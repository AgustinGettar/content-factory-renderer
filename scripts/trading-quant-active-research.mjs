// Admission comparison on real closed candles, outside the operational worker.
// Does not simulate fills or establish realized profit or independent OOS edge.
import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {quantCandidates} from '../lib/trading/quant-strategies.js';
import {ACTIVE_POLICY} from '../lib/trading/quant-active-paper.js';
import {ACTIVE_RISK_POLICY} from '../lib/trading/secondary-risk-budget.js';
import {EXPLORATION_POLICY} from '../lib/trading/secondary-exploration.js';
import {EARLY_PROFIT_POLICY} from '../lib/trading/secondary-profit-policy.js';
import {evaluateEntryEconomics} from '../lib/trading/secondary-entry-economics.js';
import {requireExternalResearch} from '../lib/trading/quant-experiments.js';
import {hash} from '../lib/trading/core.js';
requireExternalResearch();
const args=Object.fromEntries(process.argv.slice(2).reduce((a,x,i,all)=>x.startsWith('--')?[...a,[x.slice(2),all[i+1]]]:a,[]));
if(!args.data||!args.output)throw Error('DATA_OUTPUT_REQUIRED');
const manifest=JSON.parse(await readFile(path.join(args.data,'manifest.json'),'utf8')),series={};
for(const tf of [1,5,15,60,240,1440])series[tf]=JSON.parse(await readFile(path.join(args.data,tf+'.json'),'utf8'));
const contexts={1:5,5:15,15:60,60:240,240:1440},report={version:1,active_policy:ACTIVE_POLICY,risk_policy:ACTIVE_RISK_POLICY,policy_hash:hash(ACTIVE_POLICY),source_manifest_hash:hash(manifest),source_end:manifest.end,lookback_days:7,temporal_split:'FIRST_5_DAYS_AND_LAST_2_DAYS',parameters_fitted:false,independent_oos:false,quote_model:'CLOSE_PLUS_ASSUMED_1_BPS_SPREAD',funding_model:'ADVERSE_0_3_BPS_PER_HOUR',historical_bbo:false,fills_simulated:false,profitability_validated:false,frames:{},limitations:['These historical dates were inspected in previous research; this is not independent out-of-sample validation.','Candle-based quotes and funding are assumptions, not observed BBO or execution receipts.','Candidate counts are not independent trades, simultaneous capacity, fills or returns.','Operational partial exits and their profit impact need prospective PAPER observations.']};
for(const tf of [1,5,15,60,240]){
 const rows=series[tf],context=series[contexts[tf]],end=manifest.end,begin=end-7*86400000,split=end-2*86400000,result={first_5_days:{},last_2_days:{}};let ci=0;
 for(const r of Object.values(result)){r.evaluations=0;for(const mode of ['baseline','active'])r[mode]={detected:0,candidates:0,rr_below_one:0,unique_confirmations:0,patterns:{},reasons:{}};}
 const seen=Object.fromEntries(Object.keys(result).map(period=>[period,{baseline:new Set(),active:new Set()}]));
 for(let i=255;i<rows.length;i++){
  const cutoff=rows[i].end;if(cutoff<begin||cutoff>end)continue;while(ci<context.length&&context[ci].end<=cutoff)ci++;if(ci<64)continue;
  const now=cutoff+2000,px=rows[i].close,q={source:'KRAKEN_FUTURES_WS_TICKER',research_assumption:true,observed_quote:false,symbol:'PF_XBTUSD',event_at:now,received_at:now,bid:String(px*.99995),ask:String(px*1.00005),bid_qty:'1000000',ask_qty:'1000000',mark_price:String(px)},meta={qty_step:.0001,tick_size:1,checked_at:now,margin_schedule:[{numNonContractUnits:0,initialMargin:.1,maintenanceMargin:.05},{numNonContractUnits:30000000}]};
  const s={[tf]:rows.slice(i-255,i+1),[contexts[tf]]:context.slice(Math.max(0,ci-256),ci)},period=cutoff<=split?'first_5_days':'last_2_days',r=result[period];r.evaluations++;
  for(const mode of ['baseline','active']){
   const out=r[mode],decisions=quantCandidates(s,q,meta,cutoff,now,px*.00003,EXPLORATION_POLICY,EARLY_PROFIT_POLICY,{timeframe:tf,contextTimeframe:contexts[tf],timeframeVersion:'secondary-timeframes-2.0.0',opportunities:true,contextual:true,active:mode==='active'});
   for(const d of decisions){if(d.facts.pattern_detected)out.detected++;const econ=d.plan?evaluateEntryEconomics(d.plan,{quote:q,qty:'1',now}):null,reason=econ&&!econ.accepted?econ.reason:d.reason;out.reasons[reason]=(out.reasons[reason]??0)+1;if(!econ?.accepted)continue;
    out.candidates++;out.rr_below_one+=Number(Number(econ.net_rr)<1);out.patterns[d.pattern]=(out.patterns[d.pattern]??0)+1;seen[period][mode].add(d.plan.signal_key);
   }
  }
 }
 for(const period of Object.keys(result))for(const mode of ['baseline','active'])result[period][mode].unique_confirmations=seen[period][mode].size;
 report.frames[tf]=result;console.log(JSON.stringify({timeframe:tf,...Object.fromEntries(Object.entries(result).map(([period,r])=>[period,{evaluations:r.evaluations,baseline:r.baseline.candidates,active:r.active.candidates,active_below_one:r.active.rr_below_one}]))}));
}
await writeFile(args.output,JSON.stringify(report,null,2));
