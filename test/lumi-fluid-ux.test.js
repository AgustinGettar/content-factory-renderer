import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {createHash,webcrypto} from 'node:crypto';
import {runInNewContext} from 'node:vm';
import {performance} from 'node:perf_hooks';
import {parseHTML} from 'linkedom';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {LocalMediaPreviews,imagePreview} from '../lib/telegram-mini-app/library.js';
const digest=b=>createHash('sha256').update(b).digest('hex');
const js=await readFile(new URL('../public/lumi-studio/app.js',import.meta.url),'utf8');
const html=await readFile(new URL('../public/lumi-studio/index.html',import.meta.url),'utf8');
const makeState=()=>({client_scope:'owner-a',client_session:'session-a',review_revision:10,server_time:Date.now(),
 episode:{id:'fixture-005',title:'Fixture',next_action:'image:s1',checkpoint_version:8,actions:[]},episodes:[],
 media:[{id:'image1',episode:'fixture-005',role:'source',shot_id:'s1',sha256:'a'.repeat(64),mime:'image/png',width:90,height:160,url:'/original?ticket=first',expires_at:Date.now()+300000}],
 reviews:[{id:'review1',media_id:'image1',stage:'IMAGE',version:1,artifact_sha:'a'.repeat(64),contract_sha:'contract'}],
 review_receipts:[],action_receipts:[],operation:null,current_action:{status:'AWAITING_HUMAN_REVIEW',operations:[]},
 production:{shots:[{id:'s1',number:1,title:'Escena',current:true,goal:'Fixture',stages:[],characters:[],continuity:{character_details:[]}}],action:{stage:'IMAGE'}},
 budget:{ceiling_usd:8,exposure_usd:1,remaining_usd:7},episode_plan_authorization:{approval_available:true,status:'HUMAN_APPROVAL_REQUIRED'},capabilities:{},quote:null,settings:{},lifecycle:{state:'AWAITING_HUMAN_REVIEW'}});
