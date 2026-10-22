import crypto from "node:crypto";

export const JOURNAL_VERSION = "PROVIDER_EMISSION_JOURNAL_V1";
export const S37_OVERRIDE = Object.freeze({
  type: "AMBIGUOUS_EMISSION_HUMAN_OVERRIDE",
  episode_id: "ep_lumi_flores_003", scene_id: "s37", stage: "IMAGE",
  original_attempt_id: "49c9a67c-7394-4851-b3bc-cb2684f8c737",
  attempt_id: "s37-AMB1", scope: "ep_lumi_flores_003/s37",
  override_reason: "provider does not expose enough request-level evidence to prove emission or non-emission",
  possible_duplicate_remote_charge: true, max_new_provider_calls_authorized: 1,
  authorized_by: "HUMAN_EXPLICIT_APPROVAL",
});
export function validateS37Override(value) {
  if (!value || Object.entries(S37_OVERRIDE).some(([k, v]) => value[k] !== v)) {
    throw new Error("explicit_scoped_human_override_required");
  }
  return { ...S37_OVERRIDE };
}
export function emissionBoundary(row) {
  if (row?.state==='EMISSION_UNKNOWN' && row.incident_classification === 'LOCAL_PRE_DISPATCH_REJECTED'
    && row.response_metadata?.transport_invoked === false
    && row.response_parsing_outcome === 'NOT_DISPATCHED') return 'NOT_EMITTED';
  if (["PREPARED","FENCED_PREPARED"].includes(row?.state)) return "NOT_EMITTED";
  if (row?.state === "ACKNOWLEDGED") return "ACKNOWLEDGED";
  return "EMISSION_UNKNOWN";
}
export function assertEmissionIdentity(row, scope) {
  if (row && Object.entries(scope).some(([key, value]) => row[key] !== value)) {
    throw new Error('STAGE_RECOVERY_IDENTITY_MISMATCH');
  }
  return row;
}
// A status code, free-text message or timeout alone never proves lack of funds.
// This only classifies a parsed rejection from the authenticated Higgsfield API.
export function confirmedInsufficientBalance(row) {
  return row?.provider==='higgsfield_api'&&row.state==='ACKNOWLEDGED'
    &&[400,402,403].includes(row.http_status)&&row.response_parsing_outcome==='JSON_PARSED'
    &&row.incident_classification==='INSUFFICIENT_PROVIDER_BALANCE'
    &&row.response_metadata?.accepted_job_absent===true
    &&['insufficient_balance','insufficient_funds','credit_balance_exhausted'].includes(row.response_metadata.error_code);
}
export class SupabaseEmissionStore {
  constructor(supabase) { this.supabase = supabase; }
  async prepare(record) {
    const { data, error } = await this.supabase.rpc("lumi_prepare_emission_v1", { p_record: record });
    if (error) throw new Error(`emission_prepare_failed:${error.code || "unknown"}`);
    return data;
  }
  async transition(id, from, patch) {
    const { data, error } = await this.supabase.from("lumi_provider_emission_journal")
      .update(patch).eq("attempt_id", id).eq("state", from).select("*").maybeSingle();
    if (error || !data) throw new Error("emission_transition_rejected");
    return data;
  }
  async fencePreflight({attempt,nonce,user,job,lease,semantic,payloadHash}) {
    const {data,error}=await this.supabase.rpc("lumi_fence_preflight_v1",{p_attempt:attempt,p_nonce:nonce,p_user:user,p_job:job,p_lease:lease,p_semantic:semantic,p_payload_hash:payloadHash});
    if(error)throw Error("PREFLIGHT_FENCE_REJECTED");return data;
  }
  async commitPreflight({attempt,nonce,user,job,lease,version}) {
    const {data,error}=await this.supabase.rpc("lumi_commit_preflight_v1",{p_attempt:attempt,p_nonce:nonce,p_user:user,p_job:job,p_lease:lease,p_version:version});
    if(error)throw Error(error.message?.includes("PREFLIGHT_QUOTE_EXPIRED")?"PREFLIGHT_QUOTE_EXPIRED":"PREFLIGHT_FINAL_ADMISSION_REJECTED");return data;
  }
  async get(id) {
    const { data, error } = await this.supabase.from("lumi_provider_emission_journal")
      .select("*").eq("attempt_id", id).maybeSingle();
    if (error) throw new Error("emission_read_failed");
    return data;
  }
}
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
const safeId=value=>typeof value==='string'&&/^[!-~]{1,255}$/.test(value)?value:null;
const providerStatus=value=>['queued','in_progress','completed','failed','nsfw','canceled'].includes(value)?value:null;
function sanitizeDescriptor(value) {
  if (Array.isArray(value)) return value.map(sanitizeDescriptor);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k,v]) =>
    [k, /^(authorization|api_key|token|secret)$/i.test(k) ? "[REDACTED]" : sanitizeDescriptor(v)]));
  if (typeof value === "string" && /^https?:/.test(value)) {
    const url = new URL(value);
    for (const key of [...url.searchParams.keys()]) if (/token|signature|key|credential/i.test(key)) url.searchParams.set(key, "[REDACTED]");
    return url.toString();
  }
  return value;
}

