// Recovery Manager contracts only. No provider, scheduler, reservation or grant writer.
import {createHash} from 'node:crypto';
import {usd,sumUsd} from './higgsfield-usd-budget-v1.js';

const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
export const recoveryDigest=v=>createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');
const requireThat=(ok,code)=>{if(!ok)throw Error(code);};
export const REPLACEMENT_FLOW=Object.freeze(['AMBIGUOUS_OPERATION','EVIDENCE_REVIEW','REPLACEMENT_PROPOSAL','HUMAN_RISK_ACCEPTANCE','NEW_INDEPENDENT_OPERATION','PROVIDER_EMISSION','RESULT_RECOVERY','HUMAN_REVIEW']);
export const RISK_VERSION='LUMI_DUPLICATE_RISK_V2';
export const RISK_TEXT='La solicitud anterior podría haber sido procesada por Higgsfield. Si autorizás un reemplazo, existe riesgo de pagar dos veces por esta imagen.';
export const REPLACEMENT_DISCLOSURE='La solicitud anterior no pudo confirmarse. Podemos preparar una nueva generación supervisada, pero podría existir un cargo anterior no verificado.';

// Hash only immutable, necessary evidence, never tokens, sessions or signed URLs.
export function replacementEvidence({checkpoint:cp,operation:op,journal:j,authorization:auth}){
  const action=cp?.actions?.find(a=>a.key===cp.first_pending_action);
  const reservation=cp?.metadata?.budget_reservations?.[action?.key];
  requireThat(cp&&op&&j&&auth&&action,'REPLACEMENT_EVIDENCE_REQUIRED');
  requireThat(cp.status==='PAUSED_INCIDENT'&&!cp.runner_enabled&&!cp.autorun
    &&cp.metadata.provider_generation_authorized===false&&cp.metadata.publication_enabled===false,'REPLACEMENT_PAUSED_SCOPE_REQUIRED');
  requireThat(['IMAGE','VIDEO','TTS'].includes(action.stage)&&action.status==='PENDING'&&!action.artifact&&!action.provider_request_id
    &&action.active_attempt_id===j.attempt_id&&j.episode_id===cp.episode_id&&j.scene_id===action.scene_id&&j.stage===action.stage
    &&op.binding?.proposal_id===cp.episode_id&&op.binding?.next_action===action.key,'REPLACEMENT_IDENTITY_MISMATCH');
  requireThat(j.state==='EMISSION_UNKNOWN'&&j.response_parsing_outcome==='NO_RESPONSE'&&!j.provider_request_id
    &&j.http_status==null&&j.response_metadata?.transport_invoked!==false,'REPLACEMENT_AMBIGUITY_REQUIRED');
  requireThat(reservation?.attempt_id===j.attempt_id&&Number.isFinite(reservation.amount_usd)&&reservation.amount_usd>0
    &&reservation.status==='RESERVED_UNTIL_ACTUAL_CHARGE_VERIFIED','REPLACEMENT_ORIGINAL_RESERVATION_REQUIRED');
  requireThat(auth.status==='AUTHORIZED'&&auth.decision==='APPROVED'&&auth.policy?.episode_id===cp.episode_id
    &&auth.policy?.action_key===action.key&&op.consent?.value?.authorization_id===auth.policy.authorization_id
    &&op.consent.value.operation_id===op.id,'REPLACEMENT_ORIGINAL_AUTHORIZATION_REQUIRED');
  return {checkpoint_revision:cp.metadata.runtime_revision,action_id:action.key,shot_id:action.scene_id,
    original_operation_id:op.id,original_attempt_id:j.attempt_id,original_status:j.state,
    original_reserved_usd:reservation.amount_usd,provider:j.provider,model:j.model,
    checkpoint_digest:recoveryDigest(cp),operation_digest:recoveryDigest({id:op.id,status:op.status,binding:op.binding,quote_binding:op.quote_binding,error:op.error}),
    journal_digest:recoveryDigest(j),reservation_digest:recoveryDigest(reservation),
    original_authorization_id:auth.policy.authorization_id,authorization_digest:recoveryDigest(auth)};
}

