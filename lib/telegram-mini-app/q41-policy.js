import {createHmac,timingSafeEqual} from 'node:crypto';
import {buildSceneImagePayload,narrationUnits} from '../lumi-v2-executor-bindings.js';
import {miniAppSecret} from './auth.js';
import {issueDraftReviewCapability,inputDigest,FIRST_IMAGE_EPISODE} from '../lumi-v2-activation-context.js';
import {supervisedReservation,sumUsd} from '../higgsfield-usd-budget-v1.js';
import {LUMI_PRODUCTION_PROFILE_V2 as productionProfile,resolveLumiVoiceProfile} from '../lumi-production-profile-v2.js';

const planMac=(value,env)=>createHmac('sha256',miniAppSecret({...env,LUMI_TELEGRAM_BOT_TOKEN:undefined})).update('lumi-episode-plan-v1:'+inputDigest(value)).digest('hex');
const planNeed=(ok,code='EPISODE_PLAN_APPROVAL_REQUIRED')=>{if(!ok)throw Error(code);};
export function episodePlanVersion(cp){
  const g=cp.metadata.generic_v2;
  planNeed(g?.binding_sha&&g.plan&&g.shot_plans);
  return inputDigest({episode_id:cp.episode_id,binding_sha:g.binding_sha,plan:g.plan,shots:g.shot_plans,
    source_contracts:g.source_contracts,profile_sha:g.profile_sha,narration:g.narration_request,
    actions:cp.actions.filter(a=>['IMAGE','VIDEO','TTS'].includes(a.stage)).map(a=>({key:a.key,stage:a.stage,shot:a.scene_id})),
    reuse:Object.fromEntries(Object.entries(cp.metadata.library_reuse||{}).map(([key,r])=>[key,r.application_sha]))});
}
export function episodePlanContract(cp,projection,{priceBuffer=0}={}){
  planNeed([0,10].includes(priceBuffer),'EPISODE_PLAN_BUFFER_INVALID');
  planNeed(projection?.items&&projection.status!=='PLAN_EXCEEDS_BUDGET','EPISODE_PLAN_COST_EVIDENCE_REQUIRED');
  const g=cp.metadata.generic_v2,actions=cp.actions.filter(a=>['IMAGE','VIDEO','TTS'].includes(a.stage)&&a.status==='PENDING'&&(a.dispatch_state==='NOT_DISPATCHED'||cp.metadata.budget_reservations?.[a.key]));
  const limits={},constraints={},models={};
  for(const a of actions){
    const item=projection.items.find(i=>i.action_id===a.key),shot=g.shot_plans.find(s=>s.shot_id===a.scene_id);
    const existing=cp.metadata.budget_reservations?.[a.key];
    planNeed(a.stage==='TTS'||Number.isFinite(existing?.amount_usd)&&existing.amount_usd>0||Number.isFinite(item?.remaining_estimate_usd)&&item.remaining_estimate_usd>0,'EPISODE_PLAN_COST_EVIDENCE_REQUIRED');
    models[a.key]=a.stage==='IMAGE'?productionProfile.image.model:a.stage==='VIDEO'?productionProfile.video.endpoint:resolveLumiVoiceProfile(g.narration_request.voice_profile_id).model_id;
    const baseline=a.stage==='TTS'?0:existing?.amount_usd??supervisedReservation(item.remaining_estimate_usd);
    // Proposal only: existing grants/reservations are immutable. The human
    // sees and accepts these new caps; dispatch still reserves the exact quote.
    limits[a.key]=priceBuffer&&baseline&&!existing?Number((BigInt(Math.round(baseline*1e6))*110n+4999999n)/5000000n)*.05:baseline;
    limits[a.key]=Number(limits[a.key].toFixed(6));
    constraints[a.key]={stage:a.stage,shot_id:a.scene_id??null,shot_sha:shot?inputDigest(shot):null,
      duration_seconds:a.stage==='VIDEO'?shot.duration:null,sound:a.stage==='VIDEO'?'off':null,
      source_policy:'HUMAN_APPROVED_SOURCE_FROM_SAME_FROZEN_PLAN',quality_profile:g.profile_sha,
      narration_sha:a.stage==='TTS'?inputDigest(g.narration_request):null,
      maximum_quota_units:a.stage==='TTS'?narrationUnits(g).map(u=>u.text).join(' ').length:null,
      paid_overage_authorized:false};
  }
  planNeed(actions.length>0&&sumUsd([projection.existing_exposure_usd,...Object.entries(limits).filter(([key])=>!cp.metadata.budget_reservations?.[key]).map(([,limit])=>limit)])<=cp.authorized_ceiling_usd,'EPISODE_PLAN_LIMIT_EXCEEDED');
  return {scope:'EPISODE_PLAN_SPEND_V1',episode_id:cp.episode_id,plan_version:episodePlanVersion(cp),
    price_variation_percent:priceBuffer,limit_rounding_usd:priceBuffer ? .05 : null,
    model:models,action_set:actions.map(a=>a.key),payload_constraints:constraints,per_action_limits:limits,
    maximum_episode_exposure:Number(cp.authorized_ceiling_usd),maximum_provider_calls_per_action:1,
    total_reservation_maximum_usd:sumUsd(Object.values(limits)),provider_charge_guaranteed:false,
    estimate_minimum_usd:projection.minimum_estimated_total_usd,estimate_probable_usd:projection.probable_total_usd,
    unknown_costs:projection.missing_cost_evidence,estimate_assumptions:projection.items.filter(i=>i.assumption).map(i=>({action:i.action_id,basis:i.assumption,reference_quote_id:i.reference_quote_id,source_episode_id:i.reference_episode_id})),title:g.plan.episode.title};
}
export function sealEpisodePlanGrant({contract,user,chat,authorizationId,approvedAt,expiresAt},env){
  const value={...contract,human_identity:user,chat_id:chat,authorization_id:authorizationId,
    consent_timestamp:approvedAt,expires_at:expiresAt,decision:'APPROVED',channel:'TELEGRAM_MINI_APP'};
  return {scope:contract.scope,status:'AUTHORIZED',value,seal:planMac(value,env)};
}
export function assertEpisodePlanGrant(grant,env,cp,state,{allowExpired=false,historical=false}={}){
  const v=grant?.value,seal=grant?.seal;
  planNeed(grant?.status==='AUTHORIZED'&&v?.scope==='EPISODE_PLAN_SPEND_V1'&&/^[a-f0-9]{64}$/.test(seal||'')
    &&timingSafeEqual(Buffer.from(seal),Buffer.from(planMac(v,env))));
  planNeed(v.episode_id===cp.episode_id&&v.human_identity===cp.metadata.user&&v.chat_id===state.chat_id
    &&(historical||v.plan_version===episodePlanVersion(cp)&&v.maximum_episode_exposure===Number(cp.authorized_ceiling_usd))
    &&v.decision==='APPROVED'&&v.maximum_provider_calls_per_action===1,'EPISODE_PLAN_MATERIAL_CHANGED');
  planNeed(allowExpired||Date.parse(v.expires_at)>Date.now(),'EPISODE_PLAN_CONSENT_EXPIRED');return v;
}
export function findEpisodePlanGrant(state,cp,env){
  return Object.values(state.v2_authorizations||{}).filter(g=>g.scope==='EPISODE_PLAN_SPEND_V1'&&g.value?.episode_id===cp.episode_id)
    .sort((a,b)=>String(b.value.consent_timestamp).localeCompare(String(a.value.consent_timestamp)))
    .find(g=>{try{assertEpisodePlanGrant(g,env,cp,state);return true;}catch{return false;}})??null;
}
// Editorial policy is a separate explicit decision, never a human media review.

