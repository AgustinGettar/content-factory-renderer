import {acceptEpisodeGeneration} from './av2/creative-engine.js';
import {compileDirectorPacket} from './cinematic-director-v1/director.js';
import {POLICY,CAPABILITIES} from './cinematic-director-v1/profiles.js';
import {sourceGate} from './lumi-series-v2-gates.js';
import {journaledFetch} from './provider-emission-journal-v1.js';
import {LUMI_PRODUCTION_PROFILE_V2 as profile,PROFILE_SHA,selectLumiCreationProfile,buildFutureVoiceRequest} from './lumi-production-profile-v2.js';
import {sha256,validateArtifact,reviewGate} from './telegram-review-v1/core.js';
import {inputDigest} from './lumi-v2-activation-context.js';
import {readFileSync} from 'node:fs';
import {NEGATIVE_STYLES} from './cinematic-director-v1/PROMPT_COMPILER_V3.mjs';
import {GRAMMAR,LABELS} from './cinematic-director-v1/projection.js';
import directionEvidence from '../episodes/ep_lumi_granja_004_20261008_ee7ab4b3/Q41_DIRECTOR_PREPARATION_REVIEW.json' with {type:'json'};

// Contract validation covers future shots without claiming their nonexistent
// pixels, approvals, or provider readiness. Existing checkpoint inputs stay frozen.
export function validateEp004DirectorInventory(prepared){
 const descriptors=JSON.parse(readFileSync(new URL('../episodes/ep_lumi_granja_004_20261008_ee7ab4b3/SHOT_DESCRIPTORS_V2.json',import.meta.url)));
 if(prepared.episode_id!==descriptors.episode_id||prepared.shot_plans.length!==7)throw Error('EP004_SHOT_INVENTORY_INVALID');
 for(const [i,s] of prepared.shot_plans.entries()){
  const d=descriptors.shots[i];
  if(['shot_id','duration','grammar','focus','camera','body_motion','response_window_seconds'].some(k=>s[k]!==d[k])
    ||inputDigest(s.scene_ids)!==inputDigest(d.scene_ids)||!GRAMMAR[s.grammar]||!LABELS[s.focus]
    ||s.director_input.contract.DURATION!==s.duration||s.director_input.contract.shot_id!==s.shot_id
    ||inputDigest(s.director_input.contract.REQUIRED_OBJECTS.map(o=>o.id))!==inputDigest(['cow','sheep','hen'])
    ||(s.grammar==='GAZE_TARGET'&&!['cow','sheep','hen'].includes(s.focus)))throw Error('EP004_SHOT_INVENTORY_INVALID');
 }
 return {status:'PASS',shots:7,scope:'CONTRACT_ONLY',future_sources:'REQUIRE_OWN_SOURCE_QA_AND_HUMAN_REVIEW',provider_calls:0};
}

