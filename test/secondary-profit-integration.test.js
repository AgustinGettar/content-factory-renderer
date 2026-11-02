// Explicitly synthetic, isolated PAPER ledgers. No network or operational DB.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {D,hash} from '../lib/trading/core.js';
import {newAccount} from '../lib/trading/simulator.js';
import {enablePortfolio} from '../lib/trading/portfolio.js';
import {SecondaryBroker,secondaryEconomics,secondaryEstimate,SECONDARY_MODEL,SECONDARY_VERSION} from '../lib/trading/secondary-futures.js';
import {entryCandidates} from '../lib/trading/secondary-entry-context.js';
import {installExploration,getExplorationPolicy,explorationContract,EXPLORATION_VERSION,EXPLORATION_ENTRY_REVISION} from '../lib/trading/secondary-exploration.js';
import {installProfitPolicy,getProfitPolicy,makeProfitContracts,PROFIT_POLICY_VERSION,PROFIT_ENTRY_REVISION} from '../lib/trading/secondary-profit-policy.js';
import {initialState,TradingEngine} from '../lib/trading/engine.js';
import {KrakenFeed} from '../lib/trading/feed.js';
import {SQLiteStore} from '../lib/trading/sqlite-store.js';
const C=Date.parse('2026-11-02T02:00:00Z'),T=C+2000,H=Math.floor(T/3600000)*3600000;
const ENV={LUMI_RUNTIME_ENV:'staging',LUMI_TRADING_MODE:'PAPER',LUMI_TRADING_STORAGE:'SQLITE',LUMI_TRADING_SECONDARY_PROFILE:EXPLORATION_VERSION,LUMI_TRADING_SECONDARY_PROFIT_POLICY:PROFIT_POLICY_VERSION};
const META={symbol:'PF_XBTUSD',qty_step:.0001,tick_size:.01,checked_at:T};
const quote=(at=T,bid=100,size=100)=>({source:'KRAKEN_FUTURES_WS_TICKER',symbol:'PF_XBTUSD',event_at:at,received_at:at,bid:D(bid).toString(),ask:D(bid).plus('.01').toString(),bid_qty:String(size),ask_qty:String(size),suspended:false});
const near=(a,b)=>assert(D(a).minus(b).abs().lt('0.000000000001'),`${a} != ${b}`);
function fixture({cash='500',profit=true}={}){
 let now=T;const a=newAccount();enablePortfolio(a);Object.assign(a,{cash,equity:cash,peak:cash});
 const root={frequency:{account:a,counts:{evaluations:0,candidates:0,selected:0,filled:0,closed:0,notFilled:0},history:[],grossClosed:'0',closedFees:'0'},laboratory:{status:'RESEARCH_COMPLETE',trials:[{status:'REJECTED',net:'-25'}],funding:{initial:cash,added:'0',count:0}},research:{active:'primary',versions:{primary:{account:{cash:'100',equity:'100',net:'0'}}}}};
 const events=[],notices=[];const b=new SecondaryBroker({root,now:()=>now,event:e=>events.push(structuredClone(e)),notice:(...args)=>notices.push(structuredClone(args))});installExploration(root,ENV,T);if(profit)installProfitPolicy(root,ENV,T);
 return {root,b,events,notices,now:()=>now,time(at){now=at;}};
}
function plan(h,{id='ISOLATED-1',pattern='BREAKOUT',direction='LONG',at=T,entryBid=100,target,stop,confirmation=C,mode='TAKER_IOC',rate=0,profit=true}={}){
 if(mode!==getExplorationPolicy(h.root).modes[pattern])installExploration(h.root,{...ENV,['LUMI_TRADING_SECONDARY_'+pattern+'_EXECUTION']:mode},at);
 const c=explorationContract(getExplorationPolicy(h.root),pattern,at),short=direction==='SHORT',entry=mode==='MAKER_LIMIT'?D(entryBid):D(short?quote(at,entryBid).bid:quote(at,entryBid).ask).mul(short?'.9998':'1.0002');
 target??=short?97:103;stop??=short?101:99;
 const p={id,signal_key:hash(['ISOLATED',id,confirmation]),version:SECONDARY_VERSION,entry_revision:profit?PROFIT_ENTRY_REVISION:EXPLORATION_ENTRY_REVISION,execution_model:SECONDARY_MODEL,instrument:'PAPER:KRAKEN_FUTURES:PF_XBTUSD',pattern,direction,recipe:pattern,recipe_title:'ISOLATED TEST ONLY',timeframe:5,entry:entry.toString(),limit:String(entryBid),stop:String(stop),target:String(target),confirmed_at:confirmation,decision_at:at,expires_at:c.expires_at,holding_ms:1800000,order:mode==='TAKER_IOC'?'FUTURES_TAKER_IOC':'FUTURES_POST_ONLY_LIMIT',execution_contract:c,fill_model:c.liquidity_model,economics:secondaryEconomics(entry,stop,target,direction,rate,c)};
 if(profit){Object.assign(p,makeProfitContracts(getProfitPolicy(h.root)));p.entry_context={version:'secondary-entry-context-economics-1.0.0',structure_key:'structure:'+pattern+':'+direction+':'+target,movement_key:'structure:'+pattern,confirmation_key:'confirmation:'+id,confirmation_event_at:confirmation,confirmation_at:confirmation,price_tick:'.01',remaining_distance:D(target).minus(entry).mul(short?-1:1).toString(),remaining_distance_fraction:D(target).minus(entry).abs().div(entry).toString()};}
 return p;
}
function market(h,at,bid=100,size=100,rates={[H]:0},trade=null){h.time(at);h.b.market(quote(at,bid,size),trade,rates,at);}
function open(h,p=plan(h),{bid=100,size=100}={}){assert.equal(h.b.choose(p,quote(p.decision_at,bid),META,p.decision_at),'ENTRY_PENDING');market(h,p.decision_at+1100,bid,size);assert(h.b.a.positions[p.id]);return h.b.a.positions[p.id];}
function restart(h,at){h.time(at);h.root=JSON.parse(JSON.stringify(h.root));h.b=new SecondaryBroker({root:h.root,now:h.now,event:e=>h.events.push(structuredClone(e)),notice:(...args)=>h.notices.push(structuredClone(args))});return h.b;}

