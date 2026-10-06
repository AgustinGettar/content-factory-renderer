import {sha256} from './telegram-review-v1/core.js';
import {sumUsd,usd} from './higgsfield-usd-budget-v1.js';

export const STAGE_RESULT_OUTCOMES=Object.freeze(['SUCCEEDED','SUCCEEDED_WITH_WARNING','HUMAN_REVIEW_REQUIRED',
  'FAILED_RETRYABLE_LOCAL','FAILED_PROVIDER_TERMINAL','EMISSION_AMBIGUOUS','BUDGET_EXHAUSTED','CANCELED','IN_PROGRESS']);
const mediaStages=new Set(['IMAGE','VIDEO','TTS','ASSEMBLY','MASTER']);
const successful=new Set(['SUCCEEDED','SUCCEEDED_WITH_WARNING']);
const incidentClass={FAILED_RETRYABLE_LOCAL:'ARTIFACT_STORAGE_FAILURE',FAILED_PROVIDER_TERMINAL:'PROVIDER_API_FAILURE',
  EMISSION_AMBIGUOUS:'EMISSION_AMBIGUOUS',BUDGET_EXHAUSTED:'BUDGET_EXHAUSTED',HUMAN_REVIEW_REQUIRED:'QUALITY_REVIEW_REQUIRED'};

export function validateStageResult(result,episodeId,stageId){
  if(!result||!STAGE_RESULT_OUTCOMES.includes(result.status)||result.episode_id!==episodeId||result.stage_id!==stageId
    ||!Array.isArray(result.artifacts)||!Array.isArray(result.provider_job_ids)||!Array.isArray(result.claims))throw Error('NORMALIZED_STAGE_RESULT_REQUIRED');
  if(successful.has(result.status)&&mediaStages.has(stageId)&&!result.artifacts.length)throw Error('STAGE_MEDIA_ARTIFACT_REQUIRED');
  const ids=new Set();
  for(const a of result.artifacts){
    if(!a.artifact_id||ids.has(a.artifact_id)||!/^[a-f0-9]{64}$/.test(a.sha256)||a.episode_id!==episodeId
      ||!a.bucket||!a.path||a.path.startsWith('/')||a.path.includes('..')||!Number.isSafeInteger(a.size)||a.size<=0)throw Error('STAGE_ARTIFACT_BINDING_INVALID');
    ids.add(a.artifact_id);
  }
  return result;
}

