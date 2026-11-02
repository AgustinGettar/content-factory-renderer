// Isolated temporary SQLite ledger. Never opens the worker database or a network feed.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {D,hash} from '../lib/trading/core.js';
import {initialState,TradingEngine} from '../lib/trading/engine.js';
import {KrakenFeed} from '../lib/trading/feed.js';
import {SQLiteStore} from '../lib/trading/sqlite-store.js';
import {SecondaryBroker,secondaryEconomics} from '../lib/trading/secondary-futures-engine.js';
import {SECONDARY_MODEL,SECONDARY_VERSION} from '../lib/trading/secondary-futures-math.js';
import {installExploration,explorationContract,getExplorationPolicy,EXPLORATION_VERSION,EXPLORATION_ENTRY_REVISION} from '../lib/trading/secondary-exploration.js';
const T=Date.parse('2026-11-02T02:00:02Z'),H=Math.floor(T/3600000)*3600000;
const env={LUMI_RUNTIME_ENV:'staging',LUMI_TRADING_MODE:'PAPER',LUMI_TRADING_STORAGE:'SQLITE',LUMI_TRADING_SECONDARY_PROFILE:EXPLORATION_VERSION};
const quote=(at,bid='100')=>({source:'KRAKEN_FUTURES_WS_TICKER',symbol:'PF_XBTUSD',event_at:at,received_at:at,bid,ask:D(bid).plus('.01').toString(),bid_qty:'10',ask_qty:'10',suspended:false});

test('SQLite commits profile, one topup, selection, fill and delayed close atomically across three restarts',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'lumi-exploration-isolated-')),path=join(dir,'paper.sqlite');let now=T,store;
 t.after(async()=>{try{store?.close();}catch{}await rm(dir,{recursive:true,force:true});});
 store=new SQLiteStore(path,{allowEmpty:true,now:()=>now});
 store.import({schema:1,exported_at:new Date(now).toISOString(),state:{id:'KRAKEN_BTCUSD_PAPER',revision:1,fence:0,lease_until:null,last_batch:null,state:initialState(now),updated_at:new Date(now).toISOString()},counts:{events:0,outbox:0},events:[],outbox:[]});
 const initialize=async()=>{const engine=new TradingEngine({store,feed:new KrakenFeed({now:()=>now}),now:()=>now});await engine.initialize();return engine;};
 let engine=await initialize();
 engine.state.laboratory.status='RESEARCH_COMPLETE';
 Object.assign(engine.state.frequency.account,{cash:'1',equity:'1',net:'0',fees:'0',peak:'1',closed:0,wins:0,losses:0,halted:false});
 engine.state.laboratory.funding={initial:'1',added:'0',count:0,history:[],peak:'1',maxDrawdown:'0'};
 const primary=structuredClone(engine.active().account);
 const broker=()=>new SecondaryBroker({root:engine.state,now:()=>now,event:e=>engine.event(e),notice:(...args)=>engine.notice(...args)});
 let b=broker();installExploration(engine.state,env,now,e=>engine.event(e));
 const c=explorationContract(getExplorationPolicy(engine.state),'BREAKOUT',now),entry=D('100.01').mul('1.0002').toNumber();
 const plan={id:'ISOLATED_PERSISTENCE_SIGNAL',signal_key:hash(['ISOLATED',T]),version:SECONDARY_VERSION,entry_revision:EXPLORATION_ENTRY_REVISION,execution_model:SECONDARY_MODEL,instrument:'PAPER:KRAKEN_FUTURES:PF_XBTUSD',pattern:'BREAKOUT',direction:'LONG',family:'L',recipe:'BREAKOUT',recipe_title:'ISOLATED TEST ONLY',timeframe:5,entry:String(entry),limit:'100',stop:'99',target:'103',confirmed_at:T-2000,decision_at:T,expires_at:c.expires_at,holding_ms:1800000,order:'FUTURES_TAKER_IOC',fill_model:c.liquidity_model,execution_contract:c,economics:secondaryEconomics(entry,99,103,'LONG',0,c)};
 const meta={symbol:'PF_XBTUSD',qty_step:.0001,tick_size:.01,checked_at:T};
 assert.equal(b.choose(plan,quote(now),meta,now),'ENTRY_PENDING');await engine.flush();
 const topup=(await store.history('PAPER_CAPITAL_TOPUP'))[0];assert(topup);assert.equal((await store.history('SELECTED')).length,1);
 const restart=async at=>{await store.tx({phase:'RELEASE'});store.close();now=at;store=new SQLiteStore(path,{now:()=>now});engine=await initialize();b=broker();assert.equal(installExploration(engine.state,env,now,e=>engine.event(e)),false);};
 await restart(T+1100);
 assert.equal(b.choose(plan,quote(now),meta,now),'DUPLICATE_SIGNAL');
 b.market(quote(now),null,{[H]:0},now);assert(b.a.positions[plan.id]);await engine.flush();
 assert.equal((await store.history('PAPER_CAPITAL_TOPUP')).length,1);assert.equal((await store.history('FILLED')).length,1);
 const entryHash=b.a.positions[plan.id].plan.hash;await restart(T+2200);
 assert.equal(b.a.positions[plan.id].plan.hash,entryHash);b.market(quote(now,'98.9'),null,{[H]:0},now);assert(b.a.positions[plan.id].exit_intent);await engine.flush();
 await restart(T+3300);b.market(quote(now,'98.8'),null,{[H]:0},now);await engine.flush();
 assert.equal(Object.keys(b.a.positions).length,0);assert.equal(b.a.closed,1);assert.equal((await store.history('CLOSED')).length,1);
 const close=(await store.history('CLOSED'))[0];assert(D(b.a.cash).minus(1).minus(topup.amount).minus(close.pnl).abs().lt('0.000000000001'));
 assert.deepEqual(engine.active().account,primary);assert.equal(engine.state.laboratory.status,'RESEARCH_COMPLETE');
 assert.equal(store.notices(100).filter(n=>n.kind==='SECONDARY_TOPUP').length,1);assert.equal(store.notices(100).filter(n=>n.kind==='SECONDARY_OPEN').length,1);assert.equal(store.notices(100).filter(n=>n.kind==='SECONDARY_CLOSE').length,1);
 assert.equal(store.db.prepare('PRAGMA quick_check').get().quick_check,'ok');
});

test('a second SQLite writer cannot acquire the operational lease or duplicate an event',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'lumi-exploration-fence-')),path=join(dir,'paper.sqlite');let now=T;
 const first=new SQLiteStore(path,{allowEmpty:true,now:()=>now});let second;
 t.after(async()=>{first.close();second?.close();await rm(dir,{recursive:true,force:true});});
 first.import({schema:1,exported_at:new Date(now).toISOString(),state:{id:'KRAKEN_BTCUSD_PAPER',revision:1,fence:0,lease_until:null,last_batch:null,state:initialState(now),updated_at:new Date(now).toISOString()},counts:{events:0,outbox:0},events:[],outbox:[]});
 await first.acquire();second=new SQLiteStore(path,{now:()=>now});await assert.rejects(second.acquire(),/TRADING_LEASE_BUSY/);
 assert.equal(first.row().revision,1);assert.equal(first.db.prepare('SELECT count(*) AS n FROM events').get().n,0);
});
