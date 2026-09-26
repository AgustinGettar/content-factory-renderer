import { contentHash } from "../av2/contracts.js";
import { characterIdentityHash } from "./character-lock.js";
import { AV2_VISUAL_FRAME_POLICY_V1 } from "./framing.js";
import { ASSET_V2_IMAGE_MODEL, generateBenchmarkComposite, inspectPng } from "./image-provider.js";
import { compileVisualPromptV11 } from "./prompt-compiler.js";
import { fetchCanonicalReference, VISUAL_BENCHMARK_ARTIFACT_ID } from "./visual-benchmark-runner.js";
import {
  GARDEN_WORLD_LANDMARK_LOCK_V1,
  VISUAL_BENCHMARK_V11_VERSION,
  buildVisualBenchmarkV11,
  validateComposition,
} from "./visual-benchmark-v11.js";

export const VISUAL_BENCHMARK_V11_CALL_CAP = 2;
export const VISUAL_BENCHMARK_V11_VARIANT = "visual_benchmark_v1_1";

function log(logger, event, fields = {}) {
  logger?.({ component: "asset_v2_visual_benchmark_v11", event, ...fields });
}

export function shouldRunVisualBenchmarkV11({ engineVersion, benchmarkOnly, runOnBoot }) {
  return engineVersion === "v2" && benchmarkOnly === true && runOnBoot === true;
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

export function buildVisualBenchmarkV11Plan(snapshot) {
  const benchmark = buildVisualBenchmarkV11(snapshot);
  const characterLockHash = characterIdentityHash(benchmark.character_lock);
  const worldHash = contentHash(benchmark.world_manifest);
  const propRegistryHash = contentHash(benchmark.prop_registry);
  const scenes = benchmark.scenes.map((scene) => {
    const preflight = validateComposition(scene.manifest);
    if (!preflight.ok) throw new Error(`visual_benchmark_v11_preflight_failed:${scene.scene_id}`);
    const compiled = compileVisualPromptV11({
      manifest: scene.manifest,
      worldManifest: benchmark.world_manifest,
      propRegistry: benchmark.prop_registry,
    });
    const referenceHashes = [
      benchmark.character_lock.canonical_lumi_reference.sha256,
      GARDEN_WORLD_LANDMARK_LOCK_V1.evidence.asset_hash,
    ];
    const requestHash = contentHash({
      provider: "openai",
      model: ASSET_V2_IMAGE_MODEL,
      size: AV2_VISUAL_FRAME_POLICY_V1.source.size,
      quality: "high",
      reference_hashes: referenceHashes,
      prompt_hash: compiled.prompt_hash,
    });
    return { ...scene, compiled, request_hash: requestHash, reference_hashes: referenceHashes, preflight };
  });
  if (scenes.length !== VISUAL_BENCHMARK_V11_CALL_CAP) throw new Error("visual_benchmark_v11_must_have_two_scenes");
  return { benchmark, scenes, characterLockHash, worldHash, propRegistryHash };
}

async function persistPlan(store, snapshot, plan) {
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
      character_reference_hash: scene.reference_hashes[0],
      world_manifest_version: plan.benchmark.world_manifest.version,
      world_manifest_hash: plan.worldHash,
      prop_registry_version: plan.benchmark.prop_registry.version,
      prop_registry_hash: plan.propRegistryHash,
      framing_policy: scene.manifest.composition_contract.safe_frame,
      status: "planned",
    }));
  }
  return records;
}

function systemicProviderError(error) {
  const status = Number(error?.diagnostic?.http_status || 0);
  return status === 0 || status >= 400;
}

