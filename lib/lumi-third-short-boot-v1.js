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
  if (!ACTION_PATHS[action] && !['USD_QUOTE','SHOT_PACK_DESIGN','SHOT_PACK_PREFLIGHT','SHOT_PACK_START','SHOT_PACK_QA_NEXT','SHOT_PACK_STATUS','SHOT_PACK_PAUSE','Q31_SERIES_V2_CALIBRATION'].includes(action)) throw new Error("third_short_boot_action_invalid");
  return action;
}

export async function runThirdShortBootAction({ env = process.env, port, fetchImpl = fetch, logger = console } = {}) {
  const action = thirdShortBootAction(env);
  if (!action) return { status: "SKIPPED" };
  if (bootExecution) return bootExecution;
  bootExecution = (async () => {
    if (action === 'Q31_SERIES_V2_CALIBRATION') {
      const { runQ31SeriesV2Calibration } = await import('./lumi-q31-series-v2-calibration.js');
      return runQ31SeriesV2Calibration({ env, logger, fetchImpl });
    }
    if (['SHOT_PACK_DESIGN','SHOT_PACK_PREFLIGHT'].includes(action)) {
      const { runThirdShotPackDesign } = await import('./lumi-third-shot-pack-design-v1.js');
      return runThirdShotPackDesign({env,logger,freshPreflight:action==='SHOT_PACK_PREFLIGHT'});
    }
    if (action === "USD_QUOTE") {
      const { runHiggsfieldUsdPreflight } = await import('./lumi-higgsfield-usd-preflight-v1.js');
      return runHiggsfieldUsdPreflight({ env, fetchImpl, logger });
    }

    if(action==='SHOT_PACK_PAUSE'){
      const {createClient}=await import("@supabase/supabase-js");
      const {LumiRecoveryIncidentManager,SupabaseLumiRecoveryStore}=await import("./lumi-recovery-incident-manager-v1.js");
      const supabase=createClient(env.SUPABASE_URL,env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false}});
      const manager=new LumiRecoveryIncidentManager({store:new SupabaseLumiRecoveryStore(supabase)});
      const state=await manager.store.getEpisode("ep_lumi_flores_003");
      if(state.active_incident_id)return {status:"PAUSED_INCIDENT",provider_calls:0,cache_hit:true};
      const qaBindingFailure=env.LUMI_SHOT_PACK_PAUSE_QA_BINDING==="true";
      if(qaBindingFailure && state.first_pending_action!=="temporal_qa:q31")throw new Error("qa_binding_incident_checkpoint_mismatch");
      const incident=await manager.pause({episodeId:"ep_lumi_flores_003",sceneId:"q31",stage:qaBindingFailure?"TEMPORAL_QA_HANDOFF":"VIDEO_PREFLIGHT",errorClass:"UNEXPECTED_RUNTIME_ERROR",reason:qaBindingFailure?"TEMPORAL_QA_SHA_BINDING_NOT_FORWARDED: q31 artifact decoded and human-model frame review passed; canonical endpoint dropped sha256 before the artifact binding validator. QA handoff failed HTTP 400; q32 was never emitted. Endpoint repair prepared; providers remain stopped.":"JSONB_OBJECT_KEY_ORDER_FALSE_FULL_HD_MASTER_LOCK: installed pack validation failed before any VIDEO claim, journal or provider request. Field-wise validation repair is implemented; execution remains stopped for this incident.",firstPendingAction:qaBindingFailure?"temporal_qa:q31":"video:q31",safeResumeAvailable:true,retryability:"DETERMINISTIC_REPAIR_READY_NO_PROVIDER_CONTINUATION",costLostAvoidable:true});
      if(qaBindingFailure)await manager.checkpoint("ep_lumi_flores_003",draft=>{
        draft.metadata.telegram_notification={classification:"NOTIFICATION_DELIVERY_DEGRADED",status:"TELEGRAM_NOTIFICATION_PENDING",message_id:134,reason:"Existing Make edit path requires approval unavailable in this runtime; no new message or approval bypass."};
        draft.metadata.q31_local_temporal_review={classification:"PASS",sha256:env.LUMI_SHOT_PACK_QA_SHA256,ffprobe:"PASS",decode:"PASS",black_frames:0,freeze_segments:0,anatomy:"PASS",educational_semantics:"PASS",natural_1x:"PASS",sampled_frames:16,provider_repairs:0,local_repairs:0};
      });
      logger.info(JSON.stringify({event:"lumi_shot_pack_incident_paused",incident,provider_calls:0,status:"PAUSED_INCIDENT"}));
      return {status:"PAUSED_INCIDENT",incident,provider_calls:0};
    }
    const token = String(env.RENDER_API_TOKEN || env.ADMIN_API_TOKEN || "");
    if (!token) throw new Error("third_short_boot_auth_token_missing");

    if(['SHOT_PACK_START','SHOT_PACK_QA_NEXT','SHOT_PACK_STATUS'].includes(action)){
      const call=async(method,path,body)=>{
        const response=await fetchImpl("http://127.0.0.1:"+Number(port)+path,{method,headers:{"content-type":"application/json","x-render-token":token},...(body?{body:JSON.stringify(body)}:{})});
        const payload=await response.json();
        if(!response.ok)throw new Error("shot_pack_boot_http_"+response.status+":"+String(payload.error||payload.status||"unknown"));
        logger.info(JSON.stringify({event:"lumi_shot_pack_boot",action,path,result:payload}));return payload;
      };
      const prefix="/lumi-pipeline/v1_1_2/episodes/third/";
      if(action==='SHOT_PACK_STATUS')return call("GET",prefix+"media?review=1");
      if(action==='SHOT_PACK_START'){
        const resumed=await call("POST",prefix+"resume",{cost_optimized_asset_replan:true});
        if(resumed.status!=="RUNNING")return resumed;
      }else{
        const qa=JSON.parse(env.LUMI_SHOT_PACK_QA_JSON||"null");
        if(!qa?.sha256 || !qa.scene_id)throw new Error("shot_pack_qa_evidence_required");
        const result=await call("POST",prefix+"temporal-qa",qa);
        if(result.status==='PAUSED_INCIDENT'||result.status==='VISUALS_COMPLETE_VOICE_REVIEW_PENDING')return result;
      }
      return call("POST",prefix+"videos",{});
    }
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