// Invoked only by the existing orchestrator, including recovery receipt replay.
// Persist artifacts/QA first. All transitions are derived from durable evidence.
export async function handleStageResult({manager,episodeId,action,receiptId,result,artifactStorage,reviewStore,
  policy={},localRepair,dispatchNext,authorizeNext}){
  validateStageResult(result,episodeId,action.stage);
  let state=await manager.store.getEpisode(episodeId);
  if(!state||!state.actions.some(a=>a.key===action.key&&a.stage===action.stage))throw Error('STAGE_CHECKPOINT_REQUIRED');
  if(state.status==='CANCELLED')return {status:'CANCELED',provider_calls:0};
  const digest=sha256(JSON.stringify(result)),prior=state.metadata.stage_results?.[action.key];
  if(prior&&prior.receipt_id!==receiptId)throw Error('STAGE_RESULT_RECEIPT_IMMUTABLE');
  if(prior&&prior.sha256!==digest)throw Error('STAGE_RESULT_IMMUTABLE');
  const existing=state.actions.find(a=>a.key===action.key);
  if(existing.status==='COMPLETE')return {status:'STAGE_COMPLETE',completed_action:action.key,first_pending_action:state.first_pending_action,provider_calls:0};
  // Read canonical bytes even when an executor reports persisted=true. Do not trust a URL or boolean.
  for(const a of result.artifacts){
    if(!artifactStorage?.download)throw Error('GENERIC_ARTIFACT_STORAGE_REQUIRED');
    const bytes=Buffer.from(await artifactStorage.download(a.bucket,a.path));
    if(bytes.length!==a.size||sha256(bytes)!==a.sha256)throw Error('ARTIFACT_HASH_MISMATCH');
  }
  const qaPass=!mediaStages.has(action.stage)||result.qa?.ok===true;
  const needsReview=result.status==='HUMAN_REVIEW_REQUIRED'||successful.has(result.status)&&(result.human_review_requirement===true
    ||result.status==='SUCCEEDED_WITH_WARNING'&&policy.advance_with_warning!==true||!qaPass);
  const advance=successful.has(result.status)&&qaPass&&!needsReview;
  const status=needsReview?'HUMAN_REVIEW_REQUIRED':result.status;
  if(status==='CANCELED')await manager.stopRunner({episodeId,stage:action.stage});
  state=await manager.checkpoint(episodeId,d=>{
    d.metadata.stage_results||={};d.metadata.stage_results[action.key]={receipt_id:receiptId,sha256:digest,result};
    d.metadata.stage_outputs||={};d.metadata.stage_outputs[action.key]=result;
    d.metadata.artifacts||={};for(const a of result.artifacts){
      const old=d.metadata.artifacts[a.artifact_id];if(old&&old.sha256!==a.sha256)throw Error('ARTIFACT_ID_IMMUTABLE');
      d.metadata.artifacts[a.artifact_id]=a;
    }
    d.metadata.stage_qa||={};d.metadata.stage_qa[action.key]=result.qa;
    const a=d.actions.find(x=>x.key===action.key);
    a.provider_request_id=result.provider_job_ids[0]??a.provider_request_id;
    a.artifact=result.artifacts[0]??{stage_receipt:receiptId};
    a.dispatch_state=result.provider_job_ids.length?'RESULT_RECOVERED':'LOCAL_COMPLETE';
    a.status=advance?'COMPLETE':status;
    a.evidence=advance?{provider_succeeded:true,artifact_persisted:true,sha_verified:true,artifact_verified:true}:{};
    if(status==='EMISSION_AMBIGUOUS')a.dispatch_state='EMISSION_AMBIGUOUS';
    d.metadata.episode_ledger||={currency:'USD',entries:{}};
    d.metadata.episode_ledger.entries||={};
    const ledger=d.metadata.episode_ledger.entries;
    ledger[action.key]={estimated_cost:result.estimated_cost??null,actual_cost:result.actual_cost??null,
      // Estimate remains a reservation until actual USD is exposed.
      reserved_usd:result.actual_cost?.currency==='USD'?usd(result.actual_cost.usd):result.estimated_cost?.currency==='USD'?usd(result.estimated_cost.usd):0};
    d.current_cost_usd=sumUsd(Object.values(ledger).map(x=>x.reserved_usd??x.confirmed_usd??0));
    if(status==='CANCELED'){d.status='CANCELLED';d.runner_enabled=false;d.autorun=false;}
    if(needsReview){
      d.metadata.review_requests||={};
      const a=result.artifacts[0];if(!a)throw Error('REVIEW_ARTIFACT_REQUIRED');
      const id=sha256(JSON.stringify([episodeId,action.key,a.artifact_id,a.sha256]));
      const old=d.metadata.review_requests[id];
      d.metadata.review_requests[id]=old??{review_request_id:id,episode_id:episodeId,stage_id:action.stage,action_key:action.key,
        artifact_id:a.artifact_id,artifact_sha:a.sha256,review_version:1,status:'PENDING',reason:result.error_classification||'QA_WARNING',allowed_actions:['APPROVE','REJECT']};
    }
  });
  if(needsReview){
    const request=Object.values(state.metadata.review_requests).find(r=>r.action_key===action.key&&r.status==='PENDING');
    if(reviewStore){const row=await reviewStore.get(state.metadata.user),e=row?.state.episodes?.[episodeId];if(!e)throw Error('GENERIC_REVIEW_EPISODE_REQUIRED');
      e.review_requests||={};const old=e.review_requests[request.review_request_id];
      if(old&&old.artifact_sha!==request.artifact_sha)throw Error('REVIEW_ARTIFACT_IMMUTABLE');
      e.review_requests[request.review_request_id]=old??request;await reviewStore.cas(state.metadata.user,row.revision,row.state);
    }
  }
  if(incidentClass[status]){
    if(!state.active_incident_id)await manager.pause({episodeId,stage:action.stage,errorClass:incidentClass[status],
      reason:result.error_classification||status,providerRequestId:result.provider_job_ids[0],firstPendingAction:action.key,
      safeResumeAvailable:status==='FAILED_RETRYABLE_LOCAL',retryability:status==='EMISSION_AMBIGUOUS'?'RECONCILE_HUMAN_ONLY':'INSPECT_FIRST'});
    // This callback can only be supplied by policy; no provider repair is inferred.
    if(status==='FAILED_RETRYABLE_LOCAL'&&policy.deterministic_local_repair===true&&localRepair){
      return localRepair({episodeId,action,result,allow_provider_calls:false});
    }
    return {status,first_pending_action:(await manager.store.getEpisode(episodeId)).first_pending_action,provider_calls:0};
  }
  if(!advance)return {status,first_pending_action:state.first_pending_action,provider_calls:0};
  if(dispatchNext&&authorizeNext&&await authorizeNext(state))return dispatchNext({episodeId,action_key:state.first_pending_action});
  return {status:'STAGE_COMPLETE',completed_action:action.key,first_pending_action:state.first_pending_action,provider_calls:0};
}

