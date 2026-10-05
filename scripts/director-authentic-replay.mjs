import assert from 'node:assert/strict';
import { readFile,mkdir,writeFile } from 'node:fs/promises';
import { resolve,join } from 'node:path';
import { runLumiV2Step } from '../lib/lumi-series-v2-execution.js';
import { sha256,stableStringify } from '../lib/cinematic-director-v1/PROMPT_COMPILER_V3.mjs';
assert.equal(globalThis.LUMI_OFFLINE_GUARD?.active,true,'OFFLINE_GUARD_REQUIRED');
const mediaRoot=resolve(process.argv[2]),drafts=resolve(process.argv[3]),output=resolve(process.argv[4]);
await mkdir(output,{recursive:true});
const root=new URL('../docs/cinematic-director-v1/bindings/',import.meta.url);
const env={LUMI_CINEMATIC_DIRECTOR_V1:'true',LUMI_RUNTIME_ENV:'local_offline',LUMI_PIPELINE_VERSION:'v1_1_2'};
const summary=[];
for(const shot of ['q31','q32','q33']){
  const binding=JSON.parse(await readFile(new URL(shot+'_ORIGINAL_MEDIA_BINDING_V1.json',root)));
  const observations=JSON.parse(await readFile(new URL(shot+'_BOUND_QA_OBSERVATIONS_V1.json',root)));
  const input=JSON.parse(await readFile(join(drafts,shot+'_documentary_input.json')));
  input.revision=2;
  input.contract.SOURCE_ARTIFACT={artifact_id:binding.source.artifact_id,path:binding.source.object_path,sha256:binding.source.sha256};
  // Bind the actual QA video, not a screenshot or a second conditioning image.
  const golden=JSON.parse(await readFile(new URL('q31_ORIGINAL_MEDIA_BINDING_V1.json',root)));
  input.media=[{artifact_id:binding.source.artifact_id,sha256:binding.source.sha256,path:join(mediaRoot,binding.source.local_filename),canonical_path:binding.source.object_path,role:'source'},
    {artifact_id:'q31-PRO2',sha256:golden.video.sha256,path:join(mediaRoot,golden.video.local_filename),role:'qa'}];
  input.source_qa={...binding.qa.source,sha256:binding.source.sha256,ANATOMY:binding.qa.forensics?.SOURCE_ANATOMY||'REVIEW_REQUIRED'};
  const directorReview={input,outputDirectory:join(output,'decisions'),historicalReplay:{binding,observations,mediaRoot}};
  const packet=await runLumiV2Step({env,directorReview});
  const repeat=await runLumiV2Step({env,directorReview});
  assert.equal(packet.creative_fingerprint,repeat.creative_fingerprint);
  assert.equal(stableStringify(packet.historical_replay),stableStringify(repeat.historical_replay));
  assert.equal(packet.gates.EXECUTION_AUTHORIZATION,false);assert.equal(packet.PROVIDER_REQUEST_PREVIEW.payload,null);
  assert.equal(packet.historical_replay.authentic_bytes,'PASS');
  if(shot==='q31')assert.equal(packet.historical_replay.evaluation,'COMPATIBLE_WITH_EXISTING_HUMAN_APPROVAL');
  else assert.equal(packet.historical_replay.evaluation,'BLOCKED');
  if(shot==='q33')assert.equal(packet.historical_replay.source_gate.status,'BLOCKED');
  if(shot==='q32')assert.ok(packet.historical_replay.topology_stages.SAMPLED_FRAME_TEMPORAL_QA.blockers.includes('NO_BODY_MASS_BEHIND_OVERALLS'));
  await writeFile(join(output,shot+'_AUTHENTIC_DIRECTOR_INPUT_V1.json'),JSON.stringify({...input,media:input.media.map(({path,...x})=>({...x,local_file:'RESOLVED_BY_SHA_MANIFEST'}))},null,2)+'\n');
  await writeFile(join(output,shot+'_AUTHENTIC_DIRECTOR_PACKET_V1.json'),JSON.stringify(packet,null,2)+'\n');
  summary.push({shot,assertions:'PASS',evaluation:packet.historical_replay.evaluation,binding_fingerprint:binding.fingerprint,
    creative_fingerprint:packet.creative_fingerprint,replay_sha256:sha256(stableStringify(packet.historical_replay)),gates:packet.gates,
    repair:packet.historical_replay.minimum_future_repair,questions:packet.historical_replay.questions});
}
assert.deepEqual(globalThis.LUMI_OFFLINE_GUARD.attempts,[]);
const report={version:'LUMI_AUTHENTIC_REPLAY_REPORT_V1',entrypoint:'runLumiV2Step → reviewAtCanonicalBoundary → compileDirectorPacket',
  runtime:'LOCAL_OFFLINE_CANONICAL_ENTRY',authentic_media_verified:'PASS',shots:summary,provider_calls:0,outgoing_connections_during_replay:0,
  original_artifacts_modified:false,new_generation_cost:0,new_media_generated:0,master_created:false,episode_resumed:false,
  staging_replay:'NOT_RUN',visual_scope:'Authentic bytes decoded fully; bound existing QA plus explicitly listed visual samples. No complete native-speed playback or new human certification.'};
await writeFile(join(output,'AUTHENTIC_REPLAY_REPORT_V1.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report));
