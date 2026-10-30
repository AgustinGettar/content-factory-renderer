// Decision-time evidence, frozen with the plan. Never recomputed from future bars.
const keys=['start','end','open','high','low','close','volume'];
const pick=(b)=>Object.fromEntries(keys.map(k=>[k,Number(b[k])]));
const names={ema20:'EMA 20',ema50:'EMA 50',ema200:'EMA 200',mid:'Media Bollinger 20',lower:'Bollinger inferior',upper:'Bollinger superior'};
export function evidencePanel(tf,bars,lines){return {tf,candles:bars.slice(-80).map(pick),lines:lines.map(key=>({name:names[key]??key,points:bars.slice(-80).filter(b=>Number.isFinite(b[key])).map(b=>({at:b.start,value:b[key]}))}))};}
export function strategyEvidence(plan,{m15,h1,h4,ctx,rules}){
 const j=m15.at(-1),t=h1.at(-1),c=h4.at(-1),s=plan.setup;
 const facts=[{label:'Patrón',value:plan.family},{label:'Dirección',value:plan.direction},{label:'ATR del patrón',value:s.atr},
  {label:'ADX 4 h',value:c.adx},{label:'Umbral ADX de tendencia',value:rules.adxTrend},{label:'ADX 1 h',value:t.adx},
  {label:'Cuerpo / rango de confirmación',value:Math.abs(j.close-j.open)/(j.high-j.low||1)},
  {label:'ATR 15 min',value:j.atr},{label:'Distancia del stop / ATR patrón',value:Math.abs(plan.entry-plan.stop)/s.atr},
  {label:'Régimen vigente',value:plan.family==='C'?ctx.range:plan.family==='A'?(plan.direction==='LONG'?ctx.long:ctx.short):(plan.direction==='LONG'?ctx.breakLong:ctx.breakShort)}];
 const levels=Object.entries({ 'Mínimo del patrón':s.low,'Máximo del patrón':s.high,'Ruptura / retesteo':s.bound,'Canal superior':s.U,'Canal inferior':s.D,'Banda inferior del patrón':s.lower,'Centro del rango':s.mid,'Banda superior del patrón':s.upper }).filter(([,v])=>Number.isFinite(v)&&v>0&&v<1e9).map(([name,value])=>({name,value}));
 const descriptions={A:['Contexto 4 h: cierre y EMA 50 sobre/bajo EMA 200; pendiente de EMA 50 y ADX ≥ umbral.','Patrón 1 h: contacto con EMA 20 previa ±0,25 ATR; relación EMA 20/50 y cierre confirmados.','Confirmación 15 min: cierre rompe las dos velas previas, a favor de la dirección, con cuerpo ≥50 % del rango.','Stop: extremo del patrón ±0,25 ATR; distancia entre 0,75 y 3 ATR. Objetivo: 2 veces la distancia.'],B:['Contexto 4 h: cierre del lado de EMA 200 y pendiente EMA 50 compatibles.','Ruptura 1 h del canal de 20 velas por 0,1 ATR; anchura entre 2 y 8 ATR; volumen relativo ≥ umbral.','Retesteo 15 min dentro de ±0,2 ATR del nivel, con cierre y vela a favor. Invalidación al atravesar 0,25 ATR.','Stop: extremo del patrón ±0,25 ATR; distancia entre 0,5 y 3 ATR. Objetivo: 2 veces la distancia.'],C:['Rango: ADX de 1 h y 4 h <20; variación EMA 50 de 4 h / ATR <0,25.','Confirmación: perforación y recuperación de la banda; mecha ≥ cuerpo y vela a favor sin atravesar el centro.','Invalidación: se supera la banda por 0,75 ATR.','Stop: extremo de confirmación ±0,25 ATR; distancia entre 0,5 y 2 ATR. Objetivo: centro del rango.']};
 return {schema:1,at:plan.decision_at,default_tf:15,input_hash:plan.input_hash,closed_bars:true,
  panels:[evidencePanel(15,m15,[]),evidencePanel(60,h1,plan.family==='C'?['lower','mid','upper']:['ema20','ema50']),evidencePanel(240,h4,['ema50','ema200'])],levels,facts:[...facts,{label:'Umbral volumen relativo',value:rules.rvol},...(s.origin_facts??[])],rules:descriptions[plan.family]};
}
function recipePanel(recipe,bars){
 const panel=evidencePanel(recipe.tf,bars,[]);
 panel.lines=[recipe.fast,recipe.slow].map(n=>{
  let value=bars.slice(0,n).reduce((sum,b)=>sum+Number(b.close),0)/n;const points=[];
  for(let i=0;i<bars.length;i++){
   if(i>=n)value=2/(n+1)*Number(bars[i].close)+(1-2/(n+1))*value;
   if(i>=n-1&&i>=bars.length-80)points.push({at:bars[i].start,value});
  }
  return {name:'EMA '+n,points};
 });return panel;
}
export function laboratoryEvidence(plan,recipe,bars,computed,{fast,slow,atr,trend,trigger,costRoom,context}){
 const short=plan.direction==='SHORT',prior=bars.slice(0,-1),bound=short?Math.min(...prior.slice(-recipe.lookback).map(b=>+b.low)):Math.max(...prior.slice(-recipe.lookback).map(b=>+b.high));
 const result={schema:1,at:plan.decision_at,default_tf:recipe.tf,input_hash:plan.input_hash,closed_bars:true,
  panels:[recipePanel(recipe,bars)],levels:recipe.kind.includes('BREAKOUT')?[{name:(short?'Mínimo':'Máximo')+' previo de '+recipe.lookback+' velas',value:bound}]:[],
  facts:[{label:'EMA '+recipe.fast,value:fast},{label:'EMA '+recipe.slow,value:slow},{label:'ATR 14',value:atr},{label:'Tendencia',value:trend},{label:'Patrón confirmado',value:trigger},{label:'Beneficio / riesgo neto suficiente',value:costRoom},{label:'Stop en ATR',value:recipe.stopATR},{label:'Objetivo en ATR',value:recipe.targetATR}],
  rules:short?['Solo velas cerradas de '+recipe.tf+' minutos; EMA '+recipe.fast+' < EMA '+recipe.slow+' y cierre < EMA lenta.',recipe.kind==='BREAKOUT_OR_PULLBACK'?'Cierre bajo el mínimo de '+recipe.lookback+' velas O retroceso previo a EMA rápida y cierre bajista bajo ella.':recipe.kind==='BREAKOUT'?'Cierre < mínimo de las '+recipe.lookback+' velas anteriores.':'Máximo anterior ≥ EMA rápida anterior; cierre actual < EMA rápida y vela negativa.','Entrada: mínimo entre la vela y bid, menos un tick. Límite: entrada ×0,9995.','Stop: entrada +'+recipe.stopATR+' ATR. Objetivo: entrada −'+recipe.targetATR+' ATR.','Beneficio / riesgo ≥'+recipe.minNetRR+' tras costes de ejecución y financiación estimada.']:['Solo velas cerradas de '+recipe.tf+' minutos; EMA '+recipe.fast+' > EMA '+recipe.slow+' y cierre > EMA '+recipe.slow+'.',recipe.kind==='BREAKOUT_OR_PULLBACK'?'Cierre sobre el máximo de '+recipe.lookback+' velas O retroceso previo a EMA rápida y cierre alcista sobre ella.':recipe.kind==='BREAKOUT'?'Cierre > máximo de las '+recipe.lookback+' velas anteriores.':'Mínimo de la vela anterior ≤ EMA rápida anterior; cierre actual > EMA rápida y vela positiva.','Entrada: máximo entre la vela y ask, más un tick. Límite: entrada ×1,0005, redondeado al tick.','Stop: entrada −'+recipe.stopATR+' ATR. Objetivo: entrada +'+recipe.targetATR+' ATR.','Beneficio / riesgo ≥'+recipe.minNetRR+' después de comisiones, spread y deslizamiento.']};
 if(context){
  for(const [tf,c] of Object.entries(context))if(Number(tf)!==recipe.tf)result.panels.push(evidencePanel(Number(tf),c.bars,[]));
  result.facts.push({label:'ATR stop · '+recipe.stopTf+' min',value:context[recipe.stopTf].atr},{label:'ATR objetivo · '+recipe.targetTf+' min',value:context[recipe.targetTf].atr});
  result.rules[2]='Orden límite post-only al '+(short?'ask':'bid')+' al decidir; se cancela si cruza el spread al activarse. No se ejecuta por tocar el precio: exige una operación posterior que lo atraviese, del lado contrario y con al menos 10 veces la cantidad.';
  result.rules[3]='Stop: '+recipe.stopATR+' ATR de '+recipe.stopTf+' min. Objetivo: '+recipe.targetATR+' ATR de '+recipe.targetTf+' min. Solo historia cerrada, parámetros fijos antes de evaluar costes.';
  result.rules.push('Entrada maker 0,40%; salida taker 0,80%, más spread, deslizamiento y financiación si aplica. Simulación sin posición real en la cola ni ejecuciones parciales.');
 }
 return result;
}
