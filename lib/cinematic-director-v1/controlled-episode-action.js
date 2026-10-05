import {timingSafeEqual} from 'node:crypto';
import {runDirectedEpisodeStep} from './episode-step.js';
import {runEpisodeCompletionAudio} from './episode-completion-audio.js';
let state={status:'IDLE'},active=null;
export function controlledEpisodeAuthorized(env,token) {
 const secret=env.LUMI_EPISODE_COMPLETION_CONTROL_TOKEN;
 if(env.LUMI_RUNTIME_ENV!=='staging'||env.LUMI_PIPELINE_VERSION!=='legacy'||env.PROVIDER_CALLS_ALLOWED!=='0'||env.LUMI_PIPELINE_AUTORUN==='true'||typeof secret!=='string'||secret.length<32||typeof token!=='string')return false;
 const a=Buffer.from(secret),b=Buffer.from(token);return a.length===b.length&&timingSafeEqual(a,b);
}
export function beginControlledEpisodeAction({env,body,execute=runDirectedEpisodeStep,executeAudio=runEpisodeCompletionAudio,logger=console}) {
 if(env.LUMI_RUNTIME_ENV!=='staging'||env.LUMI_PIPELINE_VERSION!=='legacy'||env.PROVIDER_CALLS_ALLOWED!=='0')throw new Error('CONTROLLED_STAGING_ZERO_PROVIDER_DEFAULT_REQUIRED');
 if(body?.operation==='STATUS')return structuredClone(state);
 if(body?.operation==='AUDIO'){
  if(Object.keys(body).some(k=>k!=='operation'))throw new Error('CONTROLLED_AUDIO_SCOPE_REQUIRED');
  if(active)throw new Error('CONTROLLED_ACTION_ALREADY_RUNNING');
  state={status:'RUNNING',operation:'AUDIO',started_at:new Date().toISOString()};
  active=Promise.resolve().then(()=>executeAudio({env,logger})).then(result=>{state={...state,status:'COMPLETE',result,finished_at:new Date().toISOString()};}).catch(error=>{state={...state,status:'FAILED',error:error.code||error.message,finished_at:new Date().toISOString()};logger.error(JSON.stringify({event:'lumi_controlled_audio_failed',error:state.error}));}).finally(()=>{active=null;});
  return {status:'ACCEPTED',operation:'AUDIO'};
 }
 if(body?.shot!=='q36'||!['IMAGE','VIDEO'].includes(body.stage)||!['GENERATE','QA'].includes(body.operation))throw new Error('CONTROLLED_Q36_SINGLE_STEP_ONLY');
 if(active)throw new Error('CONTROLLED_ACTION_ALREADY_RUNNING');
 if(body.operation==='QA' && (!body.review||body.review.stage!==body.stage||body.review.attempt!==`q36-${body.stage==='IMAGE'?'SOURCE-V2-1':'V2-PRO1'}`))throw new Error('CONTROLLED_EXACT_QA_SCOPE_REQUIRED');
 if(body.operation==='GENERATE'&&body.review)throw new Error('CONTROLLED_REVIEW_ON_GENERATE_FORBIDDEN');
 const runEnv={...env,LUMI_CINEMATIC_DIRECTOR_V1:'true',LUMI_DIRECTOR_EPISODE_COMPLETION:'ep_lumi_flores_003',LUMI_SERIES_V2_AUTHORIZATION:'5dc31254ad26aa1b606735188ac30d2f4d486bc389f19bc8a50816e1e1b3da33',
  LUMI_SERIES_V2_STEP:JSON.stringify({shot:body.shot,stage:body.stage}),LUMI_DIRECTOR_QA_RECORD_JSON:body.operation==='QA'?JSON.stringify(body.review):'',PROVIDER_CALLS_ALLOWED:'1'};
 state={status:'RUNNING',operation:body.operation,shot:body.shot,stage:body.stage,started_at:new Date().toISOString()};
 // Runs only in response to a signed staging request after deployment. Never on boot.
 active=Promise.resolve().then(()=>execute({env:runEnv,logger})).then(result=>{state={...state,status:'COMPLETE',result,finished_at:new Date().toISOString()};}).catch(error=>{state={...state,status:'FAILED',error:error.code||error.message,finished_at:new Date().toISOString()};logger.error(JSON.stringify({event:'lumi_controlled_episode_action_failed',error:state.error,shot:body.shot,stage:body.stage}));}).finally(()=>{active=null;});
 return {status:'ACCEPTED',shot:body.shot,stage:body.stage,operation:body.operation};
}
export async function waitControlledEpisodeActionForTest(){if(active)await active;return structuredClone(state);}
