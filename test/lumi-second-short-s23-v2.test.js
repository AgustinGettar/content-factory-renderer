import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  SECOND_SHORT_S23_V2,
  buildS23V2Contract,
  compileS23V2Prompt,
  validateS23V2Command,
} from "../lib/lumi-second-short-s23-v2.js";
import { sourceReadinessFromContract } from "../lib/lumi-second-short-phase2-v1.js";
import { validateVideoGenerationReadiness } from "../lib/video-generation-readiness-v2.js";

const contracts = JSON.parse(await readFile(new URL("../episodes/ep_lumi_formas_002/VIDEO_GENERATION_CONTRACTS_V2.json", import.meta.url), "utf8"));

test("s23-V2 is a distinct one-call explicit temporal creative revision", () => {
  assert.equal(SECOND_SHORT_S23_V2.authorization, "EXPLICIT_TEMPORAL_CREATIVE_REVISION");
  assert.equal(SECOND_SHORT_S23_V2.identity, "s23-V2");
  assert.equal(SECOND_SHORT_S23_V2.pilotId, "lumi_jardin_formas_v1_phase2_s23_v2");
  assert.equal(SECOND_SHORT_S23_V2.maxProviderCalls, 1);
  assert.equal(SECOND_SHORT_S23_V2.maxAdditionalKlingCallsFromCheckpoint, 5);
  assert.equal(SECOND_SHORT_S23_V2.totalCompletionCeilingUsd, 4.143872);
});

test("s23-V2 command is staging-only, separately enabled, and s23-only", () => {
  const env = { LUMI_RUNTIME_ENV: "staging", LUMI_SECOND_SHORT_S23_V2_ENABLED: "true" };
  assert.deepEqual(validateS23V2Command({ env, sceneId: "s23" }), { sceneId: "s23", stage: "VIDEO" });
  assert.throws(() => validateS23V2Command({ env: {}, sceneId: "s23" }), /not_enabled/);
  assert.throws(() => validateS23V2Command({ env: { ...env, LUMI_RUNTIME_ENV: "production" }, sceneId: "s23" }), /not_enabled/);
  assert.throws(() => validateS23V2Command({ env, sceneId: "s24" }), /scene_rejected/);
  assert.throws(() => validateS23V2Command({ env, sceneId: "s23", stage: "IMAGE" }), /stage_rejected/);
});

test("s23-V2 contract removes the wand trace and fixes the camera", () => {
  const contract = buildS23V2Contract(contracts.scenes.s23);
  assert.equal(validateVideoGenerationReadiness(contract).status, "PASS");
  assert.deepEqual(contract.allowed_motion.primary_character_actions, ["small_head_tilt_once"]);
  assert.deepEqual(contract.allowed_motion.secondary_micro_motion, ["blink"]);
  assert.deepEqual(contract.camera_contract.moves, []);
  assert.equal(contract.camera_contract.multi_shots, false);
});

test("s23-V2 prompt gives triangle stability absolute priority", () => {
  const readiness = sourceReadinessFromContract(contracts.scenes.s23, 0.995);
  const compiled = compileS23V2Prompt(contracts.scenes.s23, readiness);
  assert.match(compiled.text, /completely rigid/);
  assert.match(compiled.text, /exactly three straight sides and three corners for the entire shot/);
  assert.match(compiled.text, /Static camera/);
  assert.match(compiled.text, /No arm sweep, no wand trace near the triangle/);
  assert.match(compiled.text, /no slow motion, no dreamy movement/i);
});
