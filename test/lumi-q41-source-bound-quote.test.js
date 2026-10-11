import test from 'node:test';
import assert from 'node:assert/strict';
import {isolatedFixture,secret} from './fixtures/isolated-validation-v2.js';
import {DIAGNOSTIC_Q41_SCOPE as scope,DIAGNOSTIC_Q41_KEY,DIAGNOSTIC_SCOPE,DIAGNOSTIC_TTS_SCOPE,DIAGNOSTIC_USD_SCOPE,diagnosticOperationId} from '../lib/lumi-v2-activation-context.js';
import {isolatedQ41Input,runIsolatedQ41Quote} from '../lib/lumi-isolated-usd-preflight.js';
import {IsolatedV2Validation} from '../lib/lumi-v2-isolated-validation.js';
import {MemoryLumiRecoveryStore} from '../lib/lumi-recovery-incident-manager-v1.js';
import {verifiedSignedMediaTransport} from '../lib/telegram-review-v1/runtime.js';
import {sha256} from '../lib/telegram-review-v1/core.js';
import {signRequest} from '../lib/telegram-review-v1/make-transport.js';

// All URLs, provider receipts and transports in this suite are synthetic.
// They establish offline contracts, never a remote SHA or live quote claim.
const d=isolatedQ41Input(),credential='Q41_OFFLINE_ONLY',token='SYNTHETIC_SIGNED_TOKEN';
const origin='https://q41-offline.supabase.co';
const signedUrl=origin+'/storage/v1/object/sign/'+d.canonical_artifact.bucket+'/'+d.canonical_artifact.path+'?token='+token;
async function setup({response,source,envPatch,...options}={}){
  const calls=[],sources=[];
  const f=await isolatedFixture({scope,envPatch:{HF_API_KEY:credential,SUPABASE_URL:origin,...envPatch},
    q41Source:async a=>{sources.push(a);return source?source(a):{url:signedUrl,sha256:a.sha256};},
    usdFetch:async(url,opts)=>{
      assert.equal(url,'https://api.higgsfield.ai/estimate/marketing-studio/image');
      assert.equal(opts.method,'POST');assert.equal(opts.redirect,'error');assert.equal(opts.headers.Authorization,'Key '+credential);
      calls.push({url,body:opts.body});return response?response():Response.json({usd:'0.248',credits:6.2,
        expires_at:'2026-11-01T00:00:00Z'},{headers:{'x-request-id':'offline-q41-receipt'}});
    },...options});
  assert.equal((await f.call('CONTEXT')).code,200);
  return Object.assign(f,{calls,sources});
}
function restart(f){return new IsolatedV2Validation({store:f.store,env:f.env,validateOwner:async()=>true,
  usdFetch:()=>assert.fail('NO_REQUOTE'),q41Source:()=>assert.fail('NO_RESIGN')});}
async function recover(runtime,f){
  const signed={timestamp:String(Math.floor(runtime.clock()/1000)),requestId:'read-q41-durable',method:'GET',
    path:`/lumi/telegram-review/make/diagnostic/local-operator/${f.base.operation_id}`,body:Buffer.alloc(0)};
  return runtime.http.query({signed,signature:signRequest(secret,signed),user:'local-operator',operationId:f.base.operation_id});
}

test('Q41_KEY_V2: only the fixed v2 key creates a new operation',async()=>{
  assert.equal(DIAGNOSTIC_Q41_KEY,'ep004:q41:source-bound-quote:v2');
  const f=await setup();try{
    assert.equal(f.base.operation_id,diagnosticOperationId('local-operator',DIAGNOSTIC_Q41_KEY,scope));
    const before=await f.read();
    assert.equal((await f.call('CONTEXT')).code,200); // Same key, fresh nonce: same context.
    const r=await f.call(scope);assert.equal(r.code,200);assert.equal(r.value.status,'QUOTE_VERIFIED');
    assert.equal((await f.call(scope)).value.already_applied,true);
    assert.equal(f.calls.length,1);assert.equal(f.sources.length,1);assert.equal(f.store.episodes.size,1);
    const v=await f.read();assert.deepEqual(v.grant,before.grant);assert.deepEqual(v.review,before.review);
    assert.equal(v.checkpoint,null);assert.deepEqual(v.objects,{});assert.deepEqual(v.journal,{});
    assert.equal(r.value.provider_generation_calls,0);assert.equal(r.value.telegram_mutation_calls,0);
    assert.equal(r.value.publication_calls,0);assert.equal(r.value.episode_created,false);
    assert.deepEqual(f.forbidden,[]);assert.deepEqual(globalThis.LUMI_OFFLINE_GUARD.attempts,[]);
  }finally{await f.cleanup();}
});

