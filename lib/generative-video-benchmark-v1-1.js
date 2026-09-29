import {
  GENERATIVE_VIDEO_BUCKET,
  buildModelInput,
  compileGenerativeVideoPromptV1,
  ensureBucket,
  loadCanonicalSourceBySpec,
  parseEstimateUsd,
  pollRequest,
  providerJson,
  readJsonObject,
  sha256,
  uploadObject,
  writeJsonObject,
} from "./generative-video-benchmark-v1.js";

export const GENERATIVE_VIDEO_BENCHMARK_V11 = "generative-video-benchmark/1.1";
export const GENERATIVE_VIDEO_V11_PREFIX = "generative-video-benchmark-v1-1";
export const GENERATIVE_VIDEO_V11_MAX_USD = 1;
export const GENERATIVE_VIDEO_V11_CALL_CAP = 2;
export const GENERATIVE_VIDEO_V11_MODEL = Object.freeze({
  model: "kling-video/v3.0/std/image-to-video",
  input: Object.freeze({ duration: 5, sound: "off", multi_shots: false, cfg_scale: 0.5 }),
});

export const GENERATIVE_VIDEO_V11_SCENES = Object.freeze([
  Object.freeze({
    scene_id: "s11",
    artifact_id: "090490f8-0e75-47ca-8a2c-5f3340c7f413",
    variant: "visual_benchmark_v1",
    sha256: "b069f9d7c6ff086708d57e126a3342ed820dc58d58f730f9abd0c1faf65483d4",
    width: 1152,
    height: 2048,
  }),
  Object.freeze({
    scene_id: "s12",
    artifact_id: "090490f8-0e75-47ca-8a2c-5f3340c7f413",
    variant: "visual_benchmark_v1_1",
    sha256: "941fa2a6103b61baacde91dff406b6bf89e2d274c79be97e16ea1cb0cf094d4a",
    width: 1152,
    height: 2048,
  }),
]);

function sceneBase(scene, promptHash) {
  return `${GENERATIVE_VIDEO_V11_PREFIX}/${scene.scene_id}/${GENERIC_MODEL_SLUG}/${promptHash}`;
}

const GENERIC_MODEL_SLUG = GENERATIVE_VIDEO_V11_MODEL.model.replaceAll("/", "__");

