import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { ASSET_V2_IMAGE_MODEL, generateBenchmarkComposite } from "./asset-v2/image-provider.js";
import { fetchCanonicalReference } from "./asset-v2/visual-benchmark-runner.js";
import {
  GENERATIVE_VIDEO_BUCKET,
  buildModelInput,
  ensureBucket,
  pollRequest,
  providerJson,
  sha256,
  uploadObject,
  writeJsonObject,
} from "./generative-video-benchmark-v1.js";
import { synthesizeSpeech } from "./openai.js";
import {
  compileVideoSourceImagePromptV1,
  prepareHiggsfieldRequestV2,
} from "./video-generation-readiness-v2.js";

export const SECOND_SHORT_ID = "lumi_jardin_formas_v1";
export const SECOND_SHORT_EPISODE_ID = "ep_lumi_formas_002";
export const SECOND_SHORT_SCENES = Object.freeze(["s21","s22","s23","s24","s25","s26","s27","s28","s29"]);
export const SECOND_SHORT_IMAGE_MAX_USD = 0.887396;
export const SECOND_SHORT_VIDEO_MAX_USD = 2.079;
export const SECOND_SHORT_TTS_MAX_USD = 0.01225;
export const SECOND_SHORT_IMAGE_UNIT_USD = 0.0985995;
export const SECOND_SHORT_VIDEO_UNIT_USD = 0.231;
export const SECOND_SHORT_TTS_UNIT_USD = Number((SECOND_SHORT_TTS_MAX_USD / 9).toFixed(9));
export const SECOND_SHORT_PREFIX = "lumi-second-short-v1/ep_lumi_formas_002";
export const SECOND_SHORT_VIDEO_MODEL = Object.freeze({
  model: "kling-video/v3.0/std/image-to-video",
  input: Object.freeze({ duration: 5, sound: "off", multi_shots: false, cfg_scale: 0.5 }),
});

const scenePlanPath = fileURLToPath(new URL("../episodes/ep_lumi_formas_002/SCENE_PLAN_V2.json", import.meta.url));
const videoContractsPath = fileURLToPath(new URL("../episodes/ep_lumi_formas_002/VIDEO_GENERATION_CONTRACTS_V2.json", import.meta.url));

async function scenePlan() {
  return JSON.parse(await readFile(scenePlanPath, "utf8"));
}

async function videoContracts() {
  return JSON.parse(await readFile(videoContractsPath, "utf8"));
}

function actualImageCost(usage) {
  const input = usage?.input_tokens_details || {};
  const output = usage?.output_tokens_details || {};
  if (![input.text_tokens, input.image_tokens, output.image_tokens].every(Number.isFinite)) return null;
  return Number((input.text_tokens * 2.5 / 1e6 + input.image_tokens * 4 / 1e6 + output.image_tokens * 15 / 1e6).toFixed(6));
}

async function runs(supabase, stage) {
  const { data, error } = await supabase.from("lumi_pilot_runs").select("*")
    .eq("pilot_id", SECOND_SHORT_ID).eq("stage", stage).order("created_at");
  if (error) throw new Error(`second_short_${stage.toLowerCase()}_runs_read_failed`);
  return data || [];
}

export function budgetAllowsClaim({ booked, priorCount, estimate, ceiling }) {
  // estimated_cost_usd is persisted as numeric(12,6). Each prior row can
  // therefore differ from the in-memory unit estimate by at most half a
  // microdollar. Account for only that persistence rounding; the call cap
  // remains the primary exactly-once bound.
  const persistenceRoundingTolerance = Number(priorCount || 0) * 0.0000005;
  return Number(booked || 0) + Number(estimate || 0)
    <= Number(ceiling || 0) + persistenceRoundingTolerance + 1e-9;
}

async function claim(supabase, sceneId, stage, estimate, ceiling) {
  const prior = await runs(supabase, stage);
  const existing = prior.find((row) => row.scene_id === sceneId);
  if (existing) return { claimed: false, row: existing };
  const booked = prior.reduce((sum, row) => sum + Number(row.estimated_cost_usd || 0), 0);
  if (prior.length + 1 > 9) throw new Error(`second_short_${stage.toLowerCase()}_call_cap_exceeded`);
  if (!budgetAllowsClaim({ booked, priorCount: prior.length, estimate, ceiling })) {
    throw new Error(`second_short_${stage.toLowerCase()}_budget_exceeded`);
  }
  const payload = {
    pilot_id: SECOND_SHORT_ID, scene_id: sceneId, stage, status: "CLAIMED",
    provider_calls: 1, estimated_cost_usd: estimate,
    claimed_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  };
  const { data, error } = await supabase.from("lumi_pilot_runs").insert(payload).select("*").single();
  if (!error) return { claimed: true, row: data };
  if (error.code === "23505") {
    const duplicate = (await runs(supabase, stage)).find((row) => row.scene_id === sceneId);
    return { claimed: false, row: duplicate };
  }
  throw new Error(`second_short_${stage.toLowerCase()}_claim_failed`);
}

