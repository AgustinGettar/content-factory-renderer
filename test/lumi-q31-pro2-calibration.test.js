import test from 'node:test';
import assert from 'node:assert/strict';
import { Q31, requestInput, CalibrationJournalStore, runQ31Pro2Calibration, readCalibrationJson, providerActualSettings, verifyAttachedSource } from '../lib/lumi-q31-pro2-calibration.js';
import { journaledFetch } from '../lib/provider-emission-journal-v1.js';
function memoryStorage(){
  const values=new Map();
  return {values,upload:async(path,bytes,{upsert})=>{if(values.has(path)&&!upsert)return {error:{message:'exists'}};values.set(path,JSON.parse(bytes.toString()));return {error:null};}};
}
const context=()=>({episode_id:Q31.episode,scene_id:Q31.revision,attempt_id:Q31.revision,stage:'VIDEO',provider:'higgsfield_api',model:Q31.model,expected_cost_usd:0.286,prompt:'test'});
const opts={method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({duration:4})};
test('exact model, duration, silent single shot and source binding',()=>{
  assert.equal(Q31.model,'kling-video/v3.0/pro/image-to-video');
  const r=requestInput('https://private/source.png');
  assert.equal(r.duration,4);assert.equal(r.sound,'off');assert.equal(r.multi_shots,false);assert.equal(r.image_url,'https://private/source.png');
  assert.equal(Q31.revision,'q31-PRO2');assert.notEqual(Q31.revision,'q31');
});
test('production and missing scoped authorization reject before client or emission',async()=>{
  await assert.rejects(runQ31Pro2Calibration({env:{LUMI_RUNTIME_ENV:'production',LUMI_Q31_PRO2_AUTHORIZATION:Q31.sourceSha}}),/staging_scoped/);
  await assert.rejects(runQ31Pro2Calibration({env:{LUMI_RUNTIME_ENV:'staging'}}),/staging_scoped/);
});
test('atomic admission across concurrent processes permits exactly one POST',async()=>{
  const storage=memoryStorage();let calls=0;
  const make=()=>journaledFetch({store:new CalibrationJournalStore(storage),context:context(),fetchImpl:async()=>{calls++;return new Response(JSON.stringify({request_id:'same-job'}),{status:200});}});
  const r=await Promise.allSettled([make()('https://api.higgsfield.ai/'+Q31.model,opts),make()('https://api.higgsfield.ai/'+Q31.model,opts)]);
  assert.equal(calls,1);assert.equal(r.filter(x=>x.status==='fulfilled').length,1);
});
test('EMITTING is durable before POST and exact ID before follow-up',async()=>{
  const storage=memoryStorage();let savedId;
  const f=journaledFetch({store:new CalibrationJournalStore(storage),context:context(),fetchImpl:async()=>{
    assert.ok(storage.values.get(Q31.prefix+'/journal/EMITTING.json'));
    return new Response(JSON.stringify({request_id:'job-123',status_url:'https://api.higgsfield.ai/requests/job-123/status'}),{status:200});
  },persistResponse:async b=>{assert.equal(storage.values.get(Q31.prefix+'/journal/ACKNOWLEDGED.json').provider_request_id,'job-123');savedId=b.request_id;}});
  const response=await f('https://api.higgsfield.ai/'+Q31.model,opts);await response.json();assert.equal(savedId,'job-123');
  await assert.rejects(f('https://api.higgsfield.ai/'+Q31.model,opts),/already_consumed/);
});
test('transport ambiguity persists and cannot submit a second job',async()=>{
  const storage=memoryStorage();let calls=0;
  const f=journaledFetch({store:new CalibrationJournalStore(storage),context:context(),fetchImpl:async()=>{calls++;throw new TypeError('network');}});
  await assert.rejects(f('https://api.higgsfield.ai/'+Q31.model,opts));
  assert.equal(storage.values.get(Q31.prefix+'/journal/EMISSION_UNKNOWN.json').state,'EMISSION_UNKNOWN');
  const second=journaledFetch({store:new CalibrationJournalStore(storage),context:context(),fetchImpl:async()=>{calls++;}});
  await assert.rejects(second('https://api.higgsfield.ai/'+Q31.model,opts),/journal_write_rejected/);assert.equal(calls,1);
});
test('provider HTTP rejection is persisted with no retry',async()=>{
  const storage=memoryStorage();let calls=0;
  const f=journaledFetch({store:new CalibrationJournalStore(storage),context:context(),fetchImpl:async()=>{calls++;return new Response(JSON.stringify({detail:'quota blocked'}),{status:403});}});
  const response=await f('https://api.higgsfield.ai/'+Q31.model,opts);assert.equal(response.status,403);await response.json();
  assert.equal(storage.values.get(Q31.prefix+'/journal/ACKNOWLEDGED.json').http_status,403);
  await assert.rejects(f('https://api.higgsfield.ai/'+Q31.model,opts),/already_consumed/);assert.equal(calls,1);
});
test('journal rejects identity changes and unauthorized transitions',async()=>{
  const store=new CalibrationJournalStore(memoryStorage());
  await assert.rejects(store.prepare({...context(),state:'PREPARED',scene_id:'q32'}),/scope_mismatch/);
  await store.prepare({...context(),state:'PREPARED'});
  await assert.rejects(store.transition(Q31.revision,'PREPARED',{state:'ACKNOWLEDGED'}),/transition_rejected/);
});
test('absence is proven by successful listing, not inferred from opaque download errors',async()=>{
  let downloads=0;
  assert.equal(await readCalibrationJson({list:async()=>({data:[],error:null}),download:async()=>{downloads++;throw new Error('opaque');}},'completed'),null);
  assert.equal(downloads,0);
});
test('listing access failures and unreadable existing records fail closed',async()=>{
  await assert.rejects(readCalibrationJson({list:async()=>({error:{message:'auth'}})},'completed'),/list_failed/);
  await assert.rejects(readCalibrationJson({list:async()=>({data:[{name:'completed.json'}]}),download:async()=>({error:{message:'{}'}})},'completed'),/read_failed/);
});

test('PRO requested is never treated as provider proof; missing fields are UNKNOWN',()=>{
  assert.equal(Q31.mode,'PRO');
  assert.equal(providerActualSettings({status:'completed',video:{url:'https://file/pro.mp4'}}).ACTUAL_MODE,'UNKNOWN');
});
test('actual PRO requires independent provider metadata; Standard overrides contradictory evidence',()=>{
  assert.equal(providerActualSettings({metadata:{model_id:Q31.model}}).ACTUAL_MODE,'PRO');
  assert.equal(providerActualSettings({model:Q31.model,mode:'std'}).ACTUAL_MODE,'STANDARD');
  assert.equal(providerActualSettings({model:'kling-video/v3.0/std/image-to-video',mode:'pro'}).ACTUAL_MODE,'STANDARD');
});
test('mismatching or corrupt attachment is rejected before provider',()=>{
  assert.throws(()=>verifyAttachedSource(Buffer.from('wrong bytes')),/source_hash_mismatch/);
  assert.equal(Q31.sourceSha,'5dc31254ad26aa1b606735188ac30d2f4d486bc389f19bc8a50816e1e1b3da33');
  assert.equal(Q31.source,'LUMI_CANONICAL_SOURCE_V2');
  assert.equal(Q31.width,941);assert.equal(Q31.height,1672);
});
