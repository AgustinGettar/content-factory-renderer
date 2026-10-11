import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHmac} from 'node:crypto';
import {genericFixture} from './fixtures/generic-v2.js';
import {runtimeFixture,fixtureSecret} from './fixtures/generic-runtime-v2.js';
import {createGenericV2Runtime} from '../lib/lumi-v2-telegram-runtime.js';
import {authenticateFirstImageCallback,FIRST_IMAGE_EPISODE,inputDigest} from '../lib/lumi-v2-activation-context.js';
import {SUPERVISED_BUDGET_POLICY} from '../lib/higgsfield-usd-budget-v1.js';
import {signRequest} from '../lib/telegram-review-v1/make-transport.js';
import {PROFILE_SHA} from '../lib/lumi-production-profile-v2.js';
import {sha256,reviewKey,renderTelegramPanel} from '../lib/telegram-review-v1/core.js';

async function fixture({stage='IMAGE'}={}){
 const g=await genericFixture(FIRST_IMAGE_EPISODE),f=await runtimeFixture({request:g.request});
 let row=await f.reviewStore.get('1');row.state.v2_authorizations.controlled.dry_run=false;
 row.state.v2_authorizations.controlled.authorized_ceiling_usd=5;await f.reviewStore.cas('1',row.revision,row.state);
 await f.create();
 const bytes=await readFile(new URL('./fixtures/ep004-canonical-source.png',import.meta.url));
 const a={artifact_id:'canonical',episode_id:f.episodeId,sha256:sha256(bytes),size:bytes.length,bucket:'fixture',path:'canonical.png',mime:'image/png',profile_sha:PROFILE_SHA};
 f.objects.set(a.bucket+'/'+a.path,bytes);
 await f.manager.checkpoint(f.episodeId,s=>{
   for(const x of s.actions){if(x.stage===stage)break;x.status='COMPLETE';x.evidence={provider_succeeded:true,artifact_persisted:true,sha_verified:true,artifact_verified:true};}
   s.metadata.artifacts={canonical:a};const action=s.actions.find(x=>x.stage===stage);
   s.metadata.provider_quotes={[action.key]:{currency:'USD',usd:0.2,expires_at:new Date(Date.now()+60000).toISOString(),episode_id:f.episodeId,action_key:action.key}};
 });
 if(stage==='VIDEO')await f.manager.checkpoint(f.episodeId,s=>{
   const shot=s.metadata.generic_v2.shot_plans[0],source={...a,artifact_id:'source',stage_id:'IMAGE',provider_job_id:'OFFLINE_SOURCE_JOB'};
   s.metadata.artifacts.source=source;
   const qa={classification:'PASS',sha256:a.sha256,BODY_LOCK_VERSION:'LUMI_BODY_ANATOMY_LOCK_V1',CARTOON_DRIFT:'MINIMAL'};
   for(const k of ['IDENTITY','REALISM','ANATOMY','EDUCATIONAL_SEMANTICS','COLOR','VIDEO_SOURCE_READINESS','NO_BEE_ABDOMEN','NO_STRIPED_POSTERIOR_BODY','NO_STINGER','NO_EXTRA_TORSO','NO_REAR_BULB'])qa[k]='PASS';
   const sourceResult={episode_id:f.episodeId,stage_id:'IMAGE',artifacts:[source],provider_job_ids:[source.provider_job_id],claims:['OFFLINE_SOURCE_CLAIM'],qa:{ok:true,sha256:a.sha256,visual_qa:qa}};
   const directorResult={episode_id:f.episodeId,stage_id:'DIRECTOR',output:{episode_id:f.episodeId,shot_id:shot.shot_id,
     gates:{SOURCE_EVIDENCE_READY:true,CAPABILITIES_VERIFIED:true},blockers:[],PROVIDER_PROMPT:{text:'Offline validated motion fixture'},
     PROVIDER_REQUEST_PREVIEW:{parameters:{duration:4,sound:'off',multi_shots:false,cfg_scale:0.5}},DIRECTOR_PLAN:{contract:{SOURCE_ARTIFACT:{sha256:a.sha256}}}}};
   s.metadata.stage_results={};
   for(const [key,result] of [['image:'+shot.shot_id,sourceResult],['director:'+shot.shot_id,directorResult]])
     s.metadata.stage_results[key]={receipt_id:'offline-'+key,hash_version:'CANONICAL_JSON_V1',sha256:inputDigest(result),result};
   f.journalRows.set('OFFLINE_SOURCE_CLAIM',{attempt_id:'OFFLINE_SOURCE_CLAIM',episode_id:f.episodeId,stage:'IMAGE',provider_request_id:source.provider_job_id,state:'ACKNOWLEDGED'});
 });
 row=await f.reviewStore.get('1');const e=row.state.episodes[f.episodeId];e.artifacts.canonical=a;
 e.reviews[reviewKey(f.episodeId,null,a.sha256)]={episode_id:f.episodeId,artifact_sha:a.sha256,user:'1',status:'APPROVED'};
 const policy={version:SUPERVISED_BUDGET_POLICY,user:'1',chat:'1',message_id:138,episode_id:f.episodeId,api_key_sha256:sha256('OFFLINE_KEY'),
   hard_episode_budget_usd:5,max_request_reservation_usd:5,max_q41_reservation_usd:0.5,provider_charge_guaranteed:false,billing_verified:false,
   callback_query_id:'OFFLINE_POLICY_CONSENT',expires_at:new Date(Date.now()+3600000).toISOString()};
 row.state.q41_supervised_policy={policy,seal:createHmac('sha256',fixtureSecret).update(SUPERVISED_BUDGET_POLICY+'\n'+inputDigest(policy)).digest('hex')};
 await f.reviewStore.cas('1',row.revision,row.state);
 let mode='insufficient';const calls=[];
 const journal={get:async id=>structuredClone(f.journalRows.get(id)||null),prepare:async r=>{if(f.journalRows.has(r.attempt_id))throw Error('DUPLICATE');f.journalRows.set(r.attempt_id,structuredClone(r));},
  transition:async(id,from,p)=>{const r=f.journalRows.get(id);assert.equal(r.state,from);Object.assign(r,structuredClone(p));}};
 const env={LUMI_RUNTIME_ENV:'staging',LUMI_TELEGRAM_TRANSPORT_AUTHORITY:'MAKE',LUMI_TELEGRAM_REVIEW_TEST_USERS:'1',LUMI_TELEGRAM_CALLBACK_SECRET:fixtureSecret,HF_API_KEY:'OFFLINE_KEY'};
 const fetchImpl=async(url,options)=>{
  calls.push({url,body:options.body});
  if(url.includes('/estimate/'))return Response.json({usd:0.21});
  if(mode==='timeout')throw Error('OFFLINE_TIMEOUT');
  return mode==='insufficient'?Response.json({error:{code:'insufficient_balance'}},{status:402}):Response.json({request_id:'OFFLINE_JOB',status_url:'https://api.higgsfield.ai/requests/OFFLINE_JOB'});
 };
 const makeAdapter=()=>createGenericV2Runtime({manager:f.manager,reviewStore:f.reviewStore,journal,validateOwner:async(u,c)=>u==='1'&&c==='1',env,fetchImpl,
  artifactStorage:{download:async(b,p)=>f.objects.get(b+'/'+p),upload:async()=>{throw Error('NO_UPLOAD_EXPECTED');}},
  mediaTransport:async a=>({sha256:a.sha256,url:'https://fixture.test/canonical.png',expires_at:new Date(Date.now()+120000).toISOString()})});
 let adapter=makeAdapter();
 let count=0;
 const refill=async()=>{
  const row=await f.reviewStore.get('1'),screen={kind:'progress',episode_id:f.episodeId},v=renderTelegramPanel(row.state,screen);
  row.state.tokens={...row.state.tokens,...v.tokens};row.state.screen=screen;row.state.delivery={status:'DELIVERED',tokens:Object.keys(v.tokens)};
  await f.reviewStore.cas('1',row.revision,row.state);
  const t=Object.entries(v.tokens).find(([,t])=>t.action==='balance_reloaded');assert.ok(t,'contextual button');
  const cb={id:'offline-refill-'+(++count),from:{id:1},message:{message_id:138,chat:{id:1}},data:'lr:'+t[0]};
  const signed={method:'POST',path:'/lumi/telegram-review/make/v1',timestamp:String(Math.floor(Date.now()/1000)),requestId:'offline-reload-'+count,body:Buffer.from(JSON.stringify({op:'callback',callback_query:cb}))};
  return authenticateFirstImageCallback({env,signed,signature:signRequest(fixtureSecret,signed)});
 };
 return {...f,journal,calls,refill,setMode:m=>mode=m,get adapter(){return adapter;},restart:()=>adapter=makeAdapter(),cleanup:g.cleanup};
}