async function update(supabase, sceneId, stage, status, patch = {}) {
  const terminal = status === "SUCCEEDED" || status === "FAILED";
  const { data, error } = await supabase.from("lumi_pilot_runs").update({
    status, ...patch, updated_at: new Date().toISOString(),
    ...(terminal ? { completed_at: new Date().toISOString() } : {}),
  }).eq("pilot_id", SECOND_SHORT_ID).eq("scene_id", sceneId).eq("stage", stage).select("*").single();
  if (error) throw new Error(`second_short_${stage.toLowerCase()}_update_failed`);
  return data;
}

async function objectBuffer(supabase, objectPath) {
  const { data, error } = await supabase.storage.from(GENERATIVE_VIDEO_BUCKET).download(objectPath);
  if (error) throw new Error(`second_short_storage_read_failed:${objectPath}`);
  return Buffer.from(await data.arrayBuffer());
}

async function signedObject(supabase, objectPath, expires = 86400) {
  const { data, error } = await supabase.storage.from(GENERATIVE_VIDEO_BUCKET).createSignedUrl(objectPath, expires);
  if (error || !data?.signedUrl) throw new Error(`second_short_storage_sign_failed:${objectPath}`);
  return data.signedUrl;
}

export async function secondShortPreflight({ supabase }) {
  const [plan, imageRuns, videoRuns, ttsRuns] = await Promise.all([
    scenePlan(), runs(supabase, "IMAGE"), runs(supabase, "VIDEO"), runs(supabase, "TTS"),
  ]);
  const providerCalls = { image: imageRuns.length, kling: videoRuns.length, tts: ttsRuns.length };
  return {
    status: "PASS",
    episode_id: SECOND_SHORT_EPISODE_ID,
    scene_count: plan.scenes.length,
    expected: {
      image_calls: 9, image_cost_usd: SECOND_SHORT_IMAGE_MAX_USD,
      kling_calls: 9, kling_cost_usd: SECOND_SHORT_VIDEO_MAX_USD,
      tts_calls: 9, tts_cost_usd: SECOND_SHORT_TTS_MAX_USD,
      total_cost_usd: 2.978645,
    },
    actual_claims: providerCalls,
    no_prior_claims: imageRuns.length + videoRuns.length + ttsRuns.length === 0,
    automatic_retries: 0,
    automatic_variants: 0,
  };
}

