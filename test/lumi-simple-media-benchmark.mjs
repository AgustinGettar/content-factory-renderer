import {readFile,writeFile,mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';import {execFile} from 'node:child_process';import {promisify} from 'node:util';
import {EditorMedia,digest} from '../lib/telegram-mini-app/editor-media.js';
const exec=promisify(execFile),dir=await mkdtemp(join(tmpdir(),'lumi-media-benchmark-'));
const sourceRoot=process.env.LUMI_EXISTING_SOURCE_ROOT,voicePath=process.env.LUMI_EXISTING_VOICE;
const inputs=[];
if(sourceRoot&&voicePath){for(const name of ['q31-PRO2.mp4','q32-V2-PRO1.mp4'])inputs.push(await readFile(join(sourceRoot,name)));inputs.push(await readFile(voicePath));const expected=['ea5a54493bf1ccf037ac5acac2d81668c0d9f7c0239d81479dfa7968c7ee0307','0e94f3667d2abebe913ac020a01ececf9c9b46869a0ebdc19cb7eeef23dad313','52592e542c9592f85888279f23a7010f3c744a21ceebda689751119df373a35e'];inputs.forEach((b,i)=>{if(digest(b)!==expected[i])throw Error('EXISTING_SOURCE_MISMATCH');});}
else{for(let i=0;i<2;i++){const f=join(dir,i+'.mp4');await exec('ffmpeg',['-v','error','-f','lavfi','-i',`testsrc2=s=180x320:r=30:d=${2+i/2}`,'-an','-c:v','libx264','-threads','1','-y',f]);inputs.push(await readFile(f));}const f=join(dir,'a.mp3');await exec('ffmpeg',['-v','error','-f','lavfi','-i','sine=frequency=600:duration=1','-y',f]);inputs.push(await readFile(f));}
const artifacts=inputs.map((b,i)=>({artifact_id:'fixture'+i,bucket:'private-fixture',path:'source'+i,sha256:digest(b),size:b.length,mime:i<2?'video/mp4':'audio/mpeg'}));
// Read the exact observed implementation, not a prose reconstruction.
let old=(await exec('git',['show','e48d4dd:lib/telegram-mini-app/editor-media.js'])).stdout;old=old.replace("'../../public/lumi-studio/editor-model.js'",JSON.stringify(new URL('../public/lumi-studio/editor-model.js',import.meta.url).href));const {EditorMedia:Before}=await import('data:text/javascript;base64,'+Buffer.from(old).toString('base64'));
const report={environment:'Node '+process.version+', Linux local FFmpeg, no external reads/writes. Before=historical sequential loadBundles; after=current first video only. Not Telegram startup.',sources:artifacts.map(a=>({sha256:a.sha256,bytes:a.size})),existing_sources:!!sourceRoot,samples:[]};
try{for(const [label,Class] of [['before',Before],['after',EditorMedia]])for(let sample=0;sample<3;sample++){
 const files=new Map();let sourceBytes=0,sourceReads=0;const storage={download:async(b,p)=>files.get(p)||null,upload:async(b,p,v)=>{if(files.has(p))throw Error('EXISTS');files.set(p,v);}};
 const media=new Class({storage,loadBytes:async a=>{sourceReads++;const b=inputs[artifacts.findIndex(x=>x.sha256===a.sha256)];sourceBytes+=b.length;return b;},privateBucket:async()=>true});
 const prepare=async(a,variant)=>{let r=await media.bundle('isolated',a,variant,'project');if(!r||r.ready===false){await Promise.all(media.pending.values());r=await media.bundle('isolated',a,variant,'project');}return r;};
 const t=performance.now();let first;if(label==='before'){for(const a of artifacts){const b=await prepare(a,'all');first||=b;}}else first=await prepare(artifacts[0],'video');
 const cold=Math.round(performance.now()-t),warmAt=performance.now();await prepare(artifacts[0],label==='before'?'all':'video');const warm=Math.round((performance.now()-warmAt)*100)/100,proxy=[...files].find(([k])=>k.endsWith('/proxy.mp4'))?.[1];
 report.samples.push({label,sample:sample+1,cold_ms:cold,warm_ms:warm,source_reads:sourceReads,source_bytes:sourceBytes,derived_bytes:[...files.values()].reduce((n,b)=>n+b.length,0),proxy_bytes:proxy?.length,faststart:proxy?.indexOf(Buffer.from('moov'))<proxy?.indexOf(Buffer.from('mdat')),parent_rss_bytes:process.memoryUsage().rss});
 }
 const out=process.env.LUMI_BENCH_OUTPUT||'/tmp/lumi-simple-evidence/media-preparation.json';await mkdir(join(out,'..'),{recursive:true});await writeFile(out,JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{await rm(dir,{recursive:true,force:true});}