// The journal is independent of provider idempotency/history. No retry is made here.
export function journaledFetch({ store, context, descriptor = {}, persistResponse, beforeDispatch, dispatchGuard, refreshPreflight, preparedClaim, fetchImpl = fetch, clock = () => new Date().toISOString() }) {
  let used = false;
  return async (url, options) => {
    if (used) throw new Error("provider_emission_already_consumed");
    used = true;
    const request = new Request(url, options);
    if(context.provider==='higgsfield_api'){
      const key=request.headers.get('Idempotency-Key')||context.attempt_id;
      if(!safeId(key)||descriptor.identity?.idempotency_key&&descriptor.identity.idempotency_key!==key)
        throw Error('PROVIDER_IDEMPOTENCY_BINDING_INVALID');
      request.headers.set('Idempotency-Key',key);
    }
    let bytes = Buffer.from(await request.arrayBuffer());
    const contentType = request.headers.get("content-type");
    const record = {
      version: JOURNAL_VERSION, ...context, state: "PREPARED",
      prepared_at: clock(), emission_nonce: crypto.randomUUID(),
      prompt_hash: hash(context.prompt || ""), payload_fingerprint: hash(bytes),
      request_fingerprint: hash(`${request.method}\n${url}\n${contentType}\n${hash(bytes)}`),
      payload_descriptor: { method: request.method, url:sanitizeDescriptor(url), content_type: contentType,
        body_bytes: bytes.length, ...descriptor,
        trace:{internal_operation_id:descriptor.identity?.operation_id??context.attempt_id,
          idempotency_key:safeId(request.headers.get('Idempotency-Key')),payload_hash:hash(bytes),
          quote_id:descriptor.identity?.quote_id??descriptor.identity?.operation_id??null,
          reservation_id:descriptor.identity?.reservation_id??null,dispatch_attempt_id:context.attempt_id,
          provider_idempotency:context.provider==='higgsfield_api'?'DOCUMENTED_NOT_LIVE_REPLAY_TESTED':'UNVERIFIED',
          automatic_replay:false},
        ...(contentType?.includes("application/json") ? { json: sanitizeDescriptor(JSON.parse(bytes.toString())) } : {}),
      },
    };
    delete record.prompt;
    if(!preparedClaim)await store.prepare(record);
    else {const prior=await store.get(record.attempt_id);
      if(prior?.state!=="FENCED_PREPARED"||prior.emission_nonce!==preparedClaim)throw Error("PREFLIGHT_FENCE_LOST");}
    let finalPreflight;
    if(refreshPreflight){
      finalPreflight=await refreshPreflight({record,body:bytes});
      bytes=Buffer.from(finalPreflight.body);
      await finalPreflight.commit();
    }
    // Validation belongs before the transport boundary. Keep the original
    // PREPARED claim on failure: neither a timeout nor validation authorizes replay.
    if (!finalPreflight && beforeDispatch) await beforeDispatch(url, { ...options, headers: request.headers, body: bytes });
    if(!finalPreflight)await store.transition(record.attempt_id, "PREPARED", { state: "EMITTING", request_start_at: clock() });
    let response, transportInvoked = false;
    try {
      // No asynchronous work is allowed between this deadline guard and fetch.
      // A late expiry is durable proof of local rejection for NEW records only.
      if (finalPreflight?.guard || dispatchGuard) {
        const result = (finalPreflight?.guard||dispatchGuard)();
        if (result?.then) throw new Error('ASYNC_DISPATCH_GUARD_FORBIDDEN');
      }
      transportInvoked = true;
      response = await fetchImpl(url, { ...options, headers: request.headers, body: bytes });
    } catch (error) {
      const code = String(error?.cause?.code || error?.code || error?.name || "TRANSPORT_ERROR");
      await store.transition(record.attempt_id, "EMITTING", { state: "EMISSION_UNKNOWN",
        request_end_at: clock(), transport_error: /^[A-Z_a-z0-9]+$/.test(code) ? code : "TRANSPORT_ERROR",
        response_parsing_outcome: transportInvoked ? "NO_RESPONSE" : "NOT_DISPATCHED",
        incident_classification: transportInvoked ? "PROVIDER_EMISSION_AMBIGUOUS" : "LOCAL_PRE_DISPATCH_REJECTED",
        response_metadata: { transport_invoked: transportInvoked,
          ...(transportInvoked ? {} : {validation_error: /^[A-Z0-9_]+$/.test(error.message) ? error.message : 'LOCAL_VALIDATION_FAILED'}) } });
      throw error;
    }
    // Persist response headers before reading/parsing any body.
    const headerEvidence={transport_invoked:true,correlation_id:safeId(response.headers.get('x-correlation-id')),
      http_request_id:safeId(response.headers.get('x-request-id')||response.headers.get('request-id'))};
    await store.transition(record.attempt_id, "EMITTING", { state: "ACKNOWLEDGED",
      acknowledged_at: clock(), http_status: response.status,
      provider_request_id: headerEvidence.http_request_id,response_metadata:headerEvidence,
      response_parsing_outcome: "PENDING" });
    const originalJson = response.json.bind(response);
    response.json = async () => {
      try {
        const body = await originalJson();
        const code=typeof body.error?.code==='string'?body.error.code:null;
        const balanceRejected=context.provider==='higgsfield_api'&&new URL(url).origin==='https://api.higgsfield.ai'
          &&[400,402,403].includes(response.status)&&['insufficient_balance','insufficient_funds','credit_balance_exhausted'].includes(code)
          &&Object.keys(body).every(k=>['error','message','detail'].includes(k))
          &&!body.request_id&&!body.id&&!body.status_url&&!body.job_id;
        await store.transition(record.attempt_id, "ACKNOWLEDGED", {
          ...(balanceRejected?{incident_classification:'INSUFFICIENT_PROVIDER_BALANCE'}:{}),
          state: "ACKNOWLEDGED", request_end_at: clock(), response_parsing_outcome: "JSON_PARSED",
          provider_request_id: safeId(body.request_id)||safeId(body.id)||headerEvidence.http_request_id,
          response_metadata: { ...headerEvidence,provider_status:providerStatus(body.status),
            billing_evidence:body.request_id&&body.cost?.currency==='USD'&&Number.isFinite(body.cost.usd)&&body.cost.usd>=0?
              {source:'PROVIDER_RESPONSE_USD',request_id:safeId(body.request_id),amount_usd:body.cost.usd}:null,
            error_code:/^[A-Za-z0-9_]{1,120}$/.test(code||'')?code:null,accepted_job_absent:balanceRejected,
            ...(context.provider==='higgsfield_api'&&response.ok&&/^[A-Za-z0-9_-]+$/.test(body.request_id||'')
              &&/^https:\/\/api\.higgsfield\.ai\/[A-Za-z0-9_/-]+$/.test(body.status_url||'')
              ?{accepted_result:{request_id:body.request_id,status_url:body.status_url}}:{}) },
        });
        if (persistResponse && response.ok) await persistResponse(body);
        return body;
      } catch (error) {
        await store.transition(record.attempt_id, "ACKNOWLEDGED", { state: "ACKNOWLEDGED",
          request_end_at: clock(), response_parsing_outcome: "JSON_PARSE_OR_PERSIST_FAILED" });
        throw error;
      }
    };
    const originalArrayBuffer = response.arrayBuffer.bind(response);
    response.arrayBuffer = async () => {
      try {
        const body = await originalArrayBuffer();
        await store.transition(record.attempt_id, "ACKNOWLEDGED", { state: "ACKNOWLEDGED",
          request_end_at: clock(), response_parsing_outcome: "BINARY_READ" });
        return body;
      } catch (error) {
        await store.transition(record.attempt_id, "ACKNOWLEDGED", { state: "ACKNOWLEDGED",
          request_end_at: clock(), response_parsing_outcome: "BINARY_READ_OR_PERSIST_FAILED" });
        throw error;
      }
    };
    return response;
  };
}

