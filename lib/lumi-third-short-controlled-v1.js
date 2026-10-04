import { Av2PipelineIntegration } from "./av2/pipeline-integration.js";
import { SupabaseCreativeArtifactStore } from "./av2/persistence.js";
import { runCanonicalEpisodePlan } from "./av2/benchmark-runner.js";
import { canonicalizeAv2Timeline } from "./av2/canonicalizer.js";
import {
  contentHash,
  validateEpisodePlan,
  validateEpisodePlanStructure,
  validateScenePlan,
} from "./av2/contracts.js";
import { transportToAv2Domain, validateEpisodeTransport } from "./av2/llm-transport.js";
import {
  LumiRecoveryIncidentManager,
  SupabaseLumiRecoveryStore,
} from "./lumi-recovery-incident-manager-v1.js";

export const THIRD_SHORT = Object.freeze({
  episodeId: "ep_lumi_flores_003",
  title: "Lumi y las tres flores de colores",
  pipelineVersion: "v1_1_2",
  presetVersion: "1.1.2",
  sceneIds: Object.freeze(["s31","s32","s33","s34","s35","s36","s37","s38","s39"]),
  hardCeilingUsd: 3.05,
  imageUnitUsd: 0.0985995,
  videoUnitUsd: 0.231,
  ttsTotalUsd: 0.01225,
  projectedCleanCostUsd: 2.978645,
});

export const THIRD_SHORT_IDEA = Object.freeze({
  id: "idea_tres_flores_colores",
  title: THIRD_SHORT.title,
  category: "colores",
  age_range: { min_years: 3, max_years: 5 },
  learning: {
    objective: "Reconocer rojo, amarillo y azul en tres flores grandes, separadas y de color inequívoco.",
    secondary_skill: "atención visual",
    mechanism: "one_color_one_flower",
  },
  world_ref: { id: "lumi_garden", version: "1.0" },
  story: {
    premise: "En el jardín canónico, Lumi descubre exactamente tres flores principales: una roja, una amarilla y una azul, y enseña cada color con una sola pregunta final.",
    problem_type: "color_discovery",
    challenge: "Mantener las tres flores grandes, separadas, estables y con colores exactos durante nueve escenas simples.",
  },
  activity_id: "identify_three_flower_colors",
  secondary_characters: [],
  interaction: { type: "identify_color", prompt_goal: "El niño identifica la flor azul durante una pausa real de 2.5 segundos." },
  resolution: { reward_type: "garden_glow", reward: "Lumi celebra los tres colores con las tres flores intactas." },
});

export function thirdShortActions() {
  const actions = [{ key: "episode_plan_v2", stage: "PLANNING", estimated_cost_usd: 0 }];
  for (const sceneId of THIRD_SHORT.sceneIds) actions.push({ key: `image:${sceneId}`, stage: "IMAGE", scene_id: sceneId, estimated_cost_usd: THIRD_SHORT.imageUnitUsd });
  for (const sceneId of THIRD_SHORT.sceneIds) actions.push({ key: `source_qa:${sceneId}`, stage: "SOURCE_READINESS", scene_id: sceneId, estimated_cost_usd: 0 });
  for (const sceneId of THIRD_SHORT.sceneIds) actions.push({ key: `video:${sceneId}`, stage: "VIDEO", scene_id: sceneId, estimated_cost_usd: THIRD_SHORT.videoUnitUsd });
  for (const sceneId of THIRD_SHORT.sceneIds) actions.push({ key: `temporal_qa:${sceneId}`, stage: "TEMPORAL_QA", scene_id: sceneId, estimated_cost_usd: 0 });
  actions.push({ key: "tts_storage_gate", stage: "TTS_STORAGE_GATE", estimated_cost_usd: 0 });
  for (const sceneId of THIRD_SHORT.sceneIds) actions.push({ key: `tts:${sceneId}`, stage: "TTS", scene_id: sceneId, estimated_cost_usd: THIRD_SHORT.ttsTotalUsd / 9 });
  actions.push({ key: "assembly", stage: "ASSEMBLY", estimated_cost_usd: 0 });
  actions.push({ key: "master_qa", stage: "MASTER_QA", estimated_cost_usd: 0 });
  actions.push({ key: "human_review_notice", stage: "TELEGRAM", estimated_cost_usd: 0 });
  return actions;
}

