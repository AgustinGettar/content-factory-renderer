import {mountLibrary} from './library.js';
import {createHash,createHmac,timingSafeEqual} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {MiniAppAuth,MINI_COOKIE,MINI_ORIGIN,MINI_PATH,miniAppEnabled,miniAppSecret,miniAuthConfigured,mutateMiniState,sessionCookie} from './auth.js';
import {authenticateMiniAppCommand,FIRST_IMAGE_EPISODE,studioEpisodeId,inputDigest} from '../lumi-v2-activation-context.js';
import {persistStageDecision,validateArtifact} from '../telegram-review-v1/core.js';
import {Q41_ONE_TAP_POLICY,Q42_ONE_TAP_POLICY,assertQ41Policy,sealQ41Consent,assertQ42Authorization,sealQ42Consent,assertOneTapConsent,assertOriginalRecoveryConsent} from './q41-policy.js';
import {LUMI_PRODUCTION_PROFILE_V2 as profile} from '../lumi-production-profile-v2.js';

const hash=s=>createHash('sha256').update(s).digest('hex');
const iso=()=>new Date().toISOString();
const envMenuVerified=env=>env.LUMI_TELEGRAM_BOT_ID==='8843261381'&&Number.isFinite(Date.parse(env.LUMI_MINI_APP_MENU_VERIFIED_AT||''));
const fail=(code,status=409)=>{throw Object.assign(Error(code),{status});};
const oneTapKind=kind=>['first_animation','second_image'].includes(kind);
const terminal=new Set(['COMPLETE','BLOCKED']);
const actions={quote:'q41_video_quote',authorize:'q41_video_authorize',generate:'q41_video_generate',recover:'q41_stage_recover',continue:'q41_local_continue',review:'mini_review'};
const labels={PLANNING:'Historia',SOURCE_PLANNING:'Plan de escenas',IMAGE:'Imagen',SOURCE_QA:'Revisión de imagen',DIRECTOR:'Dirección',VIDEO:'Animación',TEMPORAL_QA:'Calidad del clip',SHOT_REVIEW:'Revisión humana',TTS:'Voz',TTS_STORAGE:'Audio',CAPTIONS:'Subtítulos',ASSEMBLY:'Montaje',MASTER:'Master',MASTER_REVIEW:'Revisión final'};
const publicOperation=o=>o?{id:o.id,kind:o.kind,status:o.status,phase:o.phase??null,started_at:o.started_at,finished_at:o.finished_at??null,error:o.error??null,resume_available:o.resume_available===true,action_key:o.binding?.next_action??null,quote_id:o.binding?.quote_id??null,checkpoint_version:o.binding?.checkpoint_version??null}:null;
const quoteFields=['quote_id','quote_sha','quote_version','episode_id','action_key','shot_id','model','status','budget_gate','quote_usd','proposed_reserve_usd','expires_at','remaining_before_usd','remaining_after_usd','existing_exposure_usd','hard_budget_usd','actual_cost_usd','currency','quota_units','quota_remaining','request_count','voice_name'];
const stageTitles={IMAGE:'Preparar siguiente imagen',SOURCE_QA:'Verificar imagen para animación',DIRECTOR:'Preparar dirección cinematográfica',VIDEO:'Generar animación',TEMPORAL_QA:'Verificar calidad del clip',SHOT_REVIEW:'Revisar animación'};
const entityName=id=>({lumi:'Lumi',cow:'Vaca',sheep:'Oveja',hen:'Gallina',wand:'Varita con estrella'})[id]||id;

// Presentation is a read-only projection of the frozen AV2 contract and durable
// checkpoint. A completed shot never supplies the next economic action.
export function productionPresentation(cp){
  const current=cp.actions.find(a=>a.key===cp.first_pending_action),g=cp.metadata.generic_v2;
  const shots=(g.shot_plans||[]).map((shot,index)=>{
    const scene=g.plan.scenes.find(s=>s.id===shot.scene_ids[0]);
    const stages=cp.actions.filter(a=>a.scene_id===shot.shot_id);
    const reviews=Object.values(cp.metadata.review_requests||{});
    const complete=stages.some(a=>a.stage==='SHOT_REVIEW'&&a.status==='COMPLETE');
    const gaze=scene?.actions.find(a=>a.action_id==='gaze_target');
    const camera=({wide:'Plano general',medium:'Plano medio',close:'Primer plano'})[scene?.camera.shot]||scene?.camera.shot;
    const visual=[camera,scene?.camera.move==='static'?'cámara fija':scene?.camera.move,
      gaze?entityName(gaze.entity_id)+' dirige la mirada hacia '+(({cow:'la vaca',sheep:'la oveja',hen:'la gallina'})[gaze.gaze_target]||entityName(gaze.gaze_target)):null].filter(Boolean).join(' · ');
    const constraints=shot.director_input?.character_constraints;
    return {id:shot.shot_id,number:index+1,scene_ids:shot.scene_ids,complete,current:current?.scene_id===shot.shot_id,
      goal:shot.educational_goal,visual_description:visual,
      characters:(scene?.stage.placements||[]).filter(p=>p.visible&&g.plan.entities.some(e=>e.id===p.entity_id&&['character','animal'].includes(e.kind))).map(p=>entityName(p.entity_id)),
      continuity:{reference:entityName(g.plan.episode.continuity_initial.location),
        previous_goal:index?g.shot_plans[index-1].educational_goal:null,
        character_details:constraints?[['Cuerpo',constraints.body],['Ojos',constraints.eyes],['Alas',constraints.wings],['Vestuario',constraints.clothing],['Accesorio',constraints.prop]].filter(([,v])=>v).map(([k,v])=>k+': '+v):[],
        approved_source:!!cp.metadata.source_artifacts?.[shot.shot_id],canonical_reference:!!g.source_contracts?.find(s=>s.shot_id===shot.shot_id)?.canonical_source_sha},
      image_model:profile.image.model,generation_status:stages.find(a=>a.stage==='IMAGE')?.status??'PENDING',
      source_approved:reviews.some(r=>r.action_key==='image:'+shot.shot_id&&r.status==='APPROVED'),
      video_approved:reviews.some(r=>r.action_key==='video:'+shot.shot_id&&r.status==='APPROVED'),
      stages:stages.map(a=>({key:a.key,label:labels[a.stage],stage:a.stage,status:a.status,current:a.key===cp.first_pending_action}))};
  });
  return {current_shot:current?.scene_id??null,shots,action:current?{key:current.key,stage:current.stage,shot_id:current.scene_id,
    title:stageTitles[current.stage]||labels[current.stage]||'Continuar producción',status:current.status}:null};
}

