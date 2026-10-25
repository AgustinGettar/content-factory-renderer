// Real Studio DOM + mounted publication handlers + CAS store. Synthetic identity,
// production projection and master only. External traffic is forbidden.
import {chromium} from 'playwright';
import express from 'express';
import {readFile,mkdir} from 'node:fs/promises';
import {createHmac} from 'node:crypto';
import assert from 'node:assert/strict';
import {MemoryReviewStore} from '../lib/telegram-review-v1/core.js';
import {MiniAppAuth} from '../lib/telegram-mini-app/auth.js';
import {mountPublication,publicationPackage} from '../lib/telegram-mini-app/publication-store.js';
import {metricoolView} from '../lib/telegram-mini-app/metricool.js';
const env={LUMI_RUNTIME_ENV:'staging',SUPABASE_URL:'https://mofjhwathxzfnjapvvst.supabase.co',LUMI_TELEGRAM_BOT_TOKEN:'1:OFFLINE_ONLY'};
const store=new MemoryReviewStore();await store.create('1',{user_id:'1',chat_id:'1',message_id:1,episodes:{fixture:{episode_id:'fixture',title:'Lumi y los animales de la granja'},fixture2:{episode_id:'fixture2',title:'Lumi y las tres flores de colores'}}});
const auth=new MiniAppAuth({store,env,validateOwner:async()=>true});
const params=new URLSearchParams({auth_date:String(Math.floor(Date.now()/1000)),user:'{"id":1}',query_id:'browser-fixture'});
params.set('hash',createHmac('sha256',createHmac('sha256','WebAppData').update(env.LUMI_TELEGRAM_BOT_TOKEN).digest()).update([...params].sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>k+'='+v).join('\n')).digest('hex'));
const session=await auth.login(params.toString()),app=express();app.use(express.json());
let base,expired=false,loseSave=false;const errors=[];
const principal=req=>{if(expired)throw Object.assign(Error('MINI_SESSION_EXPIRED'),{status:401});return auth.authenticate(req.headers.cookie?.split('fixture=')[1]?.split(';')[0],req.method==='POST'?req.headers['x-lumi-csrf']||'':null);};
const wrap=fn=>async(req,res)=>{try{await fn(req,res);}catch(e){res.status(e.status||409).json({error:e.message});}};
app.use((req,res,next)=>{res.set('Cache-Control','no-store');if(req.method==='POST'&&req.headers.origin!==base)return res.sendStatus(403);
 if(loseSave&&req.path==='/lumi/studio/api/publication/episodes/fixture'){loseSave=false;const original=res.json.bind(res);res.json=()=>{res.status(504);return original({error:'FIXTURE_LOST_ACK'});};}next();});
mountPublication(app,{api:'/lumi/studio/api',principal,wrap,store,env,validateOwner:async()=>true,fetchImpl:async()=>{throw Error('EXTERNAL_FORBIDDEN');}});
async function view(){const s=(await store.get('1')).state;return {client_scope:'fixture-owner',client_session:'fixture-session',server_time:Date.now(),review_revision:1,episode:{id:'fixture',title:s.episodes.fixture.title,next_action:'image:q47',checkpoint_version:1,actions:[]},episodes:Object.entries(s.episodes).map(([id,e])=>({id,title:e.title,publication:publicationPackage(s,id)})),
 episode_job:{id:'fixture-job',status:'NEEDS_ATTENTION'},review_policy:{mode:'SUPERVISED'},episode_plan_authorization:{status:'PENDING'},current_action:{status:'BLOCKED',operations:[]},production:{shots:[]},media:[],reviews:[],review_receipts:[],action_receipts:[],capabilities:{},budget:{ceiling_usd:8,actual_cost_usd:null,exposure_usd:4,remaining_usd:4,reservations:[]},settings:{publication_connection:metricoolView(s.mini_app)}};}
