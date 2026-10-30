import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {TradingTelegramTransport} from '../lib/trading/telegram-transport.js';
import {TradingNotifier} from '../lib/trading/notifier.js';
import {SQLiteStore} from '../lib/trading/sqlite-store.js';
import {initialState,TradingEngine} from '../lib/trading/engine.js';
import {KrakenFeed} from '../lib/trading/feed.js';
import {failureDetails} from '../lib/trading/failure.js';

const env={LUMI_TRADING_STORAGE:'SQLITE',LUMI_TRADING_OWNER_ID:'123',LUMI_TELEGRAM_REVIEW_TEST_USERS:'123',LUMI_TELEGRAM_TRANSPORT_AUTHORITY:'DIRECT',LUMI_TELEGRAM_BOT_ID:'9',LUMI_TELEGRAM_BOT_TOKEN:'synthetic-token'};
function api(calls,chat={id:123,type:'private'}){
  return async(url,options)=>{
    const method=new URL(url).pathname.split('/').at(-1),body=JSON.parse(options.body);calls.push({method,body,options});
    assert.equal(new URL(url).origin,'https://api.telegram.org');
    if(method==='getMe')return Response.json({ok:true,result:{is_bot:true,id:9,username:'AppMultimedia_VideosBot'}});
    if(method==='getChat'){assert.deepEqual(body,{chat_id:'123'});assert.equal(options.redirect,'error');return Response.json({ok:true,result:chat});}
    assert.equal(method,'sendMessage');assert.equal(body.chat_id,'123');
    return Response.json({ok:true,result:{message_id:10+calls.length,chat:{id:123},date:Math.floor(Date.now()/1000)}});
  };
}

test('SQLite startup tick uses the default real adapter, verifies chat, delivers and preserves balances',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'trading-startup-'));let now=Date.now();
  const store=new SQLiteStore(join(dir,'ledger.db'),{allowEmpty:true,now:()=>now});
  t.after(async()=>{store.close();await rm(dir,{recursive:true,force:true});});
  const state=initialState(now);
  store.import({schema:1,exported_at:new Date(now).toISOString(),state:{id:'KRAKEN_BTCUSD_PAPER',revision:7,fence:1,lease_until:null,last_batch:null,state,updated_at:new Date(now).toISOString()},counts:{events:0,outbox:0},events:[],outbox:[]});
  const feed=new KrakenFeed({now:()=>now}),engine=new TradingEngine({store,feed,now:()=>now}),calls=[];
  // No substitute transport: this is the same constructor path as the worker.
  engine.notifier=new TradingNotifier({store,feed,db:null,env,pending:id=>engine.pending(id)});
  assert(engine.notifier.transport instanceof TradingTelegramTransport);
  engine.notifier.transport.fetch=api(calls);
  await engine.initialize();engine.state.frequency.account.cash='99.2611462761461504';engine.state.frequency.account.equity='99.2611462761461504';
  engine.notice('VERSION',{type:'AWS_SQLITE_ENABLED'},'aws-sqlite-v1');await engine.flush();
  const before={primary:engine.active().account.equity,secondary:engine.state.frequency.account.equity};
  for(let i=0;i<8;i++){now+=5001;await engine.tick();}
  assert.deepEqual(calls.slice(0,3).map(x=>x.method),['getMe','getChat','sendMessage']);
  assert(calls.every(x=>['getMe','getChat','sendMessage'].includes(x.method)));
  assert.equal(store.notices().find(x=>x.payload.type==='AWS_SQLITE_ENABLED').status,'DELIVERED');
  assert.equal((await store.queued()).length,0);
  assert(store.revision>7);assert(Date.parse(store.row().updated_at)>state.started_at);
  assert.equal(store.row().state.research.versions[engine.state.research.active].account.equity,before.primary);
  assert.equal(store.row().state.frequency.account.equity,before.secondary);
  assert((await store.history('FEED_AUDIT')).length>0);
  const sends=calls.filter(x=>x.method==='sendMessage').length;now+=5001;await engine.tick();
  assert.equal(calls.filter(x=>x.method==='sendMessage').length,sends);
});

test('a wrong owner or non-private chat stops identity verification before any send',async()=>{
  for(const chat of [{id:124,type:'private'},{id:123,type:'group'}]){
    const calls=[],n=new TradingNotifier({env,db:null,store:{async queued(){throw Error('MUST_NOT_READ_QUEUE');}},feed:{}});
    n.transport.fetch=api(calls,chat);
    await assert.rejects(n.drain(),/TRADING_PRIVATE_OWNER_MISMATCH/);
    assert.deepEqual(calls.map(x=>x.method),['getMe','getChat']);
  }
});

test('Trading adapter cannot change Lumi menus/webhooks or query a group',async()=>{
  const transport=new TradingTelegramTransport({token:'synthetic',fetchImpl:()=>{throw Error('NETWORK_MUST_NOT_RUN');}});
  for(const method of ['getUpdates','setWebhook','setChatMenuButton','editMessageText'])await assert.rejects(transport.call(method,{}),/METHOD_FORBIDDEN/);
  for(const body of [{chat_id:'-123'},{chat_id:'@group'},{chat_id:'123',extra:true}])await assert.rejects(transport.call('getChat',body),/PRIVATE_CHAT_REQUIRED/);
});

test('chat lookup failures expose safe codes and do not leak tokens or responses',async()=>{
  const transport=new TradingTelegramTransport({token:'private-token',fetchImpl:async()=>{throw Error('https://api.telegram.org/botprivate-token');}});
  await assert.rejects(transport.call('getChat',{chat_id:'123'}),{message:'TRADING_CHAT_LOOKUP_UNAVAILABLE'});
  transport.fetch=async()=>Response.json({ok:false,description:'private-response'},{status:403});
  await assert.rejects(transport.call('getChat',{chat_id:'123'}),{message:'TRADING_CHAT_LOOKUP_REJECTED'});
});

test('worker errors retain source locations without raw error messages or URLs',()=>{
  const error=new TypeError('private-token-and-url');error.stack='TypeError: private-token-and-url\n at verify (file:///opt/lumi-trading/current/lib/trading/notifier.js:80:20)\n at run (file:///opt/lumi-trading/current/scripts/trading-worker.mjs:30:4)';
  assert.deepEqual(failureDetails(error),{code:'TRADING_UNEXPECTED_FAILURE',error_class:'TypeError',frames:['notifier.js:80:20','trading-worker.mjs:30:4']});
  assert.equal(failureDetails(Error('TRADING_CHAT_LOOKUP_REJECTED')).code,'TRADING_CHAT_LOOKUP_REJECTED');
  assert.equal(failureDetails(Object.assign(Error('private'),{code:'SQLITE_BUSY'})).code,'SQLITE_BUSY');
  assert(!JSON.stringify(failureDetails(error)).includes('private'));
});