test('economic rejection records detection economics without capital, order, seen-signal or primary mutation',()=>{
 const h=fixture({cash:'0'}),primary=structuredClone(h.root.research),p=plan(h,{target:100.18});
 assert.equal(h.b.choose(p,quote(),META,T),'EXPECTED_NET_TARGET_BELOW_MINIMUM');const e=h.events.find(e=>e.type==='SECONDARY_ENTRY_REJECTED');assert(e);assert(D(e.entry_economics.expected_net_target).lt(e.entry_economics.minimum_expected_net_target));
 assert.equal(h.b.a.cash,'0');assert.equal(h.b.x.counts.economic_rejected,1);assert.equal(Object.keys(h.b.a.pendingOrders).length,0);assert.equal(Object.keys(h.b.a.positions).length,0);assert(!h.b.x.capital);assert(!h.b.x.seen_signals?.includes(p.signal_key));assert.deepEqual(h.root.research,primary);
});
test('a previously sufficient signal is rejected at post-latency price before any fill or debit',()=>{
 const h=fixture(),p=plan(h,{target:100.6}),cash=h.b.a.cash;assert.equal(h.b.choose(p,quote(),META,T),'ENTRY_PENDING');market(h,T+1100,100.4);
 assert(!h.b.a.positions[p.id]);assert(!h.b.a.pendingOrders[p.id]);assert.equal(h.b.a.cash,cash);assert.equal(h.b.a.net,'0');const e=h.events.find(e=>e.type==='NOT_FILLED');assert.equal(e.reason,'PRE_EXECUTION_EXPECTED_NET_TARGET_BELOW_MINIMUM');assert.equal(e.entry_revalidation.stage,'PRE_EXECUTION');assert.equal(e.entry_revalidation.estimated_entry_price,D('100.41').mul('1.0002').toString());assert(!h.events.some(e=>e.type==='FILLED'));
});
test('post-latency funding is required and never substituted by an old signal allowance',()=>{
 const h=fixture();h.b.choose(plan(h),quote(),META,T);market(h,T+1100,100,100,{});assert.equal(h.events.find(e=>e.type==='NOT_FILLED').reason,'PRE_EXECUTION_FUNDING_NOT_AVAILABLE');assert.equal(h.b.a.closed,0);
});
test('partial entry uses actual rounded quantity, effective nominal and costs; no leverage multiplier',()=>{
 const h=fixture(),p=open(h,plan(h),{size:.2});assert.equal(p.qty,'0.02');const r=p.entry_revalidation;near(r.effective_exposure,D(p.entry).mul(p.qty));near(r.minimum_expected_net_target,D(r.effective_exposure).mul('.002'));assert(r.accepted);assert.equal(p.profit_protection.basis_qty,p.qty);assert(!h.b.a.pendingOrders[p.plan.id]);
});
for(const direction of ['LONG','SHORT'])test(direction+' structural target activates trailing; observed peak protects and retracement closes later',()=>{
 const h=fixture(),p=open(h,plan(h,{direction})),sign=direction==='LONG'?1:-1,targetBid=direction==='LONG'?103:96.99;
 market(h,T+2200,targetBid);assert(h.b.a.positions[p.plan.id]);assert.equal(p.profit_protection.state,'TRAILING_ACTIVE');assert(!p.exit_intent);assert.equal(h.events.filter(e=>e.type==='TARGET_REACHED').length,1);const initial=D(p.profit_protection.protected_net);
 market(h,T+3300,100+5*sign-(direction==='SHORT'?.01:0));assert(D(p.profit_protection.protected_net).gt(initial));near(p.profit_protection.protected_net,D(p.profit_protection.peak_net).mul('.75'));const protectedNet=p.profit_protection.protected_net;
 market(h,T+4400,100+3*sign-(direction==='SHORT'?.01:0));assert.equal(p.exit_intent.reason,'TRAILING_RETRACEMENT');assert.equal(p.profit_protection.state,'EXIT_PENDING');assert.equal(p.profit_protection.protected_net,protectedNet);
 market(h,T+4900,100+3*sign);assert(h.b.a.positions[p.plan.id]);market(h,T+5500,100+2*sign);assert(!h.b.a.positions[p.plan.id]);const e=h.events.find(e=>e.type==='CLOSED');assert.equal(e.reason,'TRAILING_RETRACEMENT');assert(D(e.pnl).lt(protectedNet));assert.equal(e.profit_protection.state,'CLOSED');assert.equal(h.notices.filter(n=>n[0]==='SECONDARY_TRAILING').length,1);
});
test('durable trailing intent executes even after a rebound, or loss below its trigger, and a stop overrides profit',()=>{
 for(const after of [105,100,98.8]){
  const h=fixture(),p=open(h);market(h,T+2200,104);market(h,T+3300,102.5);assert.equal(p.exit_intent.reason,'TRAILING_RETRACEMENT');const intent=structuredClone(p.exit_intent);market(h,T+4400,after);const e=h.events.find(e=>e.type==='CLOSED');assert(e);assert.equal(e.reason,after<99?'STOP':'TRAILING_RETRACEMENT');assert.equal(e.exit_intent.not_before,intent.not_before);if(after<=100)assert(D(e.pnl).lt(0));
 }
});
test('stop before target has no profit gate and does not activate trailing',()=>{
 const h=fixture(),p=open(h);market(h,T+2200,98.9);assert.equal(p.exit_intent.reason,'STOP');market(h,T+3300,98.8);assert.equal(h.events.find(e=>e.type==='CLOSED').reason,'STOP');assert(!h.events.some(e=>e.type==='TARGET_REACHED'));
});
test('four positions keep independent management when one activates and exits',()=>{
 const h=fixture(),plans=[plan(h,{id:'one',target:103,confirmation:C-4000}),plan(h,{id:'two',pattern:'PULLBACK',target:110,confirmation:C-3000}),plan(h,{id:'three',pattern:'RANGE_REENTRY',target:111,confirmation:C-2000}),plan(h,{id:'four',target:112,confirmation:C-1000})];
 for(const p of plans)assert.equal(h.b.choose(p,quote(),META,T),'ENTRY_PENDING');market(h,T+1100);assert.equal(Object.keys(h.b.a.positions).length,4);
 market(h,T+2200,103);assert.equal(h.b.a.positions.one.profit_protection.state,'TRAILING_ACTIVE');for(const id of ['two','three','four'])assert.equal(h.b.a.positions[id].profit_protection.state,'OPEN_BEFORE_TARGET');
 market(h,T+3300,105);market(h,T+4400,103);market(h,T+5500,102.9);assert.deepEqual(Object.keys(h.b.a.positions).sort(),['four','three','two']);assert.deepEqual(h.events.filter(e=>e.type==='CLOSED').map(e=>e.id),['one']);for(const id of ['two','three','four'])assert(!h.b.a.positions[id].exit_intent);
});
test('shared structural target activates each position; a retracement can close only its own protection',()=>{
 const h=fixture(),first=open(h,plan(h,{id:'early',target:103,confirmation:C-1000}));
 const next=plan(h,{id:'later',at:T+2200,entryBid:101,target:103,stop:99,confirmation:T});assert.equal(h.b.choose(next,quote(T+2200,101),META,T+2200),'ENTRY_PENDING');market(h,T+3300,101);const second=h.b.a.positions.later;assert(second);
 market(h,T+4400,103);assert.equal(first.profit_protection.state,'TRAILING_ACTIVE');assert.equal(second.profit_protection.state,'TRAILING_ACTIVE');assert(D(first.profit_protection.peak_net).gt(second.profit_protection.peak_net));
 market(h,T+5500,104);const originalEarly=first.profit_protection.protected_net;market(h,T+6600,103.15);assert.equal(second.exit_intent?.reason,'TRAILING_RETRACEMENT');assert(!first.exit_intent);assert.equal(first.profit_protection.protected_net,originalEarly);
 market(h,T+7700,103.15);assert(h.b.a.positions.early);assert(!h.b.a.positions.later);assert.equal(first.plan.target,second.plan.target);
});
test('partial exits conserve independent liquidity, rescale per remaining unit and survive restart',()=>{
 const h=fixture(),cash=h.b.a.cash,p=open(h);market(h,T+2200,104);market(h,T+3300,102.5);const unit=p.profit_protection.peak_net_per_unit;market(h,T+4400,102.4,1);
 assert.equal(p.profit_protection.state,'PARTIALLY_CLOSED');assert.equal(p.profit_protection.peak_net_per_unit,unit);near(p.profit_protection.peak_net,D(unit).mul(p.qty));assert(D(p.realized.net).gt(0));const qty=p.qty,liquidity=structuredClone(h.b.x.liquidity),state=structuredClone(p.profit_protection);
 restart(h,T+4400);assert.deepEqual(h.b.a.positions[p.plan.id].profit_protection,state);assert.deepEqual(h.b.x.liquidity,liquidity);market(h,T+4400,102.4,1);assert.equal(h.b.a.positions[p.plan.id].qty,qty);market(h,T+5500,102.3);const e=h.events.find(e=>e.type==='CLOSED');assert(e);near(D(h.b.a.cash).minus(cash),e.pnl);near(h.b.a.net,e.pnl);assert.equal(h.events.filter(e=>e.type==='CLOSED').length,1);
});
test('zero liquidity keeps a triggered close visible, then recovery executes without a profit gate',()=>{
 const h=fixture(),p=open(h);market(h,T+2200,104);market(h,T+3300,102.5,0);assert(p.exit_intent);market(h,T+4400,102,0);assert.equal(p.execution_blocker,'EXIT_NO_OBSERVED_LIQUIDITY');assert.equal(p.qty,p.initial_qty);market(h,T+5500,100,100);assert(!h.b.a.positions[p.plan.id]);assert(D(h.events.find(e=>e.type==='CLOSED').pnl).lt(0));
});
test('funding gap and disconnect preserve last peak; recovered quote cannot invent interval highs or stops',()=>{
 const h=fixture(),p=open(h);market(h,T+2200,104);const peak=p.profit_protection.peak_net;market(h,T+3300,105,100,{});assert.equal(p.profit_protection.peak_net,peak);assert.equal(p.execution_blocker,'TRAILING_FUNDING_UNRESOLVED');assert(!p.exit_intent);
 h.time(T+20000);h.b.market(quote(T+3300,105),null,{},T+20000);assert.equal(p.profit_protection.peak_net,peak);assert(!p.exit_intent);market(h,T+21000,104,100,{[H]:0});assert.equal(p.profit_protection.peak_net,peak);assert.equal(p.funding_pending.length,0);assert(p.data_gaps.length);assert(!h.events.some(e=>e.type==='CLOSED'));
});
test('target with excessive realised financing is labelled insufficient and closes only by original deadline',()=>{
 const h=fixture(),p=open(h);p.accrued_funding='5';market(h,T+2200,103);assert.equal(p.profit_protection.state,'OPEN_BEFORE_TARGET');assert.equal(h.events.find(e=>e.type==='TARGET_REACHED_NET_INSUFFICIENT').reason,'NET_BELOW_ACTIVATION_MINIMUM');assert(!p.exit_intent);const at=p.expires_at;market(h,at,103);assert.equal(p.exit_intent.reason,'TIMEOUT');market(h,at+1100,103);assert.equal(h.events.find(e=>e.type==='CLOSED').reason,'TIMEOUT');
});
test('recent activation extends the original 30-minute deadline, with fixed maximum and stagnation exit',()=>{
 const h=fixture(),p=open(h),at=p.expires_at-1000;market(h,at,103);const limit=p.profit_protection.effective_expires_at;assert.equal(limit,p.expires_at+900000);market(h,p.expires_at+2000,103.1);assert(!p.exit_intent);assert.equal(p.profit_protection.effective_expires_at,limit);
 const lastPeak=p.profit_protection.peak_at;market(h,lastPeak+600000,103.1);assert.equal(p.exit_intent.reason,'TRAILING_STAGNATION');assert.equal(p.profit_protection.effective_expires_at,limit);
});
test('profit profile does not restore historical loss limits, resize after loss, or duplicate topups',()=>{
 const h=fixture({cash:'1'}),primary=structuredClone(h.root.research);Object.assign(h.b.x,{status:'HALTED_DRAWDOWN',loss_streak:99,cooldown_until:T+999999,day_start:'10000'});h.b.a.halted=true;h.root.frequency.daySelections=100000;
 const p=open(h);assert.equal(h.b.x.capital.count,1);assert.equal(h.b.a.net,'0');market(h,T+2200,98.9);market(h,T+3300,98.8);assert(D(h.b.a.net).lt(0));restart(h,T+4400);const next=plan(h,{id:'after-loss',at:T+4400,confirmation:T+3300});assert.equal(h.b.choose(next,quote(T+4400),META,T+4400),'ENTRY_PENDING');assert.equal(h.b.a.pendingOrders[next.id].plan.sizing.nominal_usd,'100');assert.equal(h.b.a.pendingOrders[next.id].plan.sizing.leverage,2);assert.deepEqual(h.root.research,primary);assert.equal(h.root.laboratory.trials[0].status,'REJECTED');
});
test('existing pending orders and positions retain original target-close contracts when new policy activates',()=>{
 const h=fixture({profit:false}),p=open(h,plan(h,{profit:false})),pending=plan(h,{id:'legacy-pending',pattern:'PULLBACK',profit:false,at:T+1100});assert.equal(h.b.choose(pending,quote(T+1100),META,T+1100),'ENTRY_PENDING');
 const before=structuredClone(h.b.a);installProfitPolicy(h.root,ENV,T+1200);assert.deepEqual(h.b.a,before);restart(h,T+1300);assert(!h.b.a.positions[p.plan.id].plan.exit_policy);market(h,T+2200,103);market(h,T+3300,103);assert.equal(h.events.find(e=>e.type==='CLOSED').reason,'STRUCTURAL_TARGET');assert(!h.events.some(e=>e.type==='TARGET_REACHED'));
});