test('generic image rejection pauses; signed refill quotes only pending action and preserves completed work',async()=>{
 const f=await fixture();try{
  const before=await f.store.getEpisode(f.episodeId),reviews=(await f.reviewStore.get('1')).state.episodes[f.episodeId].reviews;
  assert.equal((await f.adapter.resume({user:'1',episodeId:f.episodeId})).status,'PAUSED_INSUFFICIENT_BALANCE');
  const paused=await f.store.getEpisode(f.episodeId),original=await f.journal.get(paused.metadata.balance_pause.attempt_id);
  f.setMode('success');const command=await f.refill();await f.adapter.balanceReloaded({command});
  const after=await f.store.getEpisode(f.episodeId);
  assert.equal(f.calls.length,3);assert.equal(f.journalRows.size,2);assert.equal(after.first_pending_action,paused.first_pending_action);
  assert.deepEqual(await f.journal.get(original.attempt_id),original);
  assert.deepEqual(after.actions.filter(a=>a.status==='COMPLETE'),before.actions.filter(a=>a.status==='COMPLETE'));
  assert.deepEqual((await f.reviewStore.get('1')).state.episodes[f.episodeId].reviews,reviews);
  assert.equal(Object.keys((await f.reviewStore.get('1')).state.episodes[f.episodeId].review_requests).length,0);
  await f.restart().balanceReloaded({command});assert.equal(f.calls.length,3);
  assert.equal(after.authorized_ceiling_usd,5);assert.equal(after.metadata.budget_reservations[after.first_pending_action].amount_usd,0.2625);
  assert.ok(f.calls.every(c=>!c.url.includes('elevenlabs')));
 }finally{await f.cleanup();}
});

