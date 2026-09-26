import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  ASSET_V2_IMAGE_MODEL,
  GARDEN_WORLD_LANDMARK_LOCK_V1,
  LUMI_CHARACTER_SCALE_LOCK_V1,
  PEDAGOGICAL_SAFE_FRAME_V1,
  VISUAL_BENCHMARK_V11_VARIANT,
  buildImageEditRequest,
  buildVisualBenchmarkV11Plan,
  evaluateVisualQAV11,
  runVisualBenchmarkV11OnBoot,
  shouldRunVisualBenchmarkV11,
  validateComposition,
} from "../lib/asset-v2/index.js";

const snapshot = JSON.parse(fs.readFileSync(
  new URL("./fixtures/av2-canonical-lumi-cinco-huevos.accepted.json", import.meta.url), "utf8",
));

function png(width = 1152, height = 2048, marker = 0) {
  const buffer = Buffer.alloc(25);
  buffer.set([137, 80, 78, 71, 13, 10, 26, 10]);
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  buffer[24] = marker;
  return buffer;
}

test("V1.1 keeps s11 out and builds deterministic s17/s12 composition contracts", () => {
  const first = buildVisualBenchmarkV11Plan(snapshot);
  const second = buildVisualBenchmarkV11Plan(snapshot);
  assert.deepEqual(first, second);
  assert.deepEqual(first.scenes.map((entry) => entry.scene_id), ["s17", "s12"]);
  assert.ok(first.scenes.every((entry) => entry.preflight.ok));
  assert.ok(first.scenes.every((entry) => entry.compiled.text.includes("Image 1 is the canonical Lumi")));
  assert.ok(first.scenes.every((entry) => entry.compiled.text.includes("Image 2 is approved s11 evidence")));
});

test("gallina_amable is a canonical s17 visible placement and required visual entity", () => {
  const source = snapshot.payload.scenes.find((scene) => scene.id === "s17");
  assert.ok(source.stage.placements.some((entry) => entry.entity_id === "gallina_amable" && entry.visible));
  const scene = buildVisualBenchmarkV11Plan(snapshot).scenes.find((entry) => entry.scene_id === "s17");
  const required = scene.manifest.required_visual_entities.find((entry) => entry.entity_id === "gallina_amable");
  assert.equal(required.importance, "required_secondary");
  assert.equal(required.safe_frame_required, true);
});

test("preflight rejects missing canonical entity and critical object outside safe frame", () => {
  const scene = buildVisualBenchmarkV11Plan(snapshot).scenes.find((entry) => entry.scene_id === "s17");
  const missing = structuredClone(scene.manifest);
  missing.base_manifest.characters = missing.base_manifest.characters.filter((entry) => entry.character_id !== "gallina_amable");
  assert.ok(validateComposition(missing).errors.some((entry) => entry.code === "required_entity_not_in_canonical_scene"));
  const outside = structuredClone(scene.manifest);
  outside.composition_contract.required_visual_entities.find((entry) => entry.entity_id === "egg_01").bounds.x = 0.01;
  assert.ok(validateComposition(outside).errors.some((entry) => entry.code === "critical_entity_outside_safe_frame"));
});

