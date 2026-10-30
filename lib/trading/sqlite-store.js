// Local durable PAPER ledger. One fenced writer; atomic checkpoint/event/outbox commits.
import {DatabaseSync,backup} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {TradingStore} from './store.js';
const ID='KRAKEN_BTCUSD_PAPER';
const decode=r=>r?{...r,...Object.fromEntries(['state','payload','receipt'].filter(k=>r[k]!=null).map(k=>[k,JSON.parse(r[k])]))}:null;
const fail=code=>{throw Error(code);};
export class SQLiteStore extends TradingStore {
 constructor(path,{now=()=>Date.now(),allowEmpty=false}={}){
  super(null);this.now=now;this.path=path;
  this.db=new DatabaseSync(path,{timeout:3000});
  this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
   CREATE TABLE IF NOT EXISTS state(id TEXT PRIMARY KEY,revision INTEGER NOT NULL,fence INTEGER NOT NULL,lease_owner TEXT,lease_until TEXT,last_batch TEXT,state TEXT NOT NULL,updated_at TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY,kind TEXT NOT NULL,payload TEXT NOT NULL,created_at TEXT NOT NULL);
   CREATE INDEX IF NOT EXISTS events_kind_time ON events(kind,created_at);
   CREATE TABLE IF NOT EXISTS outbox(id TEXT PRIMARY KEY,kind TEXT NOT NULL,payload TEXT NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL,attempted_at TEXT,finished_at TEXT,claim_id TEXT,receipt TEXT,reason TEXT);
   CREATE INDEX IF NOT EXISTS outbox_status ON outbox(status,created_at);
   CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
  if(!allowEmpty&&!this.row()){this.close();fail('TRADING_MIGRATION_REQUIRED');}
 }
 row(){return decode(this.db.prepare('SELECT * FROM state WHERE id=?').get(ID));}
 atomic(fn){this.db.exec('BEGIN IMMEDIATE');try{const result=fn();this.db.exec('COMMIT');return result;}catch(e){this.db.exec('ROLLBACK');throw e;}}
 import(bundle){
  return this.atomic(()=>{
   if(this.row())fail('TRADING_IMPORT_WOULD_OVERWRITE');
   const s=bundle.state;
   if(bundle.schema!==1||s?.id!==ID||!Number.isSafeInteger(s.revision)||!s.state?.research||!Array.isArray(bundle.events)||!Array.isArray(bundle.outbox))fail('TRADING_IMPORT_INVALID');
   if(Date.parse(s.lease_until)>this.now())fail('TRADING_SOURCE_LEASE_ACTIVE');
   if(bundle.counts.events!==bundle.events.length||bundle.counts.outbox!==bundle.outbox.length)fail('TRADING_IMPORT_INCOMPLETE');
   this.db.prepare('INSERT INTO state VALUES(?,?,?,?,?,?,?,?)').run(ID,s.revision,s.fence,null,null,s.last_batch,JSON.stringify(s.state),s.updated_at);
   const e=this.db.prepare('INSERT INTO events VALUES(?,?,?,?)'),n=this.db.prepare('INSERT INTO outbox VALUES(?,?,?,?,?,?,?,?,?,?)');
   for(const r of bundle.events)e.run(r.id,r.kind,JSON.stringify(r.payload),r.created_at);
   for(const r of bundle.outbox)n.run(r.id,r.kind,JSON.stringify(r.payload),r.status,r.created_at,r.attempted_at,r.finished_at,r.claim_id,r.receipt===null?null:JSON.stringify(r.receipt),r.reason);
   this.db.prepare('INSERT INTO metadata VALUES(?,?)').run('migration',JSON.stringify({source:'SUPABASE',revision:s.revision,exported_at:bundle.exported_at,counts:bundle.counts,at:this.now()}));
   return {revision:s.revision,events:bundle.events.length,outbox:bundle.outbox.length};
  });
 }
 async tx(args){
  const p={owner:this.owner,fence:this.fence,...args};
  if(!p.owner)fail('TRADING_OWNER_REQUIRED');
  if(Buffer.byteLength(JSON.stringify(p))>8000000)fail('TRADING_PAYLOAD_LIMIT');
  return this.atomic(()=>{
   const s=this.row(),now=this.now(),stamp=new Date(now).toISOString(),until=new Date(now+45000).toISOString();
   if(!s)fail('TRADING_MIGRATION_REQUIRED');
   if(p.phase==='ACQUIRE'){
    if(Date.parse(s.lease_until)>now&&s.lease_owner!==p.owner)fail('TRADING_LEASE_BUSY');
    const changed=s.lease_owner!==p.owner||!(Date.parse(s.lease_until)>now),fence=s.fence+(changed?1:0);
    if(changed)this.db.prepare("UPDATE outbox SET status='UNKNOWN',reason='PROCESS_RESTART_DURING_SEND',finished_at=? WHERE status='DISPATCHING'").run(stamp);
    this.db.prepare('UPDATE state SET lease_owner=?,lease_until=?,fence=? WHERE id=?').run(p.owner,until,fence,ID);return this.row();
   }
   if(s.lease_owner!==p.owner||!(Date.parse(s.lease_until)>now)||s.fence!==p.fence)fail('TRADING_LEASE_LOST');
   if(p.phase==='RENEW'||p.phase==='RELEASE'){this.db.prepare('UPDATE state SET lease_until=? WHERE id=?').run(p.phase==='RENEW'?until:stamp,ID);return {ok:true};}
   if(p.phase==='COMMIT'){
    if(p.batch&&p.batch===s.last_batch)return {revision:s.revision};
    if(s.revision!==p.revision)fail('TRADING_CAS_CONFLICT');
    for(const [table,rows,code] of [['events',p.events??[],'TRADING_EVENT_CONFLICT'],['outbox',p.notices??[],'TRADING_NOTICE_CONFLICT']]){
     for(const e of rows){const old=decode(this.db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(e.id));
      if(old&&(!isDeepStrictEqual(old.payload,e.payload)||old.kind!==e.kind))fail(code);
      if(!old){if(table==='events')this.db.prepare('INSERT INTO events VALUES(?,?,?,?)').run(e.id,e.kind,JSON.stringify(e.payload),stamp);
       else this.db.prepare("INSERT INTO outbox(id,kind,payload,status,created_at) VALUES(?,?,?,'QUEUED',?)").run(e.id,e.kind,JSON.stringify(e.payload),stamp);}
     }
    }
    this.db.prepare('UPDATE state SET state=?,revision=revision+1,last_batch=?,updated_at=? WHERE id=?').run(JSON.stringify(p.state),p.batch,stamp,ID);return {revision:s.revision+1};
   }
   if(p.phase==='CLAIM'){
    const o=decode(this.db.prepare('SELECT * FROM outbox WHERE id=?').get(p.id));if(!o||o.status!=='QUEUED')return o??{};
    if(o.kind==='SIGNAL'&&(!(o.payload.plan?.decision_at+30000>=now)||!(o.payload.plan?.expires_at>now)))this.db.prepare("UPDATE outbox SET status='EXPIRED',reason='NOTICE_EXPIRED',finished_at=? WHERE id=?").run(stamp,p.id);
    else{if(!p.claim_id)fail('TRADING_CLAIM_REQUIRED');this.db.prepare("UPDATE outbox SET status='DISPATCHING',claim_id=?,attempted_at=? WHERE id=?").run(p.claim_id,stamp,p.id);}
    return decode(this.db.prepare('SELECT * FROM outbox WHERE id=?').get(p.id));
   }
   if(p.phase==='FINISH'){
    if(!['DELIVERED','REJECTED','UNKNOWN','EXPIRED'].includes(p.status))fail('TRADING_INVALID_STATUS');
    const r=this.db.prepare("UPDATE outbox SET status=?,receipt=?,reason=?,finished_at=? WHERE id=? AND status='DISPATCHING' AND claim_id=?").run(p.status,JSON.stringify(p.receipt??{}),p.reason??null,stamp,p.id,p.claim_id??null);
    if(r.changes!==1)fail('TRADING_CLAIM_CONFLICT');return decode(this.db.prepare('SELECT * FROM outbox WHERE id=?').get(p.id));
   }
   fail('TRADING_PHASE_INVALID');
  });
 }
 async queued(){return this.db.prepare("SELECT * FROM outbox WHERE status='QUEUED' ORDER BY created_at LIMIT 20").all().map(decode);}
 async deliveredSince(at){return this.db.prepare("SELECT * FROM outbox WHERE status='DELIVERED' AND kind='SIGNAL' AND finished_at>=? ORDER BY finished_at LIMIT 100").all(new Date(at).toISOString()).map(decode);}
 async history(kind,since=0){const rows=this.db.prepare('SELECT payload FROM events WHERE kind=? AND created_at>=? ORDER BY created_at LIMIT 100001').all(kind,new Date(since).toISOString());if(rows.length>100000)fail('TRADING_RESEARCH_RESOURCE_LIMIT');return rows.map(r=>JSON.parse(r.payload));}
 latest(kinds,limit=30){return this.db.prepare(`SELECT * FROM events WHERE kind IN (${kinds.map(()=>'?').join(',')}) ORDER BY created_at DESC LIMIT ?`).all(...kinds,limit).map(decode);}
 notices(limit=20){return this.db.prepare('SELECT * FROM outbox ORDER BY created_at DESC LIMIT ?').all(limit).map(decode);}
 async backup(path){await backup(this.db,path);}
 close(){this.db.close();}
}
