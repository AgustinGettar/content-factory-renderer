import test from 'node:test';import assert from 'node:assert/strict';
import {createElevenLabsDirectClient,bindApprovedFernanda,FERNANDA_SOURCE_ID,FERNANDA_OWNER_ID,FERNANDA_HUMAN_APPROVAL} from '../lib/lumi-elevenlabs-direct-v3.js';
import {MemoryStageReceiptStore} from '../lib/lumi-v2-execution-orchestrator.js';
import {executeLumiTtsStage,ttsBudgetDecision} from '../lib/lumi-tts-stage-v2.js';
import {runElevenLabsTtsRecoveryMatrix} from '../lib/lumi-elevenlabs-recovery-v3.js';
import {LUMI_VOICE_PROFILE_V3,resolveLumiVoiceProfile,buildFutureVoiceRequest} from '../lib/lumi-production-profile-v2.js';
const env={LUMI_RUNTIME_ENV:'staging',ELEVENLABS_API_KEY:'OFFLINE_SYNTHETIC_CREDENTIAL'};
const model={model_id:'eleven_multilingual_v2',name:'Multilingual v2',can_do_text_to_speech:true,languages:[{language_id:'es'}],maximum_text_length_per_request:10000,token_cost_factor:1};
const account={voice_id:FERNANDA_SOURCE_ID,name:'Fernanda',category:'professional',fine_tuning:{state:{eleven_multilingual_v2:'fine_tuned'}},available_for_tiers:['starter']};
const quota={tier:'starter',status:'active',character_count:69,character_limit:40000};
function runtime(overrides={}){const requests=[];return {requests,client:createElevenLabsDirectClient({env,fetchImpl:async(url,options)=>{
 requests.push({url,method:options.method,body:options.body});const path=new URL(url).pathname;
 if(overrides.fetch)return overrides.fetch(url,options);
 const body=path==='/v1/models'?[model]:path==='/v1/user/subscription'?quota:path==='/v2/voices'?{voices:[],has_more:false}:path.startsWith('/v1/voices/add/')?{voice_id:FERNANDA_SOURCE_ID}:account;
 return Response.json(body);
}})};}
test('explicit approval is bound to provider, shared ID and original preview SHA',()=>{
 assert.equal(FERNANDA_HUMAN_APPROVAL.HUMAN_APPROVED,true);assert.equal(FERNANDA_HUMAN_APPROVAL.source_voice_id,FERNANDA_SOURCE_ID);
 assert.equal(FERNANDA_HUMAN_APPROVAL.provider,'ElevenLabs');assert.match(FERNANDA_HUMAN_APPROVAL.preview_sha256,/^[a-f0-9]{64}$/);
});
test('quota and model preflight use character semantics without synthesis or USD',async()=>{
 const {client,requests}=runtime();const r=await client.preflight({voice_id:FERNANDA_SOURCE_ID,model_id:model.model_id,text:'¡Hola, Lumi!'});
 assert.equal(r.quota.REMAINING_CHARACTERS,39931);assert.equal(r.units,12);assert.equal(r.currency,'ELEVENLABS_CHARACTER_QUOTA');assert.equal(r.usd,null);
 assert.equal(requests.some(r=>r.method==='POST'),false);
});
test('selected shared voice is added once, actual account ID and human approval persisted',async()=>{
 const {client,requests}=runtime(),receipts=new MemoryStageReceiptStore();let row={revision:1,state:{}};
 const store={get:async()=>structuredClone(row),cas:async(u,rev,state)=>{assert.equal(rev,row.revision);row={revision:rev+1,state:structuredClone(state)};}};
 const discovery={exactVoice:async id=>{assert.equal(id,FERNANDA_SOURCE_ID);return {PUBLIC_OWNER_ID:FERNANDA_OWNER_ID,MODEL_COMPATIBILITY:[model.model_id],RATE:1,VERIFIED_SPANISH:true,ACCENT:'mexican'};}};
 const opts={client,receipts,store,discovery,user:'owner',env};
 assert.equal((await bindApprovedFernanda(opts)).ACTIVE_TTS_VOICE_ID,FERNANDA_SOURCE_ID);
 assert.equal((await bindApprovedFernanda(opts)).status,'PASS');
 assert.equal(requests.filter(r=>r.method==='POST').length,1);assert.equal(row.state.voice_v3_human_approval.source_voice_id,FERNANDA_SOURCE_ID);
});
test('ambiguous shared-voice add never retries',async()=>{
 let attempts=0;const {client}=runtime({fetch:async(url,o)=>{if(o.method==='POST'){attempts++;throw Error('untrusted provider text');}
 return Response.json({voices:[],has_more:false});}});
 const receipts=new MemoryStageReceiptStore(),store={get:async()=>({revision:1,state:{}}),cas:async()=>{}},discovery={exactVoice:async()=>({PUBLIC_OWNER_ID:FERNANDA_OWNER_ID,MODEL_COMPATIBILITY:[model.model_id]})};
 const opts={client,receipts,store,discovery,user:'owner',env};await assert.rejects(bindApprovedFernanda(opts),/UNPROVEN/);await assert.rejects(bindApprovedFernanda(opts),/OUTCOME_UNPROVEN/);assert.equal(attempts,1);
});
test('raw provider errors and credential never escape',async()=>{
 const {client}=runtime({fetch:async()=>Response.json({detail:{status:'missing_permissions',message:env.ELEVENLABS_API_KEY+' user_read'}},{status:401})});
 try{await client.subscription();assert.fail('must reject');}catch(e){assert.equal(e.required_permission,'user_read');assert.equal(JSON.stringify(e).includes(env.ELEVENLABS_API_KEY),false);}
});
test('acknowledgement precedes reading synchronous audio and history recovery never synthesizes',async()=>{
 const order=[],audio=Buffer.from('synthetic original');let calls=0;
 const {client}=runtime({fetch:async(url,o)=>{calls++;if(o.method==='POST'){
  return {ok:true,headers:new Headers({'request-id':'request_1','x-trace-id':'trace_1','character-cost':'9'}),arrayBuffer:async()=>{order.push('bytes');return audio;}};
 }throw Error('unexpected GET');}});
 const r=await client.submit({voice_id:FERNANDA_SOURCE_ID,model_id:model.model_id,text:'fixture'},{onAcknowledged:async m=>{assert.equal(m.character_cost,9);order.push('receipt');}});
 assert.deepEqual(order,['receipt','bytes']);assert.deepEqual(await client.recoverOriginal(r.job_id),audio);assert.equal(calls,1);
});
test('future voice resolves Fernanda while V2 stays available as historical profile',()=>{
 assert.equal(resolveLumiVoiceProfile().voice_id,FERNANDA_SOURCE_ID);assert.equal(buildFutureVoiceRequest('Hola').model_id,model.model_id);
 assert.equal(resolveLumiVoiceProfile('LUMI_VOICE_PROFILE_V2').voice,'Annie');assert.equal(LUMI_VOICE_PROFILE_V3.human_review_source,'EXPLICIT_USER_SELECTION');
 assert.throws(()=>resolveLumiVoiceProfile('other'),/APPROVED_VOICE/);
});
test('quota includes configured reserve, is fingerprint-bound and never accepts a USD ceiling',()=>{
 const quote={currency:'ELEVENLABS_CHARACTER_QUOTA',units:20,character_count:20,quota:{QUOTA_OBSERVED:'PASS',REMAINING_CHARACTERS:1020},request_fingerprint:'bound',provenance:'SIMULATED_QUOTA'};
 assert.equal(ttsBudgetDecision({quota_reserve_characters:1000,ceiling_usd:999},quote,'bound').status,'PASS');
 assert.equal(ttsBudgetDecision({quota_reserve_characters:1001},quote,'bound').status,'BUDGET_EXHAUSTED');
 assert.throws(()=>ttsBudgetDecision({},quote,'other'),/BOUND_TTS_QUOTE/);
});
test('real V3 dry executor journals prepared request and stops before POST',async()=>{
 const {client,requests}=runtime(),objects=new Map(),receipts=new MemoryStageReceiptStore(),bytes=Buffer.from('EXPLICIT_LOCAL_PROBE_FIXTURE');
 const input={episode_id:'existing_generic_dry',stage_id:'TTS',narration_unit_id:'dry',text:'Hola, Lumi.',voice_profile_id:LUMI_VOICE_PROFILE_V3.version,dry_run:true,require_preflight:true,
  output_artifact_target:{bucket:'generated-audio',prefix:'dry'},budget_context:{quota_reserve_characters:1000}};
 const r=await executeLumiTtsStage(input,{client,receipts,probeBytes:bytes,inspectAudio:async()=>({ok:true,status:'PASS'}),
  storage:{upload:async(b,p,v)=>objects.set(p,v),download:async(b,p)=>objects.get(p),remove:async(b,p)=>objects.delete(p)}});
 assert.equal(r.status,'DRY_PROVIDER_BOUNDARY');assert.equal(r.emission_journal.state,'DRY_PROVIDER_BOUNDARY');assert.equal(requests.some(r=>r.method==='POST'),false);
 const journal=await receipts.get(r.emission_journal.key);assert.equal(journal.model_id,model.model_id);assert.equal(journal.voice_id,FERNANDA_SOURCE_ID);assert.equal(journal.budget_decision.status,'PASS');
 assert.match(journal.text_hash,/^[a-f0-9]{64}$/);assert.equal(objects.size,0);
});
test('model Spanish/TTS and professional fine-tuning compatibility are enforced',async()=>{
 for(const wrong of ['language','tts','fine_tuning']){
  const {client}=runtime({fetch:async url=>{const path=new URL(url).pathname;return Response.json(path==='/v1/models'?[{...model,...(wrong==='language'?{languages:[]}:{}) ,...(wrong==='tts'?{can_do_text_to_speech:false}:{})}]:path==='/v1/user/subscription'?quota:{...account,...(wrong==='fine_tuning'?{fine_tuning:{state:{}}}:{})});}});
  await assert.rejects(client.validation(FERNANDA_SOURCE_ID),/INCOMPATIBLE/);
 }
});
test('six native transport recovery cases never resubmit a proven or ambiguous request',async()=>{
 const r=await runElevenLabsTtsRecoveryMatrix();assert.equal(r.status,'PASS');assert.equal(r.rows.length,6);assert.equal(r.DUPLICATE_TTS_CALLS,0);
 assert.equal(r.provider_generation_calls,0);assert.ok(r.rows.every(r=>r.pass));
});
