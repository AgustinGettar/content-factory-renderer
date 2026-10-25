import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {executeStage} from '../lib/lumi-v2-executor-bindings.js';
import {MemoryStageReceiptStore} from '../lib/lumi-v2-execution-orchestrator.js';
import {materializeStageArtifact} from '../lib/lumi-artifact-materialization-v2.js';
import {validateStageResult} from '../lib/lumi-stage-result-v2.js';
import {newSession,renderTelegramPanel,sha256} from '../lib/telegram-review-v1/core.js';
import {HOME_ASSET} from '../lib/telegram-review-v1/home-asset.js';
const exec=promisify(execFile);

test('PASS_OFFLINE: assembly encodes, persists and decodes a synthetic Full HD master before cleanup',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'lumi-synthetic-assembly-')),objects=new Map(),receipts=new MemoryStageReceiptStore();
 try{
  // FFmpeg test signal only; no generative provider, Lumi pixels or EP004 state.
  const video=join(dir,'test-pattern.mp4'),audio=join(dir,'test-tone.mp3'),output=join(dir,'synthetic-master.mp4');
  await exec('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=180x320:rate=30:duration=1',
   '-c:v','libx264','-threads','1','-pix_fmt','yuv420p','-y',video]);
  await exec('ffmpeg',['-v','error','-f','lavfi','-i','sine=frequency=440:duration=1','-ar','48000','-y',audio]);
  const episode='isolated_stabilization_fixture',action={key:'assembly',stage:'ASSEMBLY'},attempt='offline_assembly';
  let uploads=0;
  const storage={download:async(b,p)=>objects.get(b+'/'+p)??null,
   upload:async(b,p,bytes)=>{assert.ok(!objects.has(b+'/'+p));uploads++;objects.set(b+'/'+p,Buffer.from(bytes));}};
  const target={bucket:'isolated-fixtures',prefix:'synthetic/master'},runtime={receipts,storage,
   recoverOriginal:async ids=>({...ids,bytes:await readFile(output)})};
  const input={prepared:{episode_id:episode},action,attempt_id:attempt,material:{
   segments:[{videoPath:video,audioPath:audio,duration:1}],output_path:output,
   output_artifact_target:target,artifact_runtime:runtime}};
  const result=await executeStage({episode_id:episode,stage_id:'ASSEMBLY',input});
  validateStageResult(result,episode,'ASSEMBLY');assert.equal(result.status,'SUCCEEDED');assert.equal(result.qa.ok,true);
  assert.equal(result.artifacts[0].width,1080);assert.equal(result.artifacts[0].height,1920);
  assert.equal(result.output.final_encodes,1);assert.deepEqual(result.provider_job_ids,[]);assert.equal(uploads,1);
  const artifact=result.artifacts[0];assert.equal(sha256(await storage.download(artifact.bucket,artifact.path)),artifact.sha256);
  await rm(dir,{recursive:true,force:true});
  // After local cleanup a materialization replay reads the immutable object.
  const recovered=await materializeStageArtifact({episode_id:episode,stage_id:'ASSEMBLY',action_key:action.key,
   provider_job_id:'local_'+attempt,result_id:'original',target,
   expected:{width:1080,height:1920,codec:'h264',profile:'High'}},{receipts,storage,recoverOriginal:()=>assert.fail('no second encode/download')});
  assert.equal(recovered.artifacts[0].sha256,artifact.sha256);assert.equal(uploads,1);
  // Replay the executor itself after a lost ACK and deleted local inputs.
  // A second encode would fail because the entire temporary directory is gone.
  const replay=await executeStage({episode_id:episode,stage_id:'ASSEMBLY',input});
  assert.equal(replay.output.recovered_persisted_master,true);
  assert.equal(replay.artifacts[0].sha256,artifact.sha256);assert.equal(uploads,1);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('review screens display the exact source/video and frozen Fernanda identity',()=>{
 const state=newSession({user_id:'1',chat_id:'1',message_id:148,cover:HOME_ASSET});
 for(const [stage,mime]of [['IMAGE','image/png'],['VIDEO','video/mp4'],['TTS','audio/mpeg']]){
  const artifact={artifact_id:stage,mime,bucket:'isolated',path:'test',size:10,sha256:sha256(stage)};
  state.episodes.ep={episode_id:'ep',review_mode:'SUPERVISED',pipeline:'LUMI_PRODUCTION_PROFILE_V2',shots:[],artifacts:{[stage]:artifact},
   review_requests:{r:{review_request_id:'r',artifact_id:stage,artifact_sha:artifact.sha256,stage_id:stage,status:'PENDING',review_version:1}}};
  const panel=renderTelegramPanel(state,{kind:'review',episode_id:'ep',request_id:'r'});
  assert.equal(panel.artifact.sha256,artifact.sha256);
  if(stage==='TTS'){assert.match(panel.caption,/Fernanda/);assert.doesNotMatch(panel.caption,/Annie/);}
 }
});
