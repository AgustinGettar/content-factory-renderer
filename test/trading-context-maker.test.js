import {initializeMakerSizing,MAKER_SIZING_VERSION} from '../lib/trading/maker-sizing.js';
// Synthetic causal and accounting tests, not a profitability backtest.
import test from 'node:test';import assert from 'node:assert/strict';
import {D,POLICY,hash} from '../lib/trading/core.js';
import {initialState,TradingEngine} from '../lib/trading/engine.js';
import {KrakenFeed} from '../lib/trading/feed.js';
import {initializeFrequency,FrequencyExperiment} from '../lib/trading/frequency.js';
import {initializeLearning,TradingLearning} from '../lib/trading/learning.js';
import {initializeLaboratory,TradingLaboratory,laboratoryPlan,CONTEXT_RECIPES} from '../lib/trading/laboratory.js';
import {initializePortfolio,portfolioPolicy} from '../lib/trading/portfolio.js';
import {initializeTimeframes} from '../lib/trading/timeframes.js';
import {initializeMargin,MARGIN_VERSION,marginEconomics,marginRiskPlan} from '../lib/trading/margin.js';
import {initializeSecondaryRisk} from '../lib/trading/secondary-risk.js';
import {initializeEntryProfile} from '../lib/trading/entry-profile.js';
import {initializeContextProfile,CONTEXT_VERSION,MAKER_ORDER} from '../lib/trading/context-profile.js';
import {select,step,repairPosition} from '../lib/trading/simulator.js';
import {projectMonitor} from '../lib/trading/monitor-projection.js';
const NOW=Date.parse('2026-10-30T20:00:00Z');
const meta={tick_size:'.1',lot_decimals:8,ordermin:'.00001',costmin:'.1',leverage_buy:[2,3,4,5],leverage_sell:[2,3,4,5],status:'online',checked_at:NOW};
const quote={ask:'100.1',bid:'100',ask_qty:'100',bid_qty:'100',event_at:NOW,received_at:NOW};
function setup(){
 const s=initialState(NOW);initializeFrequency(s,NOW);initializeLearning(s,NOW);initializeLaboratory(s,NOW);initializePortfolio(s,NOW);initializeTimeframes(s,NOW);initializeMargin(s,NOW);
 const events=[],feed={series:{},metadata:meta,state:{quote}},frequency=new FrequencyExperiment({state:s.frequency,feed,now:()=>NOW,event:e=>events.push(e),notice:()=>{}});
 const lab=new TradingLaboratory({state:s,feed,now:()=>NOW,event:e=>events.push(e),notice:()=>{},frequency,learning:new TradingLearning({state:s.learning,now:()=>NOW,event:()=>{}})});
 lab.maintain();initializeSecondaryRisk(s,NOW,true);lab.maintain();initializeEntryProfile(s,NOW,true);lab.maintain();return {s,lab,events,a:s.frequency.account,feed};
}
function active(){const h=setup();initializeContextProfile(h.s,NOW,true);h.lab.maintain();return h;}
function bars(tf,range=100){return Array.from({length:120},(_,i)=>{const c=100000+i*100;return {start:NOW-(120-i)*tf*60000,end:NOW-(119-i)*tf*60000,open:c-50,close:c,high:c+range/2,low:c-range,volume:10,trades:10,available_at:NOW+1000};});}
function market(now=NOW+2000,changes={}){return {quote:{...quote,event_at:now,received_at:now},trade:{id:String(now),source:'KRAKEN_WS_V2_TRADE',message_type:'update',side:'sell',price:'99.9',qty:'100',event_at:now,received_at:now,...changes}};}
function plan(id='maker',short=false){return {id,version:'maker-test',family:'L',recipe:id,confirmed_at:NOW,execution_model:MARGIN_VERSION,direction:short?'SHORT':'LONG',order:MAKER_ORDER,entry:short?'100.1':'100',limit:short?'100.1':'100',stop:short?'102':'98',target:short?'90':'110',holding_ms:3600000,expires_at:NOW+120000,setup:{family:'L'}};}
function selected(h,id='maker',short=false){const e=select(h.a,plan(id,short),quote,meta,NOW);assert.equal(e.type,'SELECTED',JSON.stringify(e));return e.plan;}
test('new profile waits for flat and preserves deposits, P&L, primary and prior trials across reboot',async()=>{
 const h=setup(),old=h.s.laboratory.active,primary=structuredClone(h.s.research),money=structuredClone(h.a),funding=structuredClone(h.s.laboratory.funding);
 initializeContextProfile(h.s,NOW);assert.equal(h.s.contextProfile,undefined);initializeContextProfile(h.s,NOW,true);
 h.a.pendingOrders.old={plan:{id:'old'}};h.lab.maintain();assert.equal(h.s.contextProfile.status,'WAITING_FLAT');delete h.a.pendingOrders.old;h.lab.maintain();
 assert.equal(h.s.contextProfile.status,'ACTIVE');assert.notEqual(h.s.laboratory.active,old);assert.equal(h.lab.trial().recipe.entryRevision,CONTEXT_VERSION);
 for(const k of ['cash','equity','net','fees','closed','peak','dayStart','maxDrawdown'])assert.equal(h.a[k],money[k],k);assert.deepEqual(h.s.laboratory.funding,funding);assert.deepEqual(h.s.research,primary);
 h.lab.maintain();assert.equal(h.events.filter(e=>e.type==='CONTEXT_PROFILE_ENABLED').length,1);
 const store={async acquire(){return structuredClone(h.s)},async commit(){}};
 const reboot=await new TradingEngine({feed:new KrakenFeed(),store,now:()=>NOW+3000,contextProfileRequested:true}).initialize();assert.equal(reboot.state.schema,7);assert.equal(reboot.state.frequency.account.cash,'300');
 const d=projectMonitor({states:[{state:h.s}],now:NOW});assert.equal(d.context_profile.status,'ACTIVE');assert.equal(d.laboratory.recipes[0].stopTf,15);assert.equal(d.laboratory.recipes[0].targetTf,60);
});
test('1m pattern uses closed 15m stop and 1h target history; future/unavailable context cannot leak',()=>{
 const series={1:bars(1,100),15:bars(15,400),60:bars(60,1500)},recipe=CONTEXT_RECIPES[0].components[0],feed={quote:{...quote,bid:'111900',ask:'111900.1'}};
 const evaluate=()=>laboratoryPlan(recipe,'test',series,feed,meta,NOW,NOW+2000);
 const r=evaluate();assert(r.plan,JSON.stringify(r));assert.equal(r.plan.order,MAKER_ORDER);assert.equal(r.plan.context.stopTf,15);assert.equal(r.plan.context.targetTf,60);assert.deepEqual(r.plan.evidence.panels.map(p=>p.tf),[1,15,60]);assert.equal(r.plan.entry,r.plan.limit);assert(r.criteria.targetAtr>r.criteria.stopAtr);
 series[60].push({...series[60].at(-1),end:NOW+3600000,close:999999,available_at:NOW+2001});assert.equal(evaluate().plan.hash,r.plan.hash);
 series[60].pop();series[60].at(-1).available_at=NOW+3000;assert.equal(evaluate().reason,'LAB_CONTEXT_NOT_SYNCHRONIZED');
});
test('narrow context remains rejected, not widened to manufacture net reward',()=>{
 const series=Object.fromEntries([1,15,60].map(tf=>[tf,bars(tf,100)])),r=laboratoryPlan(CONTEXT_RECIPES[0].components[0],'test',series,{quote:{...quote,bid:'111900',ask:'111900.1'}},meta,NOW,NOW+2000);
 assert.equal(r.reason,'LAB_COSTS_TOO_HIGH');assert.equal(r.plan,undefined);
});
test('maker accounting charges maker only at entry, taker at exit, and full cash P&L reconciles',()=>{
 const h=active(),p=selected(h),policy=portfolioPolicy(p,quote,POLICY,h.a),c=marginEconomics(p,quote,policy,false),taker=marginEconomics({...p,order:'SIMULATED_STOP_LIMIT'},quote,policy,false);
 assert(c.gain.minus(taker.gain).eq(D(p.limit).mul('.004')));assert.equal(p.sizing.entry_fee_rate,'.004'.replace(/^\./,'0.'));assert.equal(p.sizing.fee,'0.008');
 assert(step(h.a,market(),NOW+2000).some(e=>e.type==='MAKER_POSTED'));assert.equal(h.a.position,null);
 const fill=step(h.a,market(NOW+3000),NOW+3000).find(e=>e.type==='FILLED');assert(fill);assert(D(fill.fee).eq(D(fill.qty).mul(fill.price).mul('.004')));
 const q={...market(NOW+4000),quote:{...quote,bid:'110',ask:'110.1',event_at:NOW+4000,received_at:NOW+4000},trade:{...market(NOW+4000).trade,price:'110'}};
 const close=step(h.a,q,NOW+4000).find(e=>e.type==='CLOSED');assert(close);assert(D(h.a.cash).minus(300).minus(close.pnl).abs().lt('0.00000001'));assert(D(close.fees).gt(fill.fee));
});
test('maker rejects crossed posting, touch, stale trade, snapshots, wrong aggressor and inadequate volume',()=>{
 const h=active(),p=selected(h);const crossed=market();crossed.quote.ask='99.9';assert.equal(step(h.a,crossed,NOW+2000).at(-1).reason,'POST_ONLY_WOULD_CROSS');
 for(const change of [{price:'100'},{event_at:NOW},{message_type:'snapshot'},{side:'buy'},{qty:String(+p.sizing.qty*9)}]){
  const g=active();selected(g);step(g.a,market(),NOW+2000);assert.equal(step(g.a,market(NOW+3000,change),NOW+3000).filter(e=>e.type==='FILLED').length,0,JSON.stringify(change));assert.equal(g.a.position,null);
 }
});
test('short maker fill requires a later buyer trading above the resting ask',()=>{
 const h=active();selected(h,'short',true);step(h.a,market(),NOW+2000);assert.equal(h.a.position,null);
 const out=step(h.a,market(NOW+3000,{side:'buy',price:'100.2'}),NOW+3000);assert(out.some(e=>e.type==='FILLED'));assert.equal(h.a.position.entry,'100.1');
});
test('same observed trade volume cannot fill another maker order on a fresh quote',()=>{
 const h=active(),p1=selected(h,'one'),p2=selected(h,'two');step(h.a,market(),NOW+2000);
 const f=market(NOW+3000,{qty:D(p1.sizing.qty).mul(10).toString()});step(h.a,f,NOW+3000);assert.equal(Object.keys(h.a.positions).length,1);
 f.quote={...f.quote,event_at:NOW+4000,received_at:NOW+4000};step(h.a,f,NOW+4000);assert.equal(Object.keys(h.a.positions).length,1);assert(h.a.pendingOrders[p2.id]);
});
test('maker gap recovery uses limit trade-through direction and never invents observed labels',()=>{
 const h=active();selected(h);const f=market(NOW+60000),b=[{start:NOW,end:NOW+60000,high:101,low:100.1}];assert.equal(repairPosition(h.a,b,f,NOW+60000,NOW).at(-1).reason,'RESTART_NO_TRIGGER_CONFIRMED');
 const g=active();selected(g);b[0].low=99.5;const out=repairPosition(g.a,b,f,NOW+60000,NOW);assert(out.some(e=>e.type==='AMBIGUOUS_RECOVERED_FILL'));assert.notEqual(g.a.position?.quality,'OBSERVED');
});
test('bounded candle retry does not consume the decision before the close becomes available',async()=>{
 let now=NOW+2000,calls=0;const h=active(),feed=new KrakenFeed({now:()=>now});feed.metadata=meta;feed.state={connected:true,reconciled:true,system:'online',clock:{checked_at:NOW,error_ms:0},...market(now)};
 feed.series=Object.fromEntries([1,15,60,240].map(tf=>[tf,bars(tf)]));feed.series[1].pop();feed.reconcile=async()=>{calls++;if(calls===2)feed.series[1]=bars(1);return true;};
 const engine=await new TradingEngine({feed,store:{async acquire(){return h.s},async commit(){}},now:()=>now}).initialize();engine.repairing=false;engine.state.last_frame_cutoff=NOW-60000;engine.state.last_cutoff=NOW-900000;
 await engine.boundary();assert.equal(calls,1);assert.equal(engine.state.last_frame_cutoff,NOW-60000);await engine.boundary();assert.equal(calls,1);
 now+=1100;await engine.boundary();assert.equal(calls,2);assert.equal(engine.state.last_frame_cutoff,NOW);await engine.boundary();assert.equal(calls,2);
});
test('missing candles stop REST retries at four attempts and never select retrospectively',async()=>{
 let now=NOW+2000,calls=0;const h=active(),feed=new KrakenFeed({now:()=>now});feed.metadata=meta;feed.state={connected:true,reconciled:true,system:'online',clock:{checked_at:NOW,error_ms:0},...market(now)};feed.series={1:[],15:[],60:[],240:[]};feed.reconcile=async()=>{calls++;return true;};
 const engine=await new TradingEngine({feed,store:{async acquire(){return h.s},async commit(){}},now:()=>now}).initialize();engine.repairing=false;engine.state.last_frame_cutoff=NOW-60000;
 for(let i=0;i<6;i++){await engine.boundary();now+=1100;}assert.equal(calls,4);assert.equal(engine.state.last_frame_cutoff,NOW);assert.equal(h.a.pending,null);
 now=NOW+11000;await engine.laboratory.boundary();assert.equal(h.a.pending,null);
});

