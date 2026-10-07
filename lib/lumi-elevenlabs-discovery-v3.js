// Official REST endpoints, using the project's native fetch convention.
// Discovery has no synthesis method. No caller can choose a provider URL.
const API = 'https://api.elevenlabs.io';
const own = (value, key) => value?.[key] ?? null;

export function elevenLabsReadiness(env = process.env) {
  return {provider:'ElevenLabs Direct API', credential_present:!!env.ELEVENLABS_API_KEY,
    ELEVENLABS_AUTH:'UNVERIFIED', VOICE_PROFILE_V3:'VOICE_SELECTION_PENDING',
    REAL_EXECUTOR_BINDINGS:'13/14', provider_generation_calls:0};
}

export function createElevenLabsDiscoveryClient({env = process.env, fetchImpl = fetch} = {}) {
  // Key stays in this closure and request header; never returned or logged.
  const key = env.ELEVENLABS_API_KEY;
  if (env.LUMI_RUNTIME_ENV !== 'staging') throw Error('ELEVENLABS_DISCOVERY_STAGING_ONLY');
  if (!key) throw Error('ELEVENLABS_STAGING_SECRET_REQUIRED');
  const redact = value => {
    if(typeof value === 'string') return value.split(key).join('[REDACTED]');
    if(Array.isArray(value)) return value.map(redact);
    if(value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,redact(v)]));
    return value;
  };
  async function get(path, params = {}) {
    if (!['/v1/models','/v2/voices','/v1/user/subscription'].includes(path)) throw Error('ELEVENLABS_READ_ENDPOINT_FORBIDDEN');
    const url = new URL(path, API);
    for(const [name,value] of Object.entries(params)) url.searchParams.set(name,String(value));
    let response;
    try {
      response = await fetchImpl(url.toString(), {method:'GET',headers:{'xi-api-key':key},
        redirect:'error',signal:AbortSignal.timeout(30000)});
    } catch {throw Error('ELEVENLABS_READ_TRANSPORT_FAILURE');}
    if(!response.ok) throw Error(`ELEVENLABS_READ_HTTP_${response.status}`);
    try {return redact(await response.json());} catch {throw Error('ELEVENLABS_READ_INVALID_JSON');}
  }
  return Object.freeze({models:()=>get('/v1/models'),
    voices:({next_page_token,high_quality=true}={})=>get('/v2/voices',{
      language:'es',gender:'female',page_size:100,include_total_count:false,
      ...(high_quality?{high_quality:true}:{}),...(next_page_token?{next_page_token}:{})}),
    subscription:()=>get('/v1/user/subscription')});
}

function modelMetadata(m) {
  return {MODEL_ID:own(m,'model_id'),NAME:own(m,'name'),DESCRIPTION:own(m,'description'),
    SPANISH_SUPPORTED:Array.isArray(m.languages)?m.languages.some(l=>l.language_id==='es'):null,
    TTS_SUPPORTED:own(m,'can_do_text_to_speech'),REQUIRES_ALPHA_ACCESS:own(m,'requires_alpha_access'),
    MAX_TEXT:own(m,'maximum_text_length_per_request'),MODEL_RATES:own(m,'model_rates'),
    TOKEN_COST_FACTOR:own(m,'token_cost_factor'),SERVES_PRO_VOICES:own(m,'serves_pro_voices')};
}
function voiceMetadata(v) {
  return {VOICE_ID:own(v,'voice_id'),NAME:own(v,'name'),LANGUAGE:own(v.labels,'language'),
    ACCENT:own(v.labels,'accent'),GENDER:own(v.labels,'gender'),AGE:own(v.labels,'age'),
    DESCRIPTION:own(v,'description'),USE_CASE:own(v.labels,'use_case'),PREVIEW:own(v,'preview_url'),
    SAMPLES:Array.isArray(v.samples)?v.samples.map(s=>({sample_id:own(s,'sample_id'),file_name:own(s,'file_name'),
      mime_type:own(s,'mime_type'),size_bytes:own(s,'size_bytes')})):null,
    CATEGORY:own(v,'category'),IS_OWNER:own(v,'is_owner'),RECORDING_QUALITY:own(v,'recording_quality'),
    MODEL_COMPATIBILITY:own(v,'high_quality_base_model_ids'),
    VERIFIED_LANGUAGES:Array.isArray(v.verified_languages)?v.verified_languages.map(l=>({language:own(l,'language'),
      accent:own(l,'accent'),model_id:own(l,'model_id'),preview_url:own(l,'preview_url')})):null};
}

