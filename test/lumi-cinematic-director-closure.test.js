import '../scripts/director-offline-guard.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { evaluateTopology,TOPOLOGY } from '../lib/cinematic-director-v1/topology.js';
import { assessActing,PRESENT_OBJECT_SAFE_POLICY } from '../lib/cinematic-director-v1/acting-presets.js';
import { classifyProviderFields,compileDirectorPacket,validateCapabilities } from '../lib/cinematic-director-v1/director.js';
import { makeFixture } from './fixtures/director-v1.js';
const sha='c'.repeat(64);
const review=()=>({version:TOPOLOGY.version,sha256:sha,evidence_ids:['SYNTHETIC_ONLY'],
 counts:{head:1,rounded_torso:1,arms:2,legs:2,antennae:2,wings:2},
 checks:Object.fromEntries(TOPOLOGY.hard.map(x=>[x,'PASS'])),findings:[],
 wing_attachment:'UPPER_BACK_ONLY',lower_torso_silhouette:'DEFINED_BY_OVERALLS',
 coverage:{source_frame:true,first_frame:true,sampled_temporal_frames:true,worst_silhouette_frames:true,end_frame:true,full_native_speed_playback:true}});
const motion=()=>({body_yaw:'PRESERVE_INITIAL',torso_rotation:'PRESERVE_INITIAL',shoulder_turn:'PRESERVE_INITIAL',
 arm_amplitude:'SMALL_FOREARM_WRIST',head_turn:'SMALL_SOURCE_SUPPORTED',end_silhouette:'PRESERVE_SOURCE',wing_motion:'STABLE',camera:'STATIC'});
for(const [episode,scene,object] of [['ep_numbers','new_square','green_square'],['ep_fruits','basket_42','pear'],['ep_shapes','triangle_88','triangle']]){
 for(const category of ['POSTERIOR_BODY_MUTATION','STRIPED_ABDOMEN','EXTRA_WING_LOBE'])test(`${episode}/${scene}/${object}: ${category} rejected independent of scene`,()=>{
  const x=review();Object.assign(x,{episode,scene,educational_object:object});x.findings=[{category,certainty:'CONFIRMED',evidence_ids:['SYNTHETIC_DEFECT']}];
  assert.equal(evaluateTopology({stage:'SOURCE_PREFLIGHT',sha256:sha,review:x}).status,'BLOCKED');
 });
}
for(const key of TOPOLOGY.detection_contract.video)test('missing temporal coverage: '+key,()=>{
 const x=review();delete x.coverage[key];const y=evaluateTopology({stage:'SAMPLED_FRAME_TEMPORAL_QA',sha256:sha,review:x});
 assert.equal(y.status,'REVIEW_REQUIRED');assert.ok(y.pending.includes('COVERAGE_REQUIRED:'+key));
});
test('all frames and decode cannot replace native-speed playback',()=>{
 const x=review();x.coverage.full_native_speed_playback=false;x.all_frames_decoded=true;
 assert.ok(evaluateTopology({stage:'SAMPLED_FRAME_TEMPORAL_QA',sha256:sha,review:x}).pending.includes('FULL_NATIVE_SPEED_REVIEW_REQUIRED'));
});
test('presentation normative zeros are not measured angles or a guarantee',()=>{
 assert.equal(PRESENT_OBJECT_SAFE_POLICY.body_yaw_added_degrees,0);assert.equal(PRESENT_OBJECT_SAFE_POLICY.guarantee,false);
 assert.equal(assessActing('PRESENT_OBJECT',motion()).status,'COMPATIBLE');
});
for(const key of ['body_yaw','torso_rotation','shoulder_turn','arm_amplitude','head_turn','end_silhouette'])test('unsafe presentation '+key+' is rejected with mitigation',()=>{
 const x=assessActing('PRESENT_OBJECT',{...motion(),[key]:'ADDED_ROTATION'});
 assert.equal(x.status,'SOURCE_ACTION_MISMATCH');assert.match(x.mitigation,/Preserve source torso/);
});
for(const params of [{mask:'bad'},{image_references:['qa']},{duration:2},{aspect_ratio:'9:16'},{mode:'pro'},{multi_shot:true},{elements:['unverified']},{duration:4.5}])test('capability audit keeps unsupported/invalid request visible: '+JSON.stringify(params),()=>{
 const x=classifyProviderFields(params);assert.equal(Object.values(x)[0].classification,'BLOCKED_UNSUPPORTED');assert.equal(Object.values(x)[0].emitted,false);
 assert.ok(validateCapabilities(params,[]).some(x=>x.startsWith('UNSUPPORTED_FIELD')||x.startsWith('INVALID_PARAMETER')));
});
test('GREETING compiles in existing chain without turning it into farewell or gaze-only acting',async()=>{
 const f=await makeFixture({grammar:'GREETING'});const x=await compileDirectorPacket(f.input,f.options);
 assert.equal(x.gates.DIRECTION_COHERENT,true);assert.match(x.PROVIDER_PROMPT.text,/greets the viewer/);
 assert.equal(x.gates.EXECUTION_AUTHORIZATION,false);assert.equal(x.PROVIDER_REQUEST_PREVIEW.payload,null);
});
test('authentic documentary conclusions do not fake source approval or native playback',async()=>{
 const read=async q=>JSON.parse(await readFile(new URL('../docs/cinematic-director-v1/closure-v2/'+q+'_BOUND_QA_OBSERVATIONS_R2.json',import.meta.url)));
 const [a,b,c]=await Promise.all(['q31','q32','q33'].map(read));
 assert.equal(a.source_decision.historical_clip,'HUMAN_APPROVED_PRESERVED');assert.equal(b.source_decision.posterior_body,'PASS');
 assert.equal(b.source_decision.topology_v2,'REVIEW_REQUIRED');assert.equal(c.source_decision.source_reuse,'NO');
 assert.equal(c.source_decision.SOURCE_STRIPED_ABDOMEN,'NOT_CONFIRMED');assert.equal(c.temporal_findings.classification,'TEMPORAL_STRIPED_ABDOMEN');
 for(const x of [a,b,c]){assert.equal(x.observation_provenance.inspected_video_frames.length,97);assert.equal(x.observation_provenance.full_native_speed_visual_playback,false);}
});
test('recovered estimator payload fingerprint is never presented as original prompt hash',async()=>{
 for(const q of ['q31','q32','q33']){const x=JSON.parse(await readFile(new URL('../docs/cinematic-director-v1/closure-v2/'+q+'_RECOVERED_REQUEST_ENVELOPE_V1.json',import.meta.url)));
 assert.equal(x.prompt_sha256,null);assert.equal(x.estimator_hash_is_prompt_hash,false);assert.equal(x.request_timestamp,null);assert.ok(x.UNAVAILABLE_FIELDS.prompt_and_hash);}
});
test('closure tests attempted zero outgoing/provider calls',()=>assert.deepEqual(globalThis.LUMI_OFFLINE_GUARD.attempts,[]));
