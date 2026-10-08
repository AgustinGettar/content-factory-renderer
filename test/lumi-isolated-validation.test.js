import test from 'node:test';
import assert from 'node:assert/strict';
import {isolatedFixture,secret} from './fixtures/isolated-validation-v2.js';
import {signRequest} from '../lib/telegram-review-v1/make-transport.js';
import {ControlledV2Authorization,diagnosticGrant,bindDiagnosticAuthorizationStore,authenticateDiagnosticCommand,inputDigest} from '../lib/lumi-v2-activation-context.js';
import {createGenericV2Runtime} from '../lib/lumi-v2-telegram-runtime.js';
import {LumiRecoveryIncidentManager} from '../lib/lumi-recovery-incident-manager-v1.js';
import {createV2InputMaterializer,checkpointIdentity} from '../lib/lumi-v2-input-materializer.js';
import {PROFILE_SHA} from '../lib/lumi-production-profile-v2.js';
import {mountTelegramReview} from '../lib/telegram-review-v1/runtime.js';
import {createClient} from '@supabase/supabase-js';
import {MemoryLumiRecoveryStore} from '../lib/lumi-recovery-incident-manager-v1.js';

test('RESUME bounds each HTTP phase under serial storage latency and persists the human pause',async()=>{
  let now=Date.now(),enabled=false,calls=0;
  class LatencyStore extends MemoryLumiRecoveryStore {
    async getEpisode(id){if(enabled){calls++;now+=750;}return super.getEpisode(id);}
    async casDiagnostic(v,r){if(enabled){calls++;now+=750;}return super.casDiagnostic(v,r);}
  }
  const f=await isolatedFixture({store:new LatencyStore(),clock:()=>now});
  try{
    assert.equal((await f.call('CONTEXT')).code,200);assert.equal((await f.call('CREATE')).code,200);
    for(const expected of ['source-planning','image:take_01','shot_review:take_01']){
      calls=0;enabled=true;const response=await f.call('RESUME');enabled=false;
      assert.equal(response.code,expected==='shot_review:take_01'?200:202,JSON.stringify(response.value));
      assert.equal(response.value.first_pending_action,expected);
      assert.ok(calls*750<45000,'one HTTP request exceeded the isolated 45s latency budget');
      if(expected!=='shot_review:take_01'){
        assert.equal(response.value.status,'STAGE_COMPLETE');
        assert.equal((await f.read()).results.RESUME,undefined);
        assert.equal((await f.call('REVIEW')).value.error,'DIAGNOSTIC_PHASE_ORDER');
      }else assert.equal(response.value.status,'HUMAN_REVIEW_REQUIRED');
    }
    const v=await f.read(),r=Object.values(v.checkpoint.metadata.review_requests);
    assert.equal(r.length,1);assert.equal(r[0].status,'PENDING');assert.equal(v.checkpoint.status,'PAUSED_INCIDENT');
    assert.equal(v.review.state.reviews.length,0);assert.equal(v.lease,null);
    assert.equal((await f.call('RESUME')).value.already_applied,true);
    assert.equal(f.store.episodes.size,1);assert.equal(Object.keys(v.review.state.production_commands).length,3);
    assert.deepEqual(f.forbidden,[]);assert.deepEqual(globalThis.LUMI_OFFLINE_GUARD.attempts,[]);
  }finally{await f.cleanup();}
});

for(const [fault,code] of [['missing_bytes','ARTIFACT_MISSING'],['missing_registry','ARTIFACT_MISSING'],
  ['qa_pending','QA_NOT_ELIGIBLE'],['inconsistent_checkpoint','CHECKPOINT_CONSISTENCY_FAILURE']])
