import express from "express";
import { createClient } from "@supabase/supabase-js";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import crypto from "node:crypto";
import { renderScene } from "./lib/render-media.js";
import { renderStoryScene, CHARACTER_FILES } from "./lib/story-renderer.js";
import { STORY_VERSION, validateProduction, validateSpokenText, createTimeline, verifyTimeline } from "./lib/story-timeline.js";
import { ACTOR_VERSION, MOUTH_FILE, analyzePerformance, validatePerformance } from "./lib/lumi-performance.js";
import { renderProfile, validateManifest, verifyAssetHash, isApprovedFinal } from "./lib/render-profiles.js";
import { blenderVersion, renderLumi2DPilot, renderLumiPilot } from "./lib/blender.js";
import { decryptJson, encryptJson } from "./lib/security.js";
import { DEFAULT_TTS_INSTRUCTIONS, OpenAIRequestError, synthesizeSpeech } from "./lib/openai.js";
import {
  buildAuthorizationUrl,
  buildVideoMetadata,
  exchangeAuthorizationCode,
  getOwnChannel,
  refreshAccessToken,
  uploadVideoBuffer,
} from "./lib/youtube.js";

const execFileAsync = promisify(execFile);

const SUPABASE_URL = process.env.SUPABASE_URL || "https://hdptwtzhpfdrqiuezjhu.supabase.co";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const RENDER_API_TOKEN = process.env.RENDER_API_TOKEN || "";
const ADMIN_API_TOKEN = process.env.ADMIN_API_TOKEN || "";
const BUCKET_RENDERED = process.env.BUCKET_RENDERED || "rendered-videos";
const BUCKET_AUDIO = process.env.BUCKET_AUDIO || "generated-audio";
const PORT = process.env.PORT || "3000";
const FFMPEG_TIMEOUT_MS = Number(process.env.FFMPEG_TIMEOUT_MS || 15 * 60 * 1000);
const BLENDER_BIN = process.env.BLENDER_BIN || "blender";
const BLENDER_TIMEOUT_MS = Number(process.env.BLENDER_TIMEOUT_MS || 30 * 60 * 1000);
const YOUTUBE_CLIENT_ID = process.env.YOUTUBE_CLIENT_ID || "";
const YOUTUBE_CLIENT_SECRET = process.env.YOUTUBE_CLIENT_SECRET || "";
const YOUTUBE_OAUTH_STATE = process.env.YOUTUBE_OAUTH_STATE || "";
const TOKEN_ENCRYPTION_KEY = process.env.TOKEN_ENCRYPTION_KEY || "";
const RENDER_EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL || "";
const YOUTUBE_REDIRECT_URI = process.env.YOUTUBE_REDIRECT_URI || `${RENDER_EXTERNAL_URL}/youtube/oauth/callback`;
const YOUTUBE_ALLOW_PUBLIC = process.env.YOUTUBE_ALLOW_PUBLIC === "true";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_TTS_MODEL = process.env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts";
const OPENAI_TTS_VOICE = process.env.OPENAI_TTS_VOICE || "marin";
const OPENAI_TTS_INSTRUCTIONS = process.env.OPENAI_TTS_INSTRUCTIONS || DEFAULT_TTS_INSTRUCTIONS;

const SUPPORTED_TTS_VOICES = new Set([
  "alloy", "ash", "ballad", "cedar", "coral", "echo", "fable",
  "marin", "nova", "onyx", "sage", "shimmer", "verse",
]);

const hasSupabaseKey = Boolean(SUPABASE_SERVICE_ROLE_KEY);
const hasRenderToken = Boolean(RENDER_API_TOKEN);

const supabase = hasSupabaseKey
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
  : null;

const app = express();
app.use(express.json({ limit: "1mb" }));

const FONT_PATH = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";

// One heavy FFmpeg video at a time. This protects the free Render instance and
// prevents duplicate Make/Supabase events from starting concurrent renders.
let activeVideoId = null;
let activeRenderAttemptId = null;
let recoveryRunning = false;
let workerRunning = false;
const pendingVideoIds = [];
const reservedVideoIds = new Set();
const pilotJobs = new Map();
let activePilotJobId = null;
let detectedBlenderVersion = null;

function safeError(err) {
  return (err instanceof Error ? err.message : String(err)).slice(0, 1800);
}

function authorized(req) {
  const suppliedToken = req.get("x-render-token");
  return Boolean(suppliedToken) && (
    (hasRenderToken && suppliedToken === RENDER_API_TOKEN) ||
    (ADMIN_API_TOKEN && suppliedToken === ADMIN_API_TOKEN)
  );
}