function harness(initial=makeState(),saved=new Map()){
 const {document,window}=parseHTML(html),metrics=[];window.scrollTo=()=>{};window.matchMedia=()=>({matches:true});
 const ctx={document,window,initial:structuredClone(initial),performance,Date,console,crypto:webcrypto,AbortController,Blob,URL,
  localStorage:{getItem:k=>saved.get(k)||null,setItem:(k,v)=>saved.set(k,v)},setTimeout,clearTimeout,setInterval(){},fetch:()=>{throw Error('EXTERNAL_READ_FORBIDDEN');}};
 runInNewContext(js.replace('navigation();login();','')+`
 state=initial;csrf='fixture';tab='produccion';autoLibraryPlan=()=>{};hydrateStudioMedia=()=>{};hydrateLibraryMedia=()=>{};
 globalThis.ui={submit,refresh,render,patchMarkup,displayBytes,markMediumLoaded,reviewCards,reconcileIntents,intentText,beginIntent,matchingIntent,metrics:uiMetrics,
 setRequest:f=>request=f,setFetch:f=>globalThis.fetch=f,setState:s=>state=s,getState:()=>state,setTab:t=>tab=t};`,ctx);
 ctx.ui.markMediumLoaded('image1');ctx.ui.render();return {...ctx,saved};
}
const decision={request_id:'review1',artifact_sha:'a'.repeat(64),review_version:1,decision:'APPROVED',pose:'FRONT',wand_hand:'RIGHT'};
for(const seconds of [5,20,60])test(`ACTION_LATENCY_${seconds}s: ten taps, lost response, reopen, stale GET and new review`,async()=>{
 const h=harness();let posts=0,rejectPost;let current=makeState();
 h.ui.setRequest((path)=>{if(path.startsWith('/actions/')){posts++;return new Promise((_,reject)=>rejectPost=reject);}return Promise.resolve(structuredClone(current));});
 const start=performance.now(),pending=h.ui.submit('review',decision);
 assert.match(h.document.querySelector('#app').textContent,/Enviando aprobación/);assert.equal(h.document.querySelector('[data-review]').disabled,true);
 const feedback=performance.now()-start;assert.ok(feedback<100,`DOM feedback ${feedback}ms`);
 for(let n=0;n<10;n++)await h.ui.submit('review',decision);assert.equal(posts,1);
 // Simulate an outstanding HTTP for the specified elapsed interval without sleeping or providers.
 current.server_time+=seconds*1000;await h.ui.refresh();assert.equal(h.document.querySelector('[data-review]').disabled,true);
 rejectPost(Object.assign(Error('timeout'),{name:'AbortError'}));await pending;
 assert.match(h.document.querySelector('#app').textContent,/Comprobando si se guardó/);
 const reopened=harness(current,h.saved);reopened.ui.setRequest(async()=>current);await reopened.ui.submit('review',decision);assert.equal(posts,1);
 current.review_revision=11;current.review_receipts=[{id:'review1',version:1,artifact_sha:decision.artifact_sha,status:'APPROVED'}];
 await reopened.ui.refresh();assert.equal(reopened.document.querySelector('[data-review]').disabled,true);assert.match(reopened.document.querySelector('[data-review]').textContent,/Aprobada/);
 const stale=makeState();reopened.ui.setRequest(async()=>stale);await reopened.ui.refresh();assert.equal(reopened.ui.getState().review_revision,11);
 current={...current,review_revision:12,reviews:[{...current.reviews[0],id:'review2',version:2}]};reopened.ui.setRequest(async()=>current);await reopened.ui.refresh();assert.equal(reopened.document.querySelector('[data-review]').disabled,false);
 console.log(JSON.stringify({measurement:'DOM_SYNTHETIC',latency_s:seconds,first_feedback_ms:Number(feedback.toFixed(2)),posts}));
});
test('OPTIONAL_DRAFT_REVIEW: pending voluntary review keeps the same action lock after lost response',async()=>{
 const s=makeState();s.optional_reviews=s.reviews;s.reviews=[];s.review_policy={mode:'DRAFT_FINAL_REVIEW_V1'};
 const h=harness(s);h.ui.beginIntent('review',decision);h.ui.render();
 assert.match(h.document.querySelector('#app').textContent,/Enviando aprobación/);
 h.ui.reconcileIntents({...s,review_receipts:[{id:'review1',version:1,artifact_sha:decision.artifact_sha,status:'APPROVED'}]});h.ui.render();
 assert.doesNotMatch(h.document.querySelector('#app').textContent,/Enviando aprobación/);
});
test('DOM_PRESERVATION: identical polls and refreshed tickets keep media, controls and selected values',async()=>{
 const h=harness(),root=h.document.querySelector('#app'),image=root.querySelector('[data-media-host]'),select=root.querySelector('select');
 select.querySelector('[value=THREE_QUARTER]').selected=true;const child=h.document.createElement('img');child.src='blob:verified';image.append(child);
 h.ui.beginIntent('review',decision);h.ui.render();assert.equal(root.querySelector('[data-media-host]'),image);h.ui.reconcileIntents({...makeState(),review_revision:11,review_receipts:[{id:'review1',version:1,artifact_sha:decision.artifact_sha,status:'APPROVED'}]});h.ui.render();assert.equal(root.querySelector('[data-media-host]'),image);h.ui.setRequest(async()=>({...makeState(),server_time:Date.now()+5000,media:makeState().media.map(m=>({...m,url:'/original?ticket=renewed',expires_at:Date.now()+500000}))}));
 await h.ui.refresh();assert.equal(root.querySelector('[data-media-host]'),image);assert.equal(image.querySelector('img'),child);assert.equal(root.querySelector('select'),select);assert.equal(select.value,'THREE_QUARTER');
 const target=h.document.createElement('div');h.ui.patchMarkup(target,'<video controls src="/a?ticket=1"></video>');const v=target.firstChild;v.currentTime=12;
 h.ui.patchMarkup(target,'<video controls src="/a?ticket=2"></video>');assert.equal(target.firstChild,v);assert.equal(v.currentTime,12);assert.equal(v.getAttribute('src'),'/a?ticket=1');
});
test('DISPLAY_CACHE: concurrent reads share verified derivative, owner isolation, expired access and no original fetch',async()=>{
 const h=harness(),bytes=Buffer.from('verified-preview'),sha=digest(bytes);let gets=0,renews=0,expired=false;
 h.ui.setRequest(async()=>{renews++;return {url:'/fixture?ticket=renewed',expires_at:Date.now()+300000};});
 h.ui.setFetch(async url=>{gets++;assert.match(url,/variant=thumb/);if(expired){expired=false;return {ok:false,status:403};}return {ok:true,status:200,headers:{get:k=>({'x-content-sha256':sha,'x-original-sha256':'a'.repeat(64)}[k])},blob:async()=>new Blob([bytes],{type:'image/jpeg'})};});
 const m=makeState().media[0],pair=await Promise.all([h.ui.displayBytes(m,'thumb'),h.ui.displayBytes(m,'thumb')]);assert.equal(pair[0].url,pair[1].url);assert.equal(gets,1);
 h.ui.setState({...makeState(),client_scope:'other-owner'});expired=true;await h.ui.displayBytes(m,'thumb');assert.equal(gets,3);assert.equal(renews,1);
 h.ui.setState({...makeState(),client_scope:'third-owner'});h.ui.setFetch(async()=>({ok:false,status:404}));await assert.rejects(h.ui.displayBytes(m,'thumb'),e=>e.status===404);
});
test('LOCAL_PREVIEWS: deterministic bytes, durable provenance, restart, bounded encoder and owner isolation',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'lumi-fluid-fixture-'));
 try{
  const path=join(dir,'fixture.png');await promisify(execFile)('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=1520x2688','-frames:v','1','-threads','1',path],{timeout:20000});
  const original=await readFile(path),a={artifact_id:'fixture',bucket:'private',path:'fixture.png',mime:'image/png',size:original.length,sha256:digest(original)},files=new Map();let loads=0,encodes=0;
  const storage={download:async(b,p)=>files.get(b+'/'+p)||null,upload:async(b,p,bytes)=>{assert.ok(!files.has(b+'/'+p));files.set(b+'/'+p,bytes);}};
  const options={storage,privateBucket:async()=>true,loadBytes:async()=>{loads++;return original;},encode:async(...args)=>{encodes++;return imagePreview(...args);}},previews=new LocalMediaPreviews(options);
  assert.equal(await previews.get('owner-a',a,'thumb'),null);assert.equal(await previews.get('owner-a',a,'thumb'),null);await Promise.all(previews.pending.values());
  const thumb=await previews.get('owner-a',a,'thumb');assert.equal(thumb.manifest.source_sha256,a.sha256);assert.equal(digest(thumb.bytes),thumb.manifest.sha256);assert.equal(thumb.manifest.artistic_approval,false);assert.ok(thumb.bytes.length<150000);
  await previews.get('owner-a',a,'preview');await Promise.all(previews.pending.values());const preview=await previews.get('owner-a',a,'preview');assert.equal(loads,1);assert.equal(encodes,2);
  const restarted=new LocalMediaPreviews(options);await restarted.get('owner-a',a,'thumb');await Promise.all(restarted.pending.values());assert.deepEqual((await restarted.get('owner-a',a,'thumb')).bytes,thumb.bytes);assert.equal(loads,1);
  await restarted.get('owner-b',a,'thumb');await Promise.all(restarted.pending.values());assert.equal(loads,2);assert.equal(files.size,6);
  await assert.rejects(new LocalMediaPreviews({...options,privateBucket:async()=>false}).get('owner-a',a,'thumb'),/PRIVATE_STORAGE/);
  const deterministic=await imagePreview(original,{variant:'thumb'});assert.equal(digest(deterministic),thumb.manifest.sha256);
  console.log(JSON.stringify({measurement:'SYNTHETIC_IMAGE_BYTES',original:original.length,thumb:thumb.bytes.length,preview:preview.bytes.length,source_downloads_for_two_variants:1}));
 }finally{await rm(dir,{recursive:true,force:true});}
});
