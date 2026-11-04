// Private, standalone secondary PAPER recovery. Never imports the trading worker.
// Existing rotating SQLite daily snapshots are the only plaintext source.
// No database writes, no trading orders, no Telegram or neural side effects.
import {DatabaseSync} from 'node:sqlite';
import {createReadStream,createWriteStream} from 'node:fs';
import {readFile,writeFile,appendFile,readdir,stat,statfs,mkdtemp,rm,open} from 'node:fs/promises';
import {join,basename} from 'node:path';
import {createCipheriv,createDecipheriv,randomBytes,createHash} from 'node:crypto';
import {createGzip,createGunzip} from 'node:zlib';
import {pipeline} from 'node:stream/promises';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';

export const PAPER_RECOVERY_VERSION='lumi-paper-s3-recovery-1.0.0';
export const PAPER_RECOVERY_BUCKET='lumi-paper-recovery-146766539818-eun1';
export const PAPER_RECOVERY_REGION='eu-north-1';
export const PAPER_RECOVERY_DIR='/var/lib/lumi-trading/backups';
export const PAPER_RECOVERY_ENV='/etc/lumi-trading/worker.env';
const AAD=Buffer.from('lumi-trading-backup-v1');
const MAGIC=Buffer.from('LUMIPAPERBACKUP1');
const HEADER_BYTES=MAGIC.length+12;
const MiB=1024*1024;
const safeInt=v=>Number.isSafeInteger(v)&&v>=0;
export function chooseLocalSnapshot(files,now=Date.now()){
 const valid=files.filter(x=>/^daily-[012]\.sqlite$/.test(x.name)&&
  safeInt(x.size)&&x.size>=4096&&
  Number.isFinite(x.mtimeMs)&&x.mtimeMs<=now+1000&&now-x.mtimeMs<36*3600000);
 valid.sort((a,b)=>b.mtimeMs-a.mtimeMs);
 return valid[0]??null;
}
export function verifySqliteSnapshot(path){
 const db=new DatabaseSync(path,{readOnly:true,timeout:5000});
 try{
  const check=db.prepare('PRAGMA integrity_check').all();
  if(check.length!==1||check[0].integrity_check!=='ok')throw Error('SNAPSHOT_INTEGRITY_FAILED');
  const row=db.prepare("SELECT revision,state FROM state WHERE id='KRAKEN_BTCUSD_PAPER'").get();
  if(!safeInt(row?.revision)||!row.state)throw Error('PAPER_LEDGER_MISSING');
  const state=JSON.parse(row.state);
  if(!state.frequency?.account||!state.secondaryExecution)throw Error('SECONDARY_PAPER_NOT_PRESENT');
  return {revision:row.revision,mode:'PAPER',realTrading:false};
 }finally{db.close();}
}
export async function sha256File(path){
 const sha=createHash('sha256');for await(const chunk of createReadStream(path))sha.update(chunk);
 return sha.digest('hex');
}
export async function encryptSnapshot(source,destination,key){
 if(!Buffer.isBuffer(key)||key.length!==32)throw Error('BACKUP_KEY_INVALID');
 const iv=randomBytes(12);
 await writeFile(destination,Buffer.concat([MAGIC,iv]),{flag:'wx',mode:0o600});
 const cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(AAD);
 await pipeline(createReadStream(source),createGzip({level:6}),cipher,
  createWriteStream(destination,{flags:'a',mode:0o600}));
 await appendFile(destination,cipher.getAuthTag());
 const size=(await stat(destination)).size;
 if(size<=HEADER_BYTES+16||size>512*MiB)throw Error('SEALED_BACKUP_INVALID_SIZE');
 return {size,sha256:await sha256File(destination)};
}
export async function decryptSnapshot(encrypted,destination,key){
 if(!Buffer.isBuffer(key)||key.length!==32)throw Error('BACKUP_KEY_INVALID');
 const info=await stat(encrypted);
 if(info.size<=HEADER_BYTES+16||info.size>512*MiB)throw Error('SEALED_BACKUP_INVALID_SIZE');
 const handle=await open(encrypted,'r');
 const header=Buffer.alloc(HEADER_BYTES),tag=Buffer.alloc(16);
 try{
  const a=await handle.read(header,0,HEADER_BYTES,0);
  const b=await handle.read(tag,0,16,info.size-16);
  if(a.bytesRead!==HEADER_BYTES||b.bytesRead!==16||!header.subarray(0,MAGIC.length).equals(MAGIC))
   throw Error('BACKUP_HEADER_INVALID');
 }finally{await handle.close();}
 const decipher=createDecipheriv('aes-256-gcm',key,header.subarray(MAGIC.length));
 decipher.setAAD(AAD);decipher.setAuthTag(tag);
 await pipeline(createReadStream(encrypted,{start:HEADER_BYTES,end:info.size-17}),
  decipher,createGunzip(),createWriteStream(destination,{flags:'wx',mode:0o600}));
}
function keyFromPrivateEnv(content){
 const lines=content.split(/\r?\n/);
 const line=lines.find(x=>/^LUMI_TRADING_BACKUP_KEY=/.test(x));
 const value=line?.slice('LUMI_TRADING_BACKUP_KEY='.length).trim().replace(/^["']|["']$/g,'');
 if(!/^[a-f\d]{64}$/i.test(value??''))throw Error('PRIVATE_BACKUP_KEY_UNAVAILABLE');
 return Buffer.from(value,'hex');
}
function aws(args,timeout=180000){
 return JSON.parse(execFileSync('/usr/bin/aws',['s3api',...args,'--region',PAPER_RECOVERY_REGION],
  {encoding:'utf8',timeout,maxBuffer:MiB,env:{...process.env,AWS_PAGER:''}}));
}
function keyFor(slot){
 if(!/^[012]$/.test(String(slot)))throw Error('BACKUP_SLOT_INVALID');
 return 'recovery/daily-'+slot+'.lumi-gcm';
}
function headOrNull(slot){
 try{return aws(['head-object','--bucket',PAPER_RECOVERY_BUCKET,'--key',keyFor(slot)],20000);}
 catch(e){if(String(e.stderr??'').includes('404')||String(e.message??'').includes('404'))return null;throw e;}
}
let recoveryPhase='PREPARE';
async function main(){
 if(process.getuid?.()!==0)throw Error('ROOT_ONLY_NO_EXPORTED_KEY');
 process.umask(0o077);
 const names=(await readdir(PAPER_RECOVERY_DIR)).filter(x=>/^daily-[012]\.sqlite$/.test(x));
 const files=await Promise.all(names.map(async name=>{
  const s=await stat(join(PAPER_RECOVERY_DIR,name));
  return {name,size:s.size,mtimeMs:s.mtimeMs};
 }));
 const source=chooseLocalSnapshot(files);
 if(!source)throw Error('NO_RECENT_SQLITE_BACKUP');
 const slot=basename(source.name).match(/^daily-([012])\.sqlite$/)[1],src=join(PAPER_RECOVERY_DIR,source.name);
 recoveryPhase='SOURCE_SQLITE_INTEGRITY';
 const item=keyFor(slot),checkpoint=verifySqliteSnapshot(src);
 const reference={source_size:String(source.size),source_mtime_ms:String(Math.trunc(source.mtimeMs)),
  revision:String(checkpoint.revision)};
 recoveryPhase='REMOTE_EXISTING_HEAD';
 const existing=headOrNull(slot);
 const remoteMatches=existing?.Metadata?.source_size===reference.source_size&&
    existing?.Metadata?.source_mtime_ms===reference.source_mtime_ms&&
    existing?.Metadata?.revision===reference.revision&&
    /^[a-f0-9]{64}$/.test(existing?.Metadata?.sha256??'');
 if(remoteMatches&&!process.argv.includes('--verify-existing')){
  console.log(JSON.stringify({status:'REMOTE_ALREADY_MATCHES',revision:checkpoint.revision,
   size:existing.ContentLength,source:source.name,remote_key:item,verified_again:false}));
  return;
 }
 recoveryPhase='STORAGE_SPACE_PREFLIGHT';
 const disk=await statfs(PAPER_RECOVERY_DIR);
 const free=Number(disk.bavail)*Number(disk.bsize);
 if(free<source.size*1.6+128*MiB)throw Error('BACKUP_STORAGE_SPACE_LOW');
 recoveryPhase='PRIVATE_KEY_LOAD';
 const envContent=await readFile(PAPER_RECOVERY_ENV,'utf8'),key=keyFromPrivateEnv(envContent);
 const tmp=await mkdtemp(join(PAPER_RECOVERY_DIR,'.remote-verify-'));
 try{
  const encrypted=join(tmp,'backup.lumi-gcm'),downloaded=join(tmp,'download.lumi-gcm');
  const restored=join(tmp,'restored.sqlite');
  let local;
  if(!remoteMatches){
   recoveryPhase='ENCRYPT';
   local=await encryptSnapshot(src,encrypted,key);
   recoveryPhase='S3_UPLOAD';
   aws(['put-object','--bucket',PAPER_RECOVERY_BUCKET,'--key',item,'--body',encrypted,
    '--server-side-encryption','AES256','--metadata',
    'source_size='+reference.source_size+',source_mtime_ms='+reference.source_mtime_ms+
    ',revision='+reference.revision+',sha256='+local.sha256],180000);
  }
  recoveryPhase='REMOTE_HEAD_CONFIRM';
  const head=aws(['head-object','--bucket',PAPER_RECOVERY_BUCKET,'--key',item],25000);
  const expectedSha=remoteMatches?existing.Metadata.sha256:local.sha256;
  const expectedSize=remoteMatches?existing.ContentLength:local.size;
  if(head.ContentLength!==expectedSize||head.Metadata?.sha256!==expectedSha||
     head.Metadata?.revision!==reference.revision||head.ServerSideEncryption!=='AES256')
   throw Error('REMOTE_HEAD_VERIFICATION_FAILED');
  recoveryPhase='REMOTE_DOWNLOAD';
  aws(['get-object','--bucket',PAPER_RECOVERY_BUCKET,'--key',item,downloaded],180000);
  recoveryPhase='REMOTE_SHA256';
  const downloadedDigest=await sha256File(downloaded);
  if(downloadedDigest!==expectedSha)throw Error('REMOTE_DOWNLOAD_SHA256_MISMATCH');
  recoveryPhase='DECRYPT_AES_GCM';
  await decryptSnapshot(downloaded,restored,key);
  recoveryPhase='RESTORED_SQLITE_INTEGRITY';
  const restoredState=verifySqliteSnapshot(restored);
  if(restoredState.revision!==checkpoint.revision)throw Error('RESTORED_REVISION_MISMATCH');
  console.log(JSON.stringify({status:'RESTORE_VERIFIED',version:PAPER_RECOVERY_VERSION,
   revision:checkpoint.revision,remote_key:item,encrypted_bytes:expectedSize,
   source_bytes:source.size,source:source.name,sha256:expectedSha,
   verified_again:true,worker_restarted:false,positions_modified:false}));
 }finally{key.fill(0);await rm(tmp,{recursive:true,force:true});}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)
 main().catch(e=>{console.error(JSON.stringify({status:'FAIL',phase:recoveryPhase,error_code:typeof e?.code==='string'?e.code:null,error_name:typeof e?.name==='string'?e.name:null,error:(
 ['NO_RECENT_SQLITE_BACKUP','BACKUP_STORAGE_SPACE_LOW','SNAPSHOT_INTEGRITY_FAILED',
 'PAPER_LEDGER_MISSING','BACKUP_KEY_INVALID','PRIVATE_BACKUP_KEY_UNAVAILABLE',
 'REMOTE_HEAD_VERIFICATION_FAILED','REMOTE_DOWNLOAD_SHA256_MISMATCH','RESTORED_REVISION_MISMATCH',
 'ROOT_ONLY_NO_EXPORTED_KEY'].includes(e.message)?e.message:'RECOVERY_UPLOAD_OR_VERIFY_ERROR')}));
  process.exitCode=1;});