export function buildReplacementProposal({checkpoint,operation,journal,authorization,budget,maximumNewReservation,createdAt}){
  const evidence=replacementEvidence({checkpoint,operation,journal,authorization});
  requireThat(Number.isFinite(maximumNewReservation)&&maximumNewReservation>0&&Number.isFinite(Date.parse(createdAt)),'REPLACEMENT_PROPOSAL_INPUT_INVALID');
  requireThat(Number(budget.episode_ceiling_usd)===Number(checkpoint.authorized_ceiling_usd)
    &&Number.isFinite(budget.required_total_usd)&&budget.required_total_usd>=evidence.original_reserved_usd,'REPLACEMENT_BUDGET_EVIDENCE_REQUIRED');
  const id=recoveryDigest(['LUMI_SUPERVISED_REPLACEMENT_V1',checkpoint.episode_id,evidence.action_id,operation.id,journal.attempt_id]);
  const maximum=usd(maximumNewReservation),exposure=sumUsd([budget.required_total_usd,maximum]);
  const value={version:1,replacement_proposal_id:id,episode_id:checkpoint.episode_id,
    ...evidence,proposal_status:'REPLACEMENT_PROPOSAL',approval_required:true,risk_acceptance:null,
    risk_disclosure:REPLACEMENT_DISCLOSURE,possible_duplicate_remote_charge:true,
    potential_duplicate_cost:{currency:'USD',original_unconfirmed_reserved_usd:evidence.original_reserved_usd,
      proposed_additional_reservation_usd:maximum,combined_q42_or_action_exposure_usd:sumUsd([evidence.original_reserved_usd,maximum]),
      actual_previous_charge_usd:null,actual_new_charge_usd:null,provider_charge_guaranteed:false},
    maximum_new_reservation:maximum,new_reservation_status:'NOT_RESERVED',estimate_source:'HISTORICAL_RESERVATION_NOT_CURRENT_QUOTE',
    quote_required:true,quote_status:'FRESH_QUOTE_REQUIRED',budget_ceiling_usd:Number(budget.episode_ceiling_usd),
    existing_episode_exposure_usd:budget.required_total_usd,potential_episode_exposure_usd:exposure,
    available_before_usd:usd(Number(budget.episode_ceiling_usd)-budget.required_total_usd),
    budget_gate:exposure<=Number(budget.episode_ceiling_usd)?'PASS_ESTIMATE_ONLY':'BLOCKED',
    planned_operation_id:recoveryDigest(['replacement-operation',id]),
    planned_attempt_id:recoveryDigest(['replacement-attempt',id]),
    planned_idempotency_key:recoveryDigest(['replacement-idempotency',id]),
    generation_enabled:false,provider_generation_calls:0,created_at:createdAt};
  return {...value,proposal_digest:recoveryDigest(value)};
}

export function assertReplacementProposal(p){
  const {proposal_digest,...value}=p||{};
  requireThat(p?.proposal_status==='REPLACEMENT_PROPOSAL'&&p.approval_required===true&&p.risk_acceptance===null
    &&p.generation_enabled===false&&p.new_reservation_status==='NOT_RESERVED'
    &&proposal_digest===recoveryDigest(value),'REPLACEMENT_PROPOSAL_INVALID');
  requireThat(new Set([p.original_operation_id,p.original_attempt_id,p.replacement_proposal_id,p.planned_operation_id,p.planned_attempt_id,p.planned_idempotency_key]).size===6,'REPLACEMENT_IDEMPOTENCY_COLLISION');
}

