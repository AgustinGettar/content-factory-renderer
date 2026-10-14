import test from 'node:test';
import assert from 'node:assert/strict';
import {runtimeFixture} from './fixtures/generic-runtime-v2.js';
import {ReviewStageReceiptStore} from '../lib/lumi-v2-execution-orchestrator.js';
import {claimRequest} from '../lib/telegram-review-v1/make-transport.js';
import {sha256} from '../lib/telegram-review-v1/core.js';
import {mountMakeTransportEndpoint} from '../lib/telegram-review-v1/make-endpoint.js';
import {signRequest} from '../lib/telegram-review-v1/make-transport.js';
import {fixtureSecret} from './fixtures/generic-runtime-v2.js';

const nonce=id=>({timestamp:String(Math.floor(Date.now()/1000)),requestId:id,path:'/test',body:Buffer.from('{}')});
async function pendingSource(options){
 const f=await runtimeFixture(options),grant=await f.reviewStore.get('1');
 grant.state.v2_authorizations.controlled.dry_run=false;grant.state.v2_authorizations.controlled.provider_generation=false;
 await f.reviewStore.cas('1',grant.revision,grant.state);
 await f.create();await f.production.resume({user:'1',episodeId:f.episodeId,expectedAction:'planning'});
 const row=await f.reviewStore.get('1');row.state.pending_callback={id:'original',token:'lr:'+'a'.repeat(24),status:'PENDING',started_at:new Date().toISOString()};
 row.state.tokens['a'.repeat(24)]={action:'resume',episode_id:f.episodeId,next_action:'source-planning'};
 row.state.delivery={status:'DELIVERED'};
 await f.reviewStore.cas('1',row.revision,row.state);
 return f;
}
for(const point of ['claim','record','projection'])test('source-planning survives concurrent webhook nonce at '+point,async()=>{
 const f=await pendingSource();try{
  const cp=await f.store.getEpisode(f.episodeId),id=sha256(f.episodeId+':'+cp.metadata.generic_v2.binding_sha+':source-planning');
  const cas=f.reviewStore.cas.bind(f.reviewStore);let raced=false;
  f.reviewStore.cas=async(u,r,s)=>{
   const receipt=s.production_commands?.[id];
   if(!raced&&(point==='claim'&&receipt?.status==='STARTED'||point==='record'&&receipt?.status==='COMPLETE'||point==='projection'&&s.episodes[f.episodeId].next_action!=='source-planning')){
    raced=true;await claimRequest(f.reviewStore,'1',nonce('following-webhook'));
   }
   return cas(u,r,s);
  };
  await f.production.resume({user:'1',episodeId:f.episodeId,expectedAction:'source-planning'});
  assert.ok(raced);const after=await f.store.getEpisode(f.episodeId),s=(await f.reviewStore.get('1')).state;
  assert.equal(after.actions.find(a=>a.key==='source-planning').status,'COMPLETE');
  assert.equal(s.production_commands[id].status,'COMPLETE');assert.ok(s.make_requests['following-webhook']);
  assert.notEqual(after.first_pending_action,'source-planning');
  assert.deepEqual(f.counters(),{providerCalls:0,uploads:0});
 }finally{await f.cleanup();}
});

test('pending production recovery completes only source-planning; repeated recovery does not dispatch next stage',async()=>{
 const f=await pendingSource();try{
  const before=await f.store.getEpisode(f.episodeId);
  const r=await f.production.recoverPendingResume({user:'1',chat:'1'});
  assert.equal(r.status,'PRODUCTION_RECOVERED');assert.equal(r.completed_action,'source-planning');
  const after=await f.store.getEpisode(f.episodeId),s=(await f.reviewStore.get('1')).state;
  assert.equal(after.last_completed_action,'source-planning');assert.equal(s.pending_callback,null);
  assert.equal(s.applied['callback:original'].status,'RECOVERED');assert.equal(s.message_id,138);
  assert.equal(after.authorized_ceiling_usd,before.authorized_ceiling_usd);
  for(const [key,value] of Object.entries(before.metadata.episode_ledger.entries))assert.deepEqual(after.metadata.episode_ledger.entries[key],value);
  assert.equal(after.metadata.episode_ledger.entries['source-planning'].reserved_usd,0);
  assert.equal(after.metadata.episode_ledger.entries['source-planning'].confirmed_usd,0);
  assert.deepEqual(after.metadata.episode_ledger.provider_units,before.metadata.episode_ledger.provider_units);
  assert.equal((await f.production.recoverPendingResume({user:'1',chat:'1'})).status,'NO_PENDING_PRODUCTION');
  assert.deepEqual(await f.store.getEpisode(f.episodeId),after);assert.deepEqual(f.counters(),{providerCalls:0,uploads:0});
 }finally{await f.cleanup();}
});

