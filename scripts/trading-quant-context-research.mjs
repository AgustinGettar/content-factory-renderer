// Fixed-rule causal feasibility audit. No model fit, live orders, or claimed fills.
import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {quantCandidates} from '../lib/trading/quant-strategies.js';
import {CONTEXT_POLICY,CONTEXT_PATTERN} from '../lib/trading/quant-context-pullback.js';
import {EXPLORATION_POLICY} from '../lib/trading/secondary-exploration.js';
import {EARLY_PROFIT_POLICY} from '../lib/trading/secondary-profit-policy.js';
import {evaluateEntryEconomics} from '../lib/trading/secondary-entry-economics.js';
import {requireExternalResearch} from '../lib/trading/quant-experiments.js';
import {hash} from '../lib/trading/core.js';
requireExternalResearch();
const args=Object.fromEntries(process.argv.slice(2).reduce((a,x,i,all)=>x.startsWith('--')?[...a,[x.slice(2),all[i+1]]]:a,[]));
if(!args.data||!args.output)throw Error('DATA_OUTPUT_REQUIRED');
const manifest=JSON.parse(await readFile(path.join(args.data,'manifest.json'),'utf8')),series={};
for(const tf of [1,5,15,60])series[tf]=JSON.parse(await readFile(path.join(args.data,tf+'.json'),'utf8'));
const contexts={1:5,5:15,15:60},report={version:1,policy:CONTEXT_POLICY,policy_hash:hash(CONTEXT_POLICY),source_manifest_hash:hash(manifest),source_end:manifest.end,lookback_days:7,temporal_split:'FIRST_5_DAYS_AND_LAST_2_DAYS_WITHOUT_PARAMETER_TUNING',quote_model:'CLOSE_PLUS_ASSUMED_1_BPS_SPREAD',funding_model:'ADVERSE_0_3_BPS_PER_HOUR',historical_bbo:false,fills_simulated:false,profitability_validated:false,frames:{},examples:[],limitations:['Historical candles cannot establish actual queue position, fills, latency or realized profitability.','Candidate count is not a count of independent trades or a portfolio return.','The last two days are an untouched temporal check of fixed rules, not proof of statistical edge.','Dynamic exits and aggregate portfolio allocations require prospective PAPER observations.']};
for(const tf of [1,5,15]){
 const rows=series[tf],context=series[contexts[tf]],end=rows.at(-1).end,begin=end-7*86400000,split=end-2*86400000,result={first_5_days:{},last_2_days:{}};let ci=0;
 const seen={first_5_days:new Set(),last_2_days:new Set()};for(const r of Object.values(result))Object.assign(r,{evaluations:0,detected:0,baseline_candidates:0,new_candidates:0,unique_confirmations:0,same_candle_as_baseline:0,reasons:{}});
 for(let i=255;i<rows.length;i++){
  const cutoff=rows[i].end;if(cutoff<begin)continue;while(ci<context.length&&context[ci].end<=cutoff)ci++;if(ci<64)continue;
  const now=cutoff+2000,px=rows[i].close,q={source:'KRAKEN_FUTURES_WS_TICKER',research_assumption:true,observed_quote:false,symbol:'PF_XBTUSD',event_at:now,received_at:now,bid:String(px*.99995),ask:String(px*1.00005),bid_qty:'1000000',ask_qty:'1000000',mark_price:String(px)},meta={qty_step:.0001,tick_size:1,checked_at:now,margin_schedule:[{numNonContractUnits:0,initialMargin:.1,maintenanceMargin:.05},{numNonContractUnits:30000000}]};
  const s={[tf]:rows.slice(i-255,i+1),[contexts[tf]]:context.slice(Math.max(0,ci-256),ci)},period=cutoff<=split?'first_5_days':'last_2_days',r=result[period];r.evaluations++;
  const decisions=quantCandidates(s,q,meta,cutoff,now,px*.00003,EXPLORATION_POLICY,EARLY_PROFIT_POLICY,{timeframe:tf,contextTimeframe:contexts[tf],timeframeVersion:'secondary-timeframes-2.0.0',opportunities:true,contextual:true});
  const baseline=decisions.filter(d=>d.pattern!==CONTEXT_PATTERN&&d.plan&&evaluateEntryEconomics(d.plan,{quote:q,qty:'1',now}).accepted);r.baseline_candidates+=baseline.length;
  const d=decisions.find(d=>d.pattern===CONTEXT_PATTERN);if(d.facts.pattern_detected)r.detected++;
  const economics=d.plan?evaluateEntryEconomics(d.plan,{quote:q,qty:'1',now}):null,reason=economics&&!economics.accepted?economics.reason:d.reason;r.reasons[reason]=(r.reasons[reason]??0)+1;
  if(economics?.accepted){r.new_candidates++;r.same_candle_as_baseline+=Number(baseline.length>0);seen[period].add(d.plan.signal_key);if(report.examples.filter(x=>x.timeframe===tf).length<3)report.examples.push({timeframe:tf,cutoff,period,plan:d.plan,economics});}
 }
 for(const period of Object.keys(result))result[period].unique_confirmations=seen[period].size;
 report.frames[tf]=result;console.log(JSON.stringify({timeframe:tf,result}));
}
await writeFile(args.output,JSON.stringify(report,null,2));
