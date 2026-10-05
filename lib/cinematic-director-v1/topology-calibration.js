import dataset from '../../docs/temporal-topology-qa-v2/AUTHENTIC_CALIBRATION_DATASET_V1.json' with {type:'json'};
import {evaluateTemporalTopology,TEMPORAL_TOPOLOGY_VERSION,CONFIDENCE_CALIBRATION_VERSION} from './temporal-topology-qa-v2.js';
import {sha256,stableStringify} from './PROMPT_COMPILER_V3.mjs';
import {applyRegisteredHumanReviews} from './artifact-human-review.js';
import {V2} from '../lumi-series-v2-continuation.js';
import {previousVideoGate} from '../lumi-series-v2-gates.js';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile);
export const CALIBRATION_PATH=V2.prefix+'/topology-calibration-v1/replay.json';
export function evaluateCalibration(data=dataset) {
 const {sha256:digest,...body}=data;
 if(sha256(stableStringify(body))!==digest)throw new Error('CALIBRATION_DATASET_SHA_MISMATCH');
 const positives=data.positives.map(p=>({attempt:p.attempt,sha256:p.review.sha256,...evaluateTemporalTopology({sha256:p.review.sha256,review:p.review})}));
 const negatives=data.negatives.map(n=>({id:n.id,kind:n.kind,...evaluateTemporalTopology({sha256:n.review.sha256,review:n.review})}));
 const falseFatals=positives.filter(p=>p.automatic_classification==='GENERATIVE_FATAL').length,blocked=negatives.filter(n=>n.severity==='BLOCKER').length;
 return {version:CONFIDENCE_CALIBRATION_VERSION,topology_version:TEMPORAL_TOPOLOGY_VERSION,status:falseFatals===0&&negatives.length>0&&blocked===negatives.length?'PASS':'CALIBRATION_REVIEW_REQUIRED',dataset_sha256:digest,
  FALSE_FATALS_ON_HUMAN_APPROVED_SET:falseFatals,TRUE_FATAL_FIXTURES_BLOCKED:blocked===negatives.length?'100_PERCENT':blocked+'/'+negatives.length,
  AMBIGUOUS_FINDINGS_PRESERVED:positives.every((p,i)=>p.findings.length===data.positives[i].review.findings.length),HUMAN_REVIEW_PROVENANCE_PRESERVED:false,
  positives,negatives,provider_calls:0,scope:'Deterministic typed evidence calibration; synthetic fixtures do not measure pixel-detector accuracy.'};
}
export async function runTopologyCalibration({env=process.env,logger=console}) {
 if(env.LUMI_RUNTIME_ENV!=='staging'||env.PROVIDER_CALLS_ALLOWED!=='0'||env.LUMI_PIPELINE_VERSION!=='legacy'||env.LUMI_PIPELINE_AUTORUN==='true')throw new Error('CALIBRATION_STAGING_ZERO_PROVIDER_REQUIRED');
 const {createClient}=await import('@supabase/supabase-js');
 const db=createClient(env.SUPABASE_URL,env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false}}),storage=db.storage.from(V2.bucket);
 const approval=await applyRegisteredHumanReviews({supabase:db,env,logger});
 const cp=await db.from('lumi_pipeline_checkpoints').select('*').eq('episode_id',V2.episode).single();
 if(cp.error||cp.data.runner_enabled||cp.data.autorun)throw new Error('CALIBRATION_CANONICAL_RUNNERS_OFF_REQUIRED');
 const report=evaluateCalibration();
 const download=async(path,expected)=>{const r=await storage.download(path);if(r.error)throw new Error('CALIBRATION_ORIGINAL_DOWNLOAD_FAILED');const b=Buffer.from(await r.data.arrayBuffer());if(sha256(b)!==expected)throw new Error('CALIBRATION_ORIGINAL_SHA_MISMATCH');return b;};
 await download(V2.sourcePath,V2.sourceSha);
 for(let i=0;i<dataset.positives.length;i++) {
  const p=dataset.positives[i];const selected=await db.from('lumi_pilot_runs').select('*').eq('pilot_id',V2.pilot).eq('scene_id',p.attempt).eq('stage','VIDEO').single();
  if(selected.error||selected.data.content_hash!==p.review.sha256)throw new Error('CALIBRATION_AUTHENTIC_LEDGER_REQUIRED');
  const row=selected.data;previousVideoGate(row);
  const bytes=await download(row.storage_path,row.content_hash),dir=await mkdtemp(join(tmpdir(),'lumi-topology-replay-'));
  try {const file=join(dir,'video.mp4');await writeFile(file,bytes);await exec('ffmpeg',['-v','error','-i',file,'-f','null','-']);const probe=JSON.parse((await exec('ffprobe',['-v','error','-count_frames','-show_streams','-of','json',file])).stdout);const stream=probe.streams.find(s=>s.codec_type==='video');if(Number(stream.nb_read_frames)!==p.review.decoded_frame_count)throw new Error('CALIBRATION_FRAME_COUNT_MISMATCH');}finally{await rm(dir,{recursive:true,force:true});}
  if(p.review.comparisons.video_source.sha256!==V2.sourceSha) {
   const src=await db.from('lumi_pilot_runs').select('*').eq('pilot_id',V2.pilot).eq('scene_id',p.attempt.split('-')[0]+'-SOURCE-V2-1').eq('stage','IMAGE').single();
   if(src.error||src.data.content_hash!==p.review.comparisons.video_source.sha256)throw new Error('CALIBRATION_SOURCE_LEDGER_REQUIRED');await download(src.data.storage_path,src.data.content_hash);
  }
  const before=sha256(stableStringify({visual_qa:row.result.visual_qa,temporal_qa:row.result.temporal_qa,human_review_layers:row.result.human_review_layers}));
  const result={...row.result,topology_calibration_layers:{...row.result.topology_calibration_layers,[CONFIDENCE_CALIBRATION_VERSION]:{review:p.review,result:report.positives[i],historical_qa_and_human_review_sha256:before}}};
  const u=await db.from('lumi_pilot_runs').update({result}).eq('id',row.id).eq('content_hash',row.content_hash).select('*').single();
  if(u.error||before!==sha256(stableStringify({visual_qa:u.data.result.visual_qa,temporal_qa:u.data.result.temporal_qa,human_review_layers:u.data.result.human_review_layers})))throw new Error('CALIBRATION_HISTORICAL_PROVENANCE_CHANGED');
  report.positives[i].original_decode_and_sha='PASS';report.positives[i].HUMAN_REVIEW_PROVENANCE='PASS';report.positives[i].historical_qa_and_human_review_sha256=before;
 }
 report.HUMAN_REVIEW_PROVENANCE_PRESERVED=true;report.code_sha=env.RENDER_GIT_COMMIT;report.runners='OFF';report.autorun=false;report.global_default='legacy';report.human_review_application=approval;
 if(!report.AMBIGUOUS_FINDINGS_PRESERVED||report.status!=='PASS')throw new Error('CALIBRATION_READINESS_FAILED');
 const bytes=Buffer.from(JSON.stringify(report));const u=await storage.upload(CALIBRATION_PATH,bytes,{contentType:'application/json',upsert:true});if(u.error)throw new Error('CALIBRATION_REPLAY_PERSIST_FAILED');await download(CALIBRATION_PATH,sha256(bytes));
 logger.info(JSON.stringify({event:'lumi_topology_calibration_completed',...report}));return report;
}
