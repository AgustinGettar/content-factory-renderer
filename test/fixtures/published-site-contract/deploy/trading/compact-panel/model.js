// Lumi Trading secondary PAPER - compact owner-private read-only projection.
// Data source: existing same-origin GET /api/monitor/live; no trading actions.
const numeric = x => (typeof x === 'number' && Number.isFinite(x)) ||
  (typeof x === 'string' && x.trim() !== '' && Number.isFinite(Number(x)));
const pick = (...xs) => xs.find(x => x !== null && x !== undefined) ?? null;
const number = x => numeric(x) ? Number(x) : null;
const count = x => number(x)!==null&&Number.isSafeInteger(Number(x))&&Number(x)>=0?Number(x):null;
const isQuantPlan = p => typeof p?.quant_contract?.version === 'string' && p.quant_contract.version.startsWith('secondary-quant-');
const eventTime = x => typeof x === 'string' && !numeric(x) ? Date.parse(x) || 0 : number(x) ?? 0;
const tfName = x => ({1:'1m',5:'5m',15:'15m',60:'1h',240:'4h'})[Number(x)] ?? '—';
const REASONS = {
 WAIT_SCALP_CONTINUATION:'Esperando retroceso y recuperación del impulso',
 WAIT_SCALP_REVERSION:'Esperando rechazo confirmado en el extremo del rango',
 WAIT_BREAKOUT_RETEST:'Esperando ruptura confirmada y retesteo posterior',
 WAIT_MOMENTUM:'Esperando aceleración con volumen y continuidad',
 WAIT_TREND_FOLLOWING:'Esperando continuación de tendencia confirmada',
 WAIT_MEAN_REVERSION:'Esperando rechazo y retorno hacia VWAP',
 WAIT_RANGE_TRADING:'Esperando rechazo cerca del soporte o la resistencia',
 WAIT_VOLATILITY_EXPANSION:'Esperando compresión y ruptura con expansión',
 WAIT_LIQUIDITY_SWEEP:'Esperando barrido y recuperación del nivel',
 ENTRY_PENDING:'Señal seleccionada; pendiente de ejecución simulada',

 REGIME_NOT_ELIGIBLE:'Esta estrategia no corresponde al régimen actual',
 STRATEGY_TIMEFRAME_NOT_ENABLED:'Esta estrategia no se utiliza en este plazo',
 QUANT_PATTERN_NOT_CONFIRMED:'Todavía no hay confirmación del patrón',
 PATTERN_NOT_CONFIRMED:'Todavía no hay confirmación del patrón',
 VOLUME_NOT_CONFIRMED:'El volumen todavía no confirma la entrada',
 LIQUIDITY_NOT_CONFIRMED:'La liquidez o el spread no permiten esta entrada',
 REVERSAL_AGAINST_STRONG_TREND:'La tendencia es demasiado fuerte para buscar una reversión',
 QUANT_STRUCTURAL_BARRIERS_INVALID:'El stop o el objetivo no dejan un recorrido técnico válido',
 QUANT_COST_OR_NET_RR:'El recorrido no compensa los costes y el riesgo',
 QUANT_MARGIN_SCHEDULE_UNVERIFIED:'La tabla de margen necesita verificarse',
 QUANT_MARK_PRICE_UNAVAILABLE:'Falta un precio de referencia verificable',
 QUANT_DAILY_LOSS_LIMIT:'Nuevas entradas pausadas por el límite diario; las salidas siguen activas',
 QUANT_DRAWDOWN_REVIEW_REQUIRED:'El drawdown requiere revisión; las salidas siguen activas',
 QUANT_EVALUATION_ERROR:'Error al evaluar: requiere revisión técnica',
 HEDGE_MODE_NOT_VALIDATED:'Ya existe exposición contraria y no está habilitado el modo de cobertura',
 QUANT_TECHNICAL_TRAILING:'Retroceso al stop técnico protegido',
 QUANT_MOMENTUM_EXHAUSTION:'Agotamiento confirmado del impulso',

 NO_CONFIRMED_5M_TREND:'No hay tendencia confirmada en 5m',
 MISSING_CONTEXT_REGIME:'Aún falta el contexto de 15m',
 NO_NET_ECONOMIC_ADVANTAGE:'La oportunidad no cubre los costes',
 SPREAD_TOO_WIDE:'El spread es demasiado alto',
 WAIT_PULLBACK:'Esperando un retroceso', WAIT_PULLBACK_CONFIRMATION:'Esperando confirmación del retroceso',
 WAIT_BREAKOUT:'Esperando una ruptura', WAIT_RANGE_REENTRY:'Esperando reentrada al rango',
 CONTEXT_NOT_SYNCHRONIZED:'Las velas de contexto aún no están sincronizadas',
 FUTURES_DATA_NOT_FRESH:'La cotización no está actualizada',
 FUNDING_NOT_AVAILABLE:'Falta información de financiación',
 TIMEOUT:'Tiempo máximo', STOP:'Stop loss', STRUCTURAL_TARGET:'Objetivo estructural',
 NET_TARGET:'Objetivo neto', TRAILING_RETRACEMENT:'Retroceso de la ganancia',
 MANUAL_PROFIT:'Cierre manual con ganancia', MANUAL_CLOSE:'Cierre manual',
 PULLBACK_NOT_CONFIRMED:'El retroceso no está confirmado',
 RESEARCH_OBSERVER_ERROR:'Observador experimental no disponible',
 DATA_GAP:'Faltan cotizaciones suficientes'
};
const REGIMES = {
 UPTREND:'Tendencia alcista', DOWNTREND:'Tendencia bajista',
 RANGE:'Mercado lateral', HIGH_VOLATILITY:'Volatilidad alta',
 VOLATILITY_COMPRESSION:'Volatilidad baja', BREAKOUT_EXPANSION:'Ruptura / expansión',
 ERRATIC:'Mercado errático', COMPRESSION:'Volatilidad comprimida', ILLIQUID:'Liquidez insuficiente', UNDETERMINED:'Indeterminado', UNKNOWN:'No disponible'
};
/** @param {unknown} code @param {unknown} [readable] */
export const reasonText = (code, readable = null) => {
 if(typeof readable === 'string' && readable.trim() && readable.trim()!==code) return readable.trim();
 if(!code) return 'Sin evaluación registrada';
 return REASONS[code] ?? String(code).replaceAll('_',' ').toLowerCase();
};
export const regimeText = x => REGIMES[x] ?? 'Sin clasificación';
export const fmtUSD = (v,{signed=false}={}) => {
 const n=number(v); if(n===null) return '—';
 const digits=n===0||Math.abs(n)>=0.01?2:Math.abs(n)>=0.0001?4:6;
 const abs=new Intl.NumberFormat('es-AR',{minimumFractionDigits:digits,maximumFractionDigits:digits}).format(Math.abs(n));
 return (n<0?'−':signed&&n>0?'+':'')+'US$ '+abs;
};
export const fmtDate = v => {
 const n=typeof v==='string'?Date.parse(v):v;
 if(!Number.isFinite(n)||n<=0||!Number.isFinite(new Date(n).getTime()))return 'Sin registro';
 return new Intl.DateTimeFormat('es-AR',{timeZone:'Europe/Rome',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}).format(n);
};
export const escapeHTML = s => String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
// Presentation thresholds mirror the existing monitor contract, not engine policy.
export const SNAPSHOT_MAX_AGE_MS=15000,QUOTE_MAX_AGE_MS=5000,FUTURE_TOLERANCE_MS=1000;
const stamp = x => numeric(x)&&Number.isSafeInteger(Number(x))&&Number(x)>0&&Number(x)<=8640000000000000?Number(x):null;
export const quoteAge = (value,now) => stamp(value)!==null?now-Number(value):null;
const current = (value,now,maxAge) => stamp(value)!==null&&now-Number(value)>=-FUTURE_TOLERANCE_MS&&now-Number(value)<maxAge;
const dataOf = payload => payload?.snapshot??payload?.data??payload;
export function snapshotOrder(previous,payload,now=Date.now()) {
 const d=dataOf(payload),prior=dataOf(previous),at=stamp(d?.generated_at??d?.secondary_activity?.snapshot_at??d?.feed?.sampled_at??d?.at);
 if(!d||d.schema!=null&&d.schema!==1||!Number.isSafeInteger(d.revision)||d.revision<0||at===null||at>now+FUTURE_TOLERANCE_MS)return 'INVALID_SNAPSHOT';
 // started_at identifies durable history, not a process boot. Normal worker
 // restart preserves its revision sequence. No worker-generation contract exists:
 // a changed/missing history identity cannot safely be ordered against the old one.
 const identity=d.started_at==null?null:stamp(d.started_at),oldIdentity=prior?.started_at==null?null:stamp(prior.started_at);
 if(d.started_at!=null&&(identity===null||identity>at))return 'INVALID_SNAPSHOT';
 if(!prior)return 'ACCEPT';
 const oldAt=stamp(prior.generated_at??prior.secondary_activity?.snapshot_at??prior.feed?.sampled_at??prior.at);
 if(identity!==oldIdentity){
  // A new durable history is different from a normal process restart. Only
  // its explicit, later identity and a current non-regressing snapshot can
  // establish a new baseline; revisions are never compared across histories.
  if(identity!==null&&oldIdentity!==null){
   if(identity<oldIdentity)return 'OLDER_SNAPSHOT';
   if(at>=oldAt&&current(at,now,SNAPSHOT_MAX_AGE_MS))return 'ACCEPT_NEW_HISTORY';
  }
  return 'SOURCE_CHANGED';
 }
 if(d.revision<prior.revision||at<oldAt)return 'OLDER_SNAPSHOT';
 return 'ACCEPT';
}
export function viewModel(payload, now=Date.now(), receivedAt=null) {
 const d=payload?.snapshot??payload?.data??payload;
 if(!d||typeof d!=='object')throw Error('MONITOR_RESPONSE_REQUIRED');
 const fin=d.secondary_finances??d.frequency?.financial_summary;
 if(!fin||fin.mode!=='PAPER'||fin.ledger!=='FREQUENT_PAPER')throw Error('SECONDARY_PAPER_SNAPSHOT_REQUIRED');
 const account=d.frequency?.account??{},activity=d.secondary_activity??{};
 const asOf=stamp(d.generated_at??activity.snapshot_at??d.feed?.sampled_at??d.at),age=quoteAge(asOf,now);
 const snapshotFresh=current(asOf,now,SNAPSHOT_MAX_AGE_MS);
 const process=activity.process??{},market=activity.market??{};
 const workerVerified=process.status==='RECENT_COMMIT_AND_LEASE',marketVerified=market.usable===true&&market.issue==null;
 let status=!snapshotFresh?'STALE_SNAPSHOT':!workerVerified?'WORKER_UNVERIFIED':!marketVerified?'MARKET_ISSUE':'LIVE_PAPER';
 const openCollectionKnown=account.positions!==null&&typeof account.positions==='object';
 const positions=Array.isArray(account.positions)?account.positions:openCollectionKnown?Object.values(account.positions):[];
 const pendingSource=account.pending_orders??account.pendingOrders;
 const pendingCollectionKnown=pendingSource!==null&&typeof pendingSource==='object';
 const pending=Array.isArray(pendingSource)?pendingSource:pendingCollectionKnown?Object.values(pendingSource):[];
 const seenPositions=new Set();let incompletePositions=0,duplicatePositions=0;
 const resultPositions=positions.filter(p=>{
  if(!p?.plan||typeof p.plan.id!=='string'||!p.plan.id.trim()||!['PF_XBTUSD','PAPER:KRAKEN_FUTURES:PF_XBTUSD'].includes(String(p.plan.instrument??''))){incompletePositions++;return false;}
  if(seenPositions.has(p.plan.id)){duplicatePositions++;return false;}
  seenPositions.add(p.plan.id);return true;
 })
  .map(p=>{
   const plan=p.plan,exit=p.live_exit??{},protection=p.profit_protection??{};
   // exit.at is valuation time, not the timestamp of its underlying quote.
   const quoteAt=stamp(exit.quote_at);
   const quoteFresh=snapshotFresh&&workerVerified&&marketVerified&&exit.fresh===true&&current(quoteAt,now,QUOTE_MAX_AGE_MS+1);
   const complete=quoteFresh && exit.liquidity_ok!==false && exit.funding_complete!==false && exit.result_final!==false
    && !p.funding_uncertain && !p.funding_pending?.length && !p.funding_gaps?.length && !p.closed_funding_pending?.length && numeric(exit.net);
   return {
    id:String(plan.id??''),side:['SHORT','LONG'].includes(plan.direction)?plan.direction:'UNKNOWN',timeframe:tfName(plan.timeframe),
    origin:isQuantPlan(plan)?'Motor cuantitativo':'Contrato anterior',fibonacci:isQuantPlan(plan)?plan.quant_contract?.fibonacci??null:null,
    pattern:String(p.plan.recipe_title??p.plan.pattern??'Patrón no registrado').slice(0,85),
    net:complete?String(exit.net):null,lastNet:numeric(exit.net)?String(exit.net):null,entry:pick(p.entry,plan.entry),
    stop:pick(p.quant_management?.stop,plan.stop,plan.exit_policy?.stop),target:pick(plan.target,plan.exit_policy?.target),
    leverage:pick(plan.sizing?.leverage,plan.execution_contract?.leverage,p.leverage),
    maxFavourable:pick(p.excursions?.max_favourable_net,p.max_favourable),
    protectedFloor:pick(protection.protected_net,protection.floor_net),
    risk:pick(p.remaining_risk,plan.sizing?.risk),expectedNet:pick(plan.entry_economics?.expected_net_target,plan.sizing?.target_net),margin:pick(p.initial_margin,plan.sizing?.initial_margin),regime:plan.quant_contract?.regime??null,
    quoteAt,
    exitReason:pick(p.exit_intent?.reason,p.execution_blocker)
   };
  });
 const times=['1','5','15','60','240'];
 const frames=times.map(key=>{
  const f=activity.frames?.[key]??{};
  const original=f.last_evaluation??null;
  const decisions=Array.isArray(original?.pattern_decisions)?original.pattern_decisions.filter(x=>x&&typeof x==='object'):[];
  const relevant=decisions.find(x=>x.reason==='ENTRY_PENDING')??decisions.find(x=>!['REGIME_NOT_ELIGIBLE','STRATEGY_TIMEFRAME_NOT_ENABLED'].includes(x.reason));
  const evaluation=relevant?{...relevant,reason_text:relevant.reason_text??null}:original;
  const lastAt=stamp(pick(f.last_evaluation_at,evaluation?.at,f.last_completed_at));
  // Same presentation window as the recovered full panel: one frame + 30s.
  // A cached backend flag cannot keep the displayed evaluation fresh forever.
  const evaluationFresh=lastAt!==null&&lastAt<=now+FUTURE_TOLERANCE_MS&&now-lastAt<=Number(key)*60000+30000;
  return {key,tf:tfName(key),lastAt:lastAt!==null&&lastAt<=now+FUTURE_TOLERANCE_MS?lastAt:null,
   status:f.evaluation_status??null,entryEnabled:typeof f.entry_enabled==='boolean'?f.entry_enabled:null,role:f.role??null,stale:!snapshotFresh||f.stale!==false||!evaluationFresh,
   reason:reasonText(pick(evaluation?.reason,f.reason,f.blocker),
    pick(evaluation?.reason_text,relevant?null:f.reason_text)),
   regime:regimeText(f.market_regime?.regime),
   regimeCode:f.market_regime?.regime??null,
   nextCandleAt:f.next_candle_close_at??null,
   shadow:key==='5'?f.scalping_shadow??null:null};
 });
 const ops=Array.isArray(d.operations)?d.operations:[];
 const legacyCount=ops.filter(x=>x?.ledger==='FREQUENT_PAPER'&&!isQuantPlan(x.plan)).length;
 const recent=ops.filter(x=>(!d.secondary_quant?.active||isQuantPlan(x?.plan))&&x?.ledger==='FREQUENT_PAPER' && ['CLOSED','NOT_FILLED','OPEN','PENDING'].includes(x.status))
  .sort((a,b)=>eventTime(pick(b.exit?.at,b.entry?.at,b.at,0))-eventTime(pick(a.exit?.at,a.entry?.at,a.at,0)))
  .slice(0,18).map(o=>({
   id:String(o.id??''),status:o.status,tf:tfName(o.plan?.timeframe),
   side:['SHORT','LONG'].includes(o.plan?.direction)?o.plan.direction:'UNKNOWN',
   // Never display unrealized PnL as a realized close.
   recordedCloseNet:o.status==='CLOSED'&&numeric(o.exit?.pnl)?String(o.exit.pnl):null,
   closeIsFinal:o.status==='CLOSED' && o.exit?.result_final===true,
   reason:reasonText(o.exit?.reason),at:pick(o.exit?.at,o.entry?.at,o.at)
  }));
 const validPending=[],seenPending=new Set();let incompletePending=0,duplicatePending=0;
 for(const row of pending){
  const plan=row?.plan;
  if(!plan||typeof plan.id!=='string'||!plan.id.trim()||!['LONG','SHORT'].includes(plan.direction)||
   ![1,5,15,60,240].includes(Number(plan.timeframe))||
   !['PF_XBTUSD','PAPER:KRAKEN_FUTURES:PF_XBTUSD'].includes(plan.instrument)||
   ![plan.entry,plan.stop,plan.target].every(x=>numeric(x)&&Number(x)>0)){incompletePending++;continue;}
  if(seenPending.has(plan.id)){duplicatePending++;continue;}seenPending.add(plan.id);validPending.push(row);
 }
 const activityOpen=count(activity.orders?.open_positions),accountOpen=count(account.position_count);
 const activityPending=count(activity.orders?.pending),accountPending=count(account.pending_count);
 const openCountConflict=activityOpen!==null&&accountOpen!==null&&activityOpen!==accountOpen;
 const pendingCountConflict=activityPending!==null&&accountPending!==null&&activityPending!==accountPending;
 const reportedOpen=openCountConflict?null:activityOpen??accountOpen,reportedPending=pendingCountConflict?null:activityPending??accountPending;
 // Published totals remain authoritative. An incomplete or repeated row is
 // evidence of a limitation, never an additional confirmed position/order.
 const openCount=openCountConflict?null:reportedOpen??(openCollectionKnown&&!incompletePositions&&!duplicatePositions?resultPositions.length:null);
 const pendingCount=pendingCountConflict?null:reportedPending??(pendingCollectionKnown&&!incompletePending&&!duplicatePending?validPending.length:null);
 const knownFlat=Array.isArray(account.positions)&&account.positions.length===0&&openCount===0;
 const quoteAt=stamp(fin.quote_at);
 if(status==='LIVE_PAPER'&&!knownFlat&&(!current(quoteAt,now,QUOTE_MAX_AGE_MS+1)||resultPositions.some(p=>!current(p.quoteAt,now,QUOTE_MAX_AGE_MS+1))))status='STALE_QUOTE';
 if(status==='LIVE_PAPER'&&(incompletePositions||duplicatePositions))status='INCOMPLETE_POSITIONS';
 const valuationFresh=snapshotFresh&&workerVerified&&marketVerified&&!incompletePositions&&!duplicatePositions&&fin.valuation_quality==='CURRENT_ESTIMATE'&&
  (knownFlat&&number(fin.unrealized_net)===0||current(quoteAt,now,QUOTE_MAX_AGE_MS+1)&&resultPositions.every(p=>p.net!==null));
 const realized=numeric(fin.realized_net)?fin.realized_net:null;
 // frequency.started_at initializes this account's accumulator. The global
 // worker/history start and strategy activation are different periods.
 const ledgerStart=stamp(d.frequency?.started_at);
 const realizedSince=ledgerStart!==null&&asOf!==null&&ledgerStart<=asOf&&ledgerStart<=now+FUTURE_TOLERANCE_MS?ledgerStart:null;
 const unrealized=valuationFresh&&numeric(fin.unrealized_net)?fin.unrealized_net:null;
 return {
  version:'lumi-trading-compact-v2',mode:'PAPER',readOnly:true,revision:d.revision??null,
  asOf,receivedAt:stamp(receivedAt),quoteAt,ageMs:age,status,marketIssue:market.issue??null,
  metrics:{equity:pick(fin.equity,account.equity),cash:pick(fin.available_cash,account.availableCash,account.cash),
   realized:realized,realizedSince,realizedFinal:fin.realized_result_final===true,
   unrealized:unrealized,unrealizedFinal:valuationFresh,valuationFresh,equityCurrent:valuationFresh,
   lastUnrealized:numeric(fin.unrealized_net)?fin.unrealized_net:null,
   total:valuationFresh&&fin.net_result_final===true?fin.total_net:null,
   costs:fin.costs_recorded??null,exposure:d.secondary_risk_budget?.portfolio?.gross_exposure??null,margin:d.secondary_risk_budget?.portfolio?.margin??null,openRisk:d.secondary_risk_budget?.portfolio?.open_risk??null,
   uncertainHistory:fin.realized_net_includes_uncertain_history===true},
  openCount,
  pendingCount,
  positions:resultPositions,frames,recent,legacyCount,
  incompletePending,duplicatePending,pendingCollectionKnown,openCollectionKnown,incompletePositions,duplicatePositions,
  receivedOpenRows:positions.length,reportedOpenCount:reportedOpen,receivedPendingRows:pending.length,reportedPendingCount:reportedPending,
  openCountConflict,pendingCountConflict,
  openCountMismatch:reportedOpen!==null&&openCollectionKnown&&reportedOpen!==resultPositions.length,
  pendingCountMismatch:reportedPending!==null&&pendingCollectionKnown&&reportedPending!==validPending.length,
  pendingPlans:validPending.filter(x=>!d.secondary_quant?.active||isQuantPlan(x.plan)).map(x=>({id:x.plan.id,side:x.plan.direction,tf:tfName(x.plan.timeframe),pattern:x.plan.recipe_title??x.plan.pattern,entry:x.plan.entry,stop:x.plan.stop,target:x.plan.target})),
  shadow:frames.find(f=>f.key==='5')?.shadow??null,quant:d.secondary_quant??null,
  shadowResearchOnly:true,
  pendingDetails:pending.length,
  processStatus:process.status??null
 };
}
