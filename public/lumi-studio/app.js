let publicationUI=null,publicationLoading=false,preparationUI=null,preparationLoading=false;
const api='/lumi/studio/api';let tg=window.Telegram?.WebApp;
const launchInitData=typeof URLSearchParams==='undefined'?null:new URLSearchParams(window.location?.hash?.slice(1)||'').get('tgWebAppData');
let loadingMessage='Verificando tu acceso…',startupFailed=false;
const root=document.querySelector('#app'),nav=document.querySelector('#navigation'),dialog=document.querySelector('#confirmation');
let state=null,csrf=null,tab=window.location?.hash==='#biblioteca'?'biblioteca':'inicio',sending=false,polling=false,serverOffset=0,timer=null,pendingSpend=null,scrollPending=false,mutationEpoch=0,progressMessage='',progressRequested=false,loggingIn=false,planReviewLoading=false,policyReviewLoading=false,controlMessage='',workflowTab=null;
const tabPositions=new Map(),workflowSelections=new Map(),publicationEdits=new Map();
const reducedMotion=()=>!!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
function resetNavigation(){tabPositions.clear();workflowSelections.clear();}
function navigate(next){
 if(!Object.hasOwn(paths,next)||next===tab)return;
 const began=tick();tabPositions.set(tab,window.scrollY||0);workflowSelections.set(tab,workflowTab);
 tab=next;workflowTab=workflowSelections.get(next)||null;render();
 window.scrollTo({top:tabPositions.get(next)||0,behavior:'instant'});root.focus?.({preventScroll:true});
 if(!reducedMotion())root.animate?.([{opacity:.65},{opacity:1}],{duration:140,easing:'ease-out'});
 metric('navigation',tick()-began);if(['biblioteca','videos'].includes(tab))loadLibrary({reuse:true});
 try{tg?.HapticFeedback?.selectionChanged();}catch{}
}
const intentKey='lumi:first-animation:ep004:q41';
let generationIntent=false;
try{generationIntent=localStorage.getItem(intentKey)==='pending';}catch{/* Server lock remains authoritative. */}
function rememberGenerationIntent(){generationIntent=true;try{localStorage.setItem(intentKey,'pending');}catch{/* Never release the in-memory lock on a storage error. */}}
const generationLocked=()=>state?.first_animation?.episode_id===state?.episode.id&&(generationIntent||state?.first_animation?.locked===true);
const actionIntentKey='lumi:pending-action:v2';
let actionIntent=null;
try{actionIntent=JSON.parse(localStorage.getItem(actionIntentKey)||'null');}catch{/* Durable server state remains authoritative. */}
function saveActionIntent(value){actionIntent=value;try{localStorage.setItem(actionIntentKey,JSON.stringify(value));}catch{/* Keep the in-memory intent. */}}
function unresolvedIntent(){
 if(currentIntent())return true;
 if(actionIntent?.kind==='produce_episode'&&actionIntent.episode===state?.episode.id)return !state.episode_job;
 if(actionIntent?.kind==='replacement_generate'&&actionIntent.episode===state?.episode.id){
   const r=state.supervised_replacement;
   return !!r&&r.authorization_reference===actionIntent.authorization_reference&&r.confirmation_id!==actionIntent.confirmation_id&&r.operation_status==='NOT_CREATED';
 }
 if(!actionIntent||actionIntent.episode!==state?.episode.id||actionIntent.action!==state?.episode.next_action||state.current_action?.emission_locked)return false;
 return !state.current_action?.operations?.some(o=>o.kind===actionIntent.kind&&(actionIntent.kind==='second_image'||o.quote_id===actionIntent.quote_id));
}
// Local intent is a presentation lock, never an authorization. Only durable
// receipts (or an explicit pre-claim rejection) settle it, across sessions/tabs.
const uiIntentStorage='lumi:ui-intents:v1';
let uiIntents={};try{uiIntents=JSON.parse(localStorage.getItem(uiIntentStorage)||'{}')||{};}catch{}
const uiMetrics=[];
function metric(phase,ms,extra={}){uiMetrics.push({phase,ms:Math.round(ms*10)/10,...extra});if(uiMetrics.length>120)uiMetrics.shift();}
const tick=()=>globalThis.performance?.now?.()??Date.now();
function writeIntents(){for(const [k,i] of Object.entries(uiIntents))if(['DONE','REJECTED_NO_EFFECT'].includes(i.phase)&&Date.now()-i.created>604800000)delete uiIntents[k];try{localStorage.setItem(uiIntentStorage,JSON.stringify(uiIntents));}catch{}}
function intentIdentity(kind,extra={}){return JSON.stringify([state?.client_scope||'memory',state?.episode.id,kind,extra.request_id??state?.episode.next_action,extra.review_version??null,extra.artifact_sha??null]);}
function matchingIntent(kind,extra={}){return uiIntents[intentIdentity(kind,extra)];}
function beginIntent(kind,extra={}){
 const key=intentIdentity(kind,extra),old=uiIntents[key];if(old&&!['REJECTED_NO_EFFECT'].includes(old.phase))return null;
 const i={key,owner:state?.client_scope,session:state?.client_session,episode:state.episode.id,stage:state.episode.next_action,kind,
  request_id:extra.request_id,review_version:extra.review_version,artifact_sha:extra.artifact_sha,decision:extra.decision,
  baseline_review:Number(state.review_revision||0),baseline_checkpoint:Number(state.episode.checkpoint_version||0),phase:'SENDING',created:Date.now()};
 uiIntents[key]=i;if(i.owner)writeIntents();return i;
}
function changeIntent(i,phase,extra={}){if(!i)return;Object.assign(i,{phase,...extra});if(i.owner)writeIntents();}
const pendingIntent=i=>i&&!['DONE','REJECTED_NO_EFFECT'].includes(i.phase);
const configurationIntent=i=>i?.kind==='draft_policy_accept'||i?.kind==='job_pause'||i?.kind==='job_continue';
const controlPending=kind=>Object.values(uiIntents).find(i=>i.owner===state?.client_scope&&i.episode===state?.episode.id&&pendingIntent(i)&&(kind==='job'?i.kind==='job_pause'||i.kind==='job_continue':i.kind===kind));
function currentIntent(){return Object.values(uiIntents).find(i=>i.owner===state?.client_scope&&i.episode===state?.episode.id&&pendingIntent(i)&&!i.kind.startsWith('library_')&&i.kind!=='select_episode'&&!(i.kind==='first_animation'&&['AWAITING_HUMAN_REVIEW','SUCCEEDED'].includes(state?.first_animation?.status))&&
 (configurationIntent(i)||(i.kind==='review'?[...(state?.reviews||[]),...(state?.optional_reviews||[])].some(r=>r.id===i.request_id&&r.version===i.review_version&&r.artifact_sha===i.artifact_sha):i.stage===state?.episode.next_action)));}
function reconcileIntents(next){
 for(const i of Object.values(uiIntents)){
  if(i.owner===next.client_scope&&i.kind==='select_episode'&&i.request_id===next.episode.id){changeIntent(i,'DONE');continue;}
  if(i.owner!==next.client_scope||i.episode!==next.episode.id||!pendingIntent(i)||Number(next.review_revision||0)<i.baseline_review||Number(next.episode.checkpoint_version||0)<i.baseline_checkpoint)continue;
  const review=next.review_receipts?.find(r=>r.id===i.request_id&&r.version===i.review_version&&r.artifact_sha===i.artifact_sha);
  const op=next.action_receipts?.find(o=>i.operation_id?o.id===i.operation_id:o.kind===i.kind&&o.binding?.next_action===i.stage&&(i.kind!=='review'||o.binding.request_id===i.request_id&&o.binding.review_version===i.review_version&&o.binding.artifact_sha===i.artifact_sha));
  if(review){changeIntent(i,'DONE',{result:review.status});continue;}
  if(i.kind==='review'){if(op&&op.kind==='review'&&op.binding.request_id===i.request_id&&op.binding.review_version===i.review_version&&op.binding.artifact_sha===i.artifact_sha)changeIntent(i,op.status==='BLOCKED'?'ATTENTION':'ACKNOWLEDGED',{operation_id:op.id});continue;}
  if(i.kind==='produce_episode'&&next.episode_job){changeIntent(i,'DONE',{result:'EPISODE_STARTED'});continue;}
  if(i.kind.startsWith('replacement_')){const r=next.supervised_replacement;if(r&&(i.kind==='replacement_accept'&&r.authorization_status==='HUMAN_RISK_ACCEPTANCE'||i.kind==='replacement_quote'&&r.confirmation_id===i.confirmation_id||i.kind==='replacement_generate'&&r.operation_status!=='NOT_CREATED'||i.kind==='replacement_recover'&&r.operation_status==='COMPLETE'))changeIntent(i,'DONE');continue;}
  if(i.kind==='draft_policy_accept'){if(next.review_policy?.id===i.authorization_id||!i.authorization_id&&next.review_policy?.mode==='DRAFT_FINAL_REVIEW_V1')changeIntent(i,'DONE',{result:'DRAFT_POLICY_REGISTERED'});continue;}
  if(i.kind==='job_pause'||i.kind==='job_continue'){if(next.episode_job?.id===i.job_id&&(i.kind==='job_pause'?next.episode_job.status==='PAUSED':next.episode_job.status!=='PAUSED'))changeIntent(i,'DONE',{result:'CONTROL_REGISTERED'});continue;}
  if(i.kind==='plan_accept'&&next.episode_plan_authorization?.status==='AUTHORIZED'){changeIntent(i,'DONE',{result:'PLAN_AUTHORIZED'});continue;}
  if(next.episode.next_action!==i.stage&&Number(next.episode.checkpoint_version)>i.baseline_checkpoint){changeIntent(i,'DONE');continue;}
  if(op)changeIntent(i,op.status==='BLOCKED'?'ATTENTION':op.status==='COMPLETE'&&!['GENERATING','DISPATCHING'].includes(op.phase)?'DONE':'ACKNOWLEDGED',{operation_id:op.id});
 }
}
function intentText(i){return i?.phase==='DONE'?(i.result==='APPROVED'?'Aprobada':i.result==='REJECTED'?'Corrección registrada':'Acción guardada'):
 i?.phase==='SENDING'?(i.kind==='review'?'Enviando '+(i.decision==='REJECTED'?'corrección':'aprobación')+'…':i.kind==='produce_episode'?'Iniciando episodio…':'Solicitud enviada; esperando confirmación…'):
 i?.phase==='ACKNOWLEDGED'?'Solicitud guardada; preparando el resultado…':i?.phase==='ATTENTION'?'La acción guardada necesita atención. Consultando su estado…':'Comprobando si se guardó; no hace falta repetir.';}
function intentBanner(){const i=currentIntent();return i?`<div class="async-banner" data-ui-key="pending-intent" role="status">${esc(intentText(i))}</div>`:'';}
function patchMarkup(target,html){
 // The no-DOM branch is only used by the pre-existing VM unit harness.
 if(!document.createElement){target.innerHTML=html;return;}
 const template=document.createElement('template');template.innerHTML=html;
 const key=n=>n.nodeType===1?(n.getAttribute('data-ui-key')||n.id||(n.hasAttribute('data-media-host')?'media:'+n.dataset.mediaHost:n.hasAttribute('data-library-preview')?'library:'+n.dataset.libraryPreview+':'+n.dataset.variant:n.hasAttribute('data-action')?'action:'+n.dataset.action:n.hasAttribute('data-review')?'review-button:'+n.dataset.review+':'+n.dataset.decision:null)):null;
 const patch=(old,fresh)=>{
  if(old.nodeType!==fresh.nodeType||old.nodeName!==fresh.nodeName){old.replaceWith(fresh.cloneNode(true));return;}
  if(old.nodeType===3){if(old.data!==fresh.data)old.data=fresh.data;return;}
  if(old.nodeType!==1)return;
  for(const a of [...old.attributes])if(!fresh.hasAttribute(a.name)&&!['style','open','value','checked','selected','data-preview-bound','data-preview-state','data-observed','data-loaded','data-load-error'].includes(a.name))old.removeAttribute(a.name);
  for(const a of [...fresh.attributes]){
   if(['data-preview-state','data-preview-bound','data-observed'].includes(a.name)&&old.hasAttribute(a.name))continue;
   if(['value','checked','selected'].includes(a.name)&&/INPUT|SELECT|OPTION/.test(old.tagName))continue;
   if(a.name==='src'&&/VIDEO|AUDIO/.test(old.tagName)&&old.getAttribute('src'))continue;
   if(old.getAttribute(a.name)!==a.value)old.setAttribute(a.name,a.value);
  }
  if(old.hasAttribute('data-media-host')||old.hasAttribute('data-library-preview'))return;
  children(old,fresh);
 };
 const children=(old,fresh)=>{
  let cursor=old.firstChild;const keyed=new Map([...old.childNodes].filter(key).map(n=>[key(n),n]));
  for(const f of [...fresh.childNodes]){
   const k=key(f);let n=k?keyed.get(k):cursor;
   if(!k){while(n&&(key(n)||n.nodeName!==f.nodeName))n=n.nextSibling;}
   if(!n){n=f.cloneNode(true);old.insertBefore(n,cursor);}else{if(n!==cursor)old.insertBefore(n,cursor);patch(n,f);}
   cursor=n.nextSibling;
  }
  while(cursor){const next=cursor.nextSibling;cursor.remove();cursor=next;}
 };
 children(target,template.content);
}
const actionStatusText={QUOTE_PENDING:'Consultando precio…',AUTHORIZATION_PENDING:'Guardando tu autorización…',AUTHORIZED:'Autorización registrada.',
 PREPARING:'Preparando imagen…',RESERVED:'Preparando imagen…',EMITTING:'Solicitud enviada; esperando confirmación…',SUBMITTED:'Generando imagen…',PROCESSING:'Generando imagen…',
 BLOCKED:'La operación está bloqueada; falta revisar su evidencia.',FAILED_CONFIRMED:'La generación fue rechazada. Requiere recuperación y una nueva autorización.',AMBIGUOUS:'Estamos verificando tu solicitud anterior.',SUCCEEDED:'Imagen guardada.',AWAITING_HUMAN_REVIEW:'Imagen lista para revisar.'};
const paths={inicio:'M3 10 12 3l9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1Z',videos:'M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Zm4 4 7 4-7 4Z',produccion:'m12 3 2.4 5.5L20 11l-5.6 2.5L12 19l-2.4-5.5L4 11l5.6-2.5ZM20 3v4m-2-2h4',biblioteca:'M4 3h6v18H4zM13 3h7v18h-7zM6 7h2m7 0h3',ajustes:'M5 4v16M12 4v16M19 4v16M2 9h6m1 6h6m1-7h6'};
const icon=name=>`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${paths[name]||paths.produccion}"/></svg>`;
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const usd=n=>n===null||n===undefined?'Sin verificar':'USD '+Number(n).toLocaleString('es-AR',{minimumFractionDigits:2,maximumFractionDigits:6});
const busy=()=>sending||!!currentIntent()||state?.operation&&['QUEUED','RUNNING','WAITING','RECOVERY_REQUIRED'].includes(state.operation.status);
const configurationBlocked=action=>!state||!csrf||(action==='draft_policy_review'
 ?!state.review_policy?.choice_available||policyReviewLoading||!!controlPending('draft_policy_accept')
 :!state.episode_job||state.episode_job.status==='COMPLETE'||!!controlPending('job'));
const button=(text,action,style='primary',disabled=false)=>{const configuration=['draft_policy_review','job_pause','job_continue'].includes(action);
 const blocked=action!=='refresh'&&(disabled||(configuration?configurationBlocked(action):sending||busy()&&!['recover','replacement_recover'].includes(action)));
 return `<button class="button ${style}" data-action="${action}" ${blocked?'disabled':''}>${text}</button>`;};
