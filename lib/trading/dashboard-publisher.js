import {freshness} from './core.js';
import {positions} from './portfolio.js';
import {exitEstimate} from './paper-exits.js';
import {dirname} from 'node:path';
import {mkdir,rename,unlink,stat} from 'node:fs/promises';
import {createReadStream,createWriteStream} from 'node:fs';
import {pipeline} from 'node:stream/promises';
import {createGzip} from 'node:zlib';
import {createCipheriv,randomBytes,createHash} from 'node:crypto';
import {projectMonitor,planView} from './monitor-projection.js';
import {PANEL_URL} from './notifier.js';
export function snapshot(store,feed,now=Date.now(),controls=null){
 const row=store.row(),audits=store.latest(['FEED_AUDIT'],1),notices=store.notices(20),results=store.latest(['CLOSED','NOT_FILLED','FILLED','SUPPRESSED'],100);
 const d=projectMonitor({states:[row],audits,evaluations:store.latest(['RULE_EVALUATION','EVALUATION_SKIPPED'],12),notices,results,now});
 d.storage='AWS_SQLITE';d.feed={sampled_at:now,connected:feed.state.connected,reconciled:feed.state.reconciled,system:feed.state.system,maintenance:feed.state.maintenanceBlocked,quote:feed.state.quote?{bid:feed.state.quote.bid,ask:feed.state.quote.ask,event_at:feed.state.quote.event_at}:null,trade:feed.state.trade?{price:feed.state.trade.price,event_at:feed.state.trade.event_at}:null,counters:{quotes:feed.counters.quotes,trades:feed.counters.trades,reconnects:feed.counters.reconnects}};
 const s=row.state,marketIssue=freshness(feed.state,now,feed.metadata);
 d.controls={enabled:Boolean(s.exitManagement&&controls),last_poll_at:controls?.lastSuccess??0,error:controls?.error??null,receipts:(s.controls?.receipts??[]).slice(-30)};
 for(const [view,a] of [[d.account,s.research?.versions[s.research?.active]?.account],[d.frequency?.account,s.frequency?.account]])for(const p of view?.positions??[]){const raw=positions(a).find(x=>x.plan.id===p.plan.id);p.live_exit=raw?{...exitEstimate(raw,feed.state.quote,now),fresh:!marketIssue,market_issue:marketIssue}:null;}
 const completed=store.latest(['CLOSED','NOT_FILLED'],500),fills=store.latest(['FILLED'],500),selected=store.latest(['SELECTED'],300);
 const seen=new Set();d.operations=[];
 for(const {payload:e} of selected){if(!['ENGINE','FREQUENT_PAPER'].includes(e.ledger)||!e.plan||seen.has(e.ledger+e.id))continue;seen.add(e.ledger+e.id);
  const closed=completed.find(x=>x.payload.id===e.id&&x.payload.ledger===e.ledger)?.payload,fill=fills.find(x=>x.payload.id===e.id&&x.payload.ledger===e.ledger)?.payload;
  d.operations.push({id:e.id,ledger:e.ledger,at:e.at??e.plan.decision_at,status:closed?.type??(fill?'OPEN':'PENDING'),plan:planView(e.plan),entry:fill?{at:fill.at,price:fill.price,qty:fill.qty}:null,exit:closed?{at:closed.at,price:closed.price,pnl:closed.pnl,reason:closed.reason,quality:closed.quality}:null});if(d.operations.length>=30)break;
 }
 // Positions predating event capture remain visible, with no fabricated evidence.
 for(const [ledger,a] of [['ENGINE',d.account],['FREQUENT_PAPER',d.frequency?.account]])for(const p of [...(a?.positions??[]),...(a?.pending_orders??[])]){
  if(d.operations.some(x=>x.id===p.plan.id&&x.ledger===ledger))continue;
  d.operations.unshift({id:p.plan.id,ledger,at:p.plan.decision_at??p.placed_at??p.entered_at,status:p.entered_at?'OPEN':'PENDING',plan:p.plan,entry:p.entered_at?{at:p.entered_at,price:p.entry,qty:p.qty}:null});
 }
 for(const o of d.operations){const a=o.ledger==='ENGINE'?d.account:d.frequency?.account;const p=a?.positions?.find(x=>x.plan.id===o.id);if(p){o.status='OPEN';o.live_position=p;}}
 return d;
}
export const LIVE_PUBLISH_MS=2000;
export const DETAIL_PUBLISH_MS=15000;
// Live state keeps authoritative numbers and statuses but omits immutable candle
// evidence. The full channel retains that evidence for the decision chart.
export const liveBody=d=>JSON.stringify({...d,refresh_ms:LIVE_PUBLISH_MS,detail_refresh_ms:DETAIL_PUBLISH_MS},(key,value)=>key==='evidence'?undefined:value?.evidence?{...value,evidence_available:true,evidence:undefined}:value);
export class DashboardPublisher {
 constructor({store,feed,env,controls=null,fetchImpl=fetch,now=()=>Date.now()}){Object.assign(this,{store,feed,env,controls,fetchImpl,now});this.busy=false;this.backupBusy=false;this.lastBackup=0;this.nextBackupAttempt=0;this.lastSuccess=0;this.lastDetail=0;this.lastShape=null;this.error=null;this.detailError=null;this.backupError=null;}
 headers(){return {'OAI-Sites-Authorization':'Bearer '+this.env.LUMI_TRADING_SITE_ACCESS,'X-Trading-Ingest-Key':this.env.LUMI_TRADING_PUBLISH_KEY};}
 saveStatus(){this.store.db.prepare('INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('dashboard',JSON.stringify({at:this.lastSuccess,backup_at:this.lastBackup,error:this.error,detail_at:this.lastDetail,detail_error:this.detailError,backup_error:this.backupError,interval_ms:LIVE_PUBLISH_MS,live_bytes:this.liveBytes}));}
 async send(path,body,revision){
  const r=await this.fetchImpl(PANEL_URL+path,{method:'PUT',headers:{...this.headers(),'Content-Type':'application/json'},body,redirect:'error',signal:AbortSignal.timeout(10000)});
  if(!r.ok)throw Error('DASHBOARD_PUBLISH_FAILED');const ack=await r.json();if(ack.revision!==revision)throw Error('DASHBOARD_RECEIPT_INVALID');
 }
 async publish(){
  if(this.busy)return;this.busy=true;
  try{
   const d=snapshot(this.store,this.feed,this.now(),this.controls),body=liveBody(d);
   await this.send('api/aws/live',body,d.revision);this.liveBytes=Buffer.byteLength(body);this.lastSuccess=this.now();this.error=null;
   const shape=JSON.stringify(d.operations.map(o=>[o.ledger,o.id,o.status,o.plan.hash]));
   if(this.now()-this.lastDetail>=DETAIL_PUBLISH_MS||shape!==this.lastShape){
    try{await this.send('api/aws/snapshot',JSON.stringify(d),d.revision);this.lastDetail=this.now();this.lastShape=shape;this.detailError=null;}
    catch{this.detailError='DASHBOARD_DETAIL_UNAVAILABLE';}
   }
   // Compression/upload can take seconds. It must never hold up live prices.
   if(!this.backupBusy&&this.now()-this.lastBackup>3600000&&this.now()>=this.nextBackupAttempt){
    this.backupBusy=true;this.nextBackupAttempt=this.now()+60000;
    this.backupTask=this.backup().then(()=>{this.lastBackup=this.now();this.backupError=null;}).catch(()=>{this.backupError='BACKUP_UPLOAD_FAILED';}).finally(()=>{this.backupBusy=false;this.saveStatus();});
   }
  }catch(e){this.error=/^[A-Z_]+$/.test(e.message)?e.message:'DASHBOARD_UNAVAILABLE';console.error(JSON.stringify({event:'trading_dashboard_attention',code:this.error}));}
  finally{this.saveStatus();this.busy=false;}
 }
 async backup(){
  const dir=dirname(this.store.path)+'/backups';await mkdir(dir,{recursive:true,mode:0o700});
  const slot=Math.floor(this.now()/86400000)%3,path=dir+'/daily-'+slot+'.sqlite',temp=path+'.tmp';
  await unlink(temp).catch(()=>{});await this.store.backup(temp);await rename(temp,path);
  const key=Buffer.from(this.env.LUMI_TRADING_BACKUP_KEY??'','hex');if(key.length!==32)throw Error('BACKUP_KEY_REQUIRED');
  const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(Buffer.from('lumi-trading-backup-v1'));
  const out=path+'.enc';await pipeline(createReadStream(path),createGzip(),cipher,createWriteStream(out,{mode:0o600}));
  const size=(await stat(out)).size;if(size>16*1024*1024)throw Error('BACKUP_SIZE_LIMIT');
  const digest=createHash('sha256');for await(const chunk of createReadStream(out))digest.update(chunk);
  const r=await this.fetchImpl(PANEL_URL+'api/aws/backup?slot='+slot,{method:'PUT',headers:{...this.headers(),'Content-Type':'application/octet-stream','Content-Length':String(size),'X-Backup-IV':iv.toString('hex'),'X-Backup-Tag':cipher.getAuthTag().toString('hex'),'X-Backup-SHA256':digest.digest('hex'),'X-Backup-Revision':String(this.store.revision)},body:createReadStream(out),duplex:'half',redirect:'error',signal:AbortSignal.timeout(30000)});
  if(!r.ok)throw Error('BACKUP_UPLOAD_FAILED');await unlink(out);
 }
}
