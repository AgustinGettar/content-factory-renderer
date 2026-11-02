#!/usr/bin/env node
// EXTERNAL runner only: consume a private read-only export, reconcile labels,
// invoke the pinned trainer, and prepare files for the existing publisher.
// This program has no AWS client, credentials, exchange API or ledger writer.
import {createHash,randomUUID} from 'node:crypto';
import {createReadStream,existsSync} from 'node:fs';
import {open,readFile,stat,mkdir,rename,unlink,chmod} from 'node:fs/promises';
import {dirname,resolve,basename,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createGunzip} from 'node:zlib';
import {StringDecoder} from 'node:string_decoder';
import {spawn} from 'node:child_process';
import {SecondaryNeuralDataset} from '../lib/trading/secondary-neural-dataset.js';
import {parseNeuralArtifact,NEURAL_LIMITS} from '../lib/trading/secondary-neural-runtime.js';
import {hash} from '../lib/trading/core.js';

export const NEURAL_CYCLE_VERSION='secondary-neural-cycle-1.0.0';
export const NEURAL_PUBLICATION_VERSION='secondary-neural-publication-1.0.0';
export const NEURAL_CYCLE_LIMITS=Object.freeze({exportBytes:32000000,lineBytes:1048576,events:10000,jsonBytes:64*1024*1024,statusBytes:65536,trainerMs:180000,childOutputBytes:65536});
const LIMIT=NEURAL_CYCLE_LIMITS,sha=bytes=>createHash('sha256').update(bytes).digest('hex'),stamp=value=>Number.isSafeInteger(value)&&value>=0;
const safeReason=error=>/^[A-Z][A-Z0-9_:.-]{1,180}$/.test(error?.message??'')?error.message:'NEURAL_EXTERNAL_CYCLE_FAILED';
const pick=(value,keys)=>Object.fromEntries(keys.filter(key=>value?.[key]!==undefined).map(key=>[key,value[key]]));
const currentDomain=domain=>domain?.mode==='PAPER'&&domain.realTrading===false&&domain.symbol==='PF_XBTUSD'&&domain.ledger==='FREQUENT_PAPER'&&domain.engine_version==='secondary-futures-1.0.0'&&domain.entry_revision==='secondary-entry-useful-margin-1.0.0'&&domain.execution_version==='secondary-exploration-execution-1.0.0'&&domain.economic_policy_version==='secondary-entry-economics-1.0.0'&&domain.exit_policy_version==='secondary-net-trailing-1.0.0';

