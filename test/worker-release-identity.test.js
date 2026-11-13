import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {SQLiteStore} from '../lib/trading/sqlite-store.js';
import {WORKER_IDENTITY_VERSION,WORKER_MANIFEST_PATH,createWorkerReleaseManifest,inspectWorkerRelease,bindWorkerIdentity,workerIdentityHeartbeat} from '../lib/trading/worker-release-identity.js';
const T=Date.parse('2026-11-07T03:00:00Z'),sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const required=['scripts/trading-worker.mjs','lib/trading/worker-release-identity.js','lib/trading/engine.js',
 'lib/trading/runtime-guard.js','lib/trading/store.js','lib/trading/sqlite-store.js','package.json','package-lock.json'];
async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'lumi-release-test-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const files=[];
 for(const path of required){const bytes=Buffer.from(path.endsWith('.json')?'{}\n':`export const role=${JSON.stringify(path)};\n`);await mkdir(dirname(join(root,path)),{recursive:true});await writeFile(join(root,path),bytes);files.push({path,sha256:sha(bytes)});}
 await mkdir(join(root,'deploy/trading'),{recursive:true});
 const manifest=createWorkerReleaseManifest({sourceCommit:'a'.repeat(40),files});
 const save=value=>writeFile(join(root,WORKER_MANIFEST_PATH),JSON.stringify(value));
 await save(manifest);return {root,files,manifest,save,inspect:()=>inspectWorkerRelease({releaseDirectory:root,now:()=>T})};
}
test('manifest agrees with bounded source files but never claims loaded JavaScript attestation',async t=>{
 const f=await fixture(t),r=await f.inspect();assert.equal(r.status,'MANIFEST_FILES_MATCH_DISK');
 assert.equal(r.matched_files,required.length);assert.equal(r.declared_source_commit,'a'.repeat(40));
 assert.equal(r.loaded_source_attested,false);assert.match(r.verification_scope,/AFTER_STATIC_IMPORTS/);
 assert.equal(r.dependencies_verification,'LOCKFILE_ONLY_NOT_INSTALLED_PACKAGE_BYTES');
 assert(Object.isFrozen(r));assert.equal(r.checked_at_utc,'2026-11-07T03:00:00.000Z');
});
test('missing and malformed manifests remain explicit diagnostics, with no startup exception',async t=>{
 const f=await fixture(t);await rm(join(f.root,WORKER_MANIFEST_PATH));assert.equal((await f.inspect()).status,'MANIFEST_MISSING');
 await writeFile(join(f.root,WORKER_MANIFEST_PATH),'{malformed-secret-marker');const r=await f.inspect();
 assert.equal(r.reason,'MANIFEST_INVALID_JSON');assert.equal(r.status,'NOT_VERIFIED');assert(!JSON.stringify(r).includes('secret-marker'));
});
test('changed source and false tree digest are rejected without claiming a different commit',async t=>{
 const f=await fixture(t);await writeFile(join(f.root,'lib/trading/engine.js'),'export const altered=true;');
 const r=await f.inspect();assert.equal(r.reason,'SOURCE_HASH_MISMATCH');assert.equal(r.loaded_source_attested,false);
 assert.equal(r.mismatch_path,'lib/trading/engine.js');
 await f.save({...f.manifest,source_tree_sha256:'0'.repeat(64)});assert.equal((await f.inspect()).reason,'MANIFEST_TREE_HASH_MISMATCH');
});
test('traversal, credentials paths, duplicate entries, and omitted mandatory sources are rejected',async t=>{
 const f=await fixture(t);
 for(const path of ['../secret.env','/etc/lumi-trading/worker.env','.aws/credentials','lib/trading/../../.env']){
  await f.save({...f.manifest,files:[...f.files,{path,sha256:'0'.repeat(64)}]});
  assert.equal((await f.inspect()).reason,'MANIFEST_INVALID');
 }
 assert.throws(()=>createWorkerReleaseManifest({sourceCommit:'a'.repeat(40),files:[...f.files,f.files[0]]}),/MANIFEST_INVALID/);
 assert.throws(()=>createWorkerReleaseManifest({sourceCommit:'a'.repeat(40),files:f.files.filter(x=>!x.path.endsWith('sqlite-store.js'))}),/MANIFEST_INVALID|REQUIRED_FILE/);
});
test('manifest and source symlinks cannot redirect verification outside the release',async t=>{
 const f=await fixture(t),other=await mkdtemp(join(tmpdir(),'lumi-release-outside-'));t.after(()=>rm(other,{recursive:true,force:true}));
 await writeFile(join(other,'file.js'),'SYNTHETIC_SECRET_NEVER_RETURNED');
 await rm(join(f.root,'lib/trading/engine.js'));await symlink(join(other,'file.js'),join(f.root,'lib/trading/engine.js'));
 const r=await f.inspect();assert.equal(r.reason,'SOURCE_OUTSIDE_RELEASE');assert(!JSON.stringify(r).includes('SYNTHETIC_SECRET'));
 await rm(join(f.root,WORKER_MANIFEST_PATH));await symlink(join(other,'file.js'),join(f.root,WORKER_MANIFEST_PATH));
 assert.equal((await f.inspect()).reason,'READ_ELOOP');
});
test('oversized manifests and source files are rejected within declared limits',async t=>{
 const f=await fixture(t);await writeFile(join(f.root,WORKER_MANIFEST_PATH),' '.repeat(65537));
 assert.equal((await f.inspect()).reason,'SOURCE_TYPE_OR_SIZE_INVALID');
 await f.save(f.manifest);await writeFile(join(f.root,'lib/trading/engine.js'),Buffer.alloc(4*1024*1024+1));
 assert.equal((await f.inspect()).reason,'SOURCE_TYPE_OR_SIZE_INVALID');
});
test('receipt binds PID, writer owner hash and fencing after acquisition without disclosing UUID',async t=>{
 const f=await fixture(t),release=await f.inspect(),store={owner:'synthetic-private-owner-uuid',fence:7,revision:89};
 const r=bindWorkerIdentity({release,store,pid:1234,now:T,uptimeSeconds:12.5,platform:'EC2'});
 assert.equal(r.pid,1234);assert.equal(r.lease_owner_sha256,sha(store.owner));assert.equal(r.fence,7);assert.equal(r.acquired_revision,89);
 assert.equal(r.process_started_at_utc_estimate,'2026-11-07T02:59:47.500Z');
 assert(!JSON.stringify(r).includes(store.owner));assert(Object.isFrozen(r.release));assert.equal(r.loaded_source_attested,false);
 assert.throws(()=>bindWorkerIdentity({release,store:{...store,fence:0},pid:1,now:T,uptimeSeconds:0}),/ACQUIRED_WRITER_IDENTITY_REQUIRED/);
});
test('health reads current revision/owner/fence and does not claim the DB lease is still valid',async t=>{
 const f=await fixture(t),store={owner:'owner-a',fence:2,revision:1};
 const identity=bindWorkerIdentity({release:await f.inspect(),store,pid:2,now:T,uptimeSeconds:0});
 store.revision=9;const h=workerIdentityHeartbeat(identity,store);assert.equal(h.revision,9);assert.equal(h.same_owner_as_startup,true);
 store.owner='owner-b';store.fence=3;assert.equal(workerIdentityHeartbeat(identity,store).same_owner_as_startup,false);
 assert.equal(h.lease_validity,'NOT_CHECKED_BY_HEARTBEAT');assert.equal(identity.acquired_revision,1);
});
test('identity event uses the acquired SQLite writer and normal atomic checkpoint without another writer',async t=>{
 const f=await fixture(t),store=new SQLiteStore(join(f.root,'test.sqlite'),{allowEmpty:true,now:()=>T});t.after(()=>store.close());
 store.import({schema:1,exported_at:new Date(T).toISOString(),state:{id:'KRAKEN_BTCUSD_PAPER',revision:1,fence:0,last_batch:null,state:{research:{preserved:true},frequency:{balance:'101.23'}},updated_at:new Date(T).toISOString()},counts:{events:0,outbox:0},events:[],outbox:[]});
 const original=await store.acquire();const identity=bindWorkerIdentity({release:await f.inspect(),store,pid:3,now:T,uptimeSeconds:0});
 await store.commit(original,[{type:'WORKER_RELEASE_IDENTITY',at:T,identity}],[]);
 assert.deepEqual(store.row().state,original);assert.equal(store.row().revision,2);
 const event=(await store.history('WORKER_RELEASE_IDENTITY'))[0];assert.equal(event.identity.lease_owner_sha256,sha(store.row().lease_owner));
 assert.equal(event.identity.fence,store.row().fence);assert.equal(store.notices().length,0);assert.equal(event.identity.loaded_source_attested,false);
});
async function gitFixture(t){
 const f=await fixture(t);
 const imports=required.filter(p=>p.startsWith('lib/trading/')&&!p.endsWith('.mjs')).map(p=>`import '../${p}';`).join('\n');
 await writeFile(join(f.root,'scripts/trading-worker.mjs'),imports+"\nthrow Error('PARSER_MUST_NOT_EXECUTE_WORKER');\n");
 // Only Trading's entrypoint is a root here. The unrelated thread and offline
 // report must not be traversed or executed merely to identify this candidate.
 await writeFile(join(f.root,'lib/trading/shadow-observation-worker.mjs'),"import './shadow-test-dependency.js';\nthrow Error('PARSER_MUST_NOT_START_THREAD');\n");
 await writeFile(join(f.root,'lib/trading/shadow-test-dependency.js'),'export const dependency=true;\n');
 await writeFile(join(f.root,'lib/trading/engine.js'),"import './static-test-dependency.js';\nexport const engine=true;\n");
 await writeFile(join(f.root,'lib/trading/static-test-dependency.js'),"throw Error('PARSER_MUST_NOT_EXECUTE_STATIC_DEPENDENCY');\n");
 await writeFile(join(f.root,'lib/trading/secondary-performance-review.js'),"throw Error('OFFLINE_FINANCING_NOT_RUNTIME');\n");
 const git=args=>execFileSync('git',['-C',f.root,...args],{stdio:['ignore','pipe','pipe']}).toString().trim();
 git(['init','-q']);git(['add','.']);git(['-c','user.name=Local Test','-c','user.email=local@example.invalid','commit','-qm','synthetic release only']);
 return {...f,commit:git(['rev-parse','HEAD'])};
}
const generator=resolve(new URL('../scripts/trading-worker-release-manifest.mjs',import.meta.url).pathname);
const generate=(f,out)=>execFileSync(process.execPath,['--experimental-vm-modules',generator,f.commit,out,f.root],{stdio:['ignore','pipe','pipe']});
test('offline generator checks committed bytes and parses only static worker roots without evaluating them',async t=>{
 const f=await gitFixture(t),out=join(f.root,'generated.json');generate(f,out);
 const manifest=JSON.parse(await readFile(out,'utf8'));
 assert(manifest.files.some(r=>r.path==='lib/trading/static-test-dependency.js'));
 assert(!manifest.files.some(r=>r.path.includes('shadow-')));
 assert.deepEqual(manifest.roots,['scripts/trading-worker.mjs']);
 assert(!manifest.files.some(r=>r.path==='lib/trading/secondary-performance-review.js'));
 assert.equal(manifest.source_commit,f.commit);assert.equal(manifest.loaded_source_attested,false);
 await f.save(manifest);assert.equal((await f.inspect()).status,'MANIFEST_FILES_MATCH_DISK');
 assert.throws(()=>generate(f,out),/EEXIST/);
});
test('offline generator refuses uncommitted source edits instead of labeling them with a clean commit',async t=>{
 const f=await gitFixture(t);await writeFile(join(f.root,'lib/trading/engine.js'),'export const uncommitted=true;');
 assert.throws(()=>generate(f,join(f.root,'should-not-exist.json')),/SOURCE_DIFFERS_FROM_DECLARED_COMMIT/);
});
test('legacy import boundary is explicit and never traversed or certified as complete runtime',async t=>{
 const f=await gitFixture(t);
 await writeFile(join(f.root,'lib/trading/engine.js'),"import '../telegram-review-v1/runtime.js';\nexport const engine=true;\n");
 // There is intentionally no legacy file: this focused manifest must not read
 // or execute that dependency just to identify Trading's listed source bytes.
 const git=args=>execFileSync('git',['-C',f.root,...args],{stdio:['ignore','pipe','pipe']}).toString().trim();
 git(['add','lib/trading/engine.js']);
 git(['-c','user.name=Local Test','-c','user.email=local@example.invalid','commit','-qm','synthetic legacy boundary']);
 f.commit=git(['rev-parse','HEAD']);
 const out=join(f.root,'bounded.json');generate(f,out);const manifest=JSON.parse(await readFile(out,'utf8'));
 assert.equal(manifest.complete_runtime_graph,false);
 assert.deepEqual(manifest.excluded_static_import_boundaries,[{importer:'lib/trading/engine.js',specifier:'../telegram-review-v1/runtime.js',resolved:'lib/telegram-review-v1/runtime.js',reason:'OUTSIDE_TRADING_SOURCE_SCOPE_NOT_READ'}]);
 await f.save(manifest);const r=await f.inspect();assert.equal(r.status,'MANIFEST_FILES_MATCH_DISK');
 assert.equal(r.excluded_static_import_boundaries.length,1);assert.equal(r.complete_runtime_graph,false);assert.equal(r.loaded_source_attested,false);
});
test('a manifest cannot relabel a scoped disk inspection as a complete loaded runtime',async t=>{
 const f=await fixture(t);await f.save({...f.manifest,complete_runtime_graph:true});
 assert.equal((await f.inspect()).reason,'MANIFEST_SCOPE_INVALID');
 await f.save({...f.manifest,excluded_static_import_boundaries:[{importer:'lib/trading/engine.js',specifier:'../../.env',resolved:'.env'}]});
 assert.equal((await f.inspect()).reason,'MANIFEST_BOUNDARIES_INVALID');
});
test('worker wiring records provenance after acquire and before health, without changing stop handlers',async()=>{
 const source=await readFile(new URL('../scripts/trading-worker.mjs',import.meta.url),'utf8');
 assert(source.indexOf('const releaseIdentity=await inspectWorkerRelease')<source.indexOf('await engine.initialize()'));
 assert(source.indexOf('const workerIdentity=bindWorkerIdentity')>source.indexOf('await engine.initialize()'));
 assert.match(source,/engine\.event\(\{type:'WORKER_RELEASE_IDENTITY'/);
 assert.match(source,/worker_identity:workerIdentityHeartbeat\(workerIdentity,store\)/);
 assert.match(source,/process\.on\('SIGTERM',stop\)/);
 assert.equal(WORKER_IDENTITY_VERSION,'lumi-worker-release-identity-1.0.0');
});
test('worker delta is only additive identity and preserves every existing operational line from the disk base',async()=>{
 const root=resolve(new URL('../',import.meta.url).pathname);
 const base=execFileSync('git',['-C',root,'show','9f8648abe12cb3457814bae9074d8e666fd56cba:scripts/trading-worker.mjs'],{stdio:['ignore','pipe','pipe']}).toString();
 const source=await readFile(new URL('../scripts/trading-worker.mjs',import.meta.url),'utf8');
 const withoutIdentity=source
  .replace("import {fileURLToPath} from 'node:url';\n",'')
  .replace("import {inspectWorkerRelease,bindWorkerIdentity,workerIdentityHeartbeat} from '../lib/trading/worker-release-identity.js';\n",'')
  .replace("// Bounded disk provenance before acquiring the lease. ESM imports have already\n// run; this receipt never attests loaded JS bytes or unlisted dependencies.\nconst releaseIdentity=await inspectWorkerRelease({releaseDirectory:fileURLToPath(new URL('../',import.meta.url))});\n",'')
  .replace("const workerIdentity=bindWorkerIdentity({release:releaseIdentity,store,platform:runtime.platform});\nengine.event({type:'WORKER_RELEASE_IDENTITY',at:workerIdentity.captured_at,identity:workerIdentity});\n",'')
  .replace(',worker_identity:workerIdentityHeartbeat(workerIdentity,store)','')
  .replace(',worker_identity:workerIdentity','');
 assert.equal(withoutIdentity,base,'STOP, startup guards, feeds, resource limits, economic flush and shutdown must remain unchanged');
});
