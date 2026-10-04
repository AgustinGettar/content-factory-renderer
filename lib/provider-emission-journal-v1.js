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
  if (row?.state === "PREPARED") return "NOT_EMITTED";
  if (row?.state === "ACKNOWLEDGED") return "ACKNOWLEDGED";
  return "EMISSION_UNKNOWN";
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
  async get(id) {
    const { data, error } = await this.supabase.from("lumi_provider_emission_journal")
      .select("*").eq("attempt_id", id).maybeSingle();
    if (error) throw new Error("emission_read_failed");
    return data;
  }
}
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
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
export function journaledFetch({ store, context, descriptor = {}, persistResponse, fetchImpl = fetch, clock = () => new Date().toISOString() }) {
  let used = false;
  return async (url, options) => {
    if (used) throw new Error("provider_emission_already_consumed");
    used = true;
    const request = new Request(url, options);
    const bytes = Buffer.from(await request.arrayBuffer());
    const contentType = request.headers.get("content-type");
    const record = {
      version: JOURNAL_VERSION, ...context, state: "PREPARED",
      prepared_at: clock(), emission_nonce: crypto.randomUUID(),
      prompt_hash: hash(context.prompt || ""), payload_fingerprint: hash(bytes),
      request_fingerprint: hash(`${request.method}\n${url}\n${contentType}\n${hash(bytes)}`),
      payload_descriptor: { method: request.method, url, content_type: contentType,
        body_bytes: bytes.length, ...descriptor,
        ...(contentType?.includes("application/json") ? { json: sanitizeDescriptor(JSON.parse(bytes.toString())) } : {}),
      },
    };
    delete record.prompt;
    await store.prepare(record);
    await store.transition(record.attempt_id, "PREPARED", { state: "EMITTING", request_start_at: clock() });
    let response;
    try {
      response = await fetchImpl(url, { ...options, headers: request.headers, body: bytes });
    } catch (error) {
      const code = String(error?.cause?.code || error?.code || error?.name || "TRANSPORT_ERROR");
      await store.transition(record.attempt_id, "EMITTING", { state: "EMISSION_UNKNOWN",
        request_end_at: clock(), transport_error: /^[A-Z_a-z0-9]+$/.test(code) ? code : "TRANSPORT_ERROR",
        response_parsing_outcome: "NO_RESPONSE", incident_classification: "PROVIDER_EMISSION_AMBIGUOUS" });
      throw error;
    }
    // Persist response headers before reading/parsing any body.
    await store.transition(record.attempt_id, "EMITTING", { state: "ACKNOWLEDGED",
      acknowledged_at: clock(), http_status: response.status,
      provider_request_id: response.headers.get("x-request-id") || response.headers.get("request-id") || null,
      response_parsing_outcome: "PENDING" });
    const originalJson = response.json.bind(response);
    response.json = async () => {
      try {
        const body = await originalJson();
        await store.transition(record.attempt_id, "ACKNOWLEDGED", {
          state: "ACKNOWLEDGED", request_end_at: clock(), response_parsing_outcome: "JSON_PARSED",
          provider_request_id: body.request_id || body.id || response.headers.get("x-request-id") || null,
          response_metadata: { usage: body.usage || null, created: body.created || null,
            error_code: typeof body.error?.code === "string" ? body.error.code.slice(0,120) : null },
        });
        if (persistResponse) await persistResponse(body);
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
