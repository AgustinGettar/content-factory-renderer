import {readFile} from 'node:fs/promises';
import {V2,STYLE} from '../lumi-series-v2-continuation.js';
import {runLumiV2Step} from '../lumi-series-v2-execution.js';
import {stepIdentity,sourceGate,previousVideoGate} from '../lumi-series-v2-gates.js';
import {sha256,stableStringify} from './PROMPT_COMPILER_V3.mjs';
import {TOPOLOGY} from './topology.js';
import {ACTING_PRESETS,GRAMMAR_PRESET,PRESENT_OBJECT_SAFE_POLICY} from './acting-presets.js';
import {projectCinematicPrompt} from './projection.js';

export function compileRemainingRequest({shot,stage,input,sourceSha,sourceQa}){
 if(!['q34','q35','q36'].includes(shot)||!['IMAGE','VIDEO'].includes(stage)||! /^[a-f0-9]{64}$/.test(sourceSha))throw new Error('DIRECTOR_REMAINING_SHOT_SCOPE_REQUIRED');
 const duration=shot==='q34'?4:5,grammar={q34:'PRESENT_FLOWER',q35:'ATTENTIVE_WAIT',q36:'FAREWELL'}[shot];
 const direction={principal_actions:[{grammar,target:shot==='q34'?'flower_blue':'viewer',body_part:'character_left_forearm',
   timing:{preparation:0.5,gesture:shot==='q34'?2.5:3.5,settle:1,response_window:shot==='q35'?2.5:0}}],
   secondary_motion:['blink'],camera:{type:'STATIC'}};
 if(stage==='VIDEO'){
   if(sourceQa?.sha256!==sourceSha||sourceQa?.classification!=='PASS_WITH_MINOR_WARNING'&&sourceQa?.classification!=='PASS')throw new Error('DIRECTOR_EXACT_SOURCE_QA_REQUIRED');
   sourceGate({sha256:sourceSha},{content_hash:sourceSha,result:{visual_qa:sourceQa}});
   if(input.duration!==duration||input.sound!=='off'||input.multi_shots!==false||input.cfg_scale!==0.5)throw new Error('DIRECTOR_PROVIDER_CONTRACT_MISMATCH');
 }
 const projection=stage==='VIDEO'?projectCinematicPrompt({contract:{shot_type:shot==='q35'?'QUESTION_TO_VIEWER':'MEDIUM_TEACHING',DURATION:duration},direction}):null;
 const providerInput={...input,prompt:stage==='VIDEO'?STYLE+'\n'+projection.text:input.prompt};
 const {image_url,image_urls,...safeInput}=providerInput;
 const packet={version:'LUMI_CINEMATIC_DIRECTOR_V1',episode_id:V2.episode,shot,stage,
   authority:'USER_20261005_EPISODE_COMPLETION',acting_preset:GRAMMAR_PRESET[grammar],acting_policy:ACTING_PRESETS[GRAMMAR_PRESET[grammar]],
   allowed_motion:{blink:'NATURAL',eye_tracking:'SMALL',head:'SMALL_SOURCE_SUPPORTED',principal_gestures:1,
     torso_rotation:'PRESERVE_INITIAL',body_yaw:'PRESERVE_INITIAL',wing_response:'MINIMAL',settle:'NATURAL_1X'},
   forbidden_motion:['BODY_TURN','REAR_FACING','TORSO_TWIST','LARGE_WING_FLUTTER','CAMERA_ORBIT','CARTOON_BOUNCE','SLOW_MOTION','DREAMY_FLOATING'],
   presentation_policy:shot==='q34'?PRESENT_OBJECT_SAFE_POLICY:null,camera_contract:'STATIC',topology_constraints:TOPOLOGY,
   quality_profile:{id:'LUMI_VIDEO_QUALITY_PROFILE_V2',canonical_source_sha256:V2.sourceSha,golden:'q31-PRO2',golden_scope:'GREETING; render quality QA only'},
   source_sha256:sourceSha,provider_projection:{model:stage==='IMAGE'?V2.imageModel:V2.videoModel,fields:safeInput,
     input_binding:{sha256:sourceSha,role:stage==='IMAGE'?'IDENTITY_STYLE_ANCHOR':'START_FRAME'},UNKNOWN_AND_EMITTED:0},
   temporal_qa_plan:{decode:true,black_frames:0,freeze_defects:0,topology:'ALL_FRAME_RISK_WINDOW_REVIEW',
     quality_parity_with_q31_pro2:['PASS','PASS_WITH_MINOR_WARNING'],pause_seconds:shot==='q35'?2.5:0,
     no_answer_cue:shot==='q35',retries:0,variants:0,resubmits:0},count:1,retries:0,variants:0,resubmits:0};
 const keys=Object.keys(safeInput).sort();
 const allowed=stage==='VIDEO'?['cfg_scale','duration','multi_shots','prompt','sound']:['aspect_ratio','enhance_prompt','moderation','prompt','quality','resolution'];
 if(stableStringify(keys)!==stableStringify(allowed))throw new Error('DIRECTOR_UNSUPPORTED_PROVIDER_FIELDS');
 packet.sha256=sha256(stableStringify(packet));return {packet,providerInput};
}