// Materialize the existing director, not another planner. All approvals come
// from durable records; static visual observations are separately identified.
export function materializeEp004Direction({state,prepared,shot,source,sourceQa,approval}){
 const e=directionEvidence,a=source.artifact;
 validateEp004DirectorInventory(prepared);
 if(state.episode_id!==e.episode_id||shot.shot_id!==e.shot_id||prepared.binding_sha!==e.prepared_binding_sha
   ||a.artifact_id!==e.source_artifact_id||a.sha256!==e.source_sha256||shot.duration!==4
   ||sourceQa.receipt_id!==e.source_qa_receipt_id||sourceQa.sha256!==e.source_qa_result_sha256
   ||inputDigest(sourceQa.result)!==sourceQa.sha256||sourceQa.result.qa?.ok!==true
   ||sourceQa.result.qa.sha256!==a.sha256||inputDigest(sourceQa.result.output.source)!==inputDigest(source)
   ||approval?.status!=='APPROVED'||approval.artifact_sha!==a.sha256||approval.user!==state.metadata.user
   ||!approval.timestamp||!approval.callback_query_id)throw Error('DIRECTOR_DURABLE_EVIDENCE_MISMATCH');
 sourceGate(a,source.ledger);
 const inventory=copy(e.inventory),objects=inventory.map(({visibility,...o})=>o);
 const locks={character:{id:profile.visual.character_lock,sha256:profile.visual.source_sha,status:'FROZEN',description:JSON.stringify(e.character_constraints)},
  world:{id:state.episode_id+':approved-source-world',sha256:inputDigest({source_sha:a.sha256,world:e.world_description,inventory}),status:'FROZEN',description:e.world_description}};
 const evidencePolicy={scope:'APPROVED_STATIC_SOURCE_DIRECTION',episode_id:state.episode_id,shot_id:shot.shot_id,sha256:a.sha256,
  canonical_sha:profile.visual.source_sha,profile_sha:PROFILE_SHA,prepared_binding_sha:prepared.binding_sha,
  source_qa_receipt:sourceQa.receipt_id,source_qa_result_sha:sourceQa.sha256,observations_sha:inputDigest(e),limitations:e.limitations};
 const contract={shot_id:shot.shot_id,shot_type:'ESTABLISHING',
  START_STATE:{description:e.world_description,object_inventory:inventory},END_STATE:{description:'Same approved composition after natural settle; no reveal or animal changes.',object_inventory:copy(inventory)},
  CHARACTER_STATE:{description:locks.character.description,character_lock_id:locks.character.id,character_lock_sha256:locks.character.sha256,
   world_lock_id:locks.world.id,world_lock_sha256:locks.world.sha256,identity_preserved:true,canonical_wings:2,wand_policy:'VISIBLE_PRESERVE_SOURCE'},
  REQUIRED_OBJECTS:objects,EDUCATIONAL_INVARIANTS:objects.flatMap(o=>['count','color','shape'].map(property=>({object_id:o.id,property,value:o[property]}))),
  PRIMARY_ACTION:{action:'look_at_viewer',description:'Warm eye contact with viewer; retain the approved pose.'},ALLOWED_SECONDARY_MOTION:['blink','natural_settle'],
  FORBIDDEN_ACTIONS:['ADD_OR_REMOVE_ANIMAL','TORSO_ROTATION','REAR_REVEAL','WAND_DISAPPEARANCE','ADDITIONAL_WINGS','BEE_ABDOMEN','STRIPES','CLOTHING_CHANGE','TEXT_OVER_LUMI','IDENTITY_CHANGE'],
  CAMERA:{type:'STATIC',description:'Preserve the exact reviewed first-frame composition.',necessary:true},DURATION:4,
  SOURCE_ARTIFACT:{artifact_id:a.artifact_id,path:a.path,sha256:a.sha256},GOLDEN_REFERENCES:[],NEGATIVE_STYLE_CONTRACT:[...NEGATIVE_STYLES]};
 const review={id:e.evidence_id,artifact_id:a.artifact_id,sha256:a.sha256,actor:e.review_method,at:e.reviewed_at,
  scope:e.scope,kind:'VISUAL_REVIEW',status:'APPROVED',observations:copy(e.observed_facts),warnings:[]};
 return {version:'LUMI_CINEMATIC_DIRECTION_V1',episode_id:state.episode_id,revision:1,contract,direction:copy(e.direction),
  policy_id:profile.id+':director',language:'en',synthetic_fixture:false,execution_authorization:false,direction_approval:null,
  facts:Object.fromEntries(Object.entries(e.observed_facts).map(([k,value])=>[k,{value:copy(value),status:'OBSERVED',evidence_ids:[e.evidence_id]}])),
  reviews:[review,{id:approval.callback_query_id,artifact_id:a.artifact_id,sha256:a.sha256,actor:approval.user,at:approval.timestamp,
   scope:'SOURCE_FOR_VIDEO',kind:'HUMAN',status:'APPROVED',observations:{original_scope:approval.visual_checklist,original_decision:copy(approval)},warnings:[]}],
  context:{style_authority:{id:'LUMI_SERIES_STYLE_V2',status:'FROZEN'},locks,static_source_evidence:evidencePolicy,
   artifact_evidence:{[a.artifact_id]:{human_approved:true,qa_status:'PASS'}},source_readiness:{[a.artifact_id]:copy(e.readiness)},
   postproduction:{deterministic_educational_graphics:true,text_character_overlap:0,visible_pause_label:false,playback_rate:1,
    master_width:profile.master.width,master_height:profile.master.height,planned_captions:[]}},
  media:[],source_qa:copy(source.ledger.result.visual_qa),request_parameters:{},required_controls:['duration','sound','multi_shots']};
}
// Production descriptors are authored for EP004, never loaded from diagnostics
// or test fixtures. Uncreated sources and unobserved visual facts remain pending.
export function ep004ProductionRequest(approvedSource){
 const root=new URL('../episodes/ep_lumi_granja_004_20261008_ee7ab4b3/',import.meta.url);
 const episodePlan=JSON.parse(readFileSync(new URL('EPISODE_PLAN_V2.json',root)));
 const descriptors=JSON.parse(readFileSync(new URL('SHOT_DESCRIPTORS_V2.json',root)));
 if(approvedSource.episode_id!==episodePlan.episode.id)throw Error('EP004_SOURCE_EPISODE_MISMATCH');
 const shotPlans=descriptors.shots.map(s=>({...s,director_input:{
  version:'LUMI_CINEMATIC_DIRECTION_V1',episode_id:episodePlan.episode.id,
  materialization_status:'SOURCE_EVIDENCE_REQUIRED',execution_authorization:false,
  contract:{shot_id:s.shot_id,DURATION:s.duration,
   SOURCE_ARTIFACT:s.shot_id==='q41'?structuredClone(approvedSource):{sha256:null,status:'NOT_CREATED'},
   GOLDEN_REFERENCES:[],REQUIRED_OBJECTS:['cow','sheep','hen'].map(id=>({id})),
   CHARACTER_STATE:{character_lock_id:profile.visual.character_lock,canonical_source_sha:profile.visual.source_sha}},
  direction:{educational_goal:s.educational_goal,focus:s.focus,grammar:s.grammar,
   camera:s.camera,body_motion:s.body_motion,response_window_seconds:s.response_window_seconds},
  character_constraints:descriptors.character,motion_policy:descriptors.motion_policy
 }}));
 return {episodePlan,shotPlans,characterProfile:{id:profile.visual.character_lock,source_sha:profile.visual.source_sha},qualityProfile:{id:profile.visual.video_profile}};
}
export const GENERIC_V2_ADAPTER_VERSION='LUMI_GENERIC_V2_ADAPTER_V1';
export const GENERIC_WORKER_STAGES=Object.freeze(['PLANNING','SOURCE_PLANNING','IMAGE','SOURCE_QA','DIRECTOR','VIDEO','TEMPORAL_QA','SHOT_REVIEW','TTS','TTS_STORAGE','CAPTIONS','ASSEMBLY','MASTER','MASTER_REVIEW']);
const paid=new Set(['IMAGE','VIDEO','TTS']);
const copy=x=>structuredClone(x);
export function genericWorkerReadiness(workers={}){
 const missing=GENERIC_WORKER_STAGES.filter(k=>!workers[k]||workers[k].generic!==true||typeof workers[k].run!=='function'||paid.has(k)&&(typeof workers[k].fetch!=='function'||typeof workers[k].quote!=='function')); 
 return {version:GENERIC_V2_ADAPTER_VERSION,status:missing.length?'BLOCKED':'PASS',missing_workers:missing,provider_calls:0,publication_calls:0};
}
// Reuse the actual AV2 validator/canonicalizer, not a parallel planning schema.
export function prepareGenericV2Episode({episodePlan,shotPlans,characterProfile,qualityProfile}){
 if(characterProfile?.id!==profile.visual.character_lock||characterProfile?.source_sha!==profile.visual.source_sha||qualityProfile?.id!==profile.visual.video_profile)throw Error('FROZEN_V2_PROFILE_BINDING_REQUIRED');
 const accepted=acceptEpisodeGeneration(episodePlan),plan=accepted.episode_plan;
 if(!Array.isArray(shotPlans)||!shotPlans.length)throw Error('GENERIC_SHOT_PLAN_REQUIRED');
 const ids=new Set(),sceneIds=new Set(plan.scenes.map(s=>s.id)),covered=new Set();
 for(const shot of shotPlans){
  if(!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(shot.shot_id)||ids.has(shot.shot_id)||!Array.isArray(shot.scene_ids)||!shot.scene_ids.length||shot.scene_ids.some(id=>!sceneIds.has(id)||covered.has(id)))throw Error('GENERIC_SHOT_SCENE_BINDING_INVALID');
  if(shot.duration!==shot.director_input?.contract?.DURATION||shot.director_input?.contract?.shot_id!==shot.shot_id||shot.director_input?.episode_id!==plan.episode.id)throw Error('GENERIC_DIRECTOR_INPUT_BINDING_INVALID');
  if(!Number.isInteger(shot.duration)||shot.duration<3||shot.duration>5)throw Error('KLING_DURATION_CONTRACT_REQUIRED');
  ids.add(shot.shot_id);shot.scene_ids.forEach(id=>covered.add(id));
 }
 if(covered.size!==sceneIds.size)throw Error('ALL_PEDAGOGICAL_SCENES_REQUIRED');
 const actions=[{key:'planning',stage:'PLANNING'},{key:'source-planning',stage:'SOURCE_PLANNING'}];
 for(const shot of shotPlans)for(const stage of ['IMAGE','SOURCE_QA','DIRECTOR','VIDEO','TEMPORAL_QA','SHOT_REVIEW'])actions.push({key:stage.toLowerCase()+':'+shot.shot_id,stage,scene_id:shot.shot_id});
 for(const stage of ['TTS','TTS_STORAGE','CAPTIONS','ASSEMBLY','MASTER','MASTER_REVIEW'])actions.push({key:stage.toLowerCase(),stage});
 const value={version:GENERIC_V2_ADAPTER_VERSION,binding_hash_version:'CANONICAL_JSON_V1',episode_id:plan.episode.id,plan,plan_sha:accepted.episode_sha256,shot_plans:copy(shotPlans),character_profile:copy(characterProfile),quality_profile:copy(qualityProfile),profile_sha:PROFILE_SHA,actions,
  source_contracts:shotPlans.map(s=>({shot_id:s.shot_id,scene_ids:s.scene_ids,character_lock_id:characterProfile.id,canonical_source_sha:characterProfile.source_sha,source_sha:s.director_input.contract.SOURCE_ARTIFACT.sha256,video_endpoint:profile.video.endpoint,first_frame_authority:true,source_gate_required:true})),
  narration_request:buildFutureVoiceRequest(plan.scenes.flatMap(s=>s.audio.utterances.map(u=>u.text)).join(' ')),assembly_contract:copy(profile.master),editorial_contract:copy(profile.editorial)};
 return Object.freeze({...value,binding_sha:inputDigest(value)});
}
export async function compileGenericV2Direction(prepared,shotId,options={}){
 const shot=prepared.shot_plans.find(s=>s.shot_id===shotId);if(!shot)throw Error('GENERIC_SHOT_UNKNOWN');
 const policy={...copy(POLICY),id:profile.id+':director',episode_id:prepared.episode_id,durations:Object.fromEntries(prepared.shot_plans.map(s=>[s.shot_id,s.duration])),educational_objects:Object.fromEntries(prepared.shot_plans.map(s=>[s.shot_id,s.director_input.contract.REQUIRED_OBJECTS.map(o=>o.id)])),ledger_aliases:{},authority:['Frozen production profile '+PROFILE_SHA+'; no execution authorization'],authority_records:[{profile:profile.id,sha256:PROFILE_SHA}],budget_authorization:false,execution_authorization:false};
 const input=copy(shot.director_input);input.policy_id=policy.id;input.execution_authorization=false;
 if(input.context?.static_source_evidence){
  // This mode is admitted only by the server-owned evidence record, never by a
  // callback parameter or an arbitrary policy override.
  const e=directionEvidence,p=input.context.static_source_evidence;
  if(prepared.binding_sha!==e.prepared_binding_sha||p.observations_sha!==inputDigest(e)||p.sha256!==e.source_sha256
    ||p.source_qa_receipt!==e.source_qa_receipt_id||p.source_qa_result_sha!==e.source_qa_result_sha256
    ||p.profile_sha!==PROFILE_SHA||p.canonical_sha!==profile.visual.source_sha||p.episode_id!==e.episode_id||p.shot_id!=='q41')throw Error('DIRECTOR_STATIC_SCOPE_INVALID');
  policy.source_evidence_policy=copy(p);policy.educational_inventory={q41:e.inventory.map(({visibility,...o})=>o)};
  policy.world_description=e.world_description;policy.restrained_breathing=true;
 }
 const packet=await compileDirectorPacket(input,{...options,policy,capabilities:options.capabilities||CAPABILITIES});
 if(packet.blockers.length||packet.gates.SOURCE_EVIDENCE_READY!==true)throw Error('GENERIC_DIRECTOR_GATE_BLOCKED:'+packet.blockers.map(x=>x.code).join(','));
 return packet;
}
// Serial adapter contract, isolated from the historical episode executors. It
// refuses missing concrete workers before creating an episode or emitting anything.
export class GenericLumiV2Adapter{
 constructor({manager,journal,workers={},reviewStore,activation=null,readiness=null,simulation=false,runtime=null}){Object.assign(this,{manager,journal,workers,reviewStore,activation,readiness,simulation,runtime});}
 async create({user,request,authorizedCeilingUsd=0,execution_context}){
  if(this.runtime)return this.runtime.create({user,request,authorizedCeilingUsd,execution_context});
  if(!this.simulation)selectLumiCreationProfile({requested:profile.id,activation:this.activation,readiness:this.readiness});
  const ready=genericWorkerReadiness(this.workers);if(ready.status!=='PASS')throw Error('GENERIC_WORKER_BINDINGS_REQUIRED:'+ready.missing_workers.join(','));
  if(this.simulation&&Object.values(this.workers).some(w=>w.simulated!==true))throw Error('ZERO_PROVIDER_WORKERS_REQUIRED');
  const prepared=prepareGenericV2Episode(request),state=await this.manager.store.getEpisode(prepared.episode_id);
  if(state&&state.metadata?.generic_v2?.binding_sha!==prepared.binding_sha)throw Error('GENERIC_EPISODE_INPUT_IMMUTABLE');
  await this.manager.startEpisode({episodeId:prepared.episode_id,actions:prepared.actions,authorizedCeilingUsd,metadata:{generic_v2:prepared,user,simulation:this.simulation,provider_calls_allowed:0}});
  return {episode_id:prepared.episode_id,status:'PREPARED',binding_sha:prepared.binding_sha,provider_calls:0};
 }
 async resume({episodeId,authorization=null,user,execution_context,expectedAction}){
  if(this.runtime)return this.runtime.resume({episodeId,user,execution_context,expectedAction});
  if(!this.simulation)selectLumiCreationProfile({requested:profile.id,activation:this.activation,readiness:this.readiness,existingEpisode:false});
  const state=await this.manager.store.getEpisode(episodeId),prepared=state?.metadata?.generic_v2;
  if(!prepared||prepared.episode_id!==episodeId||prepared.profile_sha!==PROFILE_SHA)throw Error('GENERIC_CHECKPOINT_BINDING_REQUIRED');
  if(state.status==='PAUSED_INCIDENT'||state.status==='CANCELLED')return {status:state.status,provider_calls:0};
  const action=state.actions.find(a=>a.key===state.first_pending_action);if(!action)return {status:'WAITING_FINAL_REVIEW',provider_calls:0};
  if(['DISPATCHING','EMISSION_AMBIGUOUS'].includes(action.dispatch_state))throw Error('GENERIC_EMISSION_RECONCILIATION_REQUIRED');
  const worker=this.workers[action.stage];if(worker?.generic!==true||typeof worker.run!=='function')throw Error('GENERIC_WORKER_BINDINGS_REQUIRED:'+action.stage);
  if(['SHOT_REVIEW','MASTER_REVIEW'].includes(action.stage)&&!this.simulation){const r=await this.reviewStore.get(state.metadata.user),e=r?.state.episodes[episodeId];if(!e||reviewGate(e)!=='READY_TO_CONTINUE'&&action.stage==='SHOT_REVIEW'||action.stage==='MASTER_REVIEW'&&reviewGate(e)!=='APPROVED')return {status:action.stage==='SHOT_REVIEW'?'WAITING_HUMAN_SHOT_REVIEW':'WAITING_FINAL_REVIEW',provider_calls:0};}
  const attemptId=sha256(episodeId+':'+prepared.binding_sha+':'+action.key),shot=prepared.shot_plans.find(s=>s.shot_id===action.scene_id);
  if(paid.has(action.stage)&&!this.simulation&&(authorization?.episode_id!==episodeId||authorization?.action_key!==action.key||authorization?.profile_sha!==PROFILE_SHA||authorization?.max_calls!==1))throw Error('EXACT_SINGLE_ACTION_AUTHORIZATION_REQUIRED');
  let dispatch=()=>{throw Error('LOCAL_STAGE_PROVIDER_FORBIDDEN');};
  if(paid.has(action.stage)){
   const quote=await worker.quote({prepared,action});if(quote?.currency!=='USD'||!Number.isFinite(quote.usd)||quote.usd<0)throw Error('CURRENT_USD_QUOTE_REQUIRED');
   const gate=await this.manager.budgetGate({episodeId,actionKey:action.key,projectedCallCostUsd:quote.usd});if(gate.status!=='PASS')return {status:gate.status,provider_calls:0};
   const model=action.stage==='IMAGE'?profile.image.model:action.stage==='VIDEO'?profile.video.endpoint:profile.voice.model;
   if(action.stage==='VIDEO'){const source=state.metadata.source_artifacts?.[shot.shot_id];sourceGate(source?.artifact,source?.ledger);if(!state.metadata.director_packets?.[shot.shot_id])throw Error('CINEMATIC_DIRECTOR_REQUIRED');}
   dispatch=journaledFetch({store:this.journal,context:{episode_id:episodeId,scene_id:action.scene_id,stage:action.stage,attempt_id:attemptId,provider:this.simulation?'SYNTHETIC_TRANSPORT':'higgsfield_api',model,expected_cost_usd:quote.usd},fetchImpl:worker.fetch});
  }
  // Durable claim before worker execution; restarts never silently re-run a stage.
  await this.manager.checkpoint(episodeId,d=>{d.actions.find(a=>a.key===action.key).dispatch_state='DISPATCHING';});
  try{
   const result=await worker.run({prepared,action,shot,attemptId,dispatch,state:copy(state)});
   if(!result?.artifact||!result.evidence)throw Error(action.stage==='TTS_STORAGE'?'TTS_STORAGE_FAILURE':'ARTIFACT_STORAGE_FAILURE');
   if(result.media_artifact)validateArtifact(result.media_artifact);
   if(result.request_id)await this.manager.recordRequest(episodeId,action.key,result.request_id);
   await this.manager.completeAction(episodeId,action.key,result);
   if(result.metadata_patch)await this.manager.checkpoint(episodeId,d=>Object.assign(d.metadata,result.metadata_patch));
   return {status:(await this.manager.store.getEpisode(episodeId)).status,completed_action:action.key,provider_calls:this.simulation||!paid.has(action.stage)?0:1,simulation:this.simulation};
  }catch(error){
   const journal=await this.journal?.get?.(attemptId);const ambiguous=journal?.state==='EMISSION_UNKNOWN'||paid.has(action.stage)&&journal?.state==='EMITTING';
   await this.manager.pause({episodeId,sceneId:action.scene_id,stage:action.stage,errorClass:ambiguous?'EMISSION_AMBIGUOUS':action.stage==='TTS_STORAGE'?'TTS_STORAGE_FAILURE':'QUALITY_REVIEW_REQUIRED',reason:error.message,firstPendingAction:action.key,safeResumeAvailable:false});throw error;
  }
 }
 async handleReview(args){
  if(!this.runtime)throw Error('GENERIC_REVIEW_RECOVERY_BINDING_REQUIRED');
  return this.runtime.handleReview(args);
 }
}