test('Q41_KEY_V2: v1 stays immutable even on rejected POST; signed GET still recovers its result',async()=>{
  const f=await setup();try{
    const key='ep004:q41:source-bound-quote:v1',id=diagnosticOperationId('local-operator',key,scope);
    const historical=await f.store.getEpisode(f.base.operation_id),v=historical.metadata.isolated_validation;
    historical.episode_id=id;v.operation_id=id;v.idempotency_key=key;
    v.expires_at='2026-10-11T18:10:25.247Z';v.staging_revision='d73e4c099d4861be5debe6740e919d7c21b6e463';
    v.grant={...v.grant,operation_id:id,expires_at:v.expires_at,request_sha:v.request_sha,
      user_id:'diagnostic:'+id.slice(8),episode_id:'diag_ep_'+id.slice(8,64)};
    v.nonces={'offline-historical-v1-nonce':'a'.repeat(64)};
    const blocked={operation_id:id,status:'BLOCKED',quote_status:'Q41_APPROVED_DESCRIPTOR_REQUIRED',
      quote_usd:null,provider_generation_calls:0,telegram_mutation_calls:0};
    v.results={[scope]:blocked};v.q41_quote_attempt={started_at:'2026-10-11T17:59:02.595Z',
      request_id:'offline-historical-v1-nonce',prepared:null,result:blocked};
    v.http_records=[];await f.store.putEpisode(historical);
    const original=JSON.stringify(await f.store.getEpisode(id));
    for(const phase of ['CONTEXT',scope,'STATUS']){
      const r=await f.call(phase,{idempotency_key:key,operation_id:id});
      assert.equal(r.code,400);assert.equal(r.value.error,'DIAGNOSTIC_OPERATION_MISMATCH');
      assert.equal(JSON.stringify(await f.store.getEpisode(id)),original);
    }
    const read=await recover(restart(f),{base:{operation_id:id}});
    assert.equal(read.status,200);assert.deepEqual(read.body.q41_quote,blocked);
    assert.equal(JSON.stringify(await f.store.getEpisode(id)),original);
    assert.notEqual(f.base.operation_id,id);
    const current=await f.read();assert.notDeepEqual(current.grant,v.grant);
    assert.equal(current.nonces['offline-historical-v1-nonce'],undefined);
    assert.equal((await f.call(scope)).value.status,'QUOTE_VERIFIED');
    assert.equal(f.calls.length,1);assert.equal(f.store.episodes.size,2);
    assert.equal(JSON.stringify(await f.store.getEpisode(id)),original);assert.deepEqual(f.forbidden,[]);
  }finally{await f.cleanup();}
});

for(const key of ['ep004:q41:source-bound-quote:v1','ep004:q41:source-bound-quote:v3','arbitrary-quote-key'])
test('Q41_KEY_V2: rejected key cannot create a diagnostic '+key,async()=>{
  const f=await isolatedFixture({scope});try{
    const r=await f.call('CONTEXT',{idempotency_key:key,operation_id:diagnosticOperationId('local-operator',key,scope)});
    assert.equal(r.code,400);assert.equal(r.value.error,'DIAGNOSTIC_OPERATION_MISMATCH');
    assert.equal(f.store.episodes.size,0);assert.deepEqual(f.forbidden,[]);
  }finally{await f.cleanup();}
});

test('Q41_KEY_V2: mismatched v1 identity cannot be used with v2 key',async()=>{
  const f=await isolatedFixture({scope});try{
    const r=await f.call('CONTEXT',{operation_id:diagnosticOperationId('local-operator','ep004:q41:source-bound-quote:v1',scope)});
    assert.equal(r.code,400);assert.equal(r.value.error,'DIAGNOSTIC_OPERATION_MISMATCH');
    assert.equal(f.store.episodes.size,0);
  }finally{await f.cleanup();}
});

