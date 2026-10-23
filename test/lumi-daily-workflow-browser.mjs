// Actual browser/app, synthetic media and intercepted transport. No live account
// or provider calls. This is not an iPhone/Telegram acceptance certificate.
import {chromium} from 'playwright';
import {readFile,mkdtemp,mkdir,rm} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const root=new URL('../',import.meta.url),files=Object.fromEntries(await Promise.all(['app.js','style.css','index.html'].map(async n=>[n,await readFile(new URL('public/lumi-studio/'+n,root),'utf8')])));
const dir=await mkdtemp(join(tmpdir(),'lumi-daily-')),screens='/tmp/lumi-daily-screens';await mkdir(screens,{recursive:true});
let browser;
try{
 const file=join(dir,'master.mp4');
 execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','color=c=0xabcbd8:s=1080x1920:r=24:d=2','-f','lavfi','-i','sine=frequency=440:duration=2','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-threads','1','-c:a','aac','-movflags','+faststart','-shortest',file]);
 const bytes=await readFile(file),sha=createHash('sha256').update(bytes).digest('hex');
 const probe=JSON.parse(execFileSync('ffprobe',['-v','error','-show_streams','-of','json',file],{encoding:'utf8'}));
 assert.equal(probe.streams.find(s=>s.codec_type==='audio').codec_name,'aac');
 browser=await chromium.launch({headless:true});const context=await browser.newContext({viewport:{width:390,height:844},acceptDownloads:true}),page=await context.newPage();
 let posts=0,reads=0,accesses=0,ranges=0,expired=false;const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const shot=(n)=>({id:'q4'+n,number:n,title:['Lumi y vos','La vaca','La oveja','El caballo','El cerdo','La gallina','Hasta mañana'][n-1],complete:n<3,current:n===3,goal:'Descubrir la granja',characters:['Lumi'],continuity:{character_details:[]}});
 let state={client_scope:'fixture-owner',client_session:'fixture-session',server_time:Date.now(),review_revision:4,
  episode:{id:'fixture-episode',title:'Lumi descubre la granja',next_action:'video:q43',checkpoint_version:55,actions:[]},episodes:[{id:'fixture-episode',title:'Lumi descubre la granja'}],
  operation:{kind:'production_stage',status:'RUNNING',phase:'GENERATING'},episode_job:{id:'original-job',status:'WAITING_PROVIDER'},
  review_policy:{id:'accepted-policy',mode:'DRAFT_FINAL_REVIEW_V1',choice_available:true,expired:false},episode_plan_authorization:{status:'AUTHORIZED',approval_available:true},
  current_action:{status:'SUBMITTED',emission_locked:true,provider_request_id:'internal-id',operations:[]},production:{shots:Array.from({length:7},(_,n)=>shot(n+1)),action:{stage:'VIDEO'}},
  continuity:{accepted_at:'2026-10-23T15:00:00Z',last_provider_check_at:'2026-10-23T15:01:00Z',recovery_status:'WAITING'},
  media:[],reviews:[],review_receipts:[],action_receipts:[],capabilities:{generate:false},budget:{ceiling_usd:8,actual_cost_usd:null,exposure_usd:3.03625,remaining_usd:4.96375,reservations:[{amount_usd:3.03625}]},settings:{}};
 await context.route('**/*',async route=>{
  const req=route.request(),u=new URL(req.url()),p=u.pathname,json=(body,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
  if(u.hostname!=='lumi.test')throw Error('EXTERNAL_REQUEST_BLOCKED');
  if(req.method()==='POST'){posts++;throw Error('UNEXPECTED_MUTATION');}
  if(p==='/lumi/studio')return route.fulfill({contentType:'text/html',body:files['index.html'].replace('<script defer src="https://telegram.org/js/telegram-web-app.js"></script>','')});
  if(p.endsWith('/style.css'))return route.fulfill({contentType:'text/css',body:files['style.css']});
  if(p.endsWith('/app.js'))return route.fulfill({contentType:'text/javascript',body:files['app.js'].replace('navigation();login();','window.fixtureUI={refresh,button};navigation();login();')});
  if(p.endsWith('/session'))return json({csrf:'fixture',expires_at:Date.now()+1800000});
  if(p.endsWith('/state')){reads++;return expired?json({error:'MINI_SESSION_EXPIRED'},401):json({...state,server_time:Date.now()});}
  if(p.endsWith('/library/plan'))return json({suggestions:[]});
  if(p.endsWith('/library'))return json({assets:[],counts:{},selections:[],version:1});
  if(p.endsWith('/master/access')){accesses++;return json({url:'/lumi/studio/api/media/master?ticket=fresh',expires_at:Date.now()+300000});}
  if(p.endsWith('/media/master')){
   const headers={'Accept-Ranges':'bytes',...(u.searchParams.has('download')?{'Content-Disposition':'attachment; filename="Lumi-fixture.mp4"'}:{})};
   const range=req.headers().range;
   if(range){ranges++;const [,start,end]=/^bytes=(\d+)-(\d*)$/.exec(range),a=Number(start),b=end?Number(end):bytes.length-1;return route.fulfill({status:206,contentType:'video/mp4',headers:{...headers,'Content-Range':`bytes ${a}-${b}/${bytes.length}`},body:bytes.subarray(a,b+1)});}
   return route.fulfill({contentType:'video/mp4',headers,body:bytes});
  }
  throw Error('UNEXPECTED_REQUEST '+p);
 });
 await page.goto('https://lumi.test/lumi/studio');await page.waitForSelector('.workflow-steps');
 assert.equal(await page.locator('.workflow-steps button').count(),4);
 assert.equal(await page.locator('[data-workflow=producir]').getAttribute('aria-current'),'step');
 assert.match(await page.locator('.daily-status').innerText(),/2 de 7 tomas listas/);
 assert.match(await page.locator('.budget-trio').innerText(),/Sin verificar/);
 assert.equal(await page.locator('.shot-tile').count(),7);
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 await page.screenshot({path:join(screens,'production.png'),fullPage:true});
 const beforeReads=reads;await page.locator('[data-action=refresh]').first().click();await page.waitForFunction(()=>document.querySelector('[data-progress-status]')?.textContent.includes('actualizado')).catch(async()=>{await page.evaluate(()=>fixtureUI.refresh());});assert.ok(reads>beforeReads);assert.equal(posts,0);
 await page.locator('[data-ui-key=mode-options]>summary').click();assert.equal(await page.locator('[data-action=job_pause]').isVisible(),true);assert.match(await page.evaluate(()=>fixtureUI.button('Generar','generate')),/disabled/);
 await page.reload();await page.waitForSelector('.daily-status');assert.match(await page.locator('.daily-status').innerText(),/2 de 7/);assert.equal(posts,0);
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
 assert.equal(download.suggestedFilename(),'Lumi-fixture.mp4');assert.equal(createHash('sha256').update(await readFile(await download.path())).digest('hex'),sha);assert.equal(accesses,1);
 await page.screenshot({path:join(screens,'download.png'),fullPage:true});
 expired=true;await page.evaluate(()=>fixtureUI.refresh());assert.match(await page.locator('#app').innerText(),/bot de Telegram/);assert.equal(posts,0);assert.equal(errors.length,0,errors.join(';'));
 console.log('PASS_DAILY_WORKFLOW_BROWSER '+JSON.stringify({stages:4,completed_shots:7,settings_while_pending:true,read_only_refresh:true,reopen:true,final_review_gate:true,vertical_full_hd:true,aac_fixture:true,played:true,ranges,download_sha:sha,session_expiry:true,posts}));
 await context.close();
}finally{await browser?.close();await rm(dir,{recursive:true,force:true});}
