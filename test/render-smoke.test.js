import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { renderScene } from "../lib/render-media.js";
import { renderProfile } from "../lib/render-profiles.js";
const exec = promisify(execFile);
for (const stage of ["preview","final"]) {
 test("real FFmpeg encodes the " + stage + " profile without network or AI", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(),"cf-profile-test-"));
  try {
   const image=path.join(dir,"image.png"),audio=path.join(dir,"voice.wav"),text=path.join(dir,"caption.txt"),out=path.join(dir,"video.mp4");
   await exec("ffmpeg",["-v","error","-f","lavfi","-i","color=c=lavender:s=180x320","-frames:v","1","-threads","1",image]);
   await exec("ffmpeg",["-v","error","-f","lavfi","-i","anullsrc=r=48000:cl=stereo","-t","0.4",audio]);
   await fs.writeFile(text,"A de aprender\n100% {Lumi}","utf8");
   const profile=renderProfile(stage);
   await renderScene(image,audio,text,out,true,profile,{timeoutMs:60000});
   const {stdout}=await exec("ffprobe",["-v","error","-show_entries","stream=codec_type,codec_name,width,height,r_frame_rate","-of","json",out]);
   const streams=JSON.parse(stdout).streams;
   const picture=streams.find(x=>x.codec_type==="video"),sound=streams.find(x=>x.codec_type==="audio");
   assert.equal(picture.width,profile.width);assert.equal(picture.height,profile.height);
   assert.equal(picture.r_frame_rate,"30/1");assert.equal(picture.codec_name,"h264");assert.equal(sound.codec_name,"aac");
  } finally { await fs.rm(dir,{recursive:true,force:true}); }
 });
}
