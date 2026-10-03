import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
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

const execFileAsync = promisify(execFile);

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


const SECOND_SHORT_TTS_RECOVERY_ID = `${SECOND_SHORT_ID}_tts_recovery`;
const SECOND_SHORT_AUDIO_BUCKET = "generated-audio";

async function recoveryRuns(supabase) {
  const { data, error } = await supabase.from("lumi_pilot_runs").select("*")
    .eq("pilot_id", SECOND_SHORT_TTS_RECOVERY_ID).eq("stage", "TTS").order("created_at");
  if (error) throw new Error("second_short_tts_recovery_runs_read_failed");
  return data || [];
}

async function recoveryClaim(supabase, sceneId) {
  const prior = await recoveryRuns(supabase);
  const existing = prior.find((row) => row.scene_id === sceneId);
  if (existing) return { claimed: false, row: existing };
  const booked = prior.reduce((sum, row) => sum + Number(row.estimated_cost_usd || 0), 0);
  if (prior.length + 1 > SECOND_SHORT_SCENES.length) throw new Error("second_short_tts_recovery_call_cap_exceeded");
  if (!budgetAllowsClaim({
    booked,
    priorCount: prior.length,
    estimate: SECOND_SHORT_TTS_UNIT_USD,
    ceiling: SECOND_SHORT_TTS_MAX_USD,
  })) throw new Error("second_short_tts_recovery_budget_exceeded");
  const payload = {
    pilot_id: SECOND_SHORT_TTS_RECOVERY_ID,
    scene_id: sceneId,
    stage: "TTS",
    status: "CLAIMED",
    provider_calls: 1,
    estimated_cost_usd: SECOND_SHORT_TTS_UNIT_USD,
    claimed_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    result: { lineage: { original_pilot_id: SECOND_SHORT_ID, recovery_type: "RECOVERY_REPLACEMENT_SYNTHESIS" } },
  };
  const { data, error } = await supabase.from("lumi_pilot_runs").insert(payload).select("*").single();
  if (!error) return { claimed: true, row: data };
  if (error.code === "23505") {
    const duplicate = (await recoveryRuns(supabase)).find((row) => row.scene_id === sceneId);
    return { claimed: false, row: duplicate };
  }
  throw new Error("second_short_tts_recovery_claim_failed");
}

async function recoveryUpdate(supabase, sceneId, status, patch = {}) {
  const terminal = status === "SUCCEEDED" || status === "FAILED";
  const { data, error } = await supabase.from("lumi_pilot_runs").update({
    status,
    ...patch,
    updated_at: new Date().toISOString(),
    ...(terminal ? { completed_at: new Date().toISOString() } : {}),
  }).eq("pilot_id", SECOND_SHORT_TTS_RECOVERY_ID).eq("scene_id", sceneId).eq("stage", "TTS").select("*").single();
  if (error) throw new Error("second_short_tts_recovery_update_failed");
  return data;
}

async function uploadAudioObject(supabase, objectPath, buffer, upsert = false) {
  const { data, error } = await supabase.storage.from(SECOND_SHORT_AUDIO_BUCKET).upload(objectPath, buffer, {
    contentType: "audio/mpeg",
    upsert,
    cacheControl: "31536000",
  });
  if (error) throw new Error(`second_short_audio_upload_failed:${error.message || error.code || "unknown"}`);
  return data;
}

async function downloadAudioObject(supabase, objectPath) {
  const { data, error } = await supabase.storage.from(SECOND_SHORT_AUDIO_BUCKET).download(objectPath);
  if (error) throw new Error(`second_short_audio_download_failed:${error.message || error.code || "unknown"}`);
  return Buffer.from(await data.arrayBuffer());
}

