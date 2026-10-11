import test from 'node:test';
import assert from 'node:assert/strict';
import {quoteFourthEpisodeUsd,validateQuoteEnvelopes,EPISODE_ID} from '../lib/lumi-fourth-episode-usd-preflight.js';

const inputs=()=>[
 ...Array.from({length:5},(_,i)=>({stage:'IMAGE',shot_id:'q'+(41+i),model:'marketing-studio/image',input:{
  prompt:'Premium Lumi farm CGI source',image_urls:['https://example.test/canonical.png'],quality:'high',resolution:'2k',
  aspect_ratio:'9:16',moderation:'auto',enhance_prompt:false}})),
 ...[4,5,5,5,5].map((duration,i)=>({stage:'VIDEO',shot_id:'q'+(41+i),model:'kling-video/v3.0/pro/image-to-video',input:{
  prompt:'Premium Lumi CGI animation',image_url:'https://example.test/source.png',duration,sound:'off',multi_shots:false,cfg_scale:0.5}}))
];
const env={LUMI_RUNTIME_ENV:'staging',HF_API_KEY:'LOCAL_FAKE_KEY'};
// All transport in this suite is simulated; example.test is never submitted.
const fake=(quote='0.30')=>async(url,options)=>{
 assert.match(url,/^https:\/\/api\.higgsfield\.ai\/estimate\//);
 assert.equal(options.method,'POST');assert.equal(options.headers.Authorization,'Key LOCAL_FAKE_KEY');
 assert.equal(typeof JSON.parse(options.body).prompt,'string');
 return Response.json({usd:quote,credits:7});
};

test('accepts exactly five high-quality image and five Kling Pro envelopes',()=>{
 assert.equal(validateQuoteEnvelopes(inputs()).length,10);
 for(const edit of [x=>x[0].input.quality='standard',x=>x[5].input.duration=6,
  x=>x[5].model='kling-video/v3.0/standard/image-to-video',x=>x[0].input.image_urls=[],
  x=>x[5].input.sound='on',x=>x[1].input.extra='bad']){
  const x=inputs();edit(x);assert.throws(()=>validateQuoteEnvelopes(x));
 }
});

test('never calls the provider if credentials, staging or source are absent',async()=>{
 let calls=0;const fetchImpl=()=>{calls++;throw Error('forbidden');};
 assert.equal((await quoteFourthEpisodeUsd({env:{LUMI_RUNTIME_ENV:'staging'},envelopes:inputs(),fetchImpl})).quote_status,'HF_API_KEY_MISSING');
 assert.equal((await quoteFourthEpisodeUsd({env:{...env,LUMI_RUNTIME_ENV:'production'},envelopes:inputs(),fetchImpl})).quote_status,'STAGING_ONLY');
 const x=inputs();delete x[6].input.image_url;
 assert.equal((await quoteFourthEpisodeUsd({env,envelopes:x,fetchImpl})).quote_status,'KLING_PRO_SOURCE_REQUIRED');
 assert.equal(calls,0);
});

test('ten USD quotes, no media generation and no secret or signed URLs in result',async()=>{
 let calls=0;
 const r=await quoteFourthEpisodeUsd({env,envelopes:inputs(),fetchImpl:async(...args)=>{calls++;return fake()(...args);}});
 assert.equal(r.episode_id,EPISODE_ID);assert.equal(calls,10);assert.equal(r.quote_status,'TEN_USD_ESTIMATES_RECOVERED');
 assert.equal(r.image_total_usd,1.5);assert.equal(r.video_total_usd,1.5);
 assert.equal(r.budget_gate,'BLOCKED');assert.equal(r.provider_generation_calls,0);assert.equal(r.episode_created,false);
 const s=JSON.stringify(r);assert.ok(!s.includes('LOCAL_FAKE_KEY'));assert.ok(!s.includes('example.test'));
});

test('credits-only quote fails closed on first estimate, no conversion or retries',async()=>{
 let calls=0;
 const r=await quoteFourthEpisodeUsd({env,envelopes:inputs(),fetchImpl:async()=>{calls++;return Response.json({credits:7});}});
 assert.equal(calls,1);assert.equal(r.quote_status,'INCOMPLETE');assert.equal(r.quotes[0].error_code,'USD_FIELD_MISSING');
 assert.equal(r.budget_gate,'BLOCKED');
});

test('USD price and verified balance and verified TTS upper bound are all required',async()=>{
 const common={env,envelopes:inputs(),fetchImpl:fake('0.30')};
 const missing=await quoteFourthEpisodeUsd({...common,ttsUpperBoundUsd:0.08,ttsContractVerified:true});
 assert.equal(missing.budget_gate,'BLOCKED');
 const unverifiedQuality=await quoteFourthEpisodeUsd({...common,ttsUpperBoundUsd:0.08,ttsContractVerified:true,verifiedApiBalanceUsd:5,balanceAccountVerified:true});
 assert.equal(unverifiedQuality.budget_gate,'BLOCKED');
 const ok=await quoteFourthEpisodeUsd({...common,ttsUpperBoundUsd:0.08,ttsContractVerified:true,verifiedApiBalanceUsd:5,balanceAccountVerified:true,imageQualityVerified:true});
 assert.equal(ok.total_projected_usd,3.58);assert.equal(ok.budget_gate,'PASS_PREFLIGHT_ONLY');
 const low=await quoteFourthEpisodeUsd({...common,ttsUpperBoundUsd:0.08,ttsContractVerified:true,verifiedApiBalanceUsd:2,balanceAccountVerified:true,imageQualityVerified:true});
 assert.equal(low.budget_gate,'BLOCKED');
 const expensive=await quoteFourthEpisodeUsd({...common,fetchImpl:fake('0.60'),ttsUpperBoundUsd:0.08,ttsContractVerified:true,verifiedApiBalanceUsd:20,balanceAccountVerified:true,imageQualityVerified:true});
 assert.equal(expensive.budget_gate,'BLOCKED');
});

test('failed estimate does not call next endpoint',async()=>{
 let calls=0;
 const r=await quoteFourthEpisodeUsd({env,envelopes:inputs(),fetchImpl:async()=>{calls++;return Response.json({error:'bad'},{status:422});}});
 assert.equal(calls,1);assert.equal(r.quotes[0].error_code,'ESTIMATE_HTTP_ERROR');assert.equal(r.budget_gate,'BLOCKED');
});

// Regression: pricing must never silently switch to superseded Flare.
test('rejects superseded Flare model even if image quality is high',()=>{
 const x=inputs();x[0].model='marketing-studio/image/flare';
 assert.throws(()=>validateQuoteEnvelopes(x),/IMAGE_2K_HIGH_SOURCE_REQUIRED/);
});

test('documented Kling Pro estimate parameters: source mandatory, sound off, 4/5 seconds, prompt <=2500',()=>{
 for(const edit of [x=>delete x[5].input.image_url,x=>x[5].input.audio=false,
  x=>x[5].input.resolution='1080p',x=>x[5].input.aspect_ratio='9:16',
  x=>x[5].input.multi_shots=true,x=>x[5].input.prompt='a'.repeat(2501)]){
  const x=inputs();edit(x);assert.throws(()=>validateQuoteEnvelopes(x),/KLING_PRO_SOURCE_REQUIRED/);
 }
 const x=inputs();x[5].input.prompt='a'.repeat(2500);assert.equal(validateQuoteEnvelopes(x).length,10);
});

test('image quote request preserves the approved 2k/high/9:16 parameters',async()=>{
 let images=0;
 await quoteFourthEpisodeUsd({env,envelopes:inputs(),fetchImpl:async(url,opts)=>{
  if(url.endsWith('/marketing-studio/image')){
   const x=JSON.parse(opts.body);assert.equal(x.quality,'high');assert.equal(x.resolution,'2k');
   assert.equal(x.aspect_ratio,'9:16');assert.equal(x.enhance_prompt,false);images++;
  }
  return Response.json({usd:'0.248'});
 }});
 assert.equal(images,5); // Request fidelity, not proof of provider rendering quality.
});

test('Marketing Studio image estimate respects the documented 5000-character prompt limit before I/O',async()=>{
 const atLimit=inputs();atLimit[0].input.prompt='a'.repeat(5000);
 assert.equal(validateQuoteEnvelopes(atLimit).length,10);
 for(const length of [5001,12000]){
  const envelopes=inputs();envelopes[0].input.prompt='a'.repeat(length);
  const r=await quoteFourthEpisodeUsd({env,envelopes,fetchImpl:()=>assert.fail('over-limit input reached transport')});
  assert.equal(r.quote_status,'IMAGE_2K_HIGH_SOURCE_REQUIRED');assert.equal(r.budget_gate,'BLOCKED');
  assert.deepEqual(r.quotes,[]);
 }
});

test('371 included-quota characters are not automatically a verified USD quote',async()=>{
 const {ttsBudgetDecision}=await import('../lib/lumi-tts-stage-v2.js');
 const snapshot={currency:'ELEVENLABS_CHARACTER_QUOTA',units:371,character_count:371,
  quota:{QUOTA_OBSERVED:'PASS',REMAINING_CHARACTERS:39931},request_fingerprint:'offline',provenance:'HISTORICAL_SNAPSHOT_SIMULATION'};
 const q=ttsBudgetDecision({quota_reserve_characters:1000},snapshot,'offline');
 assert.equal(q.status,'PASS');assert.equal(q.usd,null);
 const r=await quoteFourthEpisodeUsd({env,envelopes:inputs(),fetchImpl:fake(),
  verifiedApiBalanceUsd:5,balanceAccountVerified:true,imageQualityVerified:true,
  ttsUpperBoundUsd:q.usd,ttsContractVerified:false});
 assert.equal(r.budget_gate,'BLOCKED');assert.equal(r.total_projected_usd,null);
 snapshot.quota.REMAINING_CHARACTERS=1370;
 assert.equal(ttsBudgetDecision({quota_reserve_characters:1000},snapshot,'offline').status,'BUDGET_EXHAUSTED');
});
