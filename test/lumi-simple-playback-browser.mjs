// Real Studio DOM + mounted publication handlers + CAS store. Synthetic identity,
// production projection and master only. External traffic is forbidden.
import {chromium} from 'playwright';
import express from 'express';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {sendPrivateMedia} from '../lib/telegram-mini-app/private-media.js';
import {EditorMedia,digest} from '../lib/telegram-mini-app/editor-media.js';
import {EditorStore,mountEditor} from '../lib/telegram-mini-app/editor-store.js';
import {ResultsStore,mountResults,romeRange,normalizePosts,FIELDS} from '../lib/telegram-mini-app/results.js';
import {readFile,mkdir,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {createHmac} from 'node:crypto';
import assert from 'node:assert/strict';
import {MemoryReviewStore} from '../lib/telegram-review-v1/core.js';
import {MiniAppAuth} from '../lib/telegram-mini-app/auth.js';
import {mountPublication,publicationPackage} from '../lib/telegram-mini-app/publication-store.js';
import {metricoolView} from '../lib/telegram-mini-app/metricool.js';
const env={LUMI_RUNTIME_ENV:'staging',SUPABASE_URL:'https://mofjhwathxzfnjapvvst.supabase.co',LUMI_TELEGRAM_BOT_TOKEN:'1:OFFLINE_ONLY'};
globalThis.fetch=async()=>{throw Error('EXTERNAL_FETCH_BLOCKED');};
const exec=promisify(execFile),dir=await mkdtemp(join(tmpdir(),'lumi-visual-browser-'));
await exec('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=s=90x160:r=24:d=5','-an','-c:v','libx264','-threads','1','-y',join(dir,'clip.mp4')]);
await exec('ffmpeg',['-v','error','-f','lavfi','-i','sine=frequency=1000:sample_rate=48000:duration=0.5','-c:a','libmp3lame','-y',join(dir,'voice.mp3')]);
await exec('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=s=90x160:r=24:d=5','-vf','hue=h=90','-an','-c:v','libx264','-threads','1','-y',join(dir,'clip2.mp4')]);
const vb=await readFile(process.env.LUMI_EXISTING_SOURCE_ROOT?join(process.env.LUMI_EXISTING_SOURCE_ROOT,'q31-PRO2.mp4'):join(dir,'clip.mp4')),vb2=await readFile(process.env.LUMI_EXISTING_SOURCE_ROOT?join(process.env.LUMI_EXISTING_SOURCE_ROOT,'q32-V2-PRO1.mp4'):join(dir,'clip2.mp4')),ab=await readFile(process.env.LUMI_EXISTING_VOICE||join(dir,'voice.mp3')),videoArtifact={artifact_id:'video',sha256:digest(vb),size:vb.length,bucket:'private-fixture',path:'clip.mp4',mime:'video/mp4'},audioArtifact={artifact_id:'audio',sha256:digest(ab),size:ab.length,bucket:'private-fixture',path:'voice.mp3',mime:'audio/mpeg'};
const videoArtifact2={...videoArtifact,artifact_id:'second',sha256:digest(vb2),size:vb2.length,path:'clip2.mp4'};
if(process.env.LUMI_EXISTING_SOURCE_ROOT){assert.equal(digest(vb),'ea5a54493bf1ccf037ac5acac2d81668c0d9f7c0239d81479dfa7968c7ee0307');assert.equal(digest(vb2),'0e94f3667d2abebe913ac020a01ececf9c9b46869a0ebdc19cb7eeef23dad313');}
const store=new MemoryReviewStore();await store.create('1',{user_id:'1',chat_id:'1',message_id:1,episodes:{fixture:{episode_id:'fixture',title:'Lumi y los animales de la granja',shots:[{shot_id:'q1',artifact:videoArtifact},{shot_id:'q2',artifact:videoArtifact2}],artifacts:{audio:audioArtifact},master:{...videoArtifact,artifact_id:'published-fixture-v1'}},fixture2:{episode_id:'fixture2',title:'Lumi y las tres flores de colores'}}});
const auth=new MiniAppAuth({store,env,validateOwner:async()=>true});
const params=new URLSearchParams({auth_date:String(Math.floor(Date.now()/1000)),user:'{"id":1}',query_id:'browser-fixture'});
params.set('hash',createHmac('sha256',createHmac('sha256','WebAppData').update(env.LUMI_TELEGRAM_BOT_TOKEN).digest()).update([...params].sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>k+'='+v).join('\n')).digest('hex'));
const session=await auth.login(params.toString()),app=express();app.use(express.json());
let base,expired=false,loseSave=false;const errors=[];
const principal=req=>{if(expired)throw Object.assign(Error('MINI_SESSION_EXPIRED'),{status:401});return auth.authenticate(req.headers.cookie?.split('fixture=')[1]?.split(';')[0],req.method==='POST'?req.headers['x-lumi-csrf']||'':null);};
const wrap=fn=>async(req,res)=>{try{await fn(req,res);}catch(e){res.status(e.status||409).json({error:e.message});}};
const requests=[];let resultsDelay=0;app.use(async(req,res,next)=>{requests.push({path:req.path,method:req.method});if(req.path==='/lumi/studio/api/results'&&resultsDelay)await new Promise(r=>setTimeout(r,resultsDelay));next();});
app.use((req,res,next)=>{res.set('Cache-Control','no-store');if(req.method==='POST'&&req.headers.origin!==base)return res.sendStatus(403);
 if(loseSave&&req.path.startsWith('/lumi/studio/api/editor/projects/')&&req.body?.edit){loseSave=false;const original=res.json.bind(res);res.json=()=>{res.status(504);return original({error:'FIXTURE_LOST_ACK'});};}next();});
