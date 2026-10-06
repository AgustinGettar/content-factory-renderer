import { createHash, randomBytes } from 'node:crypto';
export const VERSION = 'LUMI_TELEGRAM_PRODUCTION_REVIEW_V1';
export const SHELL = 'LUMI_TELEGRAM_SINGLE_MESSAGE_SHELL_V1';
export const MODES = ['SUPERVISED', 'AUTO_WITH_EXCEPTIONS'];
export const WAIT_STATES = ['WAITING_HUMAN_SHOT_REVIEW','WAITING_FINAL_REVIEW','TELEGRAM_DELIVERY_FAILED','TELEGRAM_CALLBACK_PENDING'];
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const clone = x => structuredClone(x);
const stamp = () => new Date().toISOString();
const fail = message => { throw new Error(message); };
export function enabled(env = process.env) { return env.LUMI_RUNTIME_ENV === 'staging' && env.LUMI_TELEGRAM_REVIEW_V1 === 'true'; }
export function reviewGate(episode) {
  if (!MODES.includes(episode.review_mode)) fail('review_mode_required');
  if (episode.cancelled) return 'CANCELLED';
  if (episode.master && episode.reviews?.[episode.master.sha256]?.status !== 'APPROVED') return 'WAITING_FINAL_REVIEW';
  if (episode.incident || episode.provider_repair_required || episode.budget_change || episode.budget_approved === false) return 'PAUSED_INCIDENT';
  for (const shot of episode.shots || []) {
    if (!shot.artifact) continue;
    const review = episode.reviews?.[shot.artifact.sha256];
    if (review?.status === 'REJECTED') return 'WAITING_HUMAN_SHOT_REVIEW';
    if (review?.status === 'APPROVED') continue;
    if (episode.review_mode === 'SUPERVISED' || shot.technical_qa !== 'PASS' || shot.creative_qa !== 'PASS') return 'WAITING_HUMAN_SHOT_REVIEW';
  }
  return episode.master ? 'APPROVED' : 'READY_TO_CONTINUE';
}
export function assemblyEligible(episode, shot) {
  const r = episode.reviews?.[shot.artifact?.sha256];
  if (r) return r.status === 'APPROVED' && r.artifact_sha === shot.artifact.sha256;
  return episode.review_mode === 'AUTO_WITH_EXCEPTIONS' && shot.technical_qa === 'PASS' && shot.creative_qa === 'PASS';
}
export function validateArtifact(a) {
  if (!a || !/^[a-f0-9]{64}$/.test(a.sha256) || !a.artifact_id || !Number.isSafeInteger(a.size) || a.size <= 0) fail('invalid_artifact');
  if (!['video/mp4','image/png','image/jpeg'].includes(a.mime)) fail('invalid_artifact_mime');
  if (!a.bucket || !a.path || a.path.includes('..') || a.path.startsWith('/')) fail('canonical_storage_required');
  return a;
}
export function newSession({user_id,chat_id,message_id,cover,legacy_menu=[]}) {
  if (!user_id || !chat_id || !Number.isSafeInteger(message_id) || message_id <= 0) fail('existing_operational_message_required');
  validateArtifact(cover);
  return {version:SHELL,user_id:String(user_id),chat_id:String(chat_id),message_id,cover,legacy_menu,
    media_capable:false,episodes:{},deliveries:{},reviews:[],applied:{},tokens:{},screen:{kind:'menu'},delivery:null};
}
export class MemoryReviewStore {
  constructor(){this.rows=new Map();}
  async get(id){return clone(this.rows.get(String(id))||null);}
  async create(id,state){if(this.rows.has(String(id)))fail('session_exists');this.rows.set(String(id),{revision:0,state:clone(state)});}
  async cas(id,revision,state){const row=this.rows.get(String(id));if(!row||row.revision!==revision)fail('concurrent_update');this.rows.set(String(id),{revision:revision+1,state:clone(state)});return revision+1;}
}
export class SupabaseReviewStore {
  constructor(db){this.db=db;}
  async get(id){const {data,error}=await this.db.from('lumi_telegram_review_sessions').select('revision,state').eq('user_id',String(id)).maybeSingle();if(error)fail('review_state_read_failed');return data;}
  async create(id,state){const {error}=await this.db.from('lumi_telegram_review_sessions').insert({user_id:String(id),chat_id:state.chat_id,message_id:state.message_id,state,revision:0});if(error)fail('review_session_create_failed');}
  async cas(id,revision,state){const {data,error}=await this.db.from('lumi_telegram_review_sessions').update({state,revision:revision+1,updated_at:stamp()}).eq('user_id',String(id)).eq('revision',revision).select('revision').maybeSingle();if(error)fail('review_state_write_failed');if(!data)fail('concurrent_update');return data.revision;}
}
function own(s, user, chat, message=s.message_id) {
  if(s.user_id!==String(user)||s.chat_id!==String(chat)||s.message_id!==Number(message))fail('review_ownership_mismatch');
}
const shotReasons=[['👤 Lumi / anatomía','anatomy'],['🎨 Estilo / calidad','style'],['🎬 Movimiento','motion'],['🌸 Objeto educativo','object'],['✏️ Otro','other']];
const finalReasons=[['🎬 Una toma','shot'],['🔊 Voz/audio','audio'],['💬 Subtítulos','captions'],['🎵 Música/SFX','music'],['⏱ Ritmo','pacing'],['✏️ Otro','other']];
export function buildScreen(s, screen=s.screen) {
  const e=s.episodes[screen.episode_id];
  const tokens={};
  const button=(text,action,extra={})=>{const token=randomBytes(12).toString('hex');tokens[token]={action,episode_id:e?.episode_id,...extra};return {text,callback_data:`lr:${token}`};};
  const row=(text,action,extra)=>[button(text,action,extra)];
  const menu=()=>row('🏠 Menú principal','menu');
  const progress=()=>row('📊 Ver producción','progress');
  let artifact=s.cover,caption='',rows=[];
  if(screen.kind==='legacy'){
    const legacy=s.legacy_screen;if(!legacy)fail('legacy_screen_missing');
    const chunks=legacy.text.match(/[\s\S]{1,850}/g)||[''];const page=Math.max(0,Math.min(Number(screen.page)||0,chunks.length-1));
    caption=chunks[page]+(chunks.length>1?`\n\n${page+1}/${chunks.length}`:'');
    rows=[...legacy.rows,[...(page>0?[button('◀️','legacy',{page:page-1})]:[]),...(page<chunks.length-1?[button('▶️','legacy',{page:page+1})]:[])],menu()];
  }else if(screen.kind==='menu'){
    caption='✨ Content Factory · Lumi\n\nTu panel de contenido. Elegí qué querés hacer.';
    rows=[...s.legacy_menu,
      row('🎬 Producción actual','current'),row('📚 Mis videos','library',{page:0})];
  }else if(screen.kind==='library'){
    const episodes=Object.values(s.episodes).filter(x=>x.master), page=Math.max(0,Math.min(Number(screen.page)||0,Math.max(0,Math.ceil(episodes.length/5)-1)));
    caption='📚 Mis videos';rows=episodes.slice(page*5,page*5+5).map(x=>[button(x.title,'master',{episode_id:x.episode_id})]);
    rows.push([...(page>0?[button('◀️','library',{page:page-1})]:[]),...(episodes.length>(page+1)*5?[button('▶️','library',{page:page+1})]:[])].filter(Boolean));rows.push(menu());
  }else{
    if(!e)fail('episode_not_found');
    const gate=reviewGate(e),shot=e.shots?.[screen.index||0];
    if(screen.kind==='progress'){
      const completed=e.shots.filter(x=>x.artifact).length, pct=e.master?100:Math.min(95,Math.round(20+60*completed/Math.max(e.shots.length,1)+(e.audio_status==='COMPLETE'?15:0)));
      caption=`✨ ${e.title}\n\nProducción ${'█'.repeat(Math.floor(pct/10))}${'░'.repeat(10-Math.floor(pct/10))} ${pct}%\n\nEtapa: ${e.current_stage||gate}\n✅ Videos ${completed}/${e.shots.length}\nVoz: ${e.voice_status||'PENDIENTE'}\nAudio: ${e.audio_status||'PENDIENTE'}\nMaster: ${e.master?'Listo para revisión':'PENDIENTE'}\nCosto confirmado: ${e.confirmed_cost||'No disponible'}${e.incident?'\n⚠️ Requiere atención':''}`;
      rows=[...(completed?[row('🎬 Revisar tomas','shot',{index:0})]:[]),...(e.master?[row('▶️ Ver master','master')]:[]),...(e.resume_available&&gate==='READY_TO_CONTINUE'?[row('▶️ Continuar / Reanudar','resume')]:[]),...(e.incident?[row('⚠️ Ver incidente','incident')]:[]),...(!e.master&&!e.cancelled?[row('🛑 Cancelar','cancel')]:[]),menu()];
    }else if(screen.kind==='shot'){
      if(!shot?.artifact)fail('shot_not_available');artifact=shot.artifact;
      const review=e.reviews?.[artifact.sha256];
      caption=`🎬 Revisión de toma · ${(screen.index||0)+1}/${e.shots.length}\n\n${shot.shot_id}\n${shot.description||''}\n\nQA técnico: ${shot.technical_qa}\nQA creativo: ${shot.creative_qa}${shot.warning?'\n⚠️ '+shot.warning:''}\nCosto: ${shot.cost||'No disponible'}\n\nHuman Review: ${review?.status||'PENDING'}`;
      const bind={shot_id:shot.shot_id,sha:artifact.sha256,index:screen.index||0};
      rows=[row('✅ Aprobar toma','approve_shot',bind),row('❌ Rechazar','reject_menu',bind),[...(screen.index>0?[button('◀️ Anterior','shot',{index:screen.index-1})]:[]),...(screen.index<e.shots.length-1?[button('Siguiente ▶️','shot',{index:screen.index+1})]:[])],progress(),menu()];
    }else if(['master','download'].includes(screen.kind)){
      if(!e.master)fail('master_not_available');artifact=e.master;
      const approved=e.reviews?.[artifact.sha256]?.status==='APPROVED';
      caption=`${approved?'✅ Video aprobado':'🎉 Video terminado'}\n\n${e.title}\n\n${Number(artifact.duration).toFixed(1)} s · ${artifact.width===1080&&artifact.height===1920?'Full HD':`${artifact.width}×${artifact.height}`}\n\n✅ ${e.shots.length}/${e.shots.length} tomas\n✅ ${e.beats}/${e.beats} momentos educativos\n✅ Voz aprobada\n✅ QA técnico\n${approved?'✅ Aprobado':'✅ Listo para revisión'}${screen.kind==='download'?'\n\n⬇️ Abrí el video y elegí Guardar/Descargar en Telegram. Es el MP4 original.':''}`;
      const bind={sha:artifact.sha256};
      rows=[...(!approved?[row('✅ Aprobar video','approve_final',bind),row('🔧 Solicitar cambios','changes_menu',bind)]:[row('📚 Mis videos','library',{page:0})]),row('⬇️ Descargar MP4','download',bind),progress(),menu()];
    }else if(screen.kind==='reject_menu'||screen.kind==='changes_menu'){
      caption='🔧 ¿Qué querés corregir?';
      const reasons=screen.kind==='reject_menu'?shotReasons:finalReasons;
      rows=reasons.map(([label,reason])=>row(label,'reject',{...screen,reason,final:screen.kind==='changes_menu'}));
      rows.push(row('◀️ Volver',screen.kind==='reject_menu'?'shot':'master',{index:screen.index||0}));
    }else if(screen.kind==='incident'){
      caption=`⚠️ ${e.title}\n\n${e.incident?.message||'Sin incidentes pendientes.'}\n\nLos cambios requieren autorización. No se genera multimedia automáticamente.`;
      rows=[progress(),menu()];
    }else fail('unknown_screen');
  }
  return {artifact,caption:caption.slice(0,1024),reply_markup:{inline_keyboard:rows.filter(r=>r.length)},tokens};
}
export class ReviewService {
  constructor({store,telegram,loadBytes,validateOwner=async()=>true,production=null}){this.store=store;this.telegram=telegram;this.loadBytes=loadBytes;this.validateOwner=validateOwner;this.production=production;}
  async read(user,chat,message){const row=await this.store.get(user);if(!row)fail('existing_operational_message_required');own(row.state,user,chat,message);if(!await this.validateOwner(user,chat))fail('review_owner_inactive');return row;}
  async legacy(user,chat,text,rows){
    const r=await this.read(user,chat);if(['EMITTING','UNKNOWN'].includes(r.state.delivery?.status))fail('telegram_delivery_reconciliation_required');
    r.state.legacy_screen={text:String(text),rows};await this.store.cas(user,r.revision,r.state);
    return this.show(user,chat,{kind:'legacy',page:0});
  }
  async registerEpisode(user,chat,episode){
    const row=await this.read(user,chat);if(row.state.delivery?.status==='EMITTING')fail('telegram_delivery_reconciliation_required');
    if(!/^[a-zA-Z0-9_-]{1,80}$/.test(episode.episode_id)||!Array.isArray(episode.shots)||!MODES.includes(episode.review_mode))fail('invalid_episode');
    for(const shot of episode.shots){if(shot.artifact)validateArtifact(shot.artifact);}if(episode.master)validateArtifact(episode.master);
    const previous=row.state.episodes[episode.episode_id];
    row.state.episodes[episode.episode_id]={...clone(episode),resume_available:!!this.production?.canResume(episode),reviews:previous?.reviews||episode.reviews||{}};
    await this.store.cas(user,row.revision,row.state);
  }
  async show(user,chat,screen){
    let {state:s,revision}=await this.read(user,chat);
    if(['EMITTING','UNKNOWN'].includes(s.delivery?.status))fail('telegram_delivery_reconciliation_required');
    const view=buildScreen(s,screen),a=validateArtifact(view.artifact),cache=s.deliveries[a.sha256];
    let bytes;
    if(!cache){bytes=Buffer.from(await this.loadBytes(a));if(bytes.length!==a.size||sha256(bytes)!==a.sha256)fail('artifact_bytes_mismatch');if(a.mime==='video/mp4'&&bytes.length>50_000_000)fail('review_proxy_and_authenticated_download_required');}
    s.screen=clone(screen);s.tokens={...s.tokens,...view.tokens};
    // Keep a bounded history so duplicate callbacks and recently displayed buttons survive edits.
    s.tokens=Object.fromEntries(Object.entries(s.tokens).slice(-500));
    s.delivery={status:'EMITTING',artifact_sha:a.sha256,screen:clone(screen),started_at:stamp(),tokens:Object.keys(view.tokens)};
    revision=await this.store.cas(user,revision,s);
    const media={type:a.mime==='video/mp4'?'video':'photo',media:cache?.telegram_file_id||'attach://media',caption:view.caption,
      ...(a.mime==='video/mp4'?{supports_streaming:true,width:a.width,height:a.height,duration:Math.ceil(a.duration)}:{})};
    let message;
    try{message=await this.telegram.call('editMessageMedia',{chat_id:s.chat_id,message_id:s.message_id,media,reply_markup:view.reply_markup},bytes?{bytes,mime:a.mime}:null);}
    catch(error){
      s.delivery.status=error.definite?'FAILED':'UNKNOWN';s.delivery.error=error.code||'telegram_transport_failed';
      s.delivery.retry_delivery_only=true;s.recovery_state='TELEGRAM_DELIVERY_FAILED';
      await this.store.cas(user,revision,s);throw new Error(s.delivery.error);
    }
    if(Number(message.message_id)!==s.message_id||String(message.chat?.id)!==s.chat_id)fail('telegram_message_identity_mismatch');
    const remote=message.video||message.photo?.at(-1);
    if(!remote?.file_id||!remote.file_unique_id)fail('telegram_file_identity_missing');
    s.deliveries[a.sha256]={user:s.user_id,chat:s.chat_id,episode_id:screen.episode_id||null,artifact_id:a.artifact_id,artifact_sha:a.sha256,media_kind:media.type,
      telegram_file_id:remote.file_id,telegram_file_unique_id:remote.file_unique_id,telegram_message_id:s.message_id,upload_timestamp:cache?.upload_timestamp||stamp(),last_viewed_at:stamp(),review_status:s.episodes[screen.episode_id]?.reviews?.[a.sha256]?.status||'PENDING'};
    s.media_capable=true;s.delivery.status='DELIVERED';s.pending_callback=null;s.recovery_state=s.episodes[screen.episode_id]?reviewGate(s.episodes[screen.episode_id]):null;
    await this.store.cas(user,revision,s);return {message_id:s.message_id,artifact_sha:a.sha256,file_id:remote.file_id,file_unique_id:remote.file_unique_id};
  }
  async callback(cb){
    const user=String(cb.from?.id),chat=String(cb.message?.chat?.id);
    let {state:s,revision}=await this.read(user,chat,cb.message?.message_id);
    await this.telegram.call('answerCallbackQuery',{callback_query_id:cb.id});
    if(s.delivery?.status==='EMITTING'||s.delivery?.status==='UNKNOWN')fail('telegram_delivery_reconciliation_required');
    const t=s.tokens[String(cb.data).replace(/^lr:/,'')];if(!t)fail('invalid_callback_token');
    s.pending_callback={id:cb.id,token:String(cb.data),status:'PENDING',started_at:stamp()};s.recovery_state='TELEGRAM_CALLBACK_PENDING';
    revision=await this.store.cas(user,revision,s);
    const e=s.episodes[t.episode_id],shot=e?.shots?.find(x=>x.shot_id===t.shot_id),a=t.shot_id?shot?.artifact:e?.master;
    if(t.sha&&a?.sha256!==t.sha)fail('stale_artifact_callback');
    let screen={kind:t.action,episode_id:t.episode_id,index:t.index||0,page:t.page||0,...(t.sha?{sha:t.sha,shot_id:t.shot_id}:{})};
    if(t.action==='current'){const latest=Object.values(s.episodes).at(-1);if(!latest)fail('no_current_production');screen={kind:'progress',episode_id:latest.episode_id};}
    if(t.action==='resume'){
      if(!this.production)fail('canonical_resume_unavailable');
      await this.production.resume({user,episodeId:t.episode_id});
      return this.show(user,chat,{kind:'progress',episode_id:t.episode_id});
    }
    if(['approve_shot','approve_final','reject','cancel'].includes(t.action)){
      if(!e)fail('episode_not_found');
      const key=sha256(`${user}:${e.episode_id}:${t.sha||'episode'}:${t.action}`);
      if(!s.applied[key]){
        if(t.action==='cancel'){e.cancelled=true;e.incident={message:'Producción cancelada. Artefactos conservados.',kind:'CANCELLED'};}
        else{
          if(!a||!t.sha)fail('artifact_binding_required');
          const reject=t.action==='reject';
          if(reject&&!(t.final?finalReasons:shotReasons).some(x=>x[1]===t.reason))fail('invalid_rejection_reason');
          const review={episode_id:e.episode_id,shot_id:t.shot_id||null,artifact_sha:t.sha,status:reject?'REJECTED':'APPROVED',user,timestamp:stamp(),
            qa_disposition:reject?'REPAIR_AUTHORIZATION_REQUIRED':shot&&shot.creative_qa!=='PASS'?'HUMAN_OVERRIDE_AUTOMATED_FINDINGS_PRESERVED':'HUMAN_APPROVED',reason:reject?t.reason:null,assembly_eligible:!reject&&t.action==='approve_shot'};
          e.reviews||={};e.reviews[t.sha]=review;s.reviews.push(review);
          if(s.deliveries[t.sha])s.deliveries[t.sha].review_status=review.status;
          if(reject)e.incident={kind:'REPAIR_AUTHORIZATION_REQUIRED',artifact_sha:t.sha,reason:t.reason,message:'Cambio solicitado: '+t.reason,provider_calls_authorized:0};
        }
        s.applied[key]=stamp();s.recovery_state=reviewGate(e);
        await this.store.cas(user,revision,s);
      }
      if(t.action==='cancel'&&this.production)await this.production.cancel({user,episodeId:e.episode_id});
      screen={kind:t.action==='reject'||t.action==='cancel'?'incident':t.action==='approve_shot'?'shot':'master',episode_id:e.episode_id,index:t.index||0};
    }
    return this.show(user,chat,screen);
  }
  // Reconcile a delivery whose HTTP response was lost using the next authentic callback's message.
  async reconcile(cb){
    const user=String(cb.from?.id),chat=String(cb.message?.chat?.id);const {state:s,revision}=await this.read(user,chat,cb.message?.message_id);
    if(!['EMITTING','UNKNOWN'].includes(s.delivery?.status))return false;
    const token=s.tokens[String(cb.data).replace(/^lr:/,'')];if(!token||!s.delivery.tokens?.includes(String(cb.data).replace(/^lr:/,'')))fail('reconciliation_token_missing');
    const view=buildScreen(s,s.delivery.screen),a=view.artifact;
    // Only accept a callback generated for this pending screen and exact media caption.
    if(cb.message.caption!==view.caption)fail('reconciliation_caption_mismatch');
    const remote=cb.message.video||cb.message.photo?.at(-1);if(!remote?.file_id||!remote.file_unique_id)fail('reconciliation_media_missing');
    s.deliveries[a.sha256]={user:s.user_id,chat:s.chat_id,episode_id:s.delivery.screen.episode_id||null,artifact_id:a.artifact_id,artifact_sha:a.sha256,media_kind:cb.message.video?'video':'photo',telegram_file_id:remote.file_id,telegram_file_unique_id:remote.file_unique_id,telegram_message_id:s.message_id,upload_timestamp:stamp(),review_status:'PENDING'};
    s.delivery.status='DELIVERED';s.media_capable=true;await this.store.cas(user,revision,s);return true;
  }
}
