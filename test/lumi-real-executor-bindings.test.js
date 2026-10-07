import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';
import {runRealExecutorDryGate,createRealExecutorDryFixture,runCrashResumeMatrix} from '../lib/lumi-v2-real-executor-dry-run.js';
import {executeStage,EXECUTOR_BINDING_MATRIX,realExecutorReadiness} from '../lib/lumi-v2-executor-bindings.js';
import {LumiV2ExecutionOrchestrator,MemoryStageReceiptStore,ReviewStageReceiptStore} from '../lib/lumi-v2-execution-orchestrator.js';
import {MemoryLumiRecoveryStore,LumiRecoveryIncidentManager} from '../lib/lumi-recovery-incident-manager-v1.js';
import {MemoryReviewStore,newSession} from '../lib/telegram-review-v1/core.js';
import {HOME_ASSET} from '../lib/telegram-review-v1/home-asset.js';
import {GENERIC_WORKER_STAGES} from '../lib/lumi-generic-v2-adapter.js';
import {ProductionReviewController} from '../lib/telegram-review-v1/production.js';
import {mountMakeTransportEndpoint} from '../lib/telegram-review-v1/make-endpoint.js';
import {signRequest} from '../lib/telegram-review-v1/make-transport.js';

test('exact 14-stage matrix points to executable code and never disguises missing frozen TTS',async()=>{
 assert.deepEqual(EXECUTOR_BINDING_MATRIX.map(r=>r.stage_id),GENERIC_WORKER_STAGES);assert.equal(realExecutorReadiness().bound,14);assert.deepEqual(realExecutorReadiness().missing_stages,[]);
 for(const r of EXECUTOR_BINDING_MATRIX.filter(r=>r.stage_id!=='TTS'))for(const p of r.executor_location.split('; '))assert.ok((await readFile(new URL('../'+p,import.meta.url),'utf8')).length>0);
 assert.equal(EXECUTOR_BINDING_MATRIX.find(r=>r.stage_id==='TTS').classification,'DIRECT_API_DURABLE_BOUND');
});
test('real wrappers stop before providers and report partial E2E honestly, with full panel 138 events',async()=>{
 const r=await runRealExecutorDryGate({crashMatrix:true});assert.equal(r.status,'PASS');assert.equal(r.stages.length,14);assert.equal(r.stages.filter(s=>s.executor_bound).length,14);assert.equal(r.end_to_end.status,'PASS');assert.equal(r.first_pending_action,'master_review');
 assert.deepEqual(r.provider_calls,{IMAGE:0,VIDEO:0,TTS:0});assert.equal(r.external_calls,0);assert.equal(r.publication_calls,0);assert.equal(r.live_approval_created,false);assert.ok(r.progress_events.every(e=>e.message_id===138&&e.media_type==='photo'));assert.equal(r.rollback,'PASS');
 const c=r.crash_resume_matrix;assert.equal(c.rows.length,56);assert.equal(c.status,'PASS_FOR_BOUND_EXECUTORS');assert.equal(c.tested_bound_stages,14);assert.equal(c.rows.filter(r=>r.stage==='TTS').length,4);assert.ok(c.rows.every(r=>r.duplicate_side_effects===0));assert.equal(c.duplicate_provider_calls,0);
});
test('reserve exhausts budget before claiming or calling executor',async()=>{
 const f=await createRealExecutorDryFixture();try{
 const store=new MemoryLumiRecoveryStore(),manager=new LumiRecoveryIncidentManager({store}),receipts=new MemoryStageReceiptStore();
 const o=new LumiV2ExecutionOrchestrator({manager,receipts,dry_run:true,materialize:async args=>({...await f.materialize(args),quote:{currency:'USD',usd:.4,provider_units:100},required_remaining_reserve_usd:.7})});
 await o.create({request:f.request,authorizedCeilingUsd:1});const id=f.prepared.episode_id;await manager.checkpoint(id,s=>{s.actions=[s.actions.find(a=>a.stage==='IMAGE')];});
 assert.equal((await o.resume({episodeId:id})).status,'BUDGET_EXHAUSTED');assert.equal(receipts.rows.size,0);assert.equal((await store.getEpisode(id)).current_cost_usd,0);assert.equal(f.externalCalls(),0);
 }finally{await f.cleanup();}
});
test('video requires exact Director/source and capability provenance before dry boundary',async()=>{
 const f=await createRealExecutorDryFixture();try{const action=f.prepared.actions.find(a=>a.stage==='VIDEO'),shot=f.prepared.shot_plans[0],material=await f.materialize({action,shot});
 const run=m=>executeStage({episode_id:f.prepared.episode_id,stage_id:'VIDEO',input:{prepared:f.prepared,action,shot,material:m,attempt_id:'dry-attempt'},dry_run:true});
 assert.equal((await run(material)).status,'DRY_PROVIDER_BOUNDARY');await assert.rejects(run({...material,director_packet:null}),/DIRECTOR/);
 const bad=structuredClone(material.director_packet);bad.PROVIDER_REQUEST_PREVIEW.parameters.sound='on';await assert.rejects(run({...material,director_packet:bad}),/CONTRACT/);
 const source=structuredClone(material.source);source.ledger.content_hash='a'.repeat(64);await assert.rejects(run({...material,source}),/source/);assert.equal(f.externalCalls(),0);
 }finally{await f.cleanup();}
});
test('live routing remains closed and canonical CREATE dry diagnostics preserve existing session',async()=>{
 const f=await createRealExecutorDryFixture();try{const manager=new LumiRecoveryIncidentManager({store:new MemoryLumiRecoveryStore()}),o=new LumiV2ExecutionOrchestrator({manager,receipts:new MemoryStageReceiptStore(),materialize:f.materialize});
 await assert.rejects(o.create({request:f.request}),/ACTIVATION/);assert.equal(await manager.store.getEpisode(f.prepared.episode_id),null);
 const store=new MemoryReviewStore();await store.create('1',newSession({user_id:'1',chat_id:'1',message_id:138,cover:HOME_ASSET}));const before=await store.get('1');
 const p=new ProductionReviewController({store});assert.equal((await p.create({user:'1',requested_profile:'legacy'})).status,'LEGACY_ROUTE_UNCHANGED');const r=await p.dryRun({user:'1',message_id:138});assert.equal(r.canonical_message_id,138);assert.deepEqual(await store.get('1'),before);await assert.rejects(p.dryRun({user:'1',message_id:139}),/OWNER/);
 }finally{await f.cleanup();}
});
test('existing review CAS prevents concurrent duplicate claims and receipt overwrites',async()=>{
 const store=new MemoryReviewStore();await store.create('1',newSession({user_id:'1',chat_id:'1',message_id:138,cover:HOME_ASSET}));const claims=new ReviewStageReceiptStore({store,user:'1'});
 const values=await Promise.allSettled([claims.claim('stage',{status:'STARTED'}),claims.claim('stage',{status:'STARTED'})]);assert.equal(values.filter(r=>r.status==='fulfilled'&&r.value===true).length,1);
 await claims.record('stage',{status:'COMPLETE',result:{status:'COMPLETE'}});await assert.rejects(claims.record('stage',{status:'COMPLETE'}),/CAS/);assert.equal((await claims.get('stage')).status,'COMPLETE');
});
test('generic runtime and new topic fixture contain no historical episode/shot/master literals',async()=>{
 for(const p of ['lib/lumi-v2-executor-bindings.js','lib/lumi-v2-execution-orchestrator.js','lib/lumi-v2-real-executor-dry-run.js','qa/LUMI_GENERIC_LISTEN_FIXTURE_V1.json','qa/LUMI_GENERIC_LISTEN_DIRECTION_FIXTURE_V1.json']){
  const s=await readFile(new URL('../'+p,import.meta.url),'utf8');assert.doesNotMatch(s,/ep_lumi_flores_003|\bq3[1-6]\b|b6f9fe837d000a924608ed4bda13034ff30560ac48b5a085f7cb0a90f35a2624/);
 }
});
test('historical synchronous signed dry operation cannot silently start new work',async()=>{
 const store=new MemoryReviewStore();await store.create('1',newSession({user_id:'1',chat_id:'1',message_id:138,cover:HOME_ASSET}));
 const routes=new Map(),app={get:(p,h)=>routes.set(p,h),post:(p,h)=>routes.set(p,h)},secret='dry-fixture-secret'.repeat(3);
 const env={LUMI_RUNTIME_ENV:'staging',LUMI_TELEGRAM_TRANSPORT_AUTHORITY:'MAKE',LUMI_TELEGRAM_REVIEW_TEST_USERS:'1',LUMI_TELEGRAM_CALLBACK_SECRET:secret};
 mountMakeTransportEndpoint(app,{store,env,loadBytes:async()=>{throw Error('NO_MEDIA_LOAD');},validateOwner:async()=>true,production:new ProductionReviewController({store})});
 const path='/lumi/telegram-review/make/v1',body={op:'real_executor_dry_run',user_id:'1',chat_id:'1',message_id:138,summary_only:true},rawBody=Buffer.from(JSON.stringify(body)),timestamp=String(Math.floor(Date.now()/1000)),requestId='new-dry-request';
 const req={path,body,rawBody,headers:{'x-lumi-timestamp':timestamp,'x-lumi-request-id':requestId,'x-lumi-signature':signRequest(secret,{timestamp,requestId,path,body:rawBody})}};
 const call=async r=>{const res={code:200,status(c){this.code=c;return this;},json(v){this.value=v;return this;}};await routes.get(path)(r,res);return res;};
 assert.equal((await call({...req,headers:{...req.headers,'x-lumi-signature':'bad'}})).code,401);
 const response=await call(req);assert.equal(response.code,409);assert.equal(response.value.error,'DURABLE_DRY_RUN_REQUIRED');
 assert.equal((await store.get('1')).state.make_requests,undefined);
 assert.equal((await call(req)).code,409);assert.equal((await call({...req,body:{...body,user_id:'2',chat_id:'2'}})).code,404);assert.deepEqual((await store.get('1')).state.reviews,[]);
});
