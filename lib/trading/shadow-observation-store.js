// Dedicated observation database. This module has no operational-store import
// and must never be pointed at the account database, even for reading.
import {DatabaseSync} from 'node:sqlite';
import {closeSync,existsSync,lstatSync,openSync,readSync,realpathSync,statSync} from 'node:fs';
import {basename,dirname,resolve} from 'node:path';
import {hash} from './core.js';
import {secondaryFresh} from './secondary-futures-math.js';
import {processShadowObservation,SHADOW_STORE_VERSION} from './shadow-observation-processor.js';
const APP=0x4c534844;
export const SHADOW_STORE_LIMITS=Object.freeze({maxBytes:128*1024*1024,maxLogicalBytes:80*1024*1024,maxInputs:300000,maxTasks:128,maxEnvelopeBytes:256*1024,retentionMs:72*3600000,maxActiveWindowMs:48*3600000,maxQuoteGapMs:5000,endpointGraceMs:10000});
const clone=x=>structuredClone(x),json=x=>JSON.stringify(x),parse=x=>JSON.parse(x),int=x=>Number.isSafeInteger(x)&&x>=0;
const fail=code=>{const e=new Error(code);e.code=code;throw e;};
function safePath(path,operationalPath){
 if(typeof path!=='string'||!path||!/(?:^|[-_.])shadow(?:[-_.]|$)/i.test(basename(path))||!/[.]sqlite(?:3)?$/.test(path))fail('SHADOW_PATH_REQUIRED');
 const full=resolve(realpathSync(dirname(resolve(path))),basename(path));
 if(operationalPath){const op=existsSync(operationalPath)?realpathSync(operationalPath):resolve(operationalPath);if(full===op)fail('SHADOW_PATH_OPERATIONAL_CONFLICT');}
 if(existsSync(full)){
  const st=lstatSync(full);if(st.isSymbolicLink()||!st.isFile()||st.nlink!==1)fail('SHADOW_PATH_LINK_REJECTED');
  if(operationalPath&&existsSync(operationalPath)){const op=statSync(operationalPath);if(op.dev===st.dev&&op.ino===st.ino)fail('SHADOW_PATH_OPERATIONAL_CONFLICT');}
  if(st.size<100)fail('SHADOW_SCHEMA_UNRECOGNIZED');
  const fd=openSync(full,'r'),b=Buffer.alloc(100);try{readSync(fd,b,0,100,0);}finally{closeSync(fd);}
  if(b.subarray(0,16).toString()!=='SQLite format 3\0'||b.readUInt32BE(68)!==APP)fail('SHADOW_SCHEMA_UNRECOGNIZED');
 }else closeSync(openSync(full,'wx',0o600));
 return full;
}
export class ShadowObservationStore{
 constructor({path,operationalPath,limits={},now=()=>Date.now(),fault=()=>{}}={}){
  this.path=safePath(path,operationalPath);this.now=now;this.fault=fault;
  this.limits={...SHADOW_STORE_LIMITS,...limits};
  for(const [key,value] of Object.entries(this.limits))if(!(key in SHADOW_STORE_LIMITS)||!int(value)||value<=0||value>SHADOW_STORE_LIMITS[key])fail('SHADOW_LIMITS_INVALID');
  this.db=new DatabaseSync(this.path);this.db.exec(`PRAGMA application_id=${APP}; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=50; PRAGMA wal_autocheckpoint=64; PRAGMA journal_size_limit=1048576; PRAGMA max_page_count=${Math.floor(this.limits.maxBytes*.9/4096)};`);
  this.db.exec(`CREATE TABLE IF NOT EXISTS inputs(sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,hash TEXT NOT NULL,kind TEXT NOT NULL,at INTEGER NOT NULL,received_at INTEGER NOT NULL,stream_id TEXT,source_seq INTEGER,ack TEXT NOT NULL);
   CREATE INDEX IF NOT EXISTS inputs_at ON inputs(at);
   CREATE TABLE IF NOT EXISTS cursors(key TEXT PRIMARY KEY,revision INTEGER NOT NULL,value TEXT NOT NULL,updated_at INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS records(sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,type TEXT NOT NULL,at INTEGER NOT NULL,payload TEXT NOT NULL);
   CREATE INDEX IF NOT EXISTS records_at ON records(at);
   CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,status TEXT NOT NULL,window_start INTEGER NOT NULL,window_end INTEGER NOT NULL,value TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS paths(sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,event_at INTEGER,received_at INTEGER NOT NULL,consumed INTEGER NOT NULL,valid INTEGER NOT NULL,payload TEXT NOT NULL);
   CREATE INDEX IF NOT EXISTS paths_at ON paths(event_at,sequence);
   CREATE INDEX IF NOT EXISTS paths_received ON paths(received_at);
   CREATE TABLE IF NOT EXISTS gaps(id TEXT PRIMARY KEY,from_at INTEGER NOT NULL,to_at INTEGER NOT NULL,domain TEXT NOT NULL,reason TEXT NOT NULL,open INTEGER NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL DEFAULT 0,closed_by TEXT);
   CREATE INDEX IF NOT EXISTS gaps_at ON gaps(from_at,to_at);
   CREATE TABLE IF NOT EXISTS metrics(key TEXT PRIMARY KEY,value INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS usage(id INTEGER PRIMARY KEY CHECK(id=1),bytes INTEGER NOT NULL,inputs INTEGER NOT NULL);
   INSERT OR IGNORE INTO usage VALUES(1,0,0);`);
  // Only the already identified, dedicated shadow database may contain a prior
  // local schema. This additive observation metadata never opens account data.
  const gapColumns=new Set(this.db.prepare('PRAGMA table_info(gaps)').all().map(r=>r.name));
  for(const [column,definition] of [['open','INTEGER NOT NULL DEFAULT 0'],['updated_at','INTEGER NOT NULL DEFAULT 0'],['closed_by','TEXT']])if(!gapColumns.has(column))this.db.exec(`ALTER TABLE gaps ADD COLUMN ${column} ${definition}`);
  // Constant-time accounting: a high-rate quote stream must not scan its entire
  // history for each insertion. These counters participate in the transaction.
  for(const [table,field,overhead] of [['inputs','ack',320],['records','payload',128],['paths','payload',128],['tasks','value',128],['cursors','value',128],['gaps','reason',192]]){
   this.db.exec(`CREATE TRIGGER IF NOT EXISTS usage_${table}_insert AFTER INSERT ON ${table} BEGIN UPDATE usage SET bytes=bytes+length(new.${field})+${overhead}${table==='inputs'?',inputs=inputs+1':''} WHERE id=1; END;
    CREATE TRIGGER IF NOT EXISTS usage_${table}_delete AFTER DELETE ON ${table} BEGIN UPDATE usage SET bytes=bytes-length(old.${field})-${overhead}${table==='inputs'?',inputs=inputs-1':''} WHERE id=1; END;
    CREATE TRIGGER IF NOT EXISTS usage_${table}_update AFTER UPDATE ON ${table} BEGIN UPDATE usage SET bytes=bytes+length(new.${field})-length(old.${field}) WHERE id=1; END;`);
  }
  this.db.prepare('INSERT OR IGNORE INTO meta VALUES(?,?)').run('version',SHADOW_STORE_VERSION);
  if(this.db.prepare('SELECT value FROM meta WHERE key=?').get('version').value!==SHADOW_STORE_VERSION)fail('SHADOW_SCHEMA_VERSION_UNSUPPORTED');
 }
 apply(envelope,context){return this.process(envelope,context);}
 process(envelope,context={}){
  if(!envelope||typeof envelope.id!=='string'||!envelope.id||envelope.id.length>256||!['DECISION','OPPORTUNITY','CONTEXT','QUOTE','ECONOMIC','CLOSED','GAP','BOOT','HEARTBEAT'].includes(envelope.kind)||!int(envelope.at)||!int(envelope.received_at)||!envelope.payload||typeof envelope.payload!=='object')fail('SHADOW_ENVELOPE_INVALID');
  const encoded=json(envelope);if(Buffer.byteLength(encoded)>this.limits.maxEnvelopeBytes)fail('SHADOW_ENVELOPE_TOO_LARGE');
  // A replayed event can arrive through a new transport session/sequence. These
  // transport coordinates are evidence, not the economic observation identity.
  const identity={...envelope};delete identity.stream_id;delete identity.source_seq;
  const digest=hash(identity),db=this.db,at=envelope.at;
  db.exec('BEGIN IMMEDIATE');let committed=false;
  try{
   const previous=db.prepare('SELECT hash,ack FROM inputs WHERE id=?').get(envelope.id);
   if(previous){if(previous.hash!==digest)fail('SHADOW_EVENT_CONFLICT');db.exec('COMMIT');committed=true;return {...parse(previous.ack),duplicate:true};}
   const high=Math.max(at,Number(db.prepare('SELECT value FROM meta WHERE key=?').get('high_water')?.value??at));
   if(at<high-this.limits.retentionMs)fail('SHADOW_ENVELOPE_EXPIRED');
   this.prune(high);
   const count=db.prepare('SELECT inputs AS n FROM usage WHERE id=1').get().n;if(count>=this.limits.maxInputs)fail('SHADOW_STORAGE_CAP_REACHED');
   db.prepare('INSERT INTO inputs(id,hash,kind,at,received_at,stream_id,source_seq,ack) VALUES(?,?,?,?,?,?,?,?)').run(envelope.id,digest,envelope.kind,at,envelope.received_at,envelope.stream_id??null,envelope.source_seq??null,'{}');
   this.fault('after_input',envelope);
   const result=processShadowObservation(clone(envelope),this.context(envelope),context);
   this.fault('after_derivation',envelope);
   const ack={id:envelope.id,durable:true,duplicate:false,...result};
   db.prepare('UPDATE inputs SET ack=? WHERE id=?').run(json(ack),envelope.id);
   const bytes=db.prepare('SELECT bytes AS n FROM usage WHERE id=1').get().n;
   if(bytes>this.limits.maxLogicalBytes)fail('SHADOW_STORAGE_CAP_REACHED');
   db.prepare('INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('high_water',String(high));
   this.fault('before_commit',envelope);db.exec('COMMIT');committed=true;
   this.fault('after_commit',envelope);return ack;
  }catch(e){if(!committed)db.exec('ROLLBACK');throw e;}
 }
 context(envelope){
  const db=this.db,at=envelope.at,store=this;
  return {
   limits:this.limits,
   metric(key,amount=1){db.prepare('INSERT INTO metrics VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=value+excluded.value').run(key,amount);},
   cursor(key){const row=db.prepare('SELECT revision,value FROM cursors WHERE key=?').get(key);return row?{revision:row.revision,value:parse(row.value)}:null;},
   putCursor(key,revision,value){const old=db.prepare('SELECT revision FROM cursors WHERE key=?').get(key);if((old?.revision??0)!==revision)fail('SHADOW_CURSOR_CONFLICT');db.prepare('INSERT INTO cursors VALUES(?,?,?,?) ON CONFLICT(key) DO UPDATE SET revision=excluded.revision,value=excluded.value,updated_at=excluded.updated_at').run(key,revision+1,json(value),at);},
   emit(record){const data=json(record.payload),old=db.prepare('SELECT payload,type FROM records WHERE id=?').get(record.id);if(old){if(hash(parse(old.payload))!==hash(record.payload)||old.type!==record.type)fail('SHADOW_RECORD_CONFLICT');return;}db.prepare('INSERT INTO records(id,type,at,payload) VALUES(?,?,?,?)').run(record.id,record.type,record.at,data);store.fault('after_record',envelope);},
   pendingTasks(){return db.prepare("SELECT value FROM tasks WHERE status='PENDING' ORDER BY window_end LIMIT ?").all(store.limits.maxTasks).map(r=>parse(r.value));},
   schedule(task){const old=db.prepare('SELECT value FROM tasks WHERE id=?').get(task.id);if(old){const previous=parse(old.value);if(previous.operation_id!==task.operation_id||previous.closed_at!==task.closed_at||previous.timeframe!==task.timeframe)fail('SHADOW_TASK_CONFLICT');return;}if(db.prepare("SELECT count(*) AS n FROM tasks WHERE status='PENDING'").get().n>=store.limits.maxTasks)fail('SHADOW_TASK_CAP_REACHED');db.prepare('INSERT INTO tasks VALUES(?,?,?,?,?)').run(task.id,task.status,task.window_start,task.window_end,json(task));store.fault('after_task',envelope);},
   putTask(task){if(db.prepare('UPDATE tasks SET status=?,value=? WHERE id=?').run(task.status,json(task),task.id).changes!==1)fail('SHADOW_TASK_MISSING');},
   appendPath(input){const q=input.payload.quote,valid=secondaryFresh(q,input.at)&&q.received_at<=input.received_at&&q.event_at<=input.at;db.prepare('INSERT INTO paths(id,event_at,received_at,consumed,valid,payload) VALUES(?,?,?,?,?,?)').run(input.id,int(q?.event_at)?q.event_at:null,input.received_at,input.payload.consumed_by_simulator===true?1:0,valid?1:0,json(input.payload));},
   endpoint(from,to,receivedBy){const row=db.prepare('SELECT * FROM paths WHERE valid=1 AND event_at>=? AND event_at<=? AND received_at<=? ORDER BY event_at,sequence LIMIT 1').get(from,to,receivedBy);return row?{...row,payload:parse(row.payload)}:null;},
   coverage(from,to){return store.coverage(from,to);},
   gap(gap){
    if(!int(gap.from_at)||!int(gap.to_at)||gap.from_at>gap.to_at)fail('SHADOW_GAP_INVALID');
    const old=db.prepare('SELECT * FROM gaps WHERE id=?').get(gap.id),domain=gap.domain??'MARKET';
    if(old&&(old.domain!==domain||old.reason!==gap.reason))fail('SHADOW_GAP_IDENTITY_CONFLICT');
    db.prepare(`INSERT INTO gaps(id,from_at,to_at,domain,reason,open,updated_at,closed_by) VALUES(?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET from_at=min(from_at,excluded.from_at),to_at=max(to_at,excluded.to_at),
     open=CASE WHEN gaps.open=0 THEN 0 WHEN excluded.updated_at>=gaps.updated_at THEN excluded.open ELSE gaps.open END,
     closed_by=CASE WHEN gaps.open=1 AND excluded.open=0 AND excluded.updated_at>=gaps.updated_at THEN excluded.closed_by ELSE gaps.closed_by END,
     updated_at=max(updated_at,excluded.updated_at)`).run(gap.id,gap.from_at,gap.to_at,domain,gap.reason,gap.open===true?1:0,at,gap.open===true?null:'OBSERVED_EPISODE_END');
   },
   closeOpenGaps(){db.prepare("UPDATE gaps SET open=0,to_at=max(to_at,?),updated_at=max(updated_at,?),closed_by='BOOT_WITH_CONTINUITY_UNKNOWN' WHERE open=1").run(at,at);}
  };
 }
 coverage(from,to){
  const rows=this.db.prepare('SELECT event_at,valid FROM paths WHERE consumed=1 AND event_at>=? AND event_at<=? ORDER BY event_at,sequence').all(from,to),reasons=[];
  if(!rows.length)reasons.push('SIMULATOR_PATH_MISSING');
  else{if(rows[0].event_at>from)reasons.push('ENTRY_PATH_PREFIX_MISSING');if(to-rows.at(-1).event_at>this.limits.maxQuoteGapMs)reasons.push('SIMULATOR_PATH_SUFFIX_MISSING');let last=rows[0].event_at;for(const row of rows){if(!row.valid)reasons.push('INVALID_QUOTE_IN_PATH');if(row.event_at-last>this.limits.maxQuoteGapMs)reasons.push('EXECUTABLE_QUOTE_GAP');last=Math.max(last,row.event_at);}}
  const gaps=this.db.prepare('SELECT * FROM gaps WHERE from_at<=? AND (open=1 OR to_at>=?)').all(to,from);
  for(const gap of gaps)if(gap.domain==='MARKET')reasons.push(gap.reason);
  const unique=[...new Set(reasons)];return {complete:unique.length===0,reasons:unique,quotes:rows.length,from_at:from,to_at:to,max_quote_gap_ms:this.limits.maxQuoteGapMs,funding_complete:rows.length>0&&!gaps.some(g=>g.domain==='FUNDING'),flow_complete:false,flow_observation:'VOLATILE_WITH_CAUSAL_DECISION_SNAPSHOTS',gaps:gaps.map(g=>({...g}))};
 }
 prune(high){
  const previous=Number(this.db.prepare('SELECT value FROM meta WHERE key=?').get('pruned_at')?.value??0);if(high-previous<60000)return;
  this.db.prepare('INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('pruned_at',String(high));
  const cutoff=high-this.limits.retentionMs;
  // Pending tasks are bounded to <=48h of active path plus <=12h post-close,
  // inside the 72h retention contract. Unexpected older tasks remain explicit.
  const old=this.db.prepare("SELECT id,value FROM tasks WHERE status='PENDING' AND window_start<?").all(cutoff);
  for(const row of old){const task=parse(row.value);task.initial_issues=[...new Set([...(task.initial_issues??[]),'RETENTION_WINDOW_LOST'])];this.db.prepare('UPDATE tasks SET value=? WHERE id=?').run(json(task),row.id);}
  this.db.prepare('DELETE FROM inputs WHERE at<?').run(cutoff);this.db.prepare('DELETE FROM records WHERE at<?').run(cutoff);
  this.db.prepare('DELETE FROM paths WHERE received_at<?').run(cutoff);this.db.prepare('DELETE FROM gaps WHERE open=0 AND to_at<?').run(cutoff);
  this.db.prepare("DELETE FROM tasks WHERE status!='PENDING' AND window_end<?").run(cutoff);
  this.db.prepare("DELETE FROM cursors WHERE (key LIKE 'POSITION:%' OR key LIKE 'LAST_DECISION:%') AND updated_at<?").run(cutoff);
 }
 export(query={}){
  const db=this.db,limit=Math.max(1,Math.min(1000,Number.isSafeInteger(query.limit)?query.limit:100));
  const counts=Object.fromEntries(['inputs','records','cursors','tasks','paths','gaps'].map(table=>[table==='paths'?'path':table,db.prepare('SELECT count(*) AS n FROM '+table).get().n]));
  const summary={version:SHADOW_STORE_VERSION,authority:'NONE',counts,metrics:Object.fromEntries(db.prepare('SELECT * FROM metrics ORDER BY key').all().map(r=>[r.key,r.value])),resource_usage:db.prepare('SELECT bytes AS logical_bytes,inputs FROM usage WHERE id=1').get(),limits:{...this.limits},high_water:Number(db.prepare('SELECT value FROM meta WHERE key=?').get('high_water')?.value??0)};
  if(query.kind==='summary')return summary;
  if(query.kind==='denominators'){
   if(query.from_at!==undefined&&!int(query.from_at)||query.to_at!==undefined&&!int(query.to_at))fail('SHADOW_QUERY_WINDOW_INVALID');
   const from=Math.max(0,summary.high_water-this.limits.retentionMs,query.from_at??0),to=Math.min(summary.high_water,query.to_at??summary.high_water);
   if(from>to)fail('SHADOW_QUERY_WINDOW_INVALID');
   // On-demand only; no history scan is performed during quote ingestion.
   // Read only one ranking arm: adding the same plan's flow/no-flow ranking
   // would manufacture additional opportunities.
   const opportunities=db.prepare(`SELECT count(*) AS ranked_rows,count(DISTINCT json_extract(r.value,'$.id')) AS unique_plan_ids,
    coalesce(sum(CASE WHEN json_extract(r.value,'$.id') IS NULL THEN 1 ELSE 0 END),0) AS rows_without_identity
    FROM records e,json_each(e.payload,'$.ranks') r WHERE e.type='SECONDARY_FLOW_OPPORTUNITY_SHADOW' AND e.at BETWEEN ? AND ?`).get(from,to);
   const conflicts=db.prepare(`SELECT count(*) AS n FROM (SELECT json_extract(r.value,'$.id') AS plan_identity
    FROM records e,json_each(e.payload,'$.ranks') r WHERE e.type='SECONDARY_FLOW_OPPORTUNITY_SHADOW' AND e.at BETWEEN ? AND ?
    GROUP BY plan_identity HAVING plan_identity IS NOT NULL AND count(DISTINCT json_extract(r.value,'$.plan_hash'))>1)`).get(from,to).n;
   const positions=db.prepare(`SELECT count(DISTINCT json_extract(payload,'$.id')) AS n FROM records
    WHERE type IN ('FILLED','SECONDARY_HORIZON_SHADOW_SNAPSHOT') AND at BETWEEN ? AND ?`).get(from,to).n;
   const snapshots=db.prepare("SELECT count(*) AS n FROM records WHERE type='SECONDARY_HORIZON_SHADOW_SNAPSHOT' AND at BETWEEN ? AND ?").get(from,to).n;
   const variants=db.prepare("SELECT count(*) AS n FROM records e,json_each(e.payload,'$.arms') arm WHERE e.type='SECONDARY_HORIZON_SHADOW_SNAPSHOT' AND e.at BETWEEN ? AND ?").get(from,to).n;
   const computations=db.prepare(`SELECT count(*) AS attempted_unique_inputs,
    coalesce(sum(CASE WHEN json_extract(ack,'$.decision_computed')=1 THEN 1 ELSE 0 END),0) AS completed_decisions,
    coalesce(sum(json_extract(ack,'$.variant_computations')),0) AS variant_computations,
    coalesce(sum(CASE WHEN json_extract(ack,'$.outcome')='DUPLICATE_QUOTE' THEN 1 ELSE 0 END),0) AS duplicate_or_old_quotes,
    coalesce(sum(CASE WHEN json_extract(ack,'$.snapshot_emitted')=0 THEN 1 ELSE 0 END),0) AS suppressed_snapshots,
    coalesce(sum(CASE WHEN json_extract(ack,'$.outcome')='APPLIED' AND json_extract(ack,'$.decision_computed') IS NULL THEN 1 ELSE 0 END),0) AS legacy_inputs_without_computation_evidence
    FROM inputs WHERE kind='DECISION' AND at BETWEEN ? AND ?`).get(from,to);
   return {...summary,scope:{kind:'RETAINED_OBSERVATIONS_ONLY',from_at:from,to_at:to,retention_ms:this.limits.retentionMs,complete_operational_history:false,failed_uncommitted_attempts_included:false},
    denominators:{opportunities:{...opportunities,plan_ids_with_multiple_hashes:conflicts,identity:'plan.id',ranking_arms_counted:1},positions:{unique_ids:positions,evidence_types:['FILLED','SECONDARY_HORIZON_SHADOW_SNAPSHOT']},
     snapshots:{stored:snapshots,stored_variant_evaluations:variants},retained_computations:computations},
    cumulative_metrics_scope:'SINCE_SHADOW_DATABASE_CREATION_NOT_RETENTION_WINDOW',
    snapshot_policy:{max_per_position:256,transition_counter_threshold_for_extra_snapshot:32,periodic_snapshot_may_include_further_transitions:true,cadence_ms:{1:60000,5:300000,15:900000,60:900000,240:900000},latest_cursor_kept_separately:true,quote_path_downsampled:false}};
  }
  if(query.kind==='path'){
   const task=query.task_id?db.prepare('SELECT value FROM tasks WHERE id=?').get(query.task_id):null;if(query.task_id&&!task)fail('SHADOW_TASK_MISSING');const window=task?parse(task.value):null;
   const from=window?.window_start??query.from_at??0,to=window?.window_end??query.to_at??summary.high_water;
   const rows=db.prepare(`SELECT p.*,i.sequence AS durable_sequence,i.stream_id,i.source_seq,i.at AS consumed_at
    FROM paths p LEFT JOIN inputs i ON i.id=p.id WHERE p.sequence>? AND p.event_at>=? AND p.event_at<=? ORDER BY p.sequence LIMIT ?`).all(query.after_sequence??0,from,to,limit);
   const coverage=this.coverage(from,to),reasons=[...new Set([...(window?.initial_issues??[]),...coverage.reasons])],complete=coverage.complete&&reasons.length===0;
   return {...summary,task:window,path:rows.map(r=>({...r,payload:parse(r.payload)})),source_sequence_scope:'OBSERVER_RECEIPT_NOT_EXCHANGE_SEQUENCE',next_after_sequence:rows.at(-1)?.sequence??query.after_sequence??0,
    current_quality_authoritative_for_replay:true,current_quality:{as_of:summary.high_water,status:complete?'OBSERVED_PATH':'NOT_EVALUABLE',market_path_complete:complete,economic_path_complete:false,fully_complete:false,counterfactual_net:null,reasons,coverage,scope:'FULL_REQUESTED_WINDOW_NOT_JUST_RETURNED_PAGE'},
    replay_eligibility:{market_observations_complete:complete,economic_evaluation_authorized:false,reason:'ECONOMIC_EXECUTION_CONTEXT_STILL_REQUIRES_VALIDATION'}};
  }
  const coverageCache=new Map(),records=db.prepare('SELECT * FROM records ORDER BY sequence DESC LIMIT ?').all(limit).reverse().map(row=>{
   const payload=parse(row.payload),record={...row,payload};if(row.type!=='SECONDARY_EXIT_POST_PATH')return record;
   const key=payload.window_start+':'+payload.window_end;
   if(!coverageCache.has(key))coverageCache.set(key,this.coverage(payload.window_start,payload.window_end));
   const coverage=coverageCache.get(key),reasons=[...new Set([...(payload.reasons??[]),...coverage.reasons])],complete=payload.market_path_complete===true&&coverage.complete&&reasons.length===0;
   return {...record,current_quality_authoritative_for_replay:true,current_quality:{as_of:summary.high_water,status:complete?'OBSERVED_PATH':'NOT_EVALUABLE',market_path_complete:complete,economic_path_complete:false,fully_complete:false,counterfactual_net:null,reasons,coverage,original_record_preserved:true}};
  });
  return {...summary,records,cursors:db.prepare('SELECT * FROM cursors ORDER BY key LIMIT ?').all(limit).map(r=>({...r,value:parse(r.value)})),tasks:db.prepare('SELECT value FROM tasks ORDER BY window_end DESC LIMIT ?').all(limit).map(r=>parse(r.value)),gaps:db.prepare('SELECT * FROM gaps ORDER BY to_at DESC LIMIT ?').all(limit)};
 }
 close(){if(this.db){this.db.close();this.db=null;}}
}
