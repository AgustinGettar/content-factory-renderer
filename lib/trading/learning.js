// Prospective prediction learning only. Never changes cash, orders or risk.
import {D,hash,POLICY} from './core.js';
import {bootstrapDifference} from './research.js';
export const LEARNING_VERSION='lumi-learning-1.0.0';
export const LEARNING_PROTOCOL=Object.freeze({version:LEARNING_VERSION,event:'NET_POSITIVE_AT_CLOSE',minTraining:100,minClass:20,minValidation:200,minValidationDays:30,maxValidation:1000,maxTraining:500,newLabelsPerAttempt:100,maxAttempts:6,purgeMs:86400000,maxModelAgeMs:90*86400000,minBin:40,maxIntervalWidth:.20,maxECE:.10,alpha:.05,iterations:400,learningRate:.08,l2:.02,realTrading:false,changesEntryRules:false});
const clip=(n,lo,hi)=>Math.max(lo,Math.min(hi,n));
const logistic=z=>1/(1+Math.exp(-clip(z,-30,30)));
const day=t=>new Date(t).toISOString().slice(0,10);
const supported=l=>['ENGINE','FREQUENT_PAPER'].includes(l);
const groupKey=(ledger,version)=>ledger+':'+version;
export function initializeLearning(state,now){
 if(state.learning){if(state.learning.version!==LEARNING_VERSION||state.learning.protocol_hash!==hash(LEARNING_PROTOCOL))throw Error('LEARNING_PROTOCOL_MISMATCH');return null;}
 state.learning={version:LEARNING_VERSION,started_at:now,protocol:{...LEARNING_PROTOCOL},protocol_hash:hash(LEARNING_PROTOCOL),groups:{}};
 return {type:'LEARNING_ENABLED',at:now,version:LEARNING_VERSION,protocol_hash:state.learning.protocol_hash};
}
function group(state,ledger,version){
 const key=groupKey(ledger,version);return state.groups[key]??=( {ledger,version,status:'COLLECTING',usable:0,excluded:0,unfilled:0,exclusions:{},attempts:0,lastAttemptLabels:0,pending:{},seen:[],rows:[],active:null,candidate:null,history:[],lastAnalysis:null} );
}
export function entryFeatures(plan,bars,quote,now){
 const closed=(bars??[]).filter(b=>b.end<=plan.confirmed_at&&b.available_at<=now).slice(-60);
 if(closed.length<21||closed.at(-1).end!==plan.confirmed_at)return null;
 const b=closed.at(-1),atr=+plan.atr1,p=+b.close;
 if(!(atr>0&&p>0&&+quote?.ask>0&&+quote?.bid>0))return null;
 const mean=n=>closed.slice(-n).reduce((s,x)=>s+ +x.close,0)/n;
 // Fixed causal scaling, not fitted on future data. Volatility/price, momentum,
 // trend, candle shape, spread, costs and reward/risk define the entry context.
 const x=[1,(mean(9)-mean(21))/atr,(p-closed.at(-6).close)/atr,(p-b.open)/atr,(b.high-b.low)/atr,atr/p*1000,(+quote.ask-quote.bid)/p*10000,(+plan.limit-plan.stop)/p*100,(+plan.target-plan.limit)/p*100,+POLICY.fee*100];
 if(x.some(v=>!Number.isFinite(v)))return null;
 return {at:now,cutoff:plan.confirmed_at,x:x.map((v,i)=>i?clip(v,-5,5):1),input_hash:hash(closed),feature_version:1};
}
export function fitModel(rows,now,id){
 if(rows.length<LEARNING_PROTOCOL.minTraining||rows.some(r=>r.at>now||r.entryAt>r.at))throw Error('INVALID_TRAINING_WINDOW');
 const n=rows.length,d=rows[0].x.length,prior=(rows.reduce((s,r)=>s+r.y,0)+1)/(n+2),w=Array(d).fill(0);w[0]=Math.log(prior/(1-prior));
 for(let t=0;t<LEARNING_PROTOCOL.iterations;t++){
  const gradient=Array(d).fill(0);
  for(const r of rows){const error=logistic(w.reduce((s,v,i)=>s+v*r.x[i],0))-r.y;for(let i=0;i<d;i++)gradient[i]+=error*r.x[i]/n;}
  for(let i=0;i<d;i++)w[i]-=LEARNING_PROTOCOL.learningRate*(gradient[i]+(i?LEARNING_PROTOCOL.l2*w[i]:0));
 }
 return {id,w,prior,trained_at:now,train_n:n,train_last_at:Math.max(...rows.map(r=>r.at)),train_hash:hash(rows),bounds:w.map((_,i)=>[Math.min(...rows.map(r=>r.x[i])),Math.max(...rows.map(r=>r.x[i]))])};
}
export function score(model,x){return clip(logistic(model.w.reduce((s,w,i)=>s+w*x[i],0)),.01,.99);}
export function wilson(wins,n){if(!n)return [0,1];const z=1.96,p=wins/n,den=1+z*z/n,c=(p+z*z/(2*n))/den,r=z*Math.sqrt(p*(1-p)/n+z*z/(4*n*n))/den;return [Math.max(0,c-r),Math.min(1,c+r)];}
const bucket=p=>Math.min(4,Math.floor(p*5));
const logloss=(y,p)=>-y*Math.log(p)-(1-y)*Math.log(1-p);
export function validationReport(candidate,now,attempts){
 const rows=candidate.validation,n=rows.length,g=LEARNING_PROTOCOL;
 const wins=rows.reduce((s,r)=>s+r.y,0),days=[...new Set(rows.map(r=>day(r.at)))].sort();
 if(n<g.minValidation||wins<g.minClass||n-wins<g.minClass||days.length<g.minValidationDays)return {status:'VALIDATING',n,days:days.length,reason:'MORE_PROSPECTIVE_OUTCOMES'};
 const brier=rows.reduce((s,r)=>s+(r.p-r.y)**2,0)/n,baselineBrier=rows.reduce((s,r)=>s+(r.base-r.y)**2,0)/n;
 const ll=rows.reduce((s,r)=>s+logloss(r.y,r.p),0)/n,baselineLogLoss=rows.reduce((s,r)=>s+logloss(r.y,r.base),0)/n;
 const bins=Array.from({length:5},(_,i)=>{const rr=rows.filter(r=>bucket(r.p)===i),count=rr.length,w=rr.reduce((s,r)=>s+r.y,0);return {bin:i,n:count,wins:w,rate:count?w/count:null,mean:count?rr.reduce((s,r)=>s+r.p,0)/count:null,interval:wilson(w,count)};});
 const ece=bins.reduce((s,b)=>s+(b.n?b.n/n*Math.abs(b.rate-b.mean):0),0);
 const daily=days.map(d=>{const rr=rows.filter(r=>day(r.at)===d);return rr.reduce((s,r)=>s+(r.base-r.y)**2-(r.p-r.y)**2,0)/rr.length;});
 const ci=bootstrapDifference(Array(days.length).fill(0),daily,{block:7,reps:2000,alpha:g.alpha/g.maxAttempts});
 const eligible=bins.some(b=>b.n>=g.minBin&&b.interval[1]-b.interval[0]<=g.maxIntervalWidth);
 const pass=eligible&&ci?.lower>0&&brier<baselineBrier&&ll<baselineLogLoss&&ece<=g.maxECE;
 return {status:pass?'VALIDATED':'REJECTED',n,days:days.length,brier,baselineBrier,logLoss:ll,baselineLogLoss,ece,ci,bins,at:now,attempts,reason:pass?'PROSPECTIVE_PREDICTION_GATES':'NO_RELIABLE_PREDICTIVE_IMPROVEMENT'};
}
export function publishedPrediction(g,features,now){
 const m=g?.active;
 if(!features||!m||m.suspended||now-m.validated_at>LEARNING_PROTOCOL.maxModelAgeMs)return {status:'UNAVAILABLE',event:'NET_POSITIVE_AT_CLOSE'};
 if(features.x.some((v,i)=>v<m.bounds[i][0]-.25||v>m.bounds[i][1]+.25))return {status:'UNAVAILABLE',reason:'OUTSIDE_TRAINING_SUPPORT',event:'NET_POSITIVE_AT_CLOSE'};
 const p=score(m,features.x),b=m.report.bins[bucket(p)];
 if(!b||b.n<LEARNING_PROTOCOL.minBin||b.interval[1]-b.interval[0]>LEARNING_PROTOCOL.maxIntervalWidth||p<b.interval[0]||p>b.interval[1])return {status:'UNAVAILABLE',reason:'LOCAL_CALIBRATION_INSUFFICIENT',event:'NET_POSITIVE_AT_CLOSE'};
 return {status:'AVAILABLE',event:'NET_POSITIVE_AT_CLOSE',p,interval:b.interval,interval_type:'WILSON95_VALIDATION_GROUP_NOT_INDIVIDUAL_GUARANTEE',n:b.n,model:m.id,validated_at:m.validated_at};
}
export class TradingLearning{
 constructor({state,now=()=>Date.now(),event}){Object.assign(this,{state,now,event});}
 prepare(plan,ledger,bars,quote){
  if(!supported(ledger))return plan;
  const g=group(this.state,ledger,plan.version),features=entryFeatures(plan,bars,quote,this.now());
  return {...plan,study:{features,prediction:publishedPrediction(g,features,this.now()),shadow:g.candidate&&features?{model:g.candidate.id,p:score(g.candidate,features.x),base:g.active&&!g.active.suspended?score(g.active,features.x):g.candidate.prior}:null}};
 }
 observe(e,ledger,version){
  if(!supported(ledger))return;
  const g=group(this.state,ledger,version),now=e.at??this.now();
  if(e.type==='SELECTED'){
   if(g.pending[e.id]||g.seen.includes(e.id))return;
   g.pending[e.id]={at:e.plan.decision_at,study:structuredClone(e.plan.study??null),risk:e.plan.sizing.risk,maxFavourableR:null,maxAdverseR:null};return;
  }
  if(e.type==='NOT_FILLED'){if(g.pending[e.id]){delete g.pending[e.id];g.unfilled++;}return;}
  if(e.type!=='CLOSED'||g.seen.includes(e.id))return;
  g.seen.push(e.id);g.seen=g.seen.slice(-1000);const pending=g.pending[e.id];delete g.pending[e.id];
  const f=pending?.study?.features;
  const exclusion=e.quality!=='OBSERVED'?'INCOMPLETE_MARKET_DATA':!f?'NO_PRE_ENTRY_FEATURES':!(pending.at<=e.entered_at&&e.entered_at<now)?'INVALID_CHRONOLOGY':null;
  const net=+e.pnl,fees=+e.fees,gross=D(e.pnl).plus(e.fees).toString();
  const analysis={type:'TRADE_ANALYSIS',at:now,id:e.id,ledger,version,reason:e.reason,quality:e.quality,net:e.pnl,fees:e.fees,gross,holding_ms:now-e.entered_at,training_eligible:!exclusion,exclusion,maxFavourableR:pending?.maxFavourableR??null,maxAdverseR:pending?.maxAdverseR??null,diagnosis:net>0?'NET_GAIN':+gross>0?'COSTS_EXCEEDED_GROSS_GAIN':e.reason==='STOP'?'STOP_LOSS':'NET_LOSS',prediction:pending?.study?.prediction??{status:'UNAVAILABLE'}};
  g.lastAnalysis=analysis;this.event(analysis);
  if(exclusion){g.excluded++;g.exclusions[exclusion]=(g.exclusions[exclusion]??0)+1;return;}
  const row={id:e.id,entryAt:pending.at,at:now,x:f.x,y:net>0?1:0,pnl:net,fees,reason:e.reason};g.rows.push(row);g.rows=g.rows.slice(-LEARNING_PROTOCOL.maxTraining);g.usable++;
  const shadow=pending.study.shadow,c=g.candidate;
  if(c&&shadow?.model===c.id&&pending.at>=c.train_last_at+LEARNING_PROTOCOL.purgeMs){
   c.validation.push({id:e.id,at:now,entryAt:pending.at,p:shadow.p,base:shadow.base,y:row.y,pnl:net});
   const report=validationReport(c,now,g.attempts);c.report=report;
   if(report.status!=='VALIDATING'||c.validation.length>=LEARNING_PROTOCOL.maxValidation){
    if(report.status==='VALIDATED'){g.active={...c,validation:undefined,validated_at:now,report,recent:[]};g.status='PREDICTION_VALIDATED';}
    else g.status=g.active?'PREDICTION_VALIDATED':'COLLECTING';
    const result={type:'LEARNING_REVIEW',ledger,version,model:c.id,at:now,report:report.status==='VALIDATING'?{...report,status:'REJECTED',reason:'VALIDATION_LIMIT_REACHED'}:report};
    g.history.push(result);this.event(result);g.candidate=null;g.lastAttemptLabels=g.usable;
   }
  }
  const prediction=pending.study.prediction,m=g.active;
  if(m&&!m.suspended&&prediction.status==='AVAILABLE'&&prediction.model===m.id){
   m.recent.push({p:prediction.p,y:row.y});m.recent=m.recent.slice(-50);
   if(m.recent.length===50&&m.recent.reduce((s,r)=>s+(r.p-r.y)**2-(m.prior-r.y)**2,0)/50>.05){m.suspended=true;g.status='PREDICTION_SUSPENDED';this.event({type:'LEARNING_DRIFT',at:now,ledger,version,model:m.id});}
  }
  this.train(g,now);
 }
 track(ledger,version,position,quote){
  if(!position||!quote||!supported(ledger))return;const p=group(this.state,ledger,version).pending[position.plan.id];if(!p)return;
  const liquidation=D(position.qty).mul(quote.bid).mul(D(1).minus(position.plan.sizing.slippage)).mul(D(1).minus(position.plan.sizing.fee));
  const r=liquidation.minus(position.total_entry).div(p.risk).toNumber();p.maxFavourableR=Math.max(p.maxFavourableR??r,r);p.maxAdverseR=Math.min(p.maxAdverseR??r,r);
 }
 train(g,now){
  const policy=LEARNING_PROTOCOL,rows=g.rows,win=rows.reduce((s,r)=>s+r.y,0);
  if(g.candidate||g.attempts>=policy.maxAttempts||rows.length<policy.minTraining||win<policy.minClass||rows.length-win<policy.minClass||g.usable-g.lastAttemptLabels<policy.newLabelsPerAttempt)return;
  g.attempts++;g.lastAttemptLabels=g.usable;
  const model=fitModel(rows,now,hash([LEARNING_VERSION,g.ledger,g.version,g.attempts,hash(rows)]));
  g.candidate={...model,validation:[],report:{status:'VALIDATING',n:0,days:0}};g.status='SHADOW_VALIDATION';
  this.event({type:'LEARNING_TRAINED',at:now,ledger:g.ledger,version:g.version,model:model.id,train_n:rows.length,train_hash:model.train_hash,attempt:g.attempts});
 }
}
