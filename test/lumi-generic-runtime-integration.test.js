import test from 'node:test';
import assert from 'node:assert/strict';
import {runtimeFixture,seedPersistedVideos,reviewCallback,fixtureSecret} from './fixtures/generic-runtime-v2.js';
import {PROFILE_SHA,LUMI_PRODUCTION_PROFILE_V2 as profile} from '../lib/lumi-production-profile-v2.js';
import {createV2InputMaterializer,checkpointIdentity} from '../lib/lumi-v2-input-materializer.js';
import {mountMakeTransportEndpoint} from '../lib/telegram-review-v1/make-endpoint.js';
import {inputDigest} from '../lib/lumi-v2-activation-context.js';
import {mountTelegramReview} from '../lib/telegram-review-v1/runtime.js';
import {isGenericV2Runtime} from '../lib/lumi-v2-telegram-runtime.js';
import {createClient} from '@supabase/supabase-js';
import {sha256} from '../lib/telegram-review-v1/core.js';

test('canonical duplicate RESUME reports the persisted pending human review without execution or a new decision',async()=>{
 const f=await runtimeFixture();try{
  await f.create();await seedPersistedVideos(f);
  assert.equal((await f.production.resume({user:'1',episodeId:f.episodeId})).status,'HUMAN_REVIEW_REQUIRED');
  const before=await f.store.getEpisode(f.episodeId),reviewBefore=await f.reviewStore.get('1');
  const result=await f.production.resume({user:'1',episodeId:f.episodeId});
  assert.equal(result.status,'HUMAN_REVIEW_REQUIRED');assert.equal(result.first_pending_action,before.first_pending_action);
  assert.equal(result.review_request.status,'PENDING');
  assert.deepEqual(await f.store.getEpisode(f.episodeId),before);
  assert.deepEqual(await f.reviewStore.get('1'),reviewBefore);assert.deepEqual(f.counters(),{providerCalls:0,uploads:0});
 }finally{await f.cleanup();}
});

for(const fault of ['revoked_owner','expired_grant','missing_resume_scope','stale_request'])
test('pending review status does not bypass '+fault,async()=>{
 let active=true;const f=await runtimeFixture({validateOwner:async()=>active});try{
  await f.create();await seedPersistedVideos(f);await f.production.resume({user:'1',episodeId:f.episodeId});
  const row=await f.reviewStore.get('1');
  if(fault==='revoked_owner')active=false;
  if(fault==='expired_grant')row.state.v2_authorizations.controlled.expires_at='2000-01-01T00:00:00Z';
  if(fault==='missing_resume_scope')row.state.v2_authorizations.controlled.scopes=['CREATE'];
  if(fault==='stale_request')Object.values(row.state.episodes[f.episodeId].review_requests).find(r=>r.status==='PENDING').review_version++;
  await f.reviewStore.cas('1',row.revision,row.state);
  const before=await f.store.getEpisode(f.episodeId),reviewBefore=await f.reviewStore.get('1');
  await assert.rejects(f.production.resume({user:'1',episodeId:f.episodeId}),/ACTIVATION|STALE_GENERIC_REVIEW/);
  assert.deepEqual(await f.store.getEpisode(f.episodeId),before);assert.deepEqual(await f.reviewStore.get('1'),reviewBefore);
  assert.deepEqual(f.counters(),{providerCalls:0,uploads:0});
 }finally{await f.cleanup();}
});

test('canonical HMAC CREATE propagates server grant through adapter to orchestrator; repeat is immutable',async()=>{
 const f=await runtimeFixture();try{
  const routes=new Map(),app={get:(p,h)=>routes.set(p,h),post:(p,h)=>routes.set(p,h)};
  mountMakeTransportEndpoint(app,{store:f.reviewStore,env:{LUMI_RUNTIME_ENV:'staging',LUMI_TELEGRAM_TRANSPORT_AUTHORITY:'MAKE',LUMI_TELEGRAM_REVIEW_TEST_USERS:'1',LUMI_TELEGRAM_CALLBACK_SECRET:fixtureSecret},
    validateOwner:async()=>true,production:f.production});
  const req={body:f.body,rawBody:f.signed.body,path:f.signed.path,headers:{'x-lumi-timestamp':f.signed.timestamp,'x-lumi-request-id':f.signed.requestId,'x-lumi-signature':f.signature}};
  const call=async request=>{const res={code:200,status(c){this.code=c;return this;},json(v){this.value=v;return this;}};await routes.get(f.signed.path)(request,res);return res;};
  assert.equal((await call({...req,headers:{...req.headers,'x-lumi-signature':'bad'}})).code,401);
  assert.equal(await f.store.getEpisode(f.episodeId),null);
  const response=await call(req);assert.equal(response.code,200);assert.equal(response.value.status,'PREPARED');
  const state=await f.store.getEpisode(f.episodeId);assert.equal(state.metadata.activation_context.operation_id,f.body.operation_id);
  assert.equal(state.metadata.activation_context.profile_sha,PROFILE_SHA);assert.equal(state.metadata.activation_context.scope,'CREATE');
  await f.create();assert.deepEqual(await f.store.getEpisode(f.episodeId),state);
  assert.equal((await call(req)).code,409);assert.equal(f.counters().providerCalls,0);
  assert.equal((await f.reviewStore.get('1')).state.message_id,138);
 }finally{await f.cleanup();}
});

