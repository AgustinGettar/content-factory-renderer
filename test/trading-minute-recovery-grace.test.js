// Reproduce the minute-publication race without exchange calls or ledger writes.
import test from 'node:test';
import assert from 'node:assert/strict';
import {initialState,TradingEngine} from '../lib/trading/engine.js';
import {initializeFrequency} from '../lib/trading/frequency.js';
import {freshness} from '../lib/trading/core.js';
const C=Date.parse('2026-11-01T02:15:00Z');
function harness(){
 let now=C+196,includeOpen=false,repairs=0;
 const feed={series:{1:[],15:[],60:[],240:[]},metadata:{status:'online',checked_at:now},state:{connected:true,reconciled:true,system:'online',clock:{checked_at:now,error_ms:0},quote:{ask:'100.01',bid:'100',ask_qty:'10',bid_qty:'10',event_at:now,received_at:now},trade:{price:'100',event_at:now,received_at:now}},fetchImpl:async()=>{
  const rows=[[C/1000-60,'100','101','99','100','100','1',10]];
  if(includeOpen)rows.push([C/1000,'100','101','99','100','100','1',1]);
  return Response.json({error:[],result:{XXBTZUSD:rows,last:C/1000}});
 }};
 assert.equal(freshness(feed.state,now,feed.metadata),null);
 const engine=new TradingEngine({feed,store:{},now:()=>now});engine.state=initialState(C+100);initializeFrequency(engine.state,C+100);engine.state.technicalQueued=true;
 engine.state.frequency.account.position={fixture:true};engine.frequency={recover(){repairs++;}};
 return {engine,repairs:()=>repairs,time(at){now=at;feed.metadata.checked_at=at;feed.state.clock.checked_at=at;for(const k of ['quote','trade'])feed.state[k].event_at=feed.state[k].received_at=at;},open(){includeOpen=true;}};
}
test('missing newly opened minute waits before any conservative stop or account mutation',async()=>{
 const h=harness(),before=structuredClone(h.engine.state.frequency.account);
 await h.engine.recover({gapStart:C+88});assert.equal(h.repairs(),0);assert.equal(h.engine.repairing,true);assert.equal(h.engine.gapAt,C+88);assert.deepEqual(h.engine.state.frequency.account,before);
 assert.equal(h.engine.events[0].type,'RECOVERY_WAIT_CURRENT_CANDLE');assert(!h.engine.events.some(e=>e.type==='CLOSED'||e.type==='FEED_RECOVERED'));
 h.time(C+1600);h.open();await h.engine.recover({gapStart:h.engine.gapAt});assert.equal(h.repairs(),1);assert.equal(h.engine.repairing,false);assert.equal(h.engine.gapAt,null);assert(h.engine.events.some(e=>e.type==='FEED_RECOVERED'));
});
test('checkpoint advancement does not reset the original eight-second grace',async()=>{
 const h=harness();await h.engine.recover({gapStart:C+88});h.time(C+4000);h.engine.state.last_checkpoint=C+3900;
 await h.engine.recover({gapStart:h.engine.gapAt});assert.equal(h.repairs(),0);assert.equal(h.engine.gapAt,C+88);
 h.time(C+9000);h.engine.state.last_checkpoint=C+8900;await h.engine.recover({gapStart:h.engine.gapAt});assert.equal(h.repairs(),1);assert.equal(h.engine.repairing,false);
});
test('available current-minute data and older unresolved gaps retain existing reconciliation',async()=>{
 const ready=harness();ready.open();await ready.engine.recover({gapStart:C+88});assert.equal(ready.repairs(),1);
 const old=harness();old.engine.state.last_checkpoint=C-120000;await old.engine.recover({gapStart:C-120000});assert.equal(old.repairs(),1);
});
