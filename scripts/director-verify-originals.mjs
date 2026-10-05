// Technical verification only. Read originals; write bindings and extracted QA frames.
// No pixels are generated, altered, uploaded, or visually certified by this script.
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { sha256, stableStringify } from '../lib/cinematic-director-v1/PROMPT_COMPILER_V3.mjs';
assert.equal(globalThis.LUMI_OFFLINE_GUARD?.active, true, 'OFFLINE_GUARD_REQUIRED');
const mediaRoot=resolve(process.argv[2]), output=resolve(process.argv[3]);
await mkdir(output,{recursive:true});
const evidence=new URL('../docs/cinematic-director-v1/evidence/',import.meta.url);
const read=async name=>JSON.parse(await readFile(new URL(name,evidence)));
const ledger=await read('AUTHENTIC_LEDGER_SNAPSHOT_2026-10-05.json');
const storage=await read('ORIGINAL_STORAGE_IDENTITIES_2026-10-05.json');
const contracts=await read('SHOT_CONTRACTS_V2.json');
const provenance=await read('LUMI_q32_q33_REPAIR_PLAN.json');
const sourceName='LUMI_CANONICAL_SOURCE_V2(2).png';
const libraryIds={
  'q31-PRO2.mp4':'libfile_70c1089914708191b2a2618f4b854d7b',
  [sourceName]:'libfile_ad7b77d849e48191be35b1049b5af9a8',
  'q32-SOURCE-V2-1.png':'libfile_73f957c68a488191aa19b461b4359a60',
  'q32-V2-PRO1.mp4':'libfile_20ee9c38374081919e2d8e6b7b9120de',
  'q33-SOURCE-V2-1.png':'libfile_24c33e1ef8f481919bbd5d4aed9322a4',
  'q33-V2-PRO1.mp4':'libfile_4d2c889d8ab48191a439b6182e98e471',
};
async function verify(filename,expected,path,video){
  const local=join(mediaRoot,filename), bytes=await readFile(local), digest=sha256(bytes);
  assert.equal(digest,expected,'AUTHENTIC_SHA_MISMATCH:'+filename);
  const object=storage.rows.find(x=>x.name===path);
  assert.ok(object,'CANONICAL_STORAGE_OBJECT_REQUIRED');assert.equal(object.metadata.size,bytes.length);
  const probe=JSON.parse(execFileSync('ffprobe',['-v','error','-show_streams','-show_format','-of','json',local],{encoding:'utf8'}));
  const stream=probe.streams.find(x=>x.codec_type==='video');assert.ok(stream);
  const decode=execFileSync('ffmpeg',['-nostdin','-v','error','-xerror','-i',local,'-f','null','-'],{encoding:'utf8',stdio:['ignore','pipe','pipe']});
  assert.equal(decode,'');
  const result={artifact_id:object.id,bucket:object.bucket_id,object_path:path,sha256:digest,bytes:bytes.length,
    authenticated_transport:'ChatGPT Library server-side materialization; SHA equals canonical Storage identity and persisted ledger',library_file_id:libraryIds[filename],local_filename:filename,
    verification:{sha:'PASS',decode:'PASS',width:stream.width,height:stream.height,codec:stream.codec_name},
    provider_request_id:null};
  if(video){
    // ffmpeg writes filter diagnostics on stderr; run spawnSync to capture that stream.
    const {spawnSync}=await import('node:child_process');
    const scan=spawnSync('ffmpeg',['-nostdin','-hide_banner','-i',local,'-vf','blackdetect=d=0:pix_th=0.10:pic_th=0.98','-an','-f','null','-'],{encoding:'utf8'});
    assert.equal(scan.status,0);const segments=(scan.stderr.match(/black_start:/g)||[]).length;
    const folder=join(output,filename+'.frames');await mkdir(folder,{recursive:true});
    const indices=[0,20,48,69,75,80,89,96];const frames=[];
    for(const index of indices){const target=join(folder,`${index}.png`);
      execFileSync('ffmpeg',['-nostdin','-v','error','-i',local,'-vf',`select=eq(n\\,${index})`,'-frames:v','1','-y',target],{stdio:['ignore','pipe','pipe']});
      frames.push({index,time_s:index/24,sha256:sha256(await readFile(target)),relative_path:filename+'.frames/'+index+'.png',role:'QA_DERIVATIVE_NOT_ORIGINAL'});
    }
    Object.assign(result.verification,{duration_seconds:Number(probe.format.duration),fps:stream.r_frame_rate,pixel_format:stream.pix_fmt,
      decoded_frame_count:Number(stream.nb_frames),audio_streams:probe.streams.filter(x=>x.codec_type==='audio').length,
      black_segments:segments,black_frame_sanity:segments===0?'PASS':'REVIEW_REQUIRED',blackdetect:'d=0:pix_th=0.10:pic_th=0.98',frame_extraction:'PASS',frames,
      visual_complete_native_speed_review:'NOT_PERFORMED_BY_THIS_SCRIPT',sampled_frames_do_not_certify_all_frames:true});
    assert.equal(segments,0,'BLACK_FRAME_REVIEW_REQUIRED');
  }
  assert.equal(sha256(await readFile(local)),digest,'ORIGINAL_MUTATED');return result;
}
for(const shot of ['q31','q32','q33']){
  const videoRow=ledger.rows.find(x=>x.scene_id===(shot==='q31'?'q31-PRO2':shot+'-V2-PRO1'));
  const sourceRow=ledger.rows.find(x=>x.scene_id===shot+'-SOURCE-V2-1');
  const s=sourceRow?.result||videoRow.result.source,v=videoRow.result;
  const source=await verify(sourceRow?shot+'-SOURCE-V2-1.png':sourceName,s.sha256,s.artifact_path,false);
  const video=await verify(videoRow.scene_id+'.mp4',videoRow.content_hash,v.artifact_path,true);
  source.provider_request_id=sourceRow?.provider_request_id||null;source.origin=sourceRow?'PROVIDER_ORIGINAL':'USER_ATTACHMENT';
  video.provider_request_id=videoRow.provider_request_id;
  const contract=contracts.shots.find(x=>x.shot_id===shot);
  const binding={version:'ORIGINAL_MEDIA_BINDING_V1',episode:'ep_lumi_flores_003',shot,revision:1,
    AUTHENTIC_MEDIA_VERIFIED:'PASS',source,video,provider:'higgsfield_api',endpoint:v.model,
    ledger:{video_row_id:videoRow.id,source_row_id:sourceRow?.id||null,snapshot:'AUTHENTIC_LEDGER_SNAPSHOT_2026-10-05.json'},
    director_input_package:{contract_version:'LUMI_KLING_SHOT_CONTRACT_V2',contract_sha256:sha256(stableStringify(contract)),
      historical_contract:contract,compiler:'PROMPT_COMPILER_V3',director:'LUMI_CINEMATIC_DIRECTOR_V1',
      request_envelope_status:'FULL_PERSISTED_ENVELOPE_NOT_RECOVERED',runtime_revision:'f42d5a83e2806b3db17080c2829d305bad4a8525',
      note:'Historical contract remains incomplete; not silently upgraded to an approved direction.'},
    qa:{source:sourceRow?.result.visual_qa||null,video:v.temporal_qa||null,forensics:provenance.analysis[shot]||null},
    human_review:{state:shot==='q31'?'HUMAN_APPROVED':shot==='q32'?'REVIEW_REQUIRED_BLOCKED':'BLOCKER',
      persisted:v.HUMAN_APPROVAL||null,historical_actor:null,historical_at:null,
      reaffirmation:{actor:'current user',date:'2026-10-05',scope:'Current continuation instruction; existing artifact status only; no new direction or generation approval'}},
    original_artifacts_mutated:false,new_generation_authorized:false};
  binding.fingerprint=sha256(stableStringify(binding));
  await writeFile(join(output,shot+'_ORIGINAL_MEDIA_BINDING_V1.json'),JSON.stringify(binding,null,2)+'\n');
  console.log(JSON.stringify({shot,AUTHENTIC_MEDIA_VERIFIED:'PASS',source_sha256:source.sha256,video_sha256:video.sha256}));
}
assert.deepEqual(globalThis.LUMI_OFFLINE_GUARD.attempts,[]);
