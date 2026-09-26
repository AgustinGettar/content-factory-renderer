import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  SAFE_FRAME_SEMANTICS_V12,
  VISIBILITY_REQUIREMENT,
  buildVisibilityContractV12,
  buildVisualBenchmark,
  buildVisualBenchmarkV11Plan,
  evaluateCrossSceneQAV12,
  evaluateVisualQAV12,
  validateSemanticCompositionV12,
} from "../lib/asset-v2/index.js";

const snapshot = JSON.parse(fs.readFileSync(
  new URL("./fixtures/av2-canonical-lumi-cinco-huevos.accepted.json", import.meta.url), "utf8",
));
const v1 = buildVisualBenchmark(snapshot);
const v11 = buildVisualBenchmarkV11Plan(snapshot);
const manifest = (sceneId, version = "v11") => version === "v11"
  ? v11.scenes.find((entry) => entry.scene_id === sceneId).manifest
  : v1.scenes.find((entry) => entry.scene_id === sceneId).manifest;

const b = (x, y, width, height) => ({ x, y, width, height });
const r = (bounds, extra = {}) => ({ visible: true, bounds, occluded: false, ...extra });
const lumiCharacter = () => ({
  character_id: "lumi", identity_match: true, species_match: true, apparent_age_match: true,
  body_color: "warm_yellow", eye_color: "turquoise", antennae_count: 2, wing_count: 2,
  overalls_match: true, shoes_match: true, wand_match: true, extra_limbs: false,
  hands_ok: true, face_ok: true, uncanny: false, face_clutter: false,
});

function observation(sceneId, entityObservations, visiblePropIds, visibleEntityIds) {
  return {
    scene_id: sceneId,
    width: 1152,
    height: 2048,
    environment_id: "garden_world_01",
    characters: [lumiCharacter()],
    visible_prop_ids: visiblePropIds,
    visible_entity_ids: visibleEntityIds,
    entity_observations: entityObservations,
    unregistered_egg_count: 0,
    child_safe: true,
    generated_text: false,
    logo_or_watermark: false,
    critical_crop: false,
  };
}

const eggBounds = [0.13, 0.29, 0.45, 0.61, 0.77].map((x) => b(x, 0.72, 0.11, 0.14));

function s17V11Observation() {
  const entities = {
    lumi: r(b(0.34, 0.27, 0.48, 0.42), { critical_regions: { face: r(b(0.47, 0.31, 0.20, 0.16)), eyes: r(b(0.49, 0.36, 0.15, 0.07)) } }),
    lumi_wand_01: r(b(0.32, 0.39, 0.10, 0.15), { recognizable: true, critical_regions: { wand_star: r(b(0.33, 0.39, 0.08, 0.08)) } }),
    gallina_amable: r(b(-0.01, 0.29, 0.34, 0.31), { canvas_clip: "noncritical", recognizable: true, critical_regions: { head: r(b(0.10, 0.31, 0.14, 0.14)), face: r(b(0.13, 0.34, 0.09, 0.09)), torso: r(b(0.07, 0.42, 0.22, 0.16)) } }),
  };
  ["egg_01", "egg_02", "egg_03", "egg_04", "egg_05"].forEach((id, i) => { entities[id] = r(eggBounds[i]); });
  return observation("s17", entities, ["egg_01", "egg_02", "egg_03", "egg_04", "egg_05", "lumi_wand_01"], Object.keys(entities));
}

function s12V11Observation() {
  const entities = {
    lumi: r(b(-0.01, 0.29, 0.52, 0.42), { canvas_clip: "noncritical", critical_regions: { face: r(b(0.13, 0.32, 0.24, 0.17)), eyes: r(b(0.17, 0.36, 0.16, 0.08)), active_hand: r(b(0.39, 0.47, 0.10, 0.09)) } }),
    lumi_wand_01: r(b(0.40, 0.42, 0.18, 0.13), { critical_regions: { wand_star: r(b(0.48, 0.42, 0.09, 0.09)) } }),
    egg_01: r(b(0.69, 0.62, 0.16, 0.18)),
    magic_particles: r(b(0.49, 0.44, 0.37, 0.24)),
  };
  return observation("s12", entities, ["egg_01", "lumi_wand_01"], Object.keys(entities));
}

