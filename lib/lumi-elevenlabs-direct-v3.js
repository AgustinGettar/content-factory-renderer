import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {subscriptionMetadata,createElevenLabsDiscoveryClient} from './lumi-elevenlabs-discovery-v3.js';

export const FERNANDA_SOURCE_ID='NyQ87MpRGbszyh7rZLXM';
export const FERNANDA_OWNER_ID='909042158451df29bd1cad6a1a599e0fe5d3dedb5969181ff78406db3dcfcd5a';
export const FERNANDA_HUMAN_APPROVAL=Object.freeze(JSON.parse(readFileSync(new URL('../qa/LUMI_FERNANDA_HUMAN_APPROVAL_V3.json',import.meta.url))));
const sha=value=>createHash('sha256').update(value).digest('hex');
const id=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(value);
export function elevenLabsError(error){return {http_status:error.http_status??null,classification:error.code||(/^(ELEVENLABS|FERNANDA)_[A-Z_]+$/.test(error.message)?error.message:'ELEVENLABS_OPERATION_FAILED'),required_permission:error.required_permission??null};}

// Direct native HTTPS only. Credentials stay in this closure and are never part
// of the operational result, receipt, provider error or request fingerprint.
export function createElevenLabsDirectClient({env=process.env,fetchImpl=fetch}={}){
 const credential=env.ELEVENLABS_API_KEY;if(!credential)throw Error('ELEVENLABS_SECRET_REQUIRED');
 const originals=new Map();
 async function request(method,path,body,{binary=false}={}){
  let response;
  try{response=await fetchImpl('https://api.elevenlabs.io'+path,{method,redirect:'error',
   headers:{'xi-api-key':credential,...(body?{'content-type':'application/json'}:{})},
   ...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(120000)});}
  catch{throw Object.assign(Error('ELEVENLABS_TRANSPORT_OUTCOME_UNPROVEN'),{code:'ELEVENLABS_TRANSPORT_OUTCOME_UNPROVEN'});}
  if(!response.ok){
   const e=Object.assign(Error('ELEVENLABS_HTTP_'+response.status),{code:'ELEVENLABS_HTTP_'+response.status,http_status:response.status,
    no_job_accepted:response.status>=400&&response.status<500,evidence:{definitive_rejection:response.status>=400&&response.status<500}});
   try{const data=await response.json();if(['missing_permissions','invalid_api_key','voice_not_found','quota_exceeded','rate_limit_exceeded'].includes(data?.detail?.status))e.code=data.detail.status;
    if(e.code==='missing_permissions')e.required_permission=['user_read','voices_read','voices_write','models_read','history_read','text_to_speech'].find(p=>new RegExp('\\b'+p+'\\b').test(String(data.detail.message)))??null;
   }catch{}throw e;
  }
  return binary?response:response.json();
 }
 const subscription=async()=>subscriptionMetadata(await request('GET','/v1/user/subscription'));
 const models=()=>request('GET','/v1/models');
 const voice=async voiceId=>{if(!id(voiceId))throw Error('ELEVENLABS_VOICE_ID_INVALID');const v=await request('GET','/v1/voices/'+voiceId);
  return {voice_id:v.voice_id,name:v.name,category:v.category,labels:v.labels??{},fine_tuning:{state:v.fine_tuning?.state??{}},
   high_quality_base_model_ids:v.high_quality_base_model_ids??null,available_for_tiers:v.available_for_tiers??null,
   sharing:v.sharing?{public_owner_id:v.sharing.public_owner_id,original_voice_id:v.sharing.original_voice_id,status:v.sharing.status}:null};};
 const accountVoices=async()=>{const rows=[];let next=null;for(let p=0;p<10;p++){
  const data=await request('GET','/v2/voices?page_size=100'+(next?'&next_page_token='+encodeURIComponent(next):''));
  for(const v of data.voices??[])rows.push({voice_id:v.voice_id,name:v.name,sharing:v.sharing?{public_owner_id:v.sharing.public_owner_id,original_voice_id:v.sharing.original_voice_id}:null});
  if(!data.has_more)return rows;next=data.next_page_token;if(!next)throw Error('ELEVENLABS_VOICE_PAGINATION_INCOMPLETE');
 }throw Error('ELEVENLABS_VOICE_PAGINATION_LIMIT');};
 async function validation(voiceId){
  const [catalog,v,q]=await Promise.all([models(),voice(voiceId),subscription()]);
  const m=catalog.find(m=>m.model_id==='eleven_multilingual_v2');
  if(!m?.can_do_text_to_speech||!m.languages?.some(l=>l.language_id==='es')||m.requires_alpha_access===true)throw Error('ELEVENLABS_MODEL_INCOMPATIBLE');
  if(v.voice_id!==voiceId||v.category!=='professional'||v.fine_tuning.state[m.model_id]!=='fine_tuned')throw Error('ELEVENLABS_ACCOUNT_VOICE_INCOMPATIBLE');
  if(q.QUOTA_OBSERVED!=='PASS'||String(q.SUBSCRIPTION_STATUS).toLowerCase()!=='active')throw Error('ELEVENLABS_QUOTA_UNAVAILABLE');
  if(v.available_for_tiers?.length&&!v.available_for_tiers.includes(q.SUBSCRIPTION_TIER))throw Error('ELEVENLABS_SUBSCRIPTION_VOICE_UNAVAILABLE');
  return {ELEVENLABS_AUTH:'PASS',MODEL_VALIDATION:'PASS',QUOTA_OBSERVABILITY:'PASS',FERNANDA_CALLABLE:'PASS',voice:v,quota:q,
   model:{model_id:m.model_id,name:m.name,TTS_SUPPORTED:true,SPANISH_SUPPORTED:true,maximum_text_length_per_request:m.maximum_text_length_per_request,
    token_cost_factor:m.token_cost_factor??null,model_rates:m.model_rates??null}};
 }
 return Object.freeze({provider:'ElevenLabs',transport:'Direct API',models,voice,accountVoices,subscription,validation,
  addSelectedVoice:async()=>{const data=await request('POST',`/v1/voices/add/${FERNANDA_OWNER_ID}/${FERNANDA_SOURCE_ID}`,{new_name:'Fernanda — Warm & Natural'});
   if(!id(data.voice_id))throw Error('ELEVENLABS_ADDED_VOICE_ID_UNPROVEN');return {voice_id:data.voice_id};},
  preflight:async r=>{const result=await validation(r.voice_id);const count=[...r.text].length;
   if(r.model_id!=='eleven_multilingual_v2'||count>result.model.maximum_text_length_per_request)throw Error('ELEVENLABS_REQUEST_MODEL_LIMIT');
   const factor=result.model.model_rates?.character_cost_multiplier??result.model.token_cost_factor??1,voiceFactor=r.voice_credit_multiplier??1;
   if(!Number.isFinite(factor)||factor<=0||!Number.isFinite(voiceFactor)||voiceFactor<=0)throw Error('ELEVENLABS_MODEL_BILLING_REVALIDATION_REQUIRED');
   return {...result,authenticated:true,currency:'ELEVENLABS_CHARACTER_QUOTA',units:Math.ceil(count*factor*voiceFactor),character_count:count,
    model_multiplier:factor,voice_multiplier:voiceFactor,provenance:'Authenticated ElevenLabs model billing multiplier, selected Library voice rate and subscription quota; multilingual v2 default one credit per character',usd:null};},
  submit:async(r,{onAcknowledged=async()=>{}}={})=>{
   if(!id(r.voice_id)||r.model_id!=='eleven_multilingual_v2'||typeof r.text!=='string')throw Error('ELEVENLABS_TTS_REQUEST_INVALID');
   const response=await request('POST',`/v1/text-to-speech/${r.voice_id}?output_format=mp3_44100_128`,{text:r.text,model_id:r.model_id},{binary:true});
   const requestId=response.headers.get('request-id');if(!id(requestId))throw Error('ELEVENLABS_RESPONSE_ID_UNPROVEN');
   const characterCost=response.headers.get('character-cost');const metadata={job_id:requestId,request_id:requestId,
    trace_id:response.headers.get('x-trace-id')??null,character_cost:characterCost!==null&&/^\d+$/.test(characterCost)?Number(characterCost):null};
   await onAcknowledged(metadata);originals.set(requestId,Buffer.from(await response.arrayBuffer()));return metadata;
  },
  poll:async requestId=>{if(!id(requestId))throw Error('ELEVENLABS_REQUEST_ID_INVALID');return {job_id:requestId,status:'completed',artifact_url:'https://api.elevenlabs.io/v1/history',actual_cost:null};},
  recoverOriginal:async(requestId,{voice_id,model_id}={})=>{
   if(originals.has(requestId))return Buffer.from(originals.get(requestId));
   if(!id(requestId)||!id(voice_id)||model_id!=='eleven_multilingual_v2')throw Error('ELEVENLABS_RECOVERY_IDENTITY_REQUIRED');
   let cursor=null;for(let p=0;p<10;p++){
    const data=await request('GET',`/v1/history?page_size=1000&voice_id=${voice_id}&source=TTS&model_id=${model_id}`+(cursor?'&start_after_history_item_id='+encodeURIComponent(cursor):''));
    const item=data.history?.find(h=>h.request_id===requestId&&h.voice_id===voice_id&&h.model_id===model_id);
    if(item){if(!id(item.history_item_id))throw Error('ELEVENLABS_HISTORY_ID_INVALID');const response=await request('GET','/v1/history/'+item.history_item_id+'/audio',undefined,{binary:true});return Buffer.from(await response.arrayBuffer());}
    if(!data.has_more)break;cursor=data.last_history_item_id||data.history?.at(-1)?.history_item_id;if(!id(cursor))break;
   }throw Error('ELEVENLABS_ORIGINAL_NOT_YET_PROVEN');
  }
 });
}