test('Q41_KEY_V2: repeated nonce rejects replay; new nonce recovers without a second estimate',async()=>{
  const f=await setup();try{
    const e=f.envelope(scope,{},'offline-v2-quote-nonce');assert.equal((await f.send(e)).code,200);
    const r=await f.send(e);assert.equal(r.code,409);assert.equal(r.value.error,'replayed_request');
    const saved=(await f.read()).q41_quote_attempt;
    const runtime=restart(f);assert.equal((await runtime.http.run(e)).body.error,'replayed_request');
    assert.equal((await runtime.http.run(f.envelope(scope))).body.already_applied,true);
    assert.deepEqual((await recover(runtime,f)).body.q41_quote,saved.result);
    assert.deepEqual((await f.read()).q41_quote_attempt,saved);assert.equal(f.calls.length,1);assert.equal(f.sources.length,1);
  }finally{await f.cleanup();}
});

test('Q41_KEY_V2: changing signed key bytes cannot create a trusted v2 context',async()=>{
  const f=await isolatedFixture({scope});try{
    const oldKey='ep004:q41:source-bound-quote:v1';
    const e=f.envelope('CONTEXT',{idempotency_key:oldKey,operation_id:diagnosticOperationId('local-operator',oldKey,scope)});
    e.body={...e.body,idempotency_key:DIAGNOSTIC_Q41_KEY,operation_id:f.base.operation_id};
    e.signed.body=Buffer.from(JSON.stringify(e.body));
    assert.equal((await f.send(e)).code,401);assert.equal(f.store.episodes.size,0);
    assert.deepEqual(f.forbidden,[]);
  }finally{await f.cleanup();}
});

for(const fault of ['expired authorization','historical grant','production runtime','unsigned v2 key'])
test('Q41_KEY_V2: '+fault+' cannot authorize a quote',async()=>{
  const f=await setup();try{
    if(fault==='historical grant'){
      const row=await f.store.getEpisode(f.base.operation_id);
      row.metadata.isolated_validation.grant.operation_id=diagnosticOperationId('local-operator','ep004:q41:source-bound-quote:v1',scope);
      await f.store.putEpisode(row);
    }
    if(fault==='production runtime')f.env.LUMI_RUNTIME_ENV='production';
    const e=f.envelope(scope,fault==='expired authorization'?{expires_at:'2000-01-01T00:00:00Z'}:{});
    if(fault==='unsigned v2 key')e.signature='0'.repeat(64);
    const r=await f.send(e);assert.ok(r.code>=400);assert.equal(f.calls.length,0);assert.equal(f.sources.length,0);
    assert.equal((await f.read()).q41_quote_attempt,undefined);assert.deepEqual(f.forbidden,[]);
  }finally{await f.cleanup();}
});

function reorderKeys(value,compare){
  if(Array.isArray(value))return value.map(v=>reorderKeys(v,compare));
  if(!value||typeof value!=='object')return value;
  return Object.fromEntries(Object.keys(value).sort(compare).map(k=>[k,reorderKeys(value[k],compare)]));
}
// Offline persistence double, not a live PostgreSQL test. JSONB does not retain
// insertion order; this serializes keys by byte length then byte value, without
// changing values or array order. The expected request order was seen in staging.
const jsonbRoundTrip=value=>JSON.parse(JSON.stringify(reorderKeys(value,(a,b)=>
  Buffer.byteLength(a)-Buffer.byteLength(b)||Buffer.compare(Buffer.from(a),Buffer.from(b)))));

for(const [name,roundTrip] of [
  ['original descriptor',v=>JSON.parse(JSON.stringify(v))],
  ['REORDERED_KEYS',v=>reorderKeys(v,(a,b)=>b.localeCompare(a))],
  ['JSONB_ROUNDTRIP (offline persistence double)',jsonbRoundTrip]])
