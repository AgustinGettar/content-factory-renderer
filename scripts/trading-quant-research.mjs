// Run ONLY on an external workstation/CI. Public candle scenarios are not live fills.
import {readFile,writeFile,access} from 'node:fs/promises';
import path from 'node:path';
import {FIBONACCI_POLICY} from '../lib/trading/quant-fibonacci.js';
import {hash} from '../lib/trading/core.js';
import {quantCandidates,QUANT_VERSION,QUANT_POLICY} from '../lib/trading/quant-strategies.js';
import {entryCandidates} from '../lib/trading/secondary-entry-context.js';
import {EXPLORATION_POLICY} from '../lib/trading/secondary-exploration.js';
import {EARLY_PROFIT_POLICY} from '../lib/trading/secondary-profit-policy.js';
import {evaluateEntryEconomics} from '../lib/trading/secondary-entry-economics.js';
import {quantitativeMetrics,blockBootstrap,walkForwardSplits,promotionDecision,compareExitPaths} from '../lib/trading/quant-evaluation.js';
try{await access('/etc/lumi-trading/worker.env');throw Error('EXTERNAL_RESEARCH_HOST_REQUIRED');}catch(e){if(e.code!=='ENOENT')throw e;}
if(process.env.LUMI_TRADING_DB_PATH)throw Error('EXTERNAL_RESEARCH_HOST_REQUIRED');
const args=Object.fromEntries(process.argv.slice(2).reduce((a,x,i,all)=>x.startsWith('--')?[...a,[x.slice(2),all[i+1]]]:a,[]));
if(!args.data||!args.output)throw Error('--data and --output required');
const researchProfitPolicy={...EARLY_PROFIT_POLICY,min_expected_net_target_fraction:args['scalp-net-fraction']??EARLY_PROFIT_POLICY.min_expected_net_target_fraction};
const manifest=JSON.parse(await readFile(path.join(args.data,'manifest.json'),'utf8')),series={};
for(const tf of Object.keys(manifest.frames))series[tf]=JSON.parse(await readFile(path.join(args.data,tf+'.json'),'utf8'));
const protocol={version:'quant-candle-research-1.3.0',fibonacci_policy:FIBONACCI_POLICY,fibonacci_policy_hash:hash(FIBONACCI_POLICY),scalping_net_fraction:Number(researchProfitPolicy.min_expected_net_target_fraction),strategy_version:QUANT_VERSION,policy_hash:hash(QUANT_POLICY),fixed_parameters:true,optimized_parameters:0,
 initial_equity:1000,risk_usd_per_signal:5,notional_cap:600,taker_fee:.0005,slippage_per_side:.0002,assumed_spread_fraction:.0001,assumed_adverse_funding_fraction_per_hour:.00003,
 intrabar_order:'STOP_FIRST_WHEN_AMBIGUOUS',execution:'NEXT_NATIVE_BAR_OPEN_PLUS_ASSUMED_SPREAD_SLIPPAGE',simultaneous_portfolio:false,
 limitations:['Historical BBO, full depth, latency and actual funding are unavailable in this candle dataset.','Fees and funding are declared scenarios, not historical account receipts.','Independent strategy streams are NOT additive portfolio returns.','Higher timeframe intrabar order is unknown; adverse stop-first assumption.','Exit variants use sampled closes and do not prove executable profit.']};
