import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import test from "node:test";

import { canonicalStringify, contentHash } from "../lib/av2/contracts.js";
import {
  AV2_ASSET_CALL_BUDGET_V1,
  AV2_ASSET_STORAGE_DESIGN_V1,
  AV2_VISUAL_ARCHITECTURE_OPTIONS_V1,
  CANONICAL_AV2_ARTIFACT,
  CANONICAL_EGG_IDS,
  CURRENT_VISUAL_PIPELINE_AUDIT_V1,
  LUMI_CHARACTER_LOCK_V1,
  LUMI_EXPRESSION_VOCABULARY,
  LUMI_POSE_VOCABULARY,
  VISUAL_QA_V1,
  assetCacheKey,
  assertCharacterState,
  buildPropRegistry,
  buildSceneAssetManifest,
  buildVisualBenchmark,
  buildWorldManifest,
  compileVisualPrompt,
  evaluateVisualQA,
  validatePropRegistry,
  validateSceneAssetManifest,
  validateWorldManifest,
} from "../lib/asset-v2/index.js";

const snapshot = JSON.parse(fs.readFileSync(
  new URL("./fixtures/av2-canonical-lumi-cinco-huevos.accepted.json", import.meta.url), "utf8",
));

function sha256(path) {
  return crypto.createHash("sha256").update(fs.readFileSync(new URL(`../${path}`, import.meta.url))).digest("hex");
}

function validObservation(manifest) {
  return {
    width: 1080,
    height: 1920,
    environment_id: manifest.environment_id,
    visible_prop_ids: manifest.props.filter((prop) => prop.visible).map((prop) => prop.prop_id),
    unregistered_egg_count: 0,
    critical_crop: false,
    generated_text: false,
    logo_or_watermark: false,
    child_safe: true,
    composition_strength: "strong",
    depth_strength: "strong",
    background_density: "rich",
    characters: [{
      character_id: "lumi",
      identity_match: true,
      species_match: true,
      apparent_age_match: true,
      body_color: "warm_yellow",
      eye_color: "turquoise",
      antennae_count: 2,
      wing_count: 2,
      overalls_match: true,
      shoes_match: true,
      wand_match: true,
      extra_limbs: false,
      hands_ok: true,
      face_ok: true,
      uncanny: false,
      face_clutter: false,
      pose_match: true,
    }],
  };
}

test("canonical AV2 artifact is the immutable Asset Engine source", () => {
  assert.equal(snapshot.artifact_id, CANONICAL_AV2_ARTIFACT.artifact_id);
  assert.equal(snapshot.content_hash, CANONICAL_AV2_ARTIFACT.content_hash);
  assert.equal(contentHash(snapshot.payload), CANONICAL_AV2_ARTIFACT.content_hash);
  assert.equal(snapshot.payload.scenes.length, 9);
});

test("current CF-03 visual contract is materialized without changing it", () => {
  const audit = CURRENT_VISUAL_PIPELINE_AUDIT_V1;
  assert.equal(audit.image_generation.model, "gpt-image-2-2026-04-21");
  assert.deepEqual(audit.image_generation.size, { width: 1024, height: 1536 });
  assert.equal(audit.image_generation.seed, null);
  assert.equal(audit.storage.bucket, "generated-images");
  assert.equal(audit.consistency.independent_generated_layers, false);
  assert.ok(audit.renderer_consumption.layers.includes("lumi_open_or_blink"));
});

test("Lumi identity is immutable while valid scene state varies", () => {
  assert.ok(Object.isFrozen(LUMI_CHARACTER_LOCK_V1));
  assert.ok(Object.isFrozen(LUMI_CHARACTER_LOCK_V1.face));
  assert.equal(LUMI_CHARACTER_LOCK_V1.face.eye_color, "turquoise");
  assert.equal(LUMI_CHARACTER_LOCK_V1.head.antennae_count, 2);
  assert.equal(LUMI_CHARACTER_LOCK_V1.wings.count, 2);
  for (const [pose, expression] of [["idle", "neutral_happy"], ["wand_cast", "excited"], ["counting", "focused"]]) {
    assert.equal(assertCharacterState({ character_id: "lumi", pose, expression }), true);
  }
  assert.throws(() => assertCharacterState({ character_id: "lumi", pose: "teleport", expression: "excited" }), /pose_invalid/);
  assert.ok(LUMI_EXPRESSION_VOCABULARY.includes("questioning"));
  assert.ok(LUMI_POSE_VOCABULARY.includes("look_at_camera"));
});

test("approved Lumi references match their locked hashes", () => {
  for (const reference of LUMI_CHARACTER_LOCK_V1.approved_state_references) {
    assert.equal(sha256(reference.path), reference.sha256);
  }
  assert.equal(LUMI_CHARACTER_LOCK_V1.canonical_lumi_reference.role, "identity_master");
});

