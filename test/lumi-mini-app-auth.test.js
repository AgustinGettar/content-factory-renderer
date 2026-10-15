import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac,generateKeyPairSync,sign as edSign} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {MemoryReviewStore} from '../lib/telegram-review-v1/core.js';
import {MiniAppAuth,validateInitData,assertMiniPrincipal,miniAppEnabled,miniAuthConfigured,miniAppSecret} from '../lib/telegram-mini-app/auth.js';

const token='12345:OFFLINE_TELEGRAM_TOKEN',env={LUMI_RUNTIME_ENV:'staging',SUPABASE_URL:'https://mofjhwathxzfnjapvvst.supabase.co',LUMI_TELEGRAM_BOT_TOKEN:token};
function sign(values={},key=token){const p=new URLSearchParams({auth_date:String(Math.floor(Date.now()/1000)),query_id:'test-query',user:JSON.stringify({id:1,first_name:'Test'}),...values});
 const secret=createHmac('sha256','WebAppData').update(key).digest(),check=[...p].sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${k}=${v}`).join('\n');
 p.set('hash',createHmac('sha256',secret).update(check).digest('hex'));return p.toString();}
async function fixture(){const store=new MemoryReviewStore();await store.create('1',{user_id:'1',chat_id:'1',message_id:148});let active=true;
 const auth=new MiniAppAuth({store,env,validateOwner:async(u,c)=>active&&u==='1'&&c==='1'});return {store,auth,deactivate:()=>active=false};}

test('AUTH_SECURITY: official HMAC, exact identity, timestamp and duplicate-field checks',()=>{
 assert.equal(validateInitData(sign(),token).user,'1');
 for(const raw of [sign({},'other'),sign().replace('Test','Forged'),sign()+'&user=%7B%22id%22%3A2%7D',
  sign({auth_date:String(Math.floor(Date.now()/1000)-301)}),sign({auth_date:String(Math.floor(Date.now()/1000)+60)}),
  sign({user:'{"id":"1"}'}),sign({user:'null'}),sign({chat_type:'group'}),sign({chat:JSON.stringify({id:-1,type:'group'})}),sign({auth_date:'1e10'})])
  assert.throws(()=>validateInitData(raw,token));
 assert.throws(()=>assertMiniPrincipal({user:'1'}),/SESSION_REQUIRED/);
});
test('AUTH_SECURITY: official Ed25519 format binds bot, signed fields and replay identity; runtime pins Telegram key',async()=>{
 const {publicKey,privateKey}=generateKeyPairSync('ed25519'),botId='8843261381',now=Date.now();
 const make=(values={})=>{const p=new URLSearchParams({auth_date:String(Math.floor(now/1000)),user:JSON.stringify({id:1,first_name:'Test'}),query_id:'ed-query',...values});
  const check=botId+':WebAppData\n'+[...p].sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${k}=${v}`).join('\n');
  p.set('signature',edSign(null,Buffer.from(check),privateKey).toString('base64url'));p.set('hash','a'.repeat(64));return p;};
 const raw=make(),verified=validateInitData(raw.toString(),{botId},now,publicKey);assert.equal(verified.user,'1');
 raw.set('hash','b'.repeat(64));raw.set('signature',raw.get('signature')+'==');
 assert.equal(validateInitData(raw.toString(),{botId},now,publicKey).exchange,verified.exchange);
 for(const [p,cred] of [[make(),{botId:'999'}],[make({auth_date:String(Math.floor(now/1000)-301)}),{botId}],[make({chat_type:'group'}),{botId}]])assert.throws(()=>validateInitData(p.toString(),cred,now,publicKey));
 const tampered=make();tampered.set('user',JSON.stringify({id:2}));assert.throws(()=>validateInitData(tampered.toString(),{botId},now,publicKey),/SIGNATURE/);
 assert.throws(()=>validateInitData(make().toString(),{botId}),/SIGNATURE/);
 const f=await fixture(),edEnv={...env,LUMI_TELEGRAM_BOT_TOKEN:undefined,LUMI_TELEGRAM_BOT_ID:botId,LUMI_TELEGRAM_CALLBACK_SECRET:'offline-existing-callback-secret'};
 const auth=new MiniAppAuth({store:f.store,env:edEnv,validateOwner:async()=>true});
 await assert.rejects(auth.login(make().toString()),/SIGNATURE/); // self-signed key is NEVER trusted by runtime
 assert.equal(miniAuthConfigured(edEnv),true);assert.equal(miniAuthConfigured({...edEnv,LUMI_TELEGRAM_CALLBACK_SECRET:undefined}),false);
 assert.equal(miniAppSecret(edEnv).length,32);assert.match(auth.csrf('session'),/^[a-f0-9]{64}$/);
});
test('AUTH_SECURITY: exchange is one-time across instances; session supports re-open, CSRF and owner revocation',async()=>{
 const f=await fixture(),raw=sign(),results=await Promise.allSettled([f.auth.login(raw),f.auth.login(raw)]);
 assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
 const session=results.find(x=>x.status==='fulfilled').value;
 const restarted=new MiniAppAuth({store:f.store,env,validateOwner:async()=>true});
 await assert.rejects(restarted.login(raw),/REPLAY/);
 assert.equal((await restarted.authenticate(session.cookie,session.csrf)).user,'1');
 await assert.rejects(restarted.authenticate(session.cookie,'forged'),/CSRF/);
 await assert.rejects(restarted.authenticate('1.'+'a'.repeat(64)),/SESSION_EXPIRED/);
 const principal=await restarted.authenticate(session.cookie);assert.throws(()=>assertMiniPrincipal({...principal}));
 f.deactivate();await assert.rejects(f.auth.authenticate(session.cookie),/SESSION_EXPIRED/);
});
test('AUTH_SECURITY: no freely supplied identity, wrong private chat or expired session; staging is pinned',async()=>{
 const f=await fixture();await assert.rejects(f.auth.login(sign({user:JSON.stringify({id:2})})),/OWNER/);
 await assert.rejects(f.auth.login(sign({chat:JSON.stringify({id:2,type:'private'})})),/OWNER/);
 const s=await f.auth.login(sign()),p=await f.auth.authenticate(s.cookie),r=await f.store.get('1');
 r.state.mini_app.sessions[p.session].expires_at=0;await f.store.cas('1',r.revision,r.state);await assert.rejects(f.auth.authenticate(s.cookie),/EXPIRED/);
 assert.equal(miniAppEnabled(env),true);
 for(const patch of [{LUMI_RUNTIME_ENV:'production'},{SUPABASE_URL:'https://production.supabase.co'},{RENDER_SERVICE_ID:'production'},{LUMI_MINI_APP_ENABLED:'false'}])assert.equal(miniAppEnabled({...env,...patch}),false);
});
test('MOBILE_UI_OFFLINE: four accessible sections, safe areas, native video, separate spend/generation and no client secrets',async()=>{
 const js=await readFile(new URL('../public/lumi-studio/app.js',import.meta.url),'utf8'),css=await readFile(new URL('../public/lumi-studio/style.css',import.meta.url),'utf8'),html=await readFile(new URL('../public/lumi-studio/index.html',import.meta.url),'utf8');
 for(const word of ['Inicio','Videos','Producción','Ajustes'])assert.ok(js.includes(word));
 assert.match(html,/viewport-fit=cover/);assert.match(html,/aria-live="polite"/);assert.match(css,/safe-area-inset-bottom/);
 assert.match(js,/controls playsinline/);assert.match(js,/Autorizar este importe/);assert.match(js,/Confirmar y generar/);
 assert.match(js,/Consultando precio…/);assert.match(js,/visibilitychange/);
  assert.match(js,/generationLocked/);assert.match(js,/Actualizar progreso/);
 assert.doesNotMatch(js+html,/initDataUnsafe|SUPABASE_SERVICE_ROLE_KEY|HF_API_KEY|editMessageMedia|api\.higgsfield/);
});