app.get('/lumi/studio/api/session',wrap(async(req,res)=>{await principal(req);res.json({csrf:session.csrf,expires_at:Date.now()+1800000,...(req.query.state?{state:await view()}: {})});}));
app.get('/lumi/studio/api/state',wrap(async(req,res)=>{await principal(req);res.json(await view());}));
app.get('/lumi/studio/api/library',(_req,res)=>res.json({assets:[],counts:{},selections:[],version:1}));
app.get('/lumi/studio/api/library/plan',(_req,res)=>res.json({suggestions:[]}));
for(const file of ['index.html','app.js','style.css','publication-ui.js'])app.get(file==='index.html'?'/lumi/studio':'/lumi/studio/'+file,async(_req,res)=>res.type(file.endsWith('.js')?'js':file.endsWith('.css')?'css':'html').send((await readFile(new URL('../public/lumi-studio/'+file,import.meta.url),'utf8')).replace('<script async src="https://telegram.org/js/telegram-web-app.js"></script>','')));
const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));base='http://127.0.0.1:'+server.address().port;
let browser;
try{
 browser=await chromium.launch({headless:true,...(process.env.LUMI_TEST_BROWSER?{executablePath:process.env.LUMI_TEST_BROWSER,args:['--no-sandbox','--disable-gpu']}:{})});
 const context=await browser.newContext({viewport:{width:390,height:844}});await context.addCookies([{name:'fixture',value:session.cookie,url:base}]);
 await context.route('**/*',route=>new URL(route.request().url()).origin===base?route.continue():route.abort());
 const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
 await page.goto(base+'/lumi/studio');await page.click('[data-tab="ajustes"]');await page.waitForSelector('[data-metricool-connect]');
 assert.match(await page.locator('[data-ui-key="publication-settings"]').innerText(),/7627207|lumilaluciernaga/);
 assert.equal(await page.locator('body').innerText().then(t=>t.includes('6912906')),false);
 await page.click('[data-metricool-verify]');await page.getByText('Primero conectá Metricool con el consentimiento del propietario.').waitFor();
 await page.click('[data-tab="videos"]');const card=page.locator('[data-ui-key="publication:fixture"]');await card.locator(':scope > summary').click();
 const instagram=card.locator('[data-ui-key="publication:fixture:instagram"]');await instagram.locator('summary').click();
 const field=instagram.locator('textarea');await field.fill('🐑 Mensaje de la granja guardado en Lumi. #Lumi');
 await card.locator('[data-pub-save]').dblclick();await card.getByText('Guardado en Lumi · versión 1',{exact:true}).waitFor();
 assert.equal((await store.get('1')).state.mini_app.publication_packages.fixture.versions.length,1);
 await page.reload();await page.click('[data-tab="videos"]');await card.locator(':scope > summary').click();await instagram.locator('summary').click();assert.match(await field.inputValue(),/guardado en Lumi/);
 assert.equal(await card.getByRole('button',{name:'Aprobar y publicar · no disponible'}).isDisabled(),true);
 const second=page.locator('[data-ui-key="publication:fixture2"]');assert.doesNotMatch(await second.innerText(),/Mensaje de la granja guardado/);
 loseSave=true;await field.fill('Mensaje con respuesta perdida. #Lumi');await card.locator('[data-pub-save]').click();await card.getByText(/No se confirmó el guardado/).waitFor();
 assert.equal((await store.get('1')).state.mini_app.publication_packages.fixture.versions.length,2);
 await card.locator('[data-pub-save]').click();await card.getByText('Guardado en Lumi · versión 2',{exact:true}).waitFor();assert.equal((await store.get('1')).state.mini_app.publication_packages.fixture.versions.length,2);
 expired=true;await field.fill('Edición mientras vence la sesión. #Lumi');await card.locator('[data-pub-save]').click();await card.getByText(/Sesión vencida/).waitFor();expired=false;
 await page.reload();await page.click('[data-tab="videos"]');await card.locator(':scope > summary').click();await instagram.locator('summary').click();assert.match(await field.inputValue(),/vence la sesión/);
 await card.locator('[data-pub-save]').click();await card.getByText('Guardado en Lumi · versión 3',{exact:true}).waitFor();
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await mkdir('/tmp/lumi-publication-screens',{recursive:true});await page.screenshot({path:'/tmp/lumi-publication-screens/messages.png',fullPage:true});
 await page.click('[data-tab="ajustes"]');await page.screenshot({path:'/tmp/lumi-publication-screens/settings.png',fullPage:true});
 assert.deepEqual(errors,[]);console.log(JSON.stringify({status:'PASS_BROWSER_FIXTURE',durable_versions:3,duplicate_versions:0,real_remote_effects:0,iphone:'NOT_TESTED'}));
}finally{await browser?.close();await new Promise(r=>server.close(r));}
