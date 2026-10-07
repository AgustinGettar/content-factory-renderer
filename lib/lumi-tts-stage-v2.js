import {createHash} from 'node:crypto';
import {mkdtemp, writeFile, readFile, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {LUMI_VOICE_PROFILE_V2 as voice} from './lumi-production-profile-v2.js';
import {verifyArtifact, verifyTtsStorageGate, assertTtsStorageGate} from './lumi-recovery-incident-manager-v1.js';
import {materializeStageArtifact} from './lumi-artifact-materialization-v2.js';

const exec = promisify(execFile);
const hash = value => createHash('sha256').update(value).digest('hex');
const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value);
const terminal = new Set(['SUCCEEDED', 'SUCCEEDED_WITH_WARNING', 'HUMAN_REVIEW_REQUIRED', 'FAILED_PROVIDER_TERMINAL', 'EMISSION_AMBIGUOUS', 'CANCELED']);
export const TTS_STATES = Object.freeze(['PREPARED','CLAIMED','EMITTING','ACKNOWLEDGED','ARTIFACT_RECOVERED','PERSISTED','QA_COMPLETE','SUCCEEDED']);

// Consumes the persisted profile. No voice discovery, engine fallback or tuning.
export function prepareLumiTtsInput(input) {
  if (!safeId(input.episode_id) || input.stage_id !== 'TTS' || !safeId(input.narration_unit_id)
    || input.voice_profile_id !== voice.version || typeof input.text !== 'string' || !input.text.trim()
    || [...input.text].length > 5000) throw Error('TTS_INPUT_INVALID');
  if (!voice.HUMAN_APPROVED || voice.human_approval?.status !== 'APPROVED'
    || voice.variant !== 'elevenlabs' || voice.model !== 'text2speech_v2' || !voice.voice_id
    || !/^[a-f0-9]{64}$/.test(voice.benchmark_artifact_sha)) throw Error('FROZEN_APPROVED_VOICE_REQUIRED');
  const target = input.output_artifact_target;
  if (!safeId(target?.bucket) || !target.prefix || target.prefix.startsWith('/') || target.prefix.includes('..')
    || !target.prefix.split('/').every(safeId)) throw Error('TTS_STORAGE_TARGET_INVALID');
  // The successful historical connector request used prompt (not API `text`).
  // Sample rate/format describe observed output; the approved engine exposes no tuning fields.
  const request = {model:voice.model, variant:voice.variant, voice_id:voice.voice_id,
    voice_type:voice.voice_type, prompt:input.text, count:1};
  const profile_sha = hash(JSON.stringify(voice));
  const request_fingerprint = hash(JSON.stringify(request));
  const claim_id = hash(JSON.stringify([input.episode_id,input.stage_id,input.narration_unit_id]));
  const binding = {episode_id:input.episode_id,stage_id:'TTS',narration_unit_id:input.narration_unit_id,
    text_hash:hash(input.text),voice_profile_id:voice.version,voice_profile_sha:profile_sha,
    voice_id:voice.voice_id,variant:voice.variant,request_fingerprint,
    output_artifact_target:target,attempt_id:claim_id};
  return {request, binding, claim_id, binding_sha:hash(JSON.stringify(binding))};
}

// Real ffmpeg decode and PCM measurements, never pronunciation certification.
export async function inspectLumiAudio(bytes, expectedSha256, {storageProbe=false}={}) {
  const dir=await mkdtemp(join(tmpdir(),'lumi-audio-qa-'));
  try {
    const file=join(dir,'audio.mp3');await writeFile(file,bytes);
    const technical=await verifyArtifact({type:'AUDIO',filePath:file,expectedSha256});
    if(!technical.ok)return {...technical,status:'FAIL'};
    const metadata=JSON.parse((await exec('ffprobe',['-v','error','-show_streams','-show_format','-of','json',file])).stdout);
    const stream=metadata.streams.find(s=>s.codec_type==='audio');
    if(![1,2].includes(stream.channels)||![22050,24000,44100,48000].includes(Number(stream.sample_rate)))return {...technical,status:'FAIL',ok:false,error_class:'INVALID_ARTIFACT'};
    const pcm=join(dir,'audio.f32');
    await exec('ffmpeg',['-v','error','-i',file,'-map','0:a:0','-f','f32le','-acodec','pcm_f32le',pcm]);
    const samples=await readFile(pcm);let peak=0,clipped=0,power=0;
    for(let i=0;i<samples.length;i+=4){const v=samples.readFloatLE(i);if(!Number.isFinite(v))throw Error('NON_FINITE_AUDIO');peak=Math.max(peak,Math.abs(v));power+=v*v;if(Math.abs(v)>=.999)clipped++;}
    const count=samples.length/4, ratio=count?clipped/count:1;
    const warnings=[];
    if(ratio>.001)warnings.push('CLIPPING_ABOVE_0_1_PERCENT');
    if(Number(stream.sample_rate)!==voice.native_sample_rate||stream.channels!==voice.channels)warnings.push('NATIVE_AUDIO_PROFILE_MISMATCH');
    const ok=count>0&&(storageProbe||power>0)&&stream.codec_name==='mp3';
    return {...technical,ok,status:!ok?'FAIL':warnings.length?'WARNING':'PASS',channels:stream.channels,
      format:'mp3',codec:stream.codec_name,peak,clipped_samples:clipped,clipped_ratio:ratio,
      clipping_threshold:.001,rms:count?Math.sqrt(power/count):0,warnings,
      pronunciation:'NOT_AUTOMATICALLY_CERTIFIED',...(ok?{}:{error_class:'INVALID_ARTIFACT'})};
  } catch {return {ok:false,status:'FAIL',error_class:'AUDIO_DECODE_FAILURE'};}
  finally {await rm(dir,{recursive:true,force:true});}
}