async function decodeAudioBuffer(buffer, prefix = "lumi-tts-audit-") {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  const path = join(dir, "audio.mp3");
  try {
    await writeFile(path, buffer);
    const probe = await execFileAsync("ffprobe", [
      "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", path,
    ]);
    await execFileAsync("ffmpeg", ["-v", "error", "-i", path, "-f", "null", "-"]);
    const duration = Number(String(probe.stdout || "").trim());
    if (!Number.isFinite(duration) || duration <= 0) throw new Error("second_short_audio_duration_invalid");
    return Number(duration.toFixed(6));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function secondShortTtsStorageDryTest({ supabase, logger = () => {} }) {
  if (!supabase) throw new Error("second_short_tts_storage_not_configured");
  const dir = await mkdtemp(join(tmpdir(), "lumi-tts-storage-gate-"));
  const localPath = join(dir, "locally-generated-test.mp3");
  const objectPath = `${SECOND_SHORT_PREFIX}/audio/_storage-gate/${crypto.randomUUID()}.mp3`;
  let uploaded = false;
  try {
    await execFileAsync("ffmpeg", [
      "-v", "error", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono",
      "-t", "0.30", "-c:a", "libmp3lame", "-b:a", "64k", "-y", localPath,
    ]);
    const local = await readFile(localPath);
    const localSha = sha256(local);
    await uploadAudioObject(supabase, objectPath, local, false);
    uploaded = true;
    const downloaded = await downloadAudioObject(supabase, objectPath);
    const downloadedSha = sha256(downloaded);
    const duration = await decodeAudioBuffer(downloaded, "lumi-tts-storage-download-");
    if (localSha !== downloadedSha) throw new Error("second_short_tts_storage_sha_mismatch");
    const result = {
      status: "PASS",
      bucket: SECOND_SHORT_AUDIO_BUCKET,
      object_path_strategy: `${SECOND_SHORT_PREFIX}/audio/<scene>/<narration_hash>/narration.mp3`,
      extension: ".mp3",
      content_type: "audio/mpeg",
      upload: "PASS",
      download: "PASS",
      sha_match: "PASS",
      audio_decode: "PASS",
      duration_seconds: duration,
      test_sha256: localSha,
      test_artifact_deleted: false,
    };
    logger({ event: "second_short_tts_storage_gate_passed", ...result });
    return result;
  } finally {
    if (uploaded) {
      const { error } = await supabase.storage.from(SECOND_SHORT_AUDIO_BUCKET).remove([objectPath]);
      if (error) logger({ event: "second_short_tts_storage_gate_cleanup_failed", error: error.message || error.code });
      else logger({ event: "second_short_tts_storage_gate_test_artifact_deleted", object_path: objectPath });
    }
    await rm(dir, { recursive: true, force: true });
  }
}

export async function runSecondShortTtsRecovery({ supabase, openAiApiKey, logger = () => {} }) {
  if (!supabase || !openAiApiKey) throw new Error("second_short_tts_recovery_provider_not_configured");
  const gate = await secondShortTtsStorageDryTest({ supabase, logger });
  if (gate.status !== "PASS") throw new Error("second_short_tts_storage_gate_failed");
  const [plan, originals] = await Promise.all([scenePlan(), runs(supabase, "TTS")]);
  const results = [];
  for (const scene of plan.scenes) {
    const original = originals.find((row) => row.scene_id === scene.id);
    if (!original) {
      results.push({ scene_id: scene.id, status: "blocked", error: "original_tts_attempt_missing" });
      continue;
    }
    if (original.status === "SUCCEEDED" && original.storage_path && original.content_hash) {
      results.push({ scene_id: scene.id, status: "original_reused", storage_path: original.storage_path, output_hash: original.content_hash });
      continue;
    }
    const acquired = await recoveryClaim(supabase, scene.id);
    if (!acquired.claimed) {
      results.push({
        scene_id: scene.id,
        status: "cache_hit",
        claim_status: acquired.row?.status,
        provider_request_id: acquired.row?.provider_request_id || null,
        storage_path: acquired.row?.storage_path || null,
        output_hash: acquired.row?.content_hash || null,
      });
      continue;
    }
    const narrationHash = sha256(scene.narration);
    const lineage = {
      recovery_type: "RECOVERY_REPLACEMENT_SYNTHESIS",
      original_pilot_id: SECOND_SHORT_ID,
      original_run_id: original.id,
      original_status: original.status,
      original_error_code: original.error_code,
      original_provider_request_id: original.provider_request_id || null,
    };
    await recoveryUpdate(supabase, scene.id, "REQUESTED", {
      provider: "openai",
      result: { dispatch_state: "REQUESTED", narration_hash: narrationHash, lineage },
    });
    try {
      const audio = await synthesizeSpeech({
        apiKey: openAiApiKey,
        input: scene.narration,
        model: "gpt-4o-mini-tts",
        voice: "marin",
      });
      await recoveryUpdate(supabase, scene.id, "REQUESTED", {
        provider_request_id: audio.provider_request_id,
        result: {
          dispatch_state: "SYNTHESIZED_STORAGE_PENDING",
          narration_hash: narrationHash,
          provider_request_id: audio.provider_request_id,
          lineage,
        },
      });
      const outputHash = sha256(audio.buffer);
      const objectPath = `${SECOND_SHORT_PREFIX}/audio/${scene.id}/${narrationHash}/narration.mp3`;
      await uploadAudioObject(supabase, objectPath, audio.buffer, false);
      const stored = await downloadAudioObject(supabase, objectPath);
      if (sha256(stored) !== outputHash) throw new Error("second_short_tts_recovery_storage_sha_mismatch");
      const duration = await decodeAudioBuffer(stored);
      const result = {
        status: "completed",
        recovery_type: "RECOVERY_REPLACEMENT_SYNTHESIS",
        model: audio.model,
        voice: audio.voice,
        provider_request_id: audio.provider_request_id,
        narration_hash: narrationHash,
        output_hash: outputHash,
        output_bytes: audio.buffer.length,
        duration_seconds: duration,
        storage_bucket: SECOND_SHORT_AUDIO_BUCKET,
        storage_path: objectPath,
        estimated_cost_usd: SECOND_SHORT_TTS_UNIT_USD,
        lineage,
      };
      await recoveryUpdate(supabase, scene.id, "SUCCEEDED", {
        provider_request_id: audio.provider_request_id,
        storage_bucket: SECOND_SHORT_AUDIO_BUCKET,
        storage_path: objectPath,
        content_hash: outputHash,
        artifact_reference: objectPath,
        result,
      });
      logger({ event: "second_short_tts_recovery_completed", scene_id: scene.id, request_id: audio.provider_request_id, hash: outputHash, duration_seconds: duration });
      results.push({ scene_id: scene.id, ...result });
    } catch (error) {
      await recoveryUpdate(supabase, scene.id, "FAILED", {
        error_code: error.code || error.message || "tts_recovery_failed",
      });
      logger({ event: "second_short_tts_recovery_failed", scene_id: scene.id, error: error.code || error.message });
      results.push({ scene_id: scene.id, status: "failed", error: error.code || error.message });
    }
  }
  return {
    stage: "TTS_RECOVERY",
    storage_gate: gate,
    results,
    provider_calls: (await recoveryRuns(supabase)).length,
  };
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
    && ["IMAGE","VIDEO","TTS","TTS_RECOVERY"].includes(String(env.LUMI_SECOND_SHORT_BOOT_STAGE || "").toUpperCase());
}

export async function runSecondShortOnBoot({ env = process.env, supabase, openAiApiKey, higgsfieldApiKey, supabaseUrl, logger = () => {} }) {
  const stage = String(env.LUMI_SECOND_SHORT_BOOT_STAGE || "").toUpperCase();
  if (!shouldRunSecondShortOnBoot(env)) return { status: "disabled", provider_calls: 0 };
  if (stage === "IMAGE") return runSecondShortImages({ supabase, openAiApiKey, supabaseUrl, logger });
  if (stage === "VIDEO") return runSecondShortVideos({ supabase, higgsfieldApiKey, logger });
  if (stage === "TTS_RECOVERY") return runSecondShortTtsRecovery({ supabase, openAiApiKey, logger });
  return runSecondShortTts({ supabase, openAiApiKey, logger });
}