test('DURABLE_LOCK MOBILE_UI HTTP_TIMEOUT DOUBLE_CLICK: ambiguous HTTP result and page reload never restore Generate',async()=>{
 const js=await readFile(new URL('../public/lumi-studio/app.js',import.meta.url),'utf8'),saved=new Map();let posts=0,rejectRequest;
 const make=()=>{
  const element={innerHTML:'',textContent:'',hidden:false,querySelector:()=>null};
  const ctx={document:{querySelector:()=>element,addEventListener(){},querySelectorAll:()=>[]},window:{},
   localStorage:{getItem:k=>saved.get(k),setItem:(k,v)=>saved.set(k,v)},setInterval(){},setTimeout(){},clearTimeout(){},
   send:()=>{posts++;return new Promise((_,reject)=>{rejectRequest=reject;});}};
  runInNewContext(js.replace('navigation();login();','')+`
   state={episode:{next_action:'video:q41'},quote:null,capabilities:{},first_animation:{available:true,locked:false,status:'NOT_STARTED'}};
   csrf='offline';render=()=>{};toast=()=>{};refresh=async()=>{};request=()=>send();
   globalThis.ui={submit,quoteCard,reviewCards,setGeneration:g=>state.first_animation=g};`,ctx);
  return ctx.ui;
 };
 const ui=make();assert.match(ui.quoteCard(),/data-action="first_animation"/);
 const pending=ui.submit('first_animation',{confirm:true});await ui.submit('first_animation',{confirm:true});
 assert.equal(posts,1);assert.doesNotMatch(ui.quoteCard(),/data-action="first_animation"/);assert.match(ui.quoteCard(),/Actualizar progreso/);
 rejectRequest(Object.assign(Error('offline timeout'),{name:'AbortError'}));await pending;
 assert.doesNotMatch(ui.quoteCard(),/data-action="first_animation"/);
 const reopened=make();await reopened.submit('first_animation',{confirm:true});assert.equal(posts,1);
 assert.doesNotMatch(reopened.quoteCard(),/data-action="first_animation"/);
 reopened.setGeneration({locked:true,status:'AWAITING_HUMAN_REVIEW'});assert.match(reopened.quoteCard(),/Ver animación/);
});
test('CONTINUE_PRODUCTION UI: immediate lock, timeout recovery and durable stage identity',async()=>{
 const js=await readFile(new URL('../public/lumi-studio/app.js',import.meta.url),'utf8');let posts=[],rejectRequest;
 const element={innerHTML:'',textContent:'',hidden:false,querySelector:()=>null};
 const ctx={document:{querySelector:()=>element,addEventListener(){},querySelectorAll:()=>[]},window:{},
  setInterval(){},setTimeout(){},clearTimeout(){},send:(path,options)=>{posts.push({path,options});return new Promise((_,reject)=>{rejectRequest=reject;});}};
 runInNewContext(js.replace('navigation();login();','')+`
  state={episode:{next_action:'temporal_qa:q41',checkpoint_version:15},quote:null,capabilities:{continue:true},first_animation:{locked:true,status:'SUCCEEDED'}};
  csrf='offline';render=()=>{};toast=()=>{};refresh=async()=>{};request=(p,o)=>send(p,o);
  globalThis.ui={submit,quoteCard,banner,setOperation:o=>state.operation=o};`,ctx);
 const ui=ctx.ui,pending=ui.submit('continue');await ui.submit('continue');assert.equal(posts.length,1);
 assert.equal(posts[0].options.body.expected_action,'temporal_qa:q41');assert.equal(posts[0].options.body.checkpoint_version,15);
 assert.match(ui.quoteCard(),/disabled/);
 rejectRequest(Object.assign(Error('timeout'),{name:'AbortError'}));await pending;
 for(const status of ['QUEUED','RUNNING','RECOVERY_REQUIRED','BLOCKED']){
  ui.setOperation({kind:'continue',status,resume_available:status==='BLOCKED'});
  assert.doesNotMatch(ui.quoteCard(),/Siguiente etapa lista|data-action="continue"/);assert.match(ui.quoteCard(),/Actualizar progreso/);
 }
 assert.match(ui.banner(),/Retomar etapa guardada/);
});

