import test from "node:test";
import assert from "node:assert/strict";
import {
  SECOND_SHORT_S25_CREATIVE_REVISION,
  SECOND_SHORT_REPAIR_PHASE1,
  REPAIR_LIFECYCLE,
  buildS25CreativeSourceContract,
  claimS25CreativeRevision,
  creativeRevisionIdentity,
  claimPhase1Repair,
  dispatchPhase1Repair,
  patchPhase1Repair,
  provePhase1DryRepair,
  providerAttemptConsumed,
  recordPhase1SourceQa,
  repairIdentity,
  resumableBeforeProvider,
  validateS25CreativeRevisionCommand,
  validatePhase1RepairCommand,
} from "../lib/lumi-second-short-repair-v1.js";

function original(sceneId, index = 1) {
  return {
    id: `original-${index}`,
    pilot_id: "lumi_jardin_formas_v1",
    scene_id: sceneId,
    stage: "IMAGE",
    status: "SUCCEEDED",
    provider_calls: 1,
    estimated_cost_usd: 0.0986,
    provider_request_id: `req_original_${sceneId}`,
    artifact_reference: `original/${sceneId}.png`,
    storage_bucket: "generative-video-benchmarks",
    storage_path: `original/${sceneId}.png`,
    content_hash: sceneId.padEnd(64, "a"),
    result: { visual_qa: { version: "1.2", classification: "BLOCKER", findings: [`${sceneId}_immutable_blocker`] } },
  };
}

function s25R1() {
  return {
    id: "s25-r1-row",
    pilot_id: "lumi_jardin_formas_v1_s25_r1",
    scene_id: "s25",
    stage: "IMAGE",
    status: "SUCCEEDED",
    provider: "openai",
    provider_calls: 1,
    estimated_cost_usd: 0.0986,
    provider_request_id: "req_s25_r1",
    artifact_reference: "repairs/s25-r1/source.png",
    storage_bucket: "generative-video-benchmarks",
    storage_path: "repairs/s25-r1/source.png",
    content_hash: "c".repeat(64),
    result: {
      revision: "s25-r1",
      source_gate: "FAIL",
      visual_qa: { version: "visual-qa/1.2", classification: "BLOCKER" },
    },
  };
}

function fakeSupabase(seed = SECOND_SHORT_REPAIR_PHASE1.scenes.map(original)) {
  const rows = seed.map((row) => ({ ...row, result: structuredClone(row.result) }));
  return {
    rows,
    from(table) {
      assert.equal(table, "lumi_pilot_runs");
      const query = {
        filters: {}, patch: null, inserted: null,
        select() { return this; },
        eq(key, value) { this.filters[key] = value; return this; },
        insert(payload) { this.inserted = payload; return this; },
        update(payload) { this.patch = payload; return this; },
        resolve() {
          if (this.inserted) {
            const duplicate = rows.some((row) => row.pilot_id === this.inserted.pilot_id
              && row.scene_id === this.inserted.scene_id && row.stage === this.inserted.stage);
            if (duplicate) return { data: null, error: { code: "23505" } };
            const saved = { id: `row-${rows.length + 1}`, ...structuredClone(this.inserted) };
            rows.push(saved);
            return { data: { ...saved, result: structuredClone(saved.result) }, error: null };
          }
          const row = rows.find((candidate) => Object.entries(this.filters).every(([key, value]) => candidate[key] === value));
          if (row && this.patch) Object.assign(row, structuredClone(this.patch));
          return { data: row ? { ...row, result: structuredClone(row.result) } : null, error: null };
        },
        async single() { return this.resolve(); },
        async maybeSingle() { return this.resolve(); },
      };
      return query;
    },
  };
}

const env = { LUMI_RUNTIME_ENV: "staging", LUMI_SECOND_SHORT_REPAIR_PHASE1_ENABLED: "true" };
const creativeEnv = { LUMI_RUNTIME_ENV: "staging", LUMI_SECOND_SHORT_S25_C1_ENABLED: "true" };

