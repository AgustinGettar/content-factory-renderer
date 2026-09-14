import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { sceneFilters } from "./render-profiles.js";
const execFileAsync = promisify(execFile);

// Both passes use the same framing, captions and 30 fps timeline.
// Only resolution, encoder quality and audio bitrate change after approval.
export async function renderScene(imagePath, audioPath, textPath, outputPath, showText, profile, options = {}) {
  const fontPath = options.fontPath || "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";
  const timeoutMs = options.timeoutMs || 15 * 60 * 1000;
  await execFileAsync("ffmpeg", [
    "-y", "-threads", "1", "-filter_threads", "1",
    "-loop", "1", "-i", imagePath, "-i", audioPath,
    "-vf", sceneFilters(profile, showText, fontPath, textPath).join(","),
    "-c:v", "libx264", "-threads", "1",
    "-preset", "ultrafast", "-tune", "stillimage", "-crf", String(profile.crf),
    "-r", String(profile.fps), "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", profile.audioBitrate, "-ar", "48000", "-ac", "2",
    "-shortest", "-movflags", "+faststart", outputPath,
  ], { maxBuffer: 10 * 1024 * 1024, timeout: timeoutMs });
}

