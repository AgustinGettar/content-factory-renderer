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

// Important: the service must be able to boot even if a secret was not linked
// correctly in Render. /health will report which configuration item is missing
// without ever revealing secret values.
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
  ]);
  const d = Number.parseFloat(stdout.trim());
  if (!Number.isFinite(d) || d <= 0) throw new Error(`Invalid duration: ${filePath}`);
  return d;
}

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
    "-loop", "1",
    "-i", imagePath,
    "-i", audioPath,
    "-vf", vf.join(","),
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-tune", "stillimage",
    "-r", "30",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-b:a", "192k",
    "-ar", "48000",
    "-ac", "2",
    "-shortest",
    "-movflags", "+faststart",
    outputPath,
  ], { maxBuffer: 10 * 1024 * 1024 });
}

async function concatScenes(files, listPath, outputPath) {
  const body = files.map((p) => `file '${p.replaceAll("'", "'\\''")}'`).join("\n");
  await fs.writeFile(listPath, body, "utf8");
  await execFileAsync("ffmpeg", [
    "-y", "-f", "concat", "-safe", "0", "-i", listPath,
    "-c", "copy", "-movflags", "+faststart", outputPath,
  ], { maxBuffer: 10 * 1024 * 1024 });
}

async function renderVideo(videoId) {
  if (!supabase) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not configured on the Render service");

  let workDir;
  try {
    const { data: video, error: lockError } = await supabase
      .from("videos")
      .update({ status: "rendering", error_message: null })
      .eq("id", videoId)
      .eq("status", "queued")
      .select("id,channel_id,title,aspect_ratio,language")
      .maybeSingle();

    if (lockError) throw lockError;
    if (!video) return;

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

      await Promise.all([
        downloadToFile(scene.image_url, imagePath),
        downloadToFile(scene.audio_url, audioPath),
      ]);

      await getDuration(audioPath);
      const txt = wrapText(scene.on_screen_text);
      await fs.writeFile(textPath, txt, "utf8");
      await renderScene(imagePath, audioPath, textPath, scenePath, Boolean(txt));
      rendered.push(scenePath);
    }

    const concatPath = path.join(workDir, "concat.txt");
    const finalPath = path.join(workDir, "final.mp4");
    await concatScenes(rendered, concatPath, finalPath);

    const duration = await getDuration(finalPath);
    const objectName = `channel-${video.channel_id ?? "unknown"}-video-${videoId}.mp4`;
    const buffer = await fs.readFile(finalPath);

    const { error: uploadError } = await supabase.storage
      .from(BUCKET_RENDERED)
      .upload(objectName, buffer, {
        contentType: "video/mp4",
        upsert: true,
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
    console.error(err);
    if (supabase) {
      await supabase.from("videos").update({
        status: "failed",
        error_message: safeError(err),
      }).eq("id", videoId);
    }
  } finally {
    if (workDir) await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

app.get("/health", (_req, res) => {
  const ready = hasSupabaseKey;
  res.status(ready ? 200 : 503).json({
    ok: ready,
    service: "content-factory-renderer",
    config: {
      supabase_url: true,
      supabase_service_role_key: hasSupabaseKey,
      render_api_token: hasRenderToken,
      bucket_rendered: true,
    },
  });
});

app.post("/render", (req, res) => {
  if (!supabase) {
    return res.status(503).json({ ok: false, error: "renderer_not_configured", missing: ["SUPABASE_SERVICE_ROLE_KEY"] });
  }

  // If a token is configured, enforce it. If it is not configured yet, allow
  // requests temporarily so deployment/configuration can be completed first.
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

app.listen(Number(PORT), "0.0.0.0", () => {
  console.log(`Renderer listening on ${PORT}`);
  console.log(`Config: supabase_key=${hasSupabaseKey ? "ok" : "missing"}, render_token=${hasRenderToken ? "ok" : "optional/missing"}`);
});
