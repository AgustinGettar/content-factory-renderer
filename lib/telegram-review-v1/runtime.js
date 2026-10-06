import {GenericLumiV2Adapter} from '../lumi-generic-v2-adapter.js';
import {LumiRecoveryIncidentManager,SupabaseLumiRecoveryStore} from '../lumi-recovery-incident-manager-v1.js';
import {SupabaseEmissionStore} from '../provider-emission-journal-v1.js';
import {loadOwnedHomeAsset,HOME_ASSET} from './home-asset.js';
import {ProductionReviewController} from './production.js';
import {mountMakeTransportEndpoint} from './make-endpoint.js';
import {mountExistingMasterBootstrap} from './bootstrap-master.js';
import {mountMakeBridge,legacyMenu} from './bridge.js';
import { timingSafeEqual } from 'node:crypto';
import { enabled, newSession, sha256, SupabaseReviewStore, ReviewService, reviewGate, validateArtifact } from './core.js';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const exec=promisify(execFile);
export class TelegramTransport {
  constructor({token,fetchImpl=fetch}){if(!token)throw new Error('telegram_bot_credential_required');this.token=token;this.fetch=fetchImpl;}
  async call(method,body,file){
    if(!['editMessageText','editMessageMedia','editMessageCaption','editMessageReplyMarkup','answerCallbackQuery'].includes(method))throw new Error('single_message_method_forbidden');
    let options;
    if(file){
      if(method!=='editMessageMedia'||!body.media||typeof body.media!=='object')throw new Error('multipart_media_descriptor_required');
      const form=new FormData(),payload={...body,media:{...body.media,media:'attach://lumi_file'}};
      for(const [k,v] of Object.entries(payload))form.set(k,typeof v==='object'?JSON.stringify(v):String(v));
      form.set('lumi_file',new Blob([file.bytes],{type:file.mime}),file.filename|| (file.mime==='video/mp4'?'Lumi.mp4':'Lumi-menu.png'));
      options={body:form};
    }
    else options={headers:{'content-type':'application/json'},body:JSON.stringify(body)};
    let response,payload;
    try{response=await this.fetch(`https://api.telegram.org/bot${this.token}/${method}`,{method:'POST',...options,signal:AbortSignal.timeout(120000)});payload=await response.json();}
    catch{throw Object.assign(new Error('telegram_delivery_ambiguous'),{code:'TELEGRAM_DELIVERY_UNKNOWN',definite:false});}
    if(!response.ok||!payload.ok)throw Object.assign(new Error('telegram_api_rejected'),{code:`TELEGRAM_HTTP_${response.status}_${payload.error_code||0}`,definite:response.status<500});
    return payload.result;
  }
}
export function secretMatches(actual,expected){if(!actual||!expected)return false;const a=Buffer.from(actual),b=Buffer.from(expected);return a.length===b.length&&timingSafeEqual(a,b);}
export function storageLoader(db){return async a=>{validateArtifact(a);if(a.bucket===HOME_ASSET.bucket)return loadOwnedHomeAsset(a);const {data,error}=await db.storage.from(a.bucket).download(a.path);if(error)throw new Error('canonical_artifact_unavailable');const bytes=Buffer.from(await data.arrayBuffer());if(bytes.length!==a.size||sha256(bytes)!==a.sha256)throw new Error('artifact_bytes_mismatch');return bytes;};}
export async function probeOriginal(bytes,a){
  if(bytes.length!==a.size||sha256(bytes)!==a.sha256)throw new Error('artifact_bytes_mismatch');
  if(a.mime!=='video/mp4')return;
  const dir=await mkdtemp(join(tmpdir(),'lumi-review-'));try{const path=join(dir,'original.mp4');await writeFile(path,bytes);
    const {stdout}=await exec('ffprobe',['-v','error','-show_entries','format=duration:stream=codec_name,width,height','-of','json',path]);const probe=JSON.parse(stdout),video=probe.streams.find(x=>x.codec_name==='h264');
    if(!video||video.width!==a.width||video.height!==a.height||Math.abs(Number(probe.format.duration)-a.duration)>0.06)throw new Error('master_metadata_mismatch');
    await exec('ffmpeg',['-v','error','-xerror','-i',path,'-f','null','-'],{maxBuffer:1024*1024});
  }finally{await rm(dir,{recursive:true,force:true});}
}
export async function assertPaidShotReviewGate({db,episodeId}){
  const {data,error}=await db.from('lumi_telegram_review_sessions').select('state').eq(`state->episodes->${episodeId}->>episode_id`,episodeId);
  if(error)throw new Error('review_gate_unavailable');
  if(data?.length!==1)throw new Error('review_episode_registration_required');
  const state=data[0].state,episode=state.episodes[episodeId];
  if(state.pending_callback)throw new Error('TELEGRAM_CALLBACK_PENDING');
  if(['EMITTING','UNKNOWN','FAILED'].includes(state.delivery?.status))throw new Error('TELEGRAM_DELIVERY_FAILED');
  const gate=reviewGate(episode);if(gate!=='READY_TO_CONTINUE')throw new Error(gate);return gate;
}
export async function assertRuntimeReviewGate(env,episodeId){
  if(!enabled(env))return;
  const {createClient}=await import('@supabase/supabase-js');const db=createClient(env.SUPABASE_URL,env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false}});
  await assertPaidShotReviewGate({db,episodeId});
}
export function mountTelegramReview(app,{db,env=process.env,authorized,productionAdapters={}}){
  const store=db?new SupabaseReviewStore(db):null;
  if(env.LUMI_RUNTIME_ENV==='staging')console.log(JSON.stringify({event:'lumi_telegram_review_transport_readiness',enabled:enabled(env),bot_credential:!!env.LUMI_TELEGRAM_BOT_TOKEN,callback_secret:!!env.LUMI_TELEGRAM_CALLBACK_SECRET,storage:!!db,provider_calls:0}));
  const owner=async(user,chat)=>{const {data,error}=await db.from('cf_bot_admins').select('user_id').eq('user_id',user).eq('chat_id',chat).eq('active',true).maybeSingle();return !error&&!!data;};
  const generic=env.LUMI_RUNTIME_ENV==='staging'&&db?new GenericLumiV2Adapter({manager:new LumiRecoveryIncidentManager({store:new SupabaseLumiRecoveryStore(db)}),journal:new SupabaseEmissionStore(db),reviewStore:store}):null;
  const production=new ProductionReviewController({store,adapters:{...(generic?{LUMI_PRODUCTION_PROFILE_V2:generic}:{}),...productionAdapters}});
  mountMakeTransportEndpoint(app,{db,store,env,loadBytes:storageLoader(db),validateOwner:owner,production});
  mountExistingMasterBootstrap(app,{db,store,env,validateOwner:owner,probe:probeOriginal});
  const service=()=>new ReviewService({store,production,telegram:new TelegramTransport({token:env.LUMI_TELEGRAM_BOT_TOKEN}),loadBytes:storageLoader(db),validateOwner:owner});
  const guard=(req,res,next)=>{if(!enabled(env))return res.status(404).json({error:'review_feature_disabled'});if(!authorized(req))return res.status(401).json({error:'unauthorized'});if(!db)return res.status(503).json({error:'review_storage_unavailable'});next();};
  app.get('/lumi/telegram-review/readiness',(req,res)=>{
    if(!authorized(req)||env.LUMI_RUNTIME_ENV!=='staging')return res.status(401).json({error:'unauthorized'});
    res.json({enabled:enabled(env),bot_credential:!!env.LUMI_TELEGRAM_BOT_TOKEN,callback_secret:!!env.LUMI_TELEGRAM_CALLBACK_SECRET,storage:!!db,provider_calls:0});
  });
  app.post('/lumi/telegram-review/register',guard,async(req,res)=>{
    try{
      const {user_id,chat_id,cover,episode}=req.body;
      const legacy_menu=legacyMenu;
      if(!await owner(user_id,chat_id))return res.status(403).json({error:'owner_inactive'});
      const {data,error}=await db.from('cf_bot_sessions').select('phase,data').eq('user_id',user_id).maybeSingle();
      const message_id=Number(data?.data?.menu_message_id);
      if(error||data?.phase==='closed'||!message_id)return res.status(409).json({error:'existing_operational_message_required'});
      const load=storageLoader(db);await probeOriginal(await load(cover),cover);
      for(const shot of episode.shots||[]){if(shot.artifact)await probeOriginal(await load(shot.artifact),shot.artifact);}
      if(episode.master)await probeOriginal(await load(episode.master),episode.master);
      const old=await store.get(user_id);
      if(!old)await store.create(user_id,newSession({user_id,chat_id,message_id,cover,legacy_menu}));
      else if(old.state.message_id!==message_id)throw new Error('operational_message_changed_requires_reconciliation');
      await service().registerEpisode(String(user_id),String(chat_id),episode);res.json({ok:true,message_id,provider_calls:0});
    }catch{res.status(409).json({error:'registration_failed_closed',provider_calls:0});}
  });
  app.post('/lumi/telegram-review/completed',guard,async(req,res)=>{
    try{const body=req.body;await service().read(body.user,body.chat);await probeOriginal(await storageLoader(db)(body.artifact),body.artifact);res.json(await production.completed(body));}
    catch{res.status(409).json({error:'production_review_completion_failed',provider_calls:0});}
  });
  app.post('/lumi/telegram-review/show',guard,async(req,res)=>{try{res.json(await service().show(req.body.user_id,req.body.chat_id,req.body.screen));}catch(error){res.status(409).json({error:error.message,provider_calls:0});}});
  app.post('/lumi/telegram-review/callback',async(req,res)=>{
    if(!enabled(env))return res.status(404).json({error:'review_feature_disabled'});
    if(!secretMatches(req.headers['x-telegram-bot-api-secret-token'],env.LUMI_TELEGRAM_CALLBACK_SECRET))return res.status(401).json({error:'unauthorized'});
    try{const cb=req.body.callback_query;if(!cb?.id||!String(cb.data).startsWith('lr:'))return res.status(400).json({error:'invalid_callback'});
      const svc=service();await svc.reconcile(cb);await svc.callback(cb);res.json({ok:true});
    }catch{res.status(409).json({error:'review_callback_pending',provider_calls:0});}
  });
  mountMakeBridge(app,{db,service,enabled:()=>enabled(env),legacyEndpoint:`${env.SUPABASE_URL}/functions/v1/content-factory-bot`,serviceRoleKey:env.SUPABASE_SERVICE_ROLE_KEY});
  return {enabled:()=>enabled(env)};
}

