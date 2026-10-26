// Real Studio DOM + mounted publication handlers + CAS store. Synthetic identity,
// production projection and master only. External traffic is forbidden.
import {chromium} from 'playwright';
import express from 'express';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
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
const vb=await readFile(join(dir,'clip.mp4')),ab=await readFile(join(dir,'voice.mp3')),videoArtifact={artifact_id:'video',sha256:digest(vb),size:vb.length,bucket:'private-fixture',path:'clip.mp4',mime:'video/mp4'},audioArtifact={artifact_id:'audio',sha256:digest(ab),size:ab.length,bucket:'private-fixture',path:'voice.mp3',mime:'audio/mpeg'};
const store=new MemoryReviewStore();await store.create('1',{user_id:'1',chat_id:'1',message_id:1,episodes:{fixture:{episode_id:'fixture',title:'Lumi y los animales de la granja',shots:[{shot_id:'q1',artifact:videoArtifact}],artifacts:{audio:audioArtifact},master:{...videoArtifact,artifact_id:'published-fixture-v1'}},fixture2:{episode_id:'fixture2',title:'Lumi y las tres flores de colores'}}});
const auth=new MiniAppAuth({store,env,validateOwner:async()=>true});
const params=new URLSearchParams({auth_date:String(Math.floor(Date.now()/1000)),user:'{"id":1}',query_id:'browser-fixture'});
params.set('hash',createHmac('sha256',createHmac('sha256','WebAppData').update(env.LUMI_TELEGRAM_BOT_TOKEN).digest()).update([...params].sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>k+'='+v).join('\n')).digest('hex'));
const session=await auth.login(params.toString()),app=express();app.use(express.json());
let base,expired=false,loseSave=false;const errors=[];
const principal=req=>{if(expired)throw Object.assign(Error('MINI_SESSION_EXPIRED'),{status:401});return auth.authenticate(req.headers.cookie?.split('fixture=')[1]?.split(';')[0],req.method==='POST'?req.headers['x-lumi-csrf']||'':null);};
const wrap=fn=>async(req,res)=>{try{await fn(req,res);}catch(e){res.status(e.status||409).json({error:e.message});}};
app.use((req,res,next)=>{res.set('Cache-Control','no-store');if(req.method==='POST'&&req.headers.origin!==base)return res.sendStatus(403);
 if(loseSave&&req.path.startsWith('/lumi/studio/api/editor/projects/')&&req.body?.edit){loseSave=false;const original=res.json.bind(res);res.json=()=>{res.status(504);return original({error:'FIXTURE_LOST_ACK'});};}next();});
mountPublication(app,{api:'/lumi/studio/api',principal,wrap,store,env,validateOwner:async()=>true,fetchImpl:async()=>{throw Error('EXTERNAL_FORBIDDEN');}});
const objects=new Map(),storage={download:async(b,p)=>objects.get(b+':'+p)||null,upload:async(b,p,value)=>{if(objects.has(b+':'+p))throw Error('EXISTS');objects.set(b+':'+p,value);}};
const media=new EditorMedia({storage,loadBytes:async a=>a.sha256===videoArtifact.sha256?vb:ab,privateBucket:async()=>true});
const editor=new EditorStore({store,media,manager:{store:{getEpisode:async()=>null}},validateOwner:async()=>true});
mountEditor(app,{api:'/lumi/studio/api',principal,wrap,editor});
const results=new ResultsStore({store,connection:{owner:async u=>store.get(u)},validateOwner:async()=>true});
mountResults(app,{api:'/lumi/studio/api',principal,wrap,results});
const drain=setInterval(()=>editor.processPending('1'),300);
async function view(){const s=(await store.get('1')).state;return {client_scope:'fixture-owner',client_session:'fixture-session',server_time:Date.now(),review_revision:1,episode:{id:'fixture',title:s.episodes.fixture.title,next_action:'image:q47',checkpoint_version:1,actions:[]},episodes:Object.entries(s.episodes).map(([id,e])=>({id,title:e.title,publication:publicationPackage(s,id)})),
 episode_job:{id:'fixture-job',status:'NEEDS_ATTENTION'},review_policy:{mode:'SUPERVISED'},episode_plan_authorization:{status:'PENDING'},current_action:{status:'BLOCKED',operations:[]},production:{shots:[]},media:[],reviews:[],review_receipts:[],action_receipts:[],capabilities:{},budget:{ceiling_usd:8,actual_cost_usd:null,exposure_usd:4,remaining_usd:4,reservations:[]},settings:{publication_connection:metricoolView(s.mini_app)}};}
