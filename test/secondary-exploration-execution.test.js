// Deterministic isolated PAPER broker tests. No network, worker, live ledger or notifications.
import test from 'node:test';
import assert from 'node:assert/strict';
import {D,hash} from '../lib/trading/core.js';
import {newAccount} from '../lib/trading/simulator.js';
import {enablePortfolio} from '../lib/trading/portfolio.js';
import {SecondaryBroker,OperationalSecondary,secondaryEconomics} from '../lib/trading/secondary-futures-engine.js';
import {SECONDARY_MODEL,SECONDARY_VERSION,secondaryEstimate} from '../lib/trading/secondary-futures-math.js';
import {EXPLORATION_VERSION,EXPLORATION_ENTRY_REVISION,installExploration,getExplorationPolicy,explorationContract} from '../lib/trading/secondary-exploration.js';
const T=Date.parse('2026-11-02T02:00:02Z'),H=Math.floor(T/3600000)*3600000;
const META={symbol:'PF_XBTUSD',qty_step:.0001,tick_size:.01,checked_at:T};
const ENV={LUMI_RUNTIME_ENV:'staging',LUMI_TRADING_MODE:'PAPER',LUMI_TRADING_STORAGE:'SQLITE',LUMI_TRADING_SECONDARY_PROFILE:EXPLORATION_VERSION};
const q=(at=T,bid=100,size=100)=>({source:'KRAKEN_FUTURES_WS_TICKER',symbol:'PF_XBTUSD',event_at:at,received_at:at,bid:D(bid).toString(),ask:D(bid).plus('.01').toString(),bid_qty:String(size),ask_qty:String(size),suspended:false});
function fixture({cash='500',activate=true}={}){
 let now=T;const account=newAccount();enablePortfolio(account);Object.assign(account,{cash,equity:cash,peak:cash});
 const root={frequency:{account,counts:{evaluations:0,candidates:0,selected:0,filled:0,closed:0,notFilled:0},history:[],grossClosed:'0',closedFees:'0'},laboratory:{status:'RESEARCH_COMPLETE',active:'old',trials:[{status:'REJECTED',net:'-25'}],funding:{initial:cash,added:'0',count:0,history:[]}},research:{active:'primary',versions:{primary:{account:{cash:'100',equity:'100',net:'0'}}}}};
 const events=[],notices=[],broker=new SecondaryBroker({root,now:()=>now,event:e=>events.push(structuredClone(e)),notice:(...v)=>notices.push(structuredClone(v))});
 if(activate)installExploration(root,ENV,T,e=>events.push(e));
 return {root,broker,events,notices,time(t){now=t;},now:()=>now};
}
function plan(h,{id='p1',pattern='BREAKOUT',direction='LONG',mode='TAKER_IOC',at=T,rate=0}={}){
 const policy=structuredClone(getExplorationPolicy(h.root));policy.modes[pattern]=mode;
 if(mode!==getExplorationPolicy(h.root).modes[pattern])installExploration(h.root,{...ENV,['LUMI_TRADING_SECONDARY_'+pattern+'_EXECUTION']:mode},at);
 const c=explorationContract(getExplorationPolicy(h.root),pattern,at),short=direction==='SHORT',entry=mode==='MAKER_LIMIT'?100:D(short?q(at).bid:q(at).ask).mul(short?'.9998':'1.0002').toNumber(),stop=short?101:99,target=short?97:103;
 return {id,signal_key:hash([id,pattern,direction,at]),version:SECONDARY_VERSION,entry_revision:EXPLORATION_ENTRY_REVISION,execution_model:SECONDARY_MODEL,instrument:'PAPER:KRAKEN_FUTURES:PF_XBTUSD',pattern,direction,family:'L',recipe:pattern,recipe_title:pattern,timeframe:5,entry:String(entry),limit:'100',stop:String(stop),target:String(target),confirmed_at:Math.floor(at/300000)*300000,decision_at:at,expires_at:c.expires_at,holding_ms:1800000,order:mode==='TAKER_IOC'?'FUTURES_TAKER_IOC':'FUTURES_POST_ONLY_LIMIT',fill_model:c.liquidity_model,execution_contract:c,economics:secondaryEconomics(entry,stop,target,direction,rate,c)};
}
function market(h,at,bid=100,size=100,rates={[H]:0},trade=null){h.time(at);h.broker.market(q(at,bid,size),trade,rates,at);}
function open(h,p=plan(h),size=100){assert.equal(h.broker.choose(p,q(),META,T),'ENTRY_PENDING');market(h,T+1100,100,size);assert(h.root.frequency.account.positions[p.id]);return h.root.frequency.account.positions[p.id];}
const nearly=(a,b)=>assert(D(a).minus(b).abs().lt('0.000000000001'),`${a} != ${b}`);
test('exploration bypasses financial gates and the rejected historical trial, without touching primary or nominal size',()=>{
 const h=fixture(),primary=structuredClone(h.root.research),history=structuredClone(h.root.laboratory.trials);Object.assign(h.broker.x,{status:'HALTED_DRAWDOWN',cooldown_until:T+999999,day_start:'10000',loss_streak:99});h.broker.a.halted=true;h.root.frequency.daySelections=100000;
 for(let i=0;i<14;i++){const p=plan(h,{id:'many'+i,direction:i%2?'SHORT':'LONG'});assert.equal(h.broker.choose(p,q(),META,T),'ENTRY_PENDING');assert(D(h.broker.a.pendingOrders[p.id].plan.sizing.exposure).lte(100));assert.equal(h.broker.a.pendingOrders[p.id].plan.sizing.leverage,2);}
 assert.equal(Object.keys(h.broker.a.pendingOrders).length,14);assert.deepEqual(h.root.research,primary);assert.deepEqual(h.root.laboratory.trials,history);assert.equal(h.root.laboratory.status,'RESEARCH_COMPLETE');
});
test('an operable order obtains exactly one explicit deficit topup, preserved across retry/restart and excluded from profit',()=>{
 const h=fixture({cash:'1'}),p=plan(h);assert.equal(h.broker.choose(p,q(),META,T),'ENTRY_PENDING');const first=h.events.find(e=>e.type==='PAPER_CAPITAL_TOPUP');assert(first);assert.equal(first.balance_before,'1');assert.equal(h.broker.a.net,'0');assert.equal(h.broker.x.capital.count,1);assert.equal(h.broker.x.capital.contribution_source,'LEGACY_FUNDING_LEDGER');
 const copied=JSON.parse(JSON.stringify(h.root)),events=[],b=new SecondaryBroker({root:copied,now:()=>T+1100,event:e=>events.push(e)});assert.equal(b.choose(p,q(T+1100),META,T+1100),'DUPLICATE_SIGNAL');b.market(q(T+1100),null,{[H]:0},T+1100);assert.equal(b.x.capital.count,1);assert.equal(events.filter(e=>e.type==='PAPER_CAPITAL_TOPUP').length,0);
 b.market(q(T+2200,98.9),null,{[H]:0},T+2200);b.market(q(T+3300,98.9),null,{[H]:0},T+3300);const close=events.find(e=>e.type==='CLOSED');assert(close);nearly(D(b.a.cash).minus(1).minus(first.amount),close.pnl);assert(D(b.a.net).lt(0));nearly(b.a.net,close.pnl);assert(D(b.x.capital.total_contributed).gt(b.a.cash));
});
test('ordinary evaluations and no-signal market ticks do not create orders, positions or capital contributions',()=>{
 const h=fixture({cash:'0'});for(let i=0;i<20;i++)market(h,T+i*1000,100);
 assert.equal(Object.keys(h.broker.a.positions).length,0);assert.equal(Object.keys(h.broker.a.pendingOrders).length,0);assert.equal(h.broker.a.cash,'0');assert(!h.broker.x.capital);assert(!h.events.some(e=>e.type==='PAPER_CAPITAL_TOPUP'));
});
test('taker waits for a fresh post-latency instrument quote, uses its bid/ask and costs, never the signal close',()=>{
 const h=fixture(),p=plan(h);h.broker.choose(p,q(),META,T);market(h,T+500,100);assert(!h.broker.a.positions.p1);
 h.time(T+1100);h.broker.market({...q(T+500),received_at:T+1100},null,{[H]:0},T+1100);assert(!h.broker.a.positions.p1);
 h.broker.market({...q(T+1100),symbol:'BTC/USD'},null,{[H]:0},T+1100);assert(!h.broker.a.positions.p1);
 market(h,T+1200,100.2);const position=h.broker.a.positions.p1;assert(position);assert.equal(position.entry,D('100.21').mul('1.0002').toString());assert.notEqual(position.entry,p.entry);assert(D(position.entry_fee).gt(0));assert.equal(position.fills[0].event_at,T+1200);
});
test('a first executable IOC quote creates a partial position and cancels only the unfilled remainder',()=>{
 const h=fixture(),p=plan(h);const pos=open(h,p,.2);assert.equal(pos.qty,'.02'.replace(/^\./,'0.'));assert(!h.broker.a.pendingOrders.p1);assert.equal(h.events.filter(e=>e.type==='FILLED').length,1);assert.equal(h.events.find(e=>e.type==='FILLED').execution_state,'EJECUCIÓN_PARCIAL');const rest=h.events.find(e=>e.type==='ORDER_REMAINDER_CANCELLED');assert(rest.had_partial);assert.equal(rest.reason,'IOC_REMAINDER_CANCELLED');assert(!h.events.some(e=>e.type==='NOT_FILLED'));assert.equal(h.broker.a.reservedCash,pos.funding_reserved);assert(h.notices.some(x=>x[0]==='SECONDARY_PARTIAL'));
});
test('one quote capacity is shared between orders and cannot be reused after a persisted restart',()=>{
 const h=fixture();h.broker.choose(plan(h),q(),META,T);h.broker.choose(plan(h,{id:'p2',pattern:'PULLBACK'}),q(),META,T);market(h,T+1100,100,.5);
 const total=Object.values(h.broker.a.positions).reduce((s,p)=>s.plus(p.qty),D(0));assert(total.eq('.05'));assert.equal(h.events.filter(e=>e.type==='FILLED').length,1);assert(h.events.some(e=>e.reason==='IOC_NO_OBSERVED_LIQUIDITY'));
 const r=JSON.parse(JSON.stringify(h.root)),b=new SecondaryBroker({root:r,now:()=>T+1100});assert(b.quoteAvailable(q(T+1100,100,.5),'ask','.1').eq(0));b.market(q(T+1100,100,.5),null,{[H]:0},T+1100);assert.equal(Object.keys(b.a.positions).length,1);
});
test('zero displayed liquidity produces no fill and a distinct cancellation rather than a fictional loss',()=>{
 const h=fixture();h.broker.choose(plan(h),q(),META,T);market(h,T+1100,100,0);assert.equal(Object.keys(h.broker.a.positions).length,0);assert.equal(h.broker.a.closed,0);assert.equal(h.broker.a.net,'0');assert.equal(h.events.find(e=>e.type==='NOT_FILLED').reason,'IOC_NO_OBSERVED_LIQUIDITY');
});
test('maker credits accumulate only through post-order trades, are not reused, and survive partial entry restart',()=>{
 const h=fixture(),p=plan(h,{mode:'MAKER_LIMIT'}),meta={...META,qty_step:.1};h.broker.choose(p,q(),meta,T);market(h,T+1100);assert(h.broker.a.pendingOrders.p1.posted_at);
 const tr=(id,at)=>({id,symbol:'PF_XBTUSD',source:'KRAKEN_FUTURES_WS_TRADE',price:99.99,qty:.6,side:'sell',event_at:at,received_at:at});market(h,T+2200,99.98,100,{[H]:0},tr('one',T+2200));assert(!h.broker.a.positions.p1);assert(D(h.broker.a.pendingOrders.p1.observed_capacity).eq('.06'));
 market(h,T+3300,99.98,100,{[H]:0},tr('two',T+3300));assert(D(h.broker.a.positions.p1.qty).eq('.1'));assert(D(h.broker.a.pendingOrders.p1.remaining_reserved).lt(p.sizing?.reserved??100));
 const root=JSON.parse(JSON.stringify(h.root)),events=[],b=new SecondaryBroker({root,now:()=>T+3400,event:e=>events.push(e)});b.market(q(T+3400,99.98),tr('two',T+3300),{[H]:0},T+3400);assert(D(b.a.positions.p1.qty).eq('.1'));assert.equal(events.filter(e=>['FILLED','PARTIAL_FILL'].includes(e.type)).length,0);
 b.market(q(T+4400,99.98),tr('three',T+4400),{[H]:0},T+4400);assert(D(b.a.pendingOrders.p1.observed_capacity).eq('.08'));assert(D(b.a.positions.p1.qty).eq('.1'));
});
test('unfilled maker expiry during disconnection remains an expiry and does not require a fabricated quote',()=>{
 const h=fixture(),p=plan(h,{mode:'MAKER_LIMIT'});h.broker.choose(p,q(),META,T);h.time(p.expires_at+1);h.broker.market(null,null,{},p.expires_at+1);assert(!h.broker.a.pendingOrders.p1);assert.equal(h.events.find(e=>e.type==='NOT_FILLED').order_state,'ORDEN_VENCIDA');assert.equal(h.broker.a.net,'0');
});
test('partially closed positions conserve cash and record one aggregate close with allocated costs',()=>{
 const h=fixture(),before=h.broker.a.cash,p=open(h),total=p.qty;market(h,T+2200,98.9,.5);assert.equal(h.broker.a.positions.p1.execution_blocker,'EXIT_LATENCY_PENDING');market(h,T+3300,98.9,.5);assert(h.broker.a.positions.p1);assert.equal(h.events.filter(e=>e.type==='PARTIAL_CLOSE').length,1);assert.equal(h.broker.a.closed,0);assert(D(h.broker.a.positions.p1.qty).lt(total));
 market(h,T+4400,98.8,100);assert(!h.broker.a.positions.p1);assert.equal(h.broker.a.closed,1);const closed=h.events.find(e=>e.type==='CLOSED');assert.equal(closed.qty,total);nearly(D(h.broker.a.cash).minus(before),closed.pnl);nearly(h.broker.a.net,closed.pnl);nearly(h.broker.a.fees,closed.fees);
});
test('data and restart gaps preserve orders/positions, record uncertainty, and resume without manufactured stops',()=>{
 const h=fixture(),p=open(h);h.time(T+20000);h.broker.market(q(T+1100),null,{[H]:0},T+20000);assert(h.broker.a.positions.p1);assert.equal(p.quality,'UNRESOLVED_MARKET_GAP');assert(!p.exit_requested);market(h,T+21000,100.1);assert(h.broker.a.positions.p1);assert(!h.events.some(e=>e.type==='CLOSED'));assert.equal(p.data_gaps[0].to,T+21000);
 const pending=plan(h,{id:'still-pending',at:T+21000});h.broker.choose(pending,q(T+21000,100.1),META,T+21000);const clone=JSON.parse(JSON.stringify(h.root)),engine={state:clone,event(){},notice(){}},runtime=new OperationalSecondary({engine,now:()=>T+22000}).initialize();assert(runtime.broker.a.pendingOrders['still-pending']);assert(runtime.broker.a.positions.p1);assert(!runtime.broker.a.positions.p1.exit_requested);
});
test('unknown funding is explicit, never fabricated, and later reconciles open or closed positions',()=>{
 const h=fixture(),p=open(h);market(h,T+2200,100,100,{});assert(D(p.accrued_funding).eq(0));assert(p.funding_pending.length);assert.equal(secondaryEstimate(p,q(T+2200),T+2200).funding_complete,false);market(h,T+3300,100,100,{[H]:.25});assert.equal(p.funding_pending.length,0);nearly(p.accrued_funding,D('.25').mul(p.qty).mul(2200/3600000));
 market(h,T+4400,98.9,100,{});market(h,T+5500,98.9,100,{});assert(!h.broker.a.positions.p1);const closed=h.events.find(e=>e.type==='CLOSED');assert.equal(closed.result_final,false);assert(h.broker.x.closed_funding_pending.p1);const cash=h.broker.a.cash,net=h.broker.a.net;h.time(T+6600);h.broker.market(null,null,{[H]:.25},T+6600);assert(!h.broker.x.closed_funding_pending.p1);assert.equal(h.broker.a.equity,h.broker.a.cash);assert.equal(h.broker.a.availableCash,h.broker.a.cash);const adjustment=h.events.find(e=>e.type==='FUNDING_RECONCILED');assert(adjustment);assert(D(adjustment.amount).gt(0));nearly(D(cash).minus(h.broker.a.cash),adjustment.amount);nearly(D(net).minus(h.broker.a.net),adjustment.amount);
});
test('cost-negative exploratory goals do not close instantly, do not shift targets, and retain explicit structural exits',()=>{
 const h=fixture(),p=plan(h,{rate:100});assert(p.economics.gain<0);open(h,p);market(h,T+2200,100);assert(h.broker.a.positions.p1);assert.equal(h.broker.a.positions.p1.plan.target,'103');market(h,T+3300,103.1);assert(h.broker.a.positions.p1.exit_intent);market(h,T+4400,103);assert.equal(h.events.find(e=>e.type==='CLOSED').reason,'STRUCTURAL_TARGET');
});
test('losses do not change fixed nominal sizing or end exploration after restart',()=>{
 const h=fixture();open(h);market(h,T+2200,98.9);market(h,T+3300,98.9);assert(D(h.broker.a.net).lt(0));const at=T+4400,p=plan(h,{id:'after-loss',at});assert.equal(h.broker.choose(p,q(at),META,at),'ENTRY_PENDING');assert.equal(h.broker.a.pendingOrders[p.id].plan.sizing.nominal_usd,'100');assert.equal(h.broker.a.pendingOrders[p.id].plan.sizing.leverage,2);assert.equal(h.broker.x.cooldown_until,0);
});
test('legacy pending maker contracts retain strict single-trade 20x execution after exploration activation',()=>{
 const h=fixture({activate:false}),legacy={id:'legacy',version:SECONDARY_VERSION,execution_model:SECONDARY_MODEL,instrument:'PAPER:KRAKEN_FUTURES:PF_XBTUSD',pattern:'BREAKOUT',direction:'LONG',timeframe:5,entry:'100',limit:'100',stop:'99',target:'103',confirmed_at:T-2000,decision_at:T,expires_at:T+120000,holding_ms:1800000,order:'FUTURES_POST_ONLY_LIMIT',fill_model:'OBSERVED_TRADE_THROUGH_20X',economics:secondaryEconomics(100,99,103,'LONG',0)};
 assert.equal(h.broker.choose(legacy,q(),META,T),'ENTRY_PENDING');const saved=structuredClone(h.broker.a.pendingOrders.legacy.plan);installExploration(h.root,ENV,T);assert.deepEqual(h.broker.a.pendingOrders.legacy.plan,saved);market(h,T+1100);
 const qty=D(saved.sizing.qty);for(let i=0;i<3;i++){const at=T+2200+i*1000;market(h,at,99.98,100,{[H]:0},{id:'small'+i,price:99.99,qty:qty.mul(19).toNumber(),side:'sell',event_at:at,received_at:at});assert(!h.broker.a.positions.legacy);}
 const at=T+5500;market(h,at,99.98,100,{[H]:0},{id:'large',price:99.99,qty:qty.mul(20).toNumber(),side:'sell',event_at:at,received_at:at});assert(h.broker.a.positions.legacy);assert.equal(h.broker.a.positions.legacy.plan.execution_contract,undefined);assert.equal(h.broker.a.positions.legacy.entry,'100');
});
test('post-only instrument state blocks taker entry and waits honestly for an executable exit',()=>{
 const h=fixture({cash:'1'}),p=plan(h);assert.equal(h.broker.choose(p,{...q(),post_only:true},META,T),'INSTRUMENT_POST_ONLY');assert(!h.events.some(e=>e.type==='PAPER_CAPITAL_TOPUP'));assert.equal(h.broker.choose(p,q(),META,T),'ENTRY_PENDING');h.time(T+1100);h.broker.market({...q(T+1100),post_only:true},null,{[H]:0},T+1100);assert(!h.broker.a.positions.p1);assert.equal(h.events.find(e=>e.type==='NOT_FILLED').reason,'INSTRUMENT_POST_ONLY');
 const other=fixture();open(other);other.time(T+2200);other.broker.market({...q(T+2200,98.9),post_only:true},null,{[H]:0},T+2200);assert(other.broker.a.positions.p1);assert.equal(other.broker.a.positions.p1.execution_blocker,'EXIT_LATENCY_PENDING');other.time(T+3300);other.broker.market({...q(T+3300,98.9),post_only:true},null,{[H]:0},T+3300);assert.equal(other.broker.a.positions.p1.execution_blocker,'INSTRUMENT_POST_ONLY_EXIT');market(other,T+4400,98.8);assert.equal(other.events.find(e=>e.type==='CLOSED').reason,'STOP');
});
test('validated perpetual ticker omission means zero funding and non-book trades never feed maker fills',()=>{
 const h=fixture(),handlers={},socket={addEventListener:(name,fn)=>handlers[name]=fn,send(){}},engine={state:h.root,event:e=>h.events.push(e),notice(){}},runtime=new OperationalSecondary({engine,now:h.now,socketFactory:()=>socket}).initialize();runtime.stopped=false;runtime.connect();
 const emit=data=>handlers.message({data:JSON.stringify(data)});emit({feed:'ticker',product_id:'PF_XBTUSD',time:T,bid:100,ask:100.01,bid_size:100,ask_size:100,post_only:true});assert.equal(runtime.rates[H],0);assert.equal(runtime.quote.post_only,true);
 const base={feed:'trade',product_id:'PF_XBTUSD',time:T,side:'sell',price:99.99,qty:100};for(const type of ['block','termination','assignment'])emit({...base,type,uid:type});emit({...base,type:'fill',uid:'eligible'});emit({...base,type:'liquidation',uid:'eligible-liquidation'});assert.equal(runtime.queue.filter(x=>x.kind==='trade').length,2);assert(runtime.queue.filter(x=>x.kind==='trade').every(x=>['fill','liquidation'].includes(x.t.type)));
});
test('a future exchange timestamp on a pre-latency received quote cannot trigger an entry',()=>{
 const h=fixture(),p=plan(h);h.broker.choose(p,q(),META,T);const early={...q(T+1100),received_at:T+500};h.time(T+500);h.broker.market(early,null,{[H]:0},T+500);h.time(T+1100);h.broker.market(early,null,{[H]:0},T+1100);assert(!h.broker.a.positions.p1);assert(h.broker.a.pendingOrders.p1);market(h,T+1200);assert(h.broker.a.positions.p1);
});
test('expiry of a partly filled maker releases its remaining reservation without deleting the position or recording a loss',()=>{
 const h=fixture(),p=plan(h,{mode:'MAKER_LIMIT'});h.broker.choose(p,q(),META,T);market(h,T+1100);market(h,T+2200,99.98,100,{[H]:0},{id:'partial',type:'fill',symbol:'PF_XBTUSD',source:'KRAKEN_FUTURES_WS_TRADE',side:'sell',price:99.99,qty:1,event_at:T+2200,received_at:T+2200});assert(h.broker.a.positions.p1);assert(h.broker.a.pendingOrders.p1);h.time(p.expires_at+1);h.broker.market(null,null,{[H]:0},p.expires_at+1);assert(h.broker.a.positions.p1);assert(!h.broker.a.pendingOrders.p1);assert.equal(h.broker.a.closed,0);const e=h.events.find(e=>e.type==='ORDER_REMAINDER_CANCELLED');assert.equal(e.order_state,'ORDEN_VENCIDA');assert.equal(e.had_partial,true);
});
test('exit latency and its trigger survive persistence, reject an early received quote, and use the later available price',()=>{
 const h=fixture();open(h);market(h,T+2200,103.1);const intent=structuredClone(h.broker.a.positions.p1.exit_intent);assert.equal(intent.not_before,T+3200);assert.equal(intent.reason,'STRUCTURAL_TARGET');assert.equal(h.broker.a.closed,0);
 const root=JSON.parse(JSON.stringify(h.root)),events=[],b=new SecondaryBroker({root,now:()=>T+3400,event:e=>events.push(e)});b.market({...q(T+3400,102.8),received_at:T+2500},null,{[H]:0},T+3400);assert(b.a.positions.p1);assert.deepEqual(b.a.positions.p1.exit_intent,intent);b.market(q(T+3500,102.7),null,{[H]:0},T+3500);const close=events.find(e=>e.type==='CLOSED');assert(close);assert.equal(close.reason,'STRUCTURAL_TARGET');assert.equal(close.price,D('102.7').mul('.9998').toString());assert.notEqual(close.price,'103');assert.deepEqual(close.exit_intent,intent);
});
test('a conditional net-goal intent cannot veto an observed stop or timeout after its condition stops holding',()=>{
 const h=fixture(),p=open(h);p.management={override:true,net_goal:'.1',not_before:T};market(h,T+2200,101);assert.equal(p.exit_intent.reason,'NET_TARGET');market(h,T+3300,98.5);assert.equal(p.exit_intent.reason,'STOP');assert(h.events.some(e=>e.type==='SECONDARY_EXIT_INTENT_CANCELLED'));assert.equal(h.broker.a.closed,0);market(h,T+4400,98.4);assert.equal(h.events.find(e=>e.type==='CLOSED').reason,'STOP');
});
test('a stop intent survives an empty book and restart, then closes at observed price even after price recovery',()=>{
 const h=fixture();open(h);market(h,T+2200,98.9);market(h,T+3300,98.8,0);assert(h.broker.a.positions.p1);assert.equal(h.broker.a.positions.p1.exit_intent.reason,'STOP');const root=JSON.parse(JSON.stringify(h.root)),events=[],b=new SecondaryBroker({root,now:()=>T+4400,event:e=>events.push(e)});b.market(q(T+4400,100),null,{[H]:0},T+4400);const close=events.find(e=>e.type==='CLOSED');assert(close);assert.equal(close.reason,'STOP');assert.equal(close.price,D(100).mul('.9998').toString());
});
test('funding of partial exits is reconciled once and pattern totals match actual realised net and costs',()=>{
 const h=fixture(),cash=h.broker.a.cash,p=open(h);market(h,T+2200,98.9,100,{});market(h,T+3300,98.9,.5,{});assert(p.closed_funding_pending.length);assert(h.broker.a.positions.p1);const prior=h.broker.a.net;market(h,T+4400,98.9,0,{[H]:1});assert.equal(p.closed_funding_pending.length,0);assert(D(h.broker.a.net).lt(prior));assert(h.events.some(e=>e.type==='FUNDING_RECONCILED'&&e.position_open));market(h,T+5500,98.9,100,{[H]:1});const closed=h.events.find(e=>e.type==='CLOSED');assert(closed);assert.equal(closed.result_final,true);nearly(D(h.broker.a.cash).minus(cash),closed.pnl);nearly(h.broker.a.net,closed.pnl);const stats=Object.values(h.broker.x.by_pattern_version)[0];assert.equal(stats.filled,1);assert.equal(stats.closed,1);nearly(stats.costs,h.broker.a.fees);nearly(stats.net,h.broker.a.net);assert(D(stats.funding).gt(0));
});
test('profit-only exits cannot treat unresolved funding as zero, including an intent created before the funding gap',()=>{
 for(const manual of [false,true]){
  const h=fixture(),p=open(h);if(manual)p.close_request={id:'manual-profit',mode:'PROFIT',not_before:T,expires_at:T+60000};else p.management={override:true,net_goal:'.1',not_before:T};
  market(h,T+2200,101);assert(p.exit_intent);market(h,T+3300,101,100,{});assert(h.broker.a.positions.p1);assert.equal(h.broker.a.closed,0);assert(!p.exit_intent);assert(p.funding_pending.length);market(h,T+4400,101,100,{[H]:.25});assert(p.exit_intent);market(h,T+5500,101,100,{[H]:.25});assert.equal(h.events.find(e=>e.type==='CLOSED').reason,manual?'MANUAL_PROFIT':'NET_TARGET');
 }
});
test('spread and slippage are recorded explicitly but never debited a second time from realised profit',()=>{
 const h=fixture(),cash=h.broker.a.cash,p=open(h),fill=h.events.find(e=>e.type==='FILLED');assert.equal(fill.raw_quote_price,'100.01');assert.equal(fill.observed_spread_usd_per_btc,'.01'.replace(/^\./,'0.'));assert(D(fill.slippage_cost).gt(0));assert(D(fill.spread_cost_vs_mid).gt(0));assert.equal(p.fills[0].slippage_cost,fill.slippage_cost);market(h,T+2200,103.1);market(h,T+3300,103);const close=h.events.find(e=>e.type==='CLOSED');assert(D(close.exit_slippage_cost).gt(0));assert(D(close.exit_spread_cost_vs_mid).gt(0));assert.equal(close.costs_embedded_in_prices,true);nearly(D(h.broker.a.cash).minus(cash),close.pnl);nearly(D(close.gross).minus(close.fees),close.pnl);
});
test('restoration refuses corrupt new execution state or a missing contract hash instead of silently ignoring exposure',()=>{
 const h=fixture();open(h);
 for(const tamper of [r=>r.frequency.account.positions.p1.qty='-1',r=>r.frequency.account.positions.p1.qty='NaN',r=>delete r.frequency.account.positions.p1.plan.hash]){
  const root=structuredClone(h.root);tamper(root);assert.throws(()=>new SecondaryBroker({root,now:()=>T+2000}),/INTEGRITY/);
 }
 const pending=fixture();pending.broker.choose(plan(pending),q(),META,T);const clone=structuredClone(pending.root);clone.frequency.account.pendingOrders.p1.remaining_qty='0';assert.throws(()=>new SecondaryBroker({root:clone,now:()=>T+500}),/STATE_INTEGRITY/);
 assert.doesNotThrow(()=>new SecondaryBroker({root:JSON.parse(JSON.stringify(h.root)),now:()=>T+2000}));
});
test('historical funding older than 96 hours survives refresh until its explicit obligation is reconciled exactly once',async()=>{
 const h=fixture();open(h);market(h,T+2200,98.9,100,{});market(h,T+3300,98.9,100,{});assert(h.broker.x.closed_funding_pending.p1);const before=h.broker.a.cash,now=T+120*3600000;h.time(now);
 const requests=[],engine={state:h.root,event:e=>h.events.push(e),notice(){}},fetchImpl=async url=>{requests.push(url);return {ok:true,json:async()=>url.includes('historical-funding-rates')?{rates:[{timestamp:new Date(H).toISOString(),fundingRate:1},{timestamp:new Date(H-3600000).toISOString(),fundingRate:2}]}:{candles:[]}};};
 const runtime=new OperationalSecondary({engine,now:h.now,fetchImpl}).initialize();runtime.meta={...META,checked_at:now};runtime.stopped=false;await runtime.refresh();assert.equal(runtime.feedError,null);assert.equal(runtime.rates[H],1);assert.equal(runtime.rates[H-3600000],undefined);assert(requests.some(url=>url.endsWith('/historical-funding-rates?symbol=PF_XBTUSD')));
 runtime.broker.market(null,null,runtime.rates,now);const adjustment=h.events.find(e=>e.type==='FUNDING_RECONCILED');assert(adjustment);assert(!runtime.state.closed_funding_pending.p1);nearly(D(before).minus(runtime.broker.a.cash),adjustment.amount);const settled=runtime.broker.a.cash;
 runtime.broker.market(null,null,runtime.rates,now);assert.equal(runtime.broker.a.cash,settled);assert.equal(h.events.filter(e=>e.type==='FUNDING_RECONCILED').length,1);await runtime.refresh();assert.equal(runtime.rates[H],undefined);
});
test('funding refresh retains only old rates needed by open, partially closed or not-yet-accrued exposure',async()=>{
 const h=fixture(),p=open(h),now=T+120*3600000;h.time(now);const openHour=H-2*3600000,partialHour=H-3*3600000,unneededHour=H-4*3600000;
 p.last_funding_at=H+3600000;p.funding_pending=[{hour:openHour,from:openHour,to:openHour+1000,qty:p.qty}];p.closed_funding_pending=[{hour:partialHour,from:partialHour,to:partialHour+1000,qty:'.0001'}];
 const engine={state:h.root,event(){},notice(){}},fetchImpl=async url=>({ok:true,json:async()=>url.includes('historical-funding-rates')?{rates:[openHour,partialHour,H+3600000,unneededHour].map(hour=>({timestamp:new Date(hour).toISOString(),fundingRate:1}))}:{candles:[]}}),runtime=new OperationalSecondary({engine,now:h.now,fetchImpl}).initialize();runtime.meta={...META,checked_at:now};runtime.stopped=false;await runtime.refresh();
 assert.equal(runtime.rates[openHour],1);assert.equal(runtime.rates[partialHour],1);assert.equal(runtime.rates[H+3600000],1);assert.equal(runtime.rates[unneededHour],undefined);
 // Simulate reconciliation having consumed the known intervals. No obligation
 // without a source is discarded by refresh; only the cached rates are pruned.
 p.funding_pending=[];p.closed_funding_pending=[];p.last_funding_at=now;await runtime.refresh();assert.equal(runtime.rates[openHour],undefined);assert.equal(runtime.rates[partialHour],undefined);assert.equal(runtime.rates[H+3600000],undefined);
});
