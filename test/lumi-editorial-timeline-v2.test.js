import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {buildEditorialTimeline,naturalSegments,estimateNarration} from '../lib/lumi-editorial-timeline-v2.js';
import {buildAssemblyCommand,executeAssemblyCommand} from '../lib/lumi-third-short-master-v1.js';
import {sha256} from '../lib/telegram-review-v1/core.js';
import {compileStudioPreparation} from '../lib/telegram-mini-app/preparation.js';
const exec=promisify(execFile),base={shot_id:'take_1',source_sha:'a'.repeat(64),voice_sha:'b'.repeat(64),source_duration_seconds:5,voice_duration_seconds:1,duration:3};
test('natural timeline preserves five seconds despite a three-second legacy editorial target; cuts require a resolved action',()=>{
 const t=buildEditorialTimeline([base]);assert.equal(t.duration_seconds,5);assert.equal(t.decisions[0].source_out,5);
 assert.throws(()=>buildEditorialTimeline([{...base,source_out:3}]),/CUT_REVIEW/);
 assert.throws(()=>buildEditorialTimeline([{...base,source_duration_seconds:3,action_complete:false}]),/ACTION_INCOMPLETE/);
 assert.equal(buildEditorialTimeline([{...base,source_out:3,action_complete:true,cut_reason:'Human verified resolution before 3 s'}]).duration_seconds,3);
});
test('voice, sound tail, response pause and transition are real constraints, never automatic trim or time stretching',()=>{
 assert.throws(()=>buildEditorialTimeline([{...base,voice_duration_seconds:5.1}]),/TIMING_REVIEW/);
 assert.equal(buildEditorialTimeline([{...base,voice_duration_seconds:2.5,pause:2.5}]).decisions[0].effective_post_voice_seconds,2.5);
 assert.throws(()=>buildEditorialTimeline([{...base,voice_duration_seconds:2.51,pause:2.5}]),/TIMING_REVIEW/);
 assert.throws(()=>buildEditorialTimeline([{...base,pause:2.5,transition:'FADE',transition_overlap_seconds:.3}]),/TRANSITION_REVIEW/);
 assert.equal(buildEditorialTimeline([{...base,voice_duration_seconds:.5}]).duration_seconds,5);
 assert.equal(estimateNarration('Una flor azul').measured,false);
});
test('real ffmpeg: fractional 24 fps and nonzero PTS become a sample/frame aligned master without cropping or clipping voice',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'lumi-editorial-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const video=join(dir,'source.mp4'),audio=join(dir,'voice.wav');
 await exec('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=180x318:rate=24','-frames:v','97','-vf','setpts=PTS+2/TB','-c:v','libx264','-preset','ultrafast',video]);
 await exec('ffmpeg',['-v','error','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','1.2','-c:a','pcm_s16le',audio]);
 const s={...base,source_sha:sha256(await readFile(video)),voice_sha:sha256(await readFile(audio)),videoPath:video,audioPath:audio,source_duration_seconds:97/24,voice_duration_seconds:1.2,pause:2.5,audio_start_seconds:.1};
 const output=join(dir,'master.mp4'),command=buildAssemblyCommand({segments:naturalSegments([s,s]),outputPath:output});
 await executeAssemblyCommand({command});
 const meta=JSON.parse((await exec('ffprobe',['-v','error','-show_streams','-show_format','-of','json',output])).stdout),v=meta.streams.find(s=>s.codec_type==='video'),a=meta.streams.find(s=>s.codec_type==='audio');
 assert.equal(Number(v.nb_frames),244);assert.equal(v.width,1080);assert.equal(v.height,1920);assert.equal(v.profile,'High');assert.equal(a.sample_rate,'48000');
 assert.ok(Math.abs(Number(v.duration)-244/30)<1e-6);assert.ok(Math.abs(Number(a.duration)-244/30)<=1/48000+1e-6);
 await exec('ffmpeg',['-v','error','-xerror','-i',output,'-f','null','-']);
 const pcm=await exec('ffmpeg',['-v','error','-i',output,'-map','0:a','-f','f32le','-ac','1','-'],{encoding:'buffer',maxBuffer:4e6});
 const floats=new Float32Array(pcm.stdout.buffer,pcm.stdout.byteOffset,pcm.stdout.byteLength/4),rms=(start,end)=>{const x=floats.slice(Math.ceil(start*48000),Math.floor(end*48000));return Math.sqrt(x.reduce((n,v)=>n+v*v,0)/x.length);};
 assert.ok(rms(.15,1.25)>.02);assert.ok(rms(1.26,1.29)>.01,'the measured audio tail is retained');assert.ok(rms(1.35,3.85)<.001,'the full 2.5 s pause is audible silence, not only declared metadata');
 assert.equal(command.editorial_timeline.decisions[1].timeline_in,122/30);
 console.log('PASS_REAL_LOCAL_TIMELINE: 244 frames, 8.133333 s, measured 2.5 s silence, SHA '+sha256(await readFile(output)));
});
test('Studio authored plan accepts different lengths; estimates voice before paid generation and preserves source profile',()=>{
 const input={title:'Lumi y el azul',idea:'Una flor para reconocer el azul.',objective:'Reconocer el azul.',success_test:'Señalar la flor azul.',setting:'Jardín',objects:[{name:'flor',color:'azul',shape:'pétalos redondos',placement:'derecha'}],scenes:['setup','discovery','question','answer','close'].map(role=>({role,goal:'Reconocer el azul.',narration:'Mirá la flor.',duration:5}))};
 const p=compileStudioPreparation(input,'ep_studio_test');assert.equal(p.shot_plans.length,5);assert.ok(p.shot_plans.every(s=>s.source_status==='NOT_CREATED'));assert.equal(p.narration_request.voice_profile_id,'LUMI_VOICE_PROFILE_V3');
 input.scenes.splice(2,0,{role:'discovery',goal:'Observar la forma.',narration:'Mirá sus pétalos.',duration:6});assert.equal(compileStudioPreparation(input,'ep_studio_test2').shot_plans.length,6);
 input.scenes[0].narration='Una frase demasiado larga para una sola toma de cinco segundos con ritmo natural.';assert.throws(()=>compileStudioPreparation(input,'ep_studio_test3'),/NARRATION_TIME_CONFLICT/);
});

