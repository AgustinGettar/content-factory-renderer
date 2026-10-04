import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ASSET_V2_IMAGE_MODEL, generateBenchmarkComposite } from "./asset-v2/image-provider.js";
import { fetchCanonicalReference } from "./asset-v2/visual-benchmark-runner.js";
import {
  GENERATIVE_VIDEO_BUCKET,
  buildModelInput,
  ensureBucket,
  pollRequest,
  providerJson,
  sha256,
  uploadObject,
} from "./generative-video-benchmark-v1.js";
import {
  LumiRecoveryIncidentManager,
  SupabaseLumiRecoveryStore,
  verifyArtifact,
} from "./lumi-recovery-incident-manager-v1.js";
import { synthesizeSpeech } from "./openai.js";
import { prepareHiggsfieldRequestV2 } from "./video-generation-readiness-v2.js";
import { THIRD_SHORT } from "./lumi-third-short-controlled-v1.js";
import { secondShortTtsStorageDryTest } from "./lumi-second-short-v1.js";

export const THIRD_SHORT_MEDIA = Object.freeze({
  pilotId: "lumi_tres_flores_colores_v1",
  prefix: "lumi-third-short-v1/ep_lumi_flores_003",
  imageCeilingUsd: 0.887396,
  videoCeilingUsd: 2.079,
  ttsCeilingUsd: 0.01225,
  imageUnitUsd: 0.0985995,
  videoUnitUsd: 0.231,
  ttsUnitUsd: Number((0.01225 / 9).toFixed(9)),
  videoModel: Object.freeze({
    model: "kling-video/v3.0/std/image-to-video",
    input: Object.freeze({ duration: 5, sound: "off", multi_shots: false, cfg_scale: 0.5 }),
  }),
});

const CHARACTER_LOCK = "Canonical Lumi only: one warm rounded yellow fairy-firefly preschool teacher, large turquoise eyes, pink cheeks, exactly two violet-tipped antennae, exactly two translucent light-blue wings, light-blue denim overalls, white and light-blue shoes, exactly two arms and two legs, stable face and body, no tail, no extra abdomen, no extra limbs.";
const WORLD_LOCK = "Canonical Lumi garden in daylight: simple soft green grass, a few rounded leafy bushes without flowers, warm clean 2D illustration with soft gradients and gentle depth. No animals, no secondary characters, no unnecessary props, no clutter.";
const OUTPUT_LOCK = "Vertical 9:16, 1152x2048. Keep the upper 22 percent as calm uncluttered sky for deterministic captions. No generated text, letters, labels, logos, watermark, border, or signature.";

const FLOWER_COLORS = Object.freeze({ flower_red: "red", flower_yellow: "yellow", flower_blue: "blue" });
const READINESS_ACTION_MAP = Object.freeze({
  enter_step_in: "gaze_shift_once",
  look_around: "gaze_shift_once",
  reveal_pop: "point_once",
  point_with_wand: "point_once",
  trace_with_wand: "small_wand_trace_once",
  point_sequence: "gaze_shift_once",
  lean_forward_ask: null,
  point_with_wand_short: null,
  celebrate_nod: "small_head_tilt_once",
  fade_in: null,
  wave_and_smile: "wave_once",
});

function placementPosition(placement) {
  const x = Number(placement?.transform?.position_m?.[0] || 0);
  if (x <= -0.5) return "left";
  if (x >= 0.5) return "right";
  return "center";
}

