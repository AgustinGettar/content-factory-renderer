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
  episode: 'ep_lumi_flores_003', revision: 'q31-PRO2',
  source: 'LUMI_CANONICAL_SOURCE_V2', width: 941, height: 1672,
  sourceSha: '5dc31254ad26aa1b606735188ac30d2f4d486bc389f19bc8a50816e1e1b3da33',
  transferUrl: "https://d2ol7oe51mr4n9.cloudfront.net/user_3JyiUQvqW4GLHeQWvPah1G5GKhm/dfeded6f-354c-4c2d-935e-aadfe8517c54.png",
  attachmentLibraryId: 'libfile_ad7b77d849e48191be35b1049b5af9a8',
  model: 'kling-video/v3.0/pro/image-to-video', mode: 'PRO',
  bucket: 'av2-generative-video-benchmarks',
  prefix: 'lumi-series-v2/ep_lumi_flores_003/q31-PRO2',
});
export const PROMPT = "Use the supplied image as the exact first-frame canonical visual identity and rendering authority. PREMIUM FEATURE-FILM-QUALITY ULTRA-REALISTIC CINEMATIC 3D CGI, not human photorealism. Single continuous 4-second shot at natural real-time 1x speed.\nIDENTITY LOCK: Preserve exactly the source face, high-detail large turquoise eyes and natural catchlights, pink cheeks, two antennae with violet tips, small yellow hair tuft, rounded warm yellow body and proportions, light-blue finely textured denim overalls, white/light-blue sneakers, exactly two arms and two legs. Exactly TWO translucent light-blue canonical wings total: one wing on each side. Preserve their source contours; no extra lower wing lobes, secondary wings, duplicated membranes or new appendages.\nACTION: Lumi remains in the same garden position facing the viewer. From the source open-hand pose, perform exactly one small gentle welcoming arm/hand gesture, then a natural body settle. Feet stay grounded. Allowed secondary motion is one natural blink, subtle eye tracking, a tiny friendly head follow and barely perceptible physical wing response. Continuous restrained articulated motion, physically plausible at real-time speed.\nCAMERA: static locked camera. Preserve the full-body framing and original garden composition. No orbit, push-in, aggressive zoom, parallax, crop or major reframing.\nMATERIAL AND WORLD LOCK: preserve premium physically based materials, natural subsurface scattering, detailed iris/eye depth and reflections, fine denim weave and stitching, translucent detailed wing membranes and veins, high-detail foliage and grass, rich dimensional vegetation, natural cinematic daylight, soft global illumination, contact shadows and natural depth of field. Keep colors, environment, light, material detail and identity continuous.\nFORBIDDEN: flat cartoon, 2D illustration, cel shading, anime, toy/plastic appearance, cheap TV rendering, simplified textures, flat lighting, cartoon drift, rubbery motion, bounce, squash-and-stretch, slow motion, dreamy floating, exaggerated acting, extra wings or wing lobes, extra limbs, tail, abdomen growth, body morph, face drift, clothing mutation, new objects or characters, flowers appearing, eggs, chicken, basket, wand, shapes, text, captions, logo or watermark.";
const hash = b => createHash('sha256').update(b).digest('hex');
const exec = promisify(execFile);
const iso = () => new Date().toISOString();
export function requestInput(imageUrl) {
  return { duration: 4, sound: 'off', multi_shots: false, cfg_scale: 0.5, prompt: PROMPT, image_url: imageUrl };
}


