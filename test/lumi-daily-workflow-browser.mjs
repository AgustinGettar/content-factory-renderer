// Actual browser/app, synthetic media and intercepted transport. No live account
// or provider calls. This is not an iPhone/Telegram acceptance certificate.
import {chromium} from 'playwright';
import {createServer} from 'node:http';
import {readFile,mkdtemp,mkdir,rm} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const root=new URL('../',import.meta.url),files=Object.fromEntries(await Promise.all(['app.js','style.css','index.html'].map(async n=>[n,await readFile(new URL('public/lumi-studio/'+n,root),'utf8')])));
const dir=await mkdtemp(join(tmpdir(),'lumi-daily-')),screens='/tmp/lumi-daily-screens';await mkdir(screens,{recursive:true});
let browser,server;
try{
 const file=join(dir,'master.mp4');
 execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','color=c=0xabcbd8:s=1080x1920:r=24:d=2','-f','lavfi','-i','sine=frequency=440:duration=2','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-threads','1','-c:a','aac','-movflags','+faststart','-shortest',file]);
 const bytes=await readFile(file),sha=createHash('sha256').update(bytes).digest('hex');
 const posterFile=join(dir,'poster.jpg');execFileSync('ffmpeg',['-v','error','-i',file,'-frames:v','1','-vf','scale=180:320','-threads','1',posterFile]);const poster=await readFile(posterFile),posterSha=createHash('sha256').update(poster).digest('hex');
 const probe=JSON.parse(execFileSync('ffprobe',['-v','error','-show_streams','-of','json',file],{encoding:'utf8'}));
 assert.equal(probe.streams.find(s=>s.codec_type==='audio').codec_name,'aac');
 browser=await chromium.launch({headless:true,...(process.env.LUMI_TEST_BROWSER?{executablePath:process.env.LUMI_TEST_BROWSER,args:['--no-sandbox','--disable-gpu']}: {})});const context=await browser.newContext({viewport:{width:390,height:844},acceptDownloads:true}),page=await context.newPage();
 let posts=0,reads=0,accesses=0,ranges=0,libraryReads=0,libraryGate=null,libraryAssets=[],expired=false,allowStart=false,planAccepts=0,starts=0;const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const shot=(n)=>({id:'q4'+n,number:n,title:['Lumi y vos','La vaca','La oveja','El caballo','El cerdo','La gallina','Hasta mañana'][n-1],complete:n<3,current:n===3,goal:'Descubrir la granja',characters:['Lumi'],continuity:{character_details:[]}});
 let state={client_scope:'fixture-owner',client_session:'fixture-session',server_time:Date.now(),review_revision:4,
  episode:{id:'fixture-episode',title:'Lumi descubre la granja',next_action:'video:q43',checkpoint_version:55,actions:[]},episodes:[{id:'fixture-episode',title:'Lumi descubre la granja'}],
  operation:{kind:'production_stage',status:'RUNNING',phase:'GENERATING'},episode_job:{id:'original-job',status:'WAITING_PROVIDER'},
  review_policy:{id:'accepted-policy',mode:'DRAFT_FINAL_REVIEW_V1',choice_available:true,expired:false},episode_plan_authorization:{status:'AUTHORIZED',approval_available:true},
  current_action:{status:'SUBMITTED',emission_locked:true,provider_request_id:'internal-id',operations:[]},production:{shots:Array.from({length:7},(_,n)=>shot(n+1)),action:{stage:'VIDEO'}},
  continuity:{accepted_at:'2026-10-23T15:00:00Z',last_provider_check_at:'2026-10-23T15:01:00Z',recovery_status:'WAITING'},
  media:[],reviews:[],review_receipts:[],action_receipts:[],capabilities:{generate:false},budget:{ceiling_usd:8,actual_cost_usd:null,exposure_usd:3.03625,remaining_usd:4.96375,reservations:[{amount_usd:3.03625}]},settings:{}};
 const handle=async route=>{
  const req=route.request(),u=new URL(req.url()),p=u.pathname,json=(body,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
  if(u.hostname!=='127.0.0.1')throw Error('EXTERNAL_REQUEST_BLOCKED');
  if(req.method()==='POST'){
   posts++;if(!allowStart)throw Error('UNEXPECTED_MUTATION');
   if(p.endsWith('/plan/accept')){assert.equal(req.postDataJSON().review_mode,'DRAFT_FINAL_REVIEW_V1');assert.equal(req.postDataJSON().confirm,true);planAccepts++;state.episode_plan_authorization.status='AUTHORIZED';return json({status:'EPISODE_PLAN_AUTHORIZED'});}
   if(p.endsWith('/actions/produce_episode')){starts++;state={...state,review_revision:state.review_revision+1,episode_job:{id:'initial-job',status:'WAITING_PROVIDER'},review_policy:{id:'initial-choice',mode:'DRAFT_FINAL_REVIEW_V1'}};return json({operation:{id:'initial-job',status:'QUEUED'}});}
   throw Error('UNEXPECTED_MUTATION');
  }
  if(p==='/lumi/studio')return route.fulfill({contentType:'text/html',body:files['index.html'].replace('<script async src="https://telegram.org/js/telegram-web-app.js"></script>','')});
  if(p.endsWith('/style.css'))return route.fulfill({contentType:'text/css',body:files['style.css']});
  if(p.endsWith('/app.js'))return route.fulfill({contentType:'text/javascript',body:files['app.js'].replace('navigation();login();','window.fixtureUI={refresh,button};navigation();login();')});
  if(p.endsWith('/session'))return json({csrf:'fixture',expires_at:Date.now()+1800000});
  if(p.endsWith('/state')){reads++;return expired?json({error:'MINI_SESSION_EXPIRED'},401):json({...state,server_time:Date.now()});}
  if(p.endsWith('/plan/review'))return json({challenge:{contract:{title:state.episode.title,action_set:[],model:{},payload_constraints:{},per_action_limits:{},maximum_episode_exposure:8,total_reservation_maximum_usd:4,estimate_minimum_usd:4,estimate_probable_usd:5},consent_expires_at:new Date(Date.now()+86400000).toISOString()}});
  if(p.endsWith('/library/plan'))return json({suggestions:[]});
  if(p.endsWith('/library')){libraryReads++;if(libraryGate)await libraryGate;return json({assets:libraryAssets,counts:{},selections:[],version:1});}
  if(p.endsWith('/library/access/master'))return json({media:libraryAssets[0]});
  if(p.endsWith('/master/access')){accesses++;return json({url:'/lumi/studio/api/media/master?ticket=fresh',expires_at:Date.now()+300000});}
  if(p.endsWith('/media/master')){
   if(u.searchParams.has('variant'))return route.fulfill({contentType:'image/jpeg',headers:{'X-Content-SHA256':posterSha,'X-Original-SHA256':sha},body:poster});
   const headers={'Accept-Ranges':'bytes',...(u.searchParams.has('download')?{'Content-Disposition':'attachment; filename="Lumi-'+sha.slice(0,12)+'.mp4"'}:{})};
   const range=req.headers().range;
   if(range){ranges++;const [,start,end]=/^bytes=(\d+)-(\d*)$/.exec(range),a=Number(start),b=end?Number(end):bytes.length-1;return route.fulfill({status:206,contentType:'video/mp4',headers:{...headers,'Content-Range':`bytes ${a}-${b}/${bytes.length}`},body:bytes.subarray(a,b+1)});}
   return route.fulfill({contentType:'video/mp4',headers,body:bytes});
  }
  throw Error('UNEXPECTED_REQUEST '+p);
 };
 server=createServer(async(req,res)=>{const chunks=[];for await(const chunk of req)chunks.push(chunk);const raw=Buffer.concat(chunks).toString();handle({request:()=>({url:()=>base+req.url,method:()=>req.method,headers:()=>req.headers,postDataJSON:()=>JSON.parse(raw)}),fulfill:async({status=200,contentType,headers={},body=''})=>{res.writeHead(status,{'Content-Type':contentType,'Cache-Control':'no-store',...headers});res.end(body);}}).catch(e=>{errors.push(e.message);res.writeHead(500);res.end();});});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port;
 await context.route('**/*',route=>new URL(route.request().url()).origin===base?route.continue():route.abort());
 await page.goto(base+'/lumi/studio');await page.waitForSelector('.workflow-steps');
 assert.equal(await page.locator('.workflow-steps button').count(),4);
 assert.equal(await page.locator('[data-workflow=producir]').getAttribute('aria-current'),'step');
 assert.match(await page.locator('.daily-status').innerText(),/2 de 7 tomas listas/);
 assert.match(await page.locator('.budget-trio').innerText(),/Sin verificar/);
 assert.equal(await page.locator('.shot-tile').count(),7);
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 await page.screenshot({path:join(screens,'production.png'),fullPage:true});
 // A stable poll should not touch the visible DOM. Tickets remain fresh in memory.
 const mutations=await page.evaluate(async()=>{const changes=[];const observer=new MutationObserver(entries=>changes.push(...entries));observer.observe(document.querySelector('#app'),{subtree:true,childList:true,attributes:true,characterData:true});await fixtureUI.refresh();await Promise.resolve();observer.disconnect();return changes.length;});assert.equal(mutations,0);
 assert.deepEqual(await page.locator('.episode-progress').evaluate(p=>[p.value,p.max]),[2,7]);
 await page.evaluate(()=>scrollTo({top:600,behavior:'instant'}));const readingPosition=await page.evaluate(()=>scrollY);assert.ok(readingPosition>500);
 await page.locator('[data-tab=ajustes]').click();assert.equal(await page.evaluate(()=>scrollY),0);
 await page.locator('.bottom-nav [data-tab=inicio]').click();assert.ok(Math.abs(await page.evaluate(()=>scrollY)-readingPosition)<2);
 // The first library visit has an honest placeholder; quick returns reuse it.
 let releaseLibrary;libraryGate=new Promise(resolve=>releaseLibrary=resolve);
 await page.locator('[data-tab=biblioteca]').click();await page.waitForSelector('.loading-skeleton');
 await page.screenshot({path:join(screens,'library-loading.png'),fullPage:true});releaseLibrary();libraryGate=null;
 await page.waitForSelector('.empty h3');assert.equal(libraryReads,1);
 await page.locator('[data-tab=ajustes]').click();await page.locator('[data-tab=biblioteca]').click();assert.equal(libraryReads,1);
 await page.locator('[data-library-refresh]').click();await page.waitForFunction(()=>!document.querySelector('[data-library-refresh]').disabled);assert.equal(libraryReads,2);
 await page.emulateMedia({reducedMotion:'reduce'});assert.equal(await page.locator('.bottom-nav button').first().evaluate(n=>getComputedStyle(n).transitionDuration),'0s');
 await page.emulateMedia({reducedMotion:'no-preference'});await page.locator('.brand').click();assert.equal(await page.locator('.bottom-nav [data-tab=inicio]').getAttribute('aria-current'),'page');
 for(const width of [320,390,768]){await page.setViewportSize({width,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);}
 await page.setViewportSize({width:390,height:844});
 const beforeReads=reads;await page.locator('[data-action=refresh]').first().click();await page.waitForFunction(()=>document.querySelector('[data-progress-status]')?.textContent.includes('actualizado')).catch(async()=>{await page.evaluate(()=>fixtureUI.refresh());});assert.ok(reads>beforeReads);assert.equal(posts,0);
 await page.locator('[data-ui-key=mode-options]>summary').click();assert.equal(await page.locator('[data-action=job_pause]').isVisible(),true);assert.match(await page.evaluate(()=>fixtureUI.button('Generar','generate')),/disabled/);
 await page.reload();await page.waitForSelector('.daily-status');assert.match(await page.locator('.daily-status').innerText(),/2 de 7/);assert.equal(posts,0);
 // A real cost exception has one visible decision, with technical data collapsed.
 const producing=structuredClone(state);state={...state,review_revision:5,operation:{status:'BLOCKED'},episode_job:{id:'original-job',status:'NEEDS_ATTENTION',error:'Q41_REQUEST_RESERVATION_LIMIT_EXCEEDED'},current_action:{status:'BLOCKED',emission_locked:false,preflight_rejected:true,operations:[]},episode_plan_authorization:{status:'NEW_LIMIT_APPROVAL_REQUIRED',approval_available:true},continuity:{},quote:{economic_decision:{status:'BLOCKED',reason:'RESERVATION_MARGIN_OVER_AUTHORIZED_MAX',calculated_reservation_usd:.3475,authorized_max_usd:.345}},budget:{...state.budget,pending_reservations_usd:3.94125,source_operation_exposure_usd:.33875,reservations:[{amount_usd:3.6025}]}};
 await page.evaluate(()=>fixtureUI.refresh());assert.equal(await page.locator('[data-action=plan_review]').first().isEnabled(),true);assert.match(await page.locator('.budget-trio').innerText(),/3[,.]94125/);assert.doesNotMatch(await page.locator('#next-action').innerText(),/Q41_REQUEST/);
 await page.screenshot({path:join(screens,'budget-decision.png'),fullPage:true});state={...producing,review_revision:5};await page.evaluate(()=>fixtureUI.refresh());
 // A draft is viewable, but Download still waits for final approval.
 const media={id:'master',episode:'fixture-episode',role:'master',mime:'video/mp4',width:1080,height:1920,size:bytes.length,sha256:sha,url:'/lumi/studio/api/media/master?ticket=old',expires_at:Date.now()+300000};
 state={...state,review_revision:5,episode:{...state.episode,next_action:'master_review',checkpoint_version:56},operation:null,episode_job:{id:'original-job',status:'WAITING_HUMAN_REVIEW'},media:[media],reviews:[{id:'final-review',stage:'MASTER',media_id:'master',version:1,artifact_sha:sha}]};
 await page.evaluate(()=>fixtureUI.refresh());assert.equal(await page.locator('[data-workflow=revisar]').getAttribute('aria-current'),'step');assert.match(await page.locator('#next-action').innerText(),/episodio completo/);
 await page.locator('[data-workflow=descargar]').click();assert.equal(await page.locator('[data-download-media]').count(),0);
 // Fixture approval represents a persisted human decision, not a test POST.
 state={...state,review_revision:6,episode:{...state.episode,next_action:null,checkpoint_version:57},episode_job:{id:'original-job',status:'COMPLETE'},reviews:[],production:{...state.production,shots:state.production.shots.map(s=>({...s,complete:true,current:false}))}};
 await page.evaluate(()=>fixtureUI.refresh());await page.waitForSelector('video');
 await page.waitForFunction(()=>document.querySelector('video').readyState>=2);
 assert.deepEqual(await page.locator('video').evaluate(v=>[v.videoWidth,v.videoHeight,v.playsInline]),[1080,1920,true]);
 await page.locator('video').evaluate(v=>v.play());await page.waitForFunction(()=>document.querySelector('video').currentTime>.2);
 const playbackTime=await page.locator('video').evaluate(v=>v.currentTime);await page.evaluate(()=>fixtureUI.refresh());assert.ok(await page.locator('video').evaluate(v=>v.currentTime)>=playbackTime);
 const downloadPromise=page.waitForEvent('download');await page.locator('[data-download-media]').click();const download=await downloadPromise;
 assert.equal(download.suggestedFilename(),'Lumi-'+sha.slice(0,12)+'.mp4');assert.equal(createHash('sha256').update(await readFile(await download.path())).digest('hex'),sha);assert.equal(accesses,1);
 await page.screenshot({path:join(screens,'download.png'),fullPage:true});
 libraryAssets=[{asset_id:'master',asset_type:'MASTER',source_episode_id:state.episode.id,display_name:'Lumi descubre la granja',description:'Master aprobado',continuity_tags:[],reusable:true,version:1,media_type:'video/mp4',dimensions:{width:1080,height:1920},reuse_policy:{modes:[]},approval_reference:{scope:'ORIGINAL',source:'fixture'},sha256:sha,media_url:media.url,expires_at:Date.now()+300000}];
 await page.locator('[data-tab=biblioteca]').click();await page.locator('[data-library-refresh]').click();await page.waitForFunction(()=>!document.querySelector('[data-library-refresh]').disabled);
 await page.locator('[data-library-category=Masters]').click();await page.locator('[data-library-view=master]').click();await page.waitForFunction(()=>document.querySelector('[data-library-preview] video')?.readyState>=1);
 assert.equal(await page.locator('[data-library-preview]').getAttribute('data-preview-state'),'READY');assert.equal(await page.locator('[data-library-preview] [role=status]').count(),0);
 expired=true;await page.evaluate(()=>fixtureUI.refresh());assert.match(await page.locator('#app').innerText(),/bot de Telegram/);assert.equal(posts,0);assert.equal(errors.length,0,errors.join(';'));
 expired=false;allowStart=true;state={...state,review_revision:10,episode:{...state.episode,next_action:'video:q41',checkpoint_version:1},episode_job:null,operation:null,current_action:{status:'NOT_STARTED',operations:[]},review_policy:{mode:'SUPERVISED'},episode_plan_authorization:{status:'HUMAN_APPROVAL_REQUIRED',approval_available:true},media:[],production:{...state.production,shots:state.production.shots.map(s=>({...s,complete:false,current:s.number===1}))}};
 await page.reload();await page.locator('[data-action=plan_review]').first().click();await page.waitForFunction(()=>document.querySelector('#confirmation').open);
 await page.locator('#dialog-confirm').click();assert.equal(posts,0);assert.equal(await page.locator('#confirmation').evaluate(d=>d.open),true);
 await page.selectOption('#initial-review-mode','DRAFT_FINAL_REVIEW_V1');await page.evaluate(()=>{for(let n=0;n<10;n++)document.querySelector('#dialog-confirm').click();});
 await page.waitForFunction(()=>document.querySelector('.daily-status')?.textContent.includes('Borrador automático'));assert.equal(planAccepts,1);assert.equal(starts,1);assert.equal(posts,2);
 assert.equal(errors.length,0,errors.join(';'));
 console.log('PASS_DAILY_WORKFLOW_BROWSER '+JSON.stringify({stages:4,completed_shots:7,unchanged_poll_dom_mutations:mutations,scroll_restored:true,library_cached_navigation:true,explicit_library_refresh:true,reduced_motion:true,mobile_overflow:false,settings_while_pending:true,read_only_refresh:true,reopen:true,final_review_gate:true,vertical_full_hd:true,aac_fixture:true,played:true,ranges,download_sha:sha,session_expiry:true,initial_mode_explicit:true,planAccepts,starts,posts}));
 await context.close();
}finally{await browser?.close();await new Promise(resolve=>server?server.close(resolve):resolve());await rm(dir,{recursive:true,force:true});}
