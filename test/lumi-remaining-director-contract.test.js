import test from 'node:test';
import assert from 'node:assert/strict';
import {compileRemainingRequest} from '../lib/cinematic-director-v1/episode-step.js';
const sourceSha='5dc31254ad26aa1b606735188ac30d2f4d486bc389f19bc8a50816e1e1b3da33';
const qa={sha256:sourceSha,classification:'PASS',BODY_LOCK_VERSION:'LUMI_BODY_ANATOMY_LOCK_V1',IDENTITY:'PASS',REALISM:'PASS',ANATOMY:'PASS',EDUCATIONAL_SEMANTICS:'PASS',COLOR:'PASS',VIDEO_SOURCE_READINESS:'PASS',CARTOON_DRIFT:'MINIMAL',NO_BEE_ABDOMEN:'PASS',NO_STRIPED_POSTERIOR_BODY:'PASS',NO_STINGER:'PASS',NO_EXTRA_TORSO:'PASS',NO_REAR_BULB:'PASS'};
const input={duration:5,sound:'off',multi_shots:false,cfg_scale:0.5,prompt:'not provider authority',image_url:'offline://source'};
test('question contract preserves real-time neutral response window and complete Director binding',()=>{
 const {packet,providerInput}=compileRemainingRequest({shot:'q35',stage:'VIDEO',input,sourceSha,sourceQa:qa});
 assert.equal(packet.temporal_qa_plan.pause_seconds,2.5);assert.equal(packet.temporal_qa_plan.no_answer_cue,true);
 assert.equal(packet.source_contract.sha256,sourceSha);assert.equal(packet.source_contract.canonical_wing_assemblies,2);assert.match(packet.end_state_contract,/no answer cue/);
 assert.equal(packet.camera_contract,'STATIC');assert.equal(providerInput.duration,5);assert.equal(providerInput.sound,'off');assert.notEqual(providerInput.prompt,input.prompt);
 assert.ok(packet.forbidden_motion.includes('BODY_TURN'));assert.equal(packet.count,1);assert.equal(packet.retries,0);
});
test('closing uses one farewell with natural settle and forbids source or audio mismatches',()=>{
 const {packet}=compileRemainingRequest({shot:'q36',stage:'VIDEO',input,sourceSha,sourceQa:qa});assert.match(packet.end_state_contract,/one small farewell/);assert.equal(packet.temporal_qa_plan.pause_seconds,0);
 for(const patch of [{duration:4},{sound:'on'},{multi_shots:true}])assert.throws(()=>compileRemainingRequest({shot:'q36',stage:'VIDEO',input:{...input,...patch},sourceSha,sourceQa:qa}));
 assert.throws(()=>compileRemainingRequest({shot:'q36',stage:'VIDEO',input,sourceSha,sourceQa:{...qa,sha256:'different'}}));
 assert.throws(()=>compileRemainingRequest({shot:'q36',stage:'VIDEO',input,sourceSha,sourceQa:{...qa,NO_BEE_ABDOMEN:'FAIL'}}));
});