export function thirdShortPreflight() {
  const projected = Number((THIRD_SHORT.imageUnitUsd * 9 + THIRD_SHORT.videoUnitUsd * 9 + THIRD_SHORT.ttsTotalUsd).toFixed(6));
  return {
    status: projected <= THIRD_SHORT.hardCeilingUsd ? "PASS" : "BUDGET_EXHAUSTED",
    episode_id: THIRD_SHORT.episodeId,
    pipeline_version: THIRD_SHORT.pipelineVersion,
    global_default_unchanged: "legacy",
    planned_calls: { image: 9, kling: 9, tts: 9, provider_repairs: 0 },
    automatic_retries: 0,
    automatic_variants: 0,
    automatic_resubmits: 0,
    projected_clean_cost_usd: projected,
    hard_ceiling_usd: THIRD_SHORT.hardCeilingUsd,
  };
}

function applyCanonicalThirdShortIdentity(plan) {
  const repaired = structuredClone(plan);
  if (repaired.scenes.length !== THIRD_SHORT.sceneIds.length) throw new Error("third_short_scene_count_not_nine");
  const sceneIdMap = new Map(repaired.scenes.map((scene, index) => [scene.id, THIRD_SHORT.sceneIds[index]]));
  const identityChanges = [];
  if (repaired.episode.id !== THIRD_SHORT.episodeId) {
    identityChanges.push({ path: "/episode/id", from: repaired.episode.id, to: THIRD_SHORT.episodeId });
    repaired.episode.id = THIRD_SHORT.episodeId;
  }
  repaired.scenes.forEach((scene, index) => {
    const canonicalId = THIRD_SHORT.sceneIds[index];
    if (scene.id !== canonicalId) {
      identityChanges.push({ path: `/scenes/${index}/id`, from: scene.id, to: canonicalId });
      scene.id = canonicalId;
    }
  });
  repaired.episode.transitions.forEach((transition) => {
    transition.from_scene = sceneIdMap.get(transition.from_scene) || transition.from_scene;
    transition.to_scene = sceneIdMap.get(transition.to_scene) || transition.to_scene;
  });
  return { plan: repaired, identityChanges };
}

function applyThirdShortDurationContract(plan) {
  const repaired = structuredClone(plan);
  const beforeSeconds = repaired.scenes.reduce((sum, scene) => sum + Number(scene.duration_target_seconds), 0)
    - repaired.episode.transitions.reduce((sum, edge) => sum + Number(edge.overlap_frames || 0) / 30, 0);
  const durationChanges = [];
  if (beforeSeconds > 47) {
    const excess = Number((beforeSeconds - 47).toFixed(6));
    const finalScene = repaired.scenes.at(-1);
    const nextDuration = Number((Number(finalScene.duration_target_seconds) - excess).toFixed(6));
    if (nextDuration < 3) throw new Error("third_short_duration_contract_not_deterministically_repairable");
    durationChanges.push({
      path: `/scenes/${repaired.scenes.length - 1}/duration_target_seconds`,
      from: finalScene.duration_target_seconds,
      to: nextDuration,
    });
    finalScene.duration_target_seconds = nextDuration;
  }
  const target = { min_seconds: 43, target_seconds: 47, max_seconds: 47 };
  if (JSON.stringify(repaired.episode.duration_target) !== JSON.stringify(target)) {
    durationChanges.push({ path: "/episode/duration_target", from: repaired.episode.duration_target, to: target });
    repaired.episode.duration_target = target;
  }
  return { plan: repaired, durationChanges, beforeSeconds };
}