function availableBalance(payload) {
  for (const candidate of [payload?.balance_usd, payload?.available_usd, payload?.balance?.usd]) {
    if (candidate === null || candidate === undefined || candidate === "") continue;
    const parsed = Number(candidate);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return null;
}

function pricingFields(payload) {
  const fields = Object.fromEntries(Object.entries(payload || {})
    .filter(([key, value]) => /cost|price|usd|credit|discount/i.test(key)
      && ["string", "number", "boolean"].includes(typeof value)));
  if (payload?.cost && typeof payload.cost === "object") fields.cost = payload.cost;
  return fields;
}

async function registerS17HumanReview(supabase) {
  await writeJsonObject(supabase, "generative-video-benchmark-v1/s17/human-creative-review-v1.json", {
    review_version: "human-creative-review/1",
    status: "passed",
    generative_video_feasible: true,
    primary_candidate: "kling-video/v3.0/std/image-to-video",
    provider_final: false,
    seedance_assessment: "better_than_motion_v1_1_but_too_restrained",
    kling_assessment: "excellent_natural_living_animation_at_target_quality",
    recorded_at: new Date().toISOString(),
  });
}

export async function preflightGenerativeVideoBenchmarkV11({
  supabase,
  apiKey,
  balanceConfirmed = false,
  maxUsd = GENERATIVE_VIDEO_V11_MAX_USD,
  fetchImpl = fetch,
}) {
  if (!supabase) throw new Error("generative_video_storage_not_configured");
  if (!apiKey) return { ready: false, api_key_configured: false, auth_verified: false };
  await ensureBucket(supabase);
  await registerS17HumanReview(supabase);
  const scenes = [];
  let apiBalance = null;
  let providerCallsSoFar = 0;
  for (const sourceSpec of GENERATIVE_VIDEO_V11_SCENES) {
    const source = await loadCanonicalSourceBySpec(supabase, sourceSpec);
    const prompt = compileGenerativeVideoPromptV1(sourceSpec.scene_id);
    const payload = await providerJson(`https://api.higgsfield.ai/estimate/${GENERATIVE_VIDEO_V11_MODEL.model}`, {
      apiKey,
      method: "POST",
      body: buildModelInput(GENERATIVE_VIDEO_V11_MODEL, source.signed_url, prompt),
      fetchImpl,
    });
    const discovered = availableBalance(payload);
    if (discovered !== null) apiBalance = discovered;
    const estimate = {
      usd: parseEstimateUsd(payload, { duration: 5, resolution: "720p" }),
      raw_credits: payload?.credits ?? null,
      pricing_fields: pricingFields(payload),
    };
    const base = sceneBase(sourceSpec, prompt.prompt_hash);
    if (await readJsonObject(supabase, `${base}/submitted.json`)) providerCallsSoFar += 1;
    scenes.push({ sourceSpec, source, prompt, estimate, base });
  }
  const totalUsd = Number(scenes.reduce((sum, scene) => sum + scene.estimate.usd, 0).toFixed(6));
  const balanceSufficient = apiBalance === null ? Boolean(balanceConfirmed) : apiBalance >= totalUsd;
  const result = {
    benchmark_version: GENERATIVE_VIDEO_BENCHMARK_V11,
    api_key_configured: true,
    auth_verified: true,
    balance_api: apiBalance === null ? "unavailable" : "available",
    balance_sufficient: balanceSufficient,
    balance_evidence: apiBalance === null ? (balanceConfirmed ? "operator_confirmed" : "unavailable") : "provider_api",
    model_available: scenes.length === GENERATIVE_VIDEO_V11_SCENES.length,
    source_hashes_match: true,
    prompt_ready: true,
    estimates: scenes.map((scene) => ({
      scene_id: scene.sourceSpec.scene_id,
      model: GENERATIVE_VIDEO_V11_MODEL.model,
      source_hash: scene.sourceSpec.sha256,
      prompt_hash: scene.prompt.prompt_hash,
      usd: scene.estimate.usd,
      raw_credits: scene.estimate.raw_credits,
      pricing_fields: scene.estimate.pricing_fields,
    })),
    total_usd: totalUsd,
    max_total_usd: Number(maxUsd),
    cost_gate_passed: totalUsd <= Number(maxUsd),
    provider_calls_so_far: providerCallsSoFar,
  };
  result.ready = result.auth_verified && result.balance_sufficient && result.model_available
    && result.source_hashes_match && result.prompt_ready && result.cost_gate_passed
    && providerCallsSoFar <= GENERATIVE_VIDEO_V11_CALL_CAP;
  await writeJsonObject(supabase, `${GENERATIVE_VIDEO_V11_PREFIX}/preflight.json`, {
    ...result,
    checked_at: new Date().toISOString(),
  });
  return { ...result, scenes };
}

async function runScene({ supabase, apiKey, scene, fetchImpl }) {
  const { sourceSpec, source, prompt, estimate, base } = scene;
  const completed = await readJsonObject(supabase, `${base}/completed.json`);
  if (completed) return { ...completed, cache_hit: true };
  let submitted = await readJsonObject(supabase, `${base}/submitted.json`);
  const generationStartedAt = Date.now();
  if (!submitted) {
    await writeJsonObject(supabase, `${base}/planned.json`, {
      benchmark_version: GENERATIVE_VIDEO_BENCHMARK_V11,
      scene_id: sourceSpec.scene_id,
      model: GENERATIVE_VIDEO_V11_MODEL.model,
      source_hash: sourceSpec.sha256,
      prompt_hash: prompt.prompt_hash,
      estimated_cost_usd: estimate.usd,
      planned_at: new Date().toISOString(),
    }, false);
    const accepted = await providerJson(`https://api.higgsfield.ai/${GENERATIVE_VIDEO_V11_MODEL.model}`, {
      apiKey,
      method: "POST",
      body: buildModelInput(GENERATIVE_VIDEO_V11_MODEL, source.signed_url, prompt),
      fetchImpl,
    });
    if (!accepted.request_id || !accepted.status_url) throw new Error("higgsfield_submission_missing_request_handle");
    submitted = {
      benchmark_version: GENERATIVE_VIDEO_BENCHMARK_V11,
      scene_id: sourceSpec.scene_id,
      model: GENERATIVE_VIDEO_V11_MODEL.model,
      request_id: accepted.request_id,
      status_url: accepted.status_url,
      source_hash: sourceSpec.sha256,
      prompt_hash: prompt.prompt_hash,
      estimated_cost_usd: estimate.usd,
      submitted_at: new Date().toISOString(),
    };
    await writeJsonObject(supabase, `${base}/submitted.json`, submitted, false);
  }
  const terminal = await pollRequest({
    apiKey,
    statusUrl: submitted.status_url,
    fetchImpl,
    onStatus: (payload) => writeJsonObject(supabase, `${base}/status.json`, {
      scene_id: sourceSpec.scene_id,
      request_id: submitted.request_id,
      status: payload.status,
      error: payload.error ? String(payload.error).slice(0, 300) : null,
      updated_at: new Date().toISOString(),
    }),
  });
  if (terminal.status !== "completed" || !terminal.video?.url) {
    const failed = {
      scene_id: sourceSpec.scene_id,
      model: GENERATIVE_VIDEO_V11_MODEL.model,
      request_id: submitted.request_id,
      status: terminal.status,
      error: terminal.error ? String(terminal.error).slice(0, 300) : null,
      generation_time_ms: Date.now() - generationStartedAt,
      failed_at: new Date().toISOString(),
    };
    await writeJsonObject(supabase, `${base}/failed.json`, failed);
    return failed;
  }
  const response = await fetchImpl(terminal.video.url);
  if (!response.ok) throw new Error(`higgsfield_output_download_failed:${response.status}`);
  const video = Buffer.from(await response.arrayBuffer());
  const outputHash = sha256(video);
  const outputPath = `${base}/original.mp4`;
  await uploadObject(supabase, outputPath, video, "video/mp4", false);
  const result = {
    benchmark_version: GENERATIVE_VIDEO_BENCHMARK_V11,
    provider: "higgsfield",
    scene_id: sourceSpec.scene_id,
    model: GENERATIVE_VIDEO_V11_MODEL.model,
    request_id: submitted.request_id,
    status: "completed",
    source_hash: sourceSpec.sha256,
    prompt_hash: prompt.prompt_hash,
    duration_seconds: 5,
    audio: "off",
    estimated_cost_usd: estimate.usd,
    actual_cost_usd: terminal.cost?.usd ?? terminal.usd ?? null,
    output_bucket: GENERATIVE_VIDEO_BUCKET,
    output_path: outputPath,
    output_hash: outputHash,
    output_bytes: video.length,
    generation_time_ms: Date.now() - generationStartedAt,
    completed_at: new Date().toISOString(),
  };
  await writeJsonObject(supabase, `${base}/completed.json`, result, false);
  return result;
}

export async function runGenerativeVideoBenchmarkV11({
  supabase,
  apiKey,
  balanceConfirmed,
  maxUsd = GENERATIVE_VIDEO_V11_MAX_USD,
  fetchImpl = fetch,
  onUpdate = () => {},
}) {
  const preflight = await preflightGenerativeVideoBenchmarkV11({ supabase, apiKey, balanceConfirmed, maxUsd, fetchImpl });
  if (!preflight.ready) throw new Error("generative_video_v11_preflight_not_ready");
  const results = [];
  let providerCalls = preflight.provider_calls_so_far;
  for (const scene of preflight.scenes) {
    const existing = await readJsonObject(supabase, `${scene.base}/completed.json`);
    const submitted = await readJsonObject(supabase, `${scene.base}/submitted.json`);
    if (!existing && !submitted) providerCalls += 1;
    if (providerCalls > GENERATIVE_VIDEO_V11_CALL_CAP) throw new Error("generative_video_v11_call_cap_exceeded");
    onUpdate({ status: "processing", scene_id: scene.sourceSpec.scene_id, provider_calls: providerCalls });
    try {
      const result = existing || await runScene({ supabase, apiKey, scene, fetchImpl });
      results.push(result);
      onUpdate({ status: result.status, scene_id: scene.sourceSpec.scene_id, request_id: result.request_id, provider_calls: providerCalls });
    } catch (error) {
      const failure = {
        scene_id: scene.sourceSpec.scene_id,
        model: GENERATIVE_VIDEO_V11_MODEL.model,
        status: "failed",
        error_code: error.code || error.message || "generation_failed",
        http_status: error.http_status || null,
      };
      results.push(failure);
      onUpdate({ ...failure, provider_calls: providerCalls });
      if ([400, 401, 402, 403, 413, 422].includes(Number(error.http_status))) break;
    }
  }
  const summary = {
    benchmark_version: GENERATIVE_VIDEO_BENCHMARK_V11,
    status: results.length === 2 && results.every((entry) => entry.status === "completed") ? "generated" : "generation_failed",
    provider_calls: providerCalls,
    estimated_total_usd: preflight.total_usd,
    results,
    finished_at: new Date().toISOString(),
  };
  await writeJsonObject(supabase, `${GENERATIVE_VIDEO_V11_PREFIX}/summary.json`, summary);
  return summary;
}

export async function getGenerativeVideoBenchmarkStatusV11({ supabase }) {
  if (!supabase) return { configured: false, status: "storage_unavailable" };
  const preflight = await readJsonObject(supabase, `${GENERATIVE_VIDEO_V11_PREFIX}/preflight.json`);
  const summary = await readJsonObject(supabase, `${GENERATIVE_VIDEO_V11_PREFIX}/summary.json`);
  const results = [];
  for (const sourceSpec of GENERATIVE_VIDEO_V11_SCENES) {
    const prompt = compileGenerativeVideoPromptV1(sourceSpec.scene_id);
    const base = sceneBase(sourceSpec, prompt.prompt_hash);
    const current = await readJsonObject(supabase, `${base}/completed.json`)
      || await readJsonObject(supabase, `${base}/failed.json`)
      || await readJsonObject(supabase, `${base}/status.json`)
      || await readJsonObject(supabase, `${base}/submitted.json`);
    if (current) results.push({ scene_id: sourceSpec.scene_id, model: GENERATIVE_VIDEO_V11_MODEL.model, ...current });
  }
  return { configured: true, preflight, summary, results };
}

export async function createGenerativeVideoReviewUrlsV11({ supabase, expiresIn = 7200 }) {
  const status = await getGenerativeVideoBenchmarkStatusV11({ supabase });
  const outputs = [];
  for (const result of status.results.filter((entry) => entry.status === "completed" && entry.output_path)) {
    const { data, error } = await supabase.storage.from(GENERATIVE_VIDEO_BUCKET).createSignedUrl(result.output_path, expiresIn);
    if (!error && data?.signedUrl) outputs.push({ ...result, signed_url: data.signedUrl });
  }
  return outputs;
}