// Deterministic local silence is only a storage/decode probe, never narration.
export async function createTtsStorageProbe() {
  const dir=await mkdtemp(join(tmpdir(),'lumi-storage-probe-'));
  try {const path=join(dir,'probe.mp3');await exec('ffmpeg',['-v','error','-f','lavfi','-i','anullsrc=r=44100:cl=mono','-t','0.1','-map_metadata','-1','-codec:a','libmp3lame','-b:a','64k',path]);return await readFile(path);}
  finally {await rm(dir,{recursive:true,force:true});}
}

export function ttsStageResult(row, status=row.state, extra={}) {
  return {status,stage_id:'TTS',episode_id:row.episode_id,artifacts:row.artifact?[row.artifact]:[],
    provider_job_ids:row.job_id?[row.job_id]:[],claims:[row.attempt_id],estimated_cost:row.estimated_cost??null,
    actual_cost:row.actual_cost??null,qa:row.qa??null,human_review_requirement:status==='SUCCEEDED_WITH_WARNING',
    next_action:status==='SUCCEEDED'?'CONTINUE':status==='FAILED_RETRYABLE_LOCAL'?'RECOVER_SAME_JOB':'PAUSE',
    error_classification:row.error_classification??null,...extra};
}

export function ttsBudgetDecision(budget,quote,fingerprint){
  if(quote?.request_fingerprint!==fingerprint||!quote.provenance)throw Error('BOUND_TTS_QUOTE_REQUIRED');
  const currency=quote.currency;
  if(!['USD','CREDITS'].includes(currency))throw Error('TTS_BUDGET_UNIT_UNSUPPORTED');
  if(currency==='CREDITS'&&budget.currency!=='CREDITS')throw Error('TTS_CREDIT_BUDGET_REQUIRED');
  const estimate=currency==='USD'?quote.usd:quote.units,
    ceiling=currency==='USD'?budget.ceiling_usd:budget.ceiling_units,
    spent=currency==='USD'?(budget.spent_usd??0):(budget.spent_units??0),
    reserve=currency==='USD'?(budget.remaining_reserve_usd??0):(budget.remaining_reserve_units??0);
  if(![estimate,ceiling,spent,reserve].every(v=>Number.isFinite(v)&&v>=0))throw Error('TTS_BUDGET_INVALID');
  return {status:spent+estimate+reserve<=ceiling?'PASS':'BUDGET_EXHAUSTED',currency,estimate,ceiling,spent,reserve};
}

