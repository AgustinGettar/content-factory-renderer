import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {sha256,validateArtifact} from './telegram-review-v1/core.js';
import {verifyArtifact} from './lumi-recovery-incident-manager-v1.js';
import {inspectLumiAudio} from './lumi-tts-stage-v2.js';
const exec=promisify(execFile);
const formats={IMAGE:['png','image/png'],VIDEO:['mp4','video/mp4'],TTS:['mp3','audio/mpeg'],MASTER:['mp4','video/mp4'],ASSEMBLY:['mp4','video/mp4']};
const safe=s=>typeof s==='string'&&/^[A-Za-z0-9_-]{1,120}$/.test(s);
const imageMime=bytes=>bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))?'image/png':
  bytes[0]===255&&bytes[1]===216&&bytes[2]===255?'image/jpeg':null;

// Uses the already configured server client; never exports credentials or URLs.
export function createArtifactStorage(db){
  const location=(bucket,path)=>{if(!safe(bucket)||!path?.split('/').every(s=>/^[A-Za-z0-9_.-]+$/.test(s)&&s!=='.'&&s!=='..'))throw Error('ARTIFACT_STORAGE_IDENTITY_INVALID');};
  return {
    async download(bucket,path){location(bucket,path);const {data,error}=await db.storage.from(bucket).download(path);
      if(error){if(error.code==='NoSuchKey'||error.error==='NoSuchKey'||error.message==='Object not found')return null;throw Error('ARTIFACT_STORAGE_READ_FAILED');}
      return Buffer.from(await data.arrayBuffer());},
    async upload(bucket,path,bytes,options){location(bucket,path);const {error}=await db.storage.from(bucket).upload(path,bytes,{...options,upsert:false});if(error)throw Error('ARTIFACT_STORAGE_WRITE_FAILED');},
    async remove(bucket,path){location(bucket,path);const {error}=await db.storage.from(bucket).remove([path]);if(error)throw Error('ARTIFACT_STORAGE_REMOVE_FAILED');}
  };
}

// Inspect original bytes. Video aspect ratio is measured, never silently repaired.
export async function inspectMaterializedArtifact(bytes,stage,sha,expected={}){
  if(stage==='TTS')return inspectLumiAudio(bytes,sha);
  const dir=await mkdtemp(join(tmpdir(),'lumi-materialize-'));
  try{
    const file=join(dir,'original.'+formats[stage][0]);await writeFile(file,bytes);
    if(stage==='IMAGE'){
      if(!imageMime(bytes)||sha256(bytes)!==sha)throw Error('IMAGE_INVALID');
      const meta=JSON.parse((await exec('ffprobe',['-v','error','-show_streams','-of','json',file])).stdout),stream=meta.streams?.find(s=>s.codec_type==='video');
      if(!stream?.width||!stream.height||expected.width&&expected.width!==stream.width||expected.height&&expected.height!==stream.height)throw Error('IMAGE_DIMENSIONS_INVALID');
      await exec('ffmpeg',['-v','error','-xerror','-i',file,'-f','null','-'],{maxBuffer:1024*1024});
      return {ok:true,status:'PASS',sha256:sha,width:stream.width,height:stream.height,decode:'PASS',original_preserved:true};
    }
    const qa=await verifyArtifact({type:stage==='ASSEMBLY'?'MASTER':stage,filePath:file,expectedSha256:sha,expected});
    if(!qa.ok)return {...qa,status:'FAIL'};
    const width=qa.width??qa.video?.width,height=qa.height??qa.video?.height;
    return {...qa,status:'PASS',width,height,native_aspect_ratio:width&&height?width/height:null,
      exact_9_16:width&&height?width*16===height*9:null,original_preserved:true};
  }catch{return {ok:false,status:'FAIL',error_class:'ARTIFACT_DECODE_FAILURE'};}
  finally{await rm(dir,{recursive:true,force:true});}
}

