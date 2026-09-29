import crypto from "node:crypto";

export const GENERATIVE_VIDEO_BENCHMARK_V1 = "generative-video-benchmark/1";
export const GENERATIVE_VIDEO_PROMPT_COMPILER_V1 = "generative-video-prompt-compiler/1";
export const GENERATIVE_VIDEO_SOURCE = Object.freeze({
  artifact_id: "090490f8-0e75-47ca-8a2c-5f3340c7f413",
  scene_id: "s17",
  variant: "visual_benchmark_v1_1",
  sha256: "af6651b3de885c159c7a54cb8eb4474b3955e054c705c166ad302a4818149232",
  width: 1152,
  height: 2048,
});

export const GENERATIVE_VIDEO_MODELS = Object.freeze([
  Object.freeze({
    key: "model_a",
    model: "bytedance/seedance-2.5/image-to-video",
    input: Object.freeze({ duration: 5, resolution: "720p", output_format: "mp4", generate_audio: false }),
  }),
  Object.freeze({
    key: "model_b",
    model: "kling-video/v3.0/std/image-to-video",
    input: Object.freeze({ duration: 5, sound: "off", multi_shots: false, cfg_scale: 0.5 }),
  }),
]);

export const GENERATIVE_VIDEO_CALL_CAP = 2;
export const GENERATIVE_VIDEO_MAX_USD = 2.731;
export const GENERATIVE_VIDEO_BUCKET = "av2-generative-video-benchmarks";
export const GENERATIVE_VIDEO_PREFIX = "generative-video-benchmark-v1/s17";

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(typeof value === "string" ? value : canonicalJson(value));
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

export function compileGenerativeVideoPromptV1() {
  const sections = [
    ["CHARACTER IDENTITY", "Preserve Lumi's exact identity from the source image: same face, large turquoise eyes, thin antennae with violet tips, translucent light-blue wings, warm rounded yellow body, light-blue denim overalls, white/light-blue shoes, canonical star wand, proportions and colors. No redesign, costume change, accessories or identity drift."],
    ["REQUIRED ENTITIES", "Preserve gallina_amable and EXACTLY FIVE EGGS. Never add, remove, merge, duplicate, transform or obscure an egg. All five eggs remain complete, individually distinguishable and countable throughout."],
    ["MOTION INTENT", "Lumi first observes the five eggs. Her eyes lead a gentle left-to-right counting/pointing action; her head follows with a small natural delay. Then Lumi looks toward the viewer, smiles warmly and settles into a calm listening/wait pose. Wings provide only subtle secondary response. Use continuous natural articulated body motion, soft motion arcs, anticipation, ease-in/ease-out and settle; never replace the whole pose abruptly."],
    ["CAMERA", "Keep the original 9:16 composition. At most use an extremely subtle motivated push-in. No shake, rapid movement, reframing or crop that harms Lumi, gallina_amable or the five eggs."],
    ["WORLD CONTINUITY", "Preserve garden_world_01 exactly: canonical tree, arched wooden door, round blue four-panel window, path, vegetation, warm lighting and palette. Preserve scale, depth, grounding and gallina_amable."],
    ["NEGATIVE CONSTRAINTS", "No face drift, body morphing, extra or missing limbs, wand teleportation, egg duplication/disappearance/merging, wing duplication, costume changes, random flying, continuous bobbing, camera shake, pose popping, whole-body replacement, floating-sprite motion, text, logo or watermark."],
  ];
  const text = sections.map(([heading, body]) => `${heading}: ${body}`).join("\n");
  return Object.freeze({
    version: GENERATIVE_VIDEO_PROMPT_COMPILER_V1,
    text,
    prompt_hash: sha256(text),
  });
}

export function buildModelInput(model, imageUrl, prompt) {
  if (!model || !GENERATIVE_VIDEO_MODELS.some((entry) => entry.model === model.model)) {
    throw new Error("generative_video_model_not_allowed");
  }
  return { ...model.input, prompt: prompt.text, image_url: imageUrl };
}

