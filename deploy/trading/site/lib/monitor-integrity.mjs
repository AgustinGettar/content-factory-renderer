// Presentation and HTTP integrity only. No execution policy or economic arithmetic.
import {viewModel,snapshotOrder,SNAPSHOT_MAX_AGE_MS} from './compact-panel/model.js';
import {mergeMonitor} from './monitor-refresh.mjs';
export const knownAmount=value=>(typeof value==='number'&&Number.isFinite(value))||(typeof value==='string'&&value.trim()!==''&&Number.isFinite(Number(value)));
export const ACCESS_LOST_EVENT='lumi-monitor-access-lost';
export const MONITOR_SOURCE=Symbol('Lumi full-portfolio presentation source');
export function notifyAccessLoss(code){
 if(typeof window!=='undefined'&&typeof window.dispatchEvent==='function')window.dispatchEvent(new CustomEvent(ACCESS_LOST_EVENT,{detail:{code}}));
}
const problem=code=>Object.assign(new Error(code),{code});
export function monitorErrorCode(error){
 if(error?.name==='TimeoutError'||error?.name==='AbortError')return 'TIMEOUT';
 const code=error?.code??error?.message;return ['AUTH_REQUIRED','PERMISSION_DENIED','SERVER','INVALID_RESPONSE','INVALID_SNAPSHOT','OLDER_SNAPSHOT','SOURCE_CHANGED','STALE_REQUEST','MIGRATION','QUOTA'].includes(code)?code:'NETWORK';
}
export const monitorErrorMessage=code=>({
 AUTH_REQUIRED:'Autenticación requerida. Abrí el monitor desde Telegram.',
 PERMISSION_DENIED:'Permiso denegado para este monitor.',
 NETWORK:'Sin conexión: no se pudo actualizar el panel.',
 TIMEOUT:'La consulta agotó el tiempo de espera.',
 SERVER:'El servidor no pudo actualizar el panel.',
 INVALID_RESPONSE:'Respuesta inesperada o inválida del monitor.',
 INVALID_SNAPSHOT:'La lectura del monitor está incompleta o tiene fechas inválidas.',
 OLDER_SNAPSHOT:'Se descartó una respuesta anterior a la última lectura confirmada.',
 SOURCE_CHANGED:'El origen de esta lectura no puede ordenarse con el anterior. Recargá el panel para establecer una nueva lectura sin mezclar historias.',
 MIGRATION:'El panel está esperando la publicación del motor en AWS.',
 QUOTA:'La transferencia está restringida. Conservamos la última lectura y reintentamos en 5 minutos.'
}[code]??'No se pudo confirmar esta lectura.');
export async function readMonitorResponse(response){
 if(response.status===401||response.status===403){const code=response.status===401?'AUTH_REQUIRED':'PERMISSION_DENIED';notifyAccessLoss(code);throw problem(code);}
 const jsonType=/^application\/json(?:\s*;|$)/i.test(response.headers?.get('content-type')??'');
 if(!response.ok){
  let body=null;if(jsonType)try{body=await response.json();}catch{}
  throw Object.assign(problem(body?.error==='AWS_MIGRATION_PENDING'?'MIGRATION':body?.error==='MONITOR_EGRESS_QUOTA'?'QUOTA':response.status>=500?'SERVER':'INVALID_RESPONSE'),{status:response.status,payload:body});
 }
 if(!jsonType)throw problem('INVALID_RESPONSE');
 let value;try{value=await response.json();}catch{throw problem('INVALID_RESPONSE');}
 if(!value||typeof value!=='object'||Array.isArray(value))throw problem('INVALID_RESPONSE');
 return value;
}
export function monitorPresentation(data,now,receivedAt=null){
 try{return viewModel(data?.[MONITOR_SOURCE]??data,now,receivedAt);}catch{return null;}
}
export function positionValuation(data,position,now){
 const model=monitorPresentation(data,now),id=position?.plan?.id,p=model?.positions.find(row=>row.id===id);
 return {valid:!!p&&p.net!==null,net:p?.net??null,quoteAt:p?.quoteAt??null,reason:p?.net!==null&&p?'CURRENT_ESTIMATE':'VALUATION_UNAVAILABLE'};
}
export function snapshotRecent(data,now){
 const at=data?.generated_at;return Number.isSafeInteger(at)&&at>0&&now-at>=-1000&&now-at<SNAPSHOT_MAX_AGE_MS;
}
// Epoch only protects in-flight requests. Durable ordering belongs to the
// actual producer revision/history contract in snapshotOrder, never this clock.
export function createMonitorAcceptance(){
 let current=null,receivedAt=null,epoch=0,lastOrder=null;
 return {
  begin:()=>epoch,
  clear(){current=null;receivedAt=null;epoch++;},
  get snapshot(){return current;},get receivedAt(){return receivedAt;},get lastOrder(){return lastOrder;},
  accept(incoming,token,now,{detail=false}={}){
   if(token!==epoch)throw problem('STALE_REQUEST');
   const order=snapshotOrder(current,incoming,now);
   if(incoming?.schema!==1)throw problem('INVALID_SNAPSHOT');
   const finances=incoming.secondary_finances??incoming.frequency?.financial_summary;
   if(finances&&(finances.mode!=='PAPER'||finances.ledger!=='FREQUENT_PAPER'))throw problem('INVALID_SNAPSHOT');
   if(order==='OLDER_SNAPSHOT'&&detail&&current&&(incoming.started_at??null)===(current.started_at??null)){
    current=mergeMonitor(current,incoming);lastOrder='DETAIL_EVIDENCE';return current;
   }
   if(order!=='ACCEPT'&&order!=='ACCEPT_NEW_HISTORY')throw problem(order);
   lastOrder=order;
   if(order==='ACCEPT_NEW_HISTORY'){current=null;epoch++;}
   current=mergeMonitor(current,incoming);receivedAt=now;
   return current;
  }
 };
}
