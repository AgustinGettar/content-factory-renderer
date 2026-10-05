import {LumiRecoveryIncidentManager,SupabaseLumiRecoveryStore} from '../lumi-recovery-incident-manager-v1.js';
import {V2,STYLE} from '../lumi-series-v2-continuation.js';
import {runLumiV2Step} from '../lumi-series-v2-execution.js';
import {stepIdentity,sourceGate,previousVideoGate} from '../lumi-series-v2-gates.js';
import {sha256,stableStringify} from './PROMPT_COMPILER_V3.mjs';
import {TOPOLOGY} from './topology.js';
import {ACTING_PRESETS,GRAMMAR_PRESET,PRESENT_OBJECT_SAFE_POLICY} from './acting-presets.js';
import {projectCinematicPrompt} from './projection.js';
import {TEMPORAL_TOPOLOGY_VERSION,evaluateTemporalTopology} from './temporal-topology-qa-v2.js';

export function compileRemainingRequest({shot,stage,input,sourceSha,sourceQa}){
 if(!['q34','q35','q36'].includes(shot)||!['IMAGE','VIDEO'].includes(stage)||! /^[a-f0-9]{64}$/.test(sourceSha))throw new Error('DIRECTOR_REMAINING_SHOT_SCOPE_REQUIRED');
 const duration=shot==='q34'?4:5,grammar={q34:'PRESENT_FLOWER',q35:'ATTENTIVE_WAIT',q36:'FAREWELL'}[shot];
 const direction={principal_actions:[{grammar,target:shot==='q34'?'flower_blue':'viewer',body_part:'character_left_forearm',
   timing:{preparation:0.5,gesture:shot==='q34'?2.5:3.5,settle:1,response_window:shot==='q35'?2.5:0}}],
   secondary_motion:['blink'],camera:{type:'STATIC'}};
 if(stage==='VIDEO'){
   if(sourceQa?.sha256!==sourceSha||sourceQa?.classification!=='PASS_WITH_MINOR_WARNING'&&sourceQa?.classification!=='PASS')throw new Error('DIRECTOR_EXACT_SOURCE_QA_REQUIRED');
   sourceGate({sha256:sourceSha},{content_hash:sourceSha,result:{visual_qa:sourceQa}});
   if(input.duration!==duration||input.sound!=='off'||input.multi_shots!==false||input.cfg_scale!==0.5)throw new Error('DIRECTOR_PROVIDER_CONTRACT_MISMATCH');
 }
 const projection=stage==='VIDEO'?projectCinematicPrompt({contract:{shot_type:shot==='q35'?'QUESTION_TO_VIEWER':'MEDIUM_TEACHING',DURATION:duration},direction}):null;
 const providerInput={...input,prompt:stage==='VIDEO'?STYLE+'\n'+projection.text:input.prompt};
 const {image_url,image_urls,...safeInput}=providerInput;
 const packet={version:'LUMI_CINEMATIC_DIRECTOR_V1',episode_id:V2.episode,shot,stage,
   authority:'USER_20261005_EPISODE_COMPLETION',acting_preset:GRAMMAR_PRESET[grammar],acting_policy:ACTING_PRESETS[GRAMMAR_PRESET[grammar]],
   allowed_motion:{blink:'NATURAL',eye_tracking:'SMALL',head:'SMALL_SOURCE_SUPPORTED',principal_gestures:1,
     torso_rotation:'PRESERVE_INITIAL',body_yaw:'PRESERVE_INITIAL',wing_response:'MINIMAL',settle:'NATURAL_1X'},
   forbidden_motion:['BODY_TURN','REAR_FACING','TORSO_TWIST','LARGE_WING_FLUTTER','CAMERA_ORBIT','CARTOON_BOUNCE','SLOW_MOTION','DREAMY_FLOATING'],
   presentation_policy:shot==='q34'?PRESENT_OBJECT_SAFE_POLICY:null,camera_contract:'STATIC',topology_constraints:TOPOLOGY,
   quality_profile:{id:'LUMI_VIDEO_QUALITY_PROFILE_V2',canonical_source_sha256:V2.sourceSha,golden:'q31-PRO2',golden_scope:'GREETING; render quality QA only'},
   source_contract:{sha256:sourceSha,identity_authority:V2.sourceSha,quality_profile:'LUMI_IMAGE_QUALITY_PROFILE_V2',first_frame_authority:true,canonical_wing_assemblies:2},
   end_state_contract:shot==='q35'?'Front-facing attentive neutral listening; no answer cue; natural settle and subtle life during the 2.5-second response window.':'Front-facing warm smile after one small farewell wave; hands settle naturally; three flowers unchanged.',
   source_sha256:sourceSha,provider_projection:{model:stage==='IMAGE'?V2.imageModel:V2.videoModel,fields:safeInput,
     input_binding:{sha256:sourceSha,role:stage==='IMAGE'?'IDENTITY_STYLE_ANCHOR':'START_FRAME'},UNKNOWN_AND_EMITTED:0},
   temporal_qa_plan:{decode:true,black_frames:0,freeze_defects:0,topology:'ALL_FRAME_RISK_WINDOW_REVIEW',topology_version:TEMPORAL_TOPOLOGY_VERSION,
     quality_parity_with_q31_pro2:['PASS','PASS_WITH_MINOR_WARNING'],pause_seconds:shot==='q35'?2.5:0,
     no_answer_cue:shot==='q35',retries:0,variants:0,resubmits:0},count:1,retries:0,variants:0,resubmits:0};
 const keys=Object.keys(safeInput).sort();
 const allowed=stage==='VIDEO'?['cfg_scale','duration','multi_shots','prompt','sound']:['aspect_ratio','enhance_prompt','moderation','prompt','quality','resolution'];
 if(stableStringify(keys)!==stableStringify(allowed))throw new Error('DIRECTOR_UNSUPPORTED_PROVIDER_FIELDS');
 packet.sha256=sha256(stableStringify(packet));return {packet,providerInput};
}

