import {createHmac,timingSafeEqual} from 'node:crypto';
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
