import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {buildThirdShotPack,validateThirdShotPack,validateShotPackAudio,shotPackResumeGate,MASTER_LOCK} from '../lib/lumi-third-shot-pack-v1.js';
// This suite's source plan is supplied as a frozen fixture in the repository.
const plan=JSON.parse(readFileSync(new URL('../episodes/ep_lumi_flores_003/EPISODE_PLAN_V2.json',import.meta.url)));
const sources=['s31','s32','s33','s34','s35','s36'].map((scene_id,i)=>({scene_id,content_hash:String(i+1).repeat(64),result:{visual_qa:{classification:'PASS'}}}));
const quotes=sources.map(s=>({scene:s.scene_id,model:'kling-video/v3.0/std/image-to-video',estimated_cost_usd:0.357}));
const fresh=()=>buildThirdShotPack(plan,{sources,quotes});
test('nine distinct pedagogical beats use six animated source clips and zero new images',()=>{
 const p=fresh();assert.equal(validateThirdShotPack(p,plan,{requireSourceQa:true}).status,'PASS');
 assert.equal(p.beats.length,9);assert.equal(p.shots.length,6);assert.equal(p.image_calls,0);assert.equal(p.generated_video_seconds,30);
 assert.deepEqual(p.local_only_beats,['s35','s36','s38']);assert.equal(p.timeline_seconds,47);
});
test('removing, reordering or duplicating a beat blocks execution',()=>{
 for(const mutate of [p=>p.beats.pop(),p=>p.beats.reverse(),p=>p.beats[5]=p.beats[4]]){const p=fresh();mutate(p);assert.equal(validateThirdShotPack(p,plan).status,'FAIL');}
});
test('narration is retained once per beat; duplicate utterance fails',()=>{
 const p=fresh();p.beats[4].narration_ids.push(p.beats[0].narration_ids[0]);assert.ok(validateThirdShotPack(p,plan).errors.includes('NO_DUPLICATED_NARRATION'));
});
test('seventh video, second image and over-30-second generation are rejected',()=>{
 for(const mutate of [p=>p.shots.push({...p.shots[0],id:'extra'}),p=>p.image_calls=2,p=>p.generated_video_seconds=31]){const p=fresh();mutate(p);assert.equal(validateThirdShotPack(p,plan).status,'FAIL');}
});
test('all educational colors require genuine animated performances',()=>{
 for(const color of ['red','yellow','blue']){const p=fresh();p.shots.find(s=>s.performance===color).performance='generic';assert.ok(validateThirdShotPack(p,plan).errors.includes(`COLOR:${color}`));}
});
test('a static pan or stretched footage cannot replace a performance',()=>{
 const p=fresh();p.shots[1].generated_character_motion=false;assert.equal(validateThirdShotPack(p,plan).status,'FAIL');
 const q=fresh();q.beats[6].segments[0].speed=0.5;assert.equal(validateThirdShotPack(q,plan).status,'FAIL');
});
test('question retains 2.5 seconds; narration is never clipped to make it fit',()=>{
 const p=fresh();const timing=Object.fromEntries(p.beats.map(b=>[b.id,2]));assert.equal(validateShotPackAudio(p,timing).status,'PASS');
 timing.s37=2.6;assert.equal(validateShotPackAudio(p,timing).status,'FAIL');
 p.beats[6].pause_seconds=0;assert.equal(validateThirdShotPack(p,plan).status,'FAIL');
});
test('text exclusion and technical pause-label suppression remain enforced',()=>{
 for(const mutate of [p=>p.beats[6].technical_pause_label=true,p=>p.beats[0].text_overlay=['Lumi']]){const p=fresh();mutate(p);assert.equal(validateThirdShotPack(p,plan).status,'FAIL');}
});
test('cost includes sunk confirmed images and fits USD 2.85',()=>{
 const p=fresh();assert.equal(p.incremental_visual_cost_usd,2.142);assert.equal(p.projected_visual_cost_usd,2.733597);
 p.projected_visual_cost_usd=2.850001;assert.equal(validateThirdShotPack(p,plan).status,'FAIL');
});
test('Full HD master encoding is unchanged; lowering quality fails',()=>{
 const p=fresh();assert.deepEqual(p.master,MASTER_LOCK);p.master.height=1280;assert.equal(validateThirdShotPack(p,plan).status,'FAIL');
});
test('pending or blocked source QA never becomes a pass through asset reuse',()=>{
 const p=fresh();p.shots[4].source_qa='BLOCKER';assert.equal(validateThirdShotPack(p,plan,{requireSourceQa:true}).status,'FAIL');
});
test('Grok cannot enter the current Shot Pack',()=>{
 const p=fresh();p.shots[0].model='grok-video-1.5-lite';assert.ok(validateThirdShotPack(p,plan).errors.includes('APPROVED_KLING_ONLY'));
});
test('changed per-shot quote cannot hide behind a stale total',()=>{
 const p=fresh();p.shots[0].estimated_cost_usd=0.9;assert.ok(validateThirdShotPack(p,plan).errors.includes('COST_TOTALS_RECOMPUTED'));
});
test('recap shows the group and closing retains a measured breath',()=>{
 const p=fresh();p.beats[4].segments.pop();assert.ok(validateThirdShotPack(p,plan).errors.includes('RECAP_THREE_FLOWERS_TOGETHER'));
 const q=fresh();q.beats[8].breath_seconds=0;assert.ok(validateThirdShotPack(q,plan).errors.includes('CLOSING_BREATH_PRESERVED'));
 const durations=Object.fromEntries(fresh().beats.map(b=>[b.id,2]));durations.s39=5.1;assert.equal(validateShotPackAudio(fresh(),durations).status,'FAIL');
});
test('visual affordability alone cannot resume or resolve s37 without complete USD preflight',()=>{
 const blocked=shotPackResumeGate(fresh(),plan);assert.equal(blocked.status,'BLOCKED');assert.equal(blocked.resolve_s37_allowed,false);assert.equal(blocked.balance.recommended_top_up_usd,null);
 const pass=shotPackResumeGate(fresh(),plan,{benchmarkUsd:0.01,fullTtsUsd:0.1,freshQuotes:true});assert.equal(pass.status,'PASS');assert.equal(pass.resolve_s37_allowed,true);
 const over=shotPackResumeGate(fresh(),plan,{benchmarkUsd:0.01,fullTtsUsd:0.9,freshQuotes:true});assert.ok(over.reasons.includes('EPISODE_USD_CEILING'));
});
