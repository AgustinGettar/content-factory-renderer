// Offline regression fixtures. They verify execution rules, not expected returns.
import test from 'node:test';
import assert from 'node:assert/strict';
import {D,hash} from '../lib/trading/core.js';
import {initialState,TradingEngine} from '../lib/trading/engine.js';
import {KrakenFeed} from '../lib/trading/feed.js';
import {initializeFrequency,FrequencyExperiment,FREQUENCY_PROTOCOL,LEGACY_FREQUENCY_PROTOCOL} from '../lib/trading/frequency.js';
import {initializeLearning,TradingLearning} from '../lib/trading/learning.js';
import {initializeLaboratory,TradingLaboratory,laboratoryPlan} from '../lib/trading/laboratory.js';
import {initializePortfolio,positions,orders,accountMaxSlots} from '../lib/trading/portfolio.js';
import {initializeTimeframes,componentVersion} from '../lib/trading/timeframes.js';
import {initializeMargin,MARGIN_VERSION} from '../lib/trading/margin.js';
import {initializeSecondaryRisk} from '../lib/trading/secondary-risk.js';
import {initializeEntryProfile} from '../lib/trading/entry-profile.js';
import {initializeContextProfile,MAKER_ORDER} from '../lib/trading/context-profile.js';
import {initializeMakerSizing} from '../lib/trading/maker-sizing.js';
import {initializeExits} from '../lib/trading/paper-exits.js';
import {initializeBoost} from '../lib/trading/secondary-boost.js';
import {initializeCapacity} from '../lib/trading/secondary-capacity.js';
import {select,step} from '../lib/trading/simulator.js';
import {frequencyView} from '../lib/trading/monitor-projection.js';

const START=Date.parse('2026-10-31T00:00:00Z'),CUTOFF=START+60000;
const quote=at=>({ask:'100.1',bid:'100',ask_qty:'100',bid_qty:'100',event_at:at,received_at:at});
const metadata=at=>({tick_size:'.1',lot_decimals:8,ordermin:'.00001',costmin:'.1',leverage_buy:[2,3,4,5,6,7,8,9,10],leverage_sell:[2,3,4,5,6,7,8,9,10],status:'online',checked_at:at});
function capacityHarness(){
 let now=START;const s=initialState(now),events=[],notices=[];
 initializeFrequency(s,now);initializeLearning(s,now);initializeLaboratory(s,now);initializePortfolio(s,now);initializeTimeframes(s,now);initializeMargin(s,now);
 const feed={series:{},metadata:metadata(now),state:{quote:quote(now),trade:{price:'100',event_at:now,received_at:now},connected:true,reconciled:true,system:'online',clock:{checked_at:now,error_ms:0}}};
 const event=e=>events.push(e),notice=(...e)=>notices.push(e);
 const frequency=new FrequencyExperiment({state:s.frequency,feed,now:()=>now,event,notice});
 const learning=new TradingLearning({state:s.learning,now:()=>now,event});
 const lab=new TradingLaboratory({state:s,feed,now:()=>now,event,notice,frequency,learning});
 lab.maintain();initializeSecondaryRisk(s,now,true);lab.maintain();initializeEntryProfile(s,now,true);lab.maintain();initializeContextProfile(s,now,true);lab.maintain();
 initializeMakerSizing(s,now,true);initializeExits(s,now,true);initializeBoost(s,now,true);lab.maintain();initializeCapacity(s,now,true);lab.maintain();
 const time=at=>{now=at;feed.metadata.checked_at=at;feed.state.clock.checked_at=at;for(const k of ['quote','trade'])feed.state[k].event_at=feed.state[k].received_at=at;};
 function seed(){
  time(CUTOFF+2000);Object.assign(feed.state.quote,{bid:'111900',ask:'111900.1'});feed.state.trade.price='111900';
  for(const [tf,range] of [[1,100],[15,400],[60,1500],[240,2000]]){
   const end=Math.floor(CUTOFF/(tf*60000))*tf*60000;
   feed.series[tf]=Array.from({length:120},(_,i)=>{const c=100000+i*100;return {start:end-(120-i)*tf*60000,end:end-(119-i)*tf*60000,open:c-50,close:c,high:c+range/2,low:c-range,volume:10,trades:10,available_at:now};});
  }
  s.frequency.selectionDay='2026-10-31';s.frequency.daySelections=12;
 }
 return {s,a:s.frequency.account,feed,frequency,lab,events,notices,time,now:()=>now,seed};
}
function previousProtocol(s){s.frequency.protocol=structuredClone(LEGACY_FREQUENCY_PROTOCOL);s.frequency.protocol_hash=hash(LEGACY_FREQUENCY_PROTOCOL);}
function candidate(h){const t=h.lab.trial(),r=t.recipe.components.find(r=>r.tf===1),result=laboratoryPlan(r,componentVersion(t.version,t.recipe,1),h.feed.series,h.feed.state,h.feed.metadata,CUTOFF,h.now());assert(result.plan,JSON.stringify(result));return result.plan;}
function oldPlan(h,id){return {id,version:componentVersion(h.lab.trial().version,h.lab.trial().recipe,1),family:'L',recipe:id,confirmed_at:START,decision_at:START,timeframe:1,execution_model:MARGIN_VERSION,direction:'LONG',order:MAKER_ORDER,entry:'100',limit:'100',stop:'98',target:'110',holding_ms:3600000,expires_at:START+120000,setup:{family:'L'},sizing:{qty:'.1'}};}

