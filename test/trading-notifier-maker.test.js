// Real selection/sizing with synthetic market data and a fake transport only.
// No exchange connection, Telegram request, or live order is made by these tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import {D,POLICY,hash} from '../lib/trading/core.js';
import {newAccount,select,step} from '../lib/trading/simulator.js';
import {enablePortfolio,findOrder,orders,positions} from '../lib/trading/portfolio.js';
import {MARGIN_VERSION} from '../lib/trading/margin.js';
import {SECONDARY_RISK_VERSION,SECONDARY_RISK_PROTOCOL} from '../lib/trading/secondary-risk.js';
import {ENTRY_VERSION,ENTRY_PROTOCOL} from '../lib/trading/entry-profile.js';
import {CONTEXT_VERSION,CONTEXT_PROTOCOL,MAKER_ORDER} from '../lib/trading/context-profile.js';
import {MAKER_SIZING_VERSION,MAKER_SIZING_PROTOCOL} from '../lib/trading/maker-sizing.js';
import {BOOST_VERSION,BOOST_PROTOCOL} from '../lib/trading/secondary-boost.js';
import {CAPACITY_VERSION,CAPACITY_PROTOCOL} from '../lib/trading/secondary-capacity.js';
import {TradingNotifier} from '../lib/trading/notifier.js';

function fixture({maker=true,passive=true,onClaim=()=>{}}={}){
 const now=Date.now(),a=newAccount({...POLICY,initialCash:'500'});enablePortfolio(a);
 for(const [key,version,protocol] of [
  ['riskProfile',SECONDARY_RISK_VERSION,SECONDARY_RISK_PROTOCOL],
  ['entryProfile',ENTRY_VERSION,ENTRY_PROTOCOL],
  ['contextProfile',CONTEXT_VERSION,CONTEXT_PROTOCOL],
  ['leverageProfile',BOOST_VERSION,BOOST_PROTOCOL],
  ['capacityProfile',CAPACITY_VERSION,CAPACITY_PROTOCOL],
  ...(passive?[['makerSizingProfile',MAKER_SIZING_VERSION,MAKER_SIZING_PROTOCOL]]:[]),
 ])a[key]={version,protocol_hash:hash(protocol),activated_at:now};
 const q={bid:'100',ask:'100.01',bid_qty:'100',ask_qty:'100',event_at:now,received_at:now};
 const metadata={tick_size:'.01',lot_decimals:8,ordermin:'.00001',costmin:'.1',leverage_buy:[2,3,4,5,6,7,8,9,10],leverage_sell:[2,3,4,5,6,7,8,9,10],status:'online',checked_at:now};
 const raw={id:'selected-fixture',version:'notifier-maker-fixture',recipe:'fixture',family:'L',direction:'LONG',timeframe:1,
  confirmed_at:now,decision_at:now,execution_model:MARGIN_VERSION,order:maker?MAKER_ORDER:'SIMULATED_STOP_LIMIT',
  entry:maker?'100':'101',limit:maker?'100':'101.1',stop:'98',target:'115',holding_ms:3600000,expires_at:now+120000,setup:{family:'L'}};
 const selected=select(a,raw,q,metadata,now);assert.equal(selected.type,'SELECTED',JSON.stringify(selected));
 const plan=structuredClone(selected.plan),notice={id:'notice-fixture',kind:'SIGNAL',status:'QUEUED',payload:{account:'FREQUENT_PAPER',plan}};
 const feed={metadata,state:{connected:true,reconciled:true,system:'online',clock:{error_ms:0,checked_at:now},quote:{...q,bid_qty:'.00001',ask_qty:'.00001'},trade:{price:'100',event_at:now,received_at:now}},snapshot(){return structuredClone(this.state);}};
 assert(D(plan.sizing.qty).gt(D(feed.state.quote.bid_qty).mul('.1')));
 const calls=[],transactions=[],store={
  async queued(){return notice.status==='QUEUED'?[notice]:[];},
  async tx(p){transactions.push(p);if(p.phase==='CLAIM'){Object.assign(notice,{status:'DISPATCHING',claim_id:p.claim_id});onClaim(feed,plan);return {...notice};}Object.assign(notice,p);return {...notice};},
 };
 const transport={async call(method,body){
  calls.push({method,body});
  if(method==='getMe')return {is_bot:true,id:9,username:'AppMultimedia_VideosBot'};
  if(method==='getChat')return {id:123,type:'private'};
  if(method==='sendMessage')return {message_id:149,chat:{id:123},date:Math.floor(Date.now()/1000)};
  throw Error('UNEXPECTED_FAKE_TRANSPORT_METHOD');
 }};
 const args={store,feed,transport,pending:id=>Boolean(findOrder(a,id)),env:{LUMI_TRADING_STORAGE:'SQLITE',LUMI_TRADING_OWNER_ID:'123',LUMI_TELEGRAM_REVIEW_TEST_USERS:'123',LUMI_TELEGRAM_TRANSPORT_AUTHORITY:'DIRECT',LUMI_TELEGRAM_BOT_ID:'9'}};
 const sends=()=>calls.filter(x=>x.method==='sendMessage');
 return {now,a,plan,notice,feed,calls,transactions,args,sends};
}

test('a valid passive maker pending order can be announced with insufficient immediate BBO liquidity',async()=>{
 const h=fixture(),before=structuredClone(h.a),notifier=new TradingNotifier(h.args);
 assert.equal(h.plan.sizing.sizing_model,MAKER_SIZING_PROTOCOL.model);
 await notifier.drain();assert.equal(h.notice.status,'DELIVERED');assert.equal(h.sends().length,1);
 assert.match(h.sends()[0].body.text,/programé una compra simulada/);
 assert.match(h.sends()[0].body.text,/Orden maker: espera una operación posterior/);
 assert.doesNotMatch(h.sends()[0].body.text,/abrí una/);
 assert.deepEqual(h.a,before);assert.equal(orders(h.a).length,1);assert.equal(positions(h.a).length,0);
 await notifier.drain();assert.equal(h.sends().length,1);
});

