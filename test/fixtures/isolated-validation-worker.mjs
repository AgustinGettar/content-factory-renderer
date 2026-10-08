import {readFileSync,writeFileSync,renameSync,existsSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {MemoryLumiRecoveryStore} from '../../lib/lumi-recovery-incident-manager-v1.js';
import {isolatedFixture} from './isolated-validation-v2.js';
const [directory,mode,point]=process.argv.slice(2);mkdirSync(directory,{recursive:true});
const read=(name,fallback)=>existsSync(join(directory,name))?JSON.parse(readFileSync(join(directory,name),'utf8')):fallback;
const save=(name,value)=>{const p=join(directory,name);writeFileSync(p+'.tmp',JSON.stringify(value));renameSync(p+'.tmp',p);};
class DiskStore extends MemoryLumiRecoveryStore{
  constructor(){super();this.episodes=new Map(read('rows.json',[]));}
  async putEpisode(v){const result=await super.putEpisode(v);save('rows.json',[...this.episodes]);return result;}
}
const phases=['CONTEXT','CREATE','RESUME','REVIEW','RESULT'];
const target={CONTEXT_PERSISTED:'CONTEXT',CREATE_AFTER_AUTHORIZATION:'CREATE',CREATE_PERSISTED:'CREATE',
  RESUME_AFTER_MATERIALIZATION:'RESUME',RESUME_PERSISTED:'RESUME',REVIEW_AFTER_PERSISTENCE:'REVIEW',
  CONTINUATION_BEFORE_CHECKPOINT:'REVIEW',RESULT_PERSISTED:'RESULT'}[point];
const f=await isolatedFixture({store:new DiskStore(),request:read('request.json'),base:read('base.json'),
  // Virtual time advances in the new process to model a lease timeout. No sleep
  // or database tampering, and both HMAC validity and context TTL remain checked.
  clock:()=>Date.now()+(mode==='recover'?61000:0),
  inject:async e=>{if(mode==='crash'&&e.point===point){process.stdout.write('KILL_NOW\n');await new Promise(()=>{setInterval(()=>{},1000);});}}});
if(mode==='prepare'){
  save('request.json',f.request);save('base.json',f.base);
  for(const phase of phases.slice(0,phases.indexOf(target))){const r=await f.runPhase(phase);if(r.code!==200)throw Error(JSON.stringify(r.value));}
}else{
  for(const phase of phases.slice(phases.indexOf(target))){const r=await f.runPhase(phase);if(r.code!==200)throw Error(JSON.stringify(r.value));}
  const v=await f.read();
  process.stdout.write(JSON.stringify({operation_rows:f.store.episodes.size,review_rows:v.review.state.reviews.length,
    result:v.results.RESULT,provider_generation_calls:0,production_access:f.forbidden,
    runner_enabled:v.checkpoint.runner_enabled,autorun:v.checkpoint.autorun,
    claims:Object.keys(v.review.state.production_commands).length,guard_attempts:globalThis.LUMI_OFFLINE_GUARD.attempts})+'\n');
}
await f.cleanup();
