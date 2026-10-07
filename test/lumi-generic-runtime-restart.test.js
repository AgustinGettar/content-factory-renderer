import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const run=(directory,mode,point)=>new Promise((resolve,reject)=>{
 const child=spawn(process.execPath,['--import','./scripts/director-offline-guard.mjs','test/fixtures/generic-runtime-worker.mjs',directory,mode,point],{cwd:process.cwd(),stdio:['ignore','pipe','pipe']});
 let output='',error='',killed=false;
 const timeout=setTimeout(()=>{child.kill('SIGKILL');reject(Error('WORKER_TIMEOUT:'+mode));},20000);
 child.stdout.on('data',data=>{output+=data;if(mode==='crash'&&output.includes('KILL_NOW')&&!killed){killed=true;child.kill('SIGKILL');}});
 child.stderr.on('data',data=>{error+=data;});child.on('error',reject);
 child.on('exit',(code,signal)=>{clearTimeout(timeout);if(mode==='crash')return killed&&signal==='SIGKILL'?resolve({signal}):reject(Error(error||'CRASH_POINT_NOT_REACHED'));
   if(code!==0)return reject(Error(error));resolve(output.trim()?JSON.parse(output.trim().split('\n').at(-1)):null);});
});
for(const point of ['CREATE_AFTER_AUTHORIZATION','RESUME_AFTER_MATERIALIZATION','REVIEW_AFTER_PERSISTENCE','CONTINUATION_BEFORE_CHECKPOINT'])test('SIGKILL recovery '+point,async()=>{
 const directory=await mkdtemp(join(tmpdir(),'lumi-runtime-crash-'));
 try{
  await run(directory,'prepare',point);assert.equal((await run(directory,'crash',point)).signal,'SIGKILL');
  const result=await run(directory,'recover',point);
  assert.equal(result.episode_rows,1);assert.equal(result.providerCalls,0);assert.equal(result.uploads,0);assert.deepEqual(result.guard_attempts,[]);
  assert.equal(result.runner_enabled,false);assert.equal(result.autorun,false);
  if(point==='CREATE_AFTER_AUTHORIZATION'){assert.equal(result.first_pending_action,'planning');assert.equal(result.claims,0);
    assert.deepEqual(await run(directory,'recover',point),result);}
  else if(point==='RESUME_AFTER_MATERIALIZATION'){assert.equal(result.first_pending_action,'source-planning');assert.deepEqual(result.stage_results,['planning']);assert.equal(result.claims,1);}
  else {assert.equal(result.first_pending_action,'tts');assert.equal(result.review_rows,1);assert.equal(result.active_incident_id,null);assert.equal(result.status,'RUNNING');
    assert.deepEqual(await run(directory,'recover',point),result);}
 }finally{await rm(directory,{recursive:true,force:true});}
});
