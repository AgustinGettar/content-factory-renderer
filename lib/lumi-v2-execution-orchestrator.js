import {prepareGenericV2Episode,GENERIC_WORKER_STAGES} from './lumi-generic-v2-adapter.js';
import {executeStage,realExecutorReadiness} from './lumi-v2-executor-bindings.js';
import {PROFILE_SHA,LUMI_PRODUCTION_PROFILE_V2 as profile,selectLumiCreationProfile} from './lumi-production-profile-v2.js';
import {sha256} from './telegram-review-v1/core.js';
import {sumUsd,usd} from './higgsfield-usd-budget-v1.js';
import {handleStageResult,reconcileStageReview} from './lumi-stage-result-v2.js';
import {recoverSeriesProviderResult} from './lumi-series-v2-execution.js';

export const ORCHESTRATOR_VERSION='LUMI_V2_EXECUTION_ORCHESTRATOR_V1';
export const PROGRESS_EVENTS={PLANNING:['PLAN_STARTED','PLAN_COMPLETE'],SOURCE_PLANNING:['SOURCES_STARTED','SOURCES_PLANNED'],IMAGE:['SOURCE_STARTED','SOURCE_COMPLETE'],SOURCE_QA:['SOURCE_QA_STARTED','SOURCE_QA_COMPLETE'],DIRECTOR:['DIRECTOR_STARTED','DIRECTOR_COMPLETE'],VIDEO:['VIDEO_STARTED','VIDEO_COMPLETE'],TEMPORAL_QA:['QA_STARTED','QA_COMPLETE'],SHOT_REVIEW:['REVIEW_REQUIRED','SHOT_REVIEW_COMPLETE'],TTS:['AUDIO_STARTED','AUDIO_COMPLETE'],TTS_STORAGE:['AUDIO_STORAGE_STARTED','AUDIO_STORAGE_COMPLETE'],CAPTIONS:['CAPTIONS_STARTED','CAPTIONS_COMPLETE'],ASSEMBLY:['ASSEMBLY_STARTED','ASSEMBLY_COMPLETE'],MASTER:['MASTER_QA_STARTED','MASTER_READY'],MASTER_REVIEW:['REVIEW_REQUIRED','MASTER_REVIEW_COMPLETE']};
const paid=new Set(['IMAGE','VIDEO','TTS']);
// Existing CAS review command store is the durable claim/receipt authority. No schema change.
export class ReviewStageReceiptStore {
 constructor({store,user}){this.store=store;this.user=user;}
 async get(id){return (await this.store.get(this.user))?.state.production_commands?.[id]||null;}
 async claim(id,value){const row=await this.store.get(this.user);if(!row)throw Error('REVIEW_OWNER_REQUIRED');row.state.production_commands||={};if(row.state.production_commands[id])return false;row.state.production_commands[id]=value;await this.store.cas(this.user,row.revision,row.state);return true;}
 async record(id,value){const row=await this.store.get(this.user);if(!['STARTED','WAITING'].includes(row.state.production_commands?.[id]?.status))throw Error('STAGE_RECEIPT_CAS_REQUIRED');row.state.production_commands[id]=value;await this.store.cas(this.user,row.revision,row.state);}
 async transition(id,from,patch){const row=await this.store.get(this.user),prior=row?.state.production_commands?.[id];if(!prior||prior.state!==from)throw Error('STAGE_RECEIPT_CAS_REQUIRED');const next={...prior,...patch};row.state.production_commands[id]=next;await this.store.cas(this.user,row.revision,row.state);return structuredClone(next);}
}
export class MemoryStageReceiptStore {
 constructor(){this.rows=new Map();}
 async get(id){return structuredClone(this.rows.get(id)||null);}
 async claim(id,value){if(this.rows.has(id))return false;this.rows.set(id,structuredClone(value));return true;}
 async record(id,value){if(!['STARTED','WAITING'].includes(this.rows.get(id)?.status))throw Error('STAGE_RECEIPT_CAS_REQUIRED');this.rows.set(id,structuredClone(value));}
 async transition(id,from,patch){const prior=this.rows.get(id);if(!prior||prior.state!==from)throw Error('STAGE_RECEIPT_CAS_REQUIRED');const next={...prior,...structuredClone(patch)};this.rows.set(id,next);return structuredClone(next);}
}

