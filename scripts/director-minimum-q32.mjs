import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {runLumiV2Step} from '../lib/lumi-series-v2-execution.js';
import {sha256,stableStringify} from '../lib/cinematic-director-v1/PROMPT_COMPILER_V3.mjs';
import {projectCinematicPrompt} from '../lib/cinematic-director-v1/projection.js';
import {PRESENT_OBJECT_SAFE_POLICY} from '../lib/cinematic-director-v1/acting-presets.js';
import {TOPOLOGY} from '../lib/cinematic-director-v1/topology.js';
import {validateMinimumQ32Envelope} from '../lib/cinematic-director-v1/director.js';
assert.equal(globalThis.LUMI_OFFLINE_GUARD?.active,true,'OFFLINE_GUARD_REQUIRED');
const mediaRoot=resolve(process.argv[2]),output=resolve(process.argv[3]);
const root=new URL('../docs/cinematic-director-v1/',import.meta.url);
const read=async path=>JSON.parse(await readFile(new URL(path,root)));
const save=async(name,obj)=>writeFile(join(output,name),JSON.stringify(obj,null,2)+'\n');
await mkdir(output,{recursive:true});
const bindings=Object.fromEntries(await Promise.all(['q31','q32','q33'].map(async q=>[q,await read('bindings/'+q+'_ORIGINAL_MEDIA_BINDING_V1.json')])));
const binding=bindings.q32;
const oldInput=await read('closure-v2/replay/q32_AUTHENTIC_DIRECTOR_INPUT_V1.json');
const direction=structuredClone(oldInput.direction);
direction.principal_actions[0].body_part='character_right_forearm';
direction.secondary_motion=['blink'];direction.camera={...direction.camera,type:'STATIC'};
direction.reason_es='Presentar una flor roja con mirada y antebrazo; conservar torso, alas, silueta y calidad del Golden q31-PRO2.';
const plan={contract:{shot_id:'q32',shot_type:'MEDIUM_TEACHING',DURATION:4},direction};
const prompt=projectCinematicPrompt(plan,'en');
const capability=await read('closure-v3/Q32_MINIMUM_ENDPOINT_EVIDENCE_V1.json');
const sourceReview=await read('closure-v3/q32_BOUND_QA_OBSERVATIONS_R2.json');
const allowed_motion={body_yaw:'PRESERVE_INITIAL',torso_rotation:'PRESERVE_INITIAL',shoulder_turn:'PRESERVE_INITIAL',
  arm_amplitude:'SMALL_FOREARM_WRIST',head_turn:'SMALL_SOURCE_SUPPORTED',end_silhouette:'PRESERVE_SOURCE',wing_motion:'STABLE',camera:'STATIC',
  body_yaw_degrees:0,torso_rotation_degrees:0};
