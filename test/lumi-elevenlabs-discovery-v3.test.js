import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createElevenLabsDiscoveryClient,discoverElevenLabsSpanishVoices,elevenLabsReadiness} from '../lib/lumi-elevenlabs-discovery-v3.js';
const env={LUMI_RUNTIME_ENV:'staging',ELEVENLABS_API_KEY:'TEST_ONLY_NEVER_VALID_CREDENTIAL'};
const response=value=>({ok:true,status:200,json:async()=>value});
const model={model_id:'catalog-narration-model',can_do_text_to_speech:true,requires_alpha_access:false,
  languages:[{language_id:'es'}],maximum_text_length_per_request:1234,model_rates:{character_cost_multiplier:1}};
const voice={voice_id:'provider-spanish-id',name:'Test teacher',labels:{language:'es',gender:'female',use_case:'narrative_story'},preview_url:'https://preview.invalid/existing.mp3'};
test('missing secret and production environment make zero provider requests',async()=>{
 let calls=0;const fetchImpl=async()=>{calls++;throw Error('should not request');};
 await assert.rejects(discoverElevenLabsSpanishVoices({env:{LUMI_RUNTIME_ENV:'staging'},fetchImpl}),/SECRET_REQUIRED/);
 await assert.rejects(discoverElevenLabsSpanishVoices({env:{...env,LUMI_RUNTIME_ENV:'production'},fetchImpl}),/STAGING_ONLY/);
 assert.equal(calls,0);assert.equal(elevenLabsReadiness(env).ELEVENLABS_AUTH,'UNVERIFIED');
 assert.equal(JSON.stringify(elevenLabsReadiness(env)).includes(env.ELEVENLABS_API_KEY),false);
});
test('only authenticated official GET requests, Spanish female filter, dynamic model metadata and pending approval',async()=>{
 const calls=[];
 const result=await discoverElevenLabsSpanishVoices({env,fetchImpl:async(raw,options)=>{
  const url=new URL(raw);calls.push(url);
  assert.equal(url.origin,'https://api.elevenlabs.io');assert.equal(options.method,'GET');
  assert.equal(options.redirect,'error');assert.equal(options.headers['xi-api-key'],env.ELEVENLABS_API_KEY);
  if(url.pathname==='/v1/models')return response([model,{...model,model_id:'no-spanish',languages:[{language_id:'en'}]}]);
  if(url.pathname==='/v2/voices'){
   assert.equal(url.searchParams.get('language'),'es');assert.equal(url.searchParams.get('gender'),'female');
   return response({voices:[voice,{...voice,voice_id:'wrong-language',labels:{language:'en',gender:'female'}}],has_more:false});
  }
  return response({character_count:10,character_limit:100,tier:'test'});
 }});
 assert.equal(result.ELEVENLABS_AUTH,'PASS');assert.equal(result.production_spanish_tts_models[0].MODEL_ID,model.model_id);
 assert.equal(result.production_spanish_tts_models[0].MAX_TEXT,1234);assert.equal(result.voices.length,1);
 assert.equal(result.voices[0].ACCENT,null);assert.equal(result.voices[0].MODEL_COMPATIBILITY,null);
 assert.equal(result.quota.api_key_remaining_quota,null);assert.equal(result.quota.usd,null);
 assert.equal(result.VOICE_A,null);assert.equal(result.human_voice_selection,null);
 assert.equal(result.REAL_EXECUTOR_BINDINGS,'13/14');assert.equal(result.provider_generation_calls,0);
 assert.equal(calls.length,3);assert.equal(JSON.stringify(result).includes(env.ELEVENLABS_API_KEY),false);
});
test('raw HTTP and transport errors never escape with headers, key, body or URL',async()=>{
 for(const fetchImpl of [async()=>{throw Error('header '+env.ELEVENLABS_API_KEY);},
  async()=>({ok:false,status:401,json:async()=>({detail:env.ELEVENLABS_API_KEY})})]) {
  await assert.rejects(createElevenLabsDiscoveryClient({env,fetchImpl}).models(),error=>{
   assert.equal(JSON.stringify(error).includes(env.ELEVENLABS_API_KEY),false);
   assert.equal(error.message.includes(env.ELEVENLABS_API_KEY),false);return true;
  });
 }
 const client=createElevenLabsDiscoveryClient({env,fetchImpl:async()=>response([{name:env.ELEVENLABS_API_KEY}])});
 assert.equal((await client.models())[0].name,'[REDACTED]');assert.equal('submit' in client,false);
});
test('pagination is bounded, uses token and deduplicates voices',async()=>{
 let pages=0;
 const result=await discoverElevenLabsSpanishVoices({env,maxPages:2,fetchImpl:async raw=>{
  const url=new URL(raw);if(url.pathname==='/v1/models')return response([model]);
  if(url.pathname==='/v1/user/subscription')return {ok:false,status:403};
  pages++;if(pages===2)assert.equal(url.searchParams.get('next_page_token'),'page-two');
  return response({voices:[voice],has_more:true,next_page_token:pages===1?'page-two':'page-three'});
 }});
 assert.equal(pages,2);assert.equal(result.voices.length,1);assert.equal(result.catalog_complete,false);
 assert.equal(result.next_page_token,'page-three');assert.equal(result.quota,null);
 assert.equal(result.quota_status,'READ_PERMISSION_OR_TRANSPORT_UNAVAILABLE');
});
test('empty studio catalog fallback is disclosed, no voice or model guessed',async()=>{
 let pages=0;
 const result=await discoverElevenLabsSpanishVoices({env,fetchImpl:async raw=>{
  const url=new URL(raw);if(url.pathname==='/v1/models')return response([]);
  if(url.pathname==='/v1/user/subscription')return response({});
  pages++;assert.equal(url.searchParams.has('high_quality'),pages===1);
  return response({voices:pages===1?[]:[voice],has_more:false});
 }});
 assert.equal(pages,2);assert.equal(result.high_quality_filter,false);
 assert.equal(result.production_spanish_tts_models.length,0);assert.equal(result.voices[0].RECORDING_QUALITY,null);
});
test('pending V3 never inherits historical Annie approval or identity',()=>{
 const v3=JSON.parse(readFileSync(new URL('../qa/LUMI_VOICE_PROFILE_V3.json',import.meta.url)));
 const v2=JSON.parse(readFileSync(new URL('../qa/LUMI_VOICE_PROFILE_V2.json',import.meta.url)));
 assert.equal(v3.status,'VOICE_SELECTION_PENDING');assert.equal(v3.voice_id,null);assert.equal(v3.model_id,null);
 assert.equal(v3.HUMAN_APPROVED,false);assert.equal(v3.deployable_executor_bound,false);
 assert.equal(v2.HUMAN_APPROVED,true);assert.equal(v2.provider,'Higgsfield');assert.equal(v2.voice,'Annie');
});
