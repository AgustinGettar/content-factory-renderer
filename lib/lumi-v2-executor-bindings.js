import {acceptEpisodeGeneration} from './av2/creative-engine.js';
import {adaptEpisodeToLegacy} from './av2/compat.js';
import {imageInput} from './lumi-series-v2-continuation.js';
import {submitSeriesProviderRequest} from './lumi-series-v2-execution.js';
import {sourceGate} from './lumi-series-v2-gates.js';
import {compileGenericV2Direction,GENERIC_WORKER_STAGES} from './lumi-generic-v2-adapter.js';
import {validateCapabilities} from './cinematic-director-v1/director.js';
import {CAPABILITIES} from './cinematic-director-v1/profiles.js';
import {evaluateTemporalTopology} from './cinematic-director-v1/temporal-topology-qa-v2.js';
import {verifyArtifact,verifyTtsStorageGate,assertTtsStorageGate} from './lumi-recovery-incident-manager-v1.js';
import {validateCaptionQa} from './lumi-editorial-readiness-v1.js';
import {buildAssemblyCommand,executeAssemblyCommand} from './lumi-third-short-master-v1.js';
import {artifactReview,renderTelegramPanel} from './telegram-review-v1/core.js';
import {LUMI_PRODUCTION_PROFILE_V2 as profile,LUMI_VOICE_PROFILE_V3} from './lumi-production-profile-v2.js';
import {executeLumiTtsStage} from './lumi-tts-stage-v2.js';
import {materializeStageArtifact} from './lumi-artifact-materialization-v2.js';

const definitions={
 PLANNING:['acceptEpisodeGeneration','lib/av2/creative-engine.js','EpisodePlanV2','validated canonical plan','none','none'],
 SOURCE_PLANNING:['adaptEpisodeToLegacy','lib/av2/compat.js','canonical plan + shot/scene coverage','scene visual/narration contracts','none','none'],
 IMAGE:['imageInput + submitSeriesProviderRequest','lib/lumi-series-v2-continuation.js; lib/lumi-series-v2-execution.js','compiled scene + canonical source transport','claim / accepted request','provider POST; journal','Higgsfield marketing-studio/image'],
 SOURCE_QA:['sourceGate','lib/lumi-series-v2-gates.js','exact source SHA + typed QA ledger','source readiness','none','none'],
 DIRECTOR:['compileDirectorPacket via compileGenericV2Direction','lib/cinematic-director-v1/director.js','shot contract + reviewed source bytes + capability profile','bound director packet','temporary immutable local packet','none'],
 VIDEO:['submitSeriesProviderRequest','lib/lumi-series-v2-execution.js','source gate + Director + capability + quote','claim / accepted request','provider POST; journal','Kling 3.0 Pro'],
 TEMPORAL_QA:['verifyArtifact + evaluateTemporalTopology','lib/lumi-recovery-incident-manager-v1.js; lib/cinematic-director-v1/temporal-topology-qa-v2.js','decoded video + pixel-grounded temporal review','technical + calibrated topology QA','local decode','none'],
 SHOT_REVIEW:['artifactReview','lib/telegram-review-v1/core.js','episode + shot SHA + review version','bound human decision or wait','none','none'],
 TTS:['executeLumiTtsStage + createElevenLabsDirectClient','lib/lumi-tts-stage-v2.js; lib/lumi-elevenlabs-direct-v3.js','generic narration unit + frozen V3 + destination + quota budget','normalized StageResult + durable same-request recovery','Direct API emission after durable claim; ambiguous outcome fails closed','ElevenLabs eleven_multilingual_v2'],
 TTS_STORAGE:['verifyTtsStorageGate + assertTtsStorageGate + verifyArtifact','lib/lumi-recovery-incident-manager-v1.js','isolated probe bytes + audio decode + target bucket','storage PASS and decoded stem evidence','storage probe upload/read/remove','none'],
 CAPTIONS:['validateCaptionQa','lib/lumi-editorial-readiness-v1.js','caption geometry + protected character/object regions','editorial exclusion QA','none','none'],
 ASSEMBLY:['buildAssemblyCommand + executeAssemblyCommand','lib/lumi-third-short-master-v1.js','verified video/audio segments and exact pauses','one final encode command / artifact','local ffmpeg encode','none'],
 MASTER:['verifyArtifact','lib/lumi-recovery-incident-manager-v1.js','master bytes + frozen profile','decode/profile/black/freeze verification','local decode','none'],
 MASTER_REVIEW:['renderTelegramPanel + artifactReview','lib/telegram-review-v1/core.js','episode + master SHA + canonical session','MASTER_REVIEW panel and approval wait','transport event only','none']
};
export const EXECUTOR_BINDING_MATRIX=GENERIC_WORKER_STAGES.map(stage_id=>{
 const [real_existing_executor,executor_location,input_schema,output_schema,side_effects,provider_used]=definitions[stage_id];
 return {stage_id,contract:stage_id,current_simulated_handler:'test/fixtures/generic-v2.js:workers['+stage_id+']',real_existing_executor,executor_location,input_schema,output_schema,side_effects,provider_used,
  recovery_boundary:'BEFORE_STAGE → CLAIM/START → receipt → AFTER_STAGE; uncertainty pauses; no blind replay',
  idempotency_mechanism:['IMAGE','VIDEO','TTS'].includes(stage_id)?'existing emission journal + episode/plan/action claim':'immutable stage receipt + checkpoint',
  classification:stage_id==='TTS'?'DIRECT_API_DURABLE_BOUND':['IMAGE','VIDEO','ASSEMBLY'].includes(stage_id)?'ADAPTER_SHIM_REQUIRED':'READY_TO_BIND',
  status:stage_id==='TTS'&&!LUMI_VOICE_PROFILE_V3.frozen?'BLOCKED_VOICE_PROFILE':'REAL_EXECUTOR_BOUND'};
});
export function realExecutorReadiness(){const missing=EXECUTOR_BINDING_MATRIX.filter(r=>r.status!=='REAL_EXECUTOR_BOUND');return {status:missing.length?'BLOCKED':'PASS',bound:14-missing.length,total:14,implemented_wrappers:14,missing_stages:missing.map(r=>r.stage_id),blockers:missing.flatMap(r=>r.stage_id==='TTS'?['HIGGSFIELD_TTS_DEPLOYABLE_TRANSPORT_REQUIRED','BOUND_TTS_PROVIDER_QUOTE_REQUIRED']:['REAL_EXECUTOR_MISSING_'+r.stage_id])};}

