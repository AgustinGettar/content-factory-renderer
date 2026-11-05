// External quantitative evaluation primitives. Never train/tune on the worker.
import {hash} from './core.js';
import {mean,stdev} from './quant-features.js';
const finite=x=>x!=null&&typeof x!=='boolean'&&String(x).trim()!==''&&Number.isFinite(Number(x));
export function quantitativeMetrics(rows,{initialEquity=1000,dailyEquity=[]}={}){
 const eligible=rows.filter(x=>x.final!==false&&!['UNRESOLVED','UNRESOLVED_MARKET_GAP','FUNDING_GAP'].includes(x.quality)&&finite(x.net));
 if(eligible.every(x=>Number.isSafeInteger(x.end)))eligible.sort((a,b)=>a.end-b.end);
 const net=eligible.map(x=>Number(x.net)),wins=net.filter(x=>x>0),losses=net.filter(x=>x<0),total=net.reduce((a,b)=>a+b,0);
 let equity=initialEquity,peak=equity,drawdown=0,maxDrawdownUSD=0;for(const n of net){equity+=n;peak=Math.max(peak,equity);maxDrawdownUSD=Math.max(maxDrawdownUSD,peak-equity);drawdown=Math.max(drawdown,peak>0?(peak-equity)/peak:0);}
 const sum=a=>a.reduce((a,b)=>a+b,0),positive=sum(wins),negative=-sum(losses),returns=[];
 const ordered=[...dailyEquity].sort((a,b)=>a.at-b.at),marksValid=ordered.every(x=>Number.isSafeInteger(x.at)&&x.at%86400000===0&&finite(x.equity)&&Number(x.equity)>0);
 if(marksValid)for(let i=1;i<ordered.length;i++)if(ordered[i].at-ordered[i-1].at===86400000)returns.push(ordered[i].equity/ordered[i-1].equity-1);
 const periodicityValid=ordered.length>=3&&returns.length===ordered.length-1,sd=stdev(returns),downside=returns.length?Math.sqrt(mean(returns.map(x=>Math.min(0,x)**2))):null,annual=periodicityValid?(ordered.at(-1).equity/ordered[0].equity)**(365/returns.length)-1:null;
 let dailyPeak=0,dailyDrawdown=0;if(periodicityValid)for(const x of ordered){dailyPeak=Math.max(dailyPeak,Number(x.equity));dailyDrawdown=Math.max(dailyDrawdown,(dailyPeak-Number(x.equity))/dailyPeak);}
 const gross=eligible.filter(x=>finite(x.gross)).reduce((s,x)=>s+Number(x.gross),0),costs=eligible.filter(x=>finite(x.costs)).reduce((s,x)=>s+Number(x.costs),0);
 const groups={};for(const dimension of ['strategy','regime','timeframe','fibonacci_policy']){groups[dimension]={};for(const r of eligible){const key=String(r[dimension]??'UNKNOWN'),g=groups[dimension][key]??={count:0,net:0,wins:0,losses:0,costs:0};g.count++;g.net+=Number(r.net);g.wins+=Number(r.net)>0?1:0;g.losses+=Number(r.net)<0?1:0;g.costs+=Number(r.costs??0);}}
 return {version:'secondary-quant-metrics-1.0.0',observations:rows.length,eligible:net.length,excluded:rows.length-net.length,net_realized:total,win_rate:net.length?wins.length/net.length:null,profit_factor:negative>0?positive/negative:null,profit_factor_status:negative>0?'DEFINED':positive>0?'NO_LOSSES_IN_SAMPLE':'NO_RESULTS',expectancy:mean(net),payoff_ratio:losses.length&&wins.length?mean(wins)/-mean(losses):null,mean_r_multiple:mean(eligible.filter(x=>finite(x.initial_risk)&&Number(x.initial_risk)>0).map(x=>Number(x.net)/Number(x.initial_risk))),max_closed_equity_drawdown:drawdown,max_closed_equity_drawdown_usd:maxDrawdownUSD,mean_mfe:mean(eligible.filter(x=>finite(x.mfe)).map(x=>Number(x.mfe))),mean_mae:mean(eligible.filter(x=>finite(x.mae)).map(x=>Number(x.mae))),average_holding_ms:mean(eligible.filter(x=>finite(x.holding_ms)).map(x=>Number(x.holding_ms))),costs,gross,costs_to_positive_gross:gross>0?costs/gross:null,
 sharpe:periodicityValid&&sd>0?mean(returns)/sd*Math.sqrt(365):null,sortino:periodicityValid&&downside>0?mean(returns)/downside*Math.sqrt(365):null,calmar:annual!=null&&Number.isFinite(annual)&&dailyDrawdown>0?annual/dailyDrawdown:null,max_daily_equity_drawdown:periodicityValid?dailyDrawdown:null,calmar_basis:'GEOMETRIC_ANNUAL_RETURN_AND_DRAWDOWN_SAME_DAILY_EQUITY_WINDOW',recovery_factor:maxDrawdownUSD>0?total/maxDrawdownUSD:null,annualization:365,return_period:'UTC_DAILY_EQUITY',periodicity_valid:periodicityValid,groups,statistically_validated:false};
}
function rng(seed=42){let x=seed>>>0;return ()=>{x=(Math.imul(x,1664525)+1013904223)>>>0;return x/4294967296;};}
export function quantile(values,p){if(!values.length)return null;const a=[...values].sort((a,b)=>a-b),i=(a.length-1)*p,l=Math.floor(i);return a[l]+(a[Math.ceil(i)]-a[l])*(i-l);}
export function blockBootstrap(values,{blockSize=5,iterations=1000,seed=42}={}){
 if(values.length<Math.max(20,blockSize*4)||values.some(x=>!Number.isFinite(x)))return {status:'INSUFFICIENT_DATA',mean_ci95:null};
 if(!Number.isSafeInteger(blockSize)||blockSize<1||!Number.isSafeInteger(iterations)||iterations<100||iterations>10000)throw Error('BOOTSTRAP_PARAMETERS_INVALID');
 const random=rng(seed),means=[],drawdowns=[];for(let i=0;i<iterations;i++){const sample=[];while(sample.length<values.length){const start=Math.floor(random()*values.length);for(let j=0;j<blockSize&&sample.length<values.length;j++)sample.push(values[(start+j)%values.length]);}means.push(mean(sample));let equity=0,peak=0,dd=0;for(const x of sample){equity+=x;peak=Math.max(peak,equity);dd=Math.max(dd,peak-equity);}drawdowns.push(dd);}
 return {status:'ESTIMATED_NOT_PROOF',method:'CIRCULAR_BLOCK_BOOTSTRAP',observations:values.length,blockSize,iterations,seed,mean_ci95:[quantile(means,.025),quantile(means,.975)],drawdown_usd_p95:quantile(drawdowns,.95),probability_mean_nonpositive:means.filter(x=>x<=0).length/iterations};
}
export function walkForwardSplits(rows,{folds=3,embargoMs=0}={}){
 if(rows.length<folds*4||!Number.isSafeInteger(folds)||folds<1||embargoMs<0)return [];
 const ordered=rows.map((r,i)=>({...r,index:i})).sort((a,b)=>a.start-b.start);if(ordered.some(r=>!Number.isSafeInteger(r.start)||!Number.isSafeInteger(r.end)||r.end<r.start))throw Error('LABEL_TIME_INVALID');
 const size=Math.floor(ordered.length/(folds+1)),out=[];
 for(let f=1;f<=folds;f++){const test=ordered.slice(f*size,f===folds?undefined:(f+1)*size),first=test[0].start;const train=ordered.slice(0,f*size).filter(r=>r.end<first-embargoMs);out.push({train:train.map(x=>x.index),test:test.map(x=>x.index),test_start:first,embargo_ms:embargoMs,purged:f*size-train.length});}return out;
}
export function correlation(a,b){if(a.length!==b.length||a.length<3)return null;const ma=mean(a),mb=mean(b),s=a.reduce((s,x,i)=>s+(x-ma)*(b[i]-mb),0),den=Math.sqrt(a.reduce((s,x)=>s+(x-ma)**2,0)*b.reduce((s,x)=>s+(x-mb)**2,0));return den?s/den:null;}
export function calibration(labels,probabilities,bins=10){
 if(labels.length!==probabilities.length||!labels.length||labels.some(x=>x!==0&&x!==1)||probabilities.some(x=>!finite(x)||x<0||x>1))return {status:'UNAVAILABLE'};
 const bucket=Array.from({length:bins},(_,i)=>({lower:i/bins,upper:(i+1)/bins,count:0,predicted:0,observed:0}));let brier=0;labels.forEach((y,i)=>{const p=Number(probabilities[i]),b=bucket[Math.min(bins-1,Math.floor(p*bins))];b.count++;b.predicted+=p;b.observed+=y;brier+=(p-y)**2;});
 return {status:'MEASURED',count:labels.length,brier:brier/labels.length,bins:bucket.filter(b=>b.count).map(b=>({...b,predicted:b.predicted/b.count,observed:b.observed/b.count}))};
}
// Replay sampled NET paths: all fragments are proportional quantities; incremental
// extra execution costs are explicit. Gaps/missing future ticks are not filled in.
export function compareExitPaths(paths,{activation=.10,retracement=.25,breakEvenPlus=.05,partialExtraCost=0}={}){
 const variants=['ORIGINAL','EARLY_PROTECTION','MFE_TRAILING','BREAK_EVEN_PLUS','SCALE_OUT_30_30_40','MOMENTUM_EXIT'],results=Object.fromEntries(variants.map(k=>[k,[]]));
 for(const p of paths){if(!Array.isArray(p.samples)||!p.samples.length||p.samples.some(x=>!finite(x.net))||!finite(p.original_net)||!finite(p.target_net)||Number(p.target_net)<=0)continue;
  for(const variant of variants){let peak=0,floor=null,remaining=1,realized=0,closed=false,stage=0;
   for(const x of p.samples){const net=Number(x.net);peak=Math.max(peak,net);
    if(variant==='ORIGINAL')continue;
    if(variant==='MOMENTUM_EXIT'&&x.exhausted===true&&net>breakEvenPlus){realized=net;closed=true;break;}
    if(['EARLY_PROTECTION','MFE_TRAILING','BREAK_EVEN_PLUS'].includes(variant)){
     if(floor!=null&&net<=floor){realized=net;closed=true;break;}
     if(peak>=activation){const next=variant==='BREAK_EVEN_PLUS'?breakEvenPlus:variant==='EARLY_PROTECTION'?Math.max(breakEvenPlus,peak*.5):Math.max(breakEvenPlus,peak*(1-retracement));floor=Math.max(floor??-Infinity,next);}
    }
    if(variant==='SCALE_OUT_30_30_40'){
     if(stage===0&&net>=Number(p.target_net)*.5){realized+=.3*net-partialExtraCost;remaining-=.3;stage=1;}
     if(stage===1&&net>=Number(p.target_net)){realized+=.3*net-partialExtraCost;remaining-=.3;stage=2;}
     if(stage&&net<=peak*(1-retracement)){realized+=remaining*net-partialExtraCost;remaining=0;closed=true;break;}
    }
   }
   if(!closed)realized+=remaining*Number(p.original_net);
   results[variant].push({id:p.id,net:realized,final:p.final!==false,quality:p.quality,reference_net:Number(p.original_net),sample_path_only:true});
  }
 }
 return {version:'secondary-exit-comparison-1.0.0',source:'SUPPLIED_NET_PATH_SAMPLES',execution_validated:false,limitations:['Sampling can miss intrabar peaks and adverse moves.','No order-book replay or guaranteed fills.','Scale-out includes explicit additional cost assumption.'],parameters:{activation,retracement,breakEvenPlus,partialExtraCost},variants:Object.fromEntries(Object.entries(results).map(([k,rows])=>[k,{...quantitativeMetrics(rows),bootstrap:blockBootstrap(rows.map(x=>x.net)),rows}]))};
}
export function promotionDecision({metrics,bootstrap,walkForward,liveCount=0,costStressPositive=false,contractDataComplete=false,trialCount=1}){
 const reasons=[];if((metrics?.eligible??0)<100)reasons.push('AT_LEAST_100_FINAL_OOS_TRADES_REQUIRED');if(!(bootstrap?.mean_ci95?.[0]>0))reasons.push('EXPECTANCY_CONFIDENCE_NOT_POSITIVE');if(!walkForward?.length||walkForward.some(f=>!(f.expectancy>0)))reasons.push('WALK_FORWARD_NOT_CONSISTENT');if(liveCount<30)reasons.push('FORWARD_PAPER_SAMPLE_REQUIRED');if(!costStressPositive)reasons.push('COST_STRESS_NOT_PASSED');if(!contractDataComplete)reasons.push('EXECUTION_DATA_INCOMPLETE');if(trialCount>1)reasons.push('MULTIPLE_TESTING_INDEPENDENT_HOLDOUT_REQUIRED');
 return {decision:reasons.length?'RESEARCH_ONLY':'ELIGIBLE_FOR_HUMAN_REVIEW',reasons,automatic_promotion:false,guaranteed_profit:false};
}
export function recordQuantOutcome(root,event){
 if(!root.secondaryExecution?.quant||!['CLOSED','FUNDING_RECONCILED'].includes(event.type))return;
 const s=root.secondaryExecution.quant,rows=s.outcomes??=[];
 if(event.type==='FUNDING_RECONCILED'){const r=rows.find(x=>x.id===event.id);if(r){r.net=Number(event.net_after);r.costs-=Number(event.net_adjustment??0);r.final=event.funding_complete===true;s.metrics=quantitativeMetrics(rows,{initialEquity:Number(s.baseline.equity),dailyEquity:s.daily_equity??[]});}return;}
 if(rows.some(x=>x.id===event.id))return;
 rows.push({id:event.id,start:event.entered_at,end:event.at,net:Number(event.pnl),gross:Number(event.gross),costs:Number(event.fees),initial_risk:Number(event.plan?.sizing?.risk),mfe:Number(event.excursions?.max_favourable_net??0),mae:Number(event.excursions?.max_adverse_net??0),holding_ms:event.at-event.entered_at,strategy:event.plan?.pattern,regime:event.plan?.quant_contract?.regime??'LEGACY_UNKNOWN',timeframe:event.plan?.timeframe,final:event.result_final===true,quality:event.quality,model:event.plan?.quant_contract?.version??'LEGACY',execution_repair:event.plan?.execution_repair?.version??'NONE',active_policy:event.plan?.quant_contract?.active_experiment?.policy_hash??'NONE',fibonacci_policy:event.plan?.quant_contract?.fibonacci?.policy_hash??'NONE'});
 if(rows.length>2000)rows.splice(0,rows.length-2000);s.metrics=quantitativeMetrics(rows,{initialEquity:Number(s.baseline.equity),dailyEquity:s.daily_equity??[]});s.metrics.window='MOST_RECENT_2000_FINAL_OR_PENDING_OUTCOMES';s.metrics.source_hash=hash(rows);
}
