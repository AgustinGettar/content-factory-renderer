import '../scripts/director-offline-guard.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {compileRemainingRequest} from '../lib/cinematic-director-v1/episode-step.js';
import {budgetGate,previousVideoGate,BODY_QA_FIELDS} from '../lib/lumi-series-v2-gates.js';
const sha='a'.repeat(64),qa={classification:'PASS',sha256:sha,IDENTITY:'PASS',REALISM:'PASS',ANATOMY:'PASS',EDUCATIONAL_SEMANTICS:'PASS',COLOR:'PASS',VIDEO_SOURCE_READINESS:'PASS',CARTOON_DRIFT:'MINIMAL',BODY_LOCK_VERSION:'LUMI_BODY_ANATOMY_LOCK_V1',...Object.fromEntries(BODY_QA_FIELDS.map(k=>[k,'PASS']))};
for(const shot of ['q34','q35','q36'])test(shot+' compiled Pro payload preserves safe motion, topology and exact source',()=>{
 const x=compileRemainingRequest({shot,stage:'VIDEO',input:{prompt:'LEGACY_PROMPT_MUST_NOT_EMIT',duration:shot==='q34'?4:5,sound:'off',multi_shots:false,cfg_scale:0.5,image_url:'https://example.invalid/source'},sourceSha:sha,sourceQa:qa});
 assert.ok(!x.providerInput.prompt.includes('LEGACY_PROMPT_MUST_NOT_EMIT'));assert.equal(x.packet.camera_contract,'STATIC');
 assert.equal(x.packet.provider_projection.UNKNOWN_AND_EMITTED,0);assert.ok(x.packet.sha256);assert.equal(x.packet.topology_constraints.version,'LUMI_CHARACTER_TOPOLOGY_LOCK_V2');
 if(shot==='q35')assert.match(x.providerInput.prompt,/final 2.5-second response window/);
});
for(const shot of ['q31','q32','q33'])test(shot+' cannot be emitted by current completion compiler',()=>assert.throws(()=>compileRemainingRequest({shot,stage:'IMAGE',input:{},sourceSha:sha}),/SCOPE_REQUIRED/));
test('unknown anatomy cannot reach Pro emission',()=>assert.throws(()=>compileRemainingRequest({shot:'q34',stage:'VIDEO',input:{duration:4,sound:'off',multi_shots:false,cfg_scale:0.5},sourceSha:sha,sourceQa:{...qa,NO_REAR_BULB:'UNKNOWN'}}),/body_anatomy_gate/));
test('new budget measures only spend additional to verified checkpoint, preserving historical budget',()=>{
 const b={current_episode_completion:{authorization:'USER_20261005_EPISODE_COMPLETION',episode_id:'ep_lumi_flores_003',additional_visual_ceiling_usd:3,previous_checkpoint_spend_usd:1.216}};
 assert.doesNotThrow(()=>budgetGate(b,3.241));assert.throws(()=>budgetGate(b,4.217),/exceeds_3/);
});
test('unbound human approval cannot waive previous video QA',()=>assert.throws(()=>previousVideoGate({content_hash:sha,result:{human_review_layers:{HUMAN_REVIEW_20261005:{shot:'q33',record_sha256:sha}}}}),/previous_video_quality_gate/));
