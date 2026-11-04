// Experimental continuation scalping observer for the existing futures PAPER engine.
// AUTHORITY NONE: this module does not return plans, orders, positions or stop changes.
import {SECONDARY_PROTOCOL,secondaryFresh} from './secondary-futures-math.js';
export const SECONDARY_SCALPING_SHADOW_VERSION='secondary-scalping-shadow-1.0.0';
export const SECONDARY_SCALPING_SHADOW_PROTOCOL=Object.freeze({
 version:SECONDARY_SCALPING_SHADOW_VERSION,mode:'PAPER',realTrading:false,authority:'NONE',
 symbol:'PF_XBTUSD',timeframe:5,context_timeframe:15,nominal_study_usd:300,
 expected_net_fraction:0.002,minimum_net_rr:1.2,maximum_spread_bps:8,
 maximum_quote_displacement_atr:0.75,stop_atr_minimum:0.35,
 stop_atr_maximum:2.5,target_stop_multiple:1.8,target_atr_maximum:2.5,
 exit_after_bars:3,parameter_status:'UNVALIDATED_RESEARCH_ONLY'
});
const P=SECONDARY_SCALPING_SHADOW_PROTOCOL,finite=n=>typeof n==='number'&&Number.isFinite(n);
const num=x=>x===null||x===undefined?NaN:Number(x);
const round=x=>finite(x)?Number(x.toPrecision(10)):null;
function base(cutoff,now) {
 return {version:P.version,authority:'NONE',mode:'PAPER',realTrading:false,statistically_validated:false,
  symbol:P.symbol,timeframe:P.timeframe,context_timeframe:P.context_timeframe,cutoff,at:now,
  execution_eligible:false,submitted_orders:0,capital_reserved_usd:0,
  study_nominal_usd:P.nominal_study_usd,parameter_status:P.parameter_status};
}
const reject=(common,reason,extra={})=>({...common,status:'WAIT',reason,...extra});
const signFor=dir=>dir==='LONG'?1:-1;
// Only invoked after the existing completed 5m frame and its regime observation.
// Uses the same closed PF_XBTUSD candles; any stale quote or missing context is a WAIT.
export function observeSecondaryScalpingShadow({series,quote,regime,contextRegime,fundingRate,cutoff,now}={}) {
 const common=base(cutoff,now),step=300000;
 if(!Number.isSafeInteger(now)||!Number.isSafeInteger(cutoff)||cutoff%step||now<cutoff)
  return reject(common,'INVALID_CAUSAL_CLOCK');
 if(!regime||regime.timeframe!==5||regime.cutoff!==cutoff||regime.advisory_only!==true)
  return reject(common,'MISSING_CURRENT_REGIME');
 if(!Array.isArray(series)||series.length<64||series.at(-1)?.end!==cutoff)
  return reject(common,'CLOSED_HISTORY_NOT_SYNCHRONIZED');
 if(!secondaryFresh(quote,now))return reject(common,'FUTURES_QUOTE_NOT_FRESH');
 const ctxCutoff=Math.floor(cutoff/900000)*900000;
 if(!contextRegime||contextRegime.timeframe!==15||contextRegime.advisory_only!==true||
    contextRegime.cutoff!==ctxCutoff)
  return reject(common,'MISSING_CONTEXT_REGIME');
 if(!finite(num(fundingRate)))return reject(common,'FUNDING_UNKNOWN');
 if(!['UPTREND','DOWNTREND'].includes(regime.regime))
  return reject(common,'NO_CONFIRMED_5M_TREND',{market_regime:regime.regime});
 const direction=regime.regime==='UPTREND'?'LONG':'SHORT',expectedContext=direction==='LONG'?'UPTREND':'DOWNTREND';
 if(contextRegime.regime!==expectedContext)
  return reject(common,'CONTEXT_NOT_ALIGNED',{direction,context_regime:contextRegime.regime});
 const f=regime.features??{},atr=num(f.atr14),ema9=num(f.ema9),ema21=num(f.ema21);
 if(!finite(atr)||atr<=0||!finite(ema9)||!finite(ema21))
  return reject(common,'INDICATORS_UNAVAILABLE');
 // Regime classifier validates the whole causal interval. Repeat the final-bar
 // identity and source checks here instead of accepting a mismatched source.
 const prev=series.at(-2),last=series.at(-1);
 if(!prev||prev.end!==cutoff-step||prev.start!==cutoff-2*step||last.start!==cutoff-step||
    [prev.high,prev.low,prev.close,last.open,last.high,last.low,last.close,last.volume].some(x=>!finite(num(x))))
  return reject(common,'INVALID_LAST_CLOSED_CANDLES');
 const bid=num(quote.bid),ask=num(quote.ask),spread=ask-bid,mid=(bid+ask)/2;
 const spreadBps=spread/mid*1e4;
 if(spreadBps>P.maximum_spread_bps)return reject(common,'SPREAD_TOO_WIDE',{observed_spread_bps:round(spreadBps)});
 if(Math.abs(mid-num(last.close))>P.maximum_quote_displacement_atr*atr)
  return reject(common,'QUOTE_DISPLACED_FROM_CLOSE',{observed_spread_bps:round(spreadBps)});
 // Confirmation: the prior bar touched the fast EMA area, and the latest
 // *closed* bar recovered the fast EMA in the trend direction.
 const long=direction==='LONG',s=signFor(direction);
 const touch=long?num(prev.low)<=ema9+atr*0.15:num(prev.high)>=ema9-atr*0.15;
 const recovery=long?num(last.close)>ema9&&num(last.close)>num(last.open)&&num(last.close)>num(prev.close):
   num(last.close)<ema9&&num(last.close)<num(last.open)&&num(last.close)<num(prev.close);
 const volumeOk=finite(num(f.relative_volume20))&&num(f.relative_volume20)>=0.8;
 if(!touch||!recovery||!volumeOk)return reject(common,'WAIT_PULLBACK_CONFIRMATION',
  {direction,touch,recovery,volume_ok:volumeOk,market_regime:regime.regime});
 // A conservative taker/taker hypothetical: crossing the current BBO,
 // applying entry and exit adverse slippage, both fees and funding allowance.
 // Future target/stop levels are MID hypotheses, not observed future fills.
 const slip=num(SECONDARY_PROTOCOL.slippage),fee=num(SECONDARY_PROTOCOL.takerFee);
 const entry=(long?ask:bid)*(1+s*slip);
 const stop=long?Math.min(num(prev.low),num(last.low))-atr*.2:
   Math.max(num(prev.high),num(last.high))+atr*.2;
 const risk=s*(entry-stop);
 if(!(risk>=P.stop_atr_minimum*atr&&risk<=P.stop_atr_maximum*atr))
  return reject(common,'INVALID_STOP_DISTANCE',{direction,stop_distance_atr:round(risk/atr)});
 const targetDistance=Math.min(P.target_stop_multiple*risk,P.target_atr_maximum*atr);
 const target=entry+s*targetDistance;
 const q=P.nominal_study_usd/entry,halfSpread=spread/2;
 const sellExit=price=> (price-halfSpread)*(1-slip);
 const buyExit=price=> (price+halfSpread)*(1+slip);
 const exitTarget=long?sellExit(target):buyExit(target);
 const exitStop=long?sellExit(stop):buyExit(stop);
 const entryFee=entry*q*fee,targetFee=exitTarget*q*fee,stopFee=exitStop*q*fee;
 // Same per-BTC hourly funding convention as secondaryEconomics, conservative
 // absolute funding. Not a promise of future funding or historical fill quality.
 const fundingPerBTC=Math.abs(num(fundingRate))*P.exit_after_bars*5/60;
 const netTarget=s*(exitTarget-entry)*q-entryFee-targetFee-fundingPerBTC*q;
 const netStop=s*(exitStop-entry)*q-entryFee-stopFee-fundingPerBTC*q;
 const netLoss=-netStop,rr=netLoss>0?netTarget/netLoss:null;
 const zeroMoveExit=long?sellExit(mid):buyExit(mid);
 const estimatedRoundTripCost=q*(entryFee/q+Math.abs(zeroMoveExit-entry)+zeroMoveExit*fee+fundingPerBTC);
 const metrics={direction,regime:regime.regime,context_regime:contextRegime.regime,
   observed_spread_bps:round(spreadBps),ema9:round(ema9),ema21:round(ema21),atr14:round(atr),
   study_quantity_btc:round(q),hypothetical_entry:round(entry),hypothetical_stop:round(stop),
   hypothetical_target:round(target),hypothetical_stop_risk_usd:round(netLoss),
   hypothetical_net_target_usd:round(netTarget),hypothetical_net_rr:round(rr),
   estimated_round_trip_cost_usd:round(estimatedRoundTripCost),
   minimum_expected_net_usd:round(P.nominal_study_usd*P.expected_net_fraction),
   funding_assumption_per_btc:round(fundingPerBTC),cost_assumption:'TAKER_TAKER_AND_ADVERSE_SLIPPAGE'};
 if(!(netTarget>P.nominal_study_usd*P.expected_net_fraction&&rr!==null&&rr>=P.minimum_net_rr))
  return reject(common,'NO_NET_ECONOMIC_ADVANTAGE',{...metrics});
 return {...common,status:'CANDIDATE',reason:'HYPOTHETICAL_PULLBACK_CONTINUATION',
  ...metrics,execution_assumption:'IMMEDIATE_HYPOTHETICAL_TAKER',
  fill_verified:false,profit_verified:false,market_order_allowed:false};
}
