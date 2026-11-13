// Bounded, optional IPC only. No SQLite/filesystem access or strategy computation
// occurs on the trading event loop. RAM admission is deliberately NOT durability.
import {Worker} from 'node:worker_threads';
import {randomUUID} from 'node:crypto';
const MAX_MESSAGE=256*1024, MAX_BYTES=2*1024*1024, MAX_PENDING=128;
const safeCode=e=>/^[A-Z][A-Z0-9_]{2,96}$/.test(e?.code??'')?e.code:'SHADOW_WORKER_UNAVAILABLE';
function boundedJSON(value,limit){
 let bytes=0,nodes=0;const stack=[value];
 while(stack.length){
  if(++nodes>20000)throw Error('SHADOW_MESSAGE_LIMIT');
  const v=stack.pop();
  if(typeof v==='string'){bytes+=Buffer.byteLength(v)+2;}
  else if(v&&typeof v==='object'){
   if(Array.isArray(v)&&v.length>20000)throw Error('SHADOW_MESSAGE_LIMIT');
   const entries=Object.entries(v);bytes+=2+entries.length*2;
   for(const [k,x] of entries){bytes+=Buffer.byteLength(k)+3;stack.push(x);}
  }else if(typeof v==='number'||typeof v==='boolean'||v==null)bytes+=24;
  else throw Error('SHADOW_MESSAGE_NOT_JSON');
  if(bytes>limit)throw Error('SHADOW_MESSAGE_LIMIT');
 }
 const json=JSON.stringify(value);if(Buffer.byteLength(json)>limit)throw Error('SHADOW_MESSAGE_LIMIT');return json;
}
export class ShadowObservationClient {
 constructor({path,operationalPath,maxPending=MAX_PENDING,maxBytes=MAX_BYTES,maxMessageBytes=MAX_MESSAGE,maxRestarts=3,retryMs=100,ackTimeoutMs=2000,workerFactory,storeLimits,onAck,onError,clock=()=>Date.now()}={}){
  if(typeof path!=='string'||typeof operationalPath!=='string')throw Error('SHADOW_PATHS_REQUIRED');
  this.path=path;this.operationalPath=operationalPath;this.maxPending=Math.max(2,Math.min(MAX_PENDING,maxPending));this.maxBytes=Math.max(1024,Math.min(MAX_BYTES,maxBytes));this.maxMessageBytes=Math.max(512,Math.min(MAX_MESSAGE,maxMessageBytes));
  this.ackTimeoutMs=Math.max(100,Math.min(5000,ackTimeoutMs));this.retryStreak=0;
  this.maxRestarts=Math.max(0,Math.min(3,maxRestarts));this.retryMs=Math.max(10,Math.min(2000,retryMs));this.workerFactory=workerFactory;this.storeLimits=storeLimits;this.onAck=onAck;this.onError=onError;this.clock=clock;
  this.session=randomUUID();this.sequence=0;this.queue=[];this.pendingById=new Map();this.bytes=0;this.inflight=null;this.requests=new Map();this.waiters=new Set();this.liveWorkers=new Set();this.restarts=0;this.ended=false;this.paused=false;this.booted=false;this.gap=null;
  this.counters={accepted:0,durable:0,duplicate:0,rejected:0,flow_accepted:0,flow_processed:0,flow_rejected:0,retries:0,worker_restarts:0};
  this.current={state:'STARTING',reason:null,resync_required:true,last_durable_at:null};
  this.readyPromise=new Promise(resolve=>{this.readyResolve=resolve;});this.spawn();
 }
 get status(){return {...this.current,...this.counters,pending:this.queue.length,pending_bytes:this.bytes,inflight:!!this.inflight,paused:this.paused,retained_gap:!!this.gap};}
 ready(){return this.readyPromise;}
 spawn(){
  if(this.ended)return;
  this.booted=false;this.current.state='STARTING';
  try{
   const options={workerData:{path:this.path,operationalPath:this.operationalPath,limits:this.storeLimits,session:this.session,startedAt:this.clock()},resourceLimits:{maxOldGenerationSizeMb:64,maxYoungGenerationSizeMb:16,stackSizeMb:2}};
   this.worker=this.workerFactory?this.workerFactory(options):new Worker(new URL('./shadow-observation-worker.mjs',import.meta.url),options);
   const instance=this.worker;this.liveWorkers.add(instance);
   instance.on('message',m=>{if(instance===this.worker)this.message(m);});
   instance.on('error',e=>{if(instance===this.worker)this.failure(safeCode(e));});
   instance.on('exit',code=>{this.liveWorkers.delete(instance);if(instance!==this.worker||this.ended)return;this.worker=null;this.booted=false;this.inflight=null;clearTimeout(this.ackTimer);if(this.fatal){this.current.state='PAUSED';return;}this.failure(code===0?'SHADOW_WORKER_EXITED':'SHADOW_WORKER_CRASH');this.restart();});
  }catch(e){this.worker=null;this.failure(safeCode(e));this.restart();}
 }
 failure(reason){this.current.state='DEGRADED';this.current.reason=reason;this.current.resync_required=true;try{this.onError?.({code:reason});}catch{}this.notify();}
 restart(){
  if(this.ended||this.restartTimer)return;
  if(this.restarts>=this.maxRestarts){this.current.state='PAUSED';this.paused=true;this.current.reason='SHADOW_RESTART_LIMIT';this.readyResolve?.(false);this.readyResolve=null;return;}
  this.restarts++;this.counters.worker_restarts++;this.noteGap('OBSERVER_RESTART',this.clock(),false);
  this.restartTimer=setTimeout(()=>{this.restartTimer=null;this.spawn();},this.retryMs);this.restartTimer.unref?.();
 }
 noteGap(reason,at=this.clock(),flow=false){
  reason=/^[A-Z][A-Z0-9_]{2,96}$/.test(reason)?reason:'SHADOW_OBSERVATION_GAP';
  if(!Number.isSafeInteger(at)||at<0)at=this.clock();
  this.current.reason=reason;this.current.state='DEGRADED';this.current.resync_required=true;
  if(flow)this.counters.flow_rejected++;else this.counters.rejected++;
  // The loss interval may be old; the gap is learned now. Using the lost event's
  // timestamp for the new envelope could itself expire and recurse forever.
  if(!this.gap){const learnedAt=this.clock();this.gap={id:'gap:'+this.session+':'+(++this.sequence),kind:'GAP',at:learnedAt,received_at:learnedAt,payload:{reason,first_at:at,last_at:at,lost_messages:0,flow_only:flow}};}
  this.gap.payload.last_at=at;this.gap.payload.lost_messages++;this.gap.payload.flow_only&&=flow;
 }
 offer(envelope){
  const at=Number.isSafeInteger(envelope?.at)?envelope.at:this.clock();
  if(!envelope||typeof envelope.id!=='string'||!envelope.id||envelope.id.length>256||typeof envelope.kind!=='string'){this.noteGap('SHADOW_ENVELOPE_INVALID',at);return false;}
  const old=this.pendingById.get(envelope.id);
  if(this.ended||this.paused){this.noteGap(this.ended?'SHADOW_CLOSED':'SHADOW_PAUSED',at);return false;}
  if(!old&&(this.queue.length>=this.maxPending||this.bytes>=this.maxBytes)){this.noteGap('SHADOW_QUEUE_CAPACITY',at);return false;}
  let json;try{json=boundedJSON(envelope,this.maxMessageBytes);}catch{this.noteGap('SHADOW_MESSAGE_LIMIT',at);return false;}
  if(old){if(old.json===json)return true;this.noteGap('SHADOW_ID_CONFLICT',at);return false;}
  const bytes=Buffer.byteLength(json);if(this.bytes+bytes>this.maxBytes){this.noteGap('SHADOW_BYTE_CAPACITY',at);return false;}
  const row={id:envelope.id,json,bytes,durable:true,at};this.queue.push(row);this.pendingById.set(row.id,row);this.bytes+=bytes;this.counters.accepted++;this.pump();return true;
 }
 flow(message,receivedAt=this.clock()){
  if(this.ended||this.paused||this.queue.length>=Math.min(64,this.maxPending-1)||this.bytes>=this.maxBytes*.75){this.noteGap('SHADOW_FLOW_CAPACITY',receivedAt,true);return false;}
  let json;try{json=boundedJSON({message,received_at:receivedAt},this.maxMessageBytes);}catch{this.noteGap('SHADOW_FLOW_MESSAGE_LIMIT',receivedAt,true);return false;}
  const bytes=Buffer.byteLength(json);if(this.bytes+bytes>this.maxBytes){this.noteGap('SHADOW_FLOW_BYTE_CAPACITY',receivedAt,true);return false;}
  this.queue.push({id:'flow:'+this.session+':'+(++this.sequence),json,bytes,durable:false,at:receivedAt});this.bytes+=bytes;this.counters.flow_accepted++;this.pump();return true;
 }
 disconnect(reason='SHADOW_FEED_DISCONNECTED',at=this.clock()){
  this.noteGap(reason,at,true);this.pump();
 }
 materializeGap(){
  if(!this.gap||this.queue.length>=this.maxPending||this.bytes+1024>this.maxBytes)return;
  const gap=this.gap;this.gap=null;const json=JSON.stringify(gap),row={id:gap.id,json,bytes:Buffer.byteLength(json),durable:true,at:gap.at,gap:true};
  // First after the current acknowledgement: missing flow must be invalidated
  // before subsequent decisions can call it complete.
  this.queue.unshift(row);this.pendingById.set(row.id,row);this.bytes+=row.bytes;
 }
 pump(){
  if(!this.booted||this.ended||this.paused||this.inflight||this.retryTimer)return;
  this.materializeGap();const row=this.queue[0];if(!row){this.worker?.unref?.();this.notify();return;}
  this.inflight=row;this.worker?.ref?.();
  this.ackTimer=setTimeout(()=>{if(!this.inflight||this.ended)return;this.failure('SHADOW_ACK_TIMEOUT');const w=this.worker;this.worker=null;this.booted=false;this.inflight=null;void w?.terminate().catch(()=>{});this.restart();},this.ackTimeoutMs);
  this.ackTimer.unref?.();
  try{this.worker.postMessage({type:row.durable?'PROCESS':'FLOW',id:row.id,json:row.json});}
  catch{clearTimeout(this.ackTimer);this.inflight=null;this.failure('SHADOW_POSTMESSAGE_FAILED');this.scheduleRetry();}
 }
 scheduleRetry(){
  if(this.retryTimer||this.ended)return;
  this.counters.retries++;this.retryStreak++;const delay=Math.min(2000,this.retryMs*2**Math.min(8,this.retryStreak-1));this.retryTimer=setTimeout(()=>{this.retryTimer=null;this.pump();},delay);this.retryTimer.unref?.();
 }
 message(m){
  if(m?.type==='READY'){
   this.booted=true;this.current.state='READY';this.current.reason=null;this.readyResolve?.(true);this.readyResolve=null;this.pump();return;
  }
  if(m?.type==='FATAL'){this.fatal=true;this.failure(m.code??'SHADOW_INIT_FAILED');this.current.state='PAUSED';this.paused=true;this.readyResolve?.(false);this.readyResolve=null;return;}
  if(m?.type==='RESULT'){
   const pending=this.requests.get(m.requestId);if(!pending)return;this.requests.delete(m.requestId);clearTimeout(pending.timer);m.error?pending.reject(Error(m.error)):pending.resolve(m.result);return;
  }
  if(!this.inflight||m?.id!==this.inflight.id)return;
  if(m.type==='NACK'){
   clearTimeout(this.ackTimer);const row=this.inflight;this.inflight=null;this.failure(m.code??'SHADOW_PERSIST_FAILED');
   if(m.retryable!==false){this.scheduleRetry();return;}
   if(row.gap){this.paused=true;this.current.state='PAUSED';this.notify();return;}
   this.remove(row);this.noteGap(m.code??'SHADOW_INPUT_REJECTED',row.at,!row.durable);this.pump();return;
  }
  if(m.type!=='ACK'||(this.inflight.durable&&m.durable!==true))return;
  clearTimeout(this.ackTimer);this.retryStreak=0;const row=this.inflight;this.inflight=null;this.remove(row);
  if(row.durable){this.counters.durable++;this.counters.duplicate+=m.result?.duplicate?1:0;this.current.last_durable_at=row.at;try{this.onAck?.({id:row.id,result:m.result});}catch{}}
  else this.counters.flow_processed++;
  this.current.resync_required=!!this.gap||this.queue.some(x=>x.gap)||m.resync_required===true;
  this.current.state=this.gap?'DEGRADED':'READY';this.current.reason=this.gap?.payload.reason??null;
  this.notify();this.pump();
 }
 remove(row){const index=this.queue.indexOf(row);if(index>=0)this.queue.splice(index,1);this.bytes-=row.bytes;if(row.durable)this.pendingById.delete(row.id);}
 notify(){for(const done of this.waiters)done();}
 drain(timeout=3000){
  if(!this.queue.length&&!this.gap)return Promise.resolve(true);
  return new Promise(resolve=>{let timer;const done=()=>{if(this.queue.length||this.gap)return;clearTimeout(timer);this.waiters.delete(done);resolve(true);};this.waiters.add(done);timer=setTimeout(()=>{this.waiters.delete(done);resolve(false);},Math.max(1,timeout));this.pump();});
 }
 query(query={},timeout=3000){
  if(!this.booted||this.ended)return Promise.reject(Error('SHADOW_NOT_READY'));
  if(this.requests.size>=8)return Promise.reject(Error('SHADOW_QUERY_LIMIT'));
  const requestId='query:'+this.session+':'+(++this.sequence);
  return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.requests.delete(requestId);reject(Error('SHADOW_QUERY_TIMEOUT'));},timeout);this.requests.set(requestId,{resolve,reject,timer});try{this.worker.postMessage({type:'QUERY',requestId,query});}catch{clearTimeout(timer);this.requests.delete(requestId);reject(Error('SHADOW_QUERY_SEND_FAILED'));}});
 }
 pause(reason='SHADOW_MANUAL_PAUSE'){this.paused=true;this.failure(reason);this.current.state='PAUSED';}
 resume(){if(this.ended||!this.worker)return false;this.paused=false;this.current.state=this.booted?'READY':'STARTING';this.pump();return true;}
 async close({drain=true,timeout=1000}={}){
  const started=performance.now(),budget=Math.max(1,Math.min(5000,timeout));
  const complete=drain?await this.drain(budget):!this.queue.length;this.ended=true;this.current.state='CLOSED';clearTimeout(this.retryTimer);clearTimeout(this.restartTimer);clearTimeout(this.ackTimer);
  for(const pending of this.requests.values()){clearTimeout(pending.timer);pending.reject(Error('SHADOW_CLOSED'));}this.requests.clear();
  this.worker=null;let timer,terminationError=null;
  const endings=[...this.liveWorkers].map(async w=>{try{await w.terminate();this.liveWorkers.delete(w);return true;}catch(e){terminationError=safeCode(e);return false;}});
  const terminated=await Promise.race([Promise.all(endings).then(results=>results.every(Boolean)&&this.liveWorkers.size===0),new Promise(resolve=>{timer=setTimeout(()=>{terminationError='SHADOW_TERMINATION_TIMEOUT';resolve(false);},Math.max(1,budget-(performance.now()-started)));})]);
  clearTimeout(timer);return {complete,pending:this.queue.length,gap_pending:!!this.gap,terminated,...(!terminated?{termination_error:terminationError??'SHADOW_TERMINATION_FAILED'}:{})};
 }
}
