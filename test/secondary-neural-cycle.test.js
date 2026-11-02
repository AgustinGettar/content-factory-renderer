// Isolated fixtures and temporary files only. Empty datasets exercise the actual
// external Python entry point without installing or importing ML dependencies.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,stat,open,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {gzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {NEURAL_FEATURE_NAMES,NEURAL_FEATURE_VERSION,NEURAL_FEATURE_SCHEMA_HASH} from '../lib/trading/secondary-neural-data.js';
import {NEURAL_ARTIFACT_VERSION,NEURAL_MODEL_VERSION,NEURAL_VALIDATION_VERSION} from '../lib/trading/secondary-neural-runtime.js';
import {NEURAL_CYCLE_LIMITS,NEURAL_PUBLICATION_VERSION,guardNeuralCycle,consumeNeuralExport,runNeuralCycle,selectNeuralPublicationModels} from '../scripts/trading-neural-cycle.mjs';

const digest=value=>createHash('sha256').update(value).digest('hex');
const read=async path=>JSON.parse(await readFile(path,'utf8'));
const execute=promisify(execFile);
const DOMAIN={mode:'PAPER',realTrading:false,symbol:'PF_XBTUSD',ledger:'FREQUENT_PAPER',engine_version:'secondary-futures-1.0.0',entry_revision:'secondary-entry-useful-margin-1.0.0',execution_version:'secondary-exploration-execution-1.0.0',economic_policy_version:'secondary-entry-economics-1.0.0',exit_policy_version:'secondary-net-trailing-1.0.0',execution_policy_hash:'1'.repeat(64),economic_policy_hash:'2'.repeat(64),exit_policy_hash:'3'.repeat(64)};

