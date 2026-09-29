import test from "node:test";
import assert from "node:assert/strict";
import { claimPilotRun, runPilotCommand, validatePilotCommand } from "../lib/lumi-pilot-internal.js";

function fakeSupabase(rows = []) {
  return { from(table) {
    assert.equal(table, "lumi_pilot_runs");
    const query = { filters: {}, patch: null, select() { return this; }, eq(key, value) { this.filters[key] = value; return this; },
      async insert(row) { if (rows.some((x) => x.pilot_id === row.pilot_id && x.scene_id === row.scene_id && x.stage === row.stage)) return { error: { code: "23505" } }; const saved = { id: String(rows.length + 1), ...row }; rows.push(saved); return { data: saved, error: null }; },
      async update(patch) { this.patch = patch; return this; },
      async single() { const row = rows.find((x) => Object.entries(this.filters).every(([k, v]) => x[k] === v)); if (this.patch && row) Object.assign(row, this.patch); return { data: row, error: row ? null : { code: "PGRST116" } }; },
      async maybeSingle() { const row = rows.find((x) => Object.entries(this.filters).every(([k, v]) => x[k] === v)); return { data: row || null, error: null }; },
      then(resolve, reject) { return Promise.resolve({ data: rows.filter((x) => Object.entries(this.filters).every(([k, v]) => x[k] === v)), error: null }).then(resolve, reject); },
    }; return query;
  } };
}

const staging = { LUMI_RUNTIME_ENV: "staging" };

test("default off and production rejected", () => {
  assert.throws(() => validatePilotCommand({ env: { LUMI_RUNTIME_ENV: "production" }, sceneId: "s13", stage: "IMAGE", boot: true }), /staging_guard/);
  assert.throws(() => validatePilotCommand({ env: staging, sceneId: "s13", stage: "IMAGE", boot: true }), /boot_disabled/);
});

test("invalid stage and non-allowlisted scenes rejected", () => {
  assert.throws(() => validatePilotCommand({ env: staging, sceneId: "s13", stage: "AUDIO" }), /stage_not_allowed/);
  for (const sceneId of ["s11", "s12", "s17", "s20"]) assert.throws(() => validatePilotCommand({ env: staging, sceneId, stage: "IMAGE" }), /scene_not_allowed/);
});

test("S13 IMAGE is accepted only in staging", () => {
  assert.deepEqual(validatePilotCommand({ env: staging, sceneId: "S13", stage: "IMAGE" }), {
    pilotId: "lumi_cinco_huevos_v1", sceneId: "s13", stage: "IMAGE",
  });
});

test("duplicate claim, FAILED and SUCCEEDED are terminal", async () => {
  const rows = []; const supabase = fakeSupabase(rows);
  const args = { supabase, sceneId: "s13", stage: "IMAGE", maxCalls: 6, maxUsd: 2, estimatedCostUsd: 0.103052 };
  assert.equal((await claimPilotRun(args)).claimed, true);
  assert.equal((await claimPilotRun(args)).claimed, false);
  rows[0].status = "FAILED"; assert.equal((await claimPilotRun(args)).claimed, false);
  rows[0].status = "SUCCEEDED"; assert.equal((await claimPilotRun(args)).claimed, false);
});

test("call and budget guards reject before provider", async () => {
  const rows = Array.from({ length: 6 }, (_, i) => ({ pilot_id: "lumi_cinco_huevos_v1", scene_id: `s${i + 1}`, stage: "IMAGE", status: "FAILED", estimated_cost_usd: 0.1 }));
  await assert.rejects(() => claimPilotRun({ supabase: fakeSupabase(rows), sceneId: "s13", stage: "IMAGE", maxCalls: 6, maxUsd: 2, estimatedCostUsd: 0.1 }), /call_cap/);
  await assert.rejects(() => claimPilotRun({ supabase: fakeSupabase([{ pilot_id: "lumi_cinco_huevos_v1", scene_id: "s14", stage: "IMAGE", status: "FAILED", estimated_cost_usd: 1.95 }]), sceneId: "s13", stage: "IMAGE", maxCalls: 6, maxUsd: 2, estimatedCostUsd: 0.1 }), /budget/);
  const videoRows = Array.from({ length: 6 }, (_, i) => ({ pilot_id: "lumi_cinco_huevos_v1", scene_id: `s${i + 1}`, stage: "VIDEO", status: "FAILED", estimated_cost_usd: 0.231 }));
  await assert.rejects(() => claimPilotRun({ supabase: fakeSupabase(videoRows), sceneId: "s13", stage: "VIDEO", maxCalls: 6, maxUsd: 3, estimatedCostUsd: 0.231 }), /call_cap/);
  await assert.rejects(() => claimPilotRun({ supabase: fakeSupabase([{ pilot_id: "lumi_cinco_huevos_v1", scene_id: "s14", stage: "VIDEO", status: "FAILED", estimated_cost_usd: 2.9 }]), sceneId: "s13", stage: "VIDEO", maxCalls: 6, maxUsd: 3, estimatedCostUsd: 0.231 }), /budget/);
});

test("internal command never reaches provider when storage is not configured", async () => {
  let providerCalls = 0;
  await assert.rejects(() => runPilotCommand({ env: staging, supabase: null, store: null, sceneId: "s13", stage: "IMAGE", openAiApiKey: "test", onUpdate: () => { providerCalls += 1; } }), /storage_not_configured/);
  assert.equal(providerCalls, 0);
});
