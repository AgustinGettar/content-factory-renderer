import { contentHash } from "./av2/contracts.js";
import {
  buildPropRegistry,
  buildSceneAssetManifest,
  buildWorldManifest,
} from "./asset-v2/director.js";
import { LUMI_CHARACTER_LOCK_V1, characterIdentityHash } from "./asset-v2/character-lock.js";
import { AV2_VISUAL_FRAME_POLICY_V1 } from "./asset-v2/framing.js";
import { evaluateVisualQAV12, VISIBILITY_REQUIREMENT } from "./asset-v2/visual-qa-v12.js";
import {
  ASSET_V2_IMAGE_MODEL,
  generateBenchmarkComposite,
} from "./asset-v2/image-provider.js";
import { fetchCanonicalReference, VISUAL_BENCHMARK_ARTIFACT_ID } from "./asset-v2/visual-benchmark-runner.js";
import {
  GENERATIVE_VIDEO_BUCKET,
  buildModelInput,
  compileGenerativeVideoPromptV1,
  ensureBucket,
  parseEstimateUsd,
  pollRequest,
  providerJson,
  readJsonObject,
  sha256,
  uploadObject,
  writeJsonObject,
} from "./generative-video-benchmark-v1.js";

export const LUMI_PRODUCTION_PILOT_V1 = "lumi-production-pilot/1";
export const LUMI_PILOT_IMAGE_COMPILER_V1 = "lumi-pilot-image-prompt-compiler/1";
export const LUMI_PILOT_REPAIR_SPEC_VERSION = "scene-asset-manifest/production-pilot-v1-repair-1";
export const LUMI_PILOT_PREFIX = "lumi-production-pilot-v1";
export const LUMI_PILOT_SOURCE_VARIANT = "production_pilot_v1_source";
export const LUMI_PILOT_IMAGE_CALL_CAP = 6;
export const LUMI_PILOT_VIDEO_CALL_CAP = 6;
export const LUMI_PILOT_IMAGE_MAX_USD = 2;
export const LUMI_PILOT_VIDEO_MAX_USD = 3;
export const LUMI_PILOT_IMAGE_ESTIMATE_USD = 0.103052;
export const LUMI_PILOT_VIDEO_MODEL = Object.freeze({
  model: "kling-video/v3.0/std/image-to-video",
  input: Object.freeze({ duration: 5, sound: "off", multi_shots: false, cfg_scale: 0.5 }),
});
export const LUMI_PILOT_SCENE_IDS = Object.freeze(["s13", "s14", "s15", "s16", "s18", "s19"]);

const safeBox = Object.freeze({ x: 0.12, y: 0.13, width: 0.76, height: 0.75 });

export function buildPilotVisibilityContract(sceneId, manifest) {
  if (!LUMI_PILOT_SCENE_IDS.includes(sceneId)) throw new Error("lumi_pilot_scene_not_allowed");
  const eggs = manifest.pilot_semantics.visible_egg_ids;
  return {
    version: "entity-visibility-contract/1.2",
    scene_id: sceneId,
    entities: [
      { entity_id: "lumi", required: true, visibility_requirement: VISIBILITY_REQUIREMENT.CRITICAL_REGION,
        critical_regions: ["face", "eyes", "active_hand"].map((region_id) => ({ region_id, planned_bounds: safeBox })) },
      { entity_id: "lumi_wand_01", required: true, visibility_requirement: VISIBILITY_REQUIREMENT.CRITICAL_REGION,
        critical_regions: [{ region_id: "wand_star", planned_bounds: safeBox }] },
      ...eggs.map((entity_id) => ({ entity_id, required: true, visibility_requirement: VISIBILITY_REQUIREMENT.FULL, critical_regions: [] })),
      ...(["s18", "s19"].includes(sceneId) ? [{ entity_id: "gallina_amable", required: true,
        visibility_requirement: VISIBILITY_REQUIREMENT.RECOGNIZABLE,
        critical_regions: ["head", "face", "torso"].map((region_id) => ({ region_id, planned_bounds: safeBox })) }] : []),
      ...(sceneId === "s19" ? [{ entity_id: "basket_01", required: true,
        visibility_requirement: VISIBILITY_REQUIREMENT.RECOGNIZABLE,
        critical_regions: [{ region_id: "basket_body", planned_bounds: safeBox }] }] : []),
    ],
  };
}

export function evaluatePilotVisualQA({ sceneId, manifest, observation }) {
  const contract = buildPilotVisibilityContract(sceneId, manifest);
  const result = evaluateVisualQAV12({ manifest, contract, observation });
  const findings = [...result.findings];
  if (observation.motion_ready === false) findings.push({ severity: "BLOCKER", code: "source_not_motion_ready", entity_id: "lumi", message: "Critical pose or motion arc is unusable" });
  if (observation.semantic_match === false) findings.push({ severity: "BLOCKER", code: "scene_semantic_drift", entity_id: sceneId, message: "Source no longer expresses the canonical educational beat" });
  if (observation.world_landmark_match === false) findings.push({ severity: "BLOCKER", code: "world_landmark_drift", entity_id: manifest.pilot_semantics.required_landmark, message: "Required landmark changed identity" });
  if (observation.egg_count_verified !== manifest.pilot_semantics.exact_egg_count) findings.push({ severity: "BLOCKER", code: "visually_verified_egg_count_mismatch", entity_id: "eggs", message: "Manual count differs from canonical scene" });
  const counts = { BLOCKER: 0, WARNING: 0, INFO: 0 };
  findings.forEach((item) => { counts[item.severity] += 1; });
  return { version: "visual-qa/1.2", accepted: counts.BLOCKER === 0, counts, findings, observation };
}