export const DRAFT_POLICY_VERSION='DRAFT_FINAL_REVIEW_V1';
export function draftPolicyContract(cp,state,env){
  const grant=findEpisodePlanGrant(state,cp,env);planNeed(grant,'EPISODE_PLAN_APPROVAL_REQUIRED');
  return {scope:DRAFT_POLICY_VERSION,episode_id:cp.episode_id,plan_version:episodePlanVersion(cp),
    plan_authorization_id:grant.value.authorization_id,action_set:[...grant.value.action_set],
    maximum_episode_exposure:grant.value.maximum_episode_exposure,automatic_regeneration:false,
    final_review_required:true,publication_enabled:false,artistic_qa:'NOT_AUTOMATICALLY_EVALUATED',
    risk:'Un defecto de una imagen puede llegar a su animación antes de la revisión final.',
    stages:['imágenes','verificación técnica','dirección','videos','voz Fernanda','sincronización','montaje','master borrador'],
    expires_at:grant.value.expires_at};
}
export function sealDraftPolicy({contract,user,chat,id,approvedAt},env){
  const value={...contract,human_identity:user,chat_id:chat,authorization_id:id,consent_timestamp:approvedAt,
    decision:'APPROVED',channel:'TELEGRAM_MINI_APP'};
  return {scope:DRAFT_POLICY_VERSION,status:'AUTHORIZED',value,seal:planMac(value,env)};
}
export function draftPolicyCapability(cp,state,env){
  const job=state.mini_app?.episode_jobs?.[cp.episode_id],choice=state.mini_app?.initial_review_choices?.[cp.episode_id];
  const g=state.v2_authorizations?.[job?job.review_policy_id:choice?.review_policy_id],v=g?.value;
  if(!g)return null;
  planNeed(g.status==='AUTHORIZED'&&v?.scope===DRAFT_POLICY_VERSION&&/^[a-f0-9]{64}$/.test(g.seal||'')
    &&timingSafeEqual(Buffer.from(g.seal),Buffer.from(planMac(v,env)))
    &&v.episode_id===cp.episode_id&&v.plan_version===episodePlanVersion(cp)&&v.human_identity===cp.metadata.user
    &&v.chat_id===state.chat_id&&v.maximum_episode_exposure===Number(cp.authorized_ceiling_usd)
    &&v.automatic_regeneration===false&&v.final_review_required===true&&v.publication_enabled===false
    &&v.decision==='APPROVED','DRAFT_POLICY_INVALID');
  const cap=issueDraftReviewCapability({id:v.authorization_id,version:DRAFT_POLICY_VERSION,episode_id:v.episode_id,plan_version:v.plan_version,
    seal:g.seal,human_identity:v.human_identity,plan_authorization_id:v.plan_authorization_id,expires_at:v.expires_at});
  return cap;
}
export function remainingPlanReservation(cp,value,except){
  return sumUsd(cp.actions.filter(a=>a.key!==except&&a.status==='PENDING'&&a.dispatch_state==='NOT_DISPATCHED'
    &&value.action_set.includes(a.key)&&!cp.metadata.budget_reservations?.[a.key]).map(a=>value.per_action_limits[a.key]));
}
export function assertEpisodeOneTap(op,env,cp,quote,requireBound,state,{recover=false}={}){
  const grant=state.v2_authorizations?.[op?.plan_authorization_id],v=assertEpisodePlanGrant(grant,env,cp,state,{allowExpired:recover,historical:recover});
  const key=op.binding?.next_action;
  planNeed(op.kind==='production_stage'&&op.binding.proposal_id===cp.episode_id&&op.plan_version===v.plan_version
    &&v.action_set.includes(key));
  const job=state.mini_app?.episode_jobs?.[cp.episode_id];
  planNeed(op.activated_by==='AUTHENTICATED_MINI_APP_GENERATE_CLICK'||op.activated_by==='AUTHORIZED_EPISODE_JOB'
    &&job?.id===op.episode_job_id&&job.plan_authorization_id===op.plan_authorization_id
    &&job.activated_by==='AUTHENTICATED_MINI_APP_PRODUCE_CLICK'&&(recover||job.status==='RUNNING'&&job.lease_until>Date.now()));
  if(quote){
    planNeed(quote.episode_id===cp.episode_id&&quote.action_key===key&&quote.model===v.model[key]
      &&quote.hard_budget_usd===v.maximum_episode_exposure&&quote.budget_gate==='PASS'
      &&Number.isFinite(quote.proposed_reserve_usd)&&quote.proposed_reserve_usd>=0
      &&quote.proposed_reserve_usd<=v.per_action_limits[key],'EPISODE_PLAN_ACTION_LIMIT_EXCEEDED');
    if(!recover)planNeed(sumUsd([quote.existing_exposure_usd??0,quote.proposed_reserve_usd,remainingPlanReservation(cp,v,key)])<=v.maximum_episode_exposure,'EPISODE_REMAINING_PLAN_BUDGET_EXCEEDED');
    const c=v.payload_constraints[key];
    if(c.stage==='TTS')planNeed(quote.currency==='ELEVENLABS_CHARACTER_QUOTA'&&quote.proposed_reserve_usd===0&&quote.quota_units<=c.maximum_quota_units,'EPISODE_PLAN_TTS_QUOTA_LIMIT_EXCEEDED');
    planNeed(c.stage!=='VIDEO'||quote.duration===c.duration_seconds&&quote.sound===c.sound,'EPISODE_PLAN_MATERIAL_CHANGED');
  }
  if(requireBound)planNeed(quote&&op.binding.quote_id===quote.quote_id&&op.quote_binding?.quote_id===quote.quote_id
    &&op.quote_binding.payload_sha256===quote.payload_sha256&&op.quote_binding.quote_sha===op.binding.quote_sha);
  return v;
}

