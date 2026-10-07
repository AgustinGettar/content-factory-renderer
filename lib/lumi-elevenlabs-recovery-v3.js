import {createElevenLabsDirectClient} from './lumi-elevenlabs-direct-v3.js';
import {executeLumiTtsStage} from './lumi-tts-stage-v2.js';
import {MemoryStageReceiptStore} from './lumi-v2-execution-orchestrator.js';
import {LUMI_VOICE_PROFILE_V3 as voice} from './lumi-production-profile-v2.js';

// Deterministic HTTP simulations exercise the actual Direct API transport and
// existing durable executor/materializer. No request leaves this process.
export async function runElevenLabsTtsRecoveryMatrix(){
 const scenarios=[['CRASH_BEFORE_REQUEST','CLAIMED'],['ACKNOWLEDGED_ARTIFACT_NOT_PERSISTED','ACKNOWLEDGED'],
  ['AUDIO_DOWNLOADED_STORAGE_NOT_COMPLETED','MATERIALIZATION:SHA_CALCULATED_BEFORE_PERSISTENCE'],
  ['ARTIFACT_PERSISTED_QA_NOT_COMPLETED','MATERIALIZATION:ARTIFACT_PERSISTED_QA_NOT_PERSISTED'],
  ['QA_COMPLETED_CHECKPOINT_NOT_ADVANCED','QA_COMPLETE'],['AMBIGUOUS_NETWORK_OUTCOME','NETWORK']],rows=[];
 for(const [scenario,point]of scenarios){
  let emissions=0,fault=true;const originals=Buffer.from('EXPLICIT_SIMULATION_AUDIO_NOT_PLAYABLE'),objects=new Map(),receipts=new MemoryStageReceiptStore();
  const fetchImpl=async(url,options)=>{
   const path=new URL(url).pathname;
   if(options.method==='POST'){emissions++;if(point==='NETWORK')throw Error('SIMULATED_TRANSPORT_LOSS');return new Response(originals,{headers:{'request-id':'recovery_request','character-cost':'19','x-trace-id':'recovery_trace'}});}
   if(path==='/v1/models')return Response.json([{model_id:voice.model_id,can_do_text_to_speech:true,languages:[{language_id:'es'}],maximum_text_length_per_request:10000,token_cost_factor:1}]);
   if(path==='/v1/user/subscription')return Response.json({tier:'starter',status:'active',character_count:69,character_limit:40000});
   if(path.startsWith('/v1/voices/'))return Response.json({voice_id:voice.voice_id,category:'professional',fine_tuning:{state:{[voice.model_id]:'fine_tuned'}}});
   if(path==='/v1/history')return Response.json({history:[{request_id:'recovery_request',history_item_id:'history_original',voice_id:voice.voice_id,model_id:voice.model_id}],has_more:false});
   if(path==='/v1/history/history_original/audio')return new Response(originals);
   throw Error('SIMULATION_ENDPOINT_NOT_ALLOWED');
  };
  const makeClient=()=>createElevenLabsDirectClient({env:{ELEVENLABS_API_KEY:'SYNTHETIC_OFFLINE_ONLY'},fetchImpl});
  const deps={receipts,client:makeClient(),probeBytes:originals,storage:{upload:async(b,p,v)=>{objects.set(p,Buffer.from(v));},download:async(b,p)=>objects.get(p),remove:async(b,p)=>objects.delete(p)},
   inspectAudio:async()=>({ok:true,status:'PASS',sample_rate:44100,channels:1,duration:1,scope:'DETERMINISTIC_RECOVERY_SIMULATION'}),
   inject:async p=>{if(p===point&&fault){fault=false;throw Error('INJECTED_CRASH');}}};
  const input={episode_id:'generic_tts_recovery',stage_id:'TTS',narration_unit_id:scenario,text:'Escuchemos con Lumi.',voice_profile_id:voice.version,
   budget_context:{authorized:true,quota_reserve_characters:1000},output_artifact_target:{bucket:'generated-audio',prefix:'dry-recovery'}};
  await executeLumiTtsStage(input,deps).catch(()=>{});
  deps.client=makeClient();deps.inject=async()=>{};
  const recovered=await executeLumiTtsStage(input,deps),replayed=await executeLumiTtsStage(input,deps);
  const expected=point==='NETWORK'?'EMISSION_AMBIGUOUS':'SUCCEEDED';
  rows.push({scenario,expected,status:recovered.status,simulated_emissions:emissions,duplicate_tts_calls:Math.max(0,emissions-1),
   replay_provider_calls:replayed.provider_calls,pass:recovered.status===expected&&emissions===1&&replayed.provider_calls===0});
 }
 return {status:rows.every(r=>r.pass)?'PASS':'FAIL',rows,DUPLICATE_TTS_CALLS:rows.reduce((n,r)=>n+r.duplicate_tts_calls,0),provider_generation_calls:0,
  scope:'DETERMINISTIC_OFFLINE_SIMULATIONS_OF_REAL_EXECUTOR_NOT_PROVIDER_GENERATION'};
}
