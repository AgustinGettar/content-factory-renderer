import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {MemoryLumiRecoveryStore,LumiRecoveryIncidentManager} from '../lib/lumi-recovery-incident-manager-v1.js';
const plan=JSON.parse(readFileSync(new URL('../episodes/ep_lumi_flores_003/EPISODE_PLAN_V2.json',import.meta.url)));
const pack=JSON.parse(readFileSync(new URL('../episodes/ep_lumi_flores_003/SHOT_PACK_V1.json',import.meta.url)));
async function fixture({runRows=[],journalRows=[],queryError=null,mutate=()=>{}}={}){
 const store=new MemoryLumiRecoveryStore();
 const queries=[];
 store.supabase={from(table){const q={table,filters:[],select(){return this;},eq(k,v){this.filters.push([k,v]);return this;},in(k,v){this.filters.push([k,v]);return this;},then(resolve){queries.push(this);return Promise.resolve({data:table==='lumi_pilot_runs'?runRows:journalRows,error:queryError}).then(resolve);}};return q;}};
 const state={episode_id:'ep_lumi_flores_003',status:'PAUSED_INCIDENT',first_pending_action:'video:q31',active_incident_id:'incident',current_cost_usd:pack.confirmed_visual_spend_usd,authorized_ceiling_usd:3.05,metadata:{visual_shot_pack:pack,resume_count:2},actions:[{key:'video:q31',stage:'VIDEO',scene_id:'q31',status:'PENDING',dispatch_state:'NOT_DISPATCHED',provider_request_id:null,evidence:{}}]};
 const incident={incident_id:'incident',status:'OPEN',scene_id:'q31',stage:'VIDEO_PREFLIGHT',error_class:'UNEXPECTED_RUNTIME_ERROR',reason:'JSONB_OBJECT_KEY_ORDER_FALSE_FULL_HD_MASTER_LOCK: fixed',retryability:'DETERMINISTIC_REPAIR_READY_NO_PROVIDER_CONTINUATION'};
 mutate(state,incident);
 await store.putEpisode(state);await store.putIncident(incident);
 return {store,manager:new LumiRecoveryIncidentManager({store}),queries};
}
test('same installed pack resumes repaired preflight before emission exactly once',async()=>{
 const {manager,store,queries}=await fixture();
 const result=await manager.installCostOptimizedAssetReplan('ep_lumi_flores_003',{pack,plan,freshQuotes:true});
 assert.equal(result.status,'RUNNING');assert.equal(result.resumes,3);assert.equal(result.provider_calls,0);
 assert.equal(result.incident_resolution,'RESOLVED_BEFORE_PROVIDER_EMISSION');
 assert.equal((await store.getIncident('incident')).status,'RESOLVED');
 const next=await store.getEpisode('ep_lumi_flores_003');
 assert.equal(next.current_cost_usd,0.591597);assert.equal(next.actions[0].provider_request_id,null);
 assert.equal(next.first_pending_action,'video:q31');
 assert.ok(queries[0].filters.some(([k,v])=>k==='pilot_id'&&v==='lumi_tres_flores_colores_v1'));
 await manager.installCostOptimizedAssetReplan('ep_lumi_flores_003',{pack,plan,freshQuotes:true});
 assert.equal((await store.getEpisode('ep_lumi_flores_003')).metadata.resume_count,3);
});
for(const [name,options] of [
 ['existing video ledger',{runRows:[{provider_request_id:'existing'}]}],
 ['existing emission journal',{journalRows:[{state:'EMITTING'}]}],
 ['ledger query error',{queryError:{message:'failure'}}],
 ['ambiguous dispatch',{mutate:s=>{s.actions[0].dispatch_state='EMISSION_AMBIGUOUS';}}],
 ['existing checkpoint job',{mutate:s=>{s.actions[0].provider_request_id='existing';}}],
 ['wrong incident',{mutate:(s,i)=>{i.stage='TEMPORAL_QA';}}]
])test(name+' keeps incident paused without provider continuation',async()=>{
 const {manager,store}=await fixture(options);
 await assert.rejects(manager.installCostOptimizedAssetReplan('ep_lumi_flores_003',{pack,plan,freshQuotes:true}));
 assert.equal((await store.getEpisode('ep_lumi_flores_003')).status,'PAUSED_INCIDENT');
 assert.equal((await store.getIncident('incident')).status,'OPEN');
});
