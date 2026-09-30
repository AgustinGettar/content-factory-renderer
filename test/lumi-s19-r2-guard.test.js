import test from "node:test";
import assert from "node:assert/strict";
import { R2, validateR2, claimR2, dispatchR2, patchR2 } from "../lib/lumi-s19-r2-guard.js";

function fakeDb() {
  const rows = [];
  return { rows, from(table) {
    assert.equal(table, "lumi_pilot_runs");
    const q = { filters: {}, select() { return this; }, eq(k,v) { this.filters[k]=v; return this; },
      insert(row) { this.newRow=row; return this; }, update(patch) { this.patch=patch; return this; },
      resolve() {
        if(this.newRow) {
          if(rows.some(r=>r.pilot_id===this.newRow.pilot_id&&r.scene_id===this.newRow.scene_id&&r.stage===this.newRow.stage)) return {error:{code:"23505"}};
          const row={id:String(rows.length+1),...this.newRow}; rows.push(row); return {data:{...row},error:null};
        }
        const row=rows.find(r=>Object.entries(this.filters).every(([k,v])=>r[k]===v));
        if(row&&this.patch) Object.assign(row,this.patch);
        return {data:row?{...row}:null,error:null};
      }, async single(){return this.resolve();},async maybeSingle(){return this.resolve();} };
    return q;
  } };
}
const env={LUMI_RUNTIME_ENV:"staging",LUMI_S19_R2_ENABLED:"true"};
const args={env,revision:R2.revision,sceneId:"s19",stage:"IMAGE",estimatedUsd:0.103052};

test("R2 distinct identity with terminal provenance; original patch forbidden", async()=>{
  const db=fakeDb();const row=await claimR2({...args,supabase:db});
  assert.notEqual(row.pilot_id,"lumi_cinco_huevos_v1");
  assert.equal(row.result.lineage.parent_asset_id,R2.parentAssetId);
  assert.equal(row.result.lineage.parent_image_request_id,R2.parentImageRequest);
  assert.equal(row.result.lineage.parent_video_request_id,R2.parentVideoRequest);
  await assert.rejects(patchR2(db,{pilot_id:"lumi_cinco_huevos_v1",scene_id:"s19"},{}),/immutable/);
});
test("only R2 authorized; production, other scenes and disabled rejected",()=>{
  for(const bad of [{env:{...env,LUMI_RUNTIME_ENV:"production"}},{sceneId:"s18"},{revision:"s19"},{revision:"s19-r3"},{env:{...env,LUMI_S19_R2_ENABLED:"false"}}])
    assert.throws(()=>validateR2({...args,...bad}));
});
test("one image, duplicates rejected even after restart",async()=>{
  const db=fakeDb();const row=await claimR2({...args,supabase:db});let calls=0;
  await dispatchR2({supabase:db,row,fetchImpl:async()=>{calls++;return {headers:{get:()=>"req_new"}};},url:"stub",options:{}});
  assert.equal(calls,1);assert.equal(row.provider_request_id,"req_new");
  await assert.rejects(claimR2({...args,supabase:db}),/duplicate/);
  await assert.rejects(dispatchR2({supabase:db,row,fetchImpl:()=>{calls++;},url:"stub"}),/consumed/);
  assert.equal(calls,1);
});
test("ambiguous image dispatch has no retry",async()=>{
  const db=fakeDb();const row=await claimR2({...args,supabase:db});let calls=0;
  await assert.rejects(dispatchR2({supabase:db,row,fetchImpl:()=>{calls++;throw Error("crash");},url:"stub"}),/crash/);
  assert.equal(row.result.dispatch_consumed,true);
  await assert.rejects(claimR2({...args,supabase:db}),/duplicate/);assert.equal(calls,1);
});
test("Kling requires passing new source; maximum once",async()=>{
  const db=fakeDb();const image=await claimR2({...args,supabase:db});
  await assert.rejects(claimR2({...args,supabase:db,stage:"VIDEO",estimatedUsd:0.231}),/qa_required/);
  await patchR2(db,image,{status:"SUCCEEDED",result:{...image.result,visual_qa:{accepted:true,blocker_count:0}}});
  const video=await claimR2({...args,supabase:db,stage:"VIDEO",estimatedUsd:0.231});let calls=0;
  await dispatchR2({supabase:db,row:video,fetchImpl:async()=>{calls++;return {headers:{get:()=>null}};},url:"stub"});
  await assert.rejects(claimR2({...args,supabase:db,stage:"VIDEO",estimatedUsd:0.231}),/duplicate/);assert.equal(calls,1);
});
test("budget and concurrent duplicate guards",async()=>{
  const db=fakeDb();await assert.rejects(claimR2({...args,supabase:db,estimatedUsd:0.16}),/budget/);
  const results=await Promise.allSettled([claimR2({...args,supabase:db}),claimR2({...args,supabase:db})]);
  assert.equal(results.filter(r=>r.status==="fulfilled").length,1);
});
