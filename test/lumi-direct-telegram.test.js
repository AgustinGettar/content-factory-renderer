import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {DirectTelegram,mountDirectTelegram,DIRECT_PATH,directConfigured} from '../lib/telegram-review-v1/direct-transport.js';
import {TelegramTransport} from '../lib/telegram-review-v1/runtime.js';
import {miniAppSecret,miniAuthCredential,MiniAppAuth} from '../lib/telegram-mini-app/auth.js';
import {claimRequest} from '../lib/telegram-review-v1/make-transport.js';

const env={LUMI_RUNTIME_ENV:'staging',SUPABASE_URL:'https://mofjhwathxzfnjapvvst.supabase.co',LUMI_TELEGRAM_TRANSPORT_AUTHORITY:'DIRECT',
 LUMI_TELEGRAM_BOT_ID:'8843261381',LUMI_TELEGRAM_BOT_TOKEN:'OFFLINE_ONLY',LUMI_TELEGRAM_CALLBACK_SECRET:'existing-signing-key',
 LUMI_TELEGRAM_WEBHOOK_SECRET:'independent-offline-webhook-secret-1234',LUMI_TELEGRAM_REVIEW_TEST_USERS:'1,2'};
const migration=await readFile(new URL('../supabase/migrations/20261020160000_lumi_direct_telegram_transport.sql',import.meta.url),'utf8');
const schema=`create role anon;create role authenticated;create role service_role;
create table cf_bot_admins(user_id bigint primary key,chat_id bigint,active boolean);
create table lumi_telegram_review_sessions(user_id bigint primary key,revision bigint,state jsonb,updated_at timestamptz);
insert into cf_bot_admins values(1,1,true),(2,2,true);`;
const update=(id=7,user=1)=>({update_id:id,message:{message_id:148,from:{id:user},chat:{id:user,type:'private'},text:'/start'}});
const protectedState={episodes:{EP005:{episode_id:'EP005',review_requests:{old:{review_request_id:'old',status:'PENDING',artifact_sha:'a'.repeat(64)}}}},
 mini_app:{operations:{q42:{status:'BLOCKED'}}},supervised_replacement_grants:{old:{maximum_reservation_usd:.3275}},q41:{status:'APPROVED'},budget:{cap:8,original:.3275}};