// One read-only action projection over the existing receipts, CAS operations,
// reservation and emission journal. Quote expiry never erases a spend decision
// or releases a submission lock, even when another session selects another op.
export function currentActionState({checkpoint:cp,state,quote:q,current_emission:j}){
  const a=cp.actions.find(a=>a.key===cp.first_pending_action);
  if(!a||!['IMAGE','VIDEO','TTS'].includes(a.stage))return null;
  const ops=Object.values(state.mini_app?.operations||{}).filter(o=>o.binding?.proposal_id===cp.episode_id&&o.binding?.next_action===a.key);
  const latest=kind=>ops.filter(o=>o.kind===kind).sort((a,b)=>String(b.started_at).localeCompare(String(a.started_at)))[0];
  const commands=state.production_commands||{},quotes=Object.entries(commands).filter(([,r])=>r.result?.action_key===a.key&&r.result?.episode_id===cp.episode_id);
  const receipt=commands[q?.quote_id],authorization=receipt?.human_authorization;
  const generate=latest('second_image')||latest('first_animation')||latest('generate'),pending=ops.find(o=>['quote','authorize'].includes(o.kind)&&!terminal.has(o.status));
  const attempt=a.active_attempt_id??hash(cp.episode_id+':'+cp.metadata.generic_v2.binding_sha+':'+a.key);
  const stageReceipt=commands[attempt],dispatch=quotes.some(([id])=>commands['dispatch:'+id]);
  const reserve=cp.metadata.budget_reservations?.[a.key];
  const reviews=Object.values(cp.metadata.review_requests||{}).filter(r=>r.action_key===a.key);
  const emitted=!!(generate||j||reserve||dispatch||stageReceipt||a.artifact||a.dispatch_state!=='NOT_DISPATCHED'||reviews.length);
  let status='NOT_STARTED';
  if(a.artifact)status=reviews.some(r=>r.status==='PENDING')?'AWAITING_HUMAN_REVIEW':'SUCCEEDED';
  else if(j?.not_emitted&&j?.validation_error)status='BLOCKED';
  else if(a.stage==='TTS'&&stageReceipt?.status==='WAITING'&&stageReceipt.result?.next_action==='CONTINUE_AUTHORIZED_TTS_UNIT')status='SUBMITTED';
  else if(j?.failure_confirmed)status='FAILED_CONFIRMED';
  else if(j?.state==='ACKNOWLEDGED'&&j.accepted&&j.request_id)status='SUBMITTED';
  else if(j?.state==='EMISSION_UNKNOWN'||j?.state==='ACKNOWLEDGED')status='AMBIGUOUS';
  else if(j?.state==='EMITTING')status='EMITTING';
  else if(reserve||j?.state==='PREPARED')status='RESERVED';
  else if(emitted)status=generate&&['QUEUED','RUNNING'].includes(generate.status)&&Date.now()-Date.parse(generate.phase_updated_at??generate.started_at)<120000&&!dispatch&&!stageReceipt?'PREPARING':'AMBIGUOUS';
  else if(pending)status=pending.kind==='quote'?'QUOTE_PENDING':'AUTHORIZATION_PENDING';
  else if(q?.status==='QUOTE_RESULT_UNKNOWN')status='AMBIGUOUS';
  else if(authorization)status='AUTHORIZED';
  else if(q?.quote_id)status=['AWAITING_HUMAN_AUTHORIZATION','QUOTE_EXPIRED'].includes(q.status)?'QUOTED':'AMBIGUOUS';
  else if(latest('quote')||latest('authorize'))status='AMBIGUOUS';
  const op=generate||pending||ops.find(o=>o.kind==='authorize'&&o.binding.quote_id===q?.quote_id)||latest('authorize')||latest('quote');
  return {action_key:a.key,shot_id:a.scene_id,status,lifecycle:operationLifecycle(status,{action:a.key,attempt_id:attempt,checkpoint_revision:cp.metadata.runtime_revision}),locked:status!=='NOT_STARTED',emission_locked:emitted,
    operation_id:op?.id??j?.attempt_id??null,attempt_id:attempt,provider_request_id:j?.request_id??a.provider_request_id??null,
    quote_id:q?.quote_id??null,quote_status:q?.status??null,authorization_recorded:!!authorization,
    authorization_expired:!!authorization&&Date.parse(authorization.expires_at)<=Date.now(),
    recovery_mode:stageReceipt?.result?.next_action??null,phase:generate?.phase??null,reservation_usd:reserve?.amount_usd??0,operations:ops.map(publicOperation)};
}

export const OPERATION_STATES=Object.freeze(['NOT_STARTED','PREPARING','QUOTING','AUTHORIZED','RESERVED','EMITTING','PROCESSING','SUCCEEDED','AWAITING_HUMAN_REVIEW','APPROVED','FAILED_CONFIRMED','AMBIGUOUS','BLOCKED']);
const lifecycleLabels={NOT_STARTED:'Pendiente',PREPARING:'Preparando',QUOTING:'Comprobando precio',AUTHORIZED:'Autorización guardada',RESERVED:'Reserva guardada',EMITTING:'Enviando solicitud',PROCESSING:'Procesando solicitud original',SUCCEEDED:'Resultado guardado',AWAITING_HUMAN_REVIEW:'Esperando tu revisión',APPROVED:'Aprobado',FAILED_CONFIRMED:'Fallo confirmado',AMBIGUOUS:'Falta evidencia del proveedor',BLOCKED:'Producción pausada'};
export function operationLifecycle(status,evidence={},permitted=[]){
 const state=({QUOTED:'QUOTING',QUOTE_PENDING:'QUOTING',AUTHORIZATION_PENDING:'PREPARING',SUBMITTED:'PROCESSING'})[status]||status;
 const normalized=OPERATION_STATES.includes(state)?state:'BLOCKED';
 return {state:normalized,label:lifecycleLabels[normalized],evidence,allowed:['READ_PROGRESS',...permitted],prohibited:['AUTOMATIC_RETRY','TIMEOUT_REEMISSION','RELEASE_AMBIGUOUS_RESERVATION','SKIP_HUMAN_REVIEW'],recovery:state==='PROCESSING'?'VERIFIED_ORIGINAL_JOB_ONLY':['AMBIGUOUS','BLOCKED','EMITTING','RESERVED'].includes(state)?'DURABLE_EVIDENCE_REQUIRED':'CHECKPOINT_BOUND_COMMAND'};
}

