import { Av2PipelineIntegration } from "./av2/pipeline-integration.js";
import { SupabaseCreativeArtifactStore } from "./av2/persistence.js";
import { runCanonicalEpisodePlan } from "./av2/benchmark-runner.js";
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