// Recovery Manager consumes the authenticated, already-persisted decision. It does
// not reinterpret a callback or authorize replacement generation.
export async function reconcileStageReview({manager,reviewStore,user,episodeId,requestId}){
  const row=await reviewStore.get(user),e=row?.state.episodes?.[episodeId],review=e?.review_requests?.[requestId];
  if(!review||!['APPROVED','REJECTED'].includes(review.status)||!review.human_decision?.callback_query_id)throw Error('AUTHENTIC_GENERIC_REVIEW_REQUIRED');
  const state=await manager.store.getEpisode(episodeId),bound=state?.metadata.review_requests?.[requestId];
  if(!bound||state.metadata.user!==user||review.artifact_sha!==bound.artifact_sha||review.artifact_id!==bound.artifact_id
    ||review.review_version!==bound.review_version||review.stage_id!==bound.stage_id)throw Error('STALE_GENERIC_REVIEW');
  if(bound.status===review.status)return {status:review.status,provider_calls:0};
  const stored=state.metadata.artifacts?.[bound.artifact_id];if(stored?.sha256!==bound.artifact_sha)throw Error('STALE_REVIEW_ARTIFACT');
  if(state.status==='CANCELLED')return {status:'CANCELED',provider_calls:0};
  if(review.status==='REJECTED'){
    await manager.checkpoint(episodeId,d=>{d.metadata.review_requests[requestId]=review;d.metadata.repair_plan_required=true;});
    return {status:'REPAIR_PLAN_REQUIRED',provider_calls:0};
  }
  // A human cannot turn corrupt/missing bytes into a technically valid artifact.
  const result=state.metadata.stage_results[bound.action_key]?.result;
  if(mediaStages.has(bound.stage_id)&&result?.qa?.ok!==true)throw Error('TECHNICAL_QA_REPAIR_REQUIRED');
  const incident=state.active_incident_id?await manager.store.getIncident(state.active_incident_id):null;
  if(incident&&(incident.error_class!=='QUALITY_REVIEW_REQUIRED'||incident.first_pending_action!==bound.action_key))throw Error('UNRELATED_INCIDENT_PRESERVED');
  await manager.checkpoint(episodeId,d=>{
    d.metadata.review_requests[requestId]=review;const a=d.actions.find(a=>a.key===bound.action_key);
    a.status='COMPLETE';a.evidence={provider_succeeded:true,artifact_persisted:true,sha_verified:true,artifact_verified:true};
  });
  if(incident){
    await manager.store.putIncident({...incident,status:'RESOLVED',resolved_at:new Date().toISOString(),retryability:'AUTHENTIC_HUMAN_REVIEW'});
  }
  const next=await manager.checkpoint(episodeId,d=>{d.active_incident_id=null;d.status='RUNNING';d.runner_enabled=false;});
  return {status:'READY_TO_CONTINUE',first_pending_action:next.first_pending_action,provider_calls:0};
}
