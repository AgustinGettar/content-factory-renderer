import {quoteFourthEpisodeUsd,EPISODE_ID,HARD_BUDGET_USD} from './lumi-fourth-episode-usd-preflight.js';
import {LUMI_PRODUCTION_PROFILE_V2 as profile} from './lumi-production-profile-v2.js';
import {readFileSync} from 'node:fs';
import {sha256} from './telegram-review-v1/core.js';
import {estimateHiggsfieldUsd} from './higgsfield-usd-budget-v1.js';
import {inputDigest} from './lumi-v2-activation-context.js';

// The existing q41 proposal is the only creative source. No caller input is
// merged into it. URLs exist only inside the leased server call, never in CAS.
export function isolatedQ41Input(){
  const d=JSON.parse(readFileSync(new URL('../docs/LUMI_EP004_FIRST_SOURCE_PROPOSAL.json',import.meta.url)));
  const image=JSON.parse(readFileSync(new URL('../qa/LUMI_IMAGE_QUALITY_PROFILE_V2.json',import.meta.url)));
  const p=d.provider_parameters_without_transport,a=d.canonical_reference;
  const canonical='5dc31254ad26aa1b606735188ac30d2f4d486bc389f19bc8a50816e1e1b3da33';
  const promptSha='5375de4f309192b1e963bef8623330e34ae8e4385c832d85d7b68e2b0a414360';
  if(d.episode_id!==EPISODE_ID||d.shot_id!=='q41'||d.creative_approval!=='APPROVED_FOR_QUOTE_ONLY'
    ||d.quote_approval?.scope!=='EP004_Q41_IMAGE_QUOTE_ONLY'||d.quote_approval.prompt_sha256!==promptSha
    ||typeof p?.prompt!=='string'||p.prompt.length>5000||sha256(p.prompt)!==promptSha)
    throw Error('Q41_APPROVED_DESCRIPTOR_REQUIRED');
  if(a?.sha256!==canonical||profile.visual.source_sha!==canonical||image.canonical_source_sha!==canonical
    ||a.storage_bucket!=='av2-generative-video-benchmarks'
    ||a.storage_path!==`lumi-series-v2/ep_lumi_flores_003/q31-PRO2/source/${canonical}.png`||a.size_bytes!==2282010)
    throw Error('Q41_CANONICAL_SHA_REQUIRED');
  if(profile.status!=='FROZEN'||profile.image.model!=='marketing-studio/image'||d.image_model!==profile.image.model
    ||image.model!==profile.image.model||Object.keys(p).sort().join(',')!=='aspect_ratio,enhance_prompt,moderation,prompt,quality,resolution'
    ||['resolution','quality','aspect_ratio','enhance_prompt'].some(k=>p[k]!==image[k])
    ||p.resolution!=='2k'||p.quality!=='high'||p.aspect_ratio!=='9:16'||p.enhance_prompt!==false||p.moderation!=='auto')
    throw Error('Q41_APPROVED_MODEL_2K_HIGH_REQUIRED');
  return {episode_id:EPISODE_ID,shot_id:'q41',model:profile.image.model,input:p,
    prompt_sha256:promptSha,descriptor_sha256:sha256(JSON.stringify(d)),
    production_profile_sha256:sha256(JSON.stringify(profile)),image_profile_sha256:sha256(JSON.stringify(image)),
    canonical_artifact:{artifact_id:a.id,sha256:canonical,size:a.size_bytes,mime:'image/png',bucket:a.storage_bucket,path:a.storage_path}};
}