export async function discoverElevenLabsSpanishVoices({env = process.env,fetchImpl = fetch,maxPages = 3} = {}) {
  if(!Number.isInteger(maxPages)||maxPages<1||maxPages>5) throw Error('ELEVENLABS_DISCOVERY_PAGE_LIMIT_INVALID');
  const client=createElevenLabsDiscoveryClient({env,fetchImpl});
  const rawModels=await client.models();
  if(!Array.isArray(rawModels)) throw Error('ELEVENLABS_MODEL_CATALOG_INVALID');
  const models=rawModels.map(modelMetadata);
  let readCalls=1,voices=[],next=null,hasMore=false,qualityFilter=true;
  // A bounded catalog read is evidence, never human voice approval.
  for(let page=0;page<maxPages;page++) {
    const result=await client.voices({next_page_token:next,high_quality:qualityFilter});readCalls++;
    if(!Array.isArray(result.voices)) throw Error('ELEVENLABS_VOICE_CATALOG_INVALID');
    voices.push(...result.voices.map(voiceMetadata));
    hasMore=result.has_more===true;next=result.next_page_token??null;
    if(page===0&&!voices.length&&!hasMore&&page+1<maxPages) {qualityFilter=false;continue;}
    if(!hasMore) break;
    if(!next) throw Error('ELEVENLABS_VOICE_PAGINATION_INVALID');
  }
  // Catalog filtering may also return default voices: validate the labels here.
  voices=voices.filter(v=>v.LANGUAGE==='es'&&v.GENDER==='female');
  voices=[...new Map(voices.filter(v=>v.VOICE_ID).map(v=>[v.VOICE_ID,v])).values()];
  let quota=null,quotaStatus='UNVERIFIED';
  try {
    const subscription=await client.subscription();readCalls++;
    quota={character_count:own(subscription,'character_count'),character_limit:own(subscription,'character_limit'),
      tier:own(subscription,'tier'),next_character_count_reset_unix:own(subscription,'next_character_count_reset_unix'),
      unit:'PROVIDER_CHARACTER_QUOTA',usd:null,api_key_remaining_quota:null,
      limitation:'Subscription quota does not prove the remaining quota of a restricted API key.'};
    quotaStatus='READ_ONLY_METADATA';
  } catch {readCalls++;quotaStatus='READ_PERMISSION_OR_TRANSPORT_UNAVAILABLE';}
  return {status:'VOICE_SELECTION_PENDING',ELEVENLABS_AUTH:'PASS',provider:'ElevenLabs Direct API',
    models,production_spanish_tts_models:models.filter(m=>m.SPANISH_SUPPORTED&&m.TTS_SUPPORTED&&m.REQUIRES_ALPHA_ACCESS!==true),
    voices,catalog_complete:!hasMore,next_page_token:next,high_quality_filter:qualityFilter,
    quota,quota_status:quotaStatus,model_selection:'PENDING_AUTHENTICATED_CATALOG_REVIEW',
    human_voice_selection:null,VOICE_A:null,VOICE_B:null,provider_read_operations:readCalls,
    provider_generation_calls:0,REAL_EXECUTOR_BINDINGS:'13/14',
    next_action:'INSPECT_EXISTING_SPANISH_PREVIEWS_AND_SHORTLIST_AT_MOST_TWO_VOICES'};
}
