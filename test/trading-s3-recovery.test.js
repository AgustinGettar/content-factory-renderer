import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomBytes} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {chooseLocalSnapshot,verifySqliteSnapshot,sha256File,encryptSnapshot,decryptSnapshot} from '../scripts/trading-paper-s3-recovery.mjs';
const tmp=()=>mkdtemp(join(tmpdir(),'lumi-recovery-unit-'));
function createDb(path){
 const db=new DatabaseSync(path);
 db.exec('CREATE TABLE state(id TEXT PRIMARY KEY,revision INTEGER NOT NULL,state TEXT NOT NULL)');
 db.prepare('INSERT INTO state VALUES(?,?,?)').run('KRAKEN_BTCUSD_PAPER',454,
  JSON.stringify({frequency:{account:{cash:'900',equity:'991'}},secondaryExecution:{active:true}}));
 db.close();
}
test('latest one of 3 daily snapshots is chosen; old or unexpected files rejected',()=>{
 const now=1000000000;
 const pick=chooseLocalSnapshot([{name:'daily-0.sqlite',size:4000,mtimeMs:now-1000},
 {name:'daily-1.sqlite',size:12000,mtimeMs:now-1500},
 {name:'daily-2.sqlite',size:10000,mtimeMs:now-100},
 {name:'secret.sqlite',size:99999,mtimeMs:now},
 {name:'daily-0.sqlite',size:6000,mtimeMs:now-40*3600000}],now);
 assert.equal(pick.name,'daily-2.sqlite');
 assert.equal(chooseLocalSnapshot([{name:'daily-0.sqlite',size:12000,mtimeMs:now-40*3600000}],now),null);
});
test('seal and unseal SQLITE PAPER with authenticated encryption and same digest',async()=>{
 const dir=await tmp();try{
  const src=join(dir,'src.sqlite'),enc=join(dir,'out.enc'),out=join(dir,'out.sqlite');
  createDb(src);const expected=verifySqliteSnapshot(src);assert.equal(expected.revision,454);
  const secret=randomBytes(32),info=await encryptSnapshot(src,enc,secret);
  assert.equal(info.sha256,await sha256File(enc));assert(info.size>100);
  await decryptSnapshot(enc,out,secret);
  assert.deepEqual(verifySqliteSnapshot(out),expected);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('tampered ciphertext and wrong key cannot restore data',async()=>{
 const dir=await tmp();try{
  const src=join(dir,'src.sqlite'),enc=join(dir,'out.enc'),corrupt=join(dir,'tampered.enc');
  createDb(src);const key=randomBytes(32);await encryptSnapshot(src,enc,key);
  const bytes=await readFile(enc);bytes[40]^=0x3;
  await writeFile(corrupt,bytes);
  await assert.rejects(()=>decryptSnapshot(corrupt,join(dir,'fail.sqlite'),key));
  await assert.rejects(()=>decryptSnapshot(enc,join(dir,'wrong.sqlite'),randomBytes(32)));
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('incomplete SQLite state cannot masquerade as an operational backup',async()=>{
 const dir=await tmp();try{
  const bad=join(dir,'bad.sqlite');const db=new DatabaseSync(bad);
  db.exec('CREATE TABLE state(id TEXT PRIMARY KEY,revision INTEGER,state TEXT)');
  db.prepare('INSERT INTO state VALUES(?,?,?)').run('KRAKEN_BTCUSD_PAPER',4,'{}');db.close();
  assert.throws(()=>verifySqliteSnapshot(bad),/SECONDARY_PAPER_NOT_PRESENT/);
 }finally{await rm(dir,{recursive:true,force:true});}
});