test('APPROVED_DESCRIPTOR_LOCK accepts '+name,async()=>{
  class Persisted extends MemoryLumiRecoveryStore{
    async putEpisode(value){return super.putEpisode(roundTrip(value));}
  }
  const f=await setup({store:new Persisted()});try{
    const before=await f.read();assert.deepEqual(before.request,d);
    if(name!=='original descriptor')assert.notEqual(JSON.stringify(before.request),JSON.stringify(d));
    if(name.startsWith('JSONB_ROUNDTRIP')){
      assert.deepEqual(Object.keys(before.request),['input','model','shot_id','episode_id','prompt_sha256',
        'descriptor_sha256','canonical_artifact','image_profile_sha256','production_profile_sha256']);
      assert.deepEqual(Object.keys(before.request.input),['prompt','quality','moderation','resolution','aspect_ratio','enhance_prompt']);
    }
    const r=await f.call(scope);assert.equal(r.code,200);assert.equal(r.value.status,'QUOTE_VERIFIED');
    assert.equal(f.calls.length,1);assert.deepEqual(f.sources,[d.canonical_artifact]);
    assert.deepEqual(JSON.parse(f.calls[0].body),{...d.input,image_urls:[signedUrl]});
    const saved=await f.read(),got=await recover(restart(f),f);
    assert.equal(got.status,200);assert.deepEqual(got.body.q41_quote,saved.results[scope]);
    assert.deepEqual(saved.request,d);assert.deepEqual(saved.review,before.review);
    assert.equal(r.value.first_image_budget_gate,'BLOCKED');assert.equal(r.value.episode_budget_gate,'BLOCKED');
    assert.equal(r.value.provider_generation_calls,0);assert.equal(r.value.telegram_mutation_calls,0);
    assert.equal(f.store.episodes.size,1);assert.equal(f.store.episodes.has(d.episode_id),false);
    for(const s of [credential,token,signedUrl])assert.ok(!JSON.stringify([saved,r.value,got]).includes(s));
    assert.deepEqual(f.forbidden,[]);assert.deepEqual(globalThis.LUMI_OFFLINE_GUARD.attempts,[]);
  }finally{await f.cleanup();}
});

for(const [name,mutate] of [
  ['content altered',v=>{v.input.quality='low';}],
  ['field omitted',v=>{delete v.input.moderation;}],
  ['model changed',v=>{v.model='other/image';}],
  ['prompt modified even with matching prompt hash',v=>{v.input.prompt+=' changed';v.prompt_sha256=sha256(v.input.prompt);}],
  ['source SHA changed',v=>{v.canonical_artifact.sha256='a'.repeat(64);}],
  ['source path changed',v=>{v.canonical_artifact.path='different/source.png';}],
  ['descriptor approval hash changed',v=>{v.descriptor_sha256='a'.repeat(64);}],
  ['extra field',v=>{v.input.image_urls=[signedUrl];}]])
test('SEMANTIC_MUTATION_REJECTED / APPROVED_DESCRIPTOR_LOCK: '+name,async()=>{
  // Exercise the exact descriptor guard independently of the outer CAS request
  // digest, so the test cannot pass merely because that earlier binding fails.
  const request=jsonbRoundTrip(d);mutate(request);
  const state={request},ns={read:async()=>structuredClone(state),write:async change=>change(state)};
  let sources=0,estimates=0;
  const args={command:{operation_id:'offline-q41-descriptor-lock',nonce:'offline-lock'},ns,clock:Date.now,
    env:{LUMI_RUNTIME_ENV:'staging',HF_API_KEY:credential,SUPABASE_URL:origin},
    sourceTransport:async()=>{sources++;assert.fail('MUTATED_DESCRIPTOR_SOURCE_FORBIDDEN');},
    fetchImpl:async()=>{estimates++;assert.fail('MUTATED_DESCRIPTOR_ESTIMATE_FORBIDDEN');}};
  const result=await runIsolatedQ41Quote(args);
  assert.equal(result.status,'BLOCKED');assert.equal(result.quote_status,'Q41_APPROVED_DESCRIPTOR_REQUIRED');
  assert.equal(result.quote_usd,null);assert.equal(result.first_image_budget_gate,'BLOCKED');
  assert.equal(result.episode_budget_gate,'BLOCKED');assert.equal(result.provider_generation_calls,0);
  assert.equal(result.telegram_mutation_calls,0);assert.deepEqual(state.q41_quote_attempt.result,result);
  assert.deepEqual(await runIsolatedQ41Quote(args),result);
  assert.equal(sources,0);assert.equal(estimates,0);
});

