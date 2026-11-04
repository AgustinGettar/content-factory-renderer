import {viewModel,fmtUSD,fmtDate,reasonText,escapeHTML as h} from './model.js';
// The private site MUST serve the UI and the API under the same origin.
const API='/api/monitor/live',root=document.querySelector('#content'),status=document.querySelector('#status'),nav=document.querySelector('#nav');
let tab='resumen',model=null,updating=false,backoff=2000,nextRetry=0,source=null,readError=null;
const signed=x=>fmtUSD(x,{signed:true});
const tone=x=>x==null?'neutral':Number(x)>0?'good':Number(x)<0?'bad':'neutral';
const present=x=>x===null||x===undefined||x===''?'—':String(x);
const section=(title,body,description='')=>`<section class="section"><h2>${h(title)}</h2>${description?`<p>${h(description)}</p>`:''}${body}</section>`;
const box=(name,value,desc='',css='')=>`<div class="card ${css}"><label>${h(name)}</label><strong class="${tone(value)}">${h(value)}</strong>${desc?`<small>${h(desc)}</small>`:''}</div>`;
const hUSD=x=>h(fmtUSD(x)),hSigned=x=>h(signed(x));
function position(p){
 return `<article class="position"><div class="poshead"><strong class="name">BTC/USD · ${h(p.timeframe)}</strong><span class="side ${p.side==='SHORT'?'short':'long'}">${p.side==='SHORT'?'↓ Venta':p.side==='LONG'?'↑ Compra':'Dirección no disponible'}</span></div>
 <div class="small-label">Resultado abierto neto estimado</div><strong class="bigresult ${tone(p.net)}">${hSigned(p.net)}</strong>
 <p class="pattern">${h(p.pattern)}</p>${p.net==null?'<div class="hint">No hay valoración neta final verificable para esta posición.</div>':''}
 <details data-detail="pos-${h(p.id)}"><summary>Ver entrada, objetivo y protección</summary><div class="details-grid">
 <div><label>Entrada</label><strong>${h(present(p.entry))}</strong></div><div><label>Stop loss</label><strong>${h(present(p.stop))}</strong></div>
 <div><label>Objetivo</label><strong>${h(present(p.target))}</strong></div><div><label>Apalancamiento simulado</label><strong>${h(present(p.leverage))}×</strong></div>
 <div><label>Máxima excursión neta</label><strong>${hSigned(p.maxFavourable)}</strong></div><div><label>Piso de protección</label><strong>${hSigned(p.protectedFloor)}</strong></div>
 </div><p>Los precios pueden ejecutarse con deslizamiento. No se garantiza cerrar exactamente en el piso indicado.</p>
 ${p.exitReason?`<p>Estado de ejecución: ${h(reasonText(p.exitReason))}</p>`:''}</details></article>`;
}
function timeframes(m){return `<div>${m.frames.map(f=>`<article class="frame"><div class="frame-head"><div class="tf">${f.tf}</div><div class="frame-text"><strong>${h(f.regime)} ${f.stale?'<span class="stale-flag">Por actualizar</span>':''}</strong><small>Última evaluación: ${h(fmtDate(f.lastAt))}</small></div></div><div class="frame-note">${h(f.reason)}</div></article>`).join('')}</div>`;}
function research(m){const s=m.shadow;
 const explanation=s?`${s.status==='CANDIDATE'?'Hipótesis detectada, sin orden simulada automática.':'Sin entrada experimental aprobada.'} ${reasonText(s.reason)}`:'El nuevo observador aún no publicó una lectura de 5m.';
 return `<div class="panel"><strong>Scalping experimental · solo observación</strong><p>${h(explanation)}</p><p>No modifica posiciones, stop loss, capital ni apalancamiento. Las hipótesis no equivalen a operaciones rentables.</p></div>`;}
function summary(m){const f=m.metrics;
 const cards=`<div class="grid"><div class="card hero"><label>Patrimonio ficticio</label><strong>${hUSD(f.equity)}</strong><small>Valor de la cartera secundaria PAPER; no representa una ganancia.</small></div>
 <div class="card"><label>Resultado registrado de cierres</label><strong class="${tone(f.realized)}">${hSigned(f.realized)}</strong><small>${f.realizedFinal?'Resultado realizado':'Resultado sujeto a conciliación'}</small></div>
 <div class="card"><label>Resultado abierto estimado</label><strong class="${tone(f.unrealized)}">${hSigned(f.unrealized)}</strong><small>${f.unrealized===null?'Valoración incompleta':'No cobrado · puede cambiar'}</small></div>
 <div class="card"><label>Posiciones abiertas</label><strong>${m.openCount}</strong><small>${m.pendingCount} órdenes pendientes</small></div></div>`;
 return cards+ (f.uncertainHistory?'<div class="note warn">El resultado realizado incluye operaciones históricas con calidad incierta. No interpretarlo como beneficio consolidado.</div>':'')+
 section('Posiciones ahora',m.positions.length?m.positions.map(position).join(''):'<div class="panel">No hay posiciones abiertas. Lumi continúa evaluando el mercado.</div>')+
 section('Evaluaciones por plazo',timeframes(m),'Verificamos cada temporalidad por separado; una evaluación no significa que se haya abierto una operación.')+
 section('Investigación',research(m))+
 section('Más información',`<div class="panel"><details data-detail="fin"><summary>Detalles económicos</summary><div class="details-grid">
 <div><label>Capital libre estimado</label><strong>${hUSD(f.cash)}</strong></div><div><label>Costes registrados</label><strong>${hUSD(f.costs)}</strong></div>
 <div><label>Neto total</label><strong>${f.total===null?'No verificable':hSigned(f.total)}</strong></div>
 <div><label>Origen</label><strong>Futuros PAPER</strong></div></div><p>Los aportes y las recargas ficticias no cuentan como ganancia.</p></details></div>`);
}
function operations(m){return section('Posiciones abiertas',m.positions.length?m.positions.map(position).join(''):'<div class="panel">Sin posiciones abiertas.</div>','Cada operación se presenta individualmente.')+
 section('Órdenes pendientes',`<div class="panel">${m.pendingCount} pendientes. Los controles de ejecución permanecen en la vista completa.</div>`)+
 section('Estado del mercado',timeframes(m));}
