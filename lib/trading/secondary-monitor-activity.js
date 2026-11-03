// Read-only monitor compatibility. Never writes the trading state or invents a decision.
import {secondaryFresh} from './secondary-futures-math.js';
import {capitalAllocationView} from './secondary-capital-allocation.js';
import {getSecondaryTimeframes} from './secondary-timeframes.js';
export const ACTIVITY_VIEW_VERSION='secondary-monitor-activity-1.3.0';
const clone=value=>value==null?value:structuredClone(value);
const stamp=value=>Number.isSafeInteger(value)&&value>0?value:null;
const count=value=>Number.isSafeInteger(value)&&value>=0?value:null;
const reasonNames={
 PAPER_CAPITAL_INSUFFICIENT:'La señal es válida, pero el capital disponible no cubre su tamaño base y costes. Se mantiene la evaluación y se espera capital liberado.',
 PAPER_CAPITAL_INSUFFICIENT_AT_FILL:'El capital disponible después de la latencia no cubre la ejecución; se conserva la reserva de las otras órdenes.',
 PAPER_CAPITAL_REMAINDER_CANCELLED:'Se canceló el remanente que no podía financiarse, sin recargar capital ficticio.',
 CHANNEL_NOT_BROKEN:'El cierre no rompió el canal del patrón.',
 VOLUME_OR_CANDLE_CONFIRMATION:'Falta la confirmación de volumen o de la vela.',
 PULLBACK_NOT_CONFIRMED:'El retroceso todavía no confirmó una recuperación.',
 CONTEXT_NOT_CONFIRMED:'El contexto no confirma la dirección de la entrada.',
 BAND_REENTRY_NOT_CONFIRMED:'No se confirmó la reentrada desde la banda.',
 NOT_A_RANGE:'El contexto no corresponde a un rango lateral.',
 COST_OR_NET_RR:'El recorrido no compensa los costes y el riesgo exigidos.',
 PRE_EXECUTION_EXPECTED_NET_TARGET_BELOW_MINIMUM:'La cotización posterior a la latencia ya no deja el mínimo neto útil; se cancela la entrada.',
 PRE_EXECUTION_FUNDING_NOT_AVAILABLE:'Falta financiación verificable antes de ejecutar; se cancela sin inventar costes.',
 EXPECTED_NET_TARGET_BELOW_MINIMUM:'Patrón detectado: el objetivo neto previsto no alcanza el mínimo útil experimental.',
 ENTRY_ECONOMICS_CHANGED_BEFORE_FILL:'La cotización posterior a la latencia ya no deja el margen mínimo; la entrada no se ejecuta.',
 REPEATED_CONFIRMATION:'Esta confirmación ya se procesó; se espera evidencia nueva para otra entrada.',
 LATE_REPETITION_NO_NEW_CONFIRMATION:'Es una repetición de la misma estructura sin nueva confirmación; se registra sin añadir otra posición.',
 STRUCTURAL_ENTRY_DISTANCE:'La entrada o el stop no cumplen la distancia estructural.',
 ENTRY_PENDING:'Entrada preparada; todavía no se ejecutó.',
 FUTURES_DATA_NOT_FRESH:'Faltan cotizaciones recientes del contrato de futuros.',
 CONTEXT_NOT_SYNCHRONIZED:'Faltan velas cerradas y sincronizadas.',
 FUNDING_NOT_AVAILABLE:'Falta la financiación necesaria para evaluar los costes.',
 EVALUATION_WINDOW_MISSED:'No se completó la evaluación dentro de su ventana.',
 DRAWDOWN_HALT:'Nuevas entradas detenidas por el límite de pérdidas.',
 LOSS_STREAK_COOLDOWN:'Pausa por la racha de pérdidas.',
 WAIT_BREAKOUT:'No se confirmó una ruptura.',
 WAIT_PULLBACK:'No se confirmó el retroceso.',
 WAIT_RANGE_REENTRY:'No se confirmó la reentrada en rango.',
 DUPLICATE_SIGNAL:'Esta señal ya se procesó; no se vuelve a ejecutar.',
 STRUCTURAL_TARGET_ALREADY_PASSED:'La cotización actual ya pasó el objetivo estructural de la señal.',
 NUMERIC_PLAN_INVALID:'El plan contiene un precio o una cantidad inválidos.',
 INSTRUMENT_METADATA_STALE:'La ficha del instrumento necesita actualizarse.',
 INSTRUMENT_METADATA_INVALID:'La ficha del instrumento no contiene incrementos numéricos válidos.',
 INSUFFICIENT_OBSERVED_LIQUIDITY:'La liquidez observada no alcanza; no se inventa una ejecución.',
 IOC_NO_LIQUIDITY:'La orden inmediata terminó sin liquidez observable suficiente.',
 FUTURES_DISCONNECTED:'El feed de futuros se desconectó; se conserva el estado para reconciliar.',
 FUTURES_DATA_GAP:'Hubo un intervalo sin cotizaciones suficientes; no prueba que se haya tocado un stop.'
};
const describe=d=>reasonNames[d?.criteria?.blocked_by]??reasonNames[d?.reason]??d?.reason??'Sin evaluación registrada.';

