import test from "node:test";
import assert from "node:assert/strict";
import { journaledFetch, emissionBoundary, providerOperationTrace, S37_OVERRIDE, validateS37Override } from "../lib/provider-emission-journal-v1.js";
import { LumiRecoveryIncidentManager, MemoryLumiRecoveryStore } from "../lib/lumi-recovery-incident-manager-v1.js";
import { generateBenchmarkComposite } from "../lib/asset-v2/image-provider.js";

class Store {
  constructor() { this.rows = new Map(); this.events = []; }
  async prepare(row) {
    if (this.rows.has(row.attempt_id)) throw new Error("duplicate");
    this.rows.set(row.attempt_id, structuredClone(row)); this.events.push(row.state);
  }
  async transition(id, from, patch) {
    const row = this.rows.get(id);
    if (row?.state !== from) throw new Error("CAS failed");
    Object.assign(row, patch); this.events.push(patch.state);
  }
}
const context = { episode_id: "ep_lumi_flores_003", scene_id: "s37", stage: "IMAGE", attempt_id: "s37-AMB1",
  provider: "openai", model: "test", prompt: "test prompt", expected_cost_usd: 0.1, human_override: S37_OVERRIDE };
const options = { method: "POST", headers: { Authorization: "Bearer SECRET", "content-type": "application/json" }, body: '{"prompt":"test prompt"}' };

test("transport dies before acknowledgement; restart preserves unknown and never retries", async () => {
  const store = new Store(); let calls = 0;
  const transport = async () => { calls++; assert.equal(store.rows.get("s37-AMB1").state, "EMITTING"); throw new TypeError("transport broke SECRET"); };
  await assert.rejects(journaledFetch({ store, context, fetchImpl: transport })("https://example.invalid", options));
  const persisted = store.rows.get("s37-AMB1");
  assert.equal(emissionBoundary(persisted), "EMISSION_UNKNOWN");
  assert.equal(persisted.incident_classification, "PROVIDER_EMISSION_AMBIGUOUS");
  assert.deepEqual(store.events, ["PREPARED", "EMITTING", "EMISSION_UNKNOWN"]);
  await assert.rejects(journaledFetch({ store, context, fetchImpl: transport })("https://example.invalid", options), /duplicate/);
  assert.equal(calls, 1); // Mock transport only. Real provider calls = 0.
  assert.ok(!JSON.stringify(persisted).includes("SECRET"));
});
test("PREPARED is known local non-emission; failed durable EMITTING prevents HTTP", async () => {
  const store = new Store(); store.transition = async () => { throw new Error("storage down"); };
  let calls = 0;
  await assert.rejects(journaledFetch({ store, context, fetchImpl: async () => { calls++; } })("https://example.invalid", options));
  assert.equal(emissionBoundary(store.rows.get("s37-AMB1")), "NOT_EMITTED");
  assert.equal(calls, 0);
});
test("acknowledgement is persisted before JSON parsing; malformed response stays acknowledged", async () => {
  const store = new Store();
  const response = await journaledFetch({ store, context, fetchImpl: async () => new Response("invalid", { status: 200, headers: { "x-request-id": "req_test" } }) })("https://example.invalid", options);
  assert.equal(store.rows.get("s37-AMB1").provider_request_id, "req_test");
  assert.equal(emissionBoundary(store.rows.get("s37-AMB1")), "ACKNOWLEDGED");
  await assert.rejects(response.json());
  assert.equal(store.rows.get("s37-AMB1").response_parsing_outcome, "JSON_PARSE_OR_PERSIST_FAILED");
});
test("scope and risk acknowledgement must exactly match explicit authorization", () => {
  assert.deepEqual(validateS37Override(S37_OVERRIDE), S37_OVERRIDE);
  for (const patch of [{}, { scene_id: "s38" }, { max_new_provider_calls_authorized: 2 }, { authorized_by: "AUTOMATIC" }]) {
    assert.throws(() => validateS37Override(Object.keys(patch).length ? { ...S37_OVERRIDE, ...patch } : null));
  }
});
test("real image adapter persists 429 credit rejection, request id and one consumed emission without retry", async () => {
  const store = new Store(); let calls = 0;
  const fetchImpl = journaledFetch({ store, context, fetchImpl: async () => {
    calls++;
    return new Response(JSON.stringify({error:{code:"credit_balance_exhausted",message:"No credits"}}),
      { status:429,headers:{"x-request-id":"req_credit_denial","content-type":"application/json"} });
  } });
  await assert.rejects(generateBenchmarkComposite({ apiKey:"test-key", prompt:"test", referenceBuffer:Buffer.from("test"), fetchImpl }),
    error => error.diagnostic.http_status === 429 && error.diagnostic.provider_request_id === "req_credit_denial");
  const row=store.rows.get("s37-AMB1");
  assert.equal(row.state,"ACKNOWLEDGED");
  assert.equal(row.response_metadata.error_code,"credit_balance_exhausted");
  assert.equal(row.provider_request_id,"req_credit_denial");
  await assert.rejects(generateBenchmarkComposite({ apiKey:"test-key", prompt:"test", referenceBuffer:Buffer.from("test"), fetchImpl }),/already_consumed/);
  assert.equal(calls,1);
});
test("ambiguous emission requires explicit override in real Recovery Manager", async () => {
  const store = new MemoryLumiRecoveryStore(); const manager = new LumiRecoveryIncidentManager({ store });
  await manager.startEpisode({ episodeId: context.episode_id, actions: [{ key: "image:s37", scene_id: "s37", stage: "IMAGE" }], authorizedCeilingUsd: 3.05 });
  await manager.pause({ episodeId: context.episode_id, sceneId: "s37", stage: "IMAGE", errorClass: "PROVIDER_API_FAILURE", firstPendingAction: "image:s37", retryability: "PROVIDER_EMISSION_AMBIGUOUS", safeResumeAvailable: false });
  await manager.checkpoint(context.episode_id, state => { state.actions[0].dispatch_state = "EMISSION_AMBIGUOUS"; });
  let calls = 0;
  const continuation = async (action, proof) => { calls++; assert.deepEqual(proof.humanOverride, S37_OVERRIDE); return { status: "AWAITING_SOURCE_QA" }; };
  assert.equal((await manager.resume(context.episode_id, { continueAction: continuation })).status, "AMBIGUITY_PRESERVED");
  assert.equal(calls, 0);
  assert.equal((await manager.resume(context.episode_id, { humanOverride: S37_OVERRIDE, continueAction: continuation })).status, "AWAITING_SOURCE_QA");
  assert.equal(calls, 1);
  assert.equal((await store.getEpisode(context.episode_id)).status, "PAUSED_INCIDENT");
  assert.equal((await store.getEpisode(context.episode_id)).metadata.resume_count, undefined);
});