test('quota migration preserves all money, frozen positions, orders, research and counters exactly',()=>{
 const h=capacityHarness(),a=h.a;
 assert.equal(select(a,oldPlan(h,'open'),h.feed.state.quote,h.feed.metadata,START).type,'SELECTED');
 const market=at=>({quote:quote(at),trade:{id:String(at),source:'KRAKEN_WS_V2_TRADE',message_type:'update',side:'sell',price:'99.9',qty:'100',event_at:at,received_at:at}});
 step(a,market(START+2000),START+2000);step(a,market(START+3000),START+3000);
 assert.equal(positions(a).length,1);assert.equal(select(a,oldPlan(h,'pending'),h.feed.state.quote,h.feed.metadata,START+3000).type,'SELECTED');
 h.s.frequency.daySelections=12;h.s.frequency.selectionDay='2026-10-31';h.s.frequency.counts.selected=27;h.lab.trial().training=17;
 previousProtocol(h.s);const before=structuredClone(h.s),event=initializeFrequency(h.s,START+4000);
 assert.equal(event.type,'DAILY_SELECTION_LIMIT_REMOVED');assert.equal(event.before,12);assert.equal(event.after,null);assert.equal(event.realTrading,false);
 assert.deepEqual(event.scope,['FREQUENT_PAPER','LABORATORY','ENGINE']);assert.equal(h.s.frequency.account,a);
 assert.equal(h.s.frequency.protocol_hash,hash(FREQUENCY_PROTOCOL));assert.equal(h.s.frequency.protocol.maxSelectionsPerUTCDate,null);
 assert.deepEqual(h.s.frequency.protocol_history,[{at:START+4000,reason:'DAILY_SELECTION_LIMIT_REMOVED',protocol:before.frequency.protocol,protocol_hash:before.frequency.protocol_hash}]);
 const restored=structuredClone(h.s);restored.frequency.protocol=before.frequency.protocol;restored.frequency.protocol_hash=before.frequency.protocol_hash;delete restored.frequency.protocol_history;
 assert.deepEqual(restored,before);assert.deepEqual({...FREQUENCY_PROTOCOL,maxSelectionsPerUTCDate:12},LEGACY_FREQUENCY_PROTOCOL);
 const once=structuredClone(h.s);assert.equal(initializeFrequency(h.s,START+5000),null);assert.deepEqual(h.s,once);
});

test('engine commits migration once across restarts without a migration Telegram message',async()=>{
 const h=capacityHarness();previousProtocol(h.s);h.s.frequency.daySelections=12;
 let saved=structuredClone(h.s);const events=[],notices=[];
 const store={async acquire(){return structuredClone(saved);},async commit(s,e,n){saved=structuredClone(s);events.push(...e);notices.push(...n);}};
 const before=structuredClone(saved);
 await new TradingEngine({store,feed:new KrakenFeed(),now:()=>START+4000}).initialize();
 await new TradingEngine({store,feed:new KrakenFeed(),now:()=>START+5000}).initialize();
 assert.equal(events.filter(e=>e.type==='DAILY_SELECTION_LIMIT_REMOVED').length,1);assert.equal(events.filter(e=>e.type==='FREQUENCY_ACCOUNT_STARTED').length,0);assert.equal(notices.length,0);
 assert.equal(saved.frequency.protocol_history.length,1);assert.equal(saved.frequency.daySelections,12);assert.deepEqual(saved.frequency.account,before.frequency.account);assert.deepEqual(saved.research,before.research);assert.deepEqual(saved.laboratory,before.laboratory);assert.equal(saved.schema,11);
});

