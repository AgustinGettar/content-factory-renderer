import '../scripts/director-offline-guard.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {ASSEMBLY_ATTEMPTS,validateSixShotAssemblyProof,runEpisodeCompletionAudio} from '../lib/cinematic-director-v1/episode-completion-audio.js';
import {sha256,stableStringify} from '../lib/cinematic-director-v1/PROMPT_COMPILER_V3.mjs';
import {beginControlledEpisodeAction,waitControlledEpisodeActionForTest} from '../lib/cinematic-director-v1/controlled-episode-action.js';
function proof(){const p={version:'LUMI_SIX_SHOT_ASSEMBLY_PROOF_V1',episode_id:'ep_lumi_flores_003',status:'PASS',beats:9,provider_calls:0,shots:ASSEMBLY_ATTEMPTS.map(attempt=>({attempt,sha256:'a'.repeat(64),bytes_sha_verified:true,decode:'PASS',assembly_gate:'PASS',request_id:'fixture-request',path:'fixture.mp4'}))};p.sha256=sha256(stableStringify(p));return p;}
const resign=p=>{delete p.sha256;p.sha256=sha256(stableStringify(p));return p;};
test('six original attempts and nine beats required before audio; missing byte or QA evidence blocks',()=>{
 assert.equal(validateSixShotAssemblyProof(proof()),true);
 for(const change of [p=>p.shots.pop(),p=>p.beats=8,p=>p.shots[4].attempt='q35-retry',p=>p.shots[4].bytes_sha_verified=false,p=>p.shots[5].assembly_gate='REVIEW_REQUIRED',p=>p.shots[0].decode='FAIL',p=>p.provider_calls=1]){const p=proof();change(p);assert.throws(()=>validateSixShotAssemblyProof(resign(p)));}
 const p=proof();p.shots[0].sha256='b'.repeat(64);assert.throws(()=>validateSixShotAssemblyProof(p));
});
test('audio cannot run in production, enabled global providers, autorun, or nonlegacy default',async()=>{
 const env={LUMI_RUNTIME_ENV:'staging',LUMI_PIPELINE_VERSION:'legacy',PROVIDER_CALLS_ALLOWED:'0'};
 for(const patch of [{LUMI_RUNTIME_ENV:'production'},{PROVIDER_CALLS_ALLOWED:'1'},{LUMI_PIPELINE_VERSION:'v1_1_2'},{LUMI_PIPELINE_AUTORUN:'true'}])await assert.rejects(runEpisodeCompletionAudio({env:{...env,...patch}}),/SIGNED_STAGING/);
});
test('signed audio is a separate single-flight action; no provider permission added to global env',async()=>{
 const env={LUMI_RUNTIME_ENV:'staging',LUMI_PIPELINE_VERSION:'legacy',PROVIDER_CALLS_ALLOWED:'0'};let called=0;
 assert.throws(()=>beginControlledEpisodeAction({env,body:{operation:'AUDIO',shot:'q35'}}),/AUDIO_SCOPE/);
 const a=beginControlledEpisodeAction({env,body:{operation:'AUDIO'},executeAudio:async args=>{called++;assert.equal(args.env.PROVIDER_CALLS_ALLOWED,'0');return {status:'READY_FOR_ASSEMBLY'};}});
 assert.equal(a.status,'ACCEPTED');assert.throws(()=>beginControlledEpisodeAction({env,body:{operation:'AUDIO'}}),/ALREADY_RUNNING/);
 const result=await waitControlledEpisodeActionForTest();assert.equal(result.status,'COMPLETE');assert.equal(called,1);
});