export function guardNeuralCycle({mode='PAPER',paths=[]}={},env=process.env){
 if(mode!=='PAPER')throw Error('NEURAL_CYCLE_PAPER_ONLY');
 if(env.LUMI_TRADING_PLATFORM==='EC2'||env.LUMI_TRADING_AWS_INSTANCE_ID==='i-0ae2ad0bb886f3d7f'||existsSync('/var/lib/lumi-trading/trading.sqlite')||paths.some(path=>path&&/^\/(?:var\/lib\/lumi-trading|opt\/lumi-trading)(?:\/|$)/.test(resolve(path))))throw Error('TRAINING_FORBIDDEN_ON_ACTIVE_WORKER');
}
async function readJson(path,limit=LIMIT.jsonBytes,optional=false){
 try{const info=await stat(path);if(!info.isFile()||info.size>limit)throw Error('NEURAL_CYCLE_JSON_SIZE');const raw=await readFile(path,'utf8');if(Buffer.byteLength(raw)>limit)throw Error('NEURAL_CYCLE_JSON_SIZE');return JSON.parse(raw);}catch(error){if(optional&&error.code==='ENOENT')return null;throw error;}
}
async function atomicBytes(path,bytes){
 const parent=dirname(path);await mkdir(parent,{recursive:true,mode:0o700});
 const temporary=join(parent,'.neural-cycle-'+randomUUID()+'.tmp');let handle;
 try{handle=await open(temporary,'wx',0o600);await handle.writeFile(bytes);await handle.sync();await handle.close();handle=null;await rename(temporary,path);}finally{if(handle)await handle.close();await unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});}
 return {name:basename(path),sha256:sha(bytes),bytes:Buffer.byteLength(bytes)};
}
const atomicJson=(path,value)=>atomicBytes(path,Buffer.from(JSON.stringify(value)+'\n'));
async function fileReceipt(path,role){const info=await stat(path);if(!info.isFile()||info.size>LIMIT.jsonBytes)throw Error('NEURAL_CYCLE_FILE_SIZE');const bytes=await readFile(path);return {name:basename(path),role,bytes:bytes.length,sha256:sha(bytes)};}
async function lockCycle(path){
 await mkdir(dirname(path),{recursive:true,mode:0o700});const token=randomUUID();let handle;
 try{handle=await open(path,'wx',0o600);}catch(error){
  if(error.code!=='EEXIST')throw error;const prior=await readJson(path,4096);
  if(prior?.version!==NEURAL_CYCLE_VERSION||!Number.isSafeInteger(prior.pid)||prior.pid<1)throw Error('NEURAL_CYCLE_LOCK_INVALID');
  let stale=false;try{process.kill(prior.pid,0);}catch(check){if(check.code==='ESRCH')stale=true;}
  if(!stale)throw Error('NEURAL_CYCLE_ALREADY_RUNNING');await unlink(path);handle=await open(path,'wx',0o600);
 }
 await handle.writeFile(JSON.stringify({version:NEURAL_CYCLE_VERSION,pid:process.pid,token}));await handle.sync();
 return async()=>{await handle.close();const current=await readJson(path,4096,true);if(current?.token===token)await unlink(path);};
}

/** Streaming gunzip enforces the expanded size too, not just compressed bytes. */
export async function consumeNeuralExport(path,{checkpoint=null}={}){
 const info=await stat(path);if(!info.isFile()||info.size>LIMIT.exportBytes)throw Error('NEURAL_EXPORT_INPUT_SIZE');
 const input=createReadStream(path,{highWaterMark:65536}),gunzip=createGunzip({chunkSize:65536}),digest=createHash('sha256'),decoder=new StringDecoder('utf8');
 let compressed=0,expanded=0,buffer='',manifest=null,footer=null,reducer=null,events=0,page=[],lastRowid=0;
 input.on('data',chunk=>{compressed+=chunk.length;if(compressed>LIMIT.exportBytes)gunzip.destroy(Error('NEURAL_EXPORT_INPUT_SIZE'));else digest.update(chunk);});input.on('error',error=>gunzip.destroy(error));input.pipe(gunzip);
 const flush=()=>{if(page.length){reducer.applyPage(page,{asOf:Math.max(manifest.captured_at,reducer.state.as_of)});page=[];}};
 const line=value=>{
  if(!value)return;if(Buffer.byteLength(value)>LIMIT.lineBytes)throw Error('NEURAL_EXPORT_LINE_LIMIT');const row=JSON.parse(value);
  if(!manifest){
   manifest=row.manifest;
   if(!manifest||manifest.version!=='secondary-neural-export-1.0.0'||manifest.mode!=='PAPER'||manifest.realTrading!==false||manifest.state_id!=='KRAKEN_BTCUSD_PAPER'||manifest.consistent_source!=='SQLITE_READ_TRANSACTION_INCLUDING_WAL'||!stamp(manifest.captured_at)||!stamp(manifest.cursor_start)||!stamp(manifest.snapshot_high_watermark)||manifest.cursor_start>manifest.snapshot_high_watermark||typeof manifest.source_id!=='string'||!stamp(manifest.revision))throw Error('NEURAL_EXPORT_MANIFEST_INVALID');
   reducer=new SecondaryNeuralDataset({checkpoint,sourceId:manifest.source_id});if(manifest.cursor_start>reducer.cursor)throw Error('NEURAL_EXPORT_CURSOR_GAP');if(manifest.snapshot_high_watermark<reducer.cursor)throw Error('NEURAL_EXPORT_STALE_SNAPSHOT');return;
  }
  if(footer)throw Error('NEURAL_EXPORT_TRAILING_RECORDS');
  if(row.checkpoint){footer=row.checkpoint;return;}
  if(++events>LIMIT.events||!Number.isSafeInteger(row.rowid)||row.rowid<=manifest.cursor_start||row.rowid>manifest.snapshot_high_watermark||row.rowid<=lastRowid)throw Error('NEURAL_EXPORT_EVENT_BOUNDS');lastRowid=row.rowid;page.push(row);if(page.length===100)flush();
 };
 try{
  for await(const chunk of gunzip){expanded+=chunk.length;if(expanded>LIMIT.exportBytes)throw Error('NEURAL_EXPORT_EXPANDED_SIZE');buffer+=decoder.write(chunk);let index;while((index=buffer.indexOf('\n'))>=0){line(buffer.slice(0,index));buffer=buffer.slice(index+1);}if(Buffer.byteLength(buffer)>LIMIT.lineBytes)throw Error('NEURAL_EXPORT_LINE_LIMIT');}
  buffer+=decoder.end();if(buffer)line(buffer);flush();
  if(!manifest||!footer||typeof footer.complete!=='boolean'||!stamp(footer.cursor_end)||footer.cursor_end<lastRowid||footer.cursor_end<manifest.cursor_start||footer.cursor_end>manifest.snapshot_high_watermark||footer.events!==events||footer.complete&&footer.cursor_end!==manifest.snapshot_high_watermark)throw Error('NEURAL_EXPORT_FOOTER_INVALID');
  const exportHash=digest.digest('hex');
  if(footer.cursor_end>=reducer.cursor)reducer.acknowledgeExport({cursorEnd:footer.cursor_end,highWatermark:manifest.snapshot_high_watermark,asOf:Math.max(manifest.captured_at,reducer.state.as_of),exportHash,complete:footer.complete});
  return {reducer,manifest,footer,sha256:exportHash,compressed_bytes:compressed,expanded_bytes:expanded};
 }finally{input.destroy();gunzip.destroy();}
}