function sized(){const h=active();initializeMakerSizing(h.s,NOW,true);h.lab.maintain();return h;}
test('thin BBO no longer prevents a passive order; actual maker fill still needs sufficient later liquidity',()=>{
 const thin={...quote,ask_qty:'.0001',bid_qty:'.0001'},minimum={...meta,ordermin:'.00006'},old=active();
 assert.equal(select(old.a,plan(),thin,minimum,NOW).reason,'MINIMUM_OR_LIQUIDITY');
 const h=sized(),e=select(h.a,plan(),thin,minimum,NOW);assert.equal(e.type,'SELECTED',JSON.stringify(e));assert(D(e.plan.sizing.qty).gte(minimum.ordermin));assert(D(e.plan.sizing.risk).lte(3));assert(D(e.plan.sizing.reserved).lte(270));
 assert.equal(e.plan.sizing.sizing_model,'RISK_CAPITAL_AT_POSTING');
 const f=market();f.quote={...f.quote,...thin,event_at:NOW+2000,received_at:NOW+2000};step(h.a,f,NOW+2000);assert.equal(h.a.position,null);
 f.trade=market(NOW+3000).trade;step(h.a,f,NOW+3000);assert.equal(h.a.position,null,'insufficient displayed liquidity cannot fill');
 const fill=step(h.a,market(NOW+4000),NOW+4000).find(e=>e.type==='FILLED');assert(fill);assert.equal(fill.fill_model,'POST_ONLY_TRADE_THROUGH_10X');
});
test('maker revision sizes within cash and margin and explains real exchange-minimum failures',()=>{
 const h=sized(),policy=portfolioPolicy(plan(),quote,POLICY,h.a);
 const lowCash={...h.a,cash:'31'},affordable=marginRiskPlan(plan(),lowCash,quote,meta,policy);assert(!affordable.reason);assert(D(affordable.reserved).lte(1));assert(D(affordable.risk).lte(3));
 const tiny=marginRiskPlan(plan(),h.a,quote,{...meta,ordermin:'2'},policy);assert.equal(tiny.reason,'RISK_BELOW_ORDER_MINIMUM');assert.equal(tiny.sizing_diagnostics.limiting,'RISK');assert.equal(tiny.sizing_diagnostics.minimum_qty,'2');
 const noCash=marginRiskPlan(plan(),{...h.a,cash:'30'},quote,meta,policy);assert.equal(noCash.reason,'CAPITAL_BELOW_ORDER_MINIMUM');assert.equal(noCash.sizing_diagnostics.qty,'0');
 const primary=h.s.research.versions[h.s.research.active].account;assert.equal(portfolioPolicy(plan(),quote,POLICY,primary).makerSizingModel,undefined);
 const legacy=marginRiskPlan({...plan(),order:'SIMULATED_STOP_LIMIT'},h.a,{...quote,ask_qty:'.00001'},meta,policy);assert.equal(legacy.reason,'MINIMUM_OR_LIQUIDITY');
});
test('sizing correction archives a separate trial only when flat and preserves frozen orders and balances',async()=>{
 const h=active(),p=selected(h),original=structuredClone(h.a.pendingOrders),version=h.s.laboratory.active,cash=h.a.cash,primary=structuredClone(h.s.research),funding=structuredClone(h.s.laboratory.funding);
 initializeMakerSizing(h.s,NOW);assert.equal(h.s.makerSizing,undefined);initializeMakerSizing(h.s,NOW,true);h.lab.maintain();assert.equal(h.s.makerSizing.status,'WAITING_FLAT');assert.deepEqual(h.a.pendingOrders,original);assert.equal(h.s.laboratory.active,version);
 step(h.a,market(NOW+120000),NOW+120000);h.lab.maintain();assert.equal(h.s.makerSizing.status,'ACTIVE');assert.equal(h.a.cash,cash);assert.deepEqual(h.s.research,primary);assert.deepEqual(h.s.laboratory.funding,funding);assert.notEqual(h.s.laboratory.active,version);assert.equal(h.lab.trial().recipe.sizingRevision,MAKER_SIZING_VERSION);assert(h.s.laboratory.execution_archives.some(x=>x.active===version));
 h.lab.maintain();assert.equal(h.events.filter(e=>e.type==='MAKER_SIZING_ENABLED').length,1);
 const engine=await new TradingEngine({feed:new KrakenFeed(),store:{async acquire(){return structuredClone(h.s)},async commit(){}},now:()=>NOW+130000,makerSizingRequested:true}).initialize();assert.equal(engine.state.schema,8);assert.equal(engine.state.laboratory.active,h.s.laboratory.active);
 const view=projectMonitor({states:[{state:h.s}],now:NOW});assert.equal(view.maker_sizing.status,'ACTIVE');assert.equal(view.frequency.maker_sizing_profile.model,'RISK_CAPITAL_AT_POSTING');
});
test('precise rejected sizing diagnostics survive selection for the monitor',()=>{
 const h=sized(),r=select(h.a,plan(),quote,{...meta,ordermin:'2'},NOW);assert.equal(r.reason,'RISK_BELOW_ORDER_MINIMUM');assert.equal(r.sizing_diagnostics.minimum_qty,'2');assert.equal(h.a.pending,null);
});
