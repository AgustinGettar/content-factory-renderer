// Read-only official API discovery. No synthesis, voice-add or cloning method.
import {LUMI_VOICE_PROFILE_V3} from './lumi-production-profile-v2.js';
const API='https://api.elevenlabs.io';
export const VOICE_PREVIEW_CANDIDATES=Object.freeze([
 {letter:'A',voice_id:'akOBlaKhFd59YlK6xz9u',owner_id:'22b2f4a2162ef64612a568dc1e9d621b4e050b73261e732b3c895102551ff7fc',name:'Lucia — Warm Conversational'},
 {letter:'B',voice_id:'NyQ87MpRGbszyh7rZLXM',owner_id:'909042158451df29bd1cad6a1a599e0fe5d3dedb5969181ff78406db3dcfcd5a',name:'Fernanda — Warm & Natural'}
].map(Object.freeze));
const own=(value,key)=>value?.[key]??null;
const language=value=>typeof value==='string'?value.toLowerCase().split(/[-_]/)[0]:null;
export function elevenLabsReadiness(env=process.env){
 return {provider:'ElevenLabs Direct API',credential_present:!!env.ELEVENLABS_API_KEY,
 ELEVENLABS_AUTH:'UNVERIFIED',VOICE_PROFILE_V3:LUMI_VOICE_PROFILE_V3.status,
 REAL_EXECUTOR_BINDINGS:LUMI_VOICE_PROFILE_V3.frozen?'14/14':'13/14',provider_generation_calls:0};
}
export function createElevenLabsDiscoveryClient({env=process.env,fetchImpl=fetch}={}){
 if(env.LUMI_RUNTIME_ENV!=='staging')throw Error('ELEVENLABS_DISCOVERY_STAGING_ONLY');
 const key=env.ELEVENLABS_API_KEY;if(!key)throw Error('ELEVENLABS_STAGING_SECRET_REQUIRED');
 const redact=value=>{
  if(typeof value==='string')return value.split(key).join('[REDACTED]');
  if(Array.isArray(value))return value.map(redact);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,redact(v)]));
  return value;
 };
 async function get(path,params={}){
  if(!['/v1/models','/v2/voices','/v1/shared-voices','/v1/user/subscription'].includes(path))throw Error('ELEVENLABS_READ_ENDPOINT_FORBIDDEN');
  const url=new URL(path,API);for(const [name,value]of Object.entries(params))url.searchParams.set(name,String(value));
  let response;
  try{response=await fetchImpl(url.toString(),{method:'GET',headers:{'xi-api-key':key},redirect:'error',signal:AbortSignal.timeout(30000)});}
  catch{throw Error('ELEVENLABS_READ_TRANSPORT_FAILURE');}
  if(!response.ok){
   // Only allowlisted classifications escape, never arbitrary provider text.
   const error=Object.assign(Error('ELEVENLABS_READ_HTTP_'+response.status),{http_status:response.status});
   try{
    const body=await response.json(),status=body?.detail?.status;
    if(['missing_permissions','invalid_api_key','quota_exceeded','rate_limit_exceeded','voice_not_found','not_found'].includes(status))error.provider_code=status;
    if(status==='missing_permissions'){
     const message=String(body?.detail?.message||'');
     error.required_permission=['user_read','voices_read','models_read'].find(p=>new RegExp('\\b'+p+'\\b').test(message))??null;
    }
   }catch{}
   throw error;
  }
  try{return redact(await response.json());}catch{throw Error('ELEVENLABS_READ_INVALID_JSON');}
 }
 return Object.freeze({models:()=>get('/v1/models'),subscription:()=>get('/v1/user/subscription'),
  exactVoice:async voiceId=>{
   const c=VOICE_PREVIEW_CANDIDATES.find(c=>c.voice_id===voiceId);if(!c)throw Error('ELEVENLABS_EXACT_VOICE_FORBIDDEN');
   const r=await get('/v1/shared-voices',{owner_id:c.owner_id,language:'es',page_size:100,page:0});
   const v=r.voices?.find(v=>v.voice_id===c.voice_id&&v.public_owner_id===c.owner_id);
   if(!v)throw Error('ELEVENLABS_EXACT_VOICE_NOT_FOUND');
   const m=sharedVoiceMetadata(v);
   if(!m.VERIFIED_SPANISH||m.PREVIEW_LANGUAGE!=='es'||!m.PREVIEW||!m.MODEL_COMPATIBILITY?.includes('eleven_multilingual_v2')||m.GENDER?.toLowerCase()!=='female')throw Error('ELEVENLABS_EXACT_VOICE_METADATA_BLOCKED');
   return {...m,letter:c.letter,display_name:c.name,VOICE_IDENTITY:'PASS'};
  },
  // Retained for callers inspecting saved voices, never used for Library search.
  voices:({next_page_token,high_quality=true}={})=>get('/v2/voices',{language:'es',gender:'female',page_size:100,include_total_count:false,...(high_quality?{high_quality:true}:{}),...(next_page_token?{next_page_token}:{})}),
  sharedVoices:({page=0,minimal=false,category='professional'}={})=>{
   if(!Number.isInteger(page)||page<0||!['professional','high_quality'].includes(category))throw Error('ELEVENLABS_LIBRARY_QUERY_INVALID');
   return get('/v1/shared-voices',{language:'es',page_size:100,page,...(!minimal?{gender:'female',category}:{})});
  }});
}
function modelMetadata(m){
 return {MODEL_ID:own(m,'model_id'),NAME:own(m,'name'),DESCRIPTION:own(m,'description'),
 SPANISH_SUPPORTED:Array.isArray(m.languages)?m.languages.some(l=>l.language_id==='es'):null,
 TTS_SUPPORTED:own(m,'can_do_text_to_speech'),REQUIRES_ALPHA_ACCESS:own(m,'requires_alpha_access'),
 MAX_TEXT:own(m,'maximum_text_length_per_request'),MODEL_RATES:own(m,'model_rates'),
 TOKEN_COST_FACTOR:own(m,'token_cost_factor'),SERVES_PRO_VOICES:own(m,'serves_pro_voices')};
}
export function sharedVoiceMetadata(v){
 const verified=Array.isArray(v.verified_languages)?v.verified_languages.map(l=>({language:own(l,'language'),accent:own(l,'accent'),locale:own(l,'locale'),model_id:own(l,'model_id'),preview_url:own(l,'preview_url')})):null;
 const spanish=verified?.find(l=>language(l.language)==='es'&&l.model_id==='eleven_multilingual_v2'&&l.preview_url)||verified?.find(l=>language(l.language)==='es'&&l.preview_url);
 const models=Array.isArray(v.high_quality_base_model_ids)?v.high_quality_base_model_ids:verified?[...new Set(verified.map(l=>l.model_id).filter(Boolean))]:null;
 return {VOICE_ID:own(v,'voice_id'),PUBLIC_OWNER_ID:own(v,'public_owner_id'),NAME:own(v,'name'),
 LANGUAGE:own(v,'language')??own(v.labels,'language'),VERIFIED_SPANISH:verified?verified.some(l=>language(l.language)==='es'):null,
 ACCENT:own(v,'accent')??own(v.labels,'accent'),GENDER:own(v,'gender')??own(v.labels,'gender'),
 AGE:own(v,'age')??own(v.labels,'age'),CATEGORY:own(v,'category'),DESCRIPTION:own(v,'description'),
 USE_CASE:own(v,'use_case')??own(v.labels,'use_case'),DESCRIPTIVE:own(v,'descriptive'),
 RATE:own(v,'rate'),MODEL_COMPATIBILITY:models,VERIFIED_LANGUAGES:verified,
 PREVIEW:spanish?.preview_url||own(v,'preview_url'),DEFAULT_PREVIEW:own(v,'preview_url'),
 PREVIEW_LANGUAGE:spanish?'es':null,SPANISH_PREVIEW_INSUFFICIENT:!spanish,
 FREE_USERS_ALLOWED:own(v,'free_users_allowed'),LIVE_MODERATION_ENABLED:own(v,'live_moderation_enabled')};
}
export function subscriptionMetadata(s){
 const count=own(s,'character_count'),limit=own(s,'character_limit');
 const observed=Number.isFinite(count)&&Number.isFinite(limit)&&count>=0&&limit>=0;
 return {SUBSCRIPTION_TIER:own(s,'tier'),SUBSCRIPTION_STATUS:own(s,'status'),
 CHARACTER_COUNT:count,CHARACTER_LIMIT:limit,REMAINING_CHARACTERS:observed?limit-count:null,
 MAX_CREDIT_LIMIT_EXTENSION:own(s,'max_credit_limit_extension'),CAN_EXTEND:own(s,'can_extend_character_limit'),
 CURRENT_OVERAGE:s.current_overage?{amount:own(s.current_overage,'amount'),currency:own(s.current_overage,'currency')}:null,
 QUOTA_OBSERVED:observed?'PASS':'INCOMPLETE_METADATA',unit:'PROVIDER_CHARACTER_QUOTA',usd:null,
 api_key_remaining_quota:null,limitation:'Subscription quota does not prove restricted API key remaining quota.'};
}
const errorMetadata=e=>({http_status:e.http_status??null,classification:e.provider_code??e.message,
 required_permission:e.required_permission??null});
