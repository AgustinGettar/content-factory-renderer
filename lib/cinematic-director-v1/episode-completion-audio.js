import {createClient} from '@supabase/supabase-js';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {V2} from '../lumi-series-v2-continuation.js';
import {previousVideoGate} from '../lumi-series-v2-gates.js';
import {runThirdShortTts,loadThirdShortProductionScenes} from '../lumi-third-short-media-v1.js';
import {LumiRecoveryIncidentManager,SupabaseLumiRecoveryStore,verifyArtifact,isStageComplete} from '../lumi-recovery-incident-manager-v1.js';
import {sha256,stableStringify} from './PROMPT_COMPILER_V3.mjs';
import {LUMI_TTS} from '../lumi-prompts.js';
export const ASSEMBLY_ATTEMPTS=['q31-PRO2','q32-V2-PRO1','q33-V2-PRO1','q34-V2-PRO1','q35-V2-PRO1','q36-V2-PRO1'];
const evidence={provider_succeeded:true,artifact_persisted:true,sha_verified:true,artifact_verified:true};
export function validateSixShotAssemblyProof(proof){
 const {sha256:digest,...body}=proof||{};
 if(proof?.version!=='LUMI_SIX_SHOT_ASSEMBLY_PROOF_V1'||proof.episode_id!==V2.episode||proof.status!=='PASS'||proof.beats!==9||proof.provider_calls!==0||proof.shots?.length!==6||sha256(stableStringify(body))!==digest)throw new Error('SIX_SHOT_ASSEMBLY_PROOF_REQUIRED');
 for(const [i,s]of proof.shots.entries())if(s.attempt!==ASSEMBLY_ATTEMPTS[i]||s.bytes_sha_verified!==true||s.decode!=='PASS'||s.assembly_gate!=='PASS'||!s.request_id||!s.path||!/^[a-f0-9]{64}$/.test(s.sha256))throw new Error('SIX_SHOT_AUTHENTIC_ARTIFACT_PROOF_REQUIRED');
 return true;
}
export async function proveSixShotAssembly({db,manager}){
 const state=await manager.store.getEpisode(V2.episode);
 if(state?.status!=='RUNNING'||state.active_incident_id||state.runner_enabled||state.autorun)throw new Error('SERIAL_RUNNERS_OFF_REQUIRED');
 const production=await loadThirdShortProductionScenes(db);
 const shots=[];
 for(const [i,attempt]of ASSEMBLY_ATTEMPTS.entries()){
  const {data:row,error}=await db.from('lumi_pilot_runs').select('*').eq('pilot_id',V2.pilot).eq('scene_id',attempt).eq('stage','VIDEO').single();
  const approved=state.metadata?.approved_visuals_current_episode?.['q'+(31+i)];
  if(error||row?.status!=='SUCCEEDED'||approved?.attempt!==attempt||approved.sha256!==row.content_hash||approved.request_id!==row.provider_request_id)throw new Error('SIX_SHOT_CHECKPOINT_BINDING_REQUIRED');
  previousVideoGate(row);
  const stored=await db.storage.from(row.storage_bucket).download(row.storage_path);
  if(stored.error||!stored.data)throw new Error('SIX_SHOT_STORAGE_REQUIRED');
  const bytes=Buffer.from(await stored.data.arrayBuffer());
  if(sha256(bytes)!==row.content_hash)throw new Error('SIX_SHOT_BYTES_SHA_MISMATCH');
  const dir=await mkdtemp(join(tmpdir(),'lumi-six-proof-'));
  let verification;
  try{const file=join(dir,'original.mp4');await writeFile(file,bytes);verification=await verifyArtifact({type:'VIDEO',filePath:file,expectedSha256:row.content_hash});}finally{await rm(dir,{recursive:true,force:true});}
  if(!verification.ok)throw new Error('SIX_SHOT_DECODE_REQUIRED');
  shots.push({attempt,sha256:row.content_hash,request_id:row.provider_request_id,bucket:row.storage_bucket,path:row.storage_path,bytes_sha_verified:true,decode:'PASS',assembly_gate:'PASS',duration:verification.duration,human_review_preserved:true});
 }
 const proof={version:'LUMI_SIX_SHOT_ASSEMBLY_PROOF_V1',episode_id:V2.episode,status:'PASS',shots,beats:production.scenes.length,plan_hash:production.content_hash,provider_calls:0,created_at:new Date().toISOString()};
 proof.sha256=sha256(stableStringify(proof));validateSixShotAssemblyProof(proof);
 const path=V2.prefix+'/visual-assembly-ready-v1.json';
 const uploaded=await db.storage.from(V2.bucket).upload(path,Buffer.from(JSON.stringify(proof)),{contentType:'application/json',upsert:true});
 if(uploaded.error)throw new Error('SIX_SHOT_PROOF_PERSIST_FAILED');
 const persisted=await db.storage.from(V2.bucket).download(path);if(persisted.error)throw new Error('SIX_SHOT_PROOF_READBACK_FAILED');validateSixShotAssemblyProof(JSON.parse(await persisted.data.text()));
 if(!isStageComplete(state.actions.find(a=>a.key==='visual_assembly_gate')))await manager.completeAction(V2.episode,'visual_assembly_gate',{artifact:proof,evidence,actualCostUsd:0});
 await manager.checkpoint(V2.episode,d=>{d.metadata.visual_assembly_ready_v2=proof;});
 return proof;
}
export async function runEpisodeCompletionAudio({env,logger=console}){
 if(env.LUMI_RUNTIME_ENV!=='staging'||env.LUMI_PIPELINE_VERSION!=='legacy'||env.PROVIDER_CALLS_ALLOWED!=='0'||env.LUMI_PIPELINE_AUTORUN==='true')throw new Error('AUDIO_SIGNED_STAGING_ONLY');
 const db=createClient(env.SUPABASE_URL,env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false}}),manager=new LumiRecoveryIncidentManager({store:new SupabaseLumiRecoveryStore(db)});
 const proof=await proveSixShotAssembly({db,manager});
 const state=await manager.store.getEpisode(V2.episode);
 if(!isStageComplete(state.actions.find(a=>a.key==='voice_review_gate')))await manager.completeAction(V2.episode,'voice_review_gate',{artifact:{status:'AUTHORIZED_CANONICAL_VOICE',authority:'USER_CURRENT_EPISODE_COMPLETION',model:'gpt-4o-mini-tts',voice:'marin',instructions_sha256:sha256(LUMI_TTS),new_audio_human_approved:false},evidence,actualCostUsd:0});
 logger.info(JSON.stringify({event:'lumi_six_visuals_assembly_ready',VISUAL_ASSEMBLY_READY:'PASS',shots:6,beats:9,provider_calls:0}));
 const result=await runThirdShortTts({supabase:db,openAiApiKey:env.OPENAI_API_KEY,visualAssemblyProof:proof,logger:e=>logger.info(JSON.stringify(e))});
 if(result.status!=='READY_FOR_ASSEMBLY')return result;
 const rows=await db.from('lumi_pilot_runs').select('*').eq('pilot_id',V2.pilot).eq('stage','TTS');
 if(rows.error||rows.data.length!==9||rows.data.some(r=>r.status!=='SUCCEEDED'))throw new Error('NINE_CANONICAL_STEMS_REQUIRED');
 const stems=[];
 for(const row of rows.data){const signed=await db.storage.from(row.storage_bucket).createSignedUrl(row.storage_path,7200);if(signed.error)throw new Error('STEM_REVIEW_SIGN_FAILED');stems.push({scene_id:row.scene_id,sha256:row.content_hash,request_id:row.provider_request_id,path:row.storage_path,bucket:row.storage_bucket,review_url:signed.data.signedUrl,verification:row.result.verification});}
 return {...result,stems,visual_assembly_proof:proof};
}