test("terminal original stays immutable and R1 has distinct identity with full lineage", async () => {
  const supabase = fakeSupabase();
  const before = structuredClone(supabase.rows.find((row) => row.scene_id === "s22"));
  const claim = await claimPhase1Repair({ supabase, env, sceneId: "s22", revision: "s22-r1" });
  assert.equal(claim.claimed, true);
  assert.equal(claim.row.pilot_id, repairIdentity("s22").ledgerPilotId);
  assert.notEqual(claim.row.pilot_id, before.pilot_id);
  assert.equal(claim.row.result.lineage.parent_run_id, before.id);
  assert.equal(claim.row.result.lineage.parent_provider_request_id, before.provider_request_id);
  assert.deepEqual(supabase.rows.find((row) => row.id === before.id), before);
  await assert.rejects(() => patchPhase1Repair(supabase, before, { status: "FAILED" }), /original_immutable/);
});

test("s22-R1 is accepted once and duplicate/second revision are rejected", async () => {
  const supabase = fakeSupabase();
  const first = await claimPhase1Repair({ supabase, env, sceneId: "s22", revision: "s22-r1" });
  assert.equal(first.claimed, true);
  const restartBeforeProvider = await claimPhase1Repair({ supabase, env, sceneId: "s22", revision: "s22-r1" });
  assert.equal(restartBeforeProvider.claimed, true);
  assert.equal(restartBeforeProvider.resumed, true);
  assert.throws(() => validatePhase1RepairCommand({ env, sceneId: "s22", revision: "s22-r2", stage: "IMAGE" }), /revision_not_authorized/);
  await patchPhase1Repair(supabase, first.row, { status: "FAILED", result: { ...first.row.result, lifecycle: REPAIR_LIFECYCLE.FAILED_PRE_PROVIDER, failure_terminal: true } });
  const terminal = await claimPhase1Repair({ supabase, env, sceneId: "s22", revision: "s22-r1" });
  assert.equal(terminal.claimed, false);
  assert.equal(terminal.reason, "second_short_repair_duplicate_rejected");
});

test("provider dispatch is maximum once and restart never resubmits after commit", async () => {
  const supabase = fakeSupabase();
  const { row } = await claimPhase1Repair({ supabase, env, sceneId: "s22", revision: "s22-r1" });
  await patchPhase1Repair(supabase, row, { result: { ...row.result, lifecycle: REPAIR_LIFECYCLE.PREPARED } });
  let mockedProviderCalls = 0;
  const response = await dispatchPhase1Repair({
    supabase,
    row,
    fetchImpl: async () => { mockedProviderCalls += 1; return { headers: { get: () => "req_repair_s22" } }; },
    url: "https://provider.invalid",
    options: {},
  });
  assert.ok(response);
  assert.equal(mockedProviderCalls, 1);
  assert.equal(row.provider_calls, 1);
  assert.equal(row.provider_request_id, "req_repair_s22");
  assert.equal(providerAttemptConsumed(row), true);
  await assert.rejects(() => dispatchPhase1Repair({ supabase, row, fetchImpl: async () => { mockedProviderCalls += 1; } }), /attempt_consumed/);
  assert.equal(mockedProviderCalls, 1);
  const restart = await claimPhase1Repair({ supabase, env, sceneId: "s22", revision: "s22-r1" });
  assert.equal(restart.claimed, false);
});

test("ambiguous provider failure is terminal and cannot resubmit", async () => {
  const supabase = fakeSupabase();
  const { row } = await claimPhase1Repair({ supabase, env, sceneId: "s23", revision: "s23-r1" });
  await patchPhase1Repair(supabase, row, { result: { ...row.result, lifecycle: REPAIR_LIFECYCLE.PREPARED } });
  let mockedProviderCalls = 0;
  await assert.rejects(() => dispatchPhase1Repair({
    supabase,
    row,
    fetchImpl: async () => { mockedProviderCalls += 1; throw new Error("network_unknown"); },
    url: "https://provider.invalid",
    options: {},
  }), /network_unknown/);
  assert.equal(mockedProviderCalls, 1);
  assert.equal(providerAttemptConsumed(row), true);
  assert.equal(resumableBeforeProvider(row), false);
  await assert.rejects(() => dispatchPhase1Repair({ supabase, row, fetchImpl: async () => { mockedProviderCalls += 1; } }), /attempt_consumed/);
  assert.equal(mockedProviderCalls, 1);
});

