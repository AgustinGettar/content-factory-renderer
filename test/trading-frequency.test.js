// Synthetic fixtures only; no market claims or real network calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {D,POLICY,hash,riskPlan} from '../lib/trading/core.js';
import {initialState,TradingEngine} from '../lib/trading/engine.js';
import {initializeFrequency,frequencyPlan,FrequencyExperiment,FREQUENCY_POLICY,FREQUENCY_PROTOCOL} from '../lib/trading/frequency.js';
import {newAccount,select,step,invalidate} from '../lib/trading/simulator.js';
import {renderNotice} from '../lib/trading/notifier.js';
import {initializeLearning,TradingLearning} from '../lib/trading/learning.js';
const cutoff=Date.parse('2026-10-29T11:20:00Z'),now=cutoff+2000;
const bars=Array.from({length:120},(_,i)=>({start:cutoff-(120-i)*60000,end:cutoff-(119-i)*60000,open:100+i*.01-.005,high:100+i*.01+.01,low:100+i*.01-.01,close:100+i*.01,volume:10,trades:10,available_at:now}));
const meta={tick_size:'.001',lot_decimals:8,ordermin:'.00005',costmin:'5',status:'online',checked_at:now};
const snapshot=(at=now)=>({connected:true,reconciled:true,system:'online',clock:{checked_at:at,error_ms:0},quote:{ask:'101.19',bid:'101.18',ask_qty:'10',bid_qty:'10',event_at:at,received_at:at},trade:{price:'101.19',event_at:at,received_at:at}});
function harness(){let t=now,calls=0;const state=initialState(now-60000);initializeFrequency(state,now-60000);const events=[],notices=[];const feed={state:snapshot(),metadata:meta,fetchImpl:async()=>{calls++;const rows=bars.map(b=>[b.start/1000,...['open','high','low','close'].map(k=>String(b[k])),'101','10',10]);rows.push([cutoff/1000,'101','999999','0','999999','101','10',10]);return Response.json({error:[],result:{XXBTZUSD:rows,last:cutoff/1000}});}};const ex=new FrequencyExperiment({state:state.frequency,feed,now:()=>t,event:e=>events.push(e),notice:(...n)=>notices.push(n)});return {state,feed,ex,events,notices,calls:()=>calls,time:at=>{t=at;feed.state=snapshot(at);}};}
test('second USD100 account is independent, initialized once and preserves an existing losing/open base account',()=>{
 const s=initialState(now);Object.assign(s.research.versions[s.research.active].account,{cash:'85',equity:'97',net:'-3',fees:'1',closed:4,position:{fixture:true}});const base=structuredClone(s);
 const e=initializeFrequency(s,now);assert.equal(s.frequency.account.cash,'100');assert.equal(s.frequency.baseline_at_start.net,'-3');assert.equal(e.protocol_hash,hash(FREQUENCY_PROTOCOL));
 assert.deepEqual(s.research,base.research);assert.deepEqual(s.alert,base.alert);s.frequency.account.cash='99';assert.equal(initializeFrequency(s,now+1),null);assert.equal(s.frequency.account.cash,'99');
 s.frequency.protocol_hash='different';assert.throws(()=>initializeFrequency(s,now+1),/PROTOCOL_MISMATCH/);
});
test('one-minute momentum uses closed available bars and targets a positive net gain with unchanged costs',()=>{
 const f=snapshot(),r=frequencyPlan(bars,f,meta,cutoff,now);assert(r.plan,JSON.stringify(r));const p=r.plan;
 const sizing=riskPlan(p,newAccount(),f.quote,meta,FREQUENCY_POLICY);assert(!sizing.reason,JSON.stringify(sizing));assert(D(sizing.risk).lte('.25'));assert(D(sizing.net_rr).gte('.1'));assert.equal(sizing.fee,POLICY.fee);assert.equal(sizing.financing,'SPOT_CASH_1X');
 assert.equal(riskPlan(p,newAccount(),f.quote,meta).reason,'NET_RR_TOO_LOW');assert(+p.target/+p.limit>1.016);assert.equal(p.holding_ms,1800000);
 const future={...bars.at(-1),start:cutoff,end:cutoff+60000,close:999999,available_at:now};assert.equal(frequencyPlan([...bars,future],f,meta,cutoff,now).plan.hash,p.hash);
 const delayed=structuredClone(bars);delayed.at(-1).available_at=now+1;assert.equal(frequencyPlan(delayed,f,meta,cutoff,now).reason,'UNSYNCHRONIZED_1');
 const flat=bars.map(b=>({...b,open:100,close:100,high:101,low:99}));assert.equal(frequencyPlan(flat,f,meta,cutoff,now).reason,'FREQUENCY_WAIT_MOMENTUM');
 assert.equal(invalidate(p,f,now,{long:false,breakLong:false}),null);
});
test('minute evaluation selects at most once, with durable scope and no original ledger mutation',async()=>{
 const h=harness(),before=structuredClone(h.state.research);await h.ex.boundary();await h.ex.boundary();assert.equal(h.calls(),1);assert.equal(h.state.frequency.counts.selected,1);assert.equal(h.state.frequency.daySelections,1);assert.equal(h.state.frequency.lastDecision.reason,'ENTRY_SELECTED');assert.deepEqual(h.state.research,before);
 assert.equal(h.notices[0][0],'SIGNAL');assert.equal(h.notices[0][1].account,'FREQUENT_PAPER');assert(h.events.every(e=>e.ledger==='FREQUENT_PAPER'));
});
test('minute entries continue after twelve or many earlier selections without reusing a candle',async()=>{
 for(const count of [12,1200]){
  const h=harness();h.state.frequency.selectionDay='2026-10-29';h.state.frequency.daySelections=count;
  await h.ex.boundary();await h.ex.boundary();
  assert.equal(h.state.frequency.lastDecision.reason,'ENTRY_SELECTED');assert.equal(h.state.frequency.daySelections,count+1);assert.equal(h.state.frequency.counts.selected,1);assert.equal(h.calls(),1);
  assert(D(h.state.frequency.account.pending.plan.sizing.risk).lte('.25'));
 }
});
test('after twelve selections, stale quotes, cooldown, pause and open positions still suppress entries',async()=>{
 for(const [change,reason] of [[h=>{h.feed.state.quote.event_at=now-6000;},'STALE_QUOTE'],[h=>{h.state.frequency.cooldownUntil=now+60000;},'COOLDOWN'],[h=>{h.state.frequency.account.halted=true;},'DRAWDOWN_HALT'],[h=>{h.state.frequency.account.position={};},'POSITION_OR_ENTRY_IN_PROGRESS']]){const h=harness();h.state.frequency.selectionDay='2026-10-29';h.state.frequency.daySelections=12;change(h);await h.ex.boundary();assert.equal(h.state.frequency.lastDecision.reason,reason);assert.equal(h.calls(),0);assert.equal(h.state.frequency.counts.selected,0);assert.equal(h.state.frequency.daySelections,12);}
 const h=harness();h.feed.fetchImpl=async()=>{h.time(now+11000);return Response.json({error:[],result:{}});};await h.ex.boundary();assert.equal(h.state.frequency.lastDecision.reason,'BAR_RECONCILIATION_DEADLINE');
});
test('small account obeys exchange minimums and daily budget; no extra leverage to force an entry',()=>{
 const f=snapshot(),p=frequencyPlan(bars,f,meta,cutoff,now).plan;
 assert.equal(riskPlan(p,newAccount(),f.quote,{...meta,costmin:'20'},FREQUENCY_POLICY).reason,'MINIMUM_OR_LIQUIDITY');
 const a=newAccount();Object.assign(a,{equity:'99.1',cash:'99.1'});assert.equal(riskPlan(p,a,f.quote,meta,FREQUENCY_POLICY).reason,'DAILY_RISK_LIMIT');
});
test('fill, losing timeout, fees, restart and deduplicated close are accounted separately',async()=>{
 const h=harness();await h.ex.boundary();const a=h.state.frequency.account,p=a.pending.plan;h.time(now+1000);h.feed.state.quote.ask=p.entry;h.feed.state.quote.bid=D(p.entry).minus('.01').toString();h.feed.state.trade.price=p.entry;h.ex.market();assert(a.position);assert.equal(a.position.expires_at,now+1000+1800000);
 h.state.frequency.account=JSON.parse(JSON.stringify(a));h.time(now+1000+1800000);h.feed.state.quote.ask=p.entry;h.feed.state.quote.bid=D(p.entry).plus('.05').toString();h.feed.state.trade.price=p.entry;h.ex.market();h.ex.market();
 const s=h.state.frequency;assert.equal(s.account.closed,1);assert.equal(s.counts.closed,1);assert(D(s.account.net).lt(0));assert(D(s.grossClosed).gt(0));assert(D(s.closedFees).gt(s.grossClosed));assert(D(s.grossClosed).minus(s.closedFees).eq(s.account.net));assert.equal(h.notices.filter(n=>n[0]==='RESULT'&&n[1].type==='CLOSED').length,1);assert.equal(s.history[0].reason,'TIMEOUT');
});
test('ambiguous gap is preserved as a conservative loss, never an invented successful fill',async()=>{
 const h=harness();await h.ex.boundary();const p=h.state.frequency.account.pending.plan;h.time(now+60000);h.ex.recover([{start:cutoff,end:cutoff+60000,low:+p.stop-1,high:+p.target+1}],now);
 const a=h.state.frequency.account;assert.equal(a.closed,1);assert.equal(a.ambiguousClosed,1);assert(D(a.net).lt(0));assert.equal(h.state.frequency.counts.closed,1);
});
test('restart commits startup and notice once; frequency receipts never seed the original delayed ledger',async()=>{
 let saved=initialState(now),events=[],notices=[];const store={async acquire(){return structuredClone(saved);},async commit(s,e,n){saved=structuredClone(s);events.push(...e);notices.push(...n);}};
 const engine=await new TradingEngine({store,feed:new EventEmitter(),now:()=>now}).initialize();const before=structuredClone(engine.state.alert);engine.acceptDelivery({payload:{account:'FREQUENT_PAPER'}});assert.deepEqual(engine.state.alert,before);
 await new TradingEngine({store,feed:new EventEmitter(),now:()=>now+1}).initialize();assert.equal(events.filter(e=>e.type==='FREQUENCY_ACCOUNT_STARTED').length,1);assert.equal(notices.filter(n=>n.payload.type==='FREQUENCY_ACCOUNT_STARTED').length,1);
 const text=renderNotice(notices[0],{},now);assert.match(text,/100 USD/);assert.match(text,/NO DISPONIBLE/);assert.match(text,/sin préstamo/i);
});