// A projection over the existing journal, result receipt and human review.
// It never writes a journal, infers non-emission from missing logs or releases money.
export function providerOperationTrace({journal:j,receipt=null,reservation=null,authorization=null,review=null}){
  const result=receipt?.result,ids=result?.provider_job_ids||[];
  const job=j?.response_metadata?.accepted_result?.request_id;
  const bound=!!job&&job===j?.provider_request_id&&(!ids.length||ids.includes(job));
  const artifact=bound&&result?.artifacts?.find(a=>a.sha256&&a.bucket&&a.path);
  const approved=artifact&&review?.status==='APPROVED'&&(review.artifact_sha??review.source_sha)===artifact.sha256;
  const status=providerStatus(result?.output?.status??j?.response_metadata?.provider_status);
  let state='PREPARED',evidence='NO_TRANSPORT_CLAIM';
  if(authorization){state='AUTHORIZED';evidence='SPECIFIC_HUMAN_AUTHORIZATION';}
  if(reservation){state='RESERVED';evidence='DURABLE_RESERVATION';}
  if(j?.state==='EMITTING'){state='DISPATCHING';evidence='DURABLE_TRANSPORT_CLAIM_OUTCOME_UNKNOWN';}
  if(j?.state==='EMISSION_UNKNOWN'){state='EMISSION_UNKNOWN';evidence=j.response_parsing_outcome;}
  if(j&&emissionBoundary(j)==='NOT_EMITTED'&&j.state!=='PREPARED'){state='FAILED_CONFIRMED';evidence='LOCAL_NON_EMISSION_PROOF';}
  if(j?.state==='ACKNOWLEDGED'){
    state=bound?'SUBMITTED':'EMISSION_UNKNOWN';evidence=bound?'ACCEPTED_JOB_ID_AND_STATUS_URL':'HTTP_RESPONSE_WITHOUT_ACCEPTED_JOB';
    if(bound&&status==='in_progress')state='PROCESSING';
    if(bound&&['failed','nsfw','canceled'].includes(status)||confirmedInsufficientBalance(j)){state='FAILED_CONFIRMED';evidence='PROVIDER_TERMINAL_EVIDENCE';}
    if(bound&&status==='completed'){state='SUCCEEDED';evidence='PROVIDER_COMPLETED_MATCHING_JOB';}
    if(artifact){state=approved?'APPROVED':'AWAITING_HUMAN_REVIEW';evidence=approved?'EXACT_ARTIFACT_HUMAN_APPROVAL':'DURABLE_ARTIFACT_MATCHING_JOB';}
  }
  return {state,evidence,internal_operation_id:j?.payload_descriptor?.trace?.internal_operation_id??null,
    idempotency_key:j?.payload_descriptor?.trace?.idempotency_key??j?.payload_descriptor?.identity?.idempotency_key??null,
    payload_hash:j?.payload_fingerprint??null,quote_id:j?.payload_descriptor?.trace?.quote_id??null,
    reservation_id:j?.payload_descriptor?.trace?.reservation_id??null,dispatch_attempt_id:j?.attempt_id??null,
    dispatch_timestamp:j?.request_start_at??null,provider_request_id:bound?job:null,http_status:j?.http_status??null,
    correlation_id:j?.response_metadata?.correlation_id??null,provider_status:status,
    artifact_reference:artifact?{sha256:artifact.sha256,bucket:artifact.bucket,path:artifact.path}:null,
    billing_evidence:bound&&result?.actual_cost?.currency==='USD'?{request_id:job,amount_usd:result.actual_cost.usd,source:'VERIFIED_RESULT'}:null,
    reservation_usd:reservation?.amount_usd??null,automatic_replay:false,
    recovery:bound?'GET_SAME_ACCEPTED_JOB':j?'EVIDENCE_REVIEW_NO_RESUBMIT':'NO_ACTIVE_OPERATION',
    budget_impact:'PRESERVE_UNTIL_VERIFIED_REQUEST_COST',end_to_end_exactly_once_verified:false};
}
