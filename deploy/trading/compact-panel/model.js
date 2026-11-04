// Lumi Trading secondary PAPER - compact owner-private read-only projection.
// Data source: existing same-origin GET /api/monitor/live; no trading actions.
const numeric = x => (typeof x === 'number' && Number.isFinite(x)) ||
  (typeof x === 'string' && x.trim() !== '' && Number.isFinite(Number(x)));
const pick = (...xs) => xs.find(x => x !== null && x !== undefined) ?? null;
const number = x => numeric(x) ? Number(x) : null;
const eventTime = x => typeof x === 'string' && !numeric(x) ? Date.parse(x) || 0 : number(x) ?? 0;
const tfName = x => ({1:'1m',5:'5m',15:'15m',60:'1h',240:'4h'})[Number(x)] ?? '—';
const REASONS = {
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
 if(!Number.isFinite(n)||n<=0)return 'Sin registro';
 return new Intl.DateTimeFormat('es-AR',{timeZone:'Europe/Rome',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}).format(n);
};
export const escapeHTML = s => String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const quoteAge = (stamp,now) => numeric(stamp) ? now-Number(stamp):null;
export function viewModel(payload, now=Date.now()) {
 const d=payload?.snapshot??payload?.data??payload;
 if(!d||typeof d!=='object')throw Error('MONITOR_RESPONSE_REQUIRED');
 const fin=d.secondary_finances??d.frequency?.financial_summary;
 if(!fin||fin.mode!=='PAPER'||fin.ledger!=='FREQUENT_PAPER')throw Error('SECONDARY_PAPER_SNAPSHOT_REQUIRED');
 const account=d.frequency?.account??{},activity=d.secondary_activity??{},feed=d.feed??{};
 const positions=Array.isArray(account.positions)?account.positions:Object.values(account.positions??{});
 const pending=Array.isArray(account.pending_orders)?account.pending_orders:
  Array.isArray(account.pendingOrders)?account.pendingOrders:Object.values(account.pendingOrders??{});
 const resultPositions=positions.filter(p=>p?.plan&&['PF_XBTUSD','PAPER:KRAKEN_FUTURES:PF_XBTUSD'].includes(String(p.plan.instrument??'')))
  .map(p=>{
   const plan=p.plan,exit=p.live_exit??{},protection=p.profit_protection??{};
   const quoteAt=pick(exit.quote_at,exit.at,fin.quote_at);
   const quoteFresh=exit.fresh===true && numeric(quoteAt) && now-Number(quoteAt)>=-1000 && now-Number(quoteAt)<=5000;
   const complete=quoteFresh && exit.liquidity_ok!==false && exit.funding_complete!==false && exit.result_final!==false
    && !p.funding_uncertain && !p.funding_pending?.length && !p.funding_gaps?.length && !p.closed_funding_pending?.length && numeric(exit.net);
   return {
    id:String(plan.id??''),side:['SHORT','LONG'].includes(plan.direction)?plan.direction:'UNKNOWN',timeframe:tfName(plan.timeframe),
    pattern:String(p.plan.recipe_title??p.plan.pattern??'Patrón no registrado').slice(0,85),
    net:complete?String(exit.net):null,entry:pick(p.entry,plan.entry),
    stop:pick(p.quant_management?.stop,plan.stop,plan.exit_policy?.stop),target:pick(plan.target,plan.exit_policy?.target),
    leverage:pick(plan.sizing?.leverage,plan.execution_contract?.leverage,p.leverage),
    maxFavourable:pick(p.excursions?.max_favourable_net,p.max_favourable),
    protectedFloor:pick(protection.protected_net,protection.floor_net),
    risk:pick(p.remaining_risk,plan.sizing?.risk),expectedNet:pick(plan.entry_economics?.expected_net_target,plan.sizing?.target_net),margin:pick(p.initial_margin,plan.sizing?.initial_margin),regime:plan.quant_contract?.regime??null,
    quoteAt,
    exitReason:pick(p.exit_intent?.reason,p.execution_blocker)
   };
  });
 const times=activity.frames?.['1']?['1','5','15','60','240']:['5','15','60','240'];
 const frames=times.map(key=>{
  const f=activity.frames?.[key]??{};
  const original=f.last_evaluation??null;
  const relevant=original?.pattern_decisions?.find(x=>x.reason==='ENTRY_PENDING')??original?.pattern_decisions?.find(x=>!['REGIME_NOT_ELIGIBLE','STRATEGY_TIMEFRAME_NOT_ENABLED'].includes(x.reason));
  const evaluation=relevant?{...relevant,reason_text:relevant.reason_text??null}:original;
  return {key,tf:tfName(key),lastAt:pick(f.last_evaluation_at,evaluation?.at,f.last_completed_at),
   status:f.evaluation_status??null,stale:f.stale!==false,
   reason:reasonText(pick(evaluation?.reason,f.reason,f.blocker),
    pick(evaluation?.reason_text,f.reason_text)),
   regime:regimeText(f.market_regime?.regime),
   regimeCode:f.market_regime?.regime??null,
   nextCandleAt:f.next_candle_close_at??null,
   shadow:key==='5'?f.scalping_shadow??null:null};
 });
 const ops=Array.isArray(d.operations)?d.operations:[];
 const recent=ops.filter(x=>x?.ledger==='FREQUENT_PAPER' && ['CLOSED','NOT_FILLED','OPEN','PENDING'].includes(x.status))
  .sort((a,b)=>eventTime(pick(b.exit?.at,b.entry?.at,b.at,0))-eventTime(pick(a.exit?.at,a.entry?.at,a.at,0)))
  .slice(0,18).map(o=>({
   id:String(o.id??''),status:o.status,tf:tfName(o.plan?.timeframe),
   side:['SHORT','LONG'].includes(o.plan?.direction)?o.plan.direction:'UNKNOWN',
   // Never display unrealized PnL as a realized close.
   recordedCloseNet:o.status==='CLOSED'&&numeric(o.exit?.pnl)?String(o.exit.pnl):null,
   closeIsFinal:o.status==='CLOSED' && o.exit?.result_final===true,
   reason:reasonText(o.exit?.reason),at:pick(o.exit?.at,o.entry?.at,o.at)
  }));
 const asOf=pick(d.generated_at,d.secondary_activity?.snapshot_at,d.feed?.sampled_at,d.at);
 const age=quoteAge(asOf,now);
 const process=activity.process??{};
 const market=activity.market??{};
 const snapshotFresh=age!==null&&age>=-1000&&age<15000;
 const workerVerified=process.status==='RECENT_COMMIT_AND_LEASE';
 const marketVerified=market.usable===true&&market.issue==null;
 const status=!snapshotFresh?'STALE_SNAPSHOT':!workerVerified?'WORKER_UNVERIFIED':!marketVerified?'MARKET_ISSUE':'LIVE_PAPER';
 const realized=fin.realized_net??null,unrealized=fin.unrealized_net??null;
 return {
  version:'lumi-trading-compact-v2',mode:'PAPER',readOnly:true,revision:d.revision??null,
  asOf,ageMs:age,status,marketIssue:market.issue??null,
  metrics:{equity:pick(fin.equity,account.equity),cash:pick(fin.available_cash,account.availableCash,account.cash),
   realized:realized,realizedFinal:fin.realized_result_final===true,
   unrealized:unrealized,unrealizedFinal:fin.valuation_quality==='CURRENT_ESTIMATE',
   total:fin.net_result_final===true?fin.total_net:null,
   costs:fin.costs_recorded??null,exposure:d.secondary_risk_budget?.portfolio?.gross_exposure??null,margin:d.secondary_risk_budget?.portfolio?.margin??null,openRisk:d.secondary_risk_budget?.portfolio?.open_risk??null,
   uncertainHistory:fin.realized_net_includes_uncertain_history===true},
  openCount:Math.max(resultPositions.length,number(activity.orders?.open_positions)??0),
  pendingCount:Math.max(pending.length,number(activity.orders?.pending)??0),
  positions:resultPositions,frames,recent,
  shadow:frames.find(f=>f.key==='5')?.shadow??null,quant:d.secondary_quant??null,
  shadowResearchOnly:true,
  pendingDetails:pending.length,
  processStatus:process.status??null
 };
}
