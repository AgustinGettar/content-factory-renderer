import test from 'node:test';
import assert from 'node:assert/strict';
import {handleStageResult,reconcileStageReview} from '../lib/lumi-stage-result-v2.js';
import {MemoryLumiRecoveryStore,LumiRecoveryIncidentManager} from '../lib/lumi-recovery-incident-manager-v1.js';
import {MemoryReviewStore,newSession,sha256,ReviewService,renderTelegramPanel,reviewGate} from '../lib/telegram-review-v1/core.js';
import {HOME_ASSET} from '../lib/telegram-review-v1/home-asset.js';
const episodeId='ep_independent_audio',action={key:'tts',stage:'TTS'};
async function fixture(status='SUCCEEDED'){
  const manager=new LumiRecoveryIncidentManager({store:new MemoryLumiRecoveryStore()}),reviewStore=new MemoryReviewStore();
  await manager.startEpisode({episodeId,actions:[action,{key:'captions',stage:'CAPTIONS'}],authorizedCeilingUsd:1,metadata:{user:'1'}});
  const session=newSession({user_id:'1',chat_id:'1',message_id:138,cover:HOME_ASSET});
  session.episodes[episodeId]={episode_id:episodeId,title:'Escucha',shots:[],review_mode:'SUPERVISED'};await reviewStore.create('1',session);
  const bytes=Buffer.from('fixture'),artifact={artifact_id:'audio',episode_id:episodeId,sha256:sha256(bytes),bucket:'generated-audio',path:'future/narration.mp3',size:bytes.length,mime:'audio/mpeg'};
  const result={status,episode_id:episodeId,stage_id:'TTS',artifacts:[artifact],provider_job_ids:['one-job'],claims:['one-claim'],qa:{ok:true,status:status==='SUCCEEDED_WITH_WARNING'?'WARNING':'PASS'},estimated_cost:{currency:'USD',usd:.2},actual_cost:null,human_review_requirement:false};
  return {manager,reviewStore,result,args:{manager,reviewStore,episodeId,action,receiptId:'receipt-one',result,artifactStorage:{download:async()=>bytes}}};
}
for(const status of ['SUCCEEDED','SUCCEEDED_WITH_WARNING','HUMAN_REVIEW_REQUIRED','FAILED_RETRYABLE_LOCAL','FAILED_PROVIDER_TERMINAL','EMISSION_AMBIGUOUS','BUDGET_EXHAUSTED','CANCELED'])test('continuation outcome '+status,async()=>{
  const f=await fixture(status);let dispatched=0;const r=await handleStageResult({...f.args,dispatchNext:async()=>{dispatched++;}}),state=await f.manager.store.getEpisode(episodeId);
  assert.equal(dispatched,0);assert.equal(state.metadata.artifacts.audio.sha256,f.result.artifacts[0].sha256);assert.deepEqual(state.metadata.stage_qa.tts,f.result.qa);
  if(status==='SUCCEEDED'){assert.equal(r.first_pending_action,'captions');assert.equal(state.last_completed_action,'tts');}
  else if(status==='CANCELED')assert.equal(state.status,'CANCELLED');
  else {assert.equal(state.first_pending_action,'tts');assert.equal(state.status,'PAUSED_INCIDENT');}
});
test('warning policy, immutable result and cost replay do not double account',async()=>{
  const f=await fixture('SUCCEEDED_WITH_WARNING');const args={...f.args,policy:{advance_with_warning:true}};
  assert.equal((await handleStageResult(args)).status,'STAGE_COMPLETE');await handleStageResult(args);
  const budgetState=await f.manager.store.getEpisode(episodeId);
  assert.equal(budgetState.current_cost_usd,0);assert.equal(budgetState.metadata.budget_reservations.tts.amount_usd,.2);
  await assert.rejects(handleStageResult({...args,result:{...f.result,actual_cost:{currency:'USD',usd:.3}}}),/IMMUTABLE/);
});
test('JSONB key reordering preserves exact StageResult content while changed QA stays rejected',async()=>{
 const f=await fixture();await handleStageResult(f.args);
 const reorder=v=>Array.isArray(v)?v.map(reorder):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).reverse().map(([k,x])=>[k,reorder(x)])):v;
 const persisted=reorder(JSON.parse(JSON.stringify(f.result)));
 assert.equal((await handleStageResult({...f.args,result:persisted})).status,'STAGE_COMPLETE');
 const state=await f.manager.store.getEpisode(episodeId),prior=state.metadata.stage_results.tts;
 // Records written before canonical hashing retain their exact persisted content.
 prior.sha256=sha256(JSON.stringify(f.result));delete prior.hash_version;prior.result=persisted;
 await f.manager.store.putEpisode(state);
 assert.equal((await handleStageResult({...f.args,result:persisted})).status,'STAGE_COMPLETE');
 await assert.rejects(handleStageResult({...f.args,result:{...persisted,qa:{...persisted.qa,ok:false}}}),/IMMUTABLE/);
 const budgetState=await f.manager.store.getEpisode(episodeId);
  assert.equal(budgetState.current_cost_usd,0);assert.equal(budgetState.metadata.budget_reservations.tts.amount_usd,.2);
});
test('hash tampering and QA failure cannot advance even with succeeded status',async()=>{
  const f=await fixture();await assert.rejects(handleStageResult({...f.args,artifactStorage:{download:async()=>Buffer.from('tampered')}}),/HASH/);
  assert.equal((await f.manager.store.getEpisode(episodeId)).first_pending_action,'tts');
  f.result.qa={ok:false,status:'FAIL'};assert.equal((await handleStageResult(f.args)).status,'HUMAN_REVIEW_REQUIRED');
});
test('deterministic repair is policy-authorized and explicitly has zero provider allowance',async()=>{
  const f=await fixture('FAILED_RETRYABLE_LOCAL');let calls=0;const localRepair=async({allow_provider_calls})=>{calls++;assert.equal(allow_provider_calls,false);return {status:'LOCAL_REPAIR_REQUESTED'};};
  await handleStageResult({...f.args,localRepair});assert.equal(calls,0);
  assert.equal((await handleStageResult({...f.args,localRepair,policy:{deterministic_local_repair:true}})).status,'LOCAL_REPAIR_REQUESTED');assert.equal(calls,1);
});
test('generic review renders in canonical panel, callback binds SHA/version and Recovery Manager advances',async()=>{
  const f=await fixture('SUCCEEDED_WITH_WARNING');await handleStageResult(f.args);
  let row=await f.reviewStore.get('1'),request=Object.values(row.state.episodes[episodeId].review_requests)[0];
  const view=renderTelegramPanel(row.state,{kind:'review',episode_id:episodeId,request_id:request.review_request_id});
  assert.equal(view.panel_state,'AUDIO_REVIEW');assert.equal(view.artifact.sha256,f.result.artifacts[0].sha256);
  row.state.tokens=view.tokens;await f.reviewStore.cas('1',row.revision,row.state);
  let deliveries=0;const service=new ReviewService({store:f.reviewStore,validateOwner:async()=>true,telegram:{call:async()=>{deliveries++;}},
    production:{reviewed:async({user,episodeId,requestId})=>reconcileStageReview({manager:f.manager,reviewStore:f.reviewStore,user,episodeId,requestId})}});
  service.show=async()=>({status:'RENDERED_TEST_ONLY'});
  const token=Object.entries(view.tokens).find(([,t])=>t.action==='approve_stage')[0];
  const cb={id:'synthetic-test-callback',from:{id:'1'},message:{message_id:138,chat:{id:'1'}},data:'lr:'+token};
  await service.callback(cb);assert.equal((await f.manager.store.getEpisode(episodeId)).first_pending_action,'captions');
  await service.callback(cb);assert.equal((await f.reviewStore.get('1')).state.reviews.length,1);assert.equal(deliveries,2);
});
test('stale version is rejected before persisting a generic human decision',async()=>{
  const f=await fixture('HUMAN_REVIEW_REQUIRED');await handleStageResult(f.args);
  const row=await f.reviewStore.get('1'),request=Object.values(row.state.episodes[episodeId].review_requests)[0];
  const view=renderTelegramPanel(row.state,{kind:'review',episode_id:episodeId,request_id:request.review_request_id});row.state.tokens=view.tokens;
  row.state.episodes[episodeId].review_requests[request.review_request_id].review_version++;await f.reviewStore.cas('1',row.revision,row.state);
  const service=new ReviewService({store:f.reviewStore,validateOwner:async()=>true,telegram:{call:async()=>{}},production:{reviewed:async()=>{throw Error('MUST_NOT_REACH');}}});
  const token=Object.entries(view.tokens).find(([,t])=>t.action==='approve_stage')[0];
  await assert.rejects(service.callback({id:'test-stale',from:{id:'1'},message:{message_id:138,chat:{id:'1'}},data:'lr:'+token}),/stale_generic_review/);
  assert.deepEqual((await f.reviewStore.get('1')).state.reviews,[]);
});
test('rejection preserves artifacts, creates repair plan requirement and never dispatches',async()=>{
  const f=await fixture('HUMAN_REVIEW_REQUIRED');await handleStageResult(f.args);
  const row=await f.reviewStore.get('1'),r=Object.values(row.state.episodes[episodeId].review_requests)[0];
  r.status='REJECTED';r.human_decision={callback_query_id:'TEST_ONLY'};await f.reviewStore.cas('1',row.revision,row.state);
  assert.equal((await reconcileStageReview({manager:f.manager,reviewStore:f.reviewStore,user:'1',episodeId,requestId:r.review_request_id})).status,'REPAIR_PLAN_REQUIRED');
  const s=await f.manager.store.getEpisode(episodeId);assert.equal(s.status,'PAUSED_INCIDENT');assert.equal(s.first_pending_action,'tts');assert.equal(s.metadata.repair_plan_required,true);
});

