import test from 'node:test';
import assert from 'node:assert/strict';
import {DurableDryRun,dryOperationId,buildDryResult} from '../lib/lumi-durable-dry-run.js';
import {MemoryLumiRecoveryStore,SupabaseLumiRecoveryStore} from '../lib/lumi-recovery-incident-manager-v1.js';
import {MemoryReviewStore,newSession,sha256} from '../lib/telegram-review-v1/core.js';
import {HOME_ASSET} from '../lib/telegram-review-v1/home-asset.js';
import {mountMakeTransportEndpoint} from '../lib/telegram-review-v1/make-endpoint.js';
import {signRequest} from '../lib/telegram-review-v1/make-transport.js';
import {ProductionReviewController} from '../lib/telegram-review-v1/production.js';
import {createElevenLabsDirectClient,FERNANDA_SOURCE_ID} from '../lib/lumi-elevenlabs-direct-v3.js';

const secret='SYNTHETIC_TEST_HMAC_DO_NOT_USE_IN_RUNTIME_0000';
const baseEnv={LUMI_RUNTIME_ENV:'staging',LUMI_TELEGRAM_TRANSPORT_AUTHORITY:'MAKE',LUMI_TELEGRAM_REVIEW_TEST_USERS:'1,2',
  LUMI_TELEGRAM_CALLBACK_SECRET:secret,RENDER_GIT_COMMIT:'a'.repeat(40)};
const payload={op:'START_DRY_RUN',user_id:'1',chat_id:'1',message_id:138,idempotency_key:'dry-test-0001',
  verify_tts_preflight:true,dry_run:true,provider_generation:false,publication:false,crash_matrix:true};
const stages={
  TTS_PREFLIGHT:{ELEVENLABS_AUTH:'PASS',MODEL_VALIDATION:'PASS',FERNANDA_CALLABLE:'PASS',TTS_QUOTA:'PASS',TTS_BUDGET_GATE:'PASS',TTS_STORAGE_GATE:'PASS',TTS_DRY_BOUNDARY:'PASS'},
  GENERIC_DRY_RUN:{status:'PASS',bound:14,total:14,continuation:'PASS',recovery:'PASS',rollback:'PASS'},
  RUNTIME:{status:'PASS',TELEGRAM_SINGLE_PANEL:'PASS',legacy_preserved:true}
};
const silent={info(){},warn(){}};
async function setup(options={}) {
  const reviewStore=new MemoryReviewStore(),store=new MemoryLumiRecoveryStore(),calls=[];
  await reviewStore.create('1',newSession({user_id:'1',chat_id:'1',message_id:138,cover:HOME_ASSET}));
  await reviewStore.create('2',newSession({user_id:'2',chat_id:'2',message_id:138,cover:HOME_ASSET}));
  const env={...baseEnv},args={store,reviewStore,env,validateOwner:async()=>true,
    runStage:async stage=>{calls.push(stage);return structuredClone(stages[stage]);},logger:silent,...options};
  const diagnostics=new DurableDryRun(args);
  const routes=new Map(),app={get:(p,h)=>routes.set(p,h),post:(p,h)=>routes.set(p,h)};
  mountMakeTransportEndpoint(app,{store:reviewStore,env,validateOwner:args.validateOwner,production:{dryRun:()=>assert.fail('sync work forbidden')},diagnostics});
  let sequence=0;
  const call=async(body,nonce='transport-'+(++sequence),bad=false,responseLost=false)=>{
    const path='/lumi/telegram-review/make/v1',rawBody=Buffer.from(JSON.stringify(body)),timestamp=String(Math.floor(Date.now()/1000));
    const req={path,body,rawBody,headers:{'x-lumi-timestamp':timestamp,'x-lumi-request-id':nonce,
      'x-lumi-signature':bad?'0'.repeat(64):signRequest(secret,{timestamp,requestId:nonce,path,body:rawBody})}};
    const res={code:200,status(v){this.code=v;return this;},json(v){this.body=v;if(responseLost)throw Error('CLIENT_DISCONNECTED');return this;}};
    try{await routes.get(path)(req,res);}catch(error){if(!responseLost)throw error;}
    return res;
  };
  const get=(id,op='GET_DRY_RUN_RESULT',extra={})=>call({op,user_id:'1',chat_id:'1',operation_id:id,...extra});
  return {args,diagnostics,store,reviewStore,calls,call,get};
}

