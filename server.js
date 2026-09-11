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
const SELF_URL = process.env.RENDER_EXTERNAL_URL || "https://content-factory-renderer.onrender.com";
const KEEPALIVE_INTERVAL_MS = Number(process.env.KEEPALIVE_INTERVAL_MS || 3 * 60 * 1000);

const FPS = 24;
const TRANSITION_SECONDS = 0.10;
const AUDIO_FADE_IN_SECONDS = 0.12;
const AUDIO_FADE_OUT_SECONDS = 0.18;

// Keep a real 9:16 frame at every stage. Motion is created by scaling once to
// a slightly larger 9:16 canvas and moving a 1080x1920 crop over it.
const OUTPUT_WIDTH = 1080;
const OUTPUT_HEIGHT = 1920;
const MOTION_WIDTH = 1152;
const MOTION_HEIGHT = 2048;

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
let activeVideoId = null;
let keepAliveTimer = null;

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

async function getVideoGeometry(filePath) {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=width,height,sample_aspect_ratio,display_aspect_ratio",
    "-of", "json",
    filePath,
  ], { timeout: 60_000 });

  const parsed = JSON.parse(stdout);
  const stream = parsed?.streams?.[0];
  if (!stream) throw new Error(`No video stream found: ${filePath}`);

  return {
    width: Number(stream.width),
    height: Number(stream.height),
    sar: stream.sample_aspect_ratio || "",
    dar: stream.display_aspect_ratio || "",
  };
}

function stopKeepAlive() {
  if (keepAliveTimer) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }
}

function startKeepAlive(videoId) {
  stopKeepAlive();

  const ping = async () => {
    try {
      const response = await fetch(`${SELF_URL}/health`, {
        headers: { "x-render-keepalive": "1" },
        signal: AbortSignal.timeout(15_000),
      });
      console.log(`Video ${videoId}: keepalive ${response.status}`);
    } catch (err) {
      console.warn(`Video ${videoId}: keepalive failed: ${safeError(err)}`);
    }
  };

  keepAliveTimer = setInterval(ping, KEEPALIVE_INTERVAL_MS);
  keepAliveTimer.unref?.();
}

function buildMotionCrop(sceneNumber, duration) {
  const maxX = MOTION_WIDTH - OUTPUT_WIDTH;
  const maxY = MOTION_HEIGHT - OUTPUT_HEIGHT;
  const centerX = maxX / 2;
  const centerY = maxY / 2;
  const safeDuration = Math.max(0.1, Number(duration) || 0.1).toFixed(3);
  const progress = `min(max(t/${safeDuration},0),1)`;

  const variant = (Number(sceneNumber) - 1) % 4;
  let x = centerX.toFixed(1);
  let y = centerY.toFixed(1);

  if (variant === 0) {
    x = `${centerX.toFixed(1)}+10*sin(t*0.55)`;
    y = `${centerY.toFixed(1)}+14*sin(t*0.38)`;
  } else if (variant === 1) {
    x = `${maxX}*${progress}`;
    y = centerY.toFixed(1);
  } else if (variant === 2) {
    x = `${maxX}*(1-${progress})`;
    y = centerY.toFixed(1);
  } else {
    x = centerX.toFixed(1);
    y = `${maxY}*${progress}`;
  }

  return `crop=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:x='${x}':y='${y}'`;
}