test('actual selected plan freezes causal features and one observed close feeds only its own learner',async()=>{
 const h=harness();initializeLearning(h.state,now);const learning=new TradingLearning({state:h.state.learning,now:()=>h.feed.state.quote.event_at,event:e=>h.events.push(e)});
 h.ex.prepare=(p,b)=>learning.prepare(p,'FREQUENT_PAPER',b,h.feed.state.quote);h.ex.event=e=>{h.events.push(e);learning.observe(e,e.ledger,e.version);};
 await h.ex.boundary();const p=h.state.frequency.account.pending.plan;assert.equal(p.study.features.x.length,10);assert.equal(p.study.prediction.status,'UNAVAILABLE');assert.equal(p.hash,hash({...p,hash:undefined}));
 h.time(now+1000);h.feed.state.quote.ask=p.entry;h.feed.state.quote.bid=D(p.entry).minus('.01').toString();h.feed.state.trade.price=p.entry;h.ex.market();
 h.time(now+1801000);h.feed.state.quote.ask=p.entry;h.feed.state.quote.bid=D(p.entry).plus('.05').toString();h.feed.state.trade.price=p.entry;learning.track('FREQUENT_PAPER',p.version,h.state.frequency.account.position,h.feed.state.quote);h.ex.market();
 const groups=Object.values(h.state.learning.groups);assert.equal(groups.length,1);assert.equal(groups[0].usable,1);assert.equal(groups[0].lastAnalysis.training_eligible,true);assert.equal(groups[0].lastAnalysis.diagnosis,'COSTS_EXCEEDED_GROSS_GAIN');assert.equal(h.notices.filter(n=>n[1].type==='PAPER_OPENED').length,1);assert.equal(groups[0].rows[0].y,0);
});
