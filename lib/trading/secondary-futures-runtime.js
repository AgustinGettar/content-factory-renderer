import {randomUUID} from 'node:crypto';
import {D,hash} from './core.js';
import {TradingNotifier,PANEL_URL} from './notifier.js';
import {OperationalSecondary,SECONDARY_VERSION,SECONDARY_MODEL,SECONDARY_PROTOCOL,secondaryEstimate,isSecondary} from './secondary-futures.js';
import {projectSecondaryActivity,ACTIVITY_VIEW_VERSION} from './secondary-monitor-activity.js';
import {installExploration,isExploration,getExplorationPolicy} from './secondary-exploration.js';
const KINDS=new Set(['SECONDARY_OPEN','SECONDARY_CLOSE','SECONDARY_STATUS','SECONDARY_SELECTED','SECONDARY_PARTIAL','SECONDARY_UNFILLED','SECONDARY_PARTIAL_CLOSE','SECONDARY_TOPUP']);
const textMoney=x=>x===null||x===undefined?'no disponible':D(x).toFixed(2);
const ref=e=>String(e.id??e.order_id??'').slice(0,12);
const pct=x=>D(x??0).mul(100).toFixed(3).replace(/0+$/,'').replace(/\.$/,'');
const qualityLabel=p=>({COSTS_NOT_COVERED:'DESFAVORABLE: el objetivo no cubre los costes estimados',EXPERIMENTAL_OUTSIDE_REFERENCE:'EXPERIMENTAL: fuera de los filtros de referencia',REFERENCE_THRESHOLDS_MET:'EXPERIMENTAL: cumple filtros de referencia, sin rentabilidad validada'}[p?.quality?.classification]??p?.quality?.classification??p?.quality_classification??p?.entry_quality??'EXPERIMENTAL');
const executionLabel=p=>p?.execution_contract?.mode==='TAKER_IOC'?'taker IOC simulada':p?.execution_contract?.mode==='MAKER_LIMIT'?'maker límite simulada':'maker límite original';
export function secondaryMessage(n){
 const e=n.payload??{},p=e.plan,s=p?.sizing,link='\nAbrir Trading: '+PANEL_URL;
 if(n.kind==='SECONDARY_STATUS'){
  if(e.exploration)return `Agustín, la secundaria PAPER quedó en exploración continua sin bloqueos financieros.
Saldo patrimonial: ${textMoney(e.equity)} USD ficticios. Tamaño nominal por señal: ${textMoney(e.nominalUSD)} USD; apalancamiento fijo ${e.leverage}×.
PF_XBTUSD · entradas 5 min / contexto 15 min · ruptura, retroceso y reentrada en rango.
Las señales nuevas usan ${e.execution_mode??'taker IOC simulada'} con bid/ask posterior a la decisión, latencia, costes y liquidez observada. Puede haber ejecuciones parciales o falta de ejecución. Se conservan stop, objetivo y salida temporal.
Las pérdidas y los ensayos históricos no detienen este perfil. Los aportes ficticios se registran separados del resultado.
Perfil ${e.profile_version}`+link;
  return 'Agustín, reanudé la secundaria PAPER con un único saldo compartido de '+textMoney(e.equity)+' USD ficticios. Evalúa ruptura/retesteo, retroceso y reentrada en rango en PF_XBTUSD (Kraken Futures). Las órdenes conservan su contrato de ejecución original. Perfil conservador activo: mantiene sus controles financieros, stop y salida máxima a 30 minutos.'+link;
 }
 if(n.kind==='SECONDARY_SELECTED')return `Señal seleccionada en la secundaria PAPER · ORDEN_SELECCIONADA → ORDEN_PENDIENTE
PF_XBTUSD · ${p?.pattern??e.pattern} · ${p?.direction??e.direction}
Entrada prevista: ${textMoney(p?.entry)} USD · cantidad solicitada: ${s?.qty??e.requested_qty} BTC
${executionLabel(p)}. Todavía no hay una ejecución.
Stop ${textMoney(p?.stop)} · objetivo ${textMoney(p?.target)} USD
Objetivo neto estimado: ${textMoney(s?.target_net)} USD. Calidad: ${qualityLabel(p)}.
Ref. ${ref(e)}`+link;
 if(n.kind==='SECONDARY_TOPUP')return `Aporte exclusivamente ficticio · PAPER_CAPITAL_TOPUP
Secundaria PAPER: +${textMoney(e.amount)} USD
Saldo disponible anterior: ${textMoney(e.balance_before)} → posterior: ${textMoney(e.balance_after)} USD
Capital aportado acumulado: ${textMoney(e.capital_contributed_total)} USD
Motivo: ${e.reason}. Es un depósito ficticio, no una ganancia; el tamaño nominal de las próximas señales se conserva.
Orden ${String(e.order_id??'').slice(0,12)} · evento ${ref(e)}`+link;
 if(n.kind==='SECONDARY_UNFILLED'){
  const expired=e.order_state==='ORDEN_VENCIDA'||['VENCIDA','ENTRY_EXPIRED'].includes(e.reason),state=expired?'ORDEN_VENCIDA':'ORDEN_CANCELADA';
  return `${state} · secundaria PAPER
PF_XBTUSD · ${e.pattern??p?.pattern??''}
Motivo: ${e.reason}
${e.had_partial?'Se canceló únicamente el remanente de '+String(e.remaining_qty)+' BTC. La cantidad ya ejecutada conserva su posición y resultado.':'La orden terminó sin ejecución. Este vencimiento o cancelación no es una pérdida de una posición.'}
Ref. ${ref(e)}`+link;
 }
 if(n.kind==='SECONDARY_PARTIAL')return `EJECUCIÓN_PARCIAL · secundaria PAPER
PF_XBTUSD · ${p?.pattern??e.pattern} · ${p?.direction??e.direction}
Este fragmento: ${e.qty} BTC a ${textMoney(e.price)} USD
Ejecutado acumulado: ${e.cumulative_qty??e.qty} / ${e.requested_qty??s?.qty} BTC
Remanente: ${e.remaining_qty??'0'} BTC · ${executionLabel(p)}
Comisión del fragmento: ${textMoney(e.fee)} USD. La posición se gestiona por la cantidad realmente ejecutada.
Ref. ${ref(e)}`+link;
 if(n.kind==='SECONDARY_PARTIAL_CLOSE')return `CIERRE_PARCIAL · secundaria PAPER
PF_XBTUSD · ${e.direction??p?.direction} · ${e.reason}
Cerrado: ${e.qty} BTC a ${textMoney(e.price)} USD. Resta: ${e.remaining_qty} BTC.
Resultado neto${e.funding_complete===false?' provisional':''} del fragmento: ${textMoney(e.pnl)} USD. Costes: ${textMoney(e.fees)} USD.
La operación todavía tiene una posición abierta.
Ref. ${ref(e)}`+link;
 if(n.kind==='SECONDARY_OPEN')return `POSICIÓN_ABIERTA · Agustín, abrí una ${p.direction==='SHORT'?'venta en corto':'compra'} simulada en la secundaria.
Kraken Futures · PF_XBTUSD · 5 min / contexto 15 min
${p.recipe_title}
Entrada simulada: ${textMoney(e.price)} USD · ${e.cumulative_qty??e.qty} BTC
Exposición solicitada: ${textMoney(s.exposure)} USD · ${s.leverage}× ficticio · ${executionLabel(p)}
Stop: ${textMoney(p.stop)} · objetivo: ${textMoney(p.target)} USD
Riesgo previsto: ${textMoney(s.risk)} USD; objetivo neto estimado: ${textMoney(s.target_net)} USD, no garantizado.
Comisión de entrada ${pct(p.execution_contract?.mode==='TAKER_IOC'?p.execution_contract.takerFee:s.entry_fee_rate??'0.0002')} %; salida ${pct(p.execution_contract?.takerFee??'0.0005')} %, más deslizamiento y financiación. Salida temporal: ${Math.round((p.holding_ms??1800000)/60000)} minutos.
${Number(s.target_net)<=0?'CALIDAD DESFAVORABLE: el objetivo previsto no cubre los costes estimados.\n':''}Ref. ${ref(e)}`+link;
 if(n.kind==='SECONDARY_CLOSE')return `POSICIÓN_CERRADA · Agustín, cerré la operación simulada de la secundaria.
Kraken Futures · PF_XBTUSD · ${e.direction==='SHORT'?'Venta en corto':'Compra'}
Motivo: ${{STOP:'stop observado',NET_TARGET:'objetivo neto',TARGET:'objetivo observado',STRUCTURAL_TARGET:'objetivo estructural observado',TIMEOUT:'tiempo máximo',MANUAL_PROFIT:'toma de ganancia solicitada',MANUAL_CLOSE:'cierre solicitado',DATA_GAP_CLOSE:'cierre histórico con datos incompletos'}[e.reason]??e.reason}
Entrada ${textMoney(e.entry)} → salida ${textMoney(e.price)} USD
Resultado neto${e.result_final===false||e.funding_complete===false?' provisional':''}: ${textMoney(e.pnl)} USD. Costes: ${textMoney(e.fees)} USD, incluida financiación registrada.
${e.quality==='OBSERVED'?'Precio y volumen observados en la simulación.':'Calidad de datos: '+e.quality+'. Se conserva la incertidumbre; el caso no constituye una etiqueta limpia para validar el patrón.'}
Ref. ${ref(e)}`+link;
 throw Error('SECONDARY_NOTICE_UNKNOWN');
}
export class SecondaryNotifier extends TradingNotifier{
 constructor(options){
  const original=options.store,filtered=new Proxy(original,{get(t,k){if(k==='queued')return async()=> (await t.queued()).filter(n=>!KINDS.has(n.kind));const v=Reflect.get(t,k,t);return typeof v==='function'?v.bind(t):v;}});
  super({...options,store:filtered});this.originalStore=original;
 }
 async drain(){
  const notice=(await this.originalStore.queued()).find(n=>KINDS.has(n.kind));if(!notice)return super.drain();
  if(!this.identityAt||Date.now()-this.identityAt>3600000)await this.verify();
  const owner=await this.owner(),id=notice.id,claim_id=randomUUID(),claim=await this.originalStore.tx({phase:'CLAIM',id,claim_id});
  if(claim.status!=='DISPATCHING'||claim.claim_id!==claim_id)return [{id,status:claim.status}];
  let status='DELIVERED',reason=null,receipt={};
  try{
   const text=secondaryMessage(notice);if(text.length>4000)throw Object.assign(Error('MESSAGE_TOO_LONG'),{definite:true});
   receipt.attempt_at=Date.now();const r=await this.transport.call('sendMessage',{chat_id:owner,text,link_preview_options:{is_disabled:true},reply_markup:{inline_keyboard:[[{text:'Abrir Trading',web_app:{url:PANEL_URL}}]]}});receipt.response_at=Date.now();
   if(!Number.isSafeInteger(r?.message_id)||r.message_id<=0||String(r.chat?.id)!==owner)throw Error('INVALID_TELEGRAM_RECEIPT');
   Object.assign(receipt,{message_id:r.message_id,telegram_date:r.date,recipient_hash:hash(owner),read_confirmed:false});
  }catch(e){status=e.definite?'REJECTED':'UNKNOWN';reason=/^[A-Z_]+$/.test(e.message)?e.message:'TELEGRAM_SEND_FAILED';receipt.response_at??=Date.now();}
  await this.originalStore.tx({phase:'FINISH',id,claim_id,status,receipt,reason});return [{id,status,reason,receipt}];
 }
}
export function installOperational(engine,env){
 const requested=env.LUMI_TRADING_SECONDARY_EXECUTION;
 if(!requested){if(engine.state.secondaryExecution)throw Error('SECONDARY_EXECUTION_FLAG_REQUIRED');return null;}
 if(requested!==SECONDARY_VERSION||env.LUMI_RUNTIME_ENV!=='staging'||env.LUMI_TRADING_MODE!=='PAPER'||env.LUMI_TRADING_STORAGE!=='SQLITE')throw Error('SECONDARY_EXECUTION_PAPER_ONLY');
 if(engine.secondaryRuntime)throw Error('SECONDARY_EXECUTION_ALREADY_INSTALLED');
 const runtime=new OperationalSecondary({engine}).initialize();
 installExploration(engine.state,env,runtime.now(),e=>engine.event(e));engine.secondaryRuntime=runtime;
 // Route all secondary writes through the futures broker. The existing spot
 // engine, controls and primary continue to run, but cannot settle these trades.
 engine.frequency.market=()=>{};engine.frequency.recover=()=>{};engine.frequency.boundary=async()=>{};
 engine.frequency.cancel=reason=>{if(['ORDER_CANCELLED_ON_SHUTDOWN','RESOURCE_LIMIT'].includes(reason))runtime.broker.gap(reason);};
 engine.laboratory.boundary=async()=>{};
 const track=engine.learning.track.bind(engine.learning);engine.learning.track=(ledger,version,p,q)=>{if(!isSecondary(p))return track(ledger,version,p,q);};
 const tick=engine.tick.bind(engine);engine.tick=async()=>{if(engine.busy)return;if(runtime.now()-engine.lastLease<=30000)runtime.tick();await tick();};
 const delivery=engine.acceptDelivery.bind(engine);engine.acceptDelivery=n=>{if(KINDS.has(n.kind))return;return delivery(n);};
 if(engine.notifier){const old=engine.notifier;engine.notifier=new SecondaryNotifier({store:engine.store,db:old.db,env,feed:engine.feed,pending:id=>engine.pending(id),transport:old.transport});}
 if(isExploration(engine.state)){
  const profile=runtime.state.exploration,policy=getExplorationPolicy(engine.state),key=profile.policy_hash;
  if(runtime.state.profile_status_notice_queued!==key){engine.notice('SECONDARY_STATUS',{equity:engine.state.frequency.account.equity,exploration:true,profile_version:profile.version,nominalUSD:policy.nominalUSD,leverage:policy.leverage,execution_mode:Object.values(policy.modes).every(mode=>mode==='TAKER_IOC')?'taker IOC simulada':Object.entries(policy.modes).map(([pattern,mode])=>pattern+': '+mode).join(', ')},[profile.version,key,'enabled']);runtime.state.profile_status_notice_queued=key;}
 }else if(!runtime.state.status_notice_queued){engine.notice('SECONDARY_STATUS',{equity:engine.state.frequency.account.equity},[SECONDARY_VERSION,'enabled']);runtime.state.status_notice_queued=true;}
 runtime.start();return runtime;
}
const values=x=>Object.values(x??{});
const total=items=>items.reduce((sum,item)=>sum.plus(item??0),D(0)).toString();
const clone=x=>x==null?x:structuredClone(x);
export function secondaryFinancialSummary(state,quote,now){
 const x=state.secondaryExecution,a=state.frequency.account,capital=x.capital;
 const historical=state.laboratory?.funding,legacyContributed=historical?.initial!==undefined&&historical?.added!==undefined?D(historical.initial).plus(historical.added).toString():null;
 const topups=capital?.topups??'0',contributed=capital?.total_contributed??legacyContributed;
 const positions=values(a.positions),estimates=positions.map(p=>secondaryEstimate(p,quote,now)),complete=estimates.every(v=>v?.net!==undefined&&v?.net!==null&&v?.funding_complete!==false&&v?.result_final!==false)&&positions.every(p=>!p.closed_funding_pending?.length&&!p.funding_pending?.length&&!p.funding_uncertain&&!p.funding_unresolved&&!p.funding_gaps?.length);
 const realizedFinal=!positions.some(p=>p.closed_funding_pending?.length)&&!values(x.closed_funding_pending).some(p=>p.intervals?.length),unrealized=complete?total(estimates.map(v=>v.net)):null;
 const exitFees=complete?total(estimates.map(v=>v.exit_fee)):null,funding=complete?total(estimates.map(v=>v.funding)):null;
 return {currency:'USD',ledger:'FREQUENT_PAPER',mode:'PAPER',capital_contributed:contributed,capital_before_exploration:capital?.initial_contributed??legacyContributed,
  contribution_source:capital?.contribution_source??(legacyContributed!==null?'LEGACY_FUNDING_LEDGER':'UNAVAILABLE'),fictitious_topups:topups,topup_count:capital?.count??0,
  cash:a.cash,equity:a.equity,available_cash:a.availableCash??a.cash,reserved_cash:a.reservedCash??'0',realized_net:a.net,realized_result_final:realizedFinal,realized_net_includes_uncertain_history:Number(a.ambiguousClosed??0)>0,observed_closed:a.observedClosed??0,uncertain_closed:a.ambiguousClosed??0,
  unrealized_net:unrealized,total_net:unrealized===null||!realizedFinal?null:D(a.net).plus(unrealized).toString(),recorded_total_net:unrealized===null?null:D(a.net).plus(unrealized).toString(),net_result_final:complete&&realizedFinal,
  equity_less_contributions:contributed===null?null:D(a.equity).minus(contributed).toString(),
  costs_recorded:a.fees,estimated_exit_commissions:exitFees,accrued_open_funding:funding,valuation_quality:!realizedFinal?'UNRESOLVED_CLOSED_FUNDING':complete?'CURRENT_ESTIMATE':'INCOMPLETE_DATA',
  quote_at:quote?.event_at??null,deposits_are_profit:false,topup_events:clone((capital?.events??[]).slice(-30))};
}
const planDetails=(view,raw)=>raw?{...view,pattern:raw.pattern,rule_version:raw.rule_version??raw.entry_revision??raw.version,instrument:raw.instrument,holding_ms:raw.holding_ms,execution_contract:clone(raw.execution_contract),quality:clone(raw.quality),quality_classification:clone(raw.quality?.classification??raw.quality_classification??raw.entry_quality),economics:clone(raw.economics)}:view;
function projectOperationalOrders(d,state,now){
 const x=state.secondaryExecution,a=state.frequency.account,account=d.frequency.account,history=state.frequency.history??[];
 for(const p of account.positions??[]){
  const raw=a.positions?.[p.plan.id];if(!raw)continue;p.plan=planDetails(p.plan,raw.plan);p.live_exit=secondaryEstimate(raw,x.market?.quote,now);
  Object.assign(p,{execution_state:raw.execution_state??(raw.partial_entry?'EJECUCIÓN_PARCIAL':'POSICIÓN_ABIERTA'),requested_qty:raw.requested_qty??raw.plan.sizing.qty,cumulative_qty:raw.cumulative_qty??raw.initial_qty??raw.qty,open_qty:raw.qty,closed_qty:raw.closed_qty??'0',entry_state:D(raw.initial_qty??raw.qty).lt(raw.plan.sizing.qty)?'EJECUCIÓN_PARCIAL':'EJECUCIÓN_COMPLETA',
   exit_intent:clone(raw.exit_intent),execution_blocker:raw.execution_blocker??null,closed_funding_pending:clone(raw.closed_funding_pending??[]),data_quality:raw.quality,funding_pending:clone(raw.funding_pending??[]),funding_gaps:clone(raw.funding_gaps??[]),data_gaps:clone(raw.data_gaps??[]),excursions:clone(raw.excursions),execution_costs:clone(raw.execution_costs),max_favourable:clone(raw.excursions?.max_favourable_net??raw.max_favourable??raw.mfe),max_adverse:clone(raw.excursions?.max_adverse_net??raw.max_adverse??raw.mae)});
 }
 for(const p of account.pending_orders??[]){
  const raw=a.pendingOrders?.[p.plan.id];if(!raw)continue;p.plan=planDetails(p.plan,raw.plan);
  Object.assign(p,{execution_state:raw.filled_qty&&D(raw.filled_qty).gt(0)?'EJECUCIÓN_PARCIAL':'ORDEN_PENDIENTE',filled_qty:raw.filled_qty??'0',remaining_qty:raw.remaining_qty??raw.plan.sizing.qty,
   executable_at:raw.placed_at,expires_at:raw.plan.expires_at,last_execution_reason:raw.last_execution_reason??null,execution_blocker:raw.execution_blocker??null,exit_intent:clone(raw.exit_intent)});
 }
 for(const o of d.operations??[]){
  if(o.ledger!=='FREQUENT_PAPER'||o.plan?.execution_model!==SECONDARY_MODEL)continue;
  const position=a.positions?.[o.id],pending=a.pendingOrders?.[o.id],last=history.find(e=>e.id===o.id),rawPlan=position?.plan??pending?.plan;
  o.plan=planDetails(o.plan,rawPlan);o.instrument=SECONDARY_PROTOCOL.symbol;o.exchange='KRAKEN_FUTURES';
  if(position){o.live_position=account.positions?.find(p=>p.plan.id===o.id);o.status='OPEN';o.execution_state=pending?'EJECUCIÓN_PARCIAL':'POSICIÓN_ABIERTA';o.entry={at:position.entered_at,price:position.entry,qty:position.qty};}
  else if(pending){o.status='PENDING';o.execution_state='ORDEN_PENDIENTE';}
  else if(o.status==='CLOSED'){o.execution_state='POSICIÓN_CERRADA';}
  else if(o.status==='NOT_FILLED'){o.execution_state=last?.order_state??(['VENCIDA','ENTRY_EXPIRED'].includes(o.exit?.reason)?'ORDEN_VENCIDA':'ORDEN_CANCELADA');}
  else if(last?.type==='CLOSED'){o.status='CLOSED';o.execution_state='POSICIÓN_CERRADA';}
  o.last_execution_event=last?{type:last.type,at:last.at,reason:last.reason,quality:last.quality,remaining_qty:last.remaining_qty,had_partial:last.had_partial}:null;
 }
 account.position=account.positions?.[0]??null;account.pending=account.pending_orders?.[0]??null;
}
export function attachOperationalProjection(publisher,store,runtime=null){
 if(!publisher)return;const send=publisher.send.bind(publisher);
 // Capture the committed row once before either network await. Live and detail
 // must describe the same revision even if the worker commits during upload.
 publisher.projectSnapshot=(d,state,now)=>{
  if(!state.secondaryExecution)return d;
  const x=state.secondaryExecution,f=state.frequency,policy=SECONDARY_PROTOCOL,exploring=isExploration(state),explorationPolicy=getExplorationPolicy(state),profile=x.exploration;
  d.secondary_execution={...x,protocol:policy};
  const risk=exploring?{version:profile.version,financial_blocks:false,maxSlots:null,maxDirectionSlots:null,openRisk:null,risk:null,maxRiskUSD:null,dailyLoss:null,drawdown:null,cashReserve:null,maxGrossExposure:null,lossCooldown:null,oppositeExposureAllowed:true,nominalUSD:explorationPolicy.nominalUSD,leverage:explorationPolicy.leverage}: {version:SECONDARY_VERSION,maxSlots:policy.maxSlots,openRisk:policy.openRiskFraction,risk:policy.riskFraction,maxRiskUSD:policy.riskCapUSD,dailyLoss:policy.dailyLossFraction};
  d.frequency={...d.frequency,execution_version:SECONDARY_VERSION,execution_status:x.status,exchange:'KRAKEN_FUTURES',instrument:policy.symbol,operation_mode:exploring?'EXPLORATION_PAPER':'CONTINUOUS_PAPER',daily_selection_limit:null,
   exploration_profile:profile?{version:profile.version,active:profile.active,activated_at:profile.activated_at,policy_hash:profile.policy_hash,policy:clone(profile.policy)}:null,
   market:x.market,lastDecision:f.lastDecision,pattern_decisions:x.decisions,history:clone((f.history??[]).slice(0,40)),protocol:{...d.frequency.protocol,intervalMs:300000,maxHoldingMinutes:30,fee:policy.takerFee,makerFee:policy.makerFee,risk:exploring?null:policy.riskFraction,dailyLoss:exploring?null:policy.dailyLossFraction,minNetRR:exploring?null:String(policy.minNetRR)},risk_profile:risk,entry_profile:null,context_profile:null,maker_sizing_profile:null};
  if(exploring)d.frequency.account={...d.frequency.account,max_slots:null,financial_limits_active:false,nominal_usd:explorationPolicy.nominalUSD};
  d.frequency.financial_summary=secondaryFinancialSummary(state,x.market?.quote,now);
  d.secondary_finances=d.frequency.financial_summary;
  projectOperationalOrders(d,state,now);
  const activeTrial={version:SECONDARY_VERSION,status:x.status,started_at:x.activated_at,closed:x.counts.closed,net:D(f.account.net).minus(x.baseline.net).toNumber(),recipe:{id:SECONDARY_VERSION,title:'Secundaria operativa · PF_XBTUSD',tf:5,timeframes:[5,15]},decisions:x.decisions,report:{status:'EXPERIMENTAL_PAPER',reason:'NO_PROFITABILITY_CLAIM'}};
  d.laboratory={...d.laboratory,previous_trial_status:state.laboratory?.status??d.laboratory.status,status:x.status==='ACTIVE_PAPER'?'ACTIVE':x.status,active:SECONDARY_VERSION,executionRevision:SECONDARY_VERSION,operational:true,lastDecision:f.lastDecision,
   exploration_profile:d.frequency.exploration_profile,financial_summary:d.secondary_finances,
   recipes:policy.patterns.map(id=>({id,title:id,tf:5,kind:id,holdingMs:policy.holdingMs,minNetRR:exploring?null:String(policy.minNetRR)})),
   trials:[...(d.laboratory.trials??[]).filter(t=>t.version!==SECONDARY_VERSION),activeTrial]};
  d.secondary_comparison=clone(x.by_pattern_version??x.statistics??{});
  const inventory=Object.fromEntries([5,15].map(tf=>[tf,{bars:runtime?.series?.[tf]?.length??null,last_closed_at:runtime?.series?.[tf]?.at(-1)?.end??null}]));
  return projectSecondaryActivity(d,state,now,inventory);
 };
 publisher.send=async(path,body,revision)=>{
  const d=JSON.parse(body);
  if(d.secondary_activity?.view_version===ACTIVITY_VIEW_VERSION&&d.secondary_activity.revision===revision)return send(path,body,revision);
  const row=store.row();if(row.revision!==revision||!row.state.secondaryExecution)return send(path,body,revision);
  return send(path,JSON.stringify(publisher.projectSnapshot(d,row.state,Date.now())),revision);
 };
}
