// Read-only presentation of the committed secondary futures worker.
import {monitorPresentation,knownAmount} from './monitor-integrity.mjs';
import {exitReasonLabel} from './profit-protection.mjs';
export const patternNames={BREAKOUT:'Ruptura',PULLBACK:'Retroceso',RANGE_REENTRY:'Reentrada en rango'};
export const futuresPlan=p=>p?.execution_model==='lumi-linear-futures-paper-1.0.0'||p?.instrument==='PAPER:KRAKEN_FUTURES:PF_XBTUSD';
export const structuralTarget=(p,position)=>Boolean(futuresPlan(p)&&p?.execution_contract&&!position?.management?.override&&!position?.live_exit?.management_override);
export const operationalSecondary=data=>Boolean(data?.secondary_execution||data?.frequency?.execution_version==='secondary-futures-1.0.0');
const numeric=value=>knownAmount(value)?Number(value):null;
export function secondaryCapitalView(data){
 const risk=data?.secondary_risk_budget??data?.secondary_execution?.risk_budget;
 if(risk?.active){const policy=risk.policy??{},portfolio=risk.portfolio??{};return {version:risk.version,active:true,finiteCapital:true,riskSized:true,baseNominal:null,preferredNominal:null,leverage:numeric(policy.max_leverage),availableCash:numeric(portfolio.free_cash??data?.secondary_finances?.available_cash),targetEquity:null,fundingStatus:null,fundingReason:null,policy,riskPolicy:policy,portfolio,maxSlots:numeric(policy.max_slots),maxLegs:numeric(policy.max_movement_legs),lastBatch:risk.last_batch??null};}
 const state=data?.secondary_capital_allocation??data?.secondary_activity?.capital_allocation??data?.secondary_execution?.capital_allocation??data?.frequency?.capital_allocation;
 if(!state)return null;
 const policy=state.policy??{},account=data?.frequency?.account??{},profile=data?.frequency?.exploration_profile??data?.secondary_execution?.exploration;
 const active=state.active===true,finiteCapital=state.finite_capital===true||policy.fundingMode==='FINITE_EXISTING_CAPITAL';
 const base=numeric(active?(state.base_nominal_usd??policy.baseNominalUSD??account.nominal_usd):(account.nominal_usd??profile?.policy?.nominalUSD));
 const multiplier=numeric(policy.preferredMultiplier),preferred=active?numeric(state.preferred_nominal_usd)??(base!==null&&multiplier!==null?base*multiplier:null):base;
 const request=state.funding_request??{};
 return {version:state.version,active,finiteCapital,baseNominal:base,preferredNominal:preferred,
  leverage:numeric(policy.leverage??profile?.policy?.leverage??data?.secondary_execution?.protocol?.leverage),
  availableCash:numeric(state.available_cash??data?.secondary_finances?.available_cash??account.available_cash),
  targetEquity:numeric(request.target_equity??policy.targetEquityUSD),fundingStatus:request.status??null,fundingReason:request.reason??null,
  fundingReceipt:request.receipt??null,lastBatch:state.last_batch??null,policy};
}
export const capitalReasonLabel=reason=>({PREFERRED_VALID_CANDIDATE:'Mejor candidata válida de esta evaluación',BASE_VALID_CANDIDATE:'Asignación base',PAPER_CAPITAL_INSUFFICIENT:'Capital disponible insuficiente para esta entrada',CAPITAL_TARGET_VALUATION_UNAVAILABLE:'Esperando datos para valorar el aporte inicial',CAPITAL_TARGET_REQUIRES_CURRENT_MARK:'Esperando una valoración actual del patrimonio',CAPITAL_PREFLIGHT_INVALID:'La comprobación de asignación no fue válida'}[reason]??exitReasonLabel(reason));
export function capitalDecisionView(receipt){
 if(!receipt||typeof receipt!=='object')return null;
 const rank=Number.isSafeInteger(receipt.rank)&&receipt.rank>=0?receipt.rank+1:null;
 return {reason:receipt.reason??null,label:capitalReasonLabel(receipt.reason),rank,eligible:receipt.eligible===true,accepted:receipt.accepted===true,preferred:receipt.preferred===true,
  requestedNominal:numeric(receipt.requested_nominal_usd??receipt.nominal_usd),allocatedNominal:numeric(receipt.allocated_nominal_usd??receipt.nominal_usd),
  baseNominal:numeric(receipt.base_nominal_usd),capitalLimited:receipt.capital_limited===true,
  expectedNetFraction:numeric(receipt.expected_net_target_fraction??receipt.score?.expected_net_target_fraction),netRR:numeric(receipt.net_rr??receipt.score?.net_rr)};
}
export function entryQuality(criteria){
 const raw=criteria?.entry_quality??criteria?.quality,classification=typeof raw==='string'?raw:raw?.classification;if(!classification)return null;
 const label={COSTS_NOT_COVERED:'Desfavorable: el objetivo no cubre los costes estimados',EXPERIMENTAL_OUTSIDE_REFERENCE:'Experimental: fuera de los filtros de referencia',REFERENCE_THRESHOLDS_MET:'Cumple filtros de referencia; rentabilidad sin validar'}[classification]??classification;
 return {classification,label,labels:criteria?.quality_labels??raw?.labels??[],unfavorable:classification==='COSTS_NOT_COVERED'||raw?.expected_net_positive===false};
}
export const eventLabel=e=>({SELECTED:'Orden seleccionada · pendiente',FILLED:e.execution_state==='EJECUCIÓN_PARCIAL'?'Ejecución parcial':'Posición abierta',PARTIAL_FILL:'Ejecución parcial',PARTIAL_CLOSE:'Cierre parcial',CLOSED:e.reason==='TRAILING_RETRACEMENT'?'Posición cerrada · retroceso neto':e.reason==='STOP'?'Posición cerrada · stop':'Posición cerrada',NOT_FILLED:e.order_state==='ORDEN_VENCIDA'||e.reason==='VENCIDA'?'Orden vencida · sin ejecución':'Orden cancelada · sin ejecución',ORDER_REMAINDER_CANCELLED:'Remanente cancelado · posición conservada',PAPER_CAPITAL_TOPUP:'Recarga ficticia',FUNDING_RECONCILED:'Financiación reconciliada',TARGET_REACHED:'Objetivo alcanzado · dejando correr',TRAILING_ACTIVATED:'Protección neta activada',PROFIT_PROTECTION_ACTIVATED:'Protección temprana activada',PROFIT_PROTECTION_FLOOR_RAISED:'Piso neto actualizado',PROFIT_PROTECTION_ACTIVATION_PENDING:'Protección pendiente',SECONDARY_EXIT_ADVISORY_SNAPSHOT:'Muestra de salida · sin autoridad',TARGET_REACHED_NET_INSUFFICIENT:'Objetivo de precio · neto insuficiente',EXIT_INTENT:exitReasonLabel(e.reason)+' · intención pendiente',SECONDARY_PROFIT_POLICY_ENABLED:'Política de margen útil y protección activada'}[e?.type]??e?.type??'Evento registrado');
export function secondaryView(data,now){
 if(!operationalSecondary(data))return null;
 const x=data.secondary_execution??{},activity=data.secondary_activity??{},profile=data.frequency?.exploration_profile??x.exploration,finances=data.secondary_finances??data.frequency?.financial_summary??null;
 const entry=activity.entry_timeframe??x.protocol?.entryMinutes??5,contexts=activity.context_timeframes??[x.protocol?.contextMinutes??15];
 const sources=activity.patterns??Object.entries(x.decisions??{}).filter(([,d])=>d&&typeof d==='object').map(([pattern,d])=>({pattern,last_evaluation_at:d.at,reason:d.reason,reason_text:d.reason_text??d.reason,criteria:d.criteria,rule_version:d.criteria?.entry_revision??d.version}));
 const patterns=(x.protocol?.patterns??['BREAKOUT','PULLBACK','RANGE_REENTRY']).map(pattern=>{const d=sources.find(d=>d?.pattern===pattern),at=Number.isSafeInteger(d?.last_evaluation_at)?d.last_evaluation_at:null,criteria=d?.criteria??d?.facts;return {...d,criteria,pattern,title:patternNames[pattern]??pattern,at,evaluation_text:d?.reason==='ENTRY_PENDING'?'En esta evaluación se seleccionó una orden; estado actual en Operaciones.':d?.reason_text??d?.reason,entry_quality:entryQuality(criteria),capital_allocation:capitalDecisionView(criteria?.capital_allocation),stale:!at||now-at>entry*60000+30000||at>now+1000};});
 const updated=Date.parse(data.updated_at),lease=Date.parse(data.lease_until),running=Number.isFinite(updated)&&now-updated<=45000&&now-updated>=-1000&&lease>now;
 const quote=x.market?.quote,quoteUsable=quote?.symbol==='PF_XBTUSD'&&quote.source==='KRAKEN_FUTURES_WS_TICKER'&&!quote.suspended&&Number(quote.bid)>0&&Number(quote.ask)>=Number(quote.bid)&&Number.isSafeInteger(quote.event_at)&&now-quote.event_at>=-1000&&now-quote.event_at<=5000&&Number.isSafeInteger(quote.received_at)&&now-quote.received_at>=0&&now-quote.received_at<=5000;
 const presentation=monitorPresentation(data,now),pending=presentation?.pendingCount??null,opened=presentation?.openCount??null;
 const reason=activity.blocker??activity.market?.issue??x.market?.error??null;
 const status=!running?'Proceso por confirmar':!quoteUsable?'Esperando datos utilizables':opened?'Gestionando '+opened+' posición'+(opened===1?'':'es'):pending?'Orden pendiente de ejecución':patterns.some(p=>!p.stale)?'Evaluando los tres patrones':'Esperando evaluación actual';
 const capitalAllocation=secondaryCapitalView(data);
 return {entryFrames:activity.entry_timeframes??[entry],frames:secondaryFrameViews(data,now),profile,exploring:profile?.active===true,capitalAllocation,nominal:capitalAllocation?.baseNominal??data.frequency?.account?.nominal_usd??profile?.policy?.nominalUSD??null,leverage:capitalAllocation?.leverage??profile?.policy?.leverage??x.protocol?.leverage,entry,contexts,patterns,finances,running,quoteUsable,pending,opened,reason,status,quoteAt:quote?.event_at??null,lastEvaluationAt:activity.last_evaluation_at??null};
}
export function operationBars(op,spotFrames,tf){
 if(futuresPlan(op?.plan)){const panels=op.plan.evidence?.panels,panel=Array.isArray(panels)?panels.find(p=>p?.tf===tf):null;return {bars:Array.isArray(panel?.candles)?panel.candles:[],source:'PF_XBTUSD_DECISION',historical:true};}
 return {bars:spotFrames?.[tf]??[],source:'KRAKEN_SPOT',historical:false};
}