export async function runVisualBenchmarkV11OnBoot({
  supabase,
  store,
  apiKey,
  supabaseUrl,
  logger,
  generate = generateBenchmarkComposite,
  fetchImpl = fetch,
  loadReferences,
}) {
  if (!supabase || !store) throw new Error("visual_benchmark_v11_storage_not_configured");
  log(logger, "visual_benchmark_v11_started", { planned_provider_calls: VISUAL_BENCHMARK_V11_CALL_CAP });
  const { data: artifact, error } = await supabase.from("av2_creative_artifacts").select("*")
    .eq("id", VISUAL_BENCHMARK_ARTIFACT_ID).single();
  if (error) throw new Error("visual_benchmark_v11_artifact_read_failed");
  const snapshot = snapshotFromArtifact(artifact);
  const plan = buildVisualBenchmarkV11Plan(snapshot);
  for (const scene of plan.scenes) {
    log(logger, "visual_benchmark_v11_preflight_passed", { scene_id: scene.scene_id, preflight_hash: scene.preflight_hash });
  }
  const approvedWorld = await store.findAssetBySceneVariant(snapshot.artifact_id, "s11", "visual_benchmark_v1");
  if (!approvedWorld || approvedWorld.status !== "qa_passed"
      || approvedWorld.id !== GARDEN_WORLD_LANDMARK_LOCK_V1.evidence.asset_id
      || approvedWorld.asset_hash !== GARDEN_WORLD_LANDMARK_LOCK_V1.evidence.asset_hash) {
    throw new Error("visual_benchmark_v11_s11_approved_reference_mismatch");
  }
  const parents = new Map();
  for (const scene of plan.scenes) {
    const parent = await store.findAssetBySceneVariant(snapshot.artifact_id, scene.scene_id, "visual_benchmark_v1");
    if (!parent || parent.status !== "rejected") throw new Error(`visual_benchmark_v11_parent_missing:${scene.scene_id}`);
    parents.set(scene.scene_id, parent);
  }
  const records = await persistPlan(store, snapshot, plan);
  await store.assertStorageReady();
  const existing = [];
  for (const scene of plan.scenes) existing.push(await store.findAssetBySpecificationHash(scene.cache_key));
  const missingCount = existing.filter((asset) => !asset).length;
  if (missingCount > VISUAL_BENCHMARK_V11_CALL_CAP) throw new Error("visual_benchmark_v11_call_budget_exceeded");
  if (missingCount === 0) {
    log(logger, "visual_benchmark_v11_cache_hit", { provider_calls: 0, cache_hits: 2 });
    return { ok: true, provider_calls: 0, cache_hits: 2, assets: existing };
  }
  const references = loadReferences ? await loadReferences({ approvedWorld }) : {
    lumi: await fetchCanonicalReference({ supabaseUrl, fetchImpl }),
    world: await store.downloadPng(approvedWorld.storage_path),
  };
  if (inspectPng(references.lumi).sha256 !== plan.scenes[0].reference_hashes[0]) throw new Error("visual_benchmark_v11_lumi_reference_hash_mismatch");
  if (inspectPng(references.world).sha256 !== plan.scenes[0].reference_hashes[1]) throw new Error("visual_benchmark_v11_world_reference_hash_mismatch");
  const referenceBuffers = [
    { buffer: references.lumi, filename: "image-1-canonical-lumi.png" },
    { buffer: references.world, filename: "image-2-approved-s11-world.png" },
  ];
  let providerCalls = 0;
  const assets = [];
  for (let index = 0; index < plan.scenes.length; index += 1) {
    const scene = plan.scenes[index];
    if (existing[index]) {
      assets.push(existing[index]);
      continue;
    }
    const claimed = await store.claimSpecification(records[index].id);
    if (!claimed) throw new Error(`visual_benchmark_v11_specification_not_claimable:${scene.scene_id}`);
    providerCalls += 1;
    if (providerCalls > VISUAL_BENCHMARK_V11_CALL_CAP) throw new Error("visual_benchmark_v11_call_budget_exceeded");
    log(logger, "visual_benchmark_v11_provider_call_started", { scene_id: scene.scene_id, provider_calls: providerCalls });
    try {
      const result = await generate({
        apiKey,
        model: ASSET_V2_IMAGE_MODEL,
        prompt: scene.compiled.text,
        referenceBuffers,
        size: AV2_VISUAL_FRAME_POLICY_V1.source.size,
        quality: "high",
        fetchImpl,
      });
      if (result.image.width !== AV2_VISUAL_FRAME_POLICY_V1.source.width
          || result.image.height !== AV2_VISUAL_FRAME_POLICY_V1.source.height) {
        throw new Error(`visual_benchmark_v11_wrong_provider_dimensions:${result.image.width}x${result.image.height}`);
      }
      const path = `${snapshot.artifact_id}/benchmark_composite/${scene.cache_key}/visual-benchmark-v1-1.png`;
      await store.uploadPng(path, result.buffer, {
        artifact_id: snapshot.artifact_id,
        scene_id: scene.scene_id,
        benchmark_version: VISUAL_BENCHMARK_V11_VERSION,
        specification_hash: scene.cache_key,
        content_sha256: result.image.sha256,
        parent_asset_id: parents.get(scene.scene_id).id,
      });
      const asset = await store.saveGeneratedAsset({
        artifact_id: snapshot.artifact_id,
        scene_id: scene.scene_id,
        specification_id: records[index].id,
        specification_hash: scene.cache_key,
        variant: VISUAL_BENCHMARK_V11_VARIANT,
        asset_hash: result.image.sha256,
        provider: result.provider,
        provider_model: result.model,
        provider_request_hash: scene.request_hash,
        provider_response_id: result.provider_response_id,
        provider_request_id: result.provider_request_id,
        provider_metadata: {
          created_at: result.created_at,
          usage: result.usage,
          benchmark_version: VISUAL_BENCHMARK_V11_VERSION,
          preflight_hash: scene.preflight_hash,
          reference_inputs: [
            { index: 1, role: "canonical_lumi_identity", sha256: scene.reference_hashes[0] },
            { index: 2, role: "approved_s11_world_evidence", sha256: scene.reference_hashes[1] },
          ],
        },
        source_width: result.image.width,
        source_height: result.image.height,
        final_width: AV2_VISUAL_FRAME_POLICY_V1.final.width,
        final_height: AV2_VISUAL_FRAME_POLICY_V1.final.height,
        storage_bucket: store.bucket,
        storage_path: path,
        character_reference_hash: scene.reference_hashes[0],
        world_manifest_version: plan.benchmark.world_manifest.version,
        scene_manifest_version: scene.manifest.version,
        parent_asset_id: parents.get(scene.scene_id).id,
        status: "generated",
        generated_at: result.created_at,
      });
      await store.setSpecificationStatus(records[index].id, "generated");
      const reviewUrl = await store.createReviewUrl(path);
      await store.attachReviewUrl(asset.id, reviewUrl, new Date(Date.now() + 7200 * 1000).toISOString());
      assets.push(asset);
      log(logger, "visual_benchmark_v11_asset_persisted", {
        scene_id: scene.scene_id,
        asset_id: asset.id,
        asset_hash: asset.asset_hash,
        provider_calls: providerCalls,
      });
    } catch (providerFailure) {
      await store.setSpecificationStatus(records[index].id, "rejected", providerFailure.diagnostic || {
        code: providerFailure.code || "visual_benchmark_v11_generation_failed",
        message: String(providerFailure.message || "generation failed").slice(0, 1200),
      });
      log(logger, "visual_benchmark_v11_provider_call_failed", {
        scene_id: scene.scene_id,
        provider_calls: providerCalls,
        error_code: providerFailure.diagnostic?.code || providerFailure.code || "visual_benchmark_v11_generation_failed",
      });
      if (systemicProviderError(providerFailure)) throw providerFailure;
    }
  }
  log(logger, "visual_benchmark_v11_completed", {
    provider_calls: providerCalls,
    successful_generations: assets.length,
    failed_generations: plan.scenes.length - assets.length,
  });
  return { ok: assets.length === plan.scenes.length, provider_calls: providerCalls, cache_hits: 2 - missingCount, assets };
}