test('actual charge replaces estimate; a provider overrun preserves the charge and pauses',async()=>{
 const f=await fixture();f.result.actual_cost={currency:'USD',usd:1.1};
 await handleStageResult(f.args);await handleStageResult(f.args);
 const s=await f.manager.store.getEpisode(episodeId);
 assert.equal(s.current_cost_usd,1.1);assert.deepEqual(s.metadata.budget_reservations,{});
 assert.equal(s.metadata.budget_exhausted,true);assert.equal(s.status,'PAUSED_INCIDENT');assert.equal(s.authorized_ceiling_usd,1);
});

test('SUPERVISED_REPLACEMENT_COST: recovered actual charge reconciles only new reservation; original risk and human review remain',async()=>{
 const f=await fixture('HUMAN_REVIEW_REQUIRED'),original={amount_usd:.3,attempt_id:'ambiguous-original',status:'RESERVED_UNTIL_ACTUAL_CHARGE_VERIFIED'};
 await f.manager.checkpoint(episodeId,d=>{
  d.actions[0].active_attempt_id='one-claim';d.metadata.budget_reservations={tts:original,'replacement:one-claim':{amount_usd:.25,attempt_id:'one-claim'}};
  d.metadata.supervised_replacement_activity={'one-claim':{original_attempt_id:'ambiguous-original',reservation_key:'replacement:one-claim'}};
 });
 f.result.actual_cost={currency:'USD',usd:.2};await handleStageResult(f.args);
 const cp=await f.manager.store.getEpisode(episodeId);
 assert.deepEqual(cp.metadata.budget_reservations.tts,original);assert.equal(cp.metadata.budget_reservations['replacement:one-claim'],undefined);
 assert.equal(cp.current_cost_usd,.2);assert.equal(cp.first_pending_action,'tts');assert.equal(cp.actions[0].status,'HUMAN_REVIEW_REQUIRED');
 assert.equal(Object.values(cp.metadata.review_requests)[0].status,'PENDING');
});

