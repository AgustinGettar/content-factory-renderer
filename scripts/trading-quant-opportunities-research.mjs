// Fixed before outcomes: measure availability, NOT filled trades or profitability.
import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {quantCandidates} from '../lib/trading/quant-strategies.js';
import {EXPLORATION_POLICY} from '../lib/trading/secondary-exploration.js';
import {EARLY_PROFIT_POLICY} from '../lib/trading/secondary-profit-policy.js';
import {OPPORTUNITY_POLICY} from '../lib/trading/quant-opportunities.js';
import {evaluateEntryEconomics} from '../lib/trading/secondary-entry-economics.js';
import {requireExternalResearch} from '../lib/trading/quant-experiments.js';
import {hash} from '../lib/trading/core.js';
requireExternalResearch();
const args=Object.fromEntries(process.argv.slice(2).reduce((a,x,i,all)=>x.startsWith('--')?[...a,[x.slice(2),all[i+1]]]:a,[]));
if(!args.data||!args.output)throw Error('DATA_OUTPUT_REQUIRED');
const manifest=JSON.parse(await readFile(path.join(args.data,'manifest.json'),'utf8')),series={};
for(const tf of Object.keys(manifest.frames))series[tf]=JSON.parse(await readFile(path.join(args.data,tf+'.json'),'utf8'));
const contexts={1:5,5:15,15:60,60:240,240:1440},report={version:1,policy:OPPORTUNITY_POLICY,policy_hash:hash(OPPORTUNITY_POLICY),source_manifest_hash:hash(manifest),fixed_lookback_days:7,quote_model:'CANDLE_CLOSE_PLUS_ASSUMED_1_BPS_SPREAD',funding_model:'ADVERSE_0_3_BPS_PER_HOUR',fills_simulated:false,profitability_validated:false,limitations:['Opportunity counts are not fills, independent trades, or portfolio returns.','No historical BBO or maker queue is present. Passive fills cannot be inferred from an OHLC touch.','Parameters are predeclared hypotheses; prospective comparison and OOS validation remain required.'],frames:{}};
for(const tf of [1,5,15,60,240]){
 const rows=series[tf],context=series[contexts[tf]],begin=rows.at(-1).end-7*86400000,result={};let ci=0;
 const seen={baseline:new Set(),updated:new Set()};for(const version of Object.keys(seen))result[version]={evaluations:0,detected:0,economic_candidates:0,unique_confirmations:0,passive_candidates:0,reasons:{},patterns:{}};
 for(let i=255;i<rows.length;i++){
  const cutoff=rows[i].end;if(cutoff<begin)continue;while(ci<context.length&&context[ci].end<=cutoff)ci++;if(ci<64)continue;
  const now=cutoff+2000,px=rows[i].close,q={source:'KRAKEN_FUTURES_WS_TICKER',research_assumption:true,observed_quote:false,symbol:'PF_XBTUSD',event_at:now,received_at:now,bid:String(px*.99995),ask:String(px*1.00005),bid_qty:'1000000',ask_qty:'1000000',mark_price:String(px)},meta={qty_step:.0001,tick_size:1,checked_at:now,margin_schedule:[{numNonContractUnits:0,initialMargin:.1,maintenanceMargin:.05},{numNonContractUnits:30000000}]};
  const s={[tf]:rows.slice(i-255,i+1),[contexts[tf]]:context.slice(Math.max(0,ci-256),ci)};
  for(const [version,opportunities] of [['baseline',false],['updated',true]]){
   const r=result[version];r.evaluations++;
   for(const d of quantCandidates(s,q,meta,cutoff,now,px*.00003,EXPLORATION_POLICY,EARLY_PROFIT_POLICY,{timeframe:tf,contextTimeframe:contexts[tf],timeframeVersion:'secondary-timeframes-2.0.0',opportunities})){
    r.reasons[d.reason]=(r.reasons[d.reason]??0)+1;if(d.facts?.pattern_detected)r.detected++;
    if(d.plan){const economics=evaluateEntryEconomics(d.plan,{quote:q,qty:'1',now});if(!economics.accepted){r.reasons[economics.reason]=(r.reasons[economics.reason]??0)+1;continue;}r.economic_candidates++;r.patterns[d.pattern]=(r.patterns[d.pattern]??0)+1;if(d.plan.execution_contract.mode==='MAKER_LIMIT')r.passive_candidates++;seen[version].add(d.plan.signal_key);}
   }
  }
 }
 for(const version of Object.keys(seen))result[version].unique_confirmations=seen[version].size;
 report.frames[tf]=result;console.log(JSON.stringify({timeframe:tf,baseline:result.baseline.economic_candidates,updated:result.updated.economic_candidates,passive:result.updated.passive_candidates}));
}
await writeFile(args.output,JSON.stringify(report,null,2));
