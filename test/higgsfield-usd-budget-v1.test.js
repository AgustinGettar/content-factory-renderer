import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeApiQuote, estimateHiggsfieldUsd, remainingUsdGate, sumUsd } from '../lib/higgsfield-usd-budget-v1.js';
test('workspace credits alone are never a USD quote', () => {
  assert.throws(() => normalizeApiQuote({ credits: 10 }), /usd_quote_required/);
  assert.equal(normalizeApiQuote({ credits: '7.5', usd: '0.231' }).estimated_cost_usd, 0.231);
});
test('fresh estimator receives the generation payload and emits no generation', async () => {
  const input = { duration: 5, sound: 'off', image_url: 'https://example.com/source.png' };
  const quote = await estimateHiggsfieldUsd({ apiKey: 'test-only', model: 'kling-video/v3.0/std/image-to-video', input,
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://api.higgsfield.ai/estimate/kling-video/v3.0/std/image-to-video');
      assert.deepEqual(JSON.parse(options.body), input);
      return { ok: true, json: async () => ({ usd: '0.231000', credits: '7.5' }) };
    } });
  assert.equal(quote.actual_cost_usd, null);
  assert.equal(quote.provider_units, '7.5');
});
test('reported USD balance is planning only and reserve equality passes', () => {
  const result = remainingUsdGate({ remainingCostUsd: 8 });
  assert.equal(result.status, 'PASS');
  assert.equal(result.provider_balance_usd, null);
  assert.equal(result.balance_basis, 'USER_REPORTED_PLANNING_ONLY');
  assert.equal(remainingUsdGate({ remainingCostUsd: 8.000001 }).recommended_top_up_usd, 0.000001);
});
test('missing TTS quote cannot authorize execution', () => {
  assert.equal(remainingUsdGate({ remainingCostUsd: null }).status, 'PENDING_USD_QUOTES');
});
test('precision preserved and invalid currency values rejected', () => {
  assert.equal(sumUsd([0.0985995, 0.0985995]), 0.197199);
  for (const usd of [-1, NaN, Infinity, null, 'credits:10']) assert.throws(() => normalizeApiQuote({ usd }));
});
