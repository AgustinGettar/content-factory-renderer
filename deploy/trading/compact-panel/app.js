import {viewModel,fmtUSD,fmtDate,escapeHTML as h,reasonText} from './model.js';
const $=s=>document.querySelector(s),root=$('#content'),topStatus=$('#status'),nav=$('#nav');
const API='/api/monitor/live'; // existing owner-private, same-origin read endpoint
let view='resumen',last=null,busy=false,backoff=2000,nextAttempt=0;
const plus=v=>fmtUSD(v,{signed:true});
const money=v=>fmtUSD(v);
const tone=v=>v==null?'muted':Number(v)>0?'gain':Number(v)<0?'loss':'neutral';
const value=(v,c='')=>'<strong class="'+c+'">'+h(v)+'</strong>';
const notAvailable='<span class="muted">No disponible</span>';
const tooltip=(heading,copy)=>'<span class="hint" aria-label="'+h(heading+': '+copy)+'" title="'+h(copy)+'">i</span>';
function summary(m){
 const x=m.metrics;
 return `<section class="kpis" aria-label="Resumen de la cartera">
  <article class="kpi kpi-main"><span>Patrimonio ficticio ${tooltip('Patrimonio','Valor estimado de la secundaria, no es ganancia.')}</span><strong>${h(money(x.equity))}</strong><small>Secundaria · solamente simulación</small></article>
  <article class="kpi"><span>Resultado realizado ${tooltip('Resultado realizado','Ganancia o pérdida registrada en operaciones cerradas; no incluye posiciones abiertas.')}</span><strong class="${tone(x.realized)}">${h(plus(x.realized))}</strong></article>
  <article class="kpi"><span>Resultado abierto ${tooltip('Resultado abierto','Estimación neta al precio de salida, puede cambiar.')}</span><strong class="${tone(x.unrealized)}">${h(plus(x.unrealized))}</strong><small>${x.unrealized==null?'Datos insuficientes para calcular':'Estimación, no cobrada'}</small></article>
  <article class="kpi"><span>Posiciones abiertas</span><strong>${m.openCount}</strong><small>${m.pendingCount} órdenes pendientes</small></article>
 </section>
 <section class="section"><h2>Ahora</h2>
  ${m.positions.length?m.positions.map(position).join(''):'<div class="empty">No hay posiciones abiertas. Lumi espera señales que cumplan las reglas.</div>'}
 </section>
 <section class="section"><h2>Evaluaciones por plazo</h2>
  <p class="subcopy">“Evaluación” no significa “operación abierta”.</p>${frameList(m)}
 </section>
 <section class="section advanced"><details><summary>Información financiera adicional</summary>
 <div class="detail-grid"><div>Disponible: ${h(money(x.cash))}</div>
 <div>Costes registrados: ${h(money(x.costs))}</div>
 <div>Neto total: ${x.totalFinal?h(plus(x.total)):notAvailable}</div></div>
 <p>El neto total combina resultado cerrado y abierto sólo cuando la valoración está completa. No confundas aportes de capital con beneficios.</p>
 </details></section>`;
}
function position(p){
 return `<article class="position">
  <header><span class="pair">${h(p.timeframe)} · BTC/USD</span><span class="side ${p.side==='SHORT'?'short':'long'}">${p.side==='SHORT'?'↓ Venta':'↑ Compra'}</span></header>
  <div class="position-top"><div><small>Resultado abierto neto</small><strong class="${tone(p.net)}">${h(plus(p.net))}</strong></div><small>${h(p.pattern)}</small></div>
  ${p.exitIntent?'<p class="warning">Salida solicitada: '+h(reasonText(p.exitIntent))+'</p>':''}
  <details><summary>Ver niveles y protección</summary><dl>
   <div><dt>Entrada</dt><dd>${h(p.entry??'—')}</dd></div><div><dt>Stop loss</dt><dd>${h(p.stop??'—')}</dd></div>
   <div><dt>Objetivo</dt><dd>${h(p.target??'—')}</dd></div><div><dt>Apalancamiento simulado</dt><dd>${h(p.leverage??'—')}×</dd></div>
   <div><dt>Máximo neto observado</dt><dd>${h(plus(p.peak))}</dd></div>
   <div><dt>Piso de protección</dt><dd>${h(plus(p.floor))}</dd></div>
  </dl><p>El piso de protección es un umbral estimado; una ejecución posterior puede cerrar por debajo de él.</p></details>
 </article>`;
}
function frameList(m){
 const order=['5m','15m','1h','4h'],frames=[...m.frames].sort((a,b)=>order.indexOf(a.timeframe)-order.indexOf(b.timeframe));
 if(!frames.length)return '<p class="empty">Todavía no hay lecturas verificadas de las temporalidades.</p>';
 return `<div class="frames">${frames.map(f=>`<div class="frame"><div class="frame-main"><strong>${h(f.timeframe)}</strong>
  <div><b>${h(reasonText(f.reason))}</b><small>${h(fmtDate(f.lastAt))}</small></div></div>
  ${f.shadow?`<details><summary>Scalping experimental</summary>
   <p>${f.shadow.status==='CANDIDATE'?'Hipótesis detectada (sin operar).':'Sin hipótesis aprobada ahora.'} · ${h(reasonText(f.shadow.reason))}</p>
   <small>Solo observa · no crea órdenes</small></details>`:''}</div>`).join('')}</div>`;
}
function operations(m){
 return `<section class="section"><h2>Posiciones abiertas</h2><p class="subcopy">Cada posición se gestiona de forma independiente.</p>
 ${m.positions.length?m.positions.map(position).join(''):'<div class="empty">Sin operaciones abiertas ahora.</div>'}
 </section><section class="section"><h2>Órdenes pendientes</h2><p class="empty">${m.pendingCount} órdenes pendientes. El detalle y los controles están en la vista completa.</p></section>`;
}
function activity(m){
 return `<section class="section"><h2>Actividad reciente</h2><p class="subcopy">El resultado mostrado es neto cuando existe un cierre registrado. Los datos ausentes no equivalen a cero.</p>
 ${m.recent.length?m.recent.map(r=>`<article class="history"><span class="pair">${h(r.timeframe)} · ${h(r.side)} · ${h(r.status)}</span>
 <strong class="${tone(r.net)}">${h(plus(r.net))}</strong><small>${h(fmtDate(r.at))}${r.reason?' · '+h(reasonText(r.reason)):''}</small></article>`).join(''):'<div class="empty">No hay operaciones recientes en esta muestra.</div>'}</section>
 <section class="section"><h2>Scalping experimental</h2><div class="empty">${m.shadow?'Última lectura: '+h(reasonText(m.shadow.reason)):'Aún no hay observaciones del nuevo módulo.'}
 <br>Es investigación, no una señal para invertir.</div></section>`;
}
function draw(){
 if(!last)return;
 const m=last,opened=new Set([...root.querySelectorAll('details[open]')].map((x,i)=>x.dataset.key??'detail-'+i));
 const sections={resumen:summary,operaciones:operations,actividad:activity};
 root.innerHTML=sections[view](m);
 [...root.querySelectorAll('details')].forEach((x,i)=>{x.dataset.key='detail-'+i;if(opened.has(x.dataset.key))x.open=true;});
 [...nav.querySelectorAll('button')].forEach(b=>{const yes=b.dataset.view===view;b.classList.toggle('active',yes);b.setAttribute('aria-current',yes?'page':'false');});
 const status=m.fresh&&m.status==='ACTIVE_PAPER'?'Datos recientes':m.status==='MARKET_ISSUE'?'Mercado con incidencia':'Datos no recientes';
 topStatus.className=m.fresh?'status':'status stale';
 topStatus.textContent=status+' · '+fmtDate(m.asOf);
 $('#full-view').href='/';
}
nav.addEventListener('click',e=>{const b=e.target.closest('button[data-view]');if(b){view=b.dataset.view;draw();window.scrollTo({top:0,behavior:'instant'});}});
async function poll(){
 if(busy||document.hidden||Date.now()<nextAttempt)return;
 busy=true;
 try{
  const r=await fetch(API,{credentials:'same-origin',cache:'no-store',headers:{Accept:'application/json'},redirect:'error',signal:AbortSignal.timeout(8000)});
  if(r.status===401||r.status===403){topStatus.textContent='Sesión privada vencida: abrí el panel desde Telegram';return;}
  if(!r.ok)throw Error('MONITOR_HTTP_'+r.status);
  const payload=await r.json(),model=viewModel(payload);
  // Do not replace a newer revision or a newer source timestamp with old data.
  if(!last||model.revision==null||last.revision==null||
    model.revision>=last.revision&&((model.asOf??0)>=(last.asOf??0))){
   last=model;draw();
  }
  backoff=2000;nextAttempt=0;
 }catch{
  nextAttempt=Date.now()+backoff;backoff=Math.min(30000,backoff*2);
  topStatus.className='status stale';
  topStatus.textContent='No pudimos actualizar; se conservan los últimos datos';
 }finally{busy=false;}
}
setInterval(poll,2000);
window.addEventListener('online',()=>{nextAttempt=0;void poll();});
document.addEventListener('visibilitychange',()=>{if(!document.hidden){nextAttempt=0;void poll();}});
void poll();
