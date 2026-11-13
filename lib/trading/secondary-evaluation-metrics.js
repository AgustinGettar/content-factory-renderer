// Observability only: bounded state persisted with the existing checkpoint.
// A logical evaluation is this worker's closed-frame strategy batch, not a
// quote tick, candidate, pattern check or order. Entry clocks remain authoritative.
export const EVALUATION_METRICS_VERSION='secondary-evaluation-metrics-1.0.0';
const counts=()=>({attempts:0,retries:0,completed:0,failed:0,blocked_attempts:0,error_attempts:0,completed_pattern_checks:0});
const increment=(metrics,frame,key,n=1)=>{metrics.counts[key]+=n;frame.counts[key]+=n;};
export function evaluationMetrics(quant,profile,now){
 if(!quant)return null;
 if(!quant.evaluation_metrics){
  quant.evaluation_metrics={version:EVALUATION_METRICS_VERSION,unit:'CLOSED_FUTURES_FRAME_STRATEGY_BATCH',instrument:profile.policy.symbol,since:now,
   legacy:{field:'counts.evaluations',unit:'RESOLVED_QUANT_CALLS_INCLUDING_TRANSIENT_RETRIES',value_at_start:quant.counts.evaluations,comparable_to_completed:false},
   counts:counts(),frames:{}};
 }
 const m=quant.evaluation_metrics;
 // An unknown metrics version must not change trading admission or management.
 if(m.version!==EVALUATION_METRICS_VERSION||!m.frames||!m.counts)return null;
 const validCounts=c=>c&&Object.keys(counts()).every(k=>Number.isSafeInteger(c[k])&&c[k]>=0);
 if(!validCounts(m.counts)||Object.values(m.frames).some(f=>!validCounts(f?.counts)||!Number.isSafeInteger(f.terminal_through)||!Number.isSafeInteger(f.first_cutoff)))return null;
 for(const tf of profile.policy.entry_frames)if(!m.frames[tf]){
  const duration=tf*60000,cutoff=Math.floor(now/duration)*duration;
  const through=Math.max(profile.frames[tf].last_cutoff,cutoff-duration);
  m.frames[tf]={counts:counts(),first_cutoff:through+duration,terminal_through:through,last_attempt_key:null,last_attempt_at:null,last_status:null};
 }
 return m;
}
export function evaluationAttempt(metrics,timeframe,identity,now){
 if(!metrics)return;
 const f=metrics.frames[timeframe];
 increment(metrics,f,'attempts');
 if(f.last_attempt_key===identity)increment(metrics,f,'retries');
 f.last_attempt_key=identity;f.last_attempt_at=now;f.last_status='ATTEMPT';
}
export function evaluationBlocked(metrics,timeframe,reason){
 if(!metrics)return;
 const f=metrics.frames[timeframe];increment(metrics,f,'blocked_attempts');
 if(reason==='QUANT_EVALUATION_ERROR')increment(metrics,f,'error_attempts');
 f.last_status='TRANSIENT_BLOCKED';f.last_blocker=reason;
}
export function evaluationCompleted(metrics,timeframe,cutoff,patternCount){
 if(!metrics)return;
 const f=metrics.frames[timeframe];if(cutoff<=f.terminal_through)return;
 increment(metrics,f,'completed');increment(metrics,f,'completed_pattern_checks',patternCount);
 f.terminal_through=cutoff;f.last_status='COMPLETE';f.last_blocker=null;
}
export function evaluationMissed(metrics,timeframe,from,to){
 if(!metrics)return;
 const f=metrics.frames[timeframe],duration=timeframe*60000;
 const first=Math.max(from,f.terminal_through+duration,f.first_cutoff);
 if(to<first)return;
 increment(metrics,f,'failed',Math.floor((to-first)/duration)+1);
 f.terminal_through=to;f.last_status='MISSED';
}
