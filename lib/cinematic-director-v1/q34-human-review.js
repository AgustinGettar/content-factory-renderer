import approval from '../../docs/cinematic-director-v1/human-review-20261006/Q34_HUMAN_REVIEW_20261006.json' with {type:'json'};
import {sha256,stableStringify} from './PROMPT_COMPILER_V3.mjs';
import {LumiRecoveryIncidentManager,SupabaseLumiRecoveryStore} from '../lumi-recovery-incident-manager-v1.js';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const EPISODE='ep_lumi_flores_003',PILOT='lumi_tres_flores_colores_v1',exec=promisify(execFile);
const attempts=['q31-PRO2','q32-V2-PRO1','q33-V2-PRO1','q34-V2-PRO1'];
export function isApprovedQ34Row(row){
 const layer=row?.result?.human_review_layers?.HUMAN_REVIEW_20261006;
 return row?.pilot_id===PILOT && row.scene_id===approval.attempt && row.stage==='VIDEO' && row.status==='SUCCEEDED' &&
   row.content_hash===approval.artifact_sha256 && row.provider_request_id===approval.provider_request_id && row.result?.golden_reference===false &&
   layer?.record_sha256===approval.record_sha256 && stableStringify(layer)===stableStringify(approval);
}
export async function prepareApprovedVisualResume({manager,rows}){
 const state=await manager.store.getEpisode(EPISODE);
 if(!state)throw new Error('Q34_CANONICAL_CHECKPOINT_REQUIRED');
 if(state.metadata?.q34_human_resume?.record_sha256===approval.record_sha256 && state.status==='RUNNING')return {status:'RUNNING',first_pending_action:state.first_pending_action,provider_calls:0,duplicate_provider_calls:0,cache_hit:true};
 const byAttempt=new Map(rows.map(r=>[r.scene_id,r]));
 if(attempts.some(a=>!byAttempt.has(a))||!isApprovedQ34Row(byAttempt.get(approval.attempt)))throw new Error('Q34_EXACT_APPROVED_LEDGER_REQUIRED');
 const incident=state.active_incident_id?await manager.store.getIncident(state.active_incident_id):null;
 if(incident && (incident.episode_id!==EPISODE||incident.status!=='OPEN'||!['q31','q32','q33','q34'].includes(incident.scene_id)||incident.error_class!=='QA_BLOCKER'))throw new Error('Q34_CREATIVE_INCIDENT_SCOPE_MISMATCH');
 const known=new Set(['video:q31','temporal_qa:q31','video:q32','temporal_qa:q32','video:q33','temporal_qa:q33','video:q34','temporal_qa:q34','video:q35','video:q37']);
 if(!known.has(state.first_pending_action))throw new Error('Q34_RESUME_PENDING_ACTION_REVIEW_REQUIRED:'+state.first_pending_action);
 await manager.checkpoint(EPISODE,draft=>{
   draft.metadata={...draft.metadata,q34_human_resume:{record_sha256:approval.record_sha256,approval,previous_first_pending_action:state.first_pending_action,previous_last_completed_action:state.last_completed_action,source_video_preparation_pending:'q35',automated_findings_preserved:true,canonical_aliases:{q35:'q37',q36:'q39'}}};
   draft.metadata.approved_visuals_current_episode=Object.fromEntries(rows.map(r=>[r.result.shot||r.scene_id.split('-')[0],{attempt:r.scene_id,sha256:r.content_hash,path:r.storage_path,bucket:r.storage_bucket,request_id:r.provider_request_id}]));
   for(const action of draft.actions){
     const index=['q31','q32','q33','q34'].indexOf(action.scene_id||action.key.split(':')[1]);
     if(index<0||!['VIDEO','TEMPORAL_QA'].includes(action.stage))continue;
     const row=byAttempt.get(attempts[index]);
     action.historical_action_before_human_assembly=action.historical_action_before_human_assembly||structuredClone(action);
     action.artifact={bucket:row.storage_bucket,path:row.storage_path,sha256:row.content_hash,provider_request_id:row.provider_request_id,approved_attempt:row.scene_id};
     action.evidence={...action.evidence,provider_succeeded:true,artifact_persisted:true,sha_verified:true,artifact_verified:true,human_assembly_review:true};
     action.status='COMPLETE';action.dispatch_state='RESULT_RECOVERED';
   }
   draft.runner_enabled=false;draft.autorun=false;
 });
 const pending=await manager.store.getEpisode(EPISODE);
 if(!['video:q35','video:q37'].includes(pending.first_pending_action))throw new Error('Q34_RESUME_EXPECTED_Q35_REQUIRED:'+pending.first_pending_action);
 return manager.resume(EPISODE,{continueAction:async(action,proof)=>{
   if(!proof.recoveryInspectionComplete||action.provider_request_id||!['video:q35','video:q37'].includes(action.key))throw new Error('Q34_NO_PROVIDER_RESUME_REQUIRED');
   return {incident_resolution:'RESOLVED_BY_EXPLICIT_HUMAN_CREATIVE_REVIEW'};
 }});
}
export async function applyQ34HumanReviewAndResume({supabase,env=process.env,operation='APPLY',logger=console}){
 if(env.LUMI_RUNTIME_ENV!=='staging'||env.PROVIDER_CALLS_ALLOWED!=='0'||env.LUMI_PIPELINE_VERSION!=='legacy')throw new Error('Q34_STAGING_ZERO_PROVIDER_REQUIRED');
 if(!['STATUS','APPLY'].includes(operation))throw new Error('Q34_REVIEW_OPERATION_INVALID');
 const manager=new LumiRecoveryIncidentManager({store:new SupabaseLumiRecoveryStore(supabase)});
 const state=await manager.store.getEpisode(EPISODE),incidents=await manager.store.listIncidents(EPISODE);
 const selected=await supabase.from('lumi_pilot_runs').select('*').eq('pilot_id',PILOT).eq('stage','VIDEO').in('scene_id',attempts);
 if(selected.error||selected.data.length!==4)throw new Error('Q34_APPROVED_FOUR_ARTIFACTS_REQUIRED');
 const rows=selected.data,report={event:'lumi_q34_human_review_runtime',operation,episode_id:EPISODE,provider_calls:0,duplicate_provider_calls:0,
   checkpoint:{status:state?.status,last_completed_action:state?.last_completed_action,first_pending_action:state?.first_pending_action,active_incident_id:state?.active_incident_id,actions:state?.actions?.map(a=>({key:a.key,stage:a.stage,scene_id:a.scene_id,status:a.status,dispatch_state:a.dispatch_state,provider_request_id:a.provider_request_id,evidence:a.evidence}))},incidents};
 if(operation==='STATUS'){logger.info(JSON.stringify(report));return report;}
 const {previousVideoGate}=await import('../lumi-series-v2-gates.js');
 for(const row of rows){
   if(row.scene_id!==approval.attempt)previousVideoGate(row);
   const downloaded=await supabase.storage.from(row.storage_bucket).download(row.storage_path);
   if(downloaded.error)throw new Error('Q34_APPROVED_ARTIFACT_DOWNLOAD_FAILED');
   const bytes=Buffer.from(await downloaded.data.arrayBuffer());if(sha256(bytes)!==row.content_hash)throw new Error('Q34_APPROVED_ARTIFACT_SHA_MISMATCH');
   const dir=await mkdtemp(join(tmpdir(),'lumi-q34-approval-'));
   try{const file=join(dir,'original.mp4');await writeFile(file,bytes);await exec('ffmpeg',['-v','error','-i',file,'-f','null','-']);}finally{await rm(dir,{recursive:true,force:true});}
 }
 const row=rows.find(r=>r.scene_id===approval.attempt),before=stableStringify({visual_qa:row.result.visual_qa,temporal_qa:row.result.temporal_qa});
 if(row.content_hash!==approval.artifact_sha256||row.provider_request_id!==approval.provider_request_id||row.result.temporal_qa?.classification!=='GENERATIVE_FATAL')throw new Error('Q34_ORIGINAL_AUTOMATED_FATAL_REQUIRED');
 const result={...row.result,human_review:'APPROVED_FOR_ASSEMBLY',human_review_layers:{...(row.result.human_review_layers||{}),HUMAN_REVIEW_20261006:approval},assembly_eligible:true,golden_reference:false,golden_anatomy_reference:false,QA_DISPOSITION:'HUMAN_OVERRIDE_CURRENT_EPISODE_ONLY'};
 const updated=await supabase.from('lumi_pilot_runs').update({result}).eq('id',row.id).eq('content_hash',approval.artifact_sha256).eq('status','SUCCEEDED').select('*').single();
 if(updated.error||!isApprovedQ34Row(updated.data)||before!==stableStringify({visual_qa:updated.data.result.visual_qa,temporal_qa:updated.data.result.temporal_qa}))throw new Error('Q34_HUMAN_LAYER_WRITE_VERIFY_FAILED');
 rows[rows.indexOf(row)]=updated.data;
 const resumed=await prepareApprovedVisualResume({manager,rows});
 const request=await supabase.from('lumi_controlled_episode_requests').update({status:'RUNNING',updated_at:new Date().toISOString()}).eq('episode_id',EPISODE);if(request.error)throw new Error('Q34_REQUEST_RESUME_WRITE_FAILED');
 const final={...report,...resumed,automated_qa:'GENERATIVE_FATAL',automated_findings_preserved:true,assembly_eligible:true,golden_reference:false,first_pending_media_action:'q35 source/video preparation',human_review_record_sha256:approval.record_sha256};
 logger.info(JSON.stringify(final));return final;
}
