import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {isolatedFixture,secret} from './fixtures/isolated-validation-v2.js';
import {DIAGNOSTIC_SCOPE,DIAGNOSTIC_TTS_SCOPE,diagnosticOperationId} from '../lib/lumi-v2-activation-context.js';
import {LUMI_VOICE_PROFILE_V3 as voice} from '../lib/lumi-production-profile-v2.js';
import {IsolatedV2Validation} from '../lib/lumi-v2-isolated-validation.js';
import {MemoryLumiRecoveryStore,assertTtsStorageGate} from '../lib/lumi-recovery-incident-manager-v1.js';
import {executeLumiTtsStage} from '../lib/lumi-tts-stage-v2.js';
import {signRequest} from '../lib/telegram-review-v1/make-transport.js';

const fakeCredential='OFFLINE_TTS_PREFLIGHT_ONLY_NOT_A_REAL_KEY';
const model={model_id:voice.model_id,can_do_text_to_speech:true,languages:[{language_id:'es'}],maximum_text_length_per_request:10000,token_cost_factor:1};
const account={voice_id:voice.voice_id,category:'professional',fine_tuning:{state:{[voice.model_id]:'fine_tuned'}},available_for_tiers:['starter']};
const quota={tier:'starter',status:'active',character_count:100,character_limit:40000};
async function fixture({fetchResponse,envPatch={},...options}={}){
  const calls=[];
  const f=await isolatedFixture({scope:DIAGNOSTIC_TTS_SCOPE,envPatch:{ELEVENLABS_API_KEY:fakeCredential,...envPatch},
    ttsFetch:async(url,opts)=>{
      const path=new URL(url).pathname;
      assert.equal(new URL(url).origin,'https://api.elevenlabs.io');
      assert.equal(opts.method,'GET');assert.equal(opts.headers['xi-api-key'],fakeCredential);
      assert.equal(opts.body,undefined);calls.push({path,method:opts.method});
      assert.ok(['/v1/models','/v1/user/subscription','/v1/voices/'+voice.voice_id].includes(path));
      return fetchResponse?fetchResponse(path,opts):Response.json(path==='/v1/models'?[model]:path==='/v1/user/subscription'?quota:account);
    },...options});
  return Object.assign(f,{calls});
}
async function setup(options){const f=await fixture(options);assert.equal((await f.call('CONTEXT')).code,200);return f;}
const terminal=v=>v.http_records.filter(r=>r.event_kind==='HTTP_RESULT');