function activity(m){const history=m.recent.map(o=>`<article class="history"><div class="flex"><span class="name">${h(o.tf)} · ${o.side==='SHORT'?'↓ Venta':o.side==='LONG'?'↑ Compra':'Dirección no disponible'} · ${o.status==='CLOSED'?'Cerrada':o.status==='OPEN'?'Abierta':o.status==='PENDING'?'Pendiente':'No ejecutada'}</span>
 <strong class="${tone(o.recordedCloseNet)}">${o.status==='CLOSED'?hSigned(o.recordedCloseNet):'—'}</strong></div>
 <small>${h(fmtDate(o.at))}${o.status==='CLOSED'?' · Motivo: '+h(o.reason):''}</small>${o.status==='CLOSED'&&!o.closeIsFinal?'<div class="hint">Resultado registrado; liquidación final no comprobada.</div>':''}</article>`).join('');
 return section('Actividad reciente',history||'<div class="panel">No hay operaciones recientes en esta muestra.</div>','Las posiciones abiertas nunca se contabilizan como cierres.')+
 section('Observador de scalping',research(m));}
function draw(){if(!model)return;
 if(source)model=viewModel(source);
 const open=new Set([...root.querySelectorAll('details[open]')].map(el=>el.dataset.detail));
 root.innerHTML=({resumen:summary,operaciones:operations,actividad:activity})[tab](model);
 root.querySelectorAll('details[data-detail]').forEach(el=>{el.open=open.has(el.dataset.detail);});
 nav.querySelectorAll('button[data-view]').forEach(b=>{const active=b.dataset.view===tab;b.classList.toggle('active',active);b.setAttribute('aria-current',active?'page':'false');});
 updateStatus();
}
function updateStatus(){
 if(readError){status.className='status warn';status.textContent=readError;return;}
 if(!source)return;
 model=viewModel(source);
 const labels={LIVE_PAPER:['ok','Motor y mercado actualizados'],STALE_SNAPSHOT:['warn','Datos no recientes'],WORKER_UNVERIFIED:['warn','Motor sin latido confirmado'],MARKET_ISSUE:['error','Datos de mercado no fiables']};
 const [state,label]=labels[model.status]??['pending','Sin estado'];
 status.className='status '+state;status.textContent=label+' · '+fmtDate(model.asOf);
}
nav.addEventListener('click',e=>{const target=e.target.closest('button[data-view]');if(!target)return;tab=target.dataset.view;draw();});
async function poll(){if(updating||document.hidden||Date.now()<nextRetry)return;updating=true;
 try{const res=await fetch(API,{credentials:'same-origin',redirect:'error',cache:'no-store',headers:{Accept:'application/json'},signal:AbortSignal.timeout(9000)});
  if(res.status===401||res.status===403){source=null;model=null;readError='Acceso privado vencido. Abrí el monitor desde Telegram.';root.innerHTML='<div class="panel">La sesión privada debe renovarse.</div>';updateStatus();nextRetry=Date.now()+20000;return;}
  if(!res.ok)throw new Error('MONITOR_HTTP_'+res.status);
  const payload=await res.json(),value=viewModel(payload);
  // Reject stale replays, but accept the latest source with equal revision.
  if(!model||value.revision==null||model.revision==null||value.revision>=model.revision&&Number(value.asOf??0)>=Number(model.asOf??0)){source=payload;model=value;readError=null;draw();}
  else {readError='La respuesta recibida es anterior a la última lectura.';updateStatus();}
  backoff=2000;nextRetry=0;
 }catch{nextRetry=Date.now()+backoff;backoff=Math.min(backoff*2,30000);readError='No se pudo actualizar. Se conserva la última lectura.';updateStatus();}
 finally{updating=false;}}
setInterval(poll,2000);setInterval(updateStatus,1000);document.addEventListener('visibilitychange',()=>{if(!document.hidden){nextRetry=0;void poll();}});
window.addEventListener('online',()=>{nextRetry=0;void poll();});void poll();