mountPublication(app,{api:'/lumi/studio/api',principal,wrap,store,env,validateOwner:async()=>true,fetchImpl:async()=>{throw Error('EXTERNAL_FORBIDDEN');}});
const transfers=[];const objects=new Map(),storage={download:async(b,p)=>objects.get(b+':'+p)||null,upload:async(b,p,value)=>{if(objects.has(b+':'+p))throw Error('EXISTS');objects.set(b+':'+p,value);}};
let holdSecond=false,releaseSecond,secondWaiting;const gate=new Promise(r=>releaseSecond=r);const waiting=new Promise(r=>secondWaiting=r);
storage.openRead=async(b,p,{range}={})=>{if(holdSecond&&p.includes(videoArtifact2.sha256)&&p.endsWith('proxy.mp4')){secondWaiting();await gate;}const bytes=objects.get(b+':'+p),match=/bytes=(\d+)-(\d+)/.exec(range||''),start=match?Number(match[1]):0,end=match?Number(match[2]):bytes.length-1,part=bytes.subarray(start,end+1);transfers.push({file:p.split('/').at(-1),bytes:part.length,total:bytes.length,range:range||null});return new Response(part,{status:match?206:200,headers:{'content-length':String(part.length),...(match?{'content-range':`bytes ${start}-${end}/${bytes.length}`}:{})}});};
const media=new EditorMedia({storage,loadBytes:async a=>a.sha256===videoArtifact.sha256?vb:a.sha256===videoArtifact2.sha256?vb2:ab,privateBucket:async()=>true});
objects.set('private-fixture:clip.mp4',vb);
app.get('/lumi/studio/api/media/fixture-media/access',wrap(async(req,res)=>{await principal(req);res.json({url:base+'/fixture-original',expires_at:Date.now()+300000});}));
app.get('/fixture-original',wrap(async(req,res)=>{await principal(req);let a=videoArtifact;if(req.query.variant){a=await media.descriptor('1',videoArtifact,'poster.jpg',imported.id);if(!a)return res.status(202).json({status:'PREPARING'});}await sendPrivateMedia(req,res,storage,a);}));
const editor=new EditorStore({store,media,manager:{store:{getEpisode:async()=>null}},validateOwner:async()=>true});
mountEditor(app,{api:'/lumi/studio/api',principal,wrap,editor});
const results=new ResultsStore({store,connection:{owner:async u=>store.get(u)},validateOwner:async()=>true});
mountResults(app,{api:'/lumi/studio/api',principal,wrap,results});
const drain=setInterval(()=>editor.processPending('1'),300);
async function view(){const s=(await store.get('1')).state;return {client_scope:'fixture-owner',client_session:'fixture-session',server_time:Date.now(),review_revision:1,episode:{id:'fixture',title:s.episodes.fixture.title,next_action:'image:q47',checkpoint_version:1,actions:[]},episodes:Object.entries(s.episodes).map(([id,e])=>({id,title:e.title,publication:publicationPackage(s,id)})),
 episode_job:{id:'fixture-job',status:'NEEDS_ATTENTION'},review_policy:{mode:'SUPERVISED'},episode_plan_authorization:{status:'PENDING'},current_action:{status:'BLOCKED',operations:[]},production:{shots:[]},media:[{id:'fixture-media',episode:'fixture',role:'master',mime:'video/mp4',label:'Video existente',sha256:videoArtifact.sha256,url:base+'/fixture-original',expires_at:Date.now()+300000}],reviews:[],review_receipts:[],action_receipts:[],capabilities:{},budget:{ceiling_usd:8,actual_cost_usd:null,exposure_usd:4,remaining_usd:4,reservations:[]},settings:{publication_connection:metricoolView(s.mini_app)}};}
