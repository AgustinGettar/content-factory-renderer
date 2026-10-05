import '../scripts/director-offline-guard.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {controlledEpisodeAuthorized,beginControlledEpisodeAction,waitControlledEpisodeActionForTest} from '../lib/cinematic-director-v1/controlled-episode-action.js';
const env={LUMI_RUNTIME_ENV:'staging',LUMI_PIPELINE_VERSION:'legacy',PROVIDER_CALLS_ALLOWED:'0',LUMI_EPISODE_COMPLETION_CONTROL_TOKEN:'SYNTHETIC_TOKEN_NOT_A_SECRET'.repeat(2)};
test('scoped token only permits staging with zero-provider default',()=>{
 assert.equal(controlledEpisodeAuthorized(env,env.LUMI_EPISODE_COMPLETION_CONTROL_TOKEN),true);
 for(const patch of [{LUMI_RUNTIME_ENV:'production'},{PROVIDER_CALLS_ALLOWED:'1'},{LUMI_PIPELINE_VERSION:'v1_1_2'},{LUMI_PIPELINE_AUTORUN:'true'},{LUMI_EPISODE_COMPLETION_CONTROL_TOKEN:''}])assert.equal(controlledEpisodeAuthorized({...env,...patch},env.LUMI_EPISODE_COMPLETION_CONTROL_TOKEN),false);
 assert.equal(controlledEpisodeAuthorized(env,'wrong'),false);
});
test('one signed request authorizes only q36 and never emits during deployment',async()=>{
 const calls=[];assert.equal(beginControlledEpisodeAction({env,body:{operation:'STATUS'}}).status,'IDLE');
 for(const shot of ['q31','q32','q33','q34','q35'])assert.throws(()=>beginControlledEpisodeAction({env,body:{operation:'GENERATE',shot,stage:'VIDEO'}}),/Q36_SINGLE_STEP_ONLY/);
 assert.equal(calls.length,0);
 assert.equal(beginControlledEpisodeAction({env,body:{operation:'GENERATE',shot:'q36',stage:'IMAGE'},execute:async args=>{calls.push(args.env);return {provider_calls:1};}}).status,'ACCEPTED');
 assert.throws(()=>beginControlledEpisodeAction({env,body:{operation:'GENERATE',shot:'q36',stage:'VIDEO'}}),/ALREADY_RUNNING/);
 const done=await waitControlledEpisodeActionForTest();assert.equal(done.status,'COMPLETE');assert.equal(calls.length,1);assert.equal(calls[0].PROVIDER_CALLS_ALLOWED,'1');assert.equal(env.PROVIDER_CALLS_ALLOWED,'0');
});