// Pure preflight for a future authorized implementation. Not an emission capability.
// Callers must load authenticated server-side grants, never request-body assertions.
export function replacementRiskGate({proposal:p,checkpoint,operation,journal,authorization,budget,riskGrant,quote,now=Date.now()}){
  assertReplacementProposal(p);
  const evidence=replacementEvidence({checkpoint,operation,journal,authorization});
  requireThat(Object.entries(evidence).every(([k,v])=>p[k]===v),'REPLACEMENT_EVIDENCE_CHANGED');
  const g=riskGrant;
  requireThat(g?.scope==='SUPERVISED_REPLACEMENT_DUPLICATE_RISK'&&g.status==='AUTHORIZED'&&g.decision==='APPROVED'
    &&g.episode_id===p.episode_id&&g.action_id===p.action_id&&g.original_operation_id===p.original_operation_id
    &&g.replacement_proposal_id===p.replacement_proposal_id&&g.proposal_digest===p.proposal_digest
    &&g.accepts_possible_duplicate_charge===true&&g.preserve_original_reservation===true
    &&g.max_new_provider_calls===1&&g.max_new_reservation_usd===p.maximum_new_reservation
    &&g.user_id===checkpoint.metadata.user&&g.authorization_reference&&Number.isFinite(Date.parse(g.authorized_at))
    &&Date.parse(g.authorized_at)<=now&&Date.parse(g.authorized_at)>=Date.parse(p.created_at)
    &&Date.parse(g.expires_at)>now,'REPLACEMENT_SPECIFIC_HUMAN_RISK_ACCEPTANCE_REQUIRED');
  requireThat(quote?.episode_id===p.episode_id&&quote.action_id===p.action_id&&quote.replacement_proposal_id===p.replacement_proposal_id
    &&quote.operation_id===p.planned_operation_id&&quote.attempt_id===p.planned_attempt_id&&quote.model===p.model
    &&quote.currency==='USD'&&quote.status==='QUOTED'&&/^[a-f0-9]{64}$/.test(quote.payload_sha256||'')
    &&typeof quote.quote_id==='string'&&quote.quote_id.length>0&&Date.parse(quote.expires_at)>now
    &&Date.parse(quote.created_at)<=now&&Date.parse(quote.created_at)>=Date.parse(p.created_at)
    &&Number.isFinite(quote.reserve_usd)&&Number.isFinite(quote.estimate_usd)&&quote.estimate_usd>0
    &&quote.reserve_usd>=quote.estimate_usd&&quote.reserve_usd<=p.maximum_new_reservation,'REPLACEMENT_FRESH_BOUND_QUOTE_REQUIRED');
  requireThat(Number(budget.episode_ceiling_usd)===Number(checkpoint.authorized_ceiling_usd)
    &&budget.required_total_usd===p.existing_episode_exposure_usd
    &&sumUsd([budget.required_total_usd,quote.reserve_usd])<=Number(checkpoint.authorized_ceiling_usd),'REPLACEMENT_DOUBLE_EXPOSURE_BUDGET_BLOCKED');
  return {status:'DRAFT_ONLY_NOT_EMISSION_AUTHORITY',operation_id:p.planned_operation_id,attempt_id:p.planned_attempt_id,
    idempotency_key:p.planned_idempotency_key,replaces_operation_id:p.original_operation_id,replacement_proposal_id:p.replacement_proposal_id,
    projected_episode_exposure_usd:sumUsd([budget.required_total_usd,quote.reserve_usd]),reserve_usd:quote.reserve_usd,
    emission_enabled:false,additional_runtime_requirements:['AUTHENTICATED_GRANT','CAS_RESERVATION_WITH_ORIGINAL_PRESERVED','ATOMIC_SINGLE_CLAIM','FINAL_QUOTE_AND_PAYLOAD_GUARD','JOURNAL_BEFORE_TRANSPORT','RESULT_RECOVERY','HUMAN_REVIEW']};
}