export async function runIsolatedQ41Quote({command:c,ns,env,fetchImpl,clock,sourceTransport}){
  const v=await ns.read(),d=v.request,now=()=>new Date(clock()).toISOString();
  const base={operation_id:c.operation_id,diagnostic_request_id:c.nonce,episode_id:EPISODE_ID,shot_id:'q41',
    staging_revision:env.RENDER_GIT_COMMIT,model:d.model,prompt_sha256:d.prompt_sha256,
    descriptor_sha256:d.descriptor_sha256,production_profile_sha256:d.production_profile_sha256,
    image_profile_sha256:d.image_profile_sha256,canonical_source_sha256:d.canonical_artifact.sha256,
    canonical_source_verified:false,signed_source_ready:false,status:'BLOCKED',quote_kind:'FINAL_SOURCE_BOUND_QUOTE',
    quote_status:'NOT_EXECUTED',http_status:null,provider_request_id:null,payload_sha256:null,
    quote_usd:null,quote_timestamp:null,quote_expiration:null,provider_units:null,
    q41_cost_ceiling_usd:null,price_basis:'API_USD_ESTIMATE_NOT_FINAL_CHARGE',
    episode_total_budget_usd:HARD_BUDGET_USD,first_image_budget_gate:'BLOCKED',episode_budget_gate:'BLOCKED',
    generation_authorized:false,episode_created:false,provider_generation_calls:0,telegram_mutation_calls:0,publication_calls:0};
  // Durable intent is irreversible within this fixed operation. Re-entry may
  // recover receipts, never resolve a new URL or dispatch another estimate.
  if(v.q41_quote_attempt)return v.q41_quote_attempt.result??{...base,...v.q41_quote_attempt.prepared,
    quote_status:'QUOTE_ATTEMPT_OUTCOME_UNPROVEN',recovery_only:true};
  await ns.write(s=>{s.q41_quote_attempt={started_at:now(),request_id:c.nonce,prepared:null,result:null};});
  let result={...base};
  try{
    if(env.LUMI_RUNTIME_ENV!=='staging')throw Error('Q41_STAGING_ONLY');
    if(!env.HF_API_KEY)throw Error('Q41_HF_API_KEY_MISSING');
    if(inputDigest(d)!==inputDigest(isolatedQ41Input()))throw Error('Q41_APPROVED_DESCRIPTOR_REQUIRED');
    // Runtime binds the existing storageLoader (remote-byte SHA check) followed
    // by signedMediaTransport. Neither a URL nor a prompt can come from HMAC.
    const source=await sourceTransport(d.canonical_artifact);
    await ns.read();
    if(source?.sha256!==d.canonical_artifact.sha256)throw Error('Q41_CANONICAL_SHA_REQUIRED');
    const u=new URL(source.url),origin=new URL(env.SUPABASE_URL).origin;
    const expectedPath='/storage/v1/object/sign/'+d.canonical_artifact.bucket+'/'+d.canonical_artifact.path;
    if(u.protocol!=='https:'||u.origin!==origin||u.pathname!==expectedPath||!u.searchParams.get('token')
      ||u.username||u.password||u.hash)throw Error('Q41_SIGNED_SOURCE_REQUIRED');
    const input={...d.input,image_urls:[source.url]},body=JSON.stringify(input);
    result={...result,canonical_source_verified:true,signed_source_ready:true,
      signed_source_ttl_seconds:300,payload_sha256:sha256(body),quote_status:'PREPARED'};
    await ns.write(s=>{s.q41_quote_attempt.prepared=structuredClone(result);});
    const q=await estimateHiggsfieldUsd({apiKey:env.HF_API_KEY,model:d.model,input,clock:now,
      fetchImpl:async(url,options)=>{
        if(url!=='https://api.higgsfield.ai/estimate/marketing-studio/image'||options.method!=='POST'
          ||options.headers?.Authorization!==`Key ${env.HF_API_KEY}`||options.body!==body)
          throw Error('Q41_NON_ESTIMATE_FORBIDDEN');
        await ns.read();
        const response=await fetchImpl(url,{...options,redirect:'error'});
        return response;
      }});
    result={...result,status:'QUOTE_VERIFIED',quote_status:'SOURCE_BOUND_USD_ESTIMATE_RECOVERED',
      http_status:q.http_status,provider_request_id:q.provider_request_id,quote_usd:q.estimated_cost_usd,
      quote_timestamp:q.quoted_at,quote_expiration:q.quote_expiration,
      provider_units:typeof q.provider_units==='number'&&Number.isFinite(q.provider_units)?q.provider_units:
        typeof q.provider_units==='string'&&/^\d+(\.\d+)?$/.test(q.provider_units)?q.provider_units:null};
  }catch(error){
    const code=error?.message;
    const safe=['Q41_STAGING_ONLY','Q41_HF_API_KEY_MISSING','Q41_APPROVED_DESCRIPTOR_REQUIRED','Q41_CANONICAL_SHA_REQUIRED',
      'Q41_SIGNED_SOURCE_REQUIRED','Q41_NON_ESTIMATE_FORBIDDEN','artifact_bytes_mismatch','canonical_artifact_unavailable',
      'canonical_media_transport_unavailable'];
    result={...result,status:'BLOCKED',quote_status:code==='higgsfield_api_usd_quote_required'?'USD_REQUIRED':
      /^higgsfield_usd_estimate_http_\d+$/.test(code||'')?'ESTIMATE_HTTP_ERROR':safe.includes(code)?code:'QUOTE_OUTCOME_UNPROVEN',
      http_status:error.quote_receipt?.http_status??null,provider_request_id:error.quote_receipt?.provider_request_id??null};
  }
  // Persistence errors escape. A lost result leaves durable intent and blocks
  // replay. A saved result survives HTTP/phase failures and is returned on GET.
  await ns.write(s=>{s.q41_quote_attempt.result=structuredClone(result);});
  return result;
}

