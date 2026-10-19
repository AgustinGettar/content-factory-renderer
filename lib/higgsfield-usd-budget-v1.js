import { createHash } from 'node:crypto';

export const LUMI_BUDGET_UNIT = 'USD';
const SCALE = 1_000_000_000;
export function usd(value) {
  if (!['string', 'number'].includes(typeof value) || !/^\d+(\.\d{1,9})?$/.test(String(value))) throw new Error('usd_amount_invalid');
  const amount = Number(value);
  if (!Number.isSafeInteger(Math.round(amount * SCALE))) throw new Error('usd_amount_invalid');
  return amount;
}
export function sumUsd(values) { return values.reduce((total, value) => total + Math.round(usd(value) * SCALE), 0) / SCALE; }
// The estimate is not a price cap. For this prepaid-only action reserve the
// entire verified remaining wallet exposure, including any existing reservations.
export function firstImageAccountGate({evidence:e,apiKeySha,now=Date.now()}) {
  const fail=code=>{throw Error(code);};
  if(!e||e.source!=='VERIFIED_SAME_API_ACCOUNT'||!e.proof_reference||e.api_key_sha256!==apiKeySha
    ||!e.account_id)fail('Q41_SAME_API_ACCOUNT_UNVERIFIED');
  if(!Number.isFinite(Date.parse(e.checked_at))||Date.parse(e.checked_at)>now||now-Date.parse(e.checked_at)>60000
    ||!Number.isFinite(Date.parse(e.expires_at))||Date.parse(e.expires_at)<=now
    ||Date.parse(e.expires_at)>Date.parse(e.checked_at)+60000)fail('Q41_ACCOUNT_EVIDENCE_EXPIRED');
  if(e.prepaid_only!==true)fail('Q41_PREPAID_ONLY_UNVERIFIED');
  if(e.auto_recharge!==false)fail('Q41_AUTO_RECHARGE_NOT_VERIFIED_OFF');
  if(e.credit_billing!==false||e.negative_balance_allowed!==false)fail('Q41_NO_CREDIT_BILLING_UNVERIFIED');
  if(e.external_funding_locked!==true)fail('Q41_WALLET_EXPOSURE_NOT_BOUNDED');
  if(typeof e.balance_usd!=='number'||!Number.isFinite(e.balance_usd)||e.balance_usd<=0)fail('Q41_INSUFFICIENT_PREPAID_BALANCE');
  if(e.balance_usd>4.64)fail('Q41_PREPAID_EXPOSURE_EXCEEDS_AUTHORIZED_BALANCE');
  return {reserve_usd:usd(e.balance_usd),hard_episode_budget_usd:5,
    basis:'VERIFIED_PREPAID_WALLET_EXPOSURE_NOT_PRICE_CAP'};
}
export function firstImagePrepaidGate({evidence:e,apiKeySha,quote,payloadSha,payloadExpiresAt,now=Date.now()}) {
  const account=firstImageAccountGate({evidence:e,apiKeySha,now});
  const fail=code=>{throw Error(code);};
  if(!quote||quote.http_status!==200||quote.status!=='QUOTE_VERIFIED'||quote.payload_sha256!==payloadSha
    ||!Number.isFinite(Date.parse(quote.quote_timestamp))||Date.parse(quote.quote_timestamp)>now
    ||now-Date.parse(quote.quote_timestamp)>60000||!Number.isFinite(Date.parse(payloadExpiresAt))
    ||Date.parse(payloadExpiresAt)<=now||quote.quote_expiration&&(!Number.isFinite(Date.parse(quote.quote_expiration))||Date.parse(quote.quote_expiration)<=now))
    fail('Q41_CURRENT_EXACT_PAYLOAD_QUOTE_REQUIRED');
  const estimate=usd(quote.quote_usd),exposure=account.reserve_usd;
  if(!estimate||exposure<estimate)fail('Q41_INSUFFICIENT_PREPAID_BALANCE');
  return {status:'PASS',...account,estimate_usd:estimate,actual_cost_usd:null};
}
// Opt-in supervisory policy. This is an internal admission limit, never a
// provider charge guarantee. Billing assertions remain independently unverified.
export const SUPERVISED_BUDGET_POLICY='SUPERVISED_QUOTE_RESERVE_RECONCILE_V1';
export const RESERVATION_MULTIPLIER=1.25;
// Decimal arithmetic: round UP to micro-USD exactly, without floating-point
// artifacts at the consent boundary. This is an internal reserve, not a price cap.
export function supervisedReservation(value) {
  const nanos=BigInt(Math.round(usd(value)*SCALE));
  return Number((nanos*5n+3999n)/4000n)/1e6;
}
export function supervisedBudgetDecision({quote,payloadSha,payloadExpiresAt,maxReservationUsd=0.5,
  episodeCeilingUsd=null,existingExposureUsd=0,episodeId=null,actionId=null,now=Date.now()}) {
  const estimate=quote?.quote_usd==null?null:usd(quote.quote_usd),reserve=estimate===null?null:supervisedReservation(estimate);
  const maximum=usd(maxReservationUsd),ceiling=episodeCeilingUsd===null?null:usd(episodeCeilingUsd),exposure=usd(existingExposureUsd);
  const evidence={policy:SUPERVISED_BUDGET_POLICY,currency:'USD',episode_id:episodeId,action_id:actionId,
    quote_id:quote?.quote_id??null,quote_amount_usd:estimate,quote_timestamp:quote?.quote_timestamp??null,
    quote_expiration:quote?.quote_expiration??null,effective_expiration:payloadExpiresAt??null,
    payload_sha256:quote?.payload_sha256??null,quote_http_status:quote?.http_status??null,
    quote_provider_request_id:quote?.provider_request_id??null,quote_correlation_id:quote?.correlation_id??null,reservation_multiplier:RESERVATION_MULTIPLIER,
    calculated_reservation_usd:reserve,authorized_max_usd:maximum,episode_ceiling_usd:ceiling,
    existing_exposure_usd:exposure,episode_remaining_usd:ceiling===null?null:Math.round((ceiling-exposure)*SCALE)/SCALE,
    provider_charge_guaranteed:false,actual_cost_usd:null};
  const reject=(code,reason)=>({...evidence,status:'BLOCKED',error_code:code,reason});
  if(!quote||quote.status!=='QUOTE_VERIFIED'||quote.http_status!==200||quote.payload_sha256!==payloadSha
    ||!Number.isFinite(Date.parse(quote.quote_timestamp))||Date.parse(quote.quote_timestamp)>now
    ||now-Date.parse(quote.quote_timestamp)>60000||!Number.isFinite(Date.parse(payloadExpiresAt))
    ||Date.parse(payloadExpiresAt)<=now||quote.quote_expiration&&(!Number.isFinite(Date.parse(quote.quote_expiration))
      ||Date.parse(quote.quote_expiration)<=now))return reject('Q41_CURRENT_EXACT_PAYLOAD_QUOTE_REQUIRED','QUOTE_EXPIRED_OR_BINDING_INVALID');
  if(!estimate)return reject('BUDGET_POSITIVE_QUOTE_REQUIRED','ZERO_OR_MISSING_QUOTE');
  // Keep the legacy code for compatibility; it is not a shot identity.
  if(reserve>maximum)return reject('Q41_REQUEST_RESERVATION_LIMIT_EXCEEDED',estimate>maximum?'QUOTE_OVER_AUTHORIZED_MAX':'RESERVATION_MARGIN_OVER_AUTHORIZED_MAX');
  if(ceiling!==null&&sumUsd([exposure,reserve])>ceiling)return reject('BUDGET_EPISODE_LIMIT_EXCEEDED','EPISODE_EXPOSURE_OVER_CEILING');
  return {...evidence,status:'PASS',error_code:null,reason:'WITHIN_SPECIFIC_AND_EPISODE_LIMITS'};
}
export function assertBudgetDecision(decision){
  if(decision.status!=='PASS')throw Object.assign(Error(decision.error_code),{economic_decision:decision});
  return decision;
}
export function supervisedRequestGate(args) {
  const d=assertBudgetDecision(supervisedBudgetDecision(args));
  return {status:'PASS',basis:SUPERVISED_BUDGET_POLICY,estimate_usd:d.quote_amount_usd,reserve_usd:d.calculated_reservation_usd,
    economic_decision:d,actual_cost_usd:null,hard_episode_budget_usd:d.episode_ceiling_usd,provider_charge_guaranteed:false,
    provider_balance_usd:null,account_binding:'UNVERIFIED',no_credit_billing:'UNVERIFIED'};
}

