// Synthetic wiring test. Persistent fixture and notices never leave this process.
import test from 'node:test';import assert from 'node:assert/strict';
import {TradingEngine} from '../lib/trading/engine.js';import {KrakenFeed} from '../lib/trading/feed.js';import {M15,H1,H4,POLICY} from '../lib/trading/core.js';
test('engine wires closed-bar candidate, reservation, durable outbox, fill and automatic close',async()=>{
 let now=1793232002000;const cutoff=now-2000,events=[],notices=[];let saved={};
 const store={revision:0,async acquire(){return structuredClone(saved);},async renew(){},async commit(s,e,n){saved=structuredClone(s);events.push(...structuredClone(e));notices.push(...structuredClone(n));this.revision++;}};
 const feed=new KrakenFeed({now:()=>now});const meta={lot_decimals:8,ordermin:'.00006',costmin:'.5',tick_size:'.1',status:'online',checked_at:now};feed.metadata=meta;
 feed.state={connected:true,reconciled:true,system:'online',clock:{checked_at:now,error_ms:100},quote:{bid:'3009.8',ask:'3009.9',bid_qty:'100',ask_qty:'100',event_at:now,received_at:now},trade:{price:'3009.8',event_at:now,received_at:now}};
 const bars=(n,tf,base)=>Array.from({length:n},(_,i)=>({start:cutoff-(n-i)*tf,end:cutoff-(n-i-1)*tf,open:base+i-1,high:base+i+3,low:base+i-3,close:base+i,volume:10,trades:1,available_at:cutoff-(n-i-1)*tf+1}));
 feed.series={'240':bars(1001,H4,2000),'60':bars(300,H1,2000),'15':bars(300,M15,2700)};Object.assign(feed.series['15'].at(-1),{open:2996,low:2995,high:3010,close:3009});
 feed.reconcile=async()=>true;
 const engine=await new TradingEngine({store,feed,now:()=>now}).initialize();engine.repairing=false;engine.state.last_cutoff=cutoff-M15;
 engine.active().strategy.setups.ALONG={id:'synthetic-setup',family:'A',direction:'LONG',at:cutoff-M15,expires:cutoff+M15,atr:100,low:2750,high:3100};
 await engine.tick();assert(engine.active().account.pending);assert(notices.some(n=>n.kind==='SIGNAL'));assert(events.some(e=>e.type==='CANDIDATE'));assert(events.some(e=>e.type==='SELECTED'));assert.equal(saved.research.versions[POLICY.version].account.pending.plan.id,engine.active().account.pending.plan.id);
 now+=1500;Object.assign(feed.state.quote,{bid:'3009.9',ask:'3010.0',event_at:now,received_at:now});Object.assign(feed.state.trade,{price:'3010.1',event_at:now,received_at:now});engine.onMarket();assert(engine.active().account.position);
 await engine.flush();assert(saved.research.versions[POLICY.version].account.position);
 now+=1000;Object.assign(feed.state.quote,{bid:'2700',ask:'2700.1',event_at:now,received_at:now});Object.assign(feed.state.trade,{price:'2700',event_at:now,received_at:now});engine.onMarket();await engine.flush();assert.equal(engine.active().account.position,null);assert.equal(engine.active().account.closed,1);assert(notices.some(n=>n.kind==='RESULT'));assert(events.some(e=>e.type==='CLOSED'&&Number(e.pnl)<0));
 const reboot=await new TradingEngine({store,feed:new KrakenFeed(),now:()=>now}).initialize();assert.equal(reboot.active().account.closed,1);assert.equal(reboot.active().account.net,engine.active().account.net);
});