// Pricing inputs only. These are not production shot plans or source bindings.
// No caller-provided URLs, prompts, prices or authorization flags are accepted.
export function isolatedUsdInput(){
  return {episode_id:EPISODE_ID,title:'Lumi y los animales de la granja',
    quote_kind:'CONFIGURATION_QUOTE',hard_budget_usd:HARD_BUDGET_USD,
    tts_estimated_characters:371,tts_cost_usd:null,
    envelopes:[
      ...Array.from({length:5},(_,i)=>({stage:'IMAGE',shot_id:'q'+(41+i),model:profile.image.model,
        input:{prompt:'Configuration estimate only: premium stylized 3D CGI preschool Lumi farm scene.',
          quality:'high',resolution:'2k',aspect_ratio:'9:16',moderation:'auto',enhance_prompt:false}})),
      ...[4,5,5,5,5].map((duration,i)=>({stage:'VIDEO',shot_id:'q'+(41+i),model:profile.video.endpoint,
        input:{prompt:'Configuration estimate only: premium stylized 3D CGI preschool Lumi farm animation.',
          duration,sound:'off',multi_shots:false,cfg_scale:0.5}}))
    ]};
}

export async function runIsolatedUsdPreflight({command:c,ns,env,fetchImpl,clock}){
  const v=await ns.read(),input=v.request;
  const evidence={operation_id:c.operation_id,request_id:c.nonce,episode_id:EPISODE_ID,
    staging_revision:env.RENDER_GIT_COMMIT,quote_kind:'CONFIGURATION_QUOTE',
    final_source_bound_quote:'NOT_AVAILABLE_SOURCES_NOT_CREATED',
    image_model:profile.image.model,kling_model:profile.video.endpoint,
    tts_estimated_characters:371,tts_cost_usd:null,tts_usd_evidence:'NOT_VERIFIED',
    api_balance_usd:null,image_quality:'UNVERIFIED',hard_budget_usd:HARD_BUDGET_USD,
    budget_gate:'BLOCKED',generation_authorized:false,episode_created:false,
    provider_generation_calls:0,publication_calls:0,telegram_mutation_calls:0};
  // Intent is persisted BEFORE I/O. A process death never permits a resubmit,
  // even though estimates themselves are non-generative. Partial quotes survive.
  if(v.usd_preflight_attempt)return {...evidence,...v.usd_preflight_attempt.partial,
    status:'BLOCKED',quote_status:'QUOTE_ATTEMPT_OUTCOME_UNPROVEN',budget_gate:'BLOCKED',
    generation_authorized:false,timestamp:new Date(clock()).toISOString()};
  await ns.write(state=>{state.usd_preflight_attempt={request_id:c.nonce,started_at:new Date(clock()).toISOString(),partial:null};});
  const report=await quoteFourthEpisodeUsd({env,envelopes:input.envelopes,quoteKind:input.quote_kind,
    clock:()=>new Date(clock()).toISOString(),
    fetchImpl:async(url,options)=>{await ns.read();const response=await fetchImpl(url,options);await ns.read();return response;},
    onQuote:partial=>ns.write(state=>{state.usd_preflight_attempt.partial=partial;})});
  return {...evidence,...report,status:'BLOCKED',timestamp:new Date(clock()).toISOString(),
    blockers:[...(report.quote_status==='TEN_USD_ESTIMATES_RECOVERED'?[]:['COMPLETE_USD_QUOTES_REQUIRED']),
      'FINAL_SOURCE_BOUND_QUOTE_REQUIRED','IMAGE_2K_HIGH_PROVIDER_SUPPORT_UNVERIFIED',
      'TTS_USD_UPPER_BOUND_UNVERIFIED','SAME_ACCOUNT_API_USD_BALANCE_UNVERIFIED']};
}