export function replacementPresentation({checkpoint:cp,state,budget,current_emission,supervised_replacement_ready=false}){
  const candidates=Object.values(state.supervised_replacement_proposals||{}).filter(p=>p.episode_id===cp.episode_id&&p.action_id===cp.first_pending_action);
  if(!candidates.length)return null;
  requireThat(candidates.length===1,'REPLACEMENT_PROPOSAL_CONFLICT');
  const p=candidates[0];assertReplacementProposal(p);
  const reservation=cp.metadata.budget_reservations?.[p.action_id];
  const valid=p.checkpoint_digest===recoveryDigest(cp)&&reservation?.attempt_id===p.original_attempt_id
    &&current_emission?.state==='EMISSION_UNKNOWN'&&current_emission?.attempt_id===p.original_attempt_id;
  const grant=state.supervised_replacement_grants?.[p.replacement_proposal_id],op=state.mini_app?.operations?.[p.planned_operation_id];
  const granted=grant?.status==='AUTHORIZED'&&grant.risk_disclosure_version===RISK_VERSION&&Date.parse(grant.expires_at)>Date.now();
  const originalVisible=!!state.production_commands?.[p.original_attempt_id]?.result?.provider_job_ids?.length;
  const confirmation=state.supervised_replacement_quote_claims?.[grant?.authorization_reference];
  const claimed=!!confirmation&&!(confirmation.status==='PREFLIGHT_FAILED'||confirmation.binding&&confirmation.status==='CLAIMED'&&Date.parse(confirmation.expires_at)<=Date.now());
  return {proposal_id:p.replacement_proposal_id,status:op?'REPLACEMENT_CLAIMED':valid?p.proposal_status:'EVIDENCE_CHANGED_REVIEW_REQUIRED',
    risk_review_available:supervised_replacement_ready&&valid&&!op&&!originalVisible,
    combined_exposure_usd:sumUsd([p.original_reserved_usd,p.maximum_new_reservation]),
    recover_available:supervised_replacement_ready&&!!(originalVisible||op&&current_emission?.state==='ACKNOWLEDGED'||!op&&current_emission?.request_id),
    risk_disclosure:supervised_replacement_ready?RISK_TEXT.replace('esta imagen',cp.actions.find(a=>a.key===p.action_id)?.stage==='VIDEO'?'este video':'esta imagen'):p.risk_disclosure,duplicate_risk:true,previous_reservation_usd:reservation?.amount_usd??null,
    estimated_new_reservation_usd:p.maximum_new_reservation,available_budget_usd:usd(Number(budget.episode_ceiling_usd)-budget.required_total_usd),
    projected_episode_exposure_usd:sumUsd([budget.required_total_usd,p.maximum_new_reservation]),
    authorization_reference:grant?.authorization_reference??null,
    consent_recorded:!!grant,consent_timestamp:grant?.consent_timestamp??null,consent_expires_at:grant?.expires_at??null,
    consent_expiration_reason:grant&&!granted?(grant.consent_contract_version===3?'EXPLICIT_24_HOUR_LIMIT':'LEGACY_CONSENT_BOUND_TO_SIGNED_CONTENT'):null,
    operation_status:op?.phase??'NOT_CREATED',confirmation_status:confirmation?.status??'NOT_STARTED',confirmation_outcome_unrecorded:!!confirmation&&!confirmation.binding&&!op,
    confirmation_error:confirmation?.error_code??null,generation_boundary:confirmation?.generation_boundary??(op?'JOURNAL_RECOVERY_REQUIRED':'NO_OPERATION'),
    authorization_status:grant?(granted?'HUMAN_RISK_ACCEPTANCE':'CONSENT_EXPIRED'):'NOT_GRANTED',quote_status:claimed?'QUOTE_CLAIMED':'FRESH_QUOTE_REQUIRED',
    new_reservation_status:op?'RESERVED_UNTIL_ACTUAL_CHARGE_VERIFIED':'NOT_RESERVED',
    generation_enabled:supervised_replacement_ready&&valid&&granted&&!claimed&&!op&&!originalVisible};
}