async function transitionFixture(){
 const {productionPresentation}=await import('../lib/telegram-mini-app/runtime.js');
 const {ep004ProductionRequest,prepareGenericV2Episode}=await import('../lib/lumi-generic-v2-adapter.js');
 const generic=prepareGenericV2Episode(ep004ProductionRequest({episode_id:'ep_lumi_granja_004_20261008_ee7ab4b3',sha256:'a'.repeat(64)}));
 const stages=['IMAGE','SOURCE_QA','DIRECTOR','VIDEO','TEMPORAL_QA','SHOT_REVIEW'];
 const cp={first_pending_action:'image:q42',metadata:{generic_v2:generic,source_artifacts:{q41:{}},review_requests:{}},
  actions:['q41','q42'].flatMap(scene_id=>stages.map(stage=>({key:stage.toLowerCase()+':'+scene_id,stage,scene_id,status:scene_id==='q41'?'COMPLETE':'PENDING'})))};
 const make=()=>({server_time:Date.now(),episode:{id:generic.episode_id,title:generic.plan.episode.title,next_action:cp.first_pending_action,checkpoint_version:17,actions:cp.actions},
  production:productionPresentation(cp),media:[{id:'clip1',episode:generic.episode_id,shot_id:'q41',role:'clip',mime:'video/mp4',url:'/original',approved:true}],reviews:[],
  budget:{ceiling_usd:5,exposure_usd:.89875,remaining_usd:4.10125},quote:null,capabilities:{quote:true},first_animation:{locked:true,status:'SUCCEEDED'}});
 return {cp,make};
}
async function transitionUi(initial,{reduced=false,playing=false}={}){
 const js=await readFile(new URL('../public/lumi-studio/app.js',import.meta.url),'utf8'),events=[],elements=new Map();
 const element=id=>{if(!elements.has(id))elements.set(id,{innerHTML:'',textContent:'',hidden:false,open:false,querySelector:()=>({}),
  focus:o=>events.push({focus:o}),scrollIntoView:o=>events.push({scroll:o}),showModal(){this.open=true;events.push({dialog:true});},close(){this.open=false;}});return elements.get(id);};
 const ctx={document:{querySelector:element,querySelectorAll:()=>playing?[{paused:false}]:[],addEventListener(){}},window:{matchMedia:()=>({matches:reduced})},
  localStorage:{getItem:()=> 'pending',setItem(){}},setInterval(){},setTimeout(){},clearTimeout(){},initial};
 runInNewContext(js.replace('navigation();login();','')+`
  state=initial;csrf='offline';tab='produccion';
  globalThis.ui={production,quoteCard,render,refresh,confirmSpend,prepareSpend,
   getState:()=>state,setState:v=>state=v,setRequest:f=>request=f,setSubmit:f=>submit=f};`,ctx);
 return {ui:ctx.ui,events,elements};
}
test('Q41_COMPLETE_UI Q42_PENDING_UI NO_STALE_Q41_CONTROLS SHOT_PROGRESS BUTTON_POSITION SESSION_REOPEN',async()=>{
 const f=await transitionFixture(),v=f.make(),{ui}=await transitionUi(v),html=ui.production();
 assert.match(html,/Toma 1 · Completada/);assert.match(html,/Aprobación humana conservada/);assert.match(html,/src="\/original"/);
 assert.match(html,/Escena 2/);assert.match(html,/Asociar vaca con muu/);assert.match(html,/marketing-studio\/image/);
 assert.match(html,/Lumi, Vaca, Oveja, Gallina/);assert.match(html,/cámara fija/);assert.match(html,/preparar|Preparar siguiente imagen/);
 assert.equal((html.match(/data-action="prepare"/g)||[]).length,1);
 assert.ok(html.indexOf('id="next-action"')>html.indexOf('</ol>'));
 assert.match(html,/<\/ol><div id="next-action"/);
 assert.doesNotMatch(html,/Una primera chispa|Primera animación|Consultar precio|Renovar cotización|data-action="first_animation"/);
 assert.doesNotMatch(html,/data-action="generate"|data-action="authorize"/);
});
test('DYNAMIC_STAGE_RENDERING: all six q42 stages derive from the durable action and approved AV2 goal',async()=>{
 const f=await transitionFixture(),titles=['Preparar siguiente imagen','Verificar imagen para animación','Preparar dirección cinematográfica','Generar animación','Verificar calidad del clip','Revisar animación'];
 for(const [i,stage] of ['image','source_qa','director','video','temporal_qa','shot_review'].entries()){
  f.cp.first_pending_action=stage+':q42';const v=f.make();assert.equal(v.production.action.title,titles[i]);assert.equal(v.production.current_shot,'q42');
  assert.equal(v.production.shots[0].complete,true);assert.equal(v.production.shots[1].goal,'Asociar vaca con muu.');
  assert.equal(v.production.shots[1].stages.filter(s=>s.current).length,1);
 }
});
test('CHECKPOINT_REFRESH AUTO_SCROLL: completed stage updates even while old video plays; reduced motion and focus respected',async()=>{
 for(const reduced of [false,true]){
  const f=await transitionFixture();f.cp.first_pending_action='shot_review:q41';const {ui,events}=await transitionUi(f.make(),{reduced,playing:true});
  f.cp.first_pending_action='image:q42';ui.setRequest(async()=>f.make());await ui.refresh();
  assert.equal(ui.getState().production.current_shot,'q42');assert.equal(events.find(e=>e.focus).focus.preventScroll,true);
  assert.equal(events.find(e=>e.scroll).scroll.behavior,reduced?'auto':'smooth');
 }
});
test('AUTOMATIC_QUOTE AUTH_SECURITY: expired spend opens fresh preparation, never extends the previous authorization',async()=>{
 const f=await transitionFixture(),v=f.make();v.quote={quote_id:'expired-q42',expires_at:'2000-01-01T00:00:00Z',status:'QUOTE_EXPIRED'};
 const {ui}=await transitionUi(v),calls=[];ui.setSubmit(async kind=>calls.push(kind));await ui.confirmSpend('generate');
 assert.deepEqual(calls,['quote']);
});