export function projectSecondaryActivity(d,s,now,inventory={}){
 const x=s?.secondaryExecution;if(!x)return d;
 if(d.secondary_activity?.view_version===ACTIVITY_VIEW_VERSION&&d.secondary_activity.revision===d.revision)return d;
 if(getSecondaryTimeframes(s))return projectMultipleFrames(d,s,now,inventory);
 const version=x.version,entryTf=x.protocol?.entryMinutes??5,contextTf=x.protocol?.contextMinutes??15;
 const decisions=Object.entries(x.decisions??{}).filter(([,v])=>stamp(v?.at)&&v.at>=x.activated_at).map(([pattern,v])=>({...clone(v),pattern:v.pattern??pattern}));
 const last=decisions.slice().sort((a,b)=>b.at-a.at||String(a.pattern).localeCompare(String(b.pattern)))[0]??null;
 const patterns=x.protocol?.patterns??[],lastPatterns=decisions.filter(v=>patterns.includes(v.pattern)&&v.cutoff===last?.cutoff);
 const finalReason=lastPatterns.find(v=>v.reason==='ENTRY_PENDING')??lastPatterns.find(v=>!v.reason.startsWith('WAIT_'))??last;
 const evaluatedAt=stamp(last?.at),age=evaluatedAt===null?null:now-evaluatedAt;
 const stale=age!==null&&(age< -1000||age>entryTf*60000+30000);
 const patternCount=count(x.counts?.evaluations),net=d.laboratory?.trials?.find(t=>t.version===version)?.net??null;
 const summary=finalReason?{...clone(finalReason),timeframe:entryTf,role:'ENTRY',reason_text:describe(finalReason),pattern_decisions:clone(lastPatterns),all_patterns:lastPatterns.map(v=>({pattern:v.pattern,reason:v.reason})),stale}:null;
 const contextLast=decisions.filter(v=>patterns.includes(v.pattern)&&Number.isFinite(v.criteria?.atr15)).sort((a,b)=>b.at-a.at)[0]??null;
 const context=contextLast?{at:contextLast.at,cutoff:contextLast.cutoff,timeframe:contextTf,version,role:'CONTEXT',entry_enabled:false,
  reason:'Contexto de '+contextTf+' m leído por la evaluación de '+entryTf+' m; no abre operaciones por separado.',
  reason_code:'CONTEXT_USED_BY_ENTRY',context_close_at:stamp(contextLast.cutoff)?Math.floor(contextLast.cutoff/(contextTf*60000))*contextTf*60000:null,stale:now-contextLast.at>entryTf*60000+30000||now-contextLast.at< -1000}:null;
 const pending=Object.values(s.frequency?.account?.pendingOrders??{}),positions=Object.values(s.frequency?.account?.positions??{});
 const quote=x.market?.quote,dataUsable=secondaryFresh(quote,now),updatedAt=Date.parse(d.updated_at),leaseUntil=Date.parse(d.lease_until);
 const recentCommit=Number.isFinite(updatedAt)&&now-updatedAt>=-1000&&now-updatedAt<=45000;
 const processStatus=recentCommit&&Number.isFinite(leaseUntil)&&leaseUntil>now?'RECENT_COMMIT_AND_LEASE':Number.isFinite(updatedAt)?'STALE_OR_UNVERIFIED':'UNAVAILABLE';
 const stage=positions.length?'POSITION_OPEN':pending.length?'ORDER_PENDING':!dataUsable?'WAITING_MARKET_DATA':!evaluatedAt?'WAITING_FIRST_EVALUATION':stale?'WAITING_CURRENT_EVALUATION':'EVALUATING_PATTERNS';
 const label=x.status!=='ACTIVE_PAPER'?'PAUSED':!evaluatedAt?'WAITING_FIRST_EVALUATION':stale?'EVALUATION_STALE':'EVALUATING';
 d.secondary_activity={view_version:ACTIVITY_VIEW_VERSION,revision:d.revision,source:'COMMITTED_SECONDARY_EXECUTION',
  execution_version:version,status:label,execution_status:x.status,entry_timeframe:entryTf,context_timeframes:[contextTf],
  operational_stage:stage,profile:clone(x.exploration??null),profit_policy:clone(x.profit_policy??null),capital_allocation:capitalAllocationView(s),financial_blocks:x.exploration?.active?false:true,
  process:{status:processStatus,last_commit_at:Number.isFinite(updatedAt)?updatedAt:null,lease_until:Number.isFinite(leaseUntil)?leaseUntil:null},
  market:{usable:dataUsable,quotes_usable:dataUsable,decision_inputs_usable:dataUsable&&!x.evaluation_blocker&&!x.market?.error,quote_at:stamp(quote?.event_at),issue:clone(x.market_issue??x.market?.error??(!dataUsable?'FUTURES_DATA_NOT_FRESH':null))},
  orders:{pending:pending.length,open_positions:positions.length,partially_filled:pending.filter(o=>Number(o.filled_qty??0)>0).length,pending_order_ids:pending.map(o=>o.plan.id),open_position_ids:positions.map(p=>p.plan.id)},
  patterns:patterns.map(pattern=>{const v=decisions.find(d=>d.pattern===pattern);return {pattern,last_evaluation_at:stamp(v?.at),cutoff:stamp(v?.cutoff),reason:v?.reason??null,reason_text:describe(v),criteria:clone(v?.criteria??{}),rule_version:v?.criteria?.entry_revision??v?.version??null,stale:!v||now-v.at>entryTf*60000+30000||now-v.at< -1000};}),
  evaluation_current:Boolean(evaluatedAt&&!stale),last_evaluation:summary,last_evaluation_at:evaluatedAt,last_context_use_at:stamp(context?.at),
  pattern_evaluations:patternCount,count_unit:'PATTERN_CHECKS_NOT_CANDLES',selected:count(x.counts?.selected),
  filled:count(x.counts?.filled),closed:count(x.counts?.closed),economic_rejected:count(x.counts?.economic_rejected),context_rejected:count(x.counts?.context_rejected),capital_rejected:count(x.counts?.capital_rejected),rejection_count_unit:'SIGNAL_EVALUATION_REJECTIONS_NOT_UNIQUE_PATTERNS',net_since_activation:net,
  blocker:clone(x.evaluation_blocker??null),snapshot_at:now,stale,
  explanation:'Las entradas se evalúan en '+entryTf+' m usando contexto de '+contextTf+' m. El contador suma comprobaciones de patrones, no operaciones.'};
 // Keep the old primary/spot data explicitly separate. Do not relabel its candles as futures.
 d.primary_timeframes=clone(d.timeframes??null);
 const oldSeries=clone(d.timeframes?.series??{}),series={},roles={};
 for(const tf of [entryTf,contextTf]){
  const close=stamp(x.market?.closed_at?.[tf]),meta=inventory?.[tf],same=close!==null&&meta?.last_closed_at===close;
  const bars=same?count(meta.bars):null;
  roles[tf]=tf===entryTf?'ENTRY':'CONTEXT';
  series[tf]={last_closed_at:close,bars,checked_at:stamp(x.market?.last_refresh),source:'KRAKEN_FUTURES',instrument:x.protocol?.symbol,
   history_loaded:close!==null,history_count_available:bars!==null,analysis_window_bars:256,
   analysis_bars:bars===null?null:Math.min(bars,256),role:roles[tf],entry_enabled:tf===entryTf};
 }
 // Legacy fixed-card clients must display an explicit inactive message, not a fabricated timestamp.
 const inactive={};
 for(const key of Object.keys(oldSeries))if(![entryTf,contextTf].includes(Number(key))){
  series[key]={...oldSeries[key],source:'KRAKEN_SPOT_LEGACY',role:'LEGACY_CONTEXT',entry_enabled:false};roles[key]='LEGACY_CONTEXT';
  inactive[key]={at:null,cutoff:null,timeframe:Number(key),role:'LEGACY_CONTEXT',entry_enabled:false,
   reason:'Plazo de la configuración anterior. La secundaria actual evalúa entradas en '+entryTf+' m y usa contexto de '+contextTf+' m.',
   reason_code:'NOT_AN_OPERATIONAL_ENTRY_FRAME'};
 }
 d.timeframes={version:ACTIVITY_VIEW_VERSION,frames:[...new Set([...(d.primary_timeframes?.frames??[]),entryTf,contextTf])].sort((a,b)=>a-b),active_frames:[entryTf,contextTf],entry_frames:[entryTf],context_frames:[contextTf],roles,
  status:x.status==='ACTIVE_PAPER'?'ACTIVE':x.status,activated_at:x.activated_at,source:'KRAKEN_FUTURES',series};
 const originalTrials=d.laboratory?.trials??[],active=originalTrials.find(t=>t.version===version);
 if(active){
  const trial={...active,recipe:{...active.recipe,tf:entryTf,timeframes:[entryTf,contextTf],entry_timeframes:[entryTf],context_timeframes:[contextTf]},
   pattern_decisions:clone(x.decisions??{}),decisions:{...clone(x.decisions??{}),...inactive},
   diagnostics:{[entryTf]:{evaluations:patternCount,evaluation_unit:'PATTERN_CHECKS',selected:count(x.counts?.selected),role:'ENTRY'},
    [contextTf]:{evaluations:0,evaluation_unit:'NO_INDEPENDENT_ENTRIES',last_context_use_at:stamp(context?.at),role:'CONTEXT'}},
   frames:{[entryTf]:{closed:count(x.counts?.closed),net,role:'ENTRY'},[contextTf]:{closed:0,net:null,role:'CONTEXT',entry_enabled:false}}};
  if(summary)trial.decisions[entryTf]=summary;
  if(context)trial.decisions[contextTf]=context;
  d.laboratory={...d.laboratory,trials:originalTrials.map(t=>t===active?trial:t)};
 }
 d.frequency={...d.frequency,lastDecision:summary??d.frequency?.lastDecision,pattern_decisions:clone(x.decisions??{}),activity:d.secondary_activity};
 if(d.laboratory)d.laboratory={...d.laboratory,lastDecision:summary??d.laboratory.lastDecision};
 d.secondary_evaluations=decisions.map(v=>({at:v.at,kind:'SECONDARY_PATTERN_EVALUATION',ledger:'FREQUENT_PAPER',timeframe:entryTf,
  pattern:v.pattern,reason:v.reason,reason_text:describe(v),criteria:v.criteria,version:v.version??version,rule_version:v.criteria?.entry_revision??v.version??version,source:'COMMITTED_SECONDARY_EXECUTION'})).sort((a,b)=>b.at-a.at);
 return d;
}

