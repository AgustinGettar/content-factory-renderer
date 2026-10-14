import test from 'node:test';
import {authenticateFirstImageCallback,ControlledV2Authorization,FIRST_IMAGE_EPISODE,verifySupervisedPolicy} from '../lib/lumi-v2-activation-context.js';
import {SupabaseReviewStore} from '../lib/telegram-review-v1/core.js';
import assert from 'node:assert/strict';
import {MemoryReviewStore,ReviewService,newSession,sha256,reviewKey} from '../lib/telegram-review-v1/core.js';
import {MakeTransport,claimRequest,acknowledgeCommand,signRequest} from '../lib/telegram-review-v1/make-transport.js';
import {mountMakeTransportEndpoint} from '../lib/telegram-review-v1/make-endpoint.js';
const secret='offline-transport-secret-'.repeat(3),path='/lumi/telegram-review/make/v1';
const photo={artifact_id:'home',mime:'image/png',sha256:sha256('home'),size:4,bucket:'fixture',path:'home.png'};
const master={artifact_id:'master',mime:'video/mp4',sha256:sha256('master'),size:6,bucket:'fixture',path:'master.mp4',width:1080,height:1920,duration:41.125};
const nonce=id=>({method:'POST',timestamp:String(Math.floor(Date.now()/1000)),requestId:id,path,body:Buffer.from('{}')});
async function setup(){
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
 mountMakeTransportEndpoint({get:()=>{},post:(p,h)=>routes.set(p,h)},{store,env:{LUMI_RUNTIME_ENV:'staging',LUMI_TELEGRAM_TRANSPORT_AUTHORITY:'MAKE',LUMI_TELEGRAM_REVIEW_TEST_USERS:'1',LUMI_TELEGRAM_CALLBACK_SECRET:secret},production,log:e=>logs.push(e),loadBytes:()=>assert.fail('no upload')});
 const request=(body,id,signature)=>{const rawBody=Buffer.from(JSON.stringify(body)),signed={...nonce(id),body:rawBody};return {path,body,rawBody,headers:{'x-lumi-timestamp':signed.timestamp,'x-lumi-request-id':id,'x-lumi-signature':signature??signRequest(secret,signed)}};};
 const call=async(body,id,signature)=>{const res={code:200,status(c){this.code=c;return this;},json(value){this.value=value;return this;}};await routes.get(path)(request(body,id,signature),res);return res;};
 const menu=id=>({update_id:id,message:{message_id:1000+id,from:{id:1},chat:{id:1},text:'/menu'}});
 const click=async(c,action,id='click')=>{const s=(await store.get('1')).state;const button=c.body.reply_markup.inline_keyboard.flat().find(b=>s.tokens[b.callback_data.slice(3)]?.action===action);assert.ok(button,action);return {id,from:{id:1},message:message(c),data:button.callback_data};};
 return {store,svc,transport,ack,message,call,menu,click,logs};
}

