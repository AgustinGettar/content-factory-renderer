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
    error.quote_diagnostics = { response_keys: Object.keys(payload || {}),
      usd: payload?.usd ?? null, credits: payload?.credits ?? null,
      cost: payload?.cost ?? null, pricing: payload?.pricing ?? null };
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