export function normalizeThirdShortEpisodePlan(rawTransport) {
  const transportValidation = validateEpisodeTransport(rawTransport, { throwOnError: false });
  if (!transportValidation.ok) throw new Error("third_short_persisted_transport_invalid");
  const domain = transportToAv2Domain(rawTransport);
  validateEpisodePlanStructure(domain);
  domain.scenes.forEach((scene) => validateScenePlan(scene));
  const originalDomainHash = contentHash(domain);
  const originalValidation = validateEpisodePlan(domain, { throwOnError: false });
  const temporalErrors = originalValidation.errors.filter((error) => error.keyword === "timing_reference");
  if (temporalErrors.length !== 28) {
    throw new Error("third_short_deterministic_repair_pattern_mismatch");
  }

  const temporal = canonicalizeAv2Timeline(domain);
  if (temporal.temporal_reference_normalization.change_count !== 28) {
    throw new Error("third_short_temporal_normalization_count_mismatch");
  }
  const identity = applyCanonicalThirdShortIdentity(temporal.plan);
  const duration = applyThirdShortDurationContract(identity.plan);
  const canonical = canonicalizeAv2Timeline(duration.plan);
  const validation = validateEpisodePlan(canonical.plan, { throwOnError: false });
  const childPauses = canonical.plan.scenes.flatMap((scene) => scene.audio.pauses)
    .filter((pause) => pause.purpose === "child_response");
  const contract = {
    scene_count: canonical.plan.scenes.length === 9,
    canonical_episode_id: canonical.plan.episode.id === THIRD_SHORT.episodeId,
    canonical_scene_ids: JSON.stringify(canonical.plan.scenes.map((scene) => scene.id)) === JSON.stringify(THIRD_SHORT.sceneIds),
    duration_43_to_47: canonical.timeline.planned_duration_seconds >= 43 && canonical.timeline.planned_duration_seconds <= 47,
    pedagogical_pause_exactly_2_5: childPauses.length === 1 && Number(childPauses[0].duration_seconds) === 2.5,
    invalid_temporal_references: validation.errors.filter((error) => error.keyword === "timing_reference").length,
  };
  if (!validation.ok || !Object.values(contract).every((value) => value === true || value === 0)) {
    throw Object.assign(new Error("third_short_deterministic_repair_validation_failed"), { validation, contract });
  }
  return {
    plan: canonical.plan,
    content_hash: contentHash(canonical.plan),
    timeline: canonical.timeline,
    original_domain_hash: originalDomainHash,
    original_validation_errors: temporalErrors,
    changes: [
      ...temporal.temporal_reference_normalization.changes,
      ...identity.identityChanges,
      ...duration.durationChanges,
      ...canonical.changes,
    ],
    validation,
    contract,
  };
}

export async function repairThirdShortEpisodePlanDeterministically({ supabase, logger = () => {} } = {}) {
  if (!supabase) throw new Error("supabase_required");
  const store = new SupabaseCreativeArtifactStore(supabase);
  const integration = new Av2PipelineIntegration({ store, logger, engineVersion: "v2", benchmarkOnly: false });
  const idempotencyKey = `controlled:${THIRD_SHORT.episodeId}:plan:v2`;
  const artifact = await store.findByIdempotency("episode_plan", idempotencyKey);
  if (!artifact) throw new Error("third_short_episode_plan_artifact_missing");
  const providerOutput = await integration.loadProviderOutput({
    artifactType: "episode_plan",
    requestHash: artifact.request_hash,
    generationAttempt: Number(artifact.generation_attempt),
    context: { idea_id: artifact.idea_id, episode_id: THIRD_SHORT.episodeId },
    idempotencyKey,
  });
  const repaired = normalizeThirdShortEpisodePlan(providerOutput.raw_transport);
  const accepted = await integration.acceptPlan({
    requestHash: artifact.request_hash,
    payload: repaired.plan,
    context: { idea_id: artifact.idea_id, episode_id: THIRD_SHORT.episodeId },
    idempotencyKey,
    repairable: false,
    validationMetadata: {
      deterministic_repair: {
        version: "episode-plan-v2-deterministic-repair/1",
        resolution: "RESOLVED_DETERMINISTICALLY",
        root_cause: "SCHEMA_NORMALIZATION_ERROR",
        source_artifact_id: artifact.id,
        source_provider_output_id: providerOutput.id,
        source_provider_response_id: providerOutput.provider_response_id,
        source_raw_transport_hash: providerOutput.raw_transport_hash,
        source_domain_hash: repaired.original_domain_hash,
        repair_content_hash: repaired.content_hash,
        provider_calls_added: 0,
        temporal_reference_repairs: 28,
        invalid_temporal_references_after: 0,
        changes: repaired.changes,
        original_validation_errors: repaired.original_validation_errors,
        validation: repaired.contract,
      },
    },
  });
  return {
    status: "EPISODE_PLAN_V2_REPAIRED",
    artifact_id: accepted.artifact_id,
    request_hash: artifact.request_hash,
    provider_response_id: providerOutput.provider_response_id,
    raw_transport_hash: providerOutput.raw_transport_hash,
    content_hash: repaired.content_hash,
    timeline: repaired.timeline,
    validation: repaired.contract,
    provider_calls_added: 0,
  };
}

