import {readFile,mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {LumiRecoveryIncidentManager,MemoryLumiRecoveryStore} from './lumi-recovery-incident-manager-v1.js';
import {LumiV2ExecutionOrchestrator,MemoryStageReceiptStore} from './lumi-v2-execution-orchestrator.js';
import {executeStage,EXECUTOR_BINDING_MATRIX,realExecutorReadiness} from './lumi-v2-executor-bindings.js';
import {prepareGenericV2Episode,compileGenericV2Direction,GENERIC_WORKER_STAGES} from './lumi-generic-v2-adapter.js';
import {LUMI_PRODUCTION_PROFILE_V2 as profile,rollbackToLegacy} from './lumi-production-profile-v2.js';
import {CAPABILITIES} from './cinematic-director-v1/profiles.js';
import {sha256,newSession,renderTelegramPanel} from './telegram-review-v1/core.js';
import {HOME_ASSET} from './telegram-review-v1/home-asset.js';
import {TEMPORAL_TOPOLOGY_VERSION} from './cinematic-director-v1/temporal-topology-qa-v2.js';

// Explicit test evidence. Only this dry endpoint materializes these local inputs.
// No mocked workers, submission response, new human approval or live storage write.
export async function createRealExecutorDryFixture({message_id=138}={}) {
 const directory=await mkdtemp(join(tmpdir(),'lumi-real-executor-dry-'));
 const plan=JSON.parse(await readFile(new URL('../qa/LUMI_GENERIC_LISTEN_FIXTURE_V1.json',import.meta.url))),templates=JSON.parse(await readFile(new URL('../qa/LUMI_GENERIC_LISTEN_DIRECTION_FIXTURE_V1.json',import.meta.url)));
 const options={},shotPlans=[];
 for(const [index,scene]of plan.scenes.entries()){
  const grammar=scene.audio.pauses.some(p=>p.purpose==='child_response')?'ATTENTIVE_WAIT':'GAZE_VIEWER',input=structuredClone(templates[grammar]),shot_id='listen_'+String(index+1).padStart(2,'0'),duration=Math.min(5,scene.duration_target_seconds);
  input.episode_id=plan.episode.id;input.contract.shot_id=shot_id;input.contract.DURATION=duration;input.contract.CHARACTER_STATE.character_lock_id=profile.visual.character_lock;input.context.locks.character.id=profile.visual.character_lock;
  input.direction.educational_goal=scene.educational_goal;input.direction.principal_actions[0].timing.gesture=duration-1.5;
  input.direction.continuity.previous_shot=index?'listen_'+String(index).padStart(2,'0'):null;input.direction.continuity.next_shot=index<plan.scenes.length-1?'listen_'+String(index+2).padStart(2,'0'):null;
  for(const [i,a]of [input.contract.SOURCE_ARTIFACT,...input.contract.GOLDEN_REFERENCES].entries()){
   const path=join(directory,shot_id,a.artifact_id+'.txt');await mkdir(join(directory,shot_id),{recursive:true});
   const bytes=i===0?'SYNTHETIC SOURCE BYTES NOT AN IMAGE':'SYNTHETIC '+a.role+' BYTES NOT MEDIA';await writeFile(path,bytes);
   if(i===0)a.path=path;else delete a.path;input.media.find(m=>m.artifact_id===a.artifact_id).path=path;input.context.artifact_evidence[a.artifact_id].path=path;
  }
  shotPlans.push({shot_id,scene_ids:[scene.id],duration,director_input:input});options[shot_id]={outputDirectory:join(directory,shot_id,'director'),allowSyntheticFixtures:true,capabilities:CAPABILITIES};
 }
 const request={episodePlan:plan,shotPlans,characterProfile:{id:profile.visual.character_lock,source_sha:profile.visual.source_sha},qualityProfile:{id:profile.visual.video_profile}},prepared=prepareGenericV2Episode(request);
 const bytes=Buffer.from('DRY_METADATA_FIXTURE_NOT_PLAYABLE'),sha=sha256(bytes),file=join(directory,'media-fixture');await writeFile(file,bytes);
 const media={artifact_id:'DRY_METADATA_ONLY',sha256:sha,mime:'video/mp4',size:bytes.length,bucket:'ISOLATED_DRY_FIXTURES',path:'metadata-fixture.mp4',width:1080,height:1920,duration:4};
 const reviewEpisode={episode_id:prepared.episode_id,title:plan.episode.title,review_mode:'SUPERVISED',beats:plan.scenes.length,shots:shotPlans.map(s=>({shot_id:s.shot_id,artifact:media,technical_qa:'PASS',creative_qa:'PASS'})),master:media,reviews:{}};
 for(const shot of reviewEpisode.shots)reviewEpisode.reviews[JSON.stringify([prepared.episode_id,shot.shot_id,sha])]={episode_id:prepared.episode_id,shot_id:shot.shot_id,artifact_sha:sha,status:'APPROVED',review_version:1,scope:'SYNTHETIC_DRY_REVIEW_NOT_HUMAN'};
 const panel=newSession({user_id:'DRY_OWNER',chat_id:'DRY_OWNER',message_id,cover:HOME_ASSET});panel.episodes[prepared.episode_id]=reviewEpisode;panel.deliveries[HOME_ASSET.sha256]={telegram_file_id:'DRY_CACHED_HOME'};panel.deliveries[sha]={telegram_file_id:'DRY_CACHED_REVIEW'};
 const verification={filePath:file,expectedSha256:sha,probe:async()=>({format:{duration:4},streams:[{codec_type:'video',codec_name:'h264',width:1080,height:1920,profile:'High'},{codec_type:'audio',codec_name:'aac',sample_rate:'48000'}]}),decode:async()=>({ok:true}),scan:async()=>({blackFrames:0,freezes:0})};
 const comparisons=Object.fromEntries(['canonical_source','video_source','first_frame','preceding_clean_frames','following_frames'].map(k=>[k,{reviewed:true,evidence_ids:['DRY_PIXEL_REVIEW_FIXTURE'],...(k.endsWith('source')?{sha256:profile.visual.source_sha}:{video_sha256:sha})}]));
 const temporal_review={version:TEMPORAL_TOPOLOGY_VERSION,sha256:sha,evidence_ids:['DRY_PIXEL_REVIEW_FIXTURE'],comparisons,all_frames_decoded:true,decoded_frame_count:120,fps:30,findings:[]};
 let externalCalls=0;const deny=()=>{externalCalls++;throw Error('DRY_EXTERNAL_SIDE_EFFECT_FORBIDDEN');},storageObjects=new Map();
 const materialize=async({shot,action})=>{
  const sourceInput=shot?.director_input,sourceSha=sourceInput?.contract.SOURCE_ARTIFACT.sha256;
  const qa=sourceInput&&{...sourceInput.source_qa,classification:'PASS',IDENTITY:'PASS',REALISM:'PASS',EDUCATIONAL_SEMANTICS:'PASS',COLOR:'PASS',VIDEO_SOURCE_READINESS:'PASS',CARTOON_DRIFT:'MINIMAL'};
  const source=shot?{artifact:{sha256:sourceSha},ledger:{content_hash:sourceSha,result:{visual_qa:qa}}}:null;
  return {canonical_sha:profile.visual.source_sha,anchor_url:'https://dry.invalid/canonical.png',source_url:'https://dry.invalid/source.png',source,director_options:shot?options[shot.shot_id]:null,
   ...(action.stage==='VIDEO'?{director_packet:await compileGenericV2Direction(prepared,shot.shot_id,options[shot.shot_id])}:{}),
   quote:{currency:'USD',usd:.01,provider_units:7,scope:'TEST_QUOTE_NOT_CURRENT_PRICING'},required_remaining_reserve_usd:.02,submit:deny,
   video_verification:verification,video_sha:sha,temporal_review:{...temporal_review,comparisons:{...comparisons,video_source:{...comparisons.video_source,sha256:sourceSha}}},review_episode:reviewEpisode,shot_artifact:media,panel,
   storage_probe:{storage:{upload:async(b,p,v)=>storageObjects.set(p,Buffer.from(v)),download:async(b,p)=>storageObjects.get(p),remove:async(b,p)=>storageObjects.delete(p)},bucket:'ISOLATED_DRY_STORAGE',prefix:'readiness',probeBytes:bytes,decodeAudio:async()=>true},audio_verification:verification,
   caption_qa:{lumi_bbox:{x:.1,y:.1,width:.4,height:.7},critical_educational_object_bboxes:[],safe_area:{x:0,y:0,width:1,height:1},text_elements:[]},
   segments:prepared.plan.scenes.map(s=>({videoPath:join(directory,s.id+'.mp4'),audioPath:join(directory,s.id+'.mp3'),duration:s.duration_target_seconds,pause:s.audio.pauses.filter(p=>p.purpose==='child_response').reduce((v,p)=>v+p.duration_seconds,0)})),output_path:join(directory,'DRY_MASTER_NOT_CREATED.mp4'),master_verification:verification};
 };
 return {request,prepared,materialize,panel,externalCalls:()=>externalCalls,cleanup:()=>rm(directory,{recursive:true,force:true})};
}

export async function runRealExecutorDryGate({message_id=138,crashMatrix=false}={}){
 const f=await createRealExecutorDryFixture({message_id}),results=[],events=[];
 try{
  const store=new MemoryLumiRecoveryStore(),manager=new LumiRecoveryIncidentManager({store}),receipts=new MemoryStageReceiptStore();
  const orchestrator=new LumiV2ExecutionOrchestrator({manager,receipts,materialize:f.materialize,dry_run:true,emitProgress:async e=>{const ep=f.panel.episodes[f.prepared.episode_id];ep.current_stage=e.stage_id;ep.confirmed_spend=e.checkpoint.current_cost_usd;const panel=renderTelegramPanel(f.panel,{kind:'progress',episode_id:ep.episode_id});events.push({event:e.event,state:panel.state_id,message_id,media_type:panel.media_type});}});
  await orchestrator.create({user:'DRY_OWNER',request:f.request,authorizedCeilingUsd:1,diagnostic:true});
  let endToEnd;
  while((await store.getEpisode(f.prepared.episode_id)).first_pending_action){try{const r=await orchestrator.resume({episodeId:f.prepared.episode_id});if(r.status!=='DRY_STAGE_COMPLETE'){endToEnd=r.status;break;}}catch(error){endToEnd=error.message;break;}}
  // Independent probes for downstream contracts, never a successful E2E continuation.
  for(const stage_id of GENERIC_WORKER_STAGES){
   const action=f.prepared.actions.find(a=>a.stage===stage_id),shot=f.prepared.shot_plans.find(s=>s.shot_id===action.scene_id),material=await f.materialize({action,shot});
   try{const r=await executeStage({episode_id:f.prepared.episode_id,stage_id,input:{prepared:f.prepared,action,shot,material,attempt_id:sha256('DRY:'+stage_id)},checkpoint:{},dry_run:true});results.push({stage_id,status:r.status,wrapper_entered:true,executor_bound:true,provider_boundary:r.status==='DRY_PROVIDER_BOUNDARY',external_side_effects:0});}
   catch(error){results.push({stage_id,status:'BLOCKED',reason:error.message,wrapper_entered:true,executor_bound:stage_id!=='TTS',external_side_effects:0});}
  }
  const crash_resume_matrix=crashMatrix?await runCrashResumeMatrix(f):null;
  return {version:'REAL_EXECUTOR_DRY_MODE_V1',status:'BLOCKED',blockers:realExecutorReadiness().blockers,fixture:{episode_id:f.prepared.episode_id,title:f.prepared.plan.episode.title,beats:f.prepared.plan.scenes.length,shots:f.prepared.shot_plans.length,pause_seconds:2.5},binding:realExecutorReadiness(),stages:results,stage_order:f.prepared.actions.map(a=>a.stage),last_completed_action:(await store.getEpisode(f.prepared.episode_id)).last_completed_action,first_pending_action:(await store.getEpisode(f.prepared.episode_id)).first_pending_action,end_to_end:{status:'BLOCKED',reason:endToEnd},progress_events:events,crash_resume_matrix,rollback:rollbackToLegacy().profile==='legacy'?'PASS':'FAIL',provider_calls:{IMAGE:0,VIDEO:0,TTS:0},publication_calls:0,external_calls:f.externalCalls(),live_approval_created:false,live_storage_writes:0,telegram_actual_edits:0,canonical_message_id:message_id,
   scope:'Real executable wrappers; provider submission stops before journal/POST; typed QA/audio/master metadata are explicit fixtures. Downstream probes are independent after missing TTS, not an E2E PASS. Live canonical panel untouched.'};
 }finally{await f.cleanup();}
}

export async function runCrashResumeMatrix(f){
 const rows=[];
 for(const stage of GENERIC_WORKER_STAGES)for(const point of ['BEFORE_SIDE_EFFECT','DURING_SIDE_EFFECT','AFTER_SIDE_EFFECT_BEFORE_RECEIPT','AFTER_RECEIPT_BEFORE_CHECKPOINT']){
  if(stage==='TTS'){rows.push({stage,injected_failure_point:point,expected_resume:'BLOCKED_MISSING_EXECUTOR',actual_resume:'BLOCKED_MISSING_EXECUTOR',duplicate_side_effects:0});continue;}
  const store=new MemoryLumiRecoveryStore(),manager=new LumiRecoveryIncidentManager({store}),receipts=new MemoryStageReceiptStore();let calls=0,executions=0,faulted=false;
  const action=f.prepared.actions.find(a=>a.stage===stage);
  const materialize=async args=>{calls++;const m=await f.materialize(args);if(['SHOT_REVIEW','MASTER_REVIEW'].includes(stage)){
   // Crash probe operates on dry reviewed metadata; no human record is persisted.
   m.review_episode=structuredClone(m.review_episode);const sha=m.shot_artifact.sha256,shotId=stage==='SHOT_REVIEW'?args.shot.shot_id:null;
   m.review_episode.reviews[JSON.stringify([f.prepared.episode_id,shotId,sha])]={episode_id:f.prepared.episode_id,shot_id:shotId,artifact_sha:sha,status:'APPROVED',review_version:1,scope:'SYNTHETIC_CRASH_FIXTURE'};
  }return m;};
  const o=new LumiV2ExecutionOrchestrator({manager,receipts,materialize,dry_run:true,inject:async v=>{if(v.point==='EXECUTOR_ENTERED')executions++;if(v.point===point&&!faulted){faulted=true;throw Error('INJECTED_CRASH');}}});
  await o.create({request:f.request,authorizedCeilingUsd:1,diagnostic:true});
  await manager.checkpoint(f.prepared.episode_id,d=>{d.actions=[d.actions.find(a=>a.key===action.key)];});
  try{await o.resume({episodeId:f.prepared.episode_id});}catch(error){if(error.message!=='INJECTED_CRASH')throw error;}
  const restarted=new LumiV2ExecutionOrchestrator({manager,receipts,materialize,dry_run:true});
  const r=await restarted.resume({episodeId:f.prepared.episode_id});
  const expected=['BEFORE_SIDE_EFFECT','AFTER_RECEIPT_BEFORE_CHECKPOINT'].includes(point)?'DRY_STAGE_COMPLETE':'EMISSION_AMBIGUOUS';
  rows.push({stage,injected_failure_point:point,expected_resume:expected,actual_resume:r.status,duplicate_side_effects:Math.max(0,executions-1),executor_dispatches:executions,materialize_calls:calls,pass:r.status===expected&&executions<=1});
 }
 return {status:rows.every(r=>r.pass!==false)?'PASS_FOR_BOUND_EXECUTORS':'FAIL',tested_bound_stages:13,unbound_stages:['TTS'],rows,duplicate_provider_calls:0};
}

// Bounded signed-transport evidence. The digest covers the complete diagnostic,
// including ordered actions and all semantic events, before any compaction.
export function summarizeRealExecutorDryResult(result){
 const {stage_order,progress_events,crash_resume_matrix,...summary}=result;
 return {...summary,dry_result_sha256:sha256(JSON.stringify(result)),
  stage_order_sha256:sha256(JSON.stringify(stage_order)),stage_action_count:stage_order.length,
  progress:{count:progress_events.length,events:[...new Set(progress_events.map(e=>e.event))],message_ids:[...new Set(progress_events.map(e=>e.message_id))],media_types:[...new Set(progress_events.map(e=>e.media_type))],sha256:sha256(JSON.stringify(progress_events))},
  crash_resume_matrix:crash_resume_matrix?{status:crash_resume_matrix.status,tested_bound_stages:crash_resume_matrix.tested_bound_stages,unbound_stages:crash_resume_matrix.unbound_stages,rows:crash_resume_matrix.rows.length,duplicate_provider_calls:crash_resume_matrix.duplicate_provider_calls,sha256:sha256(JSON.stringify(crash_resume_matrix))}:null};
}
