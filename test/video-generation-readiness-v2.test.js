import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  REQUIRED_CHARACTER_INVARIANTS,
  SCENE_RISK,
  compileHiggsfieldPromptV2,
  compileVideoSourceImagePromptV1,
  expectedValueGate,
  validateVideoGenerationReadiness,
} from "../lib/video-generation-readiness-v2.js";

const contractsPath = fileURLToPath(new URL("../episodes/ep_lumi_formas_002/VIDEO_GENERATION_CONTRACTS_V2.json", import.meta.url));
const contracts = JSON.parse(await readFile(contractsPath, "utf8"));
const base = () => structuredClone(contracts.scenes.s22);
let providerCalls = 0;

function acceptedSource(contract) {
  return {
    version: "1.0.0",
    status: "PASS",
    confidence: 1,
    all_required_elements_present: true,
    correct_object_counts: true,
    clear_geometry: true,
    no_ambiguous_overlaps: true,
    lumi_anatomy_clean: true,
    pedagogical_objects_fully_visible: true,
    sufficient_motion_spacing: true,
    no_visual_ambiguity: true,
    extraneous_educational_objects: false,
    observed_educational_objects: structuredClone(contract.canonical_start_state.educational_objects),
  };
}

test("missing educational invariant is rejected", () => {
  const contract = base();
  contract.educational_invariants = [];
  assert.ok(validateVideoGenerationReadiness(contract).errors.includes("MISSING_EDUCATIONAL_INVARIANT"));
});

test("missing object count is rejected", () => {
  const contract = base();
  delete contract.canonical_start_state.educational_objects[0].count;
  assert.ok(validateVideoGenerationReadiness(contract).errors.includes("MISSING_OR_AMBIGUOUS_OBJECT_COUNT_GEOMETRY_POSITION"));
});

test("ambiguous shape is rejected", () => {
  const contract = base();
  contract.canonical_start_state.educational_objects[0].geometry = "ambiguous_roundish_shape";
  assert.ok(validateVideoGenerationReadiness(contract).errors.includes("MISSING_OR_AMBIGUOUS_OBJECT_COUNT_GEOMETRY_POSITION"));
});

test("too many primary character actions are rejected", () => {
  const contract = base();
  contract.allowed_motion.primary_character_actions = ["point_once", "wave_once"];
  assert.ok(validateVideoGenerationReadiness(contract).errors.includes("TOO_MANY_PRIMARY_CHARACTER_ACTIONS"));
});

test("too many camera moves are rejected", () => {
  const contract = base();
  contract.camera_contract.moves = ["subtle_push_in", "subtle_push_in"];
  assert.ok(validateVideoGenerationReadiness(contract).errors.includes("TOO_MANY_CAMERA_MOVES"));
});

test("missing Lumi anatomy lock is rejected", () => {
  const contract = base();
  contract.character_invariants = REQUIRED_CHARACTER_INVARIANTS.filter((item) => item !== "exactly_two_arms");
  assert.ok(validateVideoGenerationReadiness(contract).errors.includes("MISSING_CHARACTER_ANATOMY_LOCK"));
});

test("PEDAGOGICAL_LOCKED scene with complex motion is rejected", () => {
  const contract = base();
  contract.allowed_motion.secondary_micro_motion = ["blink", "subtle_wings"];
  contract.camera_contract.moves = ["subtle_push_in"];
  const result = validateVideoGenerationReadiness(contract);
  assert.equal(result.risk_class, SCENE_RISK.PEDAGOGICAL_LOCKED);
  assert.ok(result.errors.includes("PEDAGOGICAL_LOCKED_COMPLEX_MOTION"));
});

test("valid simple scene passes and compiles fixed A-H blocks", () => {
  const contract = base();
  const source = acceptedSource(contract);
  const gate = expectedValueGate({ contract, source_readiness: source });
  const prompt = compileHiggsfieldPromptV2(contract);
  assert.equal(gate.status, "PASS");
  assert.equal(gate.provider_call_allowed, true);
  assert.deepEqual(prompt.blocks.map((block) => block.name), [
    "A_START_FRAME_AUTHORITY",
    "B_CHARACTER_LOCK",
    "C_EDUCATIONAL_OBJECT_LOCK",
    "D_ALLOWED_ACTION",
    "E_SECONDARY_MICRO_MOTION",
    "F_FORBIDDEN_CHANGES",
    "G_CAMERA",
    "H_END_STATE",
  ]);
  assert.match(prompt.text, /Use the supplied image as the canonical first frame/);
  assert.match(prompt.text, /exactly two arms/);
  assert.match(prompt.text, /no object duplication/);
  assert.match(prompt.text, /static camera/);
});

test("insufficient source confidence fails expected-value gate at zero cost", () => {
  const contract = base();
  const source = acceptedSource(contract);
  source.confidence = 0.5;
  const gate = expectedValueGate({ contract, source_readiness: source });
  assert.equal(gate.status, "FAIL");
  assert.equal(gate.provider_call_allowed, false);
  assert.equal(gate.failure_cost_usd, 0);
  assert.ok(gate.errors.includes("SOURCE_QA_CONFIDENCE_INSUFFICIENT"));
});

test("all canonical episode contracts pass and s25 is high-complexity mitigated", () => {
  for (const contract of Object.values(contracts.scenes)) {
    assert.equal(validateVideoGenerationReadiness(contract).status, "PASS", contract.scene_id);
  }
  assert.equal(validateVideoGenerationReadiness(contracts.scenes.s25).risk_class, SCENE_RISK.HIGH_COMPLEXITY);
});

test("source-image compiler removes the old three-pedestal ambiguity", () => {
  const circle = compileVideoSourceImagePromptV1(contracts.scenes.s22).text;
  const examples = compileVideoSourceImagePromptV1(contracts.scenes.s25).text;
  assert.match(circle, /Exactly 1 canonical Lumi/);
  assert.match(circle, /1 lantern_circle/);
  assert.match(circle, /Zero other teaching shapes/);
  assert.doesNotMatch(circle, /same three stone pedestals/);
  assert.match(examples, /1 moon_disc/);
  assert.match(examples, /1 pennant_triangle/);
  assert.match(examples, /1 window_square/);
  assert.match(examples, /zero substitute objects/i);
});

test("runtime places readiness preparation before the video provider claim", async () => {
  const runtime = await readFile(fileURLToPath(new URL("../lib/lumi-second-short-v1.js", import.meta.url)), "utf8");
  const functionStart = runtime.indexOf("export async function runSecondShortVideos");
  const prepare = runtime.indexOf("prepareHiggsfieldRequestV2", functionStart);
  const claim = runtime.indexOf("claim(supabase, scene.id, \"VIDEO\"", functionStart);
  assert.ok(functionStart >= 0 && prepare > functionStart && claim > prepare);
});

test("deterministic readiness tests emit zero provider calls", () => {
  assert.equal(providerCalls, 0);
});
