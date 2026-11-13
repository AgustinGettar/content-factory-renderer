// Public PF_XBTUSD data only. No orders, account state or private credentials.
// Schemas: https://docs.kraken.com/exchange/api-reference/futures-websocket/{book,trade,ticker}
import {D} from './core.js';
import {SECONDARY_PROTOCOL} from './secondary-futures-math.js';
export const FLOW_VERSION='kraken-public-flow-1.0.0';
const validNumber=x=>x!==null&&x!==undefined&&x!==''&&Number.isFinite(Number(x));
const positive=x=>validNumber(x)&&Number(x)>0;
const nonnegative=x=>validNumber(x)&&Number(x)>=0;
const stamp=x=>Number.isSafeInteger(x)&&x>0;
const sum=xs=>xs.reduce((a,b)=>a.plus(b),D(0));
const sideOf=s=>s==='buy'||s==='Buy'?'buy':s==='sell'||s==='Sell'?'sell':null;
export class KrakenPublicFlow{
 constructor({symbol=SECONDARY_PROTOCOL.symbol,maxLevels=4096,maxTrades=2000,freshMs=5000,windowMs=30000}={}){
  if(symbol!==SECONDARY_PROTOCOL.symbol)throw Error('FLOW_INSTRUMENT_UNSUPPORTED');
  if(!Number.isSafeInteger(maxLevels)||maxLevels<2||maxLevels>8192||!Number.isSafeInteger(maxTrades)||maxTrades<1||maxTrades>5000)throw Error('FLOW_BOUND_INVALID');
  if(!Number.isSafeInteger(freshMs)||freshMs<100||freshMs>10000||!Number.isSafeInteger(windowMs)||windowMs<1000||windowMs>60000)throw Error('FLOW_TIME_BOUND_INVALID');
  Object.assign(this,{symbol,maxLevels,maxTrades,freshMs,windowMs,generation:0});this.disconnect('AWAITING_SNAPSHOT');
 }
 disconnect(reason='DISCONNECTED'){
  this.generation++;this.book={buy:new Map(),sell:new Map()};this.best={buy:null,sell:null};this.seq=null;this.bookAt=null;this.bookReceived=null;this.bookStarted=null;this.reason=reason;this.resync_required=true;
  this.trades=[];this.tradeSeen=new Map();this.tradeSeq=null;this.tradeStart=null;this.tradeGapAt=null;this.tickers=[];this.changes=[];this.changeGapAt=null;this.counts={book_updates:0,duplicate_book:0,duplicate_trade:0,ignored_instrument:0,invalid_messages:0};
 }
 invalidate(reason){this.reason=reason;this.resync_required=true;this.seq=null;this.book={buy:new Map(),sell:new Map()};this.best={buy:null,sell:null};this.changes=[];}
 ingest(message,receivedAt=Date.now()){
  if(!message||message.product_id!==this.symbol){this.counts.ignored_instrument++;return false;}
  try{
   if(!stamp(receivedAt))throw Error('RECEIPT_TIME_INVALID');
   const feed=message.feed;
   if(feed==='book_snapshot')return this.bookSnapshot(message,receivedAt);
   if(feed==='book')return this.bookDelta(message,receivedAt);
   if(feed==='trade_snapshot'){
    if(!Array.isArray(message.trades)||message.trades.length>this.maxTrades)throw Error('TRADE_SNAPSHOT_LIMIT');
    // Snapshot may be reverse chronological; it seeds a new trade sequence.
    this.trades=[];this.tradeSeen.clear();this.tradeSeq=null;this.tradeStart=receivedAt;this.tradeGapAt=null;
    for(const trade of [...message.trades].sort((a,b)=>a.seq-b.seq))this.trade({...trade,product_id:this.symbol},receivedAt,true);
    return true;
   }
   if(feed==='trade')return this.trade(message,receivedAt,false);
   if(feed==='ticker')return this.ticker(message,receivedAt);
   return false;
  }catch(error){this.counts.invalid_messages++;if(message.feed?.startsWith('book'))this.invalidate(error.message);else if(message.feed?.startsWith('trade'))this.tradeGapAt=receivedAt;return false;}
 }
 checkTime(at,receivedAt,{historical=false}={}){
  if(!stamp(at)||at>receivedAt+1000||(!historical&&receivedAt-at>this.freshMs))throw Error('MARKET_CLOCK_OR_STALE');
 }
 bookSnapshot(m,receivedAt){
  this.checkTime(m.timestamp,receivedAt);
  if(this.seq!==null&&m.timestamp<this.bookAt){this.counts.duplicate_book++;return false;}
  if(this.seq===m.seq&&this.bookAt===m.timestamp){this.counts.duplicate_book++;return false;}
  if(!Number.isSafeInteger(m.seq)||m.seq<0||!Array.isArray(m.bids)||!Array.isArray(m.asks)||m.bids.length+m.asks.length>this.maxLevels)throw Error('BOOK_SNAPSHOT_INVALID_OR_LIMIT');
  // A snapshot explicitly starts a fresh producer sequence; a lower seq is allowed here.
  const book={buy:new Map(),sell:new Map()};
  for(const [side,levels]of [['buy',m.bids],['sell',m.asks]])for(const level of levels){
   if(!positive(level.price)||!positive(level.qty))throw Error('BOOK_LEVEL_INVALID');
   const price=D(level.price).toString();if(book[side].has(price))throw Error('BOOK_SNAPSHOT_DUPLICATE_LEVEL');
   book[side].set(price,{price,qty:D(level.qty).toString(),since:receivedAt});
  }
  const best={buy:Math.max(...[...book.buy.keys()].map(Number)),sell:Math.min(...[...book.sell.keys()].map(Number))};
  if(!book.buy.size||!book.sell.size||best.buy>=best.sell)throw Error('BOOK_CROSSED_OR_EMPTY');
  this.generation++;this.book=book;this.best=best;this.seq=m.seq;this.bookAt=m.timestamp;this.bookReceived=receivedAt;this.bookStarted=receivedAt;this.reason=null;this.resync_required=false;this.changes=[];return true;
 }
 bookDelta(m,receivedAt){
  this.checkTime(m.timestamp,receivedAt);
  if(this.seq===null)return false;
  if(!Number.isSafeInteger(m.seq)||!sideOf(m.side)||!positive(m.price)||!nonnegative(m.qty))throw Error('BOOK_DELTA_INVALID');
  if(m.seq<=this.seq){
   if(m.timestamp>this.bookAt)throw Error('BOOK_SEQUENCE_RESET_WITHOUT_SNAPSHOT');
   this.counts.duplicate_book++;return false;
  }
  if(m.seq!==this.seq+1)throw Error('BOOK_SEQUENCE_GAP');
  if(m.timestamp<this.bookAt)throw Error('BOOK_TIME_REGRESSION');
  const side=sideOf(m.side),price=D(m.price).toString(),qty=D(m.qty),prior=this.book[side].get(price),before=D(prior?.qty??0),change=qty.minus(before);
  if(qty.eq(0))this.book[side].delete(price);else this.book[side].set(price,{price,qty:qty.toString(),since:prior&&qty.lte(before)?prior.since:receivedAt});
  if(this.book.buy.size+this.book.sell.size>this.maxLevels)throw Error('BOOK_LEVEL_LIMIT');
  // Re-scan one side only when its best level disappears. Typical size updates
  // are O(1); the observed 3,119-level snapshot must not be sorted on each delta.
  const numeric=Number(price);
  if(qty.eq(0)&&numeric===this.best[side])this.best[side]=side==='buy'?Math.max(...[...this.book.buy.keys()].map(Number)):Math.min(...[...this.book.sell.keys()].map(Number));
  else if(qty.gt(0))this.best[side]=side==='buy'?Math.max(this.best[side],numeric):Math.min(this.best[side],numeric);
  if(!this.book.buy.size||!this.book.sell.size||this.best.buy>=this.best.sell)throw Error('BOOK_CROSSED_OR_EMPTY');
  if(!change.eq(0))this.changes.push({event_at:m.timestamp,received_at:receivedAt,side,price,visible_added_btc:change.gt(0)?change.toString():'0',visible_removed_btc:change.lt(0)?change.negated().toString():'0',cause:change.lt(0)?'UNKNOWN_CANCEL_OR_EXECUTION_OR_AMENDMENT':'VISIBLE_DEPTH_INCREASE_NOT_ORDER_COUNT'});
  this.changes=this.changes.filter(x=>receivedAt-x.received_at<=this.windowMs);
  if(this.changes.length>4000){this.changeGapAt=receivedAt;this.changes=this.changes.slice(-4000);}
  this.seq=m.seq;this.bookAt=m.timestamp;this.bookReceived=receivedAt;this.counts.book_updates++;return true;
 }
 trade(m,receivedAt,historical){
  this.checkTime(m.time,receivedAt,{historical});
  if(typeof m.uid!=='string'||!m.uid||m.uid.length>200||!sideOf(m.side)||!positive(m.price)||!positive(m.qty)||!Number.isSafeInteger(m.seq)||!['fill','liquidation','termination','block'].includes(m.type))throw Error('TRADE_INVALID');
  if(this.tradeSeen.has(m.uid)){this.counts.duplicate_trade++;return false;}
  if(this.tradeSeq!==null&&m.seq<=this.tradeSeq){this.tradeGapAt=receivedAt;return false;}
  if(this.tradeSeq!==null&&m.seq!==this.tradeSeq+1)this.tradeGapAt=receivedAt;
  if(this.tradeStart===null)this.tradeStart=receivedAt;
  this.tradeSeq=m.seq;this.tradeSeen.set(m.uid,m.time);
  while(this.tradeSeen.size>5000)this.tradeSeen.delete(this.tradeSeen.keys().next().value);
  if(receivedAt-m.time<=this.windowMs)this.trades.push({uid:m.uid,event_at:m.time,received_at:receivedAt,side:sideOf(m.side),type:m.type,qty:D(m.qty).toString(),price:D(m.price).toString()});
  this.trades=this.trades.filter(x=>receivedAt-x.event_at<=this.windowMs);
  if(this.trades.length>this.maxTrades){this.tradeGapAt=receivedAt;this.trades=this.trades.slice(-this.maxTrades);}
  return true;
 }
 ticker(m,receivedAt){
  this.checkTime(m.time,receivedAt);
  if(!positive(m.bid)||!positive(m.ask)||Number(m.ask)<Number(m.bid)||m.suspended===true)throw Error('TICKER_INVALID');
  if(this.tickers.at(-1)?.event_at>=m.time)return false;
  this.tickers.push({event_at:m.time,received_at:receivedAt,open_interest:nonnegative(m.openInterest)?D(m.openInterest).toString():null});
  this.tickers=this.tickers.filter(x=>receivedAt-x.received_at<=this.windowMs).slice(-120);return true;
 }
 snapshot(now,{quantity=null,side=null}={}){
  const fresh=stamp(now)&&this.bookReceived!==null&&now>=this.bookReceived&&now-this.bookReceived<=this.freshMs&&now-this.bookAt<=this.freshMs&&this.bookAt<=now;
  const valid=this.seq!==null&&!this.resync_required&&fresh;
  const base={version:FLOW_VERSION,symbol:this.symbol,source:'KRAKEN_FUTURES_PUBLIC',mode:'SHADOW',authority:'NONE',valid,available:valid,event_at:this.bookAt,received_at:this.bookReceived,generated_at:now,generation:this.generation,book_seq:this.seq,resync_required:this.resync_required,reason:this.reason??(!fresh?'STALE_BOOK':null),units:{price:'USD/BTC',quantity:'BTC',value:'USD',time:'epoch_ms'},counts:{...this.counts}};
  if(!valid)return {...base,imbalance:null,aggressive_net_btc:null,aggressive_volume_btc:null,persistence_ms:null,bands:[],execution:null};
  const bids=[...this.book.buy.values()].sort((a,b)=>Number(b.price)-Number(a.price)),asks=[...this.book.sell.values()].sort((a,b)=>Number(a.price)-Number(b.price)),bid=D(bids[0].price),ask=D(asks[0].price),mid=bid.plus(ask).div(2);
  const bands=[5,10,25].map(bps=>{
   const b=bids.filter(x=>D(x.price).gte(mid.mul(D(1).minus(D(bps).div(10000))))),a=asks.filter(x=>D(x.price).lte(mid.mul(D(1).plus(D(bps).div(10000))))),buy=sum(b.map(x=>x.qty)),sell=sum(a.map(x=>x.qty)),total=buy.plus(sell);
   const weighted=levels=>{const qty=sum(levels.map(x=>x.qty));return qty.gt(0)?sum(levels.map(x=>D(x.qty).mul(Math.max(0,now-x.since)))).div(qty).toNumber():0;};
   return {bps,bid_btc:buy.toString(),ask_btc:sell.toString(),imbalance:total.gt(0)?buy.minus(sell).div(total).toNumber():null,persistence_ms:Math.min(weighted(b),weighted(a)),reference_mid:mid.toString()};
  });
  const trades=this.trades.filter(t=>t.received_at<=now&&t.event_at<=now&&now-t.event_at<=this.windowMs),total=sum(trades.map(x=>x.qty)),net=sum(trades.map(x=>D(x.qty).mul(x.side==='buy'?1:-1))),liquidations=sum(trades.filter(x=>x.type==='liquidation').map(x=>x.qty));
  const tradeCoverage=this.tradeStart!==null&&now-this.tradeStart>=this.windowMs&&(this.tradeGapAt===null||now-this.tradeGapAt>this.windowMs);
  const ticker=this.tickers.at(-1),oldTicker=this.tickers[0],tickerFresh=ticker&&now>=ticker.received_at&&ticker.event_at<=now&&now-ticker.event_at<=this.freshMs;
  let execution=null;
  if(positive(quantity)&&sideOf(side)){
   const levels=sideOf(side)==='buy'?asks:bids,qty=D(quantity),best=D(levels[0].price);let left=qty,cost=D(0),used=0;
   for(const level of levels){if(left.eq(0))break;const take=left.lte(level.qty)?left:D(level.qty);left=left.minus(take);cost=cost.plus(take.mul(level.price));used++;}
   const filled=qty.minus(left),vwap=filled.gt(0)?cost.div(filled):null;
   execution={side:sideOf(side),quantity_btc:qty.toString(),filled_btc:filled.toString(),unfilled_btc:left.toString(),complete:left.eq(0),vwap:vwap?.toString()??null,impact_usd:vwap?cost.minus(best.mul(filled)).abs().toString():null,levels_used:used,fee_excluded:true,spread_already_in_executable_price:true,kind:'VISIBLE_BOOK_ESTIMATE_NOT_FILL_GUARANTEE'};
  }
  const changes=this.changes.filter(x=>x.received_at<=now&&now-x.received_at<=this.windowMs);
  return {...base,bid:bid.toString(),ask:ask.toString(),spread_usd_per_btc:ask.minus(bid).toString(),bands,imbalance:bands[1].imbalance,persistence_ms:bands[1].persistence_ms,aggressive_net_btc:tradeCoverage?net.toString():null,aggressive_volume_btc:tradeCoverage?total.toString():null,trade_coverage_complete:tradeCoverage,trade_window_ms:this.windowMs,observed_trade_net_btc:net.toString(),observed_trade_volume_btc:total.toString(),observed_liquidation_btc:liquidations.toString(),visible_added_btc:sum(changes.map(x=>x.visible_added_btc)).toString(),visible_removed_btc:sum(changes.map(x=>x.visible_removed_btc)).toString(),removal_cause:'UNKNOWN_NOT_INFERRED_FROM_L2',depth_window_complete:now-this.bookStarted>=this.windowMs&&(this.changeGapAt===null||now-this.changeGapAt>this.windowMs),persistence_scope:'OBSERVED_AGGREGATED_PRICE_LEVEL_CONTINUITY_NOT_ORDER_IDENTITY',open_interest:tickerFresh?ticker.open_interest:null,open_interest_delta:tickerFresh&&ticker.open_interest!==null&&oldTicker?.open_interest!==null?D(ticker.open_interest).minus(oldTicker.open_interest).toString():null,open_interest_scope:'AGGREGATE_CONTEXT_NOT_POSITION_COUNT',execution};
 }
}