const SCENE_SEMANTICS = Object.freeze({
  s13: Object.freeze({ purpose: "discover_and_name_two", beat: "beat_find2", exact_eggs: 1, eggs: ["egg_02"], landmark: "stone_marker_01", motion: "Lumi notices egg_02 by the rounded stone, eyes lead, then gently points with the wand and settles after naming two.", expression: "focused", action: "wand_point" }),
  s14: Object.freeze({ purpose: "discover_and_name_three", beat: "beat_find3", exact_eggs: 1, eggs: ["egg_03"], landmark: "grass_patch_01", motion: "Lumi discovers egg_03 in the grass, looks down naturally, points with a smooth teaching gesture and warmly presents the third egg.", expression: "focused", action: "pointing_down" }),
  s15: Object.freeze({ purpose: "discover_and_name_four", beat: "beat_find4", exact_eggs: 1, eggs: ["egg_04"], landmark: "tree_trunk_01", motion: "Lumi finds egg_04 near the canonical tree landmark, follows it with her gaze, points down, then settles after naming four.", expression: "focused", action: "pointing_down" }),
  s16: Object.freeze({ purpose: "discover_fifth_and_total", beat: "beat_find5", exact_eggs: 1, eggs: ["egg_05"], landmark: "garden_path", motion: "Lumi discovers egg_05 on the path, celebrates gently with the wand while preserving the egg, then settles after announcing five in total.", expression: "celebrating", action: "pointing_down" }),
  s18: Object.freeze({ purpose: "confirm_and_count_one_to_five", beat: "beat_answer", exact_eggs: 5, eggs: ["egg_01", "egg_02", "egg_03", "egg_04", "egg_05"], landmark: "basket_clearing", motion: "Lumi and gallina_amable celebrate the correct answer; Lumi counts all five eggs left-to-right with natural eyes, head and hand coordination, then settles.", expression: "encouraging", action: "counting" }),
  s19: Object.freeze({ purpose: "recap_and_close", beat: "beat_recap", exact_eggs: 5, eggs: ["egg_01", "egg_02", "egg_03", "egg_04", "egg_05"], landmark: "basket_clearing", motion: "Lumi presents the basket containing exactly five individually visible eggs while gallina_amable thanks the viewer; both give a warm restrained closing reaction and settle.", expression: "neutral_happy", action: "presenting" }),
});

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

function imageActualCost(usage) {
  const details = usage?.input_tokens_details || {};
  const output = usage?.output_tokens_details || {};
  if (![details.text_tokens, details.image_tokens, output.image_tokens].every(Number.isFinite)) return null;
  return Number((details.text_tokens * 2.5 / 1e6 + details.image_tokens * 4 / 1e6 + output.image_tokens * 15 / 1e6).toFixed(6));
}

function visibleSceneProps(manifest, semantics) {
  const allowed = new Set([...semantics.eggs, "lumi_wand_01"]);
  if (manifest.scene_id === "s19") allowed.add("basket_01");
  return manifest.props.map((prop) => ({ ...prop, visible: allowed.has(prop.prop_id) }));
}

export function derivePilotSceneSpecification(snapshot, sceneId) {
  const semantics = SCENE_SEMANTICS[sceneId];
  if (!semantics) throw new Error(`lumi_pilot_scene_not_allowed:${sceneId}`);
  const worldManifest = buildWorldManifest(snapshot);
  const propRegistry = buildPropRegistry(snapshot);
  const base = buildSceneAssetManifest({ snapshot, sceneId, worldManifest, propRegistry });
  const manifest = {
    ...base,
    props: visibleSceneProps(base, semantics),
    pilot_semantics: {
      educational_purpose: semantics.purpose,
      story_beat: semantics.beat,
      exact_egg_count: semantics.exact_eggs,
      visible_egg_ids: semantics.eggs,
      required_landmark: semantics.landmark,
      lumi_expression: semantics.expression,
      lumi_action: semantics.action,
      motion_intent: semantics.motion,
      visibility_contracts: {
        eggs: "FULL",
        lumi_face_eyes: "CRITICAL_REGION",
        active_hand_wand: "CRITICAL_REGION",
        gallina_amable: sceneId === "s18" || sceneId === "s19" ? "RECOGNIZABLE" : "NOT_REQUIRED",
        scenery: "DECORATIVE",
      },
    },
  };
  const scene = snapshot.payload.scenes.find((entry) => entry.id === sceneId);
  return { scene, worldManifest, propRegistry, manifest, semantics };
}

export function compilePilotImagePromptV1({ scene, worldManifest, propRegistry, manifest, semantics }) {
  const eggText = semantics.eggs.join(", ");
  const gallinaRule = ["s18", "s19"].includes(scene.id)
    ? "gallina_amable is required and recognizable, visually integrated at a natural scale."
    : "Do not add gallina_amable in this scene.";
  const basketRule = scene.id === "s19"
    ? "The canonical woven basket is required; all five eggs are inside it yet each egg remains fully visible and individually countable above the rim."
    : "Do not add a basket unless the canonical scene state explicitly requires it.";
  const text = [
    `[VERSION]\n${LUMI_PILOT_IMAGE_COMPILER_V1}`,
    `[REFERENCE_HIERARCHY]\nImage 1 is the canonical Lumi identity master. Image 2 is approved garden_world_01 world evidence only. Preserve Lumi and the world; do not copy the reference composition or its scene-specific props.`,
    `[STYLE]\nHigh-end original stylized 3D children's educational animation, clean premium CGI, bright cheerful cinematic lighting, vibrant saturated preschool-safe palette, rounded stylized proportions, soft clay-like materials and expressive cartoon eyes. No photorealism, 2D cutout, collage or uncanny anatomy.`,
    `[CHARACTER_LOCK]\nPreserve exactly the same Lumi: warm rounded yellow body, large turquoise eyes, rosy cheeks, thin antennae with violet tips, small hair tuft, translucent light-blue wings, light-blue denim overalls, white/light-blue shoes, canonical star wand and childlike proportions. Same face, colors, clothing and body identity in every scene.`,
    `[WORLD_LOCK]\n${worldManifest.environment_id}: ${worldManifest.geography} Preserve the canonical tree with arched wooden door and round blue four-panel window, curved path, fence, vegetation, lighting, palette, materials and stable geography. Required landmark for this view: ${semantics.landmark}.`,
    `[SCENE_SEMANTICS]\nScene ${scene.id}; educational purpose=${semantics.purpose}; story beat=${semantics.beat}. Lumi expression=${semantics.expression}; action=${semantics.action}. ${scene.audio.utterances.map((entry) => entry.text).join(" ")}`,
    `[COUNT_AND_PROP_LOCK]\nRender EXACTLY ${semantics.exact_eggs} pedagogical egg${semantics.exact_eggs === 1 ? "" : "s"}: ${eggText}. Every visible egg is warm ivory, complete, unoccluded, clearly separated, individually distinguishable and fully inside the pedagogical safe area. No other oval decoration or egg-like object. Preserve the canonical wand. ${basketRule} ${gallinaRule}`,
    `[MOTION_AWARE_SOURCE]\nThis is a source keyframe for image-to-video. ${semantics.motion} Leave natural physical space for the future eye/head/arm/wand/wing movement. Keep limbs away from the canvas edge, preserve clean anatomy, avoid closed or tangled poses, keep wings readable, and leave a clear wand arc.`,
    `[CAMERA]\nExact 1152x2048 native portrait 9:16. ${scene.camera.shot} shot; framing=${scene.camera.framing.intent}; camera move intent=${scene.camera.move}. No crop or stretch. Lumi face, eyes, active educational hand and wand star remain safely readable. Eggs follow FULL visibility. Scenery may reach the canvas edge.`,
    `[NEGATIVE]\nNo text, numbers, letters, logo, watermark or signature. No redesign, costume change, extra accessories, extra or missing limbs, malformed hands, duplicate wings, duplicate wand, extra eggs, missing eggs, merged eggs, hidden eggs, incorrect landmark, world drift, flat cutout look, edge-cropped teaching action or distracting props.`,
  ].join("\n\n");
  return { compiler_version: LUMI_PILOT_IMAGE_COMPILER_V1, text, prompt_hash: contentHash(text) };
}