export async function recordCompletedShotReview({db,episodeId,shotId,result}){
  const {data,error}=await db.from('lumi_telegram_review_sessions').select('user_id,revision,state').eq(`state->episodes->${episodeId}->>episode_id`,episodeId);
  if(error||data?.length!==1)throw new Error('review_episode_registration_required');
  const row=data[0],e=row.state.episodes[episodeId],shot=e.shots.find(s=>s.shot_id===shotId);
  if(!shot)throw new Error('review_shot_registration_required');
  shot.artifact={artifact_id:result.attempt,sha256:result.sha256,size:result.bytes,mime:result.mime,bucket:result.artifact_bucket,path:result.artifact_path,
    duration:result.technical_qa.duration,width:result.technical_qa.width,height:result.technical_qa.height};
  validateArtifact(shot.artifact);
  shot.technical_qa=result.technical_qa.DECODE==='PASS'&&result.technical_qa.BLACK_FRAMES===0&&result.technical_qa.FREEZE_DEFECTS===0?'PASS':'REVIEW_REQUIRED';
  shot.creative_qa=result.temporal_qa?.classification||'REVIEW_REQUIRED';
  row.state.recovery_state=reviewGate(e);
  await new SupabaseReviewStore(db).cas(row.user_id,row.revision,row.state);
  return row.state.recovery_state;
}
