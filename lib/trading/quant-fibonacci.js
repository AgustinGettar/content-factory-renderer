// Causal, frozen Fibonacci context. A level alone never creates an entry.
import {hash} from './core.js';
export const FIBONACCI_POLICY=Object.freeze({version:'secondary-fibonacci-1.0.0',left:2,right:2,lookback:80,max_anchor_age:24,min_impulse_atr:2,tolerance_atr:.15,retracements:[.236,.382,.5,.618,.786],extensions:[1,1.272,1.618],authority:'CONFIRMATION_AND_NEARER_TARGET_ONLY',risk_authority:'NONE',profitability_validated:false});
export function fibonacciContext(input,{direction,atr,cutoff,timeframe}={}){
 const base={version:FIBONACCI_POLICY.version,policy_hash:hash(FIBONACCI_POLICY),direction,timeframe,cutoff,authority:FIBONACCI_POLICY.authority};
 const unavailable=reason=>({...base,status:'UNAVAILABLE',reason,confluence:false,levels:[],extensions:[]});
 if(!['LONG','SHORT'].includes(direction)||!(atr>0)||!Number.isSafeInteger(cutoff))return unavailable('FIBONACCI_CONTEXT_INVALID');
 const b=(input??[]).filter(x=>x.closed!==false&&x.end<=cutoff).slice(-FIBONACCI_POLICY.lookback);
 if(b.length<9||b.some((x,i)=>![x.start,x.end,x.open,x.high,x.low,x.close].every(Number.isFinite)||x.low<=0||x.low>Math.min(x.open,x.close)||x.high<Math.max(x.open,x.close)||x.end<=x.start||i>0&&b[i-1].end!==x.start))return unavailable('FIBONACCI_CLOSED_HISTORY_REQUIRED');
 const pivots=[];
 for(let i=2;i<b.length-2;i++){
  const neighbors=[b[i-2],b[i-1],b[i+1],b[i+2]],x=b[i];
  if(neighbors.every(y=>x.high>y.high))pivots.push({kind:'HIGH',price:x.high,index:i,at:x.start,confirmed_at:b[i+2].end});
  if(neighbors.every(y=>x.low<y.low))pivots.push({kind:'LOW',price:x.low,index:i,at:x.start,confirmed_at:b[i+2].end});
 }
 const long=direction==='LONG',end=pivots.filter(x=>x.kind===(long?'HIGH':'LOW')).at(-1);
 if(!end||b.length-1-end.index>FIBONACCI_POLICY.max_anchor_age)return unavailable('FIBONACCI_NO_RECENT_CONFIRMED_SWING');
 const start=pivots.filter(x=>x.kind===(long?'LOW':'HIGH')&&x.index<end.index).at(-1),sign=long?1:-1;
 if(!start||sign*(end.price-start.price)<FIBONACCI_POLICY.min_impulse_atr*atr)return unavailable('FIBONACCI_IMPULSE_TOO_SMALL');
 if(b.slice(end.index+1).some(x=>long?x.low<=start.price:x.high>=start.price))return unavailable('FIBONACCI_SWING_INVALIDATED');
 const span=Math.abs(end.price-start.price),levels=FIBONACCI_POLICY.retracements.map(ratio=>({ratio,price:end.price-sign*span*ratio,conventional:ratio===.5})),extensions=FIBONACCI_POLICY.extensions.map(ratio=>({ratio,price:start.price+sign*span*ratio})).filter(x=>x.price>0);
 const last=b.at(-1),prev=b.at(-2),tolerance=FIBONACCI_POLICY.tolerance_atr*atr;
 const matches=levels.filter(x=>last.low<=x.price+tolerance&&last.high>=x.price-tolerance&&(long?last.close>x.price&&last.close>last.open&&last.close>prev.close:last.close<x.price&&last.close<last.open&&last.close<prev.close));
 const nearest=[...matches].sort((a,c)=>Math.abs(last.close-a.price)-Math.abs(last.close-c.price))[0]??null;
 return {...base,status:'READY',reason:nearest?'FIBONACCI_REJECTION_CONFIRMED':'FIBONACCI_NO_REJECTION',confluence:Boolean(nearest),confirmed_level:nearest,anchor_start:start,anchor_end:end,impulse:span,tolerance,levels,extensions};
}
export function fibonacciTarget(context,entry,target){
 const sign=context.direction==='LONG'?1:-1;
 if(context.status!=='READY'||!(entry>0&&target>0)||sign*(target-entry)<=0)return {target,limited:false,level:null};
 const level=context.extensions.filter(x=>sign*(x.price-entry)>0&&sign*(target-x.price)>0).sort((a,b)=>sign*(a.price-b.price))[0];
 return level?{target:level.price,limited:true,level}:{target,limited:false,level:null};
}
export function fibonacciContract(context,entry,originalTarget,target){
 const q={...context,entry,original_target:originalTarget,applied_target:target};return {...q,hash:hash(q)};
}
export function validateFibonacci(plan){
 const f=plan.quant_contract?.fibonacci;if(!f)return true; // Preserve earlier signed plans.
 if(f.version!==FIBONACCI_POLICY.version||f.policy_hash!==hash(FIBONACCI_POLICY)||f.hash!==hash({...f,hash:undefined})||f.direction!==plan.direction||f.timeframe!==plan.timeframe||f.cutoff!==plan.confirmed_at||Number(f.applied_target)!==Number(plan.target)||Number(f.entry)!==Number(plan.entry)||f.anchor_end?.confirmed_at>plan.confirmed_at||f.anchor_start?.confirmed_at>plan.confirmed_at||!(Number(f.original_target)>0)||(plan.direction==='LONG'?1:-1)*(Number(f.original_target)-Number(f.applied_target))<0)throw Error('FIBONACCI_CONTRACT_INTEGRITY');
 return true;
}
