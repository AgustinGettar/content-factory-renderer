import {createHash} from 'node:crypto';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {execFile} from 'node:child_process';
import {RATE} from '../../public/lumi-studio/editor-model.js';
const exec=promisify(execFile);
export const digest=v=>createHash('sha256').update(Buffer.isBuffer(v)||typeof v==='string'?v:JSON.stringify(v)).digest('hex');
export const fail=(c,status=409)=>{throw Object.assign(Error(c),{status});};
// Shared bounded lane for display derivatives and editorial exports. No background
// external service, provider, media upload to a social platform, or paid compute.
let occupied=false;
export async function mediaLane(work){if(occupied)fail('EDITOR_MEDIA_BUSY',503);occupied=true;try{return await work();}finally{occupied=false;}}
export async function probeFile(file){
 const p=JSON.parse((await exec('ffprobe',['-v','error','-show_streams','-show_format','-of','json',file],{timeout:30000,maxBuffer:1048576})).stdout);
 const streams=p.streams.filter(s=>['audio','video'].includes(s.codec_type)).map(s=>Object.fromEntries(['codec_type','codec_name','profile','width','height','sample_rate','channels','time_base','start_time','duration','duration_ts','avg_frame_rate','r_frame_rate'].filter(k=>s[k]!==undefined).map(k=>[k,s[k]])));
 const v=streams.find(s=>s.codec_type==='video'),a=streams.find(s=>s.codec_type==='audio');
 const ticks=s=>{const n=Number(s?.duration??p.format.duration);if(!Number.isFinite(n)||n<=0||n>180)fail('EDITOR_SOURCE_DURATION');return Math.round(n*RATE);};
 return {streams,video:!!v,audio:!!a,video_ticks:v?ticks(v):0,audio_ticks:a?ticks(a):0,duration_ticks:Math.max(v?ticks(v):0,a?ticks(a):0),measured_at:new Date().toISOString()};
}
export class EditorMedia {
 constructor({storage,loadBytes,privateBucket}){Object.assign(this,{storage,loadBytes,privateBucket});this.pending=new Map();this.cache=new Map();}
 path(owner,a){return `lumi-previews/editor-v2/${digest(String(owner))}/${a.sha256}`;}
 async original(a){if(a.size>64000000||!await this.privateBucket(a.bucket))fail('EDITOR_PRIVATE_SOURCE_REQUIRED');const b=await this.loadBytes(a);if(b.length!==a.size||digest(b)!==a.sha256)fail('EDITOR_SOURCE_INTEGRITY');return b;}
 async put(bucket,path,b,mime){try{await this.storage.upload(bucket,path,b,{contentType:mime});}catch(e){const prior=await this.storage.download(bucket,path);if(!prior||digest(prior)!==digest(b))throw e;}}
 async probe(owner,a){
  const path=this.path(owner,a)+'/probe.json',saved=await this.storage.download(a.bucket,path);
  if(saved){const v=JSON.parse(saved);if(v.sha256!==a.sha256)fail('EDITOR_SOURCE_INTEGRITY');return v;}
  const dir=await mkdtemp(join(tmpdir(),'lumi-edit-probe-'));
  try{const f=join(dir,'original');await writeFile(f,await this.original(a));const value={...await probeFile(f),sha256:a.sha256};await this.put(a.bucket,path,Buffer.from(JSON.stringify(value)),'application/json');return value;}finally{await rm(dir,{recursive:true,force:true});}
 }
 async bundle(owner,a){
  const key=this.path(owner,a),cached=this.cache.get(key);if(cached)return cached;
  const saved=await this.storage.download(a.bucket,key+'/bundle.json');if(saved){const b=JSON.parse(saved);if(b.source_sha!==a.sha256)fail('EDITOR_DERIVATIVE_INTEGRITY');this.cache.set(key,b);return b;}
  if(!this.pending.has(key)){
   if(this.pending.size)fail('EDITOR_MEDIA_BUSY',503);
   const work=mediaLane(async()=>{const dir=await mkdtemp(join(tmpdir(),'lumi-edit-media-'));try{
    const file=join(dir,'original');await writeFile(file,await this.original(a));const meta=await probeFile(file),bundle={recipe:'EDITOR_DISPLAY_1',source_sha:a.sha256,meta,files:{},waveform:null};
    const encode=async(name,args,mime)=>{const out=join(dir,name);await exec('ffmpeg',['-v','error','-nostdin','-threads','1','-filter_threads','1','-i',file,...args,'-threads','1','-y',out],{timeout:90000,maxBuffer:1048576});const bytes=await readFile(out);if(bytes.length>24000000)fail('EDITOR_DERIVATIVE_SIZE');await this.put(a.bucket,key+'/'+name,bytes,mime);bundle.files[name]={sha256:digest(bytes),size:bytes.length,mime};return bytes;};
    if(meta.video){await encode('proxy.mp4',['-an','-vf','scale=360:640:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=360:640:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30','-c:v','libx264','-preset','veryfast','-crf','28','-pix_fmt','yuv420p','-movflags','+faststart'],'video/mp4');
     await encode('thumbs.jpg',['-an','-vf',`fps=${8/(meta.video_ticks/RATE)},scale=72:128:force_original_aspect_ratio=decrease,pad=72:128:(ow-iw)/2:(oh-ih)/2,tile=8x1`,'-frames:v','1','-q:v','5'],'image/jpeg');}
    if(meta.audio){await encode('audio.wav',['-vn','-ar','48000','-ac','2','-c:a','pcm_s16le'],'audio/wav');
     const pcm=(await exec('ffmpeg',['-v','error','-nostdin','-threads','1','-i',file,'-vn','-ar','8000','-ac','1','-f','s16le','pipe:1'],{encoding:'buffer',timeout:30000,maxBuffer:4000000})).stdout;
     const count=Math.min(1200,Math.ceil(meta.audio_ticks/RATE*20)),step=Math.ceil(pcm.length/2/count);bundle.waveform=[];
     for(let i=0;i<count;i++){let peak=0;for(let j=i*step;j<Math.min((i+1)*step,pcm.length/2);j++)peak=Math.max(peak,Math.abs(pcm.readInt16LE(j*2))/32768);bundle.waveform.push(Math.round(peak*1000));}
    }
    await this.put(a.bucket,key+'/bundle.json',Buffer.from(JSON.stringify(bundle)),'application/json');this.cache.set(key,bundle);if(this.cache.size>48)this.cache.delete(this.cache.keys().next().value);return bundle;
   }finally{await rm(dir,{recursive:true,force:true});}});
   this.pending.set(key,work);work.catch(()=>{}).finally(()=>this.pending.delete(key));
  }
  return null;
 }
 async file(owner,a,name){if(!['proxy.mp4','audio.wav','thumbs.jpg'].includes(name))fail('EDITOR_MEDIA_VARIANT');const b=await this.bundle(owner,a);if(!b)return null;const descriptor=b.files[name];if(!descriptor)fail('EDITOR_STREAM_MISSING');const bytes=await this.storage.download(a.bucket,this.path(owner,a)+'/'+name);if(!bytes||digest(bytes)!==descriptor.sha256)fail('EDITOR_DERIVATIVE_INTEGRITY');return {bytes,...descriptor};}
}