// This is one explicitly approved UI consent contract, not a new Budget Gate.
export const Q41_ONE_TAP_POLICY=Object.freeze({version:'EP004_Q41_ONE_TAP_V1',episode_id:FIRST_IMAGE_EPISODE,
  action_key:'video:q41',model:'kling-video/v3.0/pro/image-to-video',duration:4,sound:'off',
  source_sha256:'c963a60e9d35a6258c47ef04968cd7371c31c71d02e40cf75f63740a62efa24b',
  director_sha256:'83233e1cc88eadfe9ec28724311eddea3f4db113d9b7651d6441f5b09e3eb8f6',
  max_reservation_usd:.56,hard_budget_usd:5,max_generations:1,provider_charge_guaranteed:false});
const fail=()=>{throw Error('Q41_ONE_TAP_CONSENT_REQUIRED');};
const mac=(value,env)=>createHmac('sha256',miniAppSecret({...env,LUMI_TELEGRAM_BOT_TOKEN:undefined})).update('q41-one-tap:'+inputDigest(value)).digest('hex');
export function assertQ41Policy(cp,policy=Q41_ONE_TAP_POLICY){
  const a=cp.actions.find(a=>a.key==='video:q41'),d=cp.metadata.stage_results?.['director:q41'];
  if(policy.episode_id!==FIRST_IMAGE_EPISODE||policy.action_key!=='video:q41'||policy.model!==Q41_ONE_TAP_POLICY.model
    ||policy.duration!==4||policy.sound!=='off'||policy.max_reservation_usd!==.56||policy.hard_budget_usd!==5||policy.max_generations!==1
    ||cp.episode_id!==policy.episode_id||cp.authorized_ceiling_usd!==5||cp.runner_enabled||cp.autorun
    ||cp.metadata.source_artifacts?.q41?.artifact?.sha256!==policy.source_sha256||d?.sha256!==policy.director_sha256
    ||inputDigest(d.result)!==d.sha256||!a
    ||!Object.values(cp.metadata.review_requests||{}).some(r=>r.action_key==='image:q41'&&r.status==='APPROVED'&&r.artifact_sha===policy.source_sha256))fail();
  return policy;
}
export function sealQ41Consent({cp,policy,user,chat,operationId},env){
  assertQ41Policy(cp,policy);
  const value={...policy,user,chat,operation_id:operationId,request_sha:cp.metadata.generic_v2.binding_sha,
    activated_by:'AUTHENTICATED_MINI_APP_GENERATE_CLICK',created_at:new Date().toISOString()};
  return {value,seal:mac(value,env)};
}
export function assertQ41Consent(op,env,cp,quote=null,requireBound=false){
  const value=op?.consent?.value,seal=op?.consent?.seal;
  if(!value||typeof seal!=='string'||!/^[a-f0-9]{64}$/.test(seal)||!timingSafeEqual(Buffer.from(seal),Buffer.from(mac(value,env))))fail();
  assertQ41Policy(cp,value);
  if(op.kind!=='first_animation'||op.id!==value.operation_id||value.user!==cp.metadata.user
    ||value.request_sha!==cp.metadata.generic_v2.binding_sha||value.activated_by!=='AUTHENTICATED_MINI_APP_GENERATE_CLICK')fail();
  if(quote&&(quote.episode_id!==value.episode_id||quote.action_key!==value.action_key||quote.model!==value.model
    ||quote.source_sha256!==value.source_sha256||quote.director_sha256!==value.director_sha256
    ||quote.duration!==4||quote.sound!=='off'||quote.hard_budget_usd!==5
    ||!Number.isFinite(quote.proposed_reserve_usd)||quote.proposed_reserve_usd<=0||quote.proposed_reserve_usd>.56
    ||quote.budget_gate!=='PASS'))throw Error('Q41_ONE_TAP_LIMIT_OR_PAYLOAD_CHANGED');
  if(requireBound&&(!quote||op.binding.quote_id!==quote.quote_id||op.quote_binding?.quote_id!==quote.quote_id
    ||op.quote_binding.payload_sha256!==quote.payload_sha256||op.quote_binding.quote_sha!==op.binding.quote_sha))fail();
  return value;
}

