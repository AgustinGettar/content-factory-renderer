import '../scripts/director-offline-guard.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {applyEpisodeAssemblyApproval} from '../lib/cinematic-director-v1/human-assembly.js';
import {reviewAtCanonicalBoundary} from '../lib/cinematic-director-v1/integration.js';
const read=async p=>JSON.parse(await readFile(new URL('../docs/cinematic-director-v1/'+p,import.meta.url)));
const approvals=await read('human-review-20261005/HUMAN_ASSEMBLY_APPROVALS_V1.json');
for(const q of ['q31','q32','q33']){
  const b=await read('bindings/'+q+'_ORIGINAL_MEDIA_BINDING_V1.json');
  const approval=approvals.records.find(x=>x.shot===q);
  test(q+': human authority closes assembly while preserving automated findings',()=>{
    const original={source_gate:{status:q==='q33'?'BLOCKED':'PASS'},topology_stages:{finding:'HISTORICAL'},minimum_future_repair:{execute:false}};
    const before=structuredClone(original),r=applyEpisodeAssemblyApproval(original,b,approval);
    assert.deepEqual(original,before);assert.deepEqual(r.automated_evaluation_preserved,before);
    assert.equal(r.assembly_eligible,true);assert.equal(r.repair_execution_forbidden,true);
    assert.equal(r.minimum_future_repair,null);assert.equal(r.execution_authorization,false);
    assert.equal(r.golden_anatomy_reference,false);assert.equal(r.golden_reference,q==='q31');
  });
  for(const mutation of [{sha256:'0'.repeat(64)},{episode_id:'future_episode'},{scope:'SOURCE_FOR_VIDEO'},{full_playback_1x:false},{actor:'MODEL'},
    {golden_reference:q!=='q31'},{golden_scope:'ANATOMY'}]){
    test(q+': approval cannot broaden scope '+JSON.stringify(mutation),()=>{
      assert.throws(()=>applyEpisodeAssemblyApproval({},b,{...approval,...mutation}),/PROVENANCE_REQUIRED/);
    });
  }
}
test('staging review requires zero-provider lock before any client',async()=>{
  await assert.rejects(reviewAtCanonicalBoundary({env:{LUMI_RUNTIME_ENV:'staging',LUMI_PIPELINE_VERSION:'v1_1_2'},directorReview:{}}),/episode_selection_required/);
});
test('all approval tests made zero outgoing connections',()=>assert.deepEqual(globalThis.LUMI_OFFLINE_GUARD.attempts,[]));