test("non-authorized scene, VIDEO, disabled and production are rejected before provider", () => {
  const base = { env, sceneId: "s22", revision: "s22-r1", stage: "IMAGE" };
  assert.throws(() => validatePhase1RepairCommand({ ...base, sceneId: "s21", revision: "s21-r1" }), /scene_not_authorized/);
  assert.throws(() => validatePhase1RepairCommand({ ...base, stage: "VIDEO" }), /video_not_authorized/);
  assert.throws(() => validatePhase1RepairCommand({ ...base, env: { ...env, LUMI_SECOND_SHORT_REPAIR_PHASE1_ENABLED: "false" } }), /phase1_disabled/);
  assert.throws(() => validatePhase1RepairCommand({ ...base, env: { ...env, LUMI_RUNTIME_ENV: "production" } }), /production_rejected/);
});

test("Phase 1 budget permits exactly four authorized claims and enforces the unit price", async () => {
  const supabase = fakeSupabase();
  for (const sceneId of SECOND_SHORT_REPAIR_PHASE1.scenes) {
    const claim = await claimPhase1Repair({ supabase, env, sceneId, revision: `${sceneId}-r1` });
    assert.equal(claim.claimed, true);
  }
  const repairRows = supabase.rows.filter((row) => row.pilot_id.endsWith("_r1"));
  assert.equal(repairRows.length, 4);
  assert.ok(repairRows.reduce((sum, row) => sum + Number(row.estimated_cost_usd), 0) <= 0.3944);
  assert.equal(repairRows.reduce((sum, row) => sum + row.result.estimated_cost_usd_exact, 0), 0.394398);
  await assert.rejects(() => claimPhase1Repair({
    supabase: fakeSupabase(), env, sceneId: "s22", revision: "s22-r1", estimatedUsd: 0.10,
  }), /unit_budget_rejected/);
});

test("dry repair proof accepts identity, rejects duplicate, is restart-safe, and writes zero rows", async () => {
  const supabase = fakeSupabase();
  const before = supabase.rows.length;
  const proof = await provePhase1DryRepair({ supabase, env, sceneId: "s22", revision: "s22-r1" });
  assert.equal(proof.status, "PASS");
  assert.equal(proof.new_revision_identity_accepted, true);
  assert.equal(proof.duplicate_rejected, true);
  assert.equal(proof.restart_before_provider_resumable, true);
  assert.equal(proof.provider_calls, 0);
  assert.equal(proof.fake_rows_created, 0);
  assert.equal(supabase.rows.length, before);
});

test("Visual QA V1.2 and VIDEO_SOURCE_READINESS_V1 persist PASS only for exact source evidence", async () => {
  const supabase = fakeSupabase();
  const { row } = await claimPhase1Repair({ supabase, env, sceneId: "s22", revision: "s22-r1" });
  const contentHash = "b".repeat(64);
  await patchPhase1Repair(supabase, row, {
    status: "SUCCEEDED",
    content_hash: contentHash,
    result: { ...row.result, lifecycle: REPAIR_LIFECYCLE.SUCCEEDED_QA_PENDING },
  });
  const result = await recordPhase1SourceQa({
    supabase,
    sceneId: "s22",
    revision: "s22-r1",
    observation: {
      content_hash: contentHash,
      confidence: 0.99,
      required_elements_complete: true,
      correct_object_counts: true,
      clear_geometry: true,
      no_ambiguous_overlaps: true,
      lumi_anatomy_clean: true,
      pedagogical_objects_fully_visible: true,
      sufficient_motion_spacing: true,
      no_visual_ambiguity: true,
      extraneous_educational_objects: false,
      observed_educational_objects: [{ id: "lantern_circle", count: 1, geometry: "circle_rigid_zero_corners", position: "center_pedestal", fully_visible: true }],
    },
  });
  assert.equal(result.visual_qa.classification, "PASS");
  assert.equal(result.video_source_readiness.status, "PASS");
  assert.equal(result.row.result.lifecycle, REPAIR_LIFECYCLE.SUCCEEDED_READY);
});

