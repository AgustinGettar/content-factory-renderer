import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {materializeStageArtifact,createArtifactStorage} from '../lib/lumi-artifact-materialization-v2.js';
import {createClient} from '@supabase/supabase-js';
import {MemoryStageReceiptStore,LumiV2ExecutionOrchestrator} from '../lib/lumi-v2-execution-orchestrator.js';
import {MemoryLumiRecoveryStore,LumiRecoveryIncidentManager} from '../lib/lumi-recovery-incident-manager-v1.js';
import {sha256} from '../lib/telegram-review-v1/core.js';
import {MemoryReviewStore,newSession} from '../lib/telegram-review-v1/core.js';
import {HOME_ASSET} from '../lib/telegram-review-v1/home-asset.js';
import {ProductionReviewController} from '../lib/telegram-review-v1/production.js';

const cases=[['IMAGE',new URL('../assets/lumi-canonical-wand.png',import.meta.url)],
  ...Object.entries({VIDEO:process.env.LUMI_TEST_VIDEO_PATH,TTS:process.env.LUMI_TEST_AUDIO_PATH}).filter(([,path])=>path)];
const points=['PROVIDER_COMPLETED_ARTIFACT_NOT_PERSISTED','ARTIFACT_DOWNLOADED_HASH_NOT_PERSISTED',
  'ARTIFACT_PERSISTED_QA_NOT_PERSISTED','QA_PERSISTED_CHECKPOINT_NOT_ADVANCED'];