const recover={op:'RECOVER_TELEGRAM_PANEL',user_id:'1',chat_id:'1'};
const receipt=(f,c,id=900)=>({...f.message(c),message_id:id});
const prepare=async f=>{const r=await f.call(recover,'recover');assert.equal(r.code,200);return r.value.commands[0];};
const finish=async(f,c,id=900)=>{const r=await f.call({op:'ack',user_id:'1',chat_id:'1',message_id:c.message_id,command_id:c.idempotency_key,telegram_result:receipt(f,c,id)},'ack:'+Math.floor(Math.random()*1e12));assert.equal(r.code,200);return r;};
async function staleNavigation(){
 const f=await setup();
 const old=(await f.svc.show('1','1',{kind:'progress',episode_id:'ep'})).commands[0];await f.ack(old);
 const cb=await f.click(old,'menu','stale-home');cb.message.edit_date=Math.floor(Date.now()/1000)-60;
 const row=await f.store.get('1');row.state.episodes.ep.title='Updated progress';await f.store.cas('1',row.revision,row.state);
 const pending=(await f.svc.show('1','1',{kind:'progress',episode_id:'ep'})).commands[0];
 assert.notEqual(pending.body.media.caption,cb.message.caption);
 return {...f,cb,pending,before:(await f.store.get('1')).state};
}
test('stale HOME recovers same panel caption without ACKing or resending ambiguous media',async()=>{
 const f=await staleNavigation(),r=await f.call({update_id:101,callback_query:f.cb},'stale-home');
 assert.equal(r.code,200);assert.equal(r.value.status,'NAVIGATION_RECOVERY_PENDING');
 assert.equal(r.value.actions.length,1);assert.equal(r.value.actions[0].method,'editMessageCaption');
 const wire=JSON.parse(r.value.actions[0].body_json);assert.equal(wire.message_id,138);assert.equal(wire.media,undefined);
 const s=(await f.store.get('1')).state,h=s.delivery_history[f.pending.idempotency_key];
 assert.deepEqual(h.command,f.pending);assert.equal(h.status,'EMITTING');assert.equal(h.ack_state,'UNVERIFIED');
 assert.equal(h.observation.callback_query_id,f.cb.id);assert.deepEqual(s.episodes,f.before.episodes);assert.deepEqual(s.deliveries,f.before.deliveries);
 assert.equal(s.delivery.status,'EMITTING');assert.equal(s.message_id,138);assert.equal(s.pending_callback,f.before.pending_callback);
 const next=r.value.commands[0];await assert.rejects(f.ack(f.pending),/transport_ack_identity_mismatch/);
 // A separate instance recovers only the exact new Telegram receipt.
 await acknowledgeCommand(f.store,'1','1',next.idempotency_key,f.message(next));
 assert.equal((await f.store.get('1')).state.delivery.status,'DELIVERED');
 assert.equal((await f.store.get('1')).state.delivery_history[f.pending.idempotency_key].ack_state,'UNVERIFIED');
 const current=await f.click(next,'current','new-current');const nav=await f.svc.callback(current);
 assert.equal(nav.commands.length,1);assert.equal(nav.commands[0].message_id,138);
});
test('navigation recovery duplicate, concurrency and restart produce one new caption command',async()=>{
 const f=await staleNavigation(),rs=await Promise.all([f.svc.recoverStaleNavigation(f.cb),f.svc.recoverStaleNavigation(f.cb)]);
 assert.equal(rs.flatMap(r=>r.commands).length,1);
 const restarted=new ReviewService({store:f.store,telegram:new MakeTransport(),production:{resume:()=>assert.fail('no production')}});
 assert.equal((await restarted.recoverStaleNavigation(f.cb)).commands.length,0);
});
test('operator recovery requires owner HMAC, exact revision and exact pending command',async()=>{
 const f=await staleNavigation(),row=await f.store.get('1');
 const body={op:'RECOVER_STALE_PANEL_NAVIGATION',user_id:'1',chat_id:'1',expected_revision:row.revision,
   command_id:f.pending.idempotency_key,callback_query:f.cb,evidence:{execution_id:'b'.repeat(32),update_id:101}};
 assert.equal((await f.call(body,'forged','0'.repeat(64))).code,401);
 const bad=await f.call({...body,command_id:'0'.repeat(64)},'wrong-command');assert.equal(bad.code,409);
 body.expected_revision=(await f.store.get('1')).revision;
 const ok=await f.call(body,'recovery');assert.equal(ok.value.status,'NAVIGATION_RECOVERY_PENDING');
 assert.equal((await f.store.get('1')).state.delivery_history[f.pending.idempotency_key].observation.evidence.execution_id,'b'.repeat(32));
});
for(const [name,mutate] of [
 ['economic callback',(f)=>{const key=f.cb.data.slice(3);f.before.tokens[key]={action:'q41_video_authorize'};}],
 ['missing keyboard',f=>{delete f.cb.message.reply_markup;}],
 ['different media',f=>{f.cb.message.photo[0].file_unique_id='OTHER';}],
 ['newer remote edit',f=>{f.cb.message.edit_date=Math.floor(Date.now()/1000)+60;}],
 ['production effect pending',f=>{f.before.pending_callback={id:'provider-dispatch'};}],
 ['different pending artifact',f=>{f.before.delivery.command.artifact_sha='a'.repeat(64);}]
])test('navigation recovery rejects '+name,async()=>{
 const f=await staleNavigation();mutate(f);let row=await f.store.get('1');await f.store.cas('1',row.revision,f.before);
 const before=await f.store.get('1');await assert.rejects(f.svc.recoverStaleNavigation(f.cb),/stale_navigation_evidence_required/);
 assert.deepEqual(await f.store.get('1'),before);
});
test('invisible but editable panel: explicit authenticated recovery sends exactly one cached HOME',async()=>{
 const f=await setup(),before=(await f.store.get('1')).state;
 const r=await f.call(recover,'recover');assert.equal(r.code,200);assert.equal(r.value.actions.length,1);
 const a=r.value.actions[0],b=JSON.parse(a.body_json);assert.equal(a.method,'sendPhoto');assert.equal(b.photo,'HOME');assert.equal(b.message_id,undefined);
 assert.deepEqual(b.reply_markup.inline_keyboard.flat().map(x=>x.text),['🎬 Crear video','📁 Mis videos','📊 Producción','⚙️ Ajustes']);
 await finish(f,r.value.commands[0]);const s=(await f.store.get('1')).state;
 assert.equal(s.message_id,900);assert.equal(s.panel_history[138].message_id,138);assert.deepEqual(s.episodes,before.episodes);assert.deepEqual(s.reviews,before.reviews);assert.deepEqual(s.deliveries[master.sha256],before.deliveries[master.sha256]);
});
test('concurrent recovery claims produce one outbox emission',async()=>{
 const f=await setup();const rs=await Promise.all([f.svc.recoverPanel('1','1'),f.svc.recoverPanel('1','1')]);assert.equal(rs.flatMap(x=>x.commands).length,1);
});
test('timeout, response loss and process restart never re-emit pending recovery',async()=>{
 const f=await setup();await prepare(f);const restarted=new ReviewService({store:f.store,telegram:new MakeTransport()});
 for(let i=0;i<3;i++){const r=await restarted.recoverPanel('1','1');assert.equal(r.status,'PANEL_RECOVERY_PENDING');assert.deepEqual(r.commands,[]);}
 await assert.rejects(restarted.show('1','1',{kind:'menu'}),/reconciliation_required/);
});
test('ambiguous prior delivery cannot authorize recovery',async()=>{
 const f=await setup();let r=await f.store.get('1');r.state.delivery={status:'UNKNOWN'};await f.store.cas('1',r.revision,r.state);
 await assert.rejects(f.svc.recoverPanel('1','1'),/reconciliation_required/);
});
test('new nonces and duplicate commands after completion do not create more panels',async()=>{
 const f=await setup(),c=await prepare(f);await finish(f,c);
 for(const id of ['second','third']){const r=await f.call(recover,id);assert.equal(r.value.status,'PANEL_ALREADY_RECOVERED');assert.deepEqual(r.value.actions,[]);}
});
test('arbitrary panel IDs and forged HMAC are rejected before recovery',async()=>{
 const f=await setup();assert.equal((await f.call({...recover,new_message_id:999},'bad-id')).code,409);
 assert.equal((await f.call(recover,'forged','0'.repeat(64))).code,401);
 assert.equal((await f.store.get('1')).state.panel_recovery,undefined);
});
test('ACK validates new ID, owner, media and caption before CAS',async()=>{
 const f=await setup(),c=await prepare(f);
 for(const m of [receipt(f,c,138),receipt(f,c,-1),{...receipt(f,c),chat:{id:2}},{...receipt(f,c),caption:'changed'},{...receipt(f,c),photo:[{file_id:'X',file_unique_id:'X'}]}])await assert.rejects(acknowledgeCommand(f.store,'1','1',c.idempotency_key,m));
 assert.equal((await f.store.get('1')).state.message_id,138);
});
test('ACK CAS contention and duplicate ACK preserve one new ID',async()=>{
 const f=await setup(),c=await prepare(f);const rs=await Promise.all([acknowledgeCommand(f.store,'1','1',c.idempotency_key,receipt(f,c)),acknowledgeCommand(f.store,'1','1',c.idempotency_key,receipt(f,c))]);
 assert.ok(rs.some(r=>r.status==='ACK_ALREADY_APPLIED'));assert.equal((await f.store.get('1')).state.message_id,900);
 await assert.rejects(acknowledgeCommand(f.store,'1','1',c.idempotency_key,receipt(f,c,901)),/identity_mismatch/);
});
test('old callbacks return stale without effects; new callbacks navigate with new panel',async()=>{
 const f=await setup(),c=await prepare(f);await finish(f,c);
 const cb=await f.click(c,'create_v2_ideas');let r=await f.call({callback_query:cb},'old-cb');assert.equal(r.value.status,'STALE_CALLBACK');assert.ok(r.value.actions.every(a=>a.method==='answerCallbackQuery'));
 cb.message=receipt(f,c);r=await f.call({callback_query:cb},'new-cb');assert.equal(r.code,200);const edit=r.value.commands.find(x=>x.kind!=='ACK_CALLBACK');assert.equal(edit.method,'editMessageMedia');assert.equal(edit.body.message_id,900);
});
test('/menu and library continue by editing new panel',async()=>{
 const f=await setup(),c=await prepare(f);await finish(f,c);const r=await f.call(f.menu(88),'menu-new');assert.equal(r.code,200);assert.equal(r.value.actions[0].method,'editMessageMedia');assert.equal(JSON.parse(r.value.actions[0].body_json).message_id,900);
});
test('q41 signature and authorization bind trusted current panel; old panel cannot confirm',async()=>{
 const f=await setup(),c=await prepare(f);await finish(f,c);
 let row=await f.store.get('1');const token='a'.repeat(24);row.state.tokens[token]={action:'q41_prepare',proposal_id:FIRST_IMAGE_EPISODE};await f.store.cas('1',row.revision,row.state);
 const env={LUMI_RUNTIME_ENV:'staging',LUMI_TELEGRAM_TRANSPORT_AUTHORITY:'MAKE',LUMI_TELEGRAM_REVIEW_TEST_USERS:'1',LUMI_TELEGRAM_CALLBACK_SECRET:secret};
 const auth=id=>{const body=Buffer.from(JSON.stringify({callback_query:{id:'q41',from:{id:1},message:{message_id:id,chat:{id:1}},data:'lr:'+token}})),signed={...nonce('q41'),body};return authenticateFirstImageCallback({env,panelMessageId:900,signed,signature:signRequest(secret,signed)});};
 assert.throws(()=>auth(138),/HMAC/);const command=auth(900);const authority=new ControlledV2Authorization({store:f.store,validateOwner:async()=>true});await authority.firstImageCommand(command,['q41_prepare']);
 row=await f.store.get('1');row.state.message_id=901;await f.store.cas('1',row.revision,row.state);await assert.rejects(authority.firstImageCommand(command,['q41_prepare']),/SCOPE/);
});
test('Supabase CAS updates row panel and JSON state atomically with revision predicate',async()=>{
 let payload,filters=[];const chain={eq(k,v){filters.push([k,v]);return this;},select(){return this;},async maybeSingle(){return {data:{revision:8}};}};
 const store=new SupabaseReviewStore({from:()=>({update:p=>{payload=p;return chain;}})});await store.cas('1',7,{message_id:900});assert.equal(payload.message_id,900);assert.equal(payload.state.message_id,900);assert.deepEqual(filters,[['user_id','1'],['revision',7]]);
});

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