async function train({datasetFile,trainingCheckpoint,outputDir,env}){
 const script=fileURLToPath(new URL('./trading-neural-train.py',import.meta.url)),python=env.LUMI_TRADING_NEURAL_PYTHON??'python3';
 return await new Promise((resolvePromise,reject)=>{
  const child=spawn(python,[script,'--dataset',datasetFile,'--checkpoint',trainingCheckpoint,'--output-dir',outputDir,'--mode','PAPER'],{env:{...env,OMP_NUM_THREADS:'1',MKL_NUM_THREADS:'1',OPENBLAS_NUM_THREADS:'1',NUMEXPR_NUM_THREADS:'1'},stdio:['ignore','pipe','pipe']});let output='',bytes=0,done=false;
  const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);error?reject(error):resolvePromise(value);};
  const timer=setTimeout(()=>{child.kill('SIGKILL');finish(Error('NEURAL_TRAINER_TIMEOUT'));},LIMIT.trainerMs);
  const collect=chunk=>{bytes+=chunk.length;if(bytes>LIMIT.childOutputBytes){child.kill('SIGKILL');finish(Error('NEURAL_TRAINER_OUTPUT_LIMIT'));return;}output+=chunk.toString('utf8');};
  child.stdout.on('data',collect);child.stderr.on('data',collect);child.on('error',()=>finish(Error('NEURAL_TRAINER_LAUNCH_FAILED')));
  child.on('close',code=>{if(code!==0){let reason='NEURAL_TRAINER_FAILED';try{const report=JSON.parse(output.trim().split('\n').at(-1));if(/^[A-Z][A-Z0-9_:.-]{1,180}$/.test(report.reason??''))reason=report.reason;}catch{}finish(Error(reason));}else finish(null,{code});});
 });
}