test('real generic TTS executor reaches durable dry boundary in a TTS-only context without the five gates',async()=>{
  const f=await setup();try{
    const historical={episode_id:'local_previous_five_gates',metadata:{immutable:true,results:{RESULT:{status:'PASS',gates:{CREATE_ROUTE:'PASS',RESUME_ROUTE:'PASS',REVIEW_ROUTE:'PASS',REAL_INPUT_MATERIALIZER:'PASS',CONTROLLED_ACTIVATION:'PASS'}}}}};
    await f.store.putEpisode(historical);
    const before=await f.read(),e=f.envelope('TTS_PREFLIGHT'),r=await f.send(e),v=await f.read();
    assert.equal(r.code,200,JSON.stringify(r.value));assert.equal(r.value.status,'DRY_PROVIDER_BOUNDARY');
    const result=v.results.TTS_PREFLIGHT;
    for(const key of ['auth_result','voice_callable_result','model_result','quota_result','budget_result','storage_result','dry_boundary_result'])assert.equal(result[key],'PASS',key);
    assert.equal(result.request_id,e.signed.requestId);assert.equal(result.operation_id,f.base.operation_id);
    assert.equal(result.profile_version,3);assert.equal(result.voice_profile_id,'LUMI_VOICE_PROFILE_V3');
    assert.equal(result.voice_id,voice.voice_id);assert.equal(result.model_id,'eleven_multilingual_v2');
    assert.equal(result.provider,'ElevenLabs Direct API');assert.equal(result.remaining_characters,39900);
    assert.equal(result.estimated_quota_units,[...v.request.text].length);
    assert.equal(result.storage_scope,'DIAGNOSTIC_STORAGE_ROUNDTRIP_ONLY');assert.equal(result.audio_decode,'NOT_RUN');
    assert.equal(f.calls.length,3);assert.equal(v.journal[result.receipt_key].state,'DRY_PROVIDER_BOUNDARY');
    assert.equal(v.journal[result.receipt_key].request_constructed,true);
    assert.equal(Object.keys(v.objects).length,1);assert.match(Buffer.from(Object.values(v.objects)[0],'base64').toString(),/NON-MEDIA BYTES; NO AUDIO/);
    assert.deepEqual(v.grant.scopes,['TTS_PREFLIGHT']);assert.equal(v.checkpoint,null);assert.equal(v.lease,null);
    assert.deepEqual(v.review,before.review);assert.deepEqual(v.materializations,{});
    assert.deepEqual(Object.keys(v.results).sort(),['CONTEXT','TTS_PREFLIGHT']);
    assert.deepEqual(await f.store.getEpisode(historical.episode_id),historical);
    assert.equal(terminal(v).at(-1).stage_id,'TTS_PREFLIGHT');assert.equal(terminal(v).at(-1).http_status,200);
    assert.equal(terminal(v).at(-1).request_id,e.signed.requestId);assert.equal(terminal(v).at(-1).lease_state,'FREE');
    assert.equal(terminal(v).at(-1).checkpoint_version,null);
    assert.equal(r.value.provider_generation_calls,0);assert.equal(r.value.publication_calls,0);assert.equal(r.value.telegram_mutation_calls,0);
    assert.deepEqual(f.forbidden,[]);assert.deepEqual(globalThis.LUMI_OFFLINE_GUARD.attempts,[]);
    const serialized=JSON.stringify(v);for(const value of [fakeCredential,secret,'xi-api-key','Authorization','signed_url'])assert.ok(!serialized.includes(value));
  }finally{await f.cleanup();}
});

for(const [patch,status] of [
  [{provider_generation:true},403],[{publication:true},403],[{telegram_mutation:true},403],[{dry_run:false},403],
  [{audience:'production'},403],[{scope:'TTS_GENERATE'},400],
  [{phase:'CREATE'},403],[{phase:'RESUME'},403],[{phase:'REVIEW',decision:'APPROVED'},403],[{phase:'RESULT'},403],
  [{phase:'TTS_GENERATE'},400],[{phase:'IMAGE_GENERATE'},400],[{phase:'VIDEO_GENERATE'},400],
  [{request:{voice_id:'unapproved',text:'override'}},400],[{message_id:138},400],
  [{expires_at:'2000-01-01T00:00:00Z'},403]
])test('TTS scope rejects '+JSON.stringify(patch),async()=>{
  const f=await setup();try{
    const before=await f.read(),r=await f.call('TTS_PREFLIGHT',patch),after=await f.read();
    assert.equal(r.code,status,JSON.stringify(r.value));assert.equal(f.calls.length,0);
    for(const key of ['results','checkpoint','review','journal','objects','grant'])assert.deepEqual(after[key],before[key]);
    assert.deepEqual(f.forbidden,[]);
  }finally{await f.cleanup();}
});

test('five-gate scope cannot execute TTS; scope separation leaves historical operation IDs unchanged',async()=>{
  const f=await isolatedFixture();try{
    assert.equal((await f.call('CONTEXT')).code,200);const before=await f.read();
    assert.equal((await f.call('TTS_PREFLIGHT')).code,403);
    assert.deepEqual((await f.read()).results,before.results);assert.deepEqual(f.forbidden,[]);
    assert.notEqual(diagnosticOperationId('local-operator','key12345',DIAGNOSTIC_TTS_SCOPE),diagnosticOperationId('local-operator','key12345'));
    assert.equal(diagnosticOperationId('local-operator','key12345',DIAGNOSTIC_SCOPE),diagnosticOperationId('local-operator','key12345'));
  }finally{await f.cleanup();}
});

