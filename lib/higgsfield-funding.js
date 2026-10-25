import {createHash} from 'node:crypto';

// A generic failure, timeout, HTTP 402 or message alone is not evidence of zero funds.
export function higgsfieldFundingCode(payload){
 const code=payload?.error?.code??payload?.code;
 return ['insufficient_balance','insufficient_funds','credit_balance_exhausted','not_enough_credits'].includes(code)?code:null;
}
export const HIGGSFIELD_FUNDING_ERROR='HIGGSFIELD_INSUFFICIENT_BALANCE';
export const HIGGSFIELD_BILLING_ERROR='HIGGSFIELD_BILLING_CHECK_REQUIRED';
export function fundingPresentation(ctx){
 const {state,checkpoint:cp,current_emission:emission}=ctx;
 const stored=state.mini_app?.funding?.higgsfield||{},report=stored.owner_report;
 const a=cp.actions.find(a=>a.key===cp.first_pending_action),attempt=a?.active_attempt_id||emission?.attempt_id;
 const recovery=state.mini_app?.result_recovery?.[attempt];
 const rejected=emission?.failure_confirmed||[HIGGSFIELD_FUNDING_ERROR,HIGGSFIELD_BILLING_ERROR].includes(recovery?.error);
 const evidence=rejected?{id:createHash('sha256').update([attempt,recovery?.error||HIGGSFIELD_FUNDING_ERROR,recovery?.updated_at||emission?.accepted_at].join(':')).digest('hex'),at:recovery?.updated_at||emission?.accepted_at,code:recovery?.error}:stored.provider_notice;
 let status='UNKNOWN',source=null,at=null,id=null;
 if(report?.status==='EMPTY_REPORTED'){status='RECHARGE_REQUIRED';source='OWNER_REPORTED';at=report.reported_at;id=report.id;}
 else if(evidence&&!(report?.status==='RECHARGE_REPORTED'&&Date.parse(report.reported_at)>=Date.parse(evidence.at))){status=evidence.code===HIGGSFIELD_BILLING_ERROR?'CHECK_BILLING':'RECHARGE_REQUIRED';source=evidence.code===HIGGSFIELD_BILLING_ERROR?'PROVIDER_BILLING_RESPONSE':'PROVIDER_ERROR';at=evidence.at;id=evidence.id;}
 else if(report?.status==='RECHARGE_REPORTED'){status='RECHARGE_REPORTED';source='OWNER_REPORTED';at=report.reported_at;id=report.id;}
 return {provider:'higgsfield_api',status,source,observed_at:at,notice_id:id,blocks_generation:['RECHARGE_REQUIRED','CHECK_BILLING'].includes(status),balance_usd:null,balance_verified:false,billing_url:'https://open.higgsfield.ai/'};
}
export function recordFundingError(mini,error,at,id){
 if(![HIGGSFIELD_FUNDING_ERROR,HIGGSFIELD_BILLING_ERROR].includes(error))return;
 mini.funding||={};mini.funding.higgsfield||={};mini.funding.higgsfield.provider_notice={id,at,code:error};
}