const progressControl=()=>`<button type="button" class="button secondary progress-readonly" data-action="refresh">Actualizar progreso ↻</button><p class="budget-note" role="status" aria-live="polite" data-progress-status>${esc(progressMessage||'Consulta segura del estado guardado.')}</p>`;
function progressFeedback(message){progressMessage=message;for(const n of document.querySelectorAll('[data-progress-status]'))n.textContent=message;}
const source=()=>state?.media.find(m=>m.episode===state.episode.id&&m.role==='source');
const frame=(m,{review=false,priority=false}={})=>m?m.mime.startsWith('image/')?studioImage(m,review?'preview':'thumb',review||priority)+(review?`<a class="text-link" href="${esc(m.url)}" target="_blank" rel="noopener noreferrer">Abrir original para ampliar</a><p class="budget-note">Preview de revisión. El original está disponible para comprobar detalles.</p>`:''):`<div class="media-frame" data-ui-key="native:${esc(m.id)}">${m.mime==='video/mp4'?`<video data-native-media="${esc(m.id)}" controls playsinline preload="metadata" src="${esc(m.url)}" aria-label="${esc(m.label)}"></video>`:`<audio controls data-native-media="${esc(m.id)}" preload="metadata" src="${esc(m.url)}" aria-label="${esc(m.label)}"></audio>`}</div>`:'';
const row=(a,b)=>`<div class="row"><span>${a}</span><strong>${b}</strong></div>`;
function toast(text){const n=document.querySelector('#notice');n.textContent=text;n.hidden=false;clearTimeout(timer);timer=setTimeout(()=>n.hidden=true,5500);}
async function request(path,{method='GET',body}={}){
  const began=tick(),controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),20000);
  try{const r=await fetch(api+path,{method,credentials:'same-origin',headers:{'content-type':'application/json',...(method==='POST'&&csrf?{'x-lumi-csrf':csrf}:{})},body:body===undefined?undefined:JSON.stringify(body),signal:controller.signal});
    const v=await r.json();if(!r.ok)throw Object.assign(Error(v.error||'UNAVAILABLE'),{status:r.status,no_effect:v.no_effect===true});return v;
  }finally{clearTimeout(timeout);if(path==='/state')metric('state_latency',tick()-began);}
}
function errorText(e){
  const explanation=preparationUI?.errorText(e.message);if(explanation)return explanation;
  if(e.message==='HIGGSFIELD_BILLING_CHECK_REQUIRED')return 'Higgsfield rechazó la solicitud. Revisá el saldo API y el acceso de tu cuenta; todavía no hay una causa de saldo confirmada.';
  if(['HIGGSFIELD_INSUFFICIENT_BALANCE','HIGGSFIELD_RECHARGE_REQUIRED'].includes(e.message))return 'Hace falta recargar el saldo API de Higgsfield para generar imágenes o animaciones. Tu progreso está guardado.';
  if(e.message==='FUNDING_NOTICE_CHANGED')return 'El aviso de saldo cambió. Actualizá el estado antes de registrar la recarga.';
  if(e.message==='PROVIDER_RESULT_FAILED')return 'Higgsfield informó que la generación falló. El pedido original queda conservado para revisar lo ocurrido.';
  if(e.message==='PROVIDER_RESULT_MODERATED')return 'Higgsfield rechazó el contenido en su revisión de moderación. Hace falta revisar el pedido antes de continuar.';
  if(e.message==='PROVIDER_RESULT_CANCELED')return 'Higgsfield informó que el pedido fue cancelado. El episodio queda detenido en esta toma.';
  if(e.message==='PROVIDER_RESULT_STATUS_UNKNOWN')return 'El proveedor devolvió un estado que Lumi no reconoce. Hace falta comprobar el pedido original.';
  if(/SESSION|INIT_DATA|SIGNATURE|OWNER/.test(e.message))return 'Abrí Lumi Studio desde el botón del bot de Telegram para verificar tu acceso. Código: '+e.message;
  if(e.message==='EPISODE_PLAN_APPROVAL_REQUIRED')return 'Falta una autorización vigente del plan. Revisá el plan en Studio; no se renovó ni amplió ningún permiso.';
  if(/^DRAFT_POLICY_/.test(e.message))return (e.message==='DRAFT_POLICY_REVIEW_EXPIRED'?'La confirmación venció. Abrí de nuevo la decisión para revisar sus condiciones.':'Las condiciones del modo cambiaron. Actualizá el estado y revisá la decisión.')+' Código: '+e.message;
  if(/^(EPISODE_|SAVED_RESULT_|RECOVERY_|BUDGET_|REPLACEMENT_|HIGGSFIELD_|Q41_CURRENT_EXACT|Q41_REQUEST_RESERVATION)/.test(e.message)){
    const code=/^[A-Z0-9_]{1,100}$/.test(e.message)?e.message:'REPLACEMENT_CONFIRMATION_FAILED';
    const detail=/FULL_EPISODE_PLAN_REQUIRED/.test(code)?'Falta completar el presupuesto del episodio antes de iniciar una producción nueva. Revisá imágenes, clips, voz y costos de infraestructura.':/CONSENT_EXPIRED/.test(code)?'La aceptación guardada venció en su fecha explícita. Podés revisar una nueva decisión.':/APPROVED_CONTENT_CHANGED/.test(code)?'Cambió el contenido autorizado. Revisá el nuevo contenido antes de decidir.':/LIMIT|BUDGET/.test(code)?'La cotización supera el límite autorizado o el presupuesto disponible. No se amplió tu autorización.':/ALREADY|CLAIM|RECOVERY/.test(code)?'Ya hay una confirmación o solicitud guardada. Consultá su estado; no se repetirá la generación.':'La confirmación se detuvo. Consultá el estado guardado antes de continuar.';
    return detail+' Código: '+code;
  }
  if(/LIBRARY|STALE_CHECKPOINT/.test(e.message))return /CONFLICT|STALE|ALREADY_BOUND/.test(e.message)?'El destino cambió o tiene una operación pendiente. No se reemplazó ningún medio. Actualizá el plan.':/EXPIRED|SESSION/.test(e.message)?'El acceso al original venció. Volvé a abrir Lumi Studio.':'No se pudo verificar la compatibilidad o el archivo original. El progreso se conserva.';
  if(e.name==='AbortError')return 'La conexión está tardando. Consultaremos el estado guardado antes de repetir cualquier acción.';
  if(/EXPIRED|CURRENT_QUOTE|QUOTE_CHANGED|STAGE_CHANGED/.test(e.message))return 'La etapa o el precio cambió. Lumi comprobará el precio vigente antes de pedirte una nueva autorización.';
  if(/SESSION|INIT_DATA|SIGNATURE|OWNER/.test(e.message))return 'Abrí Lumi Studio desde el botón del bot de Telegram para verificar tu acceso.';
  if(/REVIEW/.test(e.message))return 'Esta revisión cambió. Actualizá el estado antes de decidir.';
  return 'No pudimos completar la acción. El progreso está guardado. Actualizá el estado para continuar.';
}
function navigation(){patchMarkup(nav,Object.keys(paths).map(k=>`<button data-tab="${k}" class="${tab===k?'active':''}" ${tab===k?'aria-current="page"':''}>${icon(k)}<span>${({inicio:'Inicio',videos:'Videos',produccion:'Producción',biblioteca:'Biblioteca',ajustes:'Ajustes'})[k]}</span></button>`).join(''));}
let fundingBusy=false;
function fundingNotice(){
 const f=state?.funding;if(!f||f.status==='UNKNOWN')return '';
 if(f.status==='RECHARGE_REPORTED')return '<section class="alert" data-ui-key="funding-notice" role="status"><strong>Recarga informada</strong><p>El saldo todavía no fue verificado. La solicitud fallida requiere recuperación; no se repite automáticamente.</p></section>';
 return `<section class="card funding-notice" data-ui-key="funding-notice" role="alert"><span class="tag gold">${f.status==='CHECK_BILLING'?'REVISAR CUENTA':'RECARGA NECESARIA'}</span><h2>${f.status==='CHECK_BILLING'?'Revisá tu cuenta de Higgsfield':'Falta saldo en Higgsfield'}</h2><p>${f.source==='PROVIDER_ERROR'?'Higgsfield respondió que no hay saldo suficiente.':f.source==='PROVIDER_BILLING_RESPONSE'?'Higgsfield rechazó el acceso o la facturación. Revisá el saldo API y las credenciales de la cuenta.':'Nos informaste que se agotó el saldo.'} Las imágenes y animaciones nuevas quedan en pausa. Tu progreso sigue guardado.</p><a class="button primary" href="https://open.higgsfield.ai/" target="_blank" rel="noopener noreferrer">Recargar saldo API ↗</a><button class="button secondary" data-funding-recharged ${fundingBusy?'disabled':''}>${fundingBusy?'Registrando…':'Ya recargué'}</button><small>Entrá en Billing. El saldo API es independiente de los créditos de la web. Registrar la recarga no repite una generación.</small></section>`;
}
document.addEventListener('click',async e=>{
 if(!e.target.closest('[data-funding-recharged]')||fundingBusy||!state?.funding?.notice_id)return;
 const notice=state.funding.notice_id;fundingBusy=true;mutationEpoch++;render();
 try{await request('/funding/recharged',{method:'POST',body:{notice_id:notice}});await refresh();toast('Recarga informada. Conservamos la operación original.');}
 catch(error){toast(errorText(error));}finally{fundingBusy=false;render();}
});
function banner(){const op=state.operation;if(!op||op.status==='COMPLETE')return '';
  if(op.kind==='production_stage')return `<div class="async-banner" role="status"><strong>${op.status==='BLOCKED'?'Necesita atención':op.phase==='GENERATING'?'Esperando proveedor':op.phase==='REVIEW_READY'?'Listo para revisar':op.phase==='DISPATCHING'?'Solicitud enviada':'Preparando'}</strong><p>Conservamos la misma operación al cerrar Telegram.</p></div>`;
  if(op.kind==='first_animation'||op.kind==='second_image'){
    if(op.kind==='second_image')return ''; // Its durable phase is shown once, beneath scene progress.
    const text=({VERIFYING_SOURCE:'Preparando animación…',QUOTING:'Consultando precio…',BUDGET_CHECK:'Verificando presupuesto…',DISPATCHING:'Enviando a Kling…',GENERATING:'Generando video…',REVIEW_READY:'Video preparado para tu revisión'})[op.phase]||'Consultando el estado guardado…';
    if(op.status==='BLOCKED'||op.status==='RECOVERY_REQUIRED')return '<div class="alert">La animación está detenida de forma segura. No se repetirá la solicitud. '+(/LIMIT|BUDGET/.test(op.error||'')?'El precio o presupuesto requiere una nueva autorización.':'Hay que revisar el resultado de la operación guardada antes de continuar.')+'</div>';
    return `<div class="async-banner" role="status"><div><strong>${text}</strong><p>Podés cerrar y reabrir el estudio. Conservamos esta misma operación.</p></div></div>`;
  }
  if(['QUEUED','RUNNING'].includes(op.status))return `<div class="async-banner" role="status"><div class="loading-orbit"></div><div><strong>${({quote:'Consultando precio…',authorize:'Guardando tu autorización…',generate:'Preparando la generación…',recover:'Consultando el resultado existente…',continue:'Preparando la siguiente etapa…',review:'Guardando tu revisión…'})[op.kind]||'Guardando progreso…'}</strong><p>Podés cerrar el estudio. Tu progreso se conserva.</p></div></div>`;
  if(op.status==='RECOVERY_REQUIRED')return '<div class="alert">Hay una operación sin resultado confirmado. Su registro está guardado. No se repetirá una generación.</div>'+(op.resume_available?'<button class="button secondary" data-action="resume">Retomar acción guardada</button>':'');
  if(op.status==='BLOCKED')return '<div class="alert">La última acción necesita revisión. No se repetirá automáticamente.</div>'+(op.resume_available?'<p>La siguiente etapa no llegó a ejecutarse. Tu animación y su aprobación están guardadas.</p><button class="button secondary" data-action="resume">Retomar etapa guardada</button>':'<button class="button secondary" data-action="refresh">Verificar resultado anterior</button>');
  return '';
}
function economicDetail(d){if(!d)return '';return `<div class="economic-detail">${row('Cotización recibida',usd(d.quote_amount_usd))}${row('Margen de reserva',esc(String(d.reservation_multiplier))+' ×')}${row('Reserva calculada',usd(d.calculated_reservation_usd))}${row('Máximo específico autorizado',usd(d.authorized_max_usd))}${Number.isFinite(d.calculated_reservation_usd)&&Number.isFinite(d.authorized_max_usd)&&d.calculated_reservation_usd>d.authorized_max_usd?row('Diferencia sobre el máximo',usd((Math.round(d.calculated_reservation_usd*1e6)-Math.round(d.authorized_max_usd*1e6))/1e6)):''}${row('Disponible del episodio',usd(d.episode_remaining_usd))}<p>${d.status==='PASS'?'El cálculo cabe en ambos límites; aún requiere precio vigente y confirmación.':d.reason==='ZERO_OR_MISSING_QUOTE'?'El proveedor no devolvió un precio positivo verificable.':d.reason==='EPISODE_EXPOSURE_OVER_CEILING'?'La exposición conjunta supera el presupuesto del episodio. Revisá recursos reutilizables antes de gastar.':'La reserva calculada supera el máximo de esta solicitud. Un importe mayor requiere otra decisión específica; el presupuesto del episodio no amplía esta autorización.'}</p></div>`;}
function episodeCostDetail(){const p=state.cost_projection;if(!p)return '';const names={IMAGE:'Imágenes',VIDEO:'Animaciones',TTS:'Voz',STORAGE:'Almacenamiento',INFRASTRUCTURE:'Infraestructura'};
 return `<h3>Plan económico completo</h3>${Object.entries(names).map(([stage,name])=>{const items=p.items.filter(i=>i.stage===stage&&!i.completed);return row(name,items.every(i=>i.remaining_estimate_usd!==null)?usd(items.reduce((n,i)=>n+i.remaining_estimate_usd,0)):'Falta evidencia de costo');}).join('')}${row('Mínimo estimado total',usd(p.minimum_estimated_total_usd))}${row('Total probable',usd(p.probable_total_usd))}${row('Contingencia sobre costos conocidos',usd(p.contingency_known_usd))}${row('Reservas con costo sin conciliar',usd(p.uncertain_reserved_usd))}${row('Gasto verificado registrado',usd(p.verified_spend_usd))}${row('Ahorro verificado por reutilización',usd(p.verified_savings_usd))}<p class="budget-note">${p.status==='INCOMPLETE_COST_EVIDENCE'?'Todavía no puede confirmarse el costo de terminar el episodio. Faltan cotizaciones o asignaciones documentadas.':p.status==='PLAN_EXCEEDS_BUDGET'?'El plan supera el presupuesto. Revisá clips aprobados y escenarios compatibles antes de autorizar gastos.':'Proyección orientativa; Lumi comprueba el precio antes de cada envío dentro del plan autorizado.'} Las referencias no evitan por sí solas una nueva generación. La calidad y el modelo aprobados se conservan.</p>`;}
