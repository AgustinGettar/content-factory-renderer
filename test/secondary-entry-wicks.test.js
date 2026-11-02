import test from 'node:test';
import assert from 'node:assert/strict';
import {secondaryCandidates as original} from '../lib/trading/secondary-futures-engine.js';
import {secondaryCandidates} from '../lib/trading/secondary-futures.js';
const C=Date.parse('2026-11-01T21:00:00Z'),now=C+2000,meta={tick_size:.01,qty_step:.0001};
const q=p=>({source:'KRAKEN_FUTURES_WS_TICKER',symbol:'PF_XBTUSD',event_at:now,received_at:now,bid:String(p),ask:String(p+.01),bid_qty:'100',ask_qty:'100'});
const invert=s=>Object.fromEntries(Object.entries(s).map(([k,b])=>[k,b.map(x=>({...x,open:400-x.open,close:400-x.close,high:400-x.low,low:400-x.high}))]));
function bars(tf,fn){return Array.from({length:96},(_,i)=>({start:C-(96-i)*tf*60000,end:C-(95-i)*tf*60000,volume:1,...fn(i)}));}
test('a pullback completed within the confirming candle is no longer required to span two candles',()=>{
 const s={5:bars(5,i=>({open:190+i*.1-.01,close:190+i*.1,low:190+i*.1-.03,high:190+i*.1+.06})),15:bars(15,i=>({open:190+i*.1-.01,close:190+i*.1,low:190+i*.1-.03,high:190+i*.1+.06}))};
 Object.assign(s[5].at(-1),{open:199.45,close:199.6,low:198.8,high:199.65});
 for(const [data,price] of [[s,199.6],[invert(s),200.39]]){
  const before=original(data,q(price),meta,C,now,0).find(x=>x.pattern==='PULLBACK'),after=secondaryCandidates(data,q(price),meta,C,now,0).find(x=>x.pattern==='PULLBACK');
  assert.equal(before.reason,'WAIT_PULLBACK');assert.equal(after.facts.trigger,'SAME_CANDLE_PULLBACK');assert.notEqual(after.reason,'WAIT_PULLBACK');
  if(after.plan)assert(after.plan.economics.netRR>=1.5);
 }
});
test('a closed wick reentry can be recognized without assuming it passes the economic filters',()=>{
 const s={5:bars(5,i=>{const p=i%2?201:199;return {open:p,close:p,low:p-.1,high:p+.1};}),15:bars(15,()=>({open:200,close:200,low:199.9,high:200.1}))};
 Object.assign(s[5].at(-1),{open:198.2,close:198.3,low:197.7,high:198.5});
 for(const [data,price] of [[s,198.3],[invert(s),201.69]]){
  const before=original(data,q(price),meta,C,now,0).find(x=>x.pattern==='RANGE_REENTRY'),after=secondaryCandidates(data,q(price),meta,C,now,0).find(x=>x.pattern==='RANGE_REENTRY');
  assert.equal(before.reason,'WAIT_RANGE_REENTRY');assert.equal(after.facts.trigger,'WICK_REENTRY');assert.notEqual(after.reason,'WAIT_RANGE_REENTRY');
  if(after.plan)assert(after.plan.economics.netRR>=1.5);else assert(['STRUCTURAL_ENTRY_DISTANCE','COST_OR_NET_RR','TARGET_OUTSIDE_SHORT_HORIZON'].includes(after.reason));
 }
});
