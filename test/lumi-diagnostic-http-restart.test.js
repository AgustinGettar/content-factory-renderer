import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

function worker(directory,mode,point){
  const child=spawn(process.execPath,['--import','./scripts/director-offline-guard.mjs',
    'test/fixtures/diagnostic-http-worker.mjs',directory,mode,point],{stdio:['ignore','pipe','pipe']});
  let output='',error='';const waiters=[];
  child.stdout.on('data',chunk=>{output+=chunk;for(const f of waiters)f();});child.stderr.on('data',chunk=>error+=chunk);
  const done=new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{child.kill('SIGKILL');reject(Error('LOCAL_WORKER_TIMEOUT'));},20000);
    child.on('error',reject);child.on('exit',(code,signal)=>{clearTimeout(timer);
      if(code===0||signal==='SIGKILL')resolve({code,signal,output});else reject(Error(error||output));});
  });
  const until=match=>new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(Error('LOCAL_EVENT_TIMEOUT')),15000);
    const check=()=>{const found=match(output);if(found){clearTimeout(timer);resolve(found);}};waiters.push(check);check();
  });
  return {child,done,until};
}
const run=async(...args)=>{const r=await worker(...args).done;assert.equal(r.code,0);return r.output.trim()?JSON.parse(r.output.trim().split('\n').at(-1)):null;};
for(const point of ['HTTP_BEFORE_RECEIVED_PERSISTENCE','HTTP_RECEIVED_PERSISTED','HTTP_BEFORE_RESULT_PERSISTENCE','HTTP_RESULT_PERSISTED'])
test('real SIGKILL '+point+'; restart GET recovers only persisted facts without executing',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'lumi-http-crash-'));
  try{
    await run(directory,'prepare',point);
    const crashed=worker(directory,'crash',point);await crashed.until(out=>out.includes('KILL_NOW'));
    crashed.child.kill('SIGKILL');assert.equal((await crashed.done).signal,'SIGKILL');
    const recovered=await run(directory,'recover',point),records=recovered.query.body.http_records;
    assert.equal(recovered.query.status,200);assert.equal(recovered.rows,1);assert.equal(recovered.writes,0);assert.equal(recovered.unchanged,true);
    assert.deepEqual(recovered.events,[]);assert.deepEqual(recovered.production_access,[]);assert.deepEqual(recovered.guard_attempts,[]);
    assert.equal(recovered.provider_generation_calls,0);
    if(point==='HTTP_BEFORE_RECEIVED_PERSISTENCE'){
      assert.deepEqual(records,[]);assert.equal(recovered.first_pending_action,'planning');
    }else if(point==='HTTP_RESULT_PERSISTED'){
      assert.equal(records.length,2);assert.equal(records[1].http_status,202);assert.equal(records[1].stage_id,'PLANNING');
      assert.equal(records[1].lease_state,'FREE');assert.equal(recovered.first_pending_action,'source-planning');
    }else{
      assert.equal(records.length,1);assert.equal(records[0].http_status,null);assert.equal(records[0].result_status,'OUTCOME_UNKNOWN');
      assert.equal(recovered.first_pending_action,point==='HTTP_RECEIVED_PERSISTED'?'planning':'source-planning');
    }
    const before=new Map(JSON.parse(await readFile(join(directory,'before.json'),'utf8'))).values().next().value.metadata.isolated_validation;
    const after=new Map(JSON.parse(await readFile(join(directory,'rows.json'),'utf8'))).values().next().value.metadata.isolated_validation;
    assert.deepEqual(after.http_records.slice(0,before.http_records.length),before.http_records);
    assert.deepEqual(after.results.CREATE,before.results.CREATE);assert.deepEqual(after.review.state.v2_authorizations,before.review.state.v2_authorizations);
    assert.deepEqual(await run(directory,'recover',point),recovered);
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('real client timeout after durable admission still persists 202; restarted GET does no work',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'lumi-http-timeout-'));let server;
  try{
    await run(directory,'prepare','timeout');server=worker(directory,'serve','timeout');
    const info=await server.until(out=>{const line=out.split('\n').find(s=>s.startsWith('{"port"'));return line&&JSON.parse(line);});
    const base=`http://127.0.0.1:${info.port}`,e=info.envelope,controller=new AbortController();
    const request=fetch(base+e.signed.path,{method:'POST',headers:{'content-type':'application/json',
      'x-lumi-timestamp':e.signed.timestamp,'x-lumi-request-id':e.signed.requestId,'x-lumi-signature':e.signature},
      body:Buffer.from(e.signed.body.data),signal:controller.signal});
    // Deterministic client deadline once admission is known, before a result exists.
    const rejected=assert.rejects(request,error=>error.name==='TimeoutError');
    await server.until(out=>out.includes('RECEIVED'));controller.abort(new DOMException('Client deadline','TimeoutError'));await rejected;
    assert.equal((await fetch(base+'/release')).status,200);await server.until(out=>out.includes('COMPLETED'));
    await fetch(base+'/stop');const ended=await server.done;assert.equal(ended.code,0);
    assert.deepEqual(JSON.parse(ended.output.trim().split('\n').at(-1)).guard_attempts,[]);
    const recovered=await run(directory,'recover','timeout'),records=recovered.query.body.http_records;
    assert.equal(records.length,2);assert.equal(records[1].http_status,202);assert.equal(recovered.first_pending_action,'source-planning');
    assert.equal(recovered.writes,0);assert.equal(recovered.unchanged,true);assert.deepEqual(recovered.events,[]);
    assert.equal(recovered.claims,1);assert.equal(recovered.rows,1);assert.equal(recovered.provider_generation_calls,0);
  }finally{if(server?.child.exitCode===null)server.child.kill('SIGKILL');await rm(directory,{recursive:true,force:true});}
});
