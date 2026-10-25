import test from 'node:test';
import assert from 'node:assert/strict';
import {publicationDraft} from '../lib/telegram-mini-app/publication.js';
import {recoverSeriesProviderResult} from '../lib/lumi-series-v2-execution.js';

test('PUBLICATION_DRAFT: episode-specific text stays a bounded draft without publication authority',()=>{
 const titles=['Lumi y los animales de la granja','Lumi y las tres flores de colores','Lumi y el jardín de las formas','Lumi y los cinco huevos perdidos'];
 const drafts=titles.map(title=>publicationDraft({title}));assert.equal(new Set(drafts.map(d=>d.text)).size,4);
 for(const d of drafts){assert.equal(d.status,'DRAFT');assert.equal(d.review_required,true);assert.ok(d.text.length<2200);assert.match(d.text,/#Lumi/);assert.ok(!d.text.includes('\n'));}
 assert.match(drafts[0].text,/vaca, la oveja y la gallina/);assert.match(drafts[1].text,/Tres flores/);
 const future=publicationDraft({title:'Lumi descubre el mar',objective:'Reconocer peces y tortugas.'});assert.match(future.text,/Reconocer peces y tortugas/);
 assert.ok(publicationDraft({title:'x'.repeat(10000),objective:'y'.repeat(10000)}).text.length<2200);
});

for(const [status,code] of [['queued','PROVIDER_RESULT_NOT_COMPLETE'],['in_progress','PROVIDER_RESULT_NOT_COMPLETE'],['processing','PROVIDER_RESULT_NOT_COMPLETE'],['failed','PROVIDER_RESULT_FAILED'],['nsfw','PROVIDER_RESULT_MODERATED'],['canceled','PROVIDER_RESULT_CANCELED'],['unexpected','PROVIDER_RESULT_STATUS_UNKNOWN']]){
 test('PROVIDER_STATUS: '+status+' remains distinguishable without generation or download',async()=>{
  const calls=[];await assert.rejects(recoverSeriesProviderResult({accepted:{request_id:'original',status_url:'https://api.higgsfield.ai/requests/original/status'},provider_job_id:'original',result_id:'original',stage:'IMAGE',apiKey:'fixture',fetchImpl:async(url,options)=>{calls.push({url,method:options.method});return Response.json({request_id:'original',status});}}),e=>e.message===code&&(status==='unexpected'||e.provider_status===(status==='processing'?'in_progress':status)));
  assert.deepEqual(calls,[{url:'https://api.higgsfield.ai/requests/original/status',method:'GET'}]);
 });
}
test('PROVIDER_STATUS: completed results still download only the bound original',async()=>{
 const calls=[];const result=await recoverSeriesProviderResult({accepted:{request_id:'original',status_url:'https://api.higgsfield.ai/requests/original/status'},provider_job_id:'original',result_id:'original',stage:'IMAGE',apiKey:'fixture',fetchImpl:async(url,options)=>{calls.push(url);return url.includes('/requests/')?Response.json({request_id:'original',status:'completed',images:[{url:'https://media.example.test/original'}]}):new Response('original-bytes');}});
 assert.equal(result.bytes.toString(),'original-bytes');assert.equal(calls.length,2);
});


import {higgsfieldFundingCode,fundingPresentation,HIGGSFIELD_FUNDING_ERROR} from '../lib/higgsfield-funding.js';
import {providerJson} from '../lib/generative-video-benchmark-v1.js';
test('HIGGSFIELD_FUNDING: classify only explicit structured balance errors, never a generic failure or 402',async()=>{
 assert.equal(higgsfieldFundingCode({error:{code:'insufficient_balance'}}),'insufficient_balance');
 for(const body of [{status:'failed'},{error:'No money'},{error:{code:'failed'}},{}])assert.equal(higgsfieldFundingCode(body),null);
 for(const [body,code] of [[{error:{code:'insufficient_balance'}},HIGGSFIELD_FUNDING_ERROR],[{},'HIGGSFIELD_BILLING_CHECK_REQUIRED']]){
  await assert.rejects(providerJson('https://api.higgsfield.ai/estimate/example',{apiKey:'fixture',fetchImpl:async()=>Response.json(body,{status:402})}),e=>e.message===code);
 }
 await assert.rejects(recoverSeriesProviderResult({accepted:{request_id:'original',status_url:'https://api.higgsfield.ai/requests/original/status'},provider_job_id:'original',result_id:'original',stage:'IMAGE',apiKey:'fixture',fetchImpl:async()=>Response.json({request_id:'original',status:'failed',error:{code:'insufficient_funds'}})}),e=>e.message===HIGGSFIELD_FUNDING_ERROR&&e.provider_status==='failed');
});
test('HIGGSFIELD_FUNDING: owner reports are labeled, recharge never verifies balance or grants a retry',()=>{
 const ctx={checkpoint:{actions:[]},state:{mini_app:{funding:{higgsfield:{owner_report:{id:'owner-empty',status:'EMPTY_REPORTED',reported_at:'2026-10-25T17:00:00Z'}}}}}};
 let v=fundingPresentation(ctx);assert.equal(v.blocks_generation,true);assert.equal(v.source,'OWNER_REPORTED');assert.equal(v.balance_usd,null);assert.equal(v.balance_verified,false);
 const f=ctx.state.mini_app.funding.higgsfield;f.provider_notice={id:'earlier',at:'2026-10-25T16:00:00Z'};
 f.owner_report={id:'topup',status:'RECHARGE_REPORTED',reported_at:'2026-10-25T17:30:00Z',resolves_notice_id:'owner-empty'};
 v=fundingPresentation(ctx);assert.equal(v.status,'RECHARGE_REPORTED');assert.equal(v.blocks_generation,false);assert.equal(v.balance_verified,false);
 f.provider_notice={id:'later',at:'2026-10-25T18:00:00Z'};v=fundingPresentation(ctx);assert.equal(v.blocks_generation,true);assert.equal(v.source,'PROVIDER_ERROR');
 f.provider_notice.code='HIGGSFIELD_BILLING_CHECK_REQUIRED';v=fundingPresentation(ctx);assert.equal(v.status,'CHECK_BILLING');assert.equal(v.source,'PROVIDER_BILLING_RESPONSE');assert.equal(v.balance_usd,null);
});