export async function runDirectedEpisodeStep({env,fetchImpl=fetch,logger=console}){
 if(env.LUMI_RUNTIME_ENV!=='staging'||env.LUMI_DIRECTOR_EPISODE_COMPLETION!==V2.episode)throw new Error('DIRECTOR_COMPLETION_STAGING_REQUIRED');
 if(env.PROVIDER_CALLS_ALLOWED!=='1')throw new Error('DIRECTOR_EXPLICIT_SINGLE_PROVIDER_WINDOW_REQUIRED');
 const step=JSON.parse(env.LUMI_SERIES_V2_STEP||'null');
 if(!['q34','q35','q36'].includes(step?.shot)||!['IMAGE','VIDEO'].includes(step.stage))throw new Error('DIRECTOR_Q31_Q32_Q33_EMISSION_FORBIDDEN');
 const {createClient}=await import('@supabase/supabase-js');
 const db=createClient(env.SUPABASE_URL,env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false}}),storage=db.storage.from(V2.bucket);
 const replay=await storage.download('lumi-series-v2/ep_lumi_flores_003/director-human-assembly-20261005/replay.json');
 if(replay.error)throw new Error('DIRECTOR_STAGING_REPLAY_REQUIRED');
 const report=JSON.parse(await replay.data.text());
 if(report.status!=='PASS'||report.provider_calls!==0||report.results.length!==3||!report.results.every(r=>r.assembly_eligible&&r.HUMAN_REVIEW_PROVENANCE==='PASS'))throw new Error('DIRECTOR_AUTHENTIC_ASSEMBLY_APPROVAL_REQUIRED');
 const rowFor=async(scene,stage)=>{const r=await db.from('lumi_pilot_runs').select('*').eq('pilot_id',V2.pilot).eq('scene_id',scene).eq('stage',stage).single();if(r.error)throw new Error('DIRECTOR_LEDGER_REQUIRED:'+scene);return r.data;};
 const review=JSON.parse(env.LUMI_DIRECTOR_QA_RECORD_JSON||'null');
 if(review){
   const row=await rowFor(review.attempt,review.stage);
   if(row.content_hash!==review.sha256||row.status!=='SUCCEEDED'||!['IMAGE','VIDEO'].includes(review.stage))throw new Error('DIRECTOR_QA_EXACT_ARTIFACT_REQUIRED');
   if(review.stage==='IMAGE')sourceGate({sha256:row.content_hash},{...row,result:{...row.result,visual_qa:review.qa}});
   else previousVideoGate({...row,result:{...row.result,temporal_qa:review.qa}});
   const u=await db.from('lumi_pilot_runs').update({result:{...row.result,[review.stage==='IMAGE'?'visual_qa':'temporal_qa']:review.qa}}).eq('id',row.id).eq('content_hash',review.sha256).select('content_hash').single();
   if(u.error)throw new Error('DIRECTOR_QA_PERSIST_FAILED');
 }
 const spent=await db.from('lumi_pilot_runs').select('estimated_cost_usd,scene_id').eq('pilot_id',V2.pilot).in('scene_id',['q32-SOURCE-V2-1','q32-V2-PRO1','q33-SOURCE-V2-1','q33-V2-PRO1']);
 if(spent.error||spent.data.length!==4)throw new Error('DIRECTOR_CHECKPOINT_SPEND_REQUIRED');
 const prior=Number(spent.data.reduce((n,r)=>n+Number(r.estimated_cost_usd),0).toFixed(6));
 const cp=await db.from('lumi_pipeline_checkpoints').select('metadata').eq('episode_id',V2.episode).single();if(cp.error)throw new Error('DIRECTOR_CHECKPOINT_REQUIRED');
 const metadata={...cp.data.metadata,series_v2_continuation_budget:{...cp.data.metadata.series_v2_continuation_budget,
   current_episode_completion:{authorization:'USER_20261005_EPISODE_COMPLETION',episode_id:V2.episode,additional_visual_ceiling_usd:3,previous_checkpoint_spend_usd:prior}}};
 const up=await db.from('lumi_pipeline_checkpoints').update({metadata}).eq('episode_id',V2.episode);if(up.error)throw new Error('DIRECTOR_ADDITIONAL_BUDGET_WRITE_FAILED');
 return runLumiV2Step({env:{...env,LUMI_CINEMATIC_DIRECTOR_V1:'false',LUMI_DIRECTOR_REQUEST_COMPILATION:'USER_20261005_EPISODE_COMPLETION'},fetchImpl,logger});
}