const bars=(tf,fn)=>Array.from({length:96},(_,i)=>({start:C-(96-i)*tf*60000,end:C-(95-i)*tf*60000,volume:1,...fn(i)}));
function patternFixture(pattern){
 if(pattern==='BREAKOUT'){const s={5:bars(5,()=>({open:199.9,high:200.2,low:199.7,close:199.9})),15:bars(15,()=>({open:199.9,high:200.2,low:199.7,close:199.9}))};Object.assign(s[5].at(-1),{open:199.9,high:200.9,low:199.9,close:200.8,volume:2});return {s,bid:200.8};}
 if(pattern==='PULLBACK'){const fn=i=>({open:190+i*.1-.01,close:190+i*.1,low:190+i*.1-.03,high:190+i*.1+.06}),s={5:bars(5,fn),15:bars(15,fn)};s[5].at(-5).high=202;Object.assign(s[5].at(-1),{open:199.45,close:199.6,low:198.8,high:199.65});return {s,bid:199.6};}
 const s={5:bars(5,i=>{const p=i%2?201:199;return {open:p,close:p,low:p-.1,high:p+.1};}),15:bars(15,()=>({open:200,close:200,low:199.9,high:200.1}))};Object.assign(s[5].at(-1),{open:198.2,close:198.3,low:197.7,high:198.5});return {s,bid:198.3};
}
for(const pattern of ['BREAKOUT','PULLBACK','RANGE_REENTRY'])test('causal '+pattern+' detection reaches economic admission, fill, target activation and close',()=>{
 const h=fixture(),{s,bid}=patternFixture(pattern),row=entryCandidates(s,quote(T,bid),META,C,T,0,getExplorationPolicy(h.root),getProfitPolicy(h.root)).find(d=>d.pattern===pattern);assert(row.plan,JSON.stringify(row));const p=open(h,row.plan,{bid});const target=Number(p.plan.target);market(h,T+2200,target);assert.equal(p.profit_protection.state,'TRAILING_ACTIVE');assert(!p.exit_intent);market(h,T+3300,target+1);market(h,T+4400,target);assert.equal(p.exit_intent?.reason,'TRAILING_RETRACEMENT');market(h,T+5500,target);assert(h.events.some(e=>e.type==='CLOSED'&&e.id===p.plan.id));
});