// Strict readiness path: the real non-generative quote runs through the executor's
// configured transport. Offline request-only dry fixtures do not prove this gate.
export async function preflightLumiTts(input,{client,storage,probeBytes,inspectAudio=inspectLumiAudio,binding_error}={}){
  const prepared=prepareLumiTtsInput(input);
  if(!client?.preflight)throw Error(binding_error||'HIGGSFIELD_AUTH_TRANSPORT_UNBOUND');
  const quote={...await client.preflight(prepared.request),request_fingerprint:prepared.binding.request_fingerprint};
  if(quote.authenticated!==true)throw Error('HIGGSFIELD_AUTH_TRANSPORT_UNVERIFIED');
  const bytes=probeBytes??await createTtsStorageProbe();
  const storage_gate=await verifyTtsStorageGate({storage,bucket:input.output_artifact_target.bucket,prefix:input.output_artifact_target.prefix,
    probeBytes:bytes,decodeAudio:async b=>(await inspectAudio(b,hash(b),{storageProbe:true})).ok});
  assertTtsStorageGate(storage_gate);
  const budget=ttsBudgetDecision(input.budget_context??{},quote,prepared.binding.request_fingerprint);
  return {...prepared,quote,storage_gate,budget,HIGGSFIELD_AUTH_TRANSPORT:'PASS',TTS_COST_PREFLIGHT:'PASS',
    TTS_BUDGET_PREFLIGHT:budget.status,ESTIMATED_PROVIDER_CREDITS:quote.currency==='CREDITS'?quote.units:null,
    status:budget.status==='PASS'?'DRY_PROVIDER_BOUNDARY':'BUDGET_EXHAUSTED',TTS_PROVIDER_JOBS_CREATED:0};
}

