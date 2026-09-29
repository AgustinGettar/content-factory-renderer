import test from "node:test";
import assert from "node:assert/strict";
import {
  claimPilotRepair,
  validatePilotRepair,
  LUMI_PILOT_REPAIR_REASON,
} from "../lib/lumi-pilot-repair.js";

function fakeSupabase(rows = [], repairs = []) {
  return { from(table) {
    const target = table === "lumi_pilot_runs" ? rows : repairs;
    const query = {
      filters: {}, insertResult: null, patch: null,
      select() { return this; },
      eq(key, value) { this.filters[key] = value; return this; },
      insert(row) {
        const duplicate = target.some((entry) =>
          entry.pilot_id === row.pilot_id && entry.scene_id === row.scene_id
          && entry.stage === row.stage && (row.repair_attempt === undefined || entry.repair_attempt === row.repair_attempt));
        this.insertResult = duplicate
          ? { data: null, error: { code: "23505" } }
          : (() => { const saved = { id: String(target.length + 1), ...row }; target.push(saved); return { data: saved, error: null }; })();
        return this;
      },
      async single() {
        if (this.insertResult) { const result = this.insertResult; this.insertResult = null; return result; }
        const row = target.find((entry) => Object.entries(this.filters).every(([key, value]) => entry[key] === value));
        return { data: row || null, error: row ? null : { code: "PGRST116" } };
      },
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

const staging = { LUMI_RUNTIME_ENV: "staging", LUMI_PILOT_REPAIR_ENABLED: "true" };
const source = [{
  id: "source-1", pilot_id: "lumi_cinco_huevos_v1", scene_id: "s19",
  stage: "IMAGE", status: "SUCCEEDED",
}];

test("normal terminal claim remains blocked", () => {
  assert.throws(() => validatePilotRepair({
    env: staging, sceneId: "s19", stage: "IMAGE",
    repairReason: "OTHER", repairAttempt: 0, existingStatus: "SUCCEEDED",
  }), /reason_required/);
});

test("non-S19 and VIDEO repair are rejected", () => {
  assert.throws(() => validatePilotRepair({
    env: staging, sceneId: "s18", stage: "IMAGE",
    repairReason: LUMI_PILOT_REPAIR_REASON, repairAttempt: 0, existingStatus: LUMI_PILOT_REPAIR_REASON,
  }), /scene_not_allowed/);
  assert.throws(() => validatePilotRepair({
    env: staging, sceneId: "s19", stage: "VIDEO",
    repairReason: LUMI_PILOT_REPAIR_REASON, repairAttempt: 0, existingStatus: LUMI_PILOT_REPAIR_REASON,
  }), /stage_not_allowed/);
});

test("repair without SOURCE_REPAIR_REQUIRED and production are rejected", () => {
  assert.throws(() => validatePilotRepair({
    env: staging, sceneId: "s19", stage: "IMAGE",
    repairReason: LUMI_PILOT_REPAIR_REASON, repairAttempt: 0, existingStatus: "SUCCEEDED",
  }), /source_not_terminal/);
  assert.throws(() => validatePilotRepair({
    env: { LUMI_RUNTIME_ENV: "production", LUMI_PILOT_REPAIR_ENABLED: "true" },
    sceneId: "s19", stage: "IMAGE",
    repairReason: LUMI_PILOT_REPAIR_REASON, repairAttempt: 0, existingStatus: LUMI_PILOT_REPAIR_REASON,
  }), /staging_guard/);
});

test("repair attempt 0 accepts S19, duplicate is rejected, attempt 1 prevents second repair", async () => {
  const repairs = [];
  const supabase = fakeSupabase(source, repairs);
  const args = {
    supabase, pilotId: "lumi_cinco_huevos_v1", sceneId: "s19", stage: "IMAGE",
    repairReason: LUMI_PILOT_REPAIR_REASON, repairAttempt: 0,
    estimatedCostUsd: 0.103052, maxUsd: 2,
  };
  const first = await claimPilotRepair(args);
  assert.equal(first.claimed, true);
  assert.equal(first.row.repair_attempt, 1);
  const duplicate = await claimPilotRepair(args);
  assert.equal(duplicate.claimed, false);
  assert.match(duplicate.reason, /duplicate/);
  assert.throws(() => validatePilotRepair({
    env: staging, sceneId: "s19", stage: "IMAGE",
    repairReason: LUMI_PILOT_REPAIR_REASON, repairAttempt: 1, existingStatus: LUMI_PILOT_REPAIR_REASON,
  }), /attempt_not_zero/);
});

test("provider is not invoked by claim/validation tests", async () => {
  let providerCalls = 0;
  const supabase = fakeSupabase(source, []);
  const result = await claimPilotRepair({
    supabase, pilotId: "lumi_cinco_huevos_v1", sceneId: "s19", stage: "IMAGE",
    repairReason: LUMI_PILOT_REPAIR_REASON, repairAttempt: 0,
  });
  assert.equal(result.claimed, true);
  assert.equal(providerCalls, 0);
});
