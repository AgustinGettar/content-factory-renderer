import { assertRuntimeReviewGate, recordCompletedShotReview } from './telegram-review-v1/runtime.js';
import {stepIdentity,budgetGate,sourceGate,previousVideoGate,readV2Json} from './lumi-series-v2-gates.js';
import {createHash} from 'node:crypto';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {V2,imageInput,videoPrompt,runLumiV2Preflight} from './lumi-series-v2-continuation.js';
import {journaledFetch} from './provider-emission-journal-v1.js';
import {providerJson,pollRequest} from './generative-video-benchmark-v1.js';
import {estimateHiggsfieldUsd,sumUsd} from './higgsfield-usd-budget-v1.js';
import {loadThirdShortProductionScenes} from './lumi-third-short-media-v1.js';

const hash=b=>createHash('sha256').update(b).digest('hex');
const exec=promisify(execFile), now=()=>new Date().toISOString();
class ScopedJournal {
 constructor(storage,prefix,attempt){this.storage=storage;this.prefix=prefix;this.attempt=attempt;this.current=null;}
 async write(state,value,upsert=false){const r=await this.storage.upload(`${this.prefix}/journal/${state}.json`,Buffer.from(JSON.stringify(value)),{contentType:'application/json',upsert});if(r.error)throw new Error('v2_journal_atomic_write_rejected');}
 async prepare(record){if(record.attempt_id!==this.attempt||record.state!=='PREPARED')throw new Error('v2_journal_scope');await this.write('PREPARED',record);this.current=record;return record;}
 async transition(id,from,patch){if(id!==this.attempt||this.current?.state!==from)throw new Error('v2_journal_transition');const next={...this.current,...patch};await this.write(patch.state,next,from==='ACKNOWLEDGED');this.current=next;return next;}
}
export async function runLumiV2Step({env=process.env,logger=console,fetchImpl=fetch,directorReview}={}){
 await assertRuntimeReviewGate(env, V2.episode);
 if(env.LUMI_CINEMATIC_DIRECTOR_V1==='true'){
  const {reviewAtCanonicalBoundary}=await import('./cinematic-director-v1/integration.js');
  return reviewAtCanonicalBoundary({env,directorReview});
 }
 if(env.LUMI_RUNTIME_ENV!=='staging'||env.LUMI_SERIES_V2_AUTHORIZATION!==V2.sourceSha)throw new Error('v2_staging_scoped_authorization_required');
 const step=JSON.parse(env.LUMI_SERIES_V2_STEP||'null');const attempt=stepIdentity(step?.shot,step?.stage),index=V2.shots.indexOf(step.shot);
 const {createClient}=await import('@supabase/supabase-js');
 const db=createClient(env.SUPABASE_URL,env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false}}),storage=db.storage.from(V2.bucket),prefix=`${V2.prefix}/${attempt}`;
 const put=async(name,value,upsert=false)=>{const r=await storage.upload(`${prefix}/${name}.json`,Buffer.from(JSON.stringify(value)),{contentType:'application/json',upsert});if(r.error)throw new Error(`v2_record_write_failed:${name}`);};
 const read=name=>readV2Json(storage,prefix,name);
 const sign=async(path)=>{const r=await storage.createSignedUrl(path,21600);if(r.error)throw new Error('v2_artifact_sign_failed');return r.data.signedUrl;};
 const rowFor=async(scene,stage)=>{const r=await db.from('lumi_pilot_runs').select('*').eq('pilot_id',V2.pilot).eq('scene_id',scene).eq('stage',stage).maybeSingle();if(r.error)throw new Error('v2_ledger_read_failed');return r.data;};
 const completed=await read('completed');if(completed){logger.info(JSON.stringify({event:'lumi_series_v2_step_completed',...completed,cache_hit:true,provider_calls_added:0,review_url:await sign(completed.artifact_path)}));return completed;}
 let accepted=await read('accepted'),row=await rowFor(attempt,step.stage);
 const cp=await db.from('lumi_pipeline_checkpoints').select('metadata').eq('episode_id',V2.episode).single();if(cp.error)throw new Error('v2_checkpoint_required');
 if(cp.data.metadata.video_quality_profile_v2?.golden_video!=='q31-PRO2'||cp.data.metadata.image_quality_profile_v2?.model!==V2.imageModel)throw new Error('v2_frozen_quality_profile_mismatch');
 const budget=cp.data.metadata.series_v2_continuation_budget;
 if(!accepted){
  if(row||await read('journal/PREPARED')||await read('journal/EMITTING')||await read('journal/ACKNOWLEDGED')||await read('journal/EMISSION_UNKNOWN'))throw new Error('v2_prior_emission_or_claim_requires_inspection_NO_RESUBMIT');
  if(index>0)previousVideoGate(await rowFor(stepIdentity(V2.shots[index-1],'VIDEO'),'VIDEO'));
 }
 const canonical=await storage.download(V2.sourcePath);if(canonical.error||hash(Buffer.from(await canonical.data.arrayBuffer()))!==V2.sourceSha)throw new Error('v2_canonical_reference_sha_mismatch');
 const production=await loadThirdShortProductionScenes(db),scene=production.scenes.find(s=>s.id===V2.sourceScenes[index]);
 let input,sourceSha=V2.sourceSha,sourceRecord=null;
 if(step.stage==='IMAGE')input=imageInput(scene,step.shot,await sign(V2.sourcePath));
 else {
  const sourceRow=await rowFor(stepIdentity(step.shot,'IMAGE'),'IMAGE');
  if(!sourceRow?.result?.artifact_path)throw new Error('v2_source_artifact_required');sourceRecord=sourceRow.result;
  sourceGate(sourceRecord,sourceRow);
  const src=await storage.download(sourceRecord.artifact_path);if(src.error||hash(Buffer.from(await src.data.arrayBuffer()))!==sourceRecord.sha256)throw new Error('v2_video_source_stored_sha_mismatch');
  sourceSha=sourceRecord.sha256;input={duration:V2.durations[index],sound:'off',multi_shots:false,cfg_scale:0.5,prompt:videoPrompt(scene,step.shot,V2.durations[index]),image_url:await sign(sourceRecord.artifact_path)};
 }
 const model=step.stage==='IMAGE'?V2.imageModel:V2.videoModel;
 if(env.LUMI_DIRECTOR_REQUEST_COMPILATION==='USER_20261005_EPISODE_COMPLETION'){
  if(env.LUMI_RUNTIME_ENV!=='staging'||!['q34','q35','q36'].includes(step.shot))throw new Error('director_remaining_staging_scope_required');
  const {compileRemainingRequest}=await import('./cinematic-director-v1/episode-step.js');
  const {packet,providerInput}=compileRemainingRequest({shot:step.shot,stage:step.stage,input,sourceSha,sourceQa:sourceRecord?.visual_qa});
  await put('director-package',packet,true);input=providerInput;
  logger.info(JSON.stringify({event:'lumi_director_request_compiled',shot:step.shot,stage:step.stage,package_hash:packet.sha256,provider_calls:0}));
 }
 let quote=accepted?.quote;
 if(!accepted){
  const preflight=await runLumiV2Preflight({env,logger:{info:()=>{}},fetchImpl});
  quote=await estimateHiggsfieldUsd({apiKey:env.HF_API_KEY,model,input,fetchImpl});
  const future=[];
  for(let i=index;i<5;i++){
   if(i===index){if(step.stage==='IMAGE')future.push(quote.estimated_cost_usd,preflight.video_quotes[i].estimated_cost_usd);else future.push(quote.estimated_cost_usd);}
   else future.push(preflight.image_quotes[i].estimated_cost_usd,preflight.video_quotes[i].estimated_cost_usd);
  }
  const used=await db.from('lumi_pilot_runs').select('scene_id,estimated_cost_usd').eq('pilot_id',V2.pilot).in('scene_id',V2.shots.map(shot=>stepIdentity(shot,'VIDEO')));
  const sourceUsed=await db.from('lumi_pilot_runs').select('estimated_cost_usd').eq('pilot_id',V2.pilot).in('scene_id',V2.shots.map(shot=>stepIdentity(shot,'IMAGE')));
  if(used.error||sourceUsed.error)throw new Error('v2_budget_ledger_required');
  const spent=sumUsd([...used.data,...sourceUsed.data].map(r=>r.estimated_cost_usd));
  const projected=sumUsd([spent,...future]);budgetGate(budget,projected);
  await put('preflight',{attempt,stage:step.stage,model,quote,source_sha256:sourceSha,canonical_source_sha256:V2.sourceSha,projected_checkpoint_spend_usd:projected,authorized_ceiling_usd:3.24,requested_mode:step.stage==='VIDEO'?'PRO':null,max_calls:1,retries:0,variants:0,resubmits:0});
  logger.info(JSON.stringify({event:'lumi_series_v2_step_preflight',attempt,stage:step.stage,model,quote,projected_checkpoint_spend_usd:projected,source_sha256:sourceSha}));
  const claim=await db.from('lumi_pilot_runs').insert({pilot_id:V2.pilot,scene_id:attempt,stage:step.stage,status:'CLAIMED',provider:'higgsfield_api',provider_calls:0,estimated_cost_usd:quote.estimated_cost_usd,artifact_reference:attempt,claimed_at:now(),result:{source_sha256:sourceSha,model,authorized_additional_ceiling_usd:3.24}}).select('id').single();
  if(claim.error)throw new Error('v2_atomic_ledger_claim_rejected');row=claim.data;
  const journal=new ScopedJournal(storage,prefix,attempt);
  const submit=journaledFetch({store:journal,context:{episode_id:V2.episode,scene_id:attempt,stage:step.stage,attempt_id:attempt,provider:'higgsfield_api',model,expected_cost_usd:quote.estimated_cost_usd,prompt:input.prompt},descriptor:{source_sha256:sourceSha,REQUESTED_MODE:step.stage==='VIDEO'?'PRO':null,max_calls:1,authorization:'USER_APPROVED_V2_ADDITIONAL_3_24'},fetchImpl,persistResponse:async response=>{
   await put('provider-accepted-response',response);
   if(response.request_id){await put('accepted',{...response,quote});const u=await db.from('lumi_pilot_runs').update({status:'REQUESTED',provider_calls:1,provider_request_id:response.request_id,updated_at:now()}).eq('id',row.id);if(u.error)throw new Error('v2_immediate_request_ledger_write_failed');logger.info(JSON.stringify({event:'lumi_series_v2_acknowledged',attempt,request_id:response.request_id}));}
  }});
  try{accepted=await providerJson(`https://api.higgsfield.ai/${model}`,{apiKey:env.HF_API_KEY,method:'POST',body:input,fetchImpl:(url,options)=>{const headers=new Headers(options.headers);headers.set('Idempotency-Key',attempt);return submit(url,{...options,headers});}});}
  catch(error){const existing=await read('accepted');const diagnostic={attempt,error:error.message,http_status:error.http_status??null,provider_detail:error.provider_detail??null,request_id:existing?.request_id??null,creative_attempt_consumed:!!existing?.request_id,resubmits:0};await put('blocked',diagnostic);logger.info(JSON.stringify({event:'lumi_series_v2_step_blocked',...diagnostic}));throw error;}
  if(!accepted.request_id||!accepted.status_url)throw new Error('v2_provider_request_handle_required_NO_RESUBMIT');
 }
 logger.info(JSON.stringify({event:'lumi_series_v2_poll_same',attempt,request_id:accepted.request_id}));
 const terminal=await pollRequest({apiKey:env.HF_API_KEY,statusUrl:accepted.status_url,fetchImpl,onStatus:p=>put('status',{request_id:accepted.request_id,...p},true)});
 await put('terminal',terminal);const mediaUrl=step.stage==='VIDEO'?terminal.video?.url:terminal.images?.[0]?.url;
 if(terminal.status!=='completed'||!mediaUrl)throw new Error('v2_provider_terminal_failed_NO_RETRY');
 const response=await fetchImpl(mediaUrl);if(!response.ok)throw new Error('v2_completed_media_download_failed');const bytes=Buffer.from(await response.arrayBuffer()),sha=hash(bytes);
 const isPng=bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));const ext=step.stage==='VIDEO'?'mp4':isPng?'png':'jpg',mime=step.stage==='VIDEO'?'video/mp4':isPng?'image/png':'image/jpeg';
 const path=`${prefix}/artifact/${sha}/original.${ext}`;const up=await storage.upload(path,bytes,{contentType:mime,upsert:false});if(up.error){const old=await storage.download(path);if(old.error||hash(Buffer.from(await old.data.arrayBuffer()))!==sha)throw new Error('v2_artifact_persistence_failed');}
 const verify=await storage.download(path);if(verify.error||hash(Buffer.from(await verify.data.arrayBuffer()))!==sha)throw new Error('v2_stored_artifact_sha_mismatch');
 const dir=await mkdtemp(join(tmpdir(),'lumi-series-v2-'));let technical;
 try{
  const file=join(dir,`original.${ext}`);await writeFile(file,bytes);
  const probe=JSON.parse((await exec('ffprobe',['-v','error','-show_streams','-show_format','-of','json',file])).stdout),stream=probe.streams.find(s=>s.codec_type==='video');
  await exec('ffmpeg',['-v','error','-i',file,'-f','null','-']);
  technical={DECODE:'PASS',width:stream.width,height:stream.height,codec:stream.codec_name,sha256:sha};
  if(step.stage==='VIDEO'){
   const scan=await exec('ffmpeg',['-v','info','-i',file,'-vf','blackdetect=d=0:pix_th=0.10,freezedetect=n=0.003:d=0.5','-an','-f','null','-'],{maxBuffer:8*1024*1024});
   Object.assign(technical,{duration:Number(probe.format.duration),fps:stream.avg_frame_rate,BLACK_FRAMES:(scan.stderr.match(/black_start:/g)||[]).length,FREEZE_DEFECTS:(scan.stderr.match(/freeze_start:/g)||[]).length,audio_streams:probe.streams.filter(s=>s.codec_type==='audio').length});
  }
 }finally{await rm(dir,{recursive:true,force:true});}
 const actualMode=terminal.actual_mode??terminal.mode??terminal.metadata?.mode??null;
 const result={attempt,shot:step.shot,stage:step.stage,request_id:accepted.request_id,model,requested_mode:step.stage==='VIDEO'?'PRO':null,actual_mode_reported_by_provider:actualMode,mode_provenance:step.stage==='VIDEO'?'REQUEST_ENDPOINT_CONFIRMED':null,quality_calibration_mode:step.stage==='VIDEO'?'PRO_BY_REQUEST_PROVENANCE':null,artifact_bucket:V2.bucket,artifact_path:path,sha256:sha,bytes:bytes.length,mime,technical_qa:technical,estimated_cost_usd:quote.estimated_cost_usd,actual_cost_usd:terminal.cost?.usd??terminal.usd??null,source_sha256:sourceSha,canonical_source_sha256:V2.sourceSha,visual_qa:{classification:'PENDING'},temporal_qa:null,provider_calls:1,retries:0,variants:0,resubmits:0,created_at:now(),human_review:'PENDING'};
 if(actualMode&&['std','standard'].includes(String(actualMode).toLowerCase()))result.mode_discrepancy='PROVIDER_STANDARD_FALLBACK';
 await put('completed',result);
 const ledger=await db.from('lumi_pilot_runs').update({status:'SUCCEEDED',provider_calls:1,provider_request_id:accepted.request_id,storage_bucket:V2.bucket,storage_path:path,content_hash:sha,result,completed_at:now(),updated_at:now()}).eq('pilot_id',V2.pilot).eq('scene_id',attempt).eq('stage',step.stage);if(ledger.error)throw new Error('v2_completed_ledger_persist_failed');
 if(env.LUMI_TELEGRAM_REVIEW_V1==='true'&&env.LUMI_RUNTIME_ENV==='staging'&&step.stage==='VIDEO')await recordCompletedShotReview({db,episodeId:V2.episode,shotId:step.shot,result});
 logger.info(JSON.stringify({event:'lumi_series_v2_step_completed',...result,review_url:await sign(path)}));return result;
}
