import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { renderProfile } from "../lib/render-profiles.js";
import { createTimeline, validateProduction, validateSpokenText, verifyTimeline } from "../lib/story-timeline.js";
import { renderStoryScene, focusSVG } from "../lib/story-renderer.js";
import { analyzePerformance } from "../lib/lumi-performance.js";
const exec = promisify(execFile);
const production = {version:"lumi-story-v2",role:"question",pause_after_seconds:1.5,focus:{kind:"letter",value:"A",color:"blue"}};

test("speech is never shortened and a question leaves a real response window", () => {
  const timeline = createTimeline(2.011, production);
  assert.ok(timeline.audio_frames/30 >= 2.011);
  assert.equal(timeline.pause_frames,45);
  assert.equal(timeline.frames,112);
  assert.throws(()=>verifyTimeline({...timeline,pause_frames:0},2.011,production),/aprobada/);
  assert.throws(()=>validateProduction({...production,pause_after_seconds:0}),/pausa real/);
  assert.throws(()=>validateSpokenText("¿Qué letra es? Pausa para pensar..."),/acotaciones/);
  assert.equal(validateSpokenText("¿Qué letra es?"),"¿Qué letra es?");
});
test("counting quantities are exact and model text cannot become SVG code", () => {
  const p = validateProduction({...production,focus:{kind:"count",value:"7",color:"yellow"}});
  assert.equal((focusSVG(p.focus).match(/<polygon /g)||[]).length,7);
  assert.throws(()=>validateProduction({...production,focus:{kind:"count",value:"7;exec",color:"yellow"}}),/conteo/);
  const svg = focusSVG({kind:"label",value:"<script>hi</script>",color:"blue"});
  assert.ok(!svg.includes("script"));
});

for (const stage of ["preview","final"]) test(`story ${stage} encodes motion and exact padded A/V timing`, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(),"lumi-story-test-"));
  try {
    const imagePath=path.join(dir,"bg.png"),audioPath=path.join(dir,"speech.wav"),textPath=path.join(dir,"text.txt"),outputPath=path.join(dir,"out.mkv");
    await exec("ffmpeg",["-v","error","-f","lavfi","-i","color=c=0xDCEFED:s=360x640","-frames:v","1","-threads","1",imagePath]);
    await exec("ffmpeg",["-v","error","-f","lavfi","-i","sine=frequency=440:sample_rate=48000","-t","0.4",audioPath]);
    await fs.writeFile(textPath,"¡A de aprender!\n100% {Lumi}");
    const timeline=createTimeline(.4,production),profile=renderProfile(stage);
    const performance=await analyzePerformance(audioPath,timeline);
    await renderStoryScene({imagePath,audioPath,textPath,outputPath,production,timeline,performance,profile,timeoutMs:120000});
    const {stdout}=await exec("ffprobe",["-v","error","-show_entries","format=duration:stream=codec_type,width,height,r_frame_rate,codec_name","-of","json",outputPath]);
    const result=JSON.parse(stdout),v=result.streams.find(s=>s.codec_type==="video");
    assert.deepEqual([v.width,v.height,v.r_frame_rate],[profile.width,profile.height,"30/1"]);
    assert.equal(result.streams.find(s=>s.codec_type==="audio").codec_name,"pcm_s16le");
    assert.ok(Math.abs(Number(result.format.duration)-timeline.duration_seconds)<1/30);
    const {stderr}=await exec("ffmpeg",["-hide_banner","-i",outputPath,"-af","silencedetect=noise=-60dB:d=0.5","-f","null","-"]);
    assert.match(stderr,/silence_start: 0\.4/);
    const {stdout:hashes}=await exec("ffmpeg",["-v","error","-i",outputPath,"-vf","fps=2","-an","-f","framemd5","-"]);
    const frameHashes=hashes.split("\n").filter(l=>l && !l.startsWith("#")).map(l=>l.split(",").at(-1).trim());
    assert.ok(new Set(frameHashes).size>1,"the character and background should move");
  } finally { await fs.rm(dir,{recursive:true,force:true}); }
});