test('RESUME fails bounded before review dispatch and persists '+fault,async()=>{
  const f=await isolatedFixture();try{
    for(const phase of ['CONTEXT','CREATE','RESUME','RESUME'])assert.equal((await f.call(phase)).code,phase==='RESUME'?202:200);
    const {command:c}=authenticateDiagnosticCommand({env:f.env,...f.envelope('RESUME')});
    await f.isolatedValidation.mutate(c,v=>{v.lease={token:'isolated-input-setup',until:Date.now()+60000};});
    await f.isolatedValidation.loadReviewInput(c,f.isolatedValidation.namespace(c,'isolated-input-setup'));
    await f.isolatedValidation.mutate(c,v=>{
      v.lease=null;
      if(fault==='missing_bytes')v.objects={};
      if(fault==='missing_registry')v.checkpoint.metadata.artifacts={};
      if(fault==='qa_pending'){
        const r=v.checkpoint.metadata.stage_results['video:take_01'];r.result.qa={ok:false,status:'PENDING'};
        r.sha256=inputDigest(r.result);v.checkpoint.metadata.stage_qa['video:take_01']=r.result.qa;
      }
      if(fault==='inconsistent_checkpoint')v.checkpoint.actions[0].evidence={};
    });
    for(let i=0;i<2;i++){
      const start=performance.now(),r=await f.call('RESUME');
      assert.equal(r.code,code==='CHECKPOINT_CONSISTENCY_FAILURE'?409:422);assert.equal(r.value.error,'DIAGNOSTIC_'+code);assert.ok(performance.now()-start<3000);
    }
    const v=await f.read();assert.equal(v.last_event.error_code,code);assert.equal(v.last_event.status,'BLOCKED');
    assert.equal(v.results.RESUME,undefined);assert.equal(v.lease,null);
    assert.equal(Object.keys(v.review.state.production_commands).length,2);
    assert.equal(Object.keys(v.review.state.episodes[c.episode_id].review_requests).length,0);
    assert.equal(v.review.state.reviews.length,0);assert.equal(f.store.episodes.size,1);assert.deepEqual(f.forbidden,[]);
  }finally{await f.cleanup();}
});

test('five real canonical routes, immutable review, independent identity and zero production access',async()=>{
  const f=await isolatedFixture();try{
    for(const phase of ['CONTEXT','CREATE','RESUME','REVIEW','RESULT']){
      const response=await f.runPhase(phase);assert.equal(response.code,200,JSON.stringify(response.value));
      assert.deepEqual(response.value.actions,[]);assert.deepEqual(response.value.commands,[]);
    }
    const v=await f.read();assert.equal(v.results.RESULT.status,'PASS');
    assert.equal(Object.values(v.results.RESULT.gates).filter(v=>v==='PASS').length,5);
    assert.equal(v.review.state.user_id.startsWith('diagnostic:'),true);
    assert.equal(v.review.state.message_id,null);assert.equal(v.review.state.chat_id,null);
    assert.equal(v.checkpoint.metadata.diagnostic,true);assert.equal(v.checkpoint.metadata.dry_run,true);
    assert.equal(v.checkpoint.runner_enabled,false);assert.equal(v.checkpoint.autorun,false);
    assert.equal(v.review.state.reviews.length,1);assert.equal(v.review.state.reviews[0].diagnostic,true);
    assert.equal(v.review.state.reviews[0].callback_query_id,undefined);
    assert.ok(f.events.some(e=>e.point==='RESUME_AFTER_MATERIALIZATION'&&e.stage==='SHOT_REVIEW'));
    assert.deepEqual(f.events.filter(e=>e.point==='EXECUTOR_ENTERED').map(e=>e.stage),['PLANNING','SOURCE_PLANNING','SHOT_REVIEW']);
    assert.equal((await f.store.pendingDiagnostics()).length,0);
    assert.equal(f.store.episodes.size,1);assert.equal(f.store.incidents.size,0);assert.deepEqual(f.forbidden,[]);
    const duplicate=await f.call('REVIEW');assert.equal(duplicate.value.already_applied,true);
    assert.equal((await f.read()).review.state.reviews.length,1);
    assert.equal((await f.call('REVIEW',{decision:'REJECTED'})).value.error,'DIAGNOSTIC_IDEMPOTENCY_CONFLICT');
    assert.equal((await f.call('RESULT')).value.already_applied,true);
    assert.deepEqual(globalThis.LUMI_OFFLINE_GUARD?.attempts,[]);
  }finally{await f.cleanup();}
});