function revocations(previous,receipt,training){
 const ids=new Set([...(previous?.revoked_model_ids??[]),...(receipt?.revoked_model_ids??[])]);
 for(const group of Object.values(training?.groups??{}))for(const row of group.history??[])if(/^INVALIDATED|REJECTED|EXPIRED/.test(row.status??'')&&row.model_id)ids.add(row.model_id);
 if(ids.size>4096||[...ids].some(id=>typeof id!=='string'||!/^[A-Za-z0-9_.:-]{1,128}$/.test(id)))throw Error('NEURAL_REVOCATION_REGISTRY_INVALID');return [...ids].sort();
}
function validationSummary(value){if(!value)return null;return {...pick(value,['status','reason','criteria_version','assistance_authorized','n','days','mse','baseline_mse','mae','baseline_mae','stable','reviewed_at']),...(value.priority?{priority:pick(value.priority,['status','reason','cohorts','coverage','n','assistance_authorized'])}:{})};}
export async function selectNeuralPublicationModels(receipt,outputDir,revoked,now){
 const files=receipt?.artifact_files??[];if(!Array.isArray(files)||files.length>32)throw Error('NEURAL_ARTIFACT_MANIFEST_LIMIT');const models=[],unavailable=[];
 for(const file of files){
  if(typeof file.file!=='string'||file.file!==basename(file.file)||!/^[A-Za-z0-9_.-]{1,220}\.json$/.test(file.file)||!['VALIDATED','CANDIDATE'].includes(file.role))throw Error('NEURAL_ARTIFACT_PATH_INVALID');
  if(revoked.includes(file.model_id)){unavailable.push({model_id:file.model_id,reason:'NEURAL_MODEL_REVOKED'});continue;}
  const path=join(outputDir,file.file),info=await stat(path);if(!info.isFile()||info.size>NEURAL_LIMITS.artifact_bytes)throw Error('NEURAL_ARTIFACT_SIZE');const raw=await readFile(path,'utf8');let model;
  try{model=parseNeuralArtifact(raw,{now});}catch(error){if(error.code==='NEURAL_MODEL_EXPIRED'){unavailable.push({model_id:file.model_id,reason:error.code});continue;}throw error;}
  if(file.model_id!==model.model_id||file.sha256!==model.sha256)throw Error('NEURAL_ARTIFACT_RECEIPT_MISMATCH');
  if(revoked.includes(model.model_id)||!currentDomain(model.domain))continue;
  if(file.role==='VALIDATED'&&!model.validation.assistance_authorized)throw Error('NEURAL_ARTIFACT_AUTHORITY_INVALID');
  models.push({file:file.file,role:file.role,model,raw});
 }
 const domains=new Set(models.map(row=>hash(row.model.domain)));if(domains.size>1)throw Error('NEURAL_MODEL_DOMAIN_AMBIGUOUS');
 const newest=rows=>rows.sort((a,b)=>b.model.created_at-a.model.created_at||a.model.model_id.localeCompare(b.model.model_id))[0]??null;
 const active=newest(models.filter(row=>row.role==='VALIDATED')),candidate=newest(models.filter(row=>row.role==='CANDIDATE'));
 return {primary:active??candidate,candidate,active,unavailable};
}