test('real storage SDK missing-key envelope permits recovery; auth and outages stay blocked',async()=>{
 let status=400,body={statusCode:'404',error:'not_found',message:'Object not found',code:'NoSuchKey'};
 const db=createClient('https://storage.example.test','fixture-key',{auth:{persistSession:false},global:{fetch:async()=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}})}});
 const storage=createArtifactStorage(db);
 assert.equal(await storage.download('fixture','original.mp3'),null);
 for(const next of [403,404,500]){status=next;body={message:'unavailable'};await assert.rejects(storage.download('fixture','original.mp3'),/ARTIFACT_STORAGE_READ_FAILED/);}
});
for(const [stage,path]of cases)test(stage+' canonical SHA reuses existing bytes without upload, including recovery',async()=>{
 const bytes=await readFile(path),sha=sha256(bytes),receipts=new MemoryStageReceiptStore();let uploads=0,recoveries=0;
 const existing={artifact_id:sha,sha256:sha,size:bytes.length,bucket:'existing',path:'original/media',mime:stage==='IMAGE'?'image/png':stage==='VIDEO'?'video/mp4':'audio/mpeg'};
 const input={episode_id:'diag_generic',action_key:'historical',stage_id:stage,provider_job_id:'job',result_id:'original',expected_sha256:sha,
  existing_artifact:existing,target:{bucket:'existing',prefix:'unused'}};
 const runtime={receipts,storage:{download:async(b,p)=>{assert.equal(p,existing.path);return bytes;},upload:async()=>{uploads++;}},recoverOriginal:async()=>{recoveries++;}};
 const first=await materializeStageArtifact(input,runtime),again=await materializeStageArtifact(input,runtime);
 assert.equal(first.qa.ok,true);assert.deepEqual(first,again);assert.equal(first.artifacts[0].artifact_id,sha);assert.equal(first.artifacts[0].path,existing.path);
 assert.equal(uploads,0);assert.equal(recoveries,0);
 await assert.rejects(materializeStageArtifact({...input,existing_artifact:{...existing,path:'different'}},runtime),/IMMUTABLE/);
});
for(const [stage,path]of cases)for(const point of ['DOWNLOADED_BEFORE_SHA','SHA_CALCULATED_BEFORE_PERSISTENCE'])test(stage+' pre-persistence recovery '+point+' never duplicates objects',async()=>{
 const bytes=await readFile(path),objects=new Map(),receipts=new MemoryStageReceiptStore();let crashed=false,uploads=0;
 const input={episode_id:'ep_crash',action_key:'result',stage_id:stage,provider_job_id:'job',result_id:'original',expected_sha256:sha256(bytes),target:{bucket:'fixture',prefix:'original'}};
 const runtime={receipts,storage:{download:async(b,p)=>objects.get(p),upload:async(b,p,v)=>{uploads++;assert.ok(!objects.has(p));objects.set(p,v);}},
  recoverOriginal:async ids=>({...ids,bytes}),inject:async p=>{if(p===point&&!crashed){crashed=true;throw Error('CRASH');}}};
 await assert.rejects(materializeStageArtifact(input,runtime),/CRASH/);await materializeStageArtifact(input,runtime);
 assert.equal(uploads,1);assert.equal(objects.size,1);
});
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
for(const [stage,path]of cases)for(const crash of [null,'QA_PERSISTED_BEFORE_CHECKPOINT','CHECKPOINT_PERSISTED_BEFORE_NEXT_DISPATCH'])test(stage+' accepted result reaches existing orchestrator checkpoint exactly once: '+crash,async()=>{
 const bytes=await readFile(path),episodeId='ep_generic_result',binding='fixture-binding',action={key:stage.toLowerCase()+':scene_17',stage},
  next={key:'next',stage:stage==='IMAGE'?'SOURCE_QA':stage==='VIDEO'?'TEMPORAL_QA':'ASSEMBLY'};
 const manager=new LumiRecoveryIncidentManager({store:new MemoryLumiRecoveryStore()}),receipts=new MemoryStageReceiptStore(),objects=new Map();
 const storage={download:async(b,p)=>objects.get(p)??null,upload:async(b,p,v)=>objects.set(p,Buffer.from(v))};
 await manager.startEpisode({episodeId,actions:[action,next],authorizedCeilingUsd:0,metadata:{generic_v2:{episode_id:episodeId,binding_sha:binding}}});
 const id=sha256(episodeId+':'+binding+':'+action.key);await receipts.claim(id,{status:'STARTED'});
 await receipts.record(id,{status:'WAITING',result:{provider_job_ids:['accepted-job']}});
 let crashed=false;const orchestrator=new LumiV2ExecutionOrchestrator({manager,receipts,artifactStorage:storage,inject:async({point})=>{if(crash===point&&!crashed){crashed=true;throw Error('CRASH');}}});let downloads=0;
 const args={episodeId,actionKey:action.key,completedResult:{episode_id:episodeId,action_key:action.key,stage_id:stage,
  provider_job_id:'accepted-job',result_id:'original',expected_sha256:sha256(bytes),target:{bucket:'fixture',prefix:'generic'}},
  runtime:{receipts,storage,recoverOriginal:async ids=>{downloads++;return {...ids,bytes};}}};
 await assert.rejects(orchestrator.recoverResult({...args,completedResult:{...args.completedResult,provider_job_id:'other'}}),/ACCEPTED/);
 if(crash)await assert.rejects(orchestrator.recoverResult(args),/CRASH/);
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
test('canonical controller replays a real stored image through Source QA without storage writes',async()=>{
 const bytes=await readFile(cases[0][1]),sha=sha256(bytes),episodes=new Map();let writes=0;
 const visual={classification:'PASS',sha256:sha,CARTOON_DRIFT:'MINIMAL',BODY_LOCK_VERSION:'LUMI_BODY_ANATOMY_LOCK_V1'};
 for(const k of ['IDENTITY','REALISM','ANATOMY','EDUCATIONAL_SEMANTICS','COLOR','VIDEO_SOURCE_READINESS','NO_BEE_ABDOMEN','NO_STRIPED_POSTERIOR_BODY','NO_STINGER','NO_EXTRA_TORSO','NO_REAR_BULB'])visual[k]='PASS';
 const run={status:'SUCCEEDED',provider_request_id:'job',storage_bucket:'existing',storage_path:'original.png',content_hash:sha,result:{mime:'image/png',visual_qa:visual}};
 const db={storage:{from:()=>({download:async()=>({data:new Blob([bytes])}),upload:async()=>{writes++;throw Error('NO_COPY_ALLOWED');}})},from:table=>{
  let key,value;const q={select:()=>q,eq:(k,v)=>{if(k==='episode_id')key=v;return q;},upsert:v=>{value=structuredClone(v);episodes.set(v.episode_id,value);return q;},
   maybeSingle:async()=>({data:episodes.get(key)??null}),single:async()=>({data:table==='lumi_pilot_runs'?run:value})};return q;
 }};
 const store=new MemoryReviewStore(),s=newSession({user_id:'1',chat_id:'1',message_id:138,cover:HOME_ASSET});
 s.episodes.existing={episode_id:'existing',title:'Preserved',review_mode:'SUPERVISED',shots:[],reviews:{master:{status:'APPROVED'}}};await store.create('1',s);
 const controller=new ProductionReviewController({store,db}),args={user:'1',episodeId:'existing',stage:'IMAGE',jobId:'job'};
 const first=await controller.replayArtifact(args),again=await controller.replayArtifact(args);
 assert.equal(first.status,'PASS');assert.equal(first.provenance.source_qa,'PASS');assert.equal(first.continuation.first_pending_action,'after_qa');
 assert.equal(first.artifact.sha256,sha);assert.equal(first.artifact.path,'original.png');assert.equal(writes,0);
 assert.deepEqual(first,again);assert.deepEqual((await store.get('1')).state.episodes.existing,s.episodes.existing);
 assert.ok([...episodes.values()].every(x=>x.runner_enabled===false&&x.autorun===false&&x.authorized_ceiling_usd===0));
});