async function loadArtifact(supabase) {
  const { data, error } = await supabase.from("av2_creative_artifacts").select("*")
    .eq("id", VISUAL_BENCHMARK_ARTIFACT_ID).single();
  if (error || !data) throw new Error("lumi_pilot_artifact_read_failed");
  return snapshotFromArtifact(data);
}

async function loadWorldReference(supabase) {
  const { data: asset, error } = await supabase.from("av2_assets").select("*")
    .eq("artifact_id", VISUAL_BENCHMARK_ARTIFACT_ID).eq("scene_id", "s11")
    .eq("variant", "visual_benchmark_v1").eq("asset_hash", "b069f9d7c6ff086708d57e126a3342ed820dc58d58f730f9abd0c1faf65483d4").single();
  if (error || !asset) throw new Error("lumi_pilot_world_reference_missing");
  const { data, error: downloadError } = await supabase.storage.from(asset.storage_bucket).download(asset.storage_path);
  if (downloadError) throw new Error("lumi_pilot_world_reference_download_failed");
  const buffer = Buffer.from(await data.arrayBuffer());
  if (sha256(buffer) !== asset.asset_hash) throw new Error("lumi_pilot_world_reference_hash_mismatch");
  return { asset, buffer };
}

export async function buildPilotImagePlan({ supabase, supabaseUrl }) {
  const snapshot = await loadArtifact(supabase);
  const scenes = LUMI_PILOT_SCENE_IDS.map((sceneId) => {
    const specification = derivePilotSceneSpecification(snapshot, sceneId);
    const prompt = compilePilotImagePromptV1(specification);
    const specificationHash = contentHash({
      version: LUMI_PRODUCTION_PILOT_V1,
      manifest: specification.manifest,
      prompt_hash: prompt.prompt_hash,
    });
    const requestHash = contentHash({
      provider: "openai", model: ASSET_V2_IMAGE_MODEL, size: "1152x2048", quality: "high",
      prompt_hash: prompt.prompt_hash,
      reference_hashes: [LUMI_CHARACTER_LOCK_V1.canonical_lumi_reference.sha256, "b069f9d7c6ff086708d57e126a3342ed820dc58d58f730f9abd0c1faf65483d4"],
    });
    return { sceneId, ...specification, prompt, specificationHash, requestHash };
  });
  return { snapshot, scenes, supabaseUrl };
}

export async function preflightPilotImages({ supabase, supabaseUrl, maxUsd = LUMI_PILOT_IMAGE_MAX_USD }) {
  if (!supabase) throw new Error("lumi_pilot_storage_not_configured");
  const plan = await buildPilotImagePlan({ supabase, supabaseUrl });
  const existing = [];
  const attempts = [];
  for (const scene of plan.scenes) {
    const { data } = await supabase.from("av2_assets").select("*")
      .eq("specification_hash", scene.specificationHash).eq("variant", LUMI_PILOT_SOURCE_VARIANT).maybeSingle();
    existing.push(data || null);
    const { data: specification } = await supabase.from("av2_scene_asset_manifests").select("id,status")
      .eq("specification_hash", scene.specificationHash).maybeSingle();
    attempts.push(specification || null);
  }
  const missing = existing.filter((entry) => !entry).length;
  // A planned specification is already the durable, unique provider-attempt
  // lock. Count it immediately so a process restart can never turn an
  // interrupted attempt into a second paid call.
  const attempted = attempts.filter(Boolean).length;
  const remaining = plan.scenes.filter((_, index) => !existing[index] && !attempts[index]);
  const totalUsd = Number((remaining.length * LUMI_PILOT_IMAGE_ESTIMATE_USD).toFixed(6));
  const result = {
    version: LUMI_PRODUCTION_PILOT_V1,
    image_model: ASSET_V2_IMAGE_MODEL,
    cost_method: "official_gpt_image_2_token_rates_with_historical_same_model_usage_upper_bound",
    estimated_cost_per_image_usd: LUMI_PILOT_IMAGE_ESTIMATE_USD,
    planned_scenes: LUMI_PILOT_SCENE_IDS,
    missing_scenes: plan.scenes.filter((_, index) => !existing[index]).map((entry) => entry.sceneId),
    provider_calls_so_far: attempted,
    attempted_scenes: plan.scenes.filter((_, index) => Boolean(attempts[index])).map((entry) => entry.sceneId),
    ambiguous_scenes: plan.scenes.filter((_, index) => attempts[index] && !existing[index]).map((entry) => entry.sceneId),
    estimated_total_usd: totalUsd,
    max_total_usd: Number(maxUsd),
    cost_gate_passed: totalUsd <= Number(maxUsd),
    ready: attempted + remaining.length <= LUMI_PILOT_IMAGE_CALL_CAP && totalUsd <= Number(maxUsd),
  };
  await ensureBucket(supabase);
  await writeJsonObject(supabase, `${LUMI_PILOT_PREFIX}/images/preflight.json`, { ...result, checked_at: new Date().toISOString() });
  return { ...result, plan, existing, attempts };
}