test("world manifest locks geography, lighting, palette and reusable depth layers", () => {
  const world = buildWorldManifest(snapshot);
  assert.equal(validateWorldManifest(world).ok, true);
  assert.equal(world.environment_id, "garden_world_01");
  assert.ok(world.landmarks.includes("garden_path"));
  assert.ok(world.landmarks.includes("tree_trunk_01"));
  assert.ok(world.layers.background.every((layer) => layer.reusable));
  assert.equal(world.lighting.reference.id, "day_clear");
});

test("prop registry has stable five-egg lock and rejects a sixth egg", () => {
  const registry = buildPropRegistry(snapshot);
  assert.equal(validatePropRegistry(registry).ok, true);
  assert.deepEqual(registry.count_locks[0].prop_ids, CANONICAL_EGG_IDS);
  assert.equal(registry.props.filter((prop) => prop.type === "egg").length, 5);
  const invalid = structuredClone(registry);
  invalid.props.push({ ...invalid.props[0], prop_id: "egg_06", source_entity_id: "egg_6" });
  const result = validatePropRegistry(invalid);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.keyword === "five_egg_lock"));
});

test("all nine scene manifests are deterministic, 9:16 and environment-continuous", () => {
  const world = buildWorldManifest(snapshot);
  const props = buildPropRegistry(snapshot);
  const first = snapshot.payload.scenes.map((scene) => buildSceneAssetManifest({ snapshot, sceneId: scene.id, worldManifest: world, propRegistry: props }));
  const second = snapshot.payload.scenes.map((scene) => buildSceneAssetManifest({ snapshot, sceneId: scene.id, worldManifest: world, propRegistry: props }));
  assert.deepEqual(first, second);
  assert.ok(first.every((manifest) => validateSceneAssetManifest(manifest).ok));
  assert.ok(first.every((manifest) => manifest.environment_id === "garden_world_01"));
  assert.ok(first.every((manifest) => manifest.camera.aspect_ratio === "9:16"));
  assert.equal(new Set(first.map((manifest) => manifest.asset_specification_hash)).size, 9);
});

test("three-scene visual benchmark stresses world, counting interaction and reward", () => {
  const benchmark = buildVisualBenchmark(snapshot);
  assert.deepEqual(benchmark.scenes.map((entry) => [entry.role, entry.scene_id]), [
    ["establishing_world", "s11"],
    ["close_interaction_counting", "s17"],
    ["magic_discovery_reward", "s12"],
  ]);
  assert.equal(benchmark.scenes[0].manifest.camera.shot_type, "wide");
  assert.equal(benchmark.scenes[1].manifest.camera.shot_type, "close");
  assert.equal(benchmark.scenes[1].manifest.props.filter((prop) => prop.visible && prop.prop_id.startsWith("egg_")).length, 5);
  assert.equal(benchmark.scenes[2].manifest.characters.find((entry) => entry.character_id === "lumi").pose, "pointing_right");
  assert.ok(benchmark.scenes[2].manifest.fx.some((entry) => entry.type === "sparkles"));
  const world = benchmark.world_manifest;
  const props = benchmark.prop_registry;
  const resolution = buildSceneAssetManifest({ snapshot, sceneId: "s19", worldManifest: world, propRegistry: props });
  assert.equal(resolution.props.filter((prop) => prop.state === "inside_basket").length, 5);
});

test("motion-ready manifests keep character and scene elements independently movable", () => {
  const benchmark = buildVisualBenchmark(snapshot);
  for (const { manifest } of benchmark.scenes) {
    assert.equal(manifest.motion_ready.requires_skeletal_animation, false);
    for (const part of ["lumi", "lumi_wand_01", "lumi_wings", "educational_props", "camera"]) {
      assert.ok(manifest.motion_ready.independent_layers.includes(part));
    }
    const lumi = manifest.characters.find((character) => character.character_id === "lumi");
    assert.ok(lumi.motion_parts.includes("eyes"));
    assert.ok(lumi.motion_parts.includes("mouth"));
  }
});

test("visual prompt compiler is deterministic and scene delta cannot rewrite identity", () => {
  const benchmark = buildVisualBenchmark(snapshot);
  const base = benchmark.scenes[0].manifest;
  const first = compileVisualPrompt({ sceneState: base, assetManifest: base, worldManifest: benchmark.world_manifest });
  const again = compileVisualPrompt({ sceneState: base, assetManifest: base, worldManifest: benchmark.world_manifest });
  assert.deepEqual(first, again);
  const delta = structuredClone(base);
  delta.characters.find((character) => character.character_id === "lumi").expression = "excited";
  const changed = compileVisualPrompt({ sceneState: delta, assetManifest: delta, worldManifest: benchmark.world_manifest });
  const identity = (compiled) => compiled.sections.find((section) => section.name === "CHARACTER_LOCK").text;
  assert.equal(identity(first), identity(changed));
  assert.notEqual(first.text, changed.text);
  assert.match(first.text, /NEGATIVE_CONSTRAINTS/);
});