test("s25-C1 is a distinct explicit creative revision with original and R1 lineage", async () => {
  const supabase = fakeSupabase([...SECOND_SHORT_REPAIR_PHASE1.scenes.map(original), s25R1()]);
  const beforeOriginal = structuredClone(supabase.rows.find((row) => row.pilot_id === "lumi_jardin_formas_v1" && row.scene_id === "s25"));
  const beforeR1 = structuredClone(supabase.rows.find((row) => row.pilot_id === "lumi_jardin_formas_v1_s25_r1"));
  const claim = await claimS25CreativeRevision({
    supabase,
    env: creativeEnv,
    sceneId: "s25",
    revision: "s25-c1",
  });
  assert.equal(claim.claimed, true);
  assert.equal(claim.row.pilot_id, creativeRevisionIdentity().ledgerPilotId);
  assert.equal(claim.row.provider_calls, 0);
  assert.equal(claim.row.result.authorization, "EXPLICIT_CREATIVE_REVISION");
  assert.equal(claim.row.result.lineage.original.request_id, beforeOriginal.provider_request_id);
  assert.equal(claim.row.result.lineage.r1.request_id, beforeR1.provider_request_id);
  assert.deepEqual(supabase.rows.find((row) => row.id === beforeOriginal.id), beforeOriginal);
  assert.deepEqual(supabase.rows.find((row) => row.id === beforeR1.id), beforeR1);
});

test("s25-C1 accepts exactly one claim and leaves the R1 revision policy unchanged", async () => {
  const supabase = fakeSupabase([...SECOND_SHORT_REPAIR_PHASE1.scenes.map(original), s25R1()]);
  const first = await claimS25CreativeRevision({ supabase, env: creativeEnv, sceneId: "s25", revision: "s25-c1" });
  assert.equal(first.claimed, true);
  const restart = await claimS25CreativeRevision({ supabase, env: creativeEnv, sceneId: "s25", revision: "s25-c1" });
  assert.equal(restart.claimed, true);
  assert.equal(restart.resumed, true);
  await first.row;
  assert.throws(
    () => validateS25CreativeRevisionCommand({ env: creativeEnv, sceneId: "s25", revision: "s25-c2", stage: "IMAGE" }),
    /revision_not_authorized/,
  );
  assert.throws(
    () => validatePhase1RepairCommand({ env, sceneId: "s25", revision: "s25-r2", stage: "IMAGE" }),
    /revision_not_authorized/,
  );
});

test("s25-C1 fails closed outside staging, when disabled, and above exact budget", async () => {
  const base = { env: creativeEnv, sceneId: "s25", revision: "s25-c1", stage: "IMAGE" };
  assert.throws(() => validateS25CreativeRevisionCommand({ ...base, env: { ...creativeEnv, LUMI_RUNTIME_ENV: "production" } }), /production_rejected/);
  assert.throws(() => validateS25CreativeRevisionCommand({ ...base, env: { ...creativeEnv, LUMI_SECOND_SHORT_S25_C1_ENABLED: "false" } }), /disabled/);
  assert.throws(() => validateS25CreativeRevisionCommand({ ...base, sceneId: "s24" }), /scene_not_authorized/);
  assert.throws(() => validateS25CreativeRevisionCommand({ ...base, stage: "VIDEO" }), /stage_not_authorized/);
  const supabase = fakeSupabase([...SECOND_SHORT_REPAIR_PHASE1.scenes.map(original), s25R1()]);
  await assert.rejects(
    () => claimS25CreativeRevision({ ...base, supabase, estimatedUsd: 0.0986 }),
    /unit_budget_rejected/,
  );
  assert.equal(SECOND_SHORT_S25_CREATIVE_REVISION.maxProviderCalls, 1);
});

test("s25-C1 pre-provider contract requires recessed alcoves and forbids every pedestal substitute", async () => {
  const contract = await buildS25CreativeSourceContract();
  assert.equal(contract.status, "PASS");
  assert.equal(contract.readiness.status, "PASS");
  assert.equal(contract.reference_policy, "CANONICAL_LUMI_ONLY_NO_PEDESTAL_WORLD_REFERENCE");
  for (const required of [
    "exactly three large, separate recessed wall alcoves",
    "Inside the left alcove",
    "Inside the center alcove",
    "Inside the right alcove",
    "Zero pedestals",
    "zero podiums",
    "zero stands",
    "zero tables",
    "zero projecting shelves",
    "zero bases beneath the educational objects",
    "zero plinths",
  ]) assert.match(contract.text, new RegExp(required, "i"));
});
