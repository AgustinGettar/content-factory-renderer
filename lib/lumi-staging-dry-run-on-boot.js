import crypto from "node:crypto";

let bootExecution = null;

function enabled(value) {
  return String(value || "").trim().toLowerCase() === "true";
}

export function shouldRunAuthenticatedStagingDryRunOnBoot(env = process.env) {
  if (!enabled(env.LUMI_STAGING_DRY_RUN_ON_BOOT)) return false;
  if (String(env.LUMI_RUNTIME_ENV || "").trim().toLowerCase() !== "staging") {
    throw new Error("staging_dry_run_production_rejected");
  }
  if (String(env.PROVIDER_CALLS_ALLOWED || "").trim() !== "0") {
    throw new Error("staging_dry_run_zero_provider_lock_required");
  }
  return true;
}

function executionId(env) {
  const supplied = String(env.LUMI_STAGING_DRY_RUN_ID || "").trim();
  if (supplied && !/^[a-zA-Z0-9._:-]{1,128}$/.test(supplied)) {
    throw new Error("staging_dry_run_execution_id_invalid");
  }
  return supplied || `lumi-readiness-${crypto.randomUUID()}`;
}

function sanitizeResult(payload, id) {
  return {
    event: "lumi_authenticated_staging_dry_run",
    dry_run_execution_id: id,
    status: payload.status,
    simulations_pass_count: payload.simulations_pass_count,
    simulations_required: 5,
    exactly_once_resume: payload.exactly_once_resume,
    duplicate_provider_calls: payload.duplicate_provider_calls,
    provider_calls: payload.provider_calls,
    telegram_single_message: payload.telegram_single_message,
    artifact_validation: payload.artifact_validation,
    tts_storage_gate: payload.tts_storage_gate,
    budget_gate: payload.budget_gate,
    runners_off: payload.runners_off,
    autorun: payload.autorun,
  };
}

export async function runAuthenticatedStagingDryRunOnBoot({
  env = process.env,
  port,
  fetchImpl = globalThis.fetch,
  logger = console,
} = {}) {
  if (!shouldRunAuthenticatedStagingDryRunOnBoot(env)) return { status: "SKIPPED" };
  if (bootExecution) return bootExecution;

  bootExecution = (async () => {
    const token = String(env.RENDER_API_TOKEN || env.ADMIN_API_TOKEN || "");
    if (!token) throw new Error("staging_dry_run_auth_token_missing");
    const id = executionId(env);
    const response = await fetchImpl(`http://127.0.0.1:${Number(port)}/lumi-pipeline/v1_1_2/dry-run`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-render-token": token },
      body: JSON.stringify({ execution_id: id }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.status !== "PASS" || payload.provider_calls !== 0) {
      throw new Error(`staging_dry_run_failed:http_${response.status}:${String(payload.error || payload.status || "invalid_result").slice(0, 120)}`);
    }
    const result = sanitizeResult(payload, id);
    logger.info(JSON.stringify(result));
    return result;
  })();

  return bootExecution;
}

export function resetAuthenticatedStagingDryRunForTest() {
  bootExecution = null;
}