export async function startThirdShortControlled({
  supabase,
  openAiApiKey,
  creativeModel,
  userId,
  chatId,
  commandKey,
  startTimestamp = new Date().toISOString(),
  logger = () => {},
} = {}) {
  if (!supabase) throw new Error("supabase_required");
  const preflight = thirdShortPreflight();
  if (preflight.status !== "PASS") throw Object.assign(new Error("BUDGET_EXHAUSTED"), { preflight });

  const { data: request, error: requestError } = await supabase.rpc("cf_lumi_controlled_start", {
    p_user: Number(userId), p_chat: Number(chatId), p_command_key: commandKey,
    p_episode_id: THIRD_SHORT.episodeId, p_title: THIRD_SHORT.title,
    p_objective: THIRD_SHORT_IDEA.learning.objective,
    p_pipeline_version: THIRD_SHORT.pipelineVersion,
    p_specification: {
      format: "9:16", preferred_duration_seconds: { min: 43, max: 47 },
      scene_count: 9, pedagogical_pause_seconds: 2.5,
      exact_flower_colors: ["RED", "YELLOW", "BLUE"],
      clean_path_ceiling_usd: THIRD_SHORT.hardCeilingUsd,
    },
  });
  if (requestError) throw Object.assign(new Error("controlled_start_rpc_failed"), { cause: requestError });

  const manager = new LumiRecoveryIncidentManager({ store: new SupabaseLumiRecoveryStore(supabase) });
  const checkpoint = await manager.startEpisode({
    episodeId: THIRD_SHORT.episodeId,
    actions: thirdShortActions(),
    authorizedCeilingUsd: THIRD_SHORT.hardCeilingUsd,
    metadata: {
      title: THIRD_SHORT.title, start_trigger: "LUMI_APP_CANONICAL_COMMAND",
      start_timestamp: startTimestamp, command_key: commandKey,
      global_pipeline_default: "legacy", automatic_retries: 0,
      automatic_variants: 0, automatic_resubmits: 0,
    },
  });
  if (checkpoint.last_completed_action) {
    return { status: checkpoint.status, replay: true, request, checkpoint, preflight, provider_calls: 0 };
  }

  const integration = new Av2PipelineIntegration({
    store: new SupabaseCreativeArtifactStore(supabase), logger,
    engineVersion: "v2", benchmarkOnly: false,
  });
  try {
    const plan = await runCanonicalEpisodePlan({
      integration, apiKey: openAiApiKey, idea: THIRD_SHORT_IDEA,
      context: { idea_id: Number(request.idea_id), episode_id: THIRD_SHORT.episodeId },
      idempotencyKey: `controlled:${THIRD_SHORT.episodeId}:plan:v2`, model: creativeModel,
    });
    if (plan.episode_plan?.scenes?.length !== 9) throw new Error("third_short_scene_count_not_nine");
    await manager.recordRequest(THIRD_SHORT.episodeId, "episode_plan_v2", plan.provider_response_id || plan.artifact_id);
    const completed = await manager.completeAction(THIRD_SHORT.episodeId, "episode_plan_v2", {
      artifact: { artifact_id: plan.artifact_id, request_hash: plan.request_hash, episode_sha256: plan.episode_sha256 },
      evidence: { provider_succeeded: true, artifact_persisted: true, sha_verified: true, artifact_verified: true },
      actualCostUsd: 0,
    });
    return { status: "PLANNED", request, checkpoint: completed, preflight, plan, provider_calls: plan.provider_calls };
  } catch (error) {
    const incident = await manager.pause({
      episodeId: THIRD_SHORT.episodeId, stage: "PLANNING", errorClass: "UNEXPECTED_RUNTIME_ERROR",
      reason: error.code || error.message, firstPendingAction: "episode_plan_v2",
      safeResumeAvailable: false, costLostAvoidable: false,
    });
    return { status: "PAUSED_INCIDENT", request, checkpoint: await manager.status(THIRD_SHORT.episodeId), incident, preflight, provider_calls: 0 };
  }
}
