// Synthetic execution/causality tests, never performance evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import {initialState,TradingEngine} from '../lib/trading/engine.js';
import {KrakenFeed,restBars} from '../lib/trading/feed.js';
import {initializeFrequency,FrequencyExperiment} from '../lib/trading/frequency.js';
import {initializeLearning,TradingLearning} from '../lib/trading/learning.js';
import {initializeLaboratory,TradingLaboratory,promotionReport,laboratoryPlan,MULTIFRAME_PROTOCOL} from '../lib/trading/laboratory.js';
import {initializePortfolio,orders,reserved} from '../lib/trading/portfolio.js';
import {initializeTimeframes,TIMEFRAMES,componentVersion,recipeComponents} from '../lib/trading/timeframes.js';
import {projectMonitor} from '../lib/trading/monitor-projection.js';
import {renderNotice} from '../lib/trading/notifier.js';
import {D} from '../lib/trading/core.js';
const START=Date.parse('2026-10-30T00:00:00Z'),HOUR=3600000;
function bars(tf,cutoff,now,wide=true){return Array.from({length:120},(_,i)=>{const close=50000+i*300;return {start:cutoff-(120-i)*tf*60000,end:cutoff-(119-i)*tf*60000,open:close-50,high:close+100,low:close-(wide?1500:100),close,volume:10,trades:10,available_at:now};});}
function harness(){
 let now=START;const events=[],notices=[],s=initialState(now);initializeFrequency(s,now);initializeLearning(s,now);initializeLaboratory(s,now);initializePortfolio(s,now);
 const feed=new KrakenFeed({now:()=>now});feed.metadata={tick_size:'.1',lot_decimals:8,ordermin:'.00000001',costmin:'.01',status:'online',checked_at:now};
 feed.state={connected:true,reconciled:true,system:'online',clock:{checked_at:now,error_ms:0},quote:{ask:'85700',bid:'85699.9',ask_qty:'.001',bid_qty:'.001',event_at:now,received_at:now},trade:{price:'85700',event_at:now,received_at:now}};
 let lab;const learning=new TradingLearning({state:s.learning,now:()=>now,event:e=>events.push(e)});
 const event=e=>{if(['SELECTED','CLOSED','NOT_FILLED'].includes(e.type))learning.observe(e,e.ledger,e.version);lab?.observe(e);events.push(e);};
 const frequency=new FrequencyExperiment({state:s.frequency,feed,now:()=>now,event,notice:(...e)=>notices.push(e)});
 lab=new TradingLaboratory({state:s,feed,frequency,learning,now:()=>now,event,notice:(...e)=>notices.push(e)});
 const time=n=>{now=n;feed.metadata.checked_at=n;feed.state.clock.checked_at=n;for(const k of ['quote','trade'])feed.state[k].event_at=feed.state[k].received_at=n;};
 return {s,feed,lab,events,notices,time,now:()=>now,enable(){initializeTimeframes(s,now);lab.maintain();},seed(cutoff){for(const tf of TIMEFRAMES)feed.series[tf]=bars(tf,Math.floor(cutoff/(tf*60000))*tf*60000,now);}};
}
test('four-frame migration waits for legacy exposure and preserves balances, losses, learning and halt',()=>{
 const h=harness();h.lab.maintain();const old=h.lab.trial();h.s.frequency.account.cash=h.s.frequency.account.equity='99.26';h.s.frequency.account.net='-.74';h.s.frequency.account.halted=true;
 h.s.frequency.account.pendingOrders.legacy={plan:{id:'legacy'}};h.enable();assert.equal(h.s.timeframes.status,'WAITING_FLAT');assert.equal(h.lab.trial(),old);
 delete h.s.frequency.account.pendingOrders.legacy;h.lab.maintain();assert.equal(h.s.timeframes.status,'ACTIVE');assert.equal(h.s.schema,3);assert.equal(h.s.frequency.account.net,'-.74');assert.equal(h.s.frequency.account.equity,'99.26');assert(h.s.frequency.account.halted);
 assert.equal(h.s.laboratory.execution_archives.at(-1).trials[0].version,old.version);assert.equal(h.s.research.versions[h.s.research.active].account.equity,'100');
 assert.equal(initializeTimeframes(h.s,h.now()),null);assert.equal(initializeLaboratory(h.s,h.now()),null);assert.equal(initializePortfolio(h.s,h.now()),null);
 assert.equal(h.notices.filter(n=>n[1].type==='TIMEFRAMES_ENABLED').length,1);
});
test('four simultaneous closes evaluate distinct strategies once with shared cash, slots and risk',async()=>{
 const h=harness();h.enable();h.time(START+4*HOUR+2000);h.seed(START+4*HOUR);await h.lab.boundary();
 const decisions=h.events.filter(e=>e.type==='LABORATORY_EVALUATION');assert.deepEqual(decisions.map(e=>e.timeframe),[240,60,15,1]);assert.equal(new Set(decisions.map(e=>e.version)).size,4);
 const a=h.s.frequency.account;assert(orders(a).length>=1);assert(orders(a).length<=3);assert(D(a.openRiskReserved).lte(D(a.equity).mul('.01')));assert(D(a.availableCash).gte(0));
 assert.equal(h.s.frequency.daySelections,orders(a).length);assert.equal(new Set(orders(a).map(o=>o.plan.id)).size,orders(a).length);
 assert(orders(a).every(o=>o.plan.timeframe===o.plan.evidence.default_tf));
 await h.lab.boundary();assert.equal(h.events.filter(e=>e.type==='LABORATORY_EVALUATION').length,4);
 assert.equal(Object.keys(h.s.learning.groups).filter(k=>k.startsWith('FREQUENT_PAPER:')).length,4);
});
test('one-minute decisions occur between quarter-hours and a stale quote prevents any entry',async()=>{
 const h=harness();h.enable();h.time(START+60000+2000);h.seed(START+60000);h.feed.state.quote.event_at-=6000;await h.lab.boundary();
 const e=h.events.filter(e=>e.type==='LABORATORY_EVALUATION');assert.equal(e.length,1);assert.equal(e[0].timeframe,1);assert.equal(e[0].reason,'STALE_QUOTE');assert(!reserved(h.s.frequency.account));
});
test('a minute-frame target is not inflated to force trades through high costs',()=>{
 const h=harness();h.enable();h.time(START+62000);const t=h.lab.trial(),r=recipeComponents(t.recipe)[0];
 const decision=laboratoryPlan(r,componentVersion(t.version,t.recipe,1),{'1':bars(1,START+60000,h.now(),false)},h.feed.state,h.feed.metadata,START+60000,h.now());
 assert.equal(decision.reason,'LAB_COSTS_TOO_HIGH');assert(!decision.plan);
});
test('every frame rejects its open candle and uses the same causal frozen evidence',()=>{
 const h=harness();h.enable();h.time(START+4*HOUR+2000);const t=h.lab.trial(),cutoff=START+4*HOUR;
 for(const r of recipeComponents(t.recipe)){
  const rows=bars(r.tf,cutoff,h.now()),version=componentVersion(t.version,t.recipe,r.tf);
  const a=laboratoryPlan(r,version,{[r.tf]:rows},h.feed.state,h.feed.metadata,cutoff,h.now());assert(a.plan);
  const future={...rows.at(-1),start:cutoff,end:cutoff+r.tf*60000,close:999999,available_at:h.now()};
  const b=laboratoryPlan(r,version,{[r.tf]:[...rows,future]},h.feed.state,h.feed.metadata,cutoff,h.now());assert.equal(b.plan.hash,a.plan.hash);
  assert(a.plan.evidence.panels[0].candles.every(c=>c.end<=cutoff));
 }
});
test('promotion cannot use a large one-minute sample as validation of the other frames',()=>{
 const h=harness();h.enable();const t=h.lab.trial();t.training=1000;t.frames={1:{training:1000,validation:2000}};t.validation={clean:2000,days:Array(100).fill({})};
 assert.equal(promotionReport(t,START+200*86400000).reason,'MORE_FUTURE_OUTCOMES_PER_FRAME');assert.equal(MULTIFRAME_PROTOCOL.maxHypotheses,5);
});
test('monitor and notices identify frames without claiming activation before deployment',async()=>{
 const h=harness();h.enable();h.time(START+4*HOUR+2000);h.seed(START+4*HOUR);await h.lab.boundary();
 const d=projectMonitor({states:[{state:h.s,updated_at:new Date(h.now()).toISOString(),revision:1,lease_until:new Date(h.now()+30000).toISOString()}],now:h.now()});
 assert.deepEqual(d.timeframes.frames,[1,15,60,240]);assert.equal(d.learning.groups.length,5);assert.equal(Object.keys(d.laboratory.trials[0].decisions).length,4);
 for(const n of h.notices.filter(n=>n[0]==='SIGNAL')){const text=renderNotice({kind:n[0],payload:n[1]},h.feed.state,h.now());assert.match(text,/SIMULACIÓN FICTICIA · BTC\/USD · (1 m|15 m|1 h|4 h)/);assert(text.length<1200);}
});
test('engine reconciles only due frames on minute boundaries; restart skips past closes',async()=>{
 const h=harness();let saved={};const calls=[];h.feed.reconcile=async arg=>{calls.push(arg.timeframes);return true;};
 const store={async acquire(){return structuredClone(saved);},async commit(s){saved=structuredClone(s);},async renew(){}};
 const e=await new TradingEngine({feed:h.feed,store,now:h.now}).initialize();e.repairing=false;e.laboratory.maintain();
 for(const minute of [1,15,60,240]){h.time(START+minute*60000+2000);h.seed(START+minute*60000);await e.tick();}
 assert.deepEqual(calls,[[1],[1,15],[1,15,60],[1,15,60,240]]);
 const money=saved.frequency.account.equity,closed=saved.frequency.account.closed;
 const reboot=await new TradingEngine({feed:h.feed,store,now:h.now}).initialize();reboot.repairing=false;await reboot.tick();assert.equal(calls.length,4);assert.equal(reboot.state.frequency.account.equity,money);assert.equal(reboot.state.frequency.account.closed,closed);
});
test('Kraken REST minute reconciliation discards the uncommitted last element',async()=>{
 const h=harness();h.time(START+62000);const closed=bars(1,START+60000,h.now()),all=[...closed,{...closed.at(-1),start:START+60000,end:START+120000}];
 const response={XXBTZUSD:all.map(b=>[b.start/1000,String(b.open),String(b.high),String(b.low),String(b.close),'1',String(b.volume),b.trades])};
 h.feed.fetchImpl=async()=>new Response(JSON.stringify({error:[],result:response}));
 assert(await h.feed.reconcile({timeframes:[1]}));assert.equal(h.feed.series['1'].at(-1).end,START+60000);assert.equal(h.feed.series['1'].length,120);assert.equal(restBars(response,1,h.now()).length,120);
});
test('a promoted four-frame bundle retains the shared daily limit of its experiment',async()=>{
 const h=harness();const store={async acquire(){return {};},async commit(){},async renew(){}};
 h.feed.reconcile=async()=>true;const e=await new TradingEngine({feed:h.feed,store,now:h.now}).initialize();e.repairing=false;e.laboratory.maintain();
 const v=e.active();v.recipe=structuredClone(e.laboratory.trial().recipe);v.selectionDay='2026-10-30';v.daySelections=12;
 h.time(START+60000+2000);h.seed(START+60000);await e.boundary();assert.equal(orders(v.account).length,0);assert(e.events.some(x=>x.reason==='DAILY_SELECTION_LIMIT'));
 h.time(START+86400000+2000);h.seed(START+86400000);await e.boundary();assert.equal(v.selectionDay,'2026-10-31');assert(v.daySelections>0);assert(v.daySelections<=3);
});