test('generic recovery refuses an ambiguous journal and unbranded/forged command',async()=>{
 const f=await fixture();try{
  await f.adapter.resume({user:'1',episodeId:f.episodeId});const command=await f.refill();
  await assert.rejects(f.adapter.balanceReloaded({command:{...command}}),/HMAC/);
  const cp=await f.store.getEpisode(f.episodeId);f.journalRows.get(cp.metadata.balance_pause.attempt_id).state='EMISSION_UNKNOWN';
  await assert.rejects(f.adapter.balanceReloaded({command}),/EVIDENCE/);assert.equal(f.calls.length,1);
 }finally{await f.cleanup();}
});

test('generic refill double click submits once and keeps rejected-cost exposure',async()=>{
 const f=await fixture();try{
  await f.adapter.resume({user:'1',episodeId:f.episodeId});const command=await f.refill();f.setMode('success');
  await Promise.allSettled([f.adapter.balanceReloaded({command}),f.adapter.balanceReloaded({command})]);
  assert.equal(f.calls.length,3);assert.equal(f.journalRows.size,2);
  const cp=await f.store.getEpisode(f.episodeId);assert.equal(cp.current_cost_usd,0);
  assert.equal(Object.values(cp.metadata.budget_reservations).reduce((s,r)=>s+r.amount_usd,0),0.4625);
 }finally{await f.cleanup();}
});

test('Kling recovery quotes only the rejected VIDEO and never repeats its approved source image',async()=>{
 const f=await fixture({stage:'VIDEO'});try{
  const before=await f.store.getEpisode(f.episodeId);
  assert.equal((await f.adapter.resume({user:'1',episodeId:f.episodeId})).status,'PAUSED_INSUFFICIENT_BALANCE');
  const command=await f.refill();f.setMode('success');await f.adapter.balanceReloaded({command});
  assert.equal(f.calls.length,3);assert.ok(f.calls.every(c=>c.url.includes('kling-video/v3.0/pro/image-to-video')));
  const after=await f.store.getEpisode(f.episodeId);
  assert.deepEqual(after.actions.filter(a=>a.status==='COMPLETE'),before.actions.filter(a=>a.status==='COMPLETE'));
  assert.deepEqual(after.metadata.stage_results,before.metadata.stage_results);
 }finally{await f.cleanup();}
});