export async function persistSpecification(store, plan, scene, {
  version = "scene-asset-manifest/production-pilot-v1",
  benchmarkRole = `production_pilot_${scene.semantics.beat}`,
} = {}) {
  const characterLockHash = characterIdentityHash(LUMI_CHARACTER_LOCK_V1);
  return store.saveSceneSpecification({
    artifact_id: plan.snapshot.artifact_id,
    scene_id: scene.sceneId,
    benchmark_role: benchmarkRole,
    version,
    manifest: scene.manifest,
    specification_hash: scene.specificationHash,
    asset_manifest_hash: scene.manifest.asset_specification_hash,
    compiled_prompt: scene.prompt.text,
    compiled_prompt_hash: scene.prompt.prompt_hash,
    provider_request_hash: scene.requestHash,
    character_lock_version: LUMI_CHARACTER_LOCK_V1.version,
    character_lock_hash: characterLockHash,
    character_reference_version: "canonical-lumi-reference/1",
    character_reference_hash: LUMI_CHARACTER_LOCK_V1.canonical_lumi_reference.sha256,
    world_manifest_version: scene.worldManifest.version,
    world_manifest_hash: contentHash(scene.worldManifest),
    prop_registry_version: scene.propRegistry.version,
    prop_registry_hash: contentHash(scene.propRegistry),
    framing_policy: { ...AV2_VISUAL_FRAME_POLICY_V1, semantics: "visual-qa/1.2" },
    status: "planned",
  });
}

export async function runPilotImages({ supabase, store, apiKey, supabaseUrl, sceneId, maxUsd = LUMI_PILOT_IMAGE_MAX_USD, fetchImpl = fetch, onUpdate = () => {} }) {
  const preflight = await preflightPilotImages({ supabase, supabaseUrl, maxUsd });
  if (!apiKey) throw new Error("lumi_pilot_image_provider_not_configured");
  if (!preflight.ready) throw new Error("lumi_pilot_image_preflight_not_ready");
  if (!LUMI_PILOT_SCENE_IDS.includes(sceneId)) throw new Error("lumi_pilot_scene_not_allowed");
  const index = preflight.plan.scenes.findIndex((entry) => entry.sceneId === sceneId);
  if (preflight.existing[index]) return { status: "cache_hit", scene_id: sceneId, provider_calls: preflight.provider_calls_so_far, asset: preflight.existing[index] };
  if (preflight.attempts[index]) throw new Error(`lumi_pilot_image_attempt_already_recorded:${sceneId}`);
  const lumi = await fetchCanonicalReference({ supabaseUrl, fetchImpl });
  const world = await loadWorldReference(supabase);
  const results = [];
  let providerCalls = preflight.provider_calls_so_far;
  for (let index = 0; index < preflight.plan.scenes.length; index += 1) {
    const scene = preflight.plan.scenes[index];
    if (scene.sceneId !== sceneId) continue;
    providerCalls += 1;
    if (providerCalls > LUMI_PILOT_IMAGE_CALL_CAP) throw new Error("lumi_pilot_image_call_cap_exceeded");
    const specification = await persistSpecification(store, preflight.plan, scene);
    const claimed = await store.claimSpecification(specification.id);
    if (!claimed) throw new Error(`lumi_pilot_image_attempt_not_claimable:${scene.sceneId}`);
    onUpdate({ phase: "images", status: "processing", scene_id: scene.sceneId, provider_calls: providerCalls });
    try {
      const result = await generateBenchmarkComposite({
        apiKey,
        model: ASSET_V2_IMAGE_MODEL,
        prompt: scene.prompt.text,
        referenceBuffers: [
          { buffer: lumi, filename: "canonical-lumi.png" },
          { buffer: world.buffer, filename: "approved-garden-world.png" },
        ],
        size: "1152x2048",
        quality: "high",
        fetchImpl,
      });
      if (result.image.width !== 1152 || result.image.height !== 2048) throw new Error("lumi_pilot_image_wrong_dimensions");
      const storagePath = `${preflight.plan.snapshot.artifact_id}/production_pilot_v1/source/${scene.sceneId}/${scene.specificationHash}/source.png`;
      await store.uploadPng(storagePath, result.buffer, {
        artifact_id: preflight.plan.snapshot.artifact_id,
        scene_id: scene.sceneId,
        specification_hash: scene.specificationHash,
        content_sha256: result.image.sha256,
      });
      const asset = await store.saveGeneratedAsset({
        artifact_id: preflight.plan.snapshot.artifact_id,
        scene_id: scene.sceneId,
        specification_id: specification.id,
        specification_hash: scene.specificationHash,
        variant: LUMI_PILOT_SOURCE_VARIANT,
        asset_hash: result.image.sha256,
        provider: result.provider,
        provider_model: result.model,
        provider_request_hash: scene.requestHash,
        provider_response_id: result.provider_response_id,
        provider_request_id: result.provider_request_id,
        provider_metadata: {
          pilot_version: LUMI_PRODUCTION_PILOT_V1,
          created_at: result.created_at,
          usage: result.usage,
          estimated_cost_usd: LUMI_PILOT_IMAGE_ESTIMATE_USD,
          actual_cost_usd: imageActualCost(result.usage),
          reference_hashes: [LUMI_CHARACTER_LOCK_V1.canonical_lumi_reference.sha256, world.asset.asset_hash],
        },
        source_width: result.image.width,
        source_height: result.image.height,
        final_width: 1080,
        final_height: 1920,
        storage_bucket: store.bucket,
        storage_path: storagePath,
        character_reference_hash: LUMI_CHARACTER_LOCK_V1.canonical_lumi_reference.sha256,
        world_manifest_version: scene.worldManifest.version,
        scene_manifest_version: "scene-asset-manifest/production-pilot-v1",
        generated_at: result.created_at,
        status: "generated",
      });
      await store.setSpecificationStatus(specification.id, "generated");
      const reviewUrl = await store.createReviewUrl(storagePath);
      await store.attachReviewUrl(asset.id, reviewUrl, new Date(Date.now() + 7200 * 1000).toISOString());
      results.push(asset);
      onUpdate({ phase: "images", status: "completed", scene_id: scene.sceneId, asset_id: asset.id, provider_calls: providerCalls });
    } catch (error) {
      await store.setSpecificationStatus(specification.id, "rejected", { code: error.code || error.message || "generation_failed" });
      const failure = { scene_id: scene.sceneId, status: "failed", error: error.code || error.message || "generation_failed" };
      results.push(failure);
      onUpdate({ phase: "images", ...failure, provider_calls: providerCalls });
      if (Number(error?.diagnostic?.http_status || 0) >= 400) break;
    }
  }
  const summary = {
    version: LUMI_PRODUCTION_PILOT_V1,
    phase: "images",
    status: results.length === 1 && results[0].asset_hash ? "generated" : "generation_failed",
    provider_calls: providerCalls,
    estimated_total_usd: Number((providerCalls * LUMI_PILOT_IMAGE_ESTIMATE_USD).toFixed(6)),
    results,
    finished_at: new Date().toISOString(),
  };
  await writeJsonObject(supabase, `${LUMI_PILOT_PREFIX}/images/${sceneId}/summary.json`, summary);
  return summary;
}