export async function runDirectedEpisodeStep({env,fetchImpl=fetch,logger=console}){
 if(env.LUMI_RUNTIME_ENV!=='staging'||env.LUMI_DIRECTOR_EPISODE_COMPLETION!==V2.episode)throw new Error('DIRECTOR_COMPLETION_STAGING_REQUIRED');
 if(env.PROVIDER_CALLS_ALLOWED!=='1')throw new Error('DIRECTOR_EXPLICIT_SINGLE_PROVIDER_WINDOW_REQUIRED');
 const step=JSON.parse(env.LUMI_SERIES_V2_STEP||'null');
 if(!['q34','q35','q36'].includes(step?.shot)||!['IMAGE','VIDEO'].includes(step.stage))throw new Error('DIRECTOR_Q31_Q32_Q33_EMISSION_FORBIDDEN');
 const {createClient}=await import('@supabase/supabase-js');
 const db=createClient(env.SUPABASE_URL,env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false}}),storage=db.storage.from(V2.bucket);
 const {CALIBRATION_PATH}=await import('./topology-calibration.js');
 const calibrationFile=await storage.download(CALIBRATION_PATH);
 if(calibrationFile.error)throw new Error('DIRECTOR_TOPOLOGY_CALIBRATION_REQUIRED');
 const calibration=JSON.parse(await calibrationFile.data.text());
 if(calibration.status!=='PASS'||calibration.FALSE_FATALS_ON_HUMAN_APPROVED_SET!==0||calibration.TRUE_FATAL_FIXTURES_BLOCKED!=='100_PERCENT'||calibration.AMBIGUOUS_FINDINGS_PRESERVED!==true||calibration.HUMAN_REVIEW_PROVENANCE_PRESERVED!==true||calibration.provider_calls!==0)throw new Error('DIRECTOR_TOPOLOGY_CALIBRATION_NOT_READY');
 const replay=await storage.download('lumi-series-v2/ep_lumi_flores_003/director-human-assembly-20261005/replay.json');
 if(replay.error)throw new Error('DIRECTOR_STAGING_REPLAY_REQUIRED');
 const report=JSON.parse(await replay.data.text());
 if(report.status!=='PASS'||report.provider_calls!==0||report.results.length!==3||!report.results.every(r=>r.assembly_eligible&&r.HUMAN_REVIEW_PROVENANCE==='PASS'))throw new Error('DIRECTOR_AUTHENTIC_ASSEMBLY_APPROVAL_REQUIRED');
 const rowFor=async(scene,stage)=>{const r=await db.from('lumi_pilot_runs').select('*').eq('pilot_id',V2.pilot).eq('scene_id',scene).eq('stage',stage).single();if(r.error)throw new Error('DIRECTOR_LEDGER_REQUIRED:'+scene);return r.data;};
 const manager=new LumiRecoveryIncidentManager({store:new SupabaseLumiRecoveryStore(db)});
 const state=await manager.store.getEpisode(V2.episode);
 if(!state||state.status!=='RUNNING'||state.active_incident_id||state.runner_enabled)throw new Error('DIRECTOR_RECOVERY_RUNNING_SERIAL_CHECKPOINT_REQUIRED');
 if(['q35','q36'].includes(step.shot)){
  const alias=step.shot==='q35'?'q37':'q39';
  if(!['video:'+alias,'temporal_qa:'+alias].includes(state.first_pending_action))throw new Error('DIRECTOR_SERIAL_RECOVERY_ACTION_REQUIRED');
 }
 const originals={s35:'6ae868575d242eb15c1fb454337bf5657a65c05d78c5281207e42c94273eb213',s36:'e65b466aeb0d41148bdde4a017daa3c49bba26e45eae3cbe9b3c24c1a6011671'};
 for(const [scene,sha] of Object.entries(originals)){
  const original=await rowFor(scene,'IMAGE');
  if(original.content_hash!==sha)throw new Error('DIRECTOR_LEGACY_SOURCE_HASH_CHANGED');
  if(original.result?.SOURCE_STYLE_PROFILE==='LEGACY_ILLUSTRATED'&&original.result?.VIDEO_ELIGIBLE===false)continue;
  const r=await db.from('lumi_pilot_runs').update({result:{...original.result,SOURCE_STYLE_PROFILE:'LEGACY_ILLUSTRATED',VIDEO_ELIGIBLE:false,source_audit:{reason:'Actual original bytes inspected against canonical V2 and q31-PRO2; legacy illustration. Preserve historical artifact.',sha256:sha,at:'2026-10-05T22:26:00Z'}}}).eq('id',original.id).eq('content_hash',sha);
  if(r.error)throw new Error('DIRECTOR_LEGACY_SOURCE_AUDIT_PERSIST_FAILED');
 }
 const review=JSON.parse(env.LUMI_DIRECTOR_QA_RECORD_JSON||'null');
 if(review){
   const row=await rowFor(review.attempt,review.stage);
   if(row.content_hash!==review.sha256||row.status!=='SUCCEEDED'||!['IMAGE','VIDEO'].includes(review.stage))throw new Error('DIRECTOR_QA_EXACT_ARTIFACT_REQUIRED');
   if(review.attempt!==stepIdentity(step.shot,review.stage))throw new Error('DIRECTOR_QA_STEP_SCOPE_REQUIRED');
   const reviewed={...row,result:{...row.result,[review.stage==='IMAGE'?'visual_qa':'temporal_qa']:review.qa}};
   let blocker=null;
   if(review.stage==='VIDEO') {
    if(review.qa.TEMPORAL_TOPOLOGY_VERSION!==TEMPORAL_TOPOLOGY_VERSION)throw new Error('DIRECTOR_CALIBRATED_TEMPORAL_QA_REQUIRED');
    const topology=evaluateTemporalTopology({sha256:row.content_hash,review:review.qa.temporal_topology_review});
    review.qa.calibrated_topology=topology;
   }
   try{if(review.stage==='IMAGE')sourceGate({sha256:row.content_hash},reviewed);else previousVideoGate(reviewed);}catch(error){blocker=error;}
   const result={...reviewed.result,...(review.stage==='VIDEO'&&!blocker?{assembly_eligible:true,golden_reference:false}:{})};
   const u=await db.from('lumi_pilot_runs').update({result}).eq('id',row.id).eq('content_hash',review.sha256).select('content_hash').single();
   if(u.error)throw new Error('DIRECTOR_QA_PERSIST_FAILED');
   if(blocker){
    const uncertain=review.qa.calibrated_topology?.severity==='REVIEW_REQUIRED';
    await manager.pause({episodeId:V2.episode,sceneId:review.attempt,stage:review.stage==='IMAGE'?'SOURCE_QA':'TEMPORAL_QA',errorClass:'QA_BLOCKER',reason:JSON.stringify(review.qa),providerRequestId:row.provider_request_id,artifact:row.storage_path,firstPendingAction:state.first_pending_action,retryability:uncertain?'HUMAN_REVIEW_REQUIRED_NO_AUTOMATIC_REGENERATION':'GENERATIVE_FATAL_NO_AUTOMATIC_PAID_REPAIR',safeResumeAvailable:false});
    logger.info(JSON.stringify({event:'lumi_director_quality_gate_paused',attempt:review.attempt,sha256:review.sha256,provider_calls:0,reason:blocker.message}));
    return {status:uncertain?'HUMAN_REVIEW_PENDING':'QUALITY_GATE_PAUSED',provider_calls:0};
   }
   if(review.stage==='VIDEO'){
    const alias=step.shot==='q35'?'q37':'q39';
    await manager.completeAction(V2.episode,'temporal_qa:'+alias,{artifact:{attempt:review.attempt,sha256:review.sha256,qa:review.qa},evidence:{provider_succeeded:true,artifact_persisted:true,sha_verified:true,artifact_verified:true},actualCostUsd:0});
    await manager.checkpoint(V2.episode,d=>{d.metadata.approved_visuals_current_episode={...d.metadata.approved_visuals_current_episode,[step.shot]:{attempt:review.attempt,sha256:review.sha256,request_id:row.provider_request_id,assembly_eligible:true,golden_reference:false}};});
    logger.info(JSON.stringify({event:'lumi_director_temporal_qa_completed',attempt:review.attempt,sha256:review.sha256,first_pending_action:(await manager.store.getEpisode(V2.episode)).first_pending_action,provider_calls:0}));
    return {status:'QA_COMPLETE',provider_calls:0};
   }
   if(step.stage==='IMAGE')return {status:'SOURCE_QA_COMPLETE',provider_calls:0};
 }
 const spent=await db.from('lumi_pilot_runs').select('estimated_cost_usd,scene_id').eq('pilot_id',V2.pilot).in('scene_id',['q32-SOURCE-V2-1','q32-V2-PRO1','q33-SOURCE-V2-1','q33-V2-PRO1']);
 if(spent.error||spent.data.length!==4)throw new Error('DIRECTOR_CHECKPOINT_SPEND_REQUIRED');
 const prior=Number(spent.data.reduce((n,r)=>n+Number(r.estimated_cost_usd),0).toFixed(6));
 const cp=await db.from('lumi_pipeline_checkpoints').select('metadata').eq('episode_id',V2.episode).single();if(cp.error)throw new Error('DIRECTOR_CHECKPOINT_REQUIRED');
 const metadata={...cp.data.metadata,series_v2_continuation_budget:{...cp.data.metadata.series_v2_continuation_budget,
   current_episode_completion:{authorization:'USER_20261005_EPISODE_COMPLETION',episode_id:V2.episode,additional_visual_ceiling_usd:3,previous_checkpoint_spend_usd:prior}}};
 const up=await db.from('lumi_pipeline_checkpoints').update({metadata}).eq('episode_id',V2.episode);if(up.error)throw new Error('DIRECTOR_ADDITIONAL_BUDGET_WRITE_FAILED');
 const result=await runLumiV2Step({env:{...env,LUMI_CINEMATIC_DIRECTOR_V1:'false',LUMI_DIRECTOR_REQUEST_COMPILATION:'USER_20261005_EPISODE_COMPLETION'},fetchImpl,logger});
 if(step.stage==='VIDEO'&&['q35','q36'].includes(step.shot)){
  const alias=step.shot==='q35'?'q37':'q39',key='video:'+alias;
  await manager.recordRequest(V2.episode,key,result.request_id);
  await manager.completeAction(V2.episode,key,{artifact:{attempt:result.attempt,bucket:result.artifact_bucket,path:result.artifact_path,sha256:result.sha256,request_id:result.request_id},evidence:{provider_succeeded:true,artifact_persisted:true,sha_verified:true,artifact_verified:true},actualCostUsd:0});
 }
 return result;
}