app.get('/lumi/studio/api/session',wrap(async(req,res)=>{await principal(req);res.json({csrf:session.csrf,expires_at:Date.now()+1800000,...(req.query.state?{state:await view()}: {})});}));
app.get('/lumi/studio/api/state',wrap(async(req,res)=>{await principal(req);res.json(await view());}));
app.get('/lumi/studio/api/library',(_req,res)=>res.json({assets:[],counts:{},selections:[],version:1}));
app.get('/lumi/studio/api/library/plan',(_req,res)=>res.json({suggestions:[]}));
for(const file of ['index.html','app.js','style.css','publication-ui.js','preparation-ui.js','editor-ui.js','editor-model.js','results-ui.js','secondary-ui.js'])app.get(file==='index.html'?'/lumi/studio':'/lumi/studio/'+file,async(_req,res)=>res.type(file.endsWith('.js')?'js':file.endsWith('.css')?'css':'html').send((await readFile(new URL('../public/lumi-studio/'+file,import.meta.url),'utf8')).replace('<script async src="https://telegram.org/js/telegram-web-app.js"></script>','')));
const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));base='http://127.0.0.1:'+server.address().port;
const sourceStats={video_bytes:vb.length,audio_bytes:ab.length};let browser;const evidence={environment:'Browser version pending launch; Linux, 390x844 touch viewport; isolated owner/store; real handlers/FFmpeg; NOT_IPHONE',external_requests:0};

