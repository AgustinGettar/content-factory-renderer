import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {executeLumiTtsStage,prepareLumiTtsInput,createTtsStorageProbe,inspectLumiAudio} from '../lib/lumi-tts-stage-v2.js';
import {MemoryStageReceiptStore,ReviewStageReceiptStore} from '../lib/lumi-v2-execution-orchestrator.js';
import {MemoryReviewStore,newSession} from '../lib/telegram-review-v1/core.js';
import {HOME_ASSET} from '../lib/telegram-review-v1/home-asset.js';
import {createHiggsfieldTtsCliClient} from '../lib/lumi-higgsfield-tts-cli.js';
const hash=b=>createHash('sha256').update(b).digest('hex');
function fixture(overrides={}){
  const input={episode_id:'ep_future_004',stage_id:'TTS',narration_unit_id:'intro',text:'¡Hola! Escuchemos el jardín.',voice_profile_id:'LUMI_VOICE_PROFILE_V2',output_artifact_target:{bucket:'generated-audio',prefix:'episodes/ep_future_004'}};
  const p=prepareLumiTtsInput(input);input.budget_context={authorized:true,quote:{currency:'USD',usd:.2,provenance:'SYNTHETIC_USD_TEST_ONLY',request_fingerprint:p.binding.request_fingerprint},spent_usd:0,ceiling_usd:1,remaining_reserve_usd:.1};
  const objects=new Map(),bytes=Buffer.from('EXPLICIT_TEST_AUDIO_NOT_REAL'),calls={submit:0,poll:0,download:0};
  const deps={receipts:new MemoryStageReceiptStore(),probeBytes:bytes,
    storage:{upload:async(b,p,v)=>{if(objects.has(p))throw Error('exists');objects.set(p,Buffer.from(v));},download:async(b,p)=>objects.get(p),remove:async(b,p)=>objects.delete(p)},
    client:{submit:async()=>{calls.submit++;return {job_id:'same-job'};},poll:async id=>{calls.poll++;assert.equal(id,'same-job');return {job_id:id,status:'completed',artifact_url:'https://fixture.invalid/audio.mp3'};}},
    fetchImpl:async()=>{calls.download++;return new Response(bytes);},
    inspectAudio:async()=>({ok:true,status:'PASS',duration:2,channels:1,sample_rate:44100,decode:'PASS'}),...overrides};
  return {input,deps,calls,objects,p,bytes};
}
test('frozen persisted voice request and dry run never touch any dependency',async()=>{
  const f=fixture(),r=await executeLumiTtsStage({...f.input,dry_run:true});
  assert.equal(r.request.voice_id,'f2801b0f-e345-598e-86f5-8364d886d96b');assert.equal(r.request.variant,'elevenlabs');assert.equal(r.request.prompt,f.input.text);
  assert.equal(r.request.speech_rate,undefined);assert.equal(r.status,'DRY_PROVIDER_BOUNDARY');assert.equal(f.deps.receipts.rows.size,0);
  assert.throws(()=>prepareLumiTtsInput({...f.input,voice_profile_id:'other'}));
  assert.throws(()=>prepareLumiTtsInput({...f.input,text:'a'.repeat(5001)}));
});
test('durable states, canonical artifact and exactly-once replay',async()=>{
  const f=fixture(),r=await executeLumiTtsStage(f.input,f.deps),again=await executeLumiTtsStage(f.input,f.deps);
  assert.equal(r.status,'SUCCEEDED');assert.equal(again.provider_calls,0);assert.equal(f.calls.submit,1);assert.equal(f.calls.poll,1);
  assert.deepEqual((await f.deps.receipts.get('tts:'+f.p.claim_id)).history,['PREPARED','CLAIMED','EMITTING','ACKNOWLEDGED','ARTIFACT_RECOVERED','PERSISTED','QA_COMPLETE','SUCCEEDED']);
  assert.equal(r.artifacts[0].sha256,hash(f.bytes));assert.equal(r.artifacts[0].sample_rate,44100);assert.equal(r.artifacts[0].qa_status,'PASS');
  await assert.rejects(executeLumiTtsStage({...f.input,text:'different'},f.deps),/IMMUTABLE/);
});
test('concurrent claimants cannot submit twice with existing review CAS store',async()=>{
  const store=new MemoryReviewStore();await store.create('1',newSession({user_id:'1',chat_id:'1',message_id:138,cover:HOME_ASSET}));
  const f=fixture({receipts:new ReviewStageReceiptStore({store,user:'1'})});
  await Promise.allSettled([executeLumiTtsStage(f.input,f.deps),executeLumiTtsStage(f.input,f.deps)]);assert.equal(f.calls.submit,1);
});
for(const point of ['EMITTING','ACKNOWLEDGED','PERSISTED'])test('crash recovery at '+point+' never resubmits',async()=>{
  const f=fixture();let crash=true;f.deps.inject=async p=>{if(p===point&&crash){crash=false;throw Error('CRASH');}};
  await executeLumiTtsStage(f.input,f.deps).catch(()=>{});
  const r=await executeLumiTtsStage(f.input,f.deps);
  assert.equal(r.status,point==='EMITTING'?'EMISSION_AMBIGUOUS':'SUCCEEDED');assert.ok(f.calls.submit<=1);
  if(point==='EMITTING')assert.equal(f.calls.submit,0);
});
test('transport loss fails closed and definitive pre-emission rejection is distinct',async()=>{
  for(const rejected of [false,true]){
    const f=fixture();f.deps.client.submit=async()=>{f.calls.submit++;throw Object.assign(Error('rejected'),rejected?{no_job_accepted:true,evidence:{definitive_rejection:true},code:'INSUFFICIENT_BALANCE'}:{});};
    const r=await executeLumiTtsStage(f.input,f.deps);assert.equal(r.status,rejected?'FAILED_PROVIDER_TERMINAL':'EMISSION_AMBIGUOUS');
    await executeLumiTtsStage(f.input,f.deps);assert.equal(f.calls.submit,1);
  }
});
test('pending job, failed storage and decode warning reuse the same accepted job',async()=>{
  const f=fixture(),poll=f.deps.client.poll;let pending=true;
  f.deps.client.poll=async id=>pending?{job_id:id,status:'pending'}:poll(id);
  assert.equal((await executeLumiTtsStage(f.input,f.deps)).status,'IN_PROGRESS');pending=false;
  const upload=f.deps.storage.upload;f.deps.storage.upload=async()=>{throw Error('storage offline');};
  assert.equal((await executeLumiTtsStage(f.input,f.deps)).status,'FAILED_RETRYABLE_LOCAL');
  f.deps.storage.upload=upload;f.deps.inspectAudio=async()=>({ok:true,status:'WARNING',duration:2,sample_rate:44100,channels:1,warnings:['CLIPPING']});
  const r=await executeLumiTtsStage(f.input,f.deps);assert.equal(r.status,'SUCCEEDED_WITH_WARNING');assert.equal(r.human_review_requirement,true);assert.equal(f.calls.submit,1);
});
test('storage gate, budget, quote currency and authorization precede claims and submit',async()=>{
  for(const kind of ['storage','budget','credits','authorization']){
    const f=fixture();if(kind==='storage')f.deps.storage.upload=async()=>{throw Error('MIME rejected');};
    if(kind==='budget')f.input.budget_context.ceiling_usd=.1;
    if(kind==='credits')f.input.budget_context.quote.currency='CREDITS';
    if(kind==='authorization')f.input.budget_context.authorized=false;
    const r=await executeLumiTtsStage(f.input,f.deps).catch(e=>e);
    assert.ok(r instanceof Error||r.status==='BUDGET_EXHAUSTED');assert.equal(f.calls.submit,0);assert.equal(f.deps.receipts.rows.size,0);
  }
});
test('same-job mismatch never downloads an unrelated audio',async()=>{
  const f=fixture();f.deps.client.poll=async()=>({job_id:'other',status:'completed',artifact_url:'https://fixture.invalid/audio.mp3'});
  assert.equal((await executeLumiTtsStage(f.input,f.deps)).error_classification,'TTS_JOB_ID_MISMATCH');assert.equal(f.calls.download,0);
});
test('real ffmpeg probe is decodable but silence is not valid narration',async()=>{
  const bytes=await createTtsStorageProbe();assert.equal((await inspectLumiAudio(bytes,hash(bytes),{storageProbe:true})).ok,true);
  assert.equal((await inspectLumiAudio(bytes,hash(bytes))).ok,false);assert.equal((await inspectLumiAudio(bytes,'a'.repeat(64))).ok,false);
});
test('official CLI wrapper uses argv, selected engine, no wait/retry and same job polling',async()=>{
  const args=[];const client=createHiggsfieldTtsCliClient({run:async(executable,argv)=>{args.push(argv);return {stdout:JSON.stringify({results:[{id:'same-job',status:argv[1]==='create'?'pending':'completed',results:{rawUrl:'https://fixture.invalid/audio'}}]})};}});
  const f=fixture();assert.equal((await client.submit(f.p.request)).job_id,'same-job');assert.equal((await client.poll('same-job')).job_id,'same-job');
  assert.ok(args[0].includes('elevenlabs'));assert.ok(!args[0].includes('--wait'));assert.deepEqual(args[1],['generate','get','same-job','--json']);
});
