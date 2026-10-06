import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {materializeStageArtifact} from '../lib/lumi-artifact-materialization-v2.js';
import {MemoryStageReceiptStore,LumiV2ExecutionOrchestrator} from '../lib/lumi-v2-execution-orchestrator.js';
import {MemoryLumiRecoveryStore,LumiRecoveryIncidentManager} from '../lib/lumi-recovery-incident-manager-v1.js';
import {sha256} from '../lib/telegram-review-v1/core.js';

const cases=[['IMAGE',new URL('../assets/lumi-canonical-wand.png',import.meta.url)],
  ...Object.entries({VIDEO:process.env.LUMI_TEST_VIDEO_PATH,TTS:process.env.LUMI_TEST_AUDIO_PATH}).filter(([,path])=>path)];
const points=['PROVIDER_COMPLETED_ARTIFACT_NOT_PERSISTED','ARTIFACT_DOWNLOADED_HASH_NOT_PERSISTED',
  'ARTIFACT_PERSISTED_QA_NOT_PERSISTED','QA_PERSISTED_CHECKPOINT_NOT_ADVANCED'];
for(const [stage,path]of cases)for(const point of points)test('real '+stage+' materialization recovers '+point,async()=>{
  const bytes=await readFile(path),objects=new Map(),receipts=new MemoryStageReceiptStore();let recoveries=0,crashed=false;
  const input={episode_id:'ep_unrelated_fixture',action_key:'asset_17',stage_id:stage,provider_job_id:'historical-job',result_id:'original',
    expected_sha256:sha256(bytes),target:{bucket:'fixture',prefix:'materialization'},review_required:stage==='VIDEO'};
  const runtime={receipts,storage:{download:async(b,p)=>objects.get(b+'/'+p)??null,upload:async(b,p,v)=>{assert.ok(!objects.has(b+'/'+p));objects.set(b+'/'+p,Buffer.from(v));}},
    recoverOriginal:async ids=>{recoveries++;return {...ids,bytes};},inject:async p=>{if(p===point&&!crashed){crashed=true;throw Error('CRASH');}}};
  await assert.rejects(materializeStageArtifact(input,runtime),/CRASH/);
  const result=await materializeStageArtifact(input,runtime);assert.equal(result.qa.ok,true);assert.equal(result.artifacts[0].sha256,sha256(bytes));
  assert.equal(result.artifacts[0].role,'ORIGINAL');assert.equal(result.artifacts[0].review_derivative,false);assert.equal(result.provider_calls,0);
  assert.equal(recoveries,1);assert.equal(objects.size,1);
  assert.deepEqual(await materializeStageArtifact(input,runtime),result);assert.equal(recoveries,1);
  if(stage==='VIDEO'){assert.ok(result.qa.width>0&&result.qa.duration>0);assert.equal(result.human_review_requirement,true);}
  if(stage==='TTS'){assert.equal(result.qa.sample_rate,44100);assert.equal(result.qa.channels,1);}
  objects.set(input.target.bucket+'/'+result.artifacts[0].path,Buffer.from('corrupt'));
  await assert.rejects(materializeStageArtifact(input,runtime),/HASH_MISMATCH/);
});
for(const [stage,path]of cases)test(stage+' accepted result reaches existing orchestrator checkpoint exactly once',async()=>{
 const bytes=await readFile(path),episodeId='ep_generic_result',binding='fixture-binding',action={key:stage.toLowerCase()+':scene_17',stage},
  next={key:'next',stage:stage==='IMAGE'?'SOURCE_QA':stage==='VIDEO'?'TEMPORAL_QA':'ASSEMBLY'};
 const manager=new LumiRecoveryIncidentManager({store:new MemoryLumiRecoveryStore()}),receipts=new MemoryStageReceiptStore(),objects=new Map();
 const storage={download:async(b,p)=>objects.get(p)??null,upload:async(b,p,v)=>objects.set(p,Buffer.from(v))};
 await manager.startEpisode({episodeId,actions:[action,next],authorizedCeilingUsd:0,metadata:{generic_v2:{episode_id:episodeId,binding_sha:binding}}});
 const id=sha256(episodeId+':'+binding+':'+action.key);await receipts.claim(id,{status:'STARTED'});
 await receipts.record(id,{status:'WAITING',result:{provider_job_ids:['accepted-job']}});
 const orchestrator=new LumiV2ExecutionOrchestrator({manager,receipts,artifactStorage:storage});let downloads=0;
 const args={episodeId,actionKey:action.key,completedResult:{episode_id:episodeId,action_key:action.key,stage_id:stage,
  provider_job_id:'accepted-job',result_id:'original',expected_sha256:sha256(bytes),target:{bucket:'fixture',prefix:'generic'}},
  runtime:{receipts,storage,recoverOriginal:async ids=>{downloads++;return {...ids,bytes};}}};
 await assert.rejects(orchestrator.recoverResult({...args,completedResult:{...args.completedResult,provider_job_id:'other'}}),/ACCEPTED/);
 const r=await orchestrator.recoverResult(args);assert.equal(r.first_pending_action,'next');assert.equal(r.provider_calls,0);
 await orchestrator.recoverResult(args);assert.equal(downloads,1);assert.equal((await manager.store.getEpisode(episodeId)).last_completed_action,action.key);
});
test('identity mismatch and storage outages cannot trigger provider recovery',async()=>{
  const input={episode_id:'ep_fixture',action_key:'image',stage_id:'IMAGE',provider_job_id:'job',result_id:'result',target:{bucket:'fixture',prefix:'artifacts'}};
  let calls=0;const r={receipts:new MemoryStageReceiptStore(),storage:{download:async()=>{throw Error('STORAGE_OFFLINE');},upload:async()=>{}},recoverOriginal:async()=>{calls++;}};
  await assert.rejects(materializeStageArtifact(input,r),/STORAGE_OFFLINE/);assert.equal(calls,0);
  await assert.rejects(materializeStageArtifact({...input,target:{bucket:'fixture',prefix:'other'}},r),/IMMUTABLE/);
  r.storage.download=async()=>null;r.recoverOriginal=async()=>({provider_job_id:'wrong',result_id:'result',bytes:Buffer.from('x')});
  await assert.rejects(materializeStageArtifact(input,r),/IDENTITY_MISMATCH/);
});
