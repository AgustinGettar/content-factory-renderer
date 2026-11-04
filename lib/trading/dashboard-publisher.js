import {freshness} from './core.js';
import {positions} from './portfolio.js';
import {exitEstimate} from './paper-exits.js';
import {dirname} from 'node:path';
import {mkdir,rename,unlink,stat,statfs} from 'node:fs/promises';
import {createReadStream,createWriteStream} from 'node:fs';
import {Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {createGzip} from 'node:zlib';
import {createCipheriv,randomBytes,createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {projectMonitor,planView} from './monitor-projection.js';
import {PANEL_URL} from './notifier.js';
import {SecondaryHistoryPublisher} from './secondary-history-publisher.js';
export function snapshot(store,feed,now=Date.now(),controls=null,projectSnapshot=null){
 const row=store.row(),audits=store.latest(['FEED_AUDIT'],1),notices=store.notices(20),results=store.latest(['CLOSED','NOT_FILLED','FILLED','SUPPRESSED'],100);
 const d=projectMonitor({states:[row],audits,evaluations:store.latest(['RULE_EVALUATION','EVALUATION_SKIPPED'],12),notices,results,now});
 d.storage='AWS_SQLITE';d.feed={sampled_at:now,connected:feed.state.connected,reconciled:feed.state.reconciled,system:feed.state.system,maintenance:feed.state.maintenanceBlocked,quote:feed.state.quote?{bid:feed.state.quote.bid,ask:feed.state.quote.ask,event_at:feed.state.quote.event_at}:null,trade:feed.state.trade?{price:feed.state.trade.price,event_at:feed.state.trade.event_at}:null,counters:{quotes:feed.counters.quotes,trades:feed.counters.trades,reconnects:feed.counters.reconnects}};
 const s=row.state,marketIssue=freshness(feed.state,now,feed.metadata);
 d.controls={enabled:Boolean(s.exitManagement&&controls),last_poll_at:controls?.lastSuccess??0,error:controls?.error??null,receipts:(s.controls?.receipts??[]).slice(-30)};
 for(const [view,a] of [[d.account,s.research?.versions[s.research?.active]?.account],[d.frequency?.account,s.frequency?.account]])for(const p of view?.positions??[]){const raw=positions(a).find(x=>x.plan.id===p.plan.id);p.live_exit=raw?{...exitEstimate(raw,feed.state.quote,now),fresh:!marketIssue,market_issue:marketIssue}:null;}
 const completed=store.latest(['CLOSED','NOT_FILLED','FUNDING_RECONCILED'],500),fills=store.latest(['FILLED'],500),selected=store.latest(['SELECTED'],300);
 const seen=new Set();d.operations=[];
 for(const {payload:e} of selected){if(!['ENGINE','FREQUENT_PAPER'].includes(e.ledger)||!e.plan||seen.has(e.ledger+e.id))continue;seen.add(e.ledger+e.id);
  const closed=completed.find(x=>['CLOSED','NOT_FILLED'].includes(x.payload.type)&&x.payload.id===e.id&&x.payload.ledger===e.ledger)?.payload,fill=fills.find(x=>x.payload.id===e.id&&x.payload.ledger===e.ledger)?.payload;
  const reconciled=completed.find(x=>x.payload.type==='FUNDING_RECONCILED'&&x.payload.id===e.id&&x.payload.ledger===e.ledger&&x.payload.at>=closed?.at)?.payload;
  d.operations.push({id:e.id,ledger:e.ledger,at:e.at??e.plan.decision_at,status:closed?.type??(fill?'OPEN':'PENDING'),plan:planView(e.plan),entry:fill?{at:fill.at,price:fill.price,qty:fill.qty}:null,exit:operationExitView(closed,reconciled)});if(d.operations.length>=30)break;
 }
 // Positions predating event capture remain visible, with no fabricated evidence.
 for(const [ledger,a] of [['ENGINE',d.account],['FREQUENT_PAPER',d.frequency?.account]])for(const p of [...(a?.positions??[]),...(a?.pending_orders??[])]){
  if(d.operations.some(x=>x.id===p.plan.id&&x.ledger===ledger))continue;
  d.operations.unshift({id:p.plan.id,ledger,at:p.plan.decision_at??p.placed_at??p.entered_at,status:p.entered_at?'OPEN':'PENDING',plan:p.plan,entry:p.entered_at?{at:p.entered_at,price:p.entry,qty:p.qty}:null});
 }
 for(const o of d.operations){const a=o.ledger==='ENGINE'?d.account:d.frequency?.account;const p=a?.positions?.find(x=>x.plan.id===o.id);if(p){o.status='OPEN';o.live_position=p;}}
 // Apply read-only extensions to this exact committed row before any await.
 return projectSnapshot?projectSnapshot(d,s,now):d;
}
export function operationExitView(closed,reconciled=null){
 if(!closed)return null;
 const r=reconciled?.type==='FUNDING_RECONCILED'&&reconciled.id===closed.id&&reconciled.ledger===closed.ledger&&reconciled.at>=closed.at?reconciled:null;
 return {at:closed.at,price:closed.price,pnl:r?.net_after??closed.pnl,reason:closed.reason,quality:closed.quality,
  funding_complete:r?.funding_complete??closed.funding_complete??null,
  result_final:r?r.funding_complete===true:closed.result_final??null,
  funding_reconciled_at:r?.at??null};
}
export const LIVE_PUBLISH_MS=2000;
export const DETAIL_PUBLISH_MS=15000;
export const BACKUP_INTERVAL_MS=3600000;
export const BACKUP_TRANSIENT_RETRY_MS=300000;
export const BACKUP_MAX_BYTES=16*1024*1024;
const BACKUP_FREE_MARGIN=64*1024*1024;
const BACKUP_ERRORS=new Set(['BACKUP_SIZE_LIMIT','BACKUP_KEY_REQUIRED','BACKUP_CONFIGURATION_REQUIRED','BACKUP_AUTHORIZATION_FAILED','BACKUP_STORAGE_SPACE_LOW','BACKUP_STORAGE_CHECK_FAILED','BACKUP_LOCAL_FAILED','BACKUP_UPLOAD_FAILED']);
const backupCode=e=>BACKUP_ERRORS.has(e?.message)?e.message:e?.code==='ENOSPC'?'BACKUP_STORAGE_SPACE_LOW':'BACKUP_UPLOAD_FAILED';
const backupDelay=code=>['BACKUP_SIZE_LIMIT','BACKUP_KEY_REQUIRED','BACKUP_CONFIGURATION_REQUIRED','BACKUP_AUTHORIZATION_FAILED','BACKUP_STORAGE_SPACE_LOW'].includes(code)?BACKUP_INTERVAL_MS:BACKUP_TRANSIENT_RETRY_MS;
// Reject oversized ciphertext while streaming, before a large .enc can fill disk.
export const backupSizeGuard=(limit=BACKUP_MAX_BYTES)=>{let bytes=0;return new Transform({transform(chunk,encoding,done){bytes+=chunk.length;done(bytes>limit?Error('BACKUP_SIZE_LIMIT'):null,bytes>limit?undefined:chunk);}});};
// Immutable proofs and historical contracts travel on the slower detail channel.
// Current positions keep their signed levels, sizing, policy and net valuation;
// the live history keeps exact accounting amounts, quantities and exit reasons.
const liveFields=(value,keys)=>Object.fromEntries(keys.filter(key=>value?.[key]!==undefined).map(key=>[key,value[key]]));
const LIVE_PROOFS=new Set(['evidence','activation_evidence','peak_evidence','floor_evidence','quantity_evidence','exit_quote','execution_receipt','liquidity_receipt','funding_receipt']);
const historyPlan=p=>p?{...liveFields(p,['id','hash','version','entry_revision','execution_model','instrument','pattern','direction','recipe_title','timeframe','entry','limit','stop','target','confirmed_at','decision_at','expires_at','holding_ms','order','fill_model','movement_id','parent_id','leg_index','confirmation_id']),sizing:liveFields(p.sizing,['qty','exposure','initial_margin','reserved','risk','target_net','leverage']),execution_contract:liveFields(p.execution_contract,['version','mode','leverage']),versions:{economic:p.economic_policy?.version??null,exit:p.exit_policy?.version??null},detail_available:true}:null;
const historyEvent=e=>e?.ledger==='FREQUENT_PAPER'?{
 ...liveFields(e,['type','at','id','ledger','reason','entry','price','qty','pnl','fill_pnl','fees','gross','funding','fill_entry_fee','fill_exit_fee','fill_funding','quality','timeframe','direction','leverage','fill_id','remaining_qty','cumulative_qty','requested_qty','execution_state','order_state','funding_complete','result_final','management_override','had_partial','net_adjustment','net_after','amount','profit_protection','training_eligibility','accounted','amount_scope']),
 ...(e.plan?{plan:historyPlan(e.plan)}:{}),detail_available:true,
}:e;
// New risk contracts have large immutable receipts. Their complete signed
// contents stay in SQLite and the unchanged 15-second detail payload. Live
// retains every field read by the cards/charts, including all displayed prices,
// sizing, economic thresholds, protection horizons and movement budgets.
const displayEconomics=e=>liveFields(e,['quantity','expected_net_target','minimum_expected_net_target','effective_exposure','expected_loss_stop','net_rr','min_expected_net_target_fraction']);
const displayPlan=p=>{
 const c=p.execution_contract,r=c?.risk_budget;
 return {...liveFields(p,['id','hash','execution_model','instrument','pattern','family','direction','recipe_title','timeframe','entry','limit','stop','target','confirmed_at','decision_at','expires_at','holding_ms','order','movement_id','parent_id','leg_index']),
  sizing:liveFields(p.sizing,['qty','risk','exposure','reserved','target_net','initial_margin','leverage','financing','liquidation_estimate','net_rr']),quality:p.quality,
  economic_policy:liveFields(p.economic_policy,['version','min_expected_net_target_fraction','funding_estimation_ms']),
  exit_policy:liveFields(p.exit_policy,['version','timeframe','min_activation_net_fraction','target_activation_required','retracement_fraction','min_protected_net_usd','execution_uncertainty_fraction','base_holding_ms','trailing_extension_ms','stagnation_ms']),
  quant_contract:liveFields(p.quant_contract,['version','strategy','regime','statistically_validated','fibonacci']),timeframe_contract:p.timeframe_contract,context:p.context,entry_economics:displayEconomics(p.entry_economics),
  context_admission:liveFields(p.context_admission,['reason','classification','related_position_ids']),
  execution_contract:{...liveFields(c,['version','mode','leverage','realTrading']),
   ...(r?{risk_budget:{policy:liveFields(r.policy,['max_movement_legs']),receipt:liveFields(r.receipt,['movement_budget_usd','exposure_for_aspiration','aspiration_achievable'])}}:{})},
  detail_available:true,
  ...(p.evidence||p.evidence_available?{evidence_available:true}:{})};
};
function compactSecondaryCopies(d){
 const a=d.frequency?.account,newRisk=p=>Boolean(p?.execution_contract?.risk_budget&&typeof p.hash==='string');
 const row=p=>p&&newRisk(p.plan)?{...p,plan:displayPlan(p.plan),...(p.entry_revalidation?{entry_revalidation:displayEconomics(p.entry_revalidation)}:{})}:p;
 const account=a?{...a,position:row(a.position),pending:row(a.pending),positions:(a.positions??[]).map(row),pending_orders:(a.pending_orders??[]).map(row)}:null;
 const operations=(d.operations??[]).map(o=>{
  if(o.ledger!=='FREQUENT_PAPER'||!newRisk(o.plan))return o;
  const plan=displayPlan(o.plan);
  const samePosition=o.live_position?.plan?.id===o.plan.id&&o.live_position?.plan?.hash===o.plan.hash;
  return {...o,plan,...(samePosition?{live_position:{...row(o.live_position),plan:{id:o.plan.id,hash:o.plan.hash,detail_available:true}}}:{})};
 });
 const notices=d.notices?.map(n=>(n.account==='FREQUENT_PAPER'||n.kind?.startsWith('SECONDARY_'))&&newRisk(n.plan)?{...n,plan:displayPlan(n.plan)}:n);
 let result={...d,...(a?{frequency:{...d.frequency,account}}:{}),operations,...(notices?{notices}:{})};
 if(['secondary-timeframes-1.0.0','secondary-timeframes-2.0.0'].includes(d.secondary_execution?.timeframe_execution?.version)&&d.secondary_activity?.frames){
  // The visible frame/pattern projections below remain authoritative for live.
  // Internal and laboratory aliases carry clocks, counts and outcomes only;
  // their complete duplicate decision proofs stay in the detail payload.
  const decision=e=>e?{...liveFields(e,['at','cutoff','pattern','reason','timeframe','context_timeframe','version','entry_revision','reason_text','stale','role','entry_enabled']),criteria:liveFields(e.criteria,['quant_version','regime','pattern_detected','fibonacci']),detail_available:true}:e;
  const decisions=rows=>Object.fromEntries(Object.entries(rows??{}).map(([key,value])=>[key,decision(value)]));
  const x=d.secondary_execution,frames=Object.fromEntries(Object.entries(x.timeframe_execution.frames).map(([tf,f])=>[tf,{...f,decisions:decisions(f.decisions),last_decision:decision(f.last_decision)}]));
  result.secondary_execution={...x,decisions:decisions(x.decisions),timeframe_execution:{...x.timeframe_execution,frames}};
  result.frequency={...result.frequency,lastDecision:decision(d.frequency?.lastDecision),pattern_decisions:decisions(d.frequency?.pattern_decisions)};
  result.laboratory={...d.laboratory,lastDecision:decision(d.laboratory?.lastDecision),trials:d.laboratory?.trials?.map(t=>t.version===x.version?{...t,decisions:decisions(t.decisions),pattern_decisions:decisions(t.pattern_decisions)}:t)};
  result.secondary_activity={...d.secondary_activity,last_evaluation:decision(d.secondary_activity.last_evaluation),frames:Object.fromEntries(Object.entries(d.secondary_activity.frames).map(([tf,f])=>[tf,{...f,last_evaluation:f.last_evaluation?{...f.last_evaluation,pattern_decisions:f.last_evaluation.pattern_decisions?.map(decision)}:f.last_evaluation}]))};
 }
 return result;
}
export const liveBody=d=>JSON.stringify({...compactSecondaryCopies(d),refresh_ms:LIVE_PUBLISH_MS,detail_refresh_ms:DETAIL_PUBLISH_MS},(key,value)=>{
 if(LIVE_PROOFS.has(key))return undefined;
 // Per-frame decisions and allocation summaries repeat these same immutable
 // receipts. Preserve their displayed economics/admission reasons in live;
 // the full quote, pretrade snapshot and signed proof remain in detail.
 if(['secondary-risk-budget-1.0.0','secondary-risk-budget-2.0.0'].includes(value?.version)&&value.operation_id&&value.pretrade&&value.hash)return {...liveFields(value,['version','hash','accepted','reason','at','operation_id','risk','qty','exposure','initial_margin','leverage','movement_budget_usd','expected_net_target','aspiration_achievable']),detail_available:true};
 if(['entry_economics','entry_revalidation'].includes(key)&&value?.policy_version==='secondary-profit-policy-2.0.0')return {...displayEconomics(value),...liveFields(value,['version','stage','evaluated_at','accepted','applied','reason']),detail_available:true};
 if(key==='history'&&Array.isArray(value))return value.map(historyEvent);
 if(value&&typeof value==='object'&&!Array.isArray(value)&&[...LIVE_PROOFS].some(field=>value[field]!==undefined))return {...value,evidence_available:true,...Object.fromEntries([...LIVE_PROOFS].map(field=>[field,undefined]))};
 return value;
});
export class DashboardPublisher {
 constructor({store,feed,env,controls=null,fetchImpl=fetch,now=()=>Date.now(),statfsImpl=statfs}){Object.assign(this,{store,feed,env,controls,fetchImpl,now,statfsImpl});this.busy=false;this.backupBusy=false;this.lastBackup=0;this.lastLocalBackup=0;this.localBackupSlot=null;this.nextBackupAttempt=0;this.lastSuccess=0;this.lastDetail=0;this.lastShape=null;this.error=null;this.detailError=null;this.backupError=null;
  this.history=new SecondaryHistoryPublisher({store,headers:()=>this.headers(),fetchImpl,now,enabled:Boolean(env.LUMI_TRADING_SITE_ACCESS&&env.LUMI_TRADING_PUBLISH_KEY)});
  // Retry throttling survives worker restarts; only bounded codes are restored.
  try{const saved=JSON.parse(store.db.prepare('SELECT value FROM metadata WHERE key=?').get('dashboard')?.value??'null');if(saved){this.lastBackup=Number(saved.backup_at)||0;this.lastLocalBackup=Number(saved.local_backup_at)||0;this.localBackupSlot=[0,1,2].includes(saved.local_backup_slot)?saved.local_backup_slot:null;this.nextBackupAttempt=Number(saved.next_backup_attempt_at)||0;this.backupError=BACKUP_ERRORS.has(saved.backup_error)?saved.backup_error:null;}}catch{}
 }
 headers(){return {'OAI-Sites-Authorization':'Bearer '+this.env.LUMI_TRADING_SITE_ACCESS,'X-Trading-Ingest-Key':this.env.LUMI_TRADING_PUBLISH_KEY};}
 saveStatus(){this.store.db.prepare('INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('dashboard',JSON.stringify({at:this.lastSuccess,backup_at:this.lastBackup,local_backup_at:this.lastLocalBackup,local_backup_slot:this.localBackupSlot,next_backup_attempt_at:this.nextBackupAttempt,error:this.error,detail_at:this.lastDetail,detail_error:this.detailError,backup_error:this.backupError,interval_ms:LIVE_PUBLISH_MS,live_bytes:this.liveBytes}));}
 async send(path,body,revision){
  const r=await this.fetchImpl(PANEL_URL+path,{method:'PUT',headers:{...this.headers(),'Content-Type':'application/json'},body,redirect:'error',signal:AbortSignal.timeout(10000)});
  if(!r.ok)throw Error('DASHBOARD_PUBLISH_FAILED');const ack=await r.json();if(ack.revision!==revision)throw Error('DASHBOARD_RECEIPT_INVALID');
 }
 async publish(){
  if(this.busy)return;this.busy=true;
  try{
   const d=snapshot(this.store,this.feed,this.now(),this.controls,this.projectSnapshot);d.secondary_history=this.history.status();const body=liveBody(d);
   await this.send('api/aws/live',body,d.revision);this.liveBytes=Buffer.byteLength(body);this.lastSuccess=this.now();this.error=null;
   const shape=JSON.stringify(d.operations.map(o=>[o.ledger,o.id,o.status,o.plan.hash]));
   if(this.now()-this.lastDetail>=DETAIL_PUBLISH_MS||shape!==this.lastShape){
    try{await this.send('api/aws/snapshot',JSON.stringify(d),d.revision);this.lastDetail=this.now();this.lastShape=shape;this.detailError=null;}
    catch{this.detailError='DASHBOARD_DETAIL_UNAVAILABLE';}
    // Archival requests have their own bound and never hold up live prices.
    this.history.start();
   }
   // Compression/upload can take seconds. It must never hold up live prices.
   this.startBackup();
  }catch(e){this.error=/^[A-Z_]+$/.test(e.message)?e.message:'DASHBOARD_UNAVAILABLE';console.error(JSON.stringify({event:'trading_dashboard_attention',code:this.error}));}
  finally{this.saveStatus();this.busy=false;}
 }
 startBackup(){
  if(this.backupBusy||this.now()<this.nextBackupAttempt||this.lastLocalBackup&&this.now()-this.lastLocalBackup<BACKUP_INTERVAL_MS&&!this.backupError)return this.backupTask;
  this.backupBusy=true;this.nextBackupAttempt=this.now()+BACKUP_TRANSIENT_RETRY_MS;this.saveStatus();
  this.backupTask=this.backup().then(()=>{this.lastBackup=this.now();this.backupError=null;this.nextBackupAttempt=Math.max(this.now(),this.lastLocalBackup+BACKUP_INTERVAL_MS);}).catch(e=>{this.backupError=backupCode(e);this.nextBackupAttempt=this.now()+backupDelay(this.backupError);}).finally(()=>{this.backupBusy=false;this.saveStatus();});
  return this.backupTask;
 }
 async backupSpace(dir,sourceBytes=0){
  let fs;try{fs=await this.statfsImpl(dir);}catch{throw Error('BACKUP_STORAGE_CHECK_FAILED');}
  const available=BigInt(fs.bavail)*BigInt(fs.bsize),required=BigInt(sourceBytes+BACKUP_MAX_BYTES+BACKUP_FREE_MARGIN);
  if(available<required)throw Error('BACKUP_STORAGE_SPACE_LOW');
 }
 async backup(){
  const dir=dirname(this.store.path)+'/backups';await mkdir(dir,{recursive:true,mode:0o700});
  let slot=this.localBackupSlot,path=dir+'/daily-'+slot+'.sqlite';
  if(!this.lastLocalBackup||this.now()-this.lastLocalBackup>=BACKUP_INTERVAL_MS||slot===null||!await stat(path).then(s=>s.isFile()).catch(()=>false)){
   slot=Math.floor(this.now()/86400000)%3;path=dir+'/daily-'+slot+'.sqlite';const temp=path+'.tmp';let copying=false;
   try{
    const bytes=(await stat(this.store.path)).size,pages=this.store.db.prepare('PRAGMA page_count').get().page_count,pageSize=this.store.db.prepare('PRAGMA page_size').get().page_size;
    await this.backupSpace(dir,Math.max(bytes,pages*pageSize));
    await unlink(temp).catch(()=>{});copying=true;await this.store.backup(temp);await rename(temp,path);
    this.lastLocalBackup=this.now();this.localBackupSlot=slot;this.saveStatus();
   }catch(e){if(copying)await unlink(temp).catch(()=>{});throw Error(BACKUP_ERRORS.has(e?.message)?e.message:e?.code==='ENOSPC'?'BACKUP_STORAGE_SPACE_LOW':'BACKUP_LOCAL_FAILED');}
  }
  const rawKey=this.env.LUMI_TRADING_BACKUP_KEY??'';if(!/^[a-f\d]{64}$/i.test(rawKey))throw Error('BACKUP_KEY_REQUIRED');
  if(!this.env.LUMI_TRADING_SITE_ACCESS||!this.env.LUMI_TRADING_PUBLISH_KEY)throw Error('BACKUP_CONFIGURATION_REQUIRED');
  const key=Buffer.from(rawKey,'hex');await this.backupSpace(dir);
  // A retry may upload an older local snapshot: label its actual revision.
  const local=new DatabaseSync(path,{readOnly:true});let backupRevision;
  try{backupRevision=local.prepare("SELECT revision FROM state WHERE id='KRAKEN_BTCUSD_PAPER'").get()?.revision;if(!Number.isSafeInteger(backupRevision))throw Error('BACKUP_LOCAL_FAILED');}finally{local.close();}
  const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(Buffer.from('lumi-trading-backup-v1'));
  const out=path+'.enc.tmp';
  try{
   await pipeline(createReadStream(path),createGzip(),cipher,backupSizeGuard(),createWriteStream(out,{mode:0o600}));
   const size=(await stat(out)).size,digest=createHash('sha256');for await(const chunk of createReadStream(out))digest.update(chunk);
   const r=await this.fetchImpl(PANEL_URL+'api/aws/backup?slot='+slot,{method:'PUT',headers:{...this.headers(),'Content-Type':'application/octet-stream','Content-Length':String(size),'X-Backup-IV':iv.toString('hex'),'X-Backup-Tag':cipher.getAuthTag().toString('hex'),'X-Backup-SHA256':digest.digest('hex'),'X-Backup-Revision':String(backupRevision)},body:createReadStream(out),duplex:'half',redirect:'error',signal:AbortSignal.timeout(30000)});
   if(!r.ok)throw Error(r.status===413?'BACKUP_SIZE_LIMIT':[401,403].includes(r.status)?'BACKUP_AUTHORIZATION_FAILED':[400,404].includes(r.status)?'BACKUP_CONFIGURATION_REQUIRED':'BACKUP_UPLOAD_FAILED');
  }finally{await unlink(out).catch(()=>{});}
 }
}
