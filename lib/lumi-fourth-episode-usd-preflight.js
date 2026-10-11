// Non-generative quote-only contract for Lumi episode 004.
// No route, provider job, ledger claim, production write or Telegram mutation.
import {estimateHiggsfieldUsd,sumUsd,usd} from './higgsfield-usd-budget-v1.js';
import {LUMI_PRODUCTION_PROFILE_V2 as approvedProfile} from './lumi-production-profile-v2.js';

export const EPISODE_ID='ep_lumi_granja_004_20261008_ee7ab4b3';
export const HARD_BUDGET_USD=5;
// Never quote a superseded model: the image model is frozen in the approved V2 profile.
const IMAGE=approvedProfile.image.model;
const VIDEO=approvedProfile.video.endpoint;
const durations=[4,5,5,5,5];
const plain=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const https=x=>typeof x==='string'&&/^https:\/\/[^\s]+$/i.test(x);
const allowed=(x,keys)=>Object.keys(x).every(k=>keys.includes(k));
const fail=code=>{throw Error(code);};

// Exact provider envelopes must be assembled by the production planner, not
// guessed from durations. In particular, no fake source image URLs are allowed.
export function validateQuoteEnvelopes(envelopes,quoteKind='FINAL_SOURCE_BOUND_QUOTE'){
  if(!['CONFIGURATION_QUOTE','FINAL_SOURCE_BOUND_QUOTE'].includes(quoteKind))fail('INVALID_QUOTE_KIND');
  const configuration=quoteKind==='CONFIGURATION_QUOTE';
  if(!Array.isArray(envelopes)||envelopes.length!==10)fail('EXACT_TEN_ENVELOPES_REQUIRED');
  for(let i=0;i<10;i++){
    const e=envelopes[i],input=e?.input,shot='q'+(41+i%5);
    if(!plain(e)||!allowed(e,['stage','shot_id','model','input'])||!plain(input)
      ||e.stage!==(i<5?'IMAGE':'VIDEO')||e.shot_id!==shot)fail('INVALID_QUOTE_ENVELOPE');
    if(i<5){
      if(e.model!==IMAGE||!allowed(input,['prompt','image_urls','quality','resolution','aspect_ratio','moderation','enhance_prompt'])
        ||typeof input.prompt!=='string'||!input.prompt.trim()||input.prompt.length>12000
        ||input.quality!=='high'||input.resolution!=='2k'||input.aspect_ratio!=='9:16'
        ||(configuration?input.image_urls!==undefined:!Array.isArray(input.image_urls)||input.image_urls.length!==1||!https(input.image_urls[0]))
        ||input.enhance_prompt!==false||input.moderation!=='auto')fail('IMAGE_2K_HIGH_SOURCE_REQUIRED');
    }else{
      if(e.model!==VIDEO||!allowed(input,['prompt','image_url','duration','sound','multi_shots','cfg_scale'])
        ||typeof input.prompt!=='string'||!input.prompt.trim()||input.prompt.length>12000
        ||(configuration?input.image_url!==undefined:!https(input.image_url))||input.duration!==durations[i-5]||input.sound!=='off'
        ||input.multi_shots!==false||input.cfg_scale!==0.5)fail('KLING_PRO_SOURCE_REQUIRED');
    }
  }
  return envelopes;
}

const classify=error=>error?.message==='higgsfield_api_usd_quote_required'?'USD_FIELD_MISSING':
  /^higgsfield_usd_estimate_http_\d+$/.test(error?.message||'')?'ESTIMATE_HTTP_ERROR':'ESTIMATE_UNVERIFIED';