export async function buildPilotImageRepairPlan({ supabase, supabaseUrl }) {
  const plan = await buildPilotImagePlan({ supabase, supabaseUrl });
  const base = plan.scenes.find((entry) => entry.sceneId === "s19");
  if (!base) throw new Error("lumi_pilot_repair_scene_not_found");
  const repairDirective = `[REPAIR_DIRECTIVE]
This is repair attempt 1 for the same canonical S19 scene specification. Correct only the failed visual QA blocker: place all five canonical eggs (egg_01, egg_02, egg_03, egg_04, egg_05) in a single clearly separated row above and in front of the basket rim, with every egg fully visible, unoccluded and individually countable. The basket may remain, but must not hide any egg. Preserve Lumi identity, gallina_amable, canonical garden world, camera semantics, lighting, materials, style, wand and educational recap purpose. Do not add or remove any other prop, do not change the narrative semantics, and do not add text.`;
  const promptText = `${base.prompt.text}\n\n${repairDirective}`;
  const prompt = { ...base.prompt, text: promptText, prompt_hash: contentHash(promptText) };
  const specificationHash = contentHash({
    version: LUMI_PRODUCTION_PILOT_V1,
    repair_attempt: 1,
    base_specification_hash: base.specificationHash,
    manifest: base.manifest,
    prompt_hash: prompt.prompt_hash,
  });
  const requestHash = contentHash({
    provider: "openai", model: ASSET_V2_IMAGE_MODEL, size: "1152x2048", quality: "high",
    repair_attempt: 1, base_request_hash: base.requestHash, prompt_hash: prompt.prompt_hash,
    reference_hashes: [LUMI_CHARACTER_LOCK_V1.canonical_lumi_reference.sha256, "b069f9d7c6ff086708d57e126a3342ed820dc58d58f730f9abd0c1faf65483d4"],
  });
  return { plan, scene: { ...base, prompt, specificationHash, requestHash }, promptText, specificationHash, requestHash };
}

export async function runPilotImageRepair({
  supabase, store, apiKey, supabaseUrl, sceneId, repairAttempt = 1,
  maxUsd = LUMI_PILOT_IMAGE_MAX_USD, fetchImpl = fetch, onUpdate = () => {},
  onPrepared = async () => {}, onBeforeProviderDispatch = async () => {},
  onProviderRequestEmitted = async () => {},
  onProviderResponse = async () => {},
}) {
  if (sceneId !== "s19") throw new Error("lumi_pilot_repair_scene_not_allowed");
  if (repairAttempt !== 1) throw new Error("lumi_pilot_repair_attempt_not_one");
  if (!apiKey) throw new Error("lumi_pilot_image_provider_not_configured");
  if (Number(maxUsd) < LUMI_PILOT_IMAGE_ESTIMATE_USD) throw new Error("lumi_pilot_repair_budget_exceeded");
  const { plan, scene, promptText, specificationHash, requestHash } = await buildPilotImageRepairPlan({ supabase, supabaseUrl });
  const specification = await persistSpecification(store, plan, scene, {
    version: LUMI_PILOT_REPAIR_SPEC_VERSION,
    benchmarkRole: `production_pilot_${scene.semantics.beat}_repair_1`,
  });
  const claimed = await store.claimSpecification(specification.id);
  if (!claimed) throw new Error("lumi_pilot_repair_attempt_not_claimable");
  await onPrepared({ specification_id: specification.id, specification_hash: specificationHash, request_hash: requestHash });
  onUpdate({ phase: "images", status: "preparing", scene_id: "s19", repair_attempt: 1, provider_calls: 0 });
  const lumi = await fetchCanonicalReference({ supabaseUrl, fetchImpl });
  const world = await loadWorldReference(supabase);
  const result = await generateBenchmarkComposite({
    apiKey, model: ASSET_V2_IMAGE_MODEL, prompt: promptText,
    referenceBuffers: [
      { buffer: lumi, filename: "canonical-lumi.png" },
      { buffer: world.buffer, filename: "approved-garden-world.png" },
    ],
    size: "1152x2048", quality: "high",
    fetchImpl: async (...args) => {
      // Durable dispatch intent precedes fetch: a crash after fetch must never resubmit.
      await onBeforeProviderDispatch({ specification_hash: specificationHash, request_hash: requestHash });
      const responsePromise = fetchImpl(...args);
      await onProviderRequestEmitted({ specification_hash: specificationHash, request_hash: requestHash });
      onUpdate({ phase: "images", status: "requested", scene_id: "s19", repair_attempt: 1, provider_calls: 1 });
      const response = await responsePromise;
      await onProviderResponse({ provider_request_id: response.headers?.get?.("x-request-id") || null });
      return response;
    },
  });
  if (result.image.width !== 1152 || result.image.height !== 2048) throw new Error("lumi_pilot_image_wrong_dimensions");
  const storagePath = `${plan.snapshot.artifact_id}/production_pilot_v1/source/s19/${specificationHash}/source.png`;
  await store.uploadPng(storagePath, result.buffer, {
    artifact_id: plan.snapshot.artifact_id, scene_id: "s19",
    specification_hash: specificationHash, content_sha256: result.image.sha256,
  });
  const asset = await store.saveGeneratedAsset({
    artifact_id: plan.snapshot.artifact_id, scene_id: "s19",
    specification_id: specification.id, specification_hash: specificationHash,
    variant: LUMI_PILOT_SOURCE_VARIANT, asset_hash: result.image.sha256,
    provider: result.provider, provider_model: result.model,
    provider_request_hash: requestHash,
    provider_response_id: result.provider_response_id,
    provider_request_id: result.provider_request_id,
    provider_metadata: {
      pilot_version: LUMI_PRODUCTION_PILOT_V1, repair_attempt: 1,
      repair_reason: "SOURCE_REPAIR_REQUIRED", created_at: result.created_at,
      usage: result.usage, estimated_cost_usd: LUMI_PILOT_IMAGE_ESTIMATE_USD,
      actual_cost_usd: imageActualCost(result.usage),
      reference_hashes: [LUMI_CHARACTER_LOCK_V1.canonical_lumi_reference.sha256, world.asset.asset_hash],
    },
    source_width: result.image.width, source_height: result.image.height,
    final_width: 1080, final_height: 1920, storage_bucket: store.bucket,
    storage_path: storagePath, character_reference_hash: LUMI_CHARACTER_LOCK_V1.canonical_lumi_reference.sha256,
    world_manifest_version: scene.worldManifest.version,
    scene_manifest_version: LUMI_PILOT_REPAIR_SPEC_VERSION,
    generated_at: result.created_at, status: "generated",
  });
  await store.setSpecificationStatus(specification.id, "generated");
  const reviewUrl = await store.createReviewUrl(storagePath);
  await store.attachReviewUrl(asset.id, reviewUrl, new Date(Date.now() + 7200 * 1000).toISOString());
  onUpdate({ phase: "images", status: "completed", scene_id: "s19", repair_attempt: 1, asset_id: asset.id, provider_calls: 1 });
  return {
    status: "generated", phase: "images", scene_id: "s19", repair_attempt: 1,
    provider_calls: 1, estimated_total_usd: LUMI_PILOT_IMAGE_ESTIMATE_USD,
    repair_reason: "SOURCE_REPAIR_REQUIRED", specification_hash: specificationHash,
    prompt_hash: scene.prompt.prompt_hash, request_hash: requestHash,
    provider_request_id: result.provider_request_id, artifact_id: asset.artifact_id,
    asset_hash: asset.asset_hash, actual_cost_usd: imageActualCost(result.usage),
    asset, finished_at: new Date().toISOString(),
  };
}

