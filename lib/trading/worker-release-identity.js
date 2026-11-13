// Additive provenance only. This module never reads env/secrets, shells out,
// acquires a lease, or changes trading state. Static ESM imports have ALREADY run
// before the worker calls this verifier: disk agreement is not memory attestation.
import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {open, realpath} from 'node:fs/promises';
import {isAbsolute, join, relative, sep, posix} from 'node:path';
export const WORKER_IDENTITY_VERSION='lumi-worker-release-identity-1.0.0';
export const WORKER_MANIFEST_VERSION='lumi-worker-release-manifest-1.0.0';
export const WORKER_MANIFEST_PATH='deploy/trading/worker-release-manifest.json';
export const WORKER_MANIFEST_SCOPE='TRADING_STATIC_IMPORTS_WITH_DECLARED_BOUNDARIES';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const HASH=/^[a-f0-9]{64}$/,COMMIT=/^[a-f0-9]{40}$/;
const SOURCE=/^(?:lib\/trading\/[a-z0-9-]+\.(?:js|mjs)|scripts\/trading-worker\.mjs|package(?:-lock)?\.json)$/;
const REQUIRED=['scripts/trading-worker.mjs','lib/trading/worker-release-identity.js','lib/trading/engine.js',
 'lib/trading/runtime-guard.js','lib/trading/store.js','lib/trading/sqlite-store.js','package.json','package-lock.json'];