export class MiniAppService {
  constructor({store,adapter,production,loadBytes,env,oneTapPolicy=Q41_ONE_TAP_POLICY,secondImagePolicy=Q42_ONE_TAP_POLICY}){Object.assign(this,{store,adapter,production,loadBytes,env,oneTapPolicy,secondImagePolicy});this.inflight=new Map();this.mediaCache=new Map();this.recoveryTimers=new Map();}
  async context(p){
    for(let i=0;i<4;i++){
      const status=await this.adapter.miniAppStatus(p),row=await this.store.get(p.user);
      if(status.review_revision===undefined||status.review_revision===row.revision)return {...status,state:row.state,review_revision:row.revision};
    }
    fail('MINI_STATE_CHANGED');
  }
  continuation(ctx,op){
    if(op?.kind!=='continue'||op.binding?.proposal_id!==ctx.checkpoint.episode_id)return {};
    const cp=ctx.checkpoint,a=cp.actions.find(a=>a.key===op.binding.next_action);
    if(!a||['IMAGE','VIDEO','TTS'].includes(a.stage))return {};
    const id=a.active_attempt_id??hash(cp.episode_id+':'+cp.metadata.generic_v2.binding_sha+':'+a.key);
    const receipt=ctx.state.production_commands?.[id],result=cp.metadata.stage_results?.[a.key];
    const complete=a.status==='COMPLETE'&&receipt?.status==='COMPLETE'&&result?.sha256===inputDigest(receipt.result);
    // The demonstrated failure happened during input validation, before a
    // stage claim. Only that exact unexecuted local action can be resumed.
    const resume=op.status==='BLOCKED'&&['QA_NOT_ELIGIBLE','HUMAN_REVIEW_OPERATION_MISMATCH'].includes(op.error)
      &&cp.status==='RUNNING'&&cp.first_pending_action===a.key&&cp.metadata.runtime_revision===op.binding.checkpoint_version
      &&a.status==='PENDING'&&a.dispatch_state==='NOT_DISPATCHED'&&!receipt;
    return {complete,resume};
  }
  reviewRecovery(ctx,op){
    const b=op?.binding,cp=ctx.checkpoint;
    if(op?.kind!=='review'||b?.proposal_id!==cp.episode_id)return {};
    const r=ctx.state.episodes?.[cp.episode_id]?.review_requests?.[b.request_id],c=cp.metadata.review_requests?.[b.request_id],h=r?.human_decision;
    if(!r||!c||r.episode_id!==cp.episode_id||c.episode_id!==cp.episode_id||r.artifact_id!==c.artifact_id||r.status!==b.decision||!['APPROVED','REJECTED'].includes(b.decision)
      ||r.artifact_sha!==b.artifact_sha||c.artifact_sha!==b.artifact_sha||r.review_version!==b.review_version||c.review_version!==b.review_version
      ||h?.channel!=='TELEGRAM_MINI_APP'||h.mini_app_operation_id!==op.id||h.user!==cp.metadata.user||h.status!==b.decision||h.chat_id!==ctx.state.chat_id
      ||h.artifact_sha!==b.artifact_sha||h.review_version!==b.review_version
      ||inputDigest(h.checklist_decision??null)!==inputDigest(b.checklist_decision??null))return {};
    return {complete:c.status===b.decision&&inputDigest(c.human_decision)===inputDigest(h),resume:c.status==='PENDING'};
  }
  generation({checkpoint:cp,state,q41_emission:j}){
    if(cp.episode_id!==FIRST_IMAGE_EPISODE)return {locked:false,status:'NOT_STARTED',operation_id:null,provider_request_id:null};
    // The lock is a projection of existing durable records, independent of the
    // active UI operation, session, quote expiry and process-local timers.
    const op=Object.values(state.mini_app?.operations||{}).find(o=>o.binding?.proposal_id===cp.episode_id&&(o.kind==='first_animation'||o.kind==='generate'&&o.binding?.next_action==='video:q41'));
    const a=cp.actions.find(a=>a.key==='video:q41'),reserve=cp.metadata.budget_reservations?.['video:q41'];
    const reviews=Object.values(cp.metadata.review_requests||{}).filter(r=>r.action_key==='video:q41');
    const dispatched=a&&a.dispatch_state!=='NOT_DISPATCHED';
    const locked=!!(op||j||reserve||dispatched||a?.artifact||reviews.length);
    let status='NOT_STARTED';
    if(a?.artifact)status=reviews.some(r=>r.status==='PENDING')?'AWAITING_HUMAN_REVIEW':'SUCCEEDED';
    else if(j?.state==='ACKNOWLEDGED'&&j.request_id)status='SUBMITTED';
    else if(j?.state==='EMISSION_UNKNOWN'||j?.state==='ACKNOWLEDGED'||op?.status==='RECOVERY_REQUIRED')status='AMBIGUOUS';
    else if(j?.state==='EMITTING')status='EMITTING';
    else if(reserve||j?.state==='PREPARED')status='RESERVED';
    else if(dispatched)status='AMBIGUOUS';
    else if(op?.status==='BLOCKED')status='BLOCKED';
    else if(op)status=({VERIFYING_SOURCE:'PREPARING',QUOTING:'QUOTING',BUDGET_CHECK:'BUDGET_CHECK',DISPATCHING:'AUTHORIZED'})[op.phase]||'AMBIGUOUS';
    return {locked,status,operation_id:op?.id??a?.active_attempt_id??j?.attempt_id??null,
      provider_request_id:j?.request_id??a?.provider_request_id??null};
  }
  lockedOperation(ctx){
    const op=Object.values(ctx.state.mini_app?.operations||{}).find(o=>o.binding?.proposal_id===ctx.checkpoint.episode_id&&(o.kind==='first_animation'||o.kind==='generate'&&o.binding?.next_action==='video:q41'));
    if(op)return publicOperation(op);
    const g=this.generation(ctx);
    return {id:g.operation_id,kind:'first_animation',status:['SUCCEEDED','AWAITING_HUMAN_REVIEW'].includes(g.status)?'COMPLETE':'RECOVERY_REQUIRED',
      phase:['SUCCEEDED','AWAITING_HUMAN_REVIEW'].includes(g.status)?'REVIEW_READY':g.status==='SUBMITTED'?'GENERATING':null,resume_available:false};
  }
  catalog({checkpoint:cp,state}){
    const found=new Map();
    const add=(episode,a,role,label)=>{try{validateArtifact(a);}catch{return;}const id=hash(episode+':'+a.artifact_id+':'+a.sha256);found.set(id,{id,episode,a,role,label});};
    for(const [episode,e] of Object.entries(state.episodes||{})){
      for(const a of Object.values(e.artifacts||{}))add(episode,a,a.mime.startsWith('image/')?'source':'clip',a.mime.startsWith('image/')?'Imagen de la escena':'Clip de la escena');
      for(const s of e.shots||[])if(s.artifact)add(episode,s.artifact,'clip','Animación '+s.shot_id.replace('q4',''));
      if(e.master)add(episode,e.master,'master','Video final');
    }
    for(const a of Object.values(cp.metadata.artifacts||{}))add(cp.episode_id,a,cp.metadata.stage_results?.master?.result.artifacts?.some(x=>x.artifact_id===a.artifact_id)?'master':a.mime.startsWith('image/')?'source':a.mime.startsWith('video/')?'clip':'audio',a.mime.startsWith('image/')?'Imagen aprobada · Escena 1':'Medio de producción');
    return found;
  }
  mediaTicket(p,id,expires){return createHmac('sha256',miniAppSecret(this.env)).update('lumi-mini-media:'+ [p.session,id,expires].join(':')).digest('hex');}
  projectOneTapOperation(p,ctx,op){
    if(!op||op.binding?.proposal_id!==ctx.checkpoint.episode_id)return null;
    // Read-only projection. Recovery writes and provider GETs belong only to
    // the existing recovery worker or an explicit recovery command.
    const action=op.kind==='second_image'?'image:q42':'video:q41',a=ctx.checkpoint.actions.find(a=>a.key===action);
    if(a?.artifact&&Object.values(ctx.checkpoint.metadata.review_requests||{}).some(r=>r.action_key===action)){
      return {...op,status:'COMPLETE',phase:'REVIEW_READY'};
    }
    const journal=op.kind==='second_image'?ctx.current_emission:ctx.q41_emission;
    if(journal?.state==='ACKNOWLEDGED'&&journal.request_id&&(op.kind!=='second_image'||journal.accepted)){
      return {...op,status:'RUNNING',phase:'GENERATING',binding:{...op.binding,action:'q41_stage_recover'}};
    }
    if(op.status==='RUNNING'&&!['GENERATING','REVIEW_READY'].includes(op.phase)&&Date.now()-Date.parse(op.started_at)>120000&&!this.inflight.has(p.user+':'+op.id))return {...op,status:'RECOVERY_REQUIRED',resume_available:false};
    return op;
  }
  projectOperation(p,ctx,operation){
    const {quote:q,state}=ctx;
    let op=oneTapKind(operation?.kind)?this.projectOneTapOperation(p,ctx,operation):operation;
    const continuation=this.continuation(ctx,op);
    const review=this.reviewRecovery(ctx,op);
    if((continuation.complete||review.complete)&&op.status!=='COMPLETE'){
      op={...op,status:'COMPLETE'};
    }else if(continuation.resume||review.resume)op={...op,resume_available:true};
    if(op&&!oneTapKind(op.kind)&&!terminal.has(op.status)){
      const quoteDone=op.kind==='quote'&&q?.quote_id&&q.quote_id!==op.binding.quote_id&&q.status!=='QUOTE_RESULT_UNKNOWN';
      const authorized=op.kind==='authorize'&&state.production_commands?.[op.binding.quote_id]?.human_authorization?.mini_app_operation_id===op.id;
      const dispatched=op.kind==='generate'&&state.production_commands?.['dispatch:'+op.binding.quote_id];
      if(quoteDone||authorized||dispatched){
        op={...op,status:'COMPLETE'};
      }else if(Date.now()-Date.parse(op.started_at)>120000&&!this.inflight.has(p.user+':'+op.id))op={...op,status:'RECOVERY_REQUIRED',resume_available:review.resume||op.status==='QUEUED'||op.kind==='quote'};
    }
    return op;
  }
  settleCompletedOperation(p,ctx,m,state){
    const selected=m.operations[m.active_operation],active=selected?.binding?.proposal_id===ctx.checkpoint.episode_id?selected:null,projected=this.projectOperation(p,{...ctx,state},active);
    // Called only inside an explicitly requested command's existing CAS.
    if(active&&projected?.status==='COMPLETE'&&active.status!=='COMPLETE')Object.assign(active,{status:'COMPLETE',finished_at:iso(),reconciled_from:'DURABLE_STAGE_RESULT'});
    return active;
  }
  async view(p){
    const ctx=await this.context(p),{checkpoint:cp,quote:q,budget:b,state}=ctx;
    const presentation=productionPresentation(cp);
    const expires=Math.min(p.expires_at,Date.now()+300000);
    const media=[...this.catalog(ctx).values()].map(({id,episode,a,role,label})=>{
      const shotId=episode===cp.episode_id?cp.actions.find(x=>x.scene_id&&x.artifact?.artifact_id===a.artifact_id)?.scene_id:null;
      const shot=presentation.shots.find(s=>s.id===shotId);
      return {id,episode,role,shot_id:shotId,approved:role==='clip'?shot?.video_approved===true:shot?.source_approved===true,
      label:shot?'Toma '+shot.number+' · '+(role==='clip'?'Animación':'Imagen')+(shot.complete?' · Completada':''):label,mime:a.mime,width:a.width,height:a.height,
      url:MINI_PATH+'/api/media/'+id+'?expires='+expires+'&ticket='+this.mediaTicket(p,id,expires),expires_at:expires};});
    const selected=state.mini_app?.operations?.[state.mini_app.active_operation];
    const op=selected?.binding?.proposal_id===cp.episode_id?this.projectOperation(p,ctx,selected):null;
    const current=cp.actions.find(a=>a.key===cp.first_pending_action);
    const generation=this.generation(ctx);
    const actionState=currentActionState(ctx);
    let secondAuthorized=false;
    try{assertQ42Authorization(state,cp,this.secondImagePolicy);secondAuthorized=true;}catch{/* A missing or changed consent never grants spending. */}
    const secondAvailable=secondAuthorized&&cp.first_pending_action==='image:q42'&&!actionState?.emission_locked&&['NOT_STARTED','QUOTED','AUTHORIZED'].includes(actionState?.status)&&cp.status==='RUNNING';
    const canPrepare=!actionState?.emission_locked&&['NOT_STARTED','QUOTED','AUTHORIZED'].includes(actionState?.status)&&cp.status==='RUNNING'&&current?.status==='PENDING'&&current?.dispatch_state==='NOT_DISPATCHED'&&['IMAGE','VIDEO','TTS'].includes(current?.stage)
      &&!(current.key==='video:q41'&&generation.locked);
    const quote= q&&q.action_key===current?.key?Object.fromEntries(quoteFields.filter(k=>k in q).map(k=>[k,q[k]])):null;
    const reviews=Object.values(cp.metadata.review_requests||{}).filter(r=>r.status==='PENDING').map(r=>({id:r.review_request_id,stage:r.stage_id,
      artifact_sha:r.artifact_sha,version:r.review_version,contract_sha:r.review_contract?inputDigest(r.review_contract):null,contract:r.review_contract?structuredClone(r.review_contract):null,
      source_media_id:r.review_contract?.source_sha?[...this.catalog(ctx).values()].find(x=>x.episode===cp.episode_id&&x.a.sha256===r.review_contract.source_sha)?.id:null,
      media_id:[...this.catalog(ctx).values()].find(x=>x.episode===cp.episode_id&&x.a.artifact_id===r.artifact_id)?.id}));
    const capabilities={quote:canPrepare&&actionState?.status==='NOT_STARTED',
      renew_quote:canPrepare&&['QUOTED','AUTHORIZED'].includes(actionState?.status)&&quote?.status==='QUOTE_EXPIRED',
      authorize:canPrepare&&quote?.status==='AWAITING_HUMAN_AUTHORIZATION'&&q.budget_gate==='PASS',
      generate:canPrepare&&quote?.status==='HUMAN_SPEND_AUTHORIZED'&&q.budget_gate==='PASS',
      recover:current?.status==='PENDING'&&actionState?.status==='SUBMITTED'&&['IMAGE','VIDEO','TTS'].includes(current?.stage),
      continue:(!op||op.status==='COMPLETE')&&cp.status==='RUNNING'&&current?.status==='PENDING'&&current?.dispatch_state==='NOT_DISPATCHED'&&!['IMAGE','VIDEO','TTS'].includes(current?.stage)&&!reviews.length};
    const lifecycle=operationLifecycle(reviews.length?'AWAITING_HUMAN_REVIEW':actionState?.status||(!current?'APPROVED':cp.status!=='RUNNING'?'BLOCKED':current.dispatch_state==='DISPATCHING'?'PREPARING':'NOT_STARTED'),
      {episode_id:cp.episode_id,action_key:current?.key??null,checkpoint_revision:cp.metadata.runtime_revision,review_revision:ctx.review_revision,
       operation_id:actionState?.operation_id??op?.id??null,attempt_id:actionState?.attempt_id??null,provider_request_id:actionState?.provider_request_id??null,
       reservation_usd:actionState?.reservation_usd??0,review_ids:reviews.map(r=>r.id)},
      [...Object.entries(capabilities).filter(([,enabled])=>enabled).map(([action])=>action.toUpperCase()),...(reviews.length?['REVIEW']:[])]);
    if(actionState)actionState.lifecycle=lifecycle;
    return {version:3,review_revision:ctx.review_revision,lifecycle,current_action:actionState,production:presentation,server_time:Date.now(),episode:{id:cp.episode_id,title:cp.metadata.generic_v2.plan.episode.title,status:cp.status,
      last_completed:cp.last_completed_action,next_action:cp.first_pending_action,checkpoint_version:cp.metadata.runtime_revision,director_complete:cp.actions.some(a=>a.key==='director:q41'&&a.status==='COMPLETE'),
      source_approved:Object.values(cp.metadata.review_requests||{}).some(r=>r.action_key==='image:q41'&&r.status==='APPROVED'),
      actions:cp.actions.map(a=>({key:a.key,label:labels[a.stage]||'Producción',shot:a.scene_id,status:a.status,current:a.key===cp.first_pending_action}))},
      episodes:Object.entries(state.episodes||{}).map(([id,e])=>({id,title:e.title||'Video de Lumi',has_master:!!e.master})),media,reviews,
      budget:{ceiling_usd:b.episode_ceiling_usd,exposure_usd:b.required_total_usd,remaining_usd:Number((b.episode_ceiling_usd-b.required_total_usd).toFixed(6)),
        actual_cost_usd:null,actual_cost_status:'NOT_VERIFIED',provider_balance_usd:null,reservations:Object.entries(cp.metadata.budget_reservations||{}).map(([action_key,r])=>({action_key,amount_usd:r.amount_usd,status:r.status})),full_episode_coverage:'FUTURE_QUOTES_REQUIRED',gate:b.status},quote,operation:publicOperation(op),
      first_animation:{...this.oneTapPolicy,...generation,available:canPrepare&&cp.episode_id===FIRST_IMAGE_EPISODE&&cp.first_pending_action==='video:q41'&&!generation.locked},
      second_image:{available:secondAvailable,authorization_available:secondAuthorized,max_reservation_usd:this.secondImagePolicy.max_reservation_usd,authorization_id:this.secondImagePolicy.authorization_id},
      capabilities,
      settings:{environment:'staging',supervised:true,publication:false,autorun:cp.autorun,runners:cp.runner_enabled?'ON':'OFF',
        higgsfield:!!this.env.HF_API_KEY,elevenlabs:!!this.env.ELEVENLABS_API_KEY,telegram:true,video_model:'Kling 3.0 Pro',duration_seconds:cp.metadata.generic_v2.shot_plans.find(s=>s.shot_id===current?.scene_id)?.duration??null,audio:false,
        entrypoint:state.mini_app?.entrypoint?.status||(envMenuVerified(this.env)?'CONFIGURED':'PENDING')}};
  }
  async enqueue(p,kind,body){
    if(kind==='select_episode'){
      if(Object.keys(body).length!==1||typeof body.episode_id!=='string')fail('MINI_BODY_INVALID',400);
      await this.context(p);
      await mutateMiniState(this.store,p.user,(m,state)=>{
        if(state.episodes?.[body.episode_id]?.pipeline!==profile.id)fail('MINI_EPISODE_REQUIRED');
        if(Object.values(m.operations).some(o=>['QUEUED','RUNNING'].includes(o.status)))fail('MINI_OPERATION_IN_PROGRESS');
        m.active_episode_id=body.episode_id;m.active_operation=null;
      });
      return {operation:null,dispatch:async()=>{}};
    }
    if(oneTapKind(kind)){
      if(Object.keys(body).length!==1||body.confirm!==true)fail('MINI_BODY_INVALID',400);
      const ctx=await this.context(p),image=kind==='second_image',action=image?'image:q42':'video:q41';
      const existing=Object.values(ctx.state.mini_app?.operations||{}).find(o=>o.kind===kind||o.kind==='generate'&&o.binding?.next_action===action);
      if(existing)return {operation:publicOperation(existing),dispatch:async()=>{}};
      if(!image&&this.generation(ctx).locked)return {operation:this.lockedOperation(ctx),dispatch:async()=>{}};
      if(image&&currentActionState(ctx)?.emission_locked)fail('MINI_GENERATION_LOCKED');
      const {cp}=await this.adapter.miniAppFirstAnimationContext(p),policy=image?this.secondImagePolicy:this.oneTapPolicy;
      if(image)assertQ42Authorization(ctx.state,cp,policy);else assertQ41Policy(cp,policy);
      if(cp.first_pending_action!==action)fail('MINI_STAGE_CHANGED');
      const id=hash(FIRST_IMAGE_EPISODE+':'+action+':ONE_TAP_V1');
      const consent=(image?sealQ42Consent:sealQ41Consent)({cp,state:ctx.state,policy,user:p.user,chat:p.chat,operationId:id},this.env);
      const claimed=await mutateMiniState(this.store,p.user,(m,state)=>{
        const prior=Object.values(m.operations).find(o=>o.kind===kind||o.kind==='generate'&&o.binding?.next_action===action);
        if(prior)return {operation:structuredClone(prior),created:false};
        if(image)assertQ42Authorization(state,cp,policy);
        const active=this.settleCompletedOperation(p,ctx,m,state);if(active&&!terminal.has(active.status))fail('MINI_OPERATION_IN_PROGRESS');
        const next={id,kind,status:'QUEUED',phase:'VERIFYING_SOURCE',consent,session_id:p.session,started_at:iso(),
          binding:{action:'q41_video_authorize',proposal_id:FIRST_IMAGE_EPISODE,next_action:action,checkpoint_version:cp.metadata.runtime_revision}};
        m.operations[id]=next;m.active_operation=id;return {operation:structuredClone(next),created:true};
      });
      return {operation:publicOperation(claimed.operation),dispatch:claimed.created?()=>this.run(p,claimed.operation.id):async()=>{}};
    }
    if(kind==='resume'){
      if(Object.keys(body).length)fail('MINI_BODY_INVALID',400);
      const ctx=await this.context(p);
      const op=await mutateMiniState(this.store,p.user,(m,state)=>{
        const prior=m.operations[m.active_operation];
        const review=this.reviewRecovery({...ctx,state},prior);
        if(review.resume||this.continuation({...ctx,state},prior).resume){
          prior.recovery={reason:prior.error,failed_at:prior.finished_at,resumed_at:iso(),evidence:review.resume?'EXISTING_AUTHENTIC_HUMAN_DECISION':'NO_STAGE_CLAIM_OR_DISPATCH'};
          Object.assign(prior,{status:'QUEUED',session_id:p.session,error:null,finished_at:null,started_at:iso()});
          return structuredClone(prior);
        }
        if(!prior||terminal.has(prior.status))fail('MINI_NO_PENDING_OPERATION');
        if(this.inflight.has(p.user+':'+prior.id))return structuredClone(prior);
        // A queued action has never entered the executor. An interrupted quote
        // may re-enter only its original lineage, whose canonical claim prevents
        // any repeated estimate. A started generation is NEVER replayed here.
        if(oneTapKind(prior.kind)||prior.status!=='QUEUED'&&(prior.kind!=='quote'||Date.now()-Date.parse(prior.started_at)<120000))fail('MINI_RECONCILIATION_REQUIRED');
        Object.assign(prior,{status:'QUEUED',session_id:p.session});return structuredClone(prior);
      });
      return {operation:publicOperation(op),dispatch:()=>this.run(p,op.id)};
    }
    if(!actions[kind])fail('MINI_ACTION_INVALID',400);
    const allowed=['quote_id','quote_sha','confirm','request_id','decision','artifact_sha','review_version','full_playback','source_comparison','pose','wand_hand','expected_action','checkpoint_version'];
    if(Object.keys(body).some(k=>!allowed.includes(k)))fail('MINI_BODY_INVALID',400);
    const ctx=await this.context(p),{checkpoint:cp,quote:q,state}=ctx;
    if(kind==='recover'){
      const original=Object.values(state.mini_app?.operations||{}).find(o=>oneTapKind(o.kind)&&o.binding?.proposal_id===cp.episode_id&&o.binding?.next_action===cp.first_pending_action);
      if(original){
        if(currentActionState(ctx)?.status!=='SUBMITTED')fail('MINI_ORIGINAL_JOB_UNVERIFIED');
        return {operation:publicOperation(this.projectOneTapOperation(p,ctx,original)),dispatch:()=>this.recoverFirstAnimation(p,original.id)};
      }
    }
    if(kind==='generate'&&body.expected_action){
      const prior=Object.values(state.mini_app?.operations||{}).find(o=>o.binding?.proposal_id===cp.episode_id&&(o.kind==='generate'||o.kind==='second_image')&&o.binding?.next_action===body.expected_action);
      if(prior)return {operation:publicOperation(prior),dispatch:async()=>{}};
    }
    if(kind==='continue'){
      if(Object.keys(body).some(k=>!['expected_action','checkpoint_version'].includes(k)))fail('MINI_BODY_INVALID',400);
      const prior=Object.values(state.mini_app?.operations||{}).find(o=>o.kind==='continue'&&o.binding?.proposal_id===cp.episode_id
        &&o.binding.next_action===body.expected_action&&o.binding.checkpoint_version===body.checkpoint_version);
      if(prior)return {operation:publicOperation(prior),dispatch:async()=>{}};
      const a=cp.actions.find(a=>a.key===cp.first_pending_action);
      if(body.expected_action!==a?.key||body.checkpoint_version!==cp.metadata.runtime_revision||cp.status!=='RUNNING'
        ||a.status!=='PENDING'||a.dispatch_state!=='NOT_DISPATCHED'||['IMAGE','VIDEO','TTS'].includes(a.stage))fail('MINI_CONTINUATION_CHANGED');
      const selected=state.mini_app?.operations?.[state.mini_app.active_operation];
      const active=selected?.binding?.proposal_id===cp.episode_id?this.projectOperation(p,ctx,selected):null;
      if(active&&active.status!=='COMPLETE')return {operation:publicOperation(active),dispatch:async()=>{}};
    }
    if(cp.episode_id===FIRST_IMAGE_EPISODE&&cp.first_pending_action==='video:q41'&&this.generation(ctx).locked){
      if(kind==='generate')return {operation:this.lockedOperation(ctx),dispatch:async()=>{}};
      if(['quote','authorize'].includes(kind))fail('MINI_GENERATION_LOCKED');
    }
    if(['quote','authorize','generate'].includes(kind)){
      const current=cp.actions.find(a=>a.key===cp.first_pending_action);
      if((cp.first_pending_action!=='video:q41'||body.expected_action!==undefined)&&(body.expected_action!==current?.key||body.checkpoint_version!==cp.metadata.runtime_revision))fail('MINI_STAGE_CHANGED');
      if(!current||cp.status!=='RUNNING'||current.status!=='PENDING'||current.dispatch_state!=='NOT_DISPATCHED'||!['IMAGE','VIDEO','TTS'].includes(current.stage))fail('MINI_STAGE_CHANGED');
      const prior=Object.values(state.mini_app?.operations||{}).find(o=>o.binding?.proposal_id===cp.episode_id&&(o.kind==='generate'||o.kind==='second_image')&&o.binding?.next_action===current.key);
      if(prior){if(kind==='generate')return {operation:publicOperation(prior),dispatch:async()=>{}};fail('MINI_GENERATION_LOCKED');}
      const durable=currentActionState(ctx);
      if(durable.emission_locked)fail('MINI_GENERATION_LOCKED');
      const pending=durable.operations.find(o=>['quote','authorize'].includes(o.kind)&&!terminal.has(o.status));
      if(pending)return {operation:pending,dispatch:async()=>{}};
      if(kind==='quote'&&durable.status!=='NOT_STARTED'&&q?.status!=='QUOTE_EXPIRED'){
        const prior=durable.operations.find(o=>o.kind==='quote');
        if(prior)return {operation:prior,dispatch:async()=>{}};
        fail('MINI_CURRENT_QUOTE_REQUIRED');
      }
      if(q&&q.action_key!==current.key)fail('MINI_QUOTE_CHANGED');
    }
    let binding={action:actions[kind],proposal_id:cp.episode_id,next_action:cp.first_pending_action,checkpoint_version:cp.metadata.runtime_revision};
    if(['quote','authorize','generate'].includes(kind)){
      if((q?.quote_id??null)!==(body.quote_id??null)||(q?.quote_sha??null)!==(body.quote_sha??null))fail('MINI_QUOTE_CHANGED');
      Object.assign(binding,{quote_id:q?.quote_id??null,quote_sha:q?.quote_sha??null});
      if(kind!=='quote'&&(body.confirm!==true||!q||q.budget_gate!=='PASS'||Date.parse(q.expires_at)<=Date.now()))fail('MINI_CURRENT_QUOTE_REQUIRED');
      if(kind==='authorize'&&q.status!=='AWAITING_HUMAN_AUTHORIZATION'&&q.status!=='HUMAN_SPEND_AUTHORIZED')fail('MINI_CURRENT_QUOTE_REQUIRED');
      if(kind==='generate'&&q.status!=='HUMAN_SPEND_AUTHORIZED')fail('MINI_SPEND_APPROVAL_REQUIRED');
    }
    if(kind==='review'){
      const r=cp.metadata.review_requests?.[body.request_id];
      if(!r||r.status!=='PENDING'||r.artifact_sha!==body.artifact_sha||r.review_version!==body.review_version||!['APPROVED','REJECTED'].includes(body.decision))fail('MINI_REVIEW_STALE');
      binding={...binding,request_id:body.request_id,artifact_sha:r.artifact_sha,review_version:r.review_version,decision:body.decision,
        checklist_decision:r.review_contract?{contract_sha:inputDigest(r.review_contract),full_playback:body.full_playback===true,source_comparison:body.source_comparison===true,pose:body.pose,wand_hand:body.wand_hand}:null};
    }
    if(kind==='recover')Object.assign(binding,{quote_id:q?.quote_id??null,quote_sha:q?.quote_sha??null});
    const stable=hash(JSON.stringify({kind,binding}));
    const op=await mutateMiniState(this.store,p.user,(m,state)=>{
      if(['quote','authorize','generate'].includes(kind)){
        const prior=Object.values(m.operations).find(o=>o.binding?.proposal_id===binding.proposal_id&&(o.kind==='first_animation'&&binding.next_action==='video:q41'||(o.kind==='generate'||o.kind==='second_image')&&o.binding?.next_action===binding.next_action));
        if(prior){if(kind==='generate')return structuredClone(prior);fail('MINI_GENERATION_LOCKED');}
      }
      const active=this.settleCompletedOperation(p,ctx,m,state);
      if(active&&!terminal.has(active.status))return structuredClone(active);
      const id=kind==='recover'?hash(stable+':'+Object.keys(m.operations).length):stable;
      if(m.operations[id])return structuredClone(m.operations[id]);
      const next={id,kind,status:'QUEUED',binding,session_id:p.session,started_at:iso()};m.operations[id]=next;m.active_operation=id;return structuredClone(next);
    });
    return {operation:publicOperation(op),dispatch:()=>this.run(p,op.id)};
  }
  async run(p,id){
    const key=p.user+':'+id;if(this.inflight.has(key))return this.inflight.get(key);
    const work=(async()=>{
      const admitted=await mutateMiniState(this.store,p.user,m=>{const o=m.operations[id];if(o?.status!=='QUEUED')return null;
        if(o.session_id!==p.session)fail('MINI_SESSION_REQUIRED',401);o.status='RUNNING';return structuredClone(o);});
      if(!admitted)return;
      try{
        if(oneTapKind(admitted.kind)){await this.runFirstAnimation(p,id);return;}
        const command=authenticateMiniAppCommand({principal:p,operationId:id});
        let result;
        if(admitted.kind==='quote'){
          const ctx=await this.context(p);
          if(ctx.checkpoint.first_pending_action!==admitted.binding.next_action||ctx.checkpoint.metadata.runtime_revision!==admitted.binding.checkpoint_version)fail('MINI_STAGE_CHANGED');
          result=await this.adapter.prepareEp004VideoQuote({user:p.user,chat:p.chat,renew:true,expectedQuoteId:admitted.binding.quote_id,miniAppPrincipal:p,expectedAction:admitted.binding.next_action,checkpointVersion:admitted.binding.checkpoint_version});
        }
        if(admitted.kind==='authorize')result=await this.adapter.authorizeEp004VideoQuote({command});
        if(admitted.kind==='generate')result=await this.adapter.executeQuotedStage({command});
        if(admitted.kind==='recover')result=await this.adapter.recoverQuotedStage({command});
        if(admitted.kind==='continue')result=await this.adapter.continueLocalStage({command});
        if(admitted.kind==='review'){
          const b=admitted.binding;
          result=await persistStageDecision({store:this.store,production:this.production,user:p.user,chat:p.chat,episodeId:b.proposal_id,
            requestId:b.request_id,decision:b.decision,artifactSha:b.artifact_sha,reviewVersion:b.review_version,
            evidence:{channel:'TELEGRAM_MINI_APP',mini_app_operation_id:id,checklist_decision:b.checklist_decision}});
        }
        await mutateMiniState(this.store,p.user,m=>Object.assign(m.operations[id],{status:'COMPLETE',finished_at:iso(),result_status:result?.status??null}));
      }catch(e){
        const error=/^[A-Z0-9_]{1,100}$/.test(e.message)?e.message:'MINI_ACTION_REQUIRES_RECOVERY';
        await mutateMiniState(this.store,p.user,m=>Object.assign(m.operations[id],{status:'BLOCKED',finished_at:iso(),error}));
      }
    })();this.inflight.set(key,work);try{await work;}finally{this.inflight.delete(key);}
  }
  async oneTapPhase(p,id,phase,patch={}){
    return mutateMiniState(this.store,p.user,m=>{const op=m.operations[id];if(!oneTapKind(op?.kind)||op.status!=='RUNNING')fail('MINI_OPERATION_CHANGED');
      Object.assign(op,patch,{phase,phase_updated_at:iso()});return structuredClone(op);});
  }
  async runFirstAnimation(p,id){
    const command=authenticateMiniAppCommand({principal:p,operationId:id});
    // Renew only completed, unambiguous, expired quote versions. Bounded to
    // avoid a slow estimator causing an unbounded request loop.
    for(let renewal=0;renewal<3;renewal++){
      const ctx=await this.context(p),op=ctx.state.mini_app.operations[id];assertOneTapConsent(op,this.env,ctx.checkpoint,null,false,ctx.state);
      await this.oneTapPhase(p,id,'QUOTING');
      const q=await this.adapter.prepareEp004VideoQuote({user:p.user,chat:p.chat,renew:true,expectedQuoteId:ctx.quote?.quote_id??null,miniAppPrincipal:p});
      const fresh=await this.context(p);
      if(q.status==='QUOTE_EXPIRED')continue;
      if(!['AWAITING_HUMAN_AUTHORIZATION','HUMAN_SPEND_AUTHORIZED'].includes(q.status))fail('Q41_ONE_TAP_QUOTE_UNCONFIRMED');
      assertOneTapConsent(op,this.env,fresh.checkpoint,q,false,fresh.state);
      if(Date.parse(q.expires_at)<=Date.now())continue;
      const current=await this.oneTapPhase(p,id,'BUDGET_CHECK',{binding:{...op.binding,action:'q41_video_authorize',quote_id:q.quote_id,quote_sha:q.quote_sha},
        quote_binding:{quote_id:q.quote_id,quote_sha:q.quote_sha,quote_usd:q.quote_usd,quote_timestamp:q.quote_timestamp,quote_expiration:q.expires_at,payload_sha256:q.payload_sha256,operation_id:id}});
      // Same canonical authorization and Budget Gate as the supervised flow.
      try{await this.adapter.authorizeEp004VideoQuote({command});}
      catch(e){if(e.message==='Q41_VIDEO_CURRENT_QUOTE_REQUIRED'&&Date.parse(q.expires_at)<=Date.now())continue;throw e;}
      if(Date.parse(q.expires_at)<=Date.now())continue;
      await this.oneTapPhase(p,id,'DISPATCHING',{binding:{...current.binding,action:'q41_video_generate'}});
      let result;
      try{result=await this.adapter.executeQuotedStage({command});}
      catch(e){
        const current=await this.context(p),a=current.checkpoint.actions.find(a=>a.key===op.binding.next_action);
        if(Date.parse(q.expires_at)<=Date.now()&&!current.state.production_commands?.['dispatch:'+q.quote_id]
          &&!(op.kind==='second_image'?current.current_emission:current.q41_emission)&&a?.dispatch_state==='NOT_DISPATCHED'&&!current.checkpoint.metadata.budget_reservations?.[op.binding.next_action])continue;
        throw e;
      }
      if(!['IN_PROGRESS','WAITING_EXISTING_RESULT'].includes(result?.status))fail('Q41_ONE_TAP_DISPATCH_REQUIRES_RECOVERY');
      await this.oneTapPhase(p,id,'GENERATING',{binding:{...current.binding,action:'q41_stage_recover'}});
      this.scheduleRecovery(p,id);return;
    }
    fail('Q41_ONE_TAP_QUOTE_EXPIRED_NO_EMISSION');
  }
  scheduleRecovery(p,id){
    const key=p.user+':'+id;if(this.recoveryTimers.has(key)||p.expires_at<=Date.now())return;
    const timer=setTimeout(()=>{this.recoveryTimers.delete(key);this.recoverFirstAnimation(p,id).catch(()=>{});},15000);
    timer.unref?.();this.recoveryTimers.set(key,timer);
  }
  async recoverFirstAnimation(p,id){
    const key=p.user+':'+id;if(this.inflight.has(key))return;
    const work=(async()=>{
      const ctx=await this.context(p),stored=ctx.state.mini_app?.operations?.[id];
      if(!oneTapKind(stored?.kind))return;
      const op=this.projectOneTapOperation(p,ctx,stored);
      if(op.phase!=='GENERATING'||op.status!=='RUNNING')return;
      assertOriginalRecoveryConsent(op,this.env,ctx.checkpoint,ctx.state);
      const claimed=await mutateMiniState(this.store,p.user,m=>{const o=m.operations[id];if(o.recovery_lease_until>Date.now())return false;
        Object.assign(o,{status:'RUNNING',phase:'GENERATING',binding:op.binding,recovery_lease_until:Date.now()+120000,session_id:p.session});return true;});if(!claimed)return;
      try{
        const result=await this.adapter.recoverQuotedStage({command:authenticateMiniAppCommand({principal:p,operationId:id})});
        const fresh=await this.context(p),generation=op.kind==='second_image'?currentActionState(fresh):this.generation(fresh);
        if(['AWAITING_HUMAN_REVIEW','SUCCEEDED'].includes(generation.status))await this.oneTapPhase(p,id,'REVIEW_READY',{status:'COMPLETE',finished_at:iso(),result_status:result.status});
        else this.scheduleRecovery(p,id); // A non-wait response alone is not proof of a saved clip.
      }catch(e){
        // Recovery never calls submit. Keep the original job available after a
        // transient poll/download error; no new quote or generation is admitted.
        await mutateMiniState(this.store,p.user,m=>{m.operations[id].recovery_error='EXISTING_JOB_RECOVERY_PENDING';});
        this.scheduleRecovery(p,id);
      }finally{await mutateMiniState(this.store,p.user,m=>{m.operations[id].recovery_lease_until=0;});}
    })();this.inflight.set(key,work);try{await work;}finally{this.inflight.delete(key);}
  }
  async media(p,id,expires,ticket){
    const n=Number(expires),expected=this.mediaTicket(p,id,n);
    if(!Number.isSafeInteger(n)||n<=Date.now()||n>p.expires_at||!/^\d+$/.test(String(expires))||!/^\w{64}$/.test(ticket||'')
      ||!timingSafeEqual(Buffer.from(expected),Buffer.from(ticket)))fail('MINI_MEDIA_EXPIRED',403);
    const item=this.catalog(await this.context(p)).get(id);if(!item)fail('MINI_MEDIA_NOT_FOUND',404);
    let cached=this.mediaCache.get(id);
    if(!cached||cached.expires<Date.now()){
      const bytes=await this.loadBytes(item.a);
      if(bytes.length!==item.a.size||hash(bytes)!==item.a.sha256)fail('MINI_ARTIFACT_INTEGRITY',409);
      cached={bytes,expires:Date.now()+300000};
      // Bounded original-byte cache; no public derivative or public storage object.
      if([...this.mediaCache.values()].reduce((n,x)=>n+x.bytes.length,0)+bytes.length>64000000)this.mediaCache.clear();
      if(bytes.length<=40000000)this.mediaCache.set(id,cached);
    }
    return {...item,bytes:cached.bytes};
  }
}

