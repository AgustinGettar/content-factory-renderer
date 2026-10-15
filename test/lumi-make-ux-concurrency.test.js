import test from 'node:test';
import assert from 'node:assert/strict';
import {MemoryReviewStore,ReviewService,newSession,sha256,reviewKey} from '../lib/telegram-review-v1/core.js';
import {MakeTransport,claimRequest,acknowledgeCommand,signRequest} from '../lib/telegram-review-v1/make-transport.js';
import {mountMakeTransportEndpoint} from '../lib/telegram-review-v1/make-endpoint.js';
const secret='offline-transport-secret-'.repeat(3),path='/lumi/telegram-review/make/v1';
const photo={artifact_id:'home',mime:'image/png',sha256:sha256('home'),size:4,bucket:'fixture',path:'home.png'};
const master={artifact_id:'master',mime:'video/mp4',sha256:sha256('master'),size:6,bucket:'fixture',path:'master.mp4',width:1080,height:1920,duration:41.125};
const nonce=id=>({timestamp:String(Math.floor(Date.now()/1000)),requestId:id,path,body:Buffer.from('{}')});
async function setup({mini=false}={}){
 const store=new MemoryReviewStore(),s=newSession({user_id:'1',chat_id:'1',message_id:138,cover:photo,legacy_menu:[[{text:'Old ideas',callback_data:'ideas'}]]});
 s.deliveries[photo.sha256]={telegram_file_id:'HOME',telegram_file_unique_id:'HOME_UNIQUE'};
 s.deliveries[master.sha256]={telegram_file_id:'MASTER',telegram_file_unique_id:'MASTER_UNIQUE',review_status:'APPROVED'};
 s.episodes.ep={episode_id:'ep',title:'Historical master',review_mode:'SUPERVISED',master,shots:[{shot_id:'shot',artifact:master,technical_qa:'PASS',creative_qa:'PASS'}],reviews:{[reviewKey('ep',null,master.sha256)]:{episode_id:'ep',artifact_sha:master.sha256,status:'APPROVED',human_status:'MASTER_HUMAN_APPROVED'}}};
 await store.create('1',s);
 const transport=new MakeTransport(),production={create:()=>assert.fail('no episode'),resume:()=>assert.fail('no generation')};
 const svc=new ReviewService({store,telegram:transport,production,loadBytes:()=>assert.fail('cached media only')});
 const message=c=>({message_id:138,chat:{id:1},caption:c.body.media.caption,reply_markup:c.body.reply_markup,...(c.body.media.type==='photo'?{photo:[{file_id:'HOME',file_unique_id:'HOME_UNIQUE'}]}:{video:{file_id:'MASTER',file_unique_id:'MASTER_UNIQUE',file_size:6}})});
 const ack=c=>acknowledgeCommand(store,'1','1',c.idempotency_key,message(c));
 const routes=new Map(),logs=[];
 mountMakeTransportEndpoint({get:()=>{},post:(p,h)=>routes.set(p,h)},{store,env:{LUMI_RUNTIME_ENV:'staging',LUMI_TELEGRAM_TRANSPORT_AUTHORITY:'MAKE',LUMI_TELEGRAM_REVIEW_TEST_USERS:'1',LUMI_TELEGRAM_CALLBACK_SECRET:secret,SUPABASE_URL:mini?'https://mofjhwathxzfnjapvvst.supabase.co':'https://offline.example.test'},validateOwner:async(u,c)=>u==='1'&&c==='1',production,log:e=>logs.push(e),loadBytes:()=>assert.fail('no upload')});
 const request=(body,id,signature)=>{const rawBody=Buffer.from(JSON.stringify(body)),signed={...nonce(id),body:rawBody};return {path,body,rawBody,headers:{'x-lumi-timestamp':signed.timestamp,'x-lumi-request-id':id,'x-lumi-signature':signature??signRequest(secret,signed)}};};
 const call=async(body,id,signature)=>{const res={code:200,status(c){this.code=c;return this;},json(value){this.value=value;return this;}};await routes.get(path)(request(body,id,signature),res);return res;};
 const menu=id=>({update_id:id,message:{message_id:1000+id,from:{id:1},chat:{id:1},text:'/menu'}});
 const click=async(c,action,id='click')=>{const s=(await store.get('1')).state;const button=c.body.reply_markup.inline_keyboard.flat().find(b=>s.tokens[b.callback_data.slice(3)]?.action===action);assert.ok(button,action);return {id,from:{id:1},message:message(c),data:button.callback_data};};
 return {store,svc,transport,production,ack,message,call,menu,click,logs};
}
test('MAKE_CONFLICT: old plain-message route fails at the missing staging channels table',async t=>{
 const f=await setup();let queries=[];
 t.mock.method(globalThis,'fetch',async url=>{queries.push(new URL(url).pathname);return queries.length===1?Response.json([{channel_id:1}]):Response.json({code:'PGRST205'},{status:404});});
 const body=f.menu(830558974);body.message.text='LUMI-APP';body.message.chat.type='private';
 const r=await f.call(body,'failed-real-shape');assert.equal(r.code,409);assert.equal(r.value.error,'legacy_query_failed');
 assert.deepEqual(queries,['/rest/v1/cf_bot_admins','/rest/v1/channels']);
 assert.equal(r.value.provider_calls,0);assert.equal((await f.store.get('1')).state.delivery,null);
});
test('MINI_APP_INDEPENDENCE: plain chat opens studio without legacy DB, panel writes or delivery ACK',async t=>{
 const f=await setup({mini:true});t.mock.method(globalThis,'fetch',()=>assert.fail('no legacy database'));
 const row=await f.store.get('1');row.state.delivery={status:'EMITTING',command:{idempotency_key:'ambiguous-original'}};
 await f.store.cas('1',row.revision,row.state);const before=await f.store.get('1');
 for(const [i,text] of ['LUMI-APP','/start','/menu','/produccion'].entries()){
  const body=f.menu(800+i);body.message.text=text;const r=await f.call(body,'studio-'+i);
  assert.equal(r.code,200);assert.equal(r.value.status,'MINI_APP_ENTRYPOINT');assert.equal(r.value.provider_calls,0);
  assert.equal(r.value.actions.length,1);const a=r.value.actions[0],b=JSON.parse(a.body_json);
  assert.equal(a.method,'sendMessage');assert.equal(a.track_review,false);assert.equal(a.track_menu,false);
  assert.equal(b.message_id,undefined);assert.equal(b.reply_markup.inline_keyboard[0][0].web_app.url,'https://content-factory-av2-staging.onrender.com/lumi/studio');
  const duplicate=await f.call(body,'duplicate-'+i);assert.equal(duplicate.value.status,'DUPLICATE_REQUEST');assert.deepEqual(duplicate.value.actions,[]);
 }
 const after=await f.store.get('1');assert.deepEqual(after.state.delivery,before.state.delivery);assert.equal(after.state.message_id,before.state.message_id);
 const unauthorized=await f.call(f.menu(999),'bad-signature','invalid');assert.equal(unauthorized.code,401);
});
test('distinct nonce claims recover CAS contention; same nonce remains rejected',async()=>{
 const f=await setup();const results=await Promise.allSettled([claimRequest(f.store,'1',nonce('ack')),claimRequest(f.store,'1',nonce('menu'))]);
 assert.ok(results.every(x=>x.status==='fulfilled'));assert.equal(Object.keys((await f.store.get('1')).state.make_requests).length,2);
 await assert.rejects(claimRequest(f.store,'1',nonce('ack')),/replayed_request/);
});