async function setup({path,existing=false,transport}={}){
 const sql=new PGlite(path);
 if(!existing){await sql.exec(schema);await sql.exec(migration);for(const user of [1,2])await sql.query('insert into lumi_telegram_review_sessions values($1,0,$2,now())',[user,JSON.stringify({user_id:String(user),chat_id:String(user),message_id:148,...protectedState})]);}
 const db={rpc:async(_,{p})=>{try{return {data:(await sql.query('select lumi_direct_telegram_v1($1::jsonb) as value',[JSON.stringify(p)])).rows[0].value};}catch(error){return {error};}}};
 const store={get:async u=>(await sql.query('select revision,state from lumi_telegram_review_sessions where user_id=$1',[u])).rows[0],
 cas:async(u,r,s)=>{const v=await sql.query('update lumi_telegram_review_sessions set state=$3,revision=revision+1 where user_id=$1 and revision=$2 returning revision',[u,r,JSON.stringify(s)]);if(!v.rows.length)throw Error('concurrent_update');return v.rows[0].revision;}};
 const calls=[],telegram=transport||{call:async(method,body)=>{calls.push({method,body});if(method==='getMe')return {id:8843261381,is_bot:true,username:'AppMultimedia_VideosBot'};if(method==='answerCallbackQuery')return true;return {message_id:99,chat:{id:Number(body.chat_id)},date:123};}};
 const validateOwner=async(u,c)=>(await sql.query('select 1 from cf_bot_admins where user_id=$1 and chat_id=$2 and active=true',[u,c])).rows.length===1;
 const options={db,store,transport:telegram,validateOwner,env};const service=new DirectTelegram(options);await service.verify();calls.length=0;
 return {sql,db,store,service,calls,options};
}
test('DIRECT_WEBHOOK: valid secret, wrong secret, input and owner rejection; ACK only after durable acceptance',async()=>{
 const f=await setup();const routes={},app={get:(p,h)=>routes[p]=h,post:(p,h)=>routes[p]=h};
 const mounted=mountDirectTelegram(app,{...f.options,startWorker:false});mounted.stop();await mounted.service.verify();
 const request=async(body,secret=env.LUMI_TELEGRAM_WEBHOOK_SECRET)=>{const res={statusCode:200,status(n){this.statusCode=n;return this;},json(x){this.body=x;return this;}};
 await routes[DIRECT_PATH]({body,headers:{'x-telegram-bot-api-secret-token':secret},is:()=>true},res);return res;};
 assert.equal((await request(update(),'wrong')).statusCode,401);
 assert.equal((await request(update(7,3))).statusCode,403);
 assert.equal((await request({...update(),message:{...update().message,text:'x'.repeat(17000)}})).statusCode,400);
 const server=await readFile(new URL('../server.js',import.meta.url),'utf8');assert.ok(server.includes("app.use('/lumi/telegram-review/telegram/webhook',express.json({limit:'16kb',strict:true}))"));
 const result=await request(update());assert.equal(result.statusCode,200);
 assert.equal((await f.store.get('1')).state.make_requests['direct:8843261381:update:7'].status,'QUEUED');
 assert.equal(f.calls.filter(c=>c.method==='sendMessage').length,0);
 const old=f.db.rpc;f.db.rpc=async()=>({error:Error('unavailable')});assert.equal((await request(update(8))).statusCode,503);f.db.rpc=old;
 await f.sql.close();
});
test('DIRECT_DEDUP: concurrent and repeated updates, owner uniqueness and shared CAS preserve EP005/EP006 protected state',async()=>{
 const f=await setup();const prior=(await f.store.get('1')).state;
 await Promise.all(Array.from({length:8},()=>f.service.accept(update())));
 const other=new DirectTelegram(f.options);await other.verify();await Promise.all([f.service.drain(),other.drain()]);
 assert.equal(f.calls.filter(c=>c.method==='sendMessage').length,1);
 await f.service.accept(update());await f.service.drain();assert.equal(f.calls.filter(c=>c.method==='sendMessage').length,1);
 await assert.rejects(f.service.accept(update(7,2)),/OWNER_CONFLICT/);
 const after=(await f.store.get('1')).state;delete after.make_requests;assert.deepEqual(after,prior);
 await f.sql.query(`update lumi_telegram_review_sessions set state=jsonb_set(state,'{episodes}','{"EP006":{"episode_id":"EP006"}}') where user_id=2`);
 await f.service.accept(update(8,2));await f.service.drain();assert.equal(f.calls.filter(c=>c.method==='sendMessage').length,2);
 const captured=await f.store.get('1');await f.service.accept(update(9));await assert.rejects(f.store.cas('1',captured.revision,captured.state),/concurrent/);
 await f.sql.close();
});
test('DIRECT_PROCESS_RESTART: queued receipt survives database reopen; DISPATCHING is never resent',async()=>{
 const path=await mkdtemp(join(tmpdir(),'lumi-direct-'));let f=await setup({path});await f.service.accept(update());await f.sql.close();
 f=await setup({path,existing:true});await f.service.drain();assert.equal(f.calls.filter(c=>c.method==='sendMessage').length,1);
 await f.service.accept(update(8));await f.service.tx({phase:'CLAIM',user_id:'1',key:'direct:8843261381:update:8',dispatch_id:randomUUID()});await f.sql.close();
 f=await setup({path,existing:true});await f.service.drain();assert.equal(f.calls.filter(c=>c.method==='sendMessage').length,0);await f.sql.close();await rm(path,{recursive:true});
});
test('DIRECT_RESPONSE_LOST: Telegram timeout and ACK-persistence loss never retry the send',async()=>{
 for(const lost of ['HTTP','DATABASE']){
  const f=await setup();await f.service.accept(update());let sends=0;
  f.service.transport={call:async()=>{sends++;if(lost==='HTTP')throw Error('timeout');return {message_id:99,chat:{id:1}};}};
  const real=f.db.rpc;f.db.rpc=async(n,p)=>p.p.phase==='FINISH'&&lost==='DATABASE'?{error:Error('lost')}:real(n,p);
  await f.service.drain().catch(()=>{});f.db.rpc=real;await f.service.accept(update());await f.service.drain();assert.equal(sends,1);
  const r=(await f.store.get('1')).state.make_requests['direct:8843261381:update:7'];assert.equal(r.status,lost==='HTTP'?'UNKNOWN':'DISPATCHING');await f.sql.close();
 }
});
test('DIRECT_LEGACY: old spend callbacks only redirect; old Make acceptance is held without replay',async()=>{
 const f=await setup(),cb={update_id:7,callback_query:{id:'callback123',data:'lr:expired-generation-token',from:{id:1},message:{message_id:148,chat:{id:1,type:'private'}}}};
 await f.service.accept(cb);await f.service.drain();assert.deepEqual(f.calls.map(x=>x.method),['answerCallbackQuery']);
 const row=await f.store.get('1');row.state.make_requests.oldMake={update_id:8,expires_at:0};await f.store.cas('1',row.revision,row.state);
 assert.equal((await f.service.accept(update(8))).status,'LEGACY_HELD');await f.service.drain();assert.equal(f.calls.length,1);
 await claimRequest(f.store,'1',{timestamp:Math.floor(Date.now()/1000),requestId:'test-legacy-request',body:Buffer.from('{}')});
 assert.equal((await f.store.get('1')).state.make_requests['direct:8843261381:update:8'].status,'LEGACY_HELD');await f.sql.close();
});
test('DIRECT_NOTIFICATIONS: future durable reviews and master notify once; old artifacts are not redelivered',async()=>{
 const f=await setup();await f.service.drain();assert.equal(f.calls.length,0);
 const row=await f.store.get('1');row.state.episodes.EP005.review_requests.next={review_request_id:'new',status:'PENDING',artifact_sha:'b'.repeat(64)};
 row.state.episodes.EP005.master={sha256:'c'.repeat(64)};await f.store.cas('1',row.revision,row.state);
 await f.service.drain();await f.service.drain();assert.equal(f.calls.length,2);
 assert.ok(f.calls.every(c=>c.method==='sendMessage'&&c.body.reply_markup.inline_keyboard[0][0].web_app.url.endsWith('/lumi/studio')));
 const receipts=Object.values((await f.store.get('1')).state.make_requests).filter(r=>r.status==='DELIVERED');assert.ok(receipts.every(r=>r.receipt.message_id===99));await f.sql.close();
});
test('DIRECT_TOKEN_ADDITION: unchanged CSRF/media signing and Ed25519 identity; invalid configuration fails closed',async()=>{
 const before={...env,LUMI_TELEGRAM_BOT_TOKEN:undefined};assert.deepEqual(miniAppSecret(before),miniAppSecret(env));assert.deepEqual(miniAuthCredential(before),miniAuthCredential(env));
 const auth=new MiniAppAuth({env:before}),after=new MiniAppAuth({env});assert.equal(auth.csrf('existing-session'),after.csrf('existing-session'));
 for(const patch of [{LUMI_TELEGRAM_BOT_TOKEN:undefined},{LUMI_TELEGRAM_WEBHOOK_SECRET:undefined},{LUMI_TELEGRAM_WEBHOOK_SECRET:env.LUMI_TELEGRAM_CALLBACK_SECRET},{LUMI_TELEGRAM_TRANSPORT_AUTHORITY:'MAKE'},{SUPABASE_URL:'https://production.supabase.co'}])assert.equal(directConfigured({...env,...patch}),false);
 const f=await setup();f.service.transport={call:async()=>({id:123,is_bot:true,username:'other'})};await assert.rejects(f.service.verify(),/IDENTITY/);await f.sql.close();
});
test('DIRECT_HTTP_TRANSPORT: direct Bot API receipt, sanitized failures and no provider/Make calls',async()=>{
 const calls=[],telegram=new TelegramTransport({token:'OFFLINE_TOKEN',fetchImpl:async(url,options)=>{calls.push({url,options});return {ok:true,json:async()=>({ok:true,result:{message_id:99,chat:{id:1}}})};}});
 assert.equal((await telegram.call('sendMessage',{chat_id:1,text:'Studio'})).message_id,99);assert.equal(calls.length,1);assert.match(calls[0].url,/^https:\/\/api.telegram.org\//);
 await assert.rejects(telegram.call('setWebhook',{drop_pending_updates:true}),/preservation/);await assert.rejects(telegram.call('getUpdates',{}),/forbidden/);
 const broken=new TelegramTransport({token:'OFFLINE_SECRET',fetchImpl:async()=>{throw Error('secret transport URL');}});await assert.rejects(broken.call('sendMessage',{}),e=>e.code==='TELEGRAM_DELIVERY_UNKNOWN'&&!e.message.includes('SECRET'));
});