test('Q42_OPERATION_RECOVERY IMAGE_BUTTON_LOCK SESSION_REOPEN PROVIDER_AMBIGUITY: durable evidence survives unrelated active operation',async()=>{
 const {currentActionState,MiniAppService}=await import('../lib/telegram-mini-app/runtime.js');
 const f=await transitionFixture();f.cp.episode_id='ep_lumi_granja_004_20261008_ee7ab4b3';f.cp.status='RUNNING';f.cp.metadata.runtime_revision=19;
 f.cp.actions.forEach(a=>a.dispatch_state='NOT_DISPATCHED');
 const state={mini_app:{operations:{other:{id:'other',kind:'review',status:'COMPLETE',binding:{next_action:'video:q41'}}},active_operation:'other'},production_commands:{}};
 const ctx={checkpoint:f.cp,state,quote:null,current_emission:null};
 const project=()=>currentActionState(ctx);
 assert.equal(project().status,'NOT_STARTED');
 state.mini_app.operations.quote={id:'quote',kind:'quote',status:'QUEUED',started_at:new Date().toISOString(),binding:{next_action:'image:q42',quote_id:null}};
 assert.equal(project().status,'QUOTE_PENDING');assert.equal(project().locked,true);
 state.mini_app.operations.quote.status='COMPLETE';ctx.quote={quote_id:'q',action_key:'image:q42',status:'QUOTE_EXPIRED'};
 state.production_commands.q={result:{action_key:'image:q42',episode_id:f.cp.episode_id},human_authorization:{expires_at:'2000-01-01T00:00:00Z'}};
 assert.equal(project().status,'AUTHORIZED');assert.equal(project().authorization_expired,true);assert.equal(project().emission_locked,false);
 const generate={id:'original',kind:'generate',status:'BLOCKED',binding:{next_action:'image:q42',quote_id:'q'},started_at:'2000-01-01T00:00:00Z'};
 state.mini_app.operations.original=generate;
 assert.equal(project().status,'AMBIGUOUS');assert.equal(project().emission_locked,true);
 for(const [journal,status] of [[{state:'PREPARED'},'RESERVED'],[{state:'EMITTING'},'EMITTING'],[{state:'EMISSION_UNKNOWN'},'AMBIGUOUS'],[{state:'ACKNOWLEDGED'},'AMBIGUOUS'],[{state:'ACKNOWLEDGED',request_id:'unverified-header'},'AMBIGUOUS'],[{state:'ACKNOWLEDGED',accepted:true,request_id:'verified-original'},'SUBMITTED'],[{state:'ACKNOWLEDGED',failure_confirmed:true},'FAILED_CONFIRMED']]){
  ctx.current_emission={attempt_id:'attempt',...journal};assert.equal(project().status,status);assert.equal(project().locked,true);
  const lockedService=new MiniAppService({store:{get:async()=>({revision:4,state})},adapter:{miniAppStatus:async()=>ctx}});
  const replay=await lockedService.enqueue({user:'1'},'generate',{expected_action:'image:q42',checkpoint_version:19});assert.equal(replay.operation.id,'original');await replay.dispatch();
  await assert.rejects(lockedService.enqueue({user:'1'},'quote',{expected_action:'image:q42',checkpoint_version:19}),/GENERATION_LOCKED/);
  const uiState=f.make();uiState.current_action=project();uiState.capabilities={};const {ui}=await transitionUi(uiState);
  assert.doesNotMatch(ui.quoteCard(),/data-action="(?:prepare|authorize|generate)"/);
 }
 // Reopening the backend with no UI operation still honors reservation and journal.
 delete state.mini_app.operations.original;ctx.current_emission=null;f.cp.metadata.budget_reservations={'image:q42':{amount_usd:.3275}};
 assert.equal(project().status,'RESERVED');assert.equal(project().reservation_usd,.3275);
 delete f.cp.metadata.budget_reservations;state.production_commands['dispatch:q']={status:'CLAIMED'};
 assert.equal(project().status,'AMBIGUOUS');
 // Once any original generate operation exists, even a late request after
 // checkpoint advancement returns it and cannot call the executor again.
 state.mini_app.operations.original=generate;f.cp.first_pending_action='source_qa:q42';
 const service=new MiniAppService({store:{get:async()=>({revision:4,state})},adapter:{miniAppStatus:async()=>ctx}});
 const replay=await service.enqueue({user:'1'},'generate',{expected_action:'image:q42',checkpoint_version:19});
 assert.equal(replay.operation.id,'original');await replay.dispatch();
});

