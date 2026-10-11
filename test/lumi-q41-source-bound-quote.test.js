import test from 'node:test';
import assert from 'node:assert/strict';
import {isolatedFixture,secret} from './fixtures/isolated-validation-v2.js';
import {DIAGNOSTIC_Q41_SCOPE as scope,DIAGNOSTIC_Q41_KEY,DIAGNOSTIC_SCOPE,DIAGNOSTIC_TTS_SCOPE,DIAGNOSTIC_USD_SCOPE,diagnosticOperationId} from '../lib/lumi-v2-activation-context.js';
import {isolatedQ41Input} from '../lib/lumi-isolated-usd-preflight.js';
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
  assert.deepEqual(await verifiedSignedMediaTransport(db)(a),{url:signedUrl,sha256:a.sha256});
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
  ['NO_TELEGRAM_MUTATION',{telegram_mutation:true}],['CREATE',{phase:'CREATE'}],['RESUME',{phase:'RESUME'}],
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
