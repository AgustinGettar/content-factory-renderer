const ACTION_PATHS = Object.freeze({
  START: ["POST", "/lumi-pipeline/v1_1_2/episodes/third/start"],
  RESUME: ["POST", "/lumi-pipeline/v1_1_2/episodes/third/resume"],
  IMAGE: ["POST", "/lumi-pipeline/v1_1_2/episodes/third/images"],
  VIDEO: ["POST", "/lumi-pipeline/v1_1_2/episodes/third/videos"],
  TTS: ["POST", "/lumi-pipeline/v1_1_2/episodes/third/tts"],
  ASSEMBLY: ["POST", "/lumi-pipeline/v1_1_2/episodes/third/assemble"],
});

let bootExecution = null;

export function thirdShortBootAction(env = process.env) {
  const action = String(env.LUMI_THIRD_SHORT_BOOT_ACTION || "").trim().toUpperCase();
  if (!action) return null;
  if (String(env.LUMI_RUNTIME_ENV || "").trim().toLowerCase() !== "staging") throw new Error("third_short_boot_production_rejected");
  if (!ACTION_PATHS[action] && !['USD_QUOTE','SHOT_PACK_DESIGN','SHOT_PACK_PREFLIGHT'].includes(action)) throw new Error("third_short_boot_action_invalid");
  return action;
}

export async function runThirdShortBootAction({ env = process.env, port, fetchImpl = fetch, logger = console } = {}) {
  const action = thirdShortBootAction(env);
  if (!action) return { status: "SKIPPED" };
  if (bootExecution) return bootExecution;
  bootExecution = (async () => {
    if (['SHOT_PACK_DESIGN','SHOT_PACK_PREFLIGHT'].includes(action)) {
      const { runThirdShotPackDesign } = await import('./lumi-third-shot-pack-design-v1.js');
      return runThirdShotPackDesign({env,logger,freshPreflight:action==='SHOT_PACK_PREFLIGHT'});
    }
    if (action === "USD_QUOTE") {
      const { runHiggsfieldUsdPreflight } = await import('./lumi-higgsfield-usd-preflight-v1.js');
      return runHiggsfieldUsdPreflight({ env, fetchImpl, logger });
    }
    const token = String(env.RENDER_API_TOKEN || env.ADMIN_API_TOKEN || "");
    if (!token) throw new Error("third_short_boot_auth_token_missing");
    const [method, path] = ACTION_PATHS[action];
    const body = action === "START" ? {
      pipeline_version: "v1_1_2",
      user_id: Number(env.LUMI_THIRD_SHORT_TELEGRAM_USER_ID || 6213838779),
      chat_id: Number(env.LUMI_THIRD_SHORT_TELEGRAM_CHAT_ID || 6213838779),
      command_key: String(env.LUMI_THIRD_SHORT_COMMAND_KEY || "lumi-third-short-controlled-20261004"),
      start_timestamp: String(env.LUMI_THIRD_SHORT_START_TIMESTAMP || new Date().toISOString()),
    } : action === "RESUME" && env.LUMI_THIRD_SHORT_HUMAN_OVERRIDE_JSON
      ? { human_override: JSON.parse(env.LUMI_THIRD_SHORT_HUMAN_OVERRIDE_JSON) } : {};
    const response = await fetchImpl(`http://127.0.0.1:${Number(port)}${path}`, {
      method,
      headers: { "content-type": "application/json", "x-render-token": token },
      body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`third_short_boot_failed:${action}:http_${response.status}:${String(payload.error || payload.status || "unknown").slice(0, 160)}`);
    const result = { event: "lumi_third_short_boot_action", action, status: payload.status || payload.state?.status || "ACCEPTED", episode_id: payload.episode_id || "ep_lumi_flores_003", provider_calls: Number(payload.provider_calls || 0) };
    logger.info(JSON.stringify(result));
    return result;
  })();
  return bootExecution;
}

export function resetThirdShortBootActionForTest() { bootExecution = null; }