test('taker and earlier BBO-sized maker notices retain the immediate liquidity veto',async()=>{
 for(const opts of [{maker:false},{passive:false}]){
  const h=fixture(opts);await new TradingNotifier(h.args).drain();
  assert.equal(h.notice.status,'EXPIRED');assert.equal(h.notice.reason,'PRE_SEND_COST_OR_LIQUIDITY_CHANGED');assert.equal(h.sends().length,0);
 }
});

test('a maker label or incomplete, changed execution contract does not obtain the passive exception',async()=>{
 const changed=fixture();changed.plan.hash='changed';
 await new TradingNotifier(changed.args).drain();assert.equal(changed.notice.status,'EXPIRED');assert.equal(changed.sends().length,0);
 const changes=[
  p=>{delete p.policy.makerSizingModel;},
  p=>{delete p.sizing.sizing_model;},
  p=>{p.sizing.fill_model='UNKNOWN';},
  p=>{p.sizing.entry_fee_rate='0';},
  p=>{p.policy.makerFee='0';},
  p=>{p.execution_model='UNKNOWN';},
 ];
 for(const change of changes){
  const h=fixture();change(h.plan);h.plan.hash=hash({...h.plan,hash:undefined});await new TradingNotifier(h.args).drain();
  assert.equal(h.notice.status,'EXPIRED');assert.equal(h.notice.reason,'PRE_SEND_COST_OR_LIQUIDITY_CHANGED');assert.equal(h.sends().length,0);
 }
 const labelled=fixture({maker:false});labelled.plan.order=MAKER_ORDER;labelled.plan.hash=hash({...labelled.plan,hash:undefined});
 await new TradingNotifier(labelled.args).drain();assert.equal(labelled.sends().length,0);assert.equal(labelled.notice.status,'EXPIRED');
});

test('passive maker notices still reject wider spread and a passed barrier',async()=>{
 for(const [mutate,reason] of [
  [h=>{h.feed.state.quote.ask='100.02';},'PRE_SEND_COST_OR_LIQUIDITY_CHANGED'],
  [h=>{h.feed.state.trade.price='97';},'BARRIER_BEFORE_ENTRY'],
 ]){
  const h=fixture();mutate(h);await new TradingNotifier(h.args).drain();
  assert.equal(h.notice.status,'EXPIRED');assert.equal(h.notice.reason,reason);assert.equal(h.sends().length,0);
 }
});

test('a no-longer-pending, expired or old maker plan is never announced',async()=>{
 for(const [mutate,reason] of [
  [h=>{delete h.a.pendingOrders[h.plan.id];},'PLAN_NO_LONGER_PENDING'],
  [h=>{h.plan.expires_at=h.now-1;},'VENCIDA'],
  [h=>{h.plan.decision_at=h.now-31000;},'NOTICE_EXPIRED'],
 ]){
  const h=fixture();mutate(h);await new TradingNotifier(h.args).drain();
  assert.equal(h.notice.status,'EXPIRED');assert.equal(h.notice.reason,reason);assert.equal(h.sends().length,0);
 }
});

test('stale market data both before and after the claim prevents a maker notice',async()=>{
 const stale=fixture();stale.feed.state.quote.event_at-=6000;
 await new TradingNotifier(stale.args).drain();assert.equal(stale.sends().length,0);assert.equal(stale.notice.status,'QUEUED');assert.equal(stale.transactions.length,0);
 const changed=fixture({onClaim:feed=>{feed.state.quote.event_at-=6000;}});
 await new TradingNotifier(changed.args).drain();assert.equal(changed.sends().length,0);assert.equal(changed.notice.status,'EXPIRED');assert.equal(changed.notice.reason,'STALE_QUOTE');
});

test('passive signals still require the verified private owner',async()=>{
 const h=fixture();h.args.env.LUMI_TRADING_OWNER_ID='456';
 await assert.rejects(new TradingNotifier(h.args).drain(),/TRADING_PRIVATE_OWNER_NOT_UNIQUE/);
 assert.equal(h.sends().length,0);assert.equal(h.notice.status,'QUEUED');
});

test('announcing a pending maker does not relax any actual fill liquidity condition',async()=>{
 const h=fixture();await new TradingNotifier(h.args).drain();assert.equal(h.notice.status,'DELIVERED');
 const market=(at,{thin=false,qty='100',price='99.9'}={})=>({
  quote:{...h.feed.state.quote,bid_qty:thin?'.00001':'100',ask_qty:thin?'.00001':'100',event_at:at,received_at:at},
  trade:{id:String(at),source:'KRAKEN_WS_V2_TRADE',message_type:'update',side:'sell',price,qty,event_at:at,received_at:at},
 });
 const first=h.now+2000;assert(step(h.a,market(first,{thin:true}),first).some(e=>e.type==='MAKER_POSTED'));
 for(const [offset,opts] of [[3000,{thin:true}],[4000,{qty:D(h.plan.sizing.qty).mul(9).toString()}],[5000,{price:h.plan.limit}]]){
  const at=h.now+offset;assert(!step(h.a,market(at,opts),at).some(e=>e.type==='FILLED'));assert.equal(positions(h.a).length,0);assert.equal(orders(h.a).length,1);
 }
 const at=h.now+6000,out=step(h.a,market(at,{qty:D(h.plan.sizing.qty).mul(10).toString()}),at);
 assert(out.some(e=>e.type==='FILLED'));assert.equal(positions(h.a).length,1);assert.equal(orders(h.a).length,0);
});