// New consent supplied on 2026-10-15. It is deliberately separate from the
// expired quote decisions. Stored in the existing v2_authorizations ledger;
// only a genuine Mini App click can activate and HMAC-seal its single operation.
export const Q42_ONE_TAP_POLICY=Object.freeze({version:'EP004_Q42_ONE_TAP_V1',authorization_id:'EP004_Q42_DURABLE_SPEND_20261015',
  authorized_at:'2026-10-15T18:41:31.000Z',episode_id:FIRST_IMAGE_EPISODE,action_key:'image:q42',model:'marketing-studio/image',
  request_sha:'8c3ecc2a8cc722440cd209576e007ea6ec64d88b95f56903024cd9169d87072c',
  source_sha256:'5dc31254ad26aa1b606735188ac30d2f4d486bc389f19bc8a50816e1e1b3da33',
  payload_fingerprint:'ae1916f39eea02f6df2a31940254c9a312d6dceb36134b85f19c73dbc2fee11f',
  max_reservation_usd:.3275,hard_budget_usd:5,max_generations:1,provider_charge_guaranteed:false});
const q42Fail=()=>{throw Error('Q42_DURABLE_AUTHORIZATION_REQUIRED');};
const q42Mac=(value,env)=>createHmac('sha256',miniAppSecret({...env,LUMI_TELEGRAM_BOT_TOKEN:undefined})).update('q42-one-tap:'+inputDigest(value)).digest('hex');
// Only the verified source transport is normalized. Prompt, settings, model and
// source bytes stay bound. Each quote also binds the exact outgoing body SHA.
export function imagePayloadFingerprint(payload,sourceSha,model='marketing-studio/image'){
  if(!/^[a-f0-9]{64}$/.test(sourceSha||'')||!Array.isArray(payload?.image_urls)||payload.image_urls.length!==1)q42Fail();
  return inputDigest({model,payload:{...payload,image_urls:['sha256:'+sourceSha]}});
}
export function q42PayloadFingerprint(cp){
  const g=cp.metadata.generic_v2,shot=g.shot_plans.find(s=>s.shot_id==='q42');
  const source=g.source_contracts.find(s=>s.shot_id==='q42')?.canonical_source_sha;
  return imagePayloadFingerprint(buildSceneImagePayload(g,shot,'sha256:'+source),source);
}
export function assertQ42Policy(cp,policy=Q42_ONE_TAP_POLICY){
  const base=Q42_ONE_TAP_POLICY;
  if(['version','authorization_id','authorized_at','episode_id','action_key','model','max_reservation_usd','hard_budget_usd','max_generations','provider_charge_guaranteed'].some(k=>policy[k]!==base[k])
    ||cp.episode_id!==policy.episode_id||cp.authorized_ceiling_usd!==5||cp.runner_enabled||cp.autorun
    ||cp.metadata.generic_v2.binding_sha!==policy.request_sha||q42PayloadFingerprint(cp)!==policy.payload_fingerprint
    ||cp.metadata.generic_v2.source_contracts.find(s=>s.shot_id==='q42')?.canonical_source_sha!==policy.source_sha256
    ||!cp.actions.some(a=>a.key==='shot_review:q41'&&a.status==='COMPLETE')
    ||!['image:q41','video:q41'].every(key=>Object.values(cp.metadata.review_requests||{}).some(r=>r.action_key===key&&r.status==='APPROVED')))q42Fail();
  return policy;
}
export function assertQ42Authorization(state,cp,policy=Q42_ONE_TAP_POLICY){
  assertQ42Policy(cp,policy);
  const record=state.v2_authorizations?.[policy.authorization_id];
  if(record?.status!=='AUTHORIZED'||record.decision!=='APPROVED'||record.channel!=='EXPLICIT_USER_REQUEST'
    ||record.user_id!==cp.metadata.user||record.chat_id!==state.chat_id
    ||inputDigest(record.policy)!==inputDigest(policy))q42Fail();
  return record;
}
export function sealQ42Consent({cp,state,policy,user,chat,operationId},env){
  const record=assertQ42Authorization(state,cp,policy);
  const value={...policy,user,chat,operation_id:operationId,authorization_digest:inputDigest(record),
    activated_by:'AUTHENTICATED_MINI_APP_GENERATE_CLICK',created_at:new Date().toISOString()};
  return {value,seal:q42Mac(value,env)};
}
export function assertOneTapConsent(op,env,cp,quote=null,requireBound=false,state=null){
  if(op?.kind==='production_stage')return assertEpisodeOneTap(op,env,cp,quote,requireBound,state);
  if(op?.kind!=='second_image')return assertQ41Consent(op,env,cp,quote,requireBound);
  const value=op.consent?.value,seal=op.consent?.seal;
  if(!value||typeof seal!=='string'||!/^[a-f0-9]{64}$/.test(seal)||!timingSafeEqual(Buffer.from(seal),Buffer.from(q42Mac(value,env))))q42Fail();
  const record=assertQ42Authorization(state,cp,Object.fromEntries(Object.keys(Q42_ONE_TAP_POLICY).map(k=>[k,value[k]])));
  if(op.id!==value.operation_id||value.user!==cp.metadata.user||value.chat!==state.chat_id
    ||value.authorization_digest!==inputDigest(record)||value.activated_by!=='AUTHENTICATED_MINI_APP_GENERATE_CLICK')q42Fail();
  if(quote&&(quote.episode_id!==value.episode_id||quote.action_key!==value.action_key||quote.model!==value.model
    ||quote.source_sha256!==value.source_sha256||quote.payload_fingerprint!==value.payload_fingerprint
    ||quote.hard_budget_usd!==5||quote.budget_gate!=='PASS'||!Number.isFinite(quote.proposed_reserve_usd)
    ||quote.proposed_reserve_usd<=0||quote.proposed_reserve_usd>value.max_reservation_usd))throw Error('Q42_ONE_TAP_LIMIT_OR_PAYLOAD_CHANGED');
  if(requireBound&&(!quote||op.binding.quote_id!==quote.quote_id||op.quote_binding?.quote_id!==quote.quote_id
    ||op.quote_binding.payload_sha256!==quote.payload_sha256||op.quote_binding.quote_sha!==op.binding.quote_sha))q42Fail();
  return value;
}