// Read-only, evidence-based whole-episode planning in the existing Budget Gate.
// Missing USD evidence remains unknown (including character quotas and hosting).
// Quotes for different shots/payloads are never silently extrapolated.
export function episodeCostProjection({checkpoint:cp,budget,quotes=[],now=Date.now()}){
  const entries=cp.metadata?.episode_ledger?.entries||{},reuse=cp.metadata?.library_reuse||{};
  const items=cp.actions.filter(a=>['IMAGE','VIDEO','TTS'].includes(a.stage)).map(a=>{
    const applied=reuse[a.key],direct=applied?.reuse_mode==='DIRECT_MEDIA_REUSE'&&a.status==='COMPLETE'
      &&applied.target_episode_id===cp.episode_id&&applied.target_action===a.key&&!!applied.application_sha;
    const q=quotes.filter(q=>q?.episode_id===cp.episode_id&&(q.action_key??q.action_id)===a.key
      &&q.currency==='USD'&&Number.isFinite(q.quote_usd??q.estimate_usd??q.usd))
      .sort((a,b)=>Date.parse(b.quote_timestamp??b.created_at)-Date.parse(a.quote_timestamp??a.created_at))[0];
    const ledger=entries[a.key]?.estimated_cost;
    const estimate=q?.quote_usd??q?.estimate_usd??q?.usd??(ledger?.currency==='USD'?ledger.usd:null);
    const completed=a.status==='COMPLETE';
    const fresh=!!q&&Date.parse(q.expires_at)>now&&q.checkpoint_version===cp.metadata.runtime_revision;
    const saving=direct&&applied.expected_cost_impact?.basis==='EXISTING_CURRENT_QUOTE'?
      applied.expected_cost_impact.potential_saving_usd:null;
    return {action_id:a.key,stage:a.stage,completed,generation_required:!completed&&!direct,
      remaining_estimate_usd:completed?0:estimate,quote_id:q?.quote_id??null,
      price_basis:completed?'COMPLETED_NO_NEW_GENERATION':fresh?'CURRENT_BOUND_QUOTE':estimate!==null?'HISTORICAL_ESTIMATE_NOT_AUTHORIZATION':'UNKNOWN',
      direct_reuse:direct,potential_saving_usd:applied?.reuse_mode==='REFERENCE_REUSE'?0:applied?.expected_cost_impact?.potential_saving_usd??null,
      verified_saving_usd:saving};
  });
  for(const category of ['STORAGE','INFRASTRUCTURE']){
    const e=cp.metadata?.episode_ledger?.overhead_estimates?.[category];
    const amount=e?.currency==='USD'&&e.evidence_reference&&Number.isFinite(e.estimate_usd)&&e.estimate_usd>=0?e.estimate_usd:null;
    items.push({action_id:category.toLowerCase(),stage:category,completed:false,remaining_estimate_usd:amount,
      price_basis:amount===null?'UNKNOWN':'DOCUMENTED_ALLOCATION',evidence_reference:e?.evidence_reference??null});
  }
  const pending=items.filter(i=>!i.completed),known=pending.filter(i=>i.remaining_estimate_usd!==null);
  const subtotal=sumUsd(known.map(i=>i.remaining_estimate_usd)),complete=known.length===pending.length;
  const contingent=supervisedReservation(subtotal),exposure=budget.required_total_usd;
  const missing=pending.filter(i=>i.remaining_estimate_usd===null).map(i=>i.action_id);
  return {version:1,currency:'USD',status:!complete?'INCOMPLETE_COST_EVIDENCE':sumUsd([exposure,contingent])>budget.episode_ceiling_usd?'PLAN_EXCEEDS_BUDGET':'PLANNING_WITHIN_BUDGET',
    minimum_estimated_total_usd:complete?sumUsd([budget.current_confirmed_spend_usd,subtotal]):null,
    probable_total_usd:complete?sumUsd([exposure,subtotal]):null,
    projected_exposure_with_contingency_usd:complete?sumUsd([exposure,contingent]):null,
    known_remaining_subtotal_usd:subtotal,contingency_known_usd:Math.round((contingent-subtotal)*SCALE)/SCALE,
    maximum_authorized_usd:budget.episode_ceiling_usd,existing_exposure_usd:exposure,
    verified_spend_usd:budget.current_confirmed_spend_usd,
    uncertain_reserved_usd:Math.round((exposure-budget.current_confirmed_spend_usd)*SCALE)/SCALE,
    actual_total_cost_usd:null,missing_cost_evidence:missing,items,
    verified_savings_usd:items.some(i=>i.verified_saving_usd!==null&&i.verified_saving_usd!==undefined)?sumUsd(items.filter(i=>i.verified_saving_usd!=null).map(i=>i.verified_saving_usd)):null,
    generation_authorized:false,price_guarantee:false,
    next_action:complete?'REVIEW_REUSE_AND_CURRENT_QUOTES':'REVIEW_APPROVED_LIBRARY_AND_COMPLETE_MISSING_COST_EVIDENCE',
    quality_change_authorized:false,provider_change_authorized:false};
}