export function mountMiniApp(app,{db,store,adapter,production,loadBytes,validateOwner,env=process.env,fetchImpl=fetch,configureEntry=true,configureLibrary=configureEntry}){
  if(!miniAppEnabled(env)||!db||!adapter)return null;
  const auth=new MiniAppAuth({store,validateOwner,env}),service=new MiniAppService({store,adapter,production,loadBytes,env});
  const api=MINI_PATH+'/api';
  const wrap=fn=>async(req,res)=>{try{await fn(req,res);}catch(e){res.status(e.status||409).json({error:/^[A-Z0-9_]{1,100}$/.test(e.message)?e.message:'MINI_ACTION_UNAVAILABLE'});}};
  const principal=req=>auth.authenticate(sessionCookie(req),req.method==='POST'?String(req.headers['x-lumi-csrf']||''):null);
  app.use(MINI_PATH,(req,res,next)=>{
    res.set({'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff',
      'Content-Security-Policy':"default-src 'self'; script-src 'self' https://telegram.org; style-src 'self'; img-src 'self' data:; media-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors https://web.telegram.org https://*.telegram.org"});
    if(req.method==='POST'&&(req.headers.origin!==MINI_ORIGIN||!String(req.headers['content-type']||'').startsWith('application/json')))return res.status(403).json({error:'MINI_ORIGIN_REQUIRED'});
    next();
  });
  for(const [suffix,file,type] of [['','index.html','text/html'],['/','index.html','text/html'],['/app.js','app.js','text/javascript'],['/style.css','style.css','text/css']])
    app.get(MINI_PATH+suffix,wrap(async(_req,res)=>res.type(type).send(await readFile(new URL('../../public/lumi-studio/'+file,import.meta.url)))));
  app.get(api+'/readiness',(_req,res)=>res.json({version:1,progress_mode:'READ_ONLY_DURABLE_PROJECTION',staging_sha:env.RENDER_GIT_COMMIT??null,auth_configured:miniAuthConfigured(env),auth_method:env.LUMI_TELEGRAM_BOT_TOKEN?'TELEGRAM_HMAC':'TELEGRAM_ED25519',menu_verified_at:envMenuVerified(env)?env.LUMI_MINI_APP_MENU_VERIFIED_AT:null,url:MINI_ORIGIN+MINI_PATH}));
  app.post(api+'/auth',wrap(async(req,res)=>{
    if(Object.keys(req.body||{}).some(k=>k!=='initData'))fail('MINI_BODY_INVALID',400);
    const s=await auth.login(req.body?.initData);
    res.set('Set-Cookie',`${MINI_COOKIE}=${s.cookie}; Path=${MINI_PATH}; Max-Age=1800; Secure; HttpOnly; SameSite=None; Partitioned`);
    res.json({csrf:s.csrf,expires_at:s.expires_at});
  }));
  app.get(api+'/session',wrap(async(req,res)=>{const p=await principal(req);res.json({csrf:auth.csrf(sessionCookie(req)),expires_at:p.expires_at});}));
  app.get(api+'/state',wrap(async(req,res)=>res.json(await service.view(await principal(req)))));
  app.post(api+'/actions/:kind',wrap(async(req,res)=>{
    const p=await principal(req),r=await service.enqueue(p,req.params.kind,req.body||{});
    res.status(202).json({operation:r.operation});
    setImmediate(()=>r.dispatch().catch(()=>console.error(JSON.stringify({event:'lumi_mini_operation_persistence_failed'}))));
  }));
  app.get(api+'/media/:id',wrap(async(req,res)=>{
    const p=await principal(req),{a,bytes}=await service.media(p,req.params.id,req.query.expires,req.query.ticket);
    res.type(a.mime).set('Accept-Ranges','bytes');
    if(req.query.download==='1')res.set('Content-Disposition',`attachment; filename="Lumi-${a.sha256.slice(0,12)}.${a.mime==='video/mp4'?'mp4':a.mime==='image/png'?'png':a.mime==='audio/mpeg'?'mp3':'jpg'}"`);
    if(req.headers.range){const m=/^bytes=(\d+)-(\d*)$/.exec(req.headers.range);if(!m)return res.status(416).end();
      const start=Number(m[1]),end=m[2]?Number(m[2]):bytes.length-1;if(start>end||end>=bytes.length)return res.status(416).set('Content-Range','bytes */'+bytes.length).end();
      return res.status(206).set('Content-Range',`bytes ${start}-${end}/${bytes.length}`).send(bytes.subarray(start,end+1));}
    res.send(bytes);
  }));
  const assetLibrary=mountLibrary(app,{api,principal,wrap,db,loadBytes,env,bootstrap:configureLibrary});
  const configure=async()=>{
    if(!env.LUMI_TELEGRAM_BOT_TOKEN)return;
    const {data,error}=await db.from('cf_bot_admins').select('user_id,chat_id').eq('active',true);if(error)throw Error('MINI_ENTRY_OWNER_UNAVAILABLE');
    const call=async(method,body)=>{const r=await fetchImpl(`https://api.telegram.org/bot${env.LUMI_TELEGRAM_BOT_TOKEN}/${method}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
      const v=await r.json();if(!r.ok||!v.ok)throw Error('MINI_ENTRY_TELEGRAM_REJECTED');return v.result;};
    for(const owner of data||[]){
      const user=String(owner.user_id),chat=String(owner.chat_id),row=await store.get(user);
      if(user!==chat||row?.state.chat_id!==chat)continue;
      const wanted={type:'web_app',text:'Abrir Lumi Studio',web_app:{url:MINI_ORIGIN+MINI_PATH}};
      let menu=await call('getChatMenuButton',{chat_id:chat});
      if(menu?.type!==wanted.type||menu?.text!==wanted.text||menu?.web_app?.url!==wanted.web_app.url){await call('setChatMenuButton',{chat_id:chat,menu_button:wanted});menu=await call('getChatMenuButton',{chat_id:chat});}
      if(menu?.web_app?.url!==wanted.web_app.url)throw Error('MINI_ENTRY_VERIFY_FAILED');
      await mutateMiniState(store,user,m=>{m.entrypoint={status:'CONFIGURED',checked_at:iso(),url:wanted.web_app.url};});
      console.log(JSON.stringify({event:'lumi_mini_entrypoint_configured',provider_generation_calls:0}));
    }
  };
  if(configureEntry)configure().catch(()=>console.error(JSON.stringify({event:'lumi_mini_entrypoint_configuration_required'})));
  return {auth,service,configure,assetLibrary};
}