test('shared boundary: local validation expiry never crosses transport and restart cannot replay PREPARED',async()=>{
 const store=new Store();let calls=0;
 const submit=journaledFetch({store,context,beforeDispatch:async()=>{throw Error('STAGE_QUOTE_EXPIRED_BEFORE_DISPATCH');},fetchImpl:async()=>{calls++;}});
 await assert.rejects(submit('https://example.invalid',options),/QUOTE_EXPIRED/);
 assert.equal(calls,0);assert.equal(store.rows.get(context.attempt_id).state,'PREPARED');
 await assert.rejects(journaledFetch({store,context,fetchImpl:async()=>{calls++;}})('https://example.invalid',options),/duplicate/);
 assert.equal(calls,0);
});
test('shared boundary: deadline expires during durable EMITTING CAS; records proven local rejection without ACK',async()=>{
 const store=new Store();let calls=0,expired=false;const transition=store.transition.bind(store);
 store.transition=async(...args)=>{await transition(...args);if(args[2].state==='EMITTING')expired=true;};
 await assert.rejects(journaledFetch({store,context,beforeDispatch:async()=>assert.equal(expired,false),
  dispatchGuard:()=>{if(expired)throw Error('STAGE_QUOTE_EXPIRED_BEFORE_DISPATCH');},fetchImpl:async()=>{calls++;}})('https://example.invalid',options),/QUOTE_EXPIRED/);
 const r=store.rows.get(context.attempt_id);assert.equal(calls,0);assert.equal(r.provider_request_id,undefined);
 assert.equal(r.response_metadata.transport_invoked,false);assert.equal(emissionBoundary(r),'NOT_EMITTED');
 // Historical ambiguous rows have no such proof, even with a suggestive error string.
 assert.equal(emissionBoundary({state:'EMISSION_UNKNOWN',transport_error:'Q41_EMISSION_BINDING_CHANGED'}),'EMISSION_UNKNOWN');
});
test('PROVIDER_TRACEABILITY / JOURNAL_RECONCILIATION: identity before HTTP, correlation before parse, result and review remain separate',async()=>{
 const store=new Store(),c={...context,provider:'higgsfield_api'},identity={operation_id:'op-new',quote_id:'quote-new',reservation_id:'reservation-new',idempotency_key:'independent-key'};
 const response=await journaledFetch({store,context:c,descriptor:{identity},fetchImpl:async(url,o)=>{
   const j=store.rows.get(c.attempt_id);assert.equal(j.state,'EMITTING');assert.equal(j.payload_descriptor.trace.internal_operation_id,'op-new');
   assert.equal(j.payload_descriptor.trace.payload_hash,j.payload_fingerprint);assert.equal(o.headers.get('Idempotency-Key'),'independent-key');
   return new Response(JSON.stringify({request_id:'job-new',status:'queued',status_url:'https://api.higgsfield.ai/requests/job-new/status',secret:'SHOULD_NOT_PERSIST'}),{status:200,headers:{'x-correlation-id':'corr-safe'}});
 }})('https://api.higgsfield.ai/test',{...options,headers:{...options.headers,'Idempotency-Key':'independent-key'}});
 const j=store.rows.get(c.attempt_id);assert.equal(j.response_metadata.correlation_id,'corr-safe');assert.equal(providerOperationTrace({journal:j}).state,'EMISSION_UNKNOWN');
 await response.json();assert.equal(providerOperationTrace({journal:j}).state,'SUBMITTED');assert.ok(!JSON.stringify(j).includes('SHOULD_NOT_PERSIST'));
 const artifact={sha256:'a'.repeat(64),bucket:'private',path:'result.png'},receipt={result:{provider_job_ids:['job-new'],output:{status:'completed'},artifacts:[artifact],actual_cost:{currency:'USD',usd:.1}}};
 let trace=providerOperationTrace({journal:j,receipt,reservation:{amount_usd:.125}});assert.equal(trace.state,'AWAITING_HUMAN_REVIEW');assert.equal(trace.billing_evidence.amount_usd,.1);
 trace=providerOperationTrace({journal:j,receipt,review:{status:'APPROVED',artifact_sha:artifact.sha256}});assert.equal(trace.state,'APPROVED');assert.equal(trace.end_to_end_exactly_once_verified,false);
 assert.equal(providerOperationTrace({journal:j,receipt:{result:{...receipt.result,provider_job_ids:['wrong-job']}}}).state,'EMISSION_UNKNOWN');
});
test('PROVIDER_RESPONSE_LOST / PROCESS_RESTART: failure persisting ACK leaves a consumed claim, never a second POST',async()=>{
 const store=new Store(),transition=store.transition.bind(store);let calls=0;
 store.transition=async(id,from,patch)=>{if(patch.state==='ACKNOWLEDGED')throw Error('DATABASE_UNAVAILABLE');return transition(id,from,patch);};
 const transport=async()=>{calls++;return new Response('{}',{status:200,headers:{'x-request-id':'accepted-but-lost'}});};
 await assert.rejects(journaledFetch({store,context,fetchImpl:transport})('https://example.invalid',options),/DATABASE_UNAVAILABLE/);
 const j=store.rows.get(context.attempt_id);assert.equal(j.state,'EMITTING');assert.equal(emissionBoundary(j),'EMISSION_UNKNOWN');
 await assert.rejects(journaledFetch({store,context,fetchImpl:transport})('https://example.invalid',options),/duplicate/);assert.equal(calls,1);
});
