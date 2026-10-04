import { createClient } from '@supabase/supabase-js';
import { estimateHiggsfieldUsd, remainingUsdGate, sumUsd } from './higgsfield-usd-budget-v1.js';
import { loadThirdShortProductionScenes, thirdShortImagePrompt, thirdShortVideoContract, THIRD_SHORT_MEDIA } from './lumi-third-short-media-v1.js';
import { compileHiggsfieldPromptV2 } from './video-generation-readiness-v2.js';
import { LUMI_CHARACTER_LOCK_V1 } from './asset-v2/character-lock.js';
import { fetchCanonicalReference } from './asset-v2/visual-benchmark-runner.js';

// Read-only cost discovery. No generation endpoint, claim, ledger mutation or resume.
export async function runHiggsfieldUsdPreflight({ env = process.env, fetchImpl = fetch, logger = console } = {}) {
  if (env.LUMI_RUNTIME_ENV !== 'staging') throw new Error('higgsfield_usd_preflight_staging_only');
  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const production = await loadThirdShortProductionScenes(supabase);
  await fetchCanonicalReference({ supabaseUrl: env.SUPABASE_URL, fetchImpl });
  const reference = LUMI_CHARACTER_LOCK_V1.canonical_lumi_reference;
  const refUrl = `${env.SUPABASE_URL}/storage/v1/object/public/${reference.storage_bucket}/${reference.object_path}`;
  const { data: rows, error } = await supabase.from('lumi_pilot_runs').select('scene_id,status,storage_bucket,storage_path,result,provider_calls')
    .eq('pilot_id', THIRD_SHORT_MEDIA.pilotId).eq('stage', 'IMAGE');
  if (error) throw new Error('higgsfield_usd_preflight_sources_read_failed');
  const report = { event: 'lumi_higgsfield_usd_preflight', episode_id: 'ep_lumi_flores_003', currency: 'USD',
    generation_calls: 0, provider_balance_usd: null, user_reported_balance_approx_usd: 9,
    confirmed_existing_spend_usd: 0.591597, episode_ceiling_usd: 3.05, HIGGSFIELD_CONFIRMED_COST_USD: 0,
    historical_incident_resolution: 'FALSE_POSITIVE_BALANCE_INTERPRETATION',
    root_cause: 'connector credits field was treated as API USD balance', image_quotes: [], video_quotes: [],
    tts_status: 'API_USD_ENDPOINT_AND_VOICE_NOT_VERIFIED', USD_TTS_BENCHMARK: null, USD_FULL_TTS: null };
  const quote = async (scene, stage, model, input, basis) => {
    try { return { scene: scene.id, stage, basis, ...await estimateHiggsfieldUsd({ apiKey: env.HF_API_KEY, model, input, fetchImpl }) }; }
    catch (error) { return { scene: scene.id, stage, model, basis, error: error.message, quote_diagnostics: error.quote_diagnostics ?? null }; }
  };
  for (const scene of production.scenes.slice(6)) {
    report.image_quotes.push(await quote(scene, 'IMAGE', 'marketing-studio/image/flare', {
      prompt: thirdShortImagePrompt(scene), image_urls: [refUrl], quality: 'high', resolution: '2k',
      aspect_ratio: '9:16', moderation: 'auto', enhance_prompt: false,
    }, 'EXACT_PLANNED_IMAGE_REQUEST'));
  }
  for (const scene of production.scenes) {
    const source = rows.find(row => row.scene_id === scene.id && row.status === 'SUCCEEDED');
    let sourceUrl = refUrl;
    if (source?.storage_path) {
      const signed = await supabase.storage.from(source.storage_bucket).createSignedUrl(source.storage_path, 3600);
      if (signed.error) throw new Error('higgsfield_usd_source_sign_failed');
      sourceUrl = signed.data.signedUrl;
    }
    // Cost discovery compiles the contract; it never declares source readiness PASS.
    const compiled = compileHiggsfieldPromptV2(thirdShortVideoContract(scene));
    const prompt = `${compiled.text}\n\n[COLOR_TEMPORAL_LOCK]\nRed stays canonical clear red. Yellow stays canonical clear yellow. Blue stays canonical clear blue. No hue drift, duplication, disappearance, fusion, petal morphing, or flower motion.\n\n[SCENE_MOTION]\n${scene.motion}`;
    report.video_quotes.push(await quote(scene, 'VIDEO', THIRD_SHORT_MEDIA.videoModel.model,
      { ...THIRD_SHORT_MEDIA.videoModel.input, prompt, image_url: sourceUrl },
      source ? 'EXISTING_SOURCE_CONFIGURATION' : 'CONFIGURATION_FORECAST_SOURCE_NOT_GENERATED'));
  }
  for (const item of report.image_quotes) report[`USD_${item.scene}`] = item.estimated_cost_usd ?? null;
  report.USD_IMAGES_REMAINING = report.image_quotes.every(x => x.estimated_cost_usd !== undefined) ? sumUsd(report.image_quotes.map(x => x.estimated_cost_usd)) : null;
  report.USD_KLING_TOTAL = report.video_quotes.every(x => x.estimated_cost_usd !== undefined) ? sumUsd(report.video_quotes.map(x => x.estimated_cost_usd)) : null;
  report.USD_VISUALS_REMAINING = [report.USD_IMAGES_REMAINING, report.USD_KLING_TOTAL].every(x => x !== null) ? sumUsd([report.USD_IMAGES_REMAINING, report.USD_KLING_TOTAL]) : null;
  report.USD_EPISODE_REMAINING = null;
  report.visual_gate = remainingUsdGate({ remainingCostUsd: report.USD_VISUALS_REMAINING });
  report.episode_gate = remainingUsdGate({ remainingCostUsd: report.USD_EPISODE_REMAINING });
  logger.info(JSON.stringify(report));
  return report;
}