test('APPROVED_MODEL / 2K_HIGH / exact existing prompt plus canonical wand',()=>{
  assert.equal(d.model,'marketing-studio/image');assert.equal(d.input.resolution,'2k');assert.equal(d.input.quality,'high');
  assert.equal(d.input.aspect_ratio,'9:16');assert.equal(d.input.moderation,'auto');assert.equal(d.input.enhance_prompt,false);
  assert.match(d.input.prompt,/Lumi holds her canonical wand with a visible star, without duplication, disappearance or transformation\.$/);
  assert.match(d.input.prompt,/no bee abdomen/);assert.match(d.input.prompt,/two translucent blue wing assemblies/);
  assert.equal(sha256(d.input.prompt),d.prompt_sha256);assert.equal(d.input.image_urls,undefined);
});

test('SERVER_SIDE_SIGNED_SOURCE / USD_REQUIRED / exact payload SHA and durable safe metadata',async()=>{
  const f=await setup();try{
    const before=await f.read(),r=await f.call(scope),v=await f.read(),q=v.results[scope];
    assert.equal(r.code,200);assert.equal(q.status,'QUOTE_VERIFIED');assert.equal(f.calls.length,1);
    assert.deepEqual(f.sources,[d.canonical_artifact]);
    assert.deepEqual(JSON.parse(f.calls[0].body),{...d.input,image_urls:[signedUrl]});
    assert.equal(q.payload_sha256,sha256(f.calls[0].body));assert.equal(q.quote_usd,0.248);
    assert.equal(q.http_status,200);assert.equal(q.provider_request_id,'offline-q41-receipt');
    assert.equal(q.provider_units,6.2);assert.equal(q.quote_expiration,'2026-11-01T00:00:00.000Z');
    assert.ok(Number.isFinite(Date.parse(q.quote_timestamp)));assert.equal(q.q41_cost_ceiling_usd,null);
    assert.equal(q.first_image_budget_gate,'BLOCKED');assert.equal(q.episode_budget_gate,'BLOCKED');
    assert.equal(q.episode_total_budget_usd,5);assert.equal(q.provider_generation_calls,0);assert.equal(q.telegram_mutation_calls,0);
    assert.deepEqual(v.review,before.review);assert.equal(v.checkpoint,null);assert.deepEqual(v.objects,{});assert.deepEqual(v.journal,{});
    assert.equal(f.store.episodes.size,1);assert.equal(f.store.episodes.has(d.episode_id),false);
    assert.deepEqual(v.grant.scopes,[scope]);assert.equal(v.http_records.at(-1).stage_id,scope);
    for(const s of [credential,token,signedUrl])assert.ok(!JSON.stringify([v,r.value]).includes(s));
    assert.deepEqual(f.forbidden,[]);assert.deepEqual(globalThis.LUMI_OFFLINE_GUARD.attempts,[]);
  }finally{await f.cleanup();}
});

test('CANONICAL_SHA_REQUIRED: real storage loader rejects wrong remote bytes before signing',async()=>{
  let signs=0,downloads=0;
  const db={storage:{from:bucket=>{assert.equal(bucket,d.canonical_artifact.bucket);return {
    download:async path=>{assert.equal(path,d.canonical_artifact.path);downloads++;return {data:new Blob(['wrong remote bytes'])};},
    createSignedUrl:async()=>{signs++;assert.fail('must not sign wrong bytes');}};}}};
  const f=await setup({source:verifiedSignedMediaTransport(db)});try{
    const r=await f.call(scope);assert.equal(r.value.quote_status,'artifact_bytes_mismatch');
    assert.equal(downloads,1);assert.equal(signs,0);assert.equal(f.calls.length,0);
  }finally{await f.cleanup();}
});