const fail=code=>{throw Object.assign(Error(code),{identityCode:code});};
const freeze=value=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;};
const canonicalFiles=files=>files.map(({path,sha256})=>({path,sha256})).sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
export function workerSourceTreeHash(files){return sha(canonicalFiles(files).map(f=>`${f.path}\0${f.sha256}\n`).join(''));}
export function createWorkerReleaseManifest({sourceCommit,files,excludedStaticImports=[]}){
 if(!COMMIT.test(sourceCommit??'')||!Array.isArray(files)||files.length<REQUIRED.length||files.length>256)fail('MANIFEST_INVALID');
 const paths=new Set();
 for(const f of files){if(!f||!SOURCE.test(f.path??'')||!HASH.test(f.sha256??'')||paths.has(f.path))fail('MANIFEST_INVALID');paths.add(f.path);}
 if(REQUIRED.some(p=>!paths.has(p)))fail('MANIFEST_REQUIRED_FILE_MISSING');
 if(!Array.isArray(excludedStaticImports)||excludedStaticImports.length>128)fail('MANIFEST_BOUNDARIES_INVALID');
 const boundaries=excludedStaticImports.map(b=>{
  if(!b||!SOURCE.test(b.importer??'')||!paths.has(b.importer)||
    !/^\.\.?\/[A-Za-z0-9_./-]+\.(?:js|mjs|json)$/.test(b.specifier??'')||
    !/^(?:lib|docs|episodes)\/[A-Za-z0-9_./-]+\.(?:js|mjs|json)$/.test(b.resolved??'')||
    b.resolved.split('/').includes('..')||SOURCE.test(b.resolved)||
    posix.normalize(posix.join(posix.dirname(b.importer),b.specifier))!==b.resolved)fail('MANIFEST_BOUNDARIES_INVALID');
  return {importer:b.importer,specifier:b.specifier,resolved:b.resolved,reason:'OUTSIDE_TRADING_SOURCE_SCOPE_NOT_READ'};
 });
 const clean=canonicalFiles(files);
 return {schema:WORKER_MANIFEST_VERSION,source_commit:sourceCommit,entrypoint:'scripts/trading-worker.mjs',
  source_tree_sha256:workerSourceTreeHash(clean),files:clean,coverage:WORKER_MANIFEST_SCOPE,
  complete_runtime_graph:false,excluded_static_import_boundaries:boundaries};
}
async function boundedRegularFile(path,maximum){
 const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{
  const stat=await handle.stat();if(!stat.isFile()||stat.size>maximum)fail('SOURCE_TYPE_OR_SIZE_INVALID');
  // Read through this verified descriptor, capped even if another process grows
  // the file after stat. No symlink target or arbitrary manifest path is opened.
  const bytes=Buffer.alloc(Math.min(maximum+1,stat.size+1));let offset=0;
  while(offset<bytes.length){const {bytesRead}=await handle.read(bytes,offset,bytes.length-offset,offset);if(!bytesRead)break;offset+=bytesRead;}
  const after=await handle.stat();
  if(after.size!==stat.size||after.mtimeMs!==stat.mtimeMs||after.ctimeMs!==stat.ctimeMs||offset!==stat.size)fail('SOURCE_CHANGED_DURING_READ');
  return bytes.subarray(0,offset);
 }finally{await handle.close();}
}
export async function inspectWorkerRelease({releaseDirectory,now=()=>Date.now()}={}){
 const at=now();
 const result={version:WORKER_IDENTITY_VERSION,checked_at:at,checked_at_utc:new Date(at).toISOString(),
  status:'UNAVAILABLE',release_directory:null,manifest_path:WORKER_MANIFEST_PATH,manifest_sha256:null,
  declared_source_commit:null,source_tree_sha256:null,listed_files:0,matched_files:0,
  verification_scope:'LISTED_FILES_ON_DISK_AT_STARTUP_AFTER_STATIC_IMPORTS',
  source_commit_verification:'MANIFEST_DECLARATION_ONLY',loaded_source_attested:false,
  dependencies_verification:'LOCKFILE_ONLY_NOT_INSTALLED_PACKAGE_BYTES',runtime_models_verified:false,
  complete_runtime_graph:false,excluded_static_import_boundaries:[]};
 try{
  if(typeof releaseDirectory!=='string'||!isAbsolute(releaseDirectory))fail('RELEASE_DIRECTORY_INVALID');
  const root=await realpath(releaseDirectory);result.release_directory=root;
  const manifestFile=join(root,WORKER_MANIFEST_PATH);
  // Intermediate directory symlinks must not redirect a read outside release.
  const manifestParent=await realpath(join(root,'deploy/trading'));
  if(relative(root,manifestParent).split(sep).includes('..'))fail('SOURCE_OUTSIDE_RELEASE');
  const raw=await boundedRegularFile(manifestFile,64*1024);result.manifest_sha256=sha(raw);
  let input;try{input=JSON.parse(raw);}catch{fail('MANIFEST_INVALID_JSON');}
  if(input?.schema!==WORKER_MANIFEST_VERSION||input.entrypoint!=='scripts/trading-worker.mjs')fail('MANIFEST_INVALID');
  if(input.coverage!==WORKER_MANIFEST_SCOPE||input.complete_runtime_graph!==false)fail('MANIFEST_SCOPE_INVALID');
  const clean=createWorkerReleaseManifest({sourceCommit:input.source_commit,files:input.files,excludedStaticImports:input.excluded_static_import_boundaries});
  if(input.source_tree_sha256!==clean.source_tree_sha256)fail('MANIFEST_TREE_HASH_MISMATCH');
  Object.assign(result,{declared_source_commit:clean.source_commit,source_tree_sha256:clean.source_tree_sha256,listed_files:clean.files.length,
   coverage:clean.coverage,excluded_static_import_boundaries:clean.excluded_static_import_boundaries});
  let total=0;
  for(const row of clean.files){
   const path=join(root,row.path),resolved=await realpath(path);
   if(relative(root,resolved).split(sep).includes('..'))fail('SOURCE_OUTSIDE_RELEASE');
   const bytes=await boundedRegularFile(path,Math.min(4*1024*1024,16*1024*1024-total));total+=bytes.length;
   if(sha(bytes)!==row.sha256){result.mismatch_path=row.path;fail('SOURCE_HASH_MISMATCH');}
   result.matched_files++;
  }
  result.status='MANIFEST_FILES_MATCH_DISK';
 }catch(error){
  result.status=error?.code==='ENOENT'&&result.manifest_sha256===null?'MANIFEST_MISSING':'NOT_VERIFIED';
  result.reason=error?.identityCode??(['ENOENT','EACCES','EPERM','ELOOP'].includes(error?.code)?`READ_${error.code}`:'READ_FAILED');
 }
 return freeze(result);
}
export function bindWorkerIdentity({release,store,pid=process.pid,now=Date.now(),uptimeSeconds=process.uptime(),platform}){
 if(!Number.isSafeInteger(pid)||pid<=0||!Number.isSafeInteger(now)||!Number.isFinite(uptimeSeconds)||uptimeSeconds<0||
    release?.version!==WORKER_IDENTITY_VERSION||release.loaded_source_attested!==false||
    typeof store?.owner!=='string'||!store.owner||!Number.isSafeInteger(store.fence)||store.fence<1||!Number.isSafeInteger(store.revision)||store.revision<0)fail('ACQUIRED_WRITER_IDENTITY_REQUIRED');
 const began=Math.trunc(now-uptimeSeconds*1000);
 const out={version:WORKER_IDENTITY_VERSION,pid,captured_at:now,captured_at_utc:new Date(now).toISOString(),
  process_started_at_utc_estimate:new Date(began).toISOString(),process_start_method:'WALL_CLOCK_MINUS_PROCESS_UPTIME_NOT_SYSTEMD_START',
  platform:['EC2','GCE','RENDER'].includes(platform)?platform:'UNKNOWN',
  lease_owner_sha256:sha(store.owner),fence:store.fence,acquired_revision:store.revision,
  release:structuredClone(release),loaded_source_attested:false,lease_binding:'SAME_PROCESS_AFTER_ACQUIRE',
  checkpoint_acknowledged_at_capture:false};
 out.identity_sha256=sha(JSON.stringify(out));return freeze(out);
}
export function workerIdentityHeartbeat(identity,store){
 if(identity?.version!==WORKER_IDENTITY_VERSION)fail('WORKER_IDENTITY_REQUIRED');
 const owner=typeof store?.owner==='string'?sha(store.owner):null;
 return {identity_sha256:identity.identity_sha256,pid:identity.pid,lease_owner_sha256:owner,
  fence:Number.isSafeInteger(store?.fence)?store.fence:null,revision:Number.isSafeInteger(store?.revision)?store.revision:null,
  same_owner_as_startup:owner===identity.lease_owner_sha256&&store?.fence===identity.fence,
  lease_validity:'NOT_CHECKED_BY_HEARTBEAT',loaded_source_attested:false};
}