export function normalizeApiQuote(payload) {
  // Website/MCP credits are never a dollar quote or an API wallet balance.
  if (payload?.usd === undefined || payload?.usd === null) throw new Error('higgsfield_api_usd_quote_required');
  return { currency: LUMI_BUDGET_UNIT, estimated_cost_usd: usd(payload.usd), provider_units: payload.credits ?? null,
    provider_units_meaning: 'API_ESTIMATOR_UNITS_NOT_WORKSPACE_BALANCE' };
}
export async function estimateHiggsfieldUsd({ apiKey, model, input, fetchImpl = fetch, clock = () => new Date().toISOString() }) {
  if (!apiKey) throw new Error('higgsfield_api_credentials_missing');
  if (!/^[a-zA-Z0-9_.\/-]+$/.test(model) || model.includes('..')) throw new Error('higgsfield_model_invalid');
  const body = JSON.stringify(input);
  const response = await fetchImpl(`https://api.higgsfield.ai/estimate/${model}`, {
    method: 'POST', headers: { Authorization: `Key ${apiKey}`, 'Content-Type': 'application/json' }, body,
    signal: AbortSignal.timeout(30000),
  });
  const safeId = value => typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,128}$/.test(value) ? value : null;
  const receipt = { http_status: Number.isInteger(response.status) ? response.status : null,
    correlation_id:safeId(response.headers?.get?.('x-correlation-id')),
    provider_request_id: safeId(response.headers?.get?.('x-request-id')) || safeId(response.headers?.get?.('request-id')) };
  if (!response.ok) throw Object.assign(new Error(`higgsfield_usd_estimate_http_${response.status}`), { quote_receipt: receipt });
  let payload;
  try { payload = await response.json(); }
  catch { throw Object.assign(new Error('higgsfield_usd_estimate_response_invalid'), { quote_receipt: receipt }); }
  receipt.provider_request_id ||= safeId(payload?.request_id);
  let quote;
  try { quote = normalizeApiQuote(payload); }
  catch (error) {
    error.quote_receipt = receipt;
    error.quote_diagnostics = { response_keys: Object.keys(payload || {}).slice(0,30).filter(k=>/^[A-Za-z0-9_]{1,60}$/.test(k)),
      usd: /^(\d+)(\.\d{1,9})?$/.test(String(payload?.usd))?String(payload.usd):null };
    throw error;
  }
  const expiration = payload?.expires_at ?? payload?.quote_expiration;
  const quote_expiration = typeof expiration === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(expiration)
    && Number.isFinite(Date.parse(expiration)) ? new Date(expiration).toISOString() : null;
  return { provider: 'higgsfield_api', model, ...quote, ...receipt, quote_expiration, actual_cost_usd: null, quoted_at: clock(),
    payload_sha256: createHash('sha256').update(body).digest('hex') };
}
export function remainingUsdGate({ remainingCostUsd, reportedBalanceUsd = 9, verifiedBalanceUsd = null, reserveUsd = 1 }) {
  const balance = usd(verifiedBalanceUsd ?? reportedBalanceUsd);
  const basis = verifiedBalanceUsd === null ? 'USER_REPORTED_PLANNING_ONLY' : 'VERIFIED_API_USD_BALANCE';
  if (remainingCostUsd === null || remainingCostUsd === undefined) return { status: 'PENDING_USD_QUOTES', currency: 'USD',
    provider_balance_usd: verifiedBalanceUsd, planning_balance_usd: balance, balance_basis: basis, recommended_top_up_usd: null };
  const required = sumUsd([remainingCostUsd, reserveUsd]);
  return { status: required <= balance ? 'PASS' : 'HIGGSFIELD_USD_TOP_UP_REQUIRED', currency: 'USD',
    expected_remaining_cost_usd: usd(remainingCostUsd), reserve_usd: usd(reserveUsd), required_balance_usd: required,
    provider_balance_usd: verifiedBalanceUsd, planning_balance_usd: balance, balance_basis: basis,
    recommended_top_up_usd: Math.max(0, Math.round((required - balance) * SCALE) / SCALE) };
}