test('HTTP_TIMEOUT: a cold-start request past the Make response window cannot leave an orphan outbox',async()=>{
 const f=await setup(),routes=new Map(),body=f.menu(91),rawBody=Buffer.from(JSON.stringify(body));
 mountMakeTransportEndpoint({get(){},post:(p,h)=>routes.set(p,h)},{store:f.store,production:f.production,
  env:{LUMI_RUNTIME_ENV:'staging',LUMI_TELEGRAM_TRANSPORT_AUTHORITY:'MAKE',LUMI_TELEGRAM_REVIEW_TEST_USERS:'1',LUMI_TELEGRAM_CALLBACK_SECRET:secret}});
 const before=await f.store.get('1'),signed={method:'POST',path,body:rawBody,requestId:'late-cold-start',timestamp:String(Math.floor(Date.now()/1000)-41)};
 const res={status(c){this.code=c;return this;},json(v){this.value=v;return this;}};
 await routes.get(path)({body,rawBody,path,headers:{'x-lumi-timestamp':signed.timestamp,'x-lumi-request-id':signed.requestId,
  'x-lumi-signature':signRequest(secret,signed)}},res);
 assert.equal(res.value.status,'TRANSPORT_REQUEST_EXPIRED');assert.deepEqual(res.value.commands,[]);
 assert.deepEqual(await f.store.get('1'),before);
});