function reviewPolicyCard(){
 const policy=state.review_policy,job=state.episode_job;if(!policy||!job)return '';
 const automatic=policy.mode==='DRAFT_FINAL_REVIEW_V1',pending=controlPending('draft_policy_accept')||controlPending('job');
 const unavailable=(!automatic||policy.expired)&&!policy.choice_available&&job.status!=='COMPLETE';
 return `<section class="card" data-ui-key="review-policy"><span class="tag">${automatic?'Borrador automático · revisión final':'Revisión por toma'}</span><p>${automatic?'Lumi avanza dentro del plan autorizado. Las verificaciones técnicas no sustituyen tu revisión artística final. Sin regeneraciones automáticas.':'Podés mantener la revisión por toma o elegir una sola revisión del borrador final.'}</p>${(!automatic||policy.expired)&&policy.choice_available?button(policyReviewLoading?'Preparando la decisión…':pending?.kind==='draft_policy_accept'?'Comprobando aceptación guardada…':policy.expired?'Revisar vigencia del modo automático':'Elegir borrador automático','draft_policy_review','secondary'):''}${unavailable?`<p role="status">${esc(errorText({message:policy.choice_unavailable_reason||'EPISODE_PLAN_APPROVAL_REQUIRED'}))}</p>${state.episode_plan_authorization?.approval_available?'<button class="button secondary" data-action="plan_review">Revisar plan vigente</button>':''}`:''}${job.status!=='COMPLETE'?button(job.status==='PAUSED'?'Continuar el mismo trabajo':'Pausar nuevas emisiones',job.status==='PAUSED'?'job_continue':'job_pause','quiet'):''}${pending||controlMessage?`<p role="status" data-control-status>${esc(pending?intentText(pending):controlMessage)}</p>`:''}<p>El trabajo se conserva al cerrar Telegram. En el alojamiento Free se reanuda cuando el servicio despierta; no puede trabajar mientras esté suspendido.</p></section>`;
}
function budgetCard(){const b=state.budget;return `<section class="card budget-summary" data-ui-key="daily-budget"><h3>Presupuesto</h3><div class="budget-trio"><div><small>Autorizado</small><strong>${usd(b.ceiling_usd)}</strong></div><div><small>Gasto confirmado</small><strong>${usd(b.actual_cost_usd)}</strong></div><div><small>Reservas pendientes</small><strong>${usd(b.pending_reservations_usd??b.reservations?.reduce((n,r)=>n+Number(r.amount_usd||0),0)??b.exposure_usd)}</strong></div></div><details><summary>Ver detalle de costos</summary>${row('Exposición total',usd(b.exposure_usd))}${row('Disponible interno',usd(b.remaining_usd))}<p class="budget-note">Las reservas no son cobros confirmados ni saldo del proveedor. Se conservan hasta conciliar su evidencia.</p>${episodeCostDetail()}</details></section>`;}
function quoteCard(){
 if(!state.episode_plan_authorization)return diagnosticQuoteCard();
 if(unresolvedIntent())return '<section class="card"><h3>Verificando la acción enviada…</h3><button class="button primary" disabled>'+esc(intentText(currentIntent()))+'</button>'+progressControl()+'</section>';
 const job=state.episode_job,plan=state.episode_plan_authorization,g=state.current_action;
 const known=state.cost_projection?.known_remaining_subtotal_usd;
 const estimate=`<p>Estimado de las etapas conocidas pendientes: <strong>${usd(known)}</strong>. Es una previsión, no un cargo. Techo del episodio: ${usd(state.budget.ceiling_usd)}.</p>`;
 if(state.reviews.length)return `<section class="card"><h3>Listo para revisar</h3><p>Tu resultado está guardado. Revisalo antes de continuar.</p>${tab==='inicio'?'<button class="button primary" data-tab="produccion">Revisar resultado</button>':''}</section>`;
 if(!state.episode.next_action){const m=state.media.find(m=>m.episode===state.episode.id&&m.role==='master');return m?`<section class="card"><h3>Episodio completado</h3><button class="button primary" data-download-media="${esc(m.id)}">Descargar video</button></section>`:'';}
 if(state.supervised_replacement?.operation_status==='NOT_CREATED')return diagnosticQuoteCard();
 if(state.continuity?.recovery_status==='ATTENTION_REQUIRED')return `<section class="card"><h3>Consulta detenida</h3><p>El resultado original aún necesita recuperarse. No vuelvas a generar esta toma.</p>${state.capabilities?.recover?button('Consultar resultado original','recover'):progressControl()}</section>`;
 if(g?.emission_locked&&!g.preflight_rejected||['RUNNING','QUEUED','WAITING_PROVIDER','WAITING_HUMAN_REVIEW'].includes(job?.status))
  return `<section class="card"><h3 role="status">${g?.status==='AMBIGUOUS'?'Necesita atención':g?.status==='SUBMITTED'?'Solicitud aceptada · esperando resultado':'Solicitud guardada'}</h3><p>${g?.status==='AMBIGUOUS'?'Conservamos la solicitud incierta y su evidencia. No se enviará otra.':'El trabajo está guardado. Lumi recupera la misma solicitud y continúa cuando el servicio está activo; podés cerrar Telegram.'}</p>${progressControl()}</section>`;
 if(job?.status==='NEEDS_ATTENTION'){const d=state.quote?.economic_decision;return `<section class="card"><h3>${d?.status==='BLOCKED'?'Revisar el presupuesto restante':'Necesita atención'}</h3><p>${d?.reason==='RESERVATION_MARGIN_OVER_AUTHORIZED_MAX'?'La reserva calculada de esta toma es '+usd(d.calculated_reservation_usd)+' y el límite aceptado es '+usd(d.authorized_max_usd)+'. La generación no se envió.':esc(errorText({message:job.error}).split(' Código:')[0])}</p>${plan?.approval_available&&plan.status!=='AUTHORIZED'?button('Revisar plan y continuar','plan_review'):''}${d?'<details><summary>Ver cálculo y límites</summary>'+economicDetail(d)+'</details>':''}${progressControl()}</section>`;}
 if(plan?.status==='AUTHORIZED')return `<section class="card"><h2>Continuar episodio</h2>${estimate}<p>El plan aprobado cubre las etapas indicadas. Lumi comprueba los precios internamente y se detiene para tus revisiones.</p>${button('Continuar episodio','produce_episode')}${progressControl()}</section>`;
 if(plan?.approval_available)return `<section class="card"><h2>Producir episodio</h2>${estimate}<p>Una decisión sobre el plan y sus límites. Sin cotizaciones manuales, variantes ni reintentos de generación automáticos.</p>${button('Producir episodio','plan_review')}${progressControl()}</section>`;
 return `<section class="card"><h3>Plan pendiente de completar</h3>${estimate}<p>${esc(plan?.error||'Falta evidencia para definir los límites de las etapas restantes.')}</p>${progressControl()}</section>`;
}
function diagnosticQuoteCard(){const q=state.quote,c=state.capabilities,g=state.current_action;
  const replacement=state.supervised_replacement;
  if(replacement){const scene=state.production?.shots.find(s=>s.current),accepted=replacement.authorization_status==='HUMAN_RISK_ACCEPTANCE';
    const attention=replacement.authorization_status==='NEW_RISK_ACCEPTANCE_REQUIRED'?'El máximo cambió. Hace falta una nueva aceptación específica.':replacement.authorization_status==='CONSENT_EXPIRED'?'Venció el plazo explícito de tu aceptación. Revisá una nueva decisión.':accepted?'Aceptación específica registrada.':'Necesitamos tu decisión sobre el riesgo.';
    const primary=replacement.recover_available?button('Recuperar resultado','replacement_recover'):replacement.generation_enabled&&!unresolvedIntent()?button(state.production?.action?.stage==='VIDEO'?'Generar animación supervisada':'Generar imagen supervisada','replacement_generate'):replacement.risk_review_available?button('Revisar riesgo y autorización','replacement_review'):'<button class="button primary" disabled>Necesita atención · Generación bloqueada</button>';
    return `<section class="card"><span class="tag">Recuperación supervisada</span><h2>${scene?'Escena '+scene.number+' — '+esc(scene.title||scene.goal):'Reemplazo supervisado'}</h2><h3>Solicitud anterior sin confirmación</h3><p>${esc(replacement.risk_disclosure)}</p>${row('Reserva anterior conservada',usd(replacement.previous_reservation_usd))}${row('Nueva reserva máxima',usd(replacement.estimated_new_reservation_usd))}${row('Posible exposición conjunta máxima',usd(replacement.combined_exposure_usd))}<p role="status">${esc(attention)}</p>${primary}<p>Lumi comprobará el precio y el presupuesto al generar. La reserva anterior se conserva; puede existir un cargo duplicado.</p><details><summary>Ver costos y evidencia</summary>${row('Presupuesto del episodio',usd(state.budget.ceiling_usd))}${row('Disponible interno',usd(replacement.available_budget_usd))}${replacement.consent_expires_at?row('Plazo de la aceptación anterior o vigente',new Date(replacement.consent_expires_at).toLocaleString()):''}${economicDetail(replacement.economic_decision)}${replacement.quote_only_available?button('Consultar cotización sin generar','replacement_quote','quiet'):''}${replacement.confirmation_error?'<p>'+esc(errorText({message:replacement.confirmation_error}))+'</p>':''}<p>Reserva interna, no cargo garantizado. La cotización histórica puede haber vencido.</p></details>${progressControl()}</section>`;}


  const plan=state.episode_plan_authorization;
  if(c.production_stage&&!unresolvedIntent())return `<section class="card quote-card"><span class="tag green">Plan y límites aprobados</span><h2>${esc(state.production?.action?.title||'Etapa lista')}</h2><p>Lumi busca recursos aprobados y comprueba el precio antes de generar.</p>${button(state.production?.action?.stage==='VIDEO'?'Generar animación':state.production?.action?.stage==='TTS'?'Generar voz':'Generar imagen','production_stage')}<details><summary>Ver autorización</summary>${row('Reserva máxima de esta etapa',usd(plan?.contract?.per_action_limits?.[state.episode.next_action]))}<p>Sin ampliaciones ni reintentos automáticos.</p></details>${progressControl()}</section>`;
  if(plan?.approval_available&&plan.status!=='AUTHORIZED'&&(!g?.emission_locked||g.preflight_rejected)&&!state.reviews.length)return `<section class="card"><h2>Aprobar plan y presupuesto</h2><p>Revisá las tomas, los modelos y el límite de cada etapa. Una variación fuera del límite requiere esta nueva decisión.</p>${economicDetail(q?.economic_decision)}${button('Revisar plan y presupuesto','plan_review')}${progressControl()}</section>`;
  const second=state.second_image;
  if(unresolvedIntent())return '<section class="card"><h3>Verificando la acción enviada…</h3><p>Esperamos su registro guardado antes de permitir otra acción. Podés cerrar y reabrir el estudio.</p><button class="button primary" disabled>Acción en curso</button><button class="button secondary" data-action="refresh">Actualizar progreso</button></section>';
  if(state.episode.next_action==='image:q42'&&second?.available)return `<section class="card quote-card"><span class="tag green">Autorización económica disponible</span><h2>Escena 2 — La vaca</h2>${row('Reserva máxima',usd(second.max_reservation_usd))}<p>Un único clic prepara la imagen, comprueba el precio vigente y continúa dentro del límite autorizado.</p>${button('Generar segunda imagen','second_image')}<p class="budget-note">La reserva interna no garantiza el cobro máximo del proveedor.</p></section>`;
  if(state.episode.next_action==='image:q42'&&g?.operations?.some(o=>o.kind==='second_image')){
    const op=g.operations.find(o=>o.kind==='second_image');
    if(op.status==='BLOCKED'&&/LIMIT|BUDGET/.test(op.error||''))return `<section class="card"><h3 role="status">El precio o el presupuesto supera la autorización.</h3><p>Necesitamos una nueva autorización específica antes de continuar. Lumi no enviará otra generación.</p>${progressControl()}</section>`;
    const phaseText=({VERIFYING_SOURCE:'Preparando imagen…',QUOTING:'Verificando precio…',BUDGET_CHECK:'Comprobando presupuesto…',DISPATCHING:'Comprobando presupuesto…',GENERATING:'Generando imagen…',REVIEW_READY:'Imagen lista para revisar.'})[g.phase];
    const text=['SUBMITTED','PROCESSING','SUCCEEDED','AWAITING_HUMAN_REVIEW','AMBIGUOUS','FAILED_CONFIRMED'].includes(g.status)?actionStatusText[g.status]:phaseText||actionStatusText[g.status];
    const reason=g.status==='AMBIGUOUS'&&op.error==='Q41_EMISSION_BINDING_CHANGED'?'La validación final de la solicitud no se completó. No hay una respuesta confirmada del proveedor. Necesitamos recuperar evidencia de esta misma operación.':g.status==='AMBIGUOUS'?'Todavía no tenemos confirmación del proveedor. La operación requiere recuperación antes de continuar.':g.status==='FAILED_CONFIRMED'?'El proveedor rechazó la solicitud. Hace falta revisar ese resultado antes de continuar.':'';
    return `<section class="card"><h3 role="status">${esc(text||'Verificando la operación original…')}</h3><p>Lumi no enviará otra generación.</p>${reason?`<p>${esc(reason)}</p>`:''}${progressControl()}${c.recover?button('Recuperar imagen original','recover','secondary'):''}</section>`;
  }
  if(g?.locked&&!['QUOTED','AUTHORIZED'].includes(g.status)&&!(state.first_animation?.episode_id===state.episode.id&&state.episode.next_action==='video:q41'))return `<section class="card"><h3 role="status">${esc((actionStatusText[g.status]||'Verificando la operación guardada…').replace(/imagen/g,state.production?.action?.stage==='VIDEO'?'animación':state.production?.action?.stage==='TTS'?'audio':'imagen'))}</h3><p>${state.production?.action?.stage==='TTS'?'Continuá los segmentos originales autorizados. Cada segmento mantiene su propia solicitud.':'Conservamos la operación original. No se enviará otra generación.'}</p>${c.recover?'<button class="button secondary" data-action="recover" '+(sending?'disabled':'')+'>' +(state.production?.action?.stage==='TTS'?'Continuar voz autorizada':'Recuperar resultado original')+'</button>':state.reviews.length?'':'<button class="button secondary" data-action="refresh">Actualizar estado</button>'}</section>`;
  if(g?.status==='AUTHORIZED'&&(g.authorization_expired||q?.status==='QUOTE_EXPIRED'))return `<section class="card"><h3>Autorización registrada.</h3><p>La generación no se inició. El precio venció antes de confirmar el envío. Al continuar, Lumi comprobará el precio automáticamente y te pedirá una autorización nueva.</p>${button('Continuar preparación guardada','prepare','primary',!c.renew_quote)}</section>`;

  if(state.operation?.kind==='continue'&&state.operation.status!=='COMPLETE')return '<section class="card"><h3>'+(['QUEUED','RUNNING'].includes(state.operation.status)?'Preparando siguiente etapa…':'Verificando resultado anterior…')+'</h3><p>Conservamos la misma operación y la aprobación del video.</p><button class="button secondary" data-action="refresh">Actualizar progreso</button></section>';
  if(state.first_animation?.episode_id===state.episode.id&&state.episode.next_action==='video:q41'){
    const g=state.first_animation,locked=generationLocked(),ready=['AWAITING_HUMAN_REVIEW','SUCCEEDED'].includes(g?.status);
    const progress=({PREPARING:'Preparando animación…',QUOTING:'Consultando precio…',BUDGET_CHECK:'Verificando presupuesto…',AUTHORIZED:'Verificando presupuesto…',RESERVED:'Reserva registrada. Verificando la solicitud original…',EMITTING:'Enviando a Kling…',SUBMITTED:'Generando video…',AWAITING_HUMAN_REVIEW:'Tu animación está lista para revisión.',SUCCEEDED:'La animación original está disponible.',BLOCKED:'La operación requiere revisión. No se enviará otra generación.',AMBIGUOUS:'Estamos verificando la solicitud original. No se enviará otra generación.'})[g?.status]||'Estamos verificando la solicitud original. No se enviará otra generación.';
    return `<section class="card quote-card"><span class="tag blue">Una sola solicitud</span><h2>Primera animación de Lumi</h2><p>Kling 3.0 Pro · 4 segundos · sin audio.</p>${row('Reserva máxima autorizada','USD 0.56')}${row('Presupuesto del episodio',usd(state.budget?.ceiling_usd))}${locked?`<p role="status">${progress}</p>${ready?'<button class="button primary" data-tab="produccion">Ver animación</button>':''}<button class="button secondary" data-action="refresh">Actualizar progreso</button><p>La generación permanece bloqueada. Cerrar Telegram o perder la conexión no crea otra solicitud.</p>`:button('Generar primera animación','first_animation','primary',!g?.available)}${!locked?'<p>Lumi verificará automáticamente el precio antes de generar.</p>':''}<p class="budget-note">Una única animación dentro de estos límites internos. El costo real del proveedor no está garantizado.</p></section>`;
  }
  const action=state.production?.action,title=action?.title||'Continuar producción',image=action?.stage==='IMAGE';
  if(c.recover)return `<section class="card quote-card"><span class="tag blue">Solicitud en curso</span><h2>${image?'Tu imagen':'Tu animación'} está en camino.</h2><p>Recuperamos el resultado de la misma solicitud.</p>${button('Consultar resultado guardado','recover')}</section>`;
  if(c.continue)return `<section class="card quote-card"><h3>${esc(title)}</h3><p>Continuá con la preparación y revisión de esta escena.</p>${button('Continuar producción','continue')}</section>`;
  if(!c.quote&&!c.renew_quote&&!c.authorize&&!c.generate)return state.reviews.length?'':`<section class="card"><h3>${esc(title)}</h3><p role="status">${action?'Verificando el estado guardado de esta etapa.':'Producción completada.'}</p></section>`;
  if(!q||q.status==='QUOTE_EXPIRED')return `<section class="card quote-card"><span class="tag gold">Próximo paso</span><h2>${esc(title)}</h2><p>Lumi comprobará automáticamente el precio y el presupuesto. Después podrás autorizar el importe específico de esta ${image?'imagen':'etapa'}.</p>${button(esc(title),'prepare')}</section>`;
  if(!['AWAITING_HUMAN_AUTHORIZATION','HUMAN_SPEND_AUTHORIZED'].includes(q.status))return `<section class="card"><h3>Precio pendiente de verificación</h3><p>El resultado guardado requiere revisión antes de autorizar un gasto.</p>${economicDetail(q.economic_decision)}${button('Actualizar estado','refresh','secondary')}</section>`;
  if(q.currency==='ELEVENLABS_CHARACTER_QUOTA')return `<section class="card quote-card"><span class="tag blue">Voz Fernanda</span><h3>${esc(title)}</h3>${row('Máximo de segmentos',esc(q.request_count))}${row('Máximo de caracteres',esc(q.quota_units))}${row('Cuota disponible observada',esc(q.quota_remaining))}<p>Una autorización para estos textos y esta voz. Se conserva al cerrar Telegram; cada segmento se procesa una sola vez y la cuota se verifica de nuevo.</p><p>El costo real en USD no está verificado.</p>${c.authorize?button('Autorizar estos segmentos','authorize'):button('Generar voz autorizada','generate')}</section>`;
  return `<section class="card quote-card"><span class="tag ${c.generate?'green':'blue'}">${c.generate?'Importe autorizado':'Precio disponible'}</span><h3>${esc(title)}</h3><div class="quote-price">${usd(q.quote_usd)}</div>${row('Reserva propuesta',usd(q.proposed_reserve_usd))}${row('Disponible tras la reserva',usd(q.remaining_after_usd))}${row('Vigencia','<span id="quote-countdown"></span>')}<p>Esta autorización corresponde únicamente a la escena y operación actuales.</p>${button(c.generate?(image?'Generar imagen':'Generar animación'):'Revisar y autorizar importe',c.generate?'generate':'authorize','primary',!c.generate&&!c.authorize)}<p class="budget-note">${c.generate?'Generar comprueba los límites y envía una única solicitud.':'Autorizar el importe no inicia la generación.'}</p></section>`;
}
function workflowState(){
 const shots=state.production?.shots||[],reviews=state.reviews||[],master=state.media.find(m=>m.episode===state.episode.id&&m.role==='master');
 const finalReview=reviews.some(r=>['MASTER','MASTER_REVIEW'].includes(r.stage));
 const active=!state.episode.next_action&&master?'descargar':reviews.length?'revisar':state.episode_job||shots.some(s=>s.complete)?'producir':'preparar';
 const attention=state.continuity?.recovery_status==='ATTENTION_REQUIRED'||state.episode_job?.status==='NEEDS_ATTENTION'||['AMBIGUOUS','BLOCKED','FAILED_CONFIRMED'].includes(state.current_action?.status);
 return {shots,master,finalReview,active,attention,ready:shots.filter(s=>s.complete).length};
}
function workflowSteps(w){const selected=workflowTab||w.active;return `<nav class="workflow-steps" aria-label="Etapas del episodio">${['preparar','producir','revisar','descargar'].map((k,i)=>`<button data-workflow="${k}" ${selected===k?'aria-current="step"':''}><span>${i+1}</span>${k[0].toUpperCase()+k.slice(1)}</button>`).join('')}</nav>`;}
function dailyStatus(w){
 const c=state.continuity||{},job=state.episode_job,current=state.production?.shots.find(s=>s.current);
 let title='Preparar el episodio',message='Revisá la historia, la estimación y el modo de revisión.',needs='Tu aceptación del plan y sus límites.';
 if(!state.episode.next_action&&w.master){title='Tu video está listo';message='El master aprobado está disponible para reproducir y descargar.';needs='Nada pendiente.';}
 else if(state.reviews.length){title=w.finalReview?'Revisar el borrador completo':'Hay una toma para revisar';message='El resultado está guardado y disponible abajo.';needs='Tu revisión del resultado.';}
 else if(w.attention){title='La producción necesita atención';message=c.recovery_status==='ATTENTION_REQUIRED'&&c.recovery_error?errorText({message:c.recovery_error}).split(' Código:')[0]:errorText({message:job?.error||state.current_action?.status||'RECOVERY_REQUIRED'}).split(' Código:')[0];needs='Revisá el siguiente paso seguro indicado abajo.';}
 else if(job?.status==='PAUSED'){title='Producción pausada';message='Las tomas disponibles y la solicitud en curso se conservan.';needs='Continuar el mismo trabajo cuando quieras.';}
 else if(state.current_action?.status==='SUBMITTED'){const image=state.episode.next_action?.startsWith('image:'),medium=image?'la imagen':'la animación';title=current?'Esperando '+medium+' · toma '+current.number:'Solicitud aceptada';message=c.provider_status==='queued'?'Higgsfield tiene el pedido en cola.':c.provider_status==='in_progress'?'Higgsfield está procesando '+medium+'.':'La solicitud fue aceptada. Todavía no hay un archivo final verificado para esta etapa.';const minutes=Math.floor((Date.now()+serverOffset-Date.parse(c.accepted_at))/60000);if(minutes>=20)message+=' Lleva '+minutes+' minutos desde su aceptación. Seguimos consultando el pedido original.';needs='Nada por ahora. No hace falta volver a generar.';}
 else if(w.active==='producir'){title='Preparando la siguiente etapa';message='Lumi verifica los resultados y los límites del plan guardado.';needs='Nada mientras no se indique una decisión pendiente.';}
 const evidence=c.last_provider_check_at||c.accepted_at||c.checkpoint_at;
 return `<section class="card daily-status" data-ui-key="daily-status"><span class="tag ${w.attention?'gold':'blue'}">${w.attention?'Necesita atención':state.review_policy?.mode==='DRAFT_FINAL_REVIEW_V1'?'Borrador automático':'Producción supervisada'}</span><h2 role="status">${esc(title)}</h2><p>${esc(message)}</p><p class="human-need"><strong>De vos:</strong> ${esc(needs)}</p>${evidence?`<small>Última actividad verificada: ${esc(new Date(evidence).toLocaleString('es-AR'))}${c.last_provider_check_at?' · consulta del resultado':c.accepted_at?' · solicitud aceptada':' · progreso guardado'}.</small>`:''}<p class="completion-count">${w.ready} de ${w.shots.length} tomas listas</p>${w.shots.length?`<progress class="episode-progress" value="${w.ready}" max="${w.shots.length}" aria-label="Tomas listas">${w.ready} de ${w.shots.length}</progress>`:''}${!state.reviews.length&&state.episode.next_action&&job?progressControl():''}</section>`;
}
function shotGallery(w){return `<section class="shot-gallery"><div class="section-heading"><h2>Tomas del episodio</h2><span>${w.ready}/${w.shots.length}</span></div><div class="shot-grid">${w.shots.map(s=>{
 const image=state.media.find(m=>m.episode===state.episode.id&&m.shot_id===s.id&&m.role==='source'),clip=state.media.find(m=>m.episode===state.episode.id&&m.shot_id===s.id&&m.role==='clip');
 const hasReview=state.reviews.some(r=>state.media.find(m=>m.id===r.media_id)?.shot_id===s.id);
 const status=s.complete?'Lista':s.current&&(w.attention||hasReview)?'Necesita atención':s.current?'En proceso':'Pendiente';
 return `<article class="shot-tile" data-ui-key="shot:${esc(s.id)}">${image?studioImage(image,'thumb'):'<div class="shot-placeholder" aria-hidden="true">✦</div>'}<div><span class="tag ${s.complete?'green':status==='Necesita atención'?'gold':'blue'}">${status}</span><h3>Toma ${s.number} · ${esc(s.title==='viewer'?'Lumi y vos':s.title||s.goal)}</h3>${image||clip?`<details><summary>Ver resultado guardado</summary>${clip?.approved?'<p>Aprobación humana conservada</p>':''}${frame(clip||image)}</details>`:''}</div></article>`;
 }).join('')}</div></section>`;}
