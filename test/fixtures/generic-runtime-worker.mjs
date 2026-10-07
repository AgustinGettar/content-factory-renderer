// Disk-backed isolated input/storage harness. No executor implementation lives here.
import {readFileSync,writeFileSync,renameSync,existsSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {MemoryLumiRecoveryStore} from '../../lib/lumi-recovery-incident-manager-v1.js';
import {MemoryReviewStore} from '../../lib/telegram-review-v1/core.js';
import {runtimeFixture,seedPersistedVideos,reviewCallback} from './generic-runtime-v2.js';
const [directory,mode,point]=process.argv.slice(2);mkdirSync(directory,{recursive:true});
const read=(name,fallback)=>existsSync(join(directory,name))?JSON.parse(readFileSync(join(directory,name),'utf8')):fallback;
const save=(name,value)=>{const p=join(directory,name);writeFileSync(p+'.tmp',JSON.stringify(value));renameSync(p+'.tmp',p);};
class DiskCheckpointStore extends MemoryLumiRecoveryStore{
  constructor(){super();this.episodes=new Map(read('episodes.json',[]));this.incidents=new Map(read('incidents.json',[]));}
  async putEpisode(v){const r=await super.putEpisode(v);save('episodes.json',[...this.episodes]);return r;}
  async putIncident(v){const r=await super.putIncident(v);save('incidents.json',[...this.incidents]);return r;}
}
class DiskReviewStore extends MemoryReviewStore{
  constructor(){super();this.rows=new Map(read('reviews.json',[]));}
  async create(...args){const r=await super.create(...args);save('reviews.json',[...this.rows]);return r;}
  async cas(...args){const r=await super.cas(...args);save('reviews.json',[...this.rows]);return r;}
}
const objects=new Map(read('objects.json',[]).map(([k,b])=>[k,Buffer.from(b,'base64')])),journalRows=new Map(read('journal.json',[]));
const f=await runtimeFixture({request:read('request.json',null),store:new DiskCheckpointStore(),reviewStore:new DiskReviewStore(),objects,journalRows,
  inject:async event=>{if(mode==='crash'&&event.point===point){process.stdout.write('KILL_NOW\n');await new Promise(()=>{setInterval(()=>{},1000);});}}});
if(mode==='prepare'){
  save('request.json',f.request);
  if(point!=='CREATE_AFTER_AUTHORIZATION')await f.create();
  if(['REVIEW_AFTER_PERSISTENCE','CONTINUATION_BEFORE_CHECKPOINT'].includes(point)){
    await seedPersistedVideos(f);await f.production.resume({user:'1',episodeId:f.episodeId});save('callback.json',await reviewCallback(f));
  }
  save('objects.json',[...objects].map(([k,b])=>[k,b.toString('base64')]));save('journal.json',[...journalRows]);
}else{
  if(point==='CREATE_AFTER_AUTHORIZATION')await f.create();
  else if(point==='RESUME_AFTER_MATERIALIZATION')await f.production.resume({user:'1',episodeId:f.episodeId});
  else await f.service.callback(read('callback.json'));
  const state=await f.store.getEpisode(f.episodeId),row=await f.reviewStore.get('1');
  process.stdout.write(JSON.stringify({episode_rows:f.store.episodes.size,review_rows:row.state.reviews.length,
    stage_results:Object.keys(state.metadata.stage_results||{}),first_pending_action:state.first_pending_action,
    active_incident_id:state.active_incident_id,status:state.status,runner_enabled:state.runner_enabled,autorun:state.autorun,
    claims:Object.keys(row.state.production_commands||{}).length,...f.counters(),guard_attempts:globalThis.LUMI_OFFLINE_GUARD.attempts})+'\n');
}
