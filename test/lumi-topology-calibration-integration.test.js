import '../scripts/director-offline-guard.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {evaluateCalibration,runTopologyCalibration} from '../lib/cinematic-director-v1/topology-calibration.js';
import {isApprovedArtifactRow,completeHumanReviewedAction,REGISTERED_HUMAN_REVIEWS} from '../lib/cinematic-director-v1/artifact-human-review.js';
import {previousVideoGate,sourceGate} from '../lib/lumi-series-v2-gates.js';
import {MemoryLumiRecoveryStore,LumiRecoveryIncidentManager} from '../lib/lumi-recovery-incident-manager-v1.js';
import {invalidAnatomy,validReview,fixtureSha} from './fixtures/temporal-topology-v2.js';
const record=REGISTERED_HUMAN_REVIEWS[0];
const row=()=>({pilot_id:'lumi_tres_flores_colores_v1',scene_id:record.attempt,stage:'VIDEO',status:'SUCCEEDED',content_hash:record.artifact_sha256,provider_request_id:record.provider_request_id,estimated_cost_usd:0.476,result:{shot:'q35',assembly_eligible:true,golden_anatomy_reference:false,temporal_qa:{classification:'GENERATIVE_FATAL',NO_BEE_ABDOMEN:'FAIL'},human_review_layers:{[record.record_sha256]:structuredClone(record)}}});
test('authentic calibration preserves uncertainty independently of human positive labels',()=>{
 const r=evaluateCalibration();assert.equal(r.status,'PASS');assert.equal(r.FALSE_FATALS_ON_HUMAN_APPROVED_SET,0);assert.equal(r.TRUE_FATAL_FIXTURES_BLOCKED,'100_PERCENT');assert.equal(r.AMBIGUOUS_FINDINGS_PRESERVED,true);
 assert.equal(r.positives[0].severity,'PASS');assert.ok(r.positives.slice(1).every(p=>p.severity==='REVIEW_REQUIRED'&&p.human_override_used===false));assert.ok(r.negatives.every(n=>n.severity==='BLOCKER'));
});
test('exact q35 provenance permits assembly without editing historical automated finding',()=>{
 const r=row(),before=structuredClone(r);assert.equal(isApprovedArtifactRow(r),true);assert.doesNotThrow(()=>previousVideoGate(r));assert.deepEqual(r,before);
 for(const patch of [{content_hash:fixtureSha},{provider_request_id:'wrong'},{stage:'IMAGE'},{pilot_id:'wrong'},{status:'CLAIMED'}])assert.equal(isApprovedArtifactRow({...r,...patch}),false);
 const forged=row();forged.result.human_review_layers[record.record_sha256].scope.episode_id='other';assert.equal(isApprovedArtifactRow(forged),false);
});
test('real incident resume preserves reason, request IDs, costs; no provider, duplicate resume or runner',async()=>{
 const store=new MemoryLumiRecoveryStore(),manager=new LumiRecoveryIncidentManager({store}),episodeId=record.episode_id;
 await manager.startEpisode({episodeId,actions:[{key:'temporal_qa:q37',stage:'TEMPORAL_QA',scene_id:'q37'},{key:'video:q39',stage:'VIDEO',scene_id:'q39'}],metadata:{q34_human_resume:{canonical_aliases:{q35:'q37',q36:'q39'}}}});
 await manager.checkpoint(episodeId,d=>{d.current_cost_usd=4.5618;});
 const incident=await manager.pause({episodeId,sceneId:record.attempt,stage:'TEMPORAL_QA',providerRequestId:record.provider_request_id,errorClass:'QA_BLOCKER',reason:'ORIGINAL_FATAL_FINDING',firstPendingAction:'temporal_qa:q37',safeResumeAvailable:false});
 const result=await completeHumanReviewedAction({manager,row:row(),record});assert.equal(result.first_pending_action,'video:q39');assert.equal(result.provider_calls,0);
 const state=await store.getEpisode(episodeId),closed=await store.getIncident(incident.incident_id);assert.equal(state.current_cost_usd,4.5618);assert.equal(state.runner_enabled,false);assert.equal(state.autorun,false);assert.equal(closed.reason,'ORIGINAL_FATAL_FINDING');assert.equal(closed.provider_request_id,record.provider_request_id);assert.equal(closed.status,'RESOLVED');
 assert.equal((await completeHumanReviewedAction({manager,row:row(),record})).cache_hit,true);assert.equal((await store.getEpisode(episodeId)).metadata.resume_count,1);
});
test('calibrated gate accepts no defect, rejects mutations and uncertain contour',()=>{
 const r={content_hash:fixtureSha,result:{canonical_source_sha256:'b'.repeat(64),source_sha256:'b'.repeat(64),technical_qa:{sha256:fixtureSha,DECODE:'PASS',BLACK_FRAMES:0,FREEZE_DEFECTS:0},temporal_qa:{sha256:fixtureSha,TEMPORAL_TOPOLOGY_VERSION:'TEMPORAL_TOPOLOGY_QA_V2',temporal_topology_review:validReview(),TECHNICAL_QA:'PASS',BLACK_FRAMES:0,FREEZE_DEFECTS:0,IDENTITY:'PASS',REALISM:'PASS',MOTION:'PASS',EDUCATIONAL_SEMANTICS:'PASS'}}};
 assert.doesNotThrow(()=>previousVideoGate(r));r.result.temporal_qa.temporal_topology_review=invalidAnatomy();assert.throws(()=>previousVideoGate(r),/BLOCKER/);r.result.temporal_qa.temporal_topology_review.findings[0].signals.INDEPENDENT_ANATOMICAL_CONNECTION.observed=false;assert.throws(()=>previousVideoGate(r),/REVIEW_REQUIRED/);
 assert.throws(()=>sourceGate({sha256:fixtureSha},{content_hash:fixtureSha,result:{visual_qa:{...r.result.temporal_qa,classification:'PASS'}}}));
});
test('production and positive provider window reject calibration before client access',async()=>{
 for(const env of [{LUMI_RUNTIME_ENV:'production',PROVIDER_CALLS_ALLOWED:'0',LUMI_PIPELINE_VERSION:'legacy'},{LUMI_RUNTIME_ENV:'staging',PROVIDER_CALLS_ALLOWED:'1',LUMI_PIPELINE_VERSION:'legacy'}])await assert.rejects(runTopologyCalibration({env}),/STAGING_ZERO_PROVIDER/);
});
test('directed boundary demands stored calibrated replay and new temporal QA',async()=>{
 const source=await readFile(new URL('../lib/cinematic-director-v1/episode-step.js',import.meta.url),'utf8');assert.match(source,/DIRECTOR_TOPOLOGY_CALIBRATION_NOT_READY/);assert.match(source,/DIRECTOR_CALIBRATED_TEMPORAL_QA_REQUIRED/);
});
