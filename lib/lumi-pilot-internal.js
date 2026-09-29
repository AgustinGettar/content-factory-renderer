import {
  LUMI_PILOT_IMAGE_CALL_CAP,
  LUMI_PILOT_IMAGE_ESTIMATE_USD,
  LUMI_PILOT_IMAGE_MAX_USD,
  LUMI_PILOT_SCENE_IDS,
  LUMI_PILOT_VIDEO_CALL_CAP,
  LUMI_PILOT_VIDEO_MAX_USD,
  runPilotImages,
  runPilotVideos,
} from "./lumi-production-pilot-v1.js";

export const LUMI_PILOT_ID = "lumi_cinco_huevos_v1";
export const LUMI_PILOT_STAGES = Object.freeze(["IMAGE", "VIDEO"]);
export const LUMI_PILOT_VIDEO_ESTIMATE_USD = 0.231;

function normalizedScene(sceneId) {
  return String(sceneId || "").trim().toLowerCase();
}

export function validatePilotCommand({ env = process.env, sceneId, stage, boot = false } = {}) {
  if (String(env.LUMI_RUNTIME_ENV || "").trim().toLowerCase() !== "staging") {
    throw new Error("lumi_pilot_staging_guard_rejected");
  }
  const normalizedStage = String(stage || "").trim().toUpperCase();
  const normalized = normalizedScene(sceneId);
  if (!LUMI_PILOT_SCENE_IDS.includes(normalized)) throw new Error("lumi_pilot_scene_not_allowed");
  if (!LUMI_PILOT_STAGES.includes(normalizedStage)) throw new Error("lumi_pilot_stage_not_allowed");
  if (boot && env.LUMI_PILOT_BOOT_ENABLED !== "true" && env.AV2_PILOT_RUN_ON_BOOT !== "true") {
    throw new Error("lumi_pilot_boot_disabled");
  }
  return { pilotId: LUMI_PILOT_ID, sceneId: normalized, stage: normalizedStage };
}

async function readRuns(supabase, pilotId) {
  const { data, error } = await supabase.from("lumi_pilot_runs").select("*").eq("pilot_id", pilotId);
  if (error) throw new Error("lumi_pilot_runs_read_failed");
  return data || [];
}

export async function claimPilotRun({ supabase, pilotId = LUMI_PILOT_ID, sceneId, stage, maxCalls, maxUsd, estimatedCostUsd }) {
  const runs = await readRuns(supabase, pilotId);
  const existing = runs.find((row) => row.scene_id === sceneId && row.stage === stage);
  if (existing) return { claimed: false, row: existing, reason: `pilot_run_${String(existing.status).toLowerCase()}` };
  const calls = runs.filter((row) => row.stage === stage && ["CLAIMED", "REQUESTED", "SUCCEEDED", "FAILED"].includes(row.status)).length;
  const spent = runs.filter((row) => row.stage === stage && ["CLAIMED", "REQUESTED", "SUCCEEDED", "FAILED"].includes(row.status))
    .reduce((sum, row) => sum + Number(row.estimated_cost_usd || 0), 0);
  if (calls + 1 > maxCalls) throw new Error("lumi_pilot_provider_call_cap_exceeded");
  if (spent + estimatedCostUsd > maxUsd + 1e-9) throw new Error("lumi_pilot_budget_exceeded");
  const row = {
    pilot_id: pilotId, scene_id: sceneId, stage, status: "CLAIMED",
    provider_calls: 1, estimated_cost_usd: estimatedCostUsd,
    claimed_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  };
  const { data, error } = await supabase.from("lumi_pilot_runs").insert(row).select("*").single();
  if (!error) return { claimed: true, row: data };
  if (error.code === "23505") {
    const retry = await readRuns(supabase, pilotId);
    const duplicate = retry.find((entry) => entry.scene_id === sceneId && entry.stage === stage);
    return { claimed: false, row: duplicate, reason: "pilot_run_duplicate_claim" };
  }
  throw new Error("lumi_pilot_run_claim_failed");
}

export async function updatePilotRun({ supabase, pilotId = LUMI_PILOT_ID, sceneId, stage, status, patch = {} }) {
  const { data, error } = await supabase.from("lumi_pilot_runs").update({
    status, ...patch, updated_at: new Date().toISOString(),
    ...(status === "SUCCEEDED" || status === "FAILED" ? { completed_at: new Date().toISOString() } : {}),
  }).eq("pilot_id", pilotId).eq("scene_id", sceneId).eq("stage", stage).select("*").single();
  if (error) throw new Error("lumi_pilot_run_update_failed");
  return data;
}

export async function runPilotCommand({
  env = process.env, supabase, store, sceneId, stage, boot = false,
  openAiApiKey, higgsfieldApiKey, supabaseUrl, balanceConfirmed,
  imageMaxUsd = LUMI_PILOT_IMAGE_MAX_USD, videoMaxUsd = LUMI_PILOT_VIDEO_MAX_USD,
  onUpdate = () => {},
} = {}) {
  const command = validatePilotCommand({ env, sceneId, stage, boot });
  if (!supabase || !store) throw new Error("lumi_pilot_storage_not_configured");
  const estimatedCostUsd = command.stage === "IMAGE" ? LUMI_PILOT_IMAGE_ESTIMATE_USD : LUMI_PILOT_VIDEO_ESTIMATE_USD;
  const claim = await claimPilotRun({
    supabase, ...command,
    maxCalls: command.stage === "IMAGE" ? LUMI_PILOT_IMAGE_CALL_CAP : LUMI_PILOT_VIDEO_CALL_CAP,
    maxUsd: command.stage === "IMAGE" ? imageMaxUsd : videoMaxUsd,
    estimatedCostUsd,
  });
  if (!claim.claimed) return { status: "cache_hit", scene_id: command.sceneId, stage: command.stage, provider_calls: 0, claim: claim.row };
  await updatePilotRun({ supabase, ...command, status: "REQUESTED" });
  onUpdate({ phase: command.stage === "IMAGE" ? "images" : "videos", status: "requested", scene_id: command.sceneId, provider_calls: 1 });
  try {
    const result = command.stage === "IMAGE"
      ? await runPilotImages({ supabase, store, apiKey: openAiApiKey, supabaseUrl, sceneId: command.sceneId, maxUsd: imageMaxUsd, onUpdate })
      : await runPilotVideos({ supabase, apiKey: higgsfieldApiKey, balanceConfirmed, sceneId: command.sceneId, maxUsd: videoMaxUsd, onUpdate });
    const terminal = result.status === "generated" || result.status === "cache_hit" ? "SUCCEEDED" : "FAILED";
    await updatePilotRun({ supabase, ...command, status: terminal, patch: { result: result } });
    return { ...result, stage: command.stage, claim: { ...claim, terminal } };
  } catch (error) {
    await updatePilotRun({ supabase, ...command, status: "FAILED", patch: { error_code: error.code || error.message || "pilot_failed" } });
    throw error;
  }
}
