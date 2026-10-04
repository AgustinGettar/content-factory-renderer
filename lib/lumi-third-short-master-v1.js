import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { GENERATIVE_VIDEO_BUCKET, sha256, uploadObject } from "./generative-video-benchmark-v1.js";
import { LumiRecoveryIncidentManager, SupabaseLumiRecoveryStore, verifyArtifact } from "./lumi-recovery-incident-manager-v1.js";
import { THIRD_SHORT } from "./lumi-third-short-controlled-v1.js";
import { THIRD_SHORT_MEDIA, loadThirdShortProductionScenes } from "./lumi-third-short-media-v1.js";

const execFileAsync = promisify(execFile);
export const THIRD_SHORT_MASTER_NAME = "LUMI_SHORT_TRES_FLORES_COLORES_V1.mp4";
export const THIRD_SHORT_MASTER_PATH = `${THIRD_SHORT_MEDIA.prefix}/master/${THIRD_SHORT_MASTER_NAME}`;

async function runs(supabase, stage) {
  const { data, error } = await supabase.from("lumi_pilot_runs").select("*")
    .eq("pilot_id", THIRD_SHORT_MEDIA.pilotId).eq("stage", stage).order("scene_id");
  if (error) throw new Error(`third_short_master_${stage.toLowerCase()}_read_failed`);
  return data || [];
}

async function download(supabase, bucket, path) {
  const { data, error } = await supabase.storage.from(bucket).download(path);
  if (error || !data) throw new Error(`third_short_master_download_failed:${path}`);
  return Buffer.from(await data.arrayBuffer());
}

async function mediaDuration(filePath) {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", filePath,
  ], { timeout: 60_000 });
  const duration = Number(String(stdout).trim());
  if (!Number.isFinite(duration) || duration <= 0) throw new Error("third_short_master_audio_duration_invalid");
  return duration;
}

