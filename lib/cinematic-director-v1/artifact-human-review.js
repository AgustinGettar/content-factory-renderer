import approval from '../../docs/temporal-topology-qa-v2/Q35_HUMAN_REVIEW_20261006.json' with {type:'json'};
import {sha256,stableStringify} from './PROMPT_COMPILER_V3.mjs';
import {LumiRecoveryIncidentManager,SupabaseLumiRecoveryStore} from '../lumi-recovery-incident-manager-v1.js';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile);
export const REGISTERED_HUMAN_REVIEWS=Object.freeze([approval]);
export function isApprovedArtifactRow(row) {
 const record=REGISTERED_HUMAN_REVIEWS.find(r=>r.attempt===row?.scene_id&&r.artifact_sha256===row.content_hash&&r.provider_request_id===row.provider_request_id);
 if(!record||row.stage!=='VIDEO'||row.status!=='SUCCEEDED'||row.pilot_id!=='lumi_tres_flores_colores_v1')return false;
 const layer=row.result?.human_review_layers?.[record.record_sha256];
 const {record_sha256,...body}=record;
 return sha256(stableStringify(body))===record_sha256 && stableStringify(layer)===stableStringify(record)&&row.result?.assembly_eligible===true&&row.result.golden_anatomy_reference===false;
}
export async function completeHumanReviewedAction({manager,row,record}) {
 if(!isApprovedArtifactRow(row))throw new Error('EXACT_REGISTERED_HUMAN_REVIEW_REQUIRED');
 const state=await manager.store.getEpisode(record.episode_id);
 if(!state||state.runner_enabled||state.autorun)throw new Error('HUMAN_REVIEW_RUNNERS_OFF_REQUIRED');
 if(state.metadata?.artifact_human_reviews?.[record.record_sha256])return {cache_hit:true,provider_calls:0,first_pending_action:state.first_pending_action};
 const shot=row.result.shot||row.scene_id.split('-')[0],alias=state.metadata?.q34_human_resume?.canonical_aliases?.[shot]||shot;
 if(state.first_pending_action!=='temporal_qa:'+alias)throw new Error('HUMAN_REVIEW_SERIAL_QA_SCOPE_REQUIRED');
 const incident=await manager.store.getIncident(state.active_incident_id);
 if(incident?.status!=='OPEN'||incident.episode_id!==record.episode_id||incident.scene_id!==record.attempt||incident.provider_request_id!==record.provider_request_id||incident.error_class!=='QA_BLOCKER')throw new Error('HUMAN_REVIEW_INCIDENT_SCOPE_REQUIRED');
 await manager.completeAction(record.episode_id,state.first_pending_action,{artifact:{attempt:row.scene_id,sha256:row.content_hash,path:row.storage_path,bucket:row.storage_bucket,request_id:row.provider_request_id,human_review_record_sha256:record.record_sha256},evidence:{provider_succeeded:true,artifact_persisted:true,sha_verified:true,artifact_verified:true,human_assembly_review:true},actualCostUsd:0});
 const resumed=await manager.resume(record.episode_id,{continueAction:async(action,proof)=>{
  if(!proof.recoveryInspectionComplete||action.provider_request_id||action.dispatch_state!=='NOT_DISPATCHED')throw new Error('HUMAN_REVIEW_NO_PROVIDER_RESUME_REQUIRED');
  return {incident_resolution:'RESOLVED_BY_EXPLICIT_HUMAN_CREATIVE_REVIEW'};
 }});
 await manager.checkpoint(record.episode_id,d=>{d.runner_enabled=false;d.autorun=false;d.metadata.artifact_human_reviews={...d.metadata.artifact_human_reviews,[record.record_sha256]:record};d.metadata.approved_visuals_current_episode={...d.metadata.approved_visuals_current_episode,[shot]:{attempt:row.scene_id,sha256:row.content_hash,path:row.storage_path,bucket:row.storage_bucket,request_id:row.provider_request_id,assembly_eligible:true,golden_reference:false}};});
 return {...resumed,provider_calls:0,human_review_record_sha256:record.record_sha256};
}
export async function applyRegisteredHumanReviews({supabase,env=process.env,logger=console}) {
 if(env.LUMI_RUNTIME_ENV!=='staging'||env.PROVIDER_CALLS_ALLOWED!=='0'||env.LUMI_PIPELINE_VERSION!=='legacy')throw new Error('HUMAN_REVIEW_STAGING_ZERO_PROVIDER_REQUIRED');
 const manager=new LumiRecoveryIncidentManager({store:new SupabaseLumiRecoveryStore(supabase)}),results=[];
 for(const record of REGISTERED_HUMAN_REVIEWS) {
  const r=await supabase.from('lumi_pilot_runs').select('*').eq('pilot_id','lumi_tres_flores_colores_v1').eq('stage','VIDEO').eq('scene_id',record.attempt).single();
  if(r.error||r.data.content_hash!==record.artifact_sha256||r.data.provider_request_id!==record.provider_request_id||r.data.status!=='SUCCEEDED')throw new Error('HUMAN_REVIEW_EXACT_ARTIFACT_REQUIRED');
  const row=r.data,downloaded=await supabase.storage.from(row.storage_bucket).download(row.storage_path);
  if(downloaded.error)throw new Error('HUMAN_REVIEW_ARTIFACT_DOWNLOAD_FAILED');
  const bytes=Buffer.from(await downloaded.data.arrayBuffer());if(sha256(bytes)!==record.artifact_sha256)throw new Error('HUMAN_REVIEW_ARTIFACT_SHA_MISMATCH');
  const dir=await mkdtemp(join(tmpdir(),'lumi-human-review-'));
  try{const file=join(dir,'video.mp4');await writeFile(file,bytes);await exec('ffmpeg',['-v','error','-i',file,'-f','null','-']);}finally{await rm(dir,{recursive:true,force:true});}
  const before=stableStringify({visual_qa:row.result.visual_qa,temporal_qa:row.result.temporal_qa});
  const result={...row.result,human_review:record.HUMAN_REVIEW,human_review_layers:{...row.result.human_review_layers,[record.record_sha256]:record},assembly_eligible:true,golden_reference:false,golden_anatomy_reference:false,QA_DISPOSITION:record.QA_DISPOSITION,CALIBRATION_LABEL:record.CALIBRATION_LABEL};
  const u=await supabase.from('lumi_pilot_runs').update({result}).eq('id',row.id).eq('content_hash',record.artifact_sha256).eq('provider_request_id',record.provider_request_id).select('*').single();
  if(u.error||!isApprovedArtifactRow(u.data)||before!==stableStringify({visual_qa:u.data.result.visual_qa,temporal_qa:u.data.result.temporal_qa})||row.estimated_cost_usd!==u.data.estimated_cost_usd)throw new Error('HUMAN_REVIEW_PRESERVATION_VERIFY_FAILED');
  results.push(await completeHumanReviewedAction({manager,row:u.data,record}));
 }
 const report={event:'lumi_registered_human_review_applied',results,provider_calls:0,automated_findings_preserved:true};logger.info(JSON.stringify(report));return report;
}