function storyPlan(){return `<section class="card" data-ui-key="story-plan"><h2>Historia y voz</h2><p>Una habilidad por episodio, con Lumi y la voz Fernanda V3.</p><ol>${(state.production?.shots||[]).map(s=>`<li><strong>Toma ${s.number} · ${esc(s.title==='viewer'?'Lumi y vos':s.title||s.goal)}</strong><p>${esc(s.goal)}</p>${s.narration?`<p>«${esc(s.narration)}»</p>`:''}</li>`).join('')}</ol></section>`;}
function workflowDetails(){const s=state.production?.shots.find(s=>s.current);return `<details class="card technical-details" data-ui-key="technical-details"><summary>Detalles de producción</summary>${s?sceneContract(s):''}${state.episode.actions?`<ol class="progress-list">${state.episode.actions.map(a=>`<li class="${a.status==='COMPLETE'?'complete':a.current?'current':''}"><span class="stage-dot">${a.status==='COMPLETE'?'✓':'·'}</span><div><strong>${esc(a.label)}</strong><small>${esc(a.key)} · ${esc(a.status)}</small></div></li>`).join('')}</ol>`:''}${row('Operación',esc(state.current_action?.provider_request_id||'Sin solicitud aceptada en esta etapa'))}${row('Recuperación',esc(state.continuity?.recovery_error||state.continuity?.recovery_status||'Sin incidencias registradas'))}${economicDetail(state.quote?.economic_decision)}</details>`;}
function publicationCard(episode){
 if(publicationUI&&episode?.publication?.networks)return publicationUI.card(episode);
 if(!episode?.publication?.text)return '';
 const key=state.client_scope+':'+episode.id,text=publicationEdits.get(key)??episode.publication.text;
 return `<details class="publication-card" data-ui-key="publication:${esc(episode.id)}"><summary>✍️ Texto para publicar</summary><p>Un mensaje para este episodio, con emojis y hashtags. Podés editarlo antes de copiar.</p><label>Mensaje sugerido<textarea data-publication-episode="${esc(episode.id)}" rows="7" maxlength="2200">${esc(text)}</textarea></label><button class="button secondary" data-copy-publication="${esc(episode.id)}">Copiar mensaje</button><small>Revisá el texto y la aprobación del video antes de programar su publicación.</small></details>`;
}
async function copyPublication(id){
 const field=[...document.querySelectorAll('[data-publication-episode]')].find(n=>n.dataset.publicationEpisode===id);if(!field)return;
 try{if(typeof navigator==='undefined'||!navigator.clipboard?.writeText)throw Error('CLIPBOARD_UNAVAILABLE');await navigator.clipboard.writeText(field.value);toast('Mensaje copiado.');}
 catch{field.focus();field.select?.();toast('Seleccioné el mensaje. Usá «Copiar» en el menú de tu teléfono.');}
}
document.addEventListener('input',e=>{const id=e.target.dataset?.publicationEpisode;if(id&&state)publicationEdits.set(state.client_scope+':'+id,e.target.value);});
document.addEventListener('click',e=>{const b=e.target.closest('[data-copy-publication]');if(b)copyPublication(b.dataset.copyPublication);});
function masterCard(m){return `<section class="card"><h2>Video final</h2>${frame(m,{priority:true})}<button class="button primary" data-download-media="${esc(m.id)}">Descargar video</button><p>Video vertical Full HD · conservá el archivo original.</p>${publicationCard(state.episodes.find(e=>e.id===m.episode))}</section>`;}
function workflowPage(){
 const w=workflowState(),selected=workflowTab||w.active,m=source();
 let content='';
 if(selected==='preparar')content=`${preparationUI?.card()||''}${quoteCard()}${reviewPolicyCard()}${storyPlan()}${plannerLibraryCard()}`;
 else if(selected==='producir')content=`<div id="next-action" tabindex="-1">${!w.attention&&!state.reviews.length&&['RUNNING','QUEUED','WAITING_PROVIDER'].includes(state.episode_job?.status)?'':quoteCard()}${reviewCards()}</div>${shotGallery(w)}<details class="card" data-ui-key="mode-options"><summary>Modo de revisión y pausa</summary>${reviewPolicyCard()}</details>`;
 else if(selected==='revisar')content=`<div id="next-action" tabindex="-1">${state.reviews.length?reviewCards():`<section class="card"><h2>${w.master?'Borrador guardado':'Revisión final pendiente'}</h2><p>${w.master?'El borrador completo está disponible. La aprobación final debe quedar registrada antes de terminar.':'El borrador completo aparecerá aquí cuando terminen las tomas, la voz y el montaje.'}</p>${w.master?frame(w.master):''}</section>`}</div>${state.optional_reviews?.length?`<details class="card"><summary>Revisar tomas antes del final (opcional)</summary>${reviewCards(state.optional_reviews)}</details>`:''}${clipCards()}`;
 else content=w.master&&!state.episode.next_action?masterCard(w.master):'<section class="card"><h2>Descarga pendiente</h2><p>El video final estará disponible después del montaje y de tu aprobación del borrador completo.</p></section>';
 return `<header class="episode-heading"><div><span class="eyebrow">EPISODIO ACTIVO</span><h1>${esc(state.episode.title)}</h1></div>${m?studioImage(m,'thumb',true):''}</header>${workflowSteps(w)}${dailyStatus(w)}${budgetCard()}${content}${workflowDetails()}`;
}
function home(){return workflowPage();}
function production(){return workflowPage();}
function sceneContract(scene){const c=scene.continuity;return `<section class="card"><h3>La escena que vamos a crear</h3>${row('Objetivo',esc(scene.goal))}${row('Descripción visual',esc(scene.visual_description))}${row('Personajes',esc(scene.characters.join(', ')))}${row('Modelo de imagen',esc(scene.image_model))}${row('Estado',scene.generation_status==='PENDING'?'Imagen pendiente':'Imagen guardada')}<h3>Continuidad</h3>${c.previous_goal?`<p>Venimos de: ${esc(c.previous_goal)}</p>`:''}<p>${esc(c.character_details.join(' · '))}</p><p>${c.canonical_reference?'Se conserva la referencia canónica aprobada de Lumi.':''}</p></section>`;}
function clipCards(){const shots=state.production?.shots||[],clips=state.media.filter(m=>m.episode===state.episode.id&&m.role==='clip'&&!state.reviews.some(r=>r.media_id===m.id));return clips.length?`<div class="section-heading"><h2>Tomas del episodio</h2></div>${clips.map(m=>{const s=shots.find(s=>s.id===m.shot_id);return `<section class="card"><h3>${s?'Toma '+s.number+(s.complete?' · Completada':''):esc(m.label)}</h3>${m.approved?'<span class="tag green">Aprobación humana conservada</span>':''}${frame(m)}${s?.complete?approvedImage(s.id):''}</section>`;}).join('')}`:'';}
function approvedImage(shotId){const m=state.media.find(m=>m.episode===state.episode.id&&m.role==='source'&&m.shot_id===shotId&&m.approved);return m?`<details><summary>Ver imagen aprobada</summary>${frame(m)}</details>`:'';}

