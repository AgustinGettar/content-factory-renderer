import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import crypto from "node:crypto";
import {
  INCIDENT_CLASSES, LumiRecoveryIncidentManager, MemoryLumiRecoveryStore, assertTtsStorageGate,
  classifyLocalSalvage, handleTelegramIncidentCallback, isStageComplete, pipelineVersion,
  runZeroProviderRecoveryDryRun, telegramIncidentView, verifyArtifact, verifyTtsStorageGate,
} from "../lib/lumi-recovery-incident-manager-v1.js";

const actions = [{ key: "image_s1", stage: "IMAGE", scene_id: "s1", estimated_cost_usd: 0.1 },
  { key: "video_s1", stage: "VIDEO", scene_id: "s1", estimated_cost_usd: 0.2 }];

test("pipeline defaults to legacy and only accepts the explicit candidate", () => {
  assert.equal(pipelineVersion({}), "legacy");
  assert.equal(pipelineVersion({ LUMI_PIPELINE_VERSION: "v1_1_2" }), "v1_1_2");
  assert.throws(() => pipelineVersion({ LUMI_PIPELINE_VERSION: "latest" }));
});

test("all required incident classes are registered", () => {
  assert.equal(INCIDENT_CLASSES.length, 20);
  for (const key of ["INSUFFICIENT_PROVIDER_BALANCE", "STORAGE_MIME_REJECTED", "BUDGET_EXHAUSTED", "QA_BLOCKER"]) assert.ok(INCIDENT_CLASSES.includes(key));
});

test("stage completion requires provider, persistence, hash and artifact verification", () => {
  assert.equal(isStageComplete({ evidence: { provider_succeeded: true, artifact_persisted: true, sha_verified: true } }), false);
  assert.equal(isStageComplete({ evidence: { provider_succeeded: true, artifact_persisted: true, sha_verified: true, artifact_verified: true } }), true);
});

test("incident persists and runner stops without completing episode", async () => {
  const store = new MemoryLumiRecoveryStore(); let stops = 0;
  const manager = new LumiRecoveryIncidentManager({ store, stopRunner: async () => { stops += 1; } });
  await manager.startEpisode({ episodeId: "ep1", actions, authorizedCeilingUsd: 1 });
  const incident = await manager.pause({ episodeId: "ep1", sceneId: "s1", stage: "IMAGE", errorClass: "PROVIDER_TIMEOUT",
    reason: "timeout", firstPendingAction: "image_s1" });
  assert.equal(stops, 1); assert.equal((await store.getIncident(incident.incident_id)).status, "OPEN");
  assert.equal((await store.getEpisode("ep1")).status, "PAUSED_INCIDENT");
});

test("request id is immutable and resume recovers it without duplicate provider call", async () => {
  const store = new MemoryLumiRecoveryStore(); const manager = new LumiRecoveryIncidentManager({ store });
  await manager.startEpisode({ episodeId: "ep2", actions: [actions[0]], authorizedCeilingUsd: 1 });
  await manager.recordRequest("ep2", "image_s1", "req-1");
  await assert.rejects(manager.recordRequest("ep2", "image_s1", "req-2"), /immutable/);
  await manager.pause({ episodeId: "ep2", sceneId: "s1", stage: "IMAGE", errorClass: "STORAGE_UPLOAD_FAILURE",
    reason: "upload failed", providerRequestId: "req-1", firstPendingAction: "image_s1" });
  let inspections = 0, recoveries = 0;
  const result = await manager.resume("ep2", { inspectProviderRequest: async (id) => { inspections += 1; assert.equal(id, "req-1"); return { status: "succeeded", actual_cost_usd: 0.1 }; },
    recoverArtifact: async () => { recoveries += 1; return { path: "source.png" }; }, validateRecoveredArtifact: async () => ({ ok: true }) });
  assert.equal(result.provider_calls, 0); assert.equal(result.recovered_request_id, "req-1");
  assert.equal(inspections, 1); assert.equal(recoveries, 1); assert.equal((await store.getEpisode("ep2")).status, "READY_FOR_HUMAN_REVIEW");
});