const out='/tmp/lumi-simple-evidence';await mkdir(out,{recursive:true});
const principalFixture=await auth.authenticate(session.cookie,session.csrf),imported=await editor.import(principalFixture,{episode_id:'fixture',command_id:'playback'});await editor.processPending('1');
const project=await editor.get(principalFixture,imported.id),{instance,clone,normalize}=await import('../public/lumi-studio/editor-model.js'),edit=clone(project.revision.edit);
for(const c of edit.clips.filter(c=>c.track==='video'))c.source_out=144000;
const sourceAudio=Object.values(project.sources).find(s=>s.audio&&!s.video),voice=instance(sourceAudio,'voice',28800,'voice');voice.source_out=Math.min(voice.source_out,24000);voice.gain_mdb=-3000;voice.cut_reason='Isolated preview timing check';voice.speech_reviewed=true;edit.clips.push(voice);
await editor.save(principalFixture,project.id,{base_revision:project.current,command_id:'seed',edit:normalize(edit),fork:false});
try{
 browser=await chromium.launch({headless:true,executablePath:process.env.LUMI_TEST_BROWSER||undefined,args:['--no-sandbox','--disable-gpu']});
 const context=await browser.newContext({viewport:{width:390,height:844},hasTouch:true});await context.addCookies([{name:'fixture',value:session.cookie,url:base}]);await context.route('**/*',r=>{if(new URL(r.request().url()).origin===base)return r.continue();evidence.external_requests++;return r.abort();});
 const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.addInitScript(()=>{window.measures=[];window.contexts=[];document.addEventListener('lumi-media-measure',e=>window.measures.push(e.detail));const AC=window.AudioContext;window.AudioContext=class extends AC{constructor(...args){super(...args);window.contexts.push(this);}};});
 const cdp=await context.newCDPSession(page);await cdp.send('Performance.enable');await cdp.send('Network.enable');
 const open=async()=>{await page.goto(base+'/lumi/studio');await page.locator('#navigation [data-tab=produccion]').click();await page.locator('[data-open-editor]').click();await page.locator('[data-lane=voice]').waitFor();await page.waitForFunction(()=>document.querySelector('[data-editor-stage] video')?.readyState>=2);};
 const current=()=>page.evaluate(()=>({at:Number(document.querySelector('[data-editor-seek]').value)/48000,video:document.querySelector('[data-editor-stage] video').currentTime,audio:window.contexts.at(-1)?.currentTime,audioState:window.contexts.at(-1)?.state,paused:document.querySelector('[data-editor-stage] video').paused,label:document.querySelector('[data-playback-status]').textContent}));
 const start=performance.now();await open();evidence.cold_open_to_frame_ms=Math.round(performance.now()-start);evidence.initial_transfers=transfers.slice();assert.equal(transfers.filter(t=>t.file==='proxy.mp4').length,1);
 // Initial/middle/end seeks use the real media element, not a mocked clock.
 evidence.seeks=[];for(const at of [.1,1.5,2.9]){const began=performance.now();await page.locator('[data-editor-seek]').evaluate((e,at)=>{e.value=at*48000;e.dispatchEvent(new Event('input',{bubbles:true}));},at);await page.waitForFunction(at=>Math.abs(document.querySelector('[data-editor-stage] video').currentTime-at)<.06&&!document.querySelector('[data-editor-stage] video').seeking,at);evidence.seeks.push({at,ms:Math.round(performance.now()-began)});}
 await page.locator('[data-editor-seek]').evaluate(e=>{e.value=0;e.dispatchEvent(new Event('input',{bubbles:true}));});await page.waitForFunction(()=>document.querySelector('[data-editor-stage] video').currentTime<.1);
 holdSecond=true;await page.locator('[data-edit-action=play]').click();await waiting;await page.waitForFunction(()=>window.contexts.at(-1)?.state==='suspended');const paused=await current();await page.screenshot({path:join(out,'buffering.png'),fullPage:true});await page.waitForTimeout(500);const held=await current();assert.ok(Math.abs(held.audio-paused.audio)<.02,'audio clock holds with video');assert.ok(held.at>=3&&held.at<3.3,'transition preserves position');releaseSecond();await page.waitForFunction(()=>Number(document.querySelector('[data-editor-seek]').value)>3.6*48000);const resumed=await current();assert.equal(resumed.paused,false);evidence.transition={held_ms:500,paused,held,resumed,automatic_same_playback:true};await page.locator('[data-edit-action=play]').click();
 // End of second clip, then exact middle of first.
 for(const at of [5.85,1.2]){await page.locator('[data-editor-seek]').evaluate((e,at)=>{e.value=at*48000;e.dispatchEvent(new Event('input',{bubbles:true}));},at);await page.waitForTimeout(250);const value=await current();assert.ok(Math.abs(value.video-(at>3?at-3:at))<.1);}
 // Browser's background event preserves position and requires a new user gesture.
 await page.locator('[data-edit-action=play]').click();await page.waitForTimeout(250);await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));});const background=await current();assert.equal(background.paused,true);await page.evaluate(()=>{delete document.hidden;document.dispatchEvent(new Event('visibilitychange'));});await page.locator('[data-edit-action=play]').click();await page.waitForTimeout(250);const foreground=await current();assert.ok(foreground.at>background.at);await page.locator('[data-edit-action=play]').click();evidence.background={simulation:'visibilitychange in Chromium, not iOS lifecycle',background,foreground};
 // A media access failure is a read failure; retry reloads the same private source.
 let deny=true;await page.route('**/proxy.mp4',r=>deny?r.fulfill({status:401,contentType:'application/json',body:'{"error":"MINI_SESSION_EXPIRED"}'}):r.continue());
 await page.locator('[data-edit-action=back]').click();await page.locator('[data-open-editor]').click();await page.locator('[data-edit-action=retry]').waitFor({state:'visible'});const failedAt=(await current()).at;await page.screenshot({path:join(out,'acceso-media-vencido.png'),fullPage:true});deny=false;
 await cdp.send('Network.emulateNetworkConditions',{offline:false,latency:200,downloadThroughput:128*1024,uploadThroughput:64*1024});const retryAt=performance.now();await page.locator('[data-edit-action=retry]').click();await page.waitForFunction(()=>!document.querySelector('[data-editor-stage] video').paused);const retry=await current();assert.ok(retry.at>=failedAt-.1);evidence.slow_retry={latency_ms:200,bytes_per_second:131072,ms:Math.round(performance.now()-retryAt),retained_position:failedAt,resumed_position:retry.at};await page.locator('[data-edit-action=play]').click();await cdp.send('Network.emulateNetworkConditions',{offline:false,latency:0,downloadThroughput:-1,uploadThroughput:-1});
 // Disconnection before a current read, then reconnect and explicit same-position retry.
 await page.locator('[data-edit-action=back]').click();await context.setOffline(true);await page.locator('[data-open-editor]').click();await page.locator('[data-edit-action=retry]').waitFor({state:'visible'});const offlineAt=(await current()).at;await context.setOffline(false);await page.locator('[data-edit-action=retry]').click();await page.waitForFunction(()=>!document.querySelector('[data-editor-stage] video').paused);assert.ok((await current()).at>=offlineAt-.1);await page.locator('[data-edit-action=play]').click();
 // Biblioteca uses its real native-player handler with an authenticated stream.
 await page.locator('[data-edit-action=back]').click();await page.locator('#navigation [data-tab=biblioteca]').click();await page.locator('[data-open-media]').first().click();const native=page.locator('[data-native-media]');await native.click();await native.evaluate(m=>m.play());await page.waitForTimeout(250);await native.evaluate(m=>m.pause());const nativeAt=await native.evaluate(m=>m.currentTime);let nativeDenied=true;await page.route('**/fixture-original*',r=>nativeDenied?r.fulfill({status:401,body:'expired'}):r.continue());await native.evaluate(m=>{m.src+='?expired=1';m.load();});await page.getByRole('button',{name:'Reintentar reproducción',exact:true}).waitFor();nativeDenied=false;await page.getByRole('button',{name:'Reintentar reproducción',exact:true}).click();await page.waitForFunction(()=>{const m=document.querySelector('[data-native-media]');return m&&m.readyState>=2&&!m.paused;});assert.ok(await native.evaluate(m=>m.currentTime)>=nativeAt-.1);evidence.library_native_retry={retained_position:nativeAt,restored_position:await native.evaluate(m=>m.currentTime)};await native.evaluate(m=>m.pause());
 assert.equal(errors.length,0,errors.join(' | '));assert.equal(evidence.external_requests,0);assert.equal(requests.filter(r=>r.method==='POST').length,0);
 evidence.environment='Chromium '+browser.version()+', Linux touch viewport, loopback; real handlers and verified '+(process.env.LUMI_EXISTING_SOURCE_ROOT?'existing':'synthetic')+' sources; NOT_IPHONE';evidence.phases=await page.evaluate(()=>window.measures);evidence.transfers=transfers;evidence.requests=requests.length;evidence.memory=(await cdp.send('Performance.getMetrics')).metrics.filter(m=>['JSHeapUsedSize','JSHeapTotalSize','Nodes','Documents'].includes(m.name));evidence.pass=true;await writeFile(join(out,'playback.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence));
}finally{clearInterval(drain);await browser?.close();server.closeAllConnections?.();await new Promise(r=>server.close(r));}
