import {quoteFourthEpisodeUsd,EPISODE_ID,HARD_BUDGET_USD} from './lumi-fourth-episode-usd-preflight.js';
import {LUMI_PRODUCTION_PROFILE_V2 as profile} from './lumi-production-profile-v2.js';

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
