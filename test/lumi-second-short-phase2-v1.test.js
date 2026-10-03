import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  PHASE2_DERIVED_SOURCES,
  SECOND_SHORT_PHASE2,
  SECOND_SHORT_PHASE2_MODEL,
  sourceReadinessFromContract,
  validatePhase2Command,
} from "../lib/lumi-second-short-phase2-v1.js";
import { validateVideoSourceReadiness } from "../lib/video-generation-readiness-v2.js";

const contracts = JSON.parse(await readFile(new URL("../episodes/ep_lumi_formas_002/VIDEO_GENERATION_CONTRACTS_V2.json", import.meta.url), "utf8"));
const preset = JSON.parse(await readFile(new URL("../LUMI_SHORT_PRODUCTION_PRESET_V1_1.json", import.meta.url), "utf8"));

test("Phase 2 is limited to the six authorized scenes and exact budget", () => {
  assert.deepEqual(SECOND_SHORT_PHASE2.scenes, ["s22", "s23", "s24", "s25", "s27", "s29"]);
  assert.equal(SECOND_SHORT_PHASE2.maxProviderCalls, 6);
  assert.equal(SECOND_SHORT_PHASE2.unitCostUsd, 0.231);
  assert.equal(SECOND_SHORT_PHASE2.incrementalCeilingUsd, 1.386);
  assert.equal(SECOND_SHORT_PHASE2.currentAccountedUsd, 2.515122);
  assert.equal(SECOND_SHORT_PHASE2.totalCompletionCeilingUsd, 3.918537);
});

test("Phase 2 model is single-shot, silent, five seconds, with multi-shots disabled", () => {
  assert.equal(SECOND_SHORT_PHASE2_MODEL.input.duration, 5);
  assert.equal(SECOND_SHORT_PHASE2_MODEL.input.sound, "off");
  assert.equal(SECOND_SHORT_PHASE2_MODEL.input.multi_shots, false);
});

test("Phase 2 command fails closed outside staging and when disabled", () => {
  assert.throws(() => validatePhase2Command({ env: {}, sceneId: "s22" }), /not_enabled_in_staging/);
  assert.throws(() => validatePhase2Command({ env: { LUMI_RUNTIME_ENV: "production", LUMI_SECOND_SHORT_PHASE2_ENABLED: "true" }, sceneId: "s22" }), /not_enabled_in_staging/);
  assert.throws(() => validatePhase2Command({ env: { LUMI_RUNTIME_ENV: "staging", LUMI_SECOND_SHORT_PHASE2_ENABLED: "false" }, sceneId: "s22" }), /not_enabled_in_staging/);
});

test("Phase 2 rejects unauthorized scenes and non-video stages", () => {
  const env = { LUMI_RUNTIME_ENV: "staging", LUMI_SECOND_SHORT_PHASE2_ENABLED: "true" };
  assert.throws(() => validatePhase2Command({ env, sceneId: "s21" }), /scene_rejected/);
  assert.throws(() => validatePhase2Command({ env, sceneId: "s22", stage: "IMAGE" }), /stage_rejected/);
  assert.deepEqual(validatePhase2Command({ env, sceneId: "s22" }), { sceneId: "s22", stage: "VIDEO" });
});

test("approved deterministic source hashes and revision identities are immutable", () => {
  assert.deepEqual(Object.fromEntries(Object.entries(PHASE2_DERIVED_SOURCES).map(([scene, spec]) => [scene, [spec.revision, spec.hash]])), {
    s22: ["s22-r1-s1", "fbe26a35e19c927d4d2df14f851c51c6d3773b06aa832073214de41374b8f498"],
    s23: ["s23-r1-s1", "e24d710017d124efd6170ac2cb7e49a0d4bebaa062cca3e9ca3c84d616a4419d"],
    s24: ["s24-r1-s1", "d74d64592bc34a9b7309f256b7b8dee0a3d87c95c4dc489d4ddc0dac789a41e3"],
  });
});

test("canonical source readiness passes V1 for every authorized contract", () => {
  for (const sceneId of SECOND_SHORT_PHASE2.scenes) {
    const source = sourceReadinessFromContract(contracts.scenes[sceneId], sceneId === "s25" ? 0.99 : 0.995);
    assert.equal(validateVideoSourceReadiness(source, contracts.scenes[sceneId]).status, "PASS", sceneId);
  }
});

test("production preset permanently requires one high-quality Full HD master encode", () => {
  const quality = preset.final_master_quality;
  assert.equal(preset.version, "1.1.2");
  assert.equal(quality.FINAL_MASTER_QUALITY, "HIGH");
  assert.deepEqual(quality.resolution, { width: 1080, height: 1920 });
  assert.equal(quality.video_encoding.codec, "H.264");
  assert.equal(quality.video_encoding.profile, "High");
  assert.equal(quality.video_encoding.pixel_format, "yuv420p");
  assert.equal(quality.video_encoding.preferred_crf, 17);
  assert.equal(quality.video_encoding.preset, "slow");
  assert.equal(quality.video_encoding.maximum_final_master_encodes, 1);
  assert.equal(quality.audio_encoding.codec, "AAC");
  assert.equal(quality.audio_encoding.sample_rate_hz, 48000);
  assert.equal(quality.audio_encoding.preferred_bitrate, "192k");
});

test("master manifest must expose technical quality evidence", () => {
  assert.deepEqual(preset.final_master_quality.manifest_required_fields, [
    "MASTER_FILE_SIZE", "VIDEO_BITRATE", "AUDIO_BITRATE", "FRAME_RATE", "ENCODE_SETTINGS",
  ]);
  assert.ok(preset.final_master_quality.final_quality_qa.includes("NO_UNNECESSARY_REENCODE"));
  assert.ok(preset.final_master_quality.final_quality_qa.includes("NO_BLACK_FRAMES"));
});
