import {executeStage} from './lumi-v2-executor-bindings.js';
import {prepareLumiTtsInput} from './lumi-tts-stage-v2.js';
import {createElevenLabsDirectClient} from './lumi-elevenlabs-direct-v3.js';
import {LUMI_VOICE_PROFILE_V3 as voice} from './lumi-production-profile-v2.js';
import {sha256} from './telegram-review-v1/core.js';

const probe=Buffer.from('LUMI ISOLATED TTS STORAGE V1: NON-MEDIA BYTES; NO AUDIO');
const deny=()=>{throw Error('DIAGNOSTIC_CAPABILITY_FORBIDDEN');};
const copy=value=>structuredClone(value);

// Server-owned input only: no narration, destination, voice or budget overrides.
export function isolatedTtsInput(episodeId,operationId){
  return {episode_id:episodeId,stage_id:'TTS',narration_unit_id:'isolated_preflight',
    text:'Hola, soy Lumi.',voice_profile_id:voice.version,dry_run:true,require_preflight:true,
    output_artifact_target:{bucket:'lumi-diagnostic-inline',prefix:operationId+'/tts-preflight'},
    budget_context:{quota_reserve_characters:voice.quota_reserve_characters}};
}

function failure(error){
  if(error.message==='ELEVENLABS_SECRET_REQUIRED')return 'DIAGNOSTIC_TTS_TRANSPORT_UNAVAILABLE';
  if(error.http_status===401||error.http_status===403)return 'DIAGNOSTIC_TTS_AUTH_FAILED';
  if(['ELEVENLABS_MODEL_INCOMPATIBLE','ELEVENLABS_ACCOUNT_VOICE_INCOMPATIBLE','ELEVENLABS_SUBSCRIPTION_VOICE_UNAVAILABLE',
    'ELEVENLABS_REQUEST_MODEL_LIMIT'].includes(error.message))return 'DIAGNOSTIC_TTS_VOICE_MODEL_FAILED';
  if(['ELEVENLABS_QUOTA_UNAVAILABLE','ELEVENLABS_QUOTA_BUDGET_INVALID','ELEVENLABS_MODEL_BILLING_REVALIDATION_REQUIRED'].includes(error.message))return 'DIAGNOSTIC_TTS_QUOTA_FAILED';
  if(error.message==='TTS_STORAGE_GATE_NOT_PASS')return 'DIAGNOSTIC_TTS_STORAGE_FAILED';
  return 'DIAGNOSTIC_TTS_PREFLIGHT_FAILED';
}