test('HMAC, active owner, staging and allowlist are mandatory before any protected write',async()=>{
  let active=true;const f=await setup({validateOwner:async()=>active});try{
    const before=await f.store.getEpisode(f.base.operation_id);
    for(const sig of [undefined,'0'.repeat(64)]){const e=f.envelope('TTS_PREFLIGHT');e.signature=sig;assert.equal((await f.send(e)).code,401);}
    const e=f.envelope('TTS_PREFLIGHT');e.signed.timestamp=String(Math.floor(Date.now()/1000)-200);e.signature=signRequest(secret,e.signed);
    assert.equal((await f.send(e)).code,401);
    assert.equal((await f.call('TTS_PREFLIGHT',{user_id:'foreign',chat_id:'foreign'})).code,404);
    active=false;assert.equal((await f.call('TTS_PREFLIGHT')).code,403);active=true;
    f.env.LUMI_RUNTIME_ENV='production';assert.equal((await f.call('TTS_PREFLIGHT')).code,404);
    assert.deepEqual(await f.store.getEpisode(f.base.operation_id),before);assert.equal(f.calls.length,0);assert.deepEqual(f.forbidden,[]);
  }finally{await f.cleanup();}
});

test('expired context cannot be renewed or reused, even with a new nonce and signature',async()=>{
  let now=Date.now();const f=await fixture({clock:()=>now});try{
    f.base.expires_at=new Date(now+60000).toISOString();assert.equal((await f.call('CONTEXT')).code,200);
    const before=await f.read();now=Date.parse(f.base.expires_at)+1;
    assert.equal((await f.call('TTS_PREFLIGHT')).value.error,'DIAGNOSTIC_EXPIRED');
    assert.equal((await f.call('TTS_PREFLIGHT',{expires_at:new Date(now+60000).toISOString()})).value.error,'DIAGNOSTIC_BINDING_MISMATCH');
    assert.equal(f.calls.length,0);assert.deepEqual((await f.read()).grant,before.grant);
    assert.deepEqual((await f.read()).results,before.results);
  }finally{await f.cleanup();}
});

test('idempotent context and preflight preserve one receipt; restart and signed GET recover without I/O',async()=>{
  const f=await setup();try{
    assert.equal((await f.call('CONTEXT')).code,200);
    const e=f.envelope('TTS_PREFLIGHT');assert.equal((await f.send(e)).code,200);
    const saved=await f.read();assert.equal((await f.send(e)).code,409);
    const restarted=new IsolatedV2Validation({store:f.store,env:f.env,validateOwner:async()=>true,
      ttsFetch:()=>assert.fail('cached result must not call provider')});
    const next=await restarted.http.run(f.envelope('TTS_PREFLIGHT'));
    assert.equal(next.status,200);assert.equal(next.body.already_applied,true);
    assert.equal(f.calls.length,3);const v=await f.read();assert.deepEqual(v.results,saved.results);
    assert.deepEqual(v.journal,saved.journal);assert.deepEqual(v.objects,saved.objects);assert.equal(f.store.episodes.size,1);
    const path='/lumi/telegram-review/make/diagnostic/local-operator/'+f.base.operation_id+'/'+e.signed.requestId;
    const signed={method:'GET',path,body:Buffer.alloc(0),requestId:randomUUID(),timestamp:String(Math.floor(Date.now()/1000))};
    const before=await f.store.getEpisode(f.base.operation_id);
    const q=await restarted.http.query({signed,signature:signRequest(secret,signed),user:'local-operator',operationId:f.base.operation_id,requestId:e.signed.requestId});
    assert.equal(q.status,200);assert.deepEqual(q.body.http_records.filter(r=>r.event_kind==='HTTP_RESULT').map(r=>r.http_status),[200,409]);
    assert.deepEqual(await f.store.getEpisode(f.base.operation_id),before);
  }finally{await f.cleanup();}
});