// Account mutation uses the existing CAS journal. An uncertain add is reconciled
// by collection reads, never repeated. Only the explicitly approved shared ID.
export async function bindApprovedFernanda({client,discovery,receipts,store,user,env=process.env}){
 if(env.LUMI_RUNTIME_ENV!=='staging')throw Error('FERNANDA_BINDING_STAGING_ONLY');
 const approval=FERNANDA_HUMAN_APPROVAL;
 if(approval.source_voice_id!==FERNANDA_SOURCE_ID||approval.HUMAN_APPROVED!==true||approval.provider!=='ElevenLabs')throw Error('FERNANDA_EXPLICIT_APPROVAL_REQUIRED');
 const review=await store.get(user);review.state.voice_v3_human_approval=approval;await store.cas(user,review.revision,review.state);
 const source=await discovery.exactVoice(FERNANDA_SOURCE_ID);
 if(source.PUBLIC_OWNER_ID!==FERNANDA_OWNER_ID||source.MODEL_COMPATIBILITY?.includes('eleven_multilingual_v2')!==true)throw Error('FERNANDA_SOURCE_IDENTITY_MISMATCH');
 const key='voice-add:'+sha(FERNANDA_OWNER_ID+':'+FERNANDA_SOURCE_ID),saved=await receipts.get(key);
 const collection=await client.accountVoices();let active=collection.find(v=>v.voice_id===FERNANDA_SOURCE_ID||v.sharing?.original_voice_id===FERNANDA_SOURCE_ID&&v.sharing.public_owner_id===FERNANDA_OWNER_ID)?.voice_id;
 if(!active&&saved?.active_voice_id)active=saved.active_voice_id;
 if(!active){
  if(saved)throw Error('FERNANDA_ADD_OUTCOME_UNPROVEN');
  if(!await receipts.claim(key,{state:'PREPARED',source_voice_id:FERNANDA_SOURCE_ID,public_owner_id:FERNANDA_OWNER_ID,human_approval_sha:sha(JSON.stringify(approval)),attempt_id:key}))throw Error('FERNANDA_ADD_CLAIM_CONFLICT');
  await receipts.transition(key,'PREPARED',{state:'EMITTING'});
  try{const added=await client.addSelectedVoice();active=added.voice_id;await receipts.transition(key,'EMITTING',{state:'ADDED',active_voice_id:active});}
  catch(error){await receipts.transition(key,'EMITTING',{state:'ADD_AMBIGUOUS',error:elevenLabsError(error)});throw error;}
 }
 const validation=await client.validation(active);
 const row=await store.get(user);row.state.voice_v3_account_binding={source_voice_id:FERNANDA_SOURCE_ID,active_voice_id:active,public_owner_id:FERNANDA_OWNER_ID,verified_spanish:true,
  model_id:'eleven_multilingual_v2',human_approval_sha:sha(JSON.stringify(approval)),validation,validated_at:new Date().toISOString()};await store.cas(user,row.revision,row.state);
 return {...validation,status:'PASS',SOURCE_SHARED_VOICE_ID:FERNANDA_SOURCE_ID,ACTIVE_TTS_VOICE_ID:active,source_rate:source.RATE,
  source_verified_spanish:source.VERIFIED_SPANISH,source_accent:source.ACCENT,HUMAN_APPROVED:true,provider_generation_calls:0};
}
