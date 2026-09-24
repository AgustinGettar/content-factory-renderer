import crypto from "node:crypto";
import { contentHash } from "../av2/contracts.js";
import { LUMI_CHARACTER_LOCK_V1, characterIdentityHash } from "./character-lock.js";
import { buildVisualBenchmark } from "./director.js";
import { AV2_VISUAL_FRAME_POLICY_V1, validateFramePolicy } from "./framing.js";
import { ASSET_V2_IMAGE_MODEL, generateBenchmarkComposite } from "./image-provider.js";
import { compileVisualPrompt } from "./prompt-compiler.js";

export const VISUAL_BENCHMARK_ARTIFACT_ID = "090490f8-0e75-47ca-8a2c-5f3340c7f413";
export const VISUAL_BENCHMARK_CALL_CAP = 3;
export const CANONICAL_LUMI_REFERENCE_HASH = LUMI_CHARACTER_LOCK_V1.canonical_lumi_reference.sha256;

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function log(logger, event, fields = {}) {
  logger?.({ component: "asset_v2_visual_benchmark", event, ...fields });
}

export function shouldRunVisualBenchmark({ engineVersion, benchmarkOnly, runOnBoot }) {
  return engineVersion === "v2" && benchmarkOnly === true && runOnBoot === true;
}

export function buildVisualBenchmarkPlan(snapshot) {
  validateFramePolicy();
  const benchmark = buildVisualBenchmark(snapshot);
  const characterLockHash = characterIdentityHash(benchmark.character_lock);
  const worldHash = contentHash(benchmark.world_manifest);
  const propRegistryHash = contentHash(benchmark.prop_registry);
  const scenes = benchmark.scenes.map((scene) => {
    const compiled = compileVisualPrompt({
      sceneState: scene.manifest,
      assetManifest: scene.manifest,
      worldManifest: benchmark.world_manifest,
      propRegistry: benchmark.prop_registry,
      benchmarkRole: scene.role,
    });
    const requestHash = contentHash({
      provider: "openai",
      model: ASSET_V2_IMAGE_MODEL,
      size: AV2_VISUAL_FRAME_POLICY_V1.source.size,
      quality: "high",
      reference_hash: CANONICAL_LUMI_REFERENCE_HASH,
      prompt_hash: compiled.prompt_hash,
    });
    return { ...scene, compiled, request_hash: requestHash };
  });
  if (scenes.length !== VISUAL_BENCHMARK_CALL_CAP) throw new Error("visual_benchmark_must_have_three_scenes");
  return { benchmark, scenes, characterLockHash, worldHash, propRegistryHash };
}

