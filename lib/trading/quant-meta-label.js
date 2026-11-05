// Fixed-protocol external baseline. Models remain research artifacts, never an
// authority to alter risk, leverage, execution or the worker's deterministic path.
import {hash} from './core.js';
import {calibration,quantitativeMetrics,blockBootstrap} from './quant-evaluation.js';
import {requireExternalResearch} from './quant-experiments.js';
import {validateQuantContract} from './quant-strategies.js';
export const QUANT_META_VERSION='secondary-quant-net-meta-1.1.0';
export const META_FEATURES=Object.freeze(['rsi14','adx','plus_di','minus_di','atr_relative','atr_ratio','relative_volume','efficiency','normalized_slope','ema_separation_atr','return_volatility','microstructure.spread_bps','microstructure.imbalance','cycles.hour_sin','cycles.hour_cos','cycles.week_sin','cycles.week_cos','public_analytics.flow_imbalance','public_analytics.open_interest_change']);
const numeric=x=>x!=null&&typeof x!=='boolean'&&String(x).trim()!==''&&Number.isFinite(Number(x));
const feature=(f,key)=>{const x=key.split('.').reduce((v,k)=>v?.[k],f);return numeric(x)?Number(x):null;};
const sigmoid=x=>1/(1+Math.exp(-Math.max(-30,Math.min(30,x))));
const logit=p=>Math.log(Math.max(1e-8,p)/Math.max(1e-8,1-p));
const mean=x=>x.reduce((s,n)=>s+n,0)/x.length;
function fit(x,y,{iterations=400,l2=.01}={}){
 const w=Array(x[0].length).fill(0);let bias=logit(mean(y));
 for(let i=0;i<iterations;i++){const g=Array(w.length).fill(0);let gb=0;for(let k=0;k<x.length;k++){const error=sigmoid(bias+w.reduce((s,n,j)=>s+n*x[k][j],0))-y[k];gb+=error;for(let j=0;j<w.length;j++)g[j]+=error*x[k][j];}bias-=.05*gb/x.length;for(let j=0;j<w.length;j++)w[j]-=.05*(g[j]/x.length+l2*w[j]);}
 return {weights:w,bias};
}
const predict=(model,x)=>sigmoid(model.bias+model.weights.reduce((s,n,j)=>s+n*x[j],0));
export function quantMetaDataset(events){
 const rows=[],excluded={};const seen=new Map(),reject=reason=>{excluded[reason]=(excluded[reason]??0)+1;};
 for(const e of events){
  if(e.type!=='CLOSED')continue;const p=e.plan,f=p?.quant_contract?.features;
  if(!p?.quant_contract||!f){reject('QUANT_FEATURE_SNAPSHOT_REQUIRED');continue;}
  try{validateQuantContract(p);}catch{reject('QUANT_CONTRACT_INTEGRITY');continue;}
  if(e.ledger!=='FREQUENT_PAPER'||p.instrument!=='PAPER:KRAKEN_FUTURES:PF_XBTUSD'||p.execution_contract?.realTrading!==false){reject('PAPER_DOMAIN_REQUIRED');continue;}
  if(e.quality!=='OBSERVED'||e.result_final!==true||e.funding_complete!==true||e.management_override||e.data_gaps?.length){reject('FINAL_UNAMBIGUOUS_AUTOMATED_RESULT_REQUIRED');continue;}
  if(!Number.isSafeInteger(f.cutoff)||!Number.isSafeInteger(p.decision_at)||!Number.isSafeInteger(e.entered_at)||!Number.isSafeInteger(e.at)||f.cutoff>p.decision_at||p.decision_at>e.entered_at||e.entered_at>=e.at||f.status!=='READY'||!numeric(e.pnl)){reject('CAUSAL_FEATURE_AND_LABEL_TIME_REQUIRED');continue;}
  const row={id:e.id,start:p.decision_at,end:e.at,net:Number(e.pnl),label:Number(e.pnl)>0?1:0,features:META_FEATURES.map(key=>feature(f,key)),domain:hash([p.quant_contract.version,f.version,p.pattern,p.timeframe,p.exit_policy?.hash,p.execution_contract?.policy_hash,p.quant_contract.fibonacci?.policy_hash??null,p.quant_contract.opportunities?.policy_hash??null,p.quant_contract.active_experiment?.policy_hash??null,p.execution_repair?.policy_hash??null]),strategy:p.pattern,timeframe:p.timeframe,regime:p.quant_contract.regime,quality:e.quality,final:true};
  if(seen.has(e.id)){if(seen.get(e.id)!==hash(row))throw Error('CONFLICTING_OPERATION_LABEL');reject('DUPLICATE');continue;}seen.set(e.id,hash(row));rows.push(row);
 }
 rows.sort((a,b)=>a.start-b.start||a.id.localeCompare(b.id));return {rows,excluded,source_hash:hash(rows),label:'FINAL_REALIZED_NET_POSITIVE_NOT_TP_BEFORE_SL'};
}
export function evaluateQuantMeta(rows,{embargoMs=3600000,walkForward=true}={}){
 requireExternalResearch();if(!Number.isSafeInteger(embargoMs)||embargoMs<0)throw Error('META_EMBARGO_INVALID');
 if(!Array.isArray(rows)||rows.some(r=>typeof r.id!=='string'||!Number.isSafeInteger(r.start)||!Number.isSafeInteger(r.end)||r.end<=r.start||!numeric(r.net)||![0,1].includes(r.label)||r.label!==(Number(r.net)>0?1:0)||typeof r.domain!=='string'||!Array.isArray(r.features)||r.features.length!==META_FEATURES.length||r.features.some(v=>v!==null&&!Number.isFinite(v)))||new Set(rows.map(r=>r.id)).size!==rows.length)throw Error('META_DATASET_INVALID');
 const base={version:QUANT_META_VERSION,authority:'RESEARCH_ONLY',automatic_promotion:false,execution_authority:'NONE',label:'FINAL_REALIZED_NET_POSITIVE_NOT_TP_BEFORE_SL',features:[...META_FEATURES],observations:rows.length,source_hash:hash(rows),embargo_ms:embargoMs};
 if(rows.length<300)return {...base,status:'INSUFFICIENT_DATA',minimum_observations:300,model:null};
 if(new Set(rows.map(x=>x.domain)).size!==1)throw Error('META_SINGLE_DOMAIN_REQUIRED');
 const ordered=[...rows].sort((a,b)=>a.start-b.start),i=Math.floor(rows.length*.6),j=Math.floor(rows.length*.8),calStart=ordered[i].start,testStart=ordered[j].start;
 const train=ordered.slice(0,i).filter(r=>r.end<calStart-embargoMs),cal=ordered.slice(i,j).filter(r=>r.end<testStart-embargoMs),test=ordered.slice(j),splits={train:train.length,calibration:cal.length,test:test.length,purged:i-train.length+j-i-cal.length,calibration_start:calStart,test_start:testStart};
 if(train.length<100||cal.length<40||test.length<50||[train,cal,test].some(rs=>Math.min(rs.filter(r=>r.label===1).length,rs.filter(r=>r.label===0).length)<10))return {...base,status:'INSUFFICIENT_TEMPORAL_CLASS_COVERAGE',splits,model:null};
 // Fit imputation and scaling on training only. Missingness stays explicit.
 const preprocessing=META_FEATURES.map((_,k)=>{const a=train.map(r=>r.features[k]).filter(x=>x!==null),center=a.length?mean(a):0,scale=a.length?Math.sqrt(mean(a.map(x=>(x-center)**2))):1;return {mean:center,scale:scale>1e-12?scale:1,observed:a.length};});
 const vector=r=>[...r.features.map((v,k)=>v===null?0:Math.max(-8,Math.min(8,(v-preprocessing[k].mean)/preprocessing[k].scale))),...r.features.map(v=>v===null?1:0)];
 const model=fit(train.map(vector),train.map(r=>r.label)),raw=rs=>rs.map(r=>predict(model,vector(r))),calProb=raw(cal),platt=fit(calProb.map(p=>[logit(p)]),cal.map(r=>r.label),{l2:.01});
 const testRaw=raw(test),testProb=testRaw.map(p=>predict(platt,[logit(p)])),labels=test.map(r=>r.label),baselineProbability=mean(train.map(r=>r.label));
 const selected=test.filter((_,k)=>testProb[k]>=.5),calibrated=calibration(labels,testProb),baseline=calibration(labels,labels.map(()=>baselineProbability));
 const artifact={version:QUANT_META_VERSION,domain:rows[0].domain,features:[...META_FEATURES],preprocessing,logistic:model,platt,trained_through:Math.max(...cal.map(r=>r.end)),source_hash:base.source_hash,authority:'RESEARCH_ONLY',risk_control_authority:false};
 const walk_forward=walkForward?[.6,.8,1].map(fraction=>{const r=evaluateQuantMeta(ordered.slice(0,Math.floor(ordered.length*fraction)),{embargoMs,walkForward:false});return {prefix_fraction:fraction,status:r.status,splits:r.splits??null,trained_through:r.model?.trained_through??null,baseline_brier:r.baseline?.brier??null,calibrated_brier:r.calibrated?.brier??null,selected_net:r.selected_net??null};}):[];
 return {...base,status:'EVALUATED_NOT_PROMOTED',splits,walk_forward,baseline,uncalibrated:calibration(labels,testRaw),calibrated,beats_constant_brier:calibrated.brier<baseline.brier,baseline_net:quantitativeMetrics(test),selected_net:quantitativeMetrics(selected),selected_bootstrap:blockBootstrap(selected.map(r=>r.net)),threshold:.5,threshold_tuned:false,model:{...artifact,hash:hash(artifact)},prediction_count:test.length,limitations:['Expanding fixed temporal windows and final chronological holdout are not independent replications; new prospective evidence is required.','A positive-net probability depends on the signed exit policy and is not a TP-before-SL probability.','Model cannot modify the operational worker or trade.']};
}