export async function recordPilotVisualQA({ supabase, sceneId, assetHash, observation }) {
  if (!LUMI_PILOT_SCENE_IDS.includes(sceneId)) throw new Error("lumi_pilot_scene_not_allowed");
  const { data: asset, error } = await supabase.from("av2_assets").select("*")
    .eq("artifact_id", VISUAL_BENCHMARK_ARTIFACT_ID).eq("scene_id", sceneId)
    .eq("variant", LUMI_PILOT_SOURCE_VARIANT).eq("asset_hash", assetHash).single();
  if (error || !asset || asset.asset_hash !== assetHash) throw new Error("lumi_pilot_asset_hash_mismatch");
  const { data: existing } = await supabase.from("av2_visual_qa_runs").select("*")
    .eq("asset_id", asset.id).eq("qa_version", "visual-qa/1.2").eq("scope", "individual").eq("run_number", 1).maybeSingle();
  if (existing) return { status: existing.status, result: existing.result, cache_hit: true };
  const plan = await buildPilotImagePlan({ supabase });
  const scene = plan.scenes.find((entry) => entry.sceneId === sceneId);
  let expectedSpecificationHash = scene.specificationHash;
  if (sceneId === "s19" && Number(asset.provider_metadata?.repair_attempt) === 1) {
    expectedSpecificationHash = (await buildPilotImageRepairPlan({ supabase })).specificationHash;
  }
  if (asset.specification_hash !== expectedSpecificationHash) throw new Error("lumi_pilot_specification_hash_mismatch");
  const result = evaluatePilotVisualQA({ sceneId, manifest: scene.manifest, observation });
  const status = result.accepted ? (result.counts.WARNING ? "qa_warning" : "qa_passed") : "rejected";
  const { error: qaError } = await supabase.from("av2_visual_qa_runs").insert({
    artifact_id: asset.artifact_id, asset_id: asset.id, benchmark_version: LUMI_PRODUCTION_PILOT_V1,
    qa_version: "visual-qa/1.2", scope: "individual", run_number: 1,
    result, blocker_count: result.counts.BLOCKER, warning_count: result.counts.WARNING,
    info_count: result.counts.INFO, status,
  });
  if (qaError) throw new Error("lumi_pilot_qa_persistence_failed");
  const { error: updateError } = await supabase.from("av2_assets").update({ status }).eq("id", asset.id);
  if (updateError) throw new Error("lumi_pilot_qa_asset_status_failed");
  return { status, result, asset_id: asset.id, asset_hash: asset.asset_hash };
}

async function approvedPilotSources(supabase) {
  const { data, error } = await supabase.from("av2_assets").select("*")
    .eq("artifact_id", VISUAL_BENCHMARK_ARTIFACT_ID).eq("variant", LUMI_PILOT_SOURCE_VARIANT)
    .in("scene_id", LUMI_PILOT_SCENE_IDS).in("status", ["qa_passed", "qa_warning"]);
  if (error) throw new Error("lumi_pilot_source_query_failed");
  const approved = new Map();
  for (const asset of data || []) {
    const { data: qa } = await supabase.from("av2_visual_qa_runs")
      .select("status,blocker_count,benchmark_version").eq("asset_id", asset.id)
      .eq("qa_version", "visual-qa/1.2").eq("scope", "individual")
      .eq("run_number", 1).maybeSingle();
    if (qa && qa.blocker_count === 0 && qa.benchmark_version === LUMI_PRODUCTION_PILOT_V1
        && ["qa_passed", "qa_warning"].includes(qa.status)) approved.set(asset.scene_id, asset);
  }
  return approved;
}

async function signedPilotSource(supabase, asset) {
  const { data: blob, error: downloadError } = await supabase.storage.from(asset.storage_bucket).download(asset.storage_path);
  if (downloadError || sha256(Buffer.from(await blob.arrayBuffer())) !== asset.asset_hash) {
    throw new Error("lumi_pilot_source_hash_mismatch");
  }
  const { data, error } = await supabase.storage.from(asset.storage_bucket).createSignedUrl(asset.storage_path, 7200);
  if (error || !data?.signedUrl) throw new Error("lumi_pilot_source_signing_failed");
  return data.signedUrl;
}

function videoBase(sceneId, promptHash) {
  return `${LUMI_PILOT_PREFIX}/videos/${sceneId}/${LUMI_PILOT_VIDEO_MODEL.model.replaceAll("/", "__")}/${promptHash}`;
}

