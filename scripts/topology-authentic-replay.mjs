import {readFile,writeFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {sha256,stableStringify} from '../lib/cinematic-director-v1/PROMPT_COMPILER_V3.mjs';
import {evaluateCalibration} from '../lib/cinematic-director-v1/topology-calibration.js';
import dataset from '../docs/temporal-topology-qa-v2/AUTHENTIC_CALIBRATION_DATASET_V1.json' with {type:'json'};
import assembly from '../docs/cinematic-director-v1/human-review-20261005/HUMAN_ASSEMBLY_APPROVALS_V1.json' with {type:'json'};
import q34 from '../docs/cinematic-director-v1/human-review-20261006/Q34_HUMAN_REVIEW_20261006.json' with {type:'json'};
import q35 from '../docs/temporal-topology-qa-v2/Q35_HUMAN_REVIEW_20261006.json' with {type:'json'};
const exec=promisify(execFile),root=process.argv[2],output=process.argv[3];
if(!root||!output)throw new Error('INPUT_MEDIA_ROOT_AND_OUTPUT_REQUIRED');
async function files(dir){const out=[];for(const e of await readdir(dir,{withFileTypes:true})){const p=join(dir,e.name);if(e.isDirectory())out.push(...await files(p));else out.push(p);}return out;}
const paths=await files(root),bySha=new Map();
for(const path of paths.filter(p=>/\.mp4$|\.png$/.test(p)))bySha.set(sha256(await readFile(path)),path);
const report=evaluateCalibration();
if(!bySha.has(dataset.canonical_source_sha256))throw new Error('CANONICAL_SOURCE_BYTES_REQUIRED');
const before=sha256(stableStringify(dataset));
for(let i=0;i<dataset.positives.length;i++){
 const p=dataset.positives[i],path=bySha.get(p.review.sha256);
 if(!path||!bySha.has(p.review.comparisons.video_source.sha256))throw new Error('EXACT_AUTHENTIC_SOURCE_AND_VIDEO_REQUIRED:'+p.attempt);
 await exec('ffmpeg',['-v','error','-i',path,'-f','null','-']);
 const probe=JSON.parse((await exec('ffprobe',['-v','error','-count_frames','-show_streams','-of','json',path])).stdout),v=probe.streams.find(s=>s.codec_type==='video');
 if(Number(v.nb_read_frames)!==p.review.decoded_frame_count)throw new Error('AUTHENTIC_FRAME_COUNT_MISMATCH');
 const [n,d]=v.avg_frame_rate.split('/').map(Number);if(n/d!==p.review.fps)throw new Error('AUTHENTIC_FRAME_RATE_MISMATCH');
 const authentic=[...assembly.records.map(r=>r.sha256),q34.artifact_sha256,q35.artifact_sha256].includes(p.review.sha256);
 if(!authentic)throw new Error('AUTHENTIC_HUMAN_REVIEW_REQUIRED');
 report.positives[i].original_decode_and_sha='PASS';report.positives[i].HUMAN_REVIEW_PROVENANCE='PASS';report.positives[i].native_frames_verified=Number(v.nb_read_frames);report.positives[i].native_dimensions=[v.width,v.height];
}
if(sha256(stableStringify(dataset))!==before)throw new Error('AUTHENTIC_OBSERVATION_MUTATED');
report.HUMAN_REVIEW_PROVENANCE_PRESERVED=true;report.authentic_byte_replay='PASS';report.method='Decoded originals and source SHA verified; native source/first/risk/surrounding frame observations classified without providers or Human override.';
await writeFile(output,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({status:report.status,false_fatals:report.FALSE_FATALS_ON_HUMAN_APPROVED_SET,blocked:report.TRUE_FATAL_FIXTURES_BLOCKED,provenance:report.HUMAN_REVIEW_PROVENANCE_PRESERVED,providers:0}));
