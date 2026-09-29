import {
  LUMI_PILOT_IMAGE_ESTIMATE_USD,
  LUMI_PILOT_IMAGE_MAX_USD,
  runPilotImageRepair,
} from "./lumi-production-pilot-v1.js";

export const LUMI_PILOT_REPAIR_SCENE = "s19";
export const LUMI_PILOT_REPAIR_STAGE = "IMAGE";
export const LUMI_PILOT_REPAIR_REASON = "SOURCE_REPAIR_REQUIRED";
export const LUMI_PILOT_REPAIR_ATTEMPT = 1;

function readRows(supabase, pilotId) {
  return supabase.from("lumi_pilot_repairs").select("*").eq("pilot_id", pilotId);
}

export function validatePilotRepair({
  env = process.env, sceneId, stage, repairReason, repairAttempt = 0,
  existingStatus, boot = false,
} = {}) {
  if (String(env.LUMI_RUNTIME_ENV || "").trim().toLowerCase() !== "staging") {
    throw new Error("lumi_pilot_repair_staging_guard_rejected");
  }
  if (String(sceneId || "").trim().toLowerCase() !== LUMI_PILOT_REPAIR_SCENE) {
    throw new Error("lumi_pilot_repair_scene_not_allowed");
  }
  if (String(stage || "").trim().toUpperCase() !== LUMI_PILOT_REPAIR_STAGE) {
    throw new Error("lumi_pilot_repair_stage_not_allowed");
  }
  if (repairReason !== LUMI_PILOT_REPAIR_REASON) {
    throw new Error("lumi_pilot_repair_reason_required");
  }
  if (Number(repairAttempt) !== 0) {
    throw new Error("lumi_pilot_repair_attempt_not_zero");
  }
  if (existingStatus !== LUMI_PILOT_REPAIR_REASON && existingStatus !== "SOURCE_REPAIR_REQUIRED") {
    throw new Error("lumi_pilot_repair_source_not_terminal");
  }
  if (boot && env.LUMI_PILOT_REPAIR_ENABLED !== "true") {
    throw new Error("lumi_pilot_repair_not_explicitly_enabled");
  }
  return {
    sceneId: LUMI_PILOT_REPAIR_SCENE,
    stage: LUMI_PILOT_REPAIR_STAGE,
    repairReason: LUMI_PILOT_REPAIR_REASON,
    repairAttempt: LUMI_PILOT_REPAIR_ATTEMPT,
  };
}

async function readSourceRun(supabase, pilotId, sceneId) {
  const { data, error } = await supabase.from("lumi_pilot_runs").select("*")
    .eq("pilot_id", pilotId).eq("scene_id", sceneId).eq("stage", "IMAGE").single();
  if (error || !data) throw new Error("lumi_pilot_repair_source_run_missing");
  return data;
}

export async function claimPilotRepair({
  supabase, pilotId, sceneId, stage, repairReason, repairAttempt = 0,
  maxUsd = LUMI_PILOT_IMAGE_MAX_USD, estimatedCostUsd = LUMI_PILOT_IMAGE_ESTIMATE_USD,
} = {}) {
  const sourceRun = await readSourceRun(supabase, pilotId, sceneId);
  validatePilotRepair({ env: { LUMI_RUNTIME_ENV: "staging" }, sceneId, stage, repairReason, repairAttempt, existingStatus: repairReason });
  const existing = await readRows(supabase, pilotId);
  const { data: repairs, error: readError } = await existing;
  if (readError) throw new Error("lumi_pilot_repairs_read_failed");
  const prior = (repairs || []).find((row) => row.scene_id === sceneId && row.stage === stage && Number(row.repair_attempt) === 1);
  if (prior) return { claimed: false, row: prior, reason: "lumi_pilot_repair_duplicate" };
  if (estimatedCostUsd > Number(maxUsd) + 1e-9) throw new Error("lumi_pilot_repair_budget_exceeded");
  const row = {
    pilot_id: pilotId, scene_id: sceneId, stage,
    source_run_id: sourceRun.id, repair_reason: repairReason,
    repair_attempt: 1, status: "CLAIMED", provider_calls: 1,
    estimated_cost_usd: estimatedCostUsd,
    claimed_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  };
  const { data, error } = await supabase.from("lumi_pilot_repairs").insert(row).select("*").single();
  if (!error) return { claimed: true, row: data };
  if (error.code === "23505") return { claimed: false, row: null, reason: "lumi_pilot_repair_duplicate" };
  throw new Error("lumi_pilot_repair_claim_failed");
}

export async function updatePilotRepair({ supabase, pilotId, sceneId, stage, patch = {}, status }) {
  const { data, error } = await supabase.from("lumi_pilot_repairs").update({
    status, ...patch, updated_at: new Date().toISOString(),
    ...(status === "SUCCEEDED" || status === "FAILED" ? { completed_at: new Date().toISOString() } : {}),
  }).eq("pilot_id", pilotId).eq("scene_id", sceneId).eq("stage", stage).eq("repair_attempt", 1).select("*").single();
  if (error) throw new Error("lumi_pilot_repair_update_failed");
  return data;
}

export async function runPilotRepairCommand({
  env = process.env, supabase, store, sceneId, stage, repairReason,
  repairAttempt = 0, openAiApiKey, supabaseUrl, imageMaxUsd = LUMI_PILOT_IMAGE_MAX_USD,
  onUpdate = () => {},
} = {}) {
  const sourceRun = await readSourceRun(supabase, "lumi_cinco_huevos_v1", sceneId);
  const command = validatePilotRepair({
    env, sceneId, stage, repairReason, repairAttempt,
    existingStatus: sourceRun.result?.source_qa_status || repairReason,
    boot: true,
  });
  if (!supabase || !store) throw new Error("lumi_pilot_repair_storage_not_configured");
  const claim = await claimPilotRepair({
    supabase, pilotId: "lumi_cinco_huevos_v1", sceneId: command.sceneId, stage: command.stage,
    repairReason: command.repairReason, repairAttempt, maxUsd: imageMaxUsd,
  });
  if (!claim.claimed) return { status: "cache_hit", scene_id: command.sceneId, stage: command.stage, repair_attempt: 1, provider_calls: 0, claim };
  await updatePilotRepair({ supabase, pilotId: "lumi_cinco_huevos_v1", sceneId: command.sceneId, stage: command.stage, status: "REQUESTED" });
  onUpdate({ phase: "images", status: "requested", scene_id: command.sceneId, repair_attempt: 1, provider_calls: 1 });
  try {
    const result = await runPilotImageRepair({
      supabase, store, apiKey: openAiApiKey, supabaseUrl,
      sceneId: command.sceneId, repairAttempt: 1, maxUsd: imageMaxUsd, onUpdate,
    });
    const terminal = result.status === "generated" ? "SUCCEEDED" : "FAILED";
    await updatePilotRepair({
      supabase, pilotId: "lumi_cinco_huevos_v1", sceneId: command.sceneId,
      stage: command.stage, status: terminal, patch: { result, content_hash: result.asset_hash || null },
    });
    return { ...result, repair_attempt: 1, claim: { ...claim, terminal } };
  } catch (error) {
    await updatePilotRepair({
      supabase, pilotId: "lumi_cinco_huevos_v1", sceneId: command.sceneId,
      stage: command.stage, status: "FAILED", patch: { error_code: error.code || error.message || "repair_failed" },
    });
    throw error;
  }
}