test('Q42_REAL_RECEIPT_SHAPE: acknowledged replacement with saved artifact reconciles once without changing either reservation',async()=>{
 const f=await fixture('SUCCEEDED');f.result.human_review_requirement=true;
 f.result.estimated_cost={currency:'USD',estimate_usd:.276,reserve_usd:.345,quote_id:'persisted-quote'};
 const reservations={tts:{amount_usd:.3275,attempt_id:'ambiguous-original'},'replacement:one-claim':{amount_usd:.345,attempt_id:'one-claim'}};
 await f.manager.checkpoint(episodeId,d=>{
  d.actions[0].active_attempt_id='one-claim';d.actions[0].dispatch_state='DISPATCHING';
  d.metadata.budget_reservations=structuredClone(reservations);
  d.metadata.supervised_replacement_activity={'one-claim':{original_attempt_id:'ambiguous-original',reservation_key:'replacement:one-claim'}};
 });
 assert.equal((await handleStageResult(f.args)).status,'HUMAN_REVIEW_REQUIRED');
 assert.equal((await handleStageResult(f.args)).status,'HUMAN_REVIEW_REQUIRED');
 const cp=await f.manager.store.getEpisode(episodeId);
 assert.deepEqual(cp.metadata.budget_reservations,reservations);assert.equal(cp.current_cost_usd,0);
 assert.equal(cp.metadata.episode_ledger.entries.tts.reserved_usd,.345);
 assert.equal(Object.keys(cp.metadata.review_requests).length,1);
 assert.equal(cp.actions[0].status,'HUMAN_REVIEW_REQUIRED');assert.equal(cp.first_pending_action,'tts');
});