function projectMultipleFrames(d,s,now,inventory){
 const x=s.secondaryExecution,profile=getSecondaryTimeframes(s),policy=profile.policy,version=x.version;
 const positions=Object.values(s.frequency?.account?.positions??{}),pending=Object.values(s.frequency?.account?.pendingOrders??{});
 const uniqueIds=[...new Set([...positions,...pending].map(row=>row.plan.id))],quote=x.market?.quote,quotesUsable=secondaryFresh(quote,now);
 const updated=Date.parse(d.updated_at),lease=Date.parse(d.lease_until),recent=Number.isFinite(updated)&&now-updated>=-1000&&now-updated<=45000;
 const frames={},allDecisions=[];
 for(const tf of policy.entry_frames){
  const f=profile.frames[tf],contextTf=f.context_timeframe,raw=Object.values(f.decisions??{}).filter(v=>stamp(v.at)),last=f.last_decision??raw.sort((a,b)=>b.at-a.at)[0]??null;
  allDecisions.push(...raw);const lastAt=stamp(f.last_evaluation_at),stale=lastAt===null||now-lastAt>tf*60000+policy.evaluation_window_ms||now-lastAt< -1000;
  const data=frameInventory(tf),context=frameInventory(contextTf),complete=data.complete&&context.complete;
  const summary=last?{...clone(last),timeframe:tf,role:'ENTRY',entry_enabled:true,reason_text:describe(last),pattern_decisions:clone(raw),all_patterns:raw.map(v=>({pattern:v.pattern,reason:v.reason})),stale}:null;
  frames[tf]={timeframe:tf,context_timeframe:contextTf,source:'KRAKEN_FUTURES',instrument:policy.symbol,entry_enabled:true,role:'ENTRY',data_complete:complete,entry_data:data,context_data:context,
   last_evaluation_at:lastAt,last_completed_at:stamp(f.last_completed_at),last_cutoff:stamp(f.last_cutoff),evaluation_status:f.last_status,last_result:f.last_result??null,
   reason:summary?.reason??null,reason_text:summary?.reason_text??'Esperando el próximo cierre natural.',last_evaluation:summary,blocker:f.blocker??null,
   last_recovered:clone(f.last_recovered??null),counts:clone(f.counts),reason_counts:clone(f.reasons),stale,
   next_candle_close_at:(Math.floor(now/(tf*60000))+1)*tf*60000,
   holding_ms:policy.frames[tf].base_holding_ms,extension_ms:policy.frames[tf].extension_ms,maximum_holding_ms:policy.frames[tf].base_holding_ms+policy.frames[tf].extension_ms,
   neural_entry_status:f.neural_entry_status};
 }
 function frameInventory(tf){
  const closed=stamp(x.market?.closed_at?.[tf]),meta=inventory?.[tf],matching=closed!==null&&meta?.last_closed_at===closed,bars=matching?count(meta.bars):null,expected=Math.floor(now/(tf*60000))*tf*60000;
  return {timeframe:tf,bars,last_closed_at:closed,expected_closed_at:expected,complete:bars!==null&&bars>=policy.minimum_closed_bars&&closed===expected,
   last_refresh_at:stamp(x.market?.frame_refresh_at?.[tf])??stamp(x.market?.last_refresh),error:x.market?.frame_errors?.[tf]??null};
 }
 const lastFrame=Object.values(frames).filter(f=>f.last_evaluation_at).sort((a,b)=>b.last_evaluation_at-a.last_evaluation_at||a.timeframe-b.timeframe)[0],last=lastFrame?.last_evaluation??null;
 const anyCurrent=Object.values(frames).some(f=>!f.stale),anyData=Object.values(frames).some(f=>f.data_complete&&!f.blocker),allStale=!anyCurrent;
 const commonNet=d.laboratory?.trials?.find(t=>t.version===version)?.net??null;
 d.secondary_activity={view_version:ACTIVITY_VIEW_VERSION,revision:d.revision,source:'COMMITTED_SECONDARY_EXECUTION',execution_version:version,
  status:x.status!=='ACTIVE_PAPER'?'PAUSED':!last?'WAITING_FIRST_EVALUATION':allStale?'EVALUATION_STALE':'EVALUATING',execution_status:x.status,
  entry_timeframe:5,entry_timeframes:[...policy.entry_frames],context_timeframes:[15,60,240,1440],timeframe_version:profile.version,frames,
  operational_stage:positions.length?'POSITION_OPEN':pending.length?'ORDER_PENDING':!quotesUsable?'WAITING_MARKET_DATA':!last?'WAITING_FIRST_EVALUATION':'EVALUATING_PATTERNS',
  profile:clone(x.exploration??null),profit_policy:clone(x.profit_policy??null),capital_allocation:capitalAllocationView(s),financial_blocks:Boolean(x.risk_budget?.active),
  process:{status:recent&&lease>now?'RECENT_COMMIT_AND_LEASE':Number.isFinite(updated)?'STALE_OR_UNVERIFIED':'UNAVAILABLE',last_commit_at:Number.isFinite(updated)?updated:null,lease_until:Number.isFinite(lease)?lease:null},
  market:{usable:quotesUsable,quotes_usable:quotesUsable,decision_inputs_usable:quotesUsable&&anyData&&!x.market?.error,quote_at:stamp(quote?.event_at),issue:x.market_issue??x.market?.error??null},
  orders:{pending:pending.length,open_positions:positions.length,unique_slots:uniqueIds.length,partially_filled:pending.filter(o=>Number(o.filled_qty??0)>0).length,pending_order_ids:pending.map(o=>o.plan.id),open_position_ids:positions.map(o=>o.plan.id)},
  patterns:(x.protocol?.patterns??[]).map(pattern=>{const v=profile.frames[5].decisions?.[pattern];return {pattern,timeframe:5,last_evaluation_at:stamp(v?.at),cutoff:stamp(v?.cutoff),reason:v?.reason??null,reason_text:describe(v),criteria:clone(v?.criteria??{}),rule_version:v?.entry_revision??v?.version??null,stale:frames[5].stale};}),
  evaluation_current:anyCurrent,last_evaluation:last,last_evaluation_at:lastFrame?.last_evaluation_at??null,last_context_use_at:lastFrame?.last_evaluation_at??null,
  pattern_evaluations:count(x.counts?.evaluations),count_unit:'PATTERN_CHECKS_NOT_CANDLES',selected:count(x.counts?.selected),filled:count(x.counts?.filled),closed:count(x.counts?.closed),
  economic_rejected:count(x.counts?.economic_rejected),context_rejected:count(x.counts?.context_rejected),capital_rejected:count(x.counts?.capital_rejected),rejection_count_unit:'SIGNAL_EVALUATION_REJECTIONS_NOT_UNIQUE_PATTERNS',net_since_activation:commonNet,
  blocker:null,snapshot_at:now,stale:allStale,
  explanation:'Entradas independientes de 5 m, 15 m, 1 h y 4 h sobre PF_XBTUSD. Comparten capital y riesgo; cada plazo conserva su reloj. Un bloqueo recuperado no cuenta como evaluación perdida.'};
 d.primary_timeframes=clone(d.timeframes??null);
 const oldSeries=d.timeframes?.series??{},series={},roles={};
 for(const tf of policy.data_frames){const f=frameInventory(tf),entry=policy.entry_frames.includes(tf);roles[tf]=entry?'ENTRY':'CONTEXT';
  series[tf]={last_closed_at:f.last_closed_at,bars:f.bars,checked_at:f.last_refresh_at,source:'KRAKEN_FUTURES',instrument:policy.symbol,history_loaded:f.last_closed_at!==null,
   history_count_available:f.bars!==null,analysis_window_bars:256,analysis_bars:f.bars===null?null:Math.min(f.bars,256),role:roles[tf],entry_enabled:entry,data_complete:f.complete,error:f.error};
 }
 const inactive={};for(const [key,value] of Object.entries(oldSeries))if(!policy.data_frames.includes(Number(key))){
  series[key]={...clone(value),source:'KRAKEN_SPOT_LEGACY',role:'LEGACY_CONTEXT',entry_enabled:false};roles[key]='LEGACY_CONTEXT';
  inactive[key]={at:null,cutoff:null,timeframe:Number(key),role:'LEGACY_CONTEXT',entry_enabled:false,reason:'Plazo histórico spot; no existe una entrada operativa de futuros en este plazo.',reason_code:'NOT_AN_OPERATIONAL_ENTRY_FRAME'};
 }
 d.timeframes={version:profile.version,frames:[...new Set([...Object.keys(oldSeries).map(Number),...policy.data_frames])].sort((a,b)=>a-b),active_frames:[...policy.data_frames],entry_frames:[...policy.entry_frames],context_frames:[15,60,240,1440],roles,status:x.status==='ACTIVE_PAPER'?'ACTIVE':x.status,activated_at:profile.activated_at,source:'KRAKEN_FUTURES',series};
 const original=d.laboratory?.trials??[],active=original.find(t=>t.version===version);
 if(active){
  const decisions={...inactive,...Object.fromEntries(Object.entries(frames).map(([tf,f])=>[tf,f.last_evaluation??{at:null,timeframe:Number(tf),role:'ENTRY',entry_enabled:true,reason:'WAITING_FIRST_NATURAL_CLOSE',reason_text:'Esperando el próximo cierre natural.'}]))};
  const trial={...active,recipe:{...active.recipe,tf:5,timeframes:[...policy.data_frames],entry_timeframes:[...policy.entry_frames],context_timeframes:[15,60,240,1440]},pattern_decisions:Object.fromEntries(allDecisions.map(v=>[v.timeframe+':'+v.pattern,clone(v)])),decisions,
   diagnostics:Object.fromEntries(Object.entries(frames).map(([tf,f])=>[tf,{evaluations:f.counts.pattern_checks,evaluation_unit:'PATTERN_CHECKS',completed_candles:f.counts.completed,missed_candles:f.counts.missed,transient_blocks:f.counts.transient_blocks,recovered_candles:f.counts.recovered,selected:f.counts.selected,role:'ENTRY',data_complete:f.data_complete}])),
   frames:Object.fromEntries(Object.entries(frames).map(([tf,f])=>[tf,{role:'ENTRY',entry_enabled:true,closed:count(f.counts.closed),net:f.counts.net??null}]))};
  d.laboratory={...d.laboratory,trials:original.map(t=>t===active?trial:t),lastDecision:last??d.laboratory.lastDecision};
 }
 d.frequency={...d.frequency,lastDecision:last??d.frequency?.lastDecision,pattern_decisions:Object.fromEntries(allDecisions.map(v=>[v.timeframe+':'+v.pattern,clone(v)])),activity:d.secondary_activity};
 d.secondary_evaluations=allDecisions.map(v=>({at:v.at,kind:'SECONDARY_PATTERN_EVALUATION',ledger:'FREQUENT_PAPER',timeframe:v.timeframe,context_timeframe:v.context_timeframe,pattern:v.pattern,reason:v.reason,reason_text:describe(v),criteria:v.criteria,evaluation_status:v.evaluation_status,version:v.version??version,rule_version:v.entry_revision??v.version??version,source:'COMMITTED_SECONDARY_EXECUTION'})).sort((a,b)=>b.at-a.at);
 return d;
}
