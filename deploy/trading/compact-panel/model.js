// Compact, read-only view model for the EXISTING private trading monitor.
// No API writes, no trading controls, no inferred probability or PnL.
const finite=v=>v!==null&&v!==undefined&&v!==''&&Number.isFinite(Number(v));
const num=v=>finite(v)?Number(v):null;
const pick=(...vs)=>vs.find(v=>v!==undefined&&v!==null)??null;
const tf=t=>({1:'1m',5:'5m',15:'15m',60:'1h',240:'4h',1440:'1d'})[t]??(t?String(t)+'m':'—');
const reasonNames={TIMEOUT:'Tiempo máximo',TIMEOUT_EXTENDED:'Tiempo extendido',
 STOP:'Stop loss',STRUCTURAL_TARGET:'Objetivo de precio',NET_TARGET:'Objetivo neto',
 TRAILING_RETRACEMENT:'Retroceso desde la ganancia máxima',
 TRAILING_STAGNATION:'Ganancia sin avance',MANUAL_PROFIT:'Ganancia tomada manualmente',
 MANUAL_CLOSE:'Cierre manual',CONTEXT_NOT_SYNCHRONIZED:'Esperando velas sincronizadas',
 FUTURES_DATA_NOT_FRESH:'Cotización no reciente',FUNDING_NOT_AVAILABLE:'Financiación no disponible',
 WAIT_BREAKOUT:'Esperando ruptura',WAIT_PULLBACK:'Esperando retroceso',
 WAIT_RANGE_REENTRY:'Esperando reentrada al rango',
 NO_CONFIRMED_5M_TREND:'Sin tendencia confirmada para scalping',
 WAIT_PULLBACK_CONFIRMATION:'Esperando confirmación del retroceso',
 NO_NET_ECONOMIC_ADVANTAGE:'Costes mayores que el margen útil',
 SPREAD_TOO_WIDE:'Spread demasiado amplio'};
export const reasonText=v=>reasonNames[v]??(typeof v==='string'?v.replaceAll('_',' ').toLowerCase():'Sin evaluación');
export function fmtUSD(v,{digits=2,signed=false}={}){
 if(!finite(v))return '—';
 const n=num(v),text=new Intl.NumberFormat('es-AR',{minimumFractionDigits:digits,maximumFractionDigits:digits}).format(Math.abs(n));
 return (n<0?'−':signed&&n>0?'+':'')+'US$ '+text;
}
export function fmtDate(v){
 const t=typeof v==='number'?v:Date.parse(v??'');
 if(!Number.isFinite(t)||t<=0)return 'Sin registro';
 return new Intl.DateTimeFormat('es-AR',{timeZone:'Europe/Rome',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}).format(t);
}
export function viewModel(snapshot,now=Date.now()){
 const raw=snapshot?.snapshot??snapshot?.data??snapshot;
 if(!raw||typeof raw!=='object')throw Error('MONITOR_SNAPSHOT_REQUIRED');
 if(!raw.secondary_finances&&!raw.frequency?.financial_summary)throw Error('SECONDARY_PAPER_PROJECTION_REQUIRED');
 const finance=raw.secondary_finances??raw.frequency?.financial_summary??{},
  account=raw.frequency?.account??{},activity=raw.secondary_activity??{},
  market=raw.frequency?.market??{},accountPositions=account.positions??[],
  positions=Array.isArray(accountPositions)?accountPositions:Object.values(accountPositions);
 const positionViews=positions.filter(p=>p&&p.plan&&p.plan.instrument?.includes('PF_XBTUSD'))
  .map(p=>{
   const exit=p.live_exit??{},prot=p.profit_protection??{},plan=p.plan??{};
   const net=exit.funding_complete!==false&&exit.result_final!==false?pick(exit.net,p.realized_plus_remaining_net):null;
   return {id:String(plan.id??''),timeframe:tf(plan.timeframe),side:plan.direction==='SHORT'?'SHORT':'LONG',
    pattern:String(plan.recipe_title??plan.pattern??'Patrón no disponible').slice(0,110),
    entry:pick(p.entry,plan.entry),qty:pick(p.open_qty,p.qty),
    net:finite(net)?String(net):null,
    stop:plan.stop??null,target:plan.target??null,
    leverage:pick(p.leverage,plan.execution_contract?.leverage),
    peak:pick(prot.peak_net,p.max_favourable),
    floor:prot.trailing_activated_at!=null?prot.protected_net:null,
    remainingRisk:pick(p.risk,p.remaining_risk),
    liveQuoteAt:exit.quote_at??null,complete:exit.funding_complete!==false&&exit.result_final!==false,
    blocker:p.execution_blocker??null,exitIntent:p.exit_intent?.reason??null
   };
  });
 const frames=Object.entries(activity.frames??{}).filter(([key])=>['5','15','60','240'].includes(key))
  .map(([key,v])=>({timeframe:tf(Number(key)),lastAt:pick(v.last_completed_at,v.last_evaluation?.at,v.last_evaluation_at),
    status:v.last_status??null,reason:pick(v.last_result,v.blocker,v.last_evaluation?.reason),
    shadow:key==='5'?v.scalping_shadow:null}));
 const list=Array.isArray(raw.operations)?raw.operations:[];
 const recent=list.filter(x=>x?.ledger==='FREQUENT_PAPER').slice(0,20).map(x=>({
  id:String(x.id??''),status:x.status??'?',timeframe:tf(x.plan?.timeframe),
  side:x.plan?.direction==='SHORT'?'SHORT':'LONG',
  net:pick(x.exit?.pnl,x.live_position?.live_exit?.net),reason:x.exit?.reason??null,
  at:pick(x.exit?.at,x.entry?.at,x.at)
 }));
 const asOf=pick(raw.generated_at,raw.sampled_at,raw.at,raw.feed?.sampled_at);
 const age=Number.isFinite(asOf)?now-asOf:null;
 const fresh=age!==null&&age>=0&&age<15000;
 const total=finance.net_result_final===true?finance.total_net:null;
 return {version:'lumi-trading-compact-view-1.0.0',readOnly:true,mode:'PAPER',
  asOf,ageMs:age,fresh,revision:raw.revision??null,
  metrics:{equity:pick(account.equity,finance.equity),realized:finance.realized_net??account.net,
    unrealized:finance.unrealized_net??null,total,
    totalFinal:finance.net_result_final===true,
    costs:pick(finance.costs_recorded,account.fees),cash:pick(finance.available_cash,account.availableCash,account.cash)},
  openCount:positionViews.length,pendingCount:Array.isArray(account.pending_orders)?account.pending_orders.length:
    Array.isArray(account.pendingOrders)?account.pendingOrders.length:0,
  positions:positionViews,frames,recent,
  shadow:frames.find(f=>f.timeframe==='5m')?.shadow??null,
  marketIssue:market.error??null,
  status:!fresh?'DATA_STALE':market.error?'MARKET_ISSUE':'ACTIVE_PAPER'};
}
export const escapeHTML=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const timeframeLabel=tf;
