// Synthetic accounting/execution checks. No profitability claim or live order.
import test from 'node:test';import assert from 'node:assert/strict';
import {D,POLICY} from '../lib/trading/core.js';
import {initialState,TradingEngine} from '../lib/trading/engine.js';
import {KrakenFeed} from '../lib/trading/feed.js';
import {initializeFrequency,FrequencyExperiment} from '../lib/trading/frequency.js';
import {initializeLearning} from '../lib/trading/learning.js';
import {initializeLaboratory,TradingLaboratory} from '../lib/trading/laboratory.js';
import {initializePortfolio,portfolioPolicy,positions,orders,syncPortfolio} from '../lib/trading/portfolio.js';
import {initializeTimeframes,componentVersion} from '../lib/trading/timeframes.js';
import {initializeMargin,MARGIN_VERSION,marginRiskPlan} from '../lib/trading/margin.js';
import {initializeSecondaryRisk} from '../lib/trading/secondary-risk.js';
import {initializeEntryProfile} from '../lib/trading/entry-profile.js';
import {initializeContextProfile,MAKER_ORDER} from '../lib/trading/context-profile.js';
import {initializeMakerSizing} from '../lib/trading/maker-sizing.js';
import {initializeExits} from '../lib/trading/paper-exits.js';
import {BOOST_VERSION,initializeBoost} from '../lib/trading/secondary-boost.js';
import {select,step} from '../lib/trading/simulator.js';
import {projectMonitor} from '../lib/trading/monitor-projection.js';
const NOW=Date.parse('2026-10-31T00:00:00Z');
const quote={ask:'100.1',bid:'100',ask_qty:'100',bid_qty:'100',event_at:NOW,received_at:NOW};
const meta={tick_size:'.1',lot_decimals:8,ordermin:'.00001',costmin:'.1',leverage_buy:[2,3,4,5],leverage_sell:[2,3,4,5],status:'online',checked_at:NOW};
const plan=(id='one',over={})=>({id,version:'boost-test',family:'L',recipe:id,confirmed_at:NOW,decision_at:NOW,timeframe:1,execution_model:MARGIN_VERSION,direction:'LONG',order:MAKER_ORDER,entry:'100',limit:'100',stop:'98',target:'110',holding_ms:3600000,expires_at:NOW+120000,setup:{family:'L'},...over});
function setup(){
 const s=initialState(NOW);initializeFrequency(s,NOW);initializeLearning(s,NOW);initializeLaboratory(s,NOW);initializePortfolio(s,NOW);initializeTimeframes(s,NOW);initializeMargin(s,NOW);
 const events=[],feed={series:{},metadata:meta,state:{quote,trade:{price:'100',event_at:NOW},connected:true,reconciled:true,system:'online',clock:{checked_at:NOW,error_ms:0}}};
 const frequency=new FrequencyExperiment({state:s.frequency,feed,now:()=>NOW,event:e=>events.push(e),notice:()=>{}});
 const lab=new TradingLaboratory({state:s,feed,now:()=>NOW,event:e=>events.push(e),notice:()=>{},frequency});
 lab.maintain();initializeSecondaryRisk(s,NOW,true);lab.maintain();initializeEntryProfile(s,NOW,true);lab.maintain();initializeContextProfile(s,NOW,true);lab.maintain();
 return {s,lab,events,feed,a:s.frequency.account};
}
function activate(h){initializeMakerSizing(h.s,NOW,true);initializeExits(h.s,NOW,true);initializeBoost(h.s,NOW,true);h.lab.maintain();return h;}
function market(at=NOW+2000,qty='100'){return {quote:{...quote,event_at:at,received_at:at},trade:{id:String(at),source:'KRAKEN_WS_V2_TRADE',message_type:'update',side:'sell',price:'99.9',qty,event_at:at,received_at:at}};}
test('preferred 3x actually doubles risk-sized exposure, preserves cash reserve and uses lower leverage on ties',()=>{
 const h=setup(),before=select(h.a,plan(),quote,meta,NOW).plan.sizing;h.a.pendingOrders={};syncPortfolio(h.a);activate(h);
 const p=select(h.a,plan('boost'),quote,meta,NOW);assert.equal(p.type,'SELECTED');const x=p.plan.sizing;
 assert.equal(before.leverage,1);assert.equal(x.leverage,3);assert(D(x.exposure).gt(D(before.exposure).mul('1.9')));assert(D(x.risk).lte(6));assert(D(x.initial_margin).lt(D(x.exposure).div(2)));assert.equal(x.preferred_leverage,3);
 assert(D(h.a.availableCash).gte(D(h.a.equity).mul('.1')));assert.equal(x.decision,'PREFERRED_LEVERAGE_WITHIN_RISK');
});
test('capital-limited passive orders pick the largest viable size, up to 5x, without pretending BBO fills',()=>{
 const h=activate(setup());h.a.cash='55';const q={...quote,ask_qty:'.000001',bid_qty:'.000001'},p=plan(),policy=portfolioPolicy(p,q,POLICY,h.a),x=marginRiskPlan(p,h.a,q,meta,policy);
 assert.equal(x.leverage,5);assert(D(x.qty).gt(x.leverage_options.find(v=>v.leverage===3).qty));assert(D(x.reserved).lte(25));assert.equal(x.sizing_diagnostics.limiting,'CASH');
 const g=activate(setup()),e=select(g.a,p,q,meta,NOW);assert.equal(e.type,'SELECTED');step(g.a,market(),NOW+2000);assert.equal(step(g.a,market(NOW+3000,'.00001'),NOW+3000).some(e=>e.type==='FILLED'),false);assert.equal(positions(g.a).length,0);
});
test('unsupported leverage falls back, and higher funding cannot bypass a failed net-cost or liquidation gate',()=>{
 const h=activate(setup()),p=plan(),policy=portfolioPolicy(p,quote,POLICY,h.a);
 const fallback=marginRiskPlan(p,h.a,quote,{...meta,leverage_buy:[2]},policy);assert.equal(fallback.leverage,1);assert.equal(fallback.decision,'LOWER_LEVERAGE_FALLBACK');
 const bad=marginRiskPlan({...p,target:'100.5'},h.a,quote,meta,policy);assert.equal(bad.reason,'NET_RR_TOO_LOW');
 const unsafe=marginRiskPlan({...p,stop:'70',target:'200'},h.a,quote,meta,{...policy,marginLeverage:[3,4,5]});assert.equal(unsafe.reason,'STOP_TOO_CLOSE_TO_LIQUIDATION');
 const short=marginRiskPlan({...p,direction:'SHORT',stop:'102',target:'90'},h.a,quote,{...meta,leverage_sell:[]},policy);assert.equal(short.reason,'MARGIN_METADATA_UNAVAILABLE');
});
test('old open contracts survive prospective activation, and their settlements update only the archived round',async()=>{
 const h=setup(),old=h.lab.trial(),version=componentVersion(old.version,old.recipe,1),selected=select(h.a,plan('legacy',{version,study:{features:{}}}),quote,meta,NOW);
 h.lab.observe({...selected,ledger:'FREQUENT_PAPER',version});step(h.a,market(),NOW+2000);step(h.a,market(NOW+3000),NOW+3000);assert.equal(positions(h.a).length,1);
 h.lab.maintain();
 const contract=structuredClone(positions(h.a)[0].plan),money=Object.fromEntries(['cash','equity','net','fees','closed','peak','dayStart'].map(k=>[k,h.a[k]])),primary=structuredClone(h.s.research),funding=structuredClone(h.s.laboratory.funding);
 initializeMakerSizing(h.s,NOW+4000,true);initializeExits(h.s,NOW+4000,true);assert.equal(h.s.makerSizing.status,'WAITING_FLAT');
 initializeBoost(h.s,NOW+4000);assert.equal(h.s.leverageProfile,undefined);initializeBoost(h.s,NOW+4000,true);h.lab.maintain();
 assert.equal(h.s.schema,10);assert.equal(h.s.leverageProfile.status,'ACTIVE');assert.equal(h.s.makerSizing.status,'ACTIVE');assert.equal(h.s.exitManagement.status,'ACTIVE');assert.notEqual(h.lab.trial(),old);assert.equal(h.lab.trial().leverageProfile,BOOST_VERSION);
 assert.deepEqual(positions(h.a)[0].plan,contract);assert.deepEqual(h.s.research,primary);assert.deepEqual(h.s.laboratory.funding,funding);for(const [k,v] of Object.entries(money))assert.equal(h.a[k],v,k);
 const closed={type:'CLOSED',id:'legacy',version,ledger:'FREQUENT_PAPER',pnl:'-2',fees:'1',entry:'100',price:'99',qty:'1',quality:'OBSERVED'};h.lab.observe(closed);h.lab.observe(closed);assert.equal(old.closed,1);assert.equal(old.net,-2);assert.equal(old.training,0);assert.equal(h.lab.trial().closed,0);
 const before=h.s.frequency.counts.evaluations;h.lab.now=()=>NOW+72000;h.feed.metadata.checked_at=NOW+72000;h.feed.state={...h.feed.state,...market(NOW+72000),clock:{checked_at:NOW+72000,error_ms:0}};await h.lab.boundary();assert.equal(h.s.frequency.counts.evaluations,before+1);assert.equal(h.lab.trial().frameCutoffs[1],NOW+60000);
 const saved=structuredClone(h.s),store={async acquire(){return structuredClone(saved);},async commit(){}};const reboot=await new TradingEngine({store,feed:new KrakenFeed(),now:()=>NOW+73000,boostRequested:true}).initialize();assert.equal(reboot.state.schema,10);assert.deepEqual(positions(reboot.state.frequency.account)[0].plan,contract);assert.equal(reboot.state.laboratory.active,h.s.laboratory.active);
});
test('risk budgets count legacy positions and all new orders; daily loss and primary policy remain bounded',()=>{
 const h=activate(setup());for(let i=0;i<3;i++)select(h.a,plan(String(i)),quote,meta,NOW);
 assert(D(h.a.openRiskReserved).lte(12));assert(orders(h.a).length<=3);assert(D(orders(h.a).reduce((v,p)=>v.plus(p.plan.sizing.exposure),D(0))).lte(900));
 const base=portfolioPolicy(plan(),quote,POLICY,h.s.research.versions[h.s.research.active].account);assert.equal(base.riskCapUSD,'1');assert.equal(base.dailyLoss,'0.01');assert.equal(base.marginPreferredLeverage,undefined);
 h.a.cash='284';step(h.a,market(),NOW+2000);assert.equal(orders(h.a).length,0);assert.equal(select(h.a,plan('later'),quote,meta,NOW).type,'SUPPRESSED');
 const d=projectMonitor({states:[{state:h.s}],now:NOW});assert.equal(d.frequency.risk_profile.preferredLeverage,3);assert.equal(d.frequency.risk_profile.maxRiskUSD,'6');assert.equal(d.leverage_profile.status,'ACTIVE');
});
test('boost protocol is opt-in and tampering cannot silently reset the profile',()=>{
 const h=activate(setup());initializeBoost(h.s,NOW+1,true);h.lab.maintain();assert.equal(h.events.filter(e=>e.type==='SECONDARY_BOOST_ENABLED').length,1);
 h.a.leverageProfile.protocol_hash='wrong';assert.throws(()=>portfolioPolicy(plan(),quote,POLICY,h.a),/MISMATCH/);assert.throws(()=>initializeBoost(h.s,NOW+2,true),/MISMATCH/);
});

test('a financed 3x fill and net-target exit reconcile collateral, fees and simulated cash exactly',()=>{
 const h=activate(setup()),e=select(h.a,plan('financed',{exit_management:'net-exit-1.0.0'}),quote,meta,NOW);assert.equal(e.plan.sizing.leverage,3);
 step(h.a,market(),NOW+2000);const opened=step(h.a,market(NOW+3000),NOW+3000);assert(opened.some(x=>x.type==='FILLED'));assert.equal(positions(h.a).length,1);
 const f=market(NOW+4000);f.quote={...f.quote,bid:'111',ask:'111.1'};f.trade.price='111';const closed=step(h.a,f,NOW+4000).find(x=>x.type==='CLOSED');assert.equal(closed.reason,'NET_TARGET');assert(D(closed.pnl).gte(e.plan.sizing.target_net));assert(D(h.a.cash).minus(300).minus(closed.pnl).abs().lt('0.000000001'));assert.equal(positions(h.a).length,0);assert.equal(step(h.a,f,NOW+4001).filter(x=>x.type==='CLOSED').length,0);
});