test('deployed Make ACK mapping replacement supports old recovery envelope and new navigation ID',async()=>{
 const {readFile}=await import('node:fs/promises');const body=(await readFile(new URL('../docs/lumi-panel-recovery/make-module-21-body.iml',import.meta.url),'utf8')).trim().slice(2,-2);
 const f=await setup(),c=await prepare(f);const payload=JSON.parse(evaluateAckTemplate(body,{'10':{track_review:true,user:'1',chat:'1',message_id:138,command_id:c.idempotency_key},'12':{body:{result:receipt(f,c)}}}));
 assert.equal(payload.message_id,138);assert.equal(payload.telegram_result.message_id,900);assert.equal((await f.call(payload,'mapped-ack')).code,200);
 const next=(await f.svc.show('1','1',{kind:'menu'})).commands[0];const p=JSON.parse(evaluateAckTemplate(body,{'10':{track_review:true,user:'1',chat:'1',message_id:900,command_id:next.idempotency_key},'12':{body:{result:receipt(f,next)}}}));assert.equal(p.message_id,900);assert.equal((await f.call(p,'next-mapped-ack')).code,200);
});
test('replayed webhook and repeated explicit command cannot emit a second message',async()=>{
 const f=await setup(),update={update_id:99,message:{from:{id:1},chat:{id:1},date:Math.floor(Date.now()/1000),text:'/recuperar_panel'}};
 assert.equal((await f.call(update,'r1')).value.actions.length,1);assert.equal((await f.call(update,'r2')).value.status,'DUPLICATE_REQUEST');
 assert.deepEqual((await f.call({...update,update_id:100},'r3')).value.actions,[]);
});
test('queued old recovery command is not an authorization to create a panel',async()=>{
 const f=await setup();const r=await f.call({message:{from:{id:1},chat:{id:1},date:1,text:'/recuperar_panel'}},'old');assert.equal(r.code,409);assert.equal((await f.store.get('1')).state.panel_recovery,undefined);
});
test('crash after durable outbox save leaves recovery pending and cannot resend',async()=>{
 const f=await setup(),cas=f.store.cas.bind(f.store);f.store.cas=async(...args)=>{await cas(...args);throw Error('process_lost_response');};
 await assert.rejects(f.svc.recoverPanel('1','1'),/process_lost_response/);f.store.cas=cas;const r=await f.svc.recoverPanel('1','1');assert.deepEqual(r.commands,[]);assert.equal(r.status,'PANEL_RECOVERY_PENDING');
});
test('historical signed budget policy survives panel recovery without rewriting consent',async()=>{
 const f=await setup();let row=await f.store.get('1');const token='b'.repeat(24);row.state.tokens[token]={action:'q41_budget',proposal_id:FIRST_IMAGE_EPISODE};row.state.delivery={status:'DELIVERED',tokens:[token]};row.state.screen={kind:'q41_confirm'};await f.store.cas('1',row.revision,row.state);
 const env={LUMI_RUNTIME_ENV:'staging',LUMI_TELEGRAM_TRANSPORT_AUTHORITY:'MAKE',LUMI_TELEGRAM_REVIEW_TEST_USERS:'1',LUMI_TELEGRAM_CALLBACK_SECRET:secret},signed={...nonce('budget'),body:Buffer.from(JSON.stringify({callback_query:{id:'human-budget',from:{id:1},message:{message_id:138,chat:{id:1}},data:'lr:'+token}}))};
 const command=authenticateFirstImageCallback({env,panelMessageId:138,signed,signature:signRequest(secret,signed)});await new ControlledV2Authorization({store:f.store,validateOwner:async()=>true}).approveSupervisedBudget({command,secret,apiKeySha:'account'});
 const policy=(await f.store.get('1')).state.q41_supervised_policy;const c=await prepare(f);await finish(f,c);assert.deepEqual((await f.store.get('1')).state.q41_supervised_policy,policy);
 const binding={user:'1',chat:'1',apiKeySha:'account',panelIds:[900,138]};assert.equal(verifySupervisedPolicy(policy,secret,binding).hard_episode_budget_usd,5);assert.throws(()=>verifySupervisedPolicy(policy,secret,{...binding,panelIds:[900]}));
});
test('lost ACK persistence after Telegram send keeps original reference until exact receipt recovery',async()=>{
 const f=await setup(),c=await prepare(f),cas=f.store.cas.bind(f.store);f.store.cas=async()=>{throw Error('review_state_write_failed');};
 await assert.rejects(acknowledgeCommand(f.store,'1','1',c.idempotency_key,receipt(f,c)),/write_failed/);f.store.cas=cas;
 assert.equal((await f.store.get('1')).state.message_id,138);assert.deepEqual((await f.svc.recoverPanel('1','1')).commands,[]);
 await finish(f,c);assert.equal((await f.store.get('1')).state.message_id,900);
});
test('new panel HOME, Create, Production, Review and library stay single-message and preserve master',async()=>{
 const f=await setup(),initial=await prepare(f),before=JSON.stringify((await f.store.get('1')).state.episodes);await finish(f,initial);let c=initial,id=200;
 for(const action of ['create_v2_ideas','menu','current','progress','shot','back','menu','library','menu']){
  const cb=await f.click(c,action,'nav-'+(++id));cb.message=receipt(f,c);const r=await f.call({update_id:id,callback_query:cb},'req-'+id);assert.equal(r.code,200);
  c=r.value.commands.find(x=>x.kind!=='ACK_CALLBACK');assert.equal(c.method,'editMessageMedia');assert.equal(c.message_id,900);await finish(f,c);
 }
 assert.equal(JSON.stringify((await f.store.get('1')).state.episodes),before);
});
test('Make WatchUpdates ISO date survives JSON normalization and authorizes fresh recovery',async()=>{
 const f=await setup();const body={message:{from:{id:1},chat:{id:1,type:'private'},date:new Date().toISOString(),text:'/recuperar_panel',attachment:{type:'OtherOrNone'}},update_id:-2026101401,channel_post:null,inline_query:null,callback_query:null,edited_message:null,my_chat_member:null,business_message:null,pre_checkout_query:null,edited_channel_post:null};
 const r=await f.call(body,'make-normalized');assert.equal(r.code,200);assert.equal(r.value.actions.length,1);assert.equal(r.value.actions[0].method,'sendPhoto');
});
test('Make ISO date normalization does not weaken the two-minute authorization window',async()=>{
 for(const date of [new Date(Date.now()-300000).toISOString(),new Date(Date.now()+300000).toISOString(),'invalid','2026-01-01',null,{},String(Math.floor(Date.now()/1000))]){
  const f=await setup();const r=await f.call({message:{from:{id:1},chat:{id:1},date,text:'/recuperar_panel'}},'expired');assert.equal(r.code,409);assert.equal(r.value.error,'panel_recovery_command_expired');assert.equal((await f.store.get('1')).state.panel_recovery,undefined);
 }
});
