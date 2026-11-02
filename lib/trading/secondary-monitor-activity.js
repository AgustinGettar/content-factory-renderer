// Read-only monitor compatibility. Never writes the trading state or invents a decision.
import {secondaryFresh} from './secondary-futures-math.js';
export const ACTIVITY_VIEW_VERSION='secondary-monitor-activity-1.2.0';
const clone=value=>value==null?value:structuredClone(value);
const stamp=value=>Number.isSafeInteger(value)&&value>0?value:null;
const count=value=>Number.isSafeInteger(value)&&value>=0?value:null;
const reasonNames={
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
  operational_stage:stage,profile:clone(x.exploration??null),profit_policy:clone(x.profit_policy??null),financial_blocks:x.exploration?.active?false:true,
  process:{status:processStatus,last_commit_at:Number.isFinite(updatedAt)?updatedAt:null,lease_until:Number.isFinite(leaseUntil)?leaseUntil:null},
  market:{usable:dataUsable,quotes_usable:dataUsable,decision_inputs_usable:dataUsable&&!x.evaluation_blocker&&!x.market?.error,quote_at:stamp(quote?.event_at),issue:clone(x.market_issue??x.market?.error??(!dataUsable?'FUTURES_DATA_NOT_FRESH':null))},
  orders:{pending:pending.length,open_positions:positions.length,partially_filled:pending.filter(o=>Number(o.filled_qty??0)>0).length,pending_order_ids:pending.map(o=>o.plan.id),open_position_ids:positions.map(p=>p.plan.id)},
  patterns:patterns.map(pattern=>{const v=decisions.find(d=>d.pattern===pattern);return {pattern,last_evaluation_at:stamp(v?.at),cutoff:stamp(v?.cutoff),reason:v?.reason??null,reason_text:describe(v),criteria:clone(v?.criteria??{}),rule_version:v?.criteria?.entry_revision??v?.version??null,stale:!v||now-v.at>entryTf*60000+30000||now-v.at< -1000};}),
  evaluation_current:Boolean(evaluatedAt&&!stale),last_evaluation:summary,last_evaluation_at:evaluatedAt,last_context_use_at:stamp(context?.at),
  pattern_evaluations:patternCount,count_unit:'PATTERN_CHECKS_NOT_CANDLES',selected:count(x.counts?.selected),
  filled:count(x.counts?.filled),closed:count(x.counts?.closed),economic_rejected:count(x.counts?.economic_rejected),context_rejected:count(x.counts?.context_rejected),rejection_count_unit:'SIGNAL_EVALUATION_REJECTIONS_NOT_UNIQUE_PATTERNS',net_since_activation:net,
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
