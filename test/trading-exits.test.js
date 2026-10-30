import test from 'node:test';import assert from 'node:assert/strict';
import {D,POLICY,hash} from '../lib/trading/core.js';
import {EXIT_VERSION,EXIT_PROTOCOL,exitEstimate,quoteForNet,initializeExits} from '../lib/trading/paper-exits.js';
import {acceptControl,checkControls,settleControl,PaperControlClient} from '../lib/trading/paper-controls.js';
import {marginOpen} from '../lib/trading/margin.js';import {newAccount,step,repairPosition} from '../lib/trading/simulator.js';
import {enablePortfolio,positions} from '../lib/trading/portfolio.js';
import {TradingEngine,initialState} from '../lib/trading/engine.js';import {KrakenFeed} from '../lib/trading/feed.js';
import {TradingLearning,initializeLearning} from '../lib/trading/learning.js';
import {initializeLaboratory,NET_EXIT_LAB_PROTOCOL} from '../lib/trading/laboratory.js';
const now=1793400000000,id='a'.repeat(64),planHash='b'.repeat(64);
const plan=(direction='LONG',over={})=>({id,hash:planHash,version:'test',family:'L',timeframe:1,execution_model:'lumi-margin-paper-1.0.0',exit_management:EXIT_VERSION,direction,entry:'100',stop:direction==='LONG'?'80':'120',target:direction==='LONG'?'150':'50',holding_ms:86400000,sizing:{qty:'1',risk:'20',fee:'.008',entry_fee_rate:'.004',funding_rate:'0',funding_interval:14400000,leverage:1,slippage:'.0002',initial_margin:'100',target_net:'2',financing:'SPOT_CASH_1X'},...over});
function opened(direction='LONG',over={}){const a=newAccount({...POLICY,initialCash:'300'});marginOpen(a,plan(direction,over),'100',now);return a;}
function feed(price,at=now+2000,extra={}){return {quote:{bid:String(price),ask:String(price),bid_qty:'100',ask_qty:'100',event_at:at,received_at:at,...extra},trade:{price:String(price),event_at:at,received_at:at}};}
const state=a=>({exitManagement:{version:EXIT_VERSION},controls:{receipts:[]},frequency:{account:a},research:{active:'x',versions:{x:{account:newAccount()}}}});
const command=(over={})=>({id:'00000000-0000-4000-8000-000000000001',operation_id:id,plan_hash:planHash,ledger:'FREQUENT_PAPER',action:'CLOSE',mode:'PROFIT',created_at:now,expires_at:now+120000,...over});
test('net display and exact settlement agree for long and short including actual fees, spread, slip and funding',()=>{
 for(const side of ['LONG','SHORT']){const a=opened(side);a.position.plan.sizing.funding_rate='.0005';a.position.plan.sizing.financing='PAPER_MARGIN_ESTIMATE';a.position.plan.sizing.maintenance='.8';
  const f=feed(side==='LONG'?106:94,now+14400001,{ask:side==='LONG'?'106.1':'94.1'}),v=exitEstimate(a.position,f.quote,now+14400001),e=step(a,f,now+14400001).find(e=>e.type==='CLOSED');
  assert.equal(e.reason,'NET_TARGET');assert.equal(e.pnl,v.net);assert(D(a.cash).eq(D(300).plus(e.pnl)));assert(D(v.gross).minus(v.costs).eq(v.net));assert(D(v.funding).gt(0));assert.equal(step(a,f,now+14400002).length,0);
 }
});
test('net goal solves bid/ask price without counting spread twice; gross profit cannot trigger a net target',()=>{
 for(const side of ['LONG','SHORT']){const a=opened(side),p=a.position,price=quoteForNet(p,'2',now+2000),f=feed(price);assert(D(exitEstimate(p,f.quote,now+2000).net).minus(2).abs().lt('1e-15'));}
 const a=opened();a.position.plan.target='100.5';assert.equal(step(a,feed(100.6),now+2000).length,0);assert(D(exitEstimate(a.position,feed(100.6).quote,now+2000).net).lt(0));
});
test('a manual close requires a new quote after latency; a profit request is rejected if net gain disappears',()=>{
 const a=opened(),s=state(a),c=command();acceptControl(s,c,now,()=>{});assert.equal(step(a,feed(101,now+999),now+999).length,0);
 checkControls(s,feed(100.6,now+1001),now+1001,()=>{});assert.equal(s.controls.receipts[0].reason,'NO_NET_PROFIT');assert(!a.position.close_request);assert.equal(a.closed,0);
 const any=command({id:'00000000-0000-4000-8000-000000000002',mode:'ANY'});acceptControl(s,any,now+2000,()=>{});assert.equal(step(a,feed(100,now+2000),now+3001).length,0);
 const e=step(a,feed(100,now+3001),now+3001)[0];assert.equal(e.reason,'MANUAL_CLOSE');assert(D(e.pnl).lt(0));assert(e.management_override);settleControl(s,{...e,ledger:'FREQUENT_PAPER'});assert.equal(s.controls.receipts[1].status,'CLOSED');
});
test('duplicate, expired, wrong-ledger, mismatched-plan and pending requests cannot mutate another position',()=>{
 const a=opened(),s=state(a),c=command();acceptControl(s,c,now,()=>{});acceptControl(s,{...c,mode:'ANY'},now+1,()=>{});assert.equal(s.controls.receipts.length,1);assert.equal(a.position.close_request.mode,'PROFIT');
 checkControls(s,{},now+120001,()=>{});assert.equal(s.controls.receipts[0].status,'EXPIRED');assert(!a.position.close_request);
 for(const over of [{ledger:'REAL'},{plan_hash:'z'},{created_at:now-130000,expires_at:now-10000}]){const r=acceptControl(s,command({...over,id:crypto.randomUUID()}),now,()=>{});assert(['REJECTED','EXPIRED'].includes(r.status));assert(!a.position.close_request);}
});
test('changing the goal only tightens it, preserves the frozen plan, and records intervention',()=>{
 const a=opened(),s=state(a),frozen=structuredClone(a.position.plan),c=command({action:'SET_NET_GOAL',net_goal:'.50'});
 // UI wire format intentionally requires the leading zero.
 assert.equal(acceptControl(s,c,now,()=>{}).status,'REJECTED');
 const r=acceptControl(s,command({id:crypto.randomUUID(),action:'SET_NET_GOAL',net_goal:'0.50'}),now,()=>{});assert.equal(r.status,'APPLIED');assert.deepEqual(a.position.plan,frozen);assert.equal(a.position.management.net_goal,'0.50');
 assert.equal(acceptControl(s,command({id:crypto.randomUUID(),action:'SET_NET_GOAL',net_goal:'1.00'}),now,()=>{}).status,'REJECTED');
 const e=step(a,feed(102),now+2000)[0];assert.equal(e.reason,'NET_TARGET');assert(e.management_override);
});
test('voluntary exits share observed quote capacity; stop remains protective and does not wait for a profit',()=>{
 const a=opened();enablePortfolio(a);const second=structuredClone(positions(a)[0]);second.plan.id='c'.repeat(64);a.positions[second.plan.id]=second;
 const f=feed(104,now+2000,{bid_qty:'10',ask_qty:'10'});assert.equal(step(a,f,now+2000).filter(e=>e.type==='CLOSED').length,1);assert.equal(step(a,f,now+2001).length,0);assert.equal(positions(a).length,1);
 const out=step(a,feed(79,now+3000,{bid_qty:'.01'}),now+3000);assert.equal(out[0].reason,'STOP');assert.equal(positions(a).length,0);
});
test('gap candles cannot invent an executable net-profit exit from a high alone',()=>{
 const a=opened(),bars=[{start:now,end:now+60000,open:100,high:160,low:99,close:100}];repairPosition(a,bars,feed(100,now+60000),now+60000,now);assert(a.position);assert.equal(a.closed,0);assert.equal(a.position.quality,'GAP_CONSERVATIVE');
});
test('migration preserves cash/plans and new prospective protocol survives restart validation',()=>{
 const a=opened();a.position.plan.exit_management=undefined;const s={schema:8,frequency:{account:a}},before=structuredClone(a);initializeExits(s,now,true);assert.equal(s.schema,9);assert.equal(a.cash,before.cash);assert.deepEqual(a.position.plan,before.position.plan);assert(a.position.management.override);initializeExits(s,now+1,true);
 initializeLaboratory({laboratory:{protocol_hash:hash(NET_EXIT_LAB_PROTOCOL)}},now);assert(NET_EXIT_LAB_PROTOCOL.recipes[0].components.every(r=>r.exitRevision===EXIT_VERSION));
});
test('manual results are kept out of training even with otherwise observed data',()=>{
 const s=initialState(now);initializeLearning(s,now);let output;const l=new TradingLearning({state:s.learning,now:()=>now+10000,event:e=>output=e});l.observe({type:'CLOSED',id,at:now+10000,entered_at:now,pnl:'1',fees:'1',quality:'OBSERVED',management_override:true},'FREQUENT_PAPER','test');assert.equal(output.exclusion,'MANUAL_OR_MANAGEMENT_OVERRIDE');assert.equal(output.training_eligible,false);
});
test('transport only acknowledges persisted receipts; retries after restart cannot close twice',async()=>{
 const a=opened(),s=state(a),c=command({mode:'ANY'});let saved=structuredClone(s),puts=[];const client=new PaperControlClient({store:{row:()=>({state:saved})},env:{},fetchImpl:async(u,o)=>{if(o.method==='GET')return Response.json({commands:[c]});puts.push(JSON.parse(o.body));return Response.json({ok:true});}});
 await client.poll();assert.equal(client.drain().length,1);acceptControl(s,c,now,()=>{});await client.poll();assert.equal(puts.length,0);
 const e=step(a,feed(100),now+2000)[0];settleControl(s,{...e,ledger:'FREQUENT_PAPER'});saved=structuredClone(s);await client.poll();assert.equal(puts[0].receipts[0].status,'CLOSED');const cash=a.cash;acceptControl(s,c,now+4000,()=>{});assert.equal(a.cash,cash);assert.equal(a.closed,1);
});
test('engine feed freshness blocks a queued close and durable state carries its result through reboot',async()=>{
 let time=now,saved={},events=[];const store={async acquire(){return structuredClone(saved);},async renew(){},async commit(s,e){saved=structuredClone(s);events.push(...e);}};
 const f=new KrakenFeed({now:()=>time});f.metadata={status:'online',checked_at:now};f.state={...feed(100,now),connected:true,reconciled:true,system:'online',clock:{checked_at:now,error_ms:0}};
 const e=await new TradingEngine({store,feed:f,now:()=>time}).initialize();e.repairing=false;const a=e.state.frequency.account;const p=plan();marginOpen(a,p,'100',now);a.positions[id]=a.position;a.position=null;
 e.state.exitManagement={version:EXIT_VERSION,protocol_hash:hash(EXIT_PROTOCOL)};e.state.controls={receipts:[]};acceptControl(e.state,command({mode:'ANY'}),now,x=>e.event(x));await e.flush();
 time=now+10000;e.onMarket();assert.equal(positions(a).length,1);
 e.gapAt=null;e.lastQuality=null;Object.assign(f.state,feed(100,time));e.onMarket();await e.flush();assert.equal(positions(a).length,0);assert.equal(saved.controls.receipts[0].status,'CLOSED');assert.equal(events.filter(x=>x.type==='CLOSED'&&x.id===id).length,1);
 const reboot=await new TradingEngine({store,feed:new KrakenFeed(),now:()=>time}).initialize();assert.equal(reboot.state.controls.receipts[0].status,'CLOSED');assert.equal(reboot.state.frequency.account.closed,1);
});