async function fixture(t){
 const directory=await mkdtemp(join(tmpdir(),'lumi-neural-cycle-isolated-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 return {directory,exportFile:join(directory,'events.jsonl.gz'),datasetCheckpoint:join(directory,'dataset-checkpoint.json'),trainingCheckpoint:join(directory,'training-checkpoint.json'),outputDir:join(directory,'private-output'),mode:'PAPER',at:Date.now()-10000};
}
function manifest(f,{start=0,high=0,mode='PAPER',at=f.at}={}){
 return {manifest:{version:'secondary-neural-export-1.0.0',mode,realTrading:false,state_id:'KRAKEN_BTCUSD_PAPER',consistent_source:'SQLITE_READ_TRANSACTION_INCLUDING_WAL',source_id:'ISOLATED_TEST_ONLY',revision:7,captured_at:at,cursor_start:start,snapshot_high_watermark:high,neural_counts:{},legacy_learning:{NO_PRE_ENTRY_FEATURES:8}}};
}
const event=(f,rowid)=>({rowid,id:'isolated-event-'+rowid,kind:'NOT_FILLED',created_at:'2026-11-02T00:00:00Z',payload:{type:'NOT_FILLED',id:'isolated-operation-'+rowid,at:f.at-1,ledger:'FREQUENT_PAPER',version:'secondary-futures-1.0.0',realTrading:false,reason:'ISOLATED_NO_LIQUIDITY'}});
async function source(f,{rows=[],start=0,high=rows.at(-1)?.rowid??0,end=high,complete=true,at=f.at,mutate=x=>x}={}){
 const records=[manifest(f,{start,high,at}),...rows,{checkpoint:{cursor_end:end,complete,events:rows.length}}];
 await writeFile(f.exportFile,gzipSync(mutate(records).map(row=>JSON.stringify(row)+'\n').join('')),{mode:0o600});return records;
}
async function modelFile(f,{id,role='CANDIDATE',created=f.at-1000,domain=DOMAIN,expires=f.at+86400000}={}){
 const dimensions=[NEURAL_FEATURE_NAMES.length,16,8,1],authorized=role==='VALIDATED';
 const payload={version:NEURAL_MODEL_VERSION,model_id:id,feature_version:NEURAL_FEATURE_VERSION,feature_schema_hash:NEURAL_FEATURE_SCHEMA_HASH,feature_names:[...NEURAL_FEATURE_NAMES],domain:structuredClone(domain),trained_at:created,created_at:created,expires_at:expires,training_cutoff:created-1000,max_label_mature_at:created-2000,architecture:{input:dimensions[0],hidden:[16,8],output:1,activation:'tanh',output_activation:'identity'},normalization:{mean:Array(dimensions[0]).fill(0),scale:Array(dimensions[0]).fill(1)},input_domain:{min:Array(dimensions[0]).fill(-10),max:Array(dimensions[0]).fill(10)},output_transform:{mean:0,scale:.01},layers:dimensions.slice(1).map((n,k)=>({weights:Array.from({length:dimensions[k]},()=>Array(n).fill(0)),bias:Array(n).fill(0)})),validation:{status:authorized?'PASSED':'PENDING_PROSPECTIVE',criteria_version:NEURAL_VALIDATION_VERSION,assistance_authorized:authorized}};
 const payload_json=JSON.stringify(payload),sha256=digest(payload_json),file=id+'-'+sha256.slice(0,12)+'.json';
 await writeFile(join(f.directory,file),JSON.stringify({version:NEURAL_ARTIFACT_VERSION,payload_json,sha256}),{mode:0o600});return {file,model_id:id,sha256,role};
}

test('an empty real-shape export runs the real external trainer and produces only private COLLECTING metadata',async t=>{
 const f=await fixture(t);await source(f,{high:4});const {status,manifest:publication}=await runNeuralCycle(f);
 assert.equal(status.status,'COLLECTING');assert.equal(status.reason,'NO_MATURE_LABELS');assert.equal(status.dataset.usable,0);assert.equal(status.model_id,null);assert.equal(status.candidate_id,null);assert.equal(status.last_training_at,null);assert.equal(status.checkpoint.cursor,4);assert.equal(status.source_complete,true);
 assert.equal(publication.version,NEURAL_PUBLICATION_VERSION);assert.deepEqual(publication.files.map(row=>row.role),['DATASET_CHECKPOINT','TRAINING_CHECKPOINT','STATUS']);
 for(const file of publication.files){const bytes=await readFile(join(f.outputDir,file.name));assert.equal(digest(bytes),file.sha256);assert.equal(bytes.length,file.bytes);assert.equal((await stat(join(f.outputDir,file.name))).mode&0o777,0o600);}
 assert.equal((await stat(f.outputDir)).mode&0o777,0o700);assert.deepEqual((await read(join(f.outputDir,'dataset.json'))).rows,[]);
 const checkpoint=await read(f.trainingCheckpoint);assert.deepEqual(checkpoint.groups,{});assert.equal(checkpoint.last_run.artifacts_created,0);assert.equal(checkpoint.last_run.uses_operational_db,false);assert.deepEqual(checkpoint.last_run.revoked_model_ids,[]);
 assert.equal(await readFile(f.datasetCheckpoint,'utf8'),await readFile(join(f.outputDir,'dataset-checkpoint.json'),'utf8'));
 assert(!(await readdir(f.directory)).some(name=>name.endsWith('.cycle.lock')));
});

test('replaying an export and restarting via the CLI does not duplicate events, labels or optimizer updates',async t=>{
 const f=await fixture(t);await source(f,{rows:[event(f,1)],high:3});const once=await runNeuralCycle(f),before=await read(f.datasetCheckpoint),training=await read(f.trainingCheckpoint);
 const twice=await runNeuralCycle(f);assert.deepEqual(await read(f.datasetCheckpoint),before);assert.deepEqual(twice.status.dataset,once.status.dataset);assert.equal(twice.status.dataset.events,1);assert.equal(twice.status.dataset.unfilled,1);assert.equal(twice.status.dataset.label_updates,0);assert.equal(twice.status.trainer_changed_labels,0);assert.deepEqual((await read(f.trainingCheckpoint)).groups,training.groups);
 const script=new URL('../scripts/trading-neural-cycle.mjs',import.meta.url).pathname;
 const beforeCli=Date.now();await execute(process.execPath,[script,'--export',f.exportFile,'--dataset-checkpoint',f.datasetCheckpoint,'--training-checkpoint',f.trainingCheckpoint,'--output-dir',f.outputDir,'--mode','PAPER'],{timeout:10000,maxBuffer:20000});
 // Persisted receipts are authoritative even if a CI launcher captures stdout.
 const receipt=await read(join(f.outputDir,'status.json'));assert(receipt.at>=beforeCli);assert.equal(receipt.checkpoint.cursor,3);assert.equal(receipt.dataset.usable,0);assert.equal(receipt.model_id,null);assert.deepEqual(await read(f.datasetCheckpoint),before);
});

test('partial exports checkpoint a prefix without training it and the next complete page resumes exactly once',async t=>{
 const f=await fixture(t);await source(f,{rows:[event(f,1),event(f,2)],high:4,end:2,complete:false});const first=await runNeuralCycle(f),training=await read(f.trainingCheckpoint);
 assert.equal(first.status.reason,'MORE_EXPORT_PAGES_REQUIRED');assert.equal(first.status.source_complete,false);assert.equal(first.status.last_training_at,null);assert.equal(first.status.checkpoint.cursor,2);assert.deepEqual(training.groups,{});assert.equal(first.manifest.files.filter(row=>row.role==='TRAINING_CHECKPOINT').length,1);
 await source(f,{rows:[event(f,3)],start:2,high:4,end:3,complete:false});const next=await runNeuralCycle(f,{...process.env,LUMI_TRADING_NEURAL_PYTHON:'/isolated-python-must-not-run'});
 assert.equal(next.status.checkpoint.cursor,3);assert.deepEqual(await read(f.trainingCheckpoint),training);assert.equal(next.status.dataset.events,3);
 await source(f,{rows:[event(f,4)],start:3,high:4});const last=await runNeuralCycle(f);assert.equal(last.status.source_complete,true);assert.equal(last.status.dataset.events,4);assert.equal(last.status.dataset.unfilled,4);assert.equal(last.status.dataset.usable,0);assert.equal(last.status.trainer_changed_labels,0);
});

test('REAL, the active EC2 environment and worker paths are rejected before files are created',async t=>{
 const f=await fixture(t);await source(f);
 assert.throws(()=>guardNeuralCycle({mode:'REAL'}),/PAPER_ONLY/);
 for(const env of [{LUMI_TRADING_PLATFORM:'EC2'},{LUMI_TRADING_AWS_INSTANCE_ID:'i-0ae2ad0bb886f3d7f'}])assert.throws(()=>guardNeuralCycle({},env),/FORBIDDEN_ON_ACTIVE_WORKER/);
 for(const path of ['/var/lib/lumi-trading/trading.sqlite','/opt/lumi-trading/current/models'])assert.throws(()=>guardNeuralCycle({paths:[path]},{}),/FORBIDDEN_ON_ACTIVE_WORKER/);
 await assert.rejects(runNeuralCycle({...f,mode:'REAL'}),/PAPER_ONLY/);await assert.rejects(runNeuralCycle(f,{...process.env,LUMI_TRADING_PLATFORM:'EC2'}),/FORBIDDEN_ON_ACTIVE_WORKER/);
 assert.deepEqual(await readdir(f.directory),['events.jsonl.gz']);
});

test('input and output collisions cannot overwrite an export or a different checkpoint',async t=>{
 const f=await fixture(t);await source(f);const before=await readFile(f.exportFile);
 await assert.rejects(runNeuralCycle({...f,datasetCheckpoint:f.exportFile}),/PATH_COLLISION/);
 await assert.rejects(runNeuralCycle({...f,datasetCheckpoint:join(f.outputDir,'training-checkpoint.json')}),/PATH_COLLISION/);
 await assert.rejects(runNeuralCycle({...f,trainingCheckpoint:join(f.outputDir,'dataset.json')}),/PATH_COLLISION/);
 assert.deepEqual(await readFile(f.exportFile),before);assert.deepEqual(await readdir(f.directory),['events.jsonl.gz']);
});

test('invalid footers and a failed trainer leave the published cursor and last compatible files unchanged',async t=>{
 const f=await fixture(t);await source(f,{rows:[event(f,1)]});await runNeuralCycle(f);
 const checkpoint=await readFile(f.datasetCheckpoint),publication=await readFile(join(f.outputDir,'publication-manifest.json')),status=await readFile(join(f.outputDir,'status.json'));
 await source(f,{rows:[event(f,2)],start:1,high:2,mutate:records=>{records.at(-1).checkpoint.events=7;return records;}});
 await assert.rejects(runNeuralCycle(f),/FOOTER_INVALID/);assert.deepEqual(await readFile(f.datasetCheckpoint),checkpoint);assert.deepEqual(await readFile(join(f.outputDir,'publication-manifest.json')),publication);
 await source(f,{rows:[event(f,2)],start:1,high:2});await assert.rejects(runNeuralCycle(f,{...process.env,LUMI_TRADING_NEURAL_PYTHON:'/isolated-missing-python'}),/LAUNCH_FAILED/);
 assert.deepEqual(await readFile(f.datasetCheckpoint),checkpoint);assert.deepEqual(await readFile(join(f.outputDir,'status.json')),status);assert.deepEqual(await readFile(join(f.outputDir,'publication-manifest.json')),publication);
 const failure=await read(join(f.outputDir,'cycle-failure.json'));assert.equal(failure.reason,'NEURAL_TRAINER_LAUNCH_FAILED');assert.equal(failure.base_rules_continue,true);assert.equal(failure.status,'DEGRADED');
 assert(!(await readdir(f.directory)).some(name=>name.endsWith('.cycle.lock')));
});

test('gzip, causal source bounds, source identity and future snapshots fail explicitly',async t=>{
 const f=await fixture(t);await writeFile(f.exportFile,'not gzip');await assert.rejects(consumeNeuralExport(f.exportFile));
 await source(f,{start:1,high:1});await assert.rejects(consumeNeuralExport(f.exportFile),/CURSOR_GAP/);
 await source(f,{rows:[event(f,1),event(f,1)],high:1});await assert.rejects(consumeNeuralExport(f.exportFile),/EVENT_BOUNDS/);
 await source(f,{mutate:records=>{records[0].manifest.mode='REAL';return records;}});await assert.rejects(consumeNeuralExport(f.exportFile),/MANIFEST_INVALID/);
 await source(f,{high:3});const {reducer}=await consumeNeuralExport(f.exportFile);await source(f,{high:2});await assert.rejects(consumeNeuralExport(f.exportFile,{checkpoint:reducer.checkpoint()}),/STALE_SNAPSHOT/);
 await source(f,{start:3,high:3,mutate:records=>{records[0].manifest.source_id='DIFFERENT_SOURCE';return records;}});await assert.rejects(consumeNeuralExport(f.exportFile,{checkpoint:reducer.checkpoint()}),/CHECKPOINT_INVALID/);
 await source(f,{at:Date.now()+60000});await assert.rejects(runNeuralCycle(f),/FUTURE_SNAPSHOT/);await assert.rejects(readFile(f.datasetCheckpoint),{code:'ENOENT'});
});

test('compressed file and expanded record budgets are enforced before unbounded allocation',async t=>{
 const f=await fixture(t),handle=await open(f.exportFile,'w');await handle.truncate(NEURAL_CYCLE_LIMITS.exportBytes+1);await handle.close();await assert.rejects(consumeNeuralExport(f.exportFile),/INPUT_SIZE/);
 await writeFile(f.exportFile,gzipSync('x'.repeat(NEURAL_CYCLE_LIMITS.lineBytes+1)));await assert.rejects(consumeNeuralExport(f.exportFile),/LINE_LIMIT/);
 await source(f,{mutate:records=>{records.push({extra:true});return records;}});await assert.rejects(consumeNeuralExport(f.exportFile),/TRAILING_RECORDS/);
});

test('a validated active model remains primary while the newer candidate is published separately',async t=>{
 const f=await fixture(t),active=await modelFile(f,{id:'nn_isolated_active',role:'VALIDATED',created:f.at-3000}),candidate=await modelFile(f,{id:'nn_isolated_candidate',created:f.at-1000}),older=await modelFile(f,{id:'nn_isolated_older',created:f.at-2000});
 const selected=await selectNeuralPublicationModels({artifact_files:[candidate,active,older]},f.directory,[],f.at);
 assert.equal(selected.primary.model.model_id,active.model_id);assert.equal(selected.active.model.model_id,active.model_id);assert.equal(selected.candidate.model.model_id,candidate.model_id);
 const advisory=await selectNeuralPublicationModels({artifact_files:[candidate]},f.directory,[],f.at);assert.equal(advisory.primary.model.model_id,candidate.model_id);assert.equal(advisory.active,null);assert.equal(advisory.primary.model.validation.assistance_authorized,false);
});

test('revoked and expired artifacts cannot revive; conflicting domains and receipt hashes are rejected',async t=>{
 const f=await fixture(t),active=await modelFile(f,{id:'nn_isolated_active',role:'VALIDATED'}),candidate=await modelFile(f,{id:'nn_isolated_candidate'}),expired=await modelFile(f,{id:'nn_isolated_expired',role:'VALIDATED',created:f.at-10000,expires:f.at-1});
 const selection=await selectNeuralPublicationModels({artifact_files:[active,candidate,expired]},f.directory,[active.model_id],f.at);
 assert.equal(selection.primary.model.model_id,candidate.model_id);assert.equal(selection.active,null);assert.deepEqual(selection.unavailable.map(row=>row.reason),['NEURAL_MODEL_REVOKED','NEURAL_MODEL_EXPIRED']);
 await assert.rejects(selectNeuralPublicationModels({artifact_files:[{...candidate,sha256:'0'.repeat(64)}]},f.directory,[],f.at),/RECEIPT_MISMATCH/);
 const other=await modelFile(f,{id:'nn_isolated_other_contract',domain:{...DOMAIN,exit_policy_hash:'4'.repeat(64)}});await assert.rejects(selectNeuralPublicationModels({artifact_files:[candidate,other]},f.directory,[],f.at),/DOMAIN_AMBIGUOUS/);
 await assert.rejects(selectNeuralPublicationModels({artifact_files:[{...candidate,file:'../other.json'}]},f.directory,[],f.at),/PATH_INVALID/);
});