test('double recovery shares the existing atomic stage claim and never runs source-planning twice',async()=>{
 let executions=0;const f=await pendingSource({inject:async e=>{if(e.stage==='SOURCE_PLANNING'&&e.point==='EXECUTOR_ENTERED')executions++;}});try{
  await Promise.allSettled([f.production.recoverPendingResume({user:'1',chat:'1'}),f.production.recoverPendingResume({user:'1',chat:'1'})]);
  assert.equal(executions,1);assert.equal((await f.store.getEpisode(f.episodeId)).actions.find(a=>a.key==='source-planning').status,'COMPLETE');
  assert.equal((await f.reviewStore.get('1')).state.pending_callback,null);assert.equal(f.counters().providerCalls,0);
 }finally{await f.cleanup();}
});

test('crash after result receipt recovers checkpoint without reexecuting source-planning',async()=>{
 let crash=true,executions=0;
 const f=await pendingSource({inject:async e=>{if(e.stage!=='SOURCE_PLANNING')return;if(e.point==='EXECUTOR_ENTERED')executions++;
  if(crash&&e.point==='AFTER_RECEIPT_BEFORE_CHECKPOINT'){crash=false;throw Error('SIMULATED_PROCESS_CRASH');}}});try{
  await assert.rejects(f.production.recoverPendingResume({user:'1',chat:'1'}),/SIMULATED_PROCESS_CRASH/);
  assert.ok((await f.reviewStore.get('1')).state.pending_callback);
  assert.equal((await f.production.recoverPendingResume({user:'1',chat:'1'})).status,'PRODUCTION_RECOVERED');
  assert.equal(executions,1);assert.equal(f.counters().providerCalls,0);
 }finally{await f.cleanup();}
});

for(const fault of ['ambiguous_receipt','paid_stage','pending_delivery','expired_grant','checkpoint_CAS'])test('pending recovery fails closed: '+fault,async()=>{
 const f=await pendingSource();try{
  const cp=await f.store.getEpisode(f.episodeId),row=await f.reviewStore.get('1');
  const id=sha256(f.episodeId+':'+cp.metadata.generic_v2.binding_sha+':source-planning');
  if(fault==='ambiguous_receipt'){row.state.production_commands[id]={status:'STARTED'};}
  if(fault==='paid_stage')row.state.tokens['a'.repeat(24)].next_action=cp.actions.find(a=>a.stage==='IMAGE').key;
  if(fault==='pending_delivery')row.state.delivery.status='EMITTING';
  if(fault==='expired_grant')row.state.v2_authorizations.controlled.expires_at='2000-01-01T00:00:00Z';
  await f.reviewStore.cas('1',row.revision,row.state);
  if(fault==='checkpoint_CAS')f.store.casGenericEpisode=async()=>null;
  await assert.rejects(f.production.recoverPendingResume({user:'1',chat:'1'}));
  assert.deepEqual(await f.store.getEpisode(f.episodeId),cp);assert.ok((await f.reviewStore.get('1')).state.pending_callback);
  assert.deepEqual(f.counters(),{providerCalls:0,uploads:0});
 }finally{await f.cleanup();}
});