function safeProviderError(status, payload) {
  const error = new Error(`higgsfield_request_failed:${status}`);
  error.code = status === 401 ? "higgsfield_auth_failed" : "higgsfield_request_failed";
  error.http_status = status;
  error.provider_detail = String(payload?.detail || payload?.error || "provider_error").slice(0, 300);
  return error;
}

async function providerJson(url, { apiKey, method = "GET", body, fetchImpl = fetch } = {}) {
  const response = await fetchImpl(url, {
    method,
    headers: {
      Authorization: `Key ${apiKey}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw safeProviderError(response.status, payload);
  return payload;
}

function numericUsd(payload) {
  const candidates = [
    payload?.usd,
    payload?.cost_usd,
    payload?.price_usd,
    payload?.estimated_cost_usd,
    payload?.cost?.usd,
    typeof payload?.cost === "number" || typeof payload?.cost === "string" ? payload.cost : null,
  ];
  for (const candidate of candidates) {
    const parsed = Number(candidate);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  const error = new Error("higgsfield_estimate_missing_usd");
  error.diagnostic = Object.fromEntries(Object.entries(payload || {})
    .filter(([, value]) => ["string", "number", "boolean"].includes(typeof value))
    .map(([key, value]) => [key, String(value).slice(0, 120)]));
  throw error;
}

function availableBalance(payload) {
  const candidates = [payload?.balance_usd, payload?.available_usd, payload?.balance?.usd];
  for (const candidate of candidates) {
    const parsed = Number(candidate);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return null;
}

function sanitizedPricingFields(payload) {
  return Object.fromEntries(Object.entries(payload || {})
    .filter(([key, value]) => /cost|price|usd|credit|discount/i.test(key)
      && ["string", "number", "boolean"].includes(typeof value))
    .map(([key, value]) => [key, value]));
}

async function ensureBucket(supabase) {
  const { data, error } = await supabase.storage.getBucket(GENERATIVE_VIDEO_BUCKET);
  if (!error && data) return;
  const created = await supabase.storage.createBucket(GENERATIVE_VIDEO_BUCKET, {
    public: false,
    fileSizeLimit: 100 * 1024 * 1024,
    allowedMimeTypes: ["video/mp4", "application/json", "image/png"],
  });
  if (created.error && !String(created.error.message || "").toLowerCase().includes("already exists")) {
    throw new Error("generative_video_bucket_unavailable");
  }
}

async function uploadObject(supabase, objectPath, body, contentType, upsert = false) {
  const result = await supabase.storage.from(GENERATIVE_VIDEO_BUCKET).upload(objectPath, body, {
    contentType,
    cacheControl: "31536000",
    upsert,
  });
  if (result.error) throw new Error(`generative_video_storage_write_failed:${objectPath}`);
  return result.data;
}

async function readJsonObject(supabase, objectPath) {
  const { data, error } = await supabase.storage.from(GENERATIVE_VIDEO_BUCKET).download(objectPath);
  if (error) return null;
  return JSON.parse(Buffer.from(await data.arrayBuffer()).toString("utf8"));
}

async function writeJsonObject(supabase, objectPath, value, upsert = true) {
  return uploadObject(supabase, objectPath, Buffer.from(`${JSON.stringify(value, null, 2)}\n`), "application/json", upsert);
}

async function loadCanonicalSource(supabase) {
  const { data: asset, error } = await supabase.from("av2_assets").select("*")
    .eq("artifact_id", GENERATIVE_VIDEO_SOURCE.artifact_id)
    .eq("scene_id", GENERATIVE_VIDEO_SOURCE.scene_id)
    .eq("variant", GENERATIVE_VIDEO_SOURCE.variant)
    .single();
  if (error || !asset) throw new Error("generative_video_source_asset_missing");
  const { data: qa, error: qaError } = await supabase.from("av2_visual_qa_runs")
    .select("qa_version,status,blocker_count,warning_count,info_count")
    .eq("asset_id", asset.id).eq("qa_version", "visual-qa/1.2").eq("scope", "individual")
    .order("run_number", { ascending: false }).limit(1).maybeSingle();
  if (qaError || !qa || qa.blocker_count !== 0 || !["qa_passed", "qa_warning"].includes(qa.status)) {
    throw new Error("generative_video_source_qa_not_accepted");
  }
  const { data: blob, error: downloadError } = await supabase.storage.from(asset.storage_bucket).download(asset.storage_path);
  if (downloadError) throw new Error("generative_video_source_download_failed");
  const buffer = Buffer.from(await blob.arrayBuffer());
  if (sha256(buffer) !== GENERATIVE_VIDEO_SOURCE.sha256 || asset.asset_hash !== GENERATIVE_VIDEO_SOURCE.sha256) {
    throw new Error("generative_video_source_hash_mismatch");
  }
  if (asset.source_width !== GENERATIVE_VIDEO_SOURCE.width || asset.source_height !== GENERATIVE_VIDEO_SOURCE.height) {
    throw new Error("generative_video_source_dimensions_mismatch");
  }
  const { data: signed, error: signedError } = await supabase.storage.from(asset.storage_bucket)
    .createSignedUrl(asset.storage_path, 7200);
  if (signedError || !signed?.signedUrl) throw new Error("generative_video_source_signing_failed");
  return { asset, qa, buffer, signed_url: signed.signedUrl };
}

export async function preflightGenerativeVideoBenchmarkV1({
  supabase,
  apiKey,
  balanceConfirmed = false,
  maxUsd = GENERATIVE_VIDEO_MAX_USD,
  fetchImpl = fetch,
}) {
  if (!supabase) throw new Error("generative_video_storage_not_configured");
  if (!apiKey) return { ready: false, api_key_configured: false, auth_verified: false };
  await ensureBucket(supabase);
  const source = await loadCanonicalSource(supabase);
  const prompt = compileGenerativeVideoPromptV1();
  const estimates = [];
  let apiBalance = null;
  for (const model of GENERATIVE_VIDEO_MODELS) {
    const payload = await providerJson(`https://api.higgsfield.ai/estimate/${model.model}`, {
      apiKey,
      method: "POST",
      body: buildModelInput(model, source.signed_url, prompt),
      fetchImpl,
    });
    const cost = numericUsd(payload);
    const discovered = availableBalance(payload);
    if (discovered !== null) apiBalance = discovered;
    estimates.push({
      key: model.key,
      model: model.model,
      usd: cost,
      raw_credits: payload?.credits ?? null,
      pricing_fields: sanitizedPricingFields(payload),
    });
  }
  const totalUsd = Number(estimates.reduce((sum, entry) => sum + entry.usd, 0).toFixed(6));
  const balanceSufficient = apiBalance === null ? Boolean(balanceConfirmed) : apiBalance >= totalUsd;
  const result = {
    benchmark_version: GENERATIVE_VIDEO_BENCHMARK_V1,
    api_key_configured: true,
    auth_verified: true,
    balance_api: apiBalance === null ? "unavailable" : "available",
    balance_sufficient: balanceSufficient,
    balance_evidence: apiBalance === null ? (balanceConfirmed ? "operator_confirmed" : "unavailable") : "provider_api",
    models_available: estimates.length === GENERATIVE_VIDEO_MODELS.length,
    source_hash_match: true,
    source_asset_id: source.asset.id,
    source_storage_path: source.asset.storage_path,
    prompt_ready: true,
    prompt_hash: prompt.prompt_hash,
    estimates,
    total_usd: totalUsd,
    max_total_usd: Number(maxUsd),
    cost_gate_passed: totalUsd <= Number(maxUsd),
    provider_calls_so_far: 0,
  };
  result.ready = result.auth_verified && result.balance_sufficient && result.models_available
    && result.source_hash_match && result.prompt_ready && result.cost_gate_passed;
  const persisted = { ...result, checked_at: new Date().toISOString() };
  await writeJsonObject(supabase, `${GENERATIVE_VIDEO_PREFIX}/preflight.json`, persisted);
  return { ...result, source, prompt };
}

