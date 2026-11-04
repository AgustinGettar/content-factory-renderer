// Tiny temporary databases and fake disk/transport failures; no worker DB or network.
import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,rm,copyFile,mkdir,readFile,writeFile,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable,Writable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {DashboardPublisher,backupSizeGuard,BACKUP_INTERVAL_MS,BACKUP_TRANSIENT_RETRY_MS,BACKUP_MAX_BYTES} from '../lib/trading/dashboard-publisher.js';
const T=Date.parse('2026-11-02T03:00:00Z');
const env={LUMI_TRADING_BACKUP_KEY:'a'.repeat(64),LUMI_TRADING_SITE_ACCESS:'isolated-site',LUMI_TRADING_PUBLISH_KEY:'isolated-key'};
async function harness(t){
 const dir=await mkdtemp(join(tmpdir(),'lumi-backup-isolated-')),path=join(dir,'paper.sqlite'),db=new DatabaseSync(path);
 db.exec("CREATE TABLE state(id TEXT PRIMARY KEY,revision INTEGER); INSERT INTO state VALUES('KRAKEN_BTCUSD_PAPER',1); CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT);");
 t.after(async()=>{db.close();await rm(dir,{recursive:true,force:true});});
 const h={dir,path,db,now:T,copies:0,uploads:[],free:1024*1024*1024,status:200};
 h.store={path,db,revision:1,backup:async target=>{h.copies++;await copyFile(path,target);}};
 h.make=(options={})=>new DashboardPublisher({store:h.store,feed:{},env,now:()=>h.now,statfsImpl:async()=>({bavail:h.free,bsize:1}),fetchImpl:async(url,o)=>{for await(const _ of o.body){}h.uploads.push({url,headers:o.headers});return {ok:h.status===200,status:h.status};},...options});
 h.saved=()=>JSON.parse(db.prepare("SELECT value FROM metadata WHERE key='dashboard'").get().value);
 h.local=()=>join(dir,'backups','daily-'+Math.floor(h.now/86400000)%3+'.sqlite');
 return h;
}

test('insufficient disk stops before SQLite copy or upload and persists the one-hour retry',async t=>{
 const h=await harness(t);h.free=BACKUP_MAX_BYTES+64*1024*1024;const p=h.make();await p.startBackup();
 assert.equal(h.copies,0);assert.equal(h.uploads.length,0);assert.equal(p.backupError,'BACKUP_STORAGE_SPACE_LOW');
 assert.equal(h.saved().next_backup_attempt_at,T+BACKUP_INTERVAL_MS);assert.equal(h.saved().local_backup_at,0);
});

test('configuration failure keeps hourly consistent local copies and throttles across restarts',async t=>{
 const h=await harness(t),badEnv={...env,LUMI_TRADING_BACKUP_KEY:'invalid'},p=h.make({env:badEnv});await p.startBackup();
 assert.equal(h.copies,1);assert.equal(h.uploads.length,0);assert.equal(p.backupError,'BACKUP_KEY_REQUIRED');
 assert.equal(h.saved().local_backup_at,T);assert.equal(h.saved().backup_at,0);assert.equal(h.saved().next_backup_attempt_at,T+BACKUP_INTERVAL_MS);
 const restored=h.make({env:badEnv});h.now=T+BACKUP_INTERVAL_MS-1;await restored.startBackup();assert.equal(h.copies,1);
 h.now++;await restored.startBackup();assert.equal(h.copies,2);assert.equal(h.saved().local_backup_at,h.now);
 const local=new DatabaseSync(h.local(),{readOnly:true});try{assert.equal(local.prepare('PRAGMA quick_check').get().quick_check,'ok');}finally{local.close();}
});