export async function runSecondShortImages({ supabase, openAiApiKey, supabaseUrl, logger = () => {} }) {
  if (!supabase || !openAiApiKey) throw new Error("second_short_image_provider_not_configured");
  await ensureBucket(supabase);
  const [plan, contracts] = await Promise.all([scenePlan(), videoContracts()]);
  const canonical = await fetchCanonicalReference({ supabaseUrl });
  let world = null;
  const results = [];
  for (const scene of plan.scenes) {
    let sourcePrompt;
    try {
      sourcePrompt = compileVideoSourceImagePromptV1(contracts.scenes?.[scene.id]);
    } catch (error) {
      logger({ event: "second_short_source_prompt_blocked", scene_id: scene.id, error: error.code || error.message, provider_calls: 0 });
      results.push({ scene_id: scene.id, status: "blocked", error: error.code || "video_source_prompt_contract_failed", provider_calls: 0 });
      continue;
    }
    const acquired = await claim(supabase, scene.id, "IMAGE", SECOND_SHORT_IMAGE_UNIT_USD, SECOND_SHORT_IMAGE_MAX_USD);
    if (!acquired.claimed) {
      results.push({ scene_id: scene.id, status: "cache_hit", claim_status: acquired.row?.status });
      if (scene.id === "s21" && acquired.row?.storage_path) world = await objectBuffer(supabase, acquired.row.storage_path);
      continue;
    }
    const prompt = sourcePrompt.text;
    const promptHash = sha256(prompt);
    await update(supabase, scene.id, "IMAGE", "REQUESTED", {
      provider: "openai", result: { dispatch_state: "REQUESTED", prompt_hash: promptHash, requested_at: new Date().toISOString() },
    });
    logger({ event: "second_short_image_requested", scene_id: scene.id });
    try {
      const references = [{ buffer: canonical, filename: "canonical-lumi.png" }];
      if (world) references.push({ buffer: world, filename: "lantern-garden-continuity.png" });
      const generated = await generateBenchmarkComposite({
        apiKey: openAiApiKey, model: ASSET_V2_IMAGE_MODEL, prompt,
        referenceBuffers: references, size: "1152x2048", quality: "high",
      });
      if (generated.image.width !== 1152 || generated.image.height !== 2048) throw new Error("second_short_image_wrong_dimensions");
      const objectPath = `${SECOND_SHORT_PREFIX}/images/${scene.id}/${promptHash}/source.png`;
      await uploadObject(supabase, objectPath, generated.buffer, "image/png", false);
      if (scene.id === "s21") world = generated.buffer;
      const reviewUrl = await signedObject(supabase, objectPath);
      const result = {
        status: "generated", visual_qa: { classification: "PENDING", version: "1.2" },
        prompt_hash: promptHash, output_hash: generated.image.sha256, output_bytes: generated.image.bytes,
        provider_request_id: generated.provider_request_id, provider_response_id: generated.provider_response_id,
        provider_model: generated.model, estimated_cost_usd: SECOND_SHORT_IMAGE_UNIT_USD,
        actual_cost_usd: actualImageCost(generated.usage), storage_bucket: GENERATIVE_VIDEO_BUCKET,
        storage_path: objectPath, review_url: reviewUrl,
      };
      await update(supabase, scene.id, "IMAGE", "SUCCEEDED", {
        provider_request_id: generated.provider_request_id, storage_bucket: GENERATIVE_VIDEO_BUCKET,
        storage_path: objectPath, content_hash: generated.image.sha256, artifact_reference: objectPath, result,
      });
      logger({ event: "second_short_image_completed", scene_id: scene.id, request_id: generated.provider_request_id, hash: generated.image.sha256, review_url: reviewUrl });
      results.push({ scene_id: scene.id, ...result });
    } catch (error) {
      await update(supabase, scene.id, "IMAGE", "FAILED", { error_code: error.code || error.message || "image_failed" });
      logger({ event: "second_short_image_failed", scene_id: scene.id, error: error.code || error.message });
      results.push({ scene_id: scene.id, status: "failed", error: error.code || error.message });
    }
  }
  return { stage: "IMAGE", results, provider_calls: (await runs(supabase, "IMAGE")).length };
}

function qaAccepted(row) {
  return row?.status === "SUCCEEDED" && ["PASS","PASS_WITH_WARNING"].includes(row?.result?.visual_qa?.classification);
}