test('security matrix: HMAC, scope, lifetime, owner, flags, identity, phase and replay fail closed',async()=>{
  const f=await isolatedFixture();try{
    const unsigned=f.envelope('CONTEXT');delete unsigned.signature;
    assert.equal((await f.send(unsigned)).code,401);assert.equal(f.store.episodes.size,0);
    for(const patch of [{scope:'CREATE'},{audience:'production'},{dry_run:false},{provider_generation:true},
      {publication:true},{telegram_mutation:true},{expires_at:'2000-01-01'},
      {expires_at:new Date(Date.now()+3600000).toISOString()},{operation_id:'ep_lumi_flores_003'},
      {message_id:138},{diagnostic_identity:'6213838779'},{authorization_id:'client-grant'},
      {user_id:'foreign-owner',chat_id:'foreign-owner'},{idempotency_key:['array-key']},{phase:'PUBLISH'}]){
      const res=await f.call('CONTEXT',patch);assert.ok(res.code>=400,JSON.stringify(patch));
      assert.equal(f.store.episodes.size,0);assert.deepEqual(f.forbidden,[]);
    }
    const tampered=f.envelope('CONTEXT');tampered.signed.body=Buffer.from(tampered.signed.body.toString().replace('"dry_run":true','"dry_run":false'));
    assert.equal((await f.send(tampered)).code,401);
    assert.equal((await f.call('CREATE')).code,409);
    const e=f.envelope('CONTEXT');assert.equal((await f.send(e)).code,200);
    assert.equal((await f.send(e)).value.error,'replayed_request');
    assert.equal((await f.call('CONTEXT',{request:{...f.request,episodePlan:{...f.request.episodePlan,episode:{...f.request.episodePlan.episode,title:'different'}}}})).value.error,'DIAGNOSTIC_IDEMPOTENCY_CONFLICT');
    assert.equal((await f.call('RESUME')).value.error,'DIAGNOSTIC_PHASE_ORDER');
    assert.equal((await f.call('CREATE',{expires_at:new Date(Date.now()+120000).toISOString()})).value.error,'DIAGNOSTIC_BINDING_MISMATCH');
    const clone={...e.body};assert.throws(()=>diagnosticGrant(clone,'a'),/AUTH_REQUIRED/);
    assert.throws(()=>bindDiagnosticAuthorizationStore({},clone),/AUTH_REQUIRED/);
    const invalidPath=f.envelope('CONTEXT');invalidPath.signed.path='/lumi/telegram-review/other';
    invalidPath.signature=signRequest(secret,invalidPath.signed);
    await assert.rejects(f.isolatedValidation.handle(invalidPath),/DIAGNOSTIC_AUTH_REQUIRED/);
  }finally{await f.cleanup();}
});

test('server refuses revoked owner, different staging revision, expired context and production runtime',async()=>{
  let active=true,now=Date.now();const f=await isolatedFixture({validateOwner:async()=>active,clock:()=>now});
  try{
    f.base.expires_at=new Date(now+60000).toISOString();
    assert.equal((await f.call('CONTEXT')).code,200);const original=await f.store.getEpisode(f.base.operation_id);
    active=false;assert.equal((await f.call('CREATE')).value.error,'DIAGNOSTIC_OWNER_INACTIVE');active=true;
    f.env.RENDER_GIT_COMMIT='0'.repeat(40);assert.equal((await f.call('CREATE')).value.error,'DIAGNOSTIC_BINDING_MISMATCH');
    f.env.RENDER_GIT_COMMIT=original.metadata.isolated_validation.staging_revision;
    now=Date.parse(f.base.expires_at);assert.equal((await f.call('CREATE')).value.error,'DIAGNOSTIC_EXPIRED');
    const current=await f.store.getEpisode(f.base.operation_id);
    // HTTP evidence is now append-only even for expired contexts; execution
    // state, original events, grant and replay records remain immutable.
    const before=original.metadata.isolated_validation,after=current.metadata.isolated_validation;
    assert.deepEqual(after.http_records.slice(0,before.http_records.length),before.http_records);
    for(const key of Object.keys(before).filter(k=>k!=='http_records'))assert.deepEqual(after[key],before[key]);
    assert.deepEqual(after.http_records.filter(e=>e.event_kind==='HTTP_RESULT').slice(-2).map(e=>e.http_status),[409,403]);
    f.env.LUMI_RUNTIME_ENV='production';assert.equal((await f.call('CONTEXT')).code,404);
  }finally{await f.cleanup();}
});