function s11Observation() {
  const entities = {
    lumi: r(b(0.49, 0.35, 0.46, 0.39), { critical_regions: { face: r(b(0.58, 0.39, 0.20, 0.17)), eyes: r(b(0.60, 0.42, 0.17, 0.09)), active_hand: r(b(0.47, 0.50, 0.12, 0.12)) } }),
    lumi_wand_01: r(b(0.42, 0.46, 0.12, 0.16), { critical_regions: { wand_star: r(b(0.43, 0.46, 0.10, 0.10)) } }),
    gallina_amable: r(b(0.04, 0.37, 0.37, 0.34), { recognizable: true, critical_regions: { head: r(b(0.17, 0.39, 0.15, 0.15)), face: r(b(0.20, 0.42, 0.10, 0.10)), torso: r(b(0.10, 0.49, 0.25, 0.20)) } }),
    basket_01: r(b(0.35, 0.65, 0.23, 0.15), { recognizable: true, critical_regions: { basket_body: r(b(0.36, 0.66, 0.22, 0.12)) } }),
  };
  return observation("s11", entities, ["basket_01", "lumi_wand_01"], Object.keys(entities));
}

test("native and final canvases are exact proportional 9:16 with no crop", () => {
  assert.equal(1152 / 2048, 9 / 16);
  assert.equal(1080 / 1920, 9 / 16);
  assert.equal(1080 / 1152, 0.9375);
  assert.equal(1920 / 2048, 0.9375);
  assert.equal(SAFE_FRAME_SEMANTICS_V12.final_frame.transform, "proportional_scale_no_crop_no_stretch");
});

test("canonical visibility contracts keep eggs FULL and classify secondary chicken as RECOGNIZABLE", () => {
  const contract = buildVisibilityContractV12("s17", manifest("s17"));
  assert.equal(contract.entities.find((entry) => entry.entity_id === "gallina_amable").visibility_requirement, VISIBILITY_REQUIREMENT.RECOGNIZABLE);
  assert.ok(contract.entities.filter((entry) => entry.entity_id.startsWith("egg_")).every((entry) => entry.visibility_requirement === VISIBILITY_REQUIREMENT.FULL));
});

test("V1.2 preflight uses the same visibility semantics as post-generation QA", () => {
  for (const sceneId of ["s17", "s12"]) {
    const sceneManifest = manifest(sceneId);
    const contract = buildVisibilityContractV12(sceneId, sceneManifest);
    assert.deepEqual(validateSemanticCompositionV12({ manifest: sceneManifest, contract }), { ok: true, errors: [] });
  }
});

test("FULL counting egg outside pedagogical safe remains a BLOCKER", () => {
  const sceneManifest = manifest("s12");
  const contract = buildVisibilityContractV12("s12", sceneManifest);
  const value = s12V11Observation();
  value.entity_observations.egg_01.bounds = b(0.84, 0.62, 0.12, 0.18);
  const result = evaluateVisualQAV12({ manifest: sceneManifest, contract, observation: value });
  assert.ok(result.findings.some((entry) => entry.code === "full_visibility_contract_failed" && entry.entity_id === "egg_01"));
});

test("unsafe Lumi face or active educational hand remains a BLOCKER", () => {
  const sceneManifest = manifest("s12");
  const contract = buildVisibilityContractV12("s12", sceneManifest);
  for (const regionId of ["face", "active_hand"]) {
    const value = s12V11Observation();
    value.entity_observations.lumi.critical_regions[regionId].bounds.x = 0.01;
    const result = evaluateVisualQAV12({ manifest: sceneManifest, contract, observation: value });
    assert.ok(result.findings.some((entry) => entry.code === "critical_region_visibility_failed" && entry.region_id === regionId));
  }
});

test("inactive hand or decorative wing outside inset is not an automatic BLOCKER", () => {
  const sceneManifest = manifest("s12");
  const contract = buildVisibilityContractV12("s12", sceneManifest);
  const result = evaluateVisualQAV12({ manifest: sceneManifest, contract, observation: s12V11Observation() });
  assert.equal(result.counts.BLOCKER, 0);
  assert.ok(result.findings.some((entry) => entry.code === "noncritical_extent_outside_safe"));
});