test("same asset specification reuses the same cache key", () => {
  const benchmark = buildVisualBenchmark(snapshot);
  const input = {
    manifest: benchmark.scenes[0].manifest,
    worldManifest: benchmark.world_manifest,
    propRegistry: benchmark.prop_registry,
  };
  assert.equal(assetCacheKey(input), assetCacheKey(structuredClone(input)));
  assert.notEqual(benchmark.scenes[0].cache_key, benchmark.scenes[1].cache_key);
});

test("Visual QA accepts a compliant 9:16 observation", () => {
  const manifest = buildVisualBenchmark(snapshot).scenes[1].manifest;
  const qa = evaluateVisualQA({ manifest, observation: validObservation(manifest) });
  assert.equal(qa.version, VISUAL_QA_V1.version);
  assert.equal(qa.accepted, true);
  assert.deepEqual(qa.counts, { BLOCKER: 0, WARNING: 0, INFO: 0 });
});

for (const [name, mutate, expectedCode] of [
  ["wrong eye color", (o) => { o.characters[0].eye_color = "blue"; }, "wrong_eye_color"],
  ["missing wing", (o) => { o.characters[0].wing_count = 1; }, "wrong_wing_count"],
  ["extra limb", (o) => { o.characters[0].extra_limbs = true; }, "broken_anatomy"],
  ["wrong outfit", (o) => { o.characters[0].overalls_match = false; }, "wrong_outfit"],
  ["wrong wand", (o) => { o.characters[0].wand_match = false; }, "wrong_wand"],
  ["six eggs", (o) => { o.unregistered_egg_count = 1; }, "wrong_egg_count"],
  ["wrong aspect ratio", (o) => { o.width = 1024; o.height = 1536; }, "wrong_aspect_ratio"],
]) {
  test(`Visual QA rejects ${name} as BLOCKER`, () => {
    const manifest = buildVisualBenchmark(snapshot).scenes[1].manifest;
    const observation = validObservation(manifest);
    mutate(observation);
    const qa = evaluateVisualQA({ manifest, observation });
    assert.equal(qa.accepted, false);
    assert.ok(qa.findings.some((entry) => entry.severity === "BLOCKER" && entry.code === expectedCode));
  });
}

test("Visual QA warnings do not force regeneration", () => {
  const manifest = buildVisualBenchmark(snapshot).scenes[0].manifest;
  const observation = validObservation(manifest);
  observation.composition_strength = "weak";
  observation.depth_strength = "weak";
  const qa = evaluateVisualQA({ manifest, observation });
  assert.equal(qa.accepted, true);
  assert.deepEqual(qa.counts, { BLOCKER: 0, WARNING: 2, INFO: 0 });
});

test("AV2 to Asset contract preserves every creative and timing field", () => {
  const before = canonicalStringify(snapshot.payload);
  const protectedProjection = snapshot.payload.scenes.map((scene) => ({
    id: scene.id,
    beat_ref: scene.beat_ref,
    educational_goal: scene.educational_goal,
    duration_target_seconds: scene.duration_target_seconds,
    audio: scene.audio,
    actions: scene.actions,
  }));
  buildVisualBenchmark(snapshot);
  const afterProjection = snapshot.payload.scenes.map((scene) => ({
    id: scene.id,
    beat_ref: scene.beat_ref,
    educational_goal: scene.educational_goal,
    duration_target_seconds: scene.duration_target_seconds,
    audio: scene.audio,
    actions: scene.actions,
  }));
  assert.equal(canonicalStringify(snapshot.payload), before);
  assert.deepEqual(afterProjection, protectedProjection);
  assert.equal(contentHash(snapshot.payload), snapshot.content_hash);
});

test("Asset Engine planning performs no network or provider calls", () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; throw new Error("network_forbidden"); };
  try {
    const benchmark = buildVisualBenchmark(snapshot);
    compileVisualPrompt({
      sceneState: benchmark.scenes[2].manifest,
      assetManifest: benchmark.scenes[2].manifest,
      worldManifest: benchmark.world_manifest,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(calls, 0);
});

test("storage remains a reviewed design and layered 2.5D is the reversible first step", () => {
  assert.equal(AV2_ASSET_STORAGE_DESIGN_V1.migration_status, "applied_staging");
  assert.equal(AV2_ASSET_STORAGE_DESIGN_V1.tables.length, 6);
  assert.equal(AV2_VISUAL_ARCHITECTURE_OPTIONS_V1.recommended_initial, "layered_2_5d");
  assert.equal(AV2_ASSET_CALL_BUDGET_V1.visual_benchmark.benchmark_composites, 3);
  assert.equal(AV2_ASSET_CALL_BUDGET_V1.visual_benchmark.automatic_retries, 0);
  assert.equal(AV2_ASSET_CALL_BUDGET_V1.visual_benchmark.estimated_max_provider_calls, 3);
});
