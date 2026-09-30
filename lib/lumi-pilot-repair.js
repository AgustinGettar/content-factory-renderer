import {
  LUMI_PILOT_IMAGE_ESTIMATE_USD,
  LUMI_PILOT_IMAGE_MAX_USD,
  runPilotImageRepair,
} from "./lumi-production-pilot-v1.js";

export const LUMI_PILOT_REPAIR_SCENE = "s19";
export const LUMI_PILOT_REPAIR_STAGE = "IMAGE";
export const LUMI_PILOT_REPAIR_REASON = "SOURCE_REPAIR_REQUIRED";
export const LUMI_PILOT_REPAIR_ATTEMPT = 1;
export const LUMI_PILOT_REPAIR_LIFECYCLE = Object.freeze({
  CLAIMED: "REPAIR_CLAIMED",
  PREPARING: "REPAIR_PREPARING",
  DISPATCH_COMMITTED: "PROVIDER_DISPATCH_COMMITTED",
  DISPATCH_UNCERTAIN: "PROVIDER_DISPATCH_UNCERTAIN",
  PROVIDER_EMITTED: "PROVIDER_REQUEST_EMITTED",
  SUCCEEDED: "SUCCEEDED",
  FAILED_BEFORE_PROVIDER: "FAILED_BEFORE_PROVIDER",
  FAILED_AFTER_PROVIDER: "FAILED_AFTER_PROVIDER",
});

function readRows(supabase, pilotId) {
  return supabase.from("lumi_pilot_repairs").select("*").eq("pilot_id", pilotId);
}

export function providerAttemptConsumed(row = {}) {
  return Number(row.provider_calls || 0) > 0
    || Boolean(row.provider_request_id)
    || row.result?.provider_call_emitted === true
    || row.result?.provider_attempt_consumed === true
    || [
      LUMI_PILOT_REPAIR_LIFECYCLE.PROVIDER_EMITTED,
      LUMI_PILOT_REPAIR_LIFECYCLE.DISPATCH_COMMITTED,
      LUMI_PILOT_REPAIR_LIFECYCLE.DISPATCH_UNCERTAIN,
      LUMI_PILOT_REPAIR_LIFECYCLE.SUCCEEDED,
      LUMI_PILOT_REPAIR_LIFECYCLE.FAILED_AFTER_PROVIDER,
    ].includes(row.result?.lifecycle_state);
}

async function recoverFailedBeforeProvider({ supabase, prior }) {
  const priorResult = prior.result && typeof prior.result === "object" ? prior.result : {};
  const history = Array.isArray(priorResult.history) ? priorResult.history : [];
  const result = {
    ...priorResult,
    lifecycle_state: LUMI_PILOT_REPAIR_LIFECYCLE.CLAIMED,
    provider_call_emitted: false,
    provider_attempt_consumed: false,
    recovery_count: Number(priorResult.recovery_count || 0) + 1,
    history: [...history, {
      status: prior.status,
      error_code: prior.error_code || null,
      completed_at: prior.completed_at || null,
      lifecycle_state: priorResult.lifecycle_state || priorResult.terminal_state || null,
      provider_call_emitted: false,
      provider_request_id: prior.provider_request_id || null,
    }],
  };
  const { data, error } = await supabase.from("lumi_pilot_repairs").update({
    status: "CLAIMED",
    provider_calls: 0,
    cost_usd: 0,
    provider_request_id: null,
    error_code: null,
    completed_at: null,
    result,
  }).eq("id", prior.id).eq("status", "FAILED").eq("provider_calls", 0).select("*").maybeSingle();
  if (error) throw new Error("lumi_pilot_repair_recovery_failed");
  return data;
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
  if (prior) {
    if (providerAttemptConsumed(prior)) {
      return { claimed: false, row: prior, reason: "lumi_pilot_repair_provider_attempt_consumed" };
    }
    if (prior.status !== "FAILED") {
      return { claimed: false, row: prior, reason: "lumi_pilot_repair_duplicate" };
    }
    const recovered = await recoverFailedBeforeProvider({ supabase, prior });
    if (!recovered) return { claimed: false, row: prior, reason: "lumi_pilot_repair_duplicate" };
    return { claimed: true, row: recovered, recovered: true };
  }
  if (estimatedCostUsd > Number(maxUsd) + 1e-9) throw new Error("lumi_pilot_repair_budget_exceeded");
  const row = {
    pilot_id: pilotId, scene_id: sceneId, stage,
    source_run_id: sourceRun.id, repair_reason: repairReason,
    repair_attempt: 1, status: "CLAIMED", provider_calls: 0,
    cost_usd: 0,
    result: {
      lifecycle_state: LUMI_PILOT_REPAIR_LIFECYCLE.CLAIMED,
      provider_call_emitted: false,
      provider_attempt_consumed: false,
      estimated_cost_usd: estimatedCostUsd,
    },
    claimed_at: new Date().toISOString(),
  };
  const { data, error } = await supabase.from("lumi_pilot_repairs").insert(row).select("*").single();
  if (!error) return { claimed: true, row: data };
  if (error.code === "23505") return { claimed: false, row: null, reason: "lumi_pilot_repair_duplicate" };
  throw new Error("lumi_pilot_repair_claim_failed");
}