test('SQLite persists trailing, pending exit, shared liquidity and one activation notification across real store restarts',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'lumi-profit-isolated-')),path=join(dir,'paper.sqlite');let now=T,store=new SQLiteStore(path,{allowEmpty:true,now:()=>now});t.after(async()=>{try{store.close();}catch{}await rm(dir,{recursive:true,force:true});});
 store.import({schema:1,exported_at:new Date(now).toISOString(),state:{id:'KRAKEN_BTCUSD_PAPER',revision:1,fence:0,lease_until:null,last_batch:null,state:initialState(now),updated_at:new Date(now).toISOString()},counts:{events:0,outbox:0},events:[],outbox:[]});
 const init=async()=>{const e=new TradingEngine({store,feed:new KrakenFeed({now:()=>now}),now:()=>now});await e.initialize();return e;};let engine=await init();engine.state.laboratory.status='RESEARCH_COMPLETE';
 Object.assign(engine.state.frequency.account,{cash:'500',equity:'500',net:'0',fees:'0',peak:'500',closed:0,wins:0,losses:0,halted:false});engine.state.laboratory.funding={initial:'500',added:'0',count:0};
 const broker=()=>new SecondaryBroker({root:engine.state,now:()=>now,event:e=>engine.event(e),notice:(...args)=>engine.notice(...args)});let b=broker();installExploration(engine.state,ENV,now,e=>engine.event(e));installProfitPolicy(engine.state,ENV,now,e=>engine.event(e));const primary=structuredClone(engine.active().account),p=plan({root:engine.state});assert.equal(b.choose(p,quote(),META,T),'ENTRY_PENDING');
 now=T+1100;b.market(quote(now),null,{[H]:0},now);now=T+2200;b.market(quote(now,104),null,{[H]:0},now);await engine.flush();const saved=structuredClone(b.a.positions[p.id].profit_protection);
 const resume=async at=>{await store.tx({phase:'RELEASE'});store.close();now=at;store=new SQLiteStore(path,{now:()=>now});engine=await init();b=broker();assert.equal(installProfitPolicy(engine.state,ENV,now),false);};
 await resume(T+3300);assert.deepEqual(b.a.positions[p.id].profit_protection,saved);b.market(quote(now,102.5),null,{[H]:0},now);await engine.flush();const intent=structuredClone(b.a.positions[p.id].exit_intent);await resume(T+4400);assert.deepEqual(b.a.positions[p.id].exit_intent,intent);b.market(quote(now,102.4,1),null,{[H]:0},now);await engine.flush();const partial=b.a.positions[p.id].qty;await resume(T+4400);b.market(quote(now,102.4,1),null,{[H]:0},now);assert.equal(b.a.positions[p.id].qty,partial);now=T+5500;b.market(quote(now,102.3),null,{[H]:0},now);await engine.flush();
 assert(!b.a.positions[p.id]);assert.equal((await store.history('CLOSED')).length,1);assert.equal((await store.history('TARGET_REACHED')).length,1);assert.equal(store.notices(100).filter(n=>n.kind==='SECONDARY_TRAILING').length,1);assert.equal(store.notices(100).filter(n=>n.kind==='SECONDARY_CLOSE').length,1);assert.deepEqual(engine.active().account,primary);assert.equal(store.db.prepare('PRAGMA quick_check').get().quick_check,'ok');
});