test('existing verified transport signs only after byte hash check and uses 300 seconds',async()=>{
  const bytes=Buffer.from('SYNTHETIC_STORAGE_CONTRACT'),a={...d.canonical_artifact,size:bytes.length,sha256:sha256(bytes)};
  const events=[],db={storage:{from:()=>({download:async()=>{events.push('download');return {data:new Blob([bytes])};},
    createSignedUrl:async(path,ttl)=>{events.push('sign');assert.equal(path,a.path);assert.equal(ttl,300);return {data:{signedUrl}};}})}};
  const before=Date.now(),result=await verifiedSignedMediaTransport(db)(a);
  assert.deepEqual({url:result.url,sha256:result.sha256},{url:signedUrl,sha256:a.sha256});
  assert.ok(Date.parse(result.expires_at)>=before+300000&&Date.parse(result.expires_at)<=Date.now()+300000);
  assert.deepEqual(events,['download','sign']);
});

for(const [name,source] of [
  ['missing SHA',()=>({url:signedUrl})],['wrong SHA',()=>({url:signedUrl,sha256:'a'.repeat(64)})],
  ['external URL',a=>({url:'https://other.invalid/source',sha256:a.sha256})],
  ['unsigned URL',a=>({url:signedUrl.split('?')[0],sha256:a.sha256})]])
test('source binding rejects '+name,async()=>{const f=await setup({source});try{
  assert.equal((await f.call(scope)).value.status,'BLOCKED');assert.equal(f.calls.length,0);
}finally{await f.cleanup();}});

for(const [name,patch] of [
  ['NO_CLIENT_SUPPLIED_URL',{image_urls:[signedUrl]}],['NO_CLIENT_SUPPLIED_PROMPT',{prompt:'override'}],
  ['client request',{request:{input:d.input}}],['NO_GENERATION',{provider_generation:true}],
  ['NO_TELEGRAM_MUTATION',{telegram_mutation:true}],['NO_PUBLICATION',{publication:true}],['CREATE',{phase:'CREATE'}],['RESUME',{phase:'RESUME'}],
  ['batch quote',{phase:'USD_PREFLIGHT'}],['price',{quote_usd:0}]])
test(name+' rejected at HMAC boundary',async()=>{const f=await setup();try{
  assert.ok((await f.call(scope,patch)).code>=400);assert.equal(f.calls.length,0);assert.equal(f.sources.length,0);
  assert.deepEqual(f.forbidden,[]);
}finally{await f.cleanup();}});

test('HMAC_REQUIRED: invalid signature cannot read source, quote or create diagnostic row',async()=>{
  const f=await isolatedFixture({scope});try{const e=f.envelope('CONTEXT');e.signature='0'.repeat(64);
    assert.equal((await f.send(e)).code,401);assert.equal(f.store.episodes.size,0);
  }finally{await f.cleanup();}
});
for(const other of [DIAGNOSTIC_SCOPE,DIAGNOSTIC_TTS_SCOPE,DIAGNOSTIC_USD_SCOPE])
test('other diagnostic scope cannot quote q41 '+other,async()=>{
  const f=await isolatedFixture({scope:other});try{assert.equal((await f.call('CONTEXT')).code,200);
    assert.equal((await f.call(scope)).code,403);
  }finally{await f.cleanup();}
});

test('fixed operation key prevents a new key from resetting the single quote',async()=>{
  const f=await setup();try{
    assert.equal(f.base.idempotency_key,DIAGNOSTIC_Q41_KEY);
    const key='new-quote-request';const r=await f.call('CONTEXT',{idempotency_key:key,operation_id:diagnosticOperationId('local-operator',key,scope)});
    assert.equal(r.code,400);assert.equal(f.store.episodes.size,1);assert.equal(f.calls.length,0);
  }finally{await f.cleanup();}
});

for(const payload of [{credits:10},{usd:null,credits:6.2}])test('CREDITS_ONLY_REJECTED '+JSON.stringify(payload),async()=>{
  const f=await setup({response:()=>Response.json(payload,{headers:{'x-request-id':'offline-missing-usd'}})});try{
    const q=(await f.call(scope)).value;assert.equal(q.quote_status,'USD_REQUIRED');assert.equal(q.quote_usd,null);
    assert.equal(q.http_status,200);assert.equal(q.provider_request_id,'offline-missing-usd');assert.equal(q.first_image_budget_gate,'BLOCKED');
    await f.call(scope);assert.equal(f.calls.length,1);
  }finally{await f.cleanup();}
});