export const secondaryFrameLabel=tf=>({1:'1 m',5:'5 m',15:'15 m',60:'1 h',240:'4 h',1440:'1 día'}[tf]??(Number.isFinite(tf)&&tf>0?tf+' m':'—'));
export function secondaryFrameViews(data,now){
 const frames=data?.secondary_activity?.frames,model=monitorPresentation(data,now);if(!model&&!frames)return [];
 return [1,5,15,60,240].map(tf=>frames?.[tf]&&typeof frames[tf]==='object'?{...frames[tf],timeframe:tf}:{timeframe:tf,entry_enabled:null}).map(f=>{
  const at=Number.isSafeInteger(f.last_evaluation_at)?f.last_evaluation_at:null,presented=model?.frames.find(row=>row.key===String(f.timeframe)),stale=presented?.stale??(!at||now-at>f.timeframe*60000+30000||at>now+1000);
  return {...f,label:secondaryFrameLabel(f.timeframe),contextLabel:secondaryFrameLabel(f.context_timeframe),at,stale,dataComplete:f.data_complete===true,entryEnabled:typeof f.entry_enabled==='boolean'?f.entry_enabled:null,
   statusLabel:({COMPLETE:'Evaluada',RECOVERED:'Evaluada tras recuperar datos',TRANSIENT_BLOCKED:'Reintentando dentro de la ventana',MISSED:'Ventana perdida',WAITING_FIRST_NATURAL_CLOSE:'Esperando cierre natural'})[f.evaluation_status]??f.evaluation_status??'Sin evaluación',
   explanation:f.reason_text??exitReasonLabel(f.reason??f.last_result),neuralStatus:f.neural_entry_status??null};
 });
}
const operationEventTypes=new Set(['SELECTED','FILLED','PARTIAL_FILL','PARTIAL_CLOSE','CLOSED','NOT_FILLED','ORDER_REMAINDER_CANCELLED','FUNDING_RECONCILED']);
const valueEvent=e=>e?.payload&&typeof e.payload==='object'?{...e.payload,type:e.payload.type??e.kind,event_id:e.event_id??e.id??e.payload.event_id}:e;
export function secondaryHistoryKey(event){
 const e=valueEvent(event),type=e?.type??e?.kind,id=e?.operation_id??e?.id??'';
 if(type==='CLOSED')return 'CLOSED:'+id;
 if(['FILLED','PARTIAL_FILL','PARTIAL_CLOSE'].includes(type))return [type,id,e?.at??'',e?.qty??'',e?.cumulative_qty??''].join(':');
 if(['SELECTED','NOT_FILLED','ORDER_REMAINDER_CANCELLED'].includes(type))return type+':'+id;
 return [type,id,e?.fill_id??'',e?.event_id??e?.event_key??'',e?.at??''].join(':');
}
export function mergeSecondaryHistory(...sources){
 const records=new Map();for(const source of sources)for(const original of Array.isArray(source)?source:[]){const raw=valueEvent(original);if(!raw||typeof raw!=='object')continue;const e={...raw,type:raw.type??raw.kind};if(!e.type||!Number.isFinite(Number(e.at)))continue;if(e.ledger&&e.ledger!=='FREQUENT_PAPER')continue;
  const key=secondaryHistoryKey(e),previous=records.get(key);records.set(key,previous?{...previous,...e}:e);
 }
 return [...records.values()].sort((a,b)=>Number(b.at)-Number(a.at)||secondaryHistoryKey(a).localeCompare(secondaryHistoryKey(b)));
}
export function secondaryHistoryView(event){
 const e=valueEvent(event),type=e?.type??e?.kind,closed=type==='CLOSED',partial=type==='PARTIAL_CLOSE',manual=Boolean(e?.manual||e?.management_override||String(e?.reason??'').startsWith('MANUAL_'));
 const funding=type==='FUNDING_RECONCILED',net=closed?numeric(e.pnl):partial?numeric(e.fill_pnl??e.pnl):funding?numeric(e.net_adjustment):null,training=e.training_eligibility;
 return {event:e,type,key:secondaryHistoryKey(e),operation:operationEventTypes.has(type),closed,partial,net,manual,
  accounted:typeof e.accounted==='boolean'?e.accounted:closed||partial||funding,netLabel:closed?'Neto final acumulado':partial?'Neto de este fragmento':funding?'Ajuste de financiación':null,
  trainingEligible:manual||training?.status==='EXCLUDED'?false:typeof e.training_eligible==='boolean'?e.training_eligible:training?.status==='ELIGIBLE'?true:null,
  trainingStatus:training?.status??null,trainingExclusion:manual?'Cierre manual: excluido de decisiones autónomas':e.training_exclusion??e.exclusion??training?.reason??null,
  title:eventLabel(e),provisional:e.result_final===false||e.funding_complete===false};
}
export function parseSecondaryHistoryPage(page){
 if(page?.version!=='secondary-history-page-1.0.0'||!Array.isArray(page.records)||page.records.length>200||!(page.previous_cursor===null||typeof page.previous_cursor==='string')||typeof page.backfill_complete!=='boolean')throw Error('SECONDARY_HISTORY_RESPONSE_INVALID');
 return {records:mergeSecondaryHistory(page.records),cursor:page.previous_cursor,complete:page.backfill_complete,generatedAt:page.generated_at??null};
}