test('expiration during server-side owner verification cannot issue a context',async()=>{
  let now=Date.now();const f=await isolatedFixture({clock:()=>now,validateOwner:async()=>{now+=61000;return true;}});
  try{
    f.base.expires_at=new Date(now+60000).toISOString();
    assert.equal((await f.call('CONTEXT')).value.error,'DIAGNOSTIC_EXPIRED');assert.equal(f.store.episodes.size,0);
  }finally{await f.cleanup();}
});

test('diagnostic grant cannot authorize a production store or historical episode',async()=>{
  const f=await isolatedFixture();try{
    await f.call('CONTEXT');const v=await f.read(),authority=new ControlledV2Authorization({store:{get:async()=>v.review},validateOwner:async()=>true});
    await assert.rejects(authority.authorize({user:v.review.state.user_id,chat:null,episodeId:v.grant.episode_id,
      operationId:v.operation_id,authorizationId:Object.keys(v.review.state.v2_authorizations)[0],scope:'RESUME',requestSha:v.request_sha}),/ACTIVATION/);
    await f.call('CREATE');const p=structuredClone(f.request);p.episodePlan.episode.id='ep_lumi_flores_003';
    assert.equal((await f.call('CONTEXT',{request:p})).value.error,'DIAGNOSTIC_EPISODE_MISMATCH');
  }finally{await f.cleanup();}
});

test('rejection persists exactly once and Recovery Manager requires repair without dispatch',async()=>{
  const f=await isolatedFixture();try{
    for(const phase of ['CONTEXT','CREATE','RESUME'])assert.equal((await f.runPhase(phase)).code,200);
    assert.equal((await f.call('REVIEW',{decision:'REJECTED'})).value.status,'REPAIR_PLAN_REQUIRED');
    assert.equal((await f.call('REVIEW',{decision:'REJECTED'})).value.already_applied,true);
    const v=await f.read();assert.equal(v.checkpoint.status,'PAUSED_INCIDENT');assert.equal(v.checkpoint.metadata.repair_plan_required,true);
    assert.equal(v.review.state.reviews.length,1);assert.equal((await f.call('RESULT')).value.status,'PASS');
    assert.deepEqual(f.forbidden,[]);
  }finally{await f.cleanup();}
});