test('forged activation booleans, unbranded context, cross owner, expiry, version/profile/scope fail closed; legacy preserved',async()=>{
 const f=await runtimeFixture();try{
  const create=()=>f.production.create({user:'1',chat:'1',request:f.request,requested_profile:profile.id,
    activation:{explicit_user_authorization:true,profile_sha:PROFILE_SHA,v2_enabled:true},readiness:{status:'PASS'}});
  await assert.rejects(create(),/ACTIVATION/);
  await assert.rejects(f.adapter.create({user:'1',request:f.request,execution_context:{...f.command,dry_run:true}}),/ACTIVATION/);
  const original=await f.reviewStore.get('1');
  for(const patch of [{expires_at:'2000-01-01'},{profile_sha:'0'.repeat(64)},{version:0},{scopes:['RESUME']},{chat_id:'2'},{operation_id:'wrong'},{request_sha:'0'.repeat(64)}]){
    const row=await f.reviewStore.get('1');row.state.v2_authorizations.controlled={...original.state.v2_authorizations.controlled,...patch};
    await f.reviewStore.cas('1',row.revision,row.state);await assert.rejects(f.create(),/ACTIVATION/);
  }
  assert.equal(await f.store.getEpisode(f.episodeId),null);
  assert.equal((await f.production.create({user:'1',requested_profile:'legacy'})).status,'LEGACY_ROUTE_UNCHANGED');
  assert.deepEqual(f.counters(),{providerCalls:0,uploads:0});
 }finally{await f.cleanup();}
});

test('real materializer reconstructs persisted plan and is read-only and JSONB-order stable',async()=>{
 const f=await runtimeFixture();try{
  await f.create();const before=await f.store.getEpisode(f.episodeId),reviewBefore=await f.reviewStore.get('1');
  const a=await f.materialize(),b=await f.materialize();assert.deepEqual(a,b);
  assert.equal(a.readiness_status,'READY');assert.equal(a.checkpoint_version,1);
  assert.deepEqual(await f.store.getEpisode(f.episodeId),before);assert.deepEqual(await f.reviewStore.get('1'),reviewBefore);
  const reorder=v=>Array.isArray(v)?v.map(reorder):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).reverse().map(([k,x])=>[k,reorder(x)])):v;
  await f.store.putEpisode(reorder(before));assert.deepEqual(await f.materialize(),a);
  assert.deepEqual(f.counters(),{providerCalls:0,uploads:0});
 }finally{await f.cleanup();}
});

test('materializer checks checkpoint/stage/profile identity and plan integrity',async()=>{
 const f=await runtimeFixture();try{
  await f.create();const state=await f.store.getEpisode(f.episodeId),m=createV2InputMaterializer({store:f.store,storage:{download:async()=>null},reviewStore:f.reviewStore,journal:{get:async()=>null}});
  const input={episode_id:f.episodeId,stage_id:'PLANNING',checkpoint_id:checkpointIdentity(state),profile_version:2,execution_context:{user:'1',profile_sha:PROFILE_SHA,action_key:'planning'}};
  await assert.rejects(m({...input,checkpoint_id:'old'}),/STALE_CHECKPOINT/);
  await assert.rejects(m({...input,stage_id:'TTS'}),/STAGE_IDENTITY/);
  await assert.rejects(m({...input,profile_version:3}),/PROFILE_COMPATIBILITY/);
  await f.manager.checkpoint(f.episodeId,d=>{d.metadata.generic_v2.plan.episode.title='changed';});
  await assert.rejects(f.materialize(),/INTEGRITY/);
 }finally{await f.cleanup();}
});

