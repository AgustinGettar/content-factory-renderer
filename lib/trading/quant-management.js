// Additive supervision for quant contracts only; original stops never move away.
import {D,hash} from './core.js';
import {secondaryFresh,secondaryEstimate} from './secondary-futures-math.js';
export const QUANT_MANAGEMENT_VERSION='secondary-quant-management-1.0.0';
export function observeQuantMicrostructure(state,event,now){
 const s=state.microstructure??={version:1,windows:[],last_quote:null,started_at:now};
 const data=event.q??event.t;if(!data||now-data.event_at>5000||data.event_at>now+1000)return;
 const start=Math.floor(data.event_at/60000)*60000;let w=s.windows.find(x=>x.start===start);
 if(!w){w={start,end:start+60000,buy_btc:0,sell_btc:0,liquidation_btc:0,trades:0,top_book_ofi:0,quote_updates:0,first_event_at:data.event_at,last_event_at:data.event_at};s.windows.push(w);s.windows=s.windows.filter(x=>x.start>=start-119*60000);}
 w.last_event_at=Math.max(w.last_event_at,data.event_at);
 if(event.t){w[data.side==='buy'?'buy_btc':'sell_btc']+=data.qty;w.trades++;if(data.type==='liquidation')w.liquidation_btc+=data.qty;}
 else{const p=s.last_quote,q=data;if(p&&q.event_at>p.event_at&&q.event_at-p.event_at<=5000){
   w.top_book_ofi+=(Number(q.bid)>=Number(p.bid)?Number(q.bid_qty):0)-(Number(q.bid)<=Number(p.bid)?Number(p.bid_qty):0)-(Number(q.ask)<=Number(p.ask)?Number(q.ask_qty):0)+(Number(q.ask)>=Number(p.ask)?Number(p.ask_qty):0);
  }else if(p)w.gap=true;s.last_quote={event_at:q.event_at,bid:q.bid,ask:q.ask,bid_qty:q.bid_qty,ask_qty:q.ask_qty};w.quote_updates++;}
 w.cvd_btc=w.buy_btc-w.sell_btc;w.authority='OBSERVATION_ONLY';w.coverage='OBSERVED_STREAM_NOT_COMPLETE_EXCHANGE_HISTORY';
}
export function updateQuantPositionContext(root,timeframe,f,now){
 for(const p of Object.values(root.frequency.account.positions??{})){
  if(!p.plan.quant_contract||p.plan.timeframe!==timeframe||f.cutoff<=p.entered_at)continue;
  const m=p.quant_management??={version:QUANT_MANAGEMENT_VERSION,stop:p.plan.stop,updates:0};
  if(m.cutoff>=f.cutoff)continue;
  const short=p.plan.direction==='SHORT',swing=short?f.structure.highs.at(-1):f.structure.lows.at(-1);
  m.cutoff=f.cutoff;m.at=now;m.atr=f.atr14;m.swing=swing??null;m.ema9=f.ema9;m.ema21=f.ema21;m.adx=f.adx;m.momentum=f.macd_histogram;m.updates++;
  m.exhaustion=short?f.close>f.ema21&&f.macd_histogram>0&&f.structure.bos_up:f.close<f.ema21&&f.macd_histogram<0&&f.structure.bos_down;
 }
}
export function evaluateQuantExit(p,q,v,now){
 if(!p.plan.quant_contract||!secondaryFresh(q,now))return {reason:null,events:[]};
 const m=p.quant_management??={version:QUANT_MANAGEMENT_VERSION,stop:p.plan.stop,updates:0},short=p.plan.direction==='SHORT',price=Number(q[short?'ask':'bid']),sign=short?-1:1;
 const hit=short?price>=Number(m.stop):price<=Number(m.stop);
 if(hit&&m.stop!==p.plan.stop)return {reason:'QUANT_TECHNICAL_TRAILING',events:[]};
 if(!v.funding_complete||!v.liquidity_ok||Number(v.net)<=.05||p.profit_protection?.trailing_activated_at==null)return {reason:null,events:[]};
 // Context can be one candle old; do not extrapolate stale indicators through a feed outage.
 if(!m.cutoff||now-m.cutoff>2*p.plan.timeframe*60000)return {reason:null,events:[]};
 if(m.exhaustion)return {reason:'QUANT_MOMENTUM_EXHAUSTION',events:[]};
 const atrStop=price-sign*2*m.atr,structureStop=m.swing?.price??Number(p.plan.stop);
 const be=Number(secondaryEstimate({...p,management:{net_goal:'0.05'}},q,now).target_quote);
 const candidates=[Number(m.stop),atrStop,structureStop,be],candidate=short?Math.min(...candidates):Math.max(...candidates);
 if(sign*(price-candidate)<=0||sign*(candidate-Number(m.stop))<=0)return {reason:null,events:[]};
 const previous=m.stop;m.stop=String(candidate);m.last_tightened_at=now;m.basis='MAX_FAVORABLE_ATR_STRUCTURE_NET_BREAK_EVEN_PLUS';
 // Record at most once per closed candle; the price state remains durable each tick.
 const events=m.last_notice_cutoff===m.cutoff?[]:[{type:'QUANT_TRAILING_TIGHTENED',id:p.plan.id,at:now,previous_stop:previous,stop:m.stop,context_cutoff:m.cutoff,net_break_even_plus_quote:String(be),realTrading:false}];m.last_notice_cutoff=m.cutoff;
 return {reason:null,events};
}
// Exact algebra for the declared USD collateral/linear isolated reference model.
// Actual Kraken account netting, wallet collateral/ADL are deliberately not implied.
export function referenceLiquidation({entry,qty,margin,direction,maintenanceRate=.05,closingFeeRate=.0005,funding=0}){
 if(![entry,qty,margin].every(x=>Number.isFinite(Number(x))&&Number(x)>0)||!['LONG','SHORT'].includes(direction)||![maintenanceRate,closingFeeRate].every(x=>Number.isFinite(Number(x))&&Number(x)>=0&&Number(x)<1)||!Number.isFinite(Number(funding)))return null;
 const e=D(entry),q=D(qty),m=D(margin).minus(funding),rate=D(maintenanceRate).plus(closingFeeRate),short=direction==='SHORT';
 const price=(short?e.plus(m.div(q)).div(D(1).plus(rate)):e.minus(m.div(q)).div(D(1).minus(rate)));
 return {price:price.gt(0)?price.toString():null,model:'LINEAR_USD_ISOLATED_REFERENCE',maintenance_rate:String(maintenanceRate),closing_fee_reserve_rate:String(closingFeeRate),funding_debited_from_reference_margin:String(funding),exact_for_declared_model:true,actual_exchange_liquidation:false};
}
export function quantMarkMargin(p,q,now){
 if(!['secondary-risk-budget-2.0.0','secondary-risk-budget-3.0.0'].includes(p.plan.execution_contract?.risk_budget?.policy?.version)||!secondaryFresh(q,now))return null;
 const valid=q.mark_price!=null&&Number(q.mark_price)>0,mark=valid?D(q.mark_price):D(q[p.plan.direction==='SHORT'?'ask':'bid']),qty=D(p.qty),short=p.plan.direction==='SHORT',gross=mark.minus(p.entry).mul(short?-1:1).mul(qty),funding=D(p.accrued_funding??0),equity=D(p.initial_margin).plus(gross).minus(funding),maintenance=mark.mul(qty).mul('.05'),fee=mark.mul(qty).mul(p.plan.execution_contract.takerFee),liquidation=referenceLiquidation({entry:p.entry,qty:p.qty,margin:p.initial_margin,direction:p.plan.direction,maintenanceRate:.05,closingFeeRate:Number(p.plan.execution_contract.takerFee),funding:p.accrued_funding??0});
 return {version:'secondary-mark-margin-reference-1.0.0',at:now,quote_at:q.event_at,mark_basis:valid?'OBSERVED_MARK_PRICE':'ADVERSE_BBO_FALLBACK',mark_price:mark.toString(),position_equity:equity.toString(),maintenance_margin:maintenance.toString(),closing_fee_reserve:fee.toString(),threshold:maintenance.plus(fee).toString(),triggered:equity.lte(maintenance.plus(fee)),liquidation,realTrading:false,schedule:'EUROPA_RETAIL_TIER1_BELOW_30M_USD',contract_schedule_verified:p.plan.quant_contract?.margin_reference?.verified??false};
}