test('concurrent TTS requests have one executor owner, durable busy error and no duplicate operation',async()=>{
  let entered,release;const barrier=new Promise(r=>entered=r),wait=new Promise(r=>release=r);
  const f=await setup({fetchResponse:async path=>{if(path==='/v1/models'){entered();await wait;return Response.json([model]);}
    return Response.json(path==='/v1/user/subscription'?quota:account);}});
  try{
    const first=f.call('TTS_PREFLIGHT');await barrier;
    const busy=await f.call('TTS_PREFLIGHT');assert.equal(busy.code,409);assert.equal(busy.value.error,'DIAGNOSTIC_BUSY');
    release();assert.equal((await first).code,200);assert.equal(f.calls.length,3);
    const v=await f.read();assert.equal(f.store.episodes.size,1);assert.equal(Object.keys(v.journal).length,1);
    assert.equal(Object.keys(v.objects).length,1);assert.equal(v.lease,null);
    assert.deepEqual(terminal(v).map(e=>e.http_status),[200,409,200]);
  }finally{release();await f.cleanup();}
});

for(const [mode,expected] of [['auth','DIAGNOSTIC_TTS_AUTH_FAILED'],['voice','DIAGNOSTIC_TTS_VOICE_MODEL_FAILED'],
  ['quota','DIAGNOSTIC_TTS_QUOTA_FAILED'],['budget','DIAGNOSTIC_TTS_BUDGET_FAILED'],['unexpected','DIAGNOSTIC_TTS_PREFLIGHT_FAILED']])
test('failed '+mode+' gate is sanitized, durable and idempotent',async()=>{
  const f=await setup({fetchResponse:async path=>{
    if(mode==='auth')return Response.json({detail:{status:'invalid_api_key',message:fakeCredential+' Authorization PRIVATE_COOKIE'}},{status:401});
    if(mode==='unexpected')throw Error(fakeCredential+' signed_url=PRIVATE');
    return Response.json(path==='/v1/models'?[model]:path==='/v1/user/subscription'
      ?mode==='quota'?{...quota,character_limit:null}:mode==='budget'?{...quota,character_limit:100}:quota
      :mode==='voice'?{...account,fine_tuning:{state:{}}}:account);
  }});try{
    const r=await f.call('TTS_PREFLIGHT');assert.equal(r.code,422,JSON.stringify(r.value));assert.equal(r.value.error,expected);
    const v=await f.read();assert.equal(v.results.TTS_PREFLIGHT.status,'BLOCKED');assert.equal(v.results.TTS_PREFLIGHT.error_code,expected);
    assert.equal(v.lease,null);assert.equal(v.checkpoint,null);assert.equal(terminal(v).at(-1).error_code,expected);
    assert.ok(!JSON.stringify(v).includes(fakeCredential));assert.ok(!JSON.stringify(v).includes('PRIVATE'));
    const count=f.calls.length;assert.equal((await f.call('TTS_PREFLIGHT')).value.error,expected);assert.equal(f.calls.length,count);
    assert.deepEqual((await f.read()).results,v.results);assert.deepEqual(f.forbidden,[]);
  }finally{await f.cleanup();}
});

test('missing credential remains blocked with a durable safe error and zero transport calls',async()=>{
  const f=await setup({envPatch:{ELEVENLABS_API_KEY:''}});try{
    const r=await f.call('TTS_PREFLIGHT');assert.equal(r.code,503);assert.equal(r.value.error,'DIAGNOSTIC_TTS_TRANSPORT_UNAVAILABLE');
    assert.equal(f.calls.length,0);assert.equal((await f.read()).results.TTS_PREFLIGHT.auth_result,'NOT_RUN');
  }finally{await f.cleanup();}
});

test('actual isolated storage write failure cannot pass the real storage gate',async()=>{
  class FailingStore extends MemoryLumiRecoveryStore{
    async casDiagnostic(row,rev){if(Object.keys(row.metadata.isolated_validation.objects).length)throw Error('PRIVATE_STORAGE_FAILURE');return super.casDiagnostic(row,rev);}
  }
  const f=await setup({store:new FailingStore()});try{
    const r=await f.call('TTS_PREFLIGHT');assert.equal(r.code,422);assert.equal(r.value.error,'DIAGNOSTIC_TTS_STORAGE_FAILED');
    const v=await f.read();assert.equal(v.results.TTS_PREFLIGHT.auth_result,'PASS');assert.notEqual(v.results.TTS_PREFLIGHT.storage_result,'PASS');
    assert.deepEqual(v.objects,{});assert.deepEqual(v.journal,{});assert.equal(v.lease,null);
    assert.ok(!JSON.stringify(v).includes('PRIVATE_STORAGE_FAILURE'));
  }finally{await f.cleanup();}
});

