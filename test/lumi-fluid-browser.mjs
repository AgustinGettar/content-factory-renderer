// Browser acceptance uses only fulfilled fixture requests. No live bot/session,
// provider, price or production action is reachable from this test context.
import {chromium} from 'playwright';
import {readFile,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import assert from 'node:assert/strict';
import {imagePreview} from '../lib/telegram-mini-app/library.js';
const sha=b=>createHash('sha256').update(b).digest('hex'),base=new URL('../',import.meta.url);
const files=Object.fromEntries(await Promise.all(['app.js','style.css','index.html'].map(async n=>[n,await readFile(new URL('public/lumi-studio/'+n,base),'utf8')])));
const before=execFileSync('git',['show','079fae88e5188da574ca589e290e6c83afc161d7:public/lumi-studio/app.js'],{encoding:'utf8'});
const dir=await mkdtemp(join(tmpdir(),'lumi-browser-'));
let browser;
try{
 const png=join(dir,'fixture.png');execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=1520x2688','-frames:v','1','-threads','1',png]);
 const original=await readFile(png),thumb=await imagePreview(original,{variant:'thumb'}),preview=await imagePreview(original,{variant:'preview'}),hash=sha(original);
 browser=await chromium.launch({headless:true});const observations=[];
 for(const version of ['before','after']){
  const context=await browser.newContext({viewport:{width:390,height:844},reducedMotion:'reduce'}),page=await context.newPage();
  let postCount=0,effects=0,stalled=false,reads=0,expired=false;const errors=[],mediaReads=[],held=[];
  page.on('pageerror',e=>errors.push(e.message));
  let state={client_scope:'fixture-owner',client_session:'fixture-session',server_time:Date.now(),review_revision:1,
   episode:{id:'ep-fixture',title:'Escena de prueba',next_action:'image:s1',checkpoint_version:1,actions:[]},episodes:[],
   production:{shots:[{id:'s1',number:1,current:true,title:'La vaca',goal:'Revisión de prueba',stages:[],characters:[],continuity:{character_details:[]}}],action:{stage:'IMAGE'}},
   media:[{id:'source',episode:'ep-fixture',shot_id:'s1',role:'source',mime:'image/png',label:'Fixture',width:1520,height:2688,sha256:hash,size:original.length,url:'/lumi/studio/api/media/source?ticket=fixture',expires_at:Date.now()+300000}],
   reviews:[{id:'review-1',stage:'IMAGE',media_id:'source',version:1,artifact_sha:hash,contract_sha:'fixture'}],review_receipts:[],action_receipts:[],
   current_action:{status:'AWAITING_HUMAN_REVIEW',operations:[]},budget:{ceiling_usd:8,exposure_usd:1,remaining_usd:7},capabilities:{},quote:null,operation:null,
   episode_plan_authorization:{status:'HUMAN_APPROVAL_REQUIRED',approval_available:true},settings:{},cost_projection:null};
  const asset={asset_id:'a'.repeat(64),sha256:hash,display_name:'Lumi fixture',description:'Test',continuity_tags:[],asset_type:'CHARACTER_REFERENCE',reuse_policy:{modes:[]},reusable:true,version:1,media_type:'image/png',size_bytes:original.length,dimensions:{width:1520,height:2688},approval_reference:{scope:'WHOLE_IMAGE_CONTEXT_REFERENCE'},expires_at:Date.now()+300000,media_url:'/lumi/studio/api/library/media/'+ 'a'.repeat(64)+'?ticket=fixture'};
  await context.route('**/*',async route=>{
   const u=new URL(route.request().url()),path=u.pathname,method=route.request().method();const json=x=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(x)});
   if(u.hostname!=='lumi.test')return route.fulfill({status:200,contentType:'text/javascript',body:''});
   if(path==='/lumi/studio')return route.fulfill({contentType:'text/html',body:files['index.html'].replace('<script defer src="https://telegram.org/js/telegram-web-app.js"></script>','')});
   if(path==='/lumi/studio/style.css')return route.fulfill({contentType:'text/css',body:files['style.css']});
   if(path==='/lumi/studio/app.js')return route.fulfill({contentType:'text/javascript',body:(version==='before'?before:files['app.js']).replace('navigation();login();',`window.fixtureUI={refresh,render,setTab:t=>tab=t,getState:()=>state,${version==='after'?'metrics:uiMetrics,':''}};navigation();login();`)});
   if(path.endsWith('/session'))return json({csrf:'fixture',expires_at:Date.now()+1800000});
   if(path.endsWith('/state')){reads++;if(expired)return route.fulfill({status:401,contentType:'application/json',body:'{"error":"MINI_SESSION_EXPIRED"}'});return json({...state,server_time:Date.now()});}
   if(path.endsWith('/library/plan'))return json({suggestions:[],checkpoint_revision:1});
   if(path.endsWith('/library'))return json({assets:[asset],selections:[],counts:{},version:2});
   if(path.includes('/library/access/'))return json({media:asset});
   if(path.endsWith('/media/source/access'))return json({url:state.media[0].url,expires_at:Date.now()+300000});
   if(path.includes('/media/')){
    const variant=u.searchParams.get('variant'),bytes=variant==='thumb'?thumb:variant==='preview'?preview:original;mediaReads.push({variant:variant||'original',bytes:bytes.length});
    return route.fulfill({contentType:variant?'image/jpeg':'image/png',body:bytes,headers:{'X-Content-SHA256':sha(bytes),'X-Original-SHA256':hash}});
   }
   if(method==='POST'&&path.endsWith('/actions/review')){
    postCount++;if(!state.action_receipts.length){effects++;state.action_receipts=[{id:'review-operation',kind:'review',status:'RUNNING',binding:{next_action:'image:s1',request_id:'review-1',review_version:1,artifact_sha:hash}}];}
    if(stalled){held.push(route);return;}return route.fulfill({status:202,contentType:'application/json',body:'{"operation":{"id":"review-operation","status":"QUEUED"}}'});
   }
   throw Error('UNEXPECTED_FIXTURE_REQUEST:'+method+':'+path);
  });
  await page.goto('https://lumi.test/lumi/studio');await page.locator('[data-tab=produccion]').click();
  await page.waitForFunction(()=>document.querySelector('#pose-review-1'));
  if(version==='after')await page.waitForFunction(()=>!document.querySelector('[data-review="review-1"]').disabled);
  await page.selectOption('#pose-review-1','FRONT');await page.selectOption('#wand-review-1','RIGHT');
  await page.evaluate(()=>{window.originalImage=document.querySelector('#next-action img');window.originalSelect=document.querySelector('#pose-review-1');});
  for(let n=0;n<3;n++){state={...state,server_time:Date.now()+n*5000,media:state.media.map(m=>({...m,url:'/lumi/studio/api/media/source?ticket=renewed-'+n,expires_at:Date.now()+300000}))};await page.evaluate(()=>window.fixtureUI.refresh());}
  const nodePreserved=await page.evaluate(()=>window.originalImage===document.querySelector('#next-action img')&&window.originalSelect===document.querySelector('#pose-review-1'));
  await page.selectOption('#pose-review-1','FRONT');await page.selectOption('#wand-review-1','RIGHT');
  stalled=true;
  const feedback=await page.evaluate(async()=>{const b=document.querySelector('[data-review="review-1"]'),t=performance.now();for(let n=0;n<10;n++)b.click();await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));return {ms:performance.now()-t,disabled:document.querySelector('[data-review="review-1"]')?.disabled,text:document.querySelector('#app').textContent};});
  await page.waitForFunction(()=>document.querySelector('#notice')?.textContent.length>0);assert.equal(postCount,1);assert.equal(effects,1);
  if(version==='after'){assert.ok(feedback.disabled);assert.match(feedback.text,/Enviando aprobación/);assert.ok(nodePreserved);assert.ok(feedback.ms<200);}
  // Simulated elapsed delays, no long wall-clock waits. Browser HTTP timeout is real application code.
  if(version==='after'){
   await page.clock.install();
   for(const elapsed of [5000,20000,60000]){await page.clock.fastForward(elapsed);assert.equal(await page.locator('[data-review="review-1"]').first().isDisabled(),true);}
   for(const r of held)await r.abort().catch(()=>{});held.length=0;
   await page.clock.uninstall?.();
   await page.reload();await page.locator('[data-tab=produccion]').click();await page.waitForFunction(()=>document.querySelector('#pose-review-1'));
   assert.equal(await page.locator('[data-review="review-1"]').first().isDisabled(),true);assert.equal(postCount,1);
   state={...state,review_revision:2,review_receipts:[{id:'review-1',version:1,artifact_sha:hash,status:'APPROVED'}]};await page.evaluate(()=>window.fixtureUI.refresh());assert.equal(await page.locator('[data-review="review-1"]').first().innerText(),'Aprobada');
   state={...state,review_revision:3,reviews:[{...state.reviews[0],id:'review-2',version:2}]};await page.evaluate(()=>window.fixtureUI.refresh());await page.waitForFunction(()=>!document.querySelector('[data-review="review-2"]').disabled);
  }
  const navigation=await page.evaluate(async()=>{const start=performance.now();document.querySelector('[data-tab=biblioteca]').click();await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));return performance.now()-start;});
  await page.waitForFunction(()=>document.querySelector('[data-library-preview] img')?.complete);
  if(version==='after'){assert.ok(navigation<200);assert.equal(errors.length,0,errors.join(';'));}
  observations.push({version,fixture:true,feedback_to_two_frames_ms:Math.round(feedback.ms),navigation_to_two_frames_ms:Math.round(navigation),media_node_preserved:nodePreserved,posts:postCount,effects,media_reads:mediaReads,client_metrics:version==='after'?await page.evaluate(()=>window.fixtureUI.metrics):null,errors});
  await context.close();
 }
 console.log('LUMI_BROWSER_MEASUREMENTS '+JSON.stringify(observations));
 console.log('PASS_BROWSER_FIXTURES: latency 5/20/60s, ten taps, timeout/reload, approved receipt, new review, stable DOM, progressive private previews. NOT_IPHONE_ACCEPTANCE.');
}finally{await browser?.close();await rm(dir,{recursive:true,force:true});}
