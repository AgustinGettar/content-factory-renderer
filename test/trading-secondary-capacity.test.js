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
import {CAPACITY_VERSION,initializeCapacity} from '../lib/trading/secondary-capacity.js';
import {accountMaxSlots} from '../lib/trading/portfolio.js';
import {BOOST_VERSION,initializeBoost} from '../lib/trading/secondary-boost.js';
import {select,step} from '../lib/trading/simulator.js';
import {projectMonitor} from '../lib/trading/monitor-projection.js';
const NOW=Date.parse('2026-10-31T00:00:00Z');
const quote={ask:'100.1',bid:'100',ask_qty:'100',bid_qty:'100',event_at:NOW,received_at:NOW};
const meta={tick_size:'.1',lot_decimals:8,ordermin:'.00001',costmin:'.1',leverage_buy:[2,3,4,5,6,7,8,9,10],leverage_sell:[2,3,4,5,6,7,8,9,10],status:'online',checked_at:NOW};
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

function capacity(h=activate(setup())){initializeCapacity(h.s,NOW,true);h.lab.maintain();return h;}
test('one explicit 200 USD contribution preserves open contracts, history and primary across restart',async()=>{
 const h=activate(setup()),old=h.lab.trial(),version=componentVersion(old.version,old.recipe,1);
 const e=select(h.a,plan('old',{version,study:{features:{}}}),quote,meta,NOW);h.lab.observe({...e,ledger:'FREQUENT_PAPER',version});step(h.a,market(),NOW+2000);step(h.a,market(NOW+3000),NOW+3000);assert.equal(positions(h.a).length,1);
 const frozen=structuredClone(positions(h.a)[0].plan),before=structuredClone(h.a),primary=structuredClone(h.s.research),funding=structuredClone(h.s.laboratory.funding);h.s.frequency.daySelections=3;
 initializeCapacity(h.s,NOW,false);assert.equal(h.s.secondaryCapacity,undefined);capacity(h);
 assert.equal(h.s.schema,11);assert.equal(h.s.secondaryCapacity.status,'ACTIVE');assert.equal(h.lab.trial().capacityProfile,CAPACITY_VERSION);
 for(const k of ['cash','equity','peak','dayStart'])assert(D(h.a[k]).eq(D(before[k]).plus(200)),k);
 for(const k of ['net','fees','closed','maxDrawdown','halted','openRiskReserved'])assert.equal(h.a[k],before[k],k);
 assert.deepEqual(positions(h.a)[0].plan,frozen);assert.deepEqual(h.s.research,primary);assert(D(h.s.laboratory.funding.added).eq(D(funding.added).plus(200)));assert.equal(h.s.frequency.daySelections,3);assert.equal(h.s.laboratory.funding.count,funding.count);
 initializeCapacity(h.s,NOW+1,true);h.lab.maintain();assert.equal(h.events.filter(e=>e.type==='SECONDARY_CAPACITY_ENABLED').length,1);
 const closed={type:'CLOSED',id:'old',version,ledger:'FREQUENT_PAPER',pnl:'-2',fees:'1',entry:'100',price:'99',qty:'1',quality:'OBSERVED'};h.lab.observe(closed);h.lab.observe(closed);assert.equal(old.closed,1);assert.equal(h.lab.trial().closed,0);
 const saved=structuredClone(h.s),store={async acquire(){return structuredClone(saved);},async commit(){}};
 const reboot=await new TradingEngine({store,feed:new KrakenFeed(),now:()=>NOW+73000,capacityRequested:true}).initialize();assert.equal(reboot.state.frequency.account.cash,h.a.cash);assert.deepEqual(reboot.state.secondaryCapacity.capital_event,h.s.secondaryCapacity.capital_event);assert.deepEqual(positions(reboot.state.frequency.account)[0].plan,frozen);
});
test('secondary accepts ten pending slots, rejects the eleventh, and the primary stays at three',()=>{
 const h=capacity();assert.equal(accountMaxSlots(h.a),10);const primary=h.s.research.versions[h.s.research.active].account;assert.equal(accountMaxSlots(primary),3);
 // A small requested quantity isolates slots from the independent shared risk cap.
 for(let i=0;i<10;i++){
  const e=select(h.a,plan('slot'+i,{sizing:{qty:'.1'}}),quote,meta,NOW);
  assert.equal(e.type,'SELECTED',JSON.stringify(e));
 }
 assert.equal(orders(h.a).length,10);assert.equal(select(h.a,plan('overflow'),quote,meta,NOW).reason,'PORTFOLIO_SLOTS_FULL');
 step(h.a,market(),NOW+2000);step(h.a,market(NOW+3000),NOW+3000);assert.equal(positions(h.a).length,10);assert.equal(orders(h.a).length,0);assert.equal(select(h.a,plan('still-full'),quote,meta,NOW+3000).reason,'PORTFOLIO_SLOTS_FULL');
 const d=projectMonitor({states:[{state:h.s}],now:NOW});assert.equal(d.frequency.account.max_slots,10);assert.equal(d.account.max_slots,3);assert.equal(d.secondary_capacity.capital_event.amount,'200');assert.equal(d.frequency.risk_profile.preferredLeverage,5);assert.equal(d.frequency.risk_profile.maxRiskUSD,'10');
});
test('higher profile increases prospective exposure but retains risk, costs and liquidation gates',()=>{
 const h=activate(setup()),before=marginRiskPlan(plan(),h.a,quote,meta,portfolioPolicy(plan(),quote,POLICY,h.a));capacity(h);
 const policy=portfolioPolicy(plan(),quote,POLICY,h.a),x=marginRiskPlan(plan(),h.a,quote,meta,policy);assert.equal(x.leverage,5);assert(D(x.exposure).gt(before.exposure));assert(D(x.risk).lte(10));assert.equal(x.preferred_leverage,5);
 h.a.cash='60';const limited=marginRiskPlan(plan('tight',{stop:'99'}),h.a,quote,meta,policy);assert.equal(limited.leverage,10);assert(D(limited.reserved).lte(10));
 const bad=marginRiskPlan(plan('bad',{target:'100.5'}),h.a,quote,meta,policy);assert.equal(bad.reason,'NET_RR_TOO_LOW');
 const unsafe=marginRiskPlan(plan('unsafe',{stop:'70',target:'200'}),h.a,quote,meta,{...policy,marginLeverage:[5,6,7,8,9,10]});assert.equal(unsafe.reason,'STOP_TOO_CLOSE_TO_LIQUIDATION');
});
test('profile corruption refuses to credit money again',()=>{
 const h=capacity(),cash=h.a.cash;h.a.capacityProfile.protocol_hash='changed';assert.throws(()=>initializeCapacity(h.s,NOW,true),/MISMATCH/);assert.equal(h.a.cash,cash);assert.throws(()=>portfolioPolicy(plan(),quote,POLICY,h.a),/MISMATCH/);
});

test('shared capital, gross exposure, daily and open risk caps still suppress excessive size',()=>{
 const h=capacity();let selected=0;
 for(let i=0;i<10;i++)if(select(h.a,plan('budget'+i),quote,meta,NOW).type==='SELECTED')selected++;
 assert(selected>3&&selected<10);assert(D(h.a.openRiskReserved).lte(D(h.a.equity).mul('.10')));
 assert(D(orders(h.a).reduce((v,o)=>v.plus(o.plan.sizing.exposure),D(0))).lte(D(h.a.equity).mul(5)));
 assert(orders(h.a).every(o=>D(o.plan.sizing.risk).lte(10)));assert(D(h.a.availableCash).gte(D(h.a.equity).mul('.10')));
 h.a.cash='449';step(h.a,market(),NOW+2000);assert.equal(orders(h.a).length,0);assert.equal(select(h.a,plan('daily'),quote,meta,NOW).type,'SUPPRESSED');
});
