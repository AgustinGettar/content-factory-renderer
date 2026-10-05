// Run only with director-offline-guard.mjs preloaded. No API, remote storage or quote call.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { runLumiV2Step } from '../lib/lumi-series-v2-execution.js';
import { POLICY } from '../lib/cinematic-director-v1/profiles.js';
import { makeFixture } from '../test/fixtures/director-v1.js';
import { sha256 } from '../lib/cinematic-director-v1/PROMPT_COMPILER_V3.mjs';

assert.equal(globalThis.LUMI_OFFLINE_GUARD?.active,true,'OFFLINE_GUARD_REQUIRED');
const output=resolve(process.argv[2] || 'director-output');
await mkdir(output,{recursive:true});
const env={LUMI_CINEMATIC_DIRECTOR_V1:'true',LUMI_RUNTIME_ENV:'local_offline',LUMI_PIPELINE_VERSION:'v1_1_2',LUMI_DIRECTOR_FIXTURES:'true'};
const planPath=new URL('../episodes/ep_lumi_flores_003/EPISODE_PLAN_V2.json',import.meta.url);
const packPath=new URL('../episodes/ep_lumi_flores_003/SHOT_PACK_V1.json',import.meta.url);
const before={plan:sha256(await readFile(planPath)),pack:sha256(await readFile(packPath))};
const examples=[];
for(const [name,grammar,turn] of [['01_presentar_flor','PRESENT_FLOWER',false],['02_espera_pedagogica','ATTENTIVE_WAIT',false],['03_fuente_incompatible','PRESENT_FLOWER',true]]) {
  const f=await makeFixture({grammar,directory:join(output,'synthetic-fixtures',name)});
  if(turn)f.input.direction.principal_actions[0].body_motion='TURN';
  const packet=await runLumiV2Step({env,directorReview:{input:f.input,...f.options}});
  if(turn){assert.ok(packet.blockers.some(x=>x.code==='SOURCE_ACTION_MISMATCH'));assert.equal(packet.PROVIDER_PROMPT,null);}
  else {assert.deepEqual(packet.blockers,[]);assert.equal(packet.gates.DIRECTION_COHERENT,true);}
  assert.equal(packet.gates.EXECUTION_AUTHORIZATION,false);assert.equal(packet.PROVIDER_REQUEST_PREVIEW.payload,null);
  await writeFile(join(output,`${name}.json`),JSON.stringify(packet,null,2)+'\n');
  examples.push({name,synthetic_fixture:true,expected:turn?'SOURCE_ACTION_MISMATCH':'OFFLINE_REVIEWABLE_NOT_AUTHORIZED',actual:packet.status,assertions:'PASS',creative_fingerprint:packet.creative_fingerprint});
}

