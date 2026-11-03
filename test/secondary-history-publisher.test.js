import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {hash} from '../lib/trading/core.js';
import {SecondaryHistoryPublisher,sanitizeSecondaryHistoryEvent,HISTORY_MAX_BYTES} from '../lib/trading/secondary-history-publisher.js';

const NOW=Date.parse('2026-11-03T15:00:00Z');
function harness(t,count=0){
 const dir=mkdtempSync(join(tmpdir(),'lumi-history-')),db=new DatabaseSync(join(dir,'history.sqlite'));
 db.exec('CREATE TABLE events(id TEXT PRIMARY KEY,kind TEXT NOT NULL,payload TEXT NOT NULL,created_at TEXT NOT NULL);CREATE INDEX events_kind_time ON events(kind,created_at);CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);CREATE TABLE ledger(balance TEXT NOT NULL);INSERT INTO ledger VALUES(\'299.25\')');
 t.after(()=>{db.close();rmSync(dir,{recursive:true,force:true});});
 let tick=NOW;const store={db},sent=[],makeEvent=(i,overrides={})=>({type:'CLOSED',id:'operation-'+i,ledger:'FREQUENT_PAPER',realTrading:false,at:NOW-100000+i,pnl:'0.2460525197',fill_pnl:'0.1',funding_complete:true,result_final:true,qty:'0.002',reason:'TRAILING_RETRACEMENT',plan:{id:'operation-'+i,timeframe:5,direction:'LONG',entry:'100000',stop:'99000',target:'101000',sizing:{qty:'0.002',exposure:'200',initial_margin:'100',leverage:2},evidence:{raw:'private-candles'}},...overrides});
 const add=(i,overrides={})=>{const e=makeEvent(i,overrides);db.prepare('INSERT INTO events VALUES(?,?,?,?)').run('event-'+i,e.type,JSON.stringify(e),new Date(e.at).toISOString());};
 for(let i=1;i<=count;i++)add(i);
 const fetchImpl=async(url,options)=>{const page=JSON.parse(options.body);sent.push(page);assert(url.endsWith('/api/aws/history'));assert.equal(options.headers['X-Trading-Ingest-Key'],'private-key');return Response.json({kind:page.kind,cursor:page.cursor,hash:page.hash});};
 const create=extra=>new SecondaryHistoryPublisher({store,headers:()=>({'X-Trading-Ingest-Key':'private-key'}),fetchImpl,now:()=>tick,...extra});
 return {db,store,sent,add,makeEvent,create,tick:n=>{tick+=n;}};
}

test('sanitized operations retain exact closed total, partial amount and manual exclusion without private evidence',t=>{
 const h=harness(t);h.add(1,{reason:'MANUAL_PROFIT',management_override:true,execution_receipt:{private:'raw'},profit_protection:{protected_net:'0.30',peak_net:'0.40',floor_evidence:{raw:'private'}}});
 h.add(2,{type:'PARTIAL_CLOSE',fill_id:'fill-2',pnl:undefined,fill_pnl:'0.10'});h.add(3,{type:'FUNDING_RECONCILED',net_adjustment:'-0.01',net_after:'0.2360525197'});
 const records=h.db.prepare('SELECT rowid,* FROM events ORDER BY rowid').all().map(sanitizeSecondaryHistoryEvent);
 assert.equal(records[0].pnl,'0.2460525197');assert.equal(records[0].amount_scope,'OPERATION_TOTAL');assert.equal(records[0].accounted,true);assert.deepEqual(records[0].training_eligibility,{status:'EXCLUDED',reason:'MANUAL_OR_MANAGEMENT_OVERRIDE'});
 assert.equal(records[1].amount_scope,'EXECUTION_FRAGMENT');assert.equal(records[1].fill_id,'fill-2');assert.equal(records[1].fill_pnl,'0.10');assert.equal(records[1].pnl,undefined);
 assert.equal(records[2].amount_scope,'ACCOUNTING_ADJUSTMENT');assert.equal(records[2].net_adjustment,'-0.01');assert.equal(records[2].training_eligibility.status,'UNKNOWN');
 assert.equal(records[0].evidence_flags.execution_receipt,true);assert(!JSON.stringify(records).includes('private'));assert.equal(records[0].profit_protection.protected_net,'0.30');
});