test('persisted video SHA, QA, human approvals and journal survive TTS input reconstruction; none are invented',async()=>{
 const f=await runtimeFixture();try{
  await f.create();await seedPersistedVideos(f,{nextStage:'TTS'});
  const a=await f.materialize();assert.equal(a.artifact_references.length,f.request.shotPlans.length);
  assert.equal(Object.keys(a.provenance.qa).length,f.request.shotPlans.length);
  assert.equal(Object.keys(a.provenance.human_reviews).length,f.request.shotPlans.length);
  assert.deepEqual(await f.materialize(),a);
  const artifact=a.artifact_references[0],key=artifact.bucket+'/'+artifact.path,bytes=f.objects.get(key);
  f.objects.delete(key);await assert.rejects(f.materialize(),/ARTIFACT_MISSING/);
  f.objects.set(key,Buffer.from('changed'));await assert.rejects(f.materialize(),/ARTIFACT_INTEGRITY_FAILURE/);f.objects.set(key,bytes);
  const row=await f.reviewStore.get('1'),r=Object.values(row.state.episodes[f.episodeId].review_requests)[0];r.status='PENDING';await f.reviewStore.cas('1',row.revision,row.state);
  await assert.rejects(f.materialize(),/HUMAN_REVIEW_REQUIRED/);
  assert.deepEqual(f.counters(),{providerCalls:0,uploads:0});
 }finally{await f.cleanup();}
});

test('journal mismatch and inconsistent action order cannot reach an executor',async()=>{
 const f=await runtimeFixture();try{
  await f.create();await seedPersistedVideos(f,{nextStage:'TTS'});
  const original=structuredClone(f.journalRows.get('claim_video_take_01'));
  f.journalRows.set('claim_video_take_01',{...original,provider_request_id:'different-job'});
  await assert.rejects(f.materialize(),/PROVIDER_JOURNAL_MISMATCH/);f.journalRows.set('claim_video_take_01',original);
  const s=await f.store.getEpisode(f.episodeId);s.actions.splice(0,1);await f.store.putEpisode(s);
  await assert.rejects(f.materialize(),/CHECKPOINT_CONSISTENCY_FAILURE/);assert.equal(f.counters().providerCalls,0);
 }finally{await f.cleanup();}
});

test('replayed RESUME token remains bound to its original action after checkpoint advancement',async()=>{
 const f=await runtimeFixture();try{
  await f.create();const args={user:'1',episodeId:f.episodeId,expectedAction:'planning'};
  const first=await f.production.resume(args),second=await f.production.resume(args);
  assert.equal(first.first_pending_action,'source-planning');assert.equal(second.already_applied,true);
  assert.equal((await f.store.getEpisode(f.episodeId)).first_pending_action,'source-planning');
  assert.equal((await f.reviewStore.get('1')).state.episodes[f.episodeId].next_action,'source-planning');
  assert.equal(f.counters().providerCalls,0);
 }finally{await f.cleanup();}
});

test('CREATE → real planning → persisted recovery inputs → REVIEW → Recovery Manager → TTS dry boundary',async()=>{
 const f=await runtimeFixture();try{
  await f.create();assert.equal((await f.production.resume({user:'1',episodeId:f.episodeId})).first_pending_action,'source-planning');
  assert.equal((await f.production.resume({user:'1',episodeId:f.episodeId})).first_pending_action,'image:take_01');
  await assert.rejects(f.production.resume({user:'1',episodeId:f.episodeId}),/ARTIFACT_MISSING/);
  // Simulates a recovered checkpoint with already produced media, never an executor.
  await seedPersistedVideos(f);const result=await f.production.resume({user:'1',episodeId:f.episodeId});assert.equal(result.status,'HUMAN_REVIEW_REQUIRED');
  const cb=await reviewCallback(f);await f.service.callback(cb);await f.service.callback(cb);
  const state=await f.store.getEpisode(f.episodeId);assert.equal(state.first_pending_action,'tts');assert.equal(state.active_incident_id,null);
  assert.equal((await f.reviewStore.get('1')).state.reviews.length,1);
  const boundary=await f.production.resume({user:'1',episodeId:f.episodeId});assert.equal(boundary.status,'DRY_PROVIDER_BOUNDARY');
  assert.deepEqual(await f.production.resume({user:'1',episodeId:f.episodeId}),boundary);
  assert.equal((await f.store.getEpisode(f.episodeId)).first_pending_action,'tts');
  assert.deepEqual(f.counters(),{providerCalls:0,uploads:0});assert.equal(state.runner_enabled,false);assert.equal(state.autorun,false);
 }finally{await f.cleanup();}
});