// Ordering, contracts, durable receipts, recovery, budget and semantic events only.
// Provider submissions belong to existing executors. Live startup stays fail closed.
export class LumiV2ExecutionOrchestrator {
 constructor({manager,receipts,materialize,artifactStorage,reviewStore,stagePolicy={},emitProgress=async()=>{},dry_run=false,activation=null,readiness=null,inject=async()=>{}}){Object.assign(this,{manager,receipts,materialize,artifactStorage,reviewStore,stagePolicy,emitProgress,dry_run,activation,readiness,inject});}
 async handleStageResult({episodeId,action,id,result}){
  return handleStageResult({manager:this.manager,episodeId,action,receiptId:id,result,artifactStorage:this.artifactStorage,
   reviewStore:this.reviewStore,policy:this.stagePolicy[action.stage]||{}});
 }
 async handleReview({user,episodeId,requestId}){
  return reconcileStageReview({manager:this.manager,reviewStore:this.reviewStore,user,episodeId,requestId});
 }
 // Same-job completion is independent of permission to create a new paid job.
 // The accepted receipt must exist and bind the exact provider job beforehand.
 async recoverResult({episodeId,actionKey,completedResult,runtime}){
  const state=await this.manager.store.getEpisode(episodeId),prepared=state?.metadata?.generic_v2;
  const action=state?.actions.find(a=>a.key===actionKey);
  if(!prepared||!action||state.status==='CANCELLED')throw Error('RECOVERY_CHECKPOINT_REQUIRED');
  const id=sha256(episodeId+':'+prepared.binding_sha+':'+action.key),receipt=await this.receipts.get(id);
  if(!receipt||!receipt.result?.provider_job_ids?.includes(completedResult.provider_job_id))throw Error('ACCEPTED_PROVIDER_JOB_REQUIRED');
  if(receipt.status==='COMPLETE')return this.handleStageResult({episodeId,action,id,result:receipt.result});
  if(receipt.status!=='WAITING')throw Error('ACCEPTED_RECEIPT_REQUIRED');
  const artifactRuntime={...runtime,receipts:runtime.receipts??this.receipts};
  if(!artifactRuntime.recoverOriginal&&['IMAGE','VIDEO'].includes(action.stage))artifactRuntime.recoverOriginal=ids=>
   recoverSeriesProviderResult({accepted:receipt.result.output,stage:action.stage,apiKey:runtime.apiKey,fetchImpl:runtime.fetchImpl,...ids});
  const result=await executeStage({episode_id:episodeId,stage_id:action.stage,input:{prepared,action,attempt_id:id,
    material:{completed_result:completedResult,artifact_runtime:artifactRuntime}},checkpoint:state,dry_run:this.dry_run});
  await this.receipts.record(id,{...receipt,status:'COMPLETE',result});
  return this.handleStageResult({episodeId,action,id,result});
 }
 async create({user,request,authorizedCeilingUsd=0,diagnostic=false}) {
  if(!this.dry_run){selectLumiCreationProfile({requested:profile.id,activation:this.activation,readiness:this.readiness});if(realExecutorReadiness().status!=='PASS')throw Error('REAL_EXECUTOR_BINDINGS_INCOMPLETE');}
  const prepared=prepareGenericV2Episode(request),old=await this.manager.store.getEpisode(prepared.episode_id);
  if(old&&old.metadata.generic_v2.binding_sha!==prepared.binding_sha)throw Error('GENERIC_EPISODE_INPUT_IMMUTABLE');
  await this.manager.startEpisode({episodeId:prepared.episode_id,actions:prepared.actions,authorizedCeilingUsd,metadata:{generic_v2:prepared,user,dry_run:this.dry_run,diagnostic,episode_ledger:{currency:'USD',entries:{},provider_units:[]}}});
  return {status:'PREPARED',episode_id:prepared.episode_id,provider_calls:0};
 }
 async resume({episodeId}) {
  if(!this.dry_run){selectLumiCreationProfile({requested:profile.id,activation:this.activation,readiness:this.readiness});if(realExecutorReadiness().status!=='PASS')throw Error('REAL_EXECUTOR_BINDINGS_INCOMPLETE');}
  const state=await this.manager.store.getEpisode(episodeId),prepared=state?.metadata?.generic_v2;
  if(!prepared||prepared.profile_sha!==PROFILE_SHA)throw Error('GENERIC_CHECKPOINT_BINDING_REQUIRED');
  if(state.status==='PAUSED_INCIDENT'||state.status==='CANCELLED')return {status:state.status,provider_calls:0};
  const action=state.actions.find(a=>a.key===state.first_pending_action);if(!action)return {status:'WAITING_FINAL_REVIEW',provider_calls:0};
  const id=sha256(episodeId+':'+prepared.binding_sha+':'+action.key),receipt=await this.receipts.get(id);
  if(receipt?.status==='COMPLETE')return this.commit(episodeId,action,id,receipt.result,receipt.quote);
  if(receipt&&action.stage==='TTS'&&!this.dry_run){
   const material=await this.materialize({prepared,action,state,dry_run:this.dry_run});
   // The inner durable TTS claim determines polling/recovery; never reset it.
   const result=await executeStage({episode_id:episodeId,stage_id:action.stage,input:{prepared,action,material,attempt_id:id},profile,checkpoint:state,dry_run:this.dry_run});
   await this.receipts.record(id,{status:result.status==='IN_PROGRESS'?'WAITING':'COMPLETE',result,quote:receipt.quote});
   return result.status==='IN_PROGRESS'?result:this.commit(episodeId,action,id,result,receipt.quote);
  }
  if(receipt){await this.manager.pause({episodeId,stage:action.stage,errorClass:'EMISSION_AMBIGUOUS',reason:'Stage claim exists without a committed receipt; inspect before any redispatch',firstPendingAction:action.key,safeResumeAvailable:false});return {status:'EMISSION_AMBIGUOUS',provider_calls:0};}
  const shot=prepared.shot_plans.find(s=>s.shot_id===action.scene_id),material=await this.materialize({prepared,action,shot,state,dry_run:this.dry_run});
  if(paid.has(action.stage)){
   if(material.quote?.currency!=='USD'||!Number.isFinite(material.quote.usd)||material.quote.usd<0)throw Error('CURRENT_USD_QUOTE_REQUIRED');
   const reserve=usd(material.required_remaining_reserve_usd??0);
   const gate=await this.manager.budgetGate({episodeId,actionKey:action.key,projectedCallCostUsd:sumUsd([material.quote.usd,reserve])});if(gate.status!=='PASS')return {status:'BUDGET_EXHAUSTED',provider_calls:0};
  }
  await this.inject({stage:action.stage,point:'BEFORE_SIDE_EFFECT'});
  if(!await this.receipts.claim(id,{status:'STARTED',episode_id:episodeId,stage_id:action.stage,action_key:action.key,profile_sha:PROFILE_SHA}))return {status:'CLAIM_ALREADY_EXISTS',provider_calls:0};
  await this.manager.checkpoint(episodeId,d=>{d.actions.find(a=>a.key===action.key).dispatch_state='DISPATCHING';});
  await this.emitProgress({event:PROGRESS_EVENTS[action.stage][0],episode_id:episodeId,stage_id:action.stage,action_key:action.key,checkpoint:await this.manager.store.getEpisode(episodeId)});
  await this.inject({stage:action.stage,point:'DURING_SIDE_EFFECT'});
  await this.inject({stage:action.stage,point:'EXECUTOR_ENTERED'});
  let result;
  try{result=await executeStage({episode_id:episodeId,stage_id:action.stage,input:{prepared,action,shot,material,attempt_id:id},profile,checkpoint:state,dry_run:this.dry_run});}
  catch(error){await this.manager.pause({episodeId,stage:action.stage,errorClass:'QUALITY_REVIEW_REQUIRED',reason:error.message,firstPendingAction:action.key,safeResumeAvailable:false});await this.emitProgress({event:'INCIDENT_PAUSED',episode_id:episodeId,stage_id:action.stage,checkpoint:await this.manager.store.getEpisode(episodeId)});throw error;}
  // Only a durable result receipt can prove completion across checkpoint loss.
  await this.inject({stage:action.stage,point:'AFTER_SIDE_EFFECT_BEFORE_RECEIPT'});
  if(['WAITING_HUMAN_SHOT_REVIEW','WAITING_FINAL_REVIEW','REPAIR_PLAN_REQUIRED','REQUEST_ACCEPTED','IN_PROGRESS'].includes(result.status)){
   await this.receipts.record(id,{status:'WAITING',result,quote:material.quote??null});
   return {...result,provider_calls:0};
  }
  await this.receipts.record(id,{status:'COMPLETE',result,quote:material.quote??null});
  await this.inject({stage:action.stage,point:'AFTER_RECEIPT_BEFORE_CHECKPOINT'});
  return this.commit(episodeId,action,id,result,material.quote);
 }
 async commit(episodeId,action,id,result,quote=null){
  if(!this.dry_run)return this.handleStageResult({episodeId,action,id,result});
  await this.manager.checkpoint(episodeId,d=>{
   const a=d.actions.find(a=>a.key===action.key);a.status='COMPLETE';a.dispatch_state='LOCAL_COMPLETE';a.artifact={stage_receipt:id,dry_run:true};a.evidence={provider_succeeded:true,artifact_persisted:true,sha_verified:true,artifact_verified:true,dry_receipt_only:true};
   d.metadata.episode_ledger.entries[action.key]={category:action.stage,confirmed_usd:0,estimate_usd:quote?.usd??null,provider_units:quote?.provider_units??null,scope:'DRY_ONLY'};
   d.metadata.stage_outputs||={};d.metadata.stage_outputs[action.key]=result;
  });
  await this.emitProgress({event:PROGRESS_EVENTS[action.stage][1],episode_id:episodeId,stage_id:action.stage,action_key:action.key,checkpoint:await this.manager.store.getEpisode(episodeId)});
  return {status:'DRY_STAGE_COMPLETE',completed_action:action.key,provider_calls:0};
 }
}
