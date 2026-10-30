import {entryProfile} from './entry-profile.js';
import {recipeComponents,componentVersion} from './timeframes.js';
import {secondaryRisk} from './secondary-risk.js';
// Read-only projection. No recipient identifiers, credentials or trading mutations.
export const PROJECT = 'mofjhwathxzfnjapvvst';
const fields = (value, keys) => Object.fromEntries(keys.filter(k => value?.[k] !== undefined).map(k => [k, value[k]]));
const predictionView = p => p ? fields(p,['status','event','p','interval','interval_type','n','model','validated_at','reason']) : null;
export function planView(p) {
  if (!p) return null;
  return {...fields(p, ['id','family','direction','entry','limit','stop','target','order','expires_at','confirmed_at','version','criteria','recipe','recipe_title','decision_at','timeframe','evidence','execution_model']), prediction:predictionView(p.study?.prediction),sizing:fields(p.sizing,['qty','risk','risk_pct','exposure','reserved','target_net','target_fees','break_even','effective_leverage','net_rr','fee','slippage','leverage','initial_margin','financing','funding_rate','funding_reserved','funding_interval','liquidation_estimate','liquidation_model','decision'])};
}
export function learningView(s,now) {
 const l=s.learning;if(!l)return null;
 const versionFor=v=>s.portfolio&&v&&!v.endsWith('@'+s.portfolio.version)?v+'@'+s.portfolio.version:v;
 const active=s.research?.versions?.[s.research?.active],trial=s.laboratory?.trials?.find(t=>t.version===s.laboratory.active);
 const groupRefs=(ledger,version,recipe)=>recipe?.components?recipeComponents(recipe).map(r=>[ledger,versionFor(componentVersion(version,recipe,r.tf)),r.tf]):[[ledger,versionFor(version),recipe?.tf??null]];
 const groups=[...groupRefs('ENGINE',s.research?.active,active?.recipe),...groupRefs('FREQUENT_PAPER',s.laboratory?.active??s.frequency?.version,trial?.recipe)].map(([ledger,version,timeframe])=>{
  const g=l.groups?.[ledger+':'+version],a=g?.active,c=g?.candidate;
  const expired=a&&now-a.validated_at>l.protocol.maxModelAgeMs;
  const rows=g?.rows??[],wins=rows.reduce((sum,r)=>sum+(r.y===1?1:0),0);
  const status=c?'SHADOW_VALIDATION':a?.suspended?'PREDICTION_SUSPENDED':expired?'MODEL_EXPIRED':a?'PREDICTION_VALIDATED':'COLLECTING';
  return {ledger,version,timeframe,status,usable:g?.usable??0,excluded:g?.excluded??0,unfilled:g?.unfilled??0,attempts:g?.attempts??0,
   training:{n:rows.length,wins,losses:rows.length-wins},
   candidate:c?{...fields(c,['id','trained_at','train_n']),report:fields(c.report,['status','n','days','reason'])}:null,
   active:a?{...fields(a,['id','validated_at','train_n','suspended']),expired:Boolean(expired),report:fields(a.report,['n','days','brier','baselineBrier','ece'])}:null,
   lastAnalysis:g?.lastAnalysis?{...fields(g.lastAnalysis,['at','id','reason','quality','net','fees','gross','holding_ms','training_eligible','exclusion','diagnosis','maxFavourableR','maxAdverseR']),prediction:predictionView(g.lastAnalysis.prediction)}:null,
   lastReview:g?.history?.length?{at:g.history.at(-1).at,report:fields(g.history.at(-1).report,['status','n','days','reason'])}:null};
 });
 return {...fields(l,['version','started_at']),protocol:fields(l.protocol,['minTraining','minClass','minValidation','minValidationDays','maxAttempts','newLabelsPerAttempt','changesEntryRules']),groups};
}
export function accountView(a) {
  if (!a) return null;
  const pending=(a.portfolio?Object.values(a.pendingOrders??{}):a.pending?[a.pending]:[]).map(p=>({...fields(p,['placed_at','triggered']),plan:planView(p.plan)}));
  const positions=(a.portfolio?Object.values(a.positions??{}):a.position?[a.position]:[]).map(p=>({...fields(p,['qty','entry','entered_at','expires_at','quality','initial_margin','total_entry','entry_fee']),plan:planView(p.plan)}));
  const reserved=pending.reduce((s,p)=>s+Number(p.plan?.sizing?.reserved??0),Number(a.fundingReserve??0)),risk=[...pending,...positions].reduce((s,p)=>s+Number(p.plan?.sizing?.risk??0),0);
  return {...fields(a,['cash','equity','net','fees','lifetimeMaxDrawdown','closed','observedClosed','ambiguousClosed','wins','losses','maxDrawdown','halted']),
    pending:pending[0]??null,position:positions[0]??null,pending_orders:pending,positions,position_count:positions.length,pending_count:pending.length,
    reserved_cash:reserved,available_cash:Number(a.cash)-reserved,committed_risk:risk,max_slots:a.portfolio?3:1};
}
export function frequencyView(s) {
  const f=s.frequency;if(!f)return null;
  const b=f.baseline_at_start,a=s.research?.versions?.[s.research?.active]?.account;
  const delta=(key)=>a&&b?.[key]!==undefined?Number(a[key])-Number(b[key]):null;
  return {...fields(f,['version','started_at','grossClosed','closedFees','daySelections']),
    account:accountView(f.account),risk_profile:secondaryRisk(f.account),entry_profile:entryProfile(f.account),counts:fields(f.counts,['evaluations','candidates','selected','filled','closed','notFilled','suppressed']),
    protocol:fields(f.protocol,['initialCash','intervalMs','maxSelectionsPerUTCDate','maxHoldingMinutes','risk','dailyLoss','drawdown','fee','slippage','minNetRR']),
    lastDecision:f.lastDecision?{...fields(f.lastDecision,['at','cutoff','reason','timeframe']),criteria:fields(f.lastDecision.criteria,['fastAboveSlow','positiveCandle','aboveFast','positiveMomentum','trend','trigger','costRoom'])}:null,
    history:(f.history??[]).slice(0,40).map(e=>fields(e,['type','at','id','reason','entry','price','qty','pnl','fees','quality','timeframe','direction','leverage'])),
    baseline_since_start:{version:b?.version,version_changed:s.research?.active!==b?.version,initial_equity:b?.equity,net:delta('net'),fees:delta('fees'),closed:delta('closed')}
  };
}
export function laboratoryView(s) {
 const l=s.laboratory;if(!l)return null;
 return {...fields(l,['version','started_at','status','active','executionRevision']),archived_rounds:l.execution_archives?.length??0,protocol:fields(l.protocol,['maxTrials','minTraining','minValidation','minCalendarDays','purgeMs','maxTrialDays','refillBelow','refillTo','maxDrawdown','risk','dailyLoss']),
  sources:(l.protocol?.sources??[]).map(x=>fields(x,['id','url','title','evidence','lesson'])),
  recipes:(l.protocol?.recipes??[]).flatMap(recipeComponents).map(x=>fields(x,['id','title','tf','kind','lookback','fast','slow','stopATR','targetATR','holdingMs','minNetRR','margin'])),
  funding:fields(l.funding,['initial','added','count','maxDrawdown']),
  deposits:(l.funding?.history??[]).slice(-20).map(x=>fields(x,['at','before','amount','after','kind'])),
  primary:l.primary?{...fields(l.primary,['version','source','at']),report:fields(l.primary.report,['n','days','net','stressNet','drawdown'])}:null,
  trials:(l.trials??[]).map(t=>({...fields(t,['version','status','started_at','training','closed','net','drawdown','refilled']),recipe:{...fields(t.recipe,['id','title','tf']),timeframes:recipeComponents(t.recipe).map(r=>r.tf)},frames:t.frames??{},decisions:t.decisions??{},diagnostics:t.diagnostics??{},validation:t.validation?{...fields(t.validation,['after','clean','closed','net','fees','drawdown','incomplete','unresolved']),days:t.validation.days?.length??0}:null,report:t.report?fields(t.report,['status','reason','at','n','days','net','stressNet','drawdown']):null})),
  lastDecision:l.lastDecision?{...fields(l.lastDecision,['at','cutoff','reason','timeframe','version']),criteria:fields(l.lastDecision.criteria,['trend','trigger','costRoom'])}:null
 };
}
export async function readMonitor({url,key,fetchImpl=fetch,now=Date.now()}) {
  const q = async (table, params) => {
    const response=await fetchImpl(url+'/rest/v1/'+table+'?'+new URLSearchParams(params), {
      headers:{apikey:key,Authorization:'Bearer '+key}, signal:AbortSignal.timeout(10000)
    });
    if (!response.ok) throw Error('SOURCE_UNAVAILABLE');
    const rows=await response.json(); if(!Array.isArray(rows)) throw Error('SOURCE_INVALID'); return rows;
  };
  const [states,audits,evaluations,notices,results,chart] = await Promise.all([
    q('lumi_trading_state',{select:'updated_at,revision,lease_until,state',id:'eq.KRAKEN_BTCUSD_PAPER',limit:'1'}),
    q('lumi_trading_events',{select:'created_at,payload',kind:'eq.FEED_AUDIT',order:'created_at.desc',limit:'1'}),
    q('lumi_trading_events',{select:'created_at,kind,payload',kind:'in.(RULE_EVALUATION,EVALUATION_SKIPPED)',order:'created_at.desc',limit:'12'}),
    q('lumi_trading_outbox',{select:'id,kind,status,created_at,finished_at,payload',order:'created_at.desc',limit:'20'}),
    q('lumi_trading_events',{select:'created_at,kind,payload',kind:'in.(CLOSED,NOT_FILLED,FILLED,SUPPRESSED)',order:'created_at.desc',limit:'30'}),
    q('lumi_trading_events',{select:'created_at,at:payload->at,price:payload->feed->quote->ask',kind:'eq.FEED_AUDIT',order:'created_at.desc',limit:'180'})
  ]);
  return projectMonitor({states,audits,evaluations,notices,results,chart,now});
}
export function projectMonitor({states,audits=[],evaluations=[],notices=[],results=[],chart=[],now=Date.now()}) {
  const row=states[0]; if(!row?.state) throw Error('STATE_UNAVAILABLE');
  const s=row.state,v=s.research?.versions?.[s.research?.active],f=audits[0]?.payload?.feed;
  return {schema:1,generated_at:now,updated_at:row.updated_at,lease_until:row.lease_until,revision:row.revision,
    started_at:s.started_at,initial_cash:s.capital?.initialCash??null,version:s.research?.active??null,
    next_summary_at:typeof s.last_summary==='number'?s.last_summary+7*86400000:null,
    account:accountView(v?.account),alert_account:accountView(s.alert),frequency:frequencyView(s),learning:learningView(s,now),laboratory:laboratoryView(s),
    portfolio:s.portfolio?{...fields(s.portfolio,['version','started_at']),protocol:fields(s.portfolio.protocol,['maxSlots','maxRiskUSD','maxRiskFraction','openRisk','dailyLoss','cashReserve','minNetRR','riskTiers'])}:null,
    entry_profile:s.entryProfile?fields(s.entryProfile,['version','status','requested_at','activated_at']):null,
    secondary_risk:s.secondaryRisk?fields(s.secondaryRisk,['version','status','requested_at','activated_at','capital_event']):null,
    counters:fields(s.counters,['candidates','selected','mature','notFilled','suppressed','delivered','rejected','unknown','criticalIncidents']),
    margin:s.margin?{...fields(s.margin,['version','status','requested_at','activated_at']),protocol:fields(s.margin.protocol,['leverage','maxGrossExposure','maxMarginFraction','maintenance','longFunding','shortFunding','fundingInterval','model','realTrading'])}:null,
    timeframes:s.timeframes?fields(s.timeframes,['version','frames','status','requested_at','activated_at','series']):null,
    paused:Boolean(s.research?.paused),setups:Object.values(v?.strategy?.setups??{}).map(x=>fields(x,['family','direction','at','expires'])),
    feed:f?{sampled_at:audits[0].payload.at,connected:f.connected,reconciled:f.reconciled,system:f.system,maintenance:f.maintenanceBlocked,
      quote:fields(f.quote,['bid','ask','event_at']),trade:fields(f.trade,['price','event_at']),counters:fields(f.counters,['quotes','trades','reconnects'])}:null,
    chart:chart.map(x=>({at:Number(x.at),price:Number(x.price)})).filter(x=>Number.isFinite(x.at)&&x.price>0).reverse(),
    evaluations:evaluations.map(x=>({at:x.payload.at??Date.parse(x.created_at),kind:x.kind,reason:x.payload.reason,timeframe:x.payload.timeframe??15,context:fields(x.payload.context,['long','short','breakLong','breakShort','range'])})),
    notices:notices.map(x=>({id:x.id,kind:x.kind,status:x.status,at:Date.parse(x.created_at),finished_at:x.finished_at,type:x.payload?.type,account:x.payload?.account??x.payload?.ledger,plan:planView(x.payload?.plan)})),
    results:results.map(x=>({at:x.payload.at??Date.parse(x.created_at),kind:x.kind,...fields(x.payload,['id','ledger','reason','entry','price','qty','pnl','fees','quality','timeframe','family','direction','leverage'])}))
  };
}
export function monitorHealth(d, now) {
  if(!d) return {tone:'neutral',title:'Conectando con tu bot',detail:'Consultando el estado de la simulación.'};
  const age=now-Date.parse(d.updated_at);
  if(!Number.isFinite(age) || age< -10000 || age>45000 || !Number.isFinite(Date.parse(d.lease_until)) || Date.parse(d.lease_until)<=now) return {tone:'bad',title:'Sin actividad reciente',detail:'El monitor no confirma que el bot siga activo. Último estado conservado.'};
  if(d.account?.halted || d.paused) return {tone:'warn',title:'Simulación en pausa',detail:'El motor tiene activado un límite o una pausa. No se esperan nuevas entradas.'};
  const f=d.feed;
  if(!f || now-f.sampled_at>95000 || !f.connected || !f.reconciled || f.maintenance || f.system!=='online') return {tone:'warn',title:'Esperando datos válidos',detail:'El bot guarda su estado, pero falta confirmar la conexión o sincronización del mercado.'};
  if(!f.quote?.event_at || !f.trade?.event_at || f.sampled_at-f.quote.event_at>5000 || f.sampled_at-f.trade.event_at>30000) return {tone:'warn',title:'Precios pendientes de actualizar',detail:'En la última muestra, los datos superaban el límite de antigüedad del bot.'};
  if(d.account?.position) return {tone:'good',title:d.account.position_count>1?d.account.position_count+' operaciones simuladas abiertas':'Operación simulada abierta',detail:'El bot sigue por separado las ventas por stop, objetivo o vencimiento y las entradas pendientes.'};
  if(d.account?.pending) return {tone:'good',title:'Entrada preparada',detail:'Hay un plan simulado. Todavía debe activarse su condición de entrada.'};
  return {tone:'good',title:'Esperando una oportunidad',detail:'El bot sigue analizando. Aún no hay una entrada seleccionada para operar.'};
}
export function reasonText(reason) {
  const margin={LAB_WAIT_ENTRY_PATTERN:'Hay tendencia, pero falta una ruptura de 5 velas o una recuperación tras el retroceso.',LAB_WAIT_TREND:'Falta confirmar una tendencia alcista o bajista.',LAB_WAIT_BREAKOUT:'Hay tendencia, pero el cierre no rompe el extremo de la ventana del patrón.',LAB_WAIT_PULLBACK:'Hay tendencia, pero falta confirmar el retroceso.',MARGIN_CAPITAL_UNAVAILABLE:'No hay margen disponible dentro de los límites de esta cuenta.',MARGIN_METADATA_UNAVAILABLE:'El exchange no confirma esta palanca para el instrumento.',STOP_TOO_CLOSE_TO_LIQUIDATION:'El stop quedaría demasiado cerca de la liquidación estimada.',MARGIN_RESERVATION_CHANGED:'La ejecución requiere más margen del reservado; se cancela.',LIQUIDATION_MODEL:'Liquidación conservadora estimada del simulador'};if(margin[reason])return margin[reason];
  const portfolio={PORTFOLIO_SLOTS_FULL:'Ya hay tres operaciones o entradas pendientes en esta cuenta.',PORTFOLIO_RISK_COMMITTED:'El presupuesto de riesgo ya está reservado por otras operaciones.',DUPLICATE_OPPORTUNITY:'Esta oportunidad ya se programó; no se duplica.',WAITING_LEGACY_POSITIONS:'La nueva prueba espera que terminen las operaciones anteriores.',VALIDATION_PURGE:'Pausa entre entrenamiento y validación para separar los resultados.'};if(portfolio[reason])return portfolio[reason];
  const frequent={LAB_WAIT_PATTERN:'La tendencia y el patrón aún no confirman la entrada.',LAB_COSTS_TOO_HIGH:'El objetivo basado en volatilidad no compensa los costes; se descarta sin alejar el objetivo.',LAB_BARS_NOT_SYNCHRONIZED:'Falta una vela cerrada y sincronizada del plazo del experimento.',FREQUENCY_WAIT_MOMENTUM:'Falta impulso: media rápida, cierre o vela no confirmaron la compra.',ENTRY_SELECTED:'Entrada seleccionada; espera el cruce del precio para ejecutarse.',POSITION_OR_ENTRY_IN_PROGRESS:'Ya hay una entrada pendiente o una operación abierta.',DAILY_SELECTION_LIMIT:'Se alcanzó el límite de 12 planes seleccionados de hoy (UTC).',COOLDOWN:'Pausa de un minuto después de la última salida o cancelación.',ONE_MINUTE_DATA_UNAVAILABLE:'No se pudo validar el historial de un minuto.',DAILY_RISK_LIMIT:'La nueva entrada excedería el presupuesto de pérdida de hoy.',DRAWDOWN_HALT:'Cuenta en pausa por su límite de caída del capital.',MINIMUM_OR_LIQUIDITY:'El tamaño permitido no cumple el mínimo o la liquidez disponible.',NET_RR_TOO_LOW:'El beneficio previsto no compensa el riesgo y los costes exigidos.',STALE_QUOTE:'Cotización demasiado antigua; no se prepara una entrada.',STALE_TRADE:'Última operación de mercado demasiado antigua.',LATE_EVALUATION:'Se pasó la ventana de evaluación de esta vela.',FEED_DISCONNECT:'Entrada cancelada al desconectarse el mercado.'};
  if(frequent[reason])return frequent[reason];
  const exact={SIN_OPORTUNIDAD_VALIDA:'Ningún patrón completó las condiciones de entrada.',CANDIDATES:'Se detectaron candidatos; se comprueban riesgo y ejecución.',LATE_OR_RECONCILING:'Evaluación omitida mientras se sincronizaban los datos.',BAR_RECONCILIATION_DEADLINE:'La sincronización superó el plazo de la evaluación.',STOP:'Stop loss',TARGET:'Take profit',TIMEOUT:'Vencimiento de la operación',VENCIDA:'La entrada venció sin ejecutarse',ENTRADA_PERDIDA:'El precio pasó el punto de entrada',STOP_DISTANCE:'Distancia del stop fuera de los límites',NET_RR:'Relación beneficio/riesgo insuficiente tras costes',MIN_ORDER:'Tamaño por debajo del mínimo permitido',PORTFOLIO_RESERVED:'La cuenta ya tiene una entrada o posición'};
  if(exact[reason]) return exact[reason];
  if(String(reason).startsWith('UNSYNCHRONIZED')) return 'Las velas todavía no estaban sincronizadas. Se omitió esa evaluación.';
  if(String(reason).includes('WARMUP')||String(reason).includes('INSUFFICIENT')) return 'Se está reuniendo el historial necesario para evaluar.';
  return reason?'Condición registrada: '+reason:'Todavía no hay una evaluación registrada.';
}
