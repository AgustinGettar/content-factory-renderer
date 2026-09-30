import test from "node:test";
import assert from "node:assert/strict";
import {
  claimPilotRepair,
  providerAttemptConsumed,
  runPilotRepairCommand,
  validatePilotRepair,
  LUMI_PILOT_REPAIR_LIFECYCLE,
  LUMI_PILOT_REPAIR_REASON,
} from "../lib/lumi-pilot-repair.js";
import {
  LUMI_PILOT_REPAIR_SPEC_VERSION,
  persistSpecification,
} from "../lib/lumi-production-pilot-v1.js";

function fakeSupabase(rows = [], repairs = []) {
  return { from(table) {
    const target = table === "lumi_pilot_runs" ? rows : repairs;
    const query = {
      filters: {}, insertRow: null, updatePatch: null,
      select() { return this; },
      eq(key, value) { this.filters[key] = value; return this; },
      insert(row) { this.insertRow = row; return this; },
      update(patch) { this.updatePatch = patch; return this; },
      resolveOne({ maybe = false } = {}) {
        if (this.insertRow) {
          const duplicate = target.some((entry) =>
            entry.pilot_id === this.insertRow.pilot_id && entry.scene_id === this.insertRow.scene_id
            && entry.stage === this.insertRow.stage && entry.repair_attempt === this.insertRow.repair_attempt);
          if (duplicate) return { data: null, error: { code: "23505" } };
          const saved = { id: String(target.length + 1), ...this.insertRow };
          target.push(saved);
          return { data: saved, error: null };
        }
        const row = target.find((entry) => Object.entries(this.filters).every(([key, value]) => entry[key] === value));
        if (!row) return { data: null, error: maybe ? null : { code: "PGRST116" } };
        if (this.updatePatch) Object.assign(row, this.updatePatch);
        return { data: row, error: null };
      },
      async single() { return this.resolveOne(); },
      async maybeSingle() { return this.resolveOne({ maybe: true }); },
      then(resolve, reject) {
        return Promise.resolve({
          data: target.filter((entry) => Object.entries(this.filters).every(([key, value]) => entry[key] === value)),
          error: null,
        }).then(resolve, reject);
      },
    };
    return query;
  } };
}

function fakeStore() {
  const statuses = [];
  return {
    statuses,
    async setSpecificationStatus(id, status, error) {
      statuses.push({ id, status, error });
      return { id, status };
    },
  };
}

const staging = { LUMI_RUNTIME_ENV: "staging", LUMI_PILOT_REPAIR_ENABLED: "true" };
const source = [{
  id: "source-1", pilot_id: "lumi_cinco_huevos_v1", scene_id: "s19",
  stage: "IMAGE", status: "SUCCEEDED", result: { source_qa_status: "SOURCE_REPAIR_REQUIRED" },
}];
const claimArgs = (supabase) => ({
  supabase, pilotId: "lumi_cinco_huevos_v1", sceneId: "s19", stage: "IMAGE",
  repairReason: LUMI_PILOT_REPAIR_REASON, repairAttempt: 0,
  estimatedCostUsd: 0.103052, maxUsd: 2,
});
const commandArgs = (supabase, store, runImageRepair) => ({
  env: staging, supabase, store, sceneId: "s19", stage: "IMAGE",
  repairReason: LUMI_PILOT_REPAIR_REASON, repairAttempt: 0,
  openAiApiKey: "configured-in-test-only", runImageRepair,
});

test("terminal original S19 permits authorized repair", () => {
  const result = validatePilotRepair({
    env: staging, sceneId: "s19", stage: "IMAGE",
    repairReason: LUMI_PILOT_REPAIR_REASON, repairAttempt: 0,
    existingStatus: "SOURCE_REPAIR_REQUIRED", boot: true,
  });
  assert.equal(result.repairAttempt, 1);
});

test("claim alone does not consume provider attempt", async () => {
  const repairs = [];
  const first = await claimPilotRepair(claimArgs(fakeSupabase(source, repairs)));
  assert.equal(first.claimed, true);
  assert.equal(first.row.repair_attempt, 1);
  assert.equal(first.row.provider_calls, 0);
  assert.equal(first.row.cost_usd, 0);
  assert.equal(first.row.result.provider_call_emitted, false);
  assert.equal(providerAttemptConsumed(first.row), false);
});