test("ambiguous dispatch fails closed before any call", async () => {
  const store = new MemoryLumiRecoveryStore(); const manager = new LumiRecoveryIncidentManager({ store });
  await manager.startEpisode({ episodeId: "ep3", actions: [actions[0]], authorizedCeilingUsd: 1 });
  await manager.checkpoint("ep3", (s) => { s.actions[0].dispatch_state = "DISPATCHING"; });
  let calls = 0; const result = await manager.resume("ep3", { continueAction: async () => { calls += 1; } });
  assert.equal(result.status, "AMBIGUITY_PRESERVED"); assert.equal(calls, 0);
});

test("provider balance and budget failures pause before call", async () => {
  const store = new MemoryLumiRecoveryStore(); const manager = new LumiRecoveryIncidentManager({ store });
  await manager.startEpisode({ episodeId: "ep4", actions, authorizedCeilingUsd: 0.15 });
  const budget = await manager.budgetGate({ episodeId: "ep4", actionKey: "video_s1", projectedCallCostUsd: 0.2 });
  assert.equal(budget.status, "BLOCKED"); assert.equal(budget.shortfall_usd, 0.05);
  assert.equal((await manager.status("ep4")).last_incident.error_class, "BUDGET_EXHAUSTED");
});

test("cancel preserves actions, cost and ledger", async () => {
  const store = new MemoryLumiRecoveryStore(); const manager = new LumiRecoveryIncidentManager({ store });
  await manager.startEpisode({ episodeId: "ep5", actions, authorizedCeilingUsd: 1 });
  const before = await store.getEpisode("ep5"); const after = await manager.cancel("ep5");
  assert.equal(after.status, "CANCELLED"); assert.deepEqual(after.actions, before.actions); assert.equal(after.current_cost_usd, before.current_cost_usd);
});

test("local salvage policy prefers deterministic educational fixes", () => {
  assert.equal(classifyLocalSalvage({ kind: "EXACT_COLOR" }).classification, "DETERMINISTICALLY_REPAIRABLE");
  assert.equal(classifyLocalSalvage({ kind: "MAJOR_ANATOMY_MUTATION" }).classification, "GENERATIVE_FATAL");
  assert.equal(classifyLocalSalvage({ kind: "LABEL", lumi_overlap: true }).classification, "REVIEW_REQUIRED");
});

test("artifact validation checks image SHA and dimensions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lumi-artifact-")); const file = join(dir, "x.png");
  const png = Buffer.alloc(24); png.write("PNG", 1, "ascii"); png.writeUInt32BE(1152, 16); png.writeUInt32BE(2048, 20); await writeFile(file, png);
  const hash = crypto.createHash("sha256").update(png).digest("hex");
  assert.equal((await verifyArtifact({ type: "IMAGE", filePath: file, expectedSha256: hash, expected: { width: 1152, height: 2048 } })).ok, true);
  assert.equal((await verifyArtifact({ type: "IMAGE", filePath: file, expectedSha256: "bad" })).error_class, "ARTIFACT_HASH_MISMATCH");
  await rm(dir, { recursive: true, force: true });
});

test("video/master validation detects black and freeze artifacts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lumi-video-")); const file = join(dir, "x.mp4"); await writeFile(file, Buffer.from("video"));
  const probe = async () => ({ streams: [{ codec_type: "video", codec_name: "h264", profile: "High", width: 1080, height: 1920 }], format: { duration: "50.178" } });
  const decode = async () => ({ ok: true });
  assert.equal((await verifyArtifact({ type: "VIDEO", filePath: file, probe, decode, scan: async () => ({ blackFrames: 1, freezes: 0 }) })).error_class, "BLACK_VIDEO_ARTIFACT");
  assert.equal((await verifyArtifact({ type: "MASTER", filePath: file, probe, decode, scan: async () => ({ blackFrames: 0, freezes: 1 }) })).ok, false);
  assert.equal((await verifyArtifact({ type: "MASTER", filePath: file, expected: { width: 1080, height: 1920, codec: "h264", profile: "High" }, probe, decode, scan: async () => ({ blackFrames: 0, freezes: 0 }) })).ok, true);
  await rm(dir, { recursive: true, force: true });
});