async function fetchCanonicalReference({ supabaseUrl, fetchImpl = fetch }) {
  const reference = LUMI_CHARACTER_LOCK_V1.canonical_lumi_reference;
  const url = `${supabaseUrl}/storage/v1/object/public/${reference.storage_bucket}/${reference.object_path}`;
  const response = await fetchImpl(url);
  if (!response.ok) throw new Error(`canonical_lumi_reference_fetch_failed:${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (sha256(buffer) !== reference.sha256) throw new Error("canonical_lumi_reference_hash_mismatch");
  return buffer;
}

async function persistPlan(store, snapshot, plan) {
  await store.saveCharacterLock({
    character_id: "lumi", version: plan.benchmark.character_lock.version,
    specification: plan.benchmark.character_lock, specification_hash: plan.characterLockHash,
    reference_hash: CANONICAL_LUMI_REFERENCE_HASH, status: "planned",
  });
  await store.saveWorldManifest({
    artifact_id: snapshot.artifact_id, environment_id: plan.benchmark.world_manifest.environment_id,
    version: plan.benchmark.world_manifest.version, manifest: plan.benchmark.world_manifest,
    manifest_hash: plan.worldHash, status: "planned",
  });
  await store.savePropRegistry({
    artifact_id: snapshot.artifact_id, version: plan.benchmark.prop_registry.version,
    registry: plan.benchmark.prop_registry, registry_hash: plan.propRegistryHash, status: "planned",
  });
  const records = [];
  for (const scene of plan.scenes) {
    records.push(await store.saveSceneSpecification({
      artifact_id: snapshot.artifact_id,
      scene_id: scene.scene_id,
      benchmark_role: scene.role,
      version: scene.manifest.version,
      manifest: scene.manifest,
      specification_hash: scene.cache_key,
      asset_manifest_hash: scene.manifest.asset_specification_hash,
      compiled_prompt: scene.compiled.text,
      compiled_prompt_hash: scene.compiled.prompt_hash,
      provider_request_hash: scene.request_hash,
      character_lock_version: plan.benchmark.character_lock.version,
      character_lock_hash: plan.characterLockHash,
      character_reference_version: "canonical-lumi-reference/1",
      character_reference_hash: CANONICAL_LUMI_REFERENCE_HASH,
      world_manifest_version: plan.benchmark.world_manifest.version,
      world_manifest_hash: plan.worldHash,
      prop_registry_version: plan.benchmark.prop_registry.version,
      prop_registry_hash: plan.propRegistryHash,
      framing_policy: AV2_VISUAL_FRAME_POLICY_V1,
      status: "planned",
    }));
  }
  return records;
}

function snapshotFromArtifact(row) {
  return {
    artifact_id: row.id,
    content_hash: row.content_hash,
    status: row.status,
    episode_schema_version: row.episode_schema_version,
    scene_schema_version: row.scene_schema_version,
    payload: row.payload,
  };
}

function systemicProviderError(error) {
  const status = Number(error?.diagnostic?.http_status || 0);
  return status === 0 || status >= 400;
}

export async function runVisualBenchmarkOnBoot({
  supabase,
  store,
  apiKey,
  supabaseUrl,
  logger,
  generate = generateBenchmarkComposite,
  fetchImpl = fetch,
  loadReference = () => fetchCanonicalReference({ supabaseUrl, fetchImpl }),
}) {
  if (!supabase || !store) throw new Error("visual_benchmark_storage_not_configured");
  log(logger, "visual_benchmark_started", { planned_provider_calls: VISUAL_BENCHMARK_CALL_CAP });
  const { data: artifact, error } = await supabase.from("av2_creative_artifacts").select("*")
    .eq("id", VISUAL_BENCHMARK_ARTIFACT_ID).single();
  if (error) throw new Error("visual_benchmark_artifact_read_failed");
  const snapshot = snapshotFromArtifact(artifact);
  const plan = buildVisualBenchmarkPlan(snapshot);
  const records = await persistPlan(store, snapshot, plan);
  await store.assertStorageReady();
  const existing = [];
  for (const scene of plan.scenes) existing.push(await store.findAssetBySpecificationHash(scene.cache_key));
  const missingCount = existing.filter((asset) => !asset).length;
  if (missingCount > VISUAL_BENCHMARK_CALL_CAP) throw new Error("visual_benchmark_call_budget_exceeded");
  if (missingCount === 0) {
    log(logger, "visual_benchmark_cache_hit", { provider_calls: 0, cache_hits: 3 });
    return { ok: true, provider_calls: 0, cache_hits: 3, assets: existing };
  }
  const referenceBuffer = await loadReference();
  let providerCalls = 0;
  const assets = [];
  for (let index = 0; index < plan.scenes.length; index += 1) {
    const scene = plan.scenes[index];
    if (existing[index]) {
      assets.push(existing[index]);
      continue;
    }
    const claimed = await store.claimSpecification(records[index].id);
    if (!claimed) throw new Error(`visual_benchmark_specification_not_claimable:${scene.scene_id}`);
    providerCalls += 1;
    if (providerCalls > VISUAL_BENCHMARK_CALL_CAP) throw new Error("visual_benchmark_call_budget_exceeded");
    log(logger, "visual_benchmark_provider_call_started", { scene_id: scene.scene_id, provider_calls: providerCalls });
    try {
      const result = await generate({
        apiKey, model: ASSET_V2_IMAGE_MODEL, prompt: scene.compiled.text,
        referenceBuffer, size: AV2_VISUAL_FRAME_POLICY_V1.source.size, quality: "high", fetchImpl,
      });
      if (result.image.width !== AV2_VISUAL_FRAME_POLICY_V1.source.width
          || result.image.height !== AV2_VISUAL_FRAME_POLICY_V1.source.height) {
        throw new Error(`visual_benchmark_wrong_provider_dimensions:${result.image.width}x${result.image.height}`);
      }
      const path = `${snapshot.artifact_id}/benchmark_composite/${scene.cache_key}/visual-benchmark-v1.png`;
      await store.uploadPng(path, result.buffer, {
        artifact_id: snapshot.artifact_id, scene_id: scene.scene_id,
        specification_hash: scene.cache_key, content_sha256: result.image.sha256,
      });
      const asset = await store.saveGeneratedAsset({
        artifact_id: snapshot.artifact_id,
        scene_id: scene.scene_id,
        specification_id: records[index].id,
        specification_hash: scene.cache_key,
        variant: "visual_benchmark_v1",
        asset_hash: result.image.sha256,
        provider: result.provider,
        provider_model: result.model,
        provider_request_hash: scene.request_hash,
        provider_response_id: result.provider_response_id,
        provider_request_id: result.provider_request_id,
        provider_metadata: { created_at: result.created_at, usage: result.usage },
        source_width: result.image.width,
        source_height: result.image.height,
        final_width: AV2_VISUAL_FRAME_POLICY_V1.final.width,
        final_height: AV2_VISUAL_FRAME_POLICY_V1.final.height,
        storage_bucket: store.bucket,
        storage_path: path,
        character_reference_hash: CANONICAL_LUMI_REFERENCE_HASH,
        world_manifest_version: plan.benchmark.world_manifest.version,
        scene_manifest_version: scene.manifest.version,
        generated_at: result.created_at,
        status: "generated",
      });
      await store.setSpecificationStatus(records[index].id, "generated");
      const reviewUrl = await store.createReviewUrl(path);
      await store.attachReviewUrl(asset.id, reviewUrl, new Date(Date.now() + 7200 * 1000).toISOString());
      assets.push(asset);
      log(logger, "visual_benchmark_asset_persisted", {
        scene_id: scene.scene_id, asset_id: asset.id, asset_hash: asset.asset_hash,
        provider_calls: providerCalls,
      });
    } catch (providerFailure) {
      await store.setSpecificationStatus(records[index].id, "rejected", providerFailure.diagnostic || {
        code: providerFailure.code || "visual_benchmark_generation_failed",
        message: String(providerFailure.message || "generation failed").slice(0, 1200),
      });
      log(logger, "visual_benchmark_provider_call_failed", {
        scene_id: scene.scene_id, provider_calls: providerCalls,
        error_code: providerFailure.diagnostic?.code || providerFailure.code || "visual_benchmark_generation_failed",
      });
      if (systemicProviderError(providerFailure)) throw providerFailure;
    }
  }
  log(logger, "visual_benchmark_completed", {
    provider_calls: providerCalls,
    successful_generations: assets.length,
    failed_generations: plan.scenes.length - assets.length,
  });
  return { ok: assets.length === plan.scenes.length, provider_calls: providerCalls, cache_hits: 3 - missingCount, assets };
}