// Adapters to the existing real TTS executor, storage gate and CAS diagnostic
// namespace. No Telegram receipt store, production storage or new executor.
export async function runIsolatedTtsPreflight({command:c,ns,env,fetchImpl,clock}){
  const input=(await ns.read()).request,prepared=prepareLumiTtsInput(input);
  const key='tts-dry:'+prepared.claim_id,objectPath=input.output_artifact_target.prefix+'/storage-probe.bin';
  const evidence={operation_id:c.operation_id,request_id:c.nonce,profile_version:voice.profile_version,
    voice_profile_id:voice.version,voice_id:voice.voice_id,model_id:voice.model_id,provider:voice.provider,
    auth_result:'NOT_RUN',voice_callable_result:'NOT_RUN',model_result:'NOT_RUN',quota_result:'NOT_RUN',
    budget_result:'NOT_RUN',storage_result:'NOT_RUN',dry_boundary_result:'NOT_RUN',
    storage_scope:'DIAGNOSTIC_STORAGE_ROUNDTRIP_ONLY',audio_decode:'NOT_RUN',
    request_fingerprint:prepared.binding.request_fingerprint,provider_generation_calls:0,
    publication_calls:0,telegram_mutation_calls:0};
  const finish=(status,error_code=null)=>({...evidence,status,error_code,timestamp:new Date(clock()).toISOString()});
  try{
    const allowed=new Set(['/v1/models','/v1/user/subscription','/v1/voices/'+voice.voice_id]);
    const direct=createElevenLabsDirectClient({env,fetchImpl:async(url,options)=>{
      const u=new URL(url);
      if(options.method!=='GET'||u.origin!=='https://api.elevenlabs.io'||u.search||!allowed.has(u.pathname))deny();
      await ns.read();const response=await fetchImpl(url,options);await ns.read();return response;
    }});
    // The executor only receives preflight. submit/poll/add/recovery are absent;
    // the transport additionally rejects every non-GET request before I/O.
    const client={preflight:async request=>{
      const quote=await direct.preflight(request);
      evidence.auth_result=quote.ELEVENLABS_AUTH==='PASS'?'PASS':'FAIL';
      evidence.voice_callable_result=quote.FERNANDA_CALLABLE==='PASS'?'PASS':'FAIL';
      evidence.model_result=quote.MODEL_VALIDATION==='PASS'?'PASS':'FAIL';
      evidence.quota_result=quote.QUOTA_OBSERVABILITY==='PASS'?'PASS':'FAIL';
      evidence.remaining_characters=quote.quota.REMAINING_CHARACTERS;
      evidence.estimated_quota_units=quote.units;
      return quote;
    }};
    const receiptKey=id=>{if(id!==key)deny();};
    const receipts={
      get:async id=>{receiptKey(id);return copy((await ns.read()).journal[id]||null);},
      claim:async(id,row)=>{receiptKey(id);
        if(row.binding_sha!==prepared.binding_sha||row.state!=='DRY_PREPARED')deny();
        return ns.write(v=>{if(v.journal[id])return null;v.journal[id]=copy(row);return copy(row);});
      },
      transition:async(id,expected,patch)=>{receiptKey(id);
        if(expected!=='DRY_PREPARED'||patch.state!=='DRY_PROVIDER_BOUNDARY'||patch.request_constructed!==true
          ||patch.provider_calls!==0||Object.keys(patch).length!==3)deny();
        return ns.write(v=>{const row=v.journal[id];
          if(row?.state!==expected||row.binding_sha!==prepared.binding_sha)throw Error('DIAGNOSTIC_CAS_CONFLICT');
          Object.assign(row,copy(patch));return copy(row);
        });
      }
    };
    const target=(bucket,path)=>{
      const prefix=input.output_artifact_target.prefix+'/storage-probe-';
      if(bucket!=='lumi-diagnostic-inline'||!path.startsWith(prefix)||!/^[a-f0-9-]{36}\.bin$/.test(path.slice(prefix.length)))deny();
    };
    const storage={
      upload:async(bucket,path,bytes,options)=>{target(bucket,path);
        if(options.contentType!=='application/octet-stream'||options.upsert!==false||!probe.equals(bytes))deny();
        await ns.write(v=>{const encoded=probe.toString('base64');
          if(v.objects[objectPath]&&v.objects[objectPath]!==encoded)throw Error('DIAGNOSTIC_ARTIFACT_INTEGRITY_FAILURE');
          v.objects[objectPath]=encoded;
        });
      },
      download:async(bucket,path)=>{target(bucket,path);const encoded=(await ns.read()).objects[objectPath];
        if(!encoded)throw Error('DIAGNOSTIC_ARTIFACT_MISSING');return Buffer.from(encoded,'base64');
      },
      // Retain the immutable non-media probe for recovery; never delete evidence.
      remove:async(bucket,path)=>{target(bucket,path);await ns.read();}
    };
    const result=await executeStage({episode_id:c.episode_id,stage_id:'TTS',dry_run:true,input:{
      prepared:{episode_id:c.episode_id,narration_request:{text:input.text,voice_profile_id:input.voice_profile_id}},
      action:{key:'tts-preflight'},material:{narration_unit_id:input.narration_unit_id,require_tts_preflight:true,
        output_artifact_target:input.output_artifact_target,budget_context:input.budget_context,
        tts_runtime:{client,storage,receipts,probeBytes:probe,diagnosticStorageProbe:true,fetchImpl:deny,inspectAudio:deny}}
    }});
    evidence.storage_result=result.storage_gate.status;
    evidence.storage_sha256=result.storage_gate.sha256;
    evidence.storage_evidence_reference=`diagnostic:${c.operation_id}:object:${objectPath}`;
    evidence.budget_result=result.TTS_BUDGET_PREFLIGHT;
    if(result.TTS_BUDGET_PREFLIGHT!=='PASS')return finish('BLOCKED','DIAGNOSTIC_TTS_BUDGET_FAILED');
    if(result.status!=='DRY_PROVIDER_BOUNDARY'||result.emission_journal?.state!=='DRY_PROVIDER_BOUNDARY'
      ||result.TTS_PROVIDER_JOBS_CREATED!==0||result.storage_gate.sha256!==sha256(probe)
      ||['auth_result','voice_callable_result','model_result','quota_result','storage_result'].some(k=>evidence[k]!=='PASS'))
      return finish('BLOCKED','DIAGNOSTIC_TTS_PREFLIGHT_FAILED');
    evidence.dry_boundary_result='PASS';evidence.receipt_key=key;
    return finish('DRY_PROVIDER_BOUNDARY');
  }catch(error){return finish('BLOCKED',failure(error));}
}
