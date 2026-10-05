import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { estimateHiggsfieldUsd } from './higgsfield-usd-budget-v1.js';
import { journaledFetch } from './provider-emission-journal-v1.js';
import { providerJson, pollRequest } from './generative-video-benchmark-v1.js';

export const Q31 = Object.freeze({
  episode: 'ep_lumi_flores_003', revision: 'q31-SERIES-V2-V1',
  source: 'q31-SOURCE-SERIES-V2-1', job: 'ad3b4e5a-0810-4659-b9ce-2606808f1cf4',
  sourceModel: 'nano_banana_flash', width: 1536, height: 2752,
  sourceSha: 'a1aa0592627986563e111879cb72bb83457873e31385d055d0199bc8543b4711',
  sourceUrl: 'https://d8j0ntlcm91z4.cloudfront.net/user_3JyiUQvqW4GLHeQWvPah1G5GKhm/hf_20261005_001105_ad3b4e5a-0810-4659-b9ce-2606808f1cf4.png',
  model: 'kling-video/v3.0/std/image-to-video', bucket: 'av2-generative-video-benchmarks',
  prefix: 'lumi-series-v2/ep_lumi_flores_003/q31-SERIES-V2-V1',
});
export const PROMPT = `PREMIUM FEATURE-FILM-QUALITY STYLIZED 3D CGI. The approved source image is the exact first-frame authority. Preserve its composition, Lumi's identity and the canonical garden throughout one continuous four-second shot, natural real-time 1x motion.
START: Lumi slightly left of center, full body visible, empty path and caption-safe space on the right. No teaching flowers revealed.
PRIMARY ACTION: exactly one gentle welcoming hand gesture toward the viewer, then a natural settle. Allowed secondary motion: one natural blink, tiny friendly head follow, subtle eye movement, very subtle canonical wing response. Feet remain grounded.
CAMERA: locked static camera, no zoom, orbit, reframing or aggressive parallax.
END: Lumi remains at the same garden position facing the viewer; stable identity and composition.
IMMUTABLE CHARACTER: warm yellow rounded body, large turquoise eyes with depth and catchlights, pink cheeks, two antennae with violet tips, small yellow hair tuft, exactly two canonical wings total, light-blue denim overalls with fine denim texture, white/light-blue sneakers, exactly two arms and two legs, canonical proportions.
STYLE: rich dimensional materials, soft cinematic daylight, natural foliage depth, grounded contact shadows, subtle subsurface scattering, translucent detailed wings, polished preschool animation and natural movement. Preserve source material, world and lighting continuity.
FORBIDDEN: extra wings or limbs, tail, abdomen growth, body morph, face drift, clothing mutation, rubbery movement, squash-and-stretch, cartoon bounce, slow motion, dreamy floating, prolonged static pose, new objects or characters, flowers appearing, eggs, chicken, basket, wand, shapes, text, captions, logo or watermark. No flat cartoon, 2D illustration, cel shading, cheap TV render, simplified materials, plastic toy appearance, human photorealism or live-action humanization.`;
const hash = b => createHash('sha256').update(b).digest('hex');
const exec = promisify(execFile);
const iso = () => new Date().toISOString();
export function requestInput(imageUrl) {
  return { duration: 4, sound: 'off', multi_shots: false, cfg_scale: 0.5, prompt: PROMPT, image_url: imageUrl };
}

