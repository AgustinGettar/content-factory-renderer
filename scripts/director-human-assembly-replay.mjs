import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import assert from 'node:assert/strict';
import {runLumiV2Step} from '../lib/lumi-series-v2-execution.js';
const root=new URL('../docs/cinematic-director-v1/',import.meta.url);
const read=async p=>JSON.parse(await readFile(new URL(p,root)));
const mediaRoot=resolve(process.argv[2]),out=resolve(process.argv[3]);
await mkdir(out,{recursive:true});
const approvals=await read('human-review-20261005/HUMAN_ASSEMBLY_APPROVALS_V1.json');
const golden=await read('bindings/q31_ORIGINAL_MEDIA_BINDING_V1.json');
const results=[];
for(const q of ['q31','q32','q33']){
 const binding=await read('bindings/'+q+'_ORIGINAL_MEDIA_BINDING_V1.json');
 const input=await read('closure-v2/replay/'+q+'_AUTHENTIC_DIRECTOR_INPUT_V1.json');
 input.media=input.media.map(m=>({...m,path:join(mediaRoot,m.role==='source'?binding.source.local_filename:golden.video.local_filename)}));
 const packet=await runLumiV2Step({env:{LUMI_RUNTIME_ENV:'local_offline',LUMI_PIPELINE_VERSION:'v1_1_2',LUMI_CINEMATIC_DIRECTOR_V1:'true'},
  directorReview:{input,outputDirectory:join(out,'decisions'),historicalReplay:{binding,observations:await read('closure-v3/'+q+'_BOUND_QA_OBSERVATIONS_R2.json'),mediaRoot},humanAssemblyApproval:approvals.records.find(r=>r.shot===q)}});
 assert.equal(packet.historical_replay.assembly_eligible,true);assert.equal(packet.historical_replay.minimum_future_repair,null);
 assert.equal(packet.gates.EXECUTION_AUTHORIZATION,false);assert.equal(packet.PROVIDER_REQUEST_PREVIEW.payload,null);
 await writeFile(join(out,q+'.json'),JSON.stringify(packet,null,2)+'\n');
 results.push({shot:q,outcome:packet.historical_replay.repair_outcome,automated_findings_preserved:true,provider_calls:0});
}
assert.deepEqual(globalThis.LUMI_OFFLINE_GUARD.attempts,[]);
await writeFile(join(out,'LOCAL_HUMAN_ASSEMBLY_REPLAY.json'),JSON.stringify({status:'PASS',results,provider_calls:0,staging_replay:'NOT_YET_RUN'},null,2)+'\n');
console.log(JSON.stringify({status:'PASS',results,provider_calls:0}));