// Public history is delayed metadata, not a source of private stops or owners.
// Unknown union tags/fields stay unclassified; false reduceOnly never means opening.
export function normalizePublicHistory(payload,{kind,receivedAt,symbol=SECONDARY_PROTOCOL.symbol,decisionAt=receivedAt}={}){
 if(!['orders','executions'].includes(kind)||!stamp(receivedAt)||!stamp(decisionAt)||!Array.isArray(payload?.elements)||payload.elements.length>2000)throw Error('HISTORY_ENVELOPE_INVALID');
 const seen=new Set(),events=[],unclassified=[];let duplicates=0;
 for(const row of payload.elements){
  const ex=row?.event?.Execution?.execution,tag=Object.keys(row?.event??{})[0],value=row?.event?.[tag],order=tag==='OrderUpdated'?value?.newOrder:value?.order;
  const id=kind==='executions'?ex?.uid:row?.uid;
  if(typeof id!=='string'||!id){unclassified.push({reason:'MISSING_ID'});continue;}
  if(seen.has(id)){duplicates++;continue;}seen.add(id);
  const at=kind==='executions'?ex?.timestamp:row.timestamp;
  if(!stamp(at)||at>receivedAt+1000){unclassified.push({id,reason:'TIME_INVALID'});continue;}
  const timing={event_at:at,received_at:receivedAt,observed_lag_ms:receivedAt-at,causal_at_decision:receivedAt<=decisionAt&&at<=decisionAt};
  if(kind==='executions'){
   if(!ex||!positive(ex.quantity)||!positive(ex.price)||![ex.makerOrder,ex.takerOrder].every(o=>o?.tradeable?.toUpperCase()===symbol&&sideOf(o.direction))||sideOf(ex.makerOrder.direction)===sideOf(ex.takerOrder.direction)){unclassified.push({id,reason:'EXECUTION_SCHEMA_OR_INSTRUMENT'});continue;}
   const sides=['makerOrder','takerOrder'].map(role=>{const o=ex[role];return {role:role==='makerOrder'?'maker':'taker',side:sideOf(o.direction),reduce_only:typeof o.reduceOnly==='boolean'?o.reduceOnly:null,observed_reduction_btc:o.reduceOnly===true?D(ex.quantity).toString():null,position_effect:o.reduceOnly===true?'REDUCTION_CONFIRMED':'OPEN_OR_REDUCTION_UNDETERMINED'};});
   events.push({id,type:'EXECUTION',...timing,price:D(ex.price).toString(),quantity_btc:D(ex.quantity).toString(),aggressor_side:sideOf(ex.takerOrder.direction),sides,reduce_flag_known_sides:sides.filter(x=>x.reduce_only!==null).length,confirmed_reduction_execution_btc:sides.some(x=>x.reduce_only===true)?D(ex.quantity).toString():'0'});
  }else{
   const type={OrderPlaced:'PLACED',OrderUpdated:'MODIFIED',OrderCancelled:'CANCELLED'}[tag];
   if(!type||order?.tradeable?.toUpperCase()!==symbol||!sideOf(order.direction)||!nonnegative(order.quantity)){unclassified.push({id,reason:'ORDER_UNION_OR_SCHEMA',tag:tag??null});continue;}
   events.push({id,order_id:order.uid??null,type,...timing,side:sideOf(order.direction),quantity_btc:D(order.quantity).toString(),price:positive(order.limitPrice)?D(order.limitPrice).toString():null,reduce_only:typeof order.reduceOnly==='boolean'?order.reduceOnly:null,position_effect:'PENDING_MAY_CANCEL_NOT_EXECUTED_REDUCTION'});
  }
 }
 const executions=events.filter(x=>x.type==='EXECUTION'),lags=events.map(x=>x.observed_lag_ms).sort((a,b)=>a-b);
 return {version:FLOW_VERSION,kind,symbol,received_at:receivedAt,scope:payload.continuationToken?'BOUNDED_PAGE_MORE_AVAILABLE':'RETURNED_PAGE_ONLY',events,unclassified,duplicates,coverage:{returned:payload.elements.length,classified:events.length,reduce_flag_known_sides:executions.reduce((a,x)=>a+x.reduce_flag_known_sides,0),total_execution_sides:executions.length*2,reduce_flag_fraction:executions.length?executions.reduce((a,x)=>a+x.reduce_flag_known_sides,0)/(executions.length*2):null},total_executed_btc:sum(executions.map(x=>x.quantity_btc)).toString(),confirmed_reduction_execution_btc:sum(executions.map(x=>x.confirmed_reduction_execution_btc)).toString(),lag_ms:{minimum:lags[0]??null,median:lags.length?lags[Math.floor(lags.length/2)]:null,maximum:lags.at(-1)??null},lag_scope:'RECEIPT_MINUS_EVENT_TIME_NOT_MINIMUM_PUBLICATION_LATENCY'};
}

