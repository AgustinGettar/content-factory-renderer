
import {createClient} from "@supabase/supabase-js";
import {readFile,mkdtemp,writeFile,rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {LumiRecoveryIncidentManager,SupabaseLumiRecoveryStore,verifyArtifact,isStageComplete} from "./lumi-recovery-incident-manager-v1.js";
import {runThirdShotPackDesign,shotPackPrompt} from "./lumi-third-shot-pack-design-v1.js";
import {estimateHiggsfieldUsd,sumUsd,usd} from "./higgsfield-usd-budget-v1.js";
import {validateThirdShotPack,SHOT_PACK_EPISODE} from "./lumi-third-shot-pack-v1.js";
import {THIRD_SHORT_MEDIA} from "./lumi-third-short-media-v1.js";
import {providerJson,pollRequest,sha256,uploadObject,GENERATIVE_VIDEO_BUCKET,ensureBucket} from "./generative-video-benchmark-v1.js";
import {journaledFetch,SupabaseEmissionStore} from "./provider-emission-journal-v1.js";

const exec=promisify(execFile);
const evidence={provider_succeeded:true,artifact_persisted:true,sha_verified:true,artifact_verified:true};
export async function shotPackRuntimeReadiness(){
  for(const binary of ["ffprobe","ffmpeg"])await exec(binary,["-version"],{timeout:10000,maxBuffer:100000});
  return {status:"PASS",ffprobe:"AVAILABLE",ffmpeg:"AVAILABLE"};
}
async function videoRows(supabase){
  const {data,error}=await supabase.from("lumi_pilot_runs").select("*").eq("pilot_id",THIRD_SHORT_MEDIA.pilotId).eq("stage","VIDEO");
  if(error)throw new Error("shot_pack_video_rows_failed");return data||[];
}
async function patch(supabase,id,value){
  const {data,error}=await supabase.from("lumi_pilot_runs").update({...value,updated_at:new Date().toISOString()}).eq("id",id).select("*").single();
  if(error)throw new Error("shot_pack_video_persistence_failed");return data;
}
async function sign(supabase,path){
  const {data,error}=await supabase.storage.from(GENERATIVE_VIDEO_BUCKET).createSignedUrl(path,7200);
  if(error)throw new Error("shot_pack_review_sign_failed");return data.signedUrl;
}
export async function runThirdShotPackVideos({supabase,higgsfieldApiKey}){
  const manager=new LumiRecoveryIncidentManager({store:new SupabaseLumiRecoveryStore(supabase)});
  let checkpoint=await manager.store.getEpisode(SHOT_PACK_EPISODE);
  if(checkpoint?.status!=="RUNNING" || checkpoint.active_incident_id)throw new Error("episode_paused_no_emission");
  const pack=checkpoint.metadata?.visual_shot_pack;
  if(!pack)throw new Error("shot_pack_not_installed");
  const plan=JSON.parse(await readFile(new URL("../episodes/ep_lumi_flores_003/EPISODE_PLAN_V2.json",import.meta.url),"utf8"));
  if(validateThirdShotPack(pack,plan,{requireSourceQa:true}).status!=="PASS")throw new Error("installed_pack_invalid");
  const all=await videoRows(supabase);
  const prior=all.filter(r=>pack.shots.some(s=>s.id===r.scene_id));
  if(prior.some(r=>r.status==="FAILED"))throw new Error("shot_pack_incident_preserved");
  const pending=checkpoint.actions.find(a=>!isStageComplete(a));
  if(pending?.stage==="TEMPORAL_QA")return {status:"AWAITING_TEMPORAL_QA",shot_id:pending.scene_id,provider_calls:0};
  if(pending?.key==="visual_assembly_gate")return completeVisualGate({supabase,manager,pack});
  if(pending?.stage!=="VIDEO")return {status:"VOICE_REVIEW_PENDING",provider_calls:0};
  const shot=pack.shots.find(s=>s.id===pending.scene_id);
  if(!shot)throw new Error("pending_shot_missing");
  const existing=all.find(r=>r.scene_id===shot.id);
  if(existing)return {status:"EXISTING_REQUEST_REQUIRES_INSPECTION",shot_id:shot.id,job_id:existing.provider_request_id,provider_calls:0};
  let row=null,requestId=null,reserved=false,quote=null;
  try{
    await shotPackRuntimeReadiness();
    const report=await runThirdShotPackDesign({freshPreflight:true});
    const src=report.review.find(s=>s.scene_id===shot.source_scene);
    const input={...shot.input,prompt:shotPackPrompt(shot),image_url:src.review_url};
    quote=await estimateHiggsfieldUsd({apiKey:higgsfieldApiKey,model:shot.model,input});
    // Price every not-yet-emitted shot using fresh quotes; completed/failed requests remain accounted.
    const remaining=pack.shots.filter(s=>!prior.some(r=>r.scene_id===s.id)).map(s=>s.id===shot.id?quote.estimated_cost_usd:report.quotes.find(q=>q.shot_id===s.id)?.estimated_cost_usd);
    const projected=sumUsd([checkpoint.current_cost_usd,...remaining]);
    if(projected>2.55){
      const incident=await manager.pause({episodeId:SHOT_PACK_EPISODE,sceneId:shot.id,stage:"VIDEO",errorClass:"BUDGET_EXHAUSTED",reason:"Projected visual total USD "+projected+" exceeds 2.55 before emission.",firstPendingAction:pending.key,safeResumeAvailable:true});
      console.info(JSON.stringify({event:"lumi_shot_pack_incident",incident,provider_calls:0}));return {status:"PAUSED_INCIDENT",incident,provider_calls:0};
    }
    const gate=await manager.budgetGate({episodeId:SHOT_PACK_EPISODE,actionKey:pending.key,projectedCallCostUsd:quote.estimated_cost_usd});
    if(gate.status!=="PASS")return {status:"PAUSED_INCIDENT",incident:gate.incident,provider_calls:0};
    await ensureBucket(supabase);
    const {data:claimed,error}=await supabase.from("lumi_pilot_runs").insert({pilot_id:THIRD_SHORT_MEDIA.pilotId,scene_id:shot.id,stage:"VIDEO",status:"CLAIMED",provider_calls:0,estimated_cost_usd:quote.estimated_cost_usd,claimed_at:new Date().toISOString(),updated_at:new Date().toISOString()}).select("*").single();
    if(error)throw new Error("shot_pack_unique_claim_failed");row=claimed;
    const base={shot_id:shot.id,covered_beats:shot.covered_beats,duration_seconds:shot.duration_seconds,source_hash:shot.source_sha256,prompt_hash:sha256(input.prompt),cost_quote:quote,actual_cost_usd:null};
    await patch(supabase,row.id,{status:"REQUESTED",provider:"higgsfield",result:{...base,dispatch_state:"REQUESTED"}});
    const accepted=await providerJson("https://api.higgsfield.ai/"+shot.model,{apiKey:higgsfieldApiKey,method:"POST",body:input,fetchImpl:journaledFetch({store:new SupabaseEmissionStore(supabase),context:{episode_id:SHOT_PACK_EPISODE,scene_id:shot.id,stage:"VIDEO",attempt_id:row.id,provider:"higgsfield",model:shot.model,expected_cost_usd:quote.estimated_cost_usd,prompt:input.prompt}})});
    requestId=accepted.request_id;
    if(!requestId || !accepted.status_url)throw new Error("shot_pack_provider_handle_missing");
    // The emission journal already holds the acknowledgment; persist the job to both checkpoint and ledger immediately.
    await manager.recordRequest(SHOT_PACK_EPISODE,pending.key,requestId);
    await patch(supabase,row.id,{status:"REQUESTED",provider_calls:1,provider_request_id:requestId,result:{...base,job_id:requestId,status_url:accepted.status_url,dispatch_state:"SUBMITTED"}});
    await manager.checkpoint(SHOT_PACK_EPISODE,draft=>{draft.current_cost_usd=sumUsd([draft.current_cost_usd,quote.estimated_cost_usd]);draft.metadata.visual_accounting_basis="API_ESTIMATE_PENDING_RECONCILIATION";});
    reserved=true;
    console.info(JSON.stringify({event:"lumi_shot_pack_submitted",shot_id:shot.id,job_id:requestId,duration:shot.duration_seconds,estimated_cost_usd:quote.estimated_cost_usd,covered_beats:shot.covered_beats}));
    const terminal=await pollRequest({apiKey:higgsfieldApiKey,statusUrl:accepted.status_url,onStatus:async()=>{}});
    if(terminal.status!=="completed" || !terminal.video?.url)throw new Error("shot_pack_terminal_"+terminal.status);
    const response=await fetch(terminal.video.url);
    if(!response.ok)throw new Error("shot_pack_output_download_failed");
    const bytes=Buffer.from(await response.arrayBuffer()),hash=sha256(bytes);
    const path=THIRD_SHORT_MEDIA.prefix+"/shot-pack/"+shot.id+"/"+hash+"/original.mp4";
    await uploadObject(supabase,path,bytes,"video/mp4",false);
    const stored=await supabase.storage.from(GENERATIVE_VIDEO_BUCKET).download(path);
    if(stored.error || !stored.data)throw new Error("shot_pack_storage_download_failed");
    const persisted=Buffer.from(await stored.data.arrayBuffer());
    const dir=await mkdtemp(join(tmpdir(),"lumi-shot-")),file=join(dir,"video.mp4");
    let verification;
    try{await writeFile(file,persisted);verification=await verifyArtifact({type:"VIDEO",filePath:file,expectedSha256:hash});}finally{await rm(dir,{recursive:true,force:true});}
    if(!verification.ok)throw new Error(verification.error_class||"shot_pack_artifact_invalid");
    if(Math.abs(verification.duration-shot.duration_seconds)>0.12)throw new Error("shot_pack_duration_mismatch");
    const actual=terminal.actual_cost_usd??terminal.cost?.usd??null;
    const actualUsd=actual===null?null:usd(actual);
    const result={...base,job_id:requestId,actual_cost_usd:actualUsd,accounting_basis:actualUsd===null?"API_ESTIMATE_PENDING_RECONCILIATION":"PROVIDER_EXPOSED_USD",verification,output_hash:hash,storage_bucket:GENERATIVE_VIDEO_BUCKET,storage_path:path,temporal_qa:{classification:"PENDING"},measured_duration_seconds:verification.duration};
    await patch(supabase,row.id,{status:"SUCCEEDED",provider_calls:1,provider_request_id:requestId,content_hash:hash,storage_bucket:GENERATIVE_VIDEO_BUCKET,storage_path:path,artifact_reference:path,completed_at:new Date().toISOString(),result});
    if(actualUsd!==null)await manager.checkpoint(SHOT_PACK_EPISODE,draft=>{draft.current_cost_usd=Number((draft.current_cost_usd-quote.estimated_cost_usd+actualUsd).toFixed(9));});
    await manager.completeAction(SHOT_PACK_EPISODE,pending.key,{artifact:{bucket:GENERATIVE_VIDEO_BUCKET,path,sha256:hash},evidence,actualCostUsd:0});
    const output={event:"lumi_shot_pack_output",status:"AWAITING_TEMPORAL_QA",shot_id:shot.id,job_id:requestId,sha256:hash,review_url:await sign(supabase,path),...result};
    console.info(JSON.stringify(output));return output;
  }catch(error){
    if(row)await patch(supabase,row.id,{status:"FAILED",provider_calls:requestId?1:0,provider_request_id:requestId,error_code:error.message});
    const incident=await manager.pause({episodeId:SHOT_PACK_EPISODE,sceneId:shot.id,stage:"VIDEO",errorClass:"PROVIDER_API_FAILURE",reason:error.message,providerRequestId:requestId,firstPendingAction:pending.key,safeResumeAvailable:false});
    console.info(JSON.stringify({event:"lumi_shot_pack_incident",incident,provider_calls:requestId?1:0,reserved_cost:reserved?quote.estimated_cost_usd:0}));
    return {status:"PAUSED_INCIDENT",incident};
  }
}
// Recover only the proven q31 local QA handoff; never submit or rename a provider request.
export async function resumeQ31QaMetadata({supabase,manager,expectedSha256,classification,findings=[],verify=verifyArtifact}){
  const state=await manager.store.getEpisode(SHOT_PACK_EPISODE);
  const incident=state?.active_incident_id?await manager.store.getIncident(state.active_incident_id):null;
  if(state?.status!=="PAUSED_INCIDENT" || state.first_pending_action!=="temporal_qa:q31"
    || incident?.status!=="OPEN" || incident.scene_id!=="q31" || incident.stage!=="TEMPORAL_QA_HANDOFF"
    || !incident.reason?.startsWith("TEMPORAL_QA_SHA_BINDING_NOT_FORWARDED") || classification!=="PASS")
    throw new Error("q31_qa_recovery_incident_mismatch");
  const row=(await videoRows(supabase)).find(r=>r.scene_id==="q31");
  const videoAction=state.actions.find(a=>a.key==="video:q31");
  if(!row || row.status!=="SUCCEEDED" || !row.provider_request_id || !isStageComplete(videoAction)
    || videoAction.provider_request_id!==row.provider_request_id || !expectedSha256
    || row.content_hash!==expectedSha256 || videoAction.artifact?.sha256!==expectedSha256)
    throw new Error("q31_qa_recovery_artifact_binding_failed");
  const {data:journal,error}=await supabase.from("lumi_provider_emission_journal").select("*")
    .eq("episode_id",SHOT_PACK_EPISODE).eq("stage","VIDEO");
  if(error || !Array.isArray(journal) || journal.length!==1 || journal[0].scene_id!=="q31"
    || journal[0].state!=="ACKNOWLEDGED" || journal[0].provider_request_id!==row.provider_request_id)
    throw new Error("q31_qa_recovery_journal_binding_failed");
  const stored=await supabase.storage.from(row.storage_bucket).download(row.storage_path);
  if(stored.error || !stored.data)throw new Error("q31_qa_recovery_download_failed");
  const dir=await mkdtemp(join(tmpdir(),"lumi-q31-recover-")),file=join(dir,"original.mp4");
  let verification;
  try{
    await writeFile(file,Buffer.from(await stored.data.arrayBuffer()));
    verification=await verify({type:"VIDEO",filePath:file,expectedSha256});
  }finally{await rm(dir,{recursive:true,force:true});}
  if(!verification.ok || verification.sha256!==expectedSha256 || verification.decode!=="PASS"
    || Math.abs(verification.duration-4)>0.12 || verification.scan?.blackFrames!==0 || verification.scan?.freezes!==0)
    throw new Error("q31_qa_recovery_verification_failed");
  return manager.resume(SHOT_PACK_EPISODE,{continueAction:async(action,proof)=>{
    if(action.key!=="temporal_qa:q31" || !proof.recoveryInspectionComplete)throw new Error("q31_qa_recovery_checkpoint_mismatch");
    await patch(supabase,row.id,{result:{...row.result,temporal_qa:{classification,findings,reviewed_at:new Date().toISOString(),sha256:expectedSha256,
      verification,requested_duration_seconds:4},cost_status:row.result?.actual_cost_usd==null?"ESTIMATED_PENDING_RECONCILIATION":"ACTUAL_CONFIRMED"}});
    await manager.completeAction(SHOT_PACK_EPISODE,action.key,{artifact:{sha256:expectedSha256,classification},evidence,actualCostUsd:0});
    return {incident_resolution:"RESOLVED_LOCAL_METADATA_PERSISTENCE",artifact_id_path:row.storage_path};
  }});
}
export async function recordShotPackTemporalQa({supabase,sceneId,classification,findings=[],expectedSha256}){
  const manager=new LumiRecoveryIncidentManager({store:new SupabaseLumiRecoveryStore(supabase)});
  const state=await manager.store.getEpisode(SHOT_PACK_EPISODE),pack=state?.metadata?.visual_shot_pack;
  if(!pack?.shots.some(s=>s.id===sceneId) || !["PASS","PASS_WITH_WARNING","BLOCKER"].includes(classification))throw new Error("shot_pack_qa_invalid");
  const row=(await videoRows(supabase)).find(r=>r.scene_id===sceneId);
  if(!row || row.status!=="SUCCEEDED" || !expectedSha256 || expectedSha256!==row.content_hash)throw new Error("shot_pack_qa_artifact_binding_required");
  if(state.status==="PAUSED_INCIDENT" && sceneId==="q31"){
    const resumed=await resumeQ31QaMetadata({supabase,manager,expectedSha256,classification,findings});
    return {status:"PASS",shot_id:sceneId,provider_calls:0,recovery:resumed};
  }
  if(state.status!=="RUNNING" || state.active_incident_id)throw new Error("episode_paused_no_qa_continuation");
  if(state.first_pending_action!=="temporal_qa:"+sceneId)throw new Error("serial_qa_order_required");
  await patch(supabase,row.id,{result:{...row.result,temporal_qa:{classification,findings,reviewed_at:new Date().toISOString(),sha256:expectedSha256}}});
  if(classification==="BLOCKER"){
    const incident=await manager.pause({episodeId:SHOT_PACK_EPISODE,sceneId,stage:"TEMPORAL_QA",errorClass:"QA_BLOCKER",reason:findings.join("; "),providerRequestId:row.provider_request_id,firstPendingAction:"temporal_qa:"+sceneId,safeResumeAvailable:true});
    console.info(JSON.stringify({event:"lumi_shot_pack_incident",incident}));return {status:"PAUSED_INCIDENT",incident};
  }
  await manager.completeAction(SHOT_PACK_EPISODE,"temporal_qa:"+sceneId,{artifact:{sha256:expectedSha256,classification},evidence,actualCostUsd:0});
  if(sceneId===pack.shots.at(-1).id)return completeVisualGate({supabase,manager,pack});
  return {status:classification,shot_id:sceneId,provider_calls:0};
}
async function completeVisualGate({supabase,manager,pack}){
  const all=await videoRows(supabase);
  if(!pack.shots.every(s=>all.some(r=>r.scene_id===s.id&&r.status==="SUCCEEDED"&&["PASS","PASS_WITH_WARNING"].includes(r.result?.temporal_qa?.classification))))throw new Error("six_usable_shots_required");
  if(pack.beats.length!==9)throw new Error("nine_beats_required");
  const state=await manager.store.getEpisode(SHOT_PACK_EPISODE);
  if(!isStageComplete(state.actions.find(a=>a.key==="visual_assembly_gate")))await manager.completeAction(SHOT_PACK_EPISODE,"visual_assembly_gate",{artifact:{shots:6,beats:9,pack_sha256:pack.pack_sha256},evidence,actualCostUsd:0});
  const updated=await manager.store.getEpisode(SHOT_PACK_EPISODE);
  const result={event:"lumi_shot_pack_visual_complete",status:"VISUALS_COMPLETE_VOICE_REVIEW_PENDING",VISUAL_ASSEMBLY_READY:"PASS",ASSEMBLY:"9/9",VISUAL_SHOTS:"6/6",cost_usd:updated.current_cost_usd,remaining_episode_budget_usd:Number((3.05-updated.current_cost_usd).toFixed(9)),provider_calls:0};
  console.info(JSON.stringify(result));return result;
}