export async function preflightPilotVideos({ supabase, apiKey, balanceConfirmed = false, maxUsd = LUMI_PILOT_VIDEO_MAX_USD, fetchImpl = fetch }) {
  if (!apiKey) return { ready: false, api_key_configured: false, auth_verified: false };
  await ensureBucket(supabase);
  const sources = await approvedPilotSources(supabase);
  const scenes = [];
  let apiBalance = null;
  let providerCallsSoFar = 0;
  for (const sceneId of LUMI_PILOT_SCENE_IDS) {
    const asset = sources.get(sceneId);
    if (!asset) continue;
    const sourceUrl = await signedPilotSource(supabase, asset);
    const prompt = compileGenerativeVideoPromptV1(sceneId);
    const estimatePayload = await providerJson(`https://api.higgsfield.ai/estimate/${LUMI_PILOT_VIDEO_MODEL.model}`, {
      apiKey, method: "POST", body: buildModelInput(LUMI_PILOT_VIDEO_MODEL, sourceUrl, prompt), fetchImpl,
    });
    const usd = parseEstimateUsd(estimatePayload, { duration: 5, resolution: "720p" });
    const candidateBalance = Number(estimatePayload?.balance_usd ?? estimatePayload?.available_usd ?? estimatePayload?.balance?.usd);
    if (Number.isFinite(candidateBalance) && candidateBalance >= 0) apiBalance = candidateBalance;
    const base = videoBase(sceneId, prompt.prompt_hash);
    const planned = await readJsonObject(supabase, `${base}/planned.json`);
    const submitted = await readJsonObject(supabase, `${base}/submitted.json`);
    const completed = await readJsonObject(supabase, `${base}/completed.json`);
    if (planned || submitted || completed) providerCallsSoFar += 1;
    scenes.push({ sceneId, asset, sourceUrl, prompt, usd, base, planned, submitted, completed });
  }
  const totalUsd = Number(scenes.reduce((sum, entry) => sum + entry.usd, 0).toFixed(6));
  const balanceSufficient = apiBalance === null ? Boolean(balanceConfirmed) : apiBalance >= totalUsd;
  const result = {
    version: LUMI_PRODUCTION_PILOT_V1,
    phase: "videos",
    api_key_configured: true,
    auth_verified: true,
    balance_api: apiBalance === null ? "unavailable" : "available",
    balance_sufficient: balanceSufficient,
    approved_source_scenes: scenes.map((entry) => entry.sceneId),
    estimates: scenes.map((entry) => ({ scene_id: entry.sceneId, usd: entry.usd, source_hash: entry.asset.asset_hash, prompt_hash: entry.prompt.prompt_hash })),
    total_usd: totalUsd,
    max_total_usd: Number(maxUsd),
    provider_calls_so_far: providerCallsSoFar,
    cost_gate_passed: totalUsd <= Number(maxUsd),
  };
  result.ready = scenes.length > 0 && scenes.length <= LUMI_PILOT_VIDEO_CALL_CAP && result.balance_sufficient
    && result.cost_gate_passed && providerCallsSoFar <= LUMI_PILOT_VIDEO_CALL_CAP;
  await writeJsonObject(supabase, `${LUMI_PILOT_PREFIX}/videos/preflight.json`, { ...result, checked_at: new Date().toISOString() });
  return { ...result, scenes };
}

async function runPilotVideoScene({ supabase, apiKey, scene, fetchImpl }) {
  const completed = await readJsonObject(supabase, `${scene.base}/completed.json`);
  if (completed) return { ...completed, cache_hit: true };
  const previousFailure = await readJsonObject(supabase, `${scene.base}/failed.json`);
  if (previousFailure) return { ...previousFailure, cache_hit: true };
  let submitted = await readJsonObject(supabase, `${scene.base}/submitted.json`);
  const started = Date.now();
  if (!submitted) {
    if (await readJsonObject(supabase, `${scene.base}/planned.json`)) throw new Error(`lumi_pilot_video_submission_ambiguous:${scene.sceneId}`);
    await writeJsonObject(supabase, `${scene.base}/planned.json`, {
      version: LUMI_PRODUCTION_PILOT_V1,
      scene_id: scene.sceneId,
      source_hash: scene.asset.asset_hash,
      prompt_hash: scene.prompt.prompt_hash,
      model: LUMI_PILOT_VIDEO_MODEL.model,
      estimated_cost_usd: scene.usd,
      planned_at: new Date().toISOString(),
    }, false);
    const accepted = await providerJson(`https://api.higgsfield.ai/${LUMI_PILOT_VIDEO_MODEL.model}`, {
      apiKey, method: "POST", body: buildModelInput(LUMI_PILOT_VIDEO_MODEL, scene.sourceUrl, scene.prompt), fetchImpl,
    });
    if (!accepted.request_id || !accepted.status_url) throw new Error("higgsfield_submission_missing_request_handle");
    submitted = {
      version: LUMI_PRODUCTION_PILOT_V1,
      scene_id: scene.sceneId,
      model: LUMI_PILOT_VIDEO_MODEL.model,
      request_id: accepted.request_id,
      status_url: accepted.status_url,
      source_hash: scene.asset.asset_hash,
      prompt_hash: scene.prompt.prompt_hash,
      estimated_cost_usd: scene.usd,
      submitted_at: new Date().toISOString(),
    };
    await writeJsonObject(supabase, `${scene.base}/submitted.json`, submitted, false);
  }
  const terminal = await pollRequest({
    apiKey,
    statusUrl: submitted.status_url,
    fetchImpl,
    onStatus: (payload) => writeJsonObject(supabase, `${scene.base}/status.json`, {
      scene_id: scene.sceneId,
      request_id: submitted.request_id,
      status: payload.status,
      error: payload.error ? String(payload.error).slice(0, 300) : null,
      updated_at: new Date().toISOString(),
    }),
  });
  if (terminal.status !== "completed" || !terminal.video?.url) {
    const failed = { scene_id: scene.sceneId, request_id: submitted.request_id, status: terminal.status, error: String(terminal.error || "generation_failed").slice(0, 300), generation_time_ms: Date.now() - started };
    await writeJsonObject(supabase, `${scene.base}/failed.json`, failed);
    return failed;
  }
  const response = await fetchImpl(terminal.video.url);
  if (!response.ok) throw new Error(`higgsfield_output_download_failed:${response.status}`);
  const video = Buffer.from(await response.arrayBuffer());
  const outputHash = sha256(video);
  const outputPath = `${scene.base}/original.mp4`;
  await uploadObject(supabase, outputPath, video, "video/mp4", false);
  const result = {
    version: LUMI_PRODUCTION_PILOT_V1,
    provider: "higgsfield",
    scene_id: scene.sceneId,
    model: LUMI_PILOT_VIDEO_MODEL.model,
    request_id: submitted.request_id,
    status: "completed",
    source_hash: scene.asset.asset_hash,
    prompt_hash: scene.prompt.prompt_hash,
    duration_seconds: 5,
    audio: "off",
    estimated_cost_usd: scene.usd,
    actual_cost_usd: terminal.cost?.usd ?? terminal.usd ?? null,
    output_bucket: GENERATIVE_VIDEO_BUCKET,
    output_path: outputPath,
    output_hash: outputHash,
    output_bytes: video.length,
    generation_time_ms: Date.now() - started,
    completed_at: new Date().toISOString(),
  };
  await writeJsonObject(supabase, `${scene.base}/completed.json`, result, false);
  return result;
}

