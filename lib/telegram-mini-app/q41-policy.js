import {createHmac,timingSafeEqual} from 'node:crypto';
import {adaptEpisodeToLegacy} from '../av2/compat.js';
import {imageInput} from '../lumi-series-v2-continuation.js';
import {miniAppSecret} from './auth.js';
import {inputDigest,FIRST_IMAGE_EPISODE} from '../lumi-v2-activation-context.js';

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
  const scene=adaptEpisodeToLegacy(g.plan).scenes.find(s=>s.metadata.av2_preparation.scene_id===shot.scene_ids[0]);
  const source=g.source_contracts.find(s=>s.shot_id==='q42')?.canonical_source_sha;
  return imagePayloadFingerprint(imageInput(scene,'q42','sha256:'+source,scene.visual_prompt),source);
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
