import {writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {runRealExecutorDryGate} from '../lib/lumi-v2-real-executor-dry-run.js';

const result=await runRealExecutorDryGate({crashMatrix:true});
assert.equal(result.external_calls,0);
assert.deepEqual(result.provider_calls,{IMAGE:0,VIDEO:0,TTS:0});
assert.equal(result.publication_calls,0);
assert.equal(result.canonical_message_id,138);
assert.equal(result.crash_resume_matrix.duplicate_provider_calls,0);
assert.ok(result.crash_resume_matrix.rows.every(r=>r.pass!==false));
assert.ok(result.stages.every(r=>r.executor_bound?r.status!=='BLOCKED':r.status==='BLOCKED'));
assert.equal(result.end_to_end.status,'BLOCKED');
assert.deepEqual(result.binding.missing_stages,['TTS']);
await writeFile(process.argv[2]||'/tmp/lumi-real-executor-v2.json',JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({diagnostic_validation:'PASS',production_readiness:result.status,bound:result.binding.bound,total:result.binding.total,blockers:result.blockers,provider_calls:0}));
