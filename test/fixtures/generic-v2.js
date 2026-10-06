import {readFile,mkdtemp,rm} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {makeFixture} from './director-v1.js';
import {GENERIC_WORKER_STAGES,GenericLumiV2Adapter,compileGenericV2Direction} from '../../lib/lumi-generic-v2-adapter.js';
import {LUMI_PRODUCTION_PROFILE_V2 as profile} from '../../lib/lumi-production-profile-v2.js';
import {MemoryLumiRecoveryStore,LumiRecoveryIncidentManager} from '../../lib/lumi-recovery-incident-manager-v1.js';
import {sha256} from '../../lib/telegram-review-v1/core.js';
import {evaluateCalibration} from '../../lib/cinematic-director-v1/topology-calibration.js';
export async function genericFixture(episodeId='ep_fictional_future'){
 const directory=await mkdtemp(join(tmpdir(),'lumi-generic-fixture-'));const original=JSON.parse(await readFile(new URL('../../episodes/ep_lumi_flores_003/EPISODE_PLAN_V2.json',import.meta.url)));
 const idMap=Object.fromEntries(original.scenes.map((s,i)=>[s.id,'s'+String(i+1).padStart(2,'0')]));
 const remap=x=>typeof x==='string'?idMap[x]||x:Array.isArray(x)?x.map(remap):x&&typeof x==='object'?Object.fromEntries(Object.entries(x).map(([k,v])=>[k,remap(v)])):x;
 const plan=remap(original);plan.episode.id=episodeId;plan.episode.title='Episodio ficticio para validación sin proveedores';
 const shotPlans=[],options={};
 for(let i=0;i<plan.scenes.length;i++){
  const f=await makeFixture({grammar:i===6?'ATTENTIVE_WAIT':'GAZE_VIEWER',directory:join(directory,'source-'+i)}),id='take_'+String(i+1).padStart(2,'0'),input=f.input,duration=Math.min(5,plan.scenes[i].duration_target_seconds);
  input.episode_id=episodeId;input.contract.shot_id=id;input.contract.DURATION=duration;input.direction.principal_actions[0].timing.gesture=duration-1.5;
  input.direction.continuity.previous_shot=i?'take_'+String(i).padStart(2,'0'):null;input.direction.continuity.next_shot=i+1<plan.scenes.length?'take_'+String(i+2).padStart(2,'0'):null;
  input.contract.CHARACTER_STATE.character_lock_id=profile.visual.character_lock;input.context.locks.character.id=profile.visual.character_lock;
  shotPlans.push({shot_id:id,scene_ids:[plan.scenes[i].id],duration,director_input:input});options[id]=f.options;
 }
 const request={episodePlan:plan,shotPlans,characterProfile:{id:profile.visual.character_lock,source_sha:profile.visual.source_sha},qualityProfile:{id:profile.visual.video_profile}};
 const store=new MemoryLumiRecoveryStore(),manager=new LumiRecoveryIncidentManager({store}),trace=[];let simulatedEmissions=0;
 const journal={rows:new Map(),async prepare(r){if(this.rows.has(r.attempt_id))throw Error('duplicate_claim');this.rows.set(r.attempt_id,structuredClone(r));},async transition(id,from,p){const r=this.rows.get(id);if(r.state!==from)throw Error('journal_cas');Object.assign(r,p);},async get(id){return this.rows.get(id);}};
 const workers=Object.fromEntries(GENERIC_WORKER_STAGES.map(stage=>[stage,{generic:true,simulated:true,quote:async()=>({currency:'USD',usd:.01}),fetch:async()=>{simulatedEmissions++;return new Response(JSON.stringify({request_id:'SIMULATED_'+stage+'_'+simulatedEmissions}),{headers:{'content-type':'application/json'}});},run:async({prepared,action,shot,dispatch,state})=>{
  trace.push(action.stage+(shot?':'+shot.shot_id:''));let request_id,metadata_patch;
  if(['IMAGE','VIDEO','TTS'].includes(stage)){const model=stage==='IMAGE'?profile.image.model:stage==='VIDEO'?profile.video.endpoint:profile.voice.model,payload=stage==='TTS'?prepared.narration_request:{scope:'SYNTHETIC_REQUEST_NOT_REAL_PROVIDER_PAYLOAD'};const response=await dispatch('https://api.higgsfield.ai/'+model,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});request_id=(await response.json()).request_id;}
  if(stage==='SOURCE_QA'){const sha=shot.director_input.contract.SOURCE_ARTIFACT.sha256,qa={...shot.director_input.source_qa,sha256:sha,classification:'PASS',IDENTITY:'PASS',REALISM:'PASS',EDUCATIONAL_SEMANTICS:'PASS',COLOR:'PASS',VIDEO_SOURCE_READINESS:'PASS',CARTOON_DRIFT:'MINIMAL'};metadata_patch={source_artifacts:{...state.metadata.source_artifacts,[shot.shot_id]:{artifact:{sha256:sha},ledger:{content_hash:sha,result:{visual_qa:qa}}}}};}
  if(stage==='DIRECTOR'){const packet=await compileGenericV2Direction(prepared,shot.shot_id,options[shot.shot_id]);metadata_patch={director_packets:{...state.metadata.director_packets,[shot.shot_id]:packet}};}
  if(stage==='TEMPORAL_QA'&&evaluateCalibration().status!=='PASS')throw Error('calibration_failed');
  return {artifact:{scope:'SYNTHETIC_NOT_PLAYABLE',sha256:sha256(action.key),...(stage==='MASTER'?{profile:profile.master}:{})},evidence:{provider_succeeded:true,artifact_persisted:true,sha_verified:true,artifact_verified:true},actualCostUsd:['IMAGE','VIDEO','TTS'].includes(stage)?.01:0,request_id,metadata_patch};
 }}]));
 const adapter=new GenericLumiV2Adapter({manager,journal,workers,simulation:true});
 return {request,directory,store,manager,journal,workers,adapter,trace,simulatedEmissions:()=>simulatedEmissions,cleanup:()=>rm(directory,{recursive:true,force:true})};
}