test('forward archival work is bounded, operations-only, newest-first and resumed through the same SQLite connection',async t=>{
 const h=harness(t,205);h.add(206,{type:'SECONDARY_PATTERN_EVALUATION'});h.add(207,{ledger:'ENGINE'});
 const p=h.create();await p.start();assert.equal(h.sent.length,4);assert.deepEqual(h.sent.map(p=>p.records.length),[40,40,40,40]);assert.equal(p.lastFullCursor,'120');assert.equal(p.backfillComplete,false);assert.equal(h.sent.at(-1).cursor,'160');
 const first=h.sent[0];assert.equal(first.cursor,'40');assert.equal(first.previous_cursor,null);assert.equal(first.records[0].source_cursor,'40');assert.equal(first.records.at(-1).source_cursor,'1');
 for(const page of h.sent){const {hash:sum,...unsigned}=page;assert.equal(hash(unsigned),sum);assert(Buffer.byteLength(JSON.stringify(page))<HISTORY_MAX_BYTES);assert(page.records.every(r=>r.ledger==='FREQUENT_PAPER'&&r.type==='CLOSED'));}
 const restarted=h.create();assert.equal(restarted.lastFullCursor,'120');h.tick(15000);await restarted.start();assert.equal(restarted.lastFullCursor,'200');assert.equal(restarted.backfillComplete,true);assert.equal(h.sent.at(-1).records.length,5);assert.equal(h.sent.at(-1).previous_cursor,'200');assert.equal(h.sent.at(-1).cursor,'205');
 assert.equal(h.db.prepare('SELECT balance FROM ledger').get().balance,'299.25');assert.equal(h.db.prepare('SELECT count(*) AS n FROM events').get().n,207);
});

test('an uncertain upload never advances the cursor and retries an identical immutable page',async t=>{
 const h=harness(t,41);let reject=true;const p=h.create({fetchImpl:async(url,options)=>{const page=JSON.parse(options.body);h.sent.push(page);return reject?new Response('',{status:503}):Response.json({kind:page.kind,cursor:page.cursor,hash:page.hash});}});
 await p.start();assert.equal(p.lastFullCursor,'0');assert.equal(p.error,'HISTORY_UPLOAD_FAILED');assert.equal(h.sent.length,1);
 reject=false;h.tick(15000);await p.start();assert.equal(h.sent[0].hash,h.sent[1].hash);assert.equal(p.lastFullCursor,'40');assert.equal(p.error,null);
});

test('in-flight publication and poll cadence do not duplicate work or block the caller',async t=>{
 const h=harness(t,1);let release;const p=h.create({fetchImpl:(url,options)=>{h.sent.push(JSON.parse(options.body));return new Promise(resolve=>{release=()=>resolve(Response.json({kind:h.sent[0].kind,cursor:h.sent[0].cursor,hash:h.sent[0].hash}));});}});
 const task=p.start();assert.equal(p.busy,true);assert.equal(p.start(),task);assert.equal(h.sent.length,1);release();await task;assert.equal(p.busy,false);await p.start();assert.equal(h.sent.length,1);
});

test('invalid acknowledgement, source rewind and corrupt optional metadata are visible and leave ledger intact',async t=>{
 const h=harness(t,41),p=h.create({fetchImpl:async()=>Response.json({kind:'PAGE',cursor:'40',hash:'bad'})});await p.start();assert.equal(p.error,'HISTORY_RECEIPT_INVALID');assert.equal(p.lastFullCursor,'0');
 p.lastFullCursor='999';await assert.rejects(()=>p.publish(),/HISTORY_SOURCE_CURSOR_REWIND/);
 h.db.prepare('UPDATE metadata SET value=?').run('{bad-json');const other=h.create();assert.equal(other.enabled,false);assert.equal(other.error,'HISTORY_METADATA_INVALID');assert.equal(h.db.prepare('SELECT balance FROM ledger').get().balance,'299.25');
});