const evidenceRoot=new URL('../docs/cinematic-director-v1/evidence/',import.meta.url);
const readEvidence=async name=>JSON.parse(await readFile(new URL(name,evidenceRoot)));
const [contracts,forensic,quality]=await Promise.all([readEvidence('SHOT_CONTRACTS_V2.json'),readEvidence('LUMI_q32_q33_REPAIR_PLAN.json'),readEvidence('LUMI_SERIES_V2_QUALITY_BUDGET_REVIEW.json')]);
const plan=JSON.parse(await readFile(planPath));
const documentary=[];
for(const shot of ['q31','q32','q33']) {
  const c=structuredClone(contracts.shots.find(s=>s.shot_id===shot));
  const source=forensic.existing_provenance.find(x=>x.scene_id===`${shot}-SOURCE-V2-1`);
  // This is an explicit proposed binding revision, not a rewrite of the historical contract.
  // The path is documented artifact identity. No fabricated URL or local image is substituted.
  if(source)c.SOURCE_ARTIFACT={artifact_id:source.scene_id,path:source.artifact_path,sha256:source.sha256};
  else c.SOURCE_ARTIFACT={artifact_id:'LUMI_CANONICAL_SOURCE_V2',path:'lumi-series-v2/ep_lumi_flores_003/q31-PRO2/source/'+quality.video_quality_profile.source_sha+'.png',sha256:quality.video_quality_profile.source_sha};
  const human=quality.human_approval;
  c.GOLDEN_REFERENCES=[{artifact_id:'q31-PRO2',role:'motion',sha256:human.artifact_sha256}];
  const unknown={value:null,status:'UNKNOWN',evidence_ids:[]};
  const input={version:'LUMI_CINEMATIC_DIRECTION_V1',episode_id:POLICY.episode_id,revision:1,contract:c,policy_id:POLICY.id,language:'en',synthetic_fixture:false,
    direction:{educational_goal:plan.scenes.find(s=>s.id===shot.replace('q','s')).educational_goal,
      reason_es:'Propuesta de actuación localizada. La pose, lateralidad, mano libre y espacio de captions requieren revisión vinculada a los bytes originales.',
      emotion:'warm',focus:shot==='q31'?'viewer':shot==='q32'?'flower_red':'flower_yellow',framing:'FROM_APPROVED_SOURCE',
      principal_actions:[{grammar:shot==='q31'?'GAZE_VIEWER':'PRESENT_FLOWER',actor:'lumi',body_part:'gaze',target:shot==='q31'?'viewer':shot==='q32'?'flower_red':'flower_yellow',direction:shot==='q31'?'toward_viewer':'toward_target',amplitude:'small',pace:'natural_1x',body_motion:'PRESERVE_INITIAL',timing:{preparation:0.5,gesture:2.5,settle:1,response_window:0}}],
      secondary_motion:['blink'],stable_parts:['torso','feet','posterior_silhouette','educational_objects','wand'],camera:{type:'STATIC',reason_es:'Evitar revelado de anatomía no documentada.',approval_id:null},end:'NATURAL_SETTLE',
      continuity:{previous_shot:null,next_shot:null,entry_gaze:'UNKNOWN',exit_gaze:'UNKNOWN',screen_direction:'UNKNOWN',function:shot==='q31'?'introduction':'teaching'},
      captions:{generated_text:false,labels:[],text_character_overlap:0,critical_object_overlap:0,safe_region_fact:'caption_space'}},
    facts:Object.fromEntries(['body_orientation','gaze','framing','caption_space','supported_actions','supported_cameras','wand_state','left_hand','right_hand','laterality','educational_inventory'].map(k=>[k,structuredClone(unknown)])),
    reviews:[{id:'documented-q31-human-warning',artifact_id:'q31-PRO2',sha256:human.artifact_sha256,actor:null,at:null,scope:'q31-PRO2_EXISTING_LOWER_WING_CONTOUR',kind:'DOCUMENTARY',status:'APPROVED_WITH_WARNING',observations:{statement:human.statement},warnings:[{code:'ACCEPTED_LOWER_WING_CONTOUR',scope:'q31-PRO2_EXISTING_LOWER_WING_CONTOUR',sha256:human.artifact_sha256}]}],
    context:{style_authority:{id:'LUMI_SERIES_STYLE_V2',status:'FROZEN'},locks:{},artifact_evidence:{},source_readiness:{},postproduction:{deterministic_educational_graphics:true,text_character_overlap:0,visible_pause_label:false,playback_rate:1,master_width:1080,master_height:1920,planned_captions:[]}},
    media:[],source_qa:{sha256:c.SOURCE_ARTIFACT.sha256,ANATOMY:shot==='q33'?'BLOCKER':'REVIEW_REQUIRED'},request_parameters:{},required_controls:['sound','duration','multi_shots','image_url','prompt'],direction_approval:null,execution_authorization:false};
  const packet=await runLumiV2Step({env:{...env,LUMI_DIRECTOR_FIXTURES:'false'},directorReview:{input,outputDirectory:join(output,'documentary-decisions')}});
  assert.equal(packet.gates.SOURCE_EVIDENCE_READY,false); assert.equal(packet.gates.EXECUTION_AUTHORIZATION,false); assert.equal(packet.PROVIDER_REQUEST_PREVIEW.payload,null);
  const report={...packet,documentary_diagnostic:shot==='q31'?{human_status:human.status,wing_decision:human.human_wing_decision,actor:null,date:null,missing_metadata_does_not_withdraw_existing_approval:true}:forensic.analysis[shot],
    diagnostic_provenance:'LUMI_q32_q33_REPAIR_PLAN.json / LUMI_SERIES_V2_QUALITY_BUDGET_REVIEW.json',
    visual_recertification:false,original_videos_not_played_this_run:true,original_approvals_modified:false,
    media_scope:'DOCUMENTARY_BINDING_ONLY_ORIGINAL_BYTES_NOT_MATERIALIZED_IN_THIS_RUN',
    pending_source_correction:shot==='q33'?'Resolve documented posterior source defect before proposing animation; no repair authorized.':null};
  await writeFile(join(output,`${shot}_documentary_packet.json`),JSON.stringify(report,null,2)+'\n');
  documentary.push({shot,status:packet.status,source_ready:false,provider_prompt:packet.PROVIDER_PROMPT,diagnostic:report.documentary_diagnostic,visual_recertification:false});
}
assert.deepEqual(before,{plan:sha256(await readFile(planPath)),pack:sha256(await readFile(packPath))});
assert.deepEqual(globalThis.LUMI_OFFLINE_GUARD.attempts,[]);
const summary={status:'IMPLEMENTED_WITH_BLOCKERS',entrypoint:'runLumiV2Step',integration_tested:'LOCAL_OFFLINE_BRANCH_OF_CANONICAL_ENTRY',
  examples,documentary,protected_plan_hashes:before,plan_and_pack_unchanged:true,
  provider_calls:0,outbound_attempts:0,new_generation_cost:0,new_media:0,tts:0,master:'NOT_CREATED',production_activated:false,episode_resumed:false,
  execution_authorization:false,remote_preflight_executed:false,live_database_read:false,live_checkpoint_written:false,
  blockers:['Real source/golden original bytes and current action-specific reviews not bound locally.','q33 documented source defect; q32 documented temporal defect.','q31 warning metadata lacks exact reviewer/date in recovered report; approval preserved, never generalized.',
    'Official prompt length and detailed media constraints remain unverified.','Direction review, budget authorization and execution authorization absent.','Sequence visual/neighbor review incomplete.'],
  validation_limits:['Synthetic reviewed examples are not production approvals.','No new visual certification.','No remote integration/deploy or provider validation.']};
await writeFile(join(output,'DRY_RUN_REPORT.json'),JSON.stringify(summary,null,2)+'\n');
console.log(JSON.stringify({status:summary.status,examples:examples.length,documentary_packets:documentary.length,provider_calls:0,outbound_attempts:0,output}));