// Offline reconciliation by the matched-execution uid, never by inferred owners
// or by summing maker+taker quantities. Delayed history is retrospective only.
export function reconcilePublicTrades(trades,history){
 if(!Array.isArray(trades)||trades.length>20000||!Array.isArray(history)||history.length>2000)throw Error('PUBLIC_RECONCILIATION_BOUND');
 const observed=new Map(),historical=new Map(history.filter(e=>e.type==='EXECUTION').map(e=>[e.id,e]));let duplicates=0;
 for(const t of trades){if(!t?.uid||t.product_id!=='PF_XBTUSD')continue;if(observed.has(t.uid)){duplicates++;continue;}observed.set(t.uid,t);}
 const matches=[],conflicts=[],missing=[];
 for(const [uid,t] of observed){const h=historical.get(uid);if(!h){missing.push(uid);continue;}
  if(!positive(t.qty)||!positive(t.price)||!D(t.qty).eq(h.quantity_btc)||!D(t.price).eq(h.price)||sideOf(t.side)!==h.aggressor_side){conflicts.push(uid);continue;}
  matches.push({uid,event_at:t.time,history_received_at:h.received_at,observed_lag_ms:h.received_at-t.time,quantity_btc:h.quantity_btc,
   confirmed_reduction_execution_btc:h.confirmed_reduction_execution_btc,sides:h.sides,evaluation_only:true});
 }
 return {unique_ws_executions:observed.size,duplicates,matched:matches.length,unmatched:missing.length,conflicts,
  matched_total_btc:sum(matches.map(e=>e.quantity_btc)).toString(),matched_confirmed_reduction_btc:sum(matches.map(e=>e.confirmed_reduction_execution_btc)).toString(),
  matches,unmatched_reason:'BOUNDED_HISTORY_COVERAGE_NOT_PROOF_OF_MISSING_EXCHANGE_EXECUTION',private_position_count:null};
}