// Read/recover the accepted ORIGINAL independently of newer prompt compilers.
// This validates the immutable historical consent/quote, and cannot grant POST.
export function assertOriginalRecoveryConsent(op,env,cp,state){
  if(op?.kind==='production_stage')return assertEpisodeOneTap(op,env,cp,state.production_commands?.[op.binding.quote_id]?.result,true,state,{recover:true});
  const value=op?.consent?.value,seal=op?.consent?.seal;
  const digest=op?.kind==='second_image'?q42Mac:op?.kind==='first_animation'?mac:null;
  if(!digest||!value||!/^[a-f0-9]{64}$/.test(seal||'')||!timingSafeEqual(Buffer.from(seal),Buffer.from(digest(value,env))))fail();
  const r=state.production_commands?.[op.binding?.quote_id],q=r?.result;
  if(value.operation_id!==op.id||value.user!==cp.metadata.user||value.chat!==state.chat_id
    ||value.episode_id!==cp.episode_id||value.request_sha!==cp.metadata.generic_v2.binding_sha
    ||op.binding.proposal_id!==cp.episode_id||op.binding.next_action!==value.action_key
    ||!q||q.episode_id!==cp.episode_id||q.action_key!==value.action_key||q.model!==value.model
    ||r.result_sha!==op.binding.quote_sha||inputDigest(q)!==r.result_sha
    ||op.quote_binding?.quote_id!==op.binding.quote_id||op.quote_binding.quote_sha!==r.result_sha
    ||op.quote_binding.payload_sha256!==q.payload_sha256)fail();
  if(op.kind==='second_image'&&value.authorization_digest!==inputDigest(state.v2_authorizations?.[value.authorization_id]))q42Fail();
  return value;
}
