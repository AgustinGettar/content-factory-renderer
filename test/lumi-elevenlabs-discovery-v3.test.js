import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createElevenLabsDiscoveryClient,discoverElevenLabsSpanishVoices,elevenLabsReadiness,subscriptionMetadata} from '../lib/lumi-elevenlabs-discovery-v3.js';
const env={LUMI_RUNTIME_ENV:'staging',ELEVENLABS_API_KEY:'TEST_ONLY_NEVER_VALID_CREDENTIAL'};
const response=value=>({ok:true,status:200,json:async()=>value});
const model={model_id:'eleven_multilingual_v2',can_do_text_to_speech:true,requires_alpha_access:false,languages:[{language_id:'es'}],maximum_text_length_per_request:10000,model_rates:{character_cost_multiplier:1}};
const subscription={tier:'starter',status:'active',character_count:10,character_limit:10000,max_credit_limit_extension:0,can_extend_character_limit:false};
const voice={voice_id:'spanish-id',public_owner_id:'public-owner',name:'Test teacher',language:'es',gender:'Female',category:'professional',use_case:'narrative_story',rate:1,preview_url:'https://preview.invalid/english.mp3',verified_languages:[{language:'es',model_id:'eleven_multilingual_v2',accent:'neutral',preview_url:'https://preview.invalid/spanish.mp3'}]};
const fetchCatalog=handler=>async(raw,options)=>{
 const url=new URL(raw);assert.equal(url.origin,'https://api.elevenlabs.io');assert.equal(options.method,'GET');
 assert.equal(options.redirect,'error');assert.equal(options.headers['xi-api-key'],env.ELEVENLABS_API_KEY);
 if(url.pathname==='/v1/user/subscription')return response(subscription);
 if(url.pathname==='/v1/models')return response([model]);
 assert.equal(url.pathname,'/v1/shared-voices');return handler(url);
};
test('missing secret and production make zero provider requests; readiness exposes boolean only',async()=>{
 let calls=0;const fetchImpl=async()=>{calls++;throw Error('should not request');};
 await assert.rejects(discoverElevenLabsSpanishVoices({env:{LUMI_RUNTIME_ENV:'staging'},fetchImpl}),/SECRET_REQUIRED/);
 await assert.rejects(discoverElevenLabsSpanishVoices({env:{...env,LUMI_RUNTIME_ENV:'production'},fetchImpl}),/STAGING_ONLY/);
 assert.equal(calls,0);assert.equal(JSON.stringify(elevenLabsReadiness(env)).includes(env.ELEVENLABS_API_KEY),false);
});
test('Library replaces My Voices and prefers verified Spanish model preview without overfiltering',async()=>{
 const order=[];
 const result=await discoverElevenLabsSpanishVoices({env,fetchImpl:async(raw,options)=>{
  const url=new URL(raw);order.push(url.pathname);
  return fetchCatalog(url=>{
   assert.equal(url.searchParams.get('language'),'es');assert.equal(url.searchParams.get('gender'),'female');
   assert.equal(url.searchParams.get('category'),'professional');assert.equal(url.searchParams.get('page_size'),'100');
   for(const forbidden of ['accent','age','featured','search','use_cases'])assert.equal(url.searchParams.has(forbidden),false);
   return response({voices:[voice],has_more:false,total_count:1});
  })(raw,options);
 }});
 assert.deepEqual(order,['/v1/user/subscription','/v1/models','/v1/shared-voices']);
 assert.equal(result.quota.QUOTA_OBSERVED,'PASS');assert.equal(result.quota.REMAINING_CHARACTERS,9990);
 assert.equal(result.voices[0].PREVIEW,voice.verified_languages[0].preview_url);
 assert.equal(result.voices[0].VERIFIED_SPANISH,true);assert.equal(result.voices[0].PUBLIC_OWNER_ID,'public-owner');
 assert.deepEqual(result.voices[0].MODEL_COMPATIBILITY,['eleven_multilingual_v2']);
 assert.equal(result.provider_generation_calls,0);assert.equal(result.REAL_EXECUTOR_BINDINGS,'13/14');
 assert.equal(result.VOICE_A,null);assert.equal(result.human_voice_selection,null);
});
test('subscription output excludes billing PII and computes only observed quota',()=>{
 const result=subscriptionMetadata({...subscription,open_invoices:[{private:'invoice'}],next_invoice:{private:'payment'},email:'private@example.test',current_overage:{amount:'0',currency:'usd',payment_method:'private'}});
 assert.deepEqual(result.CURRENT_OVERAGE,{amount:'0',currency:'usd'});
 assert.equal(JSON.stringify(result).includes('private'),false);assert.equal(result.MAX_CREDIT_LIMIT_EXTENSION,0);
 assert.equal(result.CAN_EXTEND,false);assert.equal(subscriptionMetadata({}).REMAINING_CHARACTERS,null);
});
test('zero professional results trigger exactly language-only fallback and metadata gender filtering',async()=>{
 let pages=0;const result=await discoverElevenLabsSpanishVoices({env,fetchImpl:fetchCatalog(url=>{
  pages++;if(pages===1)return response({voices:[],has_more:false,total_count:0});
  assert.equal(url.searchParams.has('gender'),false);assert.equal(url.searchParams.has('category'),false);
  return response({voices:[voice,{...voice,voice_id:'male-id',gender:'Male'}],has_more:false,total_count:2});
 })});
 assert.equal(pages,2);assert.equal(result.minimal_filters_fallback,true);assert.equal(result.SPANISH_VOICES_FOUND,2);
 assert.equal(result.voices.length,1);
});
test('Library pagination uses integer page, is bounded and deduplicates identities',async()=>{
 let pages=0;const result=await discoverElevenLabsSpanishVoices({env,maxPages:2,fetchImpl:fetchCatalog(url=>{
  assert.equal(url.searchParams.get('page'),String(pages));pages++;
  return response({voices:[voice],has_more:true,total_count:500});
 })});
 assert.equal(pages,2);assert.equal(result.voices.length,1);assert.equal(result.catalog_complete,false);assert.equal(result.next_page,2);
});
test('quota permission failure is classified safely and Library remains read-only',async()=>{
 const result=await discoverElevenLabsSpanishVoices({env,fetchImpl:async(raw,options)=>{
  if(new URL(raw).pathname==='/v1/user/subscription')return {ok:false,status:401,json:async()=>({detail:{status:'missing_permissions',message:'Permission user_read required. '+env.ELEVENLABS_API_KEY}})};
  return fetchCatalog(()=>response({voices:[voice],has_more:false,total_count:1}))(raw,options);
 }});
 assert.equal(result.status,'QUOTA_OBSERVABILITY_BLOCKER');assert.equal(result.quota_error.http_status,401);
 assert.equal(result.quota_error.required_permission,'user_read');assert.equal(result.quota,null);
 assert.equal(JSON.stringify(result).includes(env.ELEVENLABS_API_KEY),false);
});
test('English preview does not exclude verified Spanish candidate; unknown compatibility remains unknown',async()=>{
 const unknown={...voice,voice_id:'unverified',verified_languages:null};
 const fallback={...voice,verified_languages:[{language:'es',model_id:'eleven_multilingual_v2'}]};
 const result=await discoverElevenLabsSpanishVoices({env,fetchImpl:fetchCatalog(()=>response({voices:[fallback,unknown],has_more:false}))});
 assert.equal(result.voices.length,2);assert.equal(result.voices[0].SPANISH_PREVIEW_INSUFFICIENT,true);
 assert.equal(result.voices[0].PREVIEW,voice.preview_url);assert.equal(result.voices[1].MODEL_COMPATIBILITY,null);
});
test('error paths never expose arbitrary provider body, transport URL, key or headers; no mutation client',async()=>{
 for(const fetchImpl of [async()=>{throw Error('header '+env.ELEVENLABS_API_KEY);},async()=>({ok:false,status:401,json:async()=>({detail:env.ELEVENLABS_API_KEY})})]){
  await assert.rejects(createElevenLabsDiscoveryClient({env,fetchImpl}).models(),e=>!JSON.stringify(e).includes(env.ELEVENLABS_API_KEY)&&!e.message.includes(env.ELEVENLABS_API_KEY));
 }
 const client=createElevenLabsDiscoveryClient({env,fetchImpl:async()=>response([{name:env.ELEVENLABS_API_KEY}])});
 assert.equal((await client.models())[0].name,'[REDACTED]');for(const name of ['submit','add','clone'])assert.equal(name in client,false);
});
test('V3 remains pending and V2 approval is preserved',()=>{
 const v3=JSON.parse(readFileSync(new URL('../qa/LUMI_VOICE_PROFILE_V3.json',import.meta.url)));
 const v2=JSON.parse(readFileSync(new URL('../qa/LUMI_VOICE_PROFILE_V2.json',import.meta.url)));
 assert.equal(v3.status,'VOICE_SELECTION_PENDING');assert.equal(v3.voice_id,null);assert.equal(v3.model_id,null);
 assert.equal(v3.HUMAN_APPROVED,false);assert.equal(v3.deployable_executor_bound,false);
 assert.equal(v2.HUMAN_APPROVED,true);assert.equal(v2.provider,'Higgsfield');assert.equal(v2.voice,'Annie');
});