async function approvedQ41Fixture({legacyTrailingSpace=false}={}){
 const f=await setup(),row=await f.store.get('1');row.state.message_id=148;
 row.state.q41_first_image={status:'APPROVED_PAUSED',artifact:{...photo,width:1520,height:2688},
  technical_qa:{ok:true},visual_qa:'REQUIRES_HUMAN_VISUAL_REVIEW',review:{status:'APPROVED',artifact_sha:photo.sha256}};
 await f.store.cas('1',row.revision,row.state);
 let c=(await f.svc.show('1','1',{kind:'q41_review'})).commands[0];
 if(legacyTrailingSpace){const r=await f.store.get('1');r.state.delivery.command.body.media.caption=c.body.media.caption.replace(/ +$/u,'')+' ';
  await f.store.cas('1',r.revision,r.state);c=(await f.store.get('1')).state.delivery.command;}
 const message={message_id:148,chat:{id:1},caption:c.body.media.caption.replace(/ +$/u,''),
  reply_markup:c.body.reply_markup,photo:[{file_id:'HOME',file_unique_id:'HOME_UNIQUE'}]};
 return {...f,c,receipt:message};
}
test('approved q41 renders no trailing space before Continue production',async()=>{
 const f=await approvedQ41Fixture();assert.equal(f.c.body.media.caption.endsWith(' '),false);
 assert.equal(f.c.body.reply_markup.inline_keyboard[0][0].text,'Continuar producción');
});
test('real approval receipt recovers legacy trailing-space ACK without editing or repeating callback',async()=>{
 const f=await approvedQ41Fixture({legacyTrailingSpace:true}),before=(await f.store.get('1')).state;
 const body={op:'ack',user_id:'1',chat_id:'1',message_id:148,command_id:f.c.idempotency_key,
  telegram_result:{...f.receipt,caption:undefined,caption_sha:sha256(f.receipt.caption)}};
 const r=await f.call(body,'q41-ack-recovery');assert.equal(r.code,200);assert.equal(r.value.ok,true);
 const after=(await f.store.get('1')).state;assert.equal(after.delivery.status,'DELIVERED');
 assert.deepEqual(after.q41_first_image,before.q41_first_image);assert.deepEqual(after.episodes,before.episodes);
 assert.equal(after.message_id,148);assert.equal(f.transport.commands.length,0);
 assert.equal((await f.call(body,'q41-ack-duplicate')).value.status,'ACK_ALREADY_APPLIED');
 assert.equal((await f.call(body,'q41-ack-recovery')).value.classification,'REPLAY_REJECTED');
});
test('q41 receipt normalization preserves semantic, media, owner and command checks',async()=>{
 const f=await approvedQ41Fixture({legacyTrailingSpace:true});
 for(const change of [{caption:f.receipt.caption.replace('APPROVED','REJECTED')},
  {caption:f.receipt.caption.replace('Primera imagen','Primera  imagen')},{caption:f.receipt.caption+'\n'},
  {caption:undefined,caption_sha:'0'.repeat(64)},
  {photo:[{file_id:'WRONG',file_unique_id:'WRONG_UNIQUE'}]},{message_id:149},{chat:{id:2}}]){
  await assert.rejects(acknowledgeCommand(f.store,'1','1',f.c.idempotency_key,{...f.receipt,...change}));
 }
 await assert.rejects(acknowledgeCommand(f.store,'1','1','wrong-command',f.receipt),/identity/);
 const row=await f.store.get('1');row.state.delivery.screen.kind='menu';await f.store.cas('1',row.revision,row.state);
 await assert.rejects(acknowledgeCommand(f.store,'1','1',f.c.idempotency_key,f.receipt),/caption/);
 assert.equal((await f.store.get('1')).state.delivery.status,'EMITTING');
});
test('legacy q41 ACK revalidates after CAS contention and never emits Telegram commands',async()=>{
 const f=await approvedQ41Fixture({legacyTrailingSpace:true}),cas=f.store.cas.bind(f.store);let raced=false;
 f.store.cas=async(u,r,s)=>{if(!raced&&s.delivery.status==='DELIVERED'){raced=true;await claimRequest(f.store,'1',nonce('concurrent-read'));}return cas(u,r,s);};
 await acknowledgeCommand(f.store,'1','1',f.c.idempotency_key,f.receipt);
 const s=(await f.store.get('1')).state;assert.equal(s.delivery.status,'DELIVERED');assert.ok(s.make_requests['concurrent-read']);
 assert.equal(f.transport.commands.length,0);assert.equal(s.q41_first_image.review.status,'APPROVED');
});
test('outbox is atomic: every persisted EMITTING state includes exact command',async()=>{
 const f=await setup(),cas=f.store.cas.bind(f.store);let writes=0;
 f.store.cas=async(u,r,s)=>{if(s.delivery?.status==='EMITTING'){writes++;assert.equal(s.delivery.command.message_id,138);assert.equal(s.delivery.command.review_version,r+1);}return cas(u,r,s);};
 await f.svc.show('1','1',{kind:'menu'});assert.equal(writes,1);
});
test('incident sequence: confirmed edit, concurrent menu nonce, ACK claim retry and delivery merge',async()=>{
 const f=await setup(),c=(await f.svc.show('1','1',{kind:'menu'})).commands[0],original=f.store.cas.bind(f.store);
 let claimRace=false,ackRace=false,telegramEdits=1;
 f.store.cas=async(u,r,s)=>{
  if(!claimRace&&s.make_requests?.ack){claimRace=true;await claimRequest(f.store,'1',nonce('menu'));}
  else if(!ackRace&&s.delivery.status==='DELIVERED'){ackRace=true;await claimRequest(f.store,'1',nonce('other'));}
  return original(u,r,s);
 };
 await claimRequest(f.store,'1',nonce('ack'));await f.ack(c);
 const s=(await f.store.get('1')).state;
 assert.equal(s.delivery.status,'DELIVERED');assert.ok(s.make_requests.ack);assert.ok(s.make_requests.menu);assert.ok(s.make_requests.other);assert.equal(telegramEdits,1);
 assert.equal((await f.svc.show('1','1',{kind:'menu'})).commands.length,1);
});
test('bounded ACK retries exhaust without masking real CAS conflict',async()=>{
 const f=await setup(),c=(await f.svc.show('1','1',{kind:'menu'})).commands[0];let attempts=0;
 f.store.cas=async()=>{attempts++;throw Error('concurrent_update');};
 await assert.rejects(f.ack(c),/concurrent_update/);assert.equal(attempts,6);assert.equal((await f.store.get('1')).state.delivery.status,'EMITTING');
});
test('ACK retry revalidates command identity after another writer changes it',async()=>{
 const f=await setup(),c=(await f.svc.show('1','1',{kind:'menu'})).commands[0],cas=f.store.cas.bind(f.store);let changed=false;
 f.store.cas=async(u,r,s)=>{if(!changed){changed=true;const current=await f.store.get(u);current.state.delivery.command.idempotency_key='different';await cas(u,current.revision,current.state);}return cas(u,r,s);};
 await assert.rejects(f.ack(c),/transport_ack_identity_mismatch/);assert.equal((await f.store.get('1')).state.delivery.status,'EMITTING');
});
test('restart reconciles exact Telegram receipt without another edit; duplicate ACK validates identity',async()=>{
 const f=await setup(),c=(await f.svc.show('1','1',{kind:'menu'})).commands[0];const restarted=new MemoryReviewStore();restarted.rows.set('1',await f.store.get('1'));
 await acknowledgeCommand(restarted,'1','1',c.idempotency_key,f.message(c));const r=await acknowledgeCommand(restarted,'1','1',c.idempotency_key,f.message(c));assert.equal(r.status,'ACK_ALREADY_APPLIED');
 await assert.rejects(acknowledgeCommand(restarted,'1','1',c.idempotency_key,{...f.message(c),message_id:139}),/identity/);
 assert.equal(f.transport.commands.length,0);
});
test('pending /menu is explicit nonexecuted outcome; exact signed nonce cannot be reused',async()=>{
 const f=await setup();await f.svc.show('1','1',{kind:'menu'});const r=await f.call(f.menu(1),'pending');assert.equal(r.code,200);assert.equal(r.value.status,'DELIVERY_PENDING');assert.equal(r.value.executed,false);assert.deepEqual(r.value.actions,[]);
 const replay=await f.call(f.menu(1),'pending');assert.equal(replay.code,409);assert.equal(replay.value.classification,'REPLAY_REJECTED');
});
test('duplicate Telegram update with fresh nonce produces no second edit',async()=>{
 const f=await setup(),body=f.menu(1),first=await f.call(body,'first');await f.ack(first.value.commands[0]);
 const duplicate=await f.call(body,'second');assert.equal(duplicate.value.status,'DUPLICATE_REQUEST');assert.deepEqual(duplicate.value.commands,[]);assert.ok((await f.store.get('1')).state.make_requests.second);
 const conflict=await f.call({...body,message:{...body.message,text:'/start'}},'tampered-update');assert.equal(conflict.code,409);assert.equal(conflict.value.error,'update_identity_conflict');
});
test('unknown backend failure stays HTTP409 and logs only sanitized diagnostic fields',async()=>{
 const f=await setup();f.store.get=async()=>{throw Error('credential=DO_NOT_LOG');};const r=await f.call(f.menu(1),'error');assert.equal(r.code,409);assert.equal(r.value.classification,'UNEXPECTED_BACKEND_ERROR');assert.equal(r.value.error,'unexpected_backend_error');assert.doesNotMatch(JSON.stringify(f.logs),/DO_NOT_LOG|credential/);
});
test('forged HMAC and callback are rejected without edits',async()=>{
 const f=await setup();assert.equal((await f.call(f.menu(1),'bad-hmac','0'.repeat(64))).code,401);
 const c=(await f.svc.show('1','1',{kind:'menu'})).commands[0];await f.ack(c);const cb={id:'fake',from:{id:1},message:f.message(c),data:'lr:'+'0'.repeat(24)};
 const r=await f.call({callback_query:cb},'forged-token');assert.equal(r.code,409);assert.equal(r.value.error,'invalid_callback');assert.equal((await f.store.get('1')).state.screen.kind,'menu');
});
test('double click same callback is acknowledged once without a second panel edit',async()=>{
 const f=await setup(),c=(await f.svc.show('1','1',{kind:'menu'})).commands[0];await f.ack(c);const cb=await f.click(c,'create_v2_ideas');const first=await f.svc.callback(cb);await f.ack(first.commands[0]);
 const duplicate=await f.svc.callback(cb);assert.equal(duplicate.status,'DUPLICATE_REQUEST');assert.deepEqual(duplicate.commands,[]);
});
test('crash after callback reservation stays fail closed, no repeated external action',async()=>{
 const f=await setup(),c=(await f.svc.show('1','1',{kind:'menu'})).commands[0];await f.ack(c);const cb=await f.click(c,'create_v2_ideas');const row=await f.store.get('1');row.state.pending_callback={id:cb.id,status:'PENDING'};await f.store.cas('1',row.revision,row.state);
 await assert.rejects(f.svc.callback(cb),/reconciliation_required/);assert.equal(f.transport.commands.length,0);
});
test('callback receipt recovers Telegram-already-edited with strict metadata and no re-edit',async()=>{
 const f=await setup(),c=(await f.svc.show('1','1',{kind:'menu'})).commands[0],cb=await f.click(c,'library');const before=JSON.stringify((await f.store.get('1')).state.episodes);
 await assert.rejects(f.svc.reconcile({...cb,message:{...cb.message,caption:'wrong'}}),/caption/);
 assert.equal(await f.svc.reconcile(cb),true);assert.equal(f.transport.commands.length,0);assert.equal(JSON.stringify((await f.store.get('1')).state.episodes),before);
});
test('four HOME actions and read-only navigation preserve historical master and panel',async()=>{
 const f=await setup(),before=JSON.stringify((await f.store.get('1')).state.episodes);let c=(await f.svc.show('1','1',{kind:'menu'})).commands[0];await f.ack(c);
 assert.deepEqual(c.body.reply_markup.inline_keyboard.flat().map(b=>b.text),['🎬 Crear video','📁 Mis videos','📊 Producción','⚙️ Ajustes']);
 for(const [kind,episode_id] of [['create_v2_ideas'],['create_v2_budget'],['menu'],['current'],['progress','ep'],['shot','ep'],['master','ep'],['download','ep'],['settings'],['menu']]){
  c=(await f.svc.show('1','1',{kind,episode_id})).commands[0];assert.equal(c.message_id,138);assert.equal(c.method,'editMessageMedia');assert.equal(c.upload_required,false);await f.ack(c);
 }
 const s=(await f.store.get('1')).state;assert.equal(JSON.stringify(s.episodes),before);assert.equal(s.deliveries[master.sha256].telegram_file_id,'MASTER');assert.equal(s.deliveries[master.sha256].review_status,'APPROVED');assert.equal(Object.keys(s.episodes).length,1);
});
test('old literal navigation callback aliases stay within isolated router',async()=>{
 for(const [literal,kind]of [['ideas','create_v2_ideas'],['reviews:0','current'],['settings','settings'],['calendar','settings']]){
  const f=await setup(),c=(await f.svc.show('1','1',{kind:'menu'})).commands[0];await f.ack(c);
  const r=await f.call({callback_query:{id:literal,from:{id:1},message:f.message(c),data:literal}},'legacy-'+literal);
  assert.equal(r.code,200);assert.equal((await f.store.get('1')).state.screen.kind,kind);assert.equal(r.value.commands.filter(c=>c.method==='editMessageMedia').length,1);
 }
});
test('second click from previous keyboard during next delivery is stale, not a fatal 409',async()=>{
 const f=await setup(),c=(await f.svc.show('1','1',{kind:'menu'})).commands[0];await f.ack(c);const cb=await f.click(c,'create_v2_ideas');
 const first=await f.call({callback_query:cb},'click-first');assert.equal(first.code,200);
 const second=await f.call({callback_query:{...cb,id:'second-click'}},'click-second');assert.equal(second.code,200);assert.equal(second.value.status,'STALE_CALLBACK');assert.ok(second.value.actions.every(a=>a.method==='answerCallbackQuery'));assert.equal((await f.store.get('1')).state.delivery.status,'EMITTING');
});
test('menu cannot overwrite a callback reservation after crash',async()=>{
 const f=await setup(),row=await f.store.get('1');row.state.pending_callback={id:'reserved',status:'PENDING'};await f.store.cas('1',row.revision,row.state);
 const r=await f.call(f.menu(1),'menu-after-crash');assert.equal(r.value.status,'DELIVERY_PENDING');assert.deepEqual(r.value.commands,[]);assert.equal((await f.store.get('1')).state.pending_callback.id,'reserved');
});
test('old legacy generation callbacks never enter a production RPC or return AI work',async()=>{
 for(const data of ['choose:old:1','manualconfirm','retry:99:3','approve:99:3','new']){
  const f=await setup();const r=await f.call({callback_query:{id:data,data,from:{id:1},message:{message_id:138,chat:{id:1}}}},'legacy-blocked');
  assert.equal(r.value.status,'STALE_CALLBACK');assert.equal(r.value.blocked,true);assert.ok(r.value.actions.every(a=>a.method==='answerCallbackQuery'));assert.equal(r.value.ai,undefined);
 }
});
test('ambiguous external outcome cannot be automatically cleared by a callback',async()=>{
 const f=await setup(),c=(await f.svc.show('1','1',{kind:'menu'})).commands[0],cb=await f.click(c,'library');const row=await f.store.get('1');row.state.delivery.status='UNKNOWN';await f.store.cas('1',row.revision,row.state);
 await assert.rejects(f.svc.reconcile(cb),/transport_ack_state_mismatch/);assert.equal((await f.store.get('1')).state.delivery.status,'UNKNOWN');assert.equal(f.transport.commands.length,0);
});
// Offline evaluator for only the unchanged Make functions used by the ACK body.
// It validates the proposed mapping's JSON/metadata, not Make's live execution.
function evaluateAckTemplate(source,context){
 let i=0;const functions={if:(a,b,c)=>a?b:c,join:(a,b)=>a.map(x=>x??'').join(b),add:(a,...v)=>[...a,...v],decodeURL:decodeURIComponent,sha256,
  ifempty:(a,b)=>a===undefined||a===null||a===''?b:a,get:(a,k)=>a?.[k],last:a=>a?.at(-1)};
 function value(){while(/\s/.test(source[i]||'')&&i<source.length)i++;
  if(source[i]==='"'){const start=i++;while(i<source.length&&(source[i]!=='"'||source[i-1]==='\\'))i++;return JSON.parse(source.slice(start,++i));}
  const start=i;while(i<source.length&&!/[();\s]/.test(source[i]))i++;const key=source.slice(start,i);
  if(source[i]==='('){i++;const args=[];while(source[i]!==')'){args.push(value());while(source[i]===' '||source[i]===';')i++;}i++;assert.ok(functions[key],key);return functions[key](...args);}
  if(key==='emptyarray')return [];if(key==='emptystring')return '';if(/^\d+$/.test(key))return Number(key);
  return key.split('.').reduce((v,k)=>v?.[k],context);
 }
 const result=value();assert.equal(source.slice(i).trim(),'');return result;
}
test('proposed module21 ACK body preserves photo/video and includes authenticated audio identity',async()=>{
 const {readFile}=await import('node:fs/promises');const body=(await readFile(new URL('../docs/lumi-make-ux-v2/make-module-21-body.iml',import.meta.url),'utf8')).trim().slice(2,-2);
 for(const type of ['photo','video','audio']){
  const f=await setup();let screen={kind:type==='video'?'master':'menu',episode_id:'ep'};
  if(type==='audio'){
   const r=await f.store.get('1'),a={...photo,mime:'audio/mpeg',artifact_id:'fernanda',path:'fernanda.mp3',sha256:sha256('voice'),size:5};
   r.state.episodes.ep.artifacts={fernanda:a};r.state.episodes.ep.review_requests={voice:{review_request_id:'voice',artifact_id:'fernanda',artifact_sha:a.sha256,status:'PENDING',allowed_actions:['APPROVE','REJECT'],stage_id:'TTS',review_version:1}};
   r.state.deliveries[a.sha256]={telegram_file_id:'FERNANDA',telegram_file_unique_id:'FERNANDA_UNIQUE'};await f.store.cas('1',r.revision,r.state);screen={kind:'audio',episode_id:'ep',request_id:'voice'};
  }
  const c=(await f.svc.show('1','1',screen)).commands[0],message=type==='audio'?{message_id:138,chat:{id:1},caption:c.body.media.caption,audio:{file_id:'FERNANDA',file_unique_id:'FERNANDA_UNIQUE',file_size:5}}:f.message(c);
  const raw=evaluateAckTemplate(body,{'10':{track_review:true,user:'1',chat:'1',command_id:c.idempotency_key},'12':{body:{result:message}}}),parsed=JSON.parse(raw);
  assert.equal(parsed.telegram_result.caption_sha,sha256(c.body.media.caption));assert.equal(parsed.command_id,c.idempotency_key);
  assert.equal((await acknowledgeCommand(f.store,'1','1',parsed.command_id,parsed.telegram_result)).ok,true);
  if(type==='audio')assert.equal(parsed.telegram_result.audio.file_size,5);
 }
 const legacy=JSON.parse(evaluateAckTemplate(body,{'10':{track_review:false,user:'1',chat:'1'},'12':{body:{result:{message_id:138}}}}));assert.deepEqual(legacy,{user:'1',chat:'1',message_id:138});
});
test('exhausted nonce CAS remains a real HTTP409 with request and checkpoint evidence',async()=>{
 const f=await setup();f.store.cas=async()=>{throw Error('concurrent_update');};const r=await f.call(f.menu(1),'exhausted');assert.equal(r.code,409);assert.equal(r.value.classification,'CAS_CONFLICT');assert.equal(r.value.request_id,'exhausted');assert.equal(f.logs[0].idempotency_state,'NONCE_NOT_RECORDED');
});
test('repeated real-route shape /menu -> Create -> HOME -> Production -> Review -> Back stays single-panel',async()=>{
 const f=await setup(),before=JSON.stringify((await f.store.get('1')).state.episodes);let id=100;
 const deliver=async response=>{assert.equal(response.code,200);const edits=response.value.commands.filter(c=>c.method==='editMessageMedia');assert.equal(edits.length,1);const c=edits[0];assert.equal(c.message_id,138);await f.ack(c);return c;};
 for(let cycle=0;cycle<3;cycle++){
  let c=await deliver(await f.call(f.menu(++id),'menu-'+id));
  for(const action of ['create_v2_ideas','menu','current','progress','shot','back','menu']){
   const cb=await f.click(c,action,'nav-'+(++id));c=await deliver(await f.call({update_id:id,callback_query:cb},'request-'+id));
  }
 }
 assert.equal(JSON.stringify((await f.store.get('1')).state.episodes),before);assert.equal((await f.store.get('1')).state.panel_content_type,'photo');
});

