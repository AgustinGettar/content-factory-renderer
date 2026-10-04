import test from "node:test";
import assert from "node:assert/strict";
import { journaledFetch, emissionBoundary, S37_OVERRIDE, validateS37Override } from "../lib/provider-emission-journal-v1.js";
import { LumiRecoveryIncidentManager, MemoryLumiRecoveryStore } from "../lib/lumi-recovery-incident-manager-v1.js";

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
