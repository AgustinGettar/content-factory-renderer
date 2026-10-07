import {sha256,validateArtifact} from './telegram-review-v1/core.js';
import {createElevenLabsDiscoveryClient,discoverElevenLabsVoicePreviews} from './lumi-elevenlabs-discovery-v3.js';

// Existing provider previews only; no synthesis, voice-add or profile changes.
export async function recoverSpanishPreview(candidate,{client,fetchImpl=fetch}={}){
 let current=candidate;
 for(let attempt=0;attempt<2;attempt++){
  try{
   const url=new URL(current.PREVIEW);
   if(url.protocol!=='https:'||url.hostname!=='storage.googleapis.com'||!url.pathname.startsWith('/eleven-public-prod/')||!url.pathname.includes('/voices/'+candidate.VOICE_ID+'/')||!url.pathname.endsWith('.mp3'))throw Error('PREVIEW_REFERENCE_INVALID');
   const r=await fetchImpl(url.toString(),{method:'GET',redirect:'error',signal:AbortSignal.timeout(30000)});
   if(!r.ok)throw Error('PREVIEW_HTTP_'+r.status);
   if(Number(r.headers.get('content-length'))>16*1024*1024)throw Error('PREVIEW_TOO_LARGE');
   const bytes=Buffer.from(await r.arrayBuffer());
   if(!bytes.length||bytes.length>16*1024*1024)throw Error('PREVIEW_SIZE_INVALID');
   return {bytes,reference:current.PREVIEW,refreshed:attempt===1};
  }catch{
   if(attempt===1)throw Error('PREVIEW_BLOCKED_'+candidate.letter);
   current=await client.exactVoice(candidate.VOICE_ID);
  }
 }
}
export async function prepareElevenLabsPreviewReview({env,db,store,user,chat,fetchImpl=fetch,runtime}={}){
 const discovery=await discoverElevenLabsVoicePreviews({env,fetchImpl});
 if(discovery.status!=='PREVIEWS_IDENTIFIED')return discovery;
 try{
  const initial=await store.get(user),s=initial.state;
  if(s.message_id!==138||String(s.chat_id)!==String(chat))throw Error('PREVIEW_PANEL_IDENTITY_INVALID');
  const episode_id=s.voice_preview_review?.episode_id||Object.values(s.episodes).find(e=>e.master&&e.episode_id==='ep_lumi_flores_003')?.episode_id||Object.values(s.episodes).filter(e=>e.master).at(-1)?.episode_id;
  if(!episode_id)throw Error('PREVIEW_EXISTING_REVIEW_CONTEXT_REQUIRED');
  if(!runtime){
   const {materializeStageArtifact,createArtifactStorage}=await import('./lumi-artifact-materialization-v2.js');
   const {ReviewStageReceiptStore}=await import('./lumi-v2-execution-orchestrator.js');
   runtime={materialize:materializeStageArtifact,storage:createArtifactStorage(db),receipts:new ReviewStageReceiptStore({store,user})};
  }
  const client=createElevenLabsDiscoveryClient({env,fetchImpl}),candidates=[];
  for(const c of discovery.candidates){
   const provider_job_id='existing-preview-'+c.VOICE_ID,result_id='es-'+sha256(c.PREVIEW);
   let recovered=null;
   const result=await runtime.materialize({episode_id,stage_id:'TTS',action_key:'voice-v3-preview:'+c.letter,provider_job_id,result_id,
     target:{bucket:'generated-audio',prefix:'lumi-voice-v3-previews'},review_required:true,actual_cost:{provider_generation_calls:0,source:'FREE_EXISTING_PREVIEW'}},
    {...runtime,recoverOriginal:async()=>{recovered=await recoverSpanishPreview(c,{client,fetchImpl});return {bytes:recovered.bytes,provider_job_id,result_id};}});
   const artifact=result.artifacts?.[0];validateArtifact(artifact);
   if(!result.qa?.ok||!(artifact.duration>0)||result.qa.decode!=='PASS'||result.qa.clipped_ratio>0.001)throw Error('PREVIEW_TECHNICAL_QA_BLOCKED_'+c.letter);
   candidates.push({...c,PREVIEW:recovered?.reference||c.PREVIEW,PREVIEW_HTTP:'PASS',PREVIEW_DECODE:'PASS',artifact,stage_result:result,
     review_request_id:sha256('voice-preview-v3:'+c.letter+':'+artifact.sha256)});
  }
  const row=await store.get(user),state=row.state;
  if(['EMITTING','UNKNOWN'].includes(state.delivery?.status))throw Error('PREVIEW_PANEL_RECONCILIATION_REQUIRED');
  const e=state.episodes[episode_id];e.artifacts||={};e.review_requests||={};
  for(const c of candidates){
   e.artifacts[c.artifact.artifact_id]=c.artifact;
   e.review_requests[c.review_request_id]={review_request_id:c.review_request_id,episode_id,stage_id:'TTS',artifact_id:c.artifact.artifact_id,
     artifact_sha:c.artifact.sha256,review_version:1,status:'TRANSPORT_ONLY',transport_only:true,allowed_actions:[],preview_voice:{letter:c.letter,name:c.display_name,voice_id:c.VOICE_ID,accent:c.ACCENT,category:c.CATEGORY}};
  }
  state.voice_preview_review={...state.voice_preview_review,status:'HUMAN_REVIEW_PENDING',episode_id,quota:discovery.quota,candidates,profile_status:'VOICE_SELECTION_PENDING',provider_generation_calls:0};
  await store.cas(user,row.revision,state);
  return {...discovery,status:'HUMAN_REVIEW_PENDING',episode_id,candidates,message_id:138,provider_generation_calls:0};
 }catch(e){return {...discovery,status:'PREVIEW_DELIVERY_BLOCKER',preview_error:{classification:/^(PREVIEW_|ARTIFACT_|MATERIALIZATION_)/.test(e.message)?e.message:'PREVIEW_PREPARATION_FAILED'},provider_generation_calls:0};}
}