export async function updatePilotRepair({ supabase, pilotId, sceneId, stage, patch = {}, status }) {
  const { data, error } = await supabase.from("lumi_pilot_repairs").update({
    status, ...patch,
    ...(status === "SUCCEEDED" || status === "FAILED" ? { completed_at: new Date().toISOString() } : {}),
  }).eq("pilot_id", pilotId).eq("scene_id", sceneId).eq("stage", stage).eq("repair_attempt", 1).select("*").single();
  if (error) throw new Error("lumi_pilot_repair_update_failed");
  return data;
}

export async function runPilotRepairCommand({
  env = process.env, supabase, store, sceneId, stage, repairReason,
  repairAttempt = 0, openAiApiKey, supabaseUrl, imageMaxUsd = LUMI_PILOT_IMAGE_MAX_USD,
  onUpdate = () => {}, runImageRepair = runPilotImageRepair,
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
  if (!claim.claimed) {
    const error = new Error(claim.reason || "lumi_pilot_repair_duplicate");
    error.code = claim.reason || "lumi_pilot_repair_duplicate";
    throw error;
  }
  const auditBase = claim.row?.result && typeof claim.row.result === "object" ? claim.row.result : {};
  let providerCallEmitted = false;
  let providerDispatchCommitted = false;
  let providerRequestId = null;
  let preparedSpecificationId = null;
  let preparedSpecificationHash = null;
  let preparedRequestHash = null;
  try {
    const result = await runImageRepair({
      supabase, store, apiKey: openAiApiKey, supabaseUrl,
      sceneId: command.sceneId, repairAttempt: 1, maxUsd: imageMaxUsd, onUpdate,
      onPrepared: async ({ specification_id, specification_hash, request_hash }) => {
        preparedSpecificationId = specification_id;
        preparedSpecificationHash = specification_hash;
        preparedRequestHash = request_hash;
        await updatePilotRepair({
          supabase, pilotId: "lumi_cinco_huevos_v1", sceneId: command.sceneId,
          stage: command.stage, status: "CLAIMED", patch: {
            specification_hash, request_hash, provider_calls: 0, cost_usd: 0,
            result: {
              ...auditBase,
              lifecycle_state: LUMI_PILOT_REPAIR_LIFECYCLE.PREPARING,
              provider_call_emitted: false,
              provider_attempt_consumed: false,
              specification_id,
            },
          },
        });
      },
      onBeforeProviderDispatch: async ({ specification_hash, request_hash }) => {
        preparedSpecificationHash = specification_hash;
        preparedRequestHash = request_hash;
        // Treat an uncertain write acknowledgement conservatively; fetch is only
        // invoked after this durable update has acknowledged success.
        providerDispatchCommitted = true;
        await updatePilotRepair({
          supabase, pilotId: "lumi_cinco_huevos_v1", sceneId: command.sceneId,
          stage: command.stage, status: "REQUESTED", patch: {
            specification_hash, request_hash, provider_calls: 0, cost_usd: 0,
            result: {
              ...auditBase,
              lifecycle_state: LUMI_PILOT_REPAIR_LIFECYCLE.DISPATCH_COMMITTED,
              provider_call_emitted: false,
              provider_attempt_consumed: true,
              specification_id: preparedSpecificationId,
              dispatch_committed_at: new Date().toISOString(),
            },
          },
        });
      },
      onProviderRequestEmitted: async ({ specification_hash, request_hash }) => {
        providerCallEmitted = true;
        preparedSpecificationHash = specification_hash;
        preparedRequestHash = request_hash;
        await updatePilotRepair({
          supabase, pilotId: "lumi_cinco_huevos_v1", sceneId: command.sceneId,
          stage: command.stage, status: "REQUESTED", patch: {
            specification_hash, request_hash, provider_calls: 1,
            cost_usd: LUMI_PILOT_IMAGE_ESTIMATE_USD,
            result: {
              ...auditBase,
              lifecycle_state: LUMI_PILOT_REPAIR_LIFECYCLE.PROVIDER_EMITTED,
              provider_call_emitted: true,
              provider_attempt_consumed: true,
              specification_id: preparedSpecificationId,
            },
          },
        });
      },
      onProviderResponse: async ({ provider_request_id }) => {
        providerRequestId = provider_request_id || null;
        await updatePilotRepair({
          supabase, pilotId: "lumi_cinco_huevos_v1", sceneId: command.sceneId,
          stage: command.stage, status: "REQUESTED", patch: {
            provider_request_id: providerRequestId,
            provider_calls: 1,
            result: {
              ...auditBase,
              lifecycle_state: LUMI_PILOT_REPAIR_LIFECYCLE.PROVIDER_EMITTED,
              provider_call_emitted: true,
              provider_attempt_consumed: true,
              specification_id: preparedSpecificationId,
            },
          },
        });
      },
    });
    const terminal = result.status === "generated" ? "SUCCEEDED" : "FAILED";
    await updatePilotRepair({
      supabase, pilotId: "lumi_cinco_huevos_v1", sceneId: command.sceneId,
      stage: command.stage, status: terminal, patch: {
        result: {
          ...auditBase,
          ...result,
          lifecycle_state: terminal === "SUCCEEDED"
            ? LUMI_PILOT_REPAIR_LIFECYCLE.SUCCEEDED
            : LUMI_PILOT_REPAIR_LIFECYCLE.FAILED_AFTER_PROVIDER,
          provider_call_emitted: true,
          provider_attempt_consumed: true,
        },
        provider_request_id: result.provider_request_id || providerRequestId,
        artifact_id: result.artifact_id || null,
        specification_hash: result.specification_hash || preparedSpecificationHash,
        request_hash: result.request_hash || preparedRequestHash,
        cost_usd: result.actual_cost_usd || result.estimated_total_usd || LUMI_PILOT_IMAGE_ESTIMATE_USD,
        provider_calls: 1,
      },
    });
    return { ...result, repair_attempt: 1, claim: { ...claim, terminal } };
  } catch (error) {
    if (preparedSpecificationId) {
      try {
        await store.setSpecificationStatus(
          preparedSpecificationId,
          providerDispatchCommitted ? "rejected" : "planned",
          { code: error.code || error.message || "repair_failed", recoverable_before_provider: !providerDispatchCommitted },
        );
      } catch (statusError) {
        error.specification_status_error = statusError.code || statusError.message || "specification_status_failed";
      }
    }
    const lifecycleState = providerCallEmitted
      ? LUMI_PILOT_REPAIR_LIFECYCLE.FAILED_AFTER_PROVIDER
      : providerDispatchCommitted
        ? LUMI_PILOT_REPAIR_LIFECYCLE.DISPATCH_UNCERTAIN
        : LUMI_PILOT_REPAIR_LIFECYCLE.FAILED_BEFORE_PROVIDER;
    await updatePilotRepair({
      supabase, pilotId: "lumi_cinco_huevos_v1", sceneId: command.sceneId,
      stage: command.stage, status: "FAILED", patch: {
        error_code: error.code || error.message || "repair_failed",
        provider_calls: providerCallEmitted ? 1 : 0,
        cost_usd: providerCallEmitted ? LUMI_PILOT_IMAGE_ESTIMATE_USD : 0,
        provider_request_id: providerRequestId,
        specification_hash: preparedSpecificationHash,
        request_hash: preparedRequestHash,
        result: {
          ...auditBase,
          lifecycle_state: lifecycleState,
          provider_call_emitted: providerCallEmitted,
          provider_attempt_consumed: providerDispatchCommitted,
          provider_request_id: providerRequestId,
          specification_id: preparedSpecificationId,
          error_code: error.code || error.message || "repair_failed",
        },
      },
    });
    throw error;
  }
}