test('remote size rejection stays precise, removes only temporary ciphertext and waits one hour',async t=>{
 const h=await harness(t);h.status=413;const p=h.make();await p.startBackup();
 assert.equal(p.backupError,'BACKUP_SIZE_LIMIT');assert.equal(h.saved().backup_error,'BACKUP_SIZE_LIMIT');
 assert.equal(h.saved().next_backup_attempt_at,T+BACKUP_INTERVAL_MS);assert.equal(h.copies,1);
 assert((await stat(h.local())).isFile());await assert.rejects(stat(h.local()+'.enc.tmp'),{code:'ENOENT'});
 h.now+=60000;await p.startBackup();assert.equal(h.copies,1);assert.equal(h.uploads.length,1);
 const restored=h.make();await restored.startBackup();assert.equal(h.uploads.length,1);
 h.now=T+BACKUP_INTERVAL_MS;await restored.startBackup();assert.equal(h.copies,2);assert.equal(h.uploads.length,1);assert.equal(h.saved().backup_at,0);assert.equal(h.saved().backup_error,'BACKUP_SIZE_LIMIT');
 h.now=T+24*BACKUP_INTERVAL_MS;await restored.startBackup();assert.equal(h.uploads.length,2);
});

test('a transient remote failure retries after five minutes without recopying and preserves snapshot revision',async t=>{
 const h=await harness(t);h.status=503;const p=h.make();await p.startBackup();assert.equal(h.copies,1);
 assert.equal(h.saved().next_backup_attempt_at,T+BACKUP_TRANSIENT_RETRY_MS);
 h.db.prepare('UPDATE state SET revision=2').run();h.store.revision=2;h.status=200;
 h.now=T+BACKUP_TRANSIENT_RETRY_MS-1;await p.startBackup();assert.equal(h.uploads.length,1);
 h.now++;await p.startBackup();assert.equal(h.copies,1);assert.equal(h.uploads.length,2);
 assert.equal(h.uploads[1].headers['X-Backup-Revision'],'1');assert.equal(p.backupError,null);
 assert.equal(h.saved().backup_at,h.now);assert.equal(h.saved().local_backup_at,T);assert.equal(h.saved().next_backup_attempt_at,T+BACKUP_INTERVAL_MS);
 h.now=T+BACKUP_INTERVAL_MS;await p.startBackup();assert.equal(h.copies,2);assert.equal(h.uploads[2].headers['X-Backup-Revision'],'2');
});

test('the ciphertext stream stops at its size budget without emitting oversized data',async()=>{
 assert.equal(BACKUP_MAX_BYTES,16*1024*1024);let written=0;
 await assert.rejects(pipeline(Readable.from([Buffer.alloc(3),Buffer.alloc(3)]),backupSizeGuard(4),new Writable({write(chunk,encoding,done){written+=chunk.length;done();}})),/BACKUP_SIZE_LIMIT/);
 assert(written<=4);
});

test('filesystem inspection failure performs no copy and preserves a safe retry reason',async t=>{
 const h=await harness(t),p=h.make({statfsImpl:async()=>{throw Error('private filesystem detail');}});await p.startBackup();
 assert.equal(h.copies,0);assert.equal(p.backupError,'BACKUP_STORAGE_CHECK_FAILED');assert.equal(h.saved().next_backup_attempt_at,T+BACKUP_TRANSIENT_RETRY_MS);
 assert(!JSON.stringify(h.saved()).includes('private filesystem detail'));
});

test('a failed partial copy preserves the previous local snapshot and clears its incomplete temporary file',async t=>{
 const h=await harness(t);await mkdir(join(h.dir,'backups'));await copyFile(h.path,h.local());const original=await readFile(h.local());
 h.store.backup=async target=>{h.copies++;await writeFile(target,'partial');throw Object.assign(Error('private disk detail'),{code:'ENOSPC'});};
 const p=h.make();await p.startBackup();assert.equal(p.backupError,'BACKUP_STORAGE_SPACE_LOW');
 assert.deepEqual(await readFile(h.local()),original);await assert.rejects(stat(h.local()+'.tmp'),{code:'ENOENT'});assert.equal(h.uploads.length,0);
});

test('unknown transport errors cannot persist secrets and overlapping live updates do not duplicate backup work',async t=>{
 const h=await harness(t),p=h.make();let reject,attempts=0;
 p.backup=()=>{attempts++;return new Promise((resolve,r)=>{reject=r;});};
 const task=p.startBackup();p.startBackup();assert.equal(attempts,1);
 reject(Error('https://private.invalid/?token=do-not-store'));await task;
 assert.equal(p.backupError,'BACKUP_UPLOAD_FAILED');assert.equal(h.saved().next_backup_attempt_at,T+BACKUP_TRANSIENT_RETRY_MS);
 assert(!JSON.stringify(h.saved()).includes('do-not-store'));
});
