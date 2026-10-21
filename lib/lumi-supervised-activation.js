// Authenticated Recovery Manager adapter. No scheduler, retries or startup work.
import {createHmac,randomUUID,timingSafeEqual} from 'node:crypto';
import {assertMiniPrincipal,mutateMiniState} from './telegram-mini-app/auth.js';
import {assertReplacementProposal,replacementEvidence,recoveryDigest,replacementRiskGate,RISK_VERSION,RISK_TEXT} from './lumi-supervised-replacement.js';
import {journaledFetch,emissionBoundary} from './provider-emission-journal-v1.js';
import {assertBudgetDecision} from './higgsfield-usd-budget-v1.js';
const need=(ok,code)=>{if(!ok)throw Error(code);};
const iso=()=>new Date().toISOString();
export const CONSENT_VALIDITY_MS=24*60*60*1000;
const safeError=e=>/^[A-Za-z0-9_]{1,100}$/.test(e?.message||'')?e.message.toUpperCase():'REPLACEMENT_CONFIRMATION_FAILED';
const signature=(value,secret)=>createHmac('sha256',secret).update('lumi-supervised-risk-v2:'+recoveryDigest(value)).digest('hex');
function verifySeal(sealed,secret){
  const {seal,...value}=sealed||{},expected=signature(value,secret);
  need(typeof seal==='string'&&seal.length===64&&timingSafeEqual(Buffer.from(seal),Buffer.from(expected)),'REPLACEMENT_RISK_SEAL_INVALID');return value;
}
const sealed=(value,secret)=>({...value,seal:signature(value,secret)});
export const originalResultVisible=(journal,receipt,action)=>!!(journal?.provider_request_id||journal?.response_metadata?.accepted_result
  ||receipt?.result?.provider_job_ids?.length||receipt?.result?.artifacts?.length||action?.artifact||action?.provider_request_id);

