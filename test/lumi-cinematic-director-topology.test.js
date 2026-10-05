import '../scripts/director-offline-guard.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateTopology,TOPOLOGY } from '../lib/cinematic-director-v1/topology.js';
import { ACTING_PRESETS,assessActing } from '../lib/cinematic-director-v1/acting-presets.js';
import { compileDirectorPacket,validateCapabilities } from '../lib/cinematic-director-v1/director.js';
import { POLICY } from '../lib/cinematic-director-v1/profiles.js';
import { makeFixture } from './fixtures/director-v1.js';

const sha='a'.repeat(64);
const mockReview=()=>({version:TOPOLOGY.version,sha256:sha,evidence_ids:['SYNTHETIC_NOT_HUMAN_APPROVAL'],
  checks:Object.fromEntries(TOPOLOGY.hard.map(k=>[k,'PASS'])),counts:{head:1,rounded_torso:1,arms:2,legs:2,antennae:2,wings:2},
  wing_attachment:'UPPER_BACK_ONLY',lower_torso_silhouette:'DEFINED_BY_OVERALLS',findings:[]});
for(const stage of TOPOLOGY.stages)for(const category of ['POSTERIOR_BODY_MUTATION','STRIPED_ABDOMEN','EXTRA_BODY_SEGMENT','EXTRA_WING_LOBE','SILHOUETTE_DRIFT']){
  test(`synthetic different episode/shot: ${stage} rejects ${category}`,()=>{
    const review={...mockReview(),episode:'ep_other_synthetic_907',shot:'new_scene_z812'};
    review.findings=[{category,certainty:'CONFIRMED',evidence_ids:['SYNTHETIC_FRAME_19']}];
    assert.equal(evaluateTopology({stage,sha256:sha,review}).status,'BLOCKED');
  });
}
test('UNKNOWN and possible occlusion remain review, never a confirmed deformation',()=>{
  const review=mockReview();review.findings=[{category:'EXTRA_WING_LOBE',certainty:'POSSIBLE_OCCLUSION',evidence_ids:['SYNTHETIC_OCCLUSION']}];
  const result=evaluateTopology({stage:'SAMPLED_FRAME_TEMPORAL_QA',sha256:sha,review});
  assert.equal(result.status,'REVIEW_REQUIRED');assert.equal(result.confirmed.length,0);assert.equal(result.hypotheses.length,1);
});
test('wrong artifact SHA cannot supply topology evidence',()=>assert.equal(evaluateTopology({stage:'SOURCE_PREFLIGHT',sha256:'b'.repeat(64),review:mockReview()}).status,'REVIEW_REQUIRED'));
test('accepted historical warning cannot waive a different hard topology defect',()=>{
  const review=mockReview();review.human_warning={state:'APPROVED_WITH_WARNING',scope:'different_wing_contour'};review.checks.NO_REAR_BULB='FAIL';
  assert.equal(evaluateTopology({stage:'SOURCE_PREFLIGHT',sha256:sha,review}).status,'BLOCKED');
});
test('even complete typed QA PASS is not automated pixel certification',()=>{
  const x=evaluateTopology({stage:'SOURCE_PREFLIGHT',sha256:sha,review:mockReview()});assert.equal(x.status,'PASS');assert.equal(x.visual_certification,false);
});
test('all nine presets have explicit motion and end contracts without measured angles',()=>{
  assert.deepEqual(Object.keys(ACTING_PRESETS).sort(),['GREETING','PRESENT_OBJECT','POINT','LOOK_AT_OBJECT','LOOK_AT_VIEWER','ASK_QUESTION','WAIT_LISTEN','CELEBRATE','GENTLE_WAVE'].sort());
  for(const p of Object.values(ACTING_PRESETS))for(const k of ['primary_action','allowed_secondary_motion','maximum_body_yaw','maximum_torso_rotation','head_movement','eye_behavior','hand_arm_amplitude','wing_amplitude','camera_behavior','forbidden_movements','end_state_contract'])assert.ok(p[k],k);
  assert.ok(Object.values(ACTING_PRESETS).every(p=>p.numeric_angle_measurements===null));
});
test('static camera does not excuse body rotation',()=>{
  const x=assessActing('PRESENT_OBJECT',{body_yaw:'ADDED_ROTATION',torso_rotation:'ADDED_ROTATION',wing_motion:'STABLE',camera:'STATIC'});
  assert.equal(x.status,'SOURCE_ACTION_MISMATCH');assert.ok(x.blockers.includes('torso_rotation:SOURCE_ACTION_MISMATCH'));
});
test('unknown motion remains review; large wings and orbit are blocked',()=>{
  assert.equal(assessActing('GREETING',{}).status,'REVIEW_REQUIRED');
  const x=assessActing('POINT',{wing_motion:'LARGE',camera:'ORBIT_REVEAL'});assert.ok(x.blockers.includes('WING_AMPLITUDE_EXCEEDED'));assert.ok(x.blockers.includes('UNDOCUMENTED_REAR_REVEAL'));
});
test('mask, Elements and connector-specific fields fail closed at real endpoint',()=>{
  const errors=validateCapabilities({mask:'UNSUPPORTED',elements:['UNVERIFIED'],resolution:'1080p'},['mask']);
  for(const key of ['mask','elements','resolution'])assert.ok(errors.includes('UNSUPPORTED_FIELD:'+key));
  assert.ok(errors.includes('REQUIRED_CONTROL_UNSUPPORTED:mask'));
});
test('canonical storage path may differ from SHA-verified local transport',async()=>{
  const f=await makeFixture();const old=f.input.contract.SOURCE_ARTIFACT.path;
  f.input.contract.SOURCE_ARTIFACT.path='canonical-bucket/object/source.png';f.input.media[0].canonical_path=f.input.contract.SOURCE_ARTIFACT.path;
  const x=await compileDirectorPacket(f.input,f.options);assert.equal(x.gates.SOURCE_EVIDENCE_READY,true);assert.equal(f.input.media[0].path,old);
  f.input.media[0].canonical_path='wrong-object';const y=await compileDirectorPacket(f.input,f.options);assert.ok(y.blockers.some(x=>x.code==='SOURCE_PATH_MISMATCH'));
});
test('generic topology defect blocks compiler prompt before provider for renamed scene',async()=>{
  const f=await makeFixture();const review=mockReview();review.sha256=f.input.contract.SOURCE_ARTIFACT.sha256;review.findings=[{category:'STRIPED_ABDOMEN',certainty:'CONFIRMED',evidence_ids:['SYNTHETIC_OTHER_EPISODE']}];
  f.input.episode_id='ep_other_synthetic_907'; f.input.contract.shot_id='q812';
  const policy={...POLICY,episode_id:f.input.episode_id,durations:{q812:4},educational_objects:{q812:['flower_red']}};
  const x=await compileDirectorPacket(f.input,{...f.options,policy,topologyReview:review});
  assert.ok(!x.blockers.some(b=>b.code==='POLICY_CONFLICT')); 
  assert.equal(x.gates.SOURCE_EVIDENCE_READY,false);assert.equal(x.PROVIDER_PROMPT,null);assert.equal(x.PROVIDER_REQUEST_PREVIEW.payload,null);assert.equal(x.provider_calls,0);
});
test('zero network/provider attempts in topology, acting and binding tests',()=>assert.deepEqual(globalThis.LUMI_OFFLINE_GUARD.attempts,[]));