test('Q42_AUTHORIZATION_EXPIRED_UI: retains original authorization and explains no dispatch; automatic price check requires new approval',async()=>{
 const f=await transitionFixture(),v=f.make();v.current_action={status:'AUTHORIZED',locked:true,authorization_recorded:true,authorization_expired:true};
 v.quote={status:'QUOTE_EXPIRED',expires_at:'2000-01-01T00:00:00Z'};v.capabilities={quote:false,renew_quote:true};
 const {ui}=await transitionUi(v),html=ui.quoteCard();
 assert.match(html,/Autorización registrada/);assert.match(html,/generación no se inició/);assert.match(html,/Continuar preparación guardada/);
 assert.doesNotMatch(html,/Preparar siguiente imagen|data-action="generate"|data-action="authorize"/);
});

test('Q42_HTTP_TIMEOUT DOUBLE_CLICK SESSION_REOPEN STALE_RESPONSE: uncertain submission persists and old GET/POST cannot rewind state',async()=>{
 const f=await transitionFixture(),js=await readFile(new URL('../public/lumi-studio/app.js',import.meta.url),'utf8'),saved=new Map();let posts=0,resolvePost,resolveGet;
 const deferred=()=>new Promise(resolve=>resolveGet=resolve);
 const initial=f.make();initial.review_revision=10;initial.current_action={status:'AUTHORIZED',operations:[]};initial.quote={quote_id:'q',quote_sha:'sha',expires_at:new Date(Date.now()+60000).toISOString()};
 const make=()=>{
  const element={innerHTML:'',querySelector:()=>({}),close(){}};
  const ctx={document:{querySelector:()=>element,querySelectorAll:()=>[],addEventListener(){}},window:{},localStorage:{getItem:k=>saved.get(k),setItem:(k,v)=>saved.set(k,v)},setInterval(){},setTimeout(){},clearTimeout(){},initial:structuredClone(initial)};
  runInNewContext(js.replace('navigation();login();','')+`state=initial;csrf='test';render=()=>{};toast=()=>{};
   globalThis.ui={submit,refresh,quoteCard,getState:()=>state,setRequest:f=>request=f};`,ctx);return ctx.ui;
 };
 const ui=make(),old=f.make();old.review_revision=9;let gets=0;
 const fresh=structuredClone(initial);fresh.review_revision=12;fresh.current_action={status:'SUBMITTED',locked:true,operations:[{id:'original',kind:'generate',quote_id:'q'}]};fresh.operation={id:'original',status:'COMPLETE'};
 ui.setRequest((path)=>{if(path.includes('/actions/')){posts++;return new Promise((resolve,reject)=>resolvePost={resolve,reject});}gets++;return gets===1?deferred():Promise.resolve(fresh);});
 const read=ui.refresh(),send=ui.submit('generate',{confirm:true});await ui.submit('generate',{confirm:true});assert.equal(posts,1);
 assert.doesNotMatch(ui.quoteCard(),/data-action="generate"|data-action="prepare"/);
 const reopened=make();reopened.setRequest(async()=>initial);await reopened.submit('generate',{confirm:true});assert.equal(posts,1);assert.match(reopened.quoteCard(),/Verificando la acción enviada/);
 resolveGet(old);await read;assert.equal(ui.getState().review_revision,12);assert.equal(ui.getState().current_action.status,'SUBMITTED');
 // The delayed action response is older than the already received durable view.
 resolvePost.resolve({operation:{id:'original',status:'QUEUED'}});await send;assert.equal(ui.getState().operation.status,'COMPLETE');
 ui.setRequest(async()=>old);await ui.refresh();assert.equal(ui.getState().review_revision,12);
 // An HTTP timeout before acknowledgement retains intent across page reload.
 saved.clear();const timeout=make();timeout.setRequest(path=>{if(path.includes('/actions/')){posts++;throw Object.assign(Error('timeout'),{name:'AbortError'});}return Promise.resolve(initial);});
 await timeout.submit('generate',{confirm:true});assert.match(timeout.quoteCard(),/Verificando la acción enviada/);
 const reopenedTimeout=make();assert.match(reopenedTimeout.quoteCard(),/Verificando la acción enviada/);
 saved.clear();const rejected=make();rejected.setRequest(path=>{if(path.includes('/actions/'))throw Object.assign(Error('MINI_CURRENT_QUOTE_REQUIRED'),{status:409});return Promise.resolve(initial);});
 await rejected.submit('generate',{confirm:true});assert.doesNotMatch(rejected.quoteCard(),/Verificando la acción enviada/);
});