app.get('/lumi/studio/api/session',wrap(async(req,res)=>{await principal(req);res.json({csrf:session.csrf,expires_at:Date.now()+1800000,...(req.query.state?{state:await view()}: {})});}));
app.get('/lumi/studio/api/state',wrap(async(req,res)=>{await principal(req);res.json(await view());}));
app.get('/lumi/studio/api/library',(_req,res)=>res.json({assets:[],counts:{},selections:[],version:1}));
app.get('/lumi/studio/api/library/plan',(_req,res)=>res.json({suggestions:[]}));
for(const file of ['index.html','app.js','style.css','publication-ui.js','preparation-ui.js','editor-ui.js','editor-model.js','results-ui.js'])app.get(file==='index.html'?'/lumi/studio':'/lumi/studio/'+file,async(_req,res)=>res.type(file.endsWith('.js')?'js':file.endsWith('.css')?'css':'html').send((await readFile(new URL('../public/lumi-studio/'+file,import.meta.url),'utf8')).replace('<script async src="https://telegram.org/js/telegram-web-app.js"></script>','')));
const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));base='http://127.0.0.1:'+server.address().port;
let browser;const evidence={environment:'Browser version pending launch; Linux, 390x844 touch viewport; isolated owner/store; real handlers/FFmpeg; NOT_IPHONE',external_requests:0};
try{
 browser=await chromium.launch({headless:true,executablePath:process.env.LUMI_TEST_BROWSER||undefined,args:['--no-sandbox','--disable-gpu']});
 evidence.environment='Chromium '+browser.version()+', Linux, 390x844 touch viewport; isolated owner/store; real handlers/FFmpeg; NOT_IPHONE';
 const context=await browser.newContext({viewport:{width:390,height:844},hasTouch:true});await context.addCookies([{name:'fixture',value:session.cookie,url:base}]);
 await context.route('**/*',route=>{if(new URL(route.request().url()).origin===base)return route.continue();evidence.external_requests++;return route.abort();});
 const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=>{window.previewSamples=[];window.previewStarts=[];const AC=window.AudioContext;window.AudioContext=class extends AC{createGain(){const g=super.createGain(),p=this.createScriptProcessor(256,1,1);g.connect(p);p.connect(this.destination);p.onaudioprocess=e=>{const values=e.inputBuffer.getChannelData(0);let sum=0,peak=0;for(const x of values){sum+=x*x;peak=Math.max(peak,Math.abs(x));}window.previewSamples.push({at:e.playbackTime,peak,rms:Math.sqrt(sum/values.length)});};return g;}createBufferSource(){const n=super.createBufferSource(),start=n.start.bind(n);n.start=(...args)=>{window.previewStarts.push({when:args[0],offset:args[1],duration:args[2],context:this.currentTime});return start(...args);};return n;}};});
 await page.goto(base+'/lumi/studio');await page.locator('[data-tab=editor]').click();await page.locator('[data-edit-action=import]').click();await page.locator('[data-editor-inspector]').waitFor({timeout:90000});
 const projectId=Object.keys((await store.get('1')).state.mini_app.editor_projects)[0];
 await page.locator('[data-source-choice]').selectOption(digest([audioArtifact.artifact_id,audioArtifact.sha256]));
 await page.locator('[data-edit-action=add-source]').click();
 const project=(await store.get('1')).state.mini_app.editor_projects[projectId];
 await page.locator('[data-lane=voice] [data-clip]').first().click();
 await page.locator('[data-edit-field=timeline_start]').fill('0.600');await page.locator('[data-edit-field=timeline_start]').press('Tab');
 await page.locator('[data-edit-field=gain_mdb]').evaluate(e=>{e.value='-3';e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));});
 await page.locator('[data-edit-action=save]').click();await page.waitForFunction(()=>document.querySelector('[data-editor-status]').textContent.startsWith('Guardado'));
 let saved=(await store.get('1')).state.mini_app.editor_projects[projectId];assert.equal(saved.revisions.at(-1).edit.clips.find(c=>c.track==='voice').timeline_start,28800);assert.equal(saved.revisions.at(-1).edit.clips.find(c=>c.track==='voice').gain_mdb,-3000);
 const firstRev=saved.current;
 await page.locator('[data-lane=video] [data-clip]').first().click();await page.locator('[data-edit-field=source_out]').fill('4.500');await page.locator('[data-edit-field=source_out]').press('Tab');await page.locator('[data-edit-field=cut_reason]').fill('Corte deliberado de prueba local');await page.locator('[data-edit-field=cut_reason]').press('Tab');
 await page.locator('[data-edit-action=save]').click();await page.waitForTimeout(1300);
 // Persistent media DOM on save and main Studio state refresh.
 await page.evaluate(()=>window.savedMedia=document.querySelector('[data-editor-stage] video'));
 await page.locator('[data-edit-action=save]').click();assert.equal(await page.evaluate(()=>savedMedia===document.querySelector('[data-editor-stage] video')),true);
 await page.locator('[data-edit-action=play]').click();await page.waitForTimeout(3500);await page.locator('[data-edit-action=play]').click();
 const signal=await page.evaluate(()=>({starts:previewStarts,samples:previewSamples.filter(s=>s.peak>.005)}));assert.ok(signal.starts.length>0,'audio scheduled');assert.ok(signal.samples.length>0,'real decoded output measured');evidence.preview_signal={scheduled_offset:signal.starts[0].offset,timeline_onset_seconds:signal.samples[0].at-(signal.starts[0].when-.6),scheduling_error_seconds:signal.starts[0].when-signal.starts[0].context-.04-.6,scheduled_context_time:signal.starts[0].when,first_nonzero_context_time:signal.samples[0].at,rms:signal.samples.slice(4,20).reduce((n,s)=>n+s.rms,0)/16};
 assert.ok(Math.abs(evidence.preview_signal.timeline_onset_seconds-.6)<.13);
 const latencies=[];for(let i=0;i<12;i++)latencies.push(await page.evaluate(()=>new Promise(resolve=>{const t=performance.now(),slider=document.querySelector('[data-editor-zoom]');slider.value=Number(slider.value)===55?'60':'55';slider.dispatchEvent(new Event('input',{bubbles:true}));requestAnimationFrame(()=>resolve(performance.now()-t));})));evidence.hot_control_feedback_ms={count:latencies.length,max:Math.max(...latencies),median:[...latencies].sort((a,b)=>a-b)[6]};assert.ok(evidence.hot_control_feedback_ms.max<100);
 await page.screenshot({path:join(dir,'editor.png'),fullPage:true});
 await page.reload();await page.locator('[data-tab=editor]').click();await page.locator('[data-editor-project]').selectOption(projectId);await page.locator('[data-lane=voice] [data-clip]').first().click();assert.equal(await page.locator('[data-edit-field=timeline_start]').inputValue(),'0.6');assert.equal(await page.locator('[data-edit-field=gain_mdb]').inputValue(),'-3');
 // Real touch dispatch through Chromium: audio moves independently, then undo.
 const touch=await context.newCDPSession(page);await page.locator('[data-lane=voice] [data-clip]').scrollIntoViewIfNeeded();const box=await page.locator('[data-lane=voice] [data-clip]').boundingBox(),tx=box.x+box.width/2,ty=box.y+box.height/2;
 await touch.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:tx,y:ty}]});await touch.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:tx+33,y:ty}]});await touch.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});assert.ok(Number(await page.locator('[data-edit-field=timeline_start]').inputValue())>1.1);await page.locator('[data-edit-action=undo]').click();assert.equal(await page.locator('[data-edit-field=timeline_start]').inputValue(),'0.6');evidence.touch='Chromium CDP touch: independent voice drag + undo';
 // Split and undo/redo use actual model and persistent edits.
 await page.locator('[data-lane=video] [data-clip]').first().click();await page.locator('[data-editor-seek]').evaluate(e=>{e.value='96000';e.dispatchEvent(new Event('input',{bubbles:true}));});await page.locator('[data-edit-action=split]').click();assert.equal(await page.locator('[data-lane=video] [data-clip]').count(),2);await page.locator('[data-edit-action=undo]').click();assert.equal(await page.locator('[data-lane=video] [data-clip]').count(),1);await page.locator('[data-edit-action=redo]').click();assert.equal(await page.locator('[data-lane=video] [data-clip]').count(),2);await page.locator('[data-edit-action=undo]').click();
 await page.locator('[data-edit-action=save]').click();await page.waitForTimeout(1400);
 // Lost ACK is reconciled with the same command ID and no extra revision.
 loseSave=true;await page.locator('[data-lane=voice] [data-clip]').first().click();await page.locator('[data-edit-field=timeline_start]').fill('0.700');await page.locator('[data-edit-field=timeline_start]').press('Tab');await page.locator('[data-edit-action=save]').click();await page.waitForTimeout(1200);const afterLost=(await store.get('1')).state.mini_app.editor_projects[projectId].current;await page.locator('[data-edit-action=save]').click();await page.waitForTimeout(500);assert.equal((await store.get('1')).state.mini_app.editor_projects[projectId].current,afterLost);
 // Restore requested offset and submit a real candidate with immutable version identity.
 await page.locator('[data-edit-field=timeline_start]').fill('0.600');await page.locator('[data-edit-field=timeline_start]').press('Tab');await page.locator('[data-edit-action=save]').click();await page.waitForTimeout(1300);await page.locator('[data-edit-action=render]').click();await page.waitForFunction(()=>document.querySelector('[data-editor-versions]').textContent.includes('COMPLETE'),null,{timeout:90000});
 const jobs=Object.values((await store.get('1')).state.mini_app.operations).filter(j=>j.kind==='editor_render');assert.equal(jobs.length,1);assert.ok(jobs[0].result.sha256);evidence.export={sha:jobs[0].result.sha256,revision:jobs[0].binding.revision,duration_ticks:jobs[0].result.duration_ticks};
 // Cached analytics render real normalized values in isolated fixture only.
 const range=romeRange('2026-10-01','2026-10-26'),metrics=['IGRE04','IGRE06','IGRE01','IGRE10','IGRE23'],schema=Object.keys(FIELDS.instagram.values).map(fieldId=>({fieldId,metricLabel:fieldId}));const post=normalizePosts({network:'instagram',metrics,schema,data:{rows:[['test','https://www.instagram.com/reel/test/','20261014','0','17']]},range,observed_at:new Date().toISOString(),verification:{}}).posts[0];const row=await store.get('1');row.state.mini_app.analytics={snapshots:[{id:'isolated',range,posts:[post]}],links:{},continuations:{},last_good_at:new Date().toISOString()};await store.cas('1',row.revision,row.state);
 await page.locator('[data-tab=resultados]').click();await page.getByText('Sin episodio asociado',{exact:true}).waitFor();assert.match(await page.locator('.result-stats').innerText(),/17/);await page.locator('[data-link-choice]').selectOption('0');await page.locator('[data-link-confirm]').check();await page.locator('[data-results-link]').click();await page.locator('[data-results-part="2"]').click();await page.getByText(/Lumi y los animales de la granja · parte 2/).waitFor();assert.equal(Object.keys((await store.get('1')).state.mini_app.analytics.continuations).length,1);
 await page.screenshot({path:join(dir,'results.png'),fullPage:true});
 // A second real browser tab opens the same project; CAS must preserve both edits.
 await page.locator('[data-tab=editor]').click();await page.locator('[data-editor-project]').selectOption(projectId);
 const other=await context.newPage();await other.goto(base+'/lumi/studio');await other.locator('[data-tab=editor]').click();await other.locator('[data-editor-project]').selectOption(projectId);await other.locator('[data-lane=voice] [data-clip]').click();
 await page.locator('[data-lane=voice] [data-clip]').click();await page.locator('[data-edit-field=timeline_start]').fill('0.800');await page.locator('[data-edit-field=timeline_start]').press('Tab');await page.locator('[data-edit-action=save]').click();await page.waitForTimeout(600);
 await other.locator('[data-edit-field=timeline_start]').fill('0.900');await other.locator('[data-edit-field=timeline_start]').press('Tab');await other.locator('[data-edit-action=save]').click();await other.waitForFunction(()=>document.querySelector('[data-editor-status]').textContent.startsWith('Conflicto'));await other.locator('[data-edit-action=fork]').click();await other.waitForFunction(()=>document.querySelector('[data-editor-status]').textContent.startsWith('Guardado'));assert.equal(Object.keys((await store.get('1')).state.mini_app.editor_projects).length,2);await other.close();
 // Storage-denied environment still commits through the authenticated store.
 await page.evaluate(()=>{Object.defineProperty(window,'localStorage',{get(){throw Error('STORAGE_DISABLED');}});});await page.locator('[data-edit-field=timeline_start]').fill('0.600');await page.locator('[data-edit-field=timeline_start]').press('Tab');await page.locator('[data-edit-action=save]').click();await page.waitForTimeout(500);assert.equal((await store.get('1')).state.mini_app.editor_projects[projectId].revisions.at(-1).edit.clips.find(c=>c.track==='voice').timeline_start,28800);
 expired=true;await page.locator('[data-edit-field=timeline_start]').fill('0.700');await page.locator('[data-edit-field=timeline_start]').press('Tab');await page.locator('[data-edit-action=save]').click();await page.waitForTimeout(400);assert.equal((await store.get('1')).state.mini_app.editor_projects[projectId].revisions.at(-1).edit.clips.find(c=>c.track==='voice').timeline_start,28800);evidence.concurrency='two tabs, explicit alternative retained';evidence.recovery='lost ACK, reload, unavailable localStorage, expired session rejected';assert.equal(errors.length,0,errors.join(' | '));assert.equal(evidence.external_requests,0);evidence.pass=true;evidence.screenshots=dir;await mkdir('/tmp/lumi-visual-evidence',{recursive:true});await writeFile('/tmp/lumi-visual-evidence/browser.json',JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence));
}finally{clearInterval(drain);await browser?.close();server.closeAllConnections?.();await new Promise(r=>server.close(r));}
