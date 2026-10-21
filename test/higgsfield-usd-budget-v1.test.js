import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeApiQuote, estimateHiggsfieldUsd, remainingUsdGate, sumUsd } from '../lib/higgsfield-usd-budget-v1.js';
import {supervisedReservation,supervisedBudgetDecision,supervisedRequestGate,episodeCostProjection} from '../lib/higgsfield-usd-budget-v1.js';
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
test('RESERVATION_MULTIPLIER / QUOTE_OVER_LIMIT: decimal boundary and separate episode/specific limits',()=>{
  const now=Date.now(),payloadSha='a'.repeat(64),quote={status:'QUOTE_VERIFIED',http_status:200,payload_sha256:payloadSha,
    quote_usd:.262,quote_timestamp:new Date(now).toISOString(),quote_id:'mock-q'};
  const input={quote,payloadSha,payloadExpiresAt:new Date(now+30000).toISOString(),maxReservationUsd:.3275,episodeCeilingUsd:8,existingExposureUsd:1.22625,now};
  assert.equal(supervisedRequestGate(input).reserve_usd,.3275);
  assert.equal(supervisedReservation(.000172),.000215); // old float ceil incorrectly reserved .000216
  const over=supervisedBudgetDecision({...input,quote:{...quote,quote_usd:.271}});
  assert.equal(over.calculated_reservation_usd,.33875);assert.equal(over.episode_remaining_usd,6.77375);
  assert.equal(over.reason,'RESERVATION_MARGIN_OVER_AUTHORIZED_MAX');
  assert.throws(()=>supervisedRequestGate({...input,quote:{...quote,quote_usd:.4}}),e=>e.economic_decision.reason==='QUOTE_OVER_AUTHORIZED_MAX');
  assert.equal(supervisedBudgetDecision({...input,existingExposureUsd:7.8}).reason,'EPISODE_EXPOSURE_OVER_CEILING');
  assert.equal(supervisedBudgetDecision({...input,quote:{...quote,quote_usd:0}}).reason,'ZERO_OR_MISSING_QUOTE');
  assert.equal(supervisedBudgetDecision({...input,payloadSha:'b'.repeat(64)}).status,'BLOCKED');
  assert.equal(supervisedBudgetDecision({...input,now:now+31000}).status,'BLOCKED');
});
test('FULL_EPISODE_COST_ESTIMATE / DIRECT_MEDIA_REUSE: complete categories, unknown USD, no fabricated savings',()=>{
  const cp={episode_id:'ep006_cost',actions:[{key:'image:s1',stage:'IMAGE',status:'COMPLETE'},{key:'video:s1',stage:'VIDEO',status:'PENDING'},{key:'tts',stage:'TTS',status:'PENDING'}],metadata:{runtime_revision:1,
    episode_ledger:{entries:{'video:s1':{estimated_cost:{currency:'USD',usd:.5}},tts:{estimated_cost:{currency:'ELEVENLABS_CHARACTER_QUOTA',units:500}}}},library_reuse:{'image:s1':{reuse_mode:'REFERENCE_REUSE',target_episode_id:'ep006_cost',target_action:'image:s1',application_sha:'a',expected_cost_impact:{basis:'EXISTING_CURRENT_QUOTE',potential_saving_usd:.2}}}}};
  const budget={required_total_usd:1,current_confirmed_spend_usd:.25,episode_ceiling_usd:8};
  let p=episodeCostProjection({checkpoint:cp,budget});assert.equal(p.probable_total_usd,null);assert.equal(p.minimum_estimated_total_usd,.75);
  assert.deepEqual(p.missing_cost_evidence,['tts','storage','infrastructure']);assert.equal(p.known_remaining_subtotal_usd,.5);assert.equal(p.verified_savings_usd,null);
  cp.metadata.library_reuse['image:s1'].reuse_mode='DIRECT_MEDIA_REUSE';
  cp.metadata.episode_ledger.entries.tts.estimated_cost={currency:'USD',usd:.1};
  cp.metadata.episode_ledger.overhead_estimates={STORAGE:{currency:'USD',estimate_usd:.01,evidence_reference:'synthetic-allocation'},INFRASTRUCTURE:{currency:'USD',estimate_usd:.02,evidence_reference:'synthetic-allocation'}};
  p=episodeCostProjection({checkpoint:cp,budget});assert.equal(p.status,'PLANNING_WITHIN_BUDGET');assert.equal(p.probable_total_usd,1.63);
  assert.equal(p.projected_exposure_with_contingency_usd,1.7875);assert.equal(p.verified_savings_usd,.2);assert.equal(p.uncertain_reserved_usd,.75);
  assert.equal(p.items[0].remaining_estimate_usd,0);assert.equal(p.generation_authorized,false);assert.equal(p.price_guarantee,false);
  assert.equal(episodeCostProjection({checkpoint:cp,budget:{...budget,episode_ceiling_usd:1.7}}).status,'PLAN_EXCEEDS_BUDGET');
});

test('FULL_EPISODE_FORECAST: historical model rates are labeled assumptions across episodes, never current prices or free voice',()=>{
 const cp={episode_id:'ep006',actions:[{key:'image:s1',stage:'IMAGE',scene_id:'s1',status:'PENDING'},{key:'video:s1',stage:'VIDEO',scene_id:'s1',status:'PENDING'},{key:'tts',stage:'TTS',status:'PENDING'}],metadata:{generic_v2:{shot_plans:[{shot_id:'s1',duration:5}]}}};
 const budget={required_total_usd:0,current_confirmed_spend_usd:0,episode_ceiling_usd:8};
 const quotes=[{episode_id:'ep004',action_id:'image:q42',model:'marketing-studio/image',currency:'USD',estimate_usd:.276,quote_id:'historical-image'},
 {episode_id:'ep004',action_key:'video:q41',model:'kling-video/v3.0/pro/image-to-video',currency:'USD',quote_usd:.448,duration:4,quote_id:'historical-video'}];
 const p=episodeCostProjection({checkpoint:cp,budget,quotes});assert.equal(p.items[0].remaining_estimate_usd,.276);assert.equal(p.items[1].remaining_estimate_usd,.56);
 assert.equal(p.items[0].price_basis,'HISTORICAL_MODEL_RATE_ASSUMPTION');assert.equal(p.items[0].reference_episode_id,'ep004');
 quotes[1].quote_usd=.44;cp.metadata.generic_v2.shot_plans[0].duration=3;assert.equal(episodeCostProjection({checkpoint:cp,budget,quotes}).items[1].remaining_estimate_usd,.33);
 assert.equal(p.items[2].remaining_estimate_usd,null);assert.equal(p.probable_total_usd,null);assert.equal(p.generation_authorized,false);assert.equal(p.verified_savings_usd,null);
});