test('namespace forbids historical data, artifact writes, provider journals and every paid/local-media stage',async()=>{
  const f=await isolatedFixture();try{
    await f.call('CONTEXT');await f.call('CREATE');
    const {command:c}=authenticateDiagnosticCommand({env:f.env,...f.envelope('RESUME')});
    await f.isolatedValidation.mutate(c,v=>{v.lease={token:'test-lease',until:Date.now()+60000};});
    const ns=f.isolatedValidation.namespace(c,'test-lease');
    await assert.rejects(ns.checkpointStore.getEpisode('ep_lumi_flores_003'),/NAMESPACE_DENIED/);
    await assert.rejects(ns.reviewStore.get('6213838779'),/NAMESPACE_DENIED/);
    await assert.rejects(ns.storage.download('production','lumi/master.mp4'),/NAMESPACE_DENIED/);
    assert.throws(()=>ns.storage.upload(),/CAPABILITY_FORBIDDEN/);
    assert.throws(()=>ns.storage.remove(),/CAPABILITY_FORBIDDEN/);
    assert.throws(()=>ns.journal.prepare(),/CAPABILITY_FORBIDDEN/);
    assert.throws(()=>ns.journal.transition(),/CAPABILITY_FORBIDDEN/);
    const adapter=createGenericV2Runtime({manager:new LumiRecoveryIncidentManager({store:ns.checkpointStore}),reviewStore:ns.reviewStore,
      artifactStorage:ns.storage,journal:ns.journal,validateOwner:async()=>true});
    const checkpoint=await ns.checkpointStore.getEpisode(c.episode_id);
    for(const stage of ['IMAGE','VIDEO','TTS','DIRECTOR','TEMPORAL_QA','TTS_STORAGE','ASSEMBLY','MASTER','MASTER_REVIEW']){
      await ns.write(v=>{v.checkpoint.first_pending_action=v.checkpoint.actions.find(a=>a.stage===stage).key;});
      await assert.rejects(adapter.resume({user:c.user,episodeId:c.episode_id}),/DIAGNOSTIC_STAGE_FORBIDDEN/);
    }
    await assert.rejects(ns.checkpointStore.casGenericEpisode({...checkpoint,runner_enabled:true},1),/NAMESPACE_DENIED/);
    await assert.rejects(ns.checkpointStore.casGenericEpisode({...checkpoint,episode_id:'ep_lumi_flores_003'},1),/NAMESPACE_DENIED/);
    const row=await ns.reviewStore.get(c.user);row.state.message_id=138;
    await assert.rejects(ns.reviewStore.cas(c.user,row.revision,row.state),/NAMESPACE_DENIED/);
    await ns.write(v=>{v.lease={token:'replacement',until:Date.now()+60000};});
    await assert.rejects(ns.checkpointStore.getEpisode(c.episode_id),/LEASE_LOST/);
    assert.deepEqual(f.forbidden,[]);
  }finally{await f.cleanup();}
});

test('isolated real materializer verifies original bytes, QA and journal before accepting review inputs',async()=>{
  const f=await isolatedFixture();try{
    for(const phase of ['CONTEXT','CREATE','RESUME'])assert.equal((await f.runPhase(phase)).code,200);
    const {command:c}=authenticateDiagnosticCommand({env:f.env,...f.envelope('RESUME')});
    await f.isolatedValidation.mutate(c,v=>{v.lease={token:'materializer-test',until:Date.now()+60000};});
    const ns=f.isolatedValidation.namespace(c,'materializer-test'),state=await ns.checkpointStore.getEpisode(c.episode_id);
    const materialize=createV2InputMaterializer({store:ns.checkpointStore,storage:ns.storage,reviewStore:ns.reviewStore,journal:ns.journal});
    const args={episode_id:c.episode_id,stage_id:'SHOT_REVIEW',checkpoint_id:checkpointIdentity(state),profile_version:2,
      execution_context:{user:c.user,profile_sha:PROFILE_SHA,action_key:state.first_pending_action}};
    const valid=await materialize(args);assert.equal(valid.artifact_references.length,1);
    assert.equal(valid.MATERIALIZE_PROVIDER_CALLS,0);assert.equal(valid.MATERIALIZE_NEW_ARTIFACTS,0);
    const bytes=await ns.read(),path=Object.keys(bytes.objects)[0];
    await ns.write(v=>{v.objects[path]=Buffer.from('corrupt').toString('base64');});
    await assert.rejects(materialize(args),/ARTIFACT_INTEGRITY_FAILURE/);
    await ns.write(v=>{v.objects=bytes.objects;v.journal={};});
    await assert.rejects(materialize(args),/PROVIDER_JOURNAL_MISMATCH/);
    await ns.write(v=>{v.journal=bytes.journal;v.objects={};});
    await assert.rejects(materialize(args),/ARTIFACT_MISSING/);
  }finally{await f.cleanup();}
});

