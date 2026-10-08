import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const run=(directory,mode,point)=>new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,['--import','./scripts/director-offline-guard.mjs','test/fixtures/isolated-validation-worker.mjs',directory,mode,point],
    {cwd:process.cwd(),stdio:['ignore','pipe','pipe']});
  let output='',error='',killed=false;
  const timer=setTimeout(()=>{child.kill('SIGKILL');reject(Error('ISOLATED_WORKER_TIMEOUT'));},20000);
  child.stdout.on('data',data=>{output+=data;if(mode==='crash'&&output.includes('KILL_NOW')&&!killed){killed=true;child.kill('SIGKILL');}});
  child.stderr.on('data',data=>{error+=data;});child.on('error',reject);
  child.on('exit',(code,signal)=>{clearTimeout(timer);
    if(mode==='crash')return killed&&signal==='SIGKILL'?resolve({signal}):reject(Error(error||'CRASH_POINT_NOT_REACHED'));
    if(code!==0)return reject(Error(error));resolve(output.trim()?JSON.parse(output.trim().split('\n').at(-1)):null);
  });
});
for(const point of ['CONTEXT_PERSISTED','CREATE_AFTER_AUTHORIZATION','CREATE_PERSISTED','RESUME_AFTER_MATERIALIZATION',
  'RESUME_PERSISTED','REVIEW_AFTER_PERSISTENCE','CONTINUATION_BEFORE_CHECKPOINT','RESULT_PERSISTED'])test('isolated SIGKILL recovery '+point,async()=>{
  const directory=await mkdtemp(join(tmpdir(),'lumi-isolated-crash-'));
  try{
    await run(directory,'prepare',point);assert.equal((await run(directory,'crash',point)).signal,'SIGKILL');
    const result=await run(directory,'recover',point);
    assert.equal(result.operation_rows,1);assert.equal(result.review_rows,1);assert.equal(result.claims,3);
    assert.equal(result.provider_generation_calls,0);assert.equal(result.runner_enabled,false);assert.equal(result.autorun,false);
    assert.equal(result.result.status,'PASS');assert.deepEqual(result.guard_attempts,[]);assert.deepEqual(result.production_access,[]);
    assert.deepEqual(await run(directory,'recover',point),result);
  }finally{await rm(directory,{recursive:true,force:true});}
});
