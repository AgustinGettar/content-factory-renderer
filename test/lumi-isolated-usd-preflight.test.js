import test from 'node:test';
import assert from 'node:assert/strict';
import {isolatedFixture,secret} from './fixtures/isolated-validation-v2.js';
import {DIAGNOSTIC_SCOPE,DIAGNOSTIC_TTS_SCOPE,DIAGNOSTIC_USD_SCOPE} from '../lib/lumi-v2-activation-context.js';
import {IsolatedV2Validation} from '../lib/lumi-v2-isolated-validation.js';
import {MemoryLumiRecoveryStore} from '../lib/lumi-recovery-incident-manager-v1.js';
import {isolatedUsdInput} from '../lib/lumi-isolated-usd-preflight.js';
import {quoteFourthEpisodeUsd} from '../lib/lumi-fourth-episode-usd-preflight.js';

const credential='OFFLINE_USD_TEST_ONLY_NOT_REAL';
async function setup({response,envPatch,...options}={}){
  const calls=[];
  const f=await isolatedFixture({scope:DIAGNOSTIC_USD_SCOPE,envPatch:{HF_API_KEY:credential,...envPatch},
    usdFetch:async(url,opts)=>{
      assert.ok(['https://api.higgsfield.ai/estimate/marketing-studio/image',
        'https://api.higgsfield.ai/estimate/kling-video/v3.0/pro/image-to-video'].includes(url));
      assert.equal(opts.method,'POST');assert.equal(opts.redirect,'error');assert.equal(opts.headers.Authorization,'Key '+credential);
      const input=JSON.parse(opts.body);assert.equal(input.image_url,undefined);assert.equal(input.image_urls,undefined);
      calls.push({url,input});return response?response(calls.length):Response.json({usd:'0.30',credits:7});
    },...options});
  assert.equal((await f.call('CONTEXT')).code,200);return Object.assign(f,{calls});
}

test('USD-only HMAC route persists the source dependency without any provider I/O',async()=>{
  const f=await setup();try{
    const initial=await f.read(),r=await f.call('USD_PREFLIGHT'),v=await f.read();
    assert.equal(r.code,200,JSON.stringify(r.value));assert.equal(f.calls.length,0);
    const q=v.results.USD_PREFLIGHT;
    assert.equal(q.quote_status,'KLING_SOURCE_BOUND_QUOTE_REQUIRED');assert.equal(q.status,'BLOCKED');
    assert.equal(q.image_total_usd,null);assert.equal(q.video_total_usd,null);assert.equal(q.budget_gate,'BLOCKED');
    assert.equal(q.quote_kind,'CONFIGURATION_QUOTE');assert.equal(q.generation_authorized,false);
    assert.equal(q.higgsfield_auth,'UNVERIFIED');assert.equal(q.tts_cost_usd,null);
    assert.equal(q.episode_id,'ep_lumi_granja_004_20261008_ee7ab4b3');assert.equal(q.episode_created,false);
    assert.equal(q.provider_generation_calls,0);assert.equal(q.publication_calls,0);assert.equal(q.telegram_mutation_calls,0);
    assert.deepEqual(v.grant.scopes,['USD_PREFLIGHT']);assert.equal(v.checkpoint,null);assert.equal(v.lease,null);
    assert.deepEqual(v.review,initial.review);assert.deepEqual(v.objects,{});assert.deepEqual(v.journal,{});
    assert.equal(v.http_records.at(-1).stage_id,'USD_PREFLIGHT');assert.equal(r.value.http_result_persisted,true);
    const serialized=JSON.stringify(v);for(const s of [credential,secret,'Authorization','https://example'])assert.ok(!serialized.includes(s));
    assert.deepEqual(f.forbidden,[]);assert.deepEqual(globalThis.LUMI_OFFLINE_GUARD.attempts,[]);
    assert.deepEqual((await f.call('STATUS')).value.results.USD_PREFLIGHT,q);
  }finally{await f.cleanup();}
});

for(const [name,patch] of [['create',{phase:'CREATE'}],['resume',{phase:'RESUME'}],['tts',{phase:'TTS_PREFLIGHT'}],
  ['generation',{provider_generation:true}],['publication',{publication:true}],['telegram',{telegram_mutation:true}],
  ['request',{request:{envelopes:[],budget_gate:'PASS'}}],['price override',{tts_cost_usd:0}],['message',{message_id:138}]])
test('USD scope rejects '+name+' without provider access',async()=>{
  const f=await setup();try{const r=await f.call('USD_PREFLIGHT',patch);assert.ok(r.code>=400);assert.equal(f.calls.length,0);}finally{await f.cleanup();}
});

for(const scope of [DIAGNOSTIC_SCOPE,DIAGNOSTIC_TTS_SCOPE])test('other scope cannot execute USD phase: '+scope,async()=>{
  const f=await isolatedFixture({scope,usdFetch:()=>assert.fail('no provider access')});
  try{assert.equal((await f.call('CONTEXT')).code,200);assert.equal((await f.call('USD_PREFLIGHT')).code,403);}finally{await f.cleanup();}
});