test('concurrent create claims one durable operation; concurrent phase has one executor owner',async()=>{
  let entered,release;
  const barrier=new Promise(r=>{entered=r;}),wait=new Promise(r=>{release=r;});
  const f=await isolatedFixture({inject:async e=>{if(e.point==='CREATE_AFTER_AUTHORIZATION'){entered();await wait;}}});
  try{
    const contexts=await Promise.all([f.call('CONTEXT'),f.call('CONTEXT')]);
    assert.ok(contexts.every(r=>r.code===200));assert.equal(f.store.episodes.size,1);
    const first=f.call('CREATE');await barrier;
    assert.equal((await f.call('CREATE')).value.error,'DIAGNOSTIC_BUSY');release();
    assert.equal((await first).code,200);assert.equal((await f.call('CREATE')).value.already_applied,true);
    assert.equal(f.events.filter(e=>e.point==='CREATE_AFTER_AUTHORIZATION').length,1);
  }finally{release?.();await f.cleanup();}
});

test('real mounted Supabase adapters use only existing diagnostic CAS row and owner read, never Telegram sessions',async()=>{
  const f=await isolatedFixture();let mounted;try{
    const rows=[],access=[];
    const db=createClient('https://isolated-postgrest.invalid','LOCAL_TEST_ONLY',{auth:{persistSession:false},global:{fetch:async(url,options={})=>{
      const u=new URL(url),table=u.pathname.split('/').at(-1),method=options.method||'GET';access.push({table,method,query:decodeURIComponent(u.search)});
      assert.ok(['cf_bot_admins','lumi_pipeline_checkpoints'].includes(table),'unexpected table: '+table);
      if(table==='cf_bot_admins'){assert.equal(method,'GET');return Response.json({user_id:'local-operator'});}
      const match=row=>[...u.searchParams].every(([key,value])=>{
        if(['select','order','limit','on_conflict'].includes(key))return true;
        const actual=key.split('->>').reduce((a,k)=>a?.[k],row);
        if(value.startsWith('eq.'))return String(actual)===value.slice(3);
        if(value.startsWith('in.('))return value.slice(4,-1).split(',').includes(String(actual));return false;
      });
      let result=rows.filter(match);
      if(method==='POST'){
        assert.ok(new Headers(options.headers).get('prefer').includes('resolution=ignore-duplicates'));
        const body=JSON.parse(options.body),old=rows.find(r=>r.episode_id===body.episode_id);
        if(old)result=[];else{rows.push(body);result=[body];}
      }else if(method==='PATCH'){
        assert.ok(u.searchParams.has('metadata->>diagnostic_revision'));
        assert.equal(u.searchParams.get('metadata->>operation_type'),'eq.AUTHENTICATED_DRY_RUN_V1');
        result.forEach(r=>Object.assign(r,JSON.parse(options.body)));
      }
      return Response.json(new Headers(options.headers).get('accept')?.includes('object')?result[0]||null:result);
    }}});
    const routes=new Map(),app={get:(p,...h)=>routes.set(p,h.at(-1)),post:(p,...h)=>routes.set(p,h.at(-1))};
    mounted=mountTelegramReview(app,{db,env:f.env,authorized:()=>false});mounted.stopDiagnostics();
    for(const phase of ['CONTEXT','CREATE','RESUME','RESUME','RESUME','REVIEW','RESULT']){
      const e=f.envelope(phase),res={code:200,status(n){this.code=n;return this;},json(v){this.value=v;return this;}};
      await routes.get(e.signed.path)({body:e.body,rawBody:e.signed.body,path:e.signed.path,
        headers:{'x-lumi-timestamp':e.signed.timestamp,'x-lumi-request-id':e.signed.requestId,'x-lumi-signature':e.signature}},res);
      assert.equal(res.code,res.value.continuation_required?202:200,JSON.stringify(res.value));if(phase==='RESULT')assert.equal(res.value.status,'PASS');
    }
    assert.equal(rows.length,1);assert.equal(rows[0].status,'VALIDATION_CONTEXT');
    assert.ok(access.some(a=>a.method==='PATCH'));assert.equal(f.env.LUMI_TELEGRAM_REVIEW_V1,undefined);
    assert.equal(f.env.LUMI_PIPELINE_VERSION,undefined);
  }finally{mounted?.stopDiagnostics();await f.cleanup();}
});