// Reuses the existing CAS receipt store and storage adapter. No provider submission
// is present here. recoverOriginal may ONLY recover an already accepted result.
export async function materializeStageArtifact(input,{receipts,storage,recoverOriginal,
  inspect=inspectMaterializedArtifact,inject=async()=>{}}){
  const {episode_id,stage_id,action_key,provider_job_id,result_id,target}=input;
  if(!safe(episode_id)||typeof action_key!=='string'||!/^[A-Za-z0-9_:-]{1,200}$/.test(action_key)||!formats[stage_id]||!safe(provider_job_id)||!safe(result_id)
    ||!safe(target?.bucket)||!target.prefix?.split('/').every(safe))throw Error('MATERIALIZATION_IDENTITY_REQUIRED');
  if(!receipts?.transition||!storage?.download||!storage?.upload)throw Error('MATERIALIZATION_RUNTIME_REQUIRED');
  const existing=input.existing_artifact;
  if(existing){validateArtifact(existing);if(existing.sha256!==input.expected_sha256||existing.bucket!==target.bucket
    ||existing.mime!==(stage_id==='IMAGE'?imageMimeFromName(existing.mime):formats[stage_id][1]))throw Error('EXISTING_ARTIFACT_BINDING_REQUIRED');}
  const identity={episode_id,stage_id,action_key,provider_job_id,result_id,target,
    expected_sha256:input.expected_sha256??null,expected:input.expected??{},review_required:input.review_required===true,existing_artifact:existing??null};
  const binding=sha256(JSON.stringify(identity)),key='materialize:'+sha256(JSON.stringify([episode_id,stage_id,action_key,provider_job_id,result_id]));
  let row=await receipts.get(key);
  if(row&&row.binding!==binding)throw Error('MATERIALIZATION_IDENTITY_IMMUTABLE');
  const path=existing?.path??target.prefix+'/'+sha256(key)+'/original.'+(stage_id==='IMAGE'?'image':formats[stage_id][0]);
  if(!row){
    await receipts.claim(key,{state:'RESULT_IDENTIFIED',binding,identity,path});row=await receipts.get(key);
    if(row.binding!==binding)throw Error('MATERIALIZATION_IDENTITY_IMMUTABLE');
  }
  const save=async patch=>{row=await receipts.transition(key,row.state,patch);};
  if(row.state==='RESULT_IDENTIFIED'){
    await inject('PROVIDER_COMPLETED_ARTIFACT_NOT_PERSISTED');
    let stored;
    // A missing object is the only condition permitting recovery/download. Storage
    // outages must not be confused with absence. Adapters return null for not found.
    stored=await storage.download(target.bucket,path);
    if(stored==null){
      if(existing)throw Error('EXISTING_CANONICAL_ARTIFACT_MISSING');
      if(!recoverOriginal)throw Error('SAME_RESULT_RECOVERY_REQUIRED');
      const original=await recoverOriginal({provider_job_id,result_id,stage_id});
      if(original?.provider_job_id!==provider_job_id||original.result_id!==result_id)throw Error('PROVIDER_RESULT_IDENTITY_MISMATCH');
      const bytes=Buffer.from(original.bytes??[]);
      if(!bytes.length||bytes.length>256*1024*1024)throw Error('ARTIFACT_SIZE_INVALID');
      await inject('DOWNLOADED_BEFORE_SHA');
      if(input.expected_sha256&&sha256(bytes)!==input.expected_sha256)throw Error('ARTIFACT_HASH_MISMATCH');
      await inject('SHA_CALCULATED_BEFORE_PERSISTENCE');
      const mime=stage_id==='IMAGE'?imageMime(bytes):formats[stage_id][1];if(!mime)throw Error('IMAGE_FORMAT_INVALID');
      try{await storage.upload(target.bucket,path,bytes,{contentType:mime,upsert:false});}
      catch(error){const prior=await storage.download(target.bucket,path);if(!prior||sha256(prior)!==sha256(bytes))throw error;}
      stored=await storage.download(target.bucket,path);
      if(!stored||sha256(stored)!==sha256(bytes))throw Error('ARTIFACT_READBACK_MISMATCH');
    }
    // The immutable object is discoverable by result identity across a crash, even
    // before its digest was committed. No transient URL enters durable state.
    await inject('ARTIFACT_DOWNLOADED_HASH_NOT_PERSISTED');
    const bytes=Buffer.from(stored),digest=sha256(bytes);
    if(!bytes.length||input.expected_sha256&&digest!==input.expected_sha256||existing&&bytes.length!==existing.size)throw Error('ARTIFACT_HASH_MISMATCH');
    await save({state:'PERSISTED',artifact:{artifact_id:existing?.artifact_id??sha256(key+':original'),episode_id,stage_id,
      provider_job_id,result_id,sha256:digest,bucket:target.bucket,path,storage_path:path,size:bytes.length,
      mime:stage_id==='IMAGE'?imageMime(bytes):formats[stage_id][1],format:stage_id==='IMAGE'?(imageMime(bytes)==='image/png'?'png':'jpg'):formats[stage_id][0],role:'ORIGINAL',review_derivative:false,
      persistence:{readback:true,sha_verified:true}}});
  }
  if(row.state==='PERSISTED'){
    await inject('ARTIFACT_PERSISTED_QA_NOT_PERSISTED');
    const bytes=Buffer.from(await storage.download(row.artifact.bucket,row.artifact.path));
    if(sha256(bytes)!==row.artifact.sha256||bytes.length!==row.artifact.size)throw Error('ARTIFACT_HASH_MISMATCH');
    const qa=await inspect(bytes,stage_id,row.artifact.sha256,input.expected??{});
    await save({state:'QA_COMPLETE',qa,artifact:{...row.artifact,width:qa.width,height:qa.height,duration:qa.duration,
      sample_rate:qa.sample_rate,channels:qa.channels,qa_status:qa.status}});
  }
  if(row.state==='QA_COMPLETE'){
    await inject('QA_PERSISTED_CHECKPOINT_NOT_ADVANCED');
    const result={episode_id,stage_id,status:!row.qa.ok?'HUMAN_REVIEW_REQUIRED':row.qa.status==='WARNING'?'SUCCEEDED_WITH_WARNING':'SUCCEEDED',
      artifacts:[row.artifact],qa:row.qa,provider_job_ids:[provider_job_id],claims:[key],
      estimated_cost:input.estimated_cost??null,actual_cost:input.actual_cost??null,
      human_review_requirement:input.review_required===true||!row.qa.ok||row.qa.status==='WARNING',
      next_action:row.qa.ok?'CONTINUE':'LOCAL_REPAIR',error_classification:row.qa.error_class??null};
    await save({state:'COMPLETE',result});
  }
  // Verify canonical bytes on replay, including after QA/checkpoint crash.
  const bytes=await storage.download(row.artifact.bucket,row.artifact.path);
  if(!bytes||bytes.length!==row.artifact.size||sha256(bytes)!==row.artifact.sha256)throw Error('ARTIFACT_HASH_MISMATCH');
  return {...row.result,provider_calls:0};
}
const imageMimeFromName=mime=>['image/png','image/jpeg'].includes(mime)?mime:null;
