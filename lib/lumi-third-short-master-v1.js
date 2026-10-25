import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { GENERATIVE_VIDEO_BUCKET, sha256, uploadObject } from "./generative-video-benchmark-v1.js";
import { LumiRecoveryIncidentManager, SupabaseLumiRecoveryStore, verifyArtifact } from "./lumi-recovery-incident-manager-v1.js";
import { THIRD_SHORT } from "./lumi-third-short-controlled-v1.js";
import { THIRD_SHORT_MEDIA, loadThirdShortProductionScenes } from "./lumi-third-short-media-v1.js";
import {validateEdit, RATE, FRAME, length as editLength} from '../public/lumi-studio/editor-model.js';
import {EDITORIAL_VERSION,buildEditorialTimeline} from './lumi-editorial-timeline-v2.js';

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
    }
    const plannedMasterDuration = Number(sceneDurations.reduce((sum, value) => sum + value, 0).toFixed(6));
    if (plannedMasterDuration < 43 || plannedMasterDuration > 47) throw new Error("third_short_master_duration_contract_invalid");
    const masterPath = join(dir, THIRD_SHORT_MASTER_NAME);
    const command = buildAssemblyCommand({ segments: scenes.map((scene, index) => ({
      videoPath: join(dir, `${scene.id}.mp4`), audioPath: join(dir, `${scene.id}.mp3`), duration: sceneDurations[index]
    })), outputPath: masterPath });
    await executeAssemblyCommand({command});
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

// Shared command builder extracted from the proven master path. No encoding in dry mode.
export function buildAssemblyCommand({segments, outputPath, editorial, sources, sourcePaths}) {
  if(editorial)return buildVisualEditCommand({editorial,sources,sourcePaths,outputPath});
  if (!Array.isArray(segments) || !segments.length || !outputPath) throw Error('ASSEMBLY_INPUT_REQUIRED');
  const natural=segments.some(s=>s.editorial_version===EDITORIAL_VERSION);
  if(natural&&segments.some(s=>s.editorial_version!==EDITORIAL_VERSION))throw Error('EDITORIAL_VERSION_MISMATCH');
  const timeline=natural?buildEditorialTimeline(segments):null;
  const args=['-v','error','-filter_complex_threads','1'], filters=[];
  for (const [index, segment] of segments.entries()) {
    if (!segment.videoPath || !segment.audioPath || !(segment.duration>0)) throw Error('ASSEMBLY_SEGMENT_INVALID');
    args.push('-threads','1','-i',segment.videoPath,'-threads','1','-i',segment.audioPath);
    const vi=index*2,ai=vi+1,sceneDuration=segment.duration,delay=segment.audio_start_seconds??0;
    if(!Number.isFinite(delay)||delay<0||delay>=sceneDuration)throw Error('ASSEMBLY_AUDIO_TIMING_INVALID');
    if(natural){
      const d=timeline.decisions[index];
      // Normalize non-zero source PTS before cutting. At most one output frame
      // of quantization; no slowdown, loop or invented action resolution.
      filters.push(`[${vi}:v]setpts=PTS-STARTPTS,trim=start=${d.source_in}:end=${d.source_out},setpts=PTS-STARTPTS,scale=1080:1920:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,tpad=stop_mode=clone:stop_duration=0.033333334,trim=end_frame=${d.frames},setpts=N/(30*TB)[v${index}]`);
      filters.push(`[${ai}:a]asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,adelay=${Math.round(delay*48000)}S:all=1,apad,atrim=end_sample=${d.frames*1600},asetpts=N/SR/TB[a${index}]`);
    }else{
      filters.push(`[${vi}:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=30,trim=duration=${sceneDuration},setpts=PTS-STARTPTS[v${index}]`);
      filters.push(`[${ai}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,adelay=${Math.round(delay*1000)}:all=1,apad,atrim=duration=${sceneDuration},asetpts=PTS-STARTPTS[a${index}]`);
    }
  }
  filters.push(`${segments.map((_,index)=>`[v${index}][a${index}]`).join('')}concat=n=${segments.length}:v=1:a=1[vout][aout]`);
  args.push('-filter_complex',filters.join(';'),'-map','[vout]','-map','[aout]',
    '-c:v','libx264','-threads','1','-x264-params','rc-lookahead=10:sync-lookahead=0','-profile:v','high','-level','4.2','-preset','slow','-crf','17',
    ...(natural?['-movie_timescale','48000','-video_track_timescale','48000']:[]),'-pix_fmt','yuv420p','-c:a','aac','-b:a','192k','-ar','48000','-ac','2','-movflags','+faststart','-y',outputPath);
  return {executable:'ffmpeg',args,duration:timeline?.duration_seconds??segments.reduce((sum,s)=>sum+s.duration,0),final_encodes:1,...(timeline?{editorial_timeline:timeline}:{})};
}
export async function executeAssemblyCommand({command,dry_run=false,exec=execFileAsync,timeout=30*60*1000}) {
  if(command?.executable!=='ffmpeg'||!Array.isArray(command.args)) throw Error('ASSEMBLY_COMMAND_REQUIRED');
  if(dry_run)return {status:'DRY_LOCAL_BOUNDARY',command};
  await exec(command.executable,command.args,{maxBuffer:32*1024*1024,timeout});
  return {status:'ENCODE_COMPLETE'};
}