test('REJECT persists once and pauses; conflicting duplicate decision is blocked',async()=>{
 const f=await runtimeFixture();try{
  await f.create();await seedPersistedVideos(f);await f.production.resume({user:'1',episodeId:f.episodeId});
  const approve=await reviewCallback(f),reject=await reviewCallback(f,'reject_stage');
  await f.service.callback(reject);await f.service.callback(reject);await assert.rejects(f.service.callback(approve),/immutable/i);
  const state=await f.store.getEpisode(f.episodeId);assert.equal(state.status,'PAUSED_INCIDENT');assert.equal(state.metadata.repair_plan_required,true);
  assert.equal((await f.reviewStore.get('1')).state.reviews.length,1);assert.deepEqual(f.counters(),{providerCalls:0,uploads:0});
 }finally{await f.cleanup();}
});

test('MASTER_REVIEW reconstructs canonical master before Telegram projection exists and persists one final decision',async()=>{
 const f=await runtimeFixture();try{
  await f.create();const bytes=Buffer.from('PERSISTED MASTER INPUT FIXTURE; NO ENCODE'),a={artifact_id:'master_input',episode_id:f.episodeId,
    sha256:sha256(bytes),bucket:'test-isolated',path:'master.mp4',size:bytes.length,mime:'video/mp4'};
  f.objects.set(a.bucket+'/'+a.path,bytes);
  await f.manager.checkpoint(f.episodeId,d=>{
    for(const action of d.actions)if(action.stage!=='MASTER_REVIEW'){action.status='COMPLETE';action.evidence={provider_succeeded:true,artifact_persisted:true,sha_verified:true,artifact_verified:true};}
    d.metadata.artifacts={[a.artifact_id]:a};
    const result={status:'SUCCEEDED',episode_id:f.episodeId,stage_id:'MASTER',artifacts:[a],qa:{ok:true,status:'PASS',sha256:a.sha256},provider_job_ids:[],claims:[]};
    d.metadata.stage_results={master:{receipt_id:'persisted-master',hash_version:'CANONICAL_JSON_V1',sha256:inputDigest(result),result}};
  });
  const materialized=await f.materialize();assert.deepEqual(materialized.materialized_stage_input.review_episode.master,a);
  assert.equal((await f.production.resume({user:'1',episodeId:f.episodeId})).status,'HUMAN_REVIEW_REQUIRED');
  const cb=await reviewCallback(f);await f.service.callback(cb);await f.service.callback(cb);
  assert.equal((await f.store.getEpisode(f.episodeId)).first_pending_action,null);
  assert.equal((await f.reviewStore.get('1')).state.reviews.length,1);assert.deepEqual(f.counters(),{providerCalls:0,uploads:0});
 }finally{await f.cleanup();}
});

for(const failure of ['sha','version','checkpoint','reviewer'])test('REVIEW blocks '+failure+' before decision persistence',async()=>{
 const f=await runtimeFixture();try{
  await f.create();await seedPersistedVideos(f);await f.production.resume({user:'1',episodeId:f.episodeId});const cb=await reviewCallback(f);
  if(failure==='reviewer')cb.from.id='2';
  else if(failure==='checkpoint')await f.manager.checkpoint(f.episodeId,d=>{d.actions.find(a=>a.key===d.first_pending_action).evidence={provider_succeeded:true,artifact_persisted:true,sha_verified:true,artifact_verified:true};});
  else {const row=await f.reviewStore.get('1'),r=Object.values(row.state.episodes[f.episodeId].review_requests).find(r=>r.status==='PENDING');
    if(failure==='sha')row.state.episodes[f.episodeId].artifacts[r.artifact_id].sha256='0'.repeat(64);else r.review_version++;
    await f.reviewStore.cas('1',row.revision,row.state);}
  await assert.rejects(f.service.callback(cb));assert.equal((await f.reviewStore.get('1')).state.reviews.length,0);
 }finally{await f.cleanup();}
});

test('CAS rejects a concurrent checkpoint overwrite; mutable QA cannot reuse its hash',async()=>{
 const f=await runtimeFixture();try{
  await f.create();const s=await f.store.getEpisode(f.episodeId);
  await f.manager.checkpoint(f.episodeId,d=>{d.metadata.test_marker=1;});assert.equal(await f.store.casGenericEpisode(s,s.metadata.runtime_revision),null);
  await seedPersistedVideos(f,{nextStage:'TTS'});
  await f.manager.checkpoint(f.episodeId,d=>{d.metadata.stage_results['video:take_01'].result.qa.ok=false;});
  await assert.rejects(f.materialize(),/INTEGRITY/);
  await f.manager.checkpoint(f.episodeId,d=>{const r=d.metadata.stage_results['video:take_01'];r.sha256=inputDigest(r.result);});
  await assert.rejects(f.materialize(),/QA_NOT_ELIGIBLE/);
 }finally{await f.cleanup();}
});