export function verifyAttachedSource(source) {
  if(hash(source)!==Q31.sourceSha) throw new Error('calibration_source_hash_mismatch');
  if(source.length<24 || !source.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ||
     source.readUInt32BE(16)!==Q31.width || source.readUInt32BE(20)!==Q31.height) throw new Error('calibration_source_identity_mismatch');
  return 'PASS';
}
// Requested endpoint and native resolution are NOT proof of actual provider mode.
export function providerActualSettings(...responses) {
  const evidence=[];
  for (const r of responses) {
    for(const [scope,obj] of [['response',r],['metadata',r?.metadata],['execution',r?.execution],['provider',r?.provider],['video',r?.video]]) {
      if(!obj || typeof obj!=='object')continue;
      for(const key of ['actual_model','model_id','model','model_name','actual_mode','mode']) {
        if(typeof obj[key]==='string')evidence.push({scope,field:key,value:obj[key]});
      }
    }
  }
  const modelValues=evidence.filter(x=>/model/.test(x.field)).map(x=>x.value);
  const modeValues=evidence.filter(x=>/mode$/.test(x.field)).map(x=>x.value.toLowerCase());
  const endpointModes=modelValues.map(x=>/\/std\//.test(x)?'std':/\/pro\//.test(x)?'pro':null).filter(Boolean);
  const observed=[...modeValues,...endpointModes];
  const actualMode=observed.some(x=>['std','standard'].includes(x)) ? 'STANDARD' :
    observed.some(x=>x==='pro') ? 'PRO' : 'UNKNOWN';
  return {ACTUAL_MODEL:modelValues[0]??'UNKNOWN',ACTUAL_MODE:actualMode,
    verification:actualMode==='PRO'?'PRO_PROVIDER_REPORTED':actualMode==='STANDARD'?'PROVIDER_MODE_DISCREPANCY':'UNKNOWN_NO_PROVIDER_MODE_EVIDENCE',
    provider_setting_evidence:evidence};
}

export async function readCalibrationJson(storage, name) {
  const objectPath = `${Q31.prefix}/${name}.json`;
  const split = objectPath.lastIndexOf('/');
  const directory = objectPath.slice(0, split), basename = objectPath.slice(split+1);
  const listing = await storage.list(directory, { search: basename, limit: 100 });
  if (listing.error || !Array.isArray(listing.data)) throw new Error(`calibration_record_list_failed:${name}`);
  if (!listing.data.some(x=>x.name===basename)) return null;
  const r = await storage.download(objectPath);
  if (r.error || !r.data) throw new Error(`calibration_record_read_failed:${name}`);
  return JSON.parse(await r.data.text());
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

export async function runQ31Pro2Calibration({ env = process.env, logger = console, fetchImpl = fetch }) {
  if (env.LUMI_RUNTIME_ENV !== 'staging' || env.LUMI_Q31_PRO2_AUTHORIZATION !== Q31.sourceSha) throw new Error('calibration_staging_scoped_authorization_required');
  if (!env.HF_API_KEY) throw new Error('calibration_higgsfield_credentials_missing');
  const { createClient } = await import('@supabase/supabase-js');
  const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const storage = db.storage.from(Q31.bucket);
  const readJson = name => readCalibrationJson(storage,name);
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
  if (completed) { logger.info(JSON.stringify({ event: 'lumi_q31_pro2', ...completed, cache_hit: true, review_url: await signed(completed.artifact_path) })); return completed; }
  let accepted = await readJson('accepted');
  if (!accepted && (await readJson('journal/PREPARED') || await readJson('journal/EMITTING') || await readJson('journal/EMISSION_UNKNOWN'))) {
    const ack = await readJson('journal/ACKNOWLEDGED');
    if (!ack?.provider_request_id || ack.http_status >= 400) throw new Error('calibration_prior_emission_requires_inspection_no_resubmit');
    throw new Error('calibration_ack_recovery_required_no_resubmit');
  }
  let preflight;
  if (!accepted) {
    const sourcePath = `${Q31.prefix}/source/${Q31.sourceSha}.png`;
    // This URL is a NEW byte-preserving transfer of this turn's locally verified attachment.
    // No source recovery from previous links, jobs or private storage is permitted.
    const response = await fetchImpl(Q31.transferUrl, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`calibration_attachment_transfer_http_${response.status}`);
    const source = Buffer.from(await response.arrayBuffer());
    verifyAttachedSource(source);
    const up = await storage.upload(sourcePath, source, { contentType: 'image/png', upsert: false });
    if (up.error) throw new Error('calibration_attachment_private_copy_write_failed');
    const sourceMetadata = { source_identity: Q31.source, original_attachment_library_id: Q31.attachmentLibraryId,
      width: Q31.width, height: Q31.height, artifact_path: sourcePath, sha256: Q31.sourceSha,
      human_review: 'APPROVED', source_verification:'PASS', decode:'PASS',
      decode_basis:'Locally fully decoded attached PNG; exact byte SHA verified locally and again after byte-preserving transfer in staging',
      source_origin:'USER_ATTACHMENT_THIS_EXECUTION', source_edited:false, source_regenerated:false };
    await put('source-status', sourceMetadata, true);
    const input = requestInput(await signed(sourcePath));
    const quote = await estimateHiggsfieldUsd({ apiKey: env.HF_API_KEY, model: Q31.model, input, fetchImpl });
    const { data: cp, error: cpError } = await db.from('lumi_pipeline_checkpoints').select('status,current_cost_usd,authorized_ceiling_usd,pipeline_version').eq('episode_id', Q31.episode).single();
    if (cpError || cp.pipeline_version !== 'v1_1_2' || cp.status === 'CANCELLED') throw new Error('calibration_episode_identity_required');
    const {data: previous, error: previousError} = await db.from('lumi_pilot_runs').select('provider_request_id,estimated_cost_usd,result').eq('id','f6c41cd0-34be-4b14-bb02-38533eeadcaa').single();
    if(previousError || previous.provider_request_id !== '864b066b-be86-4766-9afd-4425c34c4fb0' || previous.result?.sha256 !== '7ffff39d0568d53b989d67cb1d938aaebc0debe541e941a1acbc873753af6ef9' || previous.result?.calibration_validity !== 'QUALITY_CALIBRATION_INVALID') throw new Error('previous_standard_preservation_evidence_required');
    const accountedBefore = Number((Number(cp.current_cost_usd)+Number(previous.estimated_cost_usd)).toFixed(9));
    const projected = Number((accountedBefore + quote.estimated_cost_usd).toFixed(9));
    if (projected > Number(cp.authorized_ceiling_usd)) throw new Error('calibration_accounted_budget_exhausted');
    preflight = { REQUESTED_MODEL:Q31.model, REQUESTED_MODE:Q31.mode, SOURCE_SHA:Q31.sourceSha, SOURCE_VERIFICATION:'PASS', ATTEMPT_ID:Q31.revision, DURATION:4, AUDIO:'OFF', reason:'HUMAN_REQUESTED_QUALITY_CALIBRATION', source: sourceMetadata, quote, estimated_cost_usd: quote.estimated_cost_usd, accounted_visual_cost_usd: accountedBefore, confirmed_image_cost_usd: 0.591597, prior_video_cost_usd_estimated_pending_reconciliation: Number((accountedBefore-0.591597).toFixed(9)), projected_accounted_visual_cost_usd: projected, projected_complete_episode_visual_cost_usd: null, accounting_limit: 'Historical connector image/edit costs are not available in API USD; remaining five shots are not quoted or authorized', max_new_kling_calls: 1, retries: 0, variants: 0, resubmits: 0, duration: 4, aspect: '9:16', audio: 'OFF', multi_shots: false, episode_coordinator_status: cp.status, source_human_approval: true, authorized_by: 'USER_EXPLICIT_Q31_PRO2_SINGLE_CALIBRATION_20261005', connector_event: 'CONNECTOR_PLAN_CAPABILITY_BLOCKED_BEFORE_EMISSION' };
    await put('preflight', preflight, true);
    logger.info(JSON.stringify({ event: 'lumi_q31_pro2_preflight', ...preflight }));
    const store = new CalibrationJournalStore(storage);
    const submitFetch = journaledFetch({ store, context: { episode_id: Q31.episode, scene_id: Q31.revision, stage: 'VIDEO', attempt_id: Q31.revision, provider: 'higgsfield_api', model: Q31.model, expected_cost_usd: quote.estimated_cost_usd, prompt: PROMPT }, descriptor: { authorization: 'USER_EXPLICIT_SINGLE_CALIBRATION', source_sha256: Q31.sourceSha, REQUESTED_MODEL:Q31.model, REQUESTED_MODE:Q31.mode, DURATION:4, AUDIO:'OFF', max_calls: 1 }, fetchImpl,
      persistResponse: async body => { if (body.request_id) { await put('accepted', { request_id: body.request_id, status_url: body.status_url, accepted_at: iso(), provider_response:body, preflight }, false); logger.info(JSON.stringify({ event: 'lumi_q31_pro2_acknowledged', request_id: body.request_id })); } } });
    try {
      accepted = await providerJson(`https://api.higgsfield.ai/${Q31.model}`, { apiKey: env.HF_API_KEY, method: 'POST', body: input, fetchImpl: (url, options)=> { const headers = new Headers(options.headers); headers.set('Idempotency-Key',Q31.revision); return submitFetch(url,{...options,headers}); } });
    } catch (error) {
      const job = await readJson('accepted');
      const rejection = [401,402,403,429].includes(error.http_status) && !job?.request_id;
      const diagnostic = { status: rejection ? 'PROVIDER_ACCESS_BLOCKED_BEFORE_JOB_CREATION' : 'EMISSION_REQUIRES_INSPECTION', http_status: error.http_status ?? null, error: error.message, provider_detail: error.provider_detail ?? null, creative_attempt_consumed: job?.request_id ? true : (rejection ? false : null), request_id: job?.request_id ?? null, http_correlation_id: store.current?.provider_request_id ?? null, new_calls: 1, resubmits: 0 };
      await put('blocked', diagnostic, false); logger.info(JSON.stringify({ event: 'lumi_q31_pro2_blocked', ...diagnostic })); return diagnostic;
    }
    if (!accepted.request_id || !accepted.status_url) throw new Error('calibration_ack_handle_invalid_no_resubmit');
  }
  logger.info(JSON.stringify({event:'lumi_q31_pro2_poll_same_request',request_id:accepted.request_id,status_url:accepted.status_url}));
  preflight ??= accepted.preflight ?? await readJson('preflight');
  const terminal = await pollRequest({ apiKey: env.HF_API_KEY, statusUrl: accepted.status_url, fetchImpl, onStatus: p => put('status', { request_id: accepted.request_id, ...p }, true) });
  await put('provider-terminal', terminal, true);
  const actual = providerActualSettings(terminal, accepted.provider_response ?? accepted);
  await put('actual-settings',actual,true);
  if (terminal.status !== 'completed' || !terminal.video?.url) { await put('terminal-error', terminal); throw new Error(`calibration_provider_terminal_${terminal.status}`); }
  const response = await fetchImpl(terminal.video.url);
  if (!response.ok) throw new Error(`calibration_video_download_http_${response.status}`);
  const video = Buffer.from(await response.arrayBuffer()), sha = hash(video);
  const artifactPath = `${Q31.prefix}/video/${sha}/original.mp4`;
  const up = await storage.upload(artifactPath, video, { contentType: 'video/mp4', upsert: false });
  if (up.error) {
    const prior = await storage.download(artifactPath);
    if(prior.error || hash(Buffer.from(await prior.data.arrayBuffer()))!==sha) throw new Error('calibration_video_persist_failed');
  }
  const downloaded = await storage.download(artifactPath);
  if (downloaded.error || hash(Buffer.from(await downloaded.data.arrayBuffer())) !== sha) throw new Error('calibration_video_stored_hash_mismatch');
  logger.info(JSON.stringify({event:'lumi_q31_pro2_artifact_persisted',request_id:accepted.request_id,artifact_path:artifactPath,sha256:sha,bytes:video.length,review_url:await signed(artifactPath)}));
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
  const result = { revision:Q31.revision,episode_id:Q31.episode,status:'VIDEO_HUMAN_REVIEW_PENDING', calibration_valid:actual.ACTUAL_MODE==='PRO' ? 'PENDING_VISUAL_AND_HUMAN_REVIEW':'NOT_VALID_ACTUAL_MODE_UNVERIFIED_OR_MISMATCH',request_id:accepted.request_id,REQUESTED_MODEL:Q31.model, REQUESTED_MODE:Q31.mode, ...actual, model:Q31.model, source:preflight.source,lineage:['q31:QUALITY_STYLE_REJECTED','q31-SERIES-V2-V1:QUALITY_CALIBRATION_INVALID',Q31.source,Q31.revision],artifact_bucket:Q31.bucket,artifact_path:artifactPath,sha256:sha,bytes:video.length,quote:preflight.quote,actual_cost_usd:terminal.cost?.usd??terminal.usd??null,technical_qa:technicalQa,new_kling_calls:1,retries:0,variants:0,resubmits:0,q32_q36_calls:0,tts_calls:0,master_created:false,coordinator_resumed:false,created_at:iso() };
  await put('completed',result,false);
  logger.info(JSON.stringify({event:'lumi_q31_pro2',...result,review_url:await signed(artifactPath)}));
  return result;
}
