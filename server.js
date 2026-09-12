import express from "express";
import { createClient } from "@supabase/supabase-js";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const SUPABASE_URL = process.env.SUPABASE_URL || "https://hdptwtzhpfdrqiuezjhu.supabase.co";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const RENDER_API_TOKEN = process.env.RENDER_API_TOKEN || "";
const BUCKET_RENDERED = process.env.BUCKET_RENDERED || "rendered-videos";
const PORT = process.env.PORT || "3000";
const FFMPEG_TIMEOUT_MS = Number(process.env.FFMPEG_TIMEOUT_MS || 15 * 60 * 1000);

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
let workerRunning = false;
const pendingVideoIds = [];
const reservedVideoIds = new Set();

function safeError(err) {
  return (err instanceof Error ? err.message : String(err)).slice(0, 1800);
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

// Proven original vertical renderer. Keep this visual path untouched while we
// build Lumi Animated separately: proportional fill + center crop to 1080x1920.
async function renderScene(imagePath, audioPath, textPath, outputPath, showText) {
  const vf = [
    "scale=1080:1920:force_original_aspect_ratio=increase",
    "crop=1080:1920",
  ];

  if (showText) {
    vf.push(
      "drawbox=x=60:y=ih-500:w=iw-120:h=300:color=black@0.35:t=fill",
      `drawtext=fontfile='${FONT_PATH}':textfile='${textPath}':fontcolor=white:fontsize=72:line_spacing=18:x=(main_w-text_w)/2:y=main_h-355-text_h/2`
    );
  }

  await execFileAsync("ffmpeg", [
    "-y",
    "-threads", "1",
    "-filter_threads", "1",
    "-loop", "1",
    "-i", imagePath,
    "-i", audioPath,
    "-vf", vf.join(","),
    "-c:v", "libx264",
    "-preset", "ultrafast",
    "-tune", "stillimage",
    "-r", "30",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-b:a", "128k",
    "-ar", "48000",
    "-ac", "2",
    "-shortest",
    "-movflags", "+faststart",
    outputPath,
  ], {
    maxBuffer: 10 * 1024 * 1024,
    timeout: FFMPEG_TIMEOUT_MS,
  });
}

async function concatScenes(files, listPath, outputPath) {
  const body = files.map((p) => `file '${p.replaceAll("'", "'\\''")}'`).join("\n");
  await fs.writeFile(listPath, body, "utf8");
  await execFileAsync("ffmpeg", [
    "-y",
    "-threads", "1",
    "-f", "concat",
    "-safe", "0",
    "-i", listPath,
    "-c", "copy",
    "-movflags", "+faststart",
    outputPath,
  ], {
    maxBuffer: 10 * 1024 * 1024,
    timeout: FFMPEG_TIMEOUT_MS,
  });
}

async function renderVideo(videoId) {
  if (!supabase) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not configured on the Render service");

  let workDir;
  let claimed = false;

  try {
    // Final database-side claim. Only queued -> rendering is allowed.
    const { data: video, error: lockError } = await supabase
      .from("videos")
      .update({ status: "rendering", error_message: null })
      .eq("id", videoId)
      .eq("status", "queued")
      .select("id,channel_id,title,aspect_ratio,language")
      .maybeSingle();

    if (lockError) throw lockError;
    if (!video) {
      console.log(`Video ${videoId}: claim skipped because status is not queued`);
      return;
    }

    claimed = true;
    activeVideoId = videoId;
    console.log(`Starting render for video ${videoId}`);

    const { data: scenes, error: scenesError } = await supabase
      .from("scenes")
      .select("id,scene_number,narration,on_screen_text,image_url,audio_url")
      .eq("video_id", videoId)
      .order("scene_number", { ascending: true });

    if (scenesError) throw scenesError;
    if (!scenes?.length) throw new Error(`Video ${videoId} has no scenes`);

    const missing = scenes.filter((s) => !s.image_url || !s.audio_url);
    if (missing.length) {
      throw new Error(`Missing assets in scenes: ${missing.map((s) => s.scene_number).join(", ")}`);
    }

    workDir = await fs.mkdtemp(path.join(os.tmpdir(), `cf-${videoId}-`));
    const rendered = [];

    for (const scene of scenes) {
      const n = String(scene.scene_number).padStart(2, "0");
      const imagePath = path.join(workDir, `scene-${n}.png`);
      const audioPath = path.join(workDir, `scene-${n}.mp3`);
      const textPath = path.join(workDir, `scene-${n}.txt`);
      const scenePath = path.join(workDir, `scene-${n}.mp4`);

      console.log(`Video ${videoId}: rendering scene ${scene.scene_number}/${scenes.length}`);

      await Promise.all([
        downloadToFile(scene.image_url, imagePath),
        downloadToFile(scene.audio_url, audioPath),
      ]);

      await getDuration(audioPath);
      const txt = wrapText(scene.on_screen_text);
      await fs.writeFile(textPath, txt, "utf8");
      await renderScene(imagePath, audioPath, textPath, scenePath, Boolean(txt));
      rendered.push(scenePath);

      console.log(`Video ${videoId}: scene ${scene.scene_number} complete`);
    }

    const concatPath = path.join(workDir, "concat.txt");
    const finalPath = path.join(workDir, "final.mp4");
    console.log(`Video ${videoId}: concatenating ${rendered.length} scenes`);
    await concatScenes(rendered, concatPath, finalPath);

    const duration = await getDuration(finalPath);

    // Unique URL per render avoids stale CDN/Telegram copies without ?v= query strings.
    const renderVersion = Date.now();
    const objectName = `channel-${video.channel_id ?? "unknown"}-video-${videoId}-${renderVersion}.mp4`;
    const buffer = await fs.readFile(finalPath);

    const { error: uploadError } = await supabase.storage
      .from(BUCKET_RENDERED)
      .upload(objectName, buffer, {
        contentType: "video/mp4",
        upsert: false,
        cacheControl: "31536000",
      });
    if (uploadError) throw uploadError;

    const renderUrl = `${SUPABASE_URL}/storage/v1/object/public/${BUCKET_RENDERED}/${objectName}`;

    const { error: updateError } = await supabase
      .from("videos")
      .update({
        status: "rendered",
        render_url: renderUrl,
        duration_seconds: Number(duration.toFixed(2)),
        error_message: null,
      })
      .eq("id", videoId);
    if (updateError) throw updateError;

    console.log(`Rendered video ${videoId}: ${renderUrl}`);
  } catch (err) {
    console.error(`Render failed for video ${videoId}:`, err);
    if (supabase && claimed) {
      await supabase.from("videos").update({
        status: "failed",
        error_message: safeError(err),
      }).eq("id", videoId);
    }
  } finally {
    if (activeVideoId === videoId) activeVideoId = null;
    if (workDir) await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
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
  if (!supabase) return;

  try {
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
    console.warn(`Startup recovery failed: ${safeError(err)}`);
  }
}

async function requeueActiveVideo(reason) {
  if (!supabase || !activeVideoId) return;
  const videoId = activeVideoId;
  activeVideoId = null;
  try {
    await supabase
      .from("videos")
      .update({ status: "queued", error_message: reason })
      .eq("id", videoId)
      .eq("status", "rendering");
    console.log(`Requeued video ${videoId}: ${reason}`);
  } catch (err) {
    console.error(`Could not requeue video ${videoId}:`, err);
  }
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
      visual_mode: "proven_static_vertical",
    },
  });
});

// Preferred production endpoint: one Make HTTP operation replaces GET readiness
// + PATCH queued + POST render.
app.post("/render-if-ready", async (req, res) => {
  if (!supabase) {
    return res.status(503).json({ ok: false, error: "renderer_not_configured", missing: ["SUPABASE_SERVICE_ROLE_KEY"] });
  }

  if (hasRenderToken && req.get("x-render-token") !== RENDER_API_TOKEN) {
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

  if (hasRenderToken && req.get("x-render-token") !== RENDER_API_TOKEN) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }

  const videoId = Number(req.body?.video_id);
  if (!Number.isInteger(videoId) || videoId <= 0) {
    return res.status(400).json({ ok: false, error: "video_id must be a positive integer" });
  }

  const result = enqueueRender(videoId, "direct_render_api");
  return res.status(202).json({ ok: true, video_id: videoId, ...result });
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

  // Recover queued work after a deploy/restart without another Make call.
  setTimeout(() => recoverQueuedVideos(), 5000).unref?.();
});