export async function runNeuralCycle({exportFile,datasetCheckpoint,trainingCheckpoint,outputDir,mode='PAPER'}={},env=process.env){
 guardNeuralCycle({mode,paths:[exportFile,datasetCheckpoint,trainingCheckpoint,outputDir]},env);
 if([exportFile,datasetCheckpoint,trainingCheckpoint,outputDir].some(path=>typeof path!=='string'||!path))throw Error('NEURAL_CYCLE_PATHS_REQUIRED');
 [exportFile,datasetCheckpoint,trainingCheckpoint,outputDir]=[exportFile,datasetCheckpoint,trainingCheckpoint,outputDir].map(path=>resolve(path));
 const paths=new Map();
 for(const [path,role] of [[exportFile,'EXPORT'],[datasetCheckpoint,'DATASET_CHECKPOINT'],[trainingCheckpoint,'TRAINING_CHECKPOINT'],[join(outputDir,'dataset-checkpoint.json'),'DATASET_CHECKPOINT'],[join(outputDir,'training-checkpoint.json'),'TRAINING_CHECKPOINT'],[join(outputDir,'status.json'),'STATUS'],[join(outputDir,'publication-manifest.json'),'MANIFEST'],[join(outputDir,'dataset.json'),'DATASET'],[join(outputDir,'bootstrap-dataset.json'),'BOOTSTRAP'],[join(outputDir,'last-receipt.json'),'RECEIPT'],[join(outputDir,'cycle-failure.json'),'FAILURE']]){
  if(paths.has(path)&&paths.get(path)!==role)throw Error('NEURAL_CYCLE_PATH_COLLISION');paths.set(path,role);
 }
 await mkdir(outputDir,{recursive:true,mode:0o700});await chmod(outputDir,0o700);
 const unlock=await lockCycle(datasetCheckpoint+'.cycle.lock'),started=Date.now();
 try{
  const oldCheckpoint=await readJson(datasetCheckpoint,LIMIT.jsonBytes,true),oldStatus=await readJson(join(outputDir,'status.json'),LIMIT.statusBytes,true),source=await consumeNeuralExport(exportFile,{checkpoint:oldCheckpoint}),dataset=source.reducer.export();
  if(source.manifest.captured_at>Date.now()+1000)throw Error('NEURAL_EXPORT_FUTURE_SNAPSHOT');
  const datasetFile=join(outputDir,'dataset.json');await atomicJson(datasetFile,dataset);
  let receipt=null,training=null;
  if(source.footer.complete){await train({datasetFile,trainingCheckpoint,outputDir,env});receipt=await readJson(join(outputDir,'last-receipt.json'));training=await readJson(trainingCheckpoint);}
  else{
   receipt=await readJson(join(outputDir,'last-receipt.json'),LIMIT.jsonBytes,true);training=await readJson(trainingCheckpoint,LIMIT.jsonBytes,true);
   // A first bounded page may precede all close/funding evidence. Bootstrap the
   // trainer's own compatible checkpoint with zero labels; never fit that prefix.
   if(!training){const bootstrap=join(outputDir,'bootstrap-dataset.json');try{await atomicJson(bootstrap,{version:dataset.version,mode:'PAPER',realTrading:false,source:dataset.source,as_of:dataset.as_of,rows:[],checkpoint:dataset.checkpoint});await train({datasetFile:bootstrap,trainingCheckpoint,outputDir,env});receipt=await readJson(join(outputDir,'last-receipt.json'));training=await readJson(trainingCheckpoint);}finally{await unlink(bootstrap).catch(error=>{if(error.code!=='ENOENT')throw error;});}}
  }
  const revoked=revocations(oldStatus,receipt,training),now=Date.now(),models=source.footer.complete?await selectNeuralPublicationModels(receipt,outputDir,revoked,now):{primary:null,candidate:null,active:null,unavailable:[]};
  await atomicJson(datasetCheckpoint,source.reducer.checkpoint());
  const groups=Object.values(receipt?.groups??{}),lastTraining=groups.reduce((latest,group)=>stamp(group.last_training_at)?Math.max(latest??0,group.last_training_at):latest,null),summary=source.reducer.summary();
  const status={version:'secondary-neural-training-status-1.0.0',mode:'PAPER',realTrading:false,at:now,status:!source.footer.complete?'COLLECTING':models.primary?'MODEL_AVAILABLE':'COLLECTING',reason:!source.footer.complete?'MORE_EXPORT_PAGES_REQUIRED':models.primary?.model.validation.assistance_authorized?'VALIDATED_MODEL_AVAILABLE':models.primary?'EXPERIMENTAL_MODEL_PROSPECTIVE_VALIDATION_PENDING':summary.usable?'INSUFFICIENT_MATURE_LABELS_OR_MODEL_NOT_ELIGIBLE':'NO_MATURE_LABELS',dataset:summary,checkpoint:{dataset:hash(source.reducer.checkpoint()),training:receipt?.checkpoint_hash??null,cursor:source.reducer.cursor,source_id:source.manifest.source_id,source_revision:source.manifest.revision,export_sha256:source.sha256},model_id:models.primary?.model.model_id??null,candidate_id:models.candidate?.model.model_id??null,active_model_id:models.active?.model.model_id??null,validation:models.primary?.model.validation??null,last_training_at:lastTraining,revoked_model_ids:revoked,training_location:'EXTERNAL_RUNNER_ONLY',source_complete:source.footer.complete,trainer_changed_labels:receipt?.changed_labels??0,duration_ms:now-started};
  const reportGroup=groups.find(group=>group.model_id===status.candidate_id||group.active_model_id===status.model_id);if(reportGroup?.validation)status.validation=validationSummary(reportGroup.validation);
  status.unavailable_models=models.unavailable;
  if(Buffer.byteLength(JSON.stringify(status))>LIMIT.statusBytes)throw Error('NEURAL_TRAINING_STATUS_SIZE');
  await atomicJson(join(outputDir,'status.json'),status);
  const files=[];const datasetOut=join(outputDir,'dataset-checkpoint.json');if(datasetOut!==datasetCheckpoint)await atomicJson(datasetOut,source.reducer.checkpoint());files.push(await fileReceipt(datasetOut,'DATASET_CHECKPOINT'));
  if(training){const trainingOut=join(outputDir,'training-checkpoint.json');if(trainingOut!==trainingCheckpoint)await atomicJson(trainingOut,training);files.push(await fileReceipt(trainingOut,'TRAINING_CHECKPOINT'));}
  files.push(await fileReceipt(join(outputDir,'status.json'),'STATUS'));
  if(models.primary)files.push(await fileReceipt(join(outputDir,models.primary.file),'MODEL'));
  if(models.candidate&&models.candidate.file!==models.primary?.file)files.push(await fileReceipt(join(outputDir,models.candidate.file),'CANDIDATE'));
  const manifest={version:NEURAL_PUBLICATION_VERSION,mode:'PAPER',realTrading:false,created_at:now,source:{source_id:source.manifest.source_id,revision:source.manifest.revision,cursor:source.reducer.cursor},files,model_id:status.model_id,candidate_id:status.candidate_id,model_domain:models.primary?.model.domain??null,revoked_model_ids:revoked};await atomicJson(join(outputDir,'publication-manifest.json'),manifest);
  return {status,manifest,output_dir:outputDir};
 }catch(error){
  const failure={version:'secondary-neural-training-status-1.0.0',mode:'PAPER',realTrading:false,at:Date.now(),status:'DEGRADED',reason:safeReason(error),base_rules_continue:true,training_location:'EXTERNAL_RUNNER_ONLY',duration_ms:Date.now()-started};
  await atomicJson(join(outputDir,'cycle-failure.json'),failure);throw error;
 }finally{await unlock();}
}

async function main(){
 const options={mode:'PAPER'},keys={'--export':'exportFile','--dataset-checkpoint':'datasetCheckpoint','--training-checkpoint':'trainingCheckpoint','--output-dir':'outputDir','--mode':'mode'};
 for(let i=2;i<process.argv.length;i+=2){const key=keys[process.argv[i]],value=process.argv[i+1];if(!key||!value||value.startsWith('--'))throw Error('NEURAL_CYCLE_ARGUMENTS_INVALID');options[key]=value;}
 const result=await runNeuralCycle(options);console.log(JSON.stringify({status:result.status.status,reason:result.status.reason,cursor:result.status.checkpoint.cursor,usable:result.status.dataset.usable,model_id:result.status.model_id,candidate_id:result.status.candidate_id,manifest:join(result.output_dir,'publication-manifest.json')}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 try{await main();}catch(error){console.error(JSON.stringify({status:'DEGRADED',reason:safeReason(error),base_rules_continue:true}));process.exitCode=1;}
}