function htmlEscape(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function youtubeConfigMissing() {
  return [
    ["YOUTUBE_CLIENT_ID", YOUTUBE_CLIENT_ID],
    ["YOUTUBE_CLIENT_SECRET", YOUTUBE_CLIENT_SECRET],
    ["YOUTUBE_OAUTH_STATE", YOUTUBE_OAUTH_STATE],
    ["TOKEN_ENCRYPTION_KEY", TOKEN_ENCRYPTION_KEY],
    ["YOUTUBE_REDIRECT_URI", YOUTUBE_REDIRECT_URI],
  ].filter(([, value]) => !value).map(([name]) => name);
}

async function getYouTubeConnection(channelId = 1) {
  const { data, error } = await supabase
    .from("social_connections")
    .select("channel_id,platform,account_id,account_name,credentials_ciphertext,credentials_iv,credentials_auth_tag,status,connected_at")
    .eq("channel_id", channelId)
    .eq("platform", "youtube")
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function setIntegrationStatus(platform, status) {
  const { data: settings, error } = await supabase
    .from("cf_bot_settings")
    .select("id,integrations")
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!settings) return;
  await supabase.from("cf_bot_settings").update({
    integrations: { ...(settings.integrations || {}), [platform]: status },
  }).eq("id", settings.id);
}

async function runPilotJob(job) {
  activePilotJobId = job.id;
  job.status = "rendering";
  job.started_at = new Date().toISOString();
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), `lumi-pilot-${job.id}-`));
  const outputPath = path.join(workDir, "lumi-pilot.mp4");
  try {
    const renderer = job.mode === "canonical_2d" ? renderLumi2DPilot : renderLumiPilot;
    await renderer({
      outputPath,
      width: job.width,
      height: job.height,
      fps: job.fps,
      seconds: job.seconds,
      binary: BLENDER_BIN,
      timeoutMs: BLENDER_TIMEOUT_MS,
    });
    const buffer = await fs.readFile(outputPath);
    const objectName = `pilots/lumi-blender-${Date.now()}.mp4`;
    const { error: uploadError } = await supabase.storage.from(BUCKET_RENDERED).upload(objectName, buffer, {
      contentType: "video/mp4",
      upsert: false,
      cacheControl: "31536000",
    });
    if (uploadError) throw uploadError;
    job.status = "completed";
    job.render_url = `${SUPABASE_URL}/storage/v1/object/public/${BUCKET_RENDERED}/${objectName}`;
    job.size_bytes = buffer.length;
    job.finished_at = new Date().toISOString();
  } catch (error) {
    job.status = "failed";
    job.error = safeError(error);
    job.finished_at = new Date().toISOString();
    console.error(`Lumi pilot ${job.id} failed:`, error);
  } finally {
    activePilotJobId = null;
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

function wrapText(text, maxChars = 24) {
  if (!text) return "";
  const words = String(text).trim().split(/\s+/);
  const lines = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (line && next.length > maxChars) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines.slice(0, 3).join("\n");
}

async function downloadToFile(url, destination) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Download failed ${r.status}: ${url}`);
  await fs.writeFile(destination, Buffer.from(await r.arrayBuffer()));
}

async function getDuration(filePath) {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    filePath,
  ], { timeout: 60_000 });
  const d = Number.parseFloat(stdout.trim());
  if (!Number.isFinite(d) || d <= 0) throw new Error(`Invalid duration: ${filePath}`);
  return d;
}

async function concatScenes(files, listPath, outputPath, storyProfile = null) {
  const body = files.map((p) => `file '${p.replaceAll("'", "'\\''")}'`).join("\n");
  await fs.writeFile(listPath, body, "utf8");
  await execFileAsync("ffmpeg", [
    "-y",
    "-threads", "1",
    "-f", "concat",
    "-safe", "0",
    "-i", listPath,
    ...(storyProfile ? ["-c:v", "copy", "-af", "loudnorm=I=-16:TP=-1.5:LRA=9", "-c:a", "aac", "-b:a", storyProfile.audioBitrate, "-ar", "48000", "-ac", "2"] : ["-c", "copy"]),
    "-movflags", "+faststart",
    outputPath,
  ], {
    maxBuffer: 10 * 1024 * 1024,
    timeout: FFMPEG_TIMEOUT_MS,
  });
}

async function renderVideo(videoId) {
  if (!supabase) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not configured");
  let workDir;
  let claimed = false;
  let heartbeat;
  const attemptId = crypto.randomUUID();
  try {
    const { data: claim, error: claimError } = await supabase.rpc("cf_claim_render", {
      p_video: videoId, p_attempt: attemptId,
    });
    if (claimError) throw claimError;
    if (!claim) return;
    claimed = true;
    const video = claim.video;
    const manifest = validateManifest(video, claim.manifest);
    const profile = renderProfile(video.render_stage);
    const story = manifest.scenes.some(scene => scene.production != null);
    if (story) {
      if (video.render_stage === "final" && manifest.renderer !== STORY_VERSION) throw new Error("Falta el motor de la vista previa aprobada.");
      manifest.renderer = STORY_VERSION;
      for (const scene of manifest.scenes) {
        scene.production = validateProduction(scene.production);
        validateSpokenText(scene.narration);
      }
      if (video.render_stage === "preview") manifest.actor_renderer = ACTOR_VERSION;
      if (manifest.actor_renderer && manifest.actor_renderer !== ACTOR_VERSION) throw new Error("La actuación aprobada necesita su motor original.");
      const actorFiles = manifest.actor_renderer ? [...CHARACTER_FILES,MOUTH_FILE] : CHARACTER_FILES;
      const hashes = await Promise.all(actorFiles.map(async file =>
        crypto.createHash("sha256").update(await fs.readFile(path.resolve(file))).digest("hex")));
      if (video.render_stage === "final") {
        if (!Array.isArray(manifest.character_sha256) || manifest.character_sha256.length !== hashes.length) throw new Error("Falta la identidad de Lumi aprobada.");
        hashes.forEach((hash,i) => verifyAssetHash(manifest.character_sha256[i],hash,"Lumi " + i));
      }
      manifest.character_sha256 = hashes;
    } else if (manifest.renderer && manifest.renderer !== "static-v1") {
      throw new Error("Motor de render no compatible con este manifiesto.");
    }
    activeVideoId = videoId;
    activeRenderAttemptId = attemptId;
    heartbeat = setInterval(() => {
      supabase.rpc("cf_renew_render_lease", {p_video:videoId,p_attempt:attemptId})
        .then(({error}) => { if (error) console.warn("Render lease renewal failed:", safeError(error)); })
        .catch(() => console.warn("Render lease temporarily unavailable"));
    }, 20_000);
    heartbeat.unref?.();
    console.log("Starting " + video.render_stage + " render for video " + videoId + " revision " + video.content_revision);
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), "cf-" + videoId + "-"));
    const rendered = [];
    const assetHost = new URL(SUPABASE_URL).hostname;
    for (const scene of manifest.scenes) {
      const n = String(scene.scene_number).padStart(2, "0");
      const imagePath = path.join(workDir, "scene-" + n + ".png");
      const audioPath = path.join(workDir, "scene-" + n + ".mp3");
      const textPath = path.join(workDir, "scene-" + n + ".txt");
      const scenePath = path.join(workDir, "scene-" + n + (story ? ".mkv" : ".mp4"));
      for (const assetUrl of [scene.image_url, scene.audio_url]) {
        const asset = new URL(assetUrl);
        if (asset.protocol !== "https:" || asset.hostname !== assetHost || !asset.pathname.startsWith("/storage/v1/object/")) {
          throw new Error("Los recursos deben estar guardados en el almacenamiento del proyecto.");
        }
      }
      await Promise.all([
        downloadToFile(scene.image_url, imagePath),
        downloadToFile(scene.audio_url, audioPath),
      ]);
      const digest = async file => crypto.createHash("sha256").update(await fs.readFile(file)).digest("hex");
      const [imageHash, audioHash] = await Promise.all([digest(imagePath), digest(audioPath)]);
      if (video.render_stage === "final") {
        verifyAssetHash(scene.image_sha256, imageHash, "imagen " + n);
        verifyAssetHash(scene.audio_sha256, audioHash, "voz " + n);
      }
      scene.image_sha256 = imageHash;
      scene.audio_sha256 = audioHash;
      const audioDuration = await getDuration(audioPath);
      if (audioDuration > 180) throw new Error("Una escena supera el límite de tres minutos.");
      const txt = wrapText(scene.on_screen_text);
      await fs.writeFile(textPath, txt, "utf8");
      if (story) {
        scene.timeline = video.render_stage === "final"
          ? verifyTimeline(scene.timeline, audioDuration, scene.production)
          : createTimeline(audioDuration, scene.production);
        scene.duration_seconds = scene.timeline.duration_seconds;
        if (manifest.actor_renderer) {
          scene.performance = video.render_stage === "final"
            ? validatePerformance(scene.performance,scene.timeline)
            : await analyzePerformance(audioPath,scene.timeline);
        }
        await renderStoryScene({imagePath,audioPath,textPath,outputPath:scenePath,profile,production:scene.production,timeline:scene.timeline,performance:manifest.actor_renderer ? scene.performance : null,fontPath:FONT_PATH,timeoutMs:FFMPEG_TIMEOUT_MS});
      } else {
        scene.duration_seconds = audioDuration;
        await renderScene(imagePath, audioPath, textPath, scenePath, Boolean(txt), profile, {fontPath:FONT_PATH,timeoutMs:FFMPEG_TIMEOUT_MS});
      }
      rendered.push(scenePath);
      console.log("Video " + videoId + ": " + video.render_stage + " scene " + n + " complete");
    }
    if (video.render_stage === "preview") {
      const { data: saved, error: saveError } = await supabase.rpc("cf_save_render_manifest", {
        p_video:videoId,p_attempt:attemptId,p_revision:video.content_revision,p_manifest:manifest,
      });
      if (saveError) throw saveError;
      if (!saved) throw new Error("El intento venció; se descartó esta vista previa.");
    }
    const finalPath = path.join(workDir, "result.mp4");
    await concatScenes(rendered, path.join(workDir, "concat.txt"), finalPath, story ? profile : null);
    const duration = await getDuration(finalPath);
    const objectName = "channel-" + video.channel_id + "/video-" + videoId + "/r" +
      video.content_revision + "-" + video.render_stage + "-" + attemptId + ".mp4";
    const {error:uploadError} = await supabase.storage.from(BUCKET_RENDERED).upload(
      objectName, await fs.readFile(finalPath),
      {contentType:"video/mp4",upsert:false,cacheControl:"31536000"}
    );
    if (uploadError) throw uploadError;
    const renderUrl = SUPABASE_URL + "/storage/v1/object/public/" + BUCKET_RENDERED + "/" + objectName;
    const { data: completed, error: completeError } = await supabase.rpc("cf_complete_render", {
      p_video:videoId,p_attempt:attemptId,p_revision:video.content_revision,p_url:renderUrl,
      p_duration:Number(duration.toFixed(2)),
    });
    if (completeError) throw completeError;
    if (!completed) throw new Error("El intento venció. Este archivo no se habilitó para revisión ni publicación.");
    console.log("Completed " + video.render_stage + " video " + videoId + " at " + profile.width + "x" + profile.height);
  } catch (err) {
    console.error("Render failed for video " + videoId + ":", safeError(err));
    if (supabase && claimed) {
      const {error} = await supabase.rpc("cf_fail_render", {p_video:videoId,p_attempt:attemptId,p_error:safeError(err)});
      if (error) console.warn("Could not record render failure:", safeError(error));
    } else if (supabase) {
      await supabase.from("videos").update({status:"failed",error_message:safeError(err)})
        .eq("id",videoId).eq("status","queued");
    }
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    if (activeRenderAttemptId === attemptId) {
      activeRenderAttemptId = null;
      if (activeVideoId === videoId) activeVideoId = null;
    }
    if (workDir) await fs.rm(workDir, {recursive:true,force:true}).catch(() => {});
  }
}

async function runRenderQueue() {
  if (workerRunning) return;
  workerRunning = true;

  try {
    while (pendingVideoIds.length > 0) {
      const videoId = pendingVideoIds.shift();
      if (!videoId) continue;

      try {
        await renderVideo(videoId);
      } finally {
        reservedVideoIds.delete(videoId);
      }
    }
  } finally {
    workerRunning = false;
  }
}

function enqueueRender(videoId, source = "api") {
  // Duplicate request for an active/waiting video: no FFmpeg, no extra work.
  if (reservedVideoIds.has(videoId)) {
    console.log(`Video ${videoId}: duplicate render request ignored (${source})`);
    return {
      accepted: false,
      reason: "already_reserved",
      active_video_id: activeVideoId,
      queue_length: pendingVideoIds.length,
    };
  }

  reservedVideoIds.add(videoId);
  pendingVideoIds.push(videoId);
  console.log(`Video ${videoId}: queued locally (${source}), queue=${pendingVideoIds.length}`);
  setImmediate(() => runRenderQueue());

  return {
    accepted: true,
    reason: activeVideoId ? "queued_behind_active_render" : "queued_for_render",
    active_video_id: activeVideoId,
    queue_length: pendingVideoIds.length,
  };
}

// Normal production entry point. Make only sends video_id; this endpoint owns
// readiness checking and the atomic draft -> queued transition.
async function requestRenderIfReady(videoId) {
  if (reservedVideoIds.has(videoId)) {
    console.log(`Video ${videoId}: readiness request ignored; already reserved`);
    return {
      accepted: false,
      reason: "already_reserved",
      active_video_id: activeVideoId,
      queue_length: pendingVideoIds.length,
    };
  }

  const { data: readiness, error: readinessError } = await supabase
    .from("video_render_readiness")
    .select("video_id,is_ready,video_status")
    .eq("video_id", videoId)
    .maybeSingle();

  if (readinessError) throw readinessError;
  if (!readiness) {
    return { accepted: false, reason: "readiness_not_found" };
  }

  if (readiness.video_status === "queued") return enqueueRender(videoId, "durable_queued_render");

  if (!readiness.is_ready) {
    return { accepted: false, reason: "not_ready" };
  }

  if (readiness.video_status !== "draft") {
    return {
      accepted: false,
      reason: `status_${readiness.video_status}`,
    };
  }

  // Atomic claim at the orchestration boundary. If multiple scene events race,
  // exactly one request can change draft -> queued.
  const { data: queuedVideo, error: queueError } = await supabase
    .from("videos")
    .update({ status: "queued", error_message: null })
    .eq("id", videoId)
    .eq("status", "draft")
    .select("id")
    .maybeSingle();

  if (queueError) throw queueError;
  if (!queuedVideo) {
    return { accepted: false, reason: "already_claimed" };
  }

  return enqueueRender(videoId, "render_if_ready");
}

async function recoverQueuedVideos() {
  if (!supabase || recoveryRunning) return;
  recoveryRunning = true;
  try {
    const {error: recoveryError} = await supabase.rpc("cf_recover_expired_renders");
    if (recoveryError) throw recoveryError;
    const { data, error } = await supabase
      .from("videos")
      .select("id")
      .eq("status", "queued")
      .order("updated_at", { ascending: true })
      .limit(10);

    if (error) throw error;

    for (const row of data ?? []) {
      enqueueRender(Number(row.id), "startup_recovery");
    }

    if (data?.length) {
      console.log(`Startup recovery found ${data.length} queued video(s)`);
    }
  } catch (err) {
    console.warn(`Queue recovery failed: ${safeError(err)}`);
  } finally { recoveryRunning = false; }
}

async function requeueActiveVideo() {
  if (!supabase || !activeVideoId || !activeRenderAttemptId) return;
  const {error} = await supabase.rpc("cf_release_render", {p_video:activeVideoId,p_attempt:activeRenderAttemptId});
  if (error) console.warn("Could not release render lease:", safeError(error));
}

app.get("/health", (_req, res) => {
  const ready = hasSupabaseKey;
  res.status(ready ? 200 : 503).json({
    ok: ready,
    service: "content-factory-renderer",
    active_video_id: activeVideoId,
    queue_length: pendingVideoIds.length,
    reserved_video_ids: [...reservedVideoIds],
    config: {
      supabase_url: true,
      supabase_service_role_key: hasSupabaseKey,
      render_api_token: hasRenderToken,
      bucket_rendered: true,
      single_flight: true,
      duplicate_protection: true,
      atomic_ready_claim: true,
      startup_recovery: true,
      visual_mode: detectedBlenderVersion ? "canonical_2d_blender_ready" : "proven_static_vertical",
      blender: detectedBlenderVersion,
      canonical_lumi_2d: true,
      staged_rendering: "ld-hd-v1",
      story_renderer: STORY_VERSION,
      actor_renderer: ACTOR_VERSION,
      preview_resolution: "360x640",
      final_resolution: "1080x1920",
      final_requires_approval: true,
      openai_tts_configured: Boolean(OPENAI_API_KEY),
      youtube_oauth_configured: youtubeConfigMissing().length === 0,
    },
  });
});

// Generate narration in the cloud without Make. The active character profile
// controls the voice, so Lumi keeps one approved sound across every scene.
app.post("/voice/generate", async (req, res) => {
  if (!authorized(req)) return res.status(401).json({ ok: false, error: "unauthorized" });
  if (!supabase) return res.status(503).json({ ok: false, error: "renderer_not_configured" });
  if (!OPENAI_API_KEY) {
    return res.status(503).json({ ok: false, error: "openai_api_not_configured", missing: ["OPENAI_API_KEY"] });
  }

  const requestedVideoId = Number(req.body?.video_id);
  const requestedSceneId = Number(req.body?.scene_id);
  const videoIdValid = Number.isInteger(requestedVideoId) && requestedVideoId > 0;
  const sceneIdValid = Number.isInteger(requestedSceneId) && requestedSceneId > 0;
  if (videoIdValid === sceneIdValid) {
    return res.status(400).json({ ok: false, error: "send_exactly_one_of_video_id_or_scene_id" });
  }

  try {
    let selectedScene = null;
    let videoId = requestedVideoId;
    if (sceneIdValid) {
      const { data, error } = await supabase
        .from("scenes")
        .select("id,video_id,scene_number,narration,image_url,audio_url,status,metadata")
        .eq("id", requestedSceneId)
        .maybeSingle();
      if (error) throw error;
      if (!data) return res.status(404).json({ ok: false, error: "scene_not_found" });
      selectedScene = data;
      videoId = Number(data.video_id);
    }

    const { data: video, error: videoError } = await supabase
      .from("videos")
      .select("id,channel_id,status")
      .eq("id", videoId)
      .maybeSingle();
    if (videoError) throw videoError;
    if (!video) return res.status(404).json({ ok: false, error: "video_not_found" });
    if (!["draft", "generating", "failed"].includes(video.status)) {
      return res.status(409).json({ ok: false, error: "video_locked_for_asset_changes", status: video.status });
    }

    const channelId = Number(video.channel_id || 1);
    const { data: character, error: characterError } = await supabase
      .from("characters")
      .select("id,name,voice_profile")
      .eq("channel_id", channelId)
      .eq("active", true)
      .order("id", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (characterError) throw characterError;

    const profile = character?.voice_profile || {};
    const model = profile.model || OPENAI_TTS_MODEL;
    const voice = String(profile.voice || OPENAI_TTS_VOICE).toLowerCase();
    const instructions = profile.instructions || OPENAI_TTS_INSTRUCTIONS;
    if (!SUPPORTED_TTS_VOICES.has(voice)) {
      return res.status(422).json({ ok: false, error: "unsupported_tts_voice", voice });
    }

    let scenes;
    if (selectedScene) {
      scenes = [selectedScene];
    } else {
      const { data, error } = await supabase
        .from("scenes")
        .select("id,video_id,scene_number,narration,image_url,audio_url,status,metadata")
        .eq("video_id", videoId)
        .order("scene_number", { ascending: true });
      if (error) throw error;
      scenes = data || [];
    }
    if (!scenes.length) return res.status(404).json({ ok: false, error: "no_scenes_found" });

    const generated = [];
    const skipped = [];
    for (const scene of scenes) {
      if (!String(scene.narration || "").trim()) {
        skipped.push({ scene_id: scene.id, reason: "empty_narration" });
        continue;
      }
      if (scene.audio_url && req.body?.force !== true) {
        skipped.push({ scene_id: scene.id, reason: "audio_already_exists" });
        continue;
      }

      const speech = await synthesizeSpeech({
        apiKey: OPENAI_API_KEY,
        input: scene.narration,
        model,
        voice,
        instructions,
      });
      const version = Date.now();
      const objectName = `channel-${channelId}/video-${video.id}/scene-${scene.scene_number}-${version}.mp3`;
      const { error: uploadError } = await supabase.storage.from(BUCKET_AUDIO).upload(objectName, speech.buffer, {
        contentType: "audio/mpeg",
        upsert: false,
        cacheControl: "31536000",
      });
      if (uploadError) throw uploadError;

      const audioUrl = `${SUPABASE_URL}/storage/v1/object/public/${BUCKET_AUDIO}/${objectName}`;
      const metadata = {
        ...(scene.metadata || {}),
        audio: {
          provider: "openai",
          model: speech.model,
          voice: speech.voice,
          generated_at: new Date().toISOString(),
          disclosure: "Voz generada con inteligencia artificial",
        },
      };
      const { error: updateError } = await supabase.from("scenes").update({
        audio_url: audioUrl,
        metadata,
        status: scene.image_url ? "ready" : scene.status,
      }).eq("id", scene.id);
      if (updateError) throw updateError;
      generated.push({ scene_id: scene.id, scene_number: scene.scene_number, audio_url: audioUrl });
    }

    await supabase.from("videos").update({ voice_id: voice, error_message: null }).eq("id", video.id);
    return res.json({
      ok: true,
      video_id: video.id,
      character: character?.name || "Lumi",
      model,
      voice,
      generated,
      skipped,
    });
  } catch (error) {
    const status = error instanceof OpenAIRequestError ? error.status : 500;
    const code = error instanceof OpenAIRequestError ? error.code : "voice_generation_failed";
    console.error("Voice generation failed:", error);
    return res.status(status).json({ ok: false, error: code, message: safeError(error) });
  }
});

// Preferred production endpoint: one Make HTTP operation replaces GET readiness
// + PATCH queued + POST render.
app.post("/render-if-ready", async (req, res) => {
  if (!supabase) {
    return res.status(503).json({ ok: false, error: "renderer_not_configured", missing: ["SUPABASE_SERVICE_ROLE_KEY"] });
  }

  if (!authorized(req)) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }

  const videoId = Number(req.body?.video_id);
  if (!Number.isInteger(videoId) || videoId <= 0) {
    return res.status(400).json({ ok: false, error: "video_id must be a positive integer" });
  }

  try {
    const result = await requestRenderIfReady(videoId);
    return res.status(202).json({ ok: true, video_id: videoId, ...result });
  } catch (err) {
    console.error(`Readiness/queue failed for video ${videoId}:`, err);
    return res.status(500).json({ ok: false, video_id: videoId, error: safeError(err) });
  }
});

// Backward-compatible/manual endpoint. It expects video.status already queued,
// but still benefits from duplicate protection and single-flight execution.
app.post("/render", (req, res) => {
  if (!supabase) {
    return res.status(503).json({ ok: false, error: "renderer_not_configured", missing: ["SUPABASE_SERVICE_ROLE_KEY"] });
  }

  if (!authorized(req)) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }

  const videoId = Number(req.body?.video_id);
  if (!Number.isInteger(videoId) || videoId <= 0) {
    return res.status(400).json({ ok: false, error: "video_id must be a positive integer" });
  }

  const result = enqueueRender(videoId, "direct_render_api");
  return res.status(202).json({ ok: true, video_id: videoId, ...result });
});

// Cloud-only visual pilot. It is deliberately separate from the proven static
// renderer until the user approves Lumi's final 3D model and voice.
app.post("/lumi/pilot", (req, res) => {
  if (!authorized(req)) return res.status(401).json({ ok: false, error: "unauthorized" });
  return res.status(410).json({
    ok: false,
    error: "legacy_3d_lumi_retired",
    replacement: "/lumi/2d-pilot",
  });
});

app.post("/lumi/2d-pilot", (req, res) => {
  if (!authorized(req)) return res.status(401).json({ ok: false, error: "unauthorized" });
  if (!supabase || !detectedBlenderVersion) {
    return res.status(503).json({ ok: false, error: "blender_renderer_not_ready" });
  }
  if (activePilotJobId) {
    return res.status(409).json({ ok: false, error: "pilot_already_rendering", job_id: activePilotJobId });
  }
  const job = {
    id: crypto.randomUUID(),
    status: "queued",
    mode: "canonical_2d",
    quality: "character_motion_review",
    width: 360,
    height: 640,
    fps: 12,
    seconds: 4,
    created_at: new Date().toISOString(),
  };
  pilotJobs.set(job.id, job);
  setImmediate(() => runPilotJob(job));
  return res.status(202).json({ ok: true, job });
});

app.get("/lumi/pilot/:jobId", (req, res) => {
  if (!authorized(req)) return res.status(401).json({ ok: false, error: "unauthorized" });
  const job = pilotJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ ok: false, error: "pilot_job_not_found" });
  return res.json({ ok: true, job });
});

app.get("/youtube/status", async (req, res) => {
  if (!authorized(req)) return res.status(401).json({ ok: false, error: "unauthorized" });
  if (!supabase) return res.status(503).json({ ok: false, error: "renderer_not_configured" });
  try {
    const connection = await getYouTubeConnection(1);
    return res.json({
      ok: true,
      oauth_configured: youtubeConfigMissing().length === 0,
      missing: youtubeConfigMissing(),
      connected: connection?.status === "connected",
      account: connection ? { id: connection.account_id, name: connection.account_name, connected_at: connection.connected_at } : null,
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: safeError(error) });
  }
});

app.post("/youtube/oauth/start", (req, res) => {
  if (!authorized(req)) return res.status(401).json({ ok: false, error: "unauthorized" });
  const missing = youtubeConfigMissing();
  if (missing.length) return res.status(503).json({ ok: false, error: "youtube_oauth_not_configured", missing });
  return res.json({
    ok: true,
    authorization_url: buildAuthorizationUrl({
      clientId: YOUTUBE_CLIENT_ID,
      redirectUri: YOUTUBE_REDIRECT_URI,
      state: YOUTUBE_OAUTH_STATE,
    }),
  });
});

app.get("/youtube/oauth/callback", async (req, res) => {
  if (req.query.state !== YOUTUBE_OAUTH_STATE || !req.query.code) {
    return res.status(400).type("html").send("<h1>Conexión rechazada</h1><p>El estado de autorización no es válido.</p>");
  }
  const missing = youtubeConfigMissing();
  if (!supabase || missing.length) {
    return res.status(503).type("html").send("<h1>Conexión no disponible</h1><p>Falta configurar el publicador.</p>");
  }
  try {
    const tokens = await exchangeAuthorizationCode({
      clientId: YOUTUBE_CLIENT_ID,
      clientSecret: YOUTUBE_CLIENT_SECRET,
      redirectUri: YOUTUBE_REDIRECT_URI,
      code: String(req.query.code),
    });
    const account = await getOwnChannel(tokens.access_token);
    const previous = await getYouTubeConnection(1);
    let previousCredentials = {};
    if (previous?.credentials_ciphertext) {
      previousCredentials = decryptJson({
        ciphertext: previous.credentials_ciphertext,
        iv: previous.credentials_iv,
        auth_tag: previous.credentials_auth_tag,
      }, TOKEN_ENCRYPTION_KEY);
    }
    const credentials = {
      refresh_token: tokens.refresh_token || previousCredentials.refresh_token,
      scope: tokens.scope || previousCredentials.scope,
    };
    if (!credentials.refresh_token) throw new Error("Google did not return a refresh token; revoke the prior consent and reconnect");
    const encrypted = encryptJson(credentials, TOKEN_ENCRYPTION_KEY);
    const { error } = await supabase.from("social_connections").upsert({
      channel_id: 1,
      platform: "youtube",
      account_id: account.id,
      account_name: account.title,
      credentials_ciphertext: encrypted.ciphertext,
      credentials_iv: encrypted.iv,
      credentials_auth_tag: encrypted.auth_tag,
      status: "connected",
      connected_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }, { onConflict: "channel_id,platform" });
    if (error) throw error;
    await supabase.from("channel_platforms").update({ account_label: account.title }).eq("channel_id", 1).eq("platform", "youtube");
    await setIntegrationStatus("youtube", "connected");
    return res.type("html").send(`<h1>YouTube conectado</h1><p>Canal: ${htmlEscape(account.title)}</p><p>Ya podés cerrar esta ventana.</p>`);
  } catch (error) {
    console.error("YouTube OAuth callback failed:", error);
    return res.status(500).type("html").send(`<h1>No se pudo conectar YouTube</h1><p>${htmlEscape(safeError(error))}</p>`);
  }
});

app.post("/youtube/upload", async (req, res) => {
  if (!authorized(req)) return res.status(401).json({ ok: false, error: "unauthorized" });
  if (!supabase) return res.status(503).json({ ok: false, error: "renderer_not_configured" });
  const videoId = Number(req.body?.video_id);
  if (!Number.isInteger(videoId) || videoId <= 0) {
    return res.status(400).json({ ok: false, error: "video_id must be a positive integer" });
  }
  try {
    const { data: video, error: videoError } = await supabase
      .from("videos")
      .select("id,channel_id,title,script,render_url,status,render_stage,content_revision,final_revision,approved_revision")
      .eq("id", videoId)
      .maybeSingle();
    if (videoError) throw videoError;
    if (!video?.render_url || video.status !== "rendered") {
      return res.status(409).json({ ok: false, error: "video_not_rendered" });
    }
    const { data: review, error: reviewError } = await supabase
      .from("cf_video_reviews")
      .select("verdict,reviewed_at,content_revision")
      .eq("video_id", videoId)
      .order("reviewed_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (reviewError) throw reviewError;
    if (!isApprovedFinal(video, review)) {
      return res.status(409).json({ ok: false, error: "approved_hd_revision_required" });
    }
    const connection = await getYouTubeConnection(video.channel_id || 1);
    if (!connection || connection.status !== "connected") {
      return res.status(409).json({ ok: false, error: "youtube_not_connected" });
    }
    const credentials = decryptJson({
      ciphertext: connection.credentials_ciphertext,
      iv: connection.credentials_iv,
      auth_tag: connection.credentials_auth_tag,
    }, TOKEN_ENCRYPTION_KEY);
    const token = await refreshAccessToken({
      clientId: YOUTUBE_CLIENT_ID,
      clientSecret: YOUTUBE_CLIENT_SECRET,
      refreshToken: credentials.refresh_token,
    });
    const mediaResponse = await fetch(video.render_url);
    if (!mediaResponse.ok) throw new Error(`Video download failed (${mediaResponse.status})`);
    const buffer = Buffer.from(await mediaResponse.arrayBuffer());
    if (buffer.length > 200 * 1024 * 1024) throw new Error("Video exceeds the 200 MB publisher limit");
    const privacyStatus = req.body?.privacy_status || "private";
    if (privacyStatus === "public" && !YOUTUBE_ALLOW_PUBLIC) {
      return res.status(403).json({ ok: false, error: "public_uploads_not_enabled" });
    }
    const metadata = buildVideoMetadata({
      title: video.title,
      description: `${video.script || "Una microclase de Lumi para aprender jugando."}\n\nLa voz de este video fue generada con inteligencia artificial.\n\n#Lumi #AprenderJugando #Shorts`,
      privacyStatus,
      publishAt: req.body?.publish_at || null,
    });
    const youtubeVideo = await uploadVideoBuffer({
      accessToken: token.access_token,
      buffer,
      contentType: mediaResponse.headers.get("content-type") || "video/mp4",
      metadata,
    });
    const published = metadata.status.privacyStatus === "public";
    const { error: publicationError } = await supabase.from("publications").insert({
      video_id: video.id,
      channel_id: video.channel_id,
      platform: "youtube",
      account_label: connection.account_name,
      status: published ? "published" : (metadata.status.publishAt ? "scheduled" : "pending"),
      scheduled_at: metadata.status.publishAt || null,
      published_at: published ? new Date().toISOString() : null,
      external_id: youtubeVideo.id,
      external_url: `https://www.youtube.com/watch?v=${youtubeVideo.id}`,
      metrics: {},
    });
    if (publicationError) console.warn(`YouTube upload logged with warning: ${safeError(publicationError)}`);
    return res.status(201).json({
      ok: true,
      video_id: video.id,
      youtube_video_id: youtubeVideo.id,
      youtube_url: `https://www.youtube.com/watch?v=${youtubeVideo.id}`,
      privacy_status: metadata.status.privacyStatus,
      publish_at: metadata.status.publishAt || null,
    });
  } catch (error) {
    console.error(`YouTube upload failed for video ${videoId}:`, error);
    return res.status(500).json({ ok: false, error: safeError(error) });
  }
});

process.on("SIGTERM", async () => {
  console.log("SIGTERM received; preparing renderer shutdown");
  await requeueActiveVideo("Renderer restarted while processing; automatically requeued");
  process.exit(0);
});

process.on("SIGINT", async () => {
  console.log("SIGINT received; preparing renderer shutdown");
  await requeueActiveVideo("Renderer stopped while processing; automatically requeued");
  process.exit(0);
});

app.listen(Number(PORT), "0.0.0.0", () => {
  console.log(`Renderer listening on ${PORT}`);
  console.log(`Config: supabase_key=${hasSupabaseKey ? "ok" : "missing"}, render_token=${hasRenderToken ? "ok" : "optional/missing"}, ffmpeg_threads=1, single_flight=on, duplicate_protection=on, atomic_ready_claim=on`);

  blenderVersion(BLENDER_BIN).then((version) => {
    detectedBlenderVersion = version;
    console.log(`Blender: ${version || "not available"}`);
  });

  // Recover queued work after a deploy/restart without another Make call.
  setTimeout(() => recoverQueuedVideos(), 5000).unref?.();
  setInterval(() => recoverQueuedVideos(), 30_000).unref?.();
});