// This standalone, explicitly authorized calibration never resumes or updates
// the episode coordinator. Atomic private-object creation admits one emission.
export class CalibrationJournalStore {
  constructor(storage) { this.storage = storage; this.current = null; }
  async put(name, value, upsert = false) {
    const { error } = await this.storage.upload(`${Q31.prefix}/journal/${name}.json`,
      Buffer.from(JSON.stringify(value)), { contentType: 'application/json', upsert });
    if (error) throw new Error(`calibration_journal_write_rejected:${name}`);
  }
  async prepare(record) {
    if (record.attempt_id !== Q31.revision || record.scene_id !== Q31.revision || record.model !== Q31.model || record.state !== 'PREPARED') throw new Error('calibration_scope_mismatch');
    await this.put('PREPARED', record); this.current = record; return record;
  }
  async transition(id, from, patch) {
    if (id !== Q31.revision || this.current?.state !== from) throw new Error('calibration_transition_rejected');
    if (!((from === 'PREPARED' && patch.state === 'EMITTING') || (from === 'EMITTING' && ['ACKNOWLEDGED','EMISSION_UNKNOWN'].includes(patch.state)) || (from === 'ACKNOWLEDGED' && patch.state === 'ACKNOWLEDGED'))) throw new Error('calibration_transition_rejected');
    const next = { ...this.current, ...patch };
    await this.put(patch.state, next, from === 'ACKNOWLEDGED');
    this.current = next; return next;
  }
}

