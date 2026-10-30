// Synthetic execution fixtures, not evidence of profitable market performance.
import test from 'node:test';
import assert from 'node:assert/strict';
import {D,POLICY,hash} from '../lib/trading/core.js';
import {newAccount,select,step,cancel,cancelAll,repairPosition,mark} from '../lib/trading/simulator.js';
import {enablePortfolio,positions,orders,syncPortfolio,initializePortfolio,PORTFOLIO_VERSION} from '../lib/trading/portfolio.js';
import {initialState,TradingEngine} from '../lib/trading/engine.js';
import {initializeFrequency} from '../lib/trading/frequency.js';
import {initializeLaboratory,TradingLaboratory} from '../lib/trading/laboratory.js';
import {KrakenFeed} from '../lib/trading/feed.js';
const start=Date.parse('2026-10-29T16:00:00Z');
function fixture(){const a=newAccount();enablePortfolio(a);const q={ask:'80000',bid:'79999.9',ask_qty:'1',bid_qty:'1',event_at:start,received_at:start},meta={lot_decimals:8,ordermin:'.00001',costmin:'1',tick_size:'.1'};return {a,q,meta};}
function plan(i,extra={}){const p={id:'p'+i,version:'rule@'+PORTFOLIO_VERSION,family:'L',direction:'LONG',recipe:'r'+i,confirmed_at:start,decision_at:start,entry:'80100',limit:'80150',stop:'78000',target:'87000',atr1:1000,holding_ms:3600000,expires_at:start+120000,setup:{family:'L'},...extra};p.hash=hash(p);return p;}
function feed(q,price,at){return {quote:{...q,event_at:at,received_at:at},trade:{price,event_at:at,received_at:at}};}
test('three conditional entries share cash and risk, refuse a fourth and deduplicate an opportunity',()=>{
 const {a,q,meta}=fixture();for(let i=0;i<3;i++)assert.equal(select(a,plan(i),q,meta,start).type,'SELECTED');
 assert.equal(orders(a).length,3);assert.equal(a.cash,'100');assert(D(a.reservedCash).lte(90));assert(D(a.openRiskReserved).lte(1));
 assert.equal(select(a,plan(3),q,meta,start).reason,'PORTFOLIO_SLOTS_FULL');
 assert.equal(select(a,plan(0),q,meta,start).reason,'DUPLICATE_OPPORTUNITY');
 const restored=JSON.parse(JSON.stringify(a));const released=orders(restored)[0].plan.sizing.reserved;cancel(restored,'VENCIDA',start+1,'p0');assert.equal(orders(restored).length,2);assert(D(restored.reservedCash).eq(D(a.reservedCash).minus(released)));
 assert.equal(select(restored,plan(0),q,meta,start).reason,'DUPLICATE_OPPORTUNITY');
});
test('three fills and independent exits reconcile exactly without duplicate capital or fees after restart',()=>{
 let {a,q,meta}=fixture();for(let i=0;i<3;i++)select(a,plan(i),q,meta,start);
 let f=feed({...q,ask:'80100',bid:'80099.9'},'80100',start+1100);const fills=step(a,f,start+1100);assert.equal(fills.filter(e=>e.type==='FILLED').length,3);assert.equal(positions(a).length,3);assert.equal(orders(a).length,0);
 const entryCosts=positions(a).reduce((s,p)=>s.plus(p.total_entry),D(0));assert(D(a.cash).plus(entryCosts).eq(100));
 const ids=positions(a).map(p=>p.plan.id);a=JSON.parse(JSON.stringify(a));a.positions[ids[0]].expires_at=start+2000;
 const one=step(a,feed(f.quote,'80100',start+2000),start+2000);assert.equal(one.filter(e=>e.type==='CLOSED').length,1);assert.equal(positions(a).length,2);assert.equal(a.closed,1);
 const rest=step(a,feed({...q,ask:'88000.1',bid:'88000'},'88000',start+3000),start+3000);assert.equal(rest.filter(e=>e.type==='CLOSED').length,2);assert.equal(positions(a).length,0);assert.equal(a.closed,3);assert(D(a.cash).eq(D(100).plus(a.net)));assert(D(a.equity).eq(a.cash));
 const closed=[...one,...rest].filter(e=>e.type==='CLOSED');assert(D(a.fees).eq(closed.reduce((s,e)=>s.plus(e.fees),D(0))));assert(closed.every(e=>e.policy_version===plan(0).version));
 assert.equal(step(a,feed(q,'88000',start+4000),start+4000).length,0);
});
test('risk can reach USD1 but cannot exceed it or the available daily budget',()=>{
 const {a,q,meta}=fixture();let e=select(a,plan(1,{stop:'60000',target:'150000'}),q,meta,start);assert.equal(e.type,'SELECTED');assert(D(e.plan.sizing.risk).lte(1));assert(D(e.plan.sizing.risk).gt('.99'));
 assert.equal(select(a,plan(2),q,meta,start).type,'SUPPRESSED');
 const h=fixture();h.a.day=new Date(start).toISOString().slice(0,10);h.a.dayStart='100';h.a.cash=h.a.equity='99.3';e=select(h.a,plan(1,{stop:'60000',target:'150000'}),h.q,h.meta,start);assert.equal(e.type,'SELECTED');assert(D(e.plan.sizing.risk).lte('.3'));
 const low=fixture();low.a.cash=low.a.equity=low.a.peak=low.a.dayStart='20';e=select(low.a,plan(1,{stop:'70000',target:'120000'}),low.q,low.meta,start);assert.equal(e.type,'SELECTED');assert(D(e.plan.sizing.risk).lte('.2'));
});
test('round-trip costs must be covered without moving the original target, but stop still closes at a loss',()=>{
 const {a,q,meta}=fixture(),bad=plan(0,{target:'80500'}),before=structuredClone(bad);assert.equal(select(a,bad,q,meta,start).reason,'NET_RR_TOO_LOW');assert.deepEqual(bad,before);
 const e=select(a,plan(1),q,meta,start);assert(D(e.plan.sizing.target_net).gt(0));assert(D(e.plan.sizing.target_net).gte(D(e.plan.sizing.risk).mul('1.5')));assert(D(e.plan.sizing.break_even).gt(e.plan.limit));
 step(a,feed({...q,ask:'80100',bid:'80099.9'},'80100',start+1100),start+1100);
 const stop=step(a,feed({...q,ask:'77500.1',bid:'77500'},'77500',start+2000),start+2000).find(e=>e.type==='CLOSED');assert.equal(stop.reason,'STOP');assert(D(stop.pnl).lt(0));assert.equal(positions(a).length,0);
});
test('a shared quote cannot supply the same displayed capacity to every pending entry',()=>{
 const {a,q,meta}=fixture();for(let i=0;i<3;i++)select(a,plan(i),q,meta,start);const qty=orders(a)[0].plan.sizing.qty;
 const f=feed({...q,ask:'80100',bid:'80099.9',ask_qty:D(qty).mul(10).toString(),bid_qty:D(qty).mul(10).toString()},'80100',start+1100);
 assert.equal(step(a,f,start+1100).filter(e=>e.type==='FILLED').length,1);assert.equal(positions(a).length,1);assert.equal(orders(a).length,2);
 assert.equal(step(a,f,start+1200).filter(e=>e.type==='FILLED').length,0);assert.equal(orders(a).length,2);
});
test('multiple open positions reconcile gaps conservatively and only once',()=>{
 const {a,q,meta}=fixture();for(let i=0;i<3;i++)select(a,plan(i),q,meta,start);step(a,feed({...q,ask:'80100',bid:'80099.9'},'80100',start+1100),start+1100);
 const out=repairPosition(a,[],feed(q,'80000',start+60000),start+60000,start+1100);assert.equal(out.filter(e=>e.type==='CLOSED').length,3);assert(out.filter(e=>e.type==='CLOSED').every(e=>e.quality==='UNRESOLVED_GAP'));assert.equal(positions(a).length,0);assert(D(a.cash).eq(D(100).plus(a.net)));assert.equal(repairPosition(a,[],feed(q,'80000',start+61000),start+61000,start).length,0);
});
test('schema migration keeps legacy frozen order and balances; rerunning it does not duplicate a slot',()=>{
 const s=initialState(start);initializeFrequency(s,start);initializeLaboratory(s,start);const a=s.frequency.account,{q,meta}=fixture();const e=select(a,plan(1),q,meta,start);assert.equal(e.type,'SELECTED');const frozen=structuredClone(a.pending),cash=a.cash;
 initializePortfolio(s,start);assert.equal(s.schema,2);assert.deepEqual(orders(a)[0],frozen);assert.equal(a.cash,cash);assert.equal(initializePortfolio(s,start+1),null);assert.equal(orders(a).length,1);
});
test('engine observes and checkpoints every slot and cancels every pending order on disconnection',async()=>{
 const {q,meta}=fixture();let now=start,saved={},events=[];const f=new KrakenFeed({now:()=>now});f.state={...feed(q,'80000',now),connected:true,reconciled:true,system:'online',clock:{checked_at:now,error_ms:0}};f.metadata={...meta,status:'online',checked_at:now};f.series={};f.reconcile=async()=>{};
 const store={async acquire(){return structuredClone(saved);},async renew(){},async commit(s,e){saved=structuredClone(s);events.push(...structuredClone(e));}};
 const engine=await new TradingEngine({feed:f,store,now:()=>now}).initialize();engine.repairing=false;const a=engine.active().account;
 for(let i=0;i<3;i++){const e=select(a,plan(i),q,meta,now);engine.record(e,engine.active());assert(engine.pending(e.id));}
 now+=1100;f.state={...f.state,...feed({...q,ask:'80100',bid:'80099.9'},'80100',now)};engine.onMarket();assert.equal(positions(a).length,3);assert.equal(engine.notices.filter(n=>n.payload.type==='PAPER_OPENED').length,3);await engine.flush();
 const reboot=await new TradingEngine({feed:new KrakenFeed(),store,now:()=>now}).initialize();assert.equal(positions(reboot.active().account).length,3);assert.equal(reboot.active().account.cash,a.cash);
 const secondary=engine.state.frequency.account;for(let i=0;i<3;i++)engine.frequency.record(select(secondary,plan(i+3),q,meta,now));engine.cancelPending('FEED_DISCONNECT');assert.equal(orders(secondary).length,0);assert.equal(secondary.reservedCash,'0');
});
test('laboratory separates execution revisions and waits for all training positions before validation purge',()=>{
 const s=initialState(start);initializeFrequency(s,start);initializeLaboratory(s,start);initializePortfolio(s,start);
 let now=start;const market={state:{connected:true,reconciled:true,system:'online',clock:{checked_at:now,error_ms:0},...feed(fixture().q,'80000',now)},metadata:{...fixture().meta,status:'online',checked_at:now}};
 const lab=new TradingLaboratory({state:s,feed:market,now:()=>now,event:()=>{},notice:()=>{},frequency:{},learning:{}});lab.maintain();const t=lab.trial();assert(t.version.endsWith('@'+PORTFOLIO_VERSION));
 const {q,meta}=fixture(),a=s.frequency.account;select(a,plan(1),q,meta,now);step(a,feed({...q,ask:'80100',bid:'80099.9'},'80100',now+1100),now+1100);
 t.training=99;lab.observe({type:'SELECTED',ledger:'FREQUENT_PAPER',version:t.version,id:'training100',plan:{decision_at:now,study:{features:{}}}});lab.observe({type:'CLOSED',ledger:'FREQUENT_PAPER',version:t.version,id:'training100',pnl:'.1',fees:'.01',entry:'80000',price:'81000',qty:'.0001',quality:'OBSERVED'});
 assert(t.validation.awaitingFlat);now+=2*86400000;lab.maintain();assert(t.validation.awaitingFlat);assert.equal(t.validation.days.length,0);
 step(a,feed({...q,ask:'80100',bid:'80099.9'},'80100',now),now);lab.maintain();assert.equal(t.validation.awaitingFlat,false);assert.equal(t.validation.after,now+86400000);
});