export async function quoteFourthEpisodeUsd({env=process.env,envelopes,fetchImpl=fetch,
  clock=()=>new Date().toISOString(),ttsUpperBoundUsd=null,ttsContractVerified=false,
  reserveUsd=0.5,verifiedApiBalanceUsd=null,balanceAccountVerified=false,
  imageQualityVerified=false,quoteKind='FINAL_SOURCE_BOUND_QUOTE',onQuote=async()=>{}}={}){
  const report={episode_id:EPISODE_ID,hf_api_key_present:!!env.HF_API_KEY,hard_budget_usd:HARD_BUDGET_USD,
    quotes:[],image_total_usd:null,video_total_usd:null,total_projected_usd:null,
    api_balance_usd_verified:verifiedApiBalanceUsd!==null,budget_gate:'BLOCKED',
    quote_status:'NOT_EXECUTED',quote_kind:quoteKind,higgsfield_auth:'UNVERIFIED',
    image_quality:'UNVERIFIED',provider_generation_calls:0,publication_calls:0,episode_created:false};
  if(env.LUMI_RUNTIME_ENV!=='staging')return {...report,quote_status:'STAGING_ONLY'};
  if(!env.HF_API_KEY)return {...report,quote_status:'HF_API_KEY_MISSING'};
  try{validateQuoteEnvelopes(envelopes,quoteKind);}catch(error){return {...report,quote_status:error.message};}
  const estimateOnly=async(url,options)=>{
    const u=new URL(url);
    if(u.origin!=='https://api.higgsfield.ai'||!u.pathname.startsWith('/estimate/')
      ||options.method!=='POST'||options.headers?.Authorization!==`Key ${env.HF_API_KEY}`)
      fail('NON_ESTIMATE_PROVIDER_CALL_FORBIDDEN');
    const response=await fetchImpl(url,{...options,redirect:'error'});
    if(response.status===401||response.status===403)report.higgsfield_auth='REJECTED';
    else if(response.ok)report.higgsfield_auth='AUTHENTICATED_ESTIMATE_ACCEPTED';
    return response;
  };
  for(const e of envelopes){
    try{
      const q=await estimateHiggsfieldUsd({apiKey:env.HF_API_KEY,model:e.model,input:e.input,fetchImpl:estimateOnly,clock});
      report.quotes.push({stage:e.stage,shot_id:e.shot_id,model:e.model,estimated_cost_usd:q.estimated_cost_usd,
        provider_units:typeof q.provider_units==='number'&&Number.isFinite(q.provider_units)?q.provider_units:null,
        payload_sha256:q.payload_sha256,quoted_at:q.quoted_at,
        price_basis:'API_USD_ESTIMATE_NOT_FINAL_CHARGE'});
    }catch(error){
      const status=/^higgsfield_usd_estimate_http_(\d+)$/.exec(error.message||'');
      report.quotes.push({stage:e.stage,shot_id:e.shot_id,model:e.model,status:'BLOCKED',
        error_code:classify(error),http_status:status?Number(status[1]):null});
      await onQuote(structuredClone(report));
      report.quote_status='INCOMPLETE';return report; // Never blindly retry or continue after error.
    }
    // Persistence failure must escape, never be mislabeled as a provider error.
    await onQuote(structuredClone(report));
  }
  report.image_total_usd=sumUsd(report.quotes.slice(0,5).map(q=>q.estimated_cost_usd));
  report.video_total_usd=sumUsd(report.quotes.slice(5).map(q=>q.estimated_cost_usd));
  report.quote_status='TEN_USD_ESTIMATES_RECOVERED';
  if(quoteKind==='CONFIGURATION_QUOTE')return report;
  try{
    // A quoted `quality: high` request is NOT proof the API honored it.
    // A balance is NOT trusted until linked to the same billing identity.
    if(!ttsContractVerified||ttsUpperBoundUsd===null||verifiedApiBalanceUsd===null
      ||!balanceAccountVerified||!imageQualityVerified)return report;
    const tts=usd(ttsUpperBoundUsd),reserve=usd(reserveUsd),balance=usd(verifiedApiBalanceUsd);
    report.total_projected_usd=sumUsd([report.image_total_usd,report.video_total_usd,tts,reserve]);
    if(report.total_projected_usd<=HARD_BUDGET_USD
      &&sumUsd([report.image_total_usd,report.video_total_usd,reserve])<=balance)
      report.budget_gate='PASS_PREFLIGHT_ONLY';
    return report;
  }catch{return {...report,budget_gate:'BLOCKED',quote_status:'BUDGET_INPUT_INVALID'};}
}
