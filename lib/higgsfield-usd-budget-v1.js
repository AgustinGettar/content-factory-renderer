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
  if (!response.ok) throw new Error(`higgsfield_usd_estimate_http_${response.status}`);
  const quote = normalizeApiQuote(await response.json());
  return { provider: 'higgsfield_api', model, ...quote, actual_cost_usd: null, quoted_at: clock(),
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
