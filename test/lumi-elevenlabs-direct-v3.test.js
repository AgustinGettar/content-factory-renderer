import test from 'node:test';import assert from 'node:assert/strict';
import {createElevenLabsDirectClient,bindApprovedFernanda,FERNANDA_SOURCE_ID,FERNANDA_OWNER_ID,FERNANDA_HUMAN_APPROVAL} from '../lib/lumi-elevenlabs-direct-v3.js';
import {MemoryStageReceiptStore} from '../lib/lumi-v2-execution-orchestrator.js';
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