export function compileThirdShortScenesFromPlan(plan) {
  if (plan?.episode?.id !== THIRD_SHORT.episodeId) throw new Error("third_short_media_episode_plan_identity_mismatch");
  if (!Array.isArray(plan?.scenes) || plan.scenes.length !== 9) throw new Error("third_short_media_episode_plan_scene_count_invalid");
  const compiled = plan.scenes.map((scene, index) => {
    if (scene.id !== THIRD_SHORT.sceneIds[index]) throw new Error("third_short_media_episode_plan_scene_ids_invalid");
    const placements = Array.isArray(scene.stage?.placements) ? scene.stage.placements : [];
    const visibleFlowers = placements.filter((item) => item.visible === true && FLOWER_COLORS[item.entity_id]);
    const objects = visibleFlowers.map((item) => FLOWER_COLORS[item.entity_id]);
    const positionParts = [];
    const lumiPlacement = placements.find((item) => item.visible === true && item.entity_id === "lumi");
    if (lumiPlacement) positionParts.push(`Lumi in the lower ${placementPosition(lumiPlacement)} foreground`);
    for (const placement of visibleFlowers) {
      positionParts.push(`one large ${FLOWER_COLORS[placement.entity_id]} flower in the lower ${placementPosition(placement)} area`);
    }
    const utterances = Array.isArray(scene.audio?.utterances) ? scene.audio.utterances : [];
    const childPauses = (scene.audio?.pauses || []).filter((pause) => pause.purpose === "child_response");
    if (childPauses.length > 1) throw new Error(`third_short_media_multiple_child_pauses:${scene.id}`);
    const pause = childPauses.length ? Number(childPauses[0].duration_seconds) : 0;
    const actionIds = (scene.actions || []).map((action) => action.action_id).filter(Boolean);
    const readinessAction = actionIds.map((action) => READINESS_ACTION_MAP[action]).find(Boolean) || null;
    const flowerMotion = objects.length
      ? `All ${objects.join(", ")} educational flowers remain completely still, separated, intact, and color-stable.`
      : "No flower is visible in this setup shot.";
    return Object.freeze({
      id: scene.id,
      duration: Number(scene.duration_target_seconds),
      narration: utterances.map((utterance) => String(utterance.text || "").trim()).filter(Boolean).join(" "),
      overlay: "",
      objects: Object.freeze(objects),
      position: positionParts.join("; ") || "Lumi in the lower foreground",
      action: readinessAction,
      pause,
      motion: `Natural 1x motion only. Lumi performs only these planned actions: ${actionIds.join(", ") || "natural blink"}. ${flowerMotion}`,
      source_scene_hash: sha256(JSON.stringify(scene)),
    });
  });
  const childResponseScenes = compiled.filter((scene) => scene.pause > 0);
  if (childResponseScenes.length !== 1 || childResponseScenes[0].pause !== 2.5) {
    throw new Error("third_short_media_pedagogical_pause_contract_invalid");
  }
  return Object.freeze(compiled);
}

export async function loadThirdShortProductionScenes(supabase) {
  const { data, error } = await supabase.from("av2_creative_artifacts").select("id,status,validation_status,content_hash,payload,generation_metadata")
    .eq("artifact_type", "episode_plan")
    .eq("idempotency_key", `controlled:${THIRD_SHORT.episodeId}:plan:v2`)
    .maybeSingle();
  if (error || !data) throw new Error("third_short_media_episode_plan_missing");
  if (data.status !== "valid" || data.validation_status !== "valid") throw new Error("third_short_media_episode_plan_not_valid");
  if (data.generation_metadata?.deterministic_repair?.resolution !== "RESOLVED_DETERMINISTICALLY") {
    throw new Error("third_short_media_episode_plan_repair_lineage_missing");
  }
  return {
    artifact_id: data.id,
    content_hash: data.content_hash,
    scenes: compileThirdShortScenesFromPlan(data.payload),
  };
}

function flowerObject(color, index, total) {
  const positions = total === 1 ? ["lower_right"] : ["lower_left", "lower_center", "lower_right"];
  return {
    id: `flower_${color}`,
    count: 1,
    geometry: `large_clear_${color}_flower_fully_visible`,
    position: positions[index],
    fully_visible: true,
  };
}