test('canonical runtime mount uses real Supabase adapters over isolated PostgREST storage and executes CREATE/RESUME',async()=>{
 const f=await runtimeFixture();let mounted;try{
  const row=await f.reviewStore.get('1'),tables={cf_bot_admins:[{user_id:'1',chat_id:'1',active:true}],
    lumi_telegram_review_sessions:[{user_id:'1',chat_id:'1',message_id:138,...row}],lumi_pipeline_checkpoints:[]},writes=[];
  const db=createClient('https://isolated-postgrest.invalid','TEST_ONLY_KEY',{auth:{persistSession:false},global:{fetch:async(url,options={})=>{
    const u=new URL(url),table=u.pathname.split('/').at(-1),rows=tables[table]||[],method=options.method||'GET';
    const match=r=>[...u.searchParams].every(([key,v])=>{
      if(['select','order','limit'].includes(key))return true;
      const actual=key.split('->>').reduce((a,k)=>a?.[k],r);
      return v.startsWith('eq.')?String(actual)===v.slice(3):v.startsWith('in.(')?v.slice(4,-1).split(',').includes(String(actual)):true;
    });
    let result=rows.filter(match);
    if(method==='POST'){
      const value=JSON.parse(options.body),existing=rows.find(r=>r.episode_id===value.episode_id);
      if(existing)result=[];else {rows.push(value);result=[value];}writes.push({method,table,headers:Object.fromEntries(new Headers(options.headers)),query:u.search});
    }else if(method==='PATCH'){
      const patch=JSON.parse(options.body);result.forEach(r=>Object.assign(r,patch));writes.push({method,table,query:u.search});
    }
    const object=new Headers(options.headers).get('Accept')?.includes('object');
    return new Response(JSON.stringify(object?(result[0]||null):result),{headers:{'Content-Type':'application/json'}});
  }}});
  const routes=new Map(),app={get:(p,...h)=>routes.set(p,h.at(-1)),post:(p,...h)=>routes.set(p,h.at(-1))};
  const env={LUMI_RUNTIME_ENV:'staging',LUMI_TELEGRAM_TRANSPORT_AUTHORITY:'MAKE',LUMI_TELEGRAM_REVIEW_TEST_USERS:'1',LUMI_TELEGRAM_CALLBACK_SECRET:fixtureSecret};
  mounted=mountTelegramReview(app,{db,env,authorized:()=>true});mounted.stopDiagnostics();
  assert.equal(isGenericV2Runtime(mounted.production.adapters[profile.id]),true);
  assert.equal(isGenericV2Runtime({create(){},resume(){},handleReview(){},runtimeBinding:'GENERIC_V2_REAL_INPUT_RUNTIME_V1'}),false);
  const res={code:200,status(c){this.code=c;return this;},json(v){this.value=v;return this;}};
  await routes.get(f.signed.path)({body:f.body,rawBody:f.signed.body,path:f.signed.path,
    headers:{'x-lumi-timestamp':f.signed.timestamp,'x-lumi-request-id':f.signed.requestId,'x-lumi-signature':f.signature}},res);
  assert.equal(res.code,200);assert.equal(res.value.status,'PREPARED');
  assert.equal((await mounted.production.resume({user:'1',episodeId:f.episodeId})).first_pending_action,'source-planning');
  assert.equal((await mounted.production.resume({user:'1',episodeId:f.episodeId})).first_pending_action,'image:take_01');
  assert.equal(tables.lumi_pipeline_checkpoints.length,1);assert.equal(tables.lumi_pipeline_checkpoints[0].runner_enabled,false);
  assert.ok(writes.some(w=>w.table==='lumi_pipeline_checkpoints'&&w.method==='POST'&&w.headers.prefer.includes('resolution=ignore-duplicates')));
  assert.ok(writes.some(w=>w.table==='lumi_pipeline_checkpoints'&&w.method==='PATCH'&&decodeURIComponent(w.query).includes('metadata->>runtime_revision=eq.')));
  assert.equal(env.LUMI_PIPELINE_VERSION,undefined);assert.equal(env.LUMI_TELEGRAM_REVIEW_V1,undefined);
 }finally{mounted?.stopDiagnostics();await f.cleanup();}
});