test('storage read corruption is detected by the real SHA gate',async()=>{
  class CorruptStore extends MemoryLumiRecoveryStore{
    async getEpisode(id){const row=await super.getEpisode(id),objects=row?.metadata?.isolated_validation?.objects;
      if(objects)for(const key of Object.keys(objects))objects[key]=Buffer.from('CORRUPT_NON_MEDIA').toString('base64');
      return row;
    }
  }
  const f=await setup({store:new CorruptStore()});try{
    const r=await f.call('TTS_PREFLIGHT');assert.equal(r.code,422);assert.equal(r.value.error,'DIAGNOSTIC_TTS_STORAGE_FAILED');
    assert.notEqual((await f.read()).results.TTS_PREFLIGHT.storage_result,'PASS');assert.equal(f.calls.length,3);
  }finally{await f.cleanup();}
});

test('lease expiry during provider reads fails closed before any receipt or storage write',async()=>{
  let now=Date.now();const f=await setup({clock:()=>now,leaseMs:1000,fetchResponse:async path=>{
    now+=1500;return Response.json(path==='/v1/models'?[model]:path==='/v1/user/subscription'?quota:account);
  }});try{
    const r=await f.call('TTS_PREFLIGHT');assert.notEqual(r.code,200);
    const v=await f.read();assert.deepEqual(v.objects,{});assert.deepEqual(v.journal,{});
    assert.equal(v.results.TTS_PREFLIGHT,undefined);assert.equal(v.checkpoint,null);assert.deepEqual(f.forbidden,[]);
  }finally{await f.cleanup();}
});

test('HTTP result storage failure returns 503; no success response or automatic continuation',async()=>{
  class FailingStore extends MemoryLumiRecoveryStore{
    async casDiagnostic(row,rev){const event=row.metadata.isolated_validation.http_records.at(-1);
      if(event.request_phase==='TTS_PREFLIGHT'&&event.event_kind==='HTTP_RESULT')throw Error('PRIVATE_STORE_FAILURE');return super.casDiagnostic(row,rev);}
  }
  const f=await setup({store:new FailingStore()});try{
    const r=await f.call('TTS_PREFLIGHT');assert.equal(r.code,503);assert.equal(r.value.http_result_persisted,false);
    assert.equal(r.value.error,'DIAGNOSTIC_HTTP_PERSISTENCE_FAILED');assert.equal(f.calls.length,3);
    const v=await f.read();assert.equal(v.results.TTS_PREFLIGHT.status,'DRY_PROVIDER_BOUNDARY');assert.equal(v.checkpoint,null);
    assert.equal(v.http_records.at(-1).result_status,'OUTCOME_UNKNOWN');assert.deepEqual(f.forbidden,[]);
  }finally{await f.cleanup();}
});

test('diagnostic byte probe cannot satisfy production audio gates or enter generation',async()=>{
  assert.throws(()=>assertTtsStorageGate({status:'PASS',diagnostic_only:true}),/NOT_PASS/);
  assert.doesNotThrow(()=>assertTtsStorageGate({status:'PASS',diagnostic_only:true},{allowDiagnosticOnly:true}));
  const f=await setup();try{
    const v=await f.read();let calls=0;
    for(const patch of [{dry_run:false},{require_preflight:false},{episode_id:'production'},{output_artifact_target:{bucket:'generated-audio',prefix:'production'}}])
      await assert.rejects(executeLumiTtsStage({...v.request,...patch},{diagnosticStorageProbe:true,probeBytes:Buffer.from('NON-MEDIA'),client:{preflight:()=>calls++,submit:()=>calls++}}),/SCOPE_DENIED/);
    assert.equal(calls,0);
  }finally{await f.cleanup();}
});
