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
for(const file of ['index.html','app.js','style.css','publication-ui.js','preparation-ui.js','editor-ui.js','editor-model.js','results-ui.js'])app.get(file==='index.html'?'/lumi/studio':'/lumi/studio/'+file,async(_req,res)=>res.type(file.endsWith('.js')?'js':file.endsWith('.css')?'css':'html').send((await exec('git',['show','e48d4dd:public/lumi-studio/'+file],{maxBuffer:2000000})).stdout.replace('<script async src="https://telegram.org/js/telegram-web-app.js"></script>','')));
const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));base='http://127.0.0.1:'+server.address().port;
let browser;const evidence={environment:'Browser version pending launch; Linux, 390x844 touch viewport; isolated owner/store; real handlers/FFmpeg; NOT_IPHONE',external_requests:0};
const range=romeRange('2026-10-01','2026-10-26'),metrics=['IGRE04','IGRE06','IGRE01','IGRE10','IGRE23'],schema=Object.keys(FIELDS.instagram.values).map(fieldId=>({fieldId,metricLabel:fieldId}));
const post=normalizePosts({network:'instagram',metrics,schema,data:{rows:[['post1','https://www.instagram.com/reel/fixture/','20261014','17','1200']]},range,observed_at:'2026-10-26T10:00:00Z',verification:{}}).posts[0];const row=await store.get('1');row.state.mini_app.analytics={snapshots:[{id:'one',range,posts:[post]}],links:{},continuations:{},last_good_at:'2026-10-26T10:00:00Z'};await store.cas('1',row.revision,row.state);
try{
 browser=await chromium.launch({headless:true,executablePath:process.env.LUMI_TEST_BROWSER||undefined,args:['--no-sandbox','--disable-gpu']});
 const context=await browser.newContext({viewport:{width:390,height:844},hasTouch:true});await context.addCookies([{name:'fixture',value:session.cookie,url:base}]);
 await context.route('**/*',r=>new URL(r.request().url()).origin===base?r.continue():r.abort());
 const page=await context.newPage();await page.goto(base+'/lumi/studio');await page.locator('[data-tab=produccion]').waitFor();await page.waitForTimeout(500);
 await mkdir('/tmp/lumi-simple-before',{recursive:true});
 for(const tab of (process.env.LUMI_BEFORE_RESULTS_ONLY?['resultados']:['inicio','produccion','biblioteca','resultados'])){await page.locator('[data-tab='+tab+']').first().click();await page.waitForTimeout(500);await page.screenshot({path:'/tmp/lumi-simple-before/'+tab+'.png',fullPage:true});}
 if(!process.env.LUMI_BEFORE_RESULTS_ONLY){await page.locator('[data-tab=editor]').click();await page.locator('[data-edit-action=import]').click();await page.locator('[data-editor-inspector]').waitFor({timeout:90000});await page.waitForTimeout(2500);await page.screenshot({path:'/tmp/lumi-simple-before/editor.png',fullPage:true});
 await page.locator('[data-source-choice]').selectOption(digest([audioArtifact.artifact_id,audioArtifact.sha256]));await page.locator('[data-edit-action=add-source]').click();await page.locator('[data-lane=voice] [data-clip]').first().click();await page.screenshot({path:'/tmp/lumi-simple-before/editor-audio.png',fullPage:true});
 }console.log('BEFORE_SAVED');
}finally{clearInterval(drain);await browser?.close();server.closeAllConnections?.();await new Promise(r=>server.close(r));}
