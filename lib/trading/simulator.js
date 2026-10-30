import {D,M15,POLICY,riskPlan,hash} from './core.js';
import {positions,orders,syncPortfolio,portfolioPolicy,PORTFOLIO_PROTOCOL} from './portfolio.js';
export function newAccount(policy=POLICY){return {cash:policy.initialCash,equity:policy.initialCash,peak:policy.initialCash,dayStart:policy.initialCash,day:null,halted:false,pending:null,position:null,closed:0,observedClosed:0,ambiguousClosed:0,net:'0',fees:'0',wins:0,losses:0,maxDrawdown:'0',lossStreak:0,maxLossStreak:0};}
export function mark(a,quote,now,policy=POLICY){
  a.equity=positions(a).reduce((total,p)=>total.plus(D(p.qty).mul(quote.bid).mul(D(1).minus(p.plan.sizing.fee))),D(a.cash)).toString();
  if(D(a.equity).gt(a.peak))a.peak=a.equity;
  const dd=D(a.peak).minus(a.equity).div(a.peak);if(dd.gt(a.maxDrawdown))a.maxDrawdown=dd.toString();
  if(dd.gte(policy.drawdown))a.halted=true;
  const day=new Date(now).toISOString().slice(0,10);if(a.day!==day){a.day=day;a.dayStart=a.equity;}
  syncPortfolio(a);
}
export function select(a,plan,quote,meta,now,{latency=POLICY.engineLatency,policy=POLICY}={}){
  if(a.portfolio){
    mark(a,quote,now,policy);
    const existing=[...positions(a),...orders(a)],key=hash([plan.family,plan.recipe??plan.setup_id??'',plan.confirmed_at,plan.direction]);
    if(existing.some(p=>p.plan.id===plan.id)||a.portfolio.seen.includes(key))return {type:'SUPPRESSED',id:plan.id,reason:'DUPLICATE_OPPORTUNITY'};
    if(existing.length>=PORTFOLIO_PROTOCOL.maxSlots)return {type:'SUPPRESSED',id:plan.id,reason:'PORTFOLIO_SLOTS_FULL'};
    policy=portfolioPolicy(plan,quote,policy);const sizing=riskPlan(plan,a,quote,meta,policy);
    if(sizing.reason)return {type:'SUPPRESSED',id:plan.id,reason:sizing.reason};
    const frozen={...structuredClone(plan),sizing,policy:structuredClone(policy)};frozen.hash=hash({...frozen,hash:undefined});
    a.pendingOrders[plan.id]={plan:frozen,placed_at:now+latency,triggered:false};a.portfolio.seen.push(key);a.portfolio.seen=a.portfolio.seen.slice(-1000);syncPortfolio(a);
    return {type:'SELECTED',id:plan.id,plan:frozen,placed_at:a.pendingOrders[plan.id].placed_at,portfolio:{slots:existing.length+1,risk:a.openRiskReserved,reserved:a.reservedCash}};
  }
  if(a.pending||a.position)return {type:'SUPPRESSED',id:plan.id,reason:'PORTFOLIO_RESERVED'};
  mark(a,quote,now,policy);const sizing=riskPlan(plan,a,quote,meta,policy);if(sizing.reason)return {type:'SUPPRESSED',id:plan.id,reason:sizing.reason};
  const frozen={...structuredClone(plan),sizing,policy:structuredClone(policy)};frozen.hash=hash({...frozen,hash:undefined});
  a.pending={plan:frozen,placed_at:now+latency,triggered:false};
  return {type:'SELECTED',id:plan.id,plan:frozen,placed_at:a.pending.placed_at};
}
export function invalidate(plan,feed,now,context){
  if(now>=plan.expires_at)return 'VENCIDA';
  const price=Number(feed.trade?.price),q=feed.quote;if(!(price>0)||!q)return 'DATA_UNAVAILABLE';
  if(price<=Number(plan.stop)||price>=Number(plan.target))return 'BARRIER_BEFORE_ENTRY';
  if(Number(q.ask)>Number(plan.limit)||price>=Number(plan.entry))return 'ENTRADA_PERDIDA';
  const setup=plan.setup;
  if(setup.family==='C'&&(price<setup.lower-.75*setup.atr||price>setup.upper+.75*setup.atr))return 'RANGE_EXCURSION';
  if(setup.family==='B'&&context?.last15?.at>plan.confirmed_at&&context.last15.close<setup.bound-.25*setup.atr)return 'RETEST_INVALIDATED';
  if(context&&!['F','L'].includes(plan.family)){const s=plan.setup;const ok=s.family==='C'?context.range:s.family==='A'?context.long:context.breakLong;if(!ok)return 'CONTEXT_INVALIDATED';}
  return null;
}
export function cancel(a,reason,at,planId){
 if(a.portfolio){const pending=planId?a.pendingOrders[planId]:orders(a)[0];if(!pending)return null;const id=pending.plan.id;delete a.pendingOrders[id];syncPortfolio(a);return {type:'NOT_FILLED',id,reason,at,policy_version:pending.plan.version};}
 if(!a.pending)return null;const id=a.pending.plan.id;a.pending=null;return {type:'NOT_FILLED',id,reason,at};
}
export const cancelAll=(a,reason,at)=>orders(a).map(p=>cancel(a,reason,at,p.plan.id)).filter(Boolean);
const totals=['cash','fees','net','closed','observedClosed','ambiguousClosed','wins','losses','lossStreak','maxLossStreak'];
function processSlot(a,slot,feed,now,method){
 const id=slot.plan.id,isPosition=Boolean(slot.qty),v={...a,portfolio:undefined,positions:undefined,pendingOrders:undefined,reservedCash:undefined,openRiskReserved:undefined,position:isPosition?slot:null,pending:isPosition?null:slot};
 const events=method(v);for(const k of totals)a[k]=v[k];
 delete a.positions[id];delete a.pendingOrders[id];if(v.position)a.positions[id]=v.position;if(v.pending)a.pendingOrders[id]=v.pending;syncPortfolio(a);
 return events.map(e=>({...e,policy_version:slot.plan.version,...(e.type==='FILLED'?{plan:slot.plan}:{} )}));
}
function portfolioStep(a,feed,now,policy){
 const events=[];if(!feed.quote||!feed.trade)return events;mark(a,feed.quote,now,policy);
 for(const p of positions(a))events.push(...processSlot(a,p,feed,now,v=>step(v,feed,now,policy)));
 mark(a,feed.quote,now,policy);
 const consumed=D(a.dayStart).minus(a.equity);if(a.halted||D(a.openRiskReserved).plus(consumed.gt(0)?consumed:0).gt(D(a.dayStart).mul(policy.dailyLoss)))events.push(...cancelAll(a,a.halted?'DRAWDOWN_HALT':'DAILY_RISK_LIMIT',now));
 const quoteKey=hash([feed.quote.event_at,feed.quote.received_at,feed.quote.ask,feed.quote.bid,feed.quote.ask_qty,feed.quote.bid_qty]);
 let filled=D(a.portfolio.liquidity?.key===quoteKey?a.portfolio.liquidity.used:'0');for(const p of orders(a)){
  // All entries share the same displayed liquidity, as well as cash and risk.
  const q=feed.quote,leftAsk=D(q.ask_qty).minus(filled.mul(10)),leftBid=D(q.bid_qty).minus(filled.mul(10));
  if(leftAsk.lte(0)||leftBid.lte(0))break;
  const f={...feed,quote:{...q,ask_qty:leftAsk.toString(),bid_qty:leftBid.toString()}},out=processSlot(a,p,f,now,v=>step(v,f,now,policy));events.push(...out);
  for(const e of out)if(e.type==='FILLED')filled=filled.plus(e.qty);
 }
 a.portfolio.liquidity={key:quoteKey,used:filled.toString()};mark(a,feed.quote,now,policy);return events;
}
export function step(a,feed,now,policy=POLICY){
  if(a.portfolio)return portfolioStep(a,feed,now,policy);
  const events=[],q=feed.quote,t=feed.trade;if(!q||!t)return events;
  mark(a,q,now,policy);
  if(a.position){
    const p=a.position,plan=p.plan;
    // Only observations after entry can trigger an exit. A repeated quote may
    // execute an already triggered market exit, never invent a new trade.
    let reason=p.exit_reason;
    if(t.event_at>=p.entered_at){if(D(t.price).lte(plan.stop))reason='STOP';else if(D(t.price).gte(plan.target)&&!reason)reason='TARGET';}
    if(!reason&&now>=p.expires_at)reason='TIMEOUT';
    if(reason){p.exit_reason=reason;if(q.event_at<p.entered_at)return events;
      const price=D(q.bid).mul(D(1).minus(plan.sizing.slippage)),gross=D(p.qty).mul(price),fee=gross.mul(plan.sizing.fee),pnl=gross.minus(fee).minus(p.total_entry);
      a.cash=D(a.cash).plus(gross).minus(fee).toString();a.position=null;a.closed++;if(!p.quality||p.quality==='OBSERVED')a.observedClosed=(a.observedClosed||0)+1;else a.ambiguousClosed=(a.ambiguousClosed||0)+1;a.net=D(a.net).plus(pnl).toString();a.fees=D(a.fees).plus(fee).toString();
      if(pnl.gt(0)){a.wins++;a.lossStreak=0;}else {a.losses++;a.lossStreak++;a.maxLossStreak=Math.max(a.lossStreak,a.maxLossStreak);}
      events.push({type:'CLOSED',id:plan.id,family:plan.family,timeframe:plan.timeframe??plan.evidence?.default_tf,at:now,plan_hash:plan.hash,reason,price:price.toString(),qty:p.qty,entry:p.entry,entered_at:p.entered_at,exit_quote:q,trigger_trade:t,pnl:pnl.toString(),R:pnl.div(plan.sizing.risk).toString(),fees:D(p.entry_fee).plus(fee).toString(),outcome:reason==='TARGET'?'TARGET':reason==='STOP'?'STOP':'TIMEOUT',policy_version:plan.version,quality:p.quality||'OBSERVED'});
      mark(a,q,now,policy);
    }
    return events;
  }
  const pending=a.pending;if(!pending)return events;const p=pending.plan;
  if(now>=p.expires_at||D(t.price).lte(p.stop)||D(t.price).gte(p.target)){events.push(cancel(a,now>=p.expires_at?'VENCIDA':'BARRIER_BEFORE_ENTRY',now));return events;}
  if(now<pending.placed_at){if(D(t.price).gte(p.entry))events.push(cancel(a,'ENTRADA_PERDIDA',now));return events;}
  // Late activation is not a retroactive fill. Require a post-placement trade.
  if(t.event_at<pending.placed_at)return events;
  if(!pending.triggered&&D(t.price).gte(p.entry)){pending.triggered=true;pending.trigger_at=t.event_at;events.push({type:'TRIGGERED',id:p.id,at:now,trade:t});}
  if(!pending.triggered)return events;
  const price=D(q.ask).mul(D(1).plus(p.sizing.slippage));
  if(price.gt(p.limit)){events.push(cancel(a,'ENTRY_GAP_BEYOND_LIMIT',now));return events;}
  if(q.event_at<pending.trigger_at)return events;
  // Conservative all-or-none paper fill: require <=10% displayed BOTH-side
  // capacity. This is a simulation assumption, not an exchange order type.
  if(D(p.sizing.qty).gt(D(q.ask_qty).mul('.1'))||D(p.sizing.qty).gt(D(q.bid_qty).mul('.1')))return events;
  const total=D(p.sizing.qty).mul(price),fee=total.mul(p.sizing.fee),cost=total.plus(fee);
  if(cost.gt(a.cash)){events.push(cancel(a,'CASH_UNAVAILABLE',now));return events;}
  a.cash=D(a.cash).minus(cost).toString();a.fees=D(a.fees).plus(fee).toString();a.pending=null;
  a.position={plan:p,qty:p.sizing.qty,entry:price.toString(),entry_fee:fee.toString(),total_entry:cost.toString(),entered_at:now,expires_at:['F','L'].includes(p.family)?now+p.holding_ms:(Math.floor(now/M15)+p.H)*M15};
  events.push({type:'FILLED',id:p.id,at:now,price:price.toString(),qty:p.sizing.qty,fee:fee.toString(),quote:q,trade:t,plan_hash:p.hash});mark(a,q,now,policy);return events;
}
export function repairPosition(a,bars,feed,now,gapStart){
  if(a.portfolio){const events=[];for(const p of [...positions(a),...orders(a)])events.push(...processSlot(a,p,feed,now,v=>repairPosition(v,bars,feed,now,gapStart)));if(feed.quote)mark(a,feed.quote,now);return events;}
  const recoveryEvents=[];
  if(a.pending){
    const pending=a.pending,plan=pending.plan,from=Math.max(gapStart,pending.placed_at),r=bars.filter(b=>b.end>from&&b.start<now);
    const complete=r.length&&r[0].start<=from&&r.at(-1).end>=now-60000&&r.every((b,i)=>!i||b.start===r[i-1].end);
    if(now<pending.placed_at||complete&&!r.some(b=>D(b.high).gte(plan.entry)))return [cancel(a,'RESTART_NO_TRIGGER_CONFIRMED',now)];
    // A crash can occur after an in-memory fill and before its checkpoint. Do
    // not silently classify the persisted pending order as unfilled. Preserve
    // the adverse feasible fill at the original limit and label uncertainty.
    const cost=D(plan.sizing.qty).mul(plan.limit),fee=cost.mul(plan.sizing.fee);
    a.cash=D(a.cash).minus(cost).minus(fee).toString();a.fees=D(a.fees).plus(fee).toString();a.pending=null;
    a.position={plan,qty:plan.sizing.qty,entry:plan.limit,entry_fee:fee.toString(),total_entry:cost.plus(fee).toString(),entered_at:Math.min(now,from),expires_at:['F','L'].includes(plan.family)?Math.min(now,from)+plan.holding_ms:(Math.floor(Math.min(now,from)/M15)+plan.H)*M15,entry_uncertain:true};
    recoveryEvents.push({type:'AMBIGUOUS_RECOVERED_FILL',id:plan.id,at:now,possible_from:from,possible_to:now,price:plan.limit,qty:plan.sizing.qty,complete:Boolean(complete),model:'ADVERSE_FEASIBLE_PATH_NOT_VERIFIED_EXECUTION'});
  }
  if(!a.position)return recoveryEvents;
  const p=a.position,relevant=bars.filter(b=>b.end>Math.max(gapStart,p.entered_at)&&b.start<now);
  const complete=relevant.length&&relevant[0].start<=gapStart&&relevant.at(-1).end>=now-60000;
  const sl=relevant.some(b=>D(b.low).lte(p.plan.stop)),tp=relevant.some(b=>D(b.high).gte(p.plan.target));
  p.quality=complete?(p.entry_uncertain?'GAP_ENTRY_CONSERVATIVE':'GAP_CONSERVATIVE'):'UNRESOLVED_GAP';
  // Both barriers in an unknown path resolve stop first, never omit the case.
  if(sl||!complete){p.exit_reason='STOP';if(feed.quote)feed={...feed,quote:{...feed.quote,bid:D(feed.quote.bid).lt(p.plan.stop)?feed.quote.bid:p.plan.stop}};}
  else if(tp){p.exit_reason='TARGET';if(feed.quote)feed={...feed,quote:{...feed.quote,bid:D(feed.quote.bid).lt(p.plan.target)?feed.quote.bid:p.plan.target}};}
  else if(now>=p.expires_at)p.exit_reason='TIMEOUT';
  const events=[...recoveryEvents,{type:'GAP_POSITION_RECONCILED',id:p.plan.id,at:now,stop_seen:sl,target_seen:tp,complete:Boolean(complete),bars,quality:p.quality}];
  if(p.exit_reason)events.push(...step(a,feed,now));return events;
}