// Uses the existing CAS receipt store (get/claim/transition), not a second ledger.
// client is a deployable transport binding with submit(request) / poll(job_id).
// Neither method is called by dry_run. No HTTP endpoint is inferred from a model ID.
export async function executeLumiTtsStage(input, {receipts,client,storage,binding_error,fetchImpl=fetch,
  probeBytes,inspectAudio=inspectLumiAudio,inject=async()=>{}}={}) {
  const prepared=prepareLumiTtsInput(input),{binding,claim_id,binding_sha,request}=prepared;
  if(input.dry_run&&input.require_preflight)return preflightLumiTts(input,{client,storage,probeBytes,inspectAudio,binding_error});
  if(input.dry_run)return {...ttsStageResult({...binding,state:'PREPARED'},'DRY_PROVIDER_BOUNDARY'),request,binding_sha,dry_run:true,provider_calls:0};
  if(!receipts?.transition||!storage)throw Error('TTS_DURABLE_RUNTIME_REQUIRED');
  const key='tts:'+claim_id;
  let row=await receipts.get(key),calls=0;
  if(row&&row.binding_sha!==binding_sha)throw Error('TTS_CLAIM_INPUT_IMMUTABLE');
  if(row&&terminal.has(row.state))return {...row.result,provider_calls:0};
  const save=async(patch)=>{row=await receipts.transition(key,row.state,{...patch,history:[...(row.history||[]),patch.state??row.state]});};
  const finish=async(status,error_classification=null)=>{
    const result=ttsStageResult({...row,state:status,error_classification},status,{provider_calls:calls});
    await save({state:status,error_classification,result});return result;
  };
  if(row&&['EMITTING','EMISSION_AMBIGUOUS'].includes(row.state)&&!row.job_id)return finish('EMISSION_AMBIGUOUS','EMISSION_AMBIGUOUS');
  if(!row){
    if(!client?.submit||!client?.poll)throw Error('HIGGSFIELD_TTS_DEPLOYABLE_TRANSPORT_REQUIRED');
    if(input.budget_context?.authorized!==true)throw Error('TTS_EXECUTION_AUTHORIZATION_REQUIRED');
    const budget=input.budget_context,quote=budget.quote;
    if(ttsBudgetDecision(budget,quote,binding.request_fingerprint).status!=='PASS')return ttsStageResult({...binding,estimated_cost:quote},'BUDGET_EXHAUSTED',{provider_calls:0});
    const bytes=probeBytes??await createTtsStorageProbe();
    const storage_gate=await verifyTtsStorageGate({storage,...{bucket:input.output_artifact_target.bucket,prefix:input.output_artifact_target.prefix},
      probeBytes:bytes,decodeAudio:async b=>(await inspectAudio(b,hash(b),{storageProbe:true})).ok});
    assertTtsStorageGate(storage_gate);
    row={...binding,binding_sha,state:'PREPARED',history:['PREPARED'],storage_gate,estimated_cost:quote,job_id:null};
    if(!await receipts.claim(key,row))return {status:'IN_PROGRESS',stage_id:'TTS',provider_calls:0,next_action:'RECONCILE'};
    await save({state:'CLAIMED'});
  }
  if(['PREPARED','CLAIMED'].includes(row.state)){
    // Safe to submit only after a successful atomic CLAIMED -> EMITTING transition.
    if(row.state==='PREPARED')await save({state:'CLAIMED'});
    await save({state:'EMITTING'});await inject('EMITTING');
    let accepted;
    try {calls++;accepted=await client.submit(request,{attempt_id:claim_id});}
    catch(error){
      // Only explicit transport evidence of non-acceptance permits terminal rejection.
      if(error.no_job_accepted===true&&error.evidence?.definitive_rejection===true)return finish('FAILED_PROVIDER_TERMINAL',error.code||'PROVIDER_REJECTED');
      return finish('EMISSION_AMBIGUOUS','EMISSION_AMBIGUOUS');
    }
    if(!accepted?.job_id)return finish('EMISSION_AMBIGUOUS','ACCEPTED_JOB_ID_UNPROVEN');
    try {await save({state:'ACKNOWLEDGED',job_id:accepted.job_id,acceptance:accepted});}
    catch(error){
      // A concurrent reconciler may have paused the still-active emission. The
      // original submitter can still persist its proven job; it never re-submits.
      const current=await receipts.get(key);
      if(current?.binding_sha!==binding_sha||current.state!=='EMISSION_AMBIGUOUS'||current.job_id)throw error;
      row=await receipts.transition(key,'EMISSION_AMBIGUOUS',{state:'ACKNOWLEDGED',job_id:accepted.job_id,acceptance:accepted,result:null,
        error_classification:null,history:[...current.history,'ACKNOWLEDGED']});
    }
    await inject('ACKNOWLEDGED');
  }
  try {
    if(row.state==='ACKNOWLEDGED'){
      const remote=await client.poll(row.job_id);
      if(remote.job_id!==row.job_id)throw Error('TTS_JOB_ID_MISMATCH');
      if(remote.status==='canceled')return finish('CANCELED','PROVIDER_CANCELED');
      if(['failed','nsfw'].includes(remote.status))return finish('FAILED_PROVIDER_TERMINAL','PROVIDER_JOB_FAILED');
      if(remote.status!=='completed')return ttsStageResult(row,'IN_PROGRESS',{provider_calls:calls,next_action:'POLL_SAME_JOB'});
      if(!remote.artifact_url?.startsWith('https://'))throw Error('TTS_ARTIFACT_URL_REQUIRED');
      await save({state:'ARTIFACT_RECOVERED',actual_cost:remote.actual_cost??null});
    }
    if(row.state==='ARTIFACT_RECOVERED'){
      const material=await materializeStageArtifact({episode_id:input.episode_id,stage_id:'TTS',action_key:input.narration_unit_id,
        provider_job_id:row.job_id,result_id:'original',target:input.output_artifact_target,estimated_cost:row.estimated_cost,actual_cost:row.actual_cost},
        {receipts,storage,inspect:async(bytes,stage,sha)=>inspectAudio(bytes,sha),recoverOriginal:async ids=>{
          const remote=await client.poll(row.job_id);
          if(remote.job_id!==row.job_id||remote.status!=='completed'||!remote.artifact_url?.startsWith('https://'))throw Error('TTS_RESULT_RECOVERY_UNVERIFIED');
          const response=await fetchImpl(remote.artifact_url);if(!response.ok)throw Error('TTS_ARTIFACT_DOWNLOAD_FAILED');
          return {...ids,bytes:Buffer.from(await response.arrayBuffer())};
        }});
      const artifact={...material.artifacts[0],narration_unit_id:input.narration_unit_id,
        provider:voice.provider,model:voice.model,variant:voice.variant,voice_id:voice.voice_id,voice_profile_version:voice.profile_version,
        voice_profile_id:voice.version,voice_profile_sha:binding.voice_profile_sha,estimated_cost:row.estimated_cost,actual_cost:row.actual_cost};
      await save({state:'PERSISTED',artifact});await inject('PERSISTED');
    }
    if(row.state==='PERSISTED'){
      const bytes=Buffer.from(await storage.download(row.artifact.bucket,row.artifact.path));
      if(hash(bytes)!==row.artifact.sha256)throw Error('ARTIFACT_HASH_MISMATCH');
      const qa=await inspectAudio(bytes,row.artifact.sha256);
      await save({state:'QA_COMPLETE',qa,artifact:{...row.artifact,sample_rate:qa.sample_rate,channels:qa.channels,duration:qa.duration,qa_status:qa.status}});
    }
    if(row.state==='QA_COMPLETE')return finish(row.qa.ok?(row.qa.status==='WARNING'?'SUCCEEDED_WITH_WARNING':'SUCCEEDED'):'HUMAN_REVIEW_REQUIRED',row.qa.ok?null:row.qa.error_class);
  } catch(error){return ttsStageResult(row,'FAILED_RETRYABLE_LOCAL',{provider_calls:calls,error_classification:error.message,next_action:'RECOVER_SAME_JOB'});}
  return ttsStageResult(row,'HUMAN_REVIEW_REQUIRED',{provider_calls:calls});
}