// Visual editing extends the existing final encoder; no second rendering pipeline.
function buildVisualEditCommand({editorial:m,sources,sourcePaths,outputPath}){
  validateEdit(m,sources,{render:true});
  const args=['-v','error','-nostdin','-filter_complex_threads','1'],filters=[],inputs=new Map();
  for(const c of m.clips)if(!inputs.has(c.source_id)){const p=sourcePaths[c.source_id];if(!p)throw Error('EDITOR_SOURCE_MISSING');inputs.set(c.source_id,inputs.size);args.push('-threads','1','-i',p);}
  const videos=m.clips.filter(c=>c.track==='video');
  videos.forEach((c,i)=>{const frames=Math.ceil((c.source_out-c.source_in)/FRAME);
    filters.push(`[${inputs.get(c.source_id)}:v]setpts=PTS-STARTPTS,trim=start=${c.source_in/RATE}:end=${c.source_out/RATE},setpts=PTS-STARTPTS,scale=1080:1920:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,tpad=stop_mode=clone:stop_duration=0.033333334,trim=end_frame=${frames},setpts=N/(30*TB)[ve${i}]`);
  });
  filters.push(videos.map((_,i)=>`[ve${i}]`).join('')+`concat=n=${videos.length}:v=1:a=0[vout]`);
  const audios=m.clips.filter(c=>c.track!=='video');
  audios.forEach((c,i)=>{const track=m.tracks[c.track],gain=c.mute||track.mute?0:Math.pow(10,(c.gain_mdb+track.gain_mdb)/20000),d=c.source_out-c.source_in;
    filters.push(`[${inputs.get(c.source_id)}:a]asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=start_sample=${c.source_in}:end_sample=${c.source_out},asetpts=N/SR/TB,volume=${gain}${c.fade_in?`,afade=t=in:ss=0:ns=${c.fade_in}`:''}${c.fade_out?`,afade=t=out:ss=${d-c.fade_out}:ns=${c.fade_out}`:''},adelay=${c.timeline_start}S:all=1[ae${i}]`);
  });
  filters.push(audios.length?audios.map((_,i)=>`[ae${i}]`).join('')+`amix=inputs=${audios.length}:normalize=0:dropout_transition=0,apad,atrim=end_sample=${editLength(m)},asetpts=N/SR/TB[aout]`:`anullsrc=r=48000:cl=stereo,atrim=end_sample=${editLength(m)},asetpts=N/SR/TB[aout]`);
  args.push('-filter_complex',filters.join(';'),'-map','[vout]','-map','[aout]','-c:v','libx264','-threads','1','-x264-params','rc-lookahead=10:sync-lookahead=0','-profile:v','high','-level','4.2','-preset','slow','-crf','17','-movie_timescale','48000','-video_track_timescale','48000','-pix_fmt','yuv420p','-c:a','aac','-b:a','192k','-ar','48000','-ac','2','-movflags','+faststart','-y',outputPath);
  return {executable:'ffmpeg',args,duration:editLength(m)/RATE,final_encodes:1,editorial_timeline:m};
}