function reviewCards(items=state.reviews){return items.map(r=>{const m=state.media.find(m=>m.id===r.media_id);return `<section class="card" data-ui-key="review:${esc(r.id)}:${r.version}:${esc(r.artifact_sha)}"><span class="tag gold">Tu revisión</span><h3>${['MASTER','MASTER_REVIEW'].includes(r.stage)?'¿Está listo el episodio completo?':r.stage==='TTS'?'¿Está lista la voz?':'¿Está lista esta toma?'}</h3>${frame(m,{review:true})}${['MASTER','MASTER_REVIEW'].includes(r.stage)?publicationCard(state.episodes.find(e=>e.id===state.episode.id)):''}${r.source_media_id?`<details><summary>Comparar con la imagen aprobada</summary>${frame(state.media.find(m=>m.id===r.source_media_id),{review:true})}</details>`:''}${r.contract?`<p>Al aprobar confirmás la identidad de Lumi, anatomía estable, alas y varita visibles, ausencia de objetos extra y espacio libre para texto. Acción: ${esc(r.contract.grammar)} · foco: ${esc(r.contract.focus)} · ${esc(r.contract.duration)} s.</p><ul>${r.contract.inventory.map(o=>`<li>${esc(o.count)} × ${esc(o.id)}: ${esc(o.color)}, ${esc(o.shape)}, ${esc(o.placement)}.</li>`).join('')}</ul>`:''}${r.stage==='IMAGE'&&r.contract_sha?'<p>Confirmá la identidad de Lumi, sus dos alas y varita, y los objetos de esta escena.</p><label>Orientación de Lumi<select id="pose-'+r.id+'"><option value="">Seleccionar</option><option value="FRONT">De frente</option><option value="THREE_QUARTER">Tres cuartos</option></select></label><label>Mano de Lumi que sostiene la varita<select id="wand-'+r.id+'"><option value="">Seleccionar</option><option value="LEFT">Izquierda del personaje</option><option value="RIGHT">Derecha del personaje</option></select></label>':''}${r.stage==='VIDEO'?'<label class="check"><input type="checkbox" id="playback-'+r.id+'">Vi el clip completo.</label><label class="check"><input type="checkbox" id="source-'+r.id+'">Comparé la animación con la imagen aprobada.</label>':''}<button class="button primary" data-review="${esc(r.id)}" data-decision="APPROVED" ${busy()||!reviewMediumLoaded(r.media_id)?'disabled':''}>Aprobar ${r.stage==='VIDEO'?'animación':r.stage==='TTS'?'audio':['MASTER','MASTER_REVIEW'].includes(r.stage)?'master':'imagen'}</button><button class="button quiet" data-review="${esc(r.id)}" data-decision="REJECTED" ${busy()||!reviewMediumLoaded(r.media_id)?'disabled':''}>Solicitar corrección</button></section>`;}).join('');}
function videos(){return `<section class="page-intro"><span class="eyebrow">LA COLECCIÓN DE LUMI</span><h1>Historias para<br>volver a descubrir.</h1><p>Los episodios y sus videos finales, juntos.</p></section>${state.episodes.map(e=>{const m=state.media.find(m=>m.episode===e.id&&m.role==='master');const a=libraryData?.assets.find(a=>a.asset_type==='MASTER'&&a.source_episode_id===e.id);return `<article class="card library-card"><div class="library-cover"><span class="tag ${m?'green':'blue'}">${m?'MASTER DISPONIBLE':'EN PRODUCCIÓN'}</span><span class="symbol" aria-hidden="true">✦</span></div><div class="library-body"><h3>${esc(e.title)}</h3>${m?`${a?`<button class="button secondary" data-library-view="${a.asset_id}">${libraryOpened===a.asset_id?'Cerrar master':'Reproducir master'}</button>${libraryPreview(a)}<button class="button secondary" data-library-download="${a.asset_id}">Descargar master</button>`:frame(m)+`<button class="button secondary" data-download-media="${esc(m.id)}">Descargar master</button>`}`:'<p>El video final aparecerá aquí cuando esté listo.</p><button class="text-link" data-episode="${esc(e.id)}">Ver producción ↗</button>'}${publicationCard(e)}</div></article>`;}).join('')}`;}
function settings(){const s=state.settings;return `<section class="page-intro"><span class="eyebrow">TODO EN SU LUGAR</span><h1>Tu estudio,<br>bien cuidado.</h1><p>Configuración de producción y conexiones.</p></section><section class="card"><h3>Cómo trabaja Lumi</h3>${row('Modo de trabajo',state.review_policy?.mode==='DRAFT_FINAL_REVIEW_V1'?'Borrador automático · revisión final':'Revisión por toma')}${row('Publicación','Desactivada')}${row('Inicio automático',s.autorun?'Activo':'Desactivado')}${row('Procesos automáticos',s.runners==='OFF'?'Desactivados':'Activos')}${row('Entorno','Staging aislado')}</section><section class="card"><h3>Conexiones</h3>${[['Telegram','Acceso verificado',s.telegram],['Higgsfield · Kling','Animación',s.higgsfield],['ElevenLabs','Voz',s.elevenlabs]].map(([name,note,ok])=>`<div class="setting"><span class="setting-icon">${icon('ajustes')}</span><div class="setting-text"><strong>${name}</strong><small>${note}</small></div><span class="tag ${ok?'green':'gold'}">${ok?'Configurado':'Pendiente'}</span></div>`).join('')}<p class="budget-note">Configurado indica que existe una credencial en el servidor; no verifica saldo ni disponibilidad del proveedor.</p></section><section class="card"><h3>Formato de animación</h3>${row('Modelo','Kling 3.0 Pro')}${row('Duración',String(s.duration_seconds??'Según la toma')+(s.duration_seconds?' segundos':''))}${row('Audio del clip','Desactivado')}${row('Acceso desde el bot',s.entrypoint==='CONFIGURED'?'Preparado':'Pendiente')}</section>${publicationUI?publicationUI.settings():'<section class="card"><h3>Publicación</h3><p>Preparando la conexión de Lumi…</p></section>'}<p class="footer-note">Lumi Studio · Telegram Mini App V1</p>`;}
function loadingSkeleton(){return '<div class="loading-skeleton" aria-hidden="true"><div class="skeleton-card"><i></i><i></i><i></i></div><div class="skeleton-card short"><i></i><i></i></div></div>';}
function render(){if(state?.settings?.preparation_available&&!preparationUI&&!preparationLoading){preparationLoading=true;import('/lumi/studio/preparation-ui.js').then(m=>{preparationUI=m.createPreparationUI({getState:()=>state,request,render,refresh,toast,esc});render();}).catch(()=>{preparationLoading=false;toast('No se cargó la preparación. Volvé a abrir Studio.');});}if(state?.settings?.publication_connection&&!publicationUI&&!publicationLoading){publicationLoading=true;import('/lumi/studio/publication-ui.js').then(m=>{publicationUI=m.createPublicationUI({getState:()=>state,request,render,toast,esc,row});render();}).catch(()=>{publicationLoading=false;toast('No se cargaron los controles de publicación. Volvé a abrir Ajustes.');});}navigation();if(!state){patchMarkup(root,'<section class="welcome"><h1>'+esc(({inicio:'Inicio',videos:'Videos',produccion:'Producción',biblioteca:'Biblioteca',ajustes:'Ajustes'})[tab])+'</h1><p role="status">'+esc(loadingMessage)+'</p>'+(startupFailed?button('Volver a cargar','login','secondary'):loadingSkeleton())+'</section>');return;}patchMarkup(root,fundingNotice()+intentBanner()+({inicio:home,videos,produccion:production,biblioteca:libraryPage,ajustes:settings})[tab]());countdown();hydrateLibraryMedia();hydrateStudioMedia();syncReviewControls();autoLibraryPlan();
 if(scrollPending&&tab==='produccion'){scrollPending=false;const target=document.querySelector('#next-action');
  target?.focus({preventScroll:true});target?.scrollIntoView({block:'center',behavior:window.matchMedia?.('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});}}

function countdown(){if(!state?.quote)return;const q=state.quote,n=document.querySelector('#quote-countdown');if(n)n.textContent=Math.max(0,Math.ceil((Date.parse(q.expires_at)-Date.now()-serverOffset)/1000))+' s';if(Date.parse(q.expires_at)<=Date.now()+serverOffset&&['AWAITING_HUMAN_AUTHORIZATION','HUMAN_SPEND_AUTHORIZED'].includes(q.status)){state.quote.status='QUOTE_EXPIRED';state.capabilities.authorize=false;state.capabilities.generate=false;if(!state.current_action?.emission_locked&&['QUOTED','AUTHORIZED'].includes(state.current_action?.status))state.capabilities.renew_quote=true;render();}}
function authScreen(message){clearLibraryMedia();libraryData=null;libraryPlan=null;libraryResolved=null;state=null;root.innerHTML=`<section class="welcome"><div class="auth-symbol">✦</div><span class="eyebrow">BIENVENIDO A LUMI STUDIO</span><h1>Tu próxima historia<br>empieza en Telegram.</h1><p>${esc(message)}</p>${button('Volver a comprobar acceso','login','secondary')}<small>Acceso privado al estudio de Lumi.</small></section>`;navigation();}
async function refresh({manual=false}={}){
  if(manual){progressRequested=true;progressFeedback('Consultando progreso guardado…');}
  if(polling||!csrf)return;polling=true;const epoch=mutationEpoch;let superseded=false,feedback='Progreso actualizado. La operación original se conserva.';
  try{const next=await request('/state');
    if(epoch!==mutationEpoch){superseded=true;return;}
    applyState(next);
    // Progress reads never start preparation, quote renewal or recovery.
  }catch(e){if(epoch!==mutationEpoch){superseded=true;return;}feedback='No pudimos consultar el progreso. Podés volver a actualizar; el bloqueo se conserva.';if(e.status===401){csrf=null;authScreen(errorText(e));}else if(!state){startupFailed=true;loadingMessage='La conexión está tardando. Podés volver a cargar tu episodio guardado.';render();}else toast(errorText(e));}finally{polling=false;lastPoll=Date.now();if(superseded)await refresh();else if(progressRequested){progressRequested=false;progressFeedback(feedback);}}}
// Access tickets rotate independently of the visible media. Keep fresh tickets
// in memory, but only patch the page for a meaningful state or intent change.
function presentationState(value){if(!value)return '';return JSON.stringify({...value,server_time:0,media:(value.media||[]).map(({url,expires_at,...media})=>media)});}
function applyState(next){
    const sameOwner=state?.client_scope===next.client_scope,sameEpisode=sameOwner&&state?.episode.id===next.episode.id;
    if(state&&sameOwner&&(Number(next.review_revision??0)<Number(state.review_revision??0)||sameEpisode&&Number(next.episode.checkpoint_version??0)<Number(state.episode.checkpoint_version??0)))return;
    serverOffset=next.server_time-Date.now();
    const changed=presentationState(next)!==presentationState(state),intentsBefore=JSON.stringify(uiIntents);
    const advanced=state&&(!sameEpisode||next.episode.next_action!==state.episode.next_action);
    if(advanced){workflowTab=null;workflowSelections.clear();pendingSpend=null;if(dialog.open)dialog.close();scrollPending=true;}
    if(state&&!sameEpisode)resetNavigation();
    if(state&&!sameOwner){clearLibraryMedia();libraryData=null;libraryPlan=null;libraryResolved=null;}
    reconcileIntents(next);state=next;if(Object.values(uiIntents).some(i=>i.owner===next.client_scope&&i.kind.startsWith('library_')&&pendingIntent(i)))loadLibrary();if(actionIntent&&!unresolvedIntent())saveActionIntent(null);
    if(changed||intentsBefore!==JSON.stringify(uiIntents))render();else{countdown();syncReviewControls();metric('state_unchanged',0);}
}
async function login(){if(loggingIn)return;loggingIn=true;startupFailed=false;loadingMessage='Conectando con tu estudio…';render();const started=tick();
 try{let s;try{s=await request('/session?state=1');}catch(e){if(e.status!==401)throw e;const initData=tg?.initData||launchInitData;if(!initData)return authScreen('Abrí esta aplicación desde «Abrir Lumi Studio» en el menú del bot.');s=await request('/auth',{method:'POST',body:{initData}});}
 csrf=s.csrf;if(s.state){applyState(s.state);lastPoll=Date.now();}else{loadingMessage='Cargando tu episodio guardado…';render();await refresh();}
 if(state)metric('startup_ready',tick()-started);if(['biblioteca','videos'].includes(tab))await loadLibrary();
 }catch(e){if(e.status===401)authScreen(errorText(e));else{startupFailed=true;loadingMessage='La conexión está tardando. Volvé a cargar para consultar tu episodio guardado.';render();}}
 finally{loggingIn=false;}}
async function submit(kind,extra={}){if(kind==='review'&&!reviewInputReady(extra))return;
  if(pendingIntent(matchingIntent(kind,extra))||matchingIntent(kind,extra)?.phase==='DONE')return refresh();
  if(sending||busy()&&!['resume','recover'].includes(kind))return;
  if(['quote','authorize','generate','second_image','production_stage','produce_episode'].includes(kind)&&unresolvedIntent())return refresh();if((kind==='first_animation'||kind==='generate'&&state.episode.next_action==='video:q41')&&generationLocked())return refresh();
  if(kind==='second_image'&&(!state.second_image?.available||state.current_action?.emission_locked))return refresh();
  if(kind==='first_animation')rememberGenerationIntent();
  if(['quote','authorize','generate','second_image','production_stage','produce_episode'].includes(kind))saveActionIntent({episode:state.episode.id,action:state.episode.next_action,kind,quote_id:kind==='second_image'?null:state.quote?.quote_id??null});
  const feedbackStarted=tick(),intent=beginIntent(kind,extra);if(!intent)return refresh();
  mutationEpoch++;sending=true;render();metric('first_feedback',tick()-feedbackStarted,{kind});toast(kind==='first_animation'?'Preparando animación…':kind==='quote'?'Consultando precio…':'Guardando tu acción…');
  try{const q=state.quote;const accepted=await request('/actions/'+kind,{method:'POST',body:{...(['quote','authorize','generate'].includes(kind)?{quote_id:q?.quote_id??null,quote_sha:q?.quote_sha??null}:{}),...(['continue','quote','authorize','generate','production_stage'].includes(kind)?{expected_action:state.episode.next_action,checkpoint_version:state.episode.checkpoint_version}:{}),...extra}});
    changeIntent(intent,'ACKNOWLEDGED',{operation_id:accepted.operation?.id??null});
    // Action responses can arrive after a newer checkpoint. Only /state may
    // replace the view; the durable operation is recovered by the next read.
  }
  catch(e){
    // These server guards reject before any operation claim. Network failures
    // and all uncertain outcomes keep the intent until durable reconciliation.
    if(e.no_effect){changeIntent(intent,'REJECTED_NO_EFFECT');saveActionIntent(null);}else changeIntent(intent,'UNKNOWN');
    toast(errorText(e));
  }finally{sending=false;await refresh();render();}}
async function prepareSpend(){
 pendingSpend={action:state.episode.next_action,version:state.episode.checkpoint_version};
 const q=state.quote;if(q&&Date.parse(q.expires_at)>Date.now()+serverOffset&&state.capabilities.authorize){pendingSpend=null;return confirmSpend('authorize');}
 await submit('quote');finishPreparation();
}
function finishPreparation(){
 if(!pendingSpend||sending||busy())return;
 if(pendingSpend.action!==state.episode.next_action||pendingSpend.version!==state.episode.checkpoint_version){pendingSpend=null;return;}
 if(state.capabilities.authorize){pendingSpend=null;confirmSpend('authorize');}
 else if(state.operation?.status==='BLOCKED'||state.quote?.budget_gate==='BLOCKED')pendingSpend=null;
}
async function replacementMutation(path,body){
 if(sending)return;const kind='replacement_'+path,existing=matchingIntent(kind);if(pendingIntent(existing))return refresh();const intent=beginIntent(kind);if(!intent)return refresh();intent.proposal_id=body.proposal_id??body.challenge?.proposal_id;intent.authorization_reference=body.authorization_reference;intent.confirmation_id=body.confirmation_id;writeIntents();mutationEpoch++;sending=true;render();
 try{await request('/replacement/'+path,{method:'POST',body});changeIntent(intent,'ACKNOWLEDGED');toast(path==='quote'?'Cotización guardada. No se generó ni se reservó dinero.':path==='accept'?'Aceptación registrada. Ya podés usar Generar.':'Acción registrada. Consultá el progreso guardado.');}
 catch(e){changeIntent(intent,e.no_effect?'REJECTED_NO_EFFECT':'UNKNOWN');toast(errorText(e));}finally{sending=false;await refresh();render();}
}
async function reviewReplacement(){
 const proposal=state?.supervised_replacement?.proposal_id,episode=state.episode.id,version=state.episode.checkpoint_version,epoch=mutationEpoch;
 if(!state?.supervised_replacement?.risk_review_available||sending)return;
 try{const r=await request('/replacement/'+encodeURIComponent(proposal)+'/review');
  if(epoch!==mutationEpoch||state.episode.id!==episode||state.episode.checkpoint_version!==version||state.supervised_replacement?.proposal_id!==proposal)return;
  if(r.authorization_status==='HUMAN_RISK_ACCEPTANCE'){toast('Tu aceptación sigue registrada. No necesitás volver a aceptarla.');return refresh();}
  document.querySelector('#dialog-title').textContent='Riesgo de cargo duplicado';
  document.querySelector('#dialog-content').innerHTML=`<p>${esc(r.risk_disclosure)}</p>${row('Reserva anterior conservada',usd(r.previous_reservation_usd))}${row('Nueva reserva máxima',usd(r.maximum_reservation_usd))}${row('Posible exposición conjunta',usd(r.combined_exposure_usd))}${row('Presupuesto máximo',usd(r.hard_budget_usd))}<p>Aceptar registra esta decisión y este contenido durante 24 horas, hasta ${esc(new Date(r.challenge.consent_expires_at||r.challenge.expires_at).toLocaleString())}. Las cotizaciones y enlaces pueden renovarse dentro de ese plazo, sin cambiar el contenido ni el máximo autorizado. No crea una reserva ni inicia la generación.</p><label><input type="checkbox" id="replacement-risk-check"> Entiendo y acepto el posible cargo duplicado para esta solicitud.</label>`;
  const b=document.querySelector('#dialog-confirm');b.textContent='Registrar mi aceptación de riesgo';b.disabled=true;
  document.querySelector('#replacement-risk-check').onchange=e=>{b.disabled=!e.target.checked;};
  b.onclick=()=>{if(!document.querySelector('#replacement-risk-check')?.checked||sending)return;
    b.disabled=true;dialog.close();if(state.episode.id!==episode||state.episode.checkpoint_version!==version||Date.parse(r.challenge.expires_at)<=Date.now()+serverOffset)return refresh();
    replacementMutation('accept',{challenge:r.challenge,accept_duplicate_risk:true});};dialog.showModal();
 }catch(e){toast(errorText(e));}
}
function confirmReplacementQuote(){
 const r=state?.supervised_replacement;if(!r?.quote_only_available||sending)return;const id=r.proposal_id,reference=r.authorization_reference,confirmationId=crypto.randomUUID();
 document.querySelector('#dialog-title').textContent='Consultar precio sin generar';
 document.querySelector('#dialog-content').innerHTML='<p>Se consultará y guardará el precio del contenido autorizado. Esta consulta no crea una reserva, no envía una generación y no cambia tu aceptación ni su máximo.</p>';
 const b=document.querySelector('#dialog-confirm');b.textContent='Consultar y guardar cotización';b.disabled=false;
 b.onclick=()=>{b.disabled=true;dialog.close();if(state.supervised_replacement?.proposal_id!==id||!state.supervised_replacement?.quote_only_available||state.supervised_replacement?.authorization_reference!==reference)return refresh();replacementMutation('quote',{proposal_id:id,authorization_reference:reference,confirmation_id:confirmationId,confirm:true});};dialog.showModal();
}
function confirmReplacementGeneration(){
 const r=state?.supervised_replacement;if(!r?.generation_enabled||sending||unresolvedIntent())return refresh();
 const confirmation_id=crypto.randomUUID();
 saveActionIntent({kind:'replacement_generate',episode:state.episode.id,action:state.episode.next_action,authorization_reference:r.authorization_reference,confirmation_id});
 return replacementMutation('generate',{proposal_id:r.proposal_id,authorization_reference:r.authorization_reference,confirmation_id,confirm:true});
}
async function reviewEpisodePlan(){
 if(sending||planReviewLoading)return;planReviewLoading=true;toast('Preparando el plan para revisar…');
 try{const result=await request('/plan/review?price_buffer=10'),challenge=result.challenge,c=challenge.contract,episode=state.episode.id;
  document.querySelector('#dialog-title').textContent='Aprobar plan y presupuesto';
  document.querySelector('#dialog-content').innerHTML=`<p>${esc(c.title)}</p><details><summary>Historia y narración que autorizás</summary>${storyPlan()}</details><details><summary>Ver etapas, modelos y límites</summary>${c.action_set.map(key=>{const [stage,shotId]=key.split(':'),shot=state.production?.shots.find(s=>s.id===shotId),label=({image:'Imagen',video:'Animación',tts:'Voz Fernanda'})[stage]||'Etapa';return row(esc(label+(shot?' · Escena '+shot.number+' — '+(shot.title||shot.goal):''))+' · '+esc(c.model[key])+(c.payload_constraints[key].duration_seconds?' · '+c.payload_constraints[key].duration_seconds+' s':''),usd(c.per_action_limits[key]));}).join('')}</details>${row('Estimación mínima',usd(c.estimate_minimum_usd))}${row('Estimación probable',usd(c.estimate_probable_usd))}${row('Reserva máxima de las etapas',usd(c.total_reservation_maximum_usd))}${c.price_variation_percent?'<p>Estos límites propuestos incluyen un margen del 10% para variaciones de precio, redondeado hacia arriba a USD 0,05 por etapa. Solo se aplican si los aprobás; el techo total del episodio no aumenta.</p>':''}${row('Exposición máxima del episodio',usd(c.maximum_episode_exposure))}${!state.episode_job?'<label>Revisión del episodio<select id="initial-review-mode"><option value="">Elegí cómo querés revisar</option><option value="DRAFT_FINAL_REVIEW_V1">Borrador automático · revisión final</option><option value="SUPERVISED">Revisar cada toma</option></select></label><p>Con borrador automático, Lumi avanza dentro del plan y vos revisás el episodio completo. Un defecto visual puede llegar a la animación antes de esa revisión. Sin regeneraciones automáticas ni publicación.</p>':''}<p>Autorizás únicamente estas etapas, modelos, contenidos y límites. Lumi comprobará automáticamente el precio vigente y continuará entre etapas técnicas. Se detendrá según el modo elegido y siempre antes de aprobar el master final. Sin variantes ni reintentos automáticos. Vigencia hasta ${esc(new Date(challenge.consent_expires_at).toLocaleString())}. Al aprobar e iniciar, permitís ejecutar este plan dentro de sus límites. Voz: solo cuota disponible; sin recargas ni cargos adicionales autorizados. Los costos de asignación de voz, almacenamiento e infraestructura que no estén acreditados siguen siendo desconocidos.</p>`;
  const b=document.querySelector('#dialog-confirm');b.textContent='Aprobar e iniciar episodio';b.disabled=false;b.onclick=async()=>{
   if(sending||state.episode.id!==episode||pendingIntent(matchingIntent('plan_accept')))return;const reviewMode=!state.episode_job?document.querySelector('#initial-review-mode')?.value:null;if(!state.episode_job&&!reviewMode){toast('Elegí revisión final o revisión por toma antes de aprobar.');return;}dialog.close();const planIntent=beginIntent('plan_accept');if(!planIntent)return;sending=true;mutationEpoch++;render();
   try{await request('/plan/accept',{method:'POST',body:{challenge,confirm:true,...(reviewMode?{review_mode:reviewMode}:{})}});changeIntent(planIntent,'DONE',{result:'PLAN_AUTHORIZED'});const jobIntent=beginIntent('produce_episode');const receipt=await request('/actions/produce_episode',{method:'POST',body:{confirm:true}});changeIntent(jobIntent,'ACKNOWLEDGED',{operation_id:receipt.operation?.id});toast('Episodio iniciado. Te avisaremos en Studio cuando haya un resultado para revisar.');}
   catch(e){const job=matchingIntent('produce_episode');changeIntent(pendingIntent(job)?job:planIntent,e.no_effect?'REJECTED_NO_EFFECT':'UNKNOWN');toast(errorText(e));}finally{sending=false;await refresh();render();}
  };dialog.showModal();
 }catch(e){toast(errorText(e));}finally{planReviewLoading=false;}
}

const controlNoEffect=e=>e.no_effect===true||e.status===401||['MINI_SESSION_EXPIRED','EPISODE_PLAN_APPROVAL_REQUIRED','DRAFT_POLICY_EXPLICIT_DECISION_REQUIRED','DRAFT_POLICY_REVIEW_EXPIRED','DRAFT_POLICY_MATERIAL_CHANGED','EPISODE_JOB_REQUIRED'].includes(e.message);
async function controlJob(action){
 if(configurationBlocked(action==='pause'?'job_pause':'job_continue'))return;
 const i=beginIntent('job_'+action,{request_id:crypto.randomUUID()});if(!i)return;
 changeIntent(i,'SENDING',{job_id:state.episode_job.id});mutationEpoch++;controlMessage='';render();
 try{await request('/episode/control',{method:'POST',body:{action}});changeIntent(i,'ACKNOWLEDGED',{result:'CONTROL_REGISTERED'});controlMessage=action==='pause'?'Pausa guardada. Conservamos los trabajos ya enviados.':'El mismo trabajo continuará.';}
 catch(e){changeIntent(i,controlNoEffect(e)?'REJECTED_NO_EFFECT':'UNKNOWN');controlMessage=errorText(e);}
 finally{await refresh();render();}
}
async function reviewDraftPolicy(){
 if(configurationBlocked('draft_policy_review')||dialog.open)return;
 policyReviewLoading=true;controlMessage='';const episode=state.episode.id;render();
 try{const {challenge}=await request('/review-policy/review'),c=challenge.contract;
  if(state?.episode.id!==episode)return;
  document.querySelector('#dialog-title').textContent='Borrador automático · revisión final';
  document.querySelector('#dialog-content').innerHTML=`<p>Lumi continuará el mismo trabajo: ${esc(c.stages.join(' → '))}. Revisarás el master antes de aprobarlo o descargarlo como final.</p>${row('Techo del episodio',usd(c.maximum_episode_exposure))}<p>${esc(c.risk)} Las comprobaciones técnicas verifican archivos y contratos; no certifican anatomía, continuidad ni calidad artística. Podés intervenir antes del final. No hay regeneraciones automáticas ni publicación social. Se conservan los límites y el vencimiento del plan: ${esc(new Date(c.expires_at).toLocaleString())}.</p>`;
  const b=document.querySelector('#dialog-confirm');b.textContent='Aceptar el modo y continuar';b.disabled=false;b.onclick=async()=>{
   if(state?.episode.id!==episode||controlPending('draft_policy_accept')||!state.review_policy?.choice_available)return;
   const id='draft-policy:'+challenge.challenge_id,i=beginIntent('draft_policy_accept',{request_id:id});if(!i)return;
   changeIntent(i,'SENDING',{authorization_id:id});b.disabled=true;dialog.close();mutationEpoch++;controlMessage='';render();
   try{await request('/review-policy/accept',{method:'POST',body:{challenge,confirm:true}});changeIntent(i,'ACKNOWLEDGED');controlMessage='Aceptación específica registrada.';}
   catch(e){changeIntent(i,controlNoEffect(e)?'REJECTED_NO_EFFECT':'UNKNOWN');controlMessage=errorText(e);}
   finally{await refresh();render();}
  };dialog.showModal();
 }catch(e){controlMessage=errorText(e);toast(controlMessage);}
 finally{policyReviewLoading=false;render();}
}
function confirmSpend(kind){const q=state?.quote;if(!q||Date.parse(q.expires_at)<=Date.now()+serverOffset)return prepareSpend();
 const audio=q.currency==='ELEVENLABS_CHARACTER_QUOTA',generating=kind==='generate',image=state.production?.action?.stage==='IMAGE',action=state.episode.next_action,version=state.episode.checkpoint_version;
 document.querySelector('#dialog-title').textContent=generating?(audio?'¿Generamos la voz de Fernanda?':image?'¿Creamos la imagen?':'¿Creamos la animación?'):'Autorización de gasto';
 document.querySelector('#dialog-content').innerHTML=`<p>${esc(state.production?.action?.title||'Etapa actual')}</p>`+row('Precio estimado',usd(q.quote_usd))+row('Reserva máxima propuesta',usd(q.proposed_reserve_usd))+row('Presupuesto del episodio',usd(state.budget?.ceiling_usd))+`<p>${generating?'Esta acción enviará una única solicitud con el contenido y precio aprobados.':'Autorizás este importe para esta etapa. Luego confirmarás la generación.'}</p>`;
 if(audio)document.querySelector('#dialog-content').innerHTML=row('Voz',esc(q.voice_name))+row('Máximo de segmentos',esc(q.request_count))+row('Máximo de caracteres',esc(q.quota_units))+'<p>Autorización durable para los textos originales, dentro de la cuota existente. Cada continuación comprueba la cuota disponible. Sin reintentos automáticos ni recargas. El costo real en USD no está verificado.</p>';
 const b=document.querySelector('#dialog-confirm');b.disabled=false;b.textContent=generating?'Confirmar y generar':'Autorizar este importe';b.onclick=()=>{dialog.close();
  if(state.episode.next_action!==action||state.episode.checkpoint_version!==version)return refresh();
  if(state.quote?.quote_id!==q.quote_id||state.quote?.quote_sha!==q.quote_sha||Date.parse(q.expires_at)<=Date.now()+serverOffset)return prepareSpend();
  submit(kind,{confirm:true});};dialog.showModal();}
document.addEventListener('click',async e=>{
 const step=e.target.closest('[data-workflow]');if(step){workflowTab=step.dataset.workflow;render();return;}
 const download=e.target.closest('[data-download-media]');if(!download)return;
 download.disabled=true;const label=download.textContent;download.textContent='Preparando descarga…';
 try{const access=await request('/media/'+download.dataset.downloadMedia+'/access');const a=document.createElement('a');a.href=access.url+'&download=1';a.download='Lumi-'+(state.media.find(m=>m.id===download.dataset.downloadMedia)?.sha256?.slice(0,12)||'video')+'.mp4';a.target='_blank';a.rel='noopener';document.body.append(a);a.click();a.remove();}
 catch(error){toast(errorText(error));}finally{download.disabled=false;download.textContent=label;}
});
document.addEventListener('click',async e=>{const t=e.target.closest('[data-tab],[data-action],[data-review],[data-episode]');if(!t)return;
  if(t.dataset.episode){if(sending||pendingIntent(matchingIntent('select_episode',{request_id:t.dataset.episode})))return;const intent=beginIntent('select_episode',{request_id:t.dataset.episode});if(!intent)return;sending=true;mutationEpoch++;toast('Abriendo episodio…');try{await request('/actions/select_episode',{method:'POST',body:{episode_id:t.dataset.episode}});state=null;workflowTab=null;resetNavigation();tab='produccion';window.scrollTo({top:0,behavior:'instant'});await refresh();}catch(error){changeIntent(intent,'UNKNOWN');toast(errorText(error));}finally{sending=false;render();}return;}
  if(t.dataset.tab){e.preventDefault();navigate(t.dataset.tab);return;}
  if(t.dataset.review){const r=[...state.reviews,...(state.optional_reviews||[])].find(r=>r.id===t.dataset.review);if(!r)return;
    return submit('review',{request_id:r.id,artifact_sha:r.artifact_sha,review_version:r.version,decision:t.dataset.decision,full_playback:!!document.querySelector('#playback-'+r.id)?.checked,source_comparison:!!document.querySelector('#source-'+r.id)?.checked,...(r.stage==='IMAGE'?{pose:document.querySelector('#pose-'+r.id)?.value,wand_hand:document.querySelector('#wand-'+r.id)?.value}:{})});}
  const a=t.dataset.action;if(a==='login')return login();if(a==='refresh')return refresh({manual:true});if(a==='replacement_review')return reviewReplacement();if(a==='replacement_quote')return confirmReplacementQuote();if(a==='replacement_generate')return confirmReplacementGeneration();if(a==='replacement_recover')return replacementMutation('recover',{proposal_id:state.supervised_replacement.proposal_id});if(a==='prepare')return prepareSpend();if(a==='plan_review')return reviewEpisodePlan();if(a==='draft_policy_review')return reviewDraftPolicy();if(a==='job_pause')return controlJob('pause');if(a==='job_continue')return controlJob('continue');if(a==='produce_episode')return submit(a,{confirm:true});if(a==='first_animation'||a==='second_image'||a==='production_stage')return submit(a,{confirm:true});if(a==='generate')return submit('generate',{confirm:true});if(a==='authorize')return confirmSpend(a);return submit(a);});
document.querySelector('#dialog-cancel').onclick=()=>dialog.close();
document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh();});
function attachTelegram(){tg=window.Telegram?.WebApp;try{tg?.ready();tg?.expand();tg?.setHeaderColor('#f6f7fb');tg?.setBackgroundColor('#f6f7fb');tg?.onEvent('activated',refresh);}catch{/* Older Telegram clients still support ordinary navigation. */}}
attachTelegram();document.querySelector('script[src="https://telegram.org/js/telegram-web-app.js"]')?.addEventListener?.('load',attachTelegram,{once:true});
let lastPoll=0;setInterval(()=>{countdown();const interval=currentIntent()||sending?2500:state?.episode_job&&['RUNNING','WAITING_PROVIDER','QUEUED'].includes(state.episode_job.status)?5000:15000;if(!document.hidden&&!loggingIn&&!startupFailed&&Date.now()-lastPoll>=interval){lastPoll=Date.now();refresh();}},1000);
window.addEventListener?.('storage',e=>{if(e.key===uiIntentStorage){try{uiIntents=JSON.parse(e.newValue||'{}');render();}catch{}}});


let libraryData=null,libraryLoading=false,libraryError='',libraryCategory='Personajes',libraryQuery='',libraryOpened=null,libraryResolved=null,librarySaving=false,libraryTargets=[],libraryPlan=null,libraryPlanKey='',libraryPlanLoading=false;
const displayCache=new Map(),loadedReviewMedia=new Set();
let mediaEpoch=0,libraryFetchedAt=0;
let visibleObserver=null;
const mediaIdentity=(m,variant)=>[state?.client_scope||'memory',m.sha256||m.id,variant].join(':');
function studioImage(m,variant='thumb',priority=false){return `<div class="media-frame" data-media-host="${esc(m.id+':'+variant+':'+m.sha256)}" data-media-id="${esc(m.id)}" data-preview-state="LOADING" data-variant="${variant}" data-priority="${priority?'true':'false'}" data-width="${Number(m.width)||9}" data-height="${Number(m.height)||16}"><p role="status">Preparando imagen…</p></div>`;}
function safeMediaError(e){return e.status===401?'Acceso vencido (401). Reabrí Studio desde Telegram.':e.status===403?'No se pudo renovar el acceso privado (403).':e.status===404?'El archivo no está disponible (404).':/INTEGRITY|HASH|SIZE/.test(e.message)?'El archivo no superó la verificación de integridad.':/DECODE/.test(e.message)?'No se pudo decodificar esta imagen.':/BUSY|PENDING/.test(e.message)?'El preview se está preparando. Podés volver a consultarlo.':'No se pudo leer el archivo privado. Podés reintentar la lectura.';}
async function displayBytes(m,variant,{library=false}={}){
 const epoch=mediaEpoch,owner=state?.client_scope,key=mediaIdentity(m,variant),old=displayCache.get(key);if(old)return old.pending??old;
 const started=tick(),work=(async()=>{
  let access=library?{url:m.media_url,expires_at:m.expires_at}:{url:m.url,expires_at:m.expires_at},renewed=false;
  const renew=async()=>{const t=tick();const a=await request(library?'/library/access/'+m.asset_id:'/media/'+m.id+'/access');metric('media_access',tick()-t);access=library?{url:a.media.media_url,expires_at:a.media.expires_at}:a;renewed=true;};
  if(!access.url||access.expires_at<Date.now()+5000)await renew();
  for(let tries=0;tries<5;tries++){
   const controller=new AbortController(),deadline=setTimeout(()=>controller.abort(),20000),t=tick();let response,blob;
   try{
    response=await fetch(access.url+(variant==='original'?'':'&variant='+variant),{credentials:'same-origin',cache:'no-store',signal:controller.signal});metric('media_headers',tick()-t,{status:response.status,variant});
    if(response.status===403&&!renewed){await renew();continue;}
    if(response.status===202||response.status===503){if(tries===4)throw Error('PREVIEW_PENDING');await new Promise(r=>setTimeout(r,Math.min(1000*(tries+1),4000)));continue;}
    if(!response.ok)throw Object.assign(Error('MEDIA_HTTP'),{status:response.status});
    const transfer=tick();blob=await response.blob();metric('media_transfer',tick()-transfer,{bytes:blob.size,variant});
   }finally{clearTimeout(deadline);}
   const expected=response.headers.get('x-content-sha256')||(variant==='original'?m.sha256:null),original=response.headers.get('x-original-sha256');
   if(!expected||variant!=='original'&&(original!==m.sha256||blob.type!=='image/jpeg')||variant==='original'&&m.size&&blob.size!==m.size)throw Error('MEDIA_INTEGRITY');
   const validate=tick(),hashBytes=await crypto.subtle.digest('SHA-256',await blob.arrayBuffer()),sha=[...new Uint8Array(hashBytes)].map(x=>x.toString(16).padStart(2,'0')).join('');
   if(sha!==expected)throw Error('MEDIA_HASH');metric('media_integrity',tick()-validate,{variant});
   if(epoch!==mediaEpoch||owner!==state?.client_scope)throw Error('MEDIA_CONTEXT_CHANGED');
   const value={url:URL.createObjectURL(blob),bytes:blob.size,key,created:Date.now(),started};displayCache.set(key,value);trimDisplayCache();return value;
  }
 })();displayCache.set(key,{pending:work});try{return await work;}catch(e){if(displayCache.get(key)?.pending===work)displayCache.delete(key);throw e;}
}
function trimDisplayCache(){let total=[...displayCache.values()].reduce((n,x)=>n+(x.bytes||0),0);
 for(const [k,v] of displayCache){if(total<=16000000)break;if(!v.url||[...document.querySelectorAll('img,video')].some(n=>n.src===v.url||n.poster===v.url))continue;URL.revokeObjectURL(v.url);displayCache.delete(k);total-=v.bytes;}}
function reviewMediumLoaded(id){return loadedReviewMedia.has((state?.client_scope||'memory')+':'+id);}
function markMediumLoaded(id){loadedReviewMedia.add((state?.client_scope||'memory')+':'+id);syncReviewControls();}
function syncReviewControls(){for(const b of document.querySelectorAll?.('[data-review]')||[]){const r=state?.reviews?.find(r=>r.id===b.dataset?.review);if(!r)continue;
 const i=matchingIntent('review',{request_id:r.id,review_version:r.version,artifact_sha:r.artifact_sha});b.disabled=busy()||!!i&&i.phase!=='REJECTED_NO_EFFECT'||!reviewMediumLoaded(r.media_id)||(r.source_media_id&&!reviewMediumLoaded(r.source_media_id));
 if(i&&i.phase!=='REJECTED_NO_EFFECT')b.textContent=intentText(i);
}}
function reviewInputReady(body){const r=state?.reviews?.find(r=>r.id===body.request_id);if(!r)return false;
 if(!reviewMediumLoaded(r.media_id)||(r.source_media_id&&!reviewMediumLoaded(r.source_media_id))){toast('Esperá a que cargue el medio de esta revisión.');return false;}
 if(body.decision==='APPROVED'&&r.stage==='IMAGE'&&r.contract_sha&&(!body.pose||!body.wand_hand)){toast('Indicá la orientación y la mano de la varita antes de aprobar.');return false;}
 if(body.decision==='APPROVED'&&r.stage==='VIDEO'&&(!body.full_playback||!body.source_comparison)){toast('Confirmá la reproducción y la comparación antes de aprobar.');return false;}
 return true;}
function mountImage(node,m,variant,library=false){
 if(node.dataset.previewBound)return;node.dataset.previewBound='true';const began=tick(),epoch=mediaEpoch;
 displayBytes(m,variant,{library}).then(value=>{
  if(!node.isConnected||epoch!==mediaEpoch)return;const image=document.createElement('img'),decodeStart=tick();image.alt=m.label||m.display_name||'Imagen de Lumi';image.decoding='async';image.width=m.width||m.dimensions?.width||360;image.height=m.height||m.dimensions?.height||640;
  image.onload=()=>{if(!node.isConnected||epoch!==mediaEpoch)return;node.dataset.previewState='READY';node.querySelector('[role="status"]')?.remove();metric('media_decode_mount',tick()-decodeStart,{variant});metric('first_preview',tick()-began,{variant,bytes:value.bytes});if(!library&&variant!=='thumb')markMediumLoaded(m.id);};
  image.onerror=()=>mediaFailure(node,Error('MEDIA_DECODE'));node.append(image);image.src=value.url;
 }).catch(e=>{if(epoch===mediaEpoch)mediaFailure(node,e);});
}
function mediaFailure(node,e){if(!node.isConnected)return;node.dataset.previewState='FAILED';node.replaceChildren();const p=document.createElement('p');p.setAttribute('role','alert');p.textContent=safeMediaError(e);const b=document.createElement('button');b.className='button secondary';b.textContent='Reintentar lectura';b.onclick=()=>{node.dataset.previewBound='';node.dataset.observed='';node.replaceChildren();node.dataset.previewState='LOADING';hydrateStudioMedia();hydrateLibraryMedia();};node.append(p,b);metric('media_error',0,{code:/^[A-Z_]+$/.test(e.message)?e.message:'READ_FAILED',status:e.status??null});}
function observeImage(node,load){if(node.style)node.style.aspectRatio=Number(node.dataset.width||9)+'/'+Number(node.dataset.height||16);if(node.dataset.observed)return;node.dataset.observed='true';
 if(node.dataset.priority==='true'||typeof IntersectionObserver==='undefined'){load();return;}
 visibleObserver??=new IntersectionObserver(entries=>{for(const e of entries)if(e.isIntersecting){visibleObserver.unobserve(e.target);e.target.__loadPreview?.();}},{rootMargin:'120px'});
 node.__loadPreview=load;visibleObserver.observe(node);
}
function hydrateStudioMedia(){
 for(const node of document.querySelectorAll?.('[data-media-id]')||[]){const m=state.media.find(x=>x.id===node.dataset?.mediaId);if(m)observeImage(node,()=>mountImage(node,m,node.dataset.variant));}
 for(const m of document.querySelectorAll?.('[data-native-media]')||[]){if(!m.dataset||m.dataset.previewBound)continue;m.dataset.previewBound='true';m.addEventListener('loadeddata',()=>markMediumLoaded(m.dataset.nativeMedia),{once:true});m.addEventListener('error',()=>{metric('media_error',0,{code:'NATIVE_MEDIA_ERROR'});if(m.dataset.renewed)return;m.dataset.renewed='true';request('/media/'+m.dataset.nativeMedia+'/access').then(a=>{const at=m.currentTime;m.src=a.url;m.addEventListener('loadedmetadata',()=>{m.currentTime=at;},{once:true});}).catch(()=>toast('No se pudo renovar el acceso al medio.'));},{once:true});}
}
const libraryMedia=new Map();
function libraryPreview(a){const full=libraryOpened===a.asset_id,variant=full?'preview':'thumb';return `<div class="media-frame library-preview ${full?'':'thumbnail'}" data-library-preview="${a.asset_id}" data-preview-state="LOADING" data-variant="${variant}" data-priority="${full?'true':'false'}" data-width="${Number(a.dimensions?.width)||9}" data-height="${Number(a.dimensions?.height)||16}"><p role="status">Preparando preview privado…</p></div>${full?`<button class="text-link" data-library-download="${a.asset_id}">Abrir o descargar original</button>`:''}${full&&a.approval_reference.scope==='WHOLE_IMAGE_CONTEXT_REFERENCE'?'<p>Referencia de la escena completa; no es un modelo aislado.</p>':''}`;}
function clearLibraryMedia(){publicationUI?.clear();publicationEdits.clear();mediaEpoch++;libraryFetchedAt=0;libraryLoading=false;libraryError='';libraryOpened=null;libraryQuery='';resetNavigation();for(const v of displayCache.values())if(v.url)URL.revokeObjectURL(v.url);displayCache.clear();libraryMedia.clear();loadedReviewMedia.clear();visibleObserver?.disconnect();}
async function libraryMediaUrl(a,{renew=false,poster=false}={}){
 if(a.media_type==='video/mp4'&&!poster)return (await request('/library/access/'+a.asset_id)).media.media_url;
 return (await displayBytes(a,poster?'thumb':libraryOpened===a.asset_id?'preview':'thumb',{library:true})).url;
}
function hydrateLibraryMedia(){for(const node of document.querySelectorAll?.('[data-library-preview]')||[]){
 const a=libraryData?.assets.find(a=>a.asset_id===node.dataset.libraryPreview);if(!a)continue;
 if(a.media_type==='video/mp4'&&node.dataset.variant==='preview'){
  if(node.dataset.previewBound)continue;node.dataset.previewBound='true';const epoch=mediaEpoch;
  libraryMediaUrl(a).then(url=>{if(!node.isConnected||epoch!==mediaEpoch)return;const m=document.createElement('video');m.controls=true;m.playsInline=true;m.preload='metadata';m.addEventListener('loadedmetadata',()=>{node.dataset.previewState='READY';node.querySelector('[role="status"]')?.remove();},{once:true});m.addEventListener('error',()=>mediaFailure(node,Error('MEDIA_DECODE')),{once:true});node.append(m);m.src=url;}).catch(e=>{if(epoch===mediaEpoch)mediaFailure(node,e);});
 }else observeImage(node,()=>mountImage(node,a,node.dataset.variant,true));
}}
const libraryGroups={Personajes:['CHARACTER_REFERENCE'],Escenarios:['SCENE_REFERENCE','BACKGROUND'],Objetos:['OBJECT_REFERENCE'],Imágenes:['APPROVED_IMAGE'],Clips:['APPROVED_VIDEO'],Masters:['MASTER']};
const reuseLabels={REFERENCE_REUSE:'Preparar referencia',DIRECT_MEDIA_REUSE:'Usar archivo existente',DERIVED_ASSET:'Planificar derivado'};
async function loadLibrary({reuse=false}={}){
 if(libraryLoading||!csrf)return;
 // Only navigation reuses this short-lived presentation cache. Explicit
 // refreshes, mutation receipts and action validation always read the server.
 if(reuse&&libraryData&&Date.now()-libraryFetchedAt<30000)return;
 const epoch=mediaEpoch,owner=state?.client_scope,current=()=>epoch===mediaEpoch&&owner===state?.client_scope&&!!csrf;
 libraryLoading=true;libraryError='';if(['biblioteca','videos'].includes(tab))render();
 try{const data=await request('/library');if(!current())return;libraryData=data;libraryFetchedAt=Date.now();
  for(const i of Object.values(uiIntents)){if(i.owner!==owner||!pendingIntent(i))continue;const r=libraryData.selections?.find(r=>i.kind==='library_apply'?r.selection_id===i.request_id:i.kind==='library_selection'&&r.asset_id===i.asset_id&&r.mode===i.mode&&r.target_episode_id===i.target_episode_id&&r.target_shot_id===i.target_shot_id);if(r&&(i.kind==='library_selection'||['APPLIED_APPROVED','APPLIED_REFERENCE','APPLIED_AWAITING_HUMAN_REVIEW','AWAITING_HUMAN_REVIEW'].includes(r.status)))changeIntent(i,'DONE');}
 }catch(e){if(!current())return;if(e.status===401){csrf=null;authScreen(errorText(e));}else libraryError=errorText(e);}
 finally{if(current()){libraryLoading=false;if(['biblioteca','videos'].includes(tab))render();}}
}
function autoLibraryPlan(){
 const shot=state?.production?.shots?.find(s=>s.current)?.id;if(!shot||!csrf||!['inicio','produccion'].includes(tab)||libraryPlanLoading)return;
 const key=[state.episode.id,shot,state.episode.checkpoint_version].join(':');if(key===libraryPlanKey)return;libraryPlanKey=key;loadLibraryPlan(state.episode.id,shot);
}
async function loadLibraryPlan(episode,shot){if(libraryPlanLoading)return;libraryPlanLoading=true;try{const plan=await request('/library/plan?episode='+encodeURIComponent(episode)+'&shot='+encodeURIComponent(shot));
 if(state?.episode.id===episode&&state.production?.shots?.some(s=>s.current&&s.id===shot)&&plan.checkpoint_revision===state.episode.checkpoint_version)libraryPlan=plan;
 if(tab==='produccion')render();}catch(e){toast(errorText(e));}finally{libraryPlanLoading=false;}}
async function downloadLibraryOriginal(id){try{const {media}=await request('/library/access/'+id),a=document.createElement('a');a.href=media.media_url+'&download=1';a.download='Lumi-'+media.sha256.slice(0,12)+(media.media_type==='video/mp4'?'.mp4':'.png');document.body.append(a);a.click();a.remove();}catch(e){toast(errorText(e));}}

function plannerLibraryCard(){const shot=state.production?.shots?.find(s=>s.current)?.id;if(!shot)return '';
 const plan=libraryPlan?.episode_id===state.episode.id&&libraryPlan?.shot_id===shot?libraryPlan:null;
 return `<section class="card"><h3>Recursos para esta toma</h3><p>Lumi compara los recursos aprobados con el contrato de esta toma. Vos confirmás la aplicación.</p><button class="text-link" data-library-plan="${esc(state.episode.id)}" data-shot="${esc(shot)}">Consultar Biblioteca ↗</button>${plan?`<p>${plan.status==='RUNNING'?'La aplicación requiere tu confirmación.':'Episodio bloqueado: consulta disponible, aplicación deshabilitada.'}</p>${plan.suggestions.filter(s=>s.compatibility.status==='COMPATIBLE').map(s=>`<div class="saved-selection"><strong>${esc(s.asset.display_name)}</strong><small>${esc(reuseLabels[s.mode])} · Compatible${plan.recommendation?.asset_id===s.asset.asset_id&&plan.recommendation?.mode===s.mode?' · Recomendada':''}</small><small>${s.mode==='REFERENCE_REUSE'?'Referencia visual compatible; crear la escena conserva su costo.':'Coinciden narrativa, continuidad, formato y duración del contrato.'}</small><small>Ahorro potencial: ${usd(s.expected_cost_impact.potential_saving_usd)}</small><small>Ahorro verificado: Sin acreditar</small><button class="text-link" data-library-use="${s.asset.asset_id}" data-mode="${s.mode}" ${plan.status!=='RUNNING'?'disabled':''}>Seleccionar recurso</button></div>`).join('')||'<p>No encontramos un recurso compatible acreditado.</p>'}${plan.preparation?`<details><summary>Preparación del episodio · solo lectura</summary><p>Voz: ${esc(plan.preparation.voice_name||"Perfil aprobado pendiente de verificar")}. Entrega: ${esc(plan.preparation.assembly_contract?.width)} × ${esc(plan.preparation.assembly_contract?.height)}.</p>${plan.preparation.shots.map(s=>`<p><strong>${esc(s.shot_id)} · ${s.duration} s</strong><br>${esc(s.goal)}<br>${s.narration.map(n=>esc(n.text)).join(' ')}${s.response_window_seconds?`<br>Pausa real: ${s.response_window_seconds} s`:''}</p>`).join('')}<p>Voz, sincronización, subtítulos, montaje y master conservan sus dependencias y revisiones. Esta consulta no ejecuta etapas.</p></details>`:''}${plan.applications.map(a=>`<p>${esc(reuseLabels[a.reuse_mode])}: ${esc(a.application_status)}. Ahorro verificado: ${usd(a.expected_cost_impact.verified_saving_usd)}</p>`).join('')}`:''}</section>`;
}
async function applyLibrarySelection(selectionId){
 if(librarySaving)return;
 try{const resolved=await request('/library/selections/'+selectionId);libraryResolved=resolved;
  if(!resolved.application&&resolved.target_status!=='RUNNING'||resolved.compatibility.status!=='COMPATIBLE')return toast('El destino no está listo o el recurso no es compatible. Se conserva el borrador.');
  document.querySelector('#dialog-title').textContent='Aplicar recurso al episodio';
  document.querySelector('#dialog-content').innerHTML=`<p>${esc(resolved.media.display_name)} → ${esc(resolved.contract.target_episode_id)} · ${esc(resolved.contract.target_shot_id)}</p><p>${resolved.contract.mode==='REFERENCE_REUSE'?'Usará esta referencia junto a Lumi canónica. La generación posterior conserva su costo y autorización.':'Usará el medio sin una nueva generación. El destino tendrá su propia revisión humana.'}</p><label class="check"><input type="checkbox" id="reuse-confirm">Confirmo narrativa, continuidad visual y derechos de uso para este destino.</label>${!resolved.application&&resolved.contract.mode==='DERIVED_ASSET'&&resolved.media.media_type==='video/mp4'?'<label class="library-field">Inicio del recorte de video, en segundos<input id="reuse-start" type="number" min="0" step="0.001" value="0"></label><p>Derivación local de video. Conserva el original y requiere nueva aprobación.</p>':''}`;
  if(!resolved.application&&resolved.contract.mode==='DERIVED_ASSET'&&resolved.media.media_type!=='video/mp4')document.querySelector('#dialog-content').innerHTML+=['x','y','width','height'].map(k=>`<label class="library-field">${({x:'Izquierda',y:'Arriba',width:'Ancho',height:'Alto'})[k]} (px)<input id="reuse-${k}" type="number" min="0" value="${k==='width'?resolved.media.dimensions.width:k==='height'?resolved.media.dimensions.height:0}"></label>`).join('');
  const b=document.querySelector('#dialog-confirm');b.textContent='Confirmar aplicación';b.disabled=false;b.onclick=async()=>{
   if(librarySaving||!document.querySelector('#reuse-confirm').checked)return;
   const prior=matchingIntent('library_apply',{request_id:selectionId});if(prior&&prior.phase!=='REJECTED_NO_EFFECT'){b.disabled=true;b.textContent=intentText(prior);await loadLibrary();return;}const intent=beginIntent('library_apply',{request_id:selectionId});librarySaving=true;b.disabled=true;b.textContent='Guardando aplicación…';
   try{const body={expected_revision:resolved.checkpoint_revision,confirmation:{decision:'APPLY',narrative:true,continuity:true,rights:true}};
    if(resolved.contract.mode==='DERIVED_ASSET'){if(resolved.derivation)body.derivation=resolved.derivation;else if(resolved.media.media_type==='video/mp4'){const plan=await request('/library/targets'),target=plan.targets.find(t=>t.episode_id===resolved.contract.target_episode_id),shot=target?.shots.find(s=>s.shot_id===resolved.contract.target_shot_id);body.derivation={kind:'TRIM_VIDEO',start_seconds:Number(document.querySelector('#reuse-start').value),duration:shot?.duration};}else body.derivation={kind:'CROP_IMAGE',...Object.fromEntries(['x','y','width','height'].map(k=>[k,Number(document.querySelector('#reuse-'+k).value)]))};}
    await request('/library/selections/'+selectionId+'/apply',{method:'POST',body});changeIntent(intent,'DONE');dialog.close();await loadLibrary();await refresh();toast('Aplicación guardada. Se conservan las revisiones obligatorias.');
   }catch(e){changeIntent(intent,e.no_effect?'REJECTED_NO_EFFECT':'UNKNOWN');toast(errorText(e));}finally{librarySaving=false;b.disabled=intent.phase!=='REJECTED_NO_EFFECT';b.textContent=intentText(intent);}
  };dialog.showModal();
 }catch(e){toast(errorText(e));}
}
function libraryPage(){
 const items=(libraryData?.assets||[]).filter(a=>libraryGroups[libraryCategory].includes(a.asset_type)&&[a.display_name,a.description,...a.continuity_tags].join(' ').toLocaleLowerCase().includes(libraryQuery.toLocaleLowerCase()));
 return `<section class="page-intro"><span class="eyebrow">EL MUNDO DE LUMI</span><h1>Crear una vez.<br>Volver a imaginar.</h1><p>Recursos aprobados para conservar la identidad y aprovechar lo que ya creaste.</p></section><div class="library-toolbar"><button class="text-link" data-library-refresh ${libraryLoading?'disabled aria-busy="true"':''}>${libraryLoading?'Actualizando…':'Actualizar catálogo ↻'}</button><button class="text-link" data-library-sync>Buscar nuevas aprobaciones</button></div><div class="library-tabs" role="group" aria-label="Tipo de recurso">${Object.entries(libraryGroups).map(([label,types])=>`<button data-library-category="${label}" class="${label===libraryCategory?'selected':''}" aria-pressed="${label===libraryCategory}">${label} <span>${types.reduce((n,t)=>n+(libraryData?.counts[t]||0),0)}</span></button>`).join('')}</div><label class="library-search">Buscar recurso<input id="library-search" type="search" placeholder="Nombre, personaje o continuidad" value="${esc(libraryQuery)}"></label>${libraryError?`<p class="alert">${esc(libraryError)}</p>`:''}${!libraryData?`<div class="empty"><p role="status">${libraryLoading?'Cargando recursos privados…':'El catálogo todavía no está disponible.'}</p></div>${libraryLoading?loadingSkeleton():''}`:items.length?`<div class="asset-list">${items.map(libraryCard).join('')}</div>`:'<section class="empty"><span class="symbol">✦</span><h3>Aún no hay recursos en esta categoría</h3><p>Solo se incluyen archivos presentes en este entorno. No se generan recursos al abrir la Biblioteca.</p></section>'}${librarySelections()}<p class="footer-note">Originales conservados · Versiones inmutables · Acceso privado</p>`;
}
function libraryCard(a){return `<article class="card asset-card"><div class="progress-heading"><span class="tag ${a.reusable?'green':'gold'}">${a.reusable?'Aprobado por vos':a.reuse_policy.discovery?.lifecycle.includes('REJECTED')?'Rechazado':'Pendiente de verificación'}</span><span class="asset-version">V${a.version}</span></div><h2>${esc(a.display_name)}</h2><p>${esc(a.description)}</p><div class="asset-spec">${a.dimensions.width} × ${a.dimensions.height}${a.duration?' · '+a.duration+' s':''} · ${a.media_type==='video/mp4'?'VIDEO':'IMAGEN'}</div><button class="button secondary" data-library-view="${a.asset_id}">${libraryOpened===a.asset_id?'Cerrar recurso':'Ver recurso'}</button>${libraryPreview(a)}<button class="button secondary" data-library-download="${a.asset_id}">Descargar original</button><details class="asset-provenance"><summary>Origen, aprobación y versión</summary>${row('Episodio',esc(a.source_episode_id))}${row('Toma',esc(a.source_shot_id||'Master'))}${row('Versión',String(a.version))}${a.reuse_policy.discovery?`<p>${a.reuse_policy.discovery.lifecycle.includes('REJECTED')?'Recurso rechazado.':a.reusable?'Recurso aprobado, identificado mediante su contrato.':'Candidato detectado; falta aprobación humana.'}</p>`:''}${row('Reutilizable',a.reusable?'Sí, según la política del recurso':'No, falta verificar aprobación')}<p>Aprobación: ${esc(a.approval_reference.source)}</p><p>Alcance: ${a.approval_reference.scope==='WHOLE_IMAGE_CONTEXT_REFERENCE'?'Referencia contextual en la imagen completa':'Archivo original'}</p><p>SHA-256</p><code>${esc(a.sha256)}</code>${a.continuity_tags.length?`<p>Continuidad: ${esc(a.continuity_tags.join(' · '))}</p>`:''}${a.canonical_reference?`<p>Referencia canónica</p><code>${esc(a.canonical_reference.sha256)}</code>`:''}</details>${a.reuse_policy.modes.map(mode=>`<button class="button ${mode==='DERIVED_ASSET'?'quiet':'primary'}" data-library-use="${a.asset_id}" data-mode="${mode}">${reuseLabels[mode]}</button>`).join('')}</article>`;}
function librarySelections(){const selections=libraryData?.selections||[];return selections.length?`<section class="card"><h3>Selecciones guardadas</h3><p>Contratos de preparación. La producción conserva su estado actual.</p>${selections.map(s=>`<div class="saved-selection"><strong>${esc(s.target_episode_id)} · ${esc(s.target_shot_id)}</strong><small>${esc(reuseLabels[s.mode])} · ${s.status==='DRAFT_NOT_APPLIED'?'Borrador':'Aplicado'}</small><button class="text-link" data-library-resolve="${s.selection_id}">Ver contrato y recurso ↗</button><button class="text-link" data-library-apply="${s.selection_id}">${s.status==='DRAFT_NOT_APPLIED'?'Revisar y aplicar':'Recuperar aplicación'}</button></div>`).join('')}${libraryResolved?`<div class="library-contract"><h3>Recurso listo para reutilizar</h3><p>${libraryResolved.contract.mode==='DIRECT_MEDIA_REUSE'?'El enlace entrega los mismos bytes aprobados, sin regeneración.':libraryResolved.contract.mode==='REFERENCE_REUSE'?'La referencia conserva la identidad. Crear contenido nuevo requiere cotización y autorización.':'El derivado necesitará un archivo nuevo y una aprobación propia.'}</p><a class="button secondary" href="${esc(libraryResolved.media.media_url)}&download=1" download>Descargar original aprobado</a><details><summary>Ver contrato</summary><pre>${esc(JSON.stringify(libraryResolved.contract,null,2))}</pre></details></div>`:''}</section>`:'';}
async function prepareLibraryReuse(asset,mode){
 try{libraryTargets=(await request('/library/targets')).targets;}catch{libraryTargets=[];}
 document.querySelector('#dialog-title').textContent=reuseLabels[mode];
 document.querySelector('#dialog-content').innerHTML=`<p>${esc(asset.display_name)} · V${asset.version}</p><datalist id="library-targets">${libraryTargets.map(t=>`<option value="${esc(t.episode_id)}">${esc(t.title)}</option>`).join('')}</datalist><label class="library-field">Episodio de destino<input id="library-target-episode" maxlength="100" placeholder="ep005" value="${esc(tab==='produccion'?state.episode.id:'')}" list="library-targets"></label><label class="library-field">ID de la toma<input id="library-target-shot" maxlength="100" placeholder="s01" value="${esc(tab==='produccion'?state.production?.shots?.find(s=>s.current)?.id:'')}"></label><p>${mode==='REFERENCE_REUSE'?'Usar esta referencia en una nueva generación tiene costo y requiere autorización.':mode==='DIRECT_MEDIA_REUSE'?'Reutiliza el archivo original aprobado. No requiere una nueva generación.':'Planifica un derivado; crear y aprobar ese nuevo recurso será un paso separado.'} Guardamos un contrato en borrador para el destino indicado. No inicia ni cambia su producción.</p>`;
 const b=document.querySelector('#dialog-confirm');b.textContent='Guardar selección';b.disabled=false;b.onclick=async()=>{
   if(librarySaving)return;
   const body={asset_id:asset.asset_id,mode,target_episode_id:document.querySelector('#library-target-episode').value.trim(),target_shot_id:document.querySelector('#library-target-shot').value.trim()};
   if(!/^[A-Za-z0-9_-]{1,100}$/.test(body.target_episode_id)||!/^[A-Za-z0-9_-]{1,100}$/.test(body.target_shot_id)){toast('Completá el episodio y la toma con identificadores válidos.');return;}
   const key=JSON.stringify(body),prior=matchingIntent('library_selection',{request_id:key});if(prior&&prior.phase!=='REJECTED_NO_EFFECT'){b.disabled=true;b.textContent=intentText(prior);await loadLibrary();return;}
   const intent=beginIntent('library_selection',{request_id:key});Object.assign(intent,body);writeIntents();librarySaving=true;b.disabled=true;b.textContent='Guardando selección…';
   try{const saved=await request('/library/selections',{method:'POST',body});changeIntent(intent,'DONE');libraryResolved=await request('/library/selections/'+saved.selection_id);dialog.close();await loadLibrary();toast('Selección guardada. Recurso original verificado.');}
   catch(e){if(intent.phase!=='DONE')changeIntent(intent,e.no_effect?'REJECTED_NO_EFFECT':'UNKNOWN');toast(errorText(e));}
   finally{librarySaving=false;b.disabled=intent.phase!=='REJECTED_NO_EFFECT';b.textContent=intentText(intent);}
 };dialog.showModal();
}
document.addEventListener('click',async e=>{
 const t=e.target.closest('[data-library-category],[data-library-refresh],[data-library-sync],[data-library-view],[data-library-use],[data-library-resolve],[data-library-retry],[data-library-apply],[data-library-plan],[data-library-download]' );if(!t)return;
 if(t.dataset.libraryDownload)return downloadLibraryOriginal(t.dataset.libraryDownload);
 if(t.dataset.libraryRetry){const a=libraryData.assets.find(a=>a.asset_id===t.dataset.libraryRetry);if(!a)return;const old=libraryMedia.get(a.sha256);if(old?.url)URL.revokeObjectURL(old.url);libraryMedia.delete(a.sha256);const poster=libraryMedia.get(a.sha256+':poster');if(poster?.url)URL.revokeObjectURL(poster.url);libraryMedia.delete(a.sha256+':poster');render();return;}
 if(t.dataset.libraryApply)return applyLibrarySelection(t.dataset.libraryApply);
 if(t.dataset.libraryPlan)return loadLibraryPlan(t.dataset.libraryPlan,t.dataset.shot);
 if(t.dataset.libraryCategory){libraryCategory=t.dataset.libraryCategory;libraryOpened=null;render();return;}
 if(t.hasAttribute('data-library-refresh'))return loadLibrary();
 if(t.hasAttribute('data-library-sync')){if(libraryLoading)return;t.disabled=true;try{await request('/library/sync',{method:'POST',body:{}});await loadLibrary();toast('Catálogo reconciliado con las aprobaciones guardadas.');}catch(e){toast(errorText(e));}finally{t.disabled=false;}return;}
 if(t.dataset.libraryView){libraryOpened=libraryOpened===t.dataset.libraryView?null:t.dataset.libraryView;render();return;}
 if(t.dataset.libraryUse){const a=libraryData?.assets.find(a=>a.asset_id===t.dataset.libraryUse)||libraryPlan?.suggestions.find(s=>s.asset.asset_id===t.dataset.libraryUse)?.asset;if(a)prepareLibraryReuse(a,t.dataset.mode);return;}
 if(t.dataset.libraryResolve){try{libraryResolved=await request('/library/selections/'+t.dataset.libraryResolve);render();}catch(e){toast(errorText(e));}}
});
document.addEventListener('input',e=>{if(e.target.id==='library-search'){const pos=e.target.selectionStart;libraryQuery=e.target.value;render();const n=document.querySelector('#library-search');n.focus();if(pos!==null)n.setSelectionRange?.(pos,pos);}});
navigation();login();