const meta={symbol:'PF_XBTUSD',qty_step:.0001,tick_size:1,margin_schedule:[{numNonContractUnits:0,initialMargin:.1,maintenanceMargin:.05},{numNonContractUnits:30000000}],margin_schedule_source:'DECLARED_PUBLIC_REFERENCE_FOR_RESEARCH'};
const contexts={1:5,5:15,15:60,60:240,240:1440},report={protocol,data_manifest:manifest,results:{},rejections:{},generated_at:new Date().toISOString()},allPaths=[];
for(const tf of [1,5,15,60,240]){
 const rows=series[tf],context=series[contexts[tf]],trades={},nextEligible={},rejects={};let ci=0,signalCount=0;
 for(let i=255;i<rows.length-1;i++){
  const cutoff=rows[i].end,now=cutoff+2000;while(ci<context.length&&context[ci].end<=cutoff)ci++;
  if(ci<64)continue;
  const bars=rows.slice(Math.max(0,i-255),i+1),s={[tf]:bars,[contexts[tf]]:context.slice(Math.max(0,ci-256),ci)},px=rows[i+1].open,half=px*protocol.assumed_spread_fraction/2;
  const q={source:'KRAKEN_FUTURES_WS_TICKER',symbol:'PF_XBTUSD',event_at:now,received_at:now,bid:String(px-half),ask:String(px+half),bid_qty:'1000000',ask_qty:'1000000',mark_price:String(px),research_assumption:true,observed_quote:false};
  meta.checked_at=now;
  const options={timeframe:tf,contextTimeframe:contexts[tf],timeframeVersion:'secondary-timeframes-2.0.0'},funding=px*protocol.assumed_adverse_funding_fraction_per_hour;
  const decisions=[...quantCandidates(s,q,meta,cutoff,now,funding,EXPLORATION_POLICY,tf<=5?researchProfitPolicy:EARLY_PROFIT_POLICY,options),...entryCandidates(s,q,meta,cutoff,now,funding,EXPLORATION_POLICY,EARLY_PROFIT_POLICY,options)];
  for(const d of decisions){
   const key=d.pattern;rejects[key]??={};
   if(!d.plan){rejects[key][d.reason]=(rejects[key][d.reason]??0)+1;continue;}
   if((nextEligible[key]??0)>cutoff)continue;
   const p=d.plan,e=evaluateEntryEconomics(p,{quote:q,qty:'1',now});
   if(!e.accepted){rejects[key][e.reason]=(rejects[key][e.reason]??0)+1;continue;}
   const unitLoss=Number(e.expected_loss_stop)+Number(p.entry)*.0005,qty=Math.floor(Math.min(5/unitLoss,600/Number(p.entry))/.0001)*.0001;
   if(!(qty>0))continue;
   const sign=p.direction==='LONG'?1:-1,entry=Number(p.entry),entryFee=entry*qty*.0005,expiry=cutoff+p.holding_ms;
   const value=(price,at)=>{const effective=(price-sign*price*protocol.assumed_spread_fraction/2)*(1-sign*.0002),gross=sign*(effective-entry)*qty,costs=entryFee+effective*qty*.0005+funding*qty*(at-cutoff)/3600000;return {net:gross-costs,gross,costs,effective};};
   const samples=[];let closed=null,mfe=0,mae=0;
   for(let j=i+1;j<rows.length;j++){
    const b=rows[j],stopHit=sign>0?b.low<=Number(p.stop):b.high>=Number(p.stop),targetHit=sign>0?b.high>=Number(p.target):b.low<=Number(p.target),net=value(b.close,b.end).net;
    // Favorable extremes are NOT executed; they are only excursion diagnostics.
    mfe=Math.max(mfe,value(sign>0?b.high:b.low,b.end).net);mae=Math.min(mae,value(sign>0?b.low:b.high,b.end).net);samples.push({at:b.end,net});
    if(stopHit){const stop=sign>0?Math.min(b.open,Number(p.stop)):Math.max(b.open,Number(p.stop));closed={...value(stop,b.end),at:b.end,reason:targetHit?'AMBIGUOUS_STOP_FIRST':'STOP'};break;}
    if(targetHit){closed={...value(Number(p.target),b.end),at:b.end,reason:'TARGET'};break;}
    if(b.end>=expiry){closed={...value(b.close,b.end),at:b.end,reason:'TIMEOUT'};break;}
   }
   if(closed&&samples.length)samples.at(-1).net=closed.net;
   if(!closed){rejects[key].RIGHT_CENSORED=(rejects[key].RIGHT_CENSORED??0)+1;continue;}
   const row={id:p.id,start:cutoff,end:closed.at,strategy:key,timeframe:tf,fibonacci_policy:p.quant_contract?.fibonacci?.policy_hash??'NONE',fibonacci_target_limited:d.facts?.fibonacci?.target_limited??false,fibonacci_confluence:d.facts?.fibonacci?.confluence??false,regime:p.quant_contract?.regime??d.facts?.regime??'UNKNOWN',direction:p.direction,qty,entry,target:Number(p.target),stop:Number(p.stop),net:closed.net,gross:closed.gross,costs:closed.costs,initial_risk:unitLoss*qty,mfe,mae,excursion_basis:'OHLC_BOUNDS_NOT_OBSERVED_ORDERED_PATH',holding_ms:closed.at-cutoff,reason:closed.reason,final:true,quality:'CANDLE_SCENARIO_NOT_EXECUTION_VALIDATED',cost_stress_150_net:closed.net-.5*closed.costs,cost_stress_200_net:closed.net-closed.costs};
   (trades[key]??=[]).push(row);nextEligible[key]=closed.at;signalCount++;
   allPaths.push({id:p.id,target_net:Number(e.expected_net_target)*qty,original_net:row.net,samples,final:true,quality:row.quality});
  }
  if(i%5000===0)console.log(JSON.stringify({timeframe:tf,evaluated:i,candidates:signalCount}));
 }
 report.rejections[tf]=rejects;
 report.results[tf]={};
 for(const [strategy,rs] of Object.entries(trades)){
  const splits=walkForwardSplits(rs,{folds:3,embargoMs:tf*60000}),folds=splits.map(s=>({train:s.train.length,test:s.test.length,purged:s.purged,test_start:s.test_start,...quantitativeMetrics(s.test.map(i=>rs[i]))}));
  const holdoutStart=Math.floor(rs.length*.8),holdout=rs.slice(holdoutStart),metrics=quantitativeMetrics(holdout),bootstrap=blockBootstrap(holdout.map(x=>x.net));
  report.results[tf][strategy]={all:quantitativeMetrics(rs),holdout_fraction:.2,holdout:metrics,bootstrap,walk_forward:folds,cost_stress:{net_150:rs.reduce((s,x)=>s+x.cost_stress_150_net,0),net_200:rs.reduce((s,x)=>s+x.cost_stress_200_net,0),scope:'CONDITIONAL_ON_BASELINE_ENTRIES_FEES_FUNDING_ONLY'},promotion:promotionDecision({metrics,bootstrap,walkForward:folds,liveCount:0,costStressPositive:false,contractDataComplete:false,trialCount:60}),trades:rs};
 }
 console.log(JSON.stringify({timeframe:tf,completed:true,trades:signalCount}));
}
report.exit_comparison=compareExitPaths(allPaths,{partialExtraCost:.02});
// The full path is retained separately to reproduce alternative thresholds without
// pretending an OHLC interpolation is a sequence of executable market quotes.
await writeFile(args.output,JSON.stringify(report,null,2));
await writeFile(args.output.replace(/\.json$/,'.paths.json'),JSON.stringify(allPaths));
console.log(JSON.stringify({output:args.output,version:protocol.version,profitability_validated:false}));