test("TTS storage gate uploads, downloads, hashes, decodes and cleans before TTS", async () => {
  const objects = new Map(); let removed = false;
  const storage = { upload: async (_b, p, bytes, options) => { assert.equal(options.contentType, "audio/mpeg"); objects.set(p, Buffer.from(bytes)); },
    download: async (_b, p) => objects.get(p), remove: async (_b, p) => { removed = true; objects.delete(p); } };
  const gate = await verifyTtsStorageGate({ storage, bucket: "generated-audio", prefix: "episode/audio", probeBytes: Buffer.from("mp3"), decodeAudio: async () => true });
  assert.equal(gate.status, "PASS"); assert.equal(removed, true); assert.doesNotThrow(() => assertTtsStorageGate(gate));
  assert.throws(() => assertTtsStorageGate({ status: "FAIL" }), /NOT_PASS/);
});

test("Telegram incident UX edits one existing menu and never sends a new message", async () => {
  const store = new MemoryLumiRecoveryStore(); const manager = new LumiRecoveryIncidentManager({ store });
  await manager.startEpisode({ episodeId: "ep6", actions, authorizedCeilingUsd: 1 });
  const incident = await manager.pause({ episodeId: "ep6", sceneId: "s1", stage: "VIDEO", errorClass: "QA_BLOCKER", reason: "Geometría", firstPendingAction: "video_s1" });
  const view = telegramIncidentView({ episode: "ep6", incident, status: await manager.status("ep6") });
  assert.match(view.text, /Trabajo preservado: Sí/); assert.doesNotMatch(view.text, /\b(PAUSA|pause|wait|hold|espera)\b/);
  const output = await handleTelegramIncidentCallback({ callback: { id: "cb", data: "lumi:status:ep6", message: { message_id: 8, chat: { id: 9 } } }, manager });
  assert.equal(output.filter((x) => x.method === "editMessageText").length, 1); assert.equal(output.some((x) => x.method === "sendMessage"), false);
  const start = await handleTelegramIncidentCallback({ callback: { id: "cb2", data: "lumi:start:ep7", message: { message_id: 8, chat: { id: 9 } } }, manager,
    startSpec: { actions, authorizedCeilingUsd: 1 } });
  assert.equal(start.filter((x) => x.method === "editMessageText").length, 1);
});

test("zero-provider end-to-end dry run covers pause, resume, persistence and restart", async () => {
  await assert.rejects(runZeroProviderRecoveryDryRun({ providerCallsAllowed: 1 }), /zero_provider_lock_required/);
  const result = await runZeroProviderRecoveryDryRun({ providerCallsAllowed: 0 });
  assert.equal(result.status, "PASS"); assert.equal(result.provider_calls, 0); assert.equal(result.autorun, false);
  assert.equal(result.existing_request_recovered_without_duplicate, true); assert.equal(result.runners_off, true);
  assert.equal(result.simulations_pass_count, 5); assert.equal(result.duplicate_provider_calls, 0);
  assert.equal(result.exactly_once_resume, "PASS"); assert.equal(result.telegram_single_message, "PASS");
  assert.deepEqual(result.artifact_validation, { IMAGE: "PASS", VIDEO: "PASS", AUDIO: "PASS", MASTER: "PASS" });
  assert.equal(result.tts_storage_gate, "PASS"); assert.equal(result.budget_gate, "PASS");
  assert.equal(result.production_mutations, 0);
  assert.deepEqual(result.full_pipeline_stages, ["IDEA", "PLANNING", "CLAIMS", "SOURCE_READINESS", "VIDEO_READINESS", "PERSISTENCE", "QA", "BUDGET", "ASSEMBLY", "MASTER_READINESS"]);
  assert.equal(result.master_readiness, "READY_FOR_HUMAN_REVIEW");
});