test("recognizable secondary character may cross inset but missing character remains BLOCKER", () => {
  const sceneManifest = manifest("s17");
  const contract = buildVisibilityContractV12("s17", sceneManifest);
  const visible = evaluateVisualQAV12({ manifest: sceneManifest, contract, observation: s17V11Observation() });
  assert.equal(visible.counts.BLOCKER, 0);
  assert.ok(visible.findings.some((entry) => entry.code === "recognizable_entity_edge_proximity"));
  const missing = s17V11Observation();
  missing.visible_entity_ids = missing.visible_entity_ids.filter((id) => id !== "gallina_amable");
  missing.entity_observations.gallina_amable.visible = false;
  const rejected = evaluateVisualQAV12({ manifest: sceneManifest, contract, observation: missing });
  assert.ok(rejected.findings.some((entry) => entry.code === "required_entity_missing" && entry.entity_id === "gallina_amable"));
});

test("unacceptable physical canvas clipping remains BLOCKER", () => {
  const sceneManifest = manifest("s12");
  const contract = buildVisibilityContractV12("s12", sceneManifest);
  const value = s12V11Observation();
  value.entity_observations.lumi.canvas_clip = "unacceptable";
  const result = evaluateVisualQAV12({ manifest: sceneManifest, contract, observation: value });
  assert.ok(result.findings.some((entry) => entry.code === "unacceptable_canvas_clip"));
});

test("decorative magic particles outside pedagogical safe are allowed", () => {
  const sceneManifest = manifest("s12");
  const contract = buildVisibilityContractV12("s12", sceneManifest);
  const value = s12V11Observation();
  value.entity_observations.magic_particles = r(b(0.01, 0.01, 0.30, 0.20));
  const result = evaluateVisualQAV12({ manifest: sceneManifest, contract, observation: value });
  assert.equal(result.counts.BLOCKER, 0);
});

test("s17 V1 regression still fails for missing chicken and unsafe count eggs", () => {
  const sceneManifest = manifest("s17", "v1");
  const contract = buildVisibilityContractV12("s17", sceneManifest);
  const value = s17V11Observation();
  value.visible_entity_ids = value.visible_entity_ids.filter((id) => id !== "gallina_amable");
  delete value.entity_observations.gallina_amable;
  value.entity_observations.egg_01.bounds = b(0.05, 0.72, 0.14, 0.14);
  value.entity_observations.egg_05.bounds = b(0.84, 0.72, 0.14, 0.14);
  const result = evaluateVisualQAV12({ manifest: sceneManifest, contract, observation: value });
  assert.ok(result.findings.some((entry) => entry.code === "required_entity_missing"));
  assert.ok(result.findings.some((entry) => entry.code === "full_visibility_contract_failed"));
});

test("s12 V1 regression still fails because egg_01 is outside pedagogical safe", () => {
  const sceneManifest = manifest("s12", "v1");
  const contract = buildVisibilityContractV12("s12", sceneManifest);
  const value = s12V11Observation();
  value.entity_observations.egg_01.bounds = b(0.78, 0.62, 0.18, 0.17);
  const result = evaluateVisualQAV12({ manifest: sceneManifest, contract, observation: value });
  assert.ok(result.findings.some((entry) => entry.code === "full_visibility_contract_failed"));
});

test("existing s11, s17 V1.1 and s12 V1.1 have no semantic safe-frame BLOCKERS", () => {
  const inputs = [
    ["s11", manifest("s11", "v1"), s11Observation()],
    ["s17", manifest("s17"), s17V11Observation()],
    ["s12", manifest("s12"), s12V11Observation()],
  ];
  const results = inputs.map(([sceneId, sceneManifest, value]) => evaluateVisualQAV12({ manifest: sceneManifest, contract: buildVisibilityContractV12(sceneId, sceneManifest), observation: value }));
  assert.ok(results.every((result) => result.accepted));
  assert.deepEqual(results.map((result) => result.counts), [
    { BLOCKER: 0, WARNING: 2, INFO: 0 },
    { BLOCKER: 0, WARNING: 1, INFO: 0 },
    { BLOCKER: 0, WARNING: 1, INFO: 0 },
  ]);
  const cross = evaluateCrossSceneQAV12({ individualResults: results, characterIdentity: true, worldIdentity: true, propIdentity: "warning" });
  assert.equal(cross.accepted, true);
  assert.deepEqual(cross.counts, { BLOCKER: 0, WARNING: 5, INFO: 0 });
});
