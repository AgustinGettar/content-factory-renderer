import '../scripts/director-offline-guard.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {evaluateTopology,TOPOLOGY} from '../lib/cinematic-director-v1/topology.js';
import {assessActing} from '../lib/cinematic-director-v1/acting-presets.js';
import {validateControlledQ32Package,validateMinimumQ32Envelope,validateCapabilities} from '../lib/cinematic-director-v1/director.js';
import {sha256,stableStringify} from '../lib/cinematic-director-v1/PROMPT_COMPILER_V3.mjs';
const root=new URL('../docs/cinematic-director-v1/',import.meta.url);
const read=async p=>JSON.parse(await readFile(new URL(p,root)));
const binding=await read('bindings/q32_ORIGINAL_MEDIA_BINDING_V1.json');
const observations=await read('closure-v3/q32_BOUND_QA_OBSERVATIONS_R2.json');
const pkg=await read('closure-v3/replay/Q32_CONTROLLED_REPAIR_DIRECTION_PACKAGE_V1.json');
const envelope=await read('closure-v3/replay/Q32_MINIMUM_REPRODUCIBLE_ENVELOPE_V1.json');
const gate=()=>evaluateTopology({stage:'SOURCE_PREFLIGHT',sha256:binding.source.sha256,review:observations.source});
const hash=p=>{delete p.Q32_REPAIR_PACKAGE_HASH;p.Q32_REPAIR_PACKAGE_HASH=sha256(stableStringify(p));return p;};
test('two wing assemblies with four overlapping contours pass; lobe count is independent',()=>{
  const x=gate();assert.equal(x.status,'PASS');assert.equal(x.WING_ASSEMBLY_COUNT,2);assert.equal(x.VISIBLE_CONTOUR_LOBE_COUNT,4);
  assert.ok(x.warnings.some(w=>w.includes('SOURCE_TOPOLOGY_PASS_WITH_WARNING')));
});
for(const category of ['INDEPENDENT_EXTRA_WING_ROOT','DETACHED_EXTRA_WING','SEPARATELY_ARTICULATED_EXTRA_WING'])test(category+' blocks despite q31 precedent',()=>{
  const s=structuredClone(observations.source);s.findings.push({category,certainty:'CONFIRMED',evidence_ids:['SYNTHETIC_OTHER_SHOT_ROOT']});
  s.episode='other_episode';s.shot='arbitrary_77';
  const x=evaluateTopology({stage:'SOURCE_PREFLIGHT',sha256:binding.source.sha256,review:s});
  assert.equal(x.status,'BLOCKED');assert.ok(x.blockers.includes('NO_INDEPENDENT_EXTRA_WING'));
});
test('a confirmed lobe label without independent structure remains review, not an extra wing',()=>{
  const s=structuredClone(observations.source);s.findings=[{category:'EXTRA_WING_LOBE',certainty:'CONFIRMED',evidence_ids:['SYNTHETIC_CONTOUR']}];
  const x=evaluateTopology({stage:'SOURCE_PREFLIGHT',sha256:s.sha256,review:s});assert.equal(x.status,'REVIEW_REQUIRED');assert.equal(x.blockers.length,0);
});
for(const q of ['q32','q33'])test(q+' source classification deterministic',async()=>{
  const o=await read('closure-v3/'+q+'_BOUND_QA_OBSERVATIONS_R2.json');
  const run=()=>evaluateTopology({stage:'SOURCE_PREFLIGHT',sha256:o.source.sha256,review:o.source});
  assert.deepEqual(run(),run());assert.equal(run().status,q==='q32'?'PASS':'BLOCKED');
  assert.equal(o.source_decision.source_reuse,q==='q32'?'YES':'NO');
});
test('minimum package accepts Pro by exact request endpoint without actual-mode echo',()=>{
  assert.equal(pkg.mode_provenance,'PRO_BY_REQUEST_ENDPOINT');assert.equal(validateControlledQ32Package(pkg,binding,gate()).status,'PASS');
});
test('Standard route or fallback evidence cannot masquerade as Pro',()=>{
  for(const change of [{endpoint:'kling-video/v3.0/std/image-to-video'},{fallback_evidence:true}]){
    const p=hash({...structuredClone(pkg),...change});
    assert.ok(validateControlledQ32Package(p,binding,gate()).errors.includes('PRO_ENDPOINT_PROVENANCE_REQUIRED'));
  }
});
test('unsupported field is rejected even if payload author recomputes the package hash',()=>{
  const p=structuredClone(pkg);p.provider_projection.fields.mask='fake-mask';hash(p);
  assert.ok(validateControlledQ32Package(p,binding,gate()).errors.includes('UNSUPPORTED_FIELD:mask'));
});
test('missing exact endpoint proof cannot pass a status-only assertion',()=>{
  const p=structuredClone(pkg);delete p.capability_validation.minimum_proof.sound_off_supported;hash(p);
  assert.ok(validateControlledQ32Package(p,binding,gate()).errors.includes('ENDPOINT_PROOF_MISSING:sound_off_supported'));
});
test('rehashed different target cannot reuse q32 direction approval',()=>{
  const p=structuredClone(pkg);p.plan.direction.principal_actions[0].target='flower_blue';hash(p);
  assert.ok(validateControlledQ32Package(p,binding,gate()).errors.includes('Q32_EDUCATIONAL_DIRECTION_MISMATCH'));
});
test('rehashed source rotation or absent quality parity cannot bypass controlled presentation',()=>{
  const p=structuredClone(pkg);p.allowed_motion.body_yaw_degrees=10;delete p.quality_profile.required_quality_parity;hash(p);
  const errors=validateControlledQ32Package(p,binding,gate()).errors;
  assert.ok(errors.includes('Q32_STRICT_SOURCE_ORIENTATION_REQUIRED'));assert.ok(errors.includes('Q31_QUALITY_PARITY_AND_PLAYBACK_REQUIRED'));
});
test('minimum reproducible envelope requires current hashes, source, identity and quote; no historical echo',()=>{
  // Synthetic quote, never a real cost claim.
  const e={...envelope,expected_cost_usd:0.5};assert.equal(validateMinimumQ32Envelope(e,pkg).status,'PASS');
  assert.ok(validateMinimumQ32Envelope(envelope,pkg).errors.includes('CURRENT_COST_QUOTE_REQUIRED'));
  assert.equal(validateMinimumQ32Envelope({...e,prompt_hash:'b'.repeat(64)},pkg).status,'BLOCKED');
  assert.equal(validateMinimumQ32Envelope({...e,source_sha256:'b'.repeat(64)},pkg).status,'BLOCKED');
});
test('current minimum evidence does not require undocumented universal limits; invalid fields still block',()=>{
  assert.deepEqual(validateCapabilities(pkg.provider_projection.fields,[]),[]);
  assert.ok(validateCapabilities({aspect_ratio:'9:16'},[]).includes('UNSUPPORTED_FIELD:aspect_ratio'));
});
test('PRESENT_OBJECT generic angle ceilings and stricter q32 source orientation are enforced',()=>{
  assert.equal(assessActing('PRESENT_OBJECT',pkg.allowed_motion).status,'COMPATIBLE');
  for(const change of [{body_yaw_degrees:16},{torso_rotation_degrees:9},{body_yaw:'ADDED_ROTATION'},{camera:'ORBIT_REVEAL'}])
    assert.equal(assessActing('PRESENT_OBJECT',{...pkg.allowed_motion,...change}).status,'SOURCE_ACTION_MISMATCH');
});
test('minimum package never waives native-speed review or authorizes a provider',()=>{
  assert.equal(pkg.readiness,false);assert.equal(pkg.execute,false);assert.equal(pkg.provider_projection.payload,null);
  assert.equal(pkg.temporal_qa_plan.full_1x_playback_required,true);
  assert.equal(TOPOLOGY.detection_contract.playback.includes('FULL_NATIVE_SPEED_REVIEW_REQUIRED'),true);
  assert.deepEqual(globalThis.LUMI_OFFLINE_GUARD.attempts,[]);
});