test('bad HMAC cannot create context',async()=>{
  const f=await isolatedFixture({scope:DIAGNOSTIC_USD_SCOPE});
  try{const e=f.envelope('CONTEXT');e.signature='0'.repeat(64);assert.equal((await f.send(e)).code,401);assert.equal(f.store.episodes.size,0);}finally{await f.cleanup();}
});

test('historical incomplete USD results remain immutable and recoverable after restart',async()=>{
  const f=await setup();try{
    const row=await f.store.getEpisode(f.base.operation_id),v=row.metadata.isolated_validation;
    const historical={status:'BLOCKED',budget_gate:'BLOCKED',quote_kind:'CONFIGURATION_QUOTE',quote_status:'INCOMPLETE',
      quotes:[...Array.from({length:5},(_,i)=>({stage:'IMAGE',shot_id:'q'+(41+i),estimated_cost_usd:0.248})),
        {stage:'VIDEO',shot_id:'q41',status:'BLOCKED',error_code:'ESTIMATE_HTTP_ERROR',http_status:400}]};
    v.results.USD_PREFLIGHT=historical;
    await f.store.casDiagnostic({...row,metadata:{...row.metadata,diagnostic_revision:row.metadata.diagnostic_revision+1}},row.metadata.diagnostic_revision);
    const runtime=new IsolatedV2Validation({store:f.store,env:f.env,validateOwner:async()=>true,usdFetch:()=>assert.fail('no replay')});
    const r=await runtime.http.run(f.envelope('USD_PREFLIGHT'));
    assert.equal(r.body.already_applied,true);assert.deepEqual((await f.read()).results.USD_PREFLIGHT,historical);
    assert.equal(f.calls.length,0);
  }finally{await f.cleanup();}
});

test('missing key is durably blocked before I/O',async()=>{
  const f=await setup({envPatch:{HF_API_KEY:''}});try{
    assert.equal((await f.call('USD_PREFLIGHT')).value.quote_status,'HF_API_KEY_MISSING');assert.equal(f.calls.length,0);
  }finally{await f.cleanup();}
});

test('concurrent blocked USD phase still has one CAS lease owner',async()=>{
  let entered,release;const barrier=new Promise(r=>entered=r),wait=new Promise(r=>release=r);
  class HeldIntent extends MemoryLumiRecoveryStore {async casDiagnostic(row,rev){
    if(row.metadata.isolated_validation.usd_preflight_attempt&&!this.held){this.held=true;entered();await wait;}
    return super.casDiagnostic(row,rev);
  }}
  const f=await setup({store:new HeldIntent()});
  try{const first=f.call('USD_PREFLIGHT');await barrier;assert.equal((await f.call('USD_PREFLIGHT')).code,409);
    release();assert.equal((await first).code,200);assert.equal(f.calls.length,0);
  }finally{release();await f.cleanup();}
});

test('persisted intent after interruption never repeats estimates',async()=>{
  const f=await setup();try{
    const row=await f.store.getEpisode(f.base.operation_id),v=row.metadata.isolated_validation;
    v.usd_preflight_attempt={request_id:'lost-http',partial:{quotes:[{stage:'IMAGE',estimated_cost_usd:0.3}],budget_gate:'BLOCKED'}};
    await f.store.casDiagnostic({...row,metadata:{...row.metadata,diagnostic_revision:row.metadata.diagnostic_revision+1}},row.metadata.diagnostic_revision);
    const r=await f.call('USD_PREFLIGHT');assert.equal(r.code,200);assert.equal(r.value.quote_status,'QUOTE_ATTEMPT_OUTCOME_UNPROVEN');
    assert.equal(r.value.quotes.length,1);assert.equal(f.calls.length,0);
  }finally{await f.cleanup();}
});

test('failed persistence prevents I/O and never returns successful delivery',async()=>{
  class Failing extends MemoryLumiRecoveryStore {async casDiagnostic(row,rev){
    if(row.metadata.isolated_validation.usd_preflight_attempt)throw Error('PRIVATE_STORAGE');return super.casDiagnostic(row,rev);
  }}
  const f=await setup({store:new Failing()});try{assert.notEqual((await f.call('USD_PREFLIGHT')).code,200);assert.equal(f.calls.length,0);}finally{await f.cleanup();}
});

test('configuration prices cannot pass budget even with all final evidence flags',async()=>{
  const input=isolatedUsdInput();
  const r=await quoteFourthEpisodeUsd({env:{LUMI_RUNTIME_ENV:'staging',HF_API_KEY:credential},envelopes:input.envelopes,
    quoteKind:input.quote_kind,fetchImpl:()=>assert.fail('configuration must not reach provider'),ttsUpperBoundUsd:0.1,ttsContractVerified:true,
    verifiedApiBalanceUsd:20,balanceAccountVerified:true,imageQualityVerified:true});
  assert.equal(r.budget_gate,'BLOCKED');assert.equal(r.quote_status,'KLING_SOURCE_BOUND_QUOTE_REQUIRED');
});
