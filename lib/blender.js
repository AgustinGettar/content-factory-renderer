import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const execFileAsync = promisify(execFile);

export async function blenderVersion(binary = "blender") {
  try {
    const { stdout } = await execFileAsync(binary, ["--version"], { timeout: 20_000 });
    return stdout.split("\n")[0].trim();
  } catch {
    return null;
  }
}

export async function renderLumiPilot({
  outputPath,
  width = 540,
  height = 960,
  fps = 24,
  seconds = 12,
  binary = "blender",
  timeoutMs = 30 * 60 * 1000,
}) {
  const script = path.resolve("blender/lumi_pilot.py");
  const args = [
    "--background",
    "--factory-startup",
    "--python", script,
    "--",
    "--output", outputPath,
    "--width", String(width),
    "--height", String(height),
    "--fps", String(fps),
    "--seconds", String(seconds),
  ];
  const { stdout, stderr } = await execFileAsync(binary, args, {
    timeout: timeoutMs,
    maxBuffer: 20 * 1024 * 1024,
  });
  return { stdout, stderr };
}

export async function renderLumi2DPilot({
  outputPath,
  width = 540,
  height = 960,
  fps = 24,
  seconds = 6,
  binary = "blender",
  timeoutMs = 30 * 60 * 1000,
}) {
  const script = path.resolve("blender/lumi_2d_pilot.py");
  const args = [
    "--background",
    "--factory-startup",
    "--python", script,
    "--",
    "--output", outputPath,
    "--open-image", path.resolve("assets/lumi-canonical-wand.png"),
    "--blink-image", path.resolve("assets/lumi-canonical-wand-blink.png"),
    "--width", String(width),
    "--height", String(height),
    "--fps", String(fps),
    "--seconds", String(seconds),
  ];
  const { stdout, stderr } = await execFileAsync(binary, args, {
    timeout: timeoutMs,
    maxBuffer: 20 * 1024 * 1024,
  });
  return { stdout, stderr };
}