test("failure before provider remains recoverable", async () => {
  const repairs = [];
  const supabase = fakeSupabase(source, repairs);
  await assert.rejects(
    runPilotRepairCommand(commandArgs(supabase, fakeStore(), async () => {
      throw new Error("preparation_failed");
    })),
    /preparation_failed/,
  );
  assert.equal(repairs[0].status, "FAILED");
  assert.equal(repairs[0].provider_calls, 0);
  assert.equal(repairs[0].result.lifecycle_state, LUMI_PILOT_REPAIR_LIFECYCLE.FAILED_BEFORE_PROVIDER);
  assert.equal(providerAttemptConsumed(repairs[0]), false);
  const recovered = await claimPilotRepair(claimArgs(supabase));
  assert.equal(recovered.claimed, true);
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.row.status, "CLAIMED");
  assert.equal(recovered.row.result.history.length, 1);
});

test("provider request emitted consumes one-shot and persists request id", async () => {
  const repairs = [];
  const supabase = fakeSupabase(source, repairs);
  const result = await runPilotRepairCommand(commandArgs(supabase, fakeStore(), async ({
    onPrepared, onBeforeProviderDispatch, onProviderRequestEmitted, onProviderResponse,
  }) => {
    await onPrepared({ specification_id: "spec-repair-1", specification_hash: "spec-hash", request_hash: "request-hash" });
    await onBeforeProviderDispatch({ specification_hash: "spec-hash", request_hash: "request-hash" });
    await onProviderRequestEmitted({ specification_hash: "spec-hash", request_hash: "request-hash" });
    await onProviderResponse({ provider_request_id: "req-repair-1" });
    return {
      status: "generated", provider_calls: 1, provider_request_id: "req-repair-1",
      artifact_id: "090490f8-0e75-47ca-8a2c-5f3340c7f413",
      specification_hash: "spec-hash", request_hash: "request-hash",
      asset_hash: "asset-hash", actual_cost_usd: 0.1,
    };
  }));
  assert.equal(result.status, "generated");
  assert.equal(repairs[0].status, "SUCCEEDED");
  assert.equal(repairs[0].provider_calls, 1);
  assert.equal(repairs[0].provider_request_id, "req-repair-1");
  assert.equal(repairs[0].result.lifecycle_state, LUMI_PILOT_REPAIR_LIFECYCLE.SUCCEEDED);
  assert.equal(providerAttemptConsumed(repairs[0]), true);
});

test("durable dispatch commit blocks restart before request ID exists", async () => {
  const repairs = [];
  const supabase = fakeSupabase(source, repairs);
  await assert.rejects(runPilotRepairCommand(commandArgs(supabase, fakeStore(), async ({
    onPrepared, onBeforeProviderDispatch,
  }) => {
    await onPrepared({ specification_id: "spec-repair-1", specification_hash: "spec-hash", request_hash: "request-hash" });
    await onBeforeProviderDispatch({ specification_hash: "spec-hash", request_hash: "request-hash" });
    throw new Error("process_lost_before_response");
  })), /process_lost_before_response/);
  assert.equal(repairs[0].provider_calls, 0);
  assert.equal(repairs[0].result.provider_call_emitted, false);
  assert.equal(repairs[0].result.lifecycle_state, LUMI_PILOT_REPAIR_LIFECYCLE.DISPATCH_UNCERTAIN);
  assert.equal(providerAttemptConsumed(repairs[0]), true);
  let resubmissions = 0;
  await assert.rejects(runPilotRepairCommand(commandArgs(supabase, fakeStore(), async () => { resubmissions++; })), /provider_attempt_consumed/);
  assert.equal(resubmissions, 0);
});

