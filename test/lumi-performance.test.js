import test from "node:test";
import assert from "node:assert/strict";
import { performanceFromPCM, validatePerformance, talkingExpression } from "../lib/lumi-performance.js";
import { createTimeline } from "../lib/story-timeline.js";

const production={version:"lumi-story-v2",role:"question",pause_after_seconds:2,focus:{kind:"count",value:"3",color:"yellow"}};
test("mouth follows actual speech energy and stays closed in response pauses",()=>{
  const pcm=Buffer.alloc(8000*4);
  for (let i=1600;i<4800;i++) pcm.writeFloatLE(.2*Math.sin(2*Math.PI*220*i/8000),i*4);
  const timeline=createTimeline(1,production),p=performanceFromPCM(pcm,timeline);
  assert.equal(p.talking.length,1);
  assert.ok(p.talking[0][0]>=5 && p.talking[0][0]<=7);
  assert.ok(p.talking[0][1]>=17 && p.talking[0][1]<=20);
  assert.ok(p.talking.every(([,end])=>end<=timeline.audio_frames));
  assert.equal(performanceFromPCM(Buffer.alloc(8000*4),timeline).talking.length,0);
  assert.throws(()=>validatePerformance({...p,talking:[[0,timeline.frames]]},timeline),/no coincide/);
  assert.throws(()=>validatePerformance({...p,talking:[["0;exec",2]]},timeline),/no coincide/);
  assert.match(talkingExpression(p),/^gte\(n,\d+\)\*lt\(n,\d+\)$/);
});