test("s17 has five non-overlapping eggs and s12 locks egg/wand/FX relationship", () => {
  const plan = buildVisualBenchmarkV11Plan(snapshot);
  const s17 = plan.scenes.find((entry) => entry.scene_id === "s17").manifest.composition_contract;
  assert.equal(s17.required_visual_entities.filter((entry) => entry.entity_type === "egg").length, 5);
  assert.equal(s17.exact_count_locks[0].expected_count, 5);
  const s12 = plan.scenes.find((entry) => entry.scene_id === "s12").manifest.composition_contract;
  assert.deepEqual(s12.focal_relationship, ["lumi", "lumi_wand_01", "egg_01"]);
  assert.match(s12.fx_policy, /may not cover Lumi's face, wand star, or egg shell/);
});

test("safe frame, landmark and character scale locks are explicit and stable", () => {
  assert.deepEqual(PEDAGOGICAL_SAFE_FRAME_V1.canvas, { width: 1152, height: 2048, aspect_ratio: "9:16" });
  const tree = GARDEN_WORLD_LANDMARK_LOCK_V1.landmarks[0];
  assert.equal(tree.landmark_id, "tree_trunk_01");
  assert.ok(tree.persistent_features.includes("circular_blue_four_pane_window"));
  assert.ok(tree.forbidden_drift.includes("open_tree_hole"));
  assert.match(LUMI_CHARACTER_SCALE_LOCK_V1.identity_rule, /never Lumi's physical proportions/);
});

test("V1.1 post-generation QA enforces required entities and observed safe bounds", () => {
  const scene = buildVisualBenchmarkV11Plan(snapshot).scenes.find((entry) => entry.scene_id === "s17");
  const observation = {
    characters: [{
      character_id: "lumi", identity_match: true, species_match: true, apparent_age_match: true,
      body_color: "warm_yellow", eye_color: "turquoise", antennae_count: 2, wing_count: 2,
      overalls_match: true, shoes_match: true, wand_match: true, extra_limbs: false,
      hands_ok: true, face_ok: true, uncanny: false, face_clutter: false,
    }],
    visible_prop_ids: ["egg_01", "egg_02", "egg_03", "egg_04", "egg_05", "lumi_wand_01"],
    visible_entity_ids: scene.manifest.required_visual_entities.map((entry) => entry.entity_id),
    entity_bounds: Object.fromEntries(scene.manifest.required_visual_entities.map((entry) => [entry.entity_id, entry.bounds])),
    environment_id: "garden_world_01", width: 1152, height: 2048,
    child_safe: true, generated_text: false, logo_or_watermark: false,
  };
  assert.equal(evaluateVisualQAV11({ manifest: scene.manifest, observation }).accepted, true);
  const missingChicken = structuredClone(observation);
  missingChicken.visible_entity_ids = missingChicken.visible_entity_ids.filter((id) => id !== "gallina_amable");
  assert.ok(evaluateVisualQAV11({ manifest: scene.manifest, observation: missingChicken }).findings.some((entry) => entry.code === "required_visual_entity_missing"));
  const unsafeEgg = structuredClone(observation);
  unsafeEgg.entity_bounds.egg_01.x = 0.01;
  assert.ok(evaluateVisualQAV11({ manifest: scene.manifest, observation: unsafeEgg }).findings.some((entry) => entry.code === "required_visual_entity_outside_safe_frame"));
});

test("OpenAI image-edit request sends canonical Lumi first and approved s11 world second", () => {
  const form = buildImageEditRequest({
    model: ASSET_V2_IMAGE_MODEL,
    prompt: "safe prompt",
    referenceBuffers: [
      { buffer: png(1122, 1402, 1), filename: "image-1-canonical-lumi.png" },
      { buffer: png(1152, 2048, 2), filename: "image-2-approved-s11-world.png" },
    ],
  });
  const images = [...form.entries()].filter(([key]) => key === "image[]");
  assert.equal(images.length, 2);
  assert.equal(images[0][1].name, "image-1-canonical-lumi.png");
  assert.equal(images[1][1].name, "image-2-approved-s11-world.png");
});

test("V1.1 runner performs exactly two calls and preserves V1 parents", async () => {
  const plan = buildVisualBenchmarkV11Plan(snapshot);
  const s11 = {
    id: GARDEN_WORLD_LANDMARK_LOCK_V1.evidence.asset_id,
    scene_id: "s11", variant: "visual_benchmark_v1", status: "qa_passed",
    asset_hash: GARDEN_WORLD_LANDMARK_LOCK_V1.evidence.asset_hash, storage_path: "approved-s11.png",
  };
  const parents = {
    s17: { id: "4e96adc8-97b7-4f5a-9543-18ee305fe95b", scene_id: "s17", variant: "visual_benchmark_v1", status: "rejected" },
    s12: { id: "418ae9ca-9f8e-467b-8e38-17ffd03be2aa", scene_id: "s12", variant: "visual_benchmark_v1", status: "rejected" },
  };
  const events = [];
  let specId = 0;
  const specs = new Map();
  const store = {
    bucket: "av2-assets-v2",
    async findAssetBySceneVariant(_artifact, scene, variant) { return variant === "visual_benchmark_v1" ? (scene === "s11" ? s11 : parents[scene]) : null; },
    async saveSceneSpecification(row) { const value = { id: `spec_${++specId}`, ...row }; specs.set(value.id, value); return value; },
    async assertStorageReady() {},
    async findAssetBySpecificationHash() { return null; },
    async claimSpecification(id) { return specs.get(id); },
    async uploadPng(path) { events.push(`upload:${path}`); },
    async saveGeneratedAsset(row) { events.push(row); return { id: `asset_${row.scene_id}`, ...row }; },
    async setSpecificationStatus() {},
    async createReviewUrl(path) { return `https://review.invalid/${path}`; },
    async attachReviewUrl() {},
  };
  const artifactRow = {
    id: snapshot.artifact_id,
    content_hash: snapshot.content_hash,
    status: snapshot.status,
    episode_schema_version: snapshot.episode_schema_version,
    scene_schema_version: snapshot.scene_schema_version,
    payload: snapshot.payload,
  };
  const supabase = { from() { return { select() { return this; }, eq() { return this; }, async single() { return { data: artifactRow, error: null }; } }; } };
  let calls = 0;
  const result = await runVisualBenchmarkV11OnBoot({
    supabase, store, apiKey: "test-only", supabaseUrl: "https://example.invalid",
    loadReferences: async () => ({
      lumi: fs.readFileSync(new URL("../../visual-benchmark-v1/lumi-master.png", import.meta.url)),
      world: fs.readFileSync(new URL("../../visual-benchmark-v1/s11.png", import.meta.url)),
    }),
    generate: async ({ referenceBuffers }) => {
      calls += 1;
      assert.equal(referenceBuffers.length, 2);
      return {
        buffer: png(1152, 2048, calls),
        image: { width: 1152, height: 2048, sha256: String(calls).padStart(64, "0"), bytes: 25 },
        provider: "openai", model: ASSET_V2_IMAGE_MODEL, provider_response_id: `img_${calls}`,
        provider_request_id: `req_${calls}`, created_at: new Date(0).toISOString(), usage: null,
      };
    },
  });
  assert.equal(calls, 2);
  assert.equal(result.provider_calls, 2);
  const saved = events.filter((entry) => typeof entry === "object");
  assert.deepEqual(saved.map((entry) => entry.scene_id), ["s17", "s12"]);
  assert.deepEqual(saved.map((entry) => entry.parent_asset_id), [parents.s17.id, parents.s12.id]);
  assert.ok(saved.every((entry) => entry.variant === VISUAL_BENCHMARK_V11_VARIANT));
  assert.deepEqual(plan.scenes.map((entry) => entry.scene_id), ["s17", "s12"]);
});

test("V1.1 boot runner is separately opt-in and remains off by default", () => {
  assert.equal(shouldRunVisualBenchmarkV11({ engineVersion: "v2", benchmarkOnly: true, runOnBoot: true }), true);
  assert.equal(shouldRunVisualBenchmarkV11({ engineVersion: "v2", benchmarkOnly: true, runOnBoot: false }), false);
});