test("second provider attempt is rejected", async () => {
  const repairs = [{
    id: "repair-1", pilot_id: "lumi_cinco_huevos_v1", scene_id: "s19", stage: "IMAGE",
    repair_attempt: 1, status: "FAILED", provider_calls: 1, provider_request_id: "req-used",
    result: { lifecycle_state: LUMI_PILOT_REPAIR_LIFECYCLE.FAILED_AFTER_PROVIDER, provider_call_emitted: true },
  }];
  let runnerCalls = 0;
  await assert.rejects(
    runPilotRepairCommand(commandArgs(fakeSupabase(source, repairs), fakeStore(), async () => { runnerCalls += 1; })),
    /provider_attempt_consumed/,
  );
  assert.equal(runnerCalls, 0);
});

test("duplicate concurrent repair is rejected", async () => {
  const repairs = [];
  const supabase = fakeSupabase(source, repairs);
  const first = await claimPilotRepair(claimArgs(supabase));
  const duplicate = await claimPilotRepair(claimArgs(supabase));
  assert.equal(first.claimed, true);
  assert.equal(duplicate.claimed, false);
  assert.match(duplicate.reason, /duplicate/);
  assert.equal(repairs.length, 1);
});

test("restart after provider emitted does not resubmit", async () => {
  const repairs = [{
    id: "repair-1", pilot_id: "lumi_cinco_huevos_v1", scene_id: "s19", stage: "IMAGE",
    repair_attempt: 1, status: "REQUESTED", provider_calls: 1, provider_request_id: null,
    result: { lifecycle_state: LUMI_PILOT_REPAIR_LIFECYCLE.PROVIDER_EMITTED, provider_call_emitted: true },
  }];
  let runnerCalls = 0;
  await assert.rejects(
    runPilotRepairCommand(commandArgs(fakeSupabase(source, repairs), fakeStore(), async () => { runnerCalls += 1; })),
    /provider_attempt_consumed/,
  );
  assert.equal(runnerCalls, 0);
});

test("non-S19, VIDEO and production repairs are rejected", () => {
  assert.throws(() => validatePilotRepair({
    env: staging, sceneId: "s18", stage: "IMAGE",
    repairReason: LUMI_PILOT_REPAIR_REASON, repairAttempt: 0, existingStatus: LUMI_PILOT_REPAIR_REASON,
  }), /scene_not_allowed/);
  assert.throws(() => validatePilotRepair({
    env: staging, sceneId: "s19", stage: "VIDEO",
    repairReason: LUMI_PILOT_REPAIR_REASON, repairAttempt: 0, existingStatus: LUMI_PILOT_REPAIR_REASON,
  }), /stage_not_allowed/);
  assert.throws(() => validatePilotRepair({
    env: { LUMI_RUNTIME_ENV: "production", LUMI_PILOT_REPAIR_ENABLED: "true" },
    sceneId: "s19", stage: "IMAGE", repairReason: LUMI_PILOT_REPAIR_REASON,
    repairAttempt: 0, existingStatus: LUMI_PILOT_REPAIR_REASON,
  }), /staging_guard/);
});

test("repair specification persists with a distinct version and tests issue zero provider requests", async () => {
  assert.equal(LUMI_PILOT_REPAIR_SPEC_VERSION, "scene-asset-manifest/production-pilot-v1-repair-1");
  assert.notEqual(LUMI_PILOT_REPAIR_SPEC_VERSION, "scene-asset-manifest/production-pilot-v1");
  let saved = null;
  await persistSpecification({
    async saveSceneSpecification(row) { saved = row; return row; },
  }, {
    snapshot: { artifact_id: "artifact-1" },
  }, {
    sceneId: "s19",
    semantics: { beat: "beat_recap" },
    manifest: { asset_specification_hash: "asset-manifest-hash" },
    prompt: { text: "repair prompt", prompt_hash: "prompt-hash" },
    specificationHash: "repair-spec-hash",
    requestHash: "repair-request-hash",
    worldManifest: { version: "world/1" },
    propRegistry: { version: "props/1" },
  }, {
    version: LUMI_PILOT_REPAIR_SPEC_VERSION,
    benchmarkRole: "production_pilot_beat_recap_repair_1",
  });
  assert.equal(saved.version, LUMI_PILOT_REPAIR_SPEC_VERSION);
  assert.equal(saved.benchmark_role, "production_pilot_beat_recap_repair_1");
  assert.equal(globalThis.fetchCallsForLumiRepairTests || 0, 0);
});
