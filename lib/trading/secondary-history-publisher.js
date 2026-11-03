// Bounded publication of durable secondary operations through the existing
// SQLite connection and owner-private dashboard transport. No ledger mutation.
import {hash} from './core.js';
import {PANEL_URL} from './notifier.js';
export const SECONDARY_HISTORY_VERSION='secondary-history-page-1.0.0';
export const HISTORY_PAGE_SIZE=40;
export const HISTORY_MAX_BYTES=512*1024;
export const HISTORY_PUBLISH_MS=15000;
export const HISTORY_KINDS=Object.freeze(['SELECTED','FILLED','PARTIAL_FILL','PARTIAL_CLOSE','CLOSED','NOT_FILLED','ORDER_REMAINDER_CANCELLED','FUNDING_RECONCILED']);
const META='secondary_history_publisher';
const cursor=x=>typeof x==='string'&&/^(0|[1-9]\d{0,15})$/.test(x)&&Number.isSafeInteger(Number(x));
const text=(x,max=160)=>typeof x==='string'&&x.length<=max?x:null;
const number=x=>x!==null&&x!==undefined&&typeof x!=='boolean'&&String(x).length<=80&&Number.isFinite(Number(x))?String(x):null;
const time=x=>Number.isSafeInteger(x)&&x>=0?x:null;
const code=x=>typeof x==='string'&&/^[A-Za-z0-9_:.\/-]{1,160}$/.test(x)?x:null;
const bool=x=>typeof x==='boolean'?x:null;
const compact=(object,keys,convert=number)=>Object.fromEntries(keys.map(key=>[key,convert(object?.[key])]).filter(([,value])=>value!==null));
export function sanitizeSecondaryHistoryEvent(row){
 const e=typeof row.payload==='string'?JSON.parse(row.payload):row.payload;
 if(!HISTORY_KINDS.includes(row.kind)||e?.ledger!=='FREQUENT_PAPER'||e.realTrading===true||e.type!==row.kind||!Number.isSafeInteger(row.rowid)||row.rowid<=0)throw Error('HISTORY_SOURCE_RECORD_INVALID');
 const p=e.plan??{},manual=Boolean(e.management_override||String(e.reason??'').startsWith('MANUAL_'));
 const closed=e.type==='CLOSED',partial=e.type==='PARTIAL_CLOSE',funding=e.type==='FUNDING_RECONCILED',entry=['FILLED','PARTIAL_FILL'].includes(e.type);
 const eligible=manual?{status:'EXCLUDED',reason:'MANUAL_OR_MANAGEMENT_OVERRIDE'}:(closed||partial)&&e.funding_complete===false||closed&&e.result_final===false?{status:'PENDING',reason:'FUNDING_UNRESOLVED'}:{status:'UNKNOWN',reason:'DURABLE_NEURAL_LABEL_NOT_INCLUDED_IN_OPERATION_PROJECTION'};
 const record={event_id:text(row.id),source_cursor:String(row.rowid),id:text(e.id??p.id),type:e.type,at:time(e.at)??Date.parse(row.created_at),created_at:row.created_at,ledger:'FREQUENT_PAPER',realTrading:false,reason:code(e.reason),
  amount_scope:closed?'OPERATION_TOTAL':partial?'EXECUTION_FRAGMENT':funding?'ACCOUNTING_ADJUSTMENT':entry?'ENTRY_FRAGMENT':'ORDER_EVENT',accounted:closed||partial||funding||entry,manual,training_eligibility:eligible,
  ...compact(e,['pnl','fill_pnl','fees','gross','funding','price','qty','fee','entry','remaining_qty','cumulative_qty','requested_qty','amount','net_adjustment','net_after']),
  ...compact(e,['fill_id','direction','pattern','quality','execution_state','order_state'],code),
  timeframe:Number.isSafeInteger(e.timeframe??p.timeframe)?e.timeframe??p.timeframe:null,leverage:Number.isFinite(Number(e.leverage??p.execution_contract?.leverage??p.sizing?.leverage))?Number(e.leverage??p.execution_contract?.leverage??p.sizing?.leverage):null,
  funding_complete:bool(e.funding_complete),result_final:bool(e.result_final),
  plan:{...compact(p,['id','pattern','direction','entry_revision','movement_id','parent_id'],code),timeframe:Number.isSafeInteger(p.timeframe)?p.timeframe:null,leg_index:Number.isInteger(p.leg_index)?p.leg_index:null,...compact(p,['entry','stop','target','holding_ms']),sizing:{...compact(p.sizing,['qty','exposure','initial_margin','risk','target_net','leverage','reserved'])},versions:{entry:code(p.entry_revision),execution:code(p.execution_contract?.version??p.version),economic:code(p.economic_policy?.version),exit:code(p.exit_policy?.version)}},
  profit_protection:e.profit_protection?{...compact(e.profit_protection,['state','exit_policy_version','activation_blocker','exit_reason','deadline_reason'],code),...compact(e.profit_protection,['peak_net','protected_net','required_activation_net','activation_net','basis_qty','remaining_qty','peak_net_per_unit','protected_net_per_unit']),...compact(e.profit_protection,['peak_at','floor_at','trailing_activated_at','effective_expires_at','exit_intent_at'],time)}:null,
  evidence_flags:{entry_fills_observed:Array.isArray(e.entry_fills)&&e.entry_fills.length>0,execution_receipt:Boolean(e.execution_receipt),liquidity_receipt:Boolean(e.liquidity_receipt),funding_receipt:Boolean(e.funding_receipt),data_gaps:Array.isArray(e.data_gaps)&&e.data_gaps.length>0},
 };
 if(!record.event_id||!record.id||time(record.at)===null||!Number.isFinite(Date.parse(record.created_at)))throw Error('HISTORY_SOURCE_RECORD_INVALID');
 return record;
}
function pageBody({kind,records,previousCursor,highWatermark,complete,now}){
 const newest=[...records].reverse(),end=newest[0]?.source_cursor??previousCursor;
 const body={version:SECONDARY_HISTORY_VERSION,kind,mode:'PAPER',realTrading:false,ledger:'FREQUENT_PAPER',cursor:end,previous_cursor:previousCursor==='0'?null:previousCursor,high_watermark:kind==='PAGE'?end:highWatermark,records:newest,backfill_complete:kind==='PAGE'?false:complete,generated_at:kind==='PAGE'?Date.parse(records.at(-1).created_at):now};
 body.hash=hash(body);if(Buffer.byteLength(JSON.stringify(body))>HISTORY_MAX_BYTES)throw Error('HISTORY_PAGE_TOO_LARGE');return body;
}
export class SecondaryHistoryPublisher{
 constructor({store,headers,fetchImpl=fetch,now=()=>Date.now(),enabled=true,panelUrl=PANEL_URL}){
  Object.assign(this,{store,headers,fetchImpl,now,enabled,panelUrl});this.busy=false;this.lastAttempt=0;this.lastSuccess=0;this.lastFullCursor='0';this.lastPublishedCursor='0';this.backfillComplete=false;this.error=null;this.publishedPages=0;
  if(!enabled)return;
  try{const saved=JSON.parse(store.db.prepare('SELECT value FROM metadata WHERE key=?').get(META)?.value??'null');if(saved){if(saved.version!==SECONDARY_HISTORY_VERSION||!cursor(saved.last_full_cursor))throw Error();this.lastFullCursor=saved.last_full_cursor;this.lastPublishedCursor=cursor(saved.last_published_cursor)?saved.last_published_cursor:'0';this.lastSuccess=time(saved.last_success_at)??0;this.backfillComplete=saved.backfill_complete===true;this.publishedPages=Number.isSafeInteger(saved.published_pages)?saved.published_pages:0;}}
  catch{this.error='HISTORY_METADATA_INVALID';this.enabled=false;}
 }
 status(){return {version:SECONDARY_HISTORY_VERSION,enabled:this.enabled,busy:this.busy,last_success_at:this.lastSuccess,last_full_cursor:this.lastFullCursor,last_published_cursor:this.lastPublishedCursor,backfill_complete:this.backfillComplete,error:this.error,published_pages:this.publishedPages,interval_ms:HISTORY_PUBLISH_MS};}
 save(){this.store.db.prepare('INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(META,JSON.stringify({...this.status(),last_attempt_at:this.lastAttempt}));}
 read(high){
  const rows=this.store.db.prepare(`SELECT rowid,id,kind,created_at,CASE WHEN length(CAST(payload AS BLOB))<=1048576 THEN payload ELSE NULL END AS payload FROM events WHERE rowid>? AND rowid<=? AND kind IN (${HISTORY_KINDS.map(()=>'?').join(',')}) AND json_extract(payload,'$.ledger')='FREQUENT_PAPER' ORDER BY rowid ASC LIMIT ?`).all(Number(this.lastFullCursor),Number(high),...HISTORY_KINDS,HISTORY_PAGE_SIZE+1);
  return rows.map(sanitizeSecondaryHistoryEvent);
 }
 async send(page){
  const response=await this.fetchImpl(this.panelUrl+'api/aws/history',{method:'PUT',headers:{...this.headers(),'Content-Type':'application/json'},body:JSON.stringify(page),redirect:'error',signal:AbortSignal.timeout(8000)});
  if(!response.ok)throw Error([401,403].includes(response.status)?'HISTORY_AUTHORIZATION_FAILED':response.status===409?'HISTORY_PUBLICATION_CONFLICT':'HISTORY_UPLOAD_FAILED');
  const receipt=await response.json();if(receipt.hash!==page.hash||receipt.cursor!==page.cursor||receipt.kind!==page.kind)throw Error('HISTORY_RECEIPT_INVALID');
 }
 async publish(){
  const at=this.now(),high=String(this.store.db.prepare('SELECT COALESCE(MAX(rowid),0) AS cursor FROM events').get().cursor);
  if(!cursor(high)||Number(high)<Number(this.lastFullCursor))throw Error('HISTORY_SOURCE_CURSOR_REWIND');
  let rows=this.read(high),pages=0;
  while(rows.length>HISTORY_PAGE_SIZE&&pages<3){
   const page=pageBody({kind:'PAGE',records:rows.slice(0,HISTORY_PAGE_SIZE),previousCursor:this.lastFullCursor,highWatermark:high,complete:false,now:at});
   await this.send(page);this.lastFullCursor=page.cursor;this.publishedPages++;this.save();pages++;rows=this.read(high);
  }
  const complete=rows.length<=HISTORY_PAGE_SIZE,tip=pageBody({kind:'TIP',records:rows.slice(0,HISTORY_PAGE_SIZE),previousCursor:this.lastFullCursor,highWatermark:high,complete,now:at});
  await this.send(tip);this.lastPublishedCursor=tip.cursor;this.backfillComplete=complete;this.lastSuccess=this.now();this.error=null;this.save();return this.status();
 }
 start(){
  if(!this.enabled||this.busy||this.lastAttempt&&this.now()-this.lastAttempt<HISTORY_PUBLISH_MS)return this.task;
  this.busy=true;this.lastAttempt=this.now();
  this.task=this.publish().catch(error=>{this.error=/^HISTORY_[A-Z_]+$/.test(error?.message)?error.message:'HISTORY_UNAVAILABLE';}).finally(()=>{this.busy=false;try{this.save();}catch{this.error='HISTORY_STATUS_UNAVAILABLE';}});
  return this.task;
 }
}