async function resumeFixture(){
 const f=await setup(),c=(await f.svc.show('1','1',{kind:'menu'})).commands[0];await f.ack(c);
 const row=await f.store.get('1');row.state.tokens['a'.repeat(24)]={action:'resume',episode_id:'ep',next_action:'planning'};
 row.state.episodes.ep.next_action='planning';row.state.episodes.ep.budget_usd=5;
 await f.store.cas('1',row.revision,row.state);
 return {...f,cb:{id:'continue-first',from:{id:1},message:f.message(c),data:'lr:'+'a'.repeat(24)}};
}
test('resume claim rereads after nonce CAS race, preserving budget and approvals without replay',async()=>{
 const f=await resumeFixture(),cas=f.store.cas.bind(f.store);let raced=false,calls=0;
 f.production.resume=async()=>{calls++;};
 const before=(await f.store.get('1')).state.episodes;
 f.store.cas=async(u,r,s)=>{if(!raced&&s.pending_callback){raced=true;await claimRequest(f.store,'1',nonce('concurrent-nonce'));}return cas(u,r,s);};
 const response=await f.call({callback_query:f.cb},'continue-cas');
 assert.equal(response.code,200);assert.equal(calls,1);assert.equal(response.value.commands.filter(c=>c.method==='editMessageMedia').length,1);
 assert.equal(response.value.commands.filter(c=>c.method==='answerCallbackQuery').length,1);
 await f.ack(response.value.commands.find(c=>c.method==='editMessageMedia'));
 assert.deepEqual((await f.store.get('1')).state.episodes,before);
 assert.ok((await f.store.get('1')).state.make_requests['concurrent-nonce']);
});
test('second resume during a claimed command is pending HTTP200 without dispatch or second edit',async()=>{
 const f=await resumeFixture();let release,entered,calls=0;
 const waiting=new Promise(r=>release=r),started=new Promise(r=>entered=r);
 f.production.resume=async()=>{calls++;entered();await waiting;};
 const first=f.call({callback_query:f.cb},'continue-owner');await started;
 const second=await f.call({callback_query:{...f.cb,id:'continue-second'}},'continue-contender');
 release();const completed=await first;
 assert.equal(second.code,200);assert.equal(second.value.status,'DELIVERY_PENDING');assert.equal(second.value.executed,false);
 assert.equal(second.value.provider_calls,0);assert.deepEqual(second.value.commands,[]);assert.equal(calls,1);
 assert.equal(completed.code,200);await f.ack(completed.value.commands.find(c=>c.method==='editMessageMedia'));
});
test('resume failure after dispatch remains real HTTP409 and crash cannot replay it',async()=>{
 const f=await resumeFixture();let calls=0;
 f.production.resume=async()=>{calls++;throw Error('telegram_delivery_reconciliation_required');};
 const first=await f.call({callback_query:f.cb},'continue-ambiguous');assert.equal(first.code,409);
 assert.equal(first.value.recovery_required,true);assert.equal(first.value.provider_calls,null);
 const second=await f.call({callback_query:{...f.cb,id:'continue-after-crash'}},'continue-restart');
 assert.equal(second.code,200);assert.equal(second.value.status,'DELIVERY_PENDING');assert.equal(calls,1);
});
test('resume claim retry revalidates panel identity instead of dispatching from stale snapshot',async()=>{
 const f=await resumeFixture(),cas=f.store.cas.bind(f.store);let raced=false,calls=0;
 f.production.resume=async()=>calls++;
 f.store.cas=async(u,r,s)=>{if(!raced&&s.pending_callback){raced=true;const row=await f.store.get(u);row.state.message_id=149;await cas(u,row.revision,row.state);}return cas(u,r,s);};
 const response=await f.call({callback_query:f.cb},'continue-changed-panel');
 assert.equal(response.code,409);assert.equal(calls,0);assert.equal((await f.store.get('1')).state.message_id,149);
});
test('exhausted callback claim contention remains CAS_CONFLICT without production effects',async()=>{
 const f=await resumeFixture(),cas=f.store.cas.bind(f.store);let claims=0,calls=0;
 f.production.resume=async()=>calls++;
 f.store.cas=async(u,r,s)=>{if(s.pending_callback){claims++;await claimRequest(f.store,'1',nonce('claim-race-'+claims));}return cas(u,r,s);};
 const response=await f.call({callback_query:f.cb},'continue-claim-exhausted');
 assert.equal(response.code,409);assert.equal(response.value.classification,'CAS_CONFLICT');
 assert.equal(response.value.provider_calls,0);assert.equal(claims,6);assert.equal(calls,0);
 assert.equal((await f.store.get('1')).state.pending_callback,null);
});