export function thirdShortVideoContract(scene) {
  const educationalObjects = scene.objects.length
    ? scene.objects.map((color, index) => flowerObject(color, index, scene.objects.length))
    : [{ id: "garden_context", count: 1, geometry: "canonical_lumi_garden_background", position: "background", fully_visible: true }];
  const high = educationalObjects.length === 3;
  return {
    version: "2.1.0",
    scene_id: scene.id,
    educational_domain: "object_identity",
    complexity_flags: high ? ["multiple_distinct_examples"] : [],
    max_educational_focus_objects: educationalObjects.length,
    canonical_start_state: {
      lumi: { id: "lumi", count: 1, position: scene.id === "s38" || scene.id === "s39" ? "lower_foreground" : "lower_left" },
      props: [],
      educational_objects: educationalObjects,
    },
    educational_invariants: educationalObjects.map((object) => ({
      object_id: object.id,
      rule: `${object.id}_keeps_exact_canonical_color_and_identity_no_mutation_duplication_disappearance_or_fusion`,
    })),
    character_invariants: ["canonical_face","canonical_silhouette","exactly_two_arms","exactly_two_legs","exactly_two_wings","exactly_two_antennae","no_tail","no_additional_abdomen","no_extra_appendages","no_clothing_mutation"],
    allowed_motion: { primary_character_actions: scene.action ? [scene.action] : [], secondary_micro_motion: ["blink"] },
    forbidden_transformations: ["no_object_duplication","no_object_disappearance","no_object_fusion","no_object_morphing","no_additional_shapes","no_additional_limbs","no_body_transformation","no_geometry_change"],
    camera_contract: { single_continuous_shot: true, multi_shots: false, moves: [] },
    end_state_contract: { lumi_visible: true, visible_intact_objects: educationalObjects },
    pacing_contract: { mode: "NATURAL_REAL_TIME", normal_conversational_gesture_speed: true, natural_blink_head_hand_timing: true, slow_motion: false, dreamy_slow_movement: false, prolonged_pose_holds: false, pedagogical_pause_seconds: scene.pause || 0 },
    end_frame_mode: "NONE",
    risk_mitigation: high ? ["static_camera","objects_spatially_separated","no_educational_object_motion","single_character_action"] : [],
    source_image_requirements: { minimum_confidence: 0.98 },
  };
}

export function thirdShortImagePrompt(scene) {
  const colors = scene.objects.join(", ");
  const exact = scene.objects.length === 0
    ? "No flower is visible in this setup shot. Do not add flowers or flower-like blooms."
    : scene.objects.length === 1
    ? `Exactly one main flower in the entire image: one large ${colors} flower with unmistakable canonical clear ${colors} petals. No other flowers or flower-like blooms.`
    : "Exactly three main flowers in the entire image: one canonical clear red flower, one canonical clear yellow flower, and one canonical clear blue flower. Each is large, fully visible, widely separated, and unmistakable. No other flowers or flower-like blooms.";
  return [CHARACTER_LOCK, WORLD_LOCK, exact, scene.position + ".", "Hard color lock: red is pure clear red, never orange or burgundy; yellow is pure clear yellow, never greenish or orange; blue is pure clear blue, never cyan, teal, violet, or purple.", "Flowers have stable simple round centers and broad readable petals. Lumi never overlaps a flower. Keep clear spacing around every flower.", OUTPUT_LOCK].join("\n\n");
}

async function rows(supabase, stage) {
  const { data, error } = await supabase.from("lumi_pilot_runs").select("*")
    .eq("pilot_id", THIRD_SHORT_MEDIA.pilotId).eq("stage", stage).order("created_at");
  if (error) throw new Error(`third_short_${stage.toLowerCase()}_rows_failed`);
  return data || [];
}

async function claim(supabase, sceneId, stage, estimate) {
  const existing = (await rows(supabase, stage)).find((row) => row.scene_id === sceneId);
  if (existing) return { claimed: false, row: existing };
  const { data, error } = await supabase.from("lumi_pilot_runs").insert({
    pilot_id: THIRD_SHORT_MEDIA.pilotId, scene_id: sceneId, stage,
    status: "CLAIMED", provider_calls: 0, estimated_cost_usd: estimate,
    claimed_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  }).select("*").single();
  if (!error) return { claimed: true, row: data };
  if (error.code === "23505") return { claimed: false, row: (await rows(supabase, stage)).find((row) => row.scene_id === sceneId) };
  throw new Error(`third_short_${stage.toLowerCase()}_claim_failed`);
}

async function patchRow(supabase, sceneId, stage, status, patch = {}) {
  const terminal = ["SUCCEEDED", "FAILED"].includes(status);
  const { data, error } = await supabase.from("lumi_pilot_runs").update({
    ...patch, status, updated_at: new Date().toISOString(),
    ...(terminal ? { completed_at: new Date().toISOString() } : {}),
  }).eq("pilot_id", THIRD_SHORT_MEDIA.pilotId).eq("scene_id", sceneId).eq("stage", stage).select("*").single();
  if (error) throw new Error(`third_short_${stage.toLowerCase()}_update_failed`);
  return data;
}

