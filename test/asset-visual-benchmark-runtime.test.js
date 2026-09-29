import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  ASSET_V2_IMAGE_MODEL,
  AV2_VISUAL_FRAME_POLICY_V1,
  buildImageEditRequest,
  buildVisualBenchmarkPlan,
  generateBenchmarkComposite,
  isInsideProtectedSafeFrame,
  runVisualBenchmarkOnBoot,
  shouldRunVisualBenchmark,
  validateFramePolicy,
} from "../lib/asset-v2/index.js";

const snapshot = JSON.parse(fs.readFileSync(
  new URL("./fixtures/av2-canonical-lumi-cinco-huevos.accepted.json", import.meta.url), "utf8",
));

function png(width = 1152, height = 2048) {
  const buffer = Buffer.alloc(24);
  buffer.set([137, 80, 78, 71, 13, 10, 26, 10]);
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

test("native source and legacy fallback are mathematically exact 9:16 without stretch", () => {
  assert.equal(validateFramePolicy(), true);
  assert.equal(AV2_VISUAL_FRAME_POLICY_V1.source.width / AV2_VISUAL_FRAME_POLICY_V1.source.height, 9 / 16);
  assert.deepEqual(AV2_VISUAL_FRAME_POLICY_V1.legacy_2_3_fallback.crop, { x: 80, y: 0, width: 864, height: 1536 });
  assert.equal(isInsideProtectedSafeFrame({ x: 0.1, y: 0.1, width: 0.2, height: 0.2 }), true);
  assert.equal(isInsideProtectedSafeFrame({ x: 0, y: 0, width: 0.2, height: 0.2 }), false);
});

test("benchmark plan is deterministic, exactly three calls, and locks the visual reference hierarchy", () => {
  const first = buildVisualBenchmarkPlan(snapshot);
  const second = buildVisualBenchmarkPlan(snapshot);
  assert.deepEqual(first, second);
  assert.equal(first.scenes.length, 3);
  assert.deepEqual(first.scenes.map((entry) => entry.scene_id), ["s11", "s17", "s12"]);
  for (const scene of first.scenes) {
    assert.match(scene.compiled.text, /REFERENCE_HIERARCHY/);
    assert.match(scene.compiled.text, /1152x2048/);
    assert.match(scene.compiled.text, /render no text, letters, numbers, logos, signatures or watermarks/i);
    assert.match(scene.compiled.text, /PROP_LOCK/);
    assert.match(scene.request_hash, /^[a-f0-9]{64}$/);
  }
});

test("OpenAI image-edit request uses the approved snapshot, one image, high quality and native 9:16", () => {
  const form = buildImageEditRequest({ model: ASSET_V2_IMAGE_MODEL, prompt: "safe prompt", referenceBuffer: png() });
  const entries = [...form.entries()];
  const values = Object.fromEntries(entries.filter(([, value]) => typeof value === "string"));
  assert.equal(values.model, "gpt-image-2-2026-04-21");
  assert.equal(values.n, "1");
  assert.equal(values.size, "1152x2048");
  assert.equal(values.quality, "high");
  assert.equal(values.output_format, "png");
  assert.equal(entries.filter(([key]) => key === "image[]").length, 1);
});

test("image provider parses PNG and preserves safe provider metadata", async () => {
  const result = await generateBenchmarkComposite({
    apiKey: "test-only",
    prompt: "safe prompt",
    referenceBuffer: png(1122, 1402),
    fetchImpl: async (_url, init) => {
      assert.equal(init.headers.Authorization, "Bearer test-only");
      return new Response(JSON.stringify({
        id: "img_test", created: 1700000000,
        data: [{ b64_json: png().toString("base64") }],
        usage: { total_tokens: 123 },
      }), { status: 200, headers: { "content-type": "application/json", "x-request-id": "req_test" } });
    },
  });
  assert.equal(result.image.width, 1152);
  assert.equal(result.image.height, 2048);
  assert.equal(result.provider_response_id, "img_test");
  assert.deepEqual(result.usage, { total_tokens: 123 });
});

test("visual benchmark boot runner is opt-in to AV2 staging mode", () => {
  assert.equal(shouldRunVisualBenchmark({ engineVersion: "v2", benchmarkOnly: true, runOnBoot: true }), true);
  assert.equal(shouldRunVisualBenchmark({ engineVersion: "legacy", benchmarkOnly: true, runOnBoot: true }), false);
  assert.equal(shouldRunVisualBenchmark({ engineVersion: "v2", benchmarkOnly: false, runOnBoot: true }), false);
  assert.equal(shouldRunVisualBenchmark({ engineVersion: "v2", benchmarkOnly: true, runOnBoot: false }), false);
});

function fakeSupabase() {
  const row = {
    id: snapshot.artifact_id, content_hash: snapshot.content_hash, status: snapshot.status,
    episode_schema_version: snapshot.episode_schema_version,
    scene_schema_version: snapshot.scene_schema_version, payload: snapshot.payload,
  };
  return {
    from() {
      return { select() { return this; }, eq() { return this; }, async single() { return { data: row, error: null }; } };
    },
  };
}

function fakeStore(existing = []) {
  const events = [];
  let id = 0;
  const specs = new Map();
  return {
    bucket: "av2-assets-v2", events,
    async saveCharacterLock() { events.push("character"); },
    async saveWorldManifest() { events.push("world"); },
    async savePropRegistry() { events.push("props"); },
    async saveSceneSpecification(row) { const saved = { id: `spec_${++id}`, ...row }; specs.set(saved.id, saved); events.push(`plan:${row.scene_id}`); return saved; },
    async assertStorageReady() { events.push("storage_ready"); },
    async findAssetBySpecificationHash(hash) { return existing.find((asset) => asset.specification_hash === hash) || null; },
    async claimSpecification(specId) { events.push(`claim:${specId}`); return specs.get(specId); },
    async uploadPng(path) { events.push(`upload:${path}`); },
    async saveGeneratedAsset(row) { events.push(`save:${row.scene_id}`); return { id: `asset_${row.scene_id}`, ...row }; },
    async setSpecificationStatus(specId, status) { events.push(`status:${specId}:${status}`); },
    async createReviewUrl(path) { return `https://review.invalid/${path}`; },
    async attachReviewUrl(assetId) { events.push(`review:${assetId}`); },
  };
}

test("runner performs exactly one call per scene, persists before review, and never retries", async () => {
  const store = fakeStore();
  let calls = 0;
  const result = await runVisualBenchmarkOnBoot({
    supabase: fakeSupabase(), store, apiKey: "test-only", supabaseUrl: "https://example.invalid",
    loadReference: async () => png(1122, 1402),
    generate: async () => {
      calls += 1;
      return {
        buffer: png(), image: { width: 1152, height: 2048, sha256: String(calls).padStart(64, "0"), bytes: 24 },
        provider: "openai", model: ASSET_V2_IMAGE_MODEL, provider_response_id: `img_${calls}`,
        provider_request_id: `req_${calls}`, created_at: new Date(0).toISOString(), usage: null,
      };
    },
  });
  assert.equal(calls, 3);
  assert.equal(result.provider_calls, 3);
  assert.equal(store.events.filter((entry) => entry.startsWith("upload:")).length, 3);
  for (const sceneId of ["s11", "s17", "s12"]) {
    assert.ok(store.events.indexOf(`save:${sceneId}`) < store.events.indexOf(`review:asset_${sceneId}`));
  }
});

test("systemic provider failure stops after the first call with no automatic retry", async () => {
  const store = fakeStore();
  let calls = 0;
  await assert.rejects(runVisualBenchmarkOnBoot({
    supabase: fakeSupabase(), store, apiKey: "test-only", supabaseUrl: "https://example.invalid",
    loadReference: async () => png(1122, 1402),
    generate: async () => {
      calls += 1;
      const error = new Error("provider failed");
      error.diagnostic = { http_status: 400, code: "invalid_request" };
      throw error;
    },
  }), /provider failed/);
  assert.equal(calls, 1);
});

test("Asset V2 migration creates private storage, RLS tables, status checks and unique asset specs", () => {
  const sql = fs.readFileSync(new URL("../supabase/migrations/20260924000009_asset_engine_v2_storage.sql", import.meta.url), "utf8");
  assert.match(sql, /'av2-assets-v2', 'av2-assets-v2', false/);
  assert.match(sql, /alter table public\.av2_assets enable row level security/);
  assert.match(sql, /unique \(specification_hash, variant\)/);
  assert.match(sql, /'planned','generating','generated','qa_passed','qa_warning','rejected'/);
  assert.match(sql, /revoke all on public\.av2_assets from anon, authenticated/);
});
