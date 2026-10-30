import {MAKER_ORDER,CONTEXT_PROTOCOL} from './context-profile.js';
// PAPER approximation on Kraken spot BBO. No exchange orders or borrowed funds.
// Segregated collateral and an early 80% close are conservative model assumptions,
// not Kraken's cross-account liquidation engine or an executable liquidation quote.
import Decimal from 'decimal.js';
import {D,POLICY,hash} from './core.js';
export const MARGIN_VERSION='lumi-margin-paper-1.0.0';
export const MARGIN_PROTOCOL=Object.freeze({version:MARGIN_VERSION,leverage:[1,2,3],maxGrossExposure:'1.5',maxMarginFraction:'0.5',maintenance:'0.8',liquidationFee:'0.02',longFunding:'0.0005',shortFunding:'0.0002',fundingInterval:14400000,fee:POLICY.fee,verifiedAt:'2026-10-30',model:'SEGREGATED_COLLATERAL_CONSERVATIVE',realTrading:false});
export const isMarginPlan=p=>p?.execution_model===MARGIN_VERSION;
export const isMarginPosition=p=>isMarginPlan(p?.plan)&&p?.initial_margin!==undefined;
const min=(...v)=>Decimal.min(...v),max=(...v)=>Decimal.max(...v);
const all=a=>a.portfolio?[...Object.values(a.positions??{}),...Object.values(a.pendingOrders??{})]:[a.position,a.pending].filter(Boolean);
export function initializeMargin(s,now){
 if(s.margin){if(s.margin.protocol_hash!==hash(MARGIN_PROTOCOL))throw Error('MARGIN_PROTOCOL_MISMATCH');return null;}
 s.margin={version:MARGIN_VERSION,protocol_hash:hash(MARGIN_PROTOCOL),protocol:structuredClone(MARGIN_PROTOCOL),requested_at:now,status:'WAITING_FLAT'};s.schema=4;
 return {type:'MARGIN_REQUESTED',at:now,realTrading:false};
}
export function marginEconomics(p,q,policy=POLICY,financed=true){
 const short=p.direction==='SHORT',sign=short?-1:1,e=D(p.limit),fee=D(policy.fee),slip=D(policy.slippage),spread=D(q.ask).minus(q.bid);
 const execution=x=>short?D(x).plus(spread).mul(D(1).plus(slip)):D(x).minus(spread).mul(D(1).minus(slip));
 const stop=execution(p.stop),target=execution(p.target),rate=D(financed?(short?MARGIN_PROTOCOL.shortFunding:MARGIN_PROTOCOL.longFunding):0),periods=Math.ceil(p.holding_ms/MARGIN_PROTOCOL.fundingInterval);
 const funding=price=>rate.mul(short?max(e,price):e).mul(periods),opening=e.mul(rate);
 const entryFee=D(p.order===MAKER_ORDER?(policy.makerFee??policy.fee):policy.fee);
 const fees=price=>e.mul(entryFee).plus(D(price).mul(fee)).plus(opening).plus(funding(price));
 const loss=e.minus(stop).mul(sign).plus(fees(stop)),gain=target.minus(e).mul(sign).minus(fees(target));
 return {e,stop,target,loss,gain,fee,entryFee,slip,spread,rate,periods,opening,funding,fees,rr:loss.gt(0)?gain.div(loss):D(0)};
}
export function marginRiskPlan(p,a,q,meta,policy=POLICY){
 if(!['LONG','SHORT'].includes(p.direction)||!isMarginPlan(p))return {reason:'MARGIN_MODEL_INVALID'};
 if(p.order===MAKER_ORDER&&policy.makerFee!==CONTEXT_PROTOCOL.makerFee)return {reason:'MAKER_PROFILE_REQUIRED'};
 const short=p.direction==='SHORT',e=D(p.limit),reservePrice=short?max(p.entry,p.limit):e,stop=D(p.stop),target=D(p.target);
 if(!(short?target.lt(e)&&e.lt(stop):stop.lt(e)&&e.lt(target))||min(e,stop,target).lte(0))return {reason:'MARGIN_BARRIERS_INVALID'};
 const equity=D(a.equity),consumed=max(0,D(a.dayStart).minus(equity)),committed=D(a.openRiskReserved??0);
 if(a.halted||equity.lte(D(a.peak).mul(D(1).minus(policy.drawdown))))return {reason:'DRAWDOWN_HALT'};
 const budget=max(0,min(equity.mul(policy.risk),policy.riskCapUSD??'1',equity.mul(policy.openRisk).minus(committed),D(a.dayStart).mul(policy.dailyLoss).minus(consumed).minus(committed)));
 if(budget.lte(0))return {reason:'PORTFOLIO_RISK_COMMITTED'};
 const current=all(a),gross=current.reduce((v,x)=>v.plus(x.plan.sizing.exposure),D(0)),margin=current.reduce((v,x)=>v.plus(x.initial_margin??x.plan.sizing.initial_margin??0),D(0));
 const free=max(0,D(a.cash).minus(a.reservedCash??0).minus(equity.mul(policy.cashReserve))),step=D(10).pow(-meta.lot_decimals),levers=short?meta.leverage_sell:meta.leverage_buy;
 let reason='MARGIN_CAPITAL_UNAVAILABLE';
 for(const leverage of policy.marginLeverage??MARGIN_PROTOCOL.leverage){
  if(short&&leverage===1)continue;
  if(leverage>1&&(!Array.isArray(levers)||!levers.includes(leverage))){reason='MARGIN_METADATA_UNAVAILABLE';continue;}
  const financed=leverage>1||short,c=marginEconomics(p,q,policy,financed);
  if(c.loss.lte(0)||c.gain.lte(0)||c.rr.lt(policy.minNetRR??'1.5')){reason='NET_RR_TOO_LOW';continue;}
  const desired=min(p.sizing?.qty??Number.MAX_VALUE,budget.div(c.loss),max(0,equity.mul(policy.marginMaxGrossExposure??MARGIN_PROTOCOL.maxGrossExposure).minus(gross)).div(reservePrice),D(q.ask_qty).mul('.1'),D(q.bid_qty).mul('.1')).div(step).floor().mul(step);
  if(desired.lte(0)||desired.lt(meta.ordermin)||desired.mul(e).lt(meta.costmin)){reason='MINIMUM_OR_LIQUIDITY';continue;}
  const collateral=desired.mul(reservePrice).div(leverage),funding=max(c.funding(c.stop),c.funding(c.target)).mul(desired),reserved=collateral.plus(desired.mul(reservePrice).mul(c.entryFee)).plus(desired.mul(reservePrice).mul(c.rate)).plus(funding);
  if(reserved.gt(free)||financed&&margin.plus(collateral).gt(equity.mul(policy.marginMaxFraction??MARGIN_PROTOCOL.maxMarginFraction))){reason='MARGIN_CAPITAL_UNAVAILABLE';continue;}
  // Estimated price at the early liquidation boundary after worst holding costs.
  const allowance=e.div(leverage).mul(D(1).minus(MARGIN_PROTOCOL.maintenance)).minus(e.mul(c.entryFee).plus(c.opening)).minus(max(c.funding(c.stop),c.funding(c.target)));
  const liquidation=short?e.plus(allowance):e.minus(allowance);
  if(financed&&(allowance.lte(0)||(short?c.stop.gte(liquidation):c.stop.lte(liquidation)))){reason='STOP_TOO_CLOSE_TO_LIQUIDATION';continue;}
  const risk=desired.mul(c.loss),breakEven=short?e.mul(D(1).minus(c.entryFee)).minus(c.opening).minus(max(c.funding(c.stop),c.funding(c.target))).div(D(1).plus(c.fee)).div(D(1).plus(c.slip)).minus(c.spread):e.mul(D(1).plus(c.entryFee)).plus(c.opening).plus(c.funding(c.target)).div(D(1).minus(c.fee)).div(D(1).minus(c.slip)).plus(c.spread);
  return {qty:desired.toString(),risk:risk.toString(),risk_budget:budget.toString(),risk_pct:risk.div(equity).mul(100).toString(),exposure:desired.mul(reservePrice).toString(),reserved:reserved.toString(),initial_margin:collateral.toString(),leverage,effective_leverage:desired.mul(e).div(equity).toString(),financing:financed?'PAPER_MARGIN_ESTIMATE':'SPOT_CASH_1X',funding_rate:c.rate.toString(),funding_reserved:funding.toString(),funding_interval:MARGIN_PROTOCOL.fundingInterval,liquidation_estimate:financed?liquidation.toString():null,liquidation_model:MARGIN_PROTOCOL.model,maintenance:MARGIN_PROTOCOL.maintenance,liquidation_fee:MARGIN_PROTOCOL.liquidationFee,net_rr:c.rr.toString(),target_net:desired.mul(c.gain).toString(),target_fees:desired.mul(c.fees(c.target)).toString(),break_even:breakEven.toString(),fee:policy.fee,...(p.order===MAKER_ORDER?{entry_fee_rate:c.entryFee.toString(),fill_model:CONTEXT_PROTOCOL.fillModel}:{}),slippage:policy.slippage,spread:c.spread.toString(),decision:leverage===1?'CASH_SUFFICIENT':'LOWEST_LEVERAGE_WITHIN_RISK'};
 }
 return {reason};
}
export function marginFunding(p,price,now){const s=p.plan.sizing,n=Math.max(0,Math.floor((now-p.entered_at)/s.funding_interval));return D(p.qty).mul(p.plan.direction==='SHORT'?max(p.entry,price):p.entry).mul(s.funding_rate).mul(n);}
export function marginValue(p,q,now){const short=p.plan.direction==='SHORT',price=D(short?q.ask:q.bid),gross=price.minus(p.entry).mul(short?-1:1).mul(p.qty),fee=price.mul(p.qty).mul(p.plan.sizing.fee);return D(p.initial_margin).plus(gross).minus(fee).minus(marginFunding(p,price,now));}
export function marginOpen(a,p,price,now){
 const total=D(p.sizing.qty).mul(price),fee=total.mul(p.sizing.entry_fee_rate??p.sizing.fee),opening=total.mul(p.sizing.funding_rate),collateral=total.div(p.sizing.leverage),cost=collateral.plus(fee).plus(opening);
 a.cash=D(a.cash).minus(cost).toString();a.fees=D(a.fees).plus(fee).plus(opening).toString();a.pending=null;
 a.position={plan:p,qty:p.sizing.qty,entry:String(price),entry_fee:fee.plus(opening).toString(),initial_margin:collateral.toString(),total_entry:cost.toString(),entered_at:now,expires_at:now+p.holding_ms};return {fee:fee.plus(opening).toString(),cost:cost.toString()};
}
export function marginStep(a,feed,now){
 const out=[],q=feed.quote,t=feed.trade;
 if(a.position){
  const p=a.position,plan=p.plan,s=plan.sizing,short=plan.direction==='SHORT',price=D(short?q.ask:q.bid).mul(short?D(1).plus(s.slippage):D(1).minus(s.slippage)),funding=marginFunding(p,price,now),gross=price.minus(p.entry).mul(short?-1:1).mul(p.qty);
  let reason=p.exit_reason;
  if(q.event_at>=p.entered_at&&s.financing==='PAPER_MARGIN_ESTIMATE'&&D(p.initial_margin).plus(gross).minus(p.entry_fee).minus(funding).lte(D(p.initial_margin).mul(s.maintenance)))reason='LIQUIDATION_MODEL';
  if(t.event_at>=p.entered_at&&reason!=='LIQUIDATION_MODEL'){if(short?D(t.price).gte(plan.stop):D(t.price).lte(plan.stop))reason='STOP';else if(!reason&&(short?D(t.price).lte(plan.target):D(t.price).gte(plan.target)))reason='TARGET';}
  if(!reason&&now>=p.expires_at)reason='TIMEOUT';if(!reason||q.event_at<p.entered_at)return out;
  p.exit_reason=reason;const fee=price.mul(p.qty).mul(reason==='LIQUIDATION_MODEL'?s.liquidation_fee:s.fee),pnl=gross.minus(p.entry_fee).minus(fee).minus(funding);
  a.cash=D(a.cash).plus(p.initial_margin).plus(gross).minus(fee).minus(funding).toString();a.position=null;a.closed++;a.net=D(a.net).plus(pnl).toString();a.fees=D(a.fees).plus(fee).plus(funding).toString();
  if(!p.quality||p.quality==='OBSERVED')a.observedClosed=(a.observedClosed||0)+1;else a.ambiguousClosed=(a.ambiguousClosed||0)+1;
  if(pnl.gt(0)){a.wins++;a.lossStreak=0;}else{a.losses++;a.lossStreak++;a.maxLossStreak=Math.max(a.maxLossStreak,a.lossStreak);}
  out.push({type:'CLOSED',id:plan.id,family:plan.family,timeframe:plan.timeframe,direction:plan.direction,leverage:s.leverage,at:now,plan_hash:plan.hash,reason,price:price.toString(),qty:p.qty,entry:p.entry,entered_at:p.entered_at,exit_quote:q,trigger_trade:t,pnl:pnl.toString(),R:pnl.div(s.risk).toString(),fees:D(p.entry_fee).plus(fee).plus(funding).toString(),financing_fees:funding.toString(),outcome:reason,policy_version:plan.version,quality:p.quality??'OBSERVED'});return out;
 }
 const pending=a.pending;if(!pending)return out;const p=pending.plan,s=p.sizing,short=p.direction==='SHORT',cancel=reason=>{a.pending=null;out.push({type:'NOT_FILLED',id:p.id,reason,at:now,policy_version:p.version});return out;};
 if(now>=p.expires_at)return cancel('VENCIDA');
 if(short?D(t.price).gte(p.stop)||D(t.price).lte(p.target):D(t.price).lte(p.stop)||D(t.price).gte(p.target))return cancel('BARRIER_BEFORE_ENTRY');
 if(p.order===MAKER_ORDER){
  if(now<pending.placed_at||q.event_at<pending.placed_at)return out;
  if(pending.posted_at===undefined){
   if(short?D(p.limit).lte(q.bid):D(p.limit).gte(q.ask))return cancel('POST_ONLY_WOULD_CROSS');
   pending.posted_at=now;out.push({type:'MAKER_POSTED',id:p.id,at:now,quote:q});return out;
  }
  // A touch, snapshot or candle is never a maker fill. Queue position is
  // unknown: conservative all-or-none model, with <=10% observed participation.
  if(t.source!=='KRAKEN_WS_V2_TRADE'||t.message_type!=='update'||!t.id||t.event_at<=pending.posted_at||t.received_at<=pending.posted_at||t.side!==(short?'buy':'sell'))return out;
  if(!(short?D(t.price).gt(p.limit):D(t.price).lt(p.limit)))return out;
  if(D(s.qty).gt(D(t.available_qty??t.qty??0).mul('.1'))||D(s.qty).gt(D(q.ask_qty).mul('.1'))||D(s.qty).gt(D(q.bid_qty).mul('.1')))return out;
  const price=D(p.limit),cost=D(s.qty).mul(price).mul(D(1).div(s.leverage).plus(s.entry_fee_rate).plus(s.funding_rate));
  if(cost.plus(s.funding_reserved).gt(s.reserved))return cancel('MARGIN_RESERVATION_CHANGED');
  if(cost.plus(s.funding_reserved).gt(a.cash))return cancel('MARGIN_CAPITAL_UNAVAILABLE');
  const opened=marginOpen(a,p,price.toString(),now);
  out.push({type:'FILLED',id:p.id,at:now,price:price.toString(),qty:s.qty,fee:opened.fee,quote:q,trade:t,plan_hash:p.hash,fill_model:CONTEXT_PROTOCOL.fillModel,queue_position:'NOT_MODELED'});return out;
 }
 const crossed=short?D(t.price).lte(p.entry):D(t.price).gte(p.entry);
 if(now<pending.placed_at)return crossed?cancel('ENTRADA_PERDIDA'):out;if(t.event_at<pending.placed_at)return out;
 if(!pending.triggered&&crossed){pending.triggered=true;pending.trigger_at=t.event_at;out.push({type:'TRIGGERED',id:p.id,at:now,trade:t});}if(!pending.triggered)return out;
 const price=D(short?q.bid:q.ask).mul(short?D(1).minus(s.slippage):D(1).plus(s.slippage));
 if(short?price.lt(p.limit):price.gt(p.limit))return cancel('ENTRY_GAP_BEYOND_LIMIT');if(q.event_at<pending.trigger_at)return out;
 if(D(s.qty).gt(D(q.ask_qty).mul('.1'))||D(s.qty).gt(D(q.bid_qty).mul('.1')))return out;
 const cost=D(s.qty).mul(price).mul(D(1).div(s.leverage).plus(s.fee).plus(s.funding_rate));
 if(cost.plus(s.funding_reserved).gt(s.reserved))return cancel('MARGIN_RESERVATION_CHANGED');
 if(cost.plus(s.funding_reserved).gt(a.cash))return cancel('MARGIN_CAPITAL_UNAVAILABLE');
 const opened=marginOpen(a,p,price.toString(),now);out.push({type:'FILLED',id:p.id,at:now,price:price.toString(),qty:s.qty,fee:opened.fee,quote:q,trade:t,plan_hash:p.hash});return out;
}
