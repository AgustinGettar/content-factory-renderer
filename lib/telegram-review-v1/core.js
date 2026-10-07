import {publicationPanel} from './publication-preview.js';
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
export const reviewKey = (episode, shot, sha) => JSON.stringify([episode, shot || null, sha]);
export function artifactReview(episode, artifact, shotId=null) {
  if(!artifact)return null;
  const r=episode.reviews?.[reviewKey(episode.episode_id,shotId,artifact.sha256)] || episode.reviews?.[artifact.sha256];
  return r && r.episode_id===episode.episode_id && (r.shot_id||null)===(shotId||null) && r.artifact_sha===artifact.sha256 ? r : null;
}
export function reviewGate(episode) {
  if (!MODES.includes(episode.review_mode)) fail('review_mode_required');
  if (episode.cancelled) return 'CANCELLED';
  if(Object.values(episode.review_requests||{}).some(r=>r.status==='REJECTED'))return 'PAUSED_INCIDENT';
  if(Object.values(episode.review_requests||{}).some(r=>r.status==='PENDING'))return 'WAITING_HUMAN_STAGE_REVIEW';
  if (episode.master && artifactReview(episode,episode.master)?.status !== 'APPROVED') return 'WAITING_FINAL_REVIEW';
  if (episode.incident || episode.provider_repair_required || episode.budget_change || episode.budget_approved === false) return 'PAUSED_INCIDENT';
  for (const shot of episode.shots || []) {
    if (!shot.artifact) continue;
    const review = artifactReview(episode,shot.artifact,shot.shot_id);
    if (review?.status === 'REJECTED') return 'WAITING_HUMAN_SHOT_REVIEW';
    if (review?.status === 'APPROVED') continue;
    if (episode.review_mode === 'SUPERVISED' || shot.technical_qa !== 'PASS' || shot.creative_qa !== 'PASS') return 'WAITING_HUMAN_SHOT_REVIEW';
  }
  return episode.master ? 'APPROVED' : 'READY_TO_CONTINUE';
}
export function assemblyEligible(episode, shot) {
  const r = artifactReview(episode,shot.artifact,shot.shot_id);
  if (r) return r.status === 'APPROVED' && r.artifact_sha === shot.artifact.sha256;
  return episode.review_mode === 'AUTO_WITH_EXCEPTIONS' && shot.technical_qa === 'PASS' && shot.creative_qa === 'PASS';
}
export function validateArtifact(a) {
  if (!a || !/^[a-f0-9]{64}$/.test(a.sha256) || !a.artifact_id || !Number.isSafeInteger(a.size) || a.size <= 0) fail('invalid_artifact');
  if (!['video/mp4','image/png','image/jpeg','audio/mpeg'].includes(a.mime)) fail('invalid_artifact_mime');
  if (!a.bucket || !a.path || a.path.includes('..') || a.path.startsWith('/')) fail('canonical_storage_required');
  return a;
}
export function newSession({user_id,chat_id,message_id,cover,legacy_menu=[]}) {
  if (!user_id || !chat_id || !Number.isSafeInteger(message_id) || message_id <= 0) fail('existing_operational_message_required');
  validateArtifact(cover);
  return {version:SHELL,user_id:String(user_id),chat_id:String(chat_id),message_id,cover,legacy_menu,
    panel_renderer_version:2,panel_model:'MEDIA_FIRST',navigation_stack:[],media_capable:false,episodes:{},deliveries:{},reviews:[],applied:{},tokens:{},screen:{kind:'menu'},delivery:null};
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
  const button=(text,action,extra={})=>{const token=randomBytes(12).toString('hex');const scope=extra.sha?reviewKey(e?.episode_id,extra.shot_id,extra.sha):null;tokens[token]={action,episode_id:e?.episode_id,...extra,...(scope?{review_version:e?.review_versions?.[scope]||0}:{})};return {text,callback_data:`lr:${token}`};};
  const row=(text,action,extra)=>[button(text,action,extra)];
  const menu=()=>row('🏠 Menú principal','menu');
  const progress=()=>row('📊 Ver producción','progress');
  const back=()=>row('⬅️ Volver','back',{return_screen:s.navigation_stack?.at(-1)||screen.return_to||{kind:'menu'}});
  let artifact=s.cover,caption='',rows=[];
  if(screen.kind==='legacy'){
    const legacy=s.legacy_screen;if(!legacy)fail('legacy_screen_missing');
    const chunks=legacy.text.match(/[\s\S]{1,850}/g)||[''];const page=Math.max(0,Math.min(Number(screen.page)||0,chunks.length-1));
    caption=chunks[page]+(chunks.length>1?`\n\n${page+1}/${chunks.length}`:'');
    rows=[...legacy.rows,[...(page>0?[button('◀️','legacy',{page:page-1})]:[]),...(page<chunks.length-1?[button('▶️','legacy',{page:page+1})]:[])],menu()];
  }else if(screen.kind==='menu'){
    caption='✨ Content Factory · Lumi\n\nTu panel de contenido. Elegí qué querés hacer.';
    rows=[...s.legacy_menu,
      row('🔎 Revisar producción','current'),row('📚 Mis videos','library',{page:0})];
  }else if(screen.kind==='library'){
    const episodes=Object.values(s.episodes).filter(x=>x.master), page=Math.max(0,Math.min(Number(screen.page)||0,Math.max(0,Math.ceil(episodes.length/5)-1)));
    caption='📚 Mis videos';rows=episodes.slice(page*5,page*5+5).map(x=>[button(x.title,'master',{episode_id:x.episode_id})]);
    rows.push([...(page>0?[button('◀️','library',{page:page-1})]:[]),...(episodes.length>(page+1)*5?[button('▶️','library',{page:page+1})]:[])].filter(Boolean));rows.push(menu());
  }else{
    if(!e)fail('episode_not_found');
    const gate=reviewGate(e),shot=e.shots?.[screen.index||0];
    if(['review','audio','audio_details'].includes(screen.kind)){
      const request=e.review_requests?.[screen.request_id];if(!request)fail('generic_review_not_found');
      const candidate=e.artifacts?.[request.artifact_id];
      if(candidate&&candidate.sha256!==request.artifact_sha)fail('stale_review_artifact');
      const audio=candidate?.mime==='audio/mpeg';if(audio)artifact=candidate;
      caption=audio?`🔊 Revisión de voz\n\nLumi · Español\nAnnie + ElevenLabs\n\nEstado:\n${request.status==='PENDING'?'Esperando revisión':request.status}`:`👀 ${e.title}\n\nRevisión pendiente · ${request.stage_id}\n${request.reason}\nEstado: ${request.status}`;
      if(screen.kind==='audio_details')caption+=`\n\nDuración: ${Number(candidate?.duration).toFixed(2)} s\nFrecuencia: ${candidate?.sample_rate} Hz\nCanales: ${candidate?.channels}\nRevisión: ${request.review_version}`;
      const bind={request_id:request.review_request_id,artifact_id:request.artifact_id,artifact_sha:request.artifact_sha,stage_id:request.stage_id,generic_review_version:request.review_version};
      if(audio&&request.transport_only){
        caption=caption.replace('TRANSPORT_ONLY','Revisión de audio');
        rows=[row('▶️ ESCUCHAR','audio',{request_id:request.review_request_id}),row('ℹ️ DETALLES','audio_details',{request_id:request.review_request_id}),row('⬅️ VOLVER','menu')];
      }else rows=[...(audio?[row('▶️ ESCUCHAR','audio',{request_id:request.review_request_id})]:[]),...(request.status==='PENDING'?[row('✅ Aprobar','approve_stage',bind),row('❌ Rechazar','reject_stage',bind)]:[]),...(audio?[row('ℹ️ DETALLES','audio_details',{request_id:request.review_request_id})]:[]),progress(),back(),menu()];
    }else if(screen.kind==='progress'){
      const available=e.shots.filter(x=>x.artifact).length,completed=e.master?(e.visual_completed??available):available, pct=e.master?100:Math.min(95,Math.round(20+60*completed/Math.max(e.shots.length,1)+(e.audio_status==='COMPLETE'?15:0)));
      caption=`✨ ${e.title}\n\nProducción ${'█'.repeat(Math.floor(pct/10))}${'░'.repeat(10-Math.floor(pct/10))} ${pct}%\n\nEtapa: ${e.current_stage||gate}\n✅ Videos ${completed}/${e.shots.length}\nVoz: ${e.voice_status||'PENDIENTE'}\nAudio: ${e.audio_status||'PENDIENTE'}\nMaster: ${e.master?'Listo para revisión':'PENDIENTE'}\nCosto confirmado: ${e.confirmed_cost||'No disponible'}${e.incident?'\n⚠️ Requiere atención':''}`;
      rows=[...(available?[row('🎬 Revisar tomas','shot',{index:0})]:[]),...(e.master?[row('▶️ Ver master','master')]:[]),...(e.resume_available&&gate==='READY_TO_CONTINUE'?[row('▶️ Continuar / Reanudar','resume')]:[]),...(e.incident?[row('⚠️ Ver incidente','incident')]:[]),...(!e.master&&!e.cancelled?[row('🛑 Cancelar','cancel')]:[]),menu()];
      for(const r of Object.values(e.review_requests||{}).filter(r=>r.status==='PENDING'))rows.unshift(row('👀 Revisar '+r.stage_id,'review',{request_id:r.review_request_id}));
    }else if(screen.kind==='shot'){
      if(!shot?.artifact)fail('shot_not_available');artifact=shot.artifact;
      const review=artifactReview(e,artifact,shot.shot_id);
      caption=`🎬 Revisión de toma · ${(screen.index||0)+1}/${e.shots.length}\n\n${shot.shot_id} · ${Number(artifact.duration).toFixed(1)} s\n${shot.description||''}\n\nQA técnico: ${shot.technical_qa}\nQA creativo: ${shot.creative_qa}${shot.warning?'\n⚠️ '+shot.warning:''}\nCosto: ${shot.cost||'No disponible'}\n\nHuman Review: ${review?.status||'PENDING'}`;
      const bind={shot_id:shot.shot_id,sha:artifact.sha256,index:screen.index||0};
      rows=[row('✅ Aprobar toma','approve_shot',bind),row('❌ Rechazar','reject_menu',bind),[...(screen.index>0?[button('◀️ Anterior','shot',{index:screen.index-1})]:[]),...(screen.index<e.shots.length-1?[button('Siguiente ▶️','shot',{index:screen.index+1})]:[])],progress(),back(),menu()];
    }else if(['master','download'].includes(screen.kind)){
      if(!e.master)fail('master_not_available');artifact=e.master;
      const approved=artifactReview(e,artifact)?.status==='APPROVED';
      const rejected=artifactReview(e,artifact)?.status==='REJECTED';
      caption=`${approved?'🎉 VIDEO APROBADO':e.title}\n\n${approved?e.title:'🎬 Video terminado'}\n\n⏱ ${Number(artifact.duration).toFixed(1).replace('.',',')} s\n🎥 ${artifact.width===1080&&artifact.height===1920?'Full HD':`${artifact.width}×${artifact.height}`}\n✨ ${e.shots.length}/${e.shots.length} tomas\n📚 ${e.beats}/${e.beats} momentos educativos\n\nEstado:\n${approved?'LISTO':rejected?'❌ Cambios solicitados':'👀 Esperando tu revisión'}${screen.kind==='download'?'\n\n⬇️ Abrí este video y usá Guardar/Descargar en Telegram para obtener el MP4 original.':''}`;
      const bind={sha:artifact.sha256};
      rows=[...(!approved?[row('✅ APROBAR VIDEO','approve_final',bind),row('❌ RECHAZAR','changes_menu',bind)]:[]),row('⬇️ Descargar','download',bind),row('ℹ️ Detalles','details',bind),...(approved&&e.publication_preview_available?[row('📤 PUBLICAR','publish',{sha:artifact.sha256})]:[]),back(),menu()];
    }else if(screen.kind==='master_approved'){
      if(artifactReview(e,e.master)?.status!=='APPROVED')fail('master_human_approval_required');
      caption=`🎉 Video aprobado\n\n${e.title}\n\nEstado:\nLISTO`;
      const bind={sha:e.master.sha256};
      rows=[row('▶️ VER VIDEO','master',bind),row('⬇️ Descargar','download',bind),row('📊 Detalles','details',bind),back(),menu()];
    }else if(screen.kind==='details'){
      caption=`ℹ️ ${e.title}\n\n${e.master?.filename||'Master original'}\nVoz: ${e.voice_status||'No disponible'}\nAudio: ${e.audio_status||'No disponible'}\nCosto registrado: ${e.confirmed_cost||'No disponible'}\n\nLa revisión no publica ni inicia nuevas generaciones.`;
      rows=[back(),menu()];
    }else if(screen.kind==='reject_menu'||screen.kind==='changes_menu'){
      caption='🔧 ¿Qué querés corregir?';
      const reasons=screen.kind==='reject_menu'?shotReasons:finalReasons;
      rows=reasons.map(([label,reason])=>row(label,'reject',{...screen,reason,final:screen.kind==='changes_menu'}));
      rows.push(row('◀️ Volver',screen.kind==='reject_menu'?'shot':'master',{index:screen.index||0}));
    }else if(screen.kind==='incident'){
      caption=`⚠️ ${e.title}\n\n${e.incident?.message||e.incident?.reason||'Sin incidentes pendientes.'}\nEtapa: ${e.incident?.stage||e.current_stage||'—'}\nCosto: ${e.confirmed_cost||'No disponible'}\nÚltima acción: ${e.last_completed_action||'—'}\nPendiente: ${e.first_pending_action||e.next_action||'Human Review'}\n\nLos cambios requieren autorización. No se genera multimedia automáticamente.`;
      rows=[...(e.resume_available&&!e.master?[row('▶️ REANUDAR','resume')]:[]),row('🔍 DETALLE','incident_details'),row('💰 COSTO','cost'),...(!e.master&&!e.cancelled?[row('❌ CANCELAR','cancel')]:[]),back(),menu()];
    }else if(['cost','incident_details'].includes(screen.kind)){
      caption=screen.kind==='cost'?`💰 ${e.title}\n${e.confirmed_cost||'Costo no disponible'}`:`🔍 ${e.title}\n${e.incident?.message||e.incident?.reason||'Sin incidente'}\nEtapa: ${e.incident?.stage||e.current_stage||'—'}\nÚltima acción: ${e.last_completed_action||'—'}\nPendiente: ${e.first_pending_action||e.next_action||'Human Review'}`;rows=[back(),menu()];
    }else fail('unknown_screen');
  }
  return {artifact,caption:caption.slice(0,1024),reply_markup:{inline_keyboard:rows.filter(r=>r.length)},tokens};
}
export const PANEL_STATES=Object.freeze({menu:'HOME',progress:'PRODUCTION_PROGRESS',review:'STAGE_REVIEW',audio:'AUDIO_REVIEW',audio_details:'AUDIO_REVIEW',shot:'SHOT_REVIEW',incident:'INCIDENT',master:'MASTER_REVIEW',master_approved:'MASTER_APPROVED',publish:'PUBLISH_REVIEW',publish_select:'PUBLISH_SELECT_PLATFORMS',publish_preview:'PUBLISH_PREVIEW',publish_confirm:'PUBLISH_CONFIRM',publishing:'PUBLISHING',published:'PUBLISHED',publish_error:'PUBLISH_ERROR'});
export function renderTelegramPanel(s,screen=s.screen){
  const actual=screen;
  let view;
  if(screen.kind.startsWith('publish')){const tokens={},e=s.episodes[screen.episode_id];const button=(text,action,extra={})=>{const token=randomBytes(12).toString('hex'),scope=extra.sha?reviewKey(e?.episode_id,null,extra.sha):null;tokens[token]={action,episode_id:e?.episode_id,...extra,...(scope?{review_version:e?.review_versions?.[scope]||0}:{})};return {text,callback_data:'lr:'+token};};view={...publicationPanel(s,screen,button),tokens};}
  else view=buildScreen(s,actual);
  if(screen.kind==='menu'&&s.legacy_home_text)view.caption=s.legacy_home_text;
  const isAudio=['review','audio','audio_details'].includes(actual.kind)&&view.artifact?.mime==='audio/mpeg';
  const media=isAudio||['shot','master','download'].includes(actual.kind);
  const artifact=media?view.artifact:s.cover;
  if(!media&&!['image/png','image/jpeg'].includes(artifact?.mime))fail('TELEGRAM_HOME_PHOTO_REQUIRED');
  const e=s.episodes[screen.episode_id],reviewArtifact=media?artifact:screen.kind==='master_approved'?e?.master:null;
  const r=reviewArtifact&&artifactReview(e,reviewArtifact,screen.kind==='shot'?e.shots[screen.index||0]?.shot_id:null);
  const stateId=isAudio?'AUDIO_REVIEW':PANEL_STATES[screen.kind]||screen.kind.toUpperCase(),type=isAudio?'audio':media?'video':'photo';
  return {...view,artifact,content_type:type,media_type:type,media_file_id:s.deliveries[artifact.sha256]?.telegram_file_id||null,text:null,inline_keyboard:view.reply_markup.inline_keyboard,
    state_id:stateId,panel_state:stateId,review_version:r?.review_version||0,artifact_binding:{artifact_id:artifact.artifact_id,sha256:artifact.sha256},review_identity:{episode_id:screen.episode_id||null,artifact_sha:reviewArtifact?.sha256||null}};
}
export function assertPanelCapability(s,view){
  const current=s.panel_content_type||s.delivery?.command?.body?.media?.type;
  if(view.content_type==='text'&&['video','photo'].includes(current)&&s.home_restore_capability?.media_to_text!==true){
    throw Object.assign(Error('TELEGRAM_MEDIA_TO_TEXT_UNSUPPORTED'),{api_method:'editMessageText',message_id:s.message_id});
  }
}
export class ReviewService {
  constructor({store,telegram,loadBytes,mediaTransportUrl=null,validateOwner=async()=>true,production=null}){this.store=store;this.telegram=telegram;this.loadBytes=loadBytes;this.mediaTransportUrl=mediaTransportUrl;this.validateOwner=validateOwner;this.production=production;}
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
    row.state.episodes[episode.episode_id]={...clone(episode),resume_available:!!this.production?.canResume(episode),reviews:previous?.reviews||episode.reviews||{},review_versions:previous?.review_versions||{}};
    await this.store.cas(user,row.revision,row.state);
  }
  async show(user,chat,screen,{navigation='push'}={}){
    let {state:s,revision}=await this.read(user,chat);
    if(['EMITTING','UNKNOWN'].includes(s.delivery?.status))fail('telegram_delivery_reconciliation_required');
    screen=clone(screen);
    if(s.panel_renderer_version===2){
      s.navigation_stack||=[];
      if(screen.kind==='menu')s.navigation_stack=[];
      else if(navigation==='back')s.navigation_stack.pop();
      else if(navigation==='push'&&(screen.kind!==s.screen?.kind||screen.episode_id!==s.screen?.episode_id)){const prior=clone(s.screen||{kind:'menu'});delete prior.return_to;s.navigation_stack=[...s.navigation_stack,prior].slice(-32);}
      screen.return_to=clone(s.navigation_stack.at(-1)||{kind:'menu'});
    }
    const view=s.panel_renderer_version===2?renderTelegramPanel(s,screen):buildScreen(s,screen);
    if(s.panel_renderer_version===2)assertPanelCapability(s,view);
    const a=view.artifact?validateArtifact(view.artifact):null,cache=a?s.deliveries[a.sha256]:null;
    let bytes;
    if(a&&!cache){bytes=Buffer.from(await this.loadBytes(a));if(bytes.length!==a.size||sha256(bytes)!==a.sha256)fail('artifact_bytes_mismatch');if(a.mime==='video/mp4'&&bytes.length>50_000_000)fail('review_proxy_and_authenticated_download_required');}
    let transportUrl=null;
    if(a&&!cache&&this.telegram.authority==='MAKE'&&this.mediaTransportUrl){
      const transport=await this.mediaTransportUrl(a);
      if(transport){if(transport.sha256!==a.sha256||!transport.url?.startsWith('https://'))fail('media_transport_binding_mismatch');transportUrl=transport.url;}
    }
    s.screen=clone(screen);s.tokens={...s.tokens,...view.tokens};
    // Keep a bounded history so duplicate callbacks and recently displayed buttons survive edits.
    s.tokens=Object.fromEntries(Object.entries(s.tokens).slice(-500));
    s.delivery={status:'EMITTING',artifact_sha:a?.sha256||null,content_type:view.content_type||'media',screen:clone(screen),started_at:stamp(),tokens:Object.keys(view.tokens)};
    revision=await this.store.cas(user,revision,s);
    const media=a?{type:a.mime==='audio/mpeg'?'audio':a.mime==='video/mp4'?'video':'photo',media:cache?.telegram_file_id||transportUrl||'attach://media',caption:view.caption,
      ...(a.mime==='video/mp4'?{supports_streaming:true,width:a.width,height:a.height,duration:Math.ceil(a.duration)}:{})}:null;
    if(this.telegram.authority==='MAKE'){
      const {transportCommand}=await import('./make-transport.js');
      const command=transportCommand({state:s,revision,artifact:a,media,text:view.text,reply_markup:view.reply_markup,screen});
      s.delivery.command=command;
      await this.store.cas(user,revision,s);
      return {status:'TRANSPORT_PENDING',commands:[command],provider_calls:0};
    }
    let message;
    try{message=await this.telegram.call(a?'editMessageMedia':'editMessageText',{chat_id:s.chat_id,message_id:s.message_id,...(a?{media}:{text:view.text,link_preview_options:{is_disabled:true}}),reply_markup:view.reply_markup},bytes?{bytes,mime:a.mime,filename:a.filename}:null);}
    catch(error){
      s.delivery.status=error.definite?'FAILED':'UNKNOWN';s.delivery.error=error.code||'telegram_transport_failed';
      s.delivery.retry_delivery_only=true;s.recovery_state='TELEGRAM_DELIVERY_FAILED';
      await this.store.cas(user,revision,s);throw new Error(s.delivery.error);
    }
    if(Number(message.message_id)!==s.message_id||String(message.chat?.id)!==s.chat_id)fail('telegram_message_identity_mismatch');
    if(!a){if(message.video||message.photo||message.text!==view.text)fail('telegram_text_representation_mismatch');s.panel_content_type='text';s.panel_state=view.panel_state;s.delivery.status='DELIVERED';s.pending_callback=null;await this.store.cas(user,revision,s);return {message_id:s.message_id,content_type:'text'};}
    const remote=message.audio||message.video||message.photo?.at(-1);
    if(!remote?.file_id||!remote.file_unique_id)fail('telegram_file_identity_missing');
    if(media.type==='audio'&&!message.audio?.file_id||media.type==='video'&&!message.video?.file_id||media.type==='photo'&&!message.photo?.length)fail('telegram_media_type_mismatch');
    s.deliveries[a.sha256]={user:s.user_id,chat:s.chat_id,episode_id:screen.episode_id||null,artifact_id:a.artifact_id,artifact_sha:a.sha256,media_kind:media.type,
      telegram_file_id:remote.file_id,telegram_file_unique_id:remote.file_unique_id,telegram_message_id:s.message_id,upload_timestamp:cache?.upload_timestamp||stamp(),last_viewed_at:stamp(),review_status:artifactReview(s.episodes[screen.episode_id]||{},a,screen.kind==='shot'?s.episodes[screen.episode_id]?.shots[screen.index||0]?.shot_id:null)?.status||'PENDING'};
    if(media.type==='photo'&&a.sha256===s.cover.sha256){s.TELEGRAM_HOME_FILE_ID=remote.file_id;s.HOME_ASSET_SHA=a.sha256;}
    if(media.type==='audio'){s.TELEGRAM_AUDIO_FILE_ID=remote.file_id;s.AUDIO_SHA=a.sha256;}
    s.panel_content_type=media.type;s.panel_state=view.panel_state;s.media_capable=true;s.delivery.status='DELIVERED';s.pending_callback=null;s.recovery_state=s.episodes[screen.episode_id]?reviewGate(s.episodes[screen.episode_id]):null;
    await this.store.cas(user,revision,s);return {message_id:s.message_id,artifact_sha:a.sha256,file_id:remote.file_id,file_unique_id:remote.file_unique_id};
  }
  async callback(cb){
    const user=String(cb.from?.id),chat=String(cb.message?.chat?.id);
    let {state:s,revision}=await this.read(user,chat,cb.message?.message_id);
    if(s.delivery?.status==='EMITTING'||s.delivery?.status==='UNKNOWN')fail('telegram_delivery_reconciliation_required');
    const t=s.tokens[String(cb.data).replace(/^lr:/,'')];
    const e=t?s.episodes[t.episode_id]:null,shot=e?.shots?.find(x=>x.shot_id===t.shot_id),a=t?.shot_id?shot?.artifact:e?.master;
    const scope=t?.sha?reviewKey(t.episode_id,t.shot_id,t.sha):null;
    const currentVersion=scope?(e?.review_versions?.[scope]||0):0;
    const decisionKey=t?sha256(`${user}:${scope||t.episode_id}:${t.action}:${t.review_version||0}`):null;
    const applied=s.applied[decisionKey];
    const sameDecision=applied && currentVersion===(t.review_version||0)+1;
    if(!t || (t.sha && (a?.sha256!==t.sha || (currentVersion!==(t.review_version||0)&&!sameDecision)))){
      await this.telegram.call('answerCallbackQuery',{callback_query_id:cb.id,text:'⚠️ Esta revisión ya no está activa.'});
      const fallback=e?{kind:e.master?'master':'progress',episode_id:e.episode_id}:{kind:'menu'};
      return {...await this.show(user,chat,fallback),stale:true};
    }
    if(['approve_stage','reject_stage'].includes(t.action)){
      const r=e?.review_requests?.[t.request_id],desired=t.action==='approve_stage'?'APPROVED':'REJECTED';
      if(!r||r.transport_only||r.artifact_sha!==t.artifact_sha||r.artifact_id!==t.artifact_id||r.stage_id!==t.stage_id
        ||r.review_version!==t.generic_review_version||!r.allowed_actions.includes(desired==='APPROVED'?'APPROVE':'REJECT'))fail('stale_generic_review');
      if(r.status!=='PENDING'&&r.status!==desired)fail('generic_review_decision_immutable');
      if(!this.production?.reviewed)fail('generic_review_recovery_unavailable');
      if(r.status==='PENDING'){
        r.status=desired;r.human_decision={callback_query_id:cb.id,callback_data:cb.data,user,chat_id:chat,message_id:s.message_id,
          timestamp:stamp(),artifact_sha:r.artifact_sha,review_version:r.review_version,status:desired};
        s.reviews.push({...r.human_decision,episode_id:e.episode_id,stage_id:r.stage_id,artifact_id:r.artifact_id,review_request_id:r.review_request_id});
        await this.store.cas(user,revision,s);
      }
      await this.production.reviewed({user,episodeId:e.episode_id,requestId:r.review_request_id});
      await this.telegram.call('answerCallbackQuery',{callback_query_id:cb.id});
      return this.show(user,chat,{kind:'menu'});
    }
    if(t.action==='publish_commit'){await this.telegram.call('answerCallbackQuery',{callback_query_id:cb.id,text:'La publicación requiere activación y confirmación explícitas.',show_alert:true});return {blocked:true,error:'PUBLICATION_DISABLED',provider_calls:0,publication_calls:0};}
    if(s.panel_renderer_version===2&&(['menu','back','progress','details','incident','reject_menu','changes_menu','cost','incident_details','current','library','legacy'].includes(t.action)||t.action.startsWith('publish'))){
      const latest=Object.values(s.episodes).at(-1);
      const target=t.action==='back'?t.return_screen:t.action==='current'?{kind:'progress',episode_id:latest?.episode_id}:{kind:t.action==='publish_toggle'?'publish_select':t.action,episode_id:t.episode_id};
      try{assertPanelCapability(s,renderTelegramPanel(s,target||{kind:'menu'}));}
      catch(error){if(error.message!=='TELEGRAM_MEDIA_TO_TEXT_UNSUPPORTED')throw error;await this.telegram.call('answerCallbackQuery',{callback_query_id:cb.id,text:'Telegram no permite restaurar texto en este mismo panel de video.',show_alert:true});return {blocked:true,error:error.message,message_id:s.message_id,provider_calls:0};}
    }
    await this.telegram.call('answerCallbackQuery',{callback_query_id:cb.id});
    s.pending_callback={id:cb.id,token:String(cb.data),status:'PENDING',started_at:stamp()};s.recovery_state='TELEGRAM_CALLBACK_PENDING';
    revision=await this.store.cas(user,revision,s);
    let screen={kind:t.action,episode_id:t.episode_id,index:t.index||0,page:t.page||0,...(t.request_id?{request_id:t.request_id}:{}),...(t.sha?{sha:t.sha,shot_id:t.shot_id}:{})};
    if(t.action==='publish_toggle')screen={kind:'publish_select',episode_id:t.episode_id,platforms:t.platforms?.includes(t.platform)?t.platforms.filter(p=>p!==t.platform):[...(t.platforms||[]),t.platform],mode:t.mode};
    else if(t.action.startsWith('publish'))screen={...screen,platforms:t.platforms||[],mode:t.mode};
    if(t.action==='back')screen=clone(t.return_screen||{kind:'menu'});
    if(t.action==='current'){const latest=Object.values(s.episodes).at(-1);if(!latest)fail('no_current_production');screen={kind:'progress',episode_id:latest.episode_id};}
    if(t.action==='resume'){
      if(!this.production)fail('canonical_resume_unavailable');
      await this.production.resume({user,episodeId:t.episode_id});
      return this.show(user,chat,{kind:'progress',episode_id:t.episode_id});
    }
    if(['approve_shot','approve_final','reject','changes_menu','cancel'].includes(t.action)){
      if(!e)fail('episode_not_found');
      const key=decisionKey;
      if(!s.applied[key]){
        if(t.action==='cancel'){e.cancelled=true;e.incident={message:'Producción cancelada. Artefactos conservados.',kind:'CANCELLED'};}
        else{
          if(!a||!t.sha)fail('artifact_binding_required');
          const reject=t.action==='reject'||t.action==='changes_menu';
          if(t.action==='reject'&&!(t.final?finalReasons:shotReasons).some(x=>x[1]===t.reason))fail('invalid_rejection_reason');
          const review={callback_provenance:{source:'AUTHENTIC_TELEGRAM_CALLBACK',callback_query_id:cb.id,callback_data:cb.data,message_id:s.message_id,chat_id:chat},episode_id:e.episode_id,shot_id:t.shot_id||null,artifact_sha:t.sha,status:reject?'REJECTED':'APPROVED',user,timestamp:stamp(),
            qa_disposition:reject?'REPAIR_AUTHORIZATION_REQUIRED':shot&&shot.creative_qa!=='PASS'?'HUMAN_OVERRIDE_AUTOMATED_FINDINGS_PRESERVED':'HUMAN_APPROVED',reason:reject?t.reason:null,assembly_eligible:!reject&&t.action==='approve_shot'};
          e.reviews||={};e.review_versions||={};review.review_version=(t.review_version||0)+1;e.review_versions[scope]=review.review_version;const prior=e.reviews[scope];e.reviews[scope]=review;if(t.action==='reject'&&t.final&&prior?.status==='REJECTED'){const i=s.reviews.findIndex(r=>r.episode_id===e.episode_id&&!r.shot_id&&r.artifact_sha===t.sha&&r.review_version===prior.review_version);if(i>=0)s.reviews[i]=review;else s.reviews.push(review);}else s.reviews.push(review);
          review.human_status=reject?(t.shot_id?'HUMAN_REJECTED':'MASTER_HUMAN_REJECTED'):t.action==='approve_final'?'MASTER_HUMAN_APPROVED':'HUMAN_APPROVED';
          if(t.action==='approve_final'||(!t.shot_id&&reject))e.MASTER_HUMAN_APPROVED=!reject;
          if(s.deliveries[t.sha])s.deliveries[t.sha].review_status=review.status;
          if(reject)e.incident={kind:'REPAIR_AUTHORIZATION_REQUIRED',artifact_sha:t.sha,reason:t.reason,message:'Cambio solicitado: '+t.reason,provider_calls_authorized:0};
        }
        s.applied[key]=stamp();s.recovery_state=reviewGate(e);
        await this.store.cas(user,revision,s);
      }
      if(t.action==='cancel'&&this.production)await this.production.cancel({user,episodeId:e.episode_id});
      screen={return_to:s.screen?.return_to||{kind:'menu'},kind:t.action==='changes_menu'?'changes_menu':t.action==='reject'||t.action==='cancel'?'incident':t.action==='approve_shot'?'shot':s.panel_renderer_version===2?'master_approved':'master',episode_id:e.episode_id,index:t.index||0,...(t.sha?{sha:t.sha}:{} )};
    }
    return this.show(user,chat,screen,{navigation:t.action==='back'?'back':['approve_final','approve_shot','reject','cancel'].includes(t.action)?'replace':'push'});
  }
  // Reconcile a delivery whose HTTP response was lost using the next authentic callback's message.
  async reconcile(cb){
    const user=String(cb.from?.id),chat=String(cb.message?.chat?.id);const {state:s,revision}=await this.read(user,chat,cb.message?.message_id);
    if(!['EMITTING','UNKNOWN'].includes(s.delivery?.status))return false;
    const token=s.tokens[String(cb.data).replace(/^lr:/,'')];if(!token||!s.delivery.tokens?.includes(String(cb.data).replace(/^lr:/,'')))fail('reconciliation_token_missing');
    const view=s.panel_renderer_version===2?renderTelegramPanel(s,s.delivery.screen):buildScreen(s,s.delivery.screen),a=view.artifact;
    if(!a){if(cb.message.video||cb.message.photo||cb.message.text!==view.text)fail('reconciliation_text_mismatch');s.panel_content_type='text';s.delivery.status='DELIVERED';s.pending_callback=null;await this.store.cas(user,revision,s);return true;}
    // Only accept a callback generated for this pending screen and exact media caption.
    if(cb.message.caption!==view.caption)fail('reconciliation_caption_mismatch');
    const remote=cb.message.audio||cb.message.video||cb.message.photo?.at(-1);if(!remote?.file_id||!remote.file_unique_id)fail('reconciliation_media_missing');
    if(a.mime==='audio/mpeg'&&(!cb.message.audio||remote.file_size!==a.size))fail('reconciliation_audio_mismatch');
    s.deliveries[a.sha256]={user:s.user_id,chat:s.chat_id,episode_id:s.delivery.screen.episode_id||null,artifact_id:a.artifact_id,artifact_sha:a.sha256,media_kind:cb.message.audio?'audio':cb.message.video?'video':'photo',telegram_file_id:remote.file_id,telegram_file_unique_id:remote.file_unique_id,telegram_message_id:s.message_id,upload_timestamp:stamp(),review_status:'PENDING'};
    if(cb.message.audio){s.TELEGRAM_AUDIO_FILE_ID=remote.file_id;s.AUDIO_SHA=a.sha256;s.panel_content_type='audio';}
    s.delivery.status='DELIVERED';s.media_capable=true;await this.store.cas(user,revision,s);return true;
  }
}
