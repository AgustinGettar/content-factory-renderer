// Optional observer shedding. No policy/account mutation, resource-limit increase,
// guessed RSS subtraction, or reset of a bad CPU interval after termination.
import {performance} from 'node:perf_hooks';
export const SHADOW_RESOURCE_POLICY=Object.freeze({
 version:'shadow-resource-guard-1.0.0',economicCpuFraction:.5,economicRssBytes:320*1024*1024,
 observerShedCpuFraction:.4,observerShedRssBytes:256*1024*1024,maxTerminationMs:1000
});
const nonnegative=value=>Number.isFinite(value)&&value>=0;
const cpu=usage=>usage&&nonnegative(usage.user)&&nonnegative(usage.system)?usage.user+usage.system:null;
const codeError=code=>Object.assign(new Error(code),{code});
export function captureResourceSample({runtime=process,clock=()=>performance.now()}={}){
 const total=cpu(runtime.cpuUsage());let main=null,threadStatus='UNSUPPORTED';
 if(typeof runtime.threadCpuUsage==='function'){
  try{main=cpu(runtime.threadCpuUsage());threadStatus=main===null?'INVALID':'SUPPORTED';}catch{threadStatus='UNAVAILABLE';}
 }
 const rss=runtime.memoryUsage().rss,at=clock();
 if(total===null||!nonnegative(rss)||!nonnegative(at))throw codeError('RESOURCE_SAMPLE_INVALID');
 return {at_ms:at,process_cpu_us:total,main_thread_cpu_us:main,thread_cpu_status:threadStatus,rss_bytes:rss};
}
export function resourceInterval(previous,current){
 const elapsed=current?.at_ms-previous?.at_ms,total=current?.process_cpu_us-previous?.process_cpu_us;
 if(!Number.isFinite(elapsed)||elapsed<=0||!nonnegative(total)||!nonnegative(current?.rss_bytes))throw codeError('RESOURCE_INTERVAL_INVALID');
 const main=previous.main_thread_cpu_us!==null&&previous.main_thread_cpu_us!==undefined&&current.main_thread_cpu_us!==null&&current.main_thread_cpu_us!==undefined?
  current.main_thread_cpu_us-previous.main_thread_cpu_us:null;
 return {interval_ms:elapsed,aggregate_cpu_fraction:total/elapsed/1000,main_thread_cpu_fraction:nonnegative(main)?main/elapsed/1000:null,
  thread_cpu_status:nonnegative(main)?'SUPPORTED':current.thread_cpu_status??'UNSUPPORTED',rss_bytes:current.rss_bytes};
}
export function assessResourceSample(metrics,{observerActive=false}={}){
 const policy=SHADOW_RESOURCE_POLICY;
 if(!nonnegative(metrics?.aggregate_cpu_fraction)||!nonnegative(metrics?.rss_bytes))throw codeError('RESOURCE_METRICS_INVALID');
 const useMain=observerActive&&nonnegative(metrics.main_thread_cpu_fraction);
 const economic=useMain?metrics.main_thread_cpu_fraction:metrics.aggregate_cpu_fraction;
 return {observer_active:observerActive,economic_cpu_fraction:economic,cpu_basis:useMain?'MEASURED_MAIN_THREAD':'MEASURED_PROCESS_AGGREGATE',
  shed_observer:observerActive&&(metrics.aggregate_cpu_fraction>policy.observerShedCpuFraction||metrics.rss_bytes>policy.observerShedRssBytes),
  cpu_limit:economic>policy.economicCpuFraction,rss_limit:metrics.rss_bytes>policy.economicRssBytes,
  aggregate_cpu_limit:metrics.aggregate_cpu_fraction>policy.economicCpuFraction,
  hard_limits:{cpu_fraction:policy.economicCpuFraction,rss_bytes:policy.economicRssBytes}};
}
async function terminateObserver(observer,timeoutMs){
 let pauseError=null;
 try{observer.pause('SHADOW_RESOURCE_PRESSURE');}catch{pauseError='SHADOW_PAUSE_FAILED';}
 let timer;
 try{
  const closed=Promise.resolve().then(()=>observer.close({drain:false,timeout:timeoutMs})).then(result=>
   result?.terminated===true?{terminated:true,queued_inputs_discarded:result.complete===false,pending:result.pending??null}:
    {terminated:false,error:result?.termination_error??'SHADOW_TERMINATION_NOT_CONFIRMED'}).catch(()=>({terminated:false,error:'SHADOW_TERMINATION_FAILED'}));
  const timeout=new Promise(resolve=>{timer=setTimeout(()=>resolve({terminated:false,error:'SHADOW_TERMINATION_TIMEOUT'}),timeoutMs);});
  return {...await Promise.race([closed,timeout]),pause_error:pauseError};
 }finally{clearTimeout(timer);}
}
export class ShadowResourceGuard{
 constructor({readSample=()=>captureResourceSample(),readRss=()=>process.memoryUsage().rss,terminationMs=1000}={}){
  if(!Number.isSafeInteger(terminationMs)||terminationMs<1||terminationMs>SHADOW_RESOURCE_POLICY.maxTerminationMs)throw codeError('RESOURCE_TERMINATION_BOUND_INVALID');
  this.readSample=readSample;this.readRss=readRss;this.terminationMs=terminationMs;this.previous=readSample();this.inflight=null;
 }
 check({observer=null}={}){
  // One resource interval is assessed once even if a timer caller overlaps.
  if(this.inflight)return this.inflight;
  this.inflight=this.evaluate(observer).finally(()=>{this.inflight=null;});return this.inflight;
 }
 async evaluate(observer){
  const current=this.readSample(),metrics=resourceInterval(this.previous,current);this.previous=current;
  const observerActive=!!observer&&observer.ended!==true&&observer.status?.state!=='CLOSED';
  const assessment=assessResourceSample(metrics,{observerActive});let termination=null,rssAfter=metrics.rss_bytes;
  if(assessment.shed_observer){
   termination=await terminateObserver(observer,this.terminationMs);
   // RSS is process-wide even with threadCpuUsage; only a fresh measurement can
   // establish reclaimed memory. CPU remains the ORIGINAL complete interval.
   rssAfter=this.readRss();if(!nonnegative(rssAfter))throw codeError('RESOURCE_RSS_RECHECK_INVALID');
  }
  const cpuLimit=assessment.cpu_limit,rssLimit=rssAfter>SHADOW_RESOURCE_POLICY.economicRssBytes;
  const terminationFailed=assessment.shed_observer&&termination?.terminated!==true;
  return {version:SHADOW_RESOURCE_POLICY.version,interval_ms:metrics.interval_ms,
   aggregate_cpu_fraction:metrics.aggregate_cpu_fraction,main_thread_cpu_fraction:metrics.main_thread_cpu_fraction,
   economic_cpu_fraction:assessment.economic_cpu_fraction,cpu_basis:assessment.cpu_basis,thread_cpu_status:metrics.thread_cpu_status,
   rss_before_bytes:metrics.rss_bytes,rss_bytes:rssAfter,observer_active:observerActive,observer_shed:assessment.shed_observer,termination,
   aggregate_cpu_limit:assessment.aggregate_cpu_limit,cpu_limit:cpuLimit,rss_limit:rssLimit,resource_limit:cpuLimit||rssLimit||terminationFailed,
   reason:terminationFailed?'OBSERVER_TERMINATION_FAILED':cpuLimit||rssLimit?'RESOURCE_LIMIT':null,
   hard_limits:assessment.hard_limits,cpu_interval_preserved:true};
 }
}
