// A preregistered, untrained public-flow forecast. Does not predict private stops
// or identify traders. Completed delayed windows are labels, never predictors.
import {D,hash} from './core.js';
export const FLOW_FORECAST_PROTOCOL=Object.freeze({version:'kraken-public-forecast-1.0.0',band_bps:10,horizon_ms:30000,alpha:.3,recent_windows:10,minimum_holdout_windows:100,minimum_touch_cases_each_direction:20,calibration_fraction:.7});
const classes=['CROSS','REBOUND','NO_TOUCH'];
const usable=w=>w?.complete===true&&w?.symbol==='PF_XBTUSD'&&w.band_bps===10&&Number.isSafeInteger(w.start)&&w.end-w.start===30000&&Number.isSafeInteger(w.label_received_at)&&w.label_received_at>=w.end&&Number.isSafeInteger(w.new_orders)&&w.new_orders>=0&&w.reduce_only_volume_btc!==null&&w.reduce_only_volume_btc!==''&&Number.isFinite(Number(w.reduce_only_volume_btc))&&D(w.reduce_only_volume_btc).gte(0)&&classes.includes(w.level_outcome);
const mean=xs=>xs.reduce((a,b)=>a+b,0)/xs.length;
const ewma=xs=>xs.slice(1).reduce((a,b)=>.7*a+.3*b,xs[0]);
export function forecastPublicWindow(history,start){
 const causal=history.filter(w=>usable(w)&&w.end<=start&&w.label_received_at<=start).sort((a,b)=>a.end-b.end).slice(-10);
 if(causal.length<2)return {status:'NOT_EVALUABLE',reason:'TWO_CAUSALLY_AVAILABLE_COMPLETE_WINDOWS_REQUIRED',at:start};
 const summarize=reduce=>({new_orders:reduce(causal.map(w=>w.new_orders)),reduce_only_volume_btc:reduce(causal.map(w=>Number(w.reduce_only_volume_btc))),
  probabilities:Object.fromEntries(classes.map(c=>[c,reduce(causal.map(w=>Number(w.level_outcome===c)))]))});
 return {status:'FORECAST',at:start,window_end:start+30000,band_bps:10,model:summarize(ewma),baseline:summarize(mean),
  input_windows:causal.map(w=>({start:w.start,end:w.end,label_received_at:w.label_received_at,hash:hash(w)})),protocol:FLOW_FORECAST_PROTOCOL.version};
}
export function evaluatePublicForecast(windows){
 if(!Array.isArray(windows)||windows.length>100000)throw Error('BOUNDED_PUBLIC_WINDOWS_REQUIRED');
 const ordered=[...windows].sort((a,b)=>a.start-b.start);
 for(let i=1;i<ordered.length;i++)if(ordered[i].start<ordered[i-1].end)throw Error('FORECAST_OVERLAPPING_WINDOWS');
 const split=Math.floor(ordered.length*.7),rows=[],excluded=[];
 for(let i=split;i<ordered.length;i++){
  const w=ordered[i],prediction=forecastPublicWindow(ordered.slice(0,i),w.start);
  if(!usable(w)||prediction.status!=='FORECAST'){excluded.push({start:w.start,reason:!usable(w)?'INCOMPLETE_PUBLIC_ORDER_EXECUTION_OR_PRICE_COVERAGE':prediction.reason});continue;}
  const errors=Object.fromEntries(['model','baseline'].map(arm=>[arm,{new_orders:Math.abs(prediction[arm].new_orders-w.new_orders),reduce_only_volume_btc:Math.abs(prediction[arm].reduce_only_volume_btc-Number(w.reduce_only_volume_btc)),
   brier:classes.reduce((s,c)=>s+(prediction[arm].probabilities[c]-Number(w.level_outcome===c))**2,0)}]));
  rows.push({start:w.start,end:w.end,label_received_at:w.label_received_at,publication_delay_ms:w.label_received_at-w.end,truth:{new_orders:w.new_orders,reduce_only_volume_btc:w.reduce_only_volume_btc,level_outcome:w.level_outcome},prediction,errors});
 }
 const metrics=Object.fromEntries(['model','baseline'].map(arm=>[arm,rows.length?Object.fromEntries(['new_orders','reduce_only_volume_btc','brier'].map(k=>[k,mean(rows.map(r=>r.errors[arm][k]))])):null]));
 return {version:FLOW_FORECAST_PROTOCOL.version,status:rows.length?'PILOT_EVALUATED':'NOT_EVALUABLE',calibration_windows:split,evaluation_windows:rows.length,excluded,metrics,rows,
  gates_met:rows.length>=100&&['CROSS','REBOUND'].every(c=>rows.filter(r=>r.truth.level_outcome===c).length>=20),
  period:ordered.length?{start:ordered[0].start,end:ordered.at(-1).end}:null,
  out_of_sample_predictive_advantage_demonstrated:false,uncertainty:'Requires independent day blocks and sufficient holdout; no significance inferred from this score',
  limits:['No order count inferred from aggregated L2 increases','reduceOnly=false/unknown never interpreted as an opening','Late public labels cannot enter earlier predictions','No-touch cases remain in Brier and count/volume error']};
}
