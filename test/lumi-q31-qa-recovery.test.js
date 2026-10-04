import test from 'node:test';
import assert from 'node:assert/strict';
import {MemoryLumiRecoveryStore,LumiRecoveryIncidentManager} from '../lib/lumi-recovery-incident-manager-v1.js';
import {resumeQ31QaMetadata} from '../lib/lumi-third-shot-pack-runtime-v1.js';
const hash='b'.repeat(64),job='existing-q31';
async function fixture(mutate=()=>{}) {
 const store=new MemoryLumiRecoveryStore(),manager=new LumiRecoveryIncidentManager({store});
 const evidence={provider_succeeded:true,artifact_persisted:true,sha_verified:true,artifact_verified:true};
 const state={episode_id:'ep_lumi_flores_003',status:'PAUSED_INCIDENT',active_incident_id:'incident',first_pending_action:'temporal_qa:q31',current_cost_usd:0.877597,metadata:{resume_count:3},actions:[{key:'video:q31',status:'COMPLETE',provider_request_id:job,artifact:{sha256:hash},evidence},{key:'temporal_qa:q31',status:'PENDING',dispatch_state:'NOT_DISPATCHED',evidence:{}},{key:'video:q32',status:'PENDING',dispatch_state:'NOT_DISPATCHED',evidence:{}}]};
 const incident={incident_id:'incident',status:'OPEN',scene_id:'q31',stage:'TEMPORAL_QA_HANDOFF',reason:'TEMPORAL_QA_SHA_BINDING_NOT_FORWARDED: fixed'};
 const row={id:'row',scene_id:'q31',status:'SUCCEEDED',provider_request_id:job,content_hash:hash,storage_bucket:'bucket',storage_path:'original.mp4',result:{actual_cost_usd:null}};
 const journal=[{scene_id:'q31',state:'ACKNOWLEDGED',provider_request_id:job}];
 const verification={ok:true,sha256:hash,decode:'PASS',duration:4.042,scan:{blackFrames:0,freezes:0}};
 mutate({state,incident,row,journal,verification});
 await store.putEpisode(state);await store.putIncident(incident);
 let writes=0;
 const supabase={from(table){return {select(){return this;},eq(){return this;},update(v){this.value=v;return this;},single(){writes++;Object.assign(row,this.value);return Promise.resolve({data:row});},then(resolve){return Promise.resolve({data:table==='lumi_pilot_runs'?[row]:journal}).then(resolve);}};},storage:{from(){return {download:async()=>({data:new Blob(['existing bytes'])})};}}};
 return {store,manager,row,supabase,verification,writes:()=>writes};
}
test('recovery retains identity and cost, resolves locally and advances to q32 once',async()=>{
 const f=await fixture();const args={...f,expectedSha256:hash,classification:'PASS',verify:async()=>f.verification};
 const r=await resumeQ31QaMetadata(args);
 assert.equal(r.resumes,4);assert.equal(r.provider_calls,0);assert.equal(r.first_pending_action,'video:q32');
 const state=await f.store.getEpisode('ep_lumi_flores_003');
 assert.equal(state.current_cost_usd,0.877597);assert.equal(state.actions[0].provider_request_id,job);
 assert.equal(f.row.result.temporal_qa.sha256,hash);assert.equal(f.row.result.cost_status,'ESTIMATED_PENDING_RECONCILIATION');
 assert.equal((await f.store.getIncident('incident')).retryability,'RESOLVED_LOCAL_METADATA_PERSISTENCE');
 await assert.rejects(resumeQ31QaMetadata(args));
 assert.equal((await f.store.getEpisode('ep_lumi_flores_003')).metadata.resume_count,4);
});
for(const [name,mutate] of [
 ['job',f=>f.row.provider_request_id='other'],['hash',f=>f.row.content_hash='other'],
 ['incident',f=>f.incident.stage='VIDEO'],['ambiguous journal',f=>f.journal[0].state='EMITTING'],
 ['duplicate journal',f=>f.journal.push({...f.journal[0]})],['decode',f=>f.verification.decode='FAIL'],
 ['black frames',f=>f.verification.scan.blackFrames=1],['freeze',f=>f.verification.scan.freezes=1],
 ['duration',f=>f.verification.duration=5]
])test('invalid '+name+' keeps incident open before any write',async()=>{
 const f=await fixture(mutate);
 await assert.rejects(resumeQ31QaMetadata({...f,expectedSha256:hash,classification:'PASS',verify:async()=>f.verification}));
 assert.equal(f.writes(),0);assert.equal((await f.store.getEpisode('ep_lumi_flores_003')).status,'PAUSED_INCIDENT');
 assert.equal((await f.store.getIncident('incident')).status,'OPEN');
});