export async function runSecondShortVideos({ supabase, higgsfieldApiKey, logger = () => {} }) {
  if (!supabase || !higgsfieldApiKey) throw new Error("second_short_video_provider_not_configured");
  await ensureBucket(supabase);
  const [plan, contracts, images, existingVideos] = await Promise.all([
    scenePlan(), videoContracts(), runs(supabase, "IMAGE"), runs(supabase, "VIDEO"),
  ]);
  const results = [];
  for (const scene of plan.scenes) {
    const existing = existingVideos.find((row) => row.scene_id === scene.id);
    if (existing) {
      results.push({ scene_id: scene.id, status: "cache_hit", claim_status: existing.status });
      continue;
    }
    const source = images.find((row) => row.scene_id === scene.id);
    if (!qaAccepted(source)) {
      results.push({ scene_id: scene.id, status: "blocked", error: "visual_qa_not_accepted" });
      continue;
    }
    const contract = contracts.scenes?.[scene.id];
    let prepared;
    try {
      prepared = prepareHiggsfieldRequestV2({
        contract,
        source_readiness: source?.result?.video_source_readiness,
      });
    } catch (error) {
      logger({
        event: "second_short_video_readiness_blocked",
        scene_id: scene.id,
        error: error.code || error.message,
        reasons: error.gate?.errors || error.readiness?.errors || [],
        provider_calls: 0,
      });
      results.push({
        scene_id: scene.id,
        status: "blocked",
        error: error.code || "video_generation_readiness_failed",
        reasons: error.gate?.errors || error.readiness?.errors || [],
        provider_calls: 0,
      });
      continue;
    }
    const acquired = await claim(supabase, scene.id, "VIDEO", SECOND_SHORT_VIDEO_UNIT_USD, SECOND_SHORT_VIDEO_MAX_USD);
    if (!acquired.claimed) {
      results.push({ scene_id: scene.id, status: "cache_hit", claim_status: acquired.row?.status });
      continue;
    }
    const prompt = { text: prepared.compiled_prompt.text };
    prompt.prompt_hash = sha256(prompt.text);
    const sourceUrl = await signedObject(supabase, source.storage_path);
    const base = `${SECOND_SHORT_PREFIX}/videos/${scene.id}/${prompt.prompt_hash}`;
    await writeJsonObject(supabase, `${base}/planned.json`, {
      episode_id: SECOND_SHORT_EPISODE_ID, scene_id: scene.id, model: SECOND_SHORT_VIDEO_MODEL.model,
      source_hash: source.content_hash, prompt_hash: prompt.prompt_hash,
      readiness_version: prepared.gate.readiness.version,
      source_readiness_version: prepared.gate.source_readiness.version,
      prompt_compiler_version: prepared.compiled_prompt.version,
      risk_class: prepared.compiled_prompt.risk_class,
      estimated_cost_usd: SECOND_SHORT_VIDEO_UNIT_USD, planned_at: new Date().toISOString(),
    }, false);
    await update(supabase, scene.id, "VIDEO", "REQUESTED", {
      provider: "higgsfield", result: { dispatch_state: "REQUESTED", source_hash: source.content_hash, prompt_hash: prompt.prompt_hash },
    });
    logger({ event: "second_short_video_requested", scene_id: scene.id });
    try {
      const accepted = await providerJson(`https://api.higgsfield.ai/${SECOND_SHORT_VIDEO_MODEL.model}`, {
        apiKey: higgsfieldApiKey, method: "POST", body: buildModelInput(SECOND_SHORT_VIDEO_MODEL, sourceUrl, prompt),
      });
      if (!accepted.request_id || !accepted.status_url) throw new Error("higgsfield_submission_missing_request_handle");
      await writeJsonObject(supabase, `${base}/submitted.json`, {
        scene_id: scene.id, request_id: accepted.request_id, status_url: accepted.status_url,
        source_hash: source.content_hash, prompt_hash: prompt.prompt_hash, submitted_at: new Date().toISOString(),
      }, false);
      await update(supabase, scene.id, "VIDEO", "REQUESTED", {
        provider_request_id: accepted.request_id,
        result: { dispatch_state: "SUBMITTED", request_id: accepted.request_id, status_url: accepted.status_url, source_hash: source.content_hash, prompt_hash: prompt.prompt_hash },
      });
      const terminal = await pollRequest({
        apiKey: higgsfieldApiKey, statusUrl: accepted.status_url,
        onStatus: (payload) => writeJsonObject(supabase, `${base}/status.json`, { request_id: accepted.request_id, status: payload.status, updated_at: new Date().toISOString() }),
      });
      if (terminal.status !== "completed" || !terminal.video?.url) throw new Error(`second_short_kling_terminal_${terminal.status}`);
      const response = await fetch(terminal.video.url);
      if (!response.ok) throw new Error(`second_short_kling_download_failed:${response.status}`);
      const video = Buffer.from(await response.arrayBuffer());
      const outputHash = sha256(video);
      const objectPath = `${base}/original.mp4`;
      await uploadObject(supabase, objectPath, video, "video/mp4", false);
      const reviewUrl = await signedObject(supabase, objectPath);
      const result = {
        status: "completed", temporal_qa: { classification: "PENDING" }, request_id: accepted.request_id,
        model: SECOND_SHORT_VIDEO_MODEL.model, audio: "off", duration_seconds: 5,
        source_hash: source.content_hash, prompt_hash: prompt.prompt_hash, output_hash: outputHash,
        output_bytes: video.length, storage_bucket: GENERATIVE_VIDEO_BUCKET, storage_path: objectPath,
        estimated_cost_usd: SECOND_SHORT_VIDEO_UNIT_USD, actual_cost_usd: terminal.cost?.usd ?? terminal.usd ?? null,
        review_url: reviewUrl,
      };
      await writeJsonObject(supabase, `${base}/completed.json`, result, false);
      await update(supabase, scene.id, "VIDEO", "SUCCEEDED", {
        provider_request_id: accepted.request_id, storage_bucket: GENERATIVE_VIDEO_BUCKET,
        storage_path: objectPath, content_hash: outputHash, artifact_reference: objectPath, result,
      });
      logger({ event: "second_short_video_completed", scene_id: scene.id, request_id: accepted.request_id, hash: outputHash, review_url: reviewUrl });
      results.push({ scene_id: scene.id, ...result });
    } catch (error) {
      await update(supabase, scene.id, "VIDEO", "FAILED", { error_code: error.code || error.message || "video_failed" });
      logger({ event: "second_short_video_failed", scene_id: scene.id, error: error.code || error.message });
      results.push({ scene_id: scene.id, status: "failed", error: error.code || error.message });
    }
  }
  return { stage: "VIDEO", results, provider_calls: (await runs(supabase, "VIDEO")).length };
}