export async function runPilotVideos({ supabase, apiKey, balanceConfirmed, sceneId, maxUsd = LUMI_PILOT_VIDEO_MAX_USD, fetchImpl = fetch, onUpdate = () => {} }) {
  const preflight = await preflightPilotVideos({ supabase, apiKey, balanceConfirmed, maxUsd, fetchImpl });
  if (!preflight.ready) throw new Error("lumi_pilot_video_preflight_not_ready");
  if (!LUMI_PILOT_SCENE_IDS.includes(sceneId)) throw new Error("lumi_pilot_scene_not_allowed");
  const selected = preflight.scenes.find((entry) => entry.sceneId === sceneId);
  if (!selected) throw new Error(`lumi_pilot_source_not_approved:${sceneId}`);
  if (selected.completed) return { status: "cache_hit", scene_id: sceneId, provider_calls: preflight.provider_calls_so_far, result: selected.completed };
  if (selected.planned && !selected.submitted) throw new Error(`lumi_pilot_video_submission_ambiguous:${sceneId}`);
  const results = [];
  let providerCalls = preflight.provider_calls_so_far;
  for (const scene of preflight.scenes) {
    if (scene.sceneId !== sceneId) continue;
    const existing = await readJsonObject(supabase, `${scene.base}/completed.json`);
    const submitted = await readJsonObject(supabase, `${scene.base}/submitted.json`);
    if (!existing && !submitted) providerCalls += 1;
    if (providerCalls > LUMI_PILOT_VIDEO_CALL_CAP) throw new Error("lumi_pilot_video_call_cap_exceeded");
    onUpdate({ phase: "videos", status: "processing", scene_id: scene.sceneId, provider_calls: providerCalls });
    try {
      const result = existing || await runPilotVideoScene({ supabase, apiKey, scene, fetchImpl });
      results.push(result);
      onUpdate({ phase: "videos", status: result.status, scene_id: scene.sceneId, request_id: result.request_id, provider_calls: providerCalls });
    } catch (error) {
      const failure = { scene_id: scene.sceneId, status: "failed", error: error.code || error.message || "generation_failed", http_status: error.http_status || null };
      results.push(failure);
      onUpdate({ phase: "videos", ...failure, provider_calls: providerCalls });
      if ([400, 401, 402, 403, 413, 422].includes(Number(error.http_status))) break;
    }
  }
  const summary = {
    version: LUMI_PRODUCTION_PILOT_V1,
    phase: "videos",
    status: results.length === 1 && results[0].status === "completed" ? "generated" : "generation_failed",
    provider_calls: providerCalls,
    estimated_total_usd: preflight.total_usd,
    results,
    finished_at: new Date().toISOString(),
  };
  await writeJsonObject(supabase, `${LUMI_PILOT_PREFIX}/videos/${sceneId}/summary.json`, summary);
  return summary;
}

export async function getPilotStatus({ supabase }) {
  const imagePreflight = await readJsonObject(supabase, `${LUMI_PILOT_PREFIX}/images/preflight.json`);
  const videoPreflight = await readJsonObject(supabase, `${LUMI_PILOT_PREFIX}/videos/preflight.json`);
  const images = [];
  const videos = [];
  for (const sceneId of LUMI_PILOT_SCENE_IDS) {
    const image = await readJsonObject(supabase, `${LUMI_PILOT_PREFIX}/images/${sceneId}/summary.json`);
    const prompt = compileGenerativeVideoPromptV1(sceneId);
    const base = videoBase(sceneId, prompt.prompt_hash);
    const video = await readJsonObject(supabase, `${base}/completed.json`)
      || await readJsonObject(supabase, `${base}/failed.json`)
      || await readJsonObject(supabase, `${base}/status.json`)
      || await readJsonObject(supabase, `${base}/submitted.json`)
      || await readJsonObject(supabase, `${base}/planned.json`);
    if (image) images.push(image);
    if (video) videos.push(video);
  }
  return { imagePreflight, images, videoPreflight, videos };
}

export async function createPilotReviewUrls({ supabase, expiresIn = 7200 }) {
  const { data: assets, error } = await supabase.from("av2_assets").select("*")
    .eq("artifact_id", VISUAL_BENCHMARK_ARTIFACT_ID).eq("variant", LUMI_PILOT_SOURCE_VARIANT).in("scene_id", LUMI_PILOT_SCENE_IDS);
  if (error) throw new Error("lumi_pilot_source_query_failed");
  const images = [];
  for (const asset of assets || []) {
    const { data } = await supabase.storage.from(asset.storage_bucket).createSignedUrl(asset.storage_path, expiresIn);
    if (data?.signedUrl) images.push({ scene_id: asset.scene_id, asset_id: asset.id, asset_hash: asset.asset_hash, status: asset.status, signed_url: data.signedUrl });
  }
  const status = await getPilotStatus({ supabase });
  const videos = [];
  for (const result of status.videos) {
    if (result.status !== "completed" || !result.output_path) continue;
    const { data } = await supabase.storage.from(GENERATIVE_VIDEO_BUCKET).createSignedUrl(result.output_path, expiresIn);
    if (data?.signedUrl) videos.push({ ...result, signed_url: data.signedUrl });
  }
  return { images, videos };
}