export async function assembleThirdShortMaster({ supabase, logger = () => {} }) {
  const manager = new LumiRecoveryIncidentManager({ store: new SupabaseLumiRecoveryStore(supabase) });
  const production = await loadThirdShortProductionScenes(supabase);
  const scenes = production.scenes;
  const [videos, audios] = await Promise.all([runs(supabase, "VIDEO"), runs(supabase, "TTS")]);
  for (const scene of scenes) {
    const video = videos.find((row) => row.scene_id === scene.id);
    const audio = audios.find((row) => row.scene_id === scene.id);
    if (video?.status !== "SUCCEEDED" || !["PASS","PASS_WITH_WARNING"].includes(video?.result?.temporal_qa?.classification)) throw new Error(`third_short_master_video_not_usable:${scene.id}`);
    if (audio?.status !== "SUCCEEDED") throw new Error(`third_short_master_audio_not_usable:${scene.id}`);
  }
  const dir = await mkdtemp(join(tmpdir(), "lumi-third-master-"));
  try {
    const args = ["-v", "error"];
    const filters = [];
    const sceneDurations = [];
    for (let index = 0; index < scenes.length; index += 1) {
      const scene = scenes[index];
      const videoRow = videos.find((row) => row.scene_id === scene.id);
      const audioRow = audios.find((row) => row.scene_id === scene.id);
      const videoPath = join(dir, `${scene.id}.mp4`);
      const audioPath = join(dir, `${scene.id}.mp3`);
      const [videoBytes, audioBytes] = await Promise.all([
        download(supabase, videoRow.storage_bucket, videoRow.storage_path),
        download(supabase, audioRow.storage_bucket, audioRow.storage_path),
      ]);
      if (sha256(videoBytes) !== videoRow.content_hash || sha256(audioBytes) !== audioRow.content_hash) throw new Error(`third_short_master_input_hash_mismatch:${scene.id}`);
      await Promise.all([writeFile(videoPath, videoBytes), writeFile(audioPath, audioBytes)]);
      const audioDuration = await mediaDuration(audioPath);
      const sceneDuration = scene.pause > 0 ? Number((audioDuration + scene.pause).toFixed(6)) : 5;
      if (scene.pause > 0 && (scene.pause !== 2.5 || sceneDuration > 5)) {
        throw new Error(`third_short_master_pedagogical_pause_not_representable:${scene.id}`);
      }
      sceneDurations.push(sceneDuration);
      args.push("-i", videoPath, "-i", audioPath);
      const vi = index * 2;
      const ai = vi + 1;
      filters.push(`[${vi}:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=30,trim=duration=${sceneDuration},setpts=PTS-STARTPTS[v${index}]`);
      filters.push(`[${ai}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=duration=${sceneDuration},asetpts=PTS-STARTPTS[a${index}]`);
    }
    const plannedMasterDuration = Number(sceneDurations.reduce((sum, value) => sum + value, 0).toFixed(6));
    if (plannedMasterDuration < 43 || plannedMasterDuration > 47) throw new Error("third_short_master_duration_contract_invalid");
    filters.push(`${scenes.map((_, index) => `[v${index}][a${index}]`).join("")}concat=n=9:v=1:a=1[vout][aout]`);
    const masterPath = join(dir, THIRD_SHORT_MASTER_NAME);
    args.push(
      "-filter_complex", filters.join(";"), "-map", "[vout]", "-map", "[aout]",
      "-c:v", "libx264", "-profile:v", "high", "-level", "4.2", "-preset", "slow", "-crf", "17",
      "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
      "-movflags", "+faststart", "-y", masterPath,
    );
    await execFileAsync("ffmpeg", args, { maxBuffer: 32 * 1024 * 1024, timeout: 30 * 60 * 1000 });
    const master = await readFile(masterPath);
    const masterHash = sha256(master);
    await uploadObject(supabase, THIRD_SHORT_MASTER_PATH, master, "video/mp4", false);
    const persisted = await download(supabase, GENERATIVE_VIDEO_BUCKET, THIRD_SHORT_MASTER_PATH);
    if (sha256(persisted) !== masterHash) throw new Error("third_short_master_storage_hash_mismatch");
    const persistedPath = join(dir, "persisted-master.mp4");
    await writeFile(persistedPath, persisted);
    const verification = await verifyArtifact({ type: "MASTER", filePath: persistedPath, expectedSha256: masterHash, expected: { width: 1080, height: 1920, codec: "h264", profile: "High" } });
    if (!verification.ok) throw Object.assign(new Error(verification.error_class || "third_short_master_verification_failed"), { code: verification.error_class });
    await manager.completeAction(THIRD_SHORT.episodeId, "assembly", { artifact: { bucket: GENERATIVE_VIDEO_BUCKET, path: THIRD_SHORT_MASTER_PATH, sha256: masterHash }, evidence: { provider_succeeded: true, artifact_persisted: true, sha_verified: true, artifact_verified: true }, actualCostUsd: 0 });
    const result = { status: "AWAITING_MASTER_VISUAL_QA", storage_bucket: GENERATIVE_VIDEO_BUCKET, storage_path: THIRD_SHORT_MASTER_PATH, sha256: masterHash, bytes: master.length, duration_seconds: verification.duration, planned_duration_seconds: plannedMasterDuration, pedagogical_pause_seconds: 2.5, text_overlay: false, episode_plan_artifact_id: production.artifact_id, episode_plan_hash: production.content_hash, verification };
    const { error } = await supabase.from("lumi_pilot_runs").upsert({ pilot_id: THIRD_SHORT_MEDIA.pilotId, scene_id: "master", stage: "MASTER", status: "SUCCEEDED", provider_calls: 0, estimated_cost_usd: 0, storage_bucket: GENERATIVE_VIDEO_BUCKET, storage_path: THIRD_SHORT_MASTER_PATH, content_hash: masterHash, artifact_reference: THIRD_SHORT_MASTER_PATH, result, claimed_at: new Date().toISOString(), updated_at: new Date().toISOString(), completed_at: new Date().toISOString() }, { onConflict: "pilot_id,scene_id,stage" });
    if (error) throw new Error("third_short_master_ledger_write_failed");
    logger({ event: "third_short_master_assembled", hash: masterHash, duration_seconds: verification.duration });
    return result;
  } catch (error) {
    const incident = await manager.pause({ episodeId: THIRD_SHORT.episodeId, stage: "ASSEMBLY", errorClass: error.code === "BLACK_VIDEO_ARTIFACT" ? "BLACK_VIDEO_ARTIFACT" : "INVALID_ARTIFACT", reason: error.code || error.message, firstPendingAction: "assembly", safeResumeAvailable: true, costLostAvoidable: true });
    return { status: "PAUSED_INCIDENT", incident };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function thirdShortMasterReviewUrl({ supabase, expires = 7200 }) {
  const { data, error } = await supabase.storage.from(GENERATIVE_VIDEO_BUCKET).createSignedUrl(THIRD_SHORT_MASTER_PATH, expires);
  if (error || !data?.signedUrl) throw new Error("third_short_master_sign_failed");
  return data.signedUrl;
}

export async function recordThirdShortMasterQa({ supabase, classification, checks, findings = [] }) {
  if (!['PASS','BLOCKER'].includes(classification)) throw new Error("third_short_master_qa_invalid");
  const manager = new LumiRecoveryIncidentManager({ store: new SupabaseLumiRecoveryStore(supabase) });
  const { data: row, error } = await supabase.from("lumi_pilot_runs").select("*").eq("pilot_id", THIRD_SHORT_MEDIA.pilotId).eq("scene_id", "master").eq("stage", "MASTER").single();
  if (error || !row) throw new Error("third_short_master_missing");
  if (classification === "BLOCKER") {
    const incident = await manager.pause({ episodeId: THIRD_SHORT.episodeId, stage: "MASTER_QA", errorClass: "QA_BLOCKER", reason: findings.join("; ") || "MASTER_QA_BLOCKER", firstPendingAction: "master_qa", safeResumeAvailable: true, costLostAvoidable: true });
    return { status: "PAUSED_INCIDENT", incident };
  }
  const required = ["decode_errors_zero","black_frames_zero","accidental_freeze_zero","lumi_identity","red_flower","yellow_flower","blue_flower","text_character_overlap_zero","educational_object_overlap_zero","technical_pause_label_absent","safe_area","readability","natural_1x","full_hd"];
  if (required.some((key) => checks?.[key] !== true)) throw new Error("third_short_master_qa_checks_incomplete");
  const result = { ...(row.result || {}), master_qa: { classification, checks, findings } };
  const { error: updateError } = await supabase.from("lumi_pilot_runs").update({ result, updated_at: new Date().toISOString() }).eq("id", row.id);
  if (updateError) throw new Error("third_short_master_qa_write_failed");
  await manager.completeAction(THIRD_SHORT.episodeId, "master_qa", { artifact: { master_run_id: row.id, checks }, evidence: { provider_succeeded: true, artifact_persisted: true, sha_verified: true, artifact_verified: true }, actualCostUsd: 0 });
  return { status: "PASS", master: result };
}