export async function runQ31SeriesV2Calibration({ env = process.env, logger = console, fetchImpl = fetch }) {
  if (env.LUMI_RUNTIME_ENV !== 'staging' || env.LUMI_Q31_SERIES_V2_AUTHORIZATION !== Q31.job) throw new Error('calibration_staging_scoped_authorization_required');
  if (!env.HF_API_KEY) throw new Error('calibration_higgsfield_credentials_missing');
  const { createClient } = await import('@supabase/supabase-js');
  const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const storage = db.storage.from(Q31.bucket);
  const readJson = async name => {
    const r = await storage.download(`${Q31.prefix}/${name}.json`);
    if (r.error) {
      const code = r.error.statusCode ?? r.error.status ?? r.error.originalError?.status;
      if (['404','400','undefined'].includes(String(code)) && /not found|does not exist/i.test(r.error.message)) return null;
      logger.info(JSON.stringify({event:'lumi_q31_series_v2_storage_diagnostic',name,error_name:r.error.name,error_message:r.error.message,status:code??null,error_keys:Object.keys(r.error)}));
      throw new Error(`calibration_record_read_failed:${name}`);
    }
    return JSON.parse(await r.data.text());
  };
  const put = async (name, value, upsert = false) => {
    const r = await storage.upload(`${Q31.prefix}/${name}.json`, Buffer.from(JSON.stringify(value)), { contentType: 'application/json', upsert });
    if (r.error) throw new Error(`calibration_record_write_failed:${name}`);
  };
  const signed = async path => {
    const r = await storage.createSignedUrl(path, 21600);
    if (r.error || !r.data?.signedUrl) throw new Error('calibration_artifact_sign_failed');
    return r.data.signedUrl;
  };
  const completed = await readJson('completed');
  if (completed) { logger.info(JSON.stringify({ event: 'lumi_q31_series_v2', ...completed, cache_hit: true, review_url: await signed(completed.artifact_path) })); return completed; }
  let accepted = await readJson('accepted');
  if (!accepted && (await readJson('journal/PREPARED') || await readJson('journal/EMITTING') || await readJson('journal/EMISSION_UNKNOWN'))) {
    const ack = await readJson('journal/ACKNOWLEDGED');
    if (!ack?.provider_request_id || ack.http_status >= 400) throw new Error('calibration_prior_emission_requires_inspection_no_resubmit');
    throw new Error('calibration_ack_recovery_required_no_resubmit');
  }
  let preflight;
  if (!accepted) {
    const sourcePath = `${Q31.prefix}/source/${Q31.sourceSha}.png`;
    let s = await storage.download(sourcePath);
    let source;
    if (!s.error) source = Buffer.from(await s.data.arrayBuffer());
    else {
      const response = await fetchImpl(Q31.sourceUrl, { signal: AbortSignal.timeout(30000) });
      if (!response.ok) throw new Error(`calibration_source_download_http_${response.status}`);
      source = Buffer.from(await response.arrayBuffer());
      if (hash(source) !== Q31.sourceSha) throw new Error('calibration_source_hash_mismatch');
      const up = await storage.upload(sourcePath, source, { contentType: 'image/png', upsert: false });
      if (up.error) {
        s = await storage.download(sourcePath);
        if (s.error) throw new Error('calibration_source_persistence_failed');
        source = Buffer.from(await s.data.arrayBuffer());
      }
    }
    if (hash(source) !== Q31.sourceSha || source.readUInt32BE(16) !== Q31.width || source.readUInt32BE(20) !== Q31.height || !source.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw new Error('calibration_source_identity_mismatch');
    const sourceMetadata = { source_identity: Q31.source, job_id: Q31.job, actual_model: Q31.sourceModel, width: Q31.width, height: Q31.height, artifact_path: sourcePath, sha256: Q31.sourceSha, human_review: 'APPROVED', status: 'HUMAN_APPROVED', decode: 'PASS', decode_basis: 'Original PNG fully decoded with Pillow during authenticated recovery; exact SHA verified again in staging' };
    await put('source-status', sourceMetadata, true);
    const input = requestInput(await signed(sourcePath));
    const quote = await estimateHiggsfieldUsd({ apiKey: env.HF_API_KEY, model: Q31.model, input, fetchImpl });
    const { data: cp, error: cpError } = await db.from('lumi_pipeline_checkpoints').select('status,current_cost_usd,authorized_ceiling_usd,pipeline_version').eq('episode_id', Q31.episode).single();
    if (cpError || cp.pipeline_version !== 'v1_1_2' || cp.status === 'CANCELLED') throw new Error('calibration_episode_identity_required');
    const projected = Number((Number(cp.current_cost_usd) + quote.estimated_cost_usd).toFixed(9));
    if (projected > Number(cp.authorized_ceiling_usd)) throw new Error('calibration_accounted_budget_exhausted');
    preflight = { source: sourceMetadata, quote, estimated_cost_usd: quote.estimated_cost_usd, accounted_visual_cost_usd: Number(cp.current_cost_usd), confirmed_image_cost_usd: 0.591597, prior_video_cost_usd_estimated_pending_reconciliation: Number((Number(cp.current_cost_usd)-0.591597).toFixed(9)), projected_accounted_visual_cost_usd: projected, projected_complete_episode_visual_cost_usd: null, accounting_limit: 'Historical connector image/edit costs are not available in API USD; remaining five shots are not quoted or authorized', max_new_kling_calls: 1, retries: 0, variants: 0, resubmits: 0, duration: 4, aspect: '9:16', audio: 'OFF', multi_shots: false, episode_coordinator_status: cp.status, source_human_approval: true, authorized_by: 'USER_EXPLICIT_Q31_SINGLE_CALIBRATION_20261005', connector_event: 'CONNECTOR_PLAN_CAPABILITY_BLOCKED_BEFORE_EMISSION' };
    await put('preflight', preflight, true);
    logger.info(JSON.stringify({ event: 'lumi_q31_series_v2_preflight', ...preflight }));
    const store = new CalibrationJournalStore(storage);
    const submitFetch = journaledFetch({ store, context: { episode_id: Q31.episode, scene_id: Q31.revision, stage: 'VIDEO', attempt_id: Q31.revision, provider: 'higgsfield_api', model: Q31.model, expected_cost_usd: quote.estimated_cost_usd, prompt: PROMPT }, descriptor: { authorization: 'USER_EXPLICIT_SINGLE_CALIBRATION', source_sha256: Q31.sourceSha, max_calls: 1 }, fetchImpl,
      persistResponse: async body => { if (body.request_id) { await put('accepted', { request_id: body.request_id, status_url: body.status_url, accepted_at: iso(), preflight }, false); logger.info(JSON.stringify({ event: 'lumi_q31_series_v2_acknowledged', request_id: body.request_id })); } } });
    try {
      accepted = await providerJson(`https://api.higgsfield.ai/${Q31.model}`, { apiKey: env.HF_API_KEY, method: 'POST', body: input, fetchImpl: submitFetch });
    } catch (error) {
      const job = await readJson('accepted');
      const rejection = [401,402,403,429].includes(error.http_status) && !job?.request_id;
      const diagnostic = { status: rejection ? 'PROVIDER_ACCESS_BLOCKED_BEFORE_JOB_CREATION' : 'EMISSION_REQUIRES_INSPECTION', http_status: error.http_status ?? null, error: error.message, provider_detail: error.provider_detail ?? null, creative_attempt_consumed: job?.request_id ? true : (rejection ? false : null), request_id: job?.request_id ?? null, http_correlation_id: store.current?.provider_request_id ?? null, new_calls: 1, resubmits: 0 };
      await put('blocked', diagnostic, false); logger.info(JSON.stringify({ event: 'lumi_q31_series_v2_blocked', ...diagnostic })); return diagnostic;
    }
    if (!accepted.request_id || !accepted.status_url || !/^https:\/\/api\.higgsfield\.ai\//.test(accepted.status_url)) throw new Error('calibration_ack_handle_invalid_no_resubmit');
  }
  preflight ??= accepted.preflight ?? await readJson('preflight');
  const terminal = await pollRequest({ apiKey: env.HF_API_KEY, statusUrl: accepted.status_url, fetchImpl, onStatus: p => put('status', { request_id: accepted.request_id, ...p }, true) });
  if (terminal.status !== 'completed' || !terminal.video?.url) { await put('terminal-error', terminal); throw new Error(`calibration_provider_terminal_${terminal.status}`); }
  const response = await fetchImpl(terminal.video.url);
  if (!response.ok) throw new Error(`calibration_video_download_http_${response.status}`);
  const video = Buffer.from(await response.arrayBuffer()), sha = hash(video);
  const artifactPath = `${Q31.prefix}/video/${sha}/original.mp4`;
  const up = await storage.upload(artifactPath, video, { contentType: 'video/mp4', upsert: false });
  if (up.error) throw new Error('calibration_video_persist_failed');
  const downloaded = await storage.download(artifactPath);
  if (downloaded.error || hash(Buffer.from(await downloaded.data.arrayBuffer())) !== sha) throw new Error('calibration_video_stored_hash_mismatch');
  const dir = await mkdtemp(join(tmpdir(), 'lumi-q31-series-v2-'));
  let technicalQa;
  try {
    const file = join(dir,'original.mp4'); await writeFile(file,video);
    const probe = await exec('ffprobe',['-v','error','-show_streams','-show_format','-of','json',file]);
    const metadata = JSON.parse(probe.stdout), stream = metadata.streams.find(s=>s.codec_type==='video');
    await exec('ffmpeg',['-v','error','-i',file,'-map','0','-f','null','-']);
    const scan = await exec('ffmpeg',['-v','info','-i',file,'-vf','blackdetect=d=0:pix_th=0.10,freezedetect=n=0.003:d=0.5','-an','-f','null','-'],{maxBuffer:8*1024*1024});
    technicalQa = { decode:'PASS',black_segments:(scan.stderr.match(/black_start:/g)||[]).length,freeze_defects:(scan.stderr.match(/freeze_start:/g)||[]).length,duration:Number(metadata.format.duration),width:stream.width,height:stream.height,fps:stream.avg_frame_rate,audio_streams:metadata.streams.filter(s=>s.codec_type==='audio').length,sha256:sha,visual_temporal_qa:'PENDING_COMPLETE_MP4_REVIEW' };
  } finally { await rm(dir,{recursive:true,force:true}); }
  const result = { revision:Q31.revision,episode_id:Q31.episode,status:'VIDEO_HUMAN_REVIEW_PENDING',request_id:accepted.request_id,model:Q31.model,source:preflight.source,lineage:['q31:QUALITY_STYLE_REJECTED',Q31.source,Q31.revision],artifact_bucket:Q31.bucket,artifact_path:artifactPath,sha256:sha,bytes:video.length,quote:preflight.quote,actual_cost_usd:terminal.cost?.usd??terminal.usd??null,technical_qa:technicalQa,new_kling_calls:1,retries:0,variants:0,resubmits:0,q32_q36_calls:0,tts_calls:0,master_created:false,coordinator_resumed:false,created_at:iso() };
  await put('completed',result,false);
  logger.info(JSON.stringify({event:'lumi_q31_series_v2',...result,review_url:await signed(artifactPath)}));
  return result;
}