async function renderScene(imagePath, audioPath, textPath, outputPath, showText, sceneNumber, duration) {
  const transitionDuration = Math.min(TRANSITION_SECONDS, Math.max(0.06, duration / 8));
  const transitionOutStart = Math.max(0, duration - transitionDuration);
  const audioFadeIn = Math.min(AUDIO_FADE_IN_SECONDS, Math.max(0.05, duration / 6));
  const audioFadeOut = Math.min(AUDIO_FADE_OUT_SECONDS, Math.max(0.06, duration / 6));
  const audioFadeOutStart = Math.max(0, duration - audioFadeOut);

  // One scaling pass only. The previous version scaled to 1080x1920 and then
  // scaled again to the motion canvas, which cost a lot of CPU on the free plan.
  const vf = [
    `scale=${MOTION_WIDTH}:${MOTION_HEIGHT}:force_original_aspect_ratio=increase:flags=fast_bilinear`,
    `crop=${MOTION_WIDTH}:${MOTION_HEIGHT}`,
    "setsar=1",
    buildMotionCrop(sceneNumber, duration),
    "setsar=1",
    "setdar=9/16",
  ];

  if (showText) {
    vf.push(
      "drawbox=x=60:y=ih-500:w=iw-120:h=300:color=black@0.35:t=fill",
      `drawtext=fontfile='${FONT_PATH}':textfile='${textPath}':fontcolor=white:fontsize=72:line_spacing=18:x=(main_w-text_w)/2:y=main_h-355-text_h/2`
    );
  }

  vf.push(
    `fade=t=in:st=0:d=${transitionDuration.toFixed(3)}:color=white`,
    `fade=t=out:st=${transitionOutStart.toFixed(3)}:d=${transitionDuration.toFixed(3)}:color=white`,
    "setsar=1",
    "setdar=9/16"
  );

  const af = [
    `afade=t=in:st=0:d=${audioFadeIn.toFixed(3)}`,
    `afade=t=out:st=${audioFadeOutStart.toFixed(3)}:d=${audioFadeOut.toFixed(3)}`,
  ];

  await execFileAsync("ffmpeg", [
    "-y",
    "-threads", "1",
    "-filter_threads", "1",
    "-loop", "1",
    "-framerate", String(FPS),
    "-i", imagePath,
    "-i", audioPath,
    "-vf", vf.join(","),
    "-af", af.join(","),
    "-c:v", "libx264",
    "-preset", "ultrafast",
    "-r", String(FPS),
    "-pix_fmt", "yuv420p",
    "-aspect", "9:16",
    "-c:a", "aac",
    "-b:a", "128k",
    "-ar", "48000",
    "-ac", "2",
    "-t", duration.toFixed(3),
    "-shortest",
    "-movflags", "+faststart",
    outputPath,
  ], {
    maxBuffer: 10 * 1024 * 1024,
    timeout: FFMPEG_TIMEOUT_MS,
  });

  const geometry = await getVideoGeometry(outputPath);
  if (geometry.width !== OUTPUT_WIDTH || geometry.height !== OUTPUT_HEIGHT) {
    throw new Error(
      `Scene ${sceneNumber} geometry invalid: ${geometry.width}x${geometry.height} sar=${geometry.sar} dar=${geometry.dar}`
    );
  }
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
    const { data: video, error: lockError } = await supabase
      .from("videos")
      .update({ status: "rendering", error_message: null })
      .eq("id", videoId)
      .eq("status", "queued")
      .select("id,channel_id,title,aspect_ratio,language")
      .maybeSingle();

    if (lockError) throw lockError;
    if (!video) {
      console.log(`Video ${videoId} was not queued; render skipped`);
      return;
    }

    claimed = true;
    activeVideoId = videoId;
    startKeepAlive(videoId);
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

      const audioDuration = await getDuration(audioPath);
      const txt = wrapText(scene.on_screen_text);
      await fs.writeFile(textPath, txt, "utf8");
      await renderScene(
        imagePath,
        audioPath,
        textPath,
        scenePath,
        Boolean(txt),
        scene.scene_number,
        audioDuration
      );
      rendered.push(scenePath);

      console.log(`Video ${videoId}: scene ${scene.scene_number} complete`);
    }

    const concatPath = path.join(workDir, "concat.txt");
    const finalPath = path.join(workDir, "final.mp4");
    console.log(`Video ${videoId}: concatenating ${rendered.length} scenes`);
    await concatScenes(rendered, concatPath, finalPath);

    const duration = await getDuration(finalPath);
    const geometry = await getVideoGeometry(finalPath);

    console.log(
      `Video ${videoId}: final geometry ${geometry.width}x${geometry.height}, sar=${geometry.sar}, dar=${geometry.dar}`
    );

    if (geometry.width !== OUTPUT_WIDTH || geometry.height !== OUTPUT_HEIGHT) {
      throw new Error(
        `Final video geometry invalid: ${geometry.width}x${geometry.height} sar=${geometry.sar} dar=${geometry.dar}`
      );
    }

    const renderVersion = Date.now();
    const objectName = `channel-${video.channel_id ?? "unknown"}-video-${videoId}-${renderVersion}.mp4`;
    const buffer = await fs.readFile(finalPath);

    const { error: uploadError } = await supabase.storage
      .from(BUCKET_RENDERED)
      .upload(objectName, buffer, {
        contentType: "video/mp4",
        upsert: false,
        cacheControl: "3600",
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
    stopKeepAlive();
    if (activeVideoId === videoId) activeVideoId = null;
    if (workDir) await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function requeueActiveVideo(reason) {
  stopKeepAlive();
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
    config: {
      supabase_url: true,
      supabase_service_role_key: hasSupabaseKey,
      render_api_token: hasRenderToken,
      bucket_rendered: true,
      visual_motion: true,
      scene_transitions: "white_dip",
      output_geometry: "1080x1920",
      square_pixels: true,
      unique_render_urls: true,
      fps: FPS,
      keepalive_seconds: Math.round(KEEPALIVE_INTERVAL_MS / 1000),
      scaling: "single_pass_fast_bilinear",
    },
  });
});

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

  res.status(202).json({ ok: true, accepted: true, video_id: videoId });
  setImmediate(() => renderVideo(videoId));
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
  console.log(
    `Config: supabase_key=${hasSupabaseKey ? "ok" : "missing"}, render_token=${hasRenderToken ? "ok" : "optional/missing"}, ffmpeg_threads=1, fps=${FPS}, visual_motion=on, output=1080x1920, keepalive=${Math.round(KEEPALIVE_INTERVAL_MS / 1000)}s`
  );
});