test('valid HMAC persists quickly, returns 202/id and performs no diagnostic in HTTP request',async()=>{
  const f=await setup(),r=await f.call(payload);assert.equal(r.code,202);assert.equal(r.body.status,'QUEUED');
  assert.match(r.body.operation_id,/^dry_[a-f0-9]{64}$/);assert.equal(f.calls.length,0);
  assert.equal((await f.store.getEpisode(r.body.operation_id)).status,'QUEUED');
  assert.deepEqual(r.body.actions,[]);assert.deepEqual(r.body.commands,[]);
});
test('invalid HMAC creates neither nonce nor operation; reused nonce is rejected',async()=>{
  const f=await setup();assert.equal((await f.call(payload,'nonce',true)).code,401);assert.equal(f.store.episodes.size,0);
  assert.equal((await f.reviewStore.get('1')).state.make_requests,undefined);
  assert.equal((await f.call(payload,'nonce')).code,202);assert.equal((await f.call(payload,'nonce')).body.error,'replayed_request');
  assert.equal(f.store.episodes.size,1);
});
test('new nonces and one idempotency key yield one operation, including concurrent starts',async()=>{
  const f=await setup();
  const start=nonce=>f.diagnostics.start({user:'1',chat:'1',body:payload,nonce});
  const [a,b]=await Promise.all([start('nonce-a'),start('nonce-b')]);
  assert.equal(a.operation_id,b.operation_id);assert.equal(f.store.episodes.size,1);
  assert.equal([a,b].filter(v=>!v.already_exists).length,1);
  assert.equal((await f.call(payload)).body.already_exists,true);
});
test('same logical key with changed valid payload rejects and never overwrites',async()=>{
  const f=await setup();await f.call(payload);const before=structuredClone([...f.store.episodes]);
  // Change the canonical panel in both request and owner state to reach the key conflict check.
  const row=await f.reviewStore.get('1');row.state.message_id=139;await f.reviewStore.cas('1',row.revision,row.state);
  assert.equal((await f.call({...payload,message_id:139})).body.error,'DRY_IDEMPOTENCY_CONFLICT');
  assert.deepEqual([...f.store.episodes],before);
});
test('concurrent authenticated starts reconcile nonce CAS and return the same operation',async()=>{
  const f=await setup(),results=await Promise.all([f.call(payload),f.call(payload)]);
  assert.deepEqual(results.map(r=>r.code).sort(),[200,202]);assert.equal(results[0].body.operation_id,results[1].body.operation_id);
  assert.equal(f.store.episodes.size,1);assert.equal(Object.keys((await f.reviewStore.get('1')).state.make_requests).length,2);
});
test('safety flags, unexpected fields and transport nonce used as logical key are rejected',async()=>{
  const f=await setup();
  for(const patch of [{provider_generation:true},{publication:true},{dry_run:false},{verify_tts_preflight:false},{crash_matrix:false},{replay:{}}])
    assert.equal((await f.call({...payload,...patch})).code,409);
  assert.equal((await f.call(payload,payload.idempotency_key)).body.error,'DRY_IDEMPOTENCY_KEY_INVALID');
  assert.equal(f.store.episodes.size,0);
});
test('lost start response is recovered by key, without retransmitting start or creating work',async()=>{
  const f=await setup();await f.call(payload,'disconnect',false,true);
  const r=await f.call({op:'GET_DRY_RUN_STATUS',user_id:'1',chat_id:'1',idempotency_key:payload.idempotency_key});
  assert.equal(r.body.operation_id,dryOperationId('1',payload.idempotency_key));assert.equal(r.body.status,'QUEUED');
  assert.equal(f.store.episodes.size,1);assert.equal(f.calls.length,0);
});
test('client timeout does not cancel accepted work; duplicate workers cannot duplicate execution',async()=>{
  const f=await setup();const id=(await f.call(payload)).body.operation_id;
  const another=new DurableDryRun(f.args);
  await Promise.all([f.diagnostics.process(id),another.process(id)]);
  const result=(await f.get(id)).body;assert.equal(result.status,'SUCCEEDED');assert.equal(result.result_json.status,'PASS');
  assert.equal(result.result_sha256,sha256(JSON.stringify(result.result_json)));
  assert.deepEqual(f.calls,['TTS_PREFLIGHT','GENERIC_DRY_RUN','RUNTIME']);
  assert.equal(result.result_json.duplicate_operations,0);assert.equal(result.provider_generation_calls,0);assert.equal(result.publication_calls,0);
});
test('query is operation read-only, even while running, and another owner cannot query it',async()=>{
  const f=await setup(),id=(await f.call(payload)).body.operation_id,before=await f.store.getEpisode(id);
  await f.get(id);await f.get(id,'GET_DRY_RUN_STATUS');assert.deepEqual(await f.store.getEpisode(id),before);
  assert.equal((await f.get(id,'GET_DRY_RUN_RESULT',{user_id:'2',chat_id:'2'})).body.error,'DRY_OPERATION_NOT_FOUND');
  assert.equal(f.calls.length,0);
});
test('queries preserve historical expired antireplay record',async()=>{
  const f=await setup(),row=await f.reviewStore.get('1');row.state.make_requests={historical:{body_hash:'b'.repeat(64),expires_at:1}};
  await f.reviewStore.cas('1',row.revision,row.state);const id=(await f.call(payload)).body.operation_id;await f.get(id);
  assert.deepEqual((await f.reviewStore.get('1')).state.make_requests.historical,{body_hash:'b'.repeat(64),expires_at:1});
});
test('restart before execution consumes the persisted queue; completed result never reruns',async()=>{
  const f=await setup(),id=(await f.call(payload)).body.operation_id;
  await new DurableDryRun(f.args).tick();const before=await f.store.getEpisode(id);
  await new DurableDryRun(f.args).tick();await f.call(payload);
  assert.deepEqual(await f.store.getEpisode(id),before);assert.equal(f.calls.length,3);assert.equal((await f.get(id)).body.result_available,true);
});
test('restart after stage persistence resumes only pending stages, with fencing on stale workers',async()=>{
  let now=1000,die=true;
  const f=await setup({clock:()=>now,inject:async point=>{if(point==='STAGE_PERSISTED'&&die){die=false;throw Object.assign(Error('killed'),{simulatedProcessDeath:true});}}});
  const id=(await f.call(payload)).body.operation_id;
  await assert.rejects(f.diagnostics.process(id),/killed/);
  const token=(await f.store.getEpisode(id)).metadata.dry_run_operation.lease.token;
  await new DurableDryRun(f.args).process(id);assert.equal(f.calls.length,1);
  now+=100000;await new DurableDryRun(f.args).process(id);
  assert.equal((await f.get(id)).body.status,'SUCCEEDED');assert.deepEqual(f.calls,['TTS_PREFLIGHT','GENERIC_DRY_RUN','RUNTIME']);
  await assert.rejects(f.diagnostics.assertLease(id,token),/DRY_LEASE_LOST/);
});
test('restart during safe diagnostic read resumes same operation without provider dispatch',async()=>{
  let now=1000,die=true;
  const f=await setup({clock:()=>now,inject:async point=>{if(point==='STAGE_FINISHED_BEFORE_PERSIST'&&die){die=false;throw Object.assign(Error('killed'),{simulatedProcessDeath:true});}}});
  const id=(await f.call(payload)).body.operation_id;await assert.rejects(f.diagnostics.process(id),/killed/);
  now+=100000;await new DurableDryRun(f.args).process(id);
  const r=(await f.get(id)).body;assert.equal(r.status,'SUCCEEDED');assert.equal(r.attempt_count,2);assert.equal(f.store.episodes.size,1);
  assert.equal(r.provider_generation_calls,0);assert.equal(r.publication_calls,0);
});
test('result persisted before connection/process failure remains recoverable without rerun',async()=>{
  const f=await setup({inject:async point=>{if(point==='RESULT_PERSISTED')throw Object.assign(Error('killed'),{simulatedProcessDeath:true});}});
  const id=(await f.call(payload)).body.operation_id;await assert.rejects(f.diagnostics.process(id),/killed/);
  const before=await f.store.getEpisode(id);await new DurableDryRun(f.args).tick();
  assert.deepEqual(await f.store.getEpisode(id),before);assert.equal((await f.get(id)).body.status,'SUCCEEDED');assert.equal(f.calls.length,3);
});
test('different revision after redeploy preserves operation and rejects mixed-revision evidence',async()=>{
  const f=await setup(),id=(await f.call(payload)).body.operation_id;
  await new DurableDryRun({...f.args,env:{...baseEnv,RENDER_GIT_COMMIT:'b'.repeat(40)}}).tick();
  const r=(await f.get(id)).body;assert.equal(r.status,'OUTCOME_AMBIGUOUS');assert.equal(r.error_classification,'DRY_REVISION_CHANGED');assert.equal(f.calls.length,0);
});
test('durable errors redact arbitrary upstream text and do not retry',async()=>{
  const f=await setup({runStage:async()=>{throw Error('DO_NOT_STORE_secret_OR_signed_url');}}),id=(await f.call(payload)).body.operation_id;
  await f.diagnostics.tick();await f.diagnostics.tick();const r=(await f.get(id)).body;
  assert.equal(r.status,'FAILED');assert.equal(r.result_available,true);assert.equal(r.attempt_count,1);
  assert.doesNotMatch(JSON.stringify([...f.store.episodes]),/DO_NOT_STORE|signed_url/);
});
test('bounded stage timeout persists failure; late guard prevents further work',async()=>{
  let guard;
  const f=await setup({stageTimeoutMs:15,runStage:async(s,o,g)=>{guard=g;return new Promise(()=>{});}});
  const id=(await f.call(payload)).body.operation_id;await f.diagnostics.tick();
  assert.equal((await f.get(id)).body.error_classification,'DRY_STAGE_TIMEOUT');await assert.rejects(guard(),/DRY_STAGE_TIMEOUT/);
});
test('revoked owner and production scope cannot dispatch diagnostic stages',async()=>{
  let active=true;const f=await setup({validateOwner:async()=>active}),id=(await f.call(payload)).body.operation_id;
  active=false;await f.diagnostics.tick();assert.equal((await f.store.getEpisode(id)).status,'FAILED');assert.equal(f.calls.length,0);
  const other=await setup();await other.call(payload);await new DurableDryRun({...other.args,env:{...baseEnv,LUMI_RUNTIME_ENV:'production'}}).tick();
  assert.equal(other.calls.length,0);
});
test('missing live gates cannot turn fixture PASS into production readiness',()=>{
  const c=structuredClone(stages);c.TTS_PREFLIGHT.ELEVENLABS_AUTH='UNVERIFIED';c.RUNTIME.status='BLOCKED';
  assert.equal(buildDryResult(c).status,'BLOCKED');assert.ok(buildDryResult(c).blockers.includes('ELEVENLABS_AUTH'));
});
test('native TTS diagnostic uses authenticated read transport, immutable probe and existing receipts only',async()=>{
  const f=await setup(),id=(await f.call(payload)).body.operation_id,op=(await f.store.getEpisode(id)).metadata.dry_run_operation;
  const objects=new Map(),requests=[];let uploads=0;
  const client=createElevenLabsDirectClient({env:{ELEVENLABS_API_KEY:'SYNTHETIC_OFFLINE_CREDENTIAL'},fetchImpl:async(url,options)=>{
    requests.push({url,method:options.method});assert.equal(options.method,'GET');const path=new URL(url).pathname;
    return Response.json(path==='/v1/models'?[{model_id:'eleven_multilingual_v2',can_do_text_to_speech:true,languages:[{language_id:'es'}],maximum_text_length_per_request:10000}]
      :path==='/v1/user/subscription'?{tier:'starter',status:'active',character_count:69,character_limit:40000}
      :{voice_id:FERNANDA_SOURCE_ID,category:'professional',fine_tuning:{state:{eleven_multilingual_v2:'fine_tuned'}},available_for_tiers:['starter'],private_data:'DO_NOT_PERSIST'});
  }});
  const p=new ProductionReviewController({store:f.reviewStore,ttsRuntime:{client,storage:{download:async(b,p)=>objects.get(p),
    upload:async(b,p,v)=>{uploads++;objects.set(p,Buffer.from(v));},remove:async()=>assert.fail('no asset removal')}}});
  const first=await p.diagnosticStage('TTS_PREFLIGHT',op,async()=>{},baseEnv);
  const second=await p.diagnosticStage('TTS_PREFLIGHT',op,async()=>{},baseEnv);
  assert.equal(first.TTS_DRY_BOUNDARY,'PASS');assert.equal(first.TTS_STORAGE_GATE,'PASS');assert.deepEqual(first,second);
  assert.equal(uploads,1);assert.equal(objects.size,1);assert.equal(requests.length,6);
  assert.doesNotMatch(JSON.stringify(first),/SYNTHETIC_OFFLINE|DO_NOT_PERSIST|https:|Authorization/);
});
test('Supabase checkpoint adapter uses conflict-ignore insert and revision-filtered CAS',async()=>{
  const calls=[],query=new Proxy({}, {get:(t,method)=> (...args)=>{calls.push([method,...args]);return method==='maybeSingle'?Promise.resolve({data:null,error:null}):query;}});
  const store=new SupabaseLumiRecoveryStore({from:name=>{calls.push(['from',name]);return query;}});
  const row={episode_id:'dry_test',metadata:{operation_type:'AUTHENTICATED_DRY_RUN_V1',diagnostic_revision:3}};
  await store.createDiagnostic(row);await store.casDiagnostic(row,2);
  assert.ok(calls.some(x=>x[0]==='upsert'&&x[2].ignoreDuplicates===true));
  assert.ok(calls.some(x=>x[0]==='eq'&&x[1]==='metadata->>diagnostic_revision'&&x[2]==='2'));
  assert.ok(calls.filter(x=>x[0]==='from').every(x=>x[1]==='lumi_pipeline_checkpoints'));
});
test('runtime projection fails closed when Telegram creation adapter is absent; health remains unobserved',async()=>{
  const f=await setup(),id=(await f.call(payload)).body.operation_id,op=(await f.store.getEpisode(id)).metadata.dry_run_operation;
  const p=new ProductionReviewController({store:f.reviewStore,db:{from:()=>({select:()=>({or:()=>({limit:async()=>({data:[],error:null})})})})}});
  const r=await p.diagnosticStage('RUNTIME',op,async()=>{},baseEnv);
  assert.equal(r.status,'BLOCKED');assert.equal(r.live_generic_route_registered,false);
  assert.ok(r.blockers.includes('TELEGRAM_GENERIC_ROUTE_UNREGISTERED'));assert.equal(r.DIRECT_HEALTH_HTTP,'NOT_OBSERVED');
  assert.equal(r.health_observability,'HEALTH_OBSERVABILITY_WARNING');assert.equal(r.provider_generation_calls,0);assert.equal(r.publication_calls,0);
});
