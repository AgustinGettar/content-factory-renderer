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
