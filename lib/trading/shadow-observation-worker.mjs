// The optional observer owns this thread and its dedicated SQLite file. It never
// imports the economic worker, notifier, operational SQLiteStore or account API.
import {parentPort,workerData} from 'node:worker_threads';
import {ShadowObservationStore} from './shadow-observation-store.js';
import {KrakenPublicFlow} from './kraken-public-flow.js';
const flow=new KrakenPublicFlow();let store,current=null,currentFlow=null,flowGapStart=null;
// At most one open retention episode per bounded feature window. A busy public
// feed must not turn every evicted change into a new SQLite transaction.
const retentionEpisodes=new Map();let retentionSequence=0;
function retentionGaps(at,messageId){
 const gaps=[];
 for(const [reason,marker]of [['KRAKEN_TRADE_SEQUENCE_OR_RETENTION_GAP',flow.tradeGapAt],['KRAKEN_DEPTH_WINDOW_RETENTION_GAP',flow.changeGapAt]]){
  let episode=retentionEpisodes.get(reason);
  const emit=open=>{gaps.push({id:'flow-retention:'+messageId+':'+gaps.length,kind:'GAP',at,received_at:at,payload:{reason,gap_key:episode.key,from_at:episode.first,to_at:open?episode.last:at,open,flow_only:true}});episode.emittedAt=at;};
  if(episode&&(marker===null||at-marker>flow.windowMs)){emit(false);retentionEpisodes.delete(reason);continue;}
  if(marker===null||at-marker>flow.windowMs)continue;
  if(!episode){episode={key:'retention:'+workerData.session+':'+(++retentionSequence),first:marker,last:marker,emittedAt:null};retentionEpisodes.set(reason,episode);emit(true);continue;}
  episode.last=Math.max(episode.last,marker);
  if(at-episode.emittedAt>=60000)emit(true);
 }
 return gaps;
}
const errorCode=e=>{
 if(/locked|busy/i.test(e?.message??''))return 'SHADOW_STORAGE_BUSY';
 if(/full|space/i.test(e?.message??''))return 'SHADOW_STORAGE_FULL';
 return /^[A-Z][A-Z0-9_]{2,96}$/.test(e?.code??e?.message??'')?(e.code??e.message):'SHADOW_STORAGE_FAILED';
};
try{
 store=new ShadowObservationStore({path:workerData.path,operationalPath:workerData.operationalPath,limits:workerData.limits});
 // Reopening only this observer database marks the period without observation;
 // no inference is made from the unchanged economic position or last price.
 const at=Number.isSafeInteger(workerData.startedAt)?workerData.startedAt:Date.now();store.process({id:'boot:'+workerData.session+':'+at,kind:'BOOT',at,received_at:at,payload:{reason:'OBSERVER_THREAD_STARTED',session:workerData.session}});
 parentPort.postMessage({type:'READY'});
}catch(e){parentPort.postMessage({type:'FATAL',code:errorCode(e)});parentPort.close();}
if(store)parentPort.on('message',message=>{
 if(message?.type==='QUERY'){
  try{parentPort.postMessage({type:'RESULT',requestId:message.requestId,result:store.export(message.query??{})});}
  catch(e){parentPort.postMessage({type:'RESULT',requestId:message.requestId,error:errorCode(e)});}return;
 }
 if(!['PROCESS','FLOW'].includes(message?.type))return;
 try{
  if(message.type==='FLOW'){
   if(currentFlow?.id!==message.id){
    const payload=JSON.parse(message.json),at=payload.received_at;
    const before={resync:flow.resync_required,bookAt:flow.bookAt};
    flow.ingest(payload.message,at);const gaps=[];
    const gap=(reason,from)=>gaps.push({id:'flow-gap:'+message.id+':'+gaps.length,kind:'GAP',at,received_at:at,payload:{reason,from_at:Number.isSafeInteger(from)?Math.min(from,at):at,to_at:at,flow_only:true}});
    if(!before.resync&&flow.resync_required){flowGapStart=before.bookAt??at;gap(flow.reason??'KRAKEN_FLOW_INVALIDATED',flowGapStart);}
    if(!flow.resync_required&&flowGapStart!==null){gap('KRAKEN_BOOK_RESYNC_INTERVAL',flowGapStart);flowGapStart=null;}
    gaps.push(...retentionGaps(at,message.id));
    // Public messages are ephemeral, but any detected missing interval is not.
    // Keep these exact records across BUSY retries without reapplying a delta.
    currentFlow={id:message.id,gaps};
   }
   for(const gap of currentFlow.gaps)store.process(gap);currentFlow=null;
   parentPort.postMessage({type:'ACK',id:message.id,durable:false,resync_required:flow.resync_required});return;
  }
  if(current?.id!==message.id){
   const envelope=JSON.parse(message.json);let snapshot=null;
   if(envelope.kind==='DECISION'){
    const input=envelope.payload?.input??envelope.payload,position=input.position;
    snapshot=flow.snapshot(envelope.at,{quantity:position?.qty,side:position?.plan?.direction==='SHORT'?'buy':'sell'});
   }else if(envelope.kind==='OPPORTUNITY')snapshot=flow.snapshot(envelope.at);
   if(envelope.kind==='GAP'||envelope.kind==='BOOT'){flowGapStart=envelope.payload?.from_at??envelope.payload?.first_at??envelope.at;flow.disconnect(envelope.payload?.reason??'OBSERVATION_GAP');}
   // Freeze the causal flow used for this attempt across SQLITE_BUSY retries.
   // Store deduplicates original envelope before evaluating this context.
   current={id:message.id,envelope,flow:snapshot,gaps:retentionGaps(envelope.at,message.id)};
  }
  for(const gap of current.gaps)store.process(gap);
  const result=store.process(current.envelope,{flow:current.flow});current=null;
  parentPort.postMessage({type:'ACK',id:message.id,durable:true,result,resync_required:flow.resync_required});
 }catch(e){
  const code=errorCode(e),retryable=!/CONFLICT|INVALID|REQUIRED|PATH|SCHEMA|NOT_JSON|ENVELOPE|UNSUPPORTED/.test(code);
  if(!retryable){current=null;currentFlow=null;}
  parentPort.postMessage({type:'NACK',id:message.id,code,retryable});
 }
});
