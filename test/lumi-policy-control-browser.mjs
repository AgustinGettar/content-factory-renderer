// Real browser + app event handlers; every HTTP route is fulfilled locally.
// No live credentials, Telegram interactions, prices or providers are reachable.
import {chromium} from 'playwright';
import {readFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
const root=new URL('../',import.meta.url),files=Object.fromEntries(await Promise.all(['app.js','style.css','index.html'].map(async n=>[n,await readFile(new URL('public/lumi-studio/'+n,root),'utf8')])));
const before=execFileSync('git',['show',(process.env.LUMI_POLICY_BASELINE_REF||'a1e3cee4599ceddb925a2f7363b7ea3bb0dc4bdd')+':public/lumi-studio/app.js'],{encoding:'utf8'});
const fixture=()=>({client_scope:'fixture-owner',client_session:'fixture-session',server_time:Date.now(),review_revision:4,
 episode:{id:'fixture-episode',title:'La oveja',next_action:'video:q43',checkpoint_version:55,actions:[]},episodes:[],
 operation:{kind:'production_stage',status:'RUNNING',phase:'GENERATING'},episode_job:{id:'same-fixture-job',status:'WAITING_PROVIDER',error:null},
 review_policy:{id:null,mode:'SUPERVISED',choice_available:true,expired:false},episode_plan_authorization:{status:'AUTHORIZED',approval_available:true},
 current_action:{status:'SUBMITTED',emission_locked:true,operations:[]},production:{shots:[],action:{stage:'VIDEO'}},
 media:[],reviews:[],review_receipts:[],action_receipts:[],capabilities:{generate:false},budget:{ceiling_usd:8,exposure_usd:3.03625,remaining_usd:4.96375},settings:{}});
const browser=await chromium.launch({headless:true,...(process.env.LUMI_TEST_BROWSER?{executablePath:process.env.LUMI_TEST_BROWSER,args:['--no-sandbox','--disable-gpu']}: {})});const results=[];
try{
 for(const version of ['before','after']){
  const context=await browser.newContext({viewport:{width:390,height:844}}),page=await context.newPage();
  let state=fixture(),durable=structuredClone(state),reviewGets=0,acceptPosts=0,pausePosts=0,otherPosts=0,readDurable=false,reviewError=null;
  let sawAccept;const accepted=new Promise(resolve=>sawAccept=resolve);
  const held=[],errors=[];page.on('pageerror',e=>errors.push(e.message));
  await context.route('**/*',async route=>{
   const req=route.request(),u=new URL(req.url()),p=u.pathname;
   const json=(body,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
   if(u.hostname!=='lumi.test')return route.fulfill({contentType:'text/javascript',body:''});
   if(p==='/lumi/studio')return route.fulfill({contentType:'text/html',body:files['index.html'].replace('<script defer src="https://telegram.org/js/telegram-web-app.js"></script>','')});
   if(p.endsWith('/style.css'))return route.fulfill({contentType:'text/css',body:files['style.css']});
   if(p.endsWith('/app.js'))return route.fulfill({contentType:'text/javascript',body:(version==='before'?before:files['app.js']).replace('navigation();login();','window.fixtureUI={refresh,button};navigation();login();')});
   if(p.endsWith('/session'))return json({csrf:'fixture',expires_at:Date.now()+1800000});
   if(p.endsWith('/state'))return json({...structuredClone(readDurable?durable:state),server_time:Date.now()});
   if(p.endsWith('/library/plan'))return json({suggestions:[]});
   if(p.endsWith('/review-policy/review')){
    reviewGets++;if(reviewError)return json({error:reviewError},reviewError==='MINI_SESSION_EXPIRED'?401:409);
    return json({challenge:{challenge_id:'decision-1',seal:'fixture-not-live',contract:{stages:['imágenes','videos','voz','montaje','master borrador'],maximum_episode_exposure:8,risk:'Puede animarse un defecto antes de la revisión final.',expires_at:new Date(Date.now()+600000).toISOString()}}});
   }
   if(p.endsWith('/review-policy/accept')){
    acceptPosts++;assert.equal(req.postDataJSON().confirm,true);
    durable={...structuredClone(state),review_revision:state.review_revision+1,review_policy:{id:'draft-policy:decision-1',mode:'DRAFT_FINAL_REVIEW_V1',choice_available:true,expired:false}};
    held.push(route);sawAccept();return; // Durable save succeeded; HTTP response is lost.
   }
   if(p.endsWith('/episode/control')){
    pausePosts++;assert.deepEqual(req.postDataJSON(),{action:'pause'});
    durable.episode_job={...durable.episode_job,status:'PAUSED'};durable.review_revision++;return json({status:'PAUSED',provider_calls:0});
   }
   if(req.method()==='POST')otherPosts++;
   throw Error('UNEXPECTED_FIXTURE_REQUEST '+p);
  });
  await page.goto('https://lumi.test/lumi/studio');if(version==='after')await page.locator('[data-workflow=preparar]').click();await page.waitForSelector('[data-action=draft_policy_review]');
  const policy=page.locator('[data-action=draft_policy_review]').first(),pause=page.locator('[data-action=job_pause]').first();
  if(version==='before'){assert.equal(await policy.isDisabled(),true);assert.equal(await pause.isDisabled(),true);results.push({version,reproduced:true});await context.close();continue;}
  assert.equal(await policy.isEnabled(),true);assert.equal(await pause.isEnabled(),true);
  assert.match(await page.evaluate(()=>fixtureUI.button('Generar','generate')),/disabled/);
  await page.evaluate(()=>{for(let n=0;n<10;n++)document.querySelector('[data-action=draft_policy_review]').click();});
  await page.waitForFunction(()=>document.querySelector('#confirmation').open);assert.equal(reviewGets,1);
  assert.match(await page.locator('#dialog-content').innerText(),/No hay regeneraciones/);
  await page.clock.install();
  await page.evaluate(()=>{for(let n=0;n<10;n++)document.querySelector('#dialog-confirm').click();});
  await page.waitForFunction(()=>document.querySelector('[data-action=draft_policy_review]').disabled);
  await accepted;await page.clock.fastForward(21000);assert.equal(acceptPosts,1);
  // Even a newer stage without the decision receipt must not release its lock.
  state={...state,review_revision:5,episode:{...state.episode,next_action:'temporal_qa:q43',checkpoint_version:56}};
  await page.evaluate(()=>fixtureUI.refresh());assert.equal(await policy.isDisabled(),true);
  for(const r of held)await r.abort().catch(()=>{});
  await page.clock.uninstall?.();await page.reload();await page.locator('[data-workflow=preparar]').click();await page.waitForSelector('[data-action=draft_policy_review]');
  assert.equal(await policy.isDisabled(),true);assert.equal(acceptPosts,1);
  durable={...durable,review_revision:6,episode:state.episode};readDurable=true;
  await page.evaluate(()=>fixtureUI.refresh());
  await page.waitForFunction(()=>!document.querySelector('[data-action=draft_policy_review]'));
  assert.match(await page.locator('[data-ui-key=review-policy]').innerText(),/Borrador automático/);
  assert.match(await page.evaluate(()=>fixtureUI.button('Generar','generate')),/disabled/);
  await page.evaluate(()=>{for(let n=0;n<10;n++)document.querySelector('[data-action=job_pause]').click();});
  await page.waitForSelector('[data-action=job_continue]');assert.equal(pausePosts,1);
  assert.equal(durable.episode_job.id,'same-fixture-job');assert.equal(durable.operation.phase,'GENERATING');assert.equal(durable.budget.exposure_usd,3.03625);
  // Explicit expired-plan presentation: no automatic review, consent or price request.
  durable={...fixture(),review_revision:10,episode:{...state.episode},review_policy:{mode:'SUPERVISED',choice_available:false,choice_unavailable_reason:'EPISODE_PLAN_CONSENT_EXPIRED'},episode_plan_authorization:{status:'HUMAN_APPROVAL_REQUIRED',approval_available:true}};
  await page.evaluate(()=>fixtureUI.refresh());assert.equal(await page.locator('[data-action=draft_policy_review]').count(),0);
  assert.match(await page.locator('[data-ui-key=review-policy]').innerText(),/venció/);assert.equal(await page.locator('[data-ui-key=review-policy] [data-action=plan_review]').isVisible(),true);
  // Session rejection on review GET is actionable; never a hidden generation lock.
  durable.review_policy={mode:'SUPERVISED',choice_available:true};durable.review_revision++;reviewError='MINI_SESSION_EXPIRED';
  await page.evaluate(()=>fixtureUI.refresh());await page.locator('[data-action=draft_policy_review]').click();
  await page.waitForFunction(()=>document.querySelector('[data-control-status]')?.textContent.includes('bot de Telegram'));
  assert.equal(acceptPosts,1);assert.equal(otherPosts,0);assert.equal(errors.length,0,errors.join(';'));
  results.push({version,review_gets:reviewGets,accept_posts:acceptPosts,pause_posts:pausePosts,generative_posts:otherPosts,timeout_reopen:true,expired_plan_preserved:true,session_error_visible:true});
  await context.close();
 }
 console.log('PASS_POLICY_CONTROL_BROWSER '+JSON.stringify(results));
 console.log('Chromium 390x844; fixture transport only. NOT_REAL_IPHONE_ACCEPTANCE.');
}finally{await browser.close();}
