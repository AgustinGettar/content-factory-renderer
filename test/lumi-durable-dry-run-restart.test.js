import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
function child(directory,mode,time,{kill=false}={}){
  return new Promise((resolve,reject)=>{
    const p=spawn(process.execPath,['--import','./scripts/director-offline-guard.mjs','test/fixtures/durable-dry-worker.mjs',directory,mode,String(time)],
      {cwd:root,env:{PATH:process.env.PATH},stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='',killed=false;
    const timeout=setTimeout(()=>{p.kill('SIGKILL');reject(Error('process fixture timeout'));},10000);
    p.stdout.on('data',bytes=>{stdout+=bytes;if(kill&&stdout.includes('KILL_NOW')&&!killed){killed=true;p.kill('SIGKILL');}});
    p.stderr.on('data',bytes=>stderr+=bytes);
    p.on('error',reject);p.on('exit',(code,signal)=>{
      clearTimeout(timeout);
      if(kill){if(!killed||signal!=='SIGKILL')return reject(Error('expected real SIGKILL: '+stderr));return resolve(null);}
      if(code!==0)return reject(Error(stderr));
      try{resolve(JSON.parse(stdout.trim()));}catch(error){reject(error);}
    });
  });
}
for(const mode of ['queued-restart','kill-before-execution','kill-during-execution','kill-after-result']){
  test(`real process restart: ${mode}; one disk checkpoint and recovered result`,async()=>{
    const dir=await mkdtemp(join(tmpdir(),'lumi-durable-process-'));
    try{
      const started=await child(dir,'prepare',1000);
      if(mode!=='queued-restart')await child(dir,mode,1000,{kill:true});
      const result=await child(dir,'complete',200000);
      assert.equal(result.operation_id,started.operation_id);assert.equal(result.status,'SUCCEEDED');assert.equal(result.result_json.status,'PASS');
      assert.equal(result.provider_generation_calls,0);assert.equal(result.publication_calls,0);
      assert.equal(JSON.parse(await readFile(join(dir,'checkpoint.json'),'utf8')).length,1);
      const calls=JSON.parse(await readFile(join(dir,'trace.json'),'utf8'));
      assert.deepEqual(calls,['TTS_PREFLIGHT','GENERIC_DRY_RUN','RUNTIME']);
      const repeated=await child(dir,'complete',400000);
      assert.deepEqual(repeated,result);assert.deepEqual(JSON.parse(await readFile(join(dir,'trace.json'),'utf8')),calls);
    }finally{await rm(dir,{recursive:true,force:true});}
  });
}