// Interface adapters only. Each branch calls the existing executor named above.
// No Telegram API, external network or creative prompt logic is owned here.
export async function executeStage({episode_id,stage_id,input,profile:boundProfile=profile,checkpoint,dry_run=false}) {
 if(episode_id!==input.prepared.episode_id||boundProfile.id!==profile.id||!GENERIC_WORKER_STAGES.includes(stage_id))throw Error('EXECUTOR_SCOPE_MISMATCH');
 const {prepared,action,shot,material,attempt_id}=input;
 // Accepted results recover through the shared artifact path, never redispatch.
 if(material.completed_result&&['IMAGE','VIDEO','TTS','MASTER','ASSEMBLY'].includes(stage_id)){
  if(material.completed_result.episode_id!==episode_id||material.completed_result.stage_id!==stage_id||material.completed_result.action_key!==action.key)throw Error('RESULT_SCOPE_MISMATCH');
  return materializeStageArtifact(material.completed_result,material.artifact_runtime);
 }
 let value,status='COMPLETE';
 switch(stage_id){
  case 'PLANNING':value=acceptEpisodeGeneration(prepared.plan);break;
  case 'SOURCE_PLANNING':value=adaptEpisodeToLegacy(prepared.plan);break;
  case 'IMAGE':{
   const scene=adaptEpisodeToLegacy(prepared.plan).scenes.find(s=>s.metadata.av2_preparation.scene_id===shot.scene_ids[0]);
   if(material.canonical_sha!==profile.visual.source_sha||!material.anchor_url)throw Error('CANONICAL_SOURCE_BINDING_REQUIRED');
   const payload=imageInput(scene,shot.shot_id,material.anchor_url,scene.visual_prompt);
   value=await submitSeriesProviderRequest({model:profile.image.model,input:payload,attemptId:attempt_id,apiKey:material.apiKey,submit:material.submit,dry_run});status=value.status||'REQUEST_ACCEPTED';break;
  }
  case 'SOURCE_QA':sourceGate(material.source.artifact,material.source.ledger);value={status:'PASS',source_sha:material.source.artifact.sha256};break;
  case 'DIRECTOR':value=await compileGenericV2Direction(prepared,shot.shot_id,material.director_options||{});break;
  case 'VIDEO':{
   sourceGate(material.source.artifact,material.source.ledger);
   const packet=material.director_packet;
   if(packet?.episode_id!==episode_id||packet.shot_id!==shot.shot_id||packet.gates.SOURCE_EVIDENCE_READY!==true||packet.blockers.length||packet.gates.CAPABILITIES_VERIFIED!==true||!packet.PROVIDER_PROMPT?.text)throw Error('CINEMATIC_DIRECTOR_REQUIRED');
   const payload={...packet.PROVIDER_REQUEST_PREVIEW.parameters,prompt:packet.PROVIDER_PROMPT.text,image_url:material.source_url};
   const capabilityErrors=validateCapabilities(payload,['prompt','image_url','duration','sound','multi_shots'],CAPABILITIES,{provider:CAPABILITIES.provider,endpoint:profile.video.endpoint});
   if(capabilityErrors.length)throw Error('ENDPOINT_CAPABILITY_GATE:'+capabilityErrors.join(','));
   if(packet.DIRECTOR_PLAN.contract.SOURCE_ARTIFACT.sha256!==material.source.artifact.sha256)throw Error('DIRECTOR_SOURCE_SHA_MISMATCH');
   value=await submitSeriesProviderRequest({model:profile.video.endpoint,input:payload,attemptId:attempt_id,apiKey:material.apiKey,submit:material.submit,dry_run});status=value.status||'REQUEST_ACCEPTED';break;
  }
  case 'TEMPORAL_QA':{
   if(material.temporal_review?.comparisons?.canonical_source?.sha256!==profile.visual.source_sha||material.temporal_review?.comparisons?.video_source?.sha256!==material.source.artifact.sha256)throw Error('TEMPORAL_SOURCE_BINDING_REQUIRED');
   const technical=await verifyArtifact({...material.video_verification,type:'VIDEO'});
   value={technical,topology:evaluateTemporalTopology({sha256:material.video_sha,review:material.temporal_review})};
   if(!technical.ok||!['PASS','PASS_WITH_WARNING'].includes(value.topology.status))throw Error('TEMPORAL_QA_REVIEW_REQUIRED');break;
  }
  case 'SHOT_REVIEW':value=artifactReview(material.review_episode,material.shot_artifact,shot.shot_id);status=value?.status==='APPROVED'?'COMPLETE':value?.status==='REJECTED'?'REPAIR_PLAN_REQUIRED':'WAITING_HUMAN_SHOT_REVIEW';break;
  case 'TTS':{
   return executeLumiTtsStage({episode_id,stage_id,narration_unit_id:material.narration_unit_id||'narration',
    text:prepared.narration_request.text,voice_profile_id:prepared.narration_request.voice_profile_id||'LUMI_VOICE_PROFILE_V3',require_preflight:dry_run&&material.require_tts_preflight===true,
    output_artifact_target:material.output_artifact_target||{bucket:'generated-audio',prefix:`lumi-v2/${episode_id}`},
    budget_context:material.budget_context,checkpoint,dry_run},material.tts_runtime);
  }
  case 'TTS_STORAGE':{
   const gate=await verifyTtsStorageGate(material.storage_probe);assertTtsStorageGate(gate);
   const audio=await verifyArtifact({...material.audio_verification,type:'AUDIO'});if(!audio.ok)throw Error('AUDIO_DECODE_FAILURE');value={gate,audio};break;
  }
  case 'CAPTIONS':value=validateCaptionQa(material.caption_qa);if(value.status!=='PASS')throw Error('CAPTION_QA_BLOCKED');break;
  case 'ASSEMBLY':{
   if(material.segments.some(s=>s.pause&&s.pause!==profile.editorial.pedagogical_pause_seconds))throw Error('PEDAGOGICAL_PAUSE_CONTRACT_REQUIRED');
   value=await executeAssemblyCommand({command:buildAssemblyCommand({segments:material.segments,outputPath:material.output_path}),dry_run});status=value.status;break;
  }
  case 'MASTER':value=await verifyArtifact({...material.master_verification,type:'MASTER',expected:{width:profile.master.width,height:profile.master.height,codec:'h264',profile:profile.master.profile}});if(!value.ok)throw Error('MASTER_PROFILE_BLOCKED');break;
  case 'MASTER_REVIEW':value=renderTelegramPanel(material.panel,{kind:'master',episode_id});status=artifactReview(material.review_episode,material.review_episode.master)?.status==='APPROVED'?'COMPLETE':'WAITING_FINAL_REVIEW';break;
 }
 if(!dry_run){
  const mapped=status==='COMPLETE'?'SUCCEEDED':status.startsWith('WAITING')||status==='REPAIR_PLAN_REQUIRED'?'HUMAN_REVIEW_REQUIRED':
   ['REQUEST_ACCEPTED','pending','queued'].includes(status)||value?.request_id?'IN_PROGRESS':'FAILED_RETRYABLE_LOCAL';
  const candidate=stage_id==='SHOT_REVIEW'?material.shot_artifact:stage_id==='MASTER_REVIEW'||stage_id==='MASTER'?material.review_episode?.master:material.persisted_artifact;
  return {status:mapped,episode_id,stage_id,artifacts:candidate?[{...candidate,episode_id}]:[],
   provider_job_ids:value?.request_id?[value.request_id]:[],claims:[attempt_id],estimated_cost:material.quote??null,actual_cost:null,
   qa:['TEMPORAL_QA'].includes(stage_id)?value.technical:stage_id==='MASTER'?value:stage_id==='TTS_STORAGE'?value.audio:
    stage_id==='SHOT_REVIEW'||stage_id==='MASTER_REVIEW'?{ok:material.technical_qa?.ok===true,status:material.technical_qa?.status??'UNVERIFIED'}:{ok:value?.status==='PASS',status:value?.status??'UNVERIFIED'},
   human_review_requirement:mapped==='HUMAN_REVIEW_REQUIRED',next_action:mapped==='IN_PROGRESS'?'POLL_SAME_JOB':null,
   error_classification:mapped==='FAILED_RETRYABLE_LOCAL'?'CANONICAL_ARTIFACT_HANDOFF_REQUIRED':null,output:value};
 }
 return {status,artifacts:value,claims:value?.claim?[value.claim]:[],cost:{confirmed_usd:0,provider_units:null},qa:['SOURCE_QA','TEMPORAL_QA','TTS_STORAGE','CAPTIONS','MASTER'].includes(stage_id)?value:null,next_action:status.startsWith('WAITING')?'HUMAN_REVIEW':null,dry_run,external_side_effects:0};
}
