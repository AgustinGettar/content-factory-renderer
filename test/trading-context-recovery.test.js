// Offline recovery regression. Fixtures never connect to Kraken or send notices.
import test from 'node:test';
import assert from 'node:assert/strict';
import {TradingEngine} from '../lib/trading/engine.js';
import {KrakenFeed} from '../lib/trading/feed.js';
import {orders} from '../lib/trading/portfolio.js';
import {initializeSecondaryRisk} from '../lib/trading/secondary-risk.js';
import {initializeEntryProfile} from '../lib/trading/entry-profile.js';
import {initializeContextProfile} from '../lib/trading/context-profile.js';
import {initializeMakerSizing} from '../lib/trading/maker-sizing.js';
import {initializeExits} from '../lib/trading/paper-exits.js';
import {initializeBoost} from '../lib/trading/secondary-boost.js';
import {initializeCapacity} from '../lib/trading/secondary-capacity.js';

const FRAMES=[1,15,60,240],MINUTE=60000;
const expected=(cutoff,tf)=>Math.floor(cutoff/(tf*MINUTE))*tf*MINUTE;
function bars(tf,end,availableAt){
 const range={1:100,15:400,60:1500,240:2000}[tf];
 return Array.from({length:120},(_,i)=>{const c=100000+i*100;return {start:end-(120-i)*tf*MINUTE,end:end-(119-i)*tf*MINUTE,open:c-50,close:c,high:c+range/2,low:c-range,volume:10,trades:10,available_at:availableAt};});
}
async function harness(crossing){
 let now=crossing-1000;const calls=[];
 const feed=new KrakenFeed({now:()=>now,fetchImpl:async()=>{throw Error('NETWORK_FORBIDDEN_IN_TEST');}});
 feed.metadata={tick_size:'.1',lot_decimals:8,ordermin:'.00001',costmin:'.1',leverage_buy:[2,3,4,5,6,7,8,9,10],leverage_sell:[2,3,4,5,6,7,8,9,10],status:'online',checked_at:now};
 feed.state={connected:true,reconciled:true,system:'online',clock:{checked_at:now,error_ms:0},quote:{bid:'111900',ask:'111900.1',bid_qty:'100',ask_qty:'100',event_at:now,received_at:now},trade:{price:'111900',event_at:now,received_at:now}};
 for(const tf of FRAMES)feed.series[tf]=bars(tf,expected(now,tf),now);
 const store={async acquire(){return {};},async commit(){},async renew(){}};
 const engine=await new TradingEngine({store,feed,now:()=>now}).initialize(),s=engine.state,lab=engine.laboratory;
 lab.maintain();initializeSecondaryRisk(s,now,true);lab.maintain();initializeEntryProfile(s,now,true);lab.maintain();initializeContextProfile(s,now,true);lab.maintain();
 initializeMakerSizing(s,now,true);initializeExits(s,now,true);initializeBoost(s,now,true);lab.maintain();initializeCapacity(s,now,true);lab.maintain();
 // Exercise the primary's multi-frame scheduling as well as the active secondary.
 engine.active().recipe=structuredClone(lab.trial().recipe);
 const time=at=>{now=at;feed.metadata.checked_at=at;feed.state.clock.checked_at=at;for(const k of ['quote','trade'])feed.state[k].event_at=feed.state[k].received_at=at;};
 const refresh=frames=>{for(const tf of frames)feed.series[tf]=bars(tf,expected(Math.floor(now/MINUTE)*MINUTE,tf),now);};
 feed.reconcile=async({timeframes})=>{calls.push([...timeframes]);refresh(timeframes);return true;};
 time(crossing+605);await engine.recover({gapStart:crossing-2000});
 assert.equal(engine.repairing,false);assert.equal(engine.state.last_frame_cutoff,crossing);assert.equal(orders(s.frequency.account).length,0);
 engine.events=[];engine.notices=[];
 return {engine,s,lab,feed,calls,refresh,time,now:()=>now,next:crossing+MINUTE};
}

for(const [label,date,needed] of [
 ['quarter hour','2026-10-31T15:45:00Z',[1,15]],
 ['hour','2026-10-31T17:00:00Z',[1,15,60]],
 ['four hours','2026-10-31T16:00:00Z',[1,15,60,240]],
])test('flat recovery crossing '+label+' repairs context at the next minute without old entries',async()=>{
 const crossing=Date.parse(date),h=await harness(crossing);
 for(const tf of needed.filter(tf=>tf!==1))assert(h.feed.series[tf].at(-1).end<expected(crossing,tf));
 const trial=h.lab.trial(),trialVersion=trial.version;
 h.time(h.next+2000);await h.engine.boundary();await h.lab.boundary();
 assert.deepEqual(h.calls,[needed]);
 for(const tf of FRAMES){assert.equal(h.feed.series[tf].at(-1).end,expected(h.next,tf));assert.equal(h.s.timeframes.series[tf].last_closed_at,expected(h.next,tf));}
 const evaluations=h.engine.events.filter(e=>['RULE_EVALUATION','LABORATORY_EVALUATION'].includes(e.type));
 assert(evaluations.some(e=>e.type==='RULE_EVALUATION'));assert(evaluations.some(e=>e.type==='LABORATORY_EVALUATION'));
 assert(evaluations.every(e=>e.cutoff===h.next&&e.timeframe===1),JSON.stringify(evaluations));
 assert.equal(h.s.frequency.lastDecision.reason,'ENTRY_SELECTED');assert.equal(orders(h.s.frequency.account).length,1);
 assert(h.engine.events.filter(e=>e.type==='SELECTED').every(e=>e.plan.confirmed_at===h.next));
 assert.equal(h.lab.trial(),trial);assert.equal(trial.version,trialVersion);
 const before=h.engine.events.length;await h.engine.boundary();await h.lab.boundary();assert.equal(h.calls.length,1);assert.equal(h.engine.events.length,before);
});

