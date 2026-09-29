import { LUMI_PILOT_SCENE_IDS } from "./lumi-production-pilot-v1.js";
import { runPilotCommand, validatePilotCommand } from "./lumi-pilot-internal.js";
import { runPilotRepairCommand, validatePilotRepair } from "./lumi-pilot-repair.js";

export const LUMI_PILOT_BOOT_STAGES = Object.freeze(["IMAGE", "VIDEO"]);

export function readLumiPilotBootConfig(env = process.env) {
  const sceneId = String(env.LUMI_PILOT_BOOT_SCENE || env.AV2_PILOT_RUN_SCENE || "").trim().toLowerCase();
  const stage = String(env.LUMI_PILOT_BOOT_STAGE || env.AV2_PILOT_RUN_STAGE || "").trim().toUpperCase();
  const enabled = env.LUMI_PILOT_BOOT_ENABLED === "true"
    || (env.LUMI_PRODUCTION_PILOT_ENABLED === "true" && env.AV2_PILOT_RUN_ON_BOOT === "true");
  const repairEnabled = env.LUMI_PILOT_REPAIR_ENABLED === "true";
  const repairReason = String(env.LUMI_PILOT_REPAIR_REASON || "").trim();
  const config = { enabled, sceneId, stage };
  if (repairEnabled || repairReason) {
    config.repairEnabled = repairEnabled;
    config.repairReason = repairReason;
  }
  return config;
}

export function shouldRunLumiPilotOnBoot(env = process.env) {
  const config = readLumiPilotBootConfig(env);
  return (config.enabled || Boolean(config.repairEnabled)) && LUMI_PILOT_SCENE_IDS.includes(config.sceneId) && LUMI_PILOT_BOOT_STAGES.includes(config.stage)
    && String(env.LUMI_RUNTIME_ENV || "").trim().toLowerCase() === "staging";
}

export async function runLumiPilotOnBoot({
  env = process.env,
  supabase,
  store,
  openAiApiKey,
  higgsfieldApiKey,
  supabaseUrl,
  balanceConfirmed,
  imageMaxUsd,
  videoMaxUsd,
  logger = () => {},
  runCommand = runPilotCommand,
  runRepairCommand = runPilotRepairCommand,
}) {
  const config = readLumiPilotBootConfig(env);
  if (!config.enabled && !config.repairEnabled) return { status: "disabled", provider_calls: 0 };
  if (config.repairEnabled) {
    validatePilotRepair({
      env: { ...env, LUMI_PILOT_REPAIR_ENABLED: "true" },
      sceneId: config.sceneId, stage: config.stage,
      repairReason: config.repairReason, repairAttempt: 0, existingStatus: "SOURCE_REPAIR_REQUIRED", boot: true,
    });
  } else {
    validatePilotCommand({ env: { ...env, LUMI_PILOT_BOOT_ENABLED: "true" }, sceneId: config.sceneId, stage: config.stage, boot: true });
  }
  if (!supabase || !store) throw new Error("lumi_pilot_boot_storage_not_configured");

  logger({ component: "lumi_pilot_boot", event: "one_shot_started", scene_id: config.sceneId });
  const onUpdate = (entry) => logger({
    component: "lumi_pilot_boot",
    event: `one_shot_${entry.status || "updated"}`,
    scene_id: entry.scene_id || config.sceneId,
    provider_calls: entry.provider_calls,
    cache_hits: entry.status === "cache_hit" ? 1 : undefined,
    error_code: entry.error,
  });
  const runner = config.repairEnabled ? runRepairCommand : runCommand;
  const result = await runner({
    env: { ...env, LUMI_RUNTIME_ENV: "staging", LUMI_PILOT_BOOT_ENABLED: "true", LUMI_PILOT_REPAIR_ENABLED: config.repairEnabled ? "true" : env.LUMI_PILOT_REPAIR_ENABLED },
    supabase, store, openAiApiKey, higgsfieldApiKey, supabaseUrl,
    balanceConfirmed, imageMaxUsd, videoMaxUsd,
    sceneId: config.sceneId, stage: config.stage, repairReason: config.repairReason,
    repairAttempt: 0, boot: true, onUpdate,
  });
  logger({
    component: "lumi_pilot_boot",
    event: result.status === "cache_hit" ? "one_shot_cache_hit" : "one_shot_finished",
    scene_id: config.sceneId,
    provider_calls: result.provider_calls,
    cache_hits: result.status === "cache_hit" ? 1 : 0,
  });
  return result;
}