test('receipt result is immutable when another writer records a different result',async()=>{
 const f=await pendingSource();try{
  const receipts=new ReviewStageReceiptStore({store:f.reviewStore,user:'1'});await receipts.claim('collision',{status:'STARTED'});
  const cas=f.reviewStore.cas.bind(f.reviewStore);let raced=false;
  f.reviewStore.cas=async(u,r,s)=>{if(!raced){raced=true;const row=await f.reviewStore.get(u);row.state.production_commands.collision={status:'COMPLETE',result:{different:true}};await cas(u,row.revision,row.state);}return cas(u,r,s);};
  await assert.rejects(receipts.record('collision',{status:'COMPLETE',result:{original:true}}),/STAGE_RECEIPT_CAS_REQUIRED/);
  assert.deepEqual((await receipts.get('collision')).result,{different:true});
 }finally{await f.cleanup();}
});

test('newly completed local planning is last completion when q41 was imported ahead of it',async()=>{
 const f=await pendingSource();try{
  let imported;
  await f.manager.checkpoint(f.episodeId,s=>{const a=s.actions.find(a=>a.stage==='IMAGE');a.status='COMPLETE';a.evidence={provider_succeeded:true,artifact_persisted:true,sha_verified:true,artifact_verified:true};a.artifact={sha256:'c963a60e9d35a6258c47ef04968cd7371c31c71d02e40cf75f63740a62efa24b',human_status:'HUMAN_APPROVED'};imported=structuredClone(a);});
  await f.production.recoverPendingResume({user:'1',chat:'1'});
  const cp=await f.store.getEpisode(f.episodeId);assert.equal(cp.last_completed_action,'source-planning');
  assert.equal(cp.actions.find(a=>a.key===cp.first_pending_action).stage,'SOURCE_QA');
  assert.deepEqual(cp.actions.find(a=>a.key===imported.key),imported);
 }finally{await f.cleanup();}
});

test('recovery endpoint requires HMAC, fresh nonce and server-derived action; emits no Telegram commands',async()=>{
 const f=await pendingSource();try{
  const routes=new Map(),path='/lumi/telegram-review/make/v1';
  mountMakeTransportEndpoint({get:()=>{},post:(p,h)=>routes.set(p,h)},{store:f.reviewStore,production:f.production,validateOwner:async()=>true,
   env:{LUMI_RUNTIME_ENV:'staging',LUMI_TELEGRAM_TRANSPORT_AUTHORITY:'MAKE',LUMI_TELEGRAM_REVIEW_TEST_USERS:'1',LUMI_TELEGRAM_CALLBACK_SECRET:fixtureSecret}});
  const body={op:'RECOVER_PENDING_PRODUCTION',user_id:'1',chat_id:'1'};
  const call=async(data,id,bad=false)=>{const signed={...nonce(id),path,body:Buffer.from(JSON.stringify(data))};
   const req={path,body:data,rawBody:signed.body,headers:{'x-lumi-timestamp':signed.timestamp,'x-lumi-request-id':id,'x-lumi-signature':bad?'bad':signRequest(fixtureSecret,signed)}};
   const res={code:200,status(c){this.code=c;return this;},json(v){this.value=v;return this;}};await routes.get(path)(req,res);return res;};
  assert.equal((await call(body,'bad',true)).code,401);
  assert.equal((await call({...body,action:'video:q41'},'arbitrary')).code,409);
  const r=await call(body,'valid');assert.equal(r.code,200);assert.equal(r.value.status,'PRODUCTION_RECOVERED');assert.deepEqual(r.value.commands,[]);assert.deepEqual(r.value.actions,[]);
  assert.equal((await call(body,'valid')).code,409);assert.equal(f.counters().providerCalls,0);
 }finally{await f.cleanup();}
});

test('stage receipt CAS retries are bounded and never reinterpret unexpected errors',async()=>{
 const f=await pendingSource();try{
  const r=new ReviewStageReceiptStore({store:f.reviewStore,user:'1'});let calls=0;
  f.reviewStore.cas=async()=>{calls++;throw Error('concurrent_update');};
  await assert.rejects(r.claim('bounded',{status:'STARTED'}),/concurrent_update/);assert.equal(calls,6);
  calls=0;f.reviewStore.cas=async()=>{calls++;throw Error('UNEXPECTED_BACKEND_ERROR');};
  await assert.rejects(r.claim('unexpected',{status:'STARTED'}),/UNEXPECTED_BACKEND_ERROR/);assert.equal(calls,1);
 }finally{await f.cleanup();}
});