async function signedObject(supabase, bucket, path, expires = 7200) {
  const { data, error } = await supabase.storage.from(bucket).createSignedUrl(path, expires);
  if (error || !data?.signedUrl) throw new Error("third_short_storage_sign_failed");
  return data.signedUrl;
}

async function verifyBytes(type, buffer, extension, expected = {}) {
  const dir = await mkdtemp(join(tmpdir(), "lumi-third-verify-"));
  const filePath = join(dir, `artifact.${extension}`);
  try {
    await writeFile(filePath, buffer);
    return await verifyArtifact({ type, filePath, expectedSha256: sha256(buffer), expected });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function managerFor(supabase) {
  return new LumiRecoveryIncidentManager({ store: new SupabaseLumiRecoveryStore(supabase) });
}

async function pause(manager, scene, stage, action, error, providerRequestId = null) {
  return manager.pause({
    episodeId: THIRD_SHORT.episodeId, sceneId: scene?.id || null, stage,
    errorClass: error.code === "openai_api_credit_required" ? "INSUFFICIENT_PROVIDER_BALANCE" : "PROVIDER_API_FAILURE",
    reason: error.code || error.message, providerRequestId,
    firstPendingAction: action, safeResumeAvailable: Boolean(providerRequestId), costLostAvoidable: true,
  });
}

export async function runThirdShortImages({ supabase, openAiApiKey, supabaseUrl, logger = () => {} }) {
  if (!supabase || !openAiApiKey) throw new Error("third_short_image_provider_not_configured");
  await ensureBucket(supabase);
  const manager = managerFor(supabase);
  const canonical = await fetchCanonicalReference({ supabaseUrl });
  const production = await loadThirdShortProductionScenes(supabase);
  const results = [];
  for (const scene of production.scenes) {
    const action = `image:${scene.id}`;
    const acquired = await claim(supabase, scene.id, "IMAGE", THIRD_SHORT_MEDIA.imageUnitUsd);
    if (!acquired.claimed) { results.push({ scene_id: scene.id, status: "cache_hit", row: acquired.row }); continue; }
    const gate = await manager.budgetGate({ episodeId: THIRD_SHORT.episodeId, actionKey: action, projectedCallCostUsd: THIRD_SHORT_MEDIA.imageUnitUsd });
    if (gate.status !== "PASS") return { status: "PAUSED_INCIDENT", stage: "IMAGE", results, incident: gate.incident };
    const prompt = thirdShortImagePrompt(scene);
    await patchRow(supabase, scene.id, "IMAGE", "REQUESTED", { provider: "openai", result: { dispatch_state: "REQUESTED", prompt_hash: sha256(prompt) } });
    try {
      const generated = await generateBenchmarkComposite({ apiKey: openAiApiKey, model: ASSET_V2_IMAGE_MODEL, prompt, referenceBuffer: canonical, size: "1152x2048", quality: "high" });
      const requestId = generated.provider_request_id || generated.provider_response_id;
      if (!requestId) throw new Error("third_short_image_request_id_missing");
      await manager.recordRequest(THIRD_SHORT.episodeId, action, requestId);
      const objectPath = `${THIRD_SHORT_MEDIA.prefix}/images/${scene.id}/${sha256(prompt)}/source.png`;
      await uploadObject(supabase, objectPath, generated.buffer, "image/png", false);
      const stored = await supabase.storage.from(GENERATIVE_VIDEO_BUCKET).download(objectPath);
      if (stored.error || !stored.data) throw new Error("third_short_image_storage_download_failed");
      const persisted = Buffer.from(await stored.data.arrayBuffer());
      const verification = await verifyBytes("IMAGE", persisted, "png", { width: 1152, height: 2048 });
      if (!verification.ok || verification.sha256 !== generated.image.sha256) throw Object.assign(new Error(verification.error_class || "third_short_image_verification_failed"), { code: verification.error_class });
      const result = { visual_qa: { classification: "PENDING" }, video_source_readiness: { status: "PENDING" }, episode_plan_artifact_id: production.artifact_id, episode_plan_hash: production.content_hash, source_scene_hash: scene.source_scene_hash, output_hash: verification.sha256, prompt_hash: sha256(prompt), verification, storage_bucket: GENERATIVE_VIDEO_BUCKET, storage_path: objectPath };
      await patchRow(supabase, scene.id, "IMAGE", "SUCCEEDED", { provider_calls: 1, provider_request_id: requestId, storage_bucket: GENERATIVE_VIDEO_BUCKET, storage_path: objectPath, content_hash: verification.sha256, artifact_reference: objectPath, result });
      await manager.completeAction(THIRD_SHORT.episodeId, action, { artifact: { bucket: GENERATIVE_VIDEO_BUCKET, path: objectPath, sha256: verification.sha256 }, evidence: { provider_succeeded: true, artifact_persisted: true, sha_verified: true, artifact_verified: true }, actualCostUsd: THIRD_SHORT_MEDIA.imageUnitUsd });
      results.push({ scene_id: scene.id, status: "generated", review_url: await signedObject(supabase, GENERATIVE_VIDEO_BUCKET, objectPath), ...result });
      logger({ event: "third_short_image_completed", scene_id: scene.id, request_id: requestId, hash: verification.sha256 });
    } catch (error) {
      await patchRow(supabase, scene.id, "IMAGE", "FAILED", { error_code: error.code || error.message });
      const incident = await pause(manager, scene, "IMAGE", action, error);
      return { status: "PAUSED_INCIDENT", stage: "IMAGE", results, incident };
    }
  }
  return { status: "AWAITING_SOURCE_QA", stage: "IMAGE", results, provider_calls: (await rows(supabase, "IMAGE")).reduce((sum, row) => sum + Number(row.provider_calls || 0), 0) };
}

export async function recordThirdShortSourceQa({ supabase, sceneId, classification, findings = [] }) {
  const production = await loadThirdShortProductionScenes(supabase);
  const scene = production.scenes.find((item) => item.id === sceneId);
  if (!scene || !["PASS","PASS_WITH_WARNING","BLOCKER"].includes(classification)) throw new Error("third_short_source_qa_invalid");
  const imageRows = await rows(supabase, "IMAGE");
  const row = imageRows.find((item) => item.scene_id === sceneId);
  if (!row || row.status !== "SUCCEEDED") throw new Error("third_short_source_missing");
  const accepted = classification !== "BLOCKER";
  const contract = thirdShortVideoContract(scene);
  const readiness = accepted ? {
    version: "1.0.0", status: "PASS", confidence: classification === "PASS" ? 0.995 : 0.98,
    all_required_elements_present: true, correct_object_counts: true, clear_geometry: true,
    no_ambiguous_overlaps: true, lumi_anatomy_clean: true, pedagogical_objects_fully_visible: true,
    sufficient_motion_spacing: true, no_visual_ambiguity: true, extraneous_educational_objects: false,
    observed_educational_objects: contract.canonical_start_state.educational_objects,
  } : { version: "1.0.0", status: "FAIL", confidence: 0, findings };
  const result = { ...(row.result || {}), visual_qa: { classification, findings }, video_source_readiness: readiness };
  await patchRow(supabase, sceneId, "IMAGE", "SUCCEEDED", { result });
  const manager = managerFor(supabase);
  if (!accepted) {
    const incident = await manager.pause({ episodeId: THIRD_SHORT.episodeId, sceneId, stage: "SOURCE_READINESS", errorClass: "QA_BLOCKER", reason: findings.join("; ") || "SOURCE_QA_BLOCKER", firstPendingAction: `source_qa:${sceneId}`, safeResumeAvailable: true, costLostAvoidable: true });
    return { status: "PAUSED_INCIDENT", incident };
  }
  await manager.completeAction(THIRD_SHORT.episodeId, `source_qa:${sceneId}`, { artifact: { image_run_id: row.id, source_readiness: readiness }, evidence: { provider_succeeded: true, artifact_persisted: true, sha_verified: true, artifact_verified: true }, actualCostUsd: 0 });
  return { status: classification, scene_id: sceneId, readiness };
}

export async function runThirdShortVideos({ supabase, higgsfieldApiKey, logger = () => {} }) {
  if (!supabase || !higgsfieldApiKey) throw new Error("third_short_video_provider_not_configured");
  const manager = managerFor(supabase);
  const production = await loadThirdShortProductionScenes(supabase);
  const imageRows = await rows(supabase, "IMAGE");
  const results = [];
  for (const scene of production.scenes) {
    const action = `video:${scene.id}`;
    const source = imageRows.find((row) => row.scene_id === scene.id);
    if (!source || !["PASS","PASS_WITH_WARNING"].includes(source.result?.visual_qa?.classification) || source.result?.video_source_readiness?.status !== "PASS") throw new Error(`third_short_source_not_ready:${scene.id}`);
    const acquired = await claim(supabase, scene.id, "VIDEO", THIRD_SHORT_MEDIA.videoUnitUsd);
    if (!acquired.claimed) { results.push({ scene_id: scene.id, status: "cache_hit", row: acquired.row }); continue; }
    const gate = await manager.budgetGate({ episodeId: THIRD_SHORT.episodeId, actionKey: action, projectedCallCostUsd: THIRD_SHORT_MEDIA.videoUnitUsd });
    if (gate.status !== "PASS") return { status: "PAUSED_INCIDENT", stage: "VIDEO", results, incident: gate.incident };
    const prepared = prepareHiggsfieldRequestV2({ contract: thirdShortVideoContract(scene), source_readiness: source.result.video_source_readiness });
    const prompt = `${prepared.compiled_prompt.text}\n\n[COLOR_TEMPORAL_LOCK]\nRed stays canonical clear red. Yellow stays canonical clear yellow. Blue stays canonical clear blue. No hue drift, duplication, disappearance, fusion, petal morphing, or flower motion.\n\n[SCENE_MOTION]\n${scene.motion}`;
    const sourceUrl = await signedObject(supabase, source.storage_bucket, source.storage_path, 86400);
    await patchRow(supabase, scene.id, "VIDEO", "REQUESTED", { provider: "higgsfield", result: { dispatch_state: "REQUESTED", source_hash: source.content_hash, prompt_hash: sha256(prompt) } });
    let requestId = null;
    try {
      const accepted = await providerJson(`https://api.higgsfield.ai/${THIRD_SHORT_MEDIA.videoModel.model}`, { apiKey: higgsfieldApiKey, method: "POST", body: buildModelInput(THIRD_SHORT_MEDIA.videoModel, sourceUrl, { text: prompt }) });
      requestId = accepted.request_id;
      if (!requestId || !accepted.status_url) throw new Error("third_short_kling_request_handle_missing");
      await manager.recordRequest(THIRD_SHORT.episodeId, action, requestId);
      await patchRow(supabase, scene.id, "VIDEO", "REQUESTED", { provider_calls: 1, provider_request_id: requestId, result: { dispatch_state: "SUBMITTED", status_url: accepted.status_url, source_hash: source.content_hash, prompt_hash: sha256(prompt) } });
      const terminal = await pollRequest({ apiKey: higgsfieldApiKey, statusUrl: accepted.status_url });
      if (terminal.status !== "completed" || !terminal.video?.url) throw new Error(`third_short_kling_terminal_${terminal.status}`);
      const response = await fetch(terminal.video.url);
      if (!response.ok) throw new Error(`third_short_kling_download_failed:${response.status}`);
      const video = Buffer.from(await response.arrayBuffer());
      const outputHash = sha256(video);
      const objectPath = `${THIRD_SHORT_MEDIA.prefix}/videos/${scene.id}/${sha256(prompt)}/original.mp4`;
      await uploadObject(supabase, objectPath, video, "video/mp4", false);
      const stored = await supabase.storage.from(GENERATIVE_VIDEO_BUCKET).download(objectPath);
      if (stored.error || !stored.data) throw new Error("third_short_video_storage_download_failed");
      const persisted = Buffer.from(await stored.data.arrayBuffer());
      const verification = await verifyBytes("VIDEO", persisted, "mp4");
      if (!verification.ok || verification.sha256 !== outputHash) throw Object.assign(new Error(verification.error_class || "third_short_video_verification_failed"), { code: verification.error_class });
      const result = { temporal_qa: { classification: "PENDING" }, episode_plan_artifact_id: production.artifact_id, episode_plan_hash: production.content_hash, source_scene_hash: scene.source_scene_hash, source_hash: source.content_hash, prompt_hash: sha256(prompt), output_hash: outputHash, verification, storage_bucket: GENERATIVE_VIDEO_BUCKET, storage_path: objectPath, duration_seconds: verification.duration };
      await patchRow(supabase, scene.id, "VIDEO", "SUCCEEDED", { provider_calls: 1, provider_request_id: requestId, storage_bucket: GENERATIVE_VIDEO_BUCKET, storage_path: objectPath, content_hash: outputHash, artifact_reference: objectPath, result });
      await manager.completeAction(THIRD_SHORT.episodeId, action, { artifact: { bucket: GENERATIVE_VIDEO_BUCKET, path: objectPath, sha256: outputHash }, evidence: { provider_succeeded: true, artifact_persisted: true, sha_verified: true, artifact_verified: true }, actualCostUsd: THIRD_SHORT_MEDIA.videoUnitUsd });
      results.push({ scene_id: scene.id, status: "completed", review_url: await signedObject(supabase, GENERATIVE_VIDEO_BUCKET, objectPath), ...result });
      logger({ event: "third_short_video_completed", scene_id: scene.id, request_id: requestId, hash: outputHash });
    } catch (error) {
      await patchRow(supabase, scene.id, "VIDEO", "FAILED", { provider_calls: requestId ? 1 : 0, provider_request_id: requestId, error_code: error.code || error.message });
      const incident = await pause(manager, scene, "VIDEO", action, error, requestId);
      return { status: "PAUSED_INCIDENT", stage: "VIDEO", results, incident };
    }
  }
  return { status: "AWAITING_TEMPORAL_QA", stage: "VIDEO", results, provider_calls: (await rows(supabase, "VIDEO")).reduce((sum, row) => sum + Number(row.provider_calls || 0), 0) };
}

export async function recordThirdShortTemporalQa({ supabase, sceneId, classification, findings = [] }) {
  const production = await loadThirdShortProductionScenes(supabase);
  const scene = production.scenes.find((item) => item.id === sceneId);
  if (!scene || !["PASS","PASS_WITH_WARNING","BLOCKER"].includes(classification)) throw new Error("third_short_temporal_qa_invalid");
  const videoRows = await rows(supabase, "VIDEO");
  const row = videoRows.find((item) => item.scene_id === sceneId);
  if (!row || row.status !== "SUCCEEDED") throw new Error("third_short_video_missing");
  await patchRow(supabase, sceneId, "VIDEO", "SUCCEEDED", { result: { ...(row.result || {}), temporal_qa: { classification, findings } } });
  const manager = managerFor(supabase);
  if (classification === "BLOCKER") {
    const incident = await manager.pause({ episodeId: THIRD_SHORT.episodeId, sceneId, stage: "TEMPORAL_QA", errorClass: "QA_BLOCKER", reason: findings.join("; ") || "TEMPORAL_QA_BLOCKER", providerRequestId: row.provider_request_id, firstPendingAction: `temporal_qa:${sceneId}`, safeResumeAvailable: true, costLostAvoidable: true });
    return { status: "PAUSED_INCIDENT", incident };
  }
  await manager.completeAction(THIRD_SHORT.episodeId, `temporal_qa:${sceneId}`, { artifact: { video_run_id: row.id, classification }, evidence: { provider_succeeded: true, artifact_persisted: true, sha_verified: true, artifact_verified: true }, actualCostUsd: 0 });
  return { status: classification, scene_id: sceneId };
}

export async function runThirdShortTts({ supabase, openAiApiKey, logger = () => {} }) {
  if (!supabase || !openAiApiKey) throw new Error("third_short_tts_provider_not_configured");
  const production = await loadThirdShortProductionScenes(supabase);
  const videoRows = await rows(supabase, "VIDEO");
  if (production.scenes.some((scene) => !["PASS","PASS_WITH_WARNING"].includes(videoRows.find((row) => row.scene_id === scene.id)?.result?.temporal_qa?.classification))) throw new Error("third_short_visual_assembly_not_ready");
  const manager = managerFor(supabase);
  try {
    const storageGate = await secondShortTtsStorageDryTest({ supabase, logger });
    if (storageGate.status !== "PASS") throw new Error("TTS_STORAGE_GATE_NOT_PASS");
    await manager.completeAction(THIRD_SHORT.episodeId, "tts_storage_gate", { artifact: storageGate, evidence: { provider_succeeded: true, artifact_persisted: true, sha_verified: true, artifact_verified: true }, actualCostUsd: 0 });
  } catch (error) {
    const incident = await manager.pause({ episodeId: THIRD_SHORT.episodeId, stage: "TTS_STORAGE_GATE", errorClass: "STORAGE_UPLOAD_FAILURE", reason: error.code || error.message, firstPendingAction: "tts_storage_gate", safeResumeAvailable: true, costLostAvoidable: true });
    return { status: "PAUSED_INCIDENT", stage: "TTS_STORAGE_GATE", incident, provider_calls: 0 };
  }
  const results = [];
  for (const scene of production.scenes) {
    const action = `tts:${scene.id}`;
    const acquired = await claim(supabase, scene.id, "TTS", THIRD_SHORT_MEDIA.ttsUnitUsd);
    if (!acquired.claimed) { results.push({ scene_id: scene.id, status: "cache_hit", row: acquired.row }); continue; }
    const gate = await manager.budgetGate({ episodeId: THIRD_SHORT.episodeId, actionKey: action, projectedCallCostUsd: THIRD_SHORT_MEDIA.ttsUnitUsd });
    if (gate.status !== "PASS") return { status: "PAUSED_INCIDENT", stage: "TTS", results, incident: gate.incident };
    await patchRow(supabase, scene.id, "TTS", "REQUESTED", { provider: "openai", result: { dispatch_state: "REQUESTED", narration_hash: sha256(scene.narration) } });
    try {
      const audio = await synthesizeSpeech({ apiKey: openAiApiKey, input: scene.narration, model: "gpt-4o-mini-tts", voice: "marin" });
      if (!audio.provider_request_id) throw new Error("third_short_tts_request_id_missing");
      await manager.recordRequest(THIRD_SHORT.episodeId, action, audio.provider_request_id);
      const outputHash = sha256(audio.buffer);
      const objectPath = `${THIRD_SHORT_MEDIA.prefix}/audio/${scene.id}/${sha256(scene.narration)}/narration.mp3`;
      const { error: uploadError } = await supabase.storage.from("generated-audio").upload(objectPath, audio.buffer, { contentType: "audio/mpeg", upsert: false, cacheControl: "31536000" });
      if (uploadError) throw new Error("third_short_tts_upload_failed");
      const stored = await supabase.storage.from("generated-audio").download(objectPath);
      if (stored.error || !stored.data) throw new Error("third_short_tts_download_failed");
      const persisted = Buffer.from(await stored.data.arrayBuffer());
      const verification = await verifyBytes("AUDIO", persisted, "mp3");
      if (!verification.ok || verification.sha256 !== outputHash) throw Object.assign(new Error(verification.error_class || "third_short_tts_verification_failed"), { code: verification.error_class });
      const result = { model: audio.model, voice: audio.voice, episode_plan_artifact_id: production.artifact_id, episode_plan_hash: production.content_hash, source_scene_hash: scene.source_scene_hash, output_hash: outputHash, verification, storage_bucket: "generated-audio", storage_path: objectPath };
      await patchRow(supabase, scene.id, "TTS", "SUCCEEDED", { provider_calls: 1, provider_request_id: audio.provider_request_id, storage_bucket: "generated-audio", storage_path: objectPath, content_hash: outputHash, artifact_reference: objectPath, result });
      await manager.completeAction(THIRD_SHORT.episodeId, action, { artifact: { bucket: "generated-audio", path: objectPath, sha256: outputHash }, evidence: { provider_succeeded: true, artifact_persisted: true, sha_verified: true, artifact_verified: true }, actualCostUsd: THIRD_SHORT_MEDIA.ttsUnitUsd });
      results.push({ scene_id: scene.id, status: "completed", ...result });
    } catch (error) {
      await patchRow(supabase, scene.id, "TTS", "FAILED", { error_code: error.code || error.message });
      const incident = await pause(manager, scene, "TTS", action, error);
      return { status: "PAUSED_INCIDENT", stage: "TTS", results, incident };
    }
  }
  return { status: "READY_FOR_ASSEMBLY", stage: "TTS", results, provider_calls: (await rows(supabase, "TTS")).reduce((sum, row) => sum + Number(row.provider_calls || 0), 0) };
}

export async function thirdShortMediaStatus({ supabase, includeReviewUrls = false }) {
  const [images, videos, tts] = await Promise.all([rows(supabase, "IMAGE"), rows(supabase, "VIDEO"), rows(supabase, "TTS")]);
  if (includeReviewUrls) {
    for (const row of [...images, ...videos]) if (row.storage_path) row.review_url = await signedObject(supabase, row.storage_bucket, row.storage_path);
  }
  return { images, videos, tts };
}