const pkg={version:'Q32_CONTROLLED_REPAIR_DIRECTION_PACKAGE_V1',shot:'q32',episode:binding.episode,
  status:'FINAL_REVIEW_PACKAGE_NOT_AUTHORIZED',provider:'higgsfield_api',endpoint:binding.endpoint,
  mode_provenance:'PRO_BY_REQUEST_ENDPOINT',fallback_evidence:false,
  source_reuse:'YES',source_warning:'SOURCE_TOPOLOGY_PASS_WITH_WARNING',source:binding.source,
  source_decision:sourceReview.source_decision,
  duration:4,aspect_ratio:'9:16',sound:'off',count:1,
  quality_profile:{id:'LUMI_VIDEO_QUALITY_PROFILE_V2',golden_positive_reference:{artifact_id:'q31-PRO2',sha256:bindings.q31.video.sha256,
    role:'QA_ONLY',human_approval:'PRESERVED',performance:'GREETING_ONLY',domains:['realism','identity','materials','natural_1x_movement','cartoon_drift']},
    required_quality_parity:['PASS','PASS_WITH_MINOR_WARNING']},
  topology_lock:TOPOLOGY,acting_preset:'PRESENT_OBJECT',presentation_policy:PRESENT_OBJECT_SAFE_POLICY,allowed_motion,
  forbidden_motion:['BACK_FACING','LARGE_TORSO_TWIST','FULL_BODY_ROTATION','LARGE_WING_FLUTTER','ORBIT_CAMERA','REAR_REVEAL','POSTERIOR_BODY_MUTATION','STRIPED_ABDOMEN','REAR_BULB','TAIL','STINGER','EXTRA_TORSO'],
  camera_contract:'STATIC; preserve framing, flower, wings, feet and caption space',
  end_state_contract:'Same canonical front/source silhouette; gesture settles naturally, one unchanged red flower fully legible; no freeze',
  plan,prompt:{...prompt,sha256:sha256(prompt.text)},
  provider_projection:{fields:{prompt:prompt.text,duration:4,sound:'off',cfg_scale:0.5,multi_shots:false},
    image_url:{artifact_id:binding.source.artifact_id,sha256:binding.source.sha256,role:'START_FRAME',transport:'RESOLVE_SAME_BYTES_ONLY_AFTER_AUTHORIZATION'},
    field_classifications:{prompt:'SUPPORTED_PROVIDER_FIELD',image_url:'SUPPORTED_PROVIDER_FIELD',duration:'SUPPORTED_PROVIDER_FIELD',sound:'SUPPORTED_PROVIDER_FIELD',cfg_scale:'SUPPORTED_PROVIDER_FIELD',multi_shots:'SUPPORTED_PROVIDER_FIELD',
      aspect_ratio:'LOCALLY_CONSUMED_DIRECTION',count:'LOCALLY_CONSUMED_DIRECTION',acting_preset:'LOCALLY_CONSUMED_DIRECTION',topology_lock:'LOCALLY_CONSUMED_DIRECTION',
      negative_prompt:'OMITTED_NOT_REQUIRED',elements:'OMITTED_NOT_REQUIRED',last_image_url:'OMITTED_NOT_REQUIRED',multi_prompt:'OMITTED_NOT_REQUIRED',mask:'BLOCKED_UNSUPPORTED'},
    UNKNOWN_AND_EMITTED:0,payload:null,executable:false,transmitted:false},
  capability_validation:capability,
  temporal_qa_plan:{source_gate:'FINAL_YES_WITH_SCOPED_CONTOUR_WARNING',technical:['decode','black_frames=0','freeze_defects=0'],
    full_1x_playback_required:true,coverage:['first_frame','all_frames_at_native_timestamps','worst_silhouette','end_frame'],
    compare_original_mutation_windows:{first_suspicious_s:0.8333333333333334,first_unambiguous_s:3.125,worst_s:3.3333333333333335,last_s:4},
    separate_source_and_video:true,inspect_correlations:['body_yaw','torso_rotation','wing_motion','static_camera','arm_occlusion'],
    reject:['posterior_body_mutation','striped_abdomen','rear_bulb','independent_extra_wing','object_count_color_shape_change'],
    quality_parity_with_q31_pro2:['PASS','PASS_WITH_MINOR_WARNING'],human_review_required:true,automatic_retry:false},
  attempt_identity:'q32-DIRECTOR-CONTROLLED-R1',expected_cost_usd:null,cost_status:'DEFERRED_UNTIL_ALL_READINESS_GATES_PASS',
  historical_fields_policy:'Unavailable historical fields remain unavailable; this is a new current direction, not an exact historical payload.',
  readiness:false,readiness_dependencies:['CI_GREEN_FINAL_TREE','FULL_PLAYBACK_REVIEW','STAGING_LIVE','CANONICAL_STAGING_DRY_RUN','CURRENT_COST_QUOTE'],
  execute:false,provider_calls:0,retries:0,variants:0,resubmits:0};
