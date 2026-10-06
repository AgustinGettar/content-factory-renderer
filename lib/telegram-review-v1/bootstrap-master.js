import express from 'express';
import {newSession,sha256,reviewKey} from './core.js';
import {verifyRequest,scopedEnabled,claimRequest} from './make-transport.js';
import {legacyMenu} from './bridge.js';
import {LumiRecoveryIncidentManager,SupabaseLumiRecoveryStore} from '../lumi-recovery-incident-manager-v1.js';

export const EXISTING_MASTER=Object.freeze({artifact_id:'LUMI_SHORT_TRES_FLORES_COLORES_V1',filename:'LUMI_SHORT_TRES_FLORES_COLORES_V1.mp4',
  sha256:'b6f9fe837d000a924608ed4bda13034ff30560ac48b5a085f7cb0a90f35a2624',size:30709796,
  mime:'video/mp4',duration:41.125,width:1080,height:1920,bucket:'av2-generative-video-benchmarks',
  path:'lumi-telegram-review/ep_lumi_flores_003/b6f9fe837d000a924608ed4bda13034ff30560ac48b5a085f7cb0a90f35a2624/LUMI_SHORT_TRES_FLORES_COLORES_V1.mp4'});

export function mountExistingMasterBootstrap(app,{db,store,env,validateOwner,probe}){
 const path='/lumi/telegram-review/bootstrap/master';
 app.post(path,express.raw({type:'video/mp4',limit:'40mb'}),async(req,res)=>{
  const user='6213838779',chat=user;
  if(!scopedEnabled(env,user,chat))return res.status(404).json({error:'review_scope_disabled'});
  const signed={timestamp:req.headers['x-lumi-timestamp'],requestId:req.headers['x-lumi-request-id'],method:'POST',path,body:req.body};
  try{if(!Buffer.isBuffer(req.body))throw Error();verifyRequest(env.LUMI_TELEGRAM_CALLBACK_SECRET,signed,req.headers['x-lumi-signature']);}
  catch{return res.status(401).json({error:'invalid_signed_request'});}
  try{
   if(req.body.length!==EXISTING_MASTER.size||sha256(req.body)!==EXISTING_MASTER.sha256)throw Error('immutable_master_mismatch');
   if(!await validateOwner(user,chat))throw Error('owner_inactive');
   const session=await db.from('cf_bot_sessions').select('phase,data').eq('user_id',user).single();
   if(session.error||session.data.phase==='closed'||Number(session.data.data?.menu_message_id)!==138)throw Error('canonical_panel_changed');
   const old=await store.get(user);
   if(old){await claimRequest(store,user,signed);if(old.state.message_id!==138||old.state.episodes.ep_lumi_flores_003?.master?.sha256!==EXISTING_MASTER.sha256)throw Error('existing_session_mismatch');return res.json({ok:true,already_registered:true,message_id:138});}
   await probe(req.body,EXISTING_MASTER);
   const storage=db.storage.from(EXISTING_MASTER.bucket);
   const upload=await storage.upload(EXISTING_MASTER.path,req.body,{contentType:'video/mp4',upsert:false});
   if(upload.error){const check=await storage.download(EXISTING_MASTER.path);if(check.error||sha256(Buffer.from(await check.data.arrayBuffer()))!==EXISTING_MASTER.sha256)throw Error('master_storage_failed');}
   const cp=await db.from('lumi_pipeline_checkpoints').select('metadata,current_cost_usd,status').eq('episode_id','ep_lumi_flores_003').single();
   if(cp.error)throw Error('checkpoint_unavailable');
   const approved=cp.data.metadata.approved_visuals_current_episode||{};
   if(Object.keys(approved).length!==6)throw Error('six_shots_evidence_required');
   const episode={episode_id:'ep_lumi_flores_003',pipeline:'v1_1_2',title:'🌼 Lumi y las tres flores de colores',
     review_mode:'SUPERVISED',master:{...EXISTING_MASTER},beats:9,shots:[],reviews:{},review_versions:{},
     visual_completed:6,voice_status:'Annie + ElevenLabs',audio_status:'COMPLETE',current_stage:'MASTER',
     confirmed_cost:`USD ${cp.data.current_cost_usd} (registro histórico; no incluye costos aún sin conciliar)`,
     resume_available:false,production_authorization:null};
   for(const [id,ref] of Object.entries(approved))episode.shots.push({shot_id:id,historical_artifact_sha:ref.sha256,historical_attempt:ref.attempt,artifact:null,human_review_preserved:true});
   const state=newSession({user_id:user,chat_id:chat,message_id:138,cover:{...EXISTING_MASTER},legacy_menu:legacyMenu});
   state.episodes[episode.episode_id]=episode;state.recovery_state='WAITING_FINAL_REVIEW';
   state.canonical_panel_candidate={message_id:138,chat_id:chat,evidence:'cf_bot_sessions; Telegram edit acknowledgement still required'};
   await store.create(user,state);await claimRequest(store,user,signed);
   const manager=new LumiRecoveryIncidentManager({store:new SupabaseLumiRecoveryStore(db)});
   await manager.checkpoint(episode.episode_id,draft=>{
     draft.metadata.telegram_review_completion={master_sha:EXISTING_MASTER.sha256,master_path:EXISTING_MASTER.path,master_bucket:EXISTING_MASTER.bucket,
       previous_checkpoint_status:draft.status,human_review:'HUMAN_REVIEW_PENDING',review_state:'WAITING_FINAL_REVIEW',provider_calls:0,source:'existing_immutable_master',recorded_at:new Date().toISOString()};
   });
   res.json({ok:true,message_id:138,master_sha:EXISTING_MASTER.sha256,provider_calls:0});
  }catch(error){res.status(409).json({error:error.message,provider_calls:0});}
 });
}