async function pollRequest({ apiKey, statusUrl, fetchImpl, onStatus }) {
  const terminal = new Set(["completed", "failed", "nsfw", "canceled"]);
  const startedAt = Date.now();
  let delay = 2000;
  while (Date.now() - startedAt < 30 * 60 * 1000) {
    const payload = await providerJson(statusUrl, { apiKey, fetchImpl });
    await onStatus(payload);
    if (terminal.has(payload.status)) return payload;
    await new Promise((resolve) => setTimeout(resolve, delay));
    delay = Math.min(Math.round(delay * 1.5), 10_000);
  }
  throw new Error("higgsfield_poll_timeout");
}

async function runOneModel({ supabase, apiKey, model, source, prompt, estimate, fetchImpl }) {
  const modelSlug = model.model.replaceAll("/", "__");
  const base = `${GENERATIVE_VIDEO_PREFIX}/${modelSlug}/${prompt.prompt_hash}`;
  const completed = await readJsonObject(supabase, `${base}/completed.json`);
  if (completed) return { ...completed, cache_hit: true };
  let submitted = await readJsonObject(supabase, `${base}/submitted.json`);
  const generationStartedAt = Date.now();
  if (!submitted) {
    await writeJsonObject(supabase, `${base}/planned.json`, {
      benchmark_version: GENERATIVE_VIDEO_BENCHMARK_V1,
      model: model.model,
      source_hash: GENERATIVE_VIDEO_SOURCE.sha256,
      prompt_hash: prompt.prompt_hash,
      estimated_cost_usd: estimate.usd,
      planned_at: new Date().toISOString(),
    }, false);
    const accepted = await providerJson(`https://api.higgsfield.ai/${model.model}`, {
      apiKey,
      method: "POST",
      body: buildModelInput(model, source.signed_url, prompt),
      fetchImpl,
    });
    if (!accepted.request_id || !accepted.status_url) throw new Error("higgsfield_submission_missing_request_handle");
    submitted = {
      benchmark_version: GENERATIVE_VIDEO_BENCHMARK_V1,
      model: model.model,
      request_id: accepted.request_id,
      status_url: accepted.status_url,
      source_hash: GENERATIVE_VIDEO_SOURCE.sha256,
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
      request_id: submitted.request_id,
      status: payload.status,
      error: payload.error ? String(payload.error).slice(0, 300) : null,
      updated_at: new Date().toISOString(),
    }),
  });
  if (terminal.status !== "completed" || !terminal.video?.url) {
    const failed = {
      model: model.model,
      request_id: submitted.request_id,
      status: terminal.status,
      error: terminal.error ? String(terminal.error).slice(0, 300) : null,
      generation_time_ms: Date.now() - generationStartedAt,
      failed_at: new Date().toISOString(),
    };
    await writeJsonObject(supabase, `${base}/failed.json`, failed);
    return failed;
  }
  const videoResponse = await fetchImpl(terminal.video.url);
  if (!videoResponse.ok) throw new Error(`higgsfield_output_download_failed:${videoResponse.status}`);
  const video = Buffer.from(await videoResponse.arrayBuffer());
  const outputHash = sha256(video);
  const outputPath = `${base}/original.mp4`;
  await uploadObject(supabase, outputPath, video, "video/mp4", false);
  const result = {
    benchmark_version: GENERATIVE_VIDEO_BENCHMARK_V1,
    provider: "higgsfield",
    model: model.model,
    request_id: submitted.request_id,
    status: "completed",
    source_hash: GENERATIVE_VIDEO_SOURCE.sha256,
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

export async function runGenerativeVideoBenchmarkV1({
  supabase,
  apiKey,
  balanceConfirmed,
  maxUsd = GENERATIVE_VIDEO_MAX_USD,
  fetchImpl = fetch,
  onUpdate = () => {},
}) {
  const preflight = await preflightGenerativeVideoBenchmarkV1({ supabase, apiKey, balanceConfirmed, maxUsd, fetchImpl });
  if (!preflight.ready) throw new Error("generative_video_preflight_not_ready");
  const results = [];
  let providerCalls = 0;
  for (const model of GENERATIVE_VIDEO_MODELS) {
    const modelSlug = model.model.replaceAll("/", "__");
    const base = `${GENERATIVE_VIDEO_PREFIX}/${modelSlug}/${preflight.prompt.prompt_hash}`;
    const existing = await readJsonObject(supabase, `${base}/completed.json`);
    const submitted = await readJsonObject(supabase, `${base}/submitted.json`);
    if (!existing && !submitted) providerCalls += 1;
    if (providerCalls > GENERATIVE_VIDEO_CALL_CAP) throw new Error("generative_video_call_cap_exceeded");
    onUpdate({ status: "processing", model: model.model, provider_calls: providerCalls });
    try {
      const result = existing || await runOneModel({
        supabase,
        apiKey,
        model,
        source: preflight.source,
        prompt: preflight.prompt,
        estimate: preflight.estimates.find((entry) => entry.key === model.key),
        fetchImpl,
      });
      results.push(result);
      onUpdate({ status: result.status, model: model.model, request_id: result.request_id, provider_calls: providerCalls });
    } catch (error) {
      const failure = {
        model: model.model,
        status: "failed",
        error_code: error.code || error.message || "generation_failed",
        http_status: error.http_status || null,
      };
      results.push(failure);
      onUpdate({ ...failure, provider_calls: providerCalls });
      if ([401, 403].includes(Number(error.http_status))) break;
    }
  }
  const summary = {
    benchmark_version: GENERATIVE_VIDEO_BENCHMARK_V1,
    status: results.length === 2 && results.every((entry) => entry.status === "completed") ? "generated" : "generation_failed",
    provider_calls: providerCalls,
    prompt_hash: preflight.prompt.prompt_hash,
    source_hash: GENERATIVE_VIDEO_SOURCE.sha256,
    estimated_total_usd: preflight.total_usd,
    results,
    finished_at: new Date().toISOString(),
  };
  await writeJsonObject(supabase, `${GENERATIVE_VIDEO_PREFIX}/summary.json`, summary);
  return summary;
}

export async function getGenerativeVideoBenchmarkStatusV1({ supabase }) {
  if (!supabase) return { configured: false, status: "storage_unavailable" };
  const preflight = await readJsonObject(supabase, `${GENERATIVE_VIDEO_PREFIX}/preflight.json`);
  const summary = await readJsonObject(supabase, `${GENERATIVE_VIDEO_PREFIX}/summary.json`);
  const results = [];
  const prompt = compileGenerativeVideoPromptV1();
  for (const model of GENERATIVE_VIDEO_MODELS) {
    const base = `${GENERATIVE_VIDEO_PREFIX}/${model.model.replaceAll("/", "__")}/${prompt.prompt_hash}`;
    const completed = await readJsonObject(supabase, `${base}/completed.json`);
    const failed = await readJsonObject(supabase, `${base}/failed.json`);
    const submitted = await readJsonObject(supabase, `${base}/submitted.json`);
    const status = await readJsonObject(supabase, `${base}/status.json`);
    const current = completed || failed || status || submitted;
    if (current) results.push({ model: model.model, ...current });
  }
  return { configured: true, preflight, summary, results };
}

export async function createGenerativeVideoReviewUrlsV1({ supabase, expiresIn = 7200 }) {
  const status = await getGenerativeVideoBenchmarkStatusV1({ supabase });
  const outputs = [];
  for (const result of status.results.filter((entry) => entry.status === "completed" && entry.output_path)) {
    const { data, error } = await supabase.storage.from(GENERATIVE_VIDEO_BUCKET).createSignedUrl(result.output_path, expiresIn);
    if (!error && data?.signedUrl) outputs.push({ ...result, signed_url: data.signedUrl });
  }
  return outputs;
}