test('retries fetch only the context still missing, using its own expected close',async()=>{
 const h=await harness(Date.parse('2026-10-31T15:45:00Z'));
 h.feed.reconcile=async({timeframes})=>{h.calls.push([...timeframes]);h.refresh(h.calls.length===1?timeframes.filter(tf=>tf!==15):timeframes);return true;};
 h.time(h.next+2000);await h.engine.boundary();await h.lab.boundary();
 assert.deepEqual(h.calls,[[1,15]]);assert.deepEqual(h.engine.barRetry.frames,[15]);assert.equal(h.engine.barRetry.attempts,1);assert.equal(h.s.last_frame_cutoff,h.next-MINUTE);assert.equal(h.s.frequency.lastDecision,null);
 await h.engine.boundary();assert.equal(h.calls.length,1);
 h.time(h.next+3100);await h.engine.boundary();await h.lab.boundary();
 assert.deepEqual(h.calls,[[1,15],[15]]);assert.equal(h.engine.barRetry,null);assert.equal(h.s.last_frame_cutoff,h.next);assert.equal(h.s.frequency.lastDecision.reason,'ENTRY_SELECTED');
 assert.equal(h.feed.series[15].at(-1).end,h.next-MINUTE);
});

test('background reconciliation does not consume the entry window or retry budget',async()=>{
 const h=await harness(Date.parse('2026-10-31T15:45:00Z'));h.time(h.next+2000);h.feed.busy=true;
 await h.engine.boundary();assert.equal(h.calls.length,0);assert.equal(h.engine.barRetry,undefined);assert.equal(h.s.last_frame_cutoff,h.next-MINUTE);
 h.time(h.next+3100);h.feed.busy=false;await h.engine.boundary();await h.lab.boundary();
 assert.deepEqual(h.calls,[[1,15]]);assert.equal(h.s.frequency.lastDecision.reason,'ENTRY_SELECTED');
});

test('ready recovery during reconciliation skips that close instead of evaluating it again',async()=>{
 for(const elapsed of [0,MINUTE]){
  const h=await harness(Date.parse('2026-10-31T15:45:00Z'));
  h.feed.reconcile=async({timeframes})=>{
   h.time(h.next+elapsed+2000);h.calls.push([...timeframes]);h.refresh(timeframes);h.feed.busy=true;
   try{h.feed.emit('ready',{gapStart:h.next-1000});return true;}finally{h.feed.busy=false;}
  };
  h.time(h.next+2000);await h.engine.boundary();await h.lab.boundary();
  assert.equal(h.s.last_frame_cutoff,h.next+elapsed);assert.equal(h.lab.trial().frameCutoffs[1],h.next+elapsed);
  assert.equal(h.engine.events.filter(e=>e.type==='FEED_RECOVERED').length,1);
  assert(!h.engine.events.some(e=>['RULE_EVALUATION','LABORATORY_EVALUATION','SELECTED'].includes(e.type)));
  assert.equal(orders(h.s.frequency.account).length,0);assert.equal(h.engine.barRetry,null);
 }
});

test('late context never extends the ten-second entry deadline or causes retrospective entries',async()=>{
 const h=await harness(Date.parse('2026-10-31T15:45:00Z'));
 h.time(h.next+11000);await h.engine.boundary();await h.lab.boundary();
 assert.equal(h.calls.length,0);assert.equal(orders(h.s.frequency.account).length,0);assert.equal(h.s.frequency.lastDecision.reason,'LATE_EVALUATION');
 assert(!h.engine.events.some(e=>e.type==='SELECTED'));
 h.time(h.next+MINUTE+2000);await h.engine.boundary();await h.lab.boundary();
 assert.deepEqual(h.calls,[[1,15]]);assert.equal(h.s.frequency.lastDecision.reason,'ENTRY_SELECTED');assert.equal(h.s.frequency.lastDecision.cutoff,h.next+MINUTE);
 assert(h.engine.events.filter(e=>e.type==='SELECTED').every(e=>e.plan.confirmed_at===h.next+MINUTE));
});