export function installSupervisedActivation(adapter,{manager,reviewStore,journal,validateOwner,secret,buildPayload,openPayload,quotePayload,submitPayload,receiptsFor,recoverResult}){
  const load=async(principal,proposalId,{active=false}={})=>{
    assertMiniPrincipal(principal);
    const row=await reviewStore.get(principal.user),proposal=row?.state.supervised_replacement_proposals?.[proposalId];
    need(await validateOwner(principal.user,principal.chat)&&row?.state.chat_id===principal.chat
      &&row.state.mini_app?.sessions?.[principal.session]?.expires_at>Date.now(),'MINI_OWNER_REQUIRED');
    assertReplacementProposal(proposal);
    const checkpoint=await manager.store.getEpisode(proposal.episode_id);
    need(checkpoint?.metadata.user===principal.user&&row.state.episodes?.[proposal.episode_id]
      &&(row.state.mini_app.active_episode_id??proposal.episode_id)===proposal.episode_id,'REPLACEMENT_EPISODE_OWNER_REQUIRED');
    const operation=row.state.mini_app.operations[proposal.original_operation_id],original=await journal.get(proposal.original_attempt_id),
      authorization=row.state.v2_authorizations?.[proposal.original_authorization_id],action=checkpoint.actions.find(a=>a.key===proposal.action_id);
    const oldResult=originalResultVisible(original,row.state.production_commands?.[proposal.original_attempt_id],action?.active_attempt_id===proposal.original_attempt_id?action:null);
    if(!active){
      need(!oldResult,'REPLACEMENT_ORIGINAL_RESULT_RECOVERY_REQUIRED');
      const evidence=replacementEvidence({checkpoint,operation,journal:original,authorization});
      need(Object.entries(evidence).every(([k,v])=>proposal[k]===v),'REPLACEMENT_EVIDENCE_CHANGED');
      need(!row.state.mini_app.operations[proposal.planned_operation_id]&&!await journal.get(proposal.planned_attempt_id),'REPLACEMENT_ALREADY_CLAIMED');
    }
    return {row,proposal,checkpoint,operation,journal:original,authorization,action,oldResult,budget:await manager.budgetExposure({episodeId:proposal.episode_id})};
  };
  const transact=(principal,c,phase,extra={})=>manager.supervisedReplacementTransaction({phase,user_id:principal.user,session_id:principal.session,
    proposal_id:c.proposal.replacement_proposal_id,expected_revision:c.row.revision,checkpoint:c.checkpoint,original_journal:c.journal,
    original_operation:c.operation,original_authorization:c.authorization,...extra});
  const grantFor=c=>{
    const stored=c.row.state.supervised_replacement_grants?.[c.proposal.replacement_proposal_id];
    const g=verifySeal(stored,secret);
    need(g.user_id===c.checkpoint.metadata.user&&g.proposal_digest===c.proposal.proposal_digest
      &&g.risk_disclosure_version===RISK_VERSION,'REPLACEMENT_CURRENT_CONSENT_REQUIRED');
    need(Date.parse(g.expires_at)>Date.now(),'REPLACEMENT_CONSENT_EXPIRED');return {stored,g};
  };
  adapter.reviewSupervisedReplacement=async(principal,proposalId)=>{
    const c=await load(principal,proposalId),payload=await buildPayload(c,principal);
    const prior=c.row.state.supervised_replacement_grants?.[proposalId];
    if(prior?.proposal_digest===c.proposal.proposal_digest&&prior.max_new_reservation_usd===c.proposal.maximum_new_reservation&&Date.parse(prior.expires_at)>Date.now()){
      const {g}=grantFor(c);
      if(g.approved_content_fingerprint===payload.approved_content_fingerprint&&g.consent_contract_version===3)
        return {authorization_status:'HUMAN_RISK_ACCEPTANCE',consent_expires_at:g.expires_at,provider_calls:0,new_reservations:0};
    }
    const fresh=await load(principal,proposalId);
    need(recoveryDigest(fresh.checkpoint)===recoveryDigest(c.checkpoint),'REPLACEMENT_EVIDENCE_CHANGED');
    const expires=new Date(Math.min(Date.parse(payload.expires_at),Date.now()+180000,principal.expires_at)).toISOString();
    need(Date.parse(expires)>Date.now()+10000&&/^[a-f0-9]{64}$/.test(payload.approved_content_fingerprint||'')&&/^[a-f0-9]{64}$/.test(payload.payload_sha256),'REPLACEMENT_PAYLOAD_REQUIRED');
    const challenge=sealed({challenge_id:randomUUID(),user_id:principal.user,session_id:principal.session,proposal_id:proposalId,
      proposal_digest:c.proposal.proposal_digest,checkpoint_digest:recoveryDigest(c.checkpoint),original_operation_id:c.proposal.original_operation_id,
      episode_id:c.proposal.episode_id,shot_id:c.proposal.shot_id,action_id:c.proposal.action_id,payload_sha256:payload.payload_sha256,
      maximum_reservation_usd:c.proposal.maximum_new_reservation,risk_disclosure_version:RISK_VERSION,
      consent_contract_version:3,approved_content_fingerprint:payload.approved_content_fingerprint,
      consent_expires_at:new Date(Date.now()+CONSENT_VALIDITY_MS).toISOString(),
      private_payload:payload.private_payload,created_at:iso(),expires_at:expires},secret);
    return {challenge,risk_disclosure:RISK_TEXT.replace('esta imagen',c.action.stage==='VIDEO'?'este video':'esta imagen'),
      previous_reservation_usd:c.proposal.original_reserved_usd,maximum_reservation_usd:c.proposal.maximum_new_reservation,
      combined_exposure_usd:c.proposal.potential_duplicate_cost.combined_q42_or_action_exposure_usd,
      available_budget_usd:c.budget.episode_ceiling_usd-c.budget.required_total_usd,hard_budget_usd:c.budget.episode_ceiling_usd,
      authorization_status:'NOT_GRANTED',provider_calls:0,new_reservations:0};
  };
  adapter.acceptSupervisedReplacement=async(principal,body)=>{
    need(Object.keys(body).sort().join(',')==='accept_duplicate_risk,challenge'&&body.accept_duplicate_risk===true,'REPLACEMENT_EXPLICIT_RISK_REQUIRED');
    const v=verifySeal(body.challenge,secret);
    need(v.user_id===principal.user&&v.session_id===principal.session&&Date.parse(v.expires_at)>Date.now()
      &&v.risk_disclosure_version===RISK_VERSION,'REPLACEMENT_CHALLENGE_EXPIRED_OR_FOREIGN');
    const c=await load(principal,v.proposal_id);
    need(v.checkpoint_digest===recoveryDigest(c.checkpoint)&&v.proposal_digest===c.proposal.proposal_digest,'REPLACEMENT_EVIDENCE_CHANGED');
    const existing=c.row.state.supervised_replacement_grants?.[v.proposal_id];
    need(!c.row.state.supervised_replacement_consent_history?.[v.challenge_id]||existing?.authorization_reference===v.challenge_id,'REPLACEMENT_CONSENT_REPLAY');
    if(existing?.authorization_reference===v.challenge_id)return {status:'HUMAN_RISK_ACCEPTANCE',already_applied:true,provider_calls:0,new_reservations:0};
    const timestamp=iso(),grant=sealed({scope:'SUPERVISED_REPLACEMENT_DUPLICATE_RISK',status:'AUTHORIZED',decision:'APPROVED',
      replacement_proposal_id:v.proposal_id,proposal_digest:v.proposal_digest,original_operation_id:v.original_operation_id,
      episode_id:v.episode_id,shot_id:v.shot_id,action_id:v.action_id,payload_sha256:v.payload_sha256,
      max_new_reservation_usd:v.maximum_reservation_usd,maximum_reservation_usd:v.maximum_reservation_usd,risk_disclosure_version:RISK_VERSION,
      human_identity:principal.user,user_id:principal.user,session_id:principal.session,consent_timestamp:timestamp,authorized_at:timestamp,
      consent_contract_version:v.consent_contract_version,approved_content_fingerprint:v.approved_content_fingerprint,
      expires_at:v.consent_expires_at||v.expires_at,authorization_reference:v.challenge_id,accepts_possible_duplicate_charge:true,preserve_original_reservation:true,
      max_new_provider_calls:1,private_payload:v.private_payload},secret);
    await transact(principal,c,'ACCEPT',{grant});
    return {status:'HUMAN_RISK_ACCEPTANCE',provider_calls:0,new_reservations:0};
  };
  const confirmReplacement=async(principal,body,{quoteOnly=false}={})=>{
    need(Object.keys(body).sort().join(',')==='authorization_reference,confirm,confirmation_id,proposal_id'&&body.confirm===true&&/^[a-f0-9-]{36}$/.test(body.confirmation_id||''),'REPLACEMENT_EXPLICIT_GENERATION_REQUIRED');
    let c=await load(principal,body.proposal_id);const {stored,g}=grantFor(c),p=c.proposal;
    need(body.authorization_reference===g.authorization_reference,'REPLACEMENT_CONSENT_CHANGED');
    // Renew only transport, never consent. A changed content fingerprint needs
    // another human decision, even when its price happens to be unchanged.
    let material=g.consent_contract_version===3?await buildPayload(c,principal):
      {private_payload:g.private_payload,payload_sha256:g.payload_sha256,expires_at:g.expires_at};
    if(g.consent_contract_version===3)need(material.approved_content_fingerprint===g.approved_content_fingerprint,'REPLACEMENT_APPROVED_CONTENT_CHANGED');
    need(Date.parse(material.expires_at)>Date.now()+10000,'REPLACEMENT_PAYLOAD_EXPIRED');
    c=await load(principal,p.replacement_proposal_id);
    const claim=sealed({claim_id:body.confirmation_id,authorization_reference:g.authorization_reference,
      payload_sha256:material.payload_sha256,approved_content_fingerprint:g.approved_content_fingerprint||null,
      created_at:iso(),expires_at:new Date(Math.min(Date.now()+60000,Date.parse(material.expires_at),Date.parse(g.expires_at))).toISOString()},secret);
    await transact(principal,c,'QUOTE_CLAIM',{grant:stored,quote_claim:claim});
    let phase='QUOTE',quote;
    try{
    const payload=openPayload(material.private_payload,p.replacement_proposal_id);
    quote=await quotePayload(c,{...g,payload_sha256:material.payload_sha256,expires_at:claim.expires_at},payload);
    quote={...quote,quote_claim_id:claim.claim_id,approved_content_fingerprint:g.approved_content_fingerprint||null};
    const decision=await manager.requestCostDecision({episodeId:p.episode_id,actionKey:p.action_id,quote,
      payloadSha:material.payload_sha256,payloadExpiresAt:claim.expires_at,maximumReservationUsd:p.maximum_new_reservation});
    quote={...quote,economic_decision:decision};
    // Persist successful AND rejected estimates before any reserve/journal claim.
    // A quote-only request has no path to ACTIVATE or provider dispatch.
    await transact(principal,c,'QUOTE_RESULT',{grant:stored,quote_claim:claim,quote,quote_only:quoteOnly});
    if(quoteOnly)return {status:'QUOTE_RECORDED',economic_decision:decision,provider_calls:0,new_reservations:0};
    assertBudgetDecision(decision);
    c=await load(principal,p.replacement_proposal_id);
    need(recoveryDigest(c.row.state.supervised_replacement_grants?.[p.replacement_proposal_id])===recoveryDigest(stored)
      &&quote.payload_sha256===material.payload_sha256,'REPLACEMENT_CONSENT_CHANGED');
    phase='PREFLIGHT';
    replacementRiskGate({...c,proposal:p,riskGrant:g,quote});
    const receipts=receiptsFor(principal.user);
    const boundStore={get:id=>journal.get(id),prepare:record=>{phase='ACTIVATE';return transact(principal,c,'ACTIVATE',{grant:stored,quote,record,quote_claim:claim});},
      transition:async(id,from,patch)=>{
        if(from==='PREPARED'){phase='DISPATCH';return manager.supervisedReplacementTransaction({phase:'DISPATCH',user_id:principal.user,session_id:principal.session,
          proposal_id:p.replacement_proposal_id,attempt_id:id,grant:stored,quote,patch,quote_claim:claim});}
        return journal.transition(id,from,patch);
      }};
    const submit=journaledFetch({store:boundStore,context:{episode_id:p.episode_id,scene_id:p.shot_id,stage:c.action.stage,
      attempt_id:p.planned_attempt_id,provider:p.provider,model:p.model,expected_cost_usd:quote.estimate_usd,
      original_attempt_snapshot:{supervised_replacement_of:p.original_attempt_id,original_operation_id:p.original_operation_id,proposal_id:p.replacement_proposal_id},
      potential_unconfirmed_cost_exposure:p.potential_duplicate_cost},descriptor:{identity:{operation_id:p.planned_operation_id,proposal_id:p.replacement_proposal_id,
        payload_sha256:material.payload_sha256,idempotency_key:p.planned_idempotency_key,quote_id:quote.quote_id,
        reservation_id:'replacement:'+p.planned_attempt_id}},
      dispatchGuard:()=>need(Date.parse(quote.expires_at)>Date.now()&&Date.parse(g.expires_at)>Date.now()&&Date.parse(claim.expires_at)>Date.now(),'REPLACEMENT_QUOTE_EXPIRED'),
      persistResponse:async accepted=>{
        phase='RESULT_PERSISTENCE';
        if(!accepted.request_id||!accepted.status_url)return;
        const prior=await receipts.get(p.planned_attempt_id);
        await receipts.record(p.planned_attempt_id,{...prior,status:'WAITING',result:{status:'IN_PROGRESS',episode_id:p.episode_id,stage_id:c.action.stage,
          artifacts:[],provider_job_ids:[accepted.request_id],claims:[p.planned_attempt_id],estimated_cost:{currency:'USD',usd:quote.estimate_usd},
          actual_cost:null,qa:null,human_review_requirement:false,next_action:'POLL_SAME_JOB',output:accepted}});
      },fetchImpl:(...args)=>{phase='PROVIDER';return submitPayload.fetch(...args);}});
      phase='SUBMIT';
      await submitPayload({proposal:p,payload,submit:async(url,options)=>{
        const headers=new Headers(options.headers);headers.set('Idempotency-Key',p.planned_idempotency_key);
        return submit(url,{...options,headers});
      }});
      await mutateMiniState(reviewStore,principal.user,m=>Object.assign(m.operations[p.planned_operation_id],{status:'WAITING',phase:'GENERATING'}));
      return {status:'WAITING_EXISTING_RESULT',provider_calls:1};
    }catch(error){
      // Persist a safe diagnostic and fenced outcome even when no operation was
      // created. Never clear a journal/reservation, and never replay transport.
      const code=safeError(error);
      try{await manager.supervisedReplacementTransaction({phase:'CONFIRMATION_OUTCOME',user_id:principal.user,session_id:principal.session,
        proposal_id:p.replacement_proposal_id,grant:stored,quote_claim:claim,error_code:code,error_phase:phase,
        database_code:/^[A-Z0-9]{5}$/.test(error.database_code||'')?error.database_code:null,
        quote_receipt:error.quote_receipt?{http_status:error.quote_receipt.http_status,provider_request_id:error.quote_receipt.provider_request_id}:null});}
      catch{console.warn(JSON.stringify({event:'lumi_supervised_confirmation_diagnostic_unavailable',proposal_id:p.replacement_proposal_id,code}));}
      console.warn(JSON.stringify({event:'lumi_supervised_confirmation_failed',proposal_id:p.replacement_proposal_id,phase,code}));
      error.message=code;
      throw error;
    }
  };
  adapter.generateSupervisedReplacement=(principal,body)=>confirmReplacement(principal,body);
  adapter.quoteSupervisedReplacement=(principal,body)=>confirmReplacement(principal,body,{quoteOnly:true});
  adapter.recoverSupervisedReplacement=async(principal,proposalId)=>{
    const c=await load(principal,proposalId,{active:true}),p=c.proposal;
    const replacement=await journal.get(p.planned_attempt_id);
    if(c.oldResult&&(!replacement||emissionBoundary(replacement)==='NOT_EMITTED')){
      await manager.supervisedReplacementTransaction({phase:'SELECT_ORIGINAL',user_id:principal.user,session_id:principal.session,proposal_id:p.replacement_proposal_id});
      return recoverResult(principal,c,p.original_attempt_id);
    }
    need(replacement,'REPLACEMENT_ACCEPTED_RESULT_REQUIRED');
    // Both records remain visible if the original appears after the emission claim.
    const result=await recoverResult(principal,c,p.planned_attempt_id);
    if(!['WAITING_EXISTING_RESULT','IN_PROGRESS'].includes(result.status))await mutateMiniState(reviewStore,principal.user,m=>Object.assign(m.operations[p.planned_operation_id],{status:'COMPLETE',phase:'REVIEW_READY',finished_at:iso()}));
    return {...result,possible_duplicate_charge:true,original_result_visible:c.oldResult};
  };
  return adapter;
}
