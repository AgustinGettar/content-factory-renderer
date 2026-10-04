
import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {MemoryLumiRecoveryStore,LumiRecoveryIncidentManager} from "../lib/lumi-recovery-incident-manager-v1.js";
import {buildThirdShotPack} from "../lib/lumi-third-shot-pack-v1.js";
const plan=JSON.parse(readFileSync(new URL("../episodes/ep_lumi_flores_003/EPISODE_PLAN_V2.json",import.meta.url)));
const sources=["s31","s32","s33","s34","s35","s36"].map((scene_id,i)=>({scene_id,content_hash:String(i+1).repeat(64),result:{visual_qa:{classification:"PASS"}}}));
const quotes=sources.map((s,i)=>({scene:s.scene_id,model:"kling-video/v3.0/std/image-to-video",duration_seconds:i<4?4:5,estimated_cost_usd:i<4?0.286:0.357}));
const fresh=()=>buildThirdShotPack(plan,{sources,quotes});
async function setup(){
 const store=new MemoryLumiRecoveryStore(),manager=new LumiRecoveryIncidentManager({store});
 await manager.startEpisode({episodeId:plan.episode.id,authorizedCeilingUsd:3.05,actions:[{key:"image:s36",stage:"IMAGE",scene_id:"s36"},{key:"image:s37",stage:"IMAGE",scene_id:"s37"},{key:"tts_storage_gate",stage:"TTS_STORAGE_GATE"}],metadata:{resume_count:1,provider_reconciliation:{classification:"REQUEST_STATE_REMAINS_AMBIGUOUS"}}});
 await manager.completeAction(plan.episode.id,"image:s36",{artifact:{sha256:"original"},evidence:{provider_succeeded:true,artifact_persisted:true,sha_verified:true,artifact_verified:true},actualCostUsd:0.591597});
 await manager.pause({episodeId:plan.episode.id,sceneId:"s37",stage:"IMAGE",errorClass:"PROVIDER_API_FAILURE",reason:"original ambiguous attempt",firstPendingAction:"image:s37",safeResumeAvailable:false});
 await manager.checkpoint(plan.episode.id,s=>{s.actions[1].dispatch_state="EMISSION_AMBIGUOUS";});
 return {store,manager};
}
test("cost replan preserves ambiguous history and resumes same episode once without providers",async()=>{
 const {store,manager}=await setup(),before=await store.getEpisode(plan.episode.id),pack=fresh();
 const result=await manager.installCostOptimizedAssetReplan(plan.episode.id,{pack,plan,freshQuotes:true});
 assert.equal(result.status,"RUNNING");assert.equal(result.resumes,2);assert.equal(result.provider_calls,0);assert.equal(result.first_pending_action,"video:q31");
 const after=await store.getEpisode(plan.episode.id);
 assert.deepEqual(after.metadata.asset_replan_archive.actions,before.actions);
 assert.equal(after.current_cost_usd,0.591597);assert.equal(after.authorized_ceiling_usd,3.05);
 assert.equal((await store.getIncident(before.active_incident_id)).retryability,"RESOLVED_BY_COST_OPTIMIZED_ASSET_REPLAN");
 await manager.installCostOptimizedAssetReplan(plan.episode.id,{pack,plan,freshQuotes:true});
 assert.equal((await store.getEpisode(plan.episode.id)).metadata.resume_count,2);
 assert.deepEqual(after.actions.filter(a=>a.stage==="VIDEO").map(a=>a.scene_id),["q31","q32","q33","q34","q37","q39"]);
 assert.equal(after.actions.filter(a=>a.stage==="IMAGE").length,1);
});
test("stale or over-budget replan never resolves the original incident",async()=>{
 const {store,manager}=await setup();
 await assert.rejects(()=>manager.installCostOptimizedAssetReplan(plan.episode.id,{pack:fresh(),plan,freshQuotes:false}),/blocked/);
 const pack=fresh();pack.projected_visual_cost_usd=3;
 await assert.rejects(()=>manager.installCostOptimizedAssetReplan(plan.episode.id,{pack,plan,freshQuotes:true}),/blocked/);
 assert.equal((await store.getEpisode(plan.episode.id)).status,"PAUSED_INCIDENT");
});
test("installed execution stops for QA and persists before each following provider",()=>{
 const source=readFileSync(new URL("../lib/lumi-third-shot-pack-runtime-v1.js",import.meta.url),"utf8");
 assert.ok(source.includes('pending?.stage==="TEMPORAL_QA"'));
 assert.ok(source.indexOf("await manager.recordRequest")<source.indexOf("const terminal=await pollRequest"));
 assert.ok(source.indexOf("if(projected>2.55)")<source.indexOf("const accepted=await providerJson"));
 assert.ok(source.includes("Math.abs(verification.duration-shot.duration_seconds)>0.12"));
 assert.ok(source.includes("expectedSha256!==row.content_hash"));
});