export async function discoverElevenLabsVoicePreviews({env=process.env,fetchImpl=fetch}={}){
 const client=createElevenLabsDiscoveryClient({env,fetchImpl});
 const base={provider_generation_calls:0,model_candidate:'eleven_multilingual_v2',VOICE_PROFILE_V3:'VOICE_SELECTION_PENDING'};
 let quota;
 try{quota=subscriptionMetadata(await client.subscription());}
 catch(e){return {...base,status:'QUOTA_OBSERVABILITY_BLOCKER',quota_error:errorMetadata(e),ELEVENLABS_AUTH:'BLOCKED'};}
 if(quota.QUOTA_OBSERVED!=='PASS'||quota.SUBSCRIPTION_STATUS!=='active')return {...base,status:'QUOTA_OBSERVABILITY_BLOCKER',ELEVENLABS_AUTH:'PASS',quota};
 try{
  const candidates=[];for(const c of VOICE_PREVIEW_CANDIDATES)candidates.push(await client.exactVoice(c.voice_id));
  return {...base,status:'PREVIEWS_IDENTIFIED',ELEVENLABS_AUTH:'PASS',QUOTA_OBSERVABILITY:'PASS',quota,candidates,provider_read_operations:3};
 }catch(e){return {...base,status:'PREVIEW_DELIVERY_BLOCKER',ELEVENLABS_AUTH:'PASS',QUOTA_OBSERVABILITY:'PASS',quota,preview_error:errorMetadata(e)};}
}
export async function discoverElevenLabsSpanishVoices({env=process.env,fetchImpl=fetch,maxPages=3}={}){
 if(!Number.isInteger(maxPages)||maxPages<1||maxPages>5)throw Error('ELEVENLABS_DISCOVERY_PAGE_LIMIT_INVALID');
 const client=createElevenLabsDiscoveryClient({env,fetchImpl});
 let readCalls=0,quota=null,quotaError=null;
 try{readCalls++;quota=subscriptionMetadata(await client.subscription());}catch(e){quotaError=errorMetadata(e);}
 readCalls++;const rawModels=await client.models();if(!Array.isArray(rawModels))throw Error('ELEVENLABS_MODEL_CATALOG_INVALID');
 const models=rawModels.map(modelMetadata);
 let voices=[],libraryError=null,minimal=false,hasMore=false,totalCount=null,nextPage=null;
 const queries=[];
 try{
  for(let page=0;page<maxPages;page++){
   readCalls++;const result=await client.sharedVoices({page,minimal});
   if(!Array.isArray(result.voices))throw Error('ELEVENLABS_VOICE_CATALOG_INVALID');
   queries.push({language:'es',...(!minimal?{gender:'female',category:'professional'}:{}),page_size:100,page,returned:result.voices.length,total_count:own(result,'total_count')});
   voices.push(...result.voices.map(sharedVoiceMetadata));hasMore=result.has_more===true;totalCount=own(result,'total_count');nextPage=hasMore?page+1:null;
   if(page===0&&!result.voices.length&&!hasMore){
    minimal=true;readCalls++;const fallback=await client.sharedVoices({page:0,minimal:true});
    if(!Array.isArray(fallback.voices))throw Error('ELEVENLABS_VOICE_CATALOG_INVALID');
    queries.push({language:'es',page_size:100,page:0,returned:fallback.voices.length,total_count:own(fallback,'total_count')});
    voices.push(...fallback.voices.map(sharedVoiceMetadata));hasMore=fallback.has_more===true;totalCount=own(fallback,'total_count');nextPage=hasMore?1:null;
   }
   if(!hasMore)break;
  }
 }catch(e){libraryError=errorMetadata(e);}
 const spanishVoices=[...new Map(voices.filter(v=>v.VOICE_ID&&(language(v.LANGUAGE)==='es'||v.VERIFIED_SPANISH)).map(v=>[v.VOICE_ID,v])).values()];
 const eligible=spanishVoices.filter(v=>v.GENDER?.toLowerCase()==='female'&&v.PREVIEW);
 return {status:quotaError?'QUOTA_OBSERVABILITY_BLOCKER':libraryError?'VOICE_LIBRARY_BLOCKER':'VOICE_SELECTION_PENDING',
 ELEVENLABS_AUTH:'PASS',provider:'ElevenLabs Direct API',models,
 production_spanish_tts_models:models.filter(m=>m.SPANISH_SUPPORTED&&m.TTS_SUPPORTED&&m.REQUIRES_ALPHA_ACCESS!==true),
 quota,quota_status:quotaError?'BLOCKED':quota?.QUOTA_OBSERVED,quota_error:quotaError,
 VOICE_LIBRARY_QUERY:libraryError?'BLOCKED':'PASS',library_error:libraryError,
 library_endpoint:'/v1/shared-voices',library_queries:queries,SPANISH_LIBRARY_RESULTS:totalCount,
 SPANISH_VOICES_FOUND:spanishVoices.length,voices:eligible,catalog_complete:!hasMore,
 next_page:nextPage,minimal_filters_fallback:minimal,model_selection:'CANDIDATE_NOT_FROZEN',
 human_voice_selection:null,VOICE_A:null,VOICE_B:null,provider_read_operations:readCalls,
 provider_generation_calls:0,REAL_EXECUTOR_BINDINGS:'13/14',
 next_action:quotaError?'RESOLVE_QUOTA_READ_PERMISSION_OR_TRANSPORT':libraryError?'RESOLVE_VOICE_LIBRARY_READ':'RANK_METADATA_AND_INSPECT_AT_MOST_TWO_EXISTING_PREVIEWS'};
}