export async function runSecondShortTts({ supabase, openAiApiKey, logger = () => {} }) {
  if (!supabase || !openAiApiKey) throw new Error("second_short_tts_provider_not_configured");
  await ensureBucket(supabase);
  const plan = await scenePlan();
  const results = [];
  for (const scene of plan.scenes) {
    const acquired = await claim(supabase, scene.id, "TTS", SECOND_SHORT_TTS_UNIT_USD, SECOND_SHORT_TTS_MAX_USD);
    if (!acquired.claimed) {
      results.push({ scene_id: scene.id, status: "cache_hit", claim_status: acquired.row?.status });
      continue;
    }
    const narrationHash = sha256(scene.narration);
    await update(supabase, scene.id, "TTS", "REQUESTED", {
      provider: "openai", result: { dispatch_state: "REQUESTED", narration_hash: narrationHash },
    });
    try {
      const audio = await synthesizeSpeech({ apiKey: openAiApiKey, input: scene.narration, model: "gpt-4o-mini-tts", voice: "marin" });
      const outputHash = sha256(audio.buffer);
      const objectPath = `${SECOND_SHORT_PREFIX}/audio/${scene.id}/${narrationHash}/narration.mp3`;
      await uploadObject(supabase, objectPath, audio.buffer, "audio/mpeg", false);
      const result = { status: "completed", model: audio.model, voice: audio.voice, narration_hash: narrationHash, output_hash: outputHash, output_bytes: audio.buffer.length, storage_bucket: GENERATIVE_VIDEO_BUCKET, storage_path: objectPath, estimated_cost_usd: SECOND_SHORT_TTS_UNIT_USD };
      await update(supabase, scene.id, "TTS", "SUCCEEDED", { storage_bucket: GENERATIVE_VIDEO_BUCKET, storage_path: objectPath, content_hash: outputHash, artifact_reference: objectPath, result });
      logger({ event: "second_short_tts_completed", scene_id: scene.id, hash: outputHash });
      results.push({ scene_id: scene.id, ...result });
    } catch (error) {
      await update(supabase, scene.id, "TTS", "FAILED", { error_code: error.code || error.message || "tts_failed" });
      logger({ event: "second_short_tts_failed", scene_id: scene.id, error: error.code || error.message });
      results.push({ scene_id: scene.id, status: "failed", error: error.code || error.message });
    }
  }
  return { stage: "TTS", results, provider_calls: (await runs(supabase, "TTS")).length };
}

export async function secondShortStatus({ supabase, includeReviewUrls = false }) {
  const [images, videos, tts] = await Promise.all([runs(supabase, "IMAGE"), runs(supabase, "VIDEO"), runs(supabase, "TTS")]);
  if (includeReviewUrls) {
    for (const row of [...images, ...videos]) {
      if (row.storage_path) row.review_url = await signedObject(supabase, row.storage_path, 7200);
    }
  }
  return { episode_id: SECOND_SHORT_EPISODE_ID, images, videos, tts };
}

export function shouldRunSecondShortOnBoot(env = process.env) {
  return String(env.LUMI_RUNTIME_ENV || "").toLowerCase() === "staging"
    && env.LUMI_SECOND_SHORT_BOOT_ENABLED === "true"
    && ["IMAGE","VIDEO","TTS"].includes(String(env.LUMI_SECOND_SHORT_BOOT_STAGE || "").toUpperCase());
}

export async function runSecondShortOnBoot({ env = process.env, supabase, openAiApiKey, higgsfieldApiKey, supabaseUrl, logger = () => {} }) {
  const stage = String(env.LUMI_SECOND_SHORT_BOOT_STAGE || "").toUpperCase();
  if (!shouldRunSecondShortOnBoot(env)) return { status: "disabled", provider_calls: 0 };
  if (stage === "IMAGE") return runSecondShortImages({ supabase, openAiApiKey, supabaseUrl, logger });
  if (stage === "VIDEO") return runSecondShortVideos({ supabase, higgsfieldApiKey, logger });
  return runSecondShortTts({ supabase, openAiApiKey, logger });
}