pkg.Q32_REPAIR_PACKAGE_HASH=sha256(stableStringify(pkg));
await save('Q32_CONTROLLED_REPAIR_DIRECTION_PACKAGE_V1.json',pkg);
const envelope={version:'Q32_MINIMUM_REPRODUCIBLE_ENVELOPE_V1',provider:pkg.provider,endpoint:pkg.endpoint,mode_provenance:pkg.mode_provenance,
  source_artifact_id:pkg.source.artifact_id,source_sha256:pkg.source.sha256,duration:4,aspect_ratio:'9:16',sound:'off',count:1,
  prompt_hash:pkg.prompt.sha256,Direction_Package_hash:pkg.Q32_REPAIR_PACKAGE_HASH,attempt_identity:pkg.attempt_identity,expected_cost_usd:null,
  UNAVAILABLE_NONCRITICAL_FIELDS:capability.UNAVAILABLE_NONCRITICAL_FIELDS,
  current_cost_status:pkg.cost_status,historical_submission_reconstructed:false};
envelope.validation=validateMinimumQ32Envelope(envelope,pkg);
await save('Q32_MINIMUM_REPRODUCIBLE_ENVELOPE_V1.json',envelope);
const env={LUMI_CINEMATIC_DIRECTOR_V1:'true',LUMI_RUNTIME_ENV:'local_offline',LUMI_PIPELINE_VERSION:'v1_1_2'};
const results=[];
for(const q of ['q31','q32','q33']){
  const b=bindings[q],observations=await read('closure-v3/'+q+'_BOUND_QA_OBSERVATIONS_R2.json');
  const input=await read('closure-v2/replay/'+q+'_AUTHENTIC_DIRECTOR_INPUT_V1.json');
  input.media=input.media.map(m=>({...m,path:join(mediaRoot,m.role==='source'?b.source.local_filename:bindings.q31.video.local_filename)}));
  const review={input,outputDirectory:join(output,'decisions'),historicalReplay:{binding:b,observations,mediaRoot},...(q==='q32'?{minimumRepairPackage:pkg}:{})};
  const packet=await runLumiV2Step({env,directorReview:review});
  const repeat=await runLumiV2Step({env,directorReview:review});
  assert.equal(stableStringify(packet.historical_replay),stableStringify(repeat.historical_replay));
  assert.equal(packet.gates.EXECUTION_AUTHORIZATION,false);assert.equal(packet.PROVIDER_REQUEST_PREVIEW.payload,null);
  if(q==='q32'){assert.equal(packet.current_controlled_repair.status,'PASS');assert.equal(packet.historical_replay.source_gate.status,'PASS');}
  const expected={q31:'ACCEPT_COMPATIBLE_WITH_HUMAN_GOLDEN',q32:'CONTROLLED_VIDEO_REPAIR_READY',q33:'SOURCE_REGEN_AND_VIDEO_REPAIR_REQUIRED'}[q];
  assert.equal(packet.historical_replay.repair_outcome,expected);
  await save(q+'_CANONICAL_MINIMUM_REPLAY.json',packet);
  results.push({shot:q,outcome:packet.historical_replay.repair_outcome,source_gate:packet.historical_replay.source_gate,
    repair:packet.historical_replay.minimum_future_repair,current_controlled_repair:packet.current_controlled_repair??null,
    binding_fingerprint:b.fingerprint,replay_sha256:sha256(stableStringify(packet.historical_replay)),
    historical_compiler_audit:'Preserved incomplete historical V2 contract; not a readiness requirement for this current minimum package.'});
}
assert.deepEqual(globalThis.LUMI_OFFLINE_GUARD.attempts,[]);
const report={version:'CANONICAL_MINIMUM_Q32_LOCAL_REPLAY_V1',entrypoint:'runLumiV2Step → reviewAtCanonicalBoundary',
  results,Q32_REPAIR_PACKAGE_HASH:pkg.Q32_REPAIR_PACKAGE_HASH,provider_calls:0,outgoing_connections:0,
  assertions:'PASS',staging_replay:'NOT_RUN',full_native_speed_review:'NOT_PERFORMED',overall_readiness:false};
await save('CANONICAL_MINIMUM_Q32_LOCAL_REPLAY_V1.json',report);
console.log(JSON.stringify({assertions:'PASS',results:results.map(r=>({shot:r.shot,outcome:r.outcome})),Q32_REPAIR_PACKAGE_HASH:pkg.Q32_REPAIR_PACKAGE_HASH,provider_calls:0}));