test('real VFR input keeps elapsed time and becomes a bounded CFR timeline',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'lumi-vfr-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const video=join(dir,'vfr.mp4'),audio=join(dir,'tail.wav'),out=join(dir,'out.mp4');
 await exec('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=180x320:rate=30:duration=1.1','-vf','select=not(eq(mod(n\\,7)\\,0))','-fps_mode','vfr','-c:v','libx264','-preset','ultrafast',video]);
 await exec('ffmpeg',['-v','error','-f','lavfi','-i','sine=frequency=320:sample_rate=48000:duration=0.6','-c:a','pcm_s16le',audio]);
 const probe=JSON.parse((await exec('ffprobe',['-v','error','-show_streams','-show_frames','-of','json',video])).stdout),v=probe.streams[0],times=probe.frames.map(f=>Number(f.best_effort_timestamp_time));
 assert.ok(new Set(times.slice(1).map((t,i)=>Math.round((t-times[i])*1e6))).size>1,'source really has varying frame intervals');
 const s={...base,videoPath:video,audioPath:audio,source_sha:sha256(await readFile(video)),voice_sha:sha256(await readFile(audio)),source_duration_seconds:Number(v.duration),voice_duration_seconds:.6,audio_start_seconds:.05};
 const command=buildAssemblyCommand({segments:naturalSegments([s]),outputPath:out});await executeAssemblyCommand({command});
 const result=JSON.parse((await exec('ffprobe',['-v','error','-show_streams','-of','json',out])).stdout).streams;
 console.log('VFR_TIMING',JSON.stringify({source:{duration:v.duration,start:v.start_time,frames:v.nb_frames},target:command.editorial_timeline.decisions[0].frames,output:result.map(s=>({type:s.codec_type,duration:s.duration,frames:s.nb_frames}))}));
 assert.equal(result[0].avg_frame_rate,'30/1');assert.ok(Math.abs(Number(result[0].duration)-Number(v.duration))<=1/30+1e-6);assert.ok(Math.abs(Number(result[0].duration)-Number(result[1].duration))<=1/48000+1e-6);
});
