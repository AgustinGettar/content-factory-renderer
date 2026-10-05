import test from 'node:test';
import assert from 'node:assert/strict';
import approval from '../docs/cinematic-director-v1/human-review-20261006/Q34_HUMAN_REVIEW_20261006.json' with {type:'json'};
import {isApprovedQ34Row,prepareApprovedVisualResume,applyQ34HumanReviewAndResume} from '../lib/cinematic-director-v1/q34-human-review.js';
import {previousVideoGate} from '../lib/lumi-series-v2-gates.js';
import {MemoryLumiRecoveryStore,LumiRecoveryIncidentManager} from '../lib/lumi-recovery-incident-manager-v1.js';
import {sha256,stableStringify} from '../lib/cinematic-director-v1/PROMPT_COMPILER_V3.mjs';
const episode='ep_lumi_flores_003';
const row=()=>({pilot_id:'lumi_tres_flores_colores_v1',scene_id:'q34-V2-PRO1',stage:'VIDEO',status:'SUCCEEDED',content_hash:approval.artifact_sha256,provider_request_id:approval.provider_request_id,storage_bucket:'original',storage_path:'original.mp4',result:{shot:'q34',golden_reference:false,temporal_qa:{classification:'GENERATIVE_FATAL',NO_BEE_ABDOMEN:'FAIL'},human_review_layers:{HUMAN_REVIEW_20261006:structuredClone(approval)}}});
test('q34 approval is exact artifact, exact pilot, independent from preserved fatal QA',()=>{
 const r=row(),before=structuredClone(r);assert.equal(isApprovedQ34Row(r),true);assert.doesNotThrow(()=>previousVideoGate(r));assert.deepEqual(r,before);
 for(const patch of [{scene_id:'q35-V2-PRO1'},{pilot_id:'other'},{stage:'IMAGE'},{status:'REQUESTED'},{content_hash:'wrong'},{provider_request_id:'wrong'}])assert.equal(isApprovedQ34Row({...r,...patch}),false);
 const changed=row();changed.result.human_review_layers.HUMAN_REVIEW_20261006.scope.episode_id='other';assert.equal(isApprovedQ34Row(changed),false);
 const golden=row();golden.result.golden_reference=true;assert.equal(isApprovedQ34Row(golden),false);
 const unsigned=row();delete unsigned.result.human_review_layers;assert.throws(()=>previousVideoGate(unsigned));
 const {record_sha256,...original}=approval;assert.equal(sha256(stableStringify(original)),record_sha256);
});
test('real Recovery Manager resumes once from q35 and preserves previous request IDs, incident reason and cost',async()=>{
 const store=new MemoryLumiRecoveryStore(),manager=new LumiRecoveryIncidentManager({store});
 const actions=['q31','q32','q33','q34','q37','q39'].flatMap(scene=>[{key:'video:'+scene,stage:'VIDEO',scene_id:scene},{key:'temporal_qa:'+scene,stage:'TEMPORAL_QA',scene_id:scene}]);
 await manager.startEpisode({episodeId:episode,actions,authorizedCeilingUsd:3.05});
 await manager.checkpoint(episode,d=>{d.current_cost_usd=1.163597;d.actions[0].provider_request_id='ORIGINAL_IMMUTABLE_ID';});
 const incident=await manager.pause({episodeId:episode,sceneId:'q34',stage:'TEMPORAL_QA',errorClass:'QA_BLOCKER',reason:'PRESERVED GENERATIVE_FATAL',firstPendingAction:'video:q31',safeResumeAvailable:false});
 const rows=['q31-PRO2','q32-V2-PRO1','q33-V2-PRO1'].map((scene_id,i)=>({...row(),scene_id,content_hash:'existing'+i,result:{shot:'q3'+(i+1)}}));rows.push(row());
 const result=await prepareApprovedVisualResume({manager,rows});assert.equal(result.status,'RUNNING');assert.equal(result.first_pending_action,'video:q37');assert.equal(result.provider_calls,0);assert.equal(result.incident_resolution,'RESOLVED_BY_EXPLICIT_HUMAN_CREATIVE_REVIEW');
 const cp=await store.getEpisode(episode),closed=await store.getIncident(incident.incident_id);assert.equal(closed.reason,'PRESERVED GENERATIVE_FATAL');assert.equal(closed.status,'RESOLVED');assert.equal(cp.current_cost_usd,1.163597);assert.equal(cp.actions[0].provider_request_id,'ORIGINAL_IMMUTABLE_ID');assert.equal(cp.metadata.resume_count,1);assert.equal(cp.runner_enabled,false);
 assert.equal((await prepareApprovedVisualResume({manager,rows})).cache_hit,true);assert.equal((await store.getEpisode(episode)).metadata.resume_count,1);
});
test('production, positive provider windows and invalid commands are rejected before database access',async()=>{
 for(const env of [{LUMI_RUNTIME_ENV:'production',PROVIDER_CALLS_ALLOWED:'0',LUMI_PIPELINE_VERSION:'legacy'},{LUMI_RUNTIME_ENV:'staging',PROVIDER_CALLS_ALLOWED:'1',LUMI_PIPELINE_VERSION:'legacy'}])await assert.rejects(applyQ34HumanReviewAndResume({env}),/STAGING_ZERO_PROVIDER/);
 await assert.rejects(applyQ34HumanReviewAndResume({env:{LUMI_RUNTIME_ENV:'staging',PROVIDER_CALLS_ALLOWED:'0',LUMI_PIPELINE_VERSION:'legacy'},operation:'EMIT'}),/OPERATION_INVALID/);
});
