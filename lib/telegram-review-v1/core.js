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
const callbackClaimConflict = Symbol('callback claim CAS conflict');
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
  if(episode.balance_pause?.status==='PAUSED_INSUFFICIENT_BALANCE')return 'PAUSED_INSUFFICIENT_BALANCE';
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
  async cas(id,revision,state){const {data,error}=await this.db.from('lumi_telegram_review_sessions').update({state,message_id:state.message_id,revision:revision+1,updated_at:stamp()}).eq('user_id',String(id)).eq('revision',revision).select('revision').maybeSingle();if(error)fail('review_state_write_failed');if(!data)fail('concurrent_update');return data.revision;}
}
function own(s, user, chat, message=s.message_id) {
  if(s.user_id!==String(user)||s.chat_id!==String(chat)||s.message_id!==Number(message))fail('review_ownership_mismatch');
}
const shotReasons=[['👤 Lumi / anatomía','anatomy'],['🎨 Estilo / calidad','style'],['🎬 Movimiento','motion'],['🌸 Objeto educativo','object'],['✏️ Otro','other']];
const finalReasons=[['🎬 Una toma','shot'],['🔊 Voz/audio','audio'],['💬 Subtítulos','captions'],['🎵 Música/SFX','music'],['⏱ Ritmo','pacing'],['✏️ Otro','other']];
// EP004 remains a proposal, never an episode or an authorization record.
// The blocked preview has no path to ProductionReviewController.create/resume.
const ep004Proposal='ep_lumi_granja_004_20261008_ee7ab4b3';
export function buildScreen(s, screen=s.screen) {
  const e=s.episodes[screen.episode_id];
  const tokens={};
  const button=(text,action,extra={})=>{const token=randomBytes(12).toString('hex');const scope=extra.sha?reviewKey(e?.episode_id,extra.shot_id,extra.sha):null;tokens[token]={action,episode_id:e?.episode_id,...extra,...(action==='resume'&&e?.pipeline==='LUMI_PRODUCTION_PROFILE_V2'?{next_action:e.next_action}:{}),...(scope?{review_version:e?.review_versions?.[scope]||0}:{})};return {text,callback_data:`lr:${token}`};};
  const row=(text,action,extra)=>[button(text,action,extra)];
  const menu=()=>row('🏠 Volver al inicio','menu');
  const progress=()=>row('📊 Ver progreso','progress');
  const back=()=>row('⬅️ Volver','back',{return_screen:s.navigation_stack?.at(-1)||screen.return_to||{kind:'menu'}});
  let artifact=s.cover,caption='',rows=[];
  if(screen.kind==='legacy'){
    const legacy=s.legacy_screen;if(!legacy)fail('legacy_screen_missing');
    const chunks=legacy.text.match(/[\s\S]{1,850}/g)||[''];const page=Math.max(0,Math.min(Number(screen.page)||0,chunks.length-1));
    caption=chunks[page]+(chunks.length>1?`\n\n${page+1}/${chunks.length}`:'');
    rows=[...legacy.rows,[...(page>0?[button('◀️','legacy',{page:page-1})]:[]),...(page<chunks.length-1?[button('▶️','legacy',{page:page+1})]:[])],menu()];
  }else if(screen.kind==='menu'){
    caption='✨ Lumi\n\n¿Qué querés hacer?';
    rows=[row('🎬 Crear video','create_v2_ideas'),row('📁 Mis videos','library',{page:0}),
      row('📊 Producción','current'),row('⚙️ Ajustes','settings')];
    if(s.panel_renderer_version!==2)rows=[...s.legacy_menu,...rows];
  }else if(screen.kind==='settings'){
    caption='⚙️ Ajustes\n\nModo supervisado · Cada generación requiere autorización.\nVoz prevista para nuevos videos: Fernanda.\nPresupuesto del próximo episodio: USD 5,00.\nLas herramientas históricas de programación y publicación no están habilitadas en este entorno.';
    rows=[];
    if(s.voice_preview_review?.candidates?.length===2){const v=s.voice_preview_review;rows.push(row('🔊 Escuchar voces','audio',{episode_id:v.episode_id,request_id:v.candidates[0].review_request_id}));}
    rows.push(back(),menu());
  }else if(screen.kind==='current'){
    caption='📊 Producción\n\n'+(Object.keys(s.episodes).length?'Elegí una producción para ver su progreso.':'Todavía no hay una producción iniciada.');
    const episodes=Object.values(s.episodes).reverse(),page=Math.max(0,Math.min(Number(screen.page)||0,Math.max(0,Math.ceil(episodes.length/5)-1)));
    rows=episodes.slice(page*5,page*5+5).map(e=>row(e.title,'progress',{episode_id:e.episode_id}));
    rows.push([...(page>0?[button('◀️','current',{page:page-1})]:[]),...(episodes.length>(page+1)*5?[button('▶️','current',{page:page+1})]:[])]);
    rows.push(row('🎬 Crear video','create_v2_ideas'),menu());
  }else if(screen.kind==='create_v2_ideas'){
    caption='🎬 Crear video\n\nElegí una idea para consultar su presupuesto.';
    rows=[row('Lumi y los animales de la granja','create_v2_budget',{proposal_id:ep004Proposal}),back(),menu()];
  }else if(screen.kind==='create_v2_budget'){
    caption='🎬 Lumi y los animales de la granja\n\nReconocer vaca, oveja y gallina y sus sonidos.\n\nPresupuesto máximo: USD 5,00\nRevisión supervisada\n\nInicio bloqueado: falta cotizar Kling con imágenes fuente reales y verificar la cobertura de voz. La estimación de imágenes no cubre el costo total.\n\nPodés confirmar un presupuesto supervisado para la primera imagen q41. Eso no autoriza todavía el episodio completo.';
    rows=[row('Preparar primera imagen','q41_prepare',{proposal_id:ep004Proposal}),row('🔒 Inicio bloqueado','create_v2_start',{proposal_id:ep004Proposal}),back(),menu()];
  }else if(['q41_confirm','q41_review'].includes(screen.kind)){
    const f=s.q41_first_image||{status:'BLOCKED',blocker:'Q41_PREPARATION_UNVERIFIED'};
    const bind={proposal_id:ep004Proposal,binding_sha:f.binding,expires_at:f.expires_at,attempt_id:f.attempt_id};
    caption='Lumi y los animales de la granja\nPrimera imagen q41\n\n'+
      (Number.isFinite(f.estimate_usd)?`Estimación vigente al confirmar: USD ${f.estimate_usd.toFixed(3)}. No es un precio máximo.\n`:
        'Referencia histórica: USD 0,271; vencida. Se cotizará al confirmar. Una estimación no es un precio máximo.\n')+
      'Presupuesto del episodio: USD 5,00.\n';
    rows=[];
    if(f.artifact){
      artifact=f.artifact;
      caption=`Primera imagen q41\n\n${artifact.width} × ${artifact.height}\nQA técnico: ${f.technical_qa?.ok?'PASS':'REQUIERE REVISIÓN'}\nQA visual: ${f.visual_qa}\n\nRevisá identidad, dos alas, varita visible, estilo 3D premium y vaca, oveja y gallina.\nEstado: ${f.review?.status||'PENDIENTE'}\n\nAprobar o rechazar deja la producción pausada.`;
      if(!f.review)rows=[...(f.technical_qa?.ok?[row('Aprobar imagen','q41_approve',{...bind,artifact_sha:artifact.sha256,review_version:1})]:[]),
        row('Solicitar corrección','q41_reject',{...bind,artifact_sha:artifact.sha256,review_version:1})];
      if(f.review?.status==='APPROVED'){
        caption+='\n\nContinuar abre el episodio autorizado si ya incorporó esta imagen.'+(f.blocker==='Q41_EPISODE_CONTINUATION_NOT_AUTHORIZED'?' Falta habilitar esa continuación.':'');
        rows.push(row('Continuar producción','q41_continue',{...bind,artifact_sha:artifact.sha256,review_version:1}));
      }
    }else if(f.status==='AWAITING_CONFIRMATION'){
      caption+=f.policy?`\nControl supervisado. Reserva máxima por solicitud: USD ${f.reserve_usd.toFixed(2)}. Saldo y Billing sin verificar. El cargo del proveedor puede superar la estimación y el límite interno.\nConfirmá una sola imagen con cotización vigente, reserva y conciliación de gasto.`:`\nReserva prevista sobre saldo verificado: USD ${f.reserve_usd.toFixed(2)}.\nUna sola imagen. Sin reintentos.\n\nConfirmá para cotizar y generar si los controles vigentes permiten reservar ese importe. Después podrás revisar la imagen.`;
      rows=[row('Confirmar generación','q41_confirm',bind)];
    }else if(f.status==='PAUSED_INSUFFICIENT_BALANCE'){
      caption+='\nHiggsfield rechazó la solicitud por saldo insuficiente. No se reintentó.\n\nSALDO RECARGADO autoriza una nueva solicitud pendiente tras revalidar saldo, cotización, reservas y presupuesto. Si no hay consulta oficial de saldo, se usará únicamente la política supervisada ya aprobada. El cargo final puede superar la estimación. La recarga no aumenta USD 5.';
      rows=[row('Saldo recargado','q41_refill',bind)];
    }else{
      if(f.status==='PAUSED_BUDGET_EXHAUSTED')caption+='\nPresupuesto agotado. Hace falta una autorización separada para aumentarlo. Recargar saldo no aumenta el techo de USD 5.';
      caption+=`\nEstado: ${f.status}\nBloqueo: ${f.blocker||'Esperando el resultado original.'}`;
      if(f.can_approve_supervised_policy){
        caption+='\n\nPodés aprobar control supervisado: techo interno del episodio USD 5; reserva de cotización +25%, hasta USD 0,50 para q41. Billing y saldo siguen sin verificar. El cargo final de Higgsfield puede superar la reserva y el techo interno. No se garantiza terminar todo el episodio por USD 5. Cada continuación será explícita.';
        rows.push(row('Confirmar presupuesto supervisado USD 5','q41_budget',bind));
      }
      rows.push(row(f.status==='BLOCKED'?'Actualizar controles':'Consultar resultado original',f.status==='BLOCKED'?'q41_prepare':'q41_status',bind));
    }
    rows.push(back(),menu());
  }else if(screen.kind==='library'){
    const episodes=Object.values(s.episodes).filter(x=>x.master), page=Math.max(0,Math.min(Number(screen.page)||0,Math.max(0,Math.ceil(episodes.length/5)-1)));
    caption='📁 Mis videos';rows=episodes.slice(page*5,page*5+5).map(x=>[button(x.title,'master',{episode_id:x.episode_id})]);
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
        if(request.preview_voice){
          const v=request.preview_voice,other=s.voice_preview_review?.candidates?.find(c=>c.letter!==v.letter);
          if(!other)fail('preview_comparison_missing');
          caption=`🔊 Voz ${v.letter} — ${v.name.split(' — ')[0]}\n\nEspañol verificado\nAcento mexicano\nProfessional\n\nEscuchá la voz y comparala con ${other.letter}.\nEvaluá timbre, calidez y personalidad de Lumi.`;
          if(v.letter==='B')caption='🔊 Voz B — Fernanda\n\nEspañol verificado\nAcento mexicano\nProfessional\n\nEscuchala antes de elegir la voz definitiva de Lumi.';
          if(s.voice_preview_review.human_selection)caption+=`\n\nElegiste la voz ${s.voice_preview_review.human_selection.letter}.`;
          rows=[row('▶️ ESCUCHAR','audio',{request_id:request.review_request_id}),row(v.letter==='A'?'➡️ VOZ B':'⬅️ VOZ A','audio',{request_id:other.review_request_id}),row('✅ ELEGIR '+v.letter,'choose_preview',{...bind,letter:v.letter,voice_id:v.voice_id}),row(v.letter==='A'?'⬅️ VOLVER':'🏠 VOLVER','menu')];
        }else rows=[row('▶️ ESCUCHAR','audio',{request_id:request.review_request_id}),row('ℹ️ DETALLES','audio_details',{request_id:request.review_request_id}),row('⬅️ VOLVER','menu')];
      }else rows=[...(audio?[row('▶️ ESCUCHAR','audio',{request_id:request.review_request_id})]:[]),...(request.status==='PENDING'?[row('✅ Aprobar','approve_stage',bind),row('🔧 Solicitar corrección','reject_stage',bind)]:[]),...(audio?[row('ℹ️ DETALLES','audio_details',{request_id:request.review_request_id})]:[]),progress(),back(),menu()];
    }else if(screen.kind==='progress'){
      const available=e.shots.filter(x=>x.artifact).length,completed=e.master?(e.visual_completed??available):available, pct=e.master?100:Math.min(95,Math.round(20+60*completed/Math.max(e.shots.length,1)+(e.audio_status==='COMPLETE'?15:0)));
      caption=`✨ ${e.title}\n\nProducción ${'█'.repeat(Math.floor(pct/10))}${'░'.repeat(10-Math.floor(pct/10))} ${pct}%\n\nEtapa: ${e.current_stage||gate}\n✅ Videos ${completed}/${e.shots.length}\nVoz: ${e.voice_status||'PENDIENTE'}\nAudio: ${e.audio_status||'PENDIENTE'}\nMaster: ${e.master?'Listo para revisión':'PENDIENTE'}\nCosto confirmado: ${e.confirmed_cost||'No disponible'}${e.incident?'\n⚠️ Requiere atención':''}`;
      rows=[...(available?[row('🎬 Revisar tomas','shot',{index:0})]:[]),...(e.master?[row('▶️ Ver master','master')]:[]),...(e.resume_available&&gate==='READY_TO_CONTINUE'?[row('▶️ Continuar producción','resume')]:[]),...(e.incident?[row('⚠️ Ver incidente','incident')]:[]),...(!e.master&&!e.cancelled?[row('🛑 Cancelar','cancel')]:[]),menu()];
      if(e.q41_import){
        const q=e.q41_import,r=Object.values(e.review_requests||{}).find(r=>r.artifact_sha===q.artifact_sha&&r.status==='APPROVED');
        const next={PLANNING:'Validar el plan del episodio',SOURCE_PLANNING:'Preparar las fuentes de las tomas',SOURCE_QA:'Verificar la fuente aprobada para animación',DIRECTOR:'Preparar la dirección de la toma'}[e.current_stage]||e.current_stage;
        caption=`✨ ${e.title}\n\nEpisodio 004 creado.\n✅ Primera imagen aprobada e incorporada.\n\nProducción: preparación supervisada.\nPresupuesto máximo: USD 5.00.\nq41 estimado: USD ${q.estimated_usd.toFixed(3)}.\nReserva existente: USD ${q.reserved_usd.toFixed(5)}.\nCosto real: ${q.actual_usd===null?'no verificado':'USD '+q.actual_usd}.\nRestante estimado: USD ${(5-q.estimated_usd).toFixed(3)}.\n\nPróxima acción: ${next}.\nLas nuevas generaciones requieren cotización vigente y autorización específica.`;
        if(r)rows.unshift(row('👀 Ver primera imagen','review',{request_id:r.review_request_id}));
        if(e.source_review_required)caption+='\n\nAntes de animar falta la revisión detallada de fuente y anatomía. La aprobación de la imagen se conserva; no se ejecutará Kling.';
      }
      if(e.budget_exhausted)caption+='\nPresupuesto agotado. Se requiere autorización separada para aumentarlo. Recargar saldo no cambia el techo aprobado.';
      if(!e.master&&!e.cancelled&&gate==='PAUSED_INSUFFICIENT_BALANCE'){
        caption+='\n\nSaldo insuficiente. SALDO RECARGADO autoriza revalidar y continuar solo la acción pendiente. Sin consulta oficial de saldo se requiere la política supervisada aprobada. El cargo final no está garantizado; recargar no aumenta el presupuesto.';
        rows.unshift(row('Saldo recargado','balance_reloaded',{attempt_id:e.balance_pause.attempt_id,next_action:e.next_action}));
      }
      for(const r of Object.values(e.review_requests||{}).filter(r=>r.status==='PENDING'))rows.unshift(row('👀 Revisar '+r.stage_id,'review',{request_id:r.review_request_id}));
    }else if(screen.kind==='shot'){
      if(!shot?.artifact)fail('shot_not_available');artifact=shot.artifact;
      const review=artifactReview(e,artifact,shot.shot_id);
      caption=`🎬 Revisión de toma · ${(screen.index||0)+1}/${e.shots.length}\n\n${shot.shot_id} · ${Number(artifact.duration).toFixed(1)} s\n${shot.description||''}\n\nQA técnico: ${shot.technical_qa}\nQA creativo: ${shot.creative_qa}${shot.warning?'\n⚠️ '+shot.warning:''}\nCosto: ${shot.cost||'No disponible'}\n\nHuman Review: ${review?.status||'PENDING'}`;
      const bind={shot_id:shot.shot_id,sha:artifact.sha256,index:screen.index||0};
      rows=[row('✅ Aprobar toma','approve_shot',bind),row('🔧 Solicitar corrección','reject_menu',bind),[...(screen.index>0?[button('◀️ Anterior','shot',{index:screen.index-1})]:[]),...(screen.index<e.shots.length-1?[button('Siguiente ▶️','shot',{index:screen.index+1})]:[])],progress(),back(),menu()];
    }else if(['master','download'].includes(screen.kind)){
      if(!e.master)fail('master_not_available');artifact=e.master;
      const approved=artifactReview(e,artifact)?.status==='APPROVED';
      const rejected=artifactReview(e,artifact)?.status==='REJECTED';
      caption=`${approved?'🎉 VIDEO APROBADO':e.title}\n\n${approved?e.title:'🎬 Video terminado'}\n\n⏱ ${Number(artifact.duration).toFixed(1).replace('.',',')} s\n🎥 ${artifact.width===1080&&artifact.height===1920?'Full HD':`${artifact.width}×${artifact.height}`}\n✨ ${e.shots.length}/${e.shots.length} tomas\n📚 ${e.beats}/${e.beats} momentos educativos\n\nEstado:\n${approved?'LISTO':rejected?'❌ Cambios solicitados':'👀 Esperando tu revisión'}${screen.kind==='download'?'\n\n⬇️ Abrí este video y usá Guardar/Descargar en Telegram para obtener el MP4 original.':''}`;
      const bind={sha:artifact.sha256};
      rows=[...(!approved?[row('✅ Aprobar master','approve_final',bind),row('🔧 Solicitar corrección','changes_menu',bind)]:[]),row('⬇️ Descargar MP4','download',bind),row('ℹ️ Detalles','details',bind),...(approved&&e.publication_preview_available?[row('📤 PUBLICAR','publish',{sha:artifact.sha256})]:[]),back(),menu()];
    }else if(screen.kind==='master_approved'){
      if(artifactReview(e,e.master)?.status!=='APPROVED')fail('master_human_approval_required');
      caption=`🎉 Video aprobado\n\n${e.title}\n\nEstado:\nLISTO`;
      const bind={sha:e.master.sha256};
      rows=[row('▶️ VER VIDEO','master',bind),row('⬇️ Descargar MP4','download',bind),row('📊 Detalles','details',bind),back(),menu()];
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
  // HOME is rendered by the canonical router; historical captions remain stored.
  const isAudio=['review','audio','audio_details'].includes(actual.kind)&&view.artifact?.mime==='audio/mpeg';
  const isFirstImage=['q41_confirm','q41_review'].includes(actual.kind)&&!!s.q41_first_image?.artifact;
  const media=isAudio||isFirstImage||['shot','master','download'].includes(actual.kind);
  const artifact=media?view.artifact:s.cover;
  if(!media&&!['image/png','image/jpeg'].includes(artifact?.mime))fail('TELEGRAM_HOME_PHOTO_REQUIRED');
  const e=s.episodes[screen.episode_id],reviewArtifact=media?artifact:screen.kind==='master_approved'?e?.master:null;
  const r=e&&reviewArtifact&&artifactReview(e,reviewArtifact,screen.kind==='shot'?e.shots[screen.index||0]?.shot_id:null);
  const stateId=isAudio?'AUDIO_REVIEW':PANEL_STATES[screen.kind]||screen.kind.toUpperCase(),type=isAudio?'audio':isFirstImage?'photo':media?'video':'photo';
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
  // Operator HMAC authorization records externally verified definitive rejection.
  // A transport timeout/unknown outcome never qualifies; no generic retry switch.
  async authorizeRejectedDelivery(user,chat,{command_id,expected_revision,evidence}){
    const row=await this.read(user,chat),s=row.state,c=s.delivery?.command;
    if(row.revision!==expected_revision+1||s.delivery?.status!=='EMITTING'||c?.idempotency_key!==command_id
      ||s.screen?.kind!=='q41_review'||c.artifact?.mime!=='image/png'||c.artifact.size<=5_000_000||c.artifact.size>10_000_000
      ||c.message_id!==s.message_id||s.deliveries[c.artifact_sha]||s.delivery_recovery?.command_id===command_id
      ||evidence?.http_status!==400||!['Bad Request: failed to get HTTP URL content','Bad Request: file of size 10630462 bytes is too big for a photo; the maximum size is 10485760 bytes'].includes(evidence.description)
      ||!/^([a-f0-9]{32})$/.test(evidence.execution_id||''))fail('definitive_delivery_rejection_required');
    s.delivery_recovery={command_id,evidence:clone(evidence),status:'AUTHORIZED',expires_at:Date.now()+600000};
    await this.store.cas(user,row.revision,s);return {status:'DELIVERY_RECOVERY_AUTHORIZED',provider_calls:0};
  }
  async recoverRejectedDelivery(user,chat){
    for(let attempt=0;attempt<6;attempt++){
      const row=await this.read(user,chat),s=row.state,r=s.delivery_recovery,c=s.delivery?.command;
      if(r?.status==='EMITTING'||r?.status==='DELIVERED')return {status:'DELIVERY_RECOVERY_ALREADY_CLAIMED',commands:[],provider_calls:0};
      if(r?.status!=='AUTHORIZED'||r.expires_at<Date.now()||s.delivery?.status!=='EMITTING'||r.command_id!==c?.idempotency_key||c.message_id!==s.message_id)fail('definitive_delivery_rejection_required');
      const bytes=Buffer.from(await this.loadBytes(c.artifact));
      if(bytes.length!==c.artifact.size||sha256(bytes)!==c.artifact_sha)fail('artifact_bytes_mismatch');
      const next=clone(c);next.review_version=row.revision+1;next.idempotency_key=sha256(c.idempotency_key+':multipart:'+next.review_version);
      next.upload_required=true;next.body.media.media='attach://media';
      for(const b of next.body.reply_markup.inline_keyboard.flat()){if(b.text==='Aprobar imagen y revisión visual')b.text='Aprobar imagen';if(b.text==='Rechazar imagen')b.text='Solicitar corrección';}
      s.delivery_history||={};s.delivery_history[c.idempotency_key]={...clone(s.delivery),status:'DEFINITIVELY_REJECTED',evidence:clone(r.evidence)};
      s.delivery={...s.delivery,command:next,started_at:stamp()};r.status='EMITTING';r.replacement_command_id=next.idempotency_key;
      try{await this.store.cas(user,row.revision,s);return {status:'TRANSPORT_PENDING',commands:[next],provider_calls:0};}
      catch(error){if(error.message!=='concurrent_update')throw error;}
    }
    fail('concurrent_update');
  }
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
  // One explicit recovery per incident/session. A retained claim never re-emits,
  // even after a timeout, a lost HTTP response, or an operator retry.
  async recoverPanel(user,chat){
    if(this.telegram.authority!=='MAKE')fail('panel_recovery_requires_make');
    for(let attempt=0;attempt<6;attempt++){
      const {state:s,revision}=await this.read(user,chat);
      if(s.panel_recovery)return {status:s.panel_recovery.status==='DELIVERED'?'PANEL_ALREADY_RECOVERED':'PANEL_RECOVERY_PENDING',commands:[],provider_calls:0};
      if(s.pending_callback||s.delivery&&s.delivery.status!=='DELIVERED')fail('telegram_delivery_reconciliation_required');
      const a=validateArtifact(s.cover),cache=s.deliveries[a.sha256];
      if(!a.mime.startsWith('image/')||!cache?.telegram_file_id||!cache.telegram_file_unique_id)fail('panel_recovery_canonical_photo_required');
      const screen={kind:'menu'},view=renderTelegramPanel(s,screen);
      const {transportCommand}=await import('./make-transport.js');
      const c=transportCommand({state:s,revision:revision+1,artifact:a,
        media:{type:'photo',media:cache.telegram_file_id,caption:view.caption},reply_markup:view.reply_markup,screen});
      c.method='sendPhoto';c.kind='RECOVER_TELEGRAM_PANEL';
      s.panel_recovery={status:'EMITTING',command_id:c.idempotency_key,old_message_id:s.message_id,
        started_at:stamp(),previous:{message_id:s.message_id,delivery:clone(s.delivery),screen:clone(s.screen),
          canonical_panel:clone(s.LUMI_CANONICAL_PANEL_V1||null),tokens:clone(s.tokens)}};
      s.screen=screen;s.tokens=view.tokens;s.navigation_stack=[];
      s.delivery={status:'EMITTING',command:c,artifact_sha:a.sha256,content_type:'photo',screen,
        tokens:Object.keys(view.tokens),started_at:stamp()};
      try{await this.store.cas(user,revision,s);return {status:'PANEL_RECOVERY_PENDING',commands:[c],provider_calls:0};}
      catch(error){if(error.message!=='concurrent_update')throw error;}
    }
    fail('concurrent_update');
  }
  async show(user,chat,screen,options={}){
    // Only retry local outbox preparation. The MAKE branch commits the complete
    // command in one CAS, before the caller can perform a Telegram operation.
    for(let attempt=0;attempt<6;attempt++){
      try{return await this.prepareScreen(user,chat,screen,options);}
      catch(error){if(this.telegram.authority!=='MAKE'||error.message!=='concurrent_update')throw error;}
    }
    fail('concurrent_update');
  }
  async prepareScreen(user,chat,screen,{navigation='push',callbackId=null}={}){
    let {state:s,revision}=await this.read(user,chat);
    if(['EMITTING','UNKNOWN'].includes(s.delivery?.status)||s.pending_callback&&s.pending_callback.id!==callbackId)fail('telegram_delivery_reconciliation_required');
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
    const media=a?{type:a.mime==='audio/mpeg'?'audio':a.mime==='video/mp4'?'video':'photo',media:cache?.telegram_file_id||transportUrl||'attach://media',caption:view.caption,
      ...(a.mime==='video/mp4'?{supports_streaming:true,width:a.width,height:a.height,duration:Math.ceil(a.duration)}:{})}:null;
    if(this.telegram.authority==='MAKE'){
      const {transportCommand}=await import('./make-transport.js');
      const command=transportCommand({state:s,revision:revision+1,artifact:a,media,text:view.text,reply_markup:view.reply_markup,screen});
      s.delivery.command=command;
      await this.store.cas(user,revision,s);
      return {status:'TRANSPORT_PENDING',commands:[command],provider_calls:0};
    }
    revision=await this.store.cas(user,revision,s);
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
  async callback(cb,options={}){
    // Only the pre-dispatch callback claim may be retried. Each attempt checks
    // the current owner, panel, token, decision and pending delivery again.
    for(let attempt=0;attempt<6;attempt++){
      try{return await this.callbackOnce(cb,options);}
      catch(error){if(this.telegram.authority!=='MAKE'||!error[callbackClaimConflict])throw error;}
    }
    fail('concurrent_update');
  }
  async callbackOnce(cb,{firstImageCommand=null,beforeProductionEffect=()=>{}}={}){
    const user=String(cb.from?.id),chat=String(cb.message?.chat?.id);
    let {state:s,revision}=await this.read(user,chat,cb.message?.message_id);
    if(s.applied?.['callback:'+cb.id]){
      await this.telegram.call('answerCallbackQuery',{callback_query_id:cb.id});
      return {status:'DUPLICATE_REQUEST',already_applied:true,commands:[],provider_calls:0};
    }
    if(s.delivery?.status==='EMITTING'||s.delivery?.status==='UNKNOWN')fail('telegram_delivery_reconciliation_required');
    if(s.pending_callback)fail('telegram_delivery_reconciliation_required');
    const t=s.tokens[String(cb.data).replace(/^lr:/,'')];
    const e=t?s.episodes[t.episode_id]:null,shot=e?.shots?.find(x=>x.shot_id===t.shot_id),a=t?.shot_id?shot?.artifact:e?.master;
    const scope=t?.sha?reviewKey(t.episode_id,t.shot_id,t.sha):null;
    const currentVersion=scope?(e?.review_versions?.[scope]||0):0;
    const decisionKey=t?sha256(`${user}:${scope||t.episode_id}:${t.action}:${t.review_version||0}`):null;
    const applied=s.applied[decisionKey];
    const sameDecision=applied && currentVersion===(t.review_version||0)+1;
    if(!t)fail('invalid_callback');
    if((t.sha && (a?.sha256!==t.sha || (currentVersion!==(t.review_version||0)&&!sameDecision)))){
      await this.telegram.call('answerCallbackQuery',{callback_query_id:cb.id,text:'⚠️ Esta revisión ya no está activa.'});
      const fallback=e?{kind:e.master?'master':'progress',episode_id:e.episode_id}:{kind:'menu'};
      return {...await this.show(user,chat,fallback),stale:true,status:'STALE_CALLBACK'};
    }
    if(t.action?.startsWith('q41_')){
      if(t.proposal_id!==ep004Proposal||s.message_id!==Number(cb.message?.message_id))fail('Q41_CALLBACK_SCOPE_INVALID');
      await this.telegram.call('answerCallbackQuery',{callback_query_id:cb.id});
      let result;
      try{
        result=t.action==='q41_prepare'?await this.production.firstImageStatus({user}):
          await this.production.firstImageAction({command:firstImageCommand});
      }catch(error){
        const blocker=/^Q41_[A-Z_]+$/.test(error.message)?error.message:'Q41_OPERATION_BLOCKED';
        await this.telegram.call('answerCallbackQuery',{callback_query_id:cb.id,text:blocker,show_alert:true});
        return {blocked:true,error:blocker,episode_created:false};
      }
      return {...await this.show(user,chat,result.next_screen??{kind:result.artifact?'q41_review':'q41_confirm'}),
        first_image_status:result.status,blocker:result.blocker||null,episode_created:false};
    }
    if(t.action==='create_v2_start'){
      // No callback flag, prior grant, cached price or duplicate click can turn
      // this proposal into generation authority while the real gate is blocked.
      await this.telegram.call('answerCallbackQuery',{callback_query_id:cb.id,text:'Presupuesto sin verificar. Producción bloqueada.',show_alert:true});
      return {blocked:true,error:'BUDGET_GATE_BLOCKED',episode_created:false,authorization_created:false,provider_calls:0};
    }
    if(t.action==='choose_preview'){
      const r=e?.review_requests?.[t.request_id],v=s.voice_preview_review,c=v?.candidates?.find(c=>c.letter===t.letter);
      if(!r?.transport_only||!r.preview_voice||!c||c.VOICE_ID!==t.voice_id||c.review_request_id!==t.request_id||r.artifact_sha!==t.artifact_sha||e.artifacts?.[r.artifact_id]?.sha256!==t.artifact_sha)fail('stale_preview_selection');
      v.human_selection={letter:t.letter,voice_id:t.voice_id,artifact_sha:t.artifact_sha,user,chat_id:chat,message_id:s.message_id,callback_query_id:cb.id,timestamp:stamp()};
      v.status='HUMAN_SELECTION_RECORDED';v.profile_status='VOICE_SELECTION_PENDING';
      await this.store.cas(user,revision,s);
      await this.telegram.call('answerCallbackQuery',{callback_query_id:cb.id,text:'Selección registrada. La configuración final sigue pendiente.'});
      return this.show(user,chat,{kind:'audio',episode_id:e.episode_id,request_id:r.review_request_id});
    }
    if(['approve_stage','reject_stage'].includes(t.action)){
      const r=e?.review_requests?.[t.request_id],desired=t.action==='approve_stage'?'APPROVED':'REJECTED';
      if(!r||r.transport_only||r.artifact_sha!==t.artifact_sha||r.artifact_id!==t.artifact_id||r.stage_id!==t.stage_id
        ||r.review_version!==t.generic_review_version||!r.allowed_actions.includes(desired==='APPROVED'?'APPROVE':'REJECT'))fail('stale_generic_review');
      if(r.status!=='PENDING'&&r.status!==desired)fail('generic_review_decision_immutable');
      if(!this.production?.reviewed)fail('generic_review_recovery_unavailable');
      await persistStageDecision({store:this.store,production:this.production,user,chat,episodeId:e.episode_id,
        requestId:r.review_request_id,decision:desired,artifactSha:t.artifact_sha,reviewVersion:t.generic_review_version,
        evidence:{callback_query_id:cb.id,callback_data:cb.data},validatedRow:{state:s,revision}});
      await this.telegram.call('answerCallbackQuery',{callback_query_id:cb.id});
      return this.show(user,chat,{kind:'menu'});
    }
    if(t.action==='publish_commit'){await this.telegram.call('answerCallbackQuery',{callback_query_id:cb.id,text:'La publicación requiere activación y confirmación explícitas.',show_alert:true});return {blocked:true,error:'PUBLICATION_DISABLED',provider_calls:0,publication_calls:0};}
    if(s.panel_renderer_version===2&&(['menu','back','progress','details','incident','reject_menu','changes_menu','cost','incident_details','current','library','legacy'].includes(t.action)||t.action.startsWith('publish'))){
      const target=t.action==='back'?t.return_screen:t.action==='current'?{kind:'current'}:{kind:t.action==='publish_toggle'?'publish_select':t.action,episode_id:t.episode_id};
      try{assertPanelCapability(s,renderTelegramPanel(s,target||{kind:'menu'}));}
      catch(error){if(error.message!=='TELEGRAM_MEDIA_TO_TEXT_UNSUPPORTED')throw error;await this.telegram.call('answerCallbackQuery',{callback_query_id:cb.id,text:'Telegram no permite restaurar texto en este mismo panel de video.',show_alert:true});return {blocked:true,error:error.message,message_id:s.message_id,provider_calls:0};}
    }
    s.pending_callback={id:cb.id,token:String(cb.data),status:'PENDING',started_at:stamp()};s.recovery_state='TELEGRAM_CALLBACK_PENDING';
    try{revision=await this.store.cas(user,revision,s);}
    catch(error){if(error.message==='concurrent_update')throw Object.assign(Error('telegram_delivery_reconciliation_required'),{[callbackClaimConflict]:true});throw error;}
    await this.telegram.call('answerCallbackQuery',{callback_query_id:cb.id});
    let screen={kind:t.action,episode_id:t.episode_id,index:t.index||0,page:t.page||0,...(t.request_id?{request_id:t.request_id}:{}),...(t.sha?{sha:t.sha,shot_id:t.shot_id}:{})};
    if(t.action==='publish_toggle')screen={kind:'publish_select',episode_id:t.episode_id,platforms:t.platforms?.includes(t.platform)?t.platforms.filter(p=>p!==t.platform):[...(t.platforms||[]),t.platform],mode:t.mode};
    else if(t.action.startsWith('publish'))screen={...screen,platforms:t.platforms||[],mode:t.mode};
    if(t.action==='back')screen=clone(t.return_screen||{kind:'menu'});
    if(t.action==='current')screen={kind:'current',page:t.page||0};
    if(t.action==='balance_reloaded'){
      await this.production.balanceReloaded({command:firstImageCommand});
      return this.show(user,chat,{kind:'progress',episode_id:t.episode_id},{callbackId:cb.id});
    }
    if(t.action==='resume'){
      if(!this.production)fail('canonical_resume_unavailable');
      if(e?.pipeline==='LUMI_PRODUCTION_PROFILE_V2'&&!t.next_action)fail('stale_resume_command');
      beforeProductionEffect();
      await this.production.resume({user,episodeId:t.episode_id,expectedAction:t.next_action});
      return this.show(user,chat,{kind:'progress',episode_id:t.episode_id},{callbackId:cb.id});
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
    return this.show(user,chat,screen,{callbackId:cb.id,navigation:t.action==='back'?'back':['approve_final','approve_shot','reject','cancel'].includes(t.action)?'replace':'push'});
  }
  // Reconcile a delivery whose HTTP response was lost using the next authentic callback's message.
  async reconcile(cb){
    const user=String(cb.from?.id),chat=String(cb.message?.chat?.id);const {state:s,revision}=await this.read(user,chat,cb.message?.message_id);
    if(!['EMITTING','UNKNOWN'].includes(s.delivery?.status))return false;
    const token=s.tokens[String(cb.data).replace(/^lr:/,'')];if(!token)fail('invalid_callback');if(!s.delivery.tokens?.includes(String(cb.data).replace(/^lr:/,'')))fail('reconciliation_token_missing');
    if(s.delivery.command){
      const {acknowledgeCommand}=await import('./make-transport.js');
      await acknowledgeCommand(this.store,user,chat,s.delivery.command.idempotency_key,cb.message);
      return true;
    }
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

// The canonical callback and isolated diagnostics share exactly the same
// validation, immutable decision persistence and Recovery Manager continuation.
export async function persistStageDecision({store,production,user,chat,episodeId,requestId,decision,artifactSha,reviewVersion,evidence,validatedRow}) {
  // Keep the callback's original owner/message/token snapshot and CAS revision.
  const row=validatedRow||await store.get(user),s=row?.state,r=s?.episodes[episodeId]?.review_requests?.[requestId];
  if(!s||s.user_id!==user||s.chat_id!==chat||!r||r.transport_only||r.artifact_sha!==artifactSha
    ||r.review_version!==reviewVersion||!['APPROVED','REJECTED'].includes(decision)
    ||!r.allowed_actions.includes(decision==='APPROVED'?'APPROVE':'REJECT'))fail('stale_generic_review');
  if(r.status!=='PENDING'&&r.status!==decision)fail('generic_review_decision_immutable');
  if(!production?.reviewed)fail('generic_review_recovery_unavailable');
  await production.validateReview?.({user,episodeId,requestId,decision,artifactSha,reviewVersion});
  if(r.status==='PENDING'){
    r.status=decision;r.human_decision={...evidence,user,chat_id:chat,message_id:s.message_id,
      timestamp:stamp(),artifact_sha:r.artifact_sha,review_version:r.review_version,status:decision};
    s.reviews.push({...r.human_decision,episode_id:episodeId,stage_id:r.stage_id,artifact_id:r.artifact_id,review_request_id:requestId});
    await store.cas(user,row.revision,s);
  }
  return production.reviewed({user,episodeId,requestId});
}