test('migration refuses corrupt, unknown or mismatched protocols before mutating state',()=>{
 const changes=[
  s=>{s.frequency.protocol.dailyLoss='1';},
  s=>{s.frequency.protocol_hash='unknown';},
  s=>{s.frequency.protocol.maxSelectionsPerUTCDate=13;s.frequency.protocol_hash=hash(s.frequency.protocol);},
  s=>{s.frequency.version='unreviewed';},
  s=>{s.frequency.protocol_history={};},
  s=>{s.frequency.protocol={...FREQUENCY_PROTOCOL,risk:'1'};s.frequency.protocol_hash=hash(FREQUENCY_PROTOCOL);},
  s=>{delete s.frequency.protocol;},
 ];
 for(const change of changes){const h=capacityHarness();previousProtocol(h.s);change(h.s);const before=structuredClone(h.s);assert.throws(()=>initializeFrequency(h.s,START+1),/FREQUENCY_PROTOCOL_MISMATCH/);assert.deepEqual(h.s,before);}
});

test('active capacity laboratory selects a thirteenth plan without changing risk or its trial',async()=>{
 const h=capacityHarness();h.seed();const t=h.lab.trial(),before=structuredClone(h.s.research),trialVersion=t.version,protocol=h.s.laboratory.protocol_hash;
 await h.lab.boundary();await h.lab.boundary();
 assert.equal(h.s.frequency.daySelections,13);assert.equal(h.s.frequency.lastDecision.reason,'ENTRY_SELECTED');assert.equal(orders(h.a).length,1);
 assert.equal(h.lab.trial(),t);assert.equal(t.version,trialVersion);assert.equal(h.s.laboratory.protocol_hash,protocol);assert.deepEqual(h.s.research,before);
 const p=orders(h.a)[0].plan;assert(D(p.sizing.risk).lte(10));assert(D(p.sizing.risk).lte(D(h.a.equity).mul('.02')));assert(D(h.a.openRiskReserved).lte(D(h.a.equity).mul('.10')));assert.equal(p.policy.dailyLoss,'0.10');assert.equal(p.policy.drawdown,'0.10');assert.equal(accountMaxSlots(h.a),10);assert(!h.events.some(e=>e.reason==='DAILY_SELECTION_LIMIT'));
});

test('laboratory still rejects stale quotes, full slots and committed daily risk after twelve plans',async()=>{
 const stale=capacityHarness();stale.seed();stale.feed.state.quote.event_at-=6000;await stale.lab.boundary();assert.equal(stale.s.frequency.lastDecision.reason,'STALE_QUOTE');assert.equal(orders(stale.a).length,0);
 const full=capacityHarness();full.seed();const raw=candidate(full);
 for(let i=0;i<10;i++){const e=select(full.a,{...raw,id:'slot-'+i,recipe:'slot-'+i,sizing:{qty:'.00001'}},full.feed.state.quote,full.feed.metadata,full.now());assert.equal(e.type,'SELECTED',JSON.stringify(e));}
 await full.lab.boundary();assert.equal(full.s.frequency.lastDecision.reason,'PORTFOLIO_SLOTS_FULL');assert.equal(orders(full.a).length,10);assert.equal(full.s.frequency.daySelections,12);
 const risk=capacityHarness();risk.seed();const first=select(risk.a,{...candidate(risk),id:'already-reserved',recipe:'already-reserved'},risk.feed.state.quote,risk.feed.metadata,risk.now());assert.equal(first.type,'SELECTED');
 // Daily loss plus the already reserved stop risk exhausts the existing budget.
 risk.a.cash='451';risk.a.equity='451';risk.a.day='2026-10-31';risk.a.dayStart='500';
 await risk.lab.boundary();assert.equal(risk.s.frequency.lastDecision.reason,'PORTFOLIO_RISK_COMMITTED');assert.equal(orders(risk.a).length,1);assert.equal(risk.s.frequency.daySelections,12);
});

test('monitor reports continuous operation only from an exact migrated protocol',()=>{
 const h=capacityHarness();previousProtocol(h.s);let view=frequencyView(h.s);
 assert.equal(view.operation_mode,'DAILY_CAPPED_PAPER');assert.equal(view.daily_selection_limit,12);
 initializeFrequency(h.s,START+1);view=frequencyView(h.s);assert.equal(view.operation_mode,'CONTINUOUS_PAPER');assert.equal(view.daily_selection_limit,null);assert.equal(view.protocol.maxSelectionsPerUTCDate,null);
 h.s.frequency.protocol_hash='corrupt';view=frequencyView(h.s);assert.equal(view.operation_mode,'UNKNOWN');assert.equal('daily_selection_limit' in view,false);
});