test('DURABLE_RESULT_RECOVERY after runtime restart and expiration uses read-only GET without re-quote',async()=>{
  const f=await setup();try{await f.call(scope);const v=await f.read(),runtime=restart(f);runtime.clock=()=>Date.now()+3600000;
    const got=await recover(runtime,f);assert.equal(got.status,200);assert.deepEqual(got.body.q41_quote,v.results[scope]);
    runtime.clock=Date.now;
    assert.deepEqual(await f.read(),v);const resumed=await runtime.http.run(f.envelope(scope));
    assert.equal(resumed.body.already_applied,true);assert.equal(f.calls.length,1);
  }finally{await f.cleanup();}
});

for(const failure of ['timeout','http','malformed'])test('no automatic resubmit after '+failure,async()=>{
  const f=await setup({response:()=>{if(failure==='timeout')throw Error('timeout '+signedUrl+' '+credential);
    return failure==='http'?new Response('private',{status:503,headers:{'x-request-id':'offline-error'}}):new Response('not-json',{status:200});}});
  try{await f.call(scope);const runtime=restart(f),r=await recover(runtime,f);
    assert.equal(r.body.q41_quote.status,'BLOCKED');assert.equal(r.body.q41_quote.quote_usd,null);
    await runtime.http.run(f.envelope(scope));assert.equal(f.calls.length,1);
    assert.ok(!JSON.stringify(await f.read()).includes(token));assert.ok(!JSON.stringify(await f.read()).includes(credential));
    if(failure==='http')assert.equal(r.body.q41_quote.http_status,503);
    if(failure==='malformed')assert.equal(r.body.q41_quote.http_status,200);
  }finally{await f.cleanup();}
});

test('saved quote survives phase response failure and is recovered without a second estimate',async()=>{
  const f=await setup({inject:async e=>{if(e.point==='Q41_QUOTE_COMPLETED')throw Error('simulate-crash-after-receipt');}});
  try{assert.equal((await f.call(scope)).code,500);assert.equal((await f.read()).results[scope],undefined);
    const runtime=restart(f),r=await recover(runtime,f);assert.equal(r.body.q41_quote.quote_usd,0.248);
    assert.equal((await runtime.http.run(f.envelope(scope))).body.quote_usd,0.248);assert.equal(f.calls.length,1);
  }finally{await f.cleanup();}
});

test('CAS intent failure prevents source reads and provider I/O',async()=>{
  class Failing extends MemoryLumiRecoveryStore{async casDiagnostic(row,rev){
    if(row.metadata.isolated_validation.q41_quote_attempt)throw Error('offline-store-failed');return super.casDiagnostic(row,rev);
  }}
  const f=await setup({store:new Failing()});try{assert.notEqual((await f.call(scope)).code,200);
    assert.equal(f.calls.length,0);assert.equal(f.sources.length,0);
  }finally{await f.cleanup();}
});

test('result persistence failure leaves intent and prevents quote replay',async()=>{
  class Failing extends MemoryLumiRecoveryStore{async casDiagnostic(row,rev){
    if(row.metadata.isolated_validation.q41_quote_attempt?.result&&!this.recovered)throw Error('offline-result-failed');
    return super.casDiagnostic(row,rev);
  }}
  const f=await setup({store:new Failing()});try{
    assert.notEqual((await f.call(scope)).code,200);f.store.recovered=true;
    const r=await restart(f).http.run(f.envelope(scope));assert.equal(r.body.quote_status,'QUOTE_ATTEMPT_OUTCOME_UNPROVEN');
    assert.equal(f.calls.length,1);
  }finally{await f.cleanup();}
});

test('concurrent calls have one source binding and one estimate',async()=>{
  let entered,release;const barrier=new Promise(r=>entered=r),wait=new Promise(r=>release=r);
  const f=await setup({response:async()=>{entered();await wait;return Response.json({usd:0.248});}});
  try{const pending=f.call(scope);await barrier;assert.equal((await f.call(scope)).code,409);
    release();assert.equal((await pending).code,200);assert.equal(f.calls.length,1);assert.equal(f.sources.length,1);
  }finally{release();await f.cleanup();}
});
