#!/usr/bin/env node
// Local packaging tool. Parses ESM without evaluation; no worker, DB or remote Git.
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {constants,openSync,fstatSync,readSync,closeSync,realpathSync,writeFileSync} from 'node:fs';
import {relative,resolve,sep,posix} from 'node:path';
import {pathToFileURL} from 'node:url';
import vm from 'node:vm';
import {createWorkerReleaseManifest} from '../lib/trading/worker-release-identity.js';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const allowed=/^(?:lib\/trading\/[a-z0-9-]+\.(?:js|mjs)|scripts\/trading-worker\.mjs|package(?:-lock)?\.json)$/;
export const WORKER_SOURCE_ROOTS=Object.freeze(['scripts/trading-worker.mjs']);
function readSource(path,maximum){
 const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{
  const stat=fstatSync(fd);if(!stat.isFile()||stat.size>maximum)throw Error('MANIFEST_SOURCE_READ_NOT_ALLOWED');
  const bytes=Buffer.alloc(Math.min(maximum+1,stat.size+1));let count=0;
  while(count<bytes.length){const n=readSync(fd,bytes,count,bytes.length-count,count);if(!n)break;count+=n;}
  const after=fstatSync(fd);
  if(count!==stat.size||after.size!==stat.size||after.mtimeMs!==stat.mtimeMs||after.ctimeMs!==stat.ctimeMs)throw Error('SOURCE_CHANGED_DURING_MANIFEST');
  return bytes.subarray(0,count);
 }finally{closeSync(fd);}
}
function collectWorkerStaticScope({directory,onSource=()=>{}}){
 if(typeof vm.SourceTextModule!=='function')throw Error('RUN_NODE_WITH_EXPERIMENTAL_VM_MODULES_FOR_PARSE_ONLY');
 const root=realpathSync(directory),files=[],boundaries=[],seen=new Set(),pending=[...WORKER_SOURCE_ROOTS,'package.json','package-lock.json'];let total=0;
 while(pending.length){
  const path=pending.shift();if(seen.has(path))continue;
  if(!allowed.test(path)||files.length>=256)throw Error('MANIFEST_SOURCE_SCOPE_INVALID');
  seen.add(path);const full=resolve(root,path),resolved=realpathSync(full);
  if(relative(root,resolved).split(sep).includes('..'))throw Error('MANIFEST_SOURCE_READ_NOT_ALLOWED');
  const bytes=readSource(full,Math.min(4*1024*1024,16*1024*1024-total));total+=bytes.length;
  onSource({root,path,bytes});
  files.push({path,sha256:sha(bytes)});
  if(path.endsWith('.json'))continue;
  const parsed=new vm.SourceTextModule(bytes.toString('utf8'),{identifier:path});
  for(const specifier of parsed.dependencySpecifiers){
   if(specifier.startsWith('.')){
    const dependency=posix.normalize(posix.join(posix.dirname(path),specifier));
    if(allowed.test(dependency))pending.push(dependency);
    else{
     // Existing Telegram transport reaches unrelated legacy modules. Their
     // boundary is declared, not silently treated as verified or traversed.
     if(!/^(?:lib|docs|episodes)\/[A-Za-z0-9_./-]+\.(?:js|mjs|json)$/.test(dependency)||dependency.split('/').includes('..'))throw Error('LOCAL_IMPORT_OUTSIDE_DECLARED_WORKER_SCOPE');
     boundaries.push({importer:path,specifier,resolved:dependency});
    }
   }else if(!specifier.startsWith('node:')&&!['@supabase/supabase-js','decimal.js'].includes(specifier))throw Error('UNREVIEWED_PACKAGE_IMPORT');
  }
 }
 return {files,excludedStaticImports:boundaries,roots:[...WORKER_SOURCE_ROOTS],complete_runtime_graph:false};
}
export function inspectWorkerStaticScope({directory}){return collectWorkerStaticScope({directory});}
export function generateWorkerReleaseManifest({directory,sourceCommit}){
 if(!/^[a-f0-9]{40}$/.test(sourceCommit??''))throw Error('FULL_SOURCE_COMMIT_REQUIRED');
 const scope=collectWorkerStaticScope({directory,onSource:({root,path,bytes})=>{
  let committed;
  try{committed=execFileSync('git',['--no-optional-locks','-C',root,'show',`${sourceCommit}:${path}`],{maxBuffer:4*1024*1024,stdio:['ignore','pipe','pipe'],timeout:5000});}
  catch{throw Error('SOURCE_NOT_PRESENT_AT_DECLARED_COMMIT');}
  if(!bytes.equals(committed))throw Error(`SOURCE_DIFFERS_FROM_DECLARED_COMMIT:${path}`);
 }});
 return {...createWorkerReleaseManifest({sourceCommit,files:scope.files,excludedStaticImports:scope.excludedStaticImports}),
  roots:[...WORKER_SOURCE_ROOTS],
  source_commit_files_compared:true,installed_dependency_bytes_verified:false,
  loaded_source_attested:false};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const [sourceCommit,output,directory=process.cwd()]=process.argv.slice(2);
 if(!sourceCommit||!output||process.argv.length>5)throw Error('Usage: node --experimental-vm-modules scripts/trading-worker-release-manifest.mjs FULL_SOURCE_COMMIT NEW_OUTPUT.json [RELEASE_DIRECTORY]');
 const manifest=generateWorkerReleaseManifest({directory,sourceCommit});
 writeFileSync(output,JSON.stringify(manifest,null,2)+'\n',{flag:'wx',mode:0o600});
 process.stdout.write(JSON.stringify({output,source_commit:manifest.source_commit,source_tree_sha256:manifest.source_tree_sha256,files:manifest.files.length,loaded_source_attested:false})+'\n');
}
