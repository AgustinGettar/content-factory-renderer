import {installActivePaper} from './quant-active-paper.js';
import {installContextPullback,getContextProfile} from './quant-context-pullback.js';
import {compactQuantMessage,legacyTradingNotice} from './quant-notices.js';
import {installQuant,quantStrategySpecs} from './quant-strategies.js';
import {installOpportunities} from './quant-opportunities.js';
import {randomUUID} from 'node:crypto';
import {D,hash} from './core.js';
import {TradingNotifier,PANEL_URL} from './notifier.js';
import {OperationalSecondary,SECONDARY_VERSION,SECONDARY_MODEL,SECONDARY_PROTOCOL,secondaryEstimate,isSecondary} from './secondary-futures.js';
import {projectSecondaryActivity,ACTIVITY_VIEW_VERSION} from './secondary-monitor-activity.js';
import {installExploration,isExploration,getExplorationPolicy} from './secondary-exploration.js';
import {installProfitPolicy,isEarlyProfitContract} from './secondary-profit-policy.js';
import {installSecondaryNeural,neuralView} from './secondary-neural.js';
import {installCapitalAllocation,applyCapitalAllocationFunding,capitalAllocationView} from './secondary-capital-allocation.js';
import {installSecondaryRiskBudget,riskBudgetView} from './secondary-risk-budget.js';
import {installSecondaryTimeframes,getSecondaryTimeframes} from './secondary-timeframes.js';
const KINDS=new Set(['SECONDARY_OPEN','SECONDARY_CLOSE','SECONDARY_STATUS','SECONDARY_SELECTED','SECONDARY_PARTIAL','SECONDARY_UNFILLED','SECONDARY_PARTIAL_CLOSE','SECONDARY_TOPUP','SECONDARY_TRAILING','SECONDARY_PROFIT_POLICY','SECONDARY_NEURAL','SECONDARY_CAPITAL_ALLOCATION','SECONDARY_RISK_POLICY','SECONDARY_TIMEFRAMES','SECONDARY_QUANT']);
const textMoney=x=>x===null||x===undefined?'no disponible':D(x).toFixed(D(x).abs().lt(1)?6:2);
const ref=e=>String(e.id??e.order_id??'').slice(0,12);
const pct=x=>D(x??0).mul(100).toFixed(3).replace(/0+$/,'').replace(/\.$/,'');
const qualityLabel=p=>({COSTS_NOT_COVERED:'DESFAVORABLE: el objetivo no cubre los costes estimados',EXPERIMENTAL_OUTSIDE_REFERENCE:'EXPERIMENTAL: fuera de los filtros de referencia',REFERENCE_THRESHOLDS_MET:'EXPERIMENTAL: cumple filtros de referencia, sin rentabilidad validada'}[p?.quality?.classification]??p?.quality?.classification??p?.quality_classification??p?.entry_quality??'EXPERIMENTAL');
const executionLabel=p=>p?.execution_contract?.mode==='TAKER_IOC'?'taker IOC simulada':p?.execution_contract?.mode==='MAKER_LIMIT'?'maker límite simulada':'maker límite original';
const frameLabel=tf=>({1:'1 min',5:'5 min',15:'15 min',60:'1 h',240:'4 h',1440:'1 d'}[tf]??String(tf??5)+' min');
const planContext=p=>`${frameLabel(p?.timeframe??5)} / contexto ${frameLabel(p?.timeframe_contract?.context_timeframe??p?.context?.contextTf??p?.context?.contextMinutes??p?.entry_context?.context_timeframe??15)}`;
const trancheText=p=>p?.movement_id?`\nMovimiento ${p.movement_id.slice(0,10)} · tramo ${(p.leg_index??0)+1}/3${p.parent_id?' · ampliación de '+p.parent_id.slice(0,10):''}`:'';
const exitReason=reason=>({QUANT_TECHNICAL_TRAILING:'retroceso hasta el stop técnico protegido de esta posición',QUANT_MOMENTUM_EXHAUSTION:'agotamiento del impulso confirmado con estructura',PRE_EXECUTION_EXPECTED_NET_TARGET_BELOW_MINIMUM:'la cotización posterior a la latencia ya no deja el mínimo neto útil para la cantidad revalidada',PRE_EXECUTION_FUNDING_NOT_AVAILABLE:'falta financiación verificable al revalidar la entrada; no se inventan los costes',ENTRY_ECONOMICS_CHANGED_BEFORE_FILL:'el margen neto dejó de alcanzar el mínimo al revalidar la cotización posterior a la latencia',EXPECTED_NET_TARGET_BELOW_MINIMUM:'objetivo neto previsto inferior al mínimo útil experimental',STOP:'stop observado',NET_TARGET:'objetivo neto',TARGET:'objetivo observado',STRUCTURAL_TARGET:'objetivo estructural observado',TIMEOUT:'tiempo máximo',TIMEOUT_EXTENDED:'tiempo máximo extendido de la continuación',TRAILING_RETRACEMENT:'retroceso del beneficio neto desde su máximo observado',TRAILING_STAGNATION:'estancamiento de la continuación protegida',MANUAL_PROFIT:'toma de ganancia solicitada',MANUAL_CLOSE:'cierre solicitado',DATA_GAP_CLOSE:'cierre histórico con datos incompletos'}[reason]??reason);
const entryEconomicsText=(p,receipt=p?.entry_economics,scope='al seleccionar')=>receipt?`\nEconomía ${scope} para ${receipt.quantity??'la cantidad registrada'} BTC: neto previsto al objetivo ${textMoney(receipt.expected_net_target)} USD; mínimo experimental: ${textMoney(receipt.minimum_expected_net_target)} USD (${pct(p?.economic_policy?.min_expected_net_target_fraction??receipt.min_expected_net_target_fraction)} % del nominal efectivo ${textMoney(receipt.effective_exposure)} USD).`:'';
const closedProtectionText=e=>{const t=e.details?.profit_protection??e.profit_protection;return t?.trailing_activated_at?`\nProtección del último remanente (${t.basis_qty} BTC): máximo neto observado ${textMoney(t.peak_net)} USD; umbral de cierre ${textMoney(t.protected_net)} USD. El resultado realizado depende de las ejecuciones, no de ese umbral.`:'';};
export function secondaryMessage(n){
 const compact=compactQuantMessage(n);if(compact)return compact;
 const e=n.payload??{},p=e.plan,s=p?.sizing,link='\nAbrir Trading: '+PANEL_URL;
 if(n.kind==='SECONDARY_RISK_POLICY'&&e.version==='secondary-risk-budget-3.0.0')return 'Secundaria PAPER · perfil activo experimental\nRiesgo máximo por entrada 1%; por dirección 2%; cartera 5%. Hasta 10 posiciones/órdenes, con capital finito y control de margen. Los tamaños efectivos pueden ser menores. Nuevos contratos: parciales 30% + 30% y remanente con trailing. Sin rentabilidad demostrada.'+link;
 if(n.kind==='SECONDARY_RISK_POLICY')return `Secundaria PAPER · tamaño por riesgo y ampliaciones\nNuevos contratos: cantidad limitada por pérdida al stop, costes y estrés de ejecución. Presupuesto por tramo: 0,5 % del patrimonio y máximo 10 USD; movimiento: 1 % y máximo 20 USD; cartera: 3 % y máximo 50 USD.\nMargen total máximo 50 % y exposición bruta máxima 3× el patrimonio. Apalancamiento simulado de ${e.version==='secondary-risk-budget-2.0.0'?'1×, 2×, 3×, 5× o 10×':'2×, 5× o hasta 10×'} según el margen disponible; no multiplica otra vez el resultado. El modelo de liquidación es una aproximación de estrés, no una réplica de Kraken.\nHasta 10 órdenes/posiciones en conjunto y tres tramos seleccionados por movimiento. Las ampliaciones necesitan una confirmación nueva y un padre favorable, protegido y todavía vigente. Sin recargas. Contratos anteriores intactos.`+link;
 if(n.kind==='SECONDARY_QUANT')return `Secundaria PAPER · motor cuantitativo experimental\nNueve familias de patrones con selección por régimen; scalping, continuación, reversión, rupturas, momentum y barridos. Relojes independientes en 1m, 5m, 15m, 1h y 4h.\nCostes, riesgo correlacionado, margen y confirmación posterior a latencia limitan cada entrada. Protección neta temprana más trailing técnico por posición. Pérdida diaria máxima 3%; drawdown 10% requiere revisión y mantiene las salidas activas.\nSon hipótesis en evaluación: la investigación no demuestra rentabilidad. No hay probabilidades nuevas calibradas ni órdenes reales.`+link;
 if(n.kind==='SECONDARY_TIMEFRAMES'&&e.version==='secondary-timeframes-2.0.0')return `Secundaria PAPER · entradas por plazo\nHabilitados 1 min, 5 min, 15 min, 1 h y 4 h con velas cerradas de PF_XBTUSD y relojes separados. Datos de 30 min y 1 día disponibles para contexto.\n1 min: horizonte base 10 min, extensión 5 min y estancamiento 3 min. Los otros plazos conservan sus horizontes. Compartir saldo no bloquea automáticamente otro plazo; se comprueban riesgo y exposición agregados.\nCada cierre de vela registra evaluación o motivo de espera, sin fabricar entradas históricas.`+link;
 if(n.kind==='SECONDARY_TIMEFRAMES')return `Secundaria PAPER · entradas por plazo\nHabilitados 5 min, 15 min, 1 h y 4 h con velas cerradas de PF_XBTUSD, relojes separados y el mismo saldo/riesgo.\nPlazos base: 30 min, 90 min, 6 h y 24 h; extensiones máximas: 15 min, 45 min, 3 h y 12 h. Las salidas se revisan con cotizaciones recientes.\nLa activación no fabrica señales ni entradas inmediatas. El panel muestra datos disponibles, última evaluación y motivo de espera de cada plazo. La red de entradas existente conserva sólo su dominio 5 min / 15 min.`+link;
 if(n.kind==='SECONDARY_CAPITAL_ALLOCATION')return `Secundaria PAPER · asignación con capital disponible\nNominal base por señal válida: ${textMoney(e.base_nominal_usd)} USD; mejor candidata: hasta ${textMoney(e.preferred_nominal_usd)} USD, sólo cuando hay varias válidas y una es estrictamente mejor por margen neto previsto y RR.\nApalancamiento: 2×. Aporte único hasta un patrimonio de ${textMoney(e.target_equity)} USD ficticios; no se repone el saldo después de perder.\nAbre las operaciones financiables y conserva margen y costes reservados. No hay una meta de diez posiciones ni recargas automáticas. Stop, objetivo, trailing y contratos existentes se conservan.\nLa prioridad es experimental y no garantiza rentabilidad.`+link;
 if(n.kind==='SECONDARY_NEURAL')return `Lumi Trading PAPER · capa neuronal ${e.mode}\n${e.mode==='ASSISTED'?'Una versión validada puede priorizar nuevas oportunidades ya válidas.':e.mode==='ADVISORY'?'Predicciones experimentales para comparar; no cambian las órdenes.':e.mode==='COLLECTING'?'Captura de variables previas y resultados. Todavía no hay un modelo entrenado disponible.':'Se utiliza el motor de reglas existente.'}\nLa gestión por posición, el filtro de margen útil y el trailing se conservan.\n${e.reason?'Estado: '+e.reason+'\n':''}${e.model_id?'Modelo '+e.model_id+'\n':''}La capa neuronal no implica rentabilidad demostrada.`+link;
 if(n.kind==='SECONDARY_PROFIT_POLICY'){
  const policy=e.policy??{};
  if(policy.target_activation_required===false)return `Secundaria PAPER · protección neta temprana\nLas nuevas entradas conservan un mínimo neto previsto de ${pct(policy.min_expected_net_target_fraction)} % del nominal efectivo, después de costes.\nLa protección puede activarse antes del objetivo cuando el neto liquidable permite un piso mínimo de ${textMoney(policy.min_protected_net_usd)} USD y un margen adicional de ejecución. El piso sólo sube: retroceso inicial ${pct(policy.retracement_fraction)} % del máximo neto, con colchón por spread/ejecución.\nCruzar el piso deja una salida pendiente hasta ejecutarse; gaps, latencia o liquidez pueden dar un resultado inferior o negativo. Stop y plazo máximo siguen vigentes. Cada contrato anterior mantiene su política.\nPerfil ${e.profile_version}`+link;
  return `Secundaria PAPER · política experimental de margen útil y continuación protegida\nLas nuevas entradas necesitan un objetivo estructural con neto previsto mínimo de ${pct(policy.min_expected_net_target_fraction)} % del nominal efectivo, después de costes. El cálculo se comprueba de nuevo antes de ejecutar.\nAl alcanzar el objetivo con neto suficiente, cada posición activa su propia protección: deja continuar y solicita cierre al retroceder ${pct(policy.retracement_fraction)} % desde su máximo neto observado. El umbral dispara una salida; no garantiza precio ni ganancia.\nSe conservan stop, plazo acotado, costes y liquidez. Las órdenes y posiciones anteriores mantienen su contrato. La exploración continúa sin bloqueos por pérdidas ficticias.\nPerfil ${e.profile_version}`+link;
 }
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
Plazo ${planContext(p)} · exposición ${textMoney(s?.exposure)} USD · margen ${textMoney(s?.initial_margin)} USD · ${s?.leverage??p?.execution_contract?.leverage??2}×${trancheText(p)}
Objetivo neto estimado: ${textMoney(s?.target_net)} USD. Calidad: ${qualityLabel(p)}.${entryEconomicsText(p)}
Ref. ${ref(e)}`+link;
 if(n.kind==='SECONDARY_TOPUP')return `Aporte exclusivamente ficticio · PAPER_CAPITAL_TOPUP
Secundaria PAPER: +${textMoney(e.amount)} USD
Saldo disponible anterior: ${textMoney(e.balance_before)} → posterior: ${textMoney(e.balance_after)} USD
Capital aportado acumulado: ${textMoney(e.capital_contributed_total)} USD
Motivo: ${e.reason}. Es un depósito ficticio, no una ganancia. ${e.reason==='USER_REQUESTED_CAPITAL_TARGET'?'Aporte único solicitado: no se repetirá después de pérdidas.':'El aporte no aumenta automáticamente el nominal de las próximas señales.'}
${e.reason==='USER_REQUESTED_CAPITAL_TARGET'?'Solicitud':'Orden'} ${String(e.order_id??'').slice(0,12)} · evento ${ref(e)}`+link;
 if(n.kind==='SECONDARY_UNFILLED'){
  const expired=e.order_state==='ORDEN_VENCIDA'||['VENCIDA','ENTRY_EXPIRED'].includes(e.reason),state=expired?'ORDEN_VENCIDA':'ORDEN_CANCELADA';
  return `${state} · secundaria PAPER
PF_XBTUSD · ${e.pattern??p?.pattern??''}
Motivo: ${exitReason(e.reason)}${e.entry_revalidation?entryEconomicsText(p,e.entry_revalidation,'revalidada antes de cancelar'):''}
${e.had_partial?'Se canceló únicamente el remanente de '+String(e.remaining_qty)+' BTC. La cantidad ya ejecutada conserva su posición y resultado.':'La orden terminó sin ejecución. Este vencimiento o cancelación no es una pérdida de una posición.'}
Ref. ${ref(e)}`+link;
 }
 if(n.kind==='SECONDARY_PARTIAL')return `EJECUCIÓN_PARCIAL · secundaria PAPER
PF_XBTUSD · ${p?.pattern??e.pattern} · ${p?.direction??e.direction}
Este fragmento: ${e.qty} BTC a ${textMoney(e.price)} USD
Ejecutado acumulado: ${e.cumulative_qty??e.qty} / ${e.requested_qty??s?.qty} BTC
Remanente: ${e.remaining_qty??'0'} BTC · ${executionLabel(p)}
Comisión del fragmento: ${textMoney(e.fee)} USD. La posición se gestiona por la cantidad realmente ejecutada.${e.entry_revalidation?entryEconomicsText(p,e.entry_revalidation,'revalidada'):''}
Ref. ${ref(e)}`+link;
 if(n.kind==='SECONDARY_PARTIAL_CLOSE')return `CIERRE_PARCIAL · secundaria PAPER
PF_XBTUSD · ${e.direction??p?.direction} · ${exitReason(e.reason)}
Cerrado: ${e.qty} BTC a ${textMoney(e.price)} USD. Resta: ${e.remaining_qty} BTC.
Resultado neto${e.result_final===false||e.funding_complete===false?' provisional':''} del fragmento: ${textMoney(e.pnl)} USD. Costes: ${textMoney(e.fees)} USD.
La operación todavía tiene una posición abierta. La intención de cierre y la protección del remanente se conservan por su propio identificador.
Ref. ${ref(e)}`+link;
 if(n.kind==='SECONDARY_TRAILING'){
  const t=e.profit_protection??e.protection??e;
  if(isEarlyProfitContract(p?.exit_policy))return `PROTECCIÓN NETA ACTIVA · secundaria PAPER\nPF_XBTUSD · ${p?.pattern??e.pattern??''} · ${p?.direction??e.direction??''} · ${planContext(p)}\nNeto liquidable al activar: ${textMoney(t.activation_net)} USD. Máximo causal: ${textMoney(t.peak_net)} USD.\nPiso de salida: ${textMoney(t.protected_net)} USD; retroceso permitido: ${textMoney(t.retracement_allowance)} USD. Objetivo de referencia: ${textMoney(p?.target)} USD; no es necesario tocarlo para proteger.\nEl piso dispara la solicitud de salida y no garantiza su resultado. Cada tramo conserva su propia gestión.\nPolítica ${p.exit_policy.version} · Ref. ${ref(e)}`+link;
  return `OBJETIVO ALCANZADO: DEJANDO CORRER · secundaria PAPER\nPF_XBTUSD · ${p?.pattern??e.pattern??''} · ${p?.direction??e.direction??''}\nObjetivo de precio: ${textMoney(p?.target??e.target)} USD. Se activó la protección de esta posición; alcanzar el objetivo no la liquida automáticamente.\nNeto ejecutable observado al activar: ${textMoney(t.activation_net)} USD. Máximo neto observado: ${textMoney(t.peak_net)} USD.\nUmbral neto de cierre: ${textMoney(t.protected_net)} USD; retroceso permitido: ${textMoney(t.retracement_allowance)} USD (${pct(p?.exit_policy?.retracement_fraction??e.retracement_fraction??'0.25')} % del máximo).\nEl umbral solo dispara la intención de salida. Latencia, liquidez, costes y movimientos posteriores pueden dar un resultado inferior, incluso negativo. Las otras posiciones conservan su propia gestión.\nPolítica ${t.exit_policy_version??p?.exit_policy?.version??e.exit_policy_version??'registrada'} · Ref. ${ref(e)}`+link;
 }
 if(n.kind==='SECONDARY_OPEN')return `POSICIÓN_ABIERTA · Agustín, abrí una ${p.direction==='SHORT'?'venta en corto':'compra'} simulada en la secundaria.
Kraken Futures · PF_XBTUSD · ${planContext(p)}
${p.recipe_title}
Entrada simulada: ${textMoney(e.price)} USD · ${e.cumulative_qty??e.qty} BTC
Exposición ${e.entry_revalidation?'revalidada para la ejecución':'solicitada'}: ${textMoney(e.entry_revalidation?.effective_exposure??s.exposure)} USD · ${s.leverage}× ficticio · ${executionLabel(p)}
Margen solicitado: ${textMoney(s.initial_margin)} USD · riesgo al stop con estrés: ${textMoney(s.risk)} USD${trancheText(p)}
Stop: ${textMoney(p.stop)} · objetivo: ${textMoney(p.target)} USD
Riesgo previsto de ${e.entry_revalidation?'la cantidad ejecutada':'la señal completa'}: ${textMoney(e.entry_revalidation?.expected_loss_stop??s.risk)} USD; objetivo neto estimado: ${textMoney(e.entry_revalidation?.expected_net_target??s.target_net)} USD, no garantizado.${entryEconomicsText(p,e.entry_revalidation??p.entry_economics,e.entry_revalidation?'revalidada antes de ejecutar':'al seleccionar')}
Comisión de entrada ${pct(p.execution_contract?.mode==='TAKER_IOC'?p.execution_contract.takerFee:s.entry_fee_rate??'0.0002')} %; salida ${pct(p.execution_contract?.takerFee??'0.0005')} %, más deslizamiento y financiación. Plazo base: ${Math.round((p.exit_policy?.base_holding_ms??p.holding_ms??1800000)/60000)} minutos.
${isEarlyProfitContract(p.exit_policy)?`Protección neta temprana: puede activarse antes del objetivo si cubre costes y ruido; el piso solo sube. Extensión máxima ${Math.round(p.exit_policy.trailing_extension_ms/60000)} min. No garantiza una ganancia.\n`:p.exit_policy?`Objetivo como activación: con neto suficiente deja continuar y protege frente a un retroceso del ${pct(p.exit_policy.retracement_fraction)} % del máximo neto. Extensión acotada: ${Math.round(p.exit_policy.trailing_extension_ms/60000)} min; estancamiento: ${Math.round(p.exit_policy.stagnation_ms/60000)} min. La protección es un disparador, no una ganancia asegurada.\n`:''}
${Number(s.target_net)<=0?'CALIDAD DESFAVORABLE: el objetivo previsto no cubre los costes estimados.\n':''}Ref. ${ref(e)}`+link;
 if(n.kind==='SECONDARY_CLOSE')return `POSICIÓN_CERRADA · Agustín, cerré la operación simulada de la secundaria.
Kraken Futures · PF_XBTUSD · ${e.direction==='SHORT'?'Venta en corto':'Compra'}
Motivo: ${exitReason(e.reason)}
Entrada ${textMoney(e.entry)} → salida ${textMoney(e.price)} USD
Resultado neto${e.result_final===false||e.funding_complete===false?' provisional':''}: ${textMoney(e.pnl)} USD. Costes: ${textMoney(e.fees)} USD, incluida financiación registrada.${closedProtectionText(e)}
${e.quality==='OBSERVED'?'Precio y volumen observados en la simulación.':'Calidad de datos: '+e.quality+'. Se conserva la incertidumbre; el caso no constituye una etiqueta limpia para validar el patrón.'}
Ref. ${ref(e)}`+link;
 throw Error('SECONDARY_NOTICE_UNKNOWN');
}
export class SecondaryNotifier extends TradingNotifier{
 constructor(options){
  const original=options.store,filtered=new Proxy(original,{get(t,k){if(k==='queued')return async()=> (await t.queued()).filter(n=>!KINDS.has(n.kind));const v=Reflect.get(t,k,t);return typeof v==='function'?v.bind(t):v;}});
  super({...options,store:filtered});this.originalStore=original;this.quantOnly=options.quantOnly??(()=>false);this.secondaryPending=options.secondaryPending??null;
 }
 async drain(){
  if(this.quantOnly()){
   const old=(await this.originalStore.queued()).find(legacyTradingNotice);
   if(old){const claim_id=randomUUID(),claim=await this.originalStore.tx({phase:'CLAIM',id:old.id,claim_id});
    if(claim.status==='DISPATCHING'&&claim.claim_id===claim_id)await this.originalStore.tx({phase:'FINISH',id:old.id,claim_id,status:'REJECTED',reason:'SUPERSEDED_BY_QUANT_ENGINE',receipt:{sent:false}});
    return [{id:old.id,status:claim.status==='DISPATCHING'?'REJECTED':claim.status,reason:'SUPERSEDED_BY_QUANT_ENGINE'}];}
  }
  const notice=(await this.originalStore.queued()).find(n=>KINDS.has(n.kind));if(!notice)return super.drain();
  const expired=notice.kind==='SECONDARY_SELECTED'&&notice.payload?.plan?.quant_contract&&(Date.now()-notice.payload.plan.decision_at>30000||notice.payload.plan.expires_at<=Date.now()||this.secondaryPending&&!this.secondaryPending(notice.payload.plan.id));
  if(expired){const claim_id=randomUUID(),claim=await this.originalStore.tx({phase:'CLAIM',id:notice.id,claim_id});if(claim.status==='DISPATCHING'&&claim.claim_id===claim_id)await this.originalStore.tx({phase:'FINISH',id:notice.id,claim_id,status:'EXPIRED',reason:'QUANT_SIGNAL_NO_LONGER_PENDING',receipt:{sent:false}});return [{id:notice.id,status:'EXPIRED'}];}
  if(!this.identityAt||Date.now()-this.identityAt>3600000)await this.verify();
  const owner=await this.owner(),id=notice.id,claim_id=randomUUID(),claim=await this.originalStore.tx({phase:'CLAIM',id,claim_id});
  if(claim.status!=='DISPATCHING'||claim.claim_id!==claim_id)return [{id,status:claim.status}];
  let status='DELIVERED',reason=null,receipt={};
  try{
   if(notice.kind==='SECONDARY_SELECTED'&&notice.payload?.plan?.quant_contract&&(Date.now()-notice.payload.plan.decision_at>30000||notice.payload.plan.expires_at<=Date.now()||this.secondaryPending&&!this.secondaryPending(notice.payload.plan.id)))throw Object.assign(Error('QUANT_SIGNAL_NO_LONGER_PENDING'),{expired:true});
   const text=secondaryMessage(notice);if(text.length>4000)throw Object.assign(Error('MESSAGE_TOO_LONG'),{definite:true});
   receipt.attempt_at=Date.now();const r=await this.transport.call('sendMessage',{chat_id:owner,text,link_preview_options:{is_disabled:true},reply_markup:{inline_keyboard:[[{text:'Vista simple',web_app:{url:PANEL_URL.replace(/\/$/,'')+'/simple/'}},{text:'Vista completa',web_app:{url:PANEL_URL}}]]}});receipt.response_at=Date.now();
   if(!Number.isSafeInteger(r?.message_id)||r.message_id<=0||String(r.chat?.id)!==owner)throw Error('INVALID_TELEGRAM_RECEIPT');
   Object.assign(receipt,{message_id:r.message_id,telegram_date:r.date,recipient_hash:hash(owner),read_confirmed:false});
  }catch(e){status=e.expired?'EXPIRED':e.definite?'REJECTED':'UNKNOWN';reason=/^[A-Z_]+$/.test(e.message)?e.message:'TELEGRAM_SEND_FAILED';receipt.response_at??=Date.now();}
  await this.originalStore.tx({phase:'FINISH',id,claim_id,status,receipt,reason});return [{id,status,reason,receipt}];
 }
}
export function installOperational(engine,env){
 const requested=env.LUMI_TRADING_SECONDARY_EXECUTION;
 if(!requested){if(engine.state.secondaryExecution)throw Error('SECONDARY_EXECUTION_FLAG_REQUIRED');return null;}
 if(requested!==SECONDARY_VERSION||env.LUMI_RUNTIME_ENV!=='staging'||env.LUMI_TRADING_MODE!=='PAPER'||env.LUMI_TRADING_STORAGE!=='SQLITE')throw Error('SECONDARY_EXECUTION_PAPER_ONLY');
 if(engine.secondaryRuntime)throw Error('SECONDARY_EXECUTION_ALREADY_INSTALLED');
 const runtime=new OperationalSecondary({engine}).initialize();
 installExploration(engine.state,env,runtime.now(),e=>engine.event(e));
 installProfitPolicy(engine.state,env,runtime.now(),e=>engine.event(e));engine.secondaryRuntime=runtime;
 installCapitalAllocation(engine.state,env,runtime.now(),e=>engine.event(e));
 installSecondaryRiskBudget(engine.state,env,runtime.now(),e=>engine.event(e));
 installSecondaryTimeframes(engine.state,env,runtime.now(),e=>engine.event(e));
 installQuant(engine.state,env,runtime.now(),e=>engine.event(e));
 installOpportunities(engine.state,env,runtime.now(),e=>engine.event(e));
 installContextPullback(engine.state,env,runtime.now(),e=>engine.event(e));
 installActivePaper(engine.state,env,runtime.now(),e=>engine.event(e));
 applyCapitalAllocationFunding(engine.state,runtime.now(),runtime.broker.topup.bind(runtime.broker),{quote:runtime.quote});
 installSecondaryNeural(engine,env);
 // Route all secondary writes through the futures broker. The existing spot
 // engine, controls and primary continue to run, but cannot settle these trades.
 engine.frequency.market=()=>{};engine.frequency.recover=()=>{};engine.frequency.boundary=async()=>{};
 engine.frequency.cancel=reason=>{if(['ORDER_CANCELLED_ON_SHUTDOWN','RESOURCE_LIMIT'].includes(reason))runtime.broker.gap(reason);};
 engine.laboratory.boundary=async()=>{};
 const track=engine.learning.track.bind(engine.learning);engine.learning.track=(ledger,version,p,q)=>{if(!isSecondary(p))return track(ledger,version,p,q);};
 const tick=engine.tick.bind(engine);engine.tick=async()=>{if(engine.busy)return;if(runtime.now()-engine.lastLease<=30000)runtime.tick();await tick();};
 const delivery=engine.acceptDelivery.bind(engine);engine.acceptDelivery=n=>{if(KINDS.has(n.kind))return;return delivery(n);};
 if(engine.notifier){const old=engine.notifier;engine.notifier=new SecondaryNotifier({store:engine.store,db:old.db,env,feed:engine.feed,pending:id=>engine.pending(id),transport:old.transport,quantOnly:()=>runtime.state.quant?.active===true,secondaryPending:id=>Boolean(engine.state.frequency.account.pendingOrders?.[id])});}
 if(isExploration(engine.state)){
  const profile=runtime.state.exploration,policy=getExplorationPolicy(engine.state),key=profile.policy_hash;
  if(runtime.state.profile_status_notice_queued!==key){engine.notice('SECONDARY_STATUS',{equity:engine.state.frequency.account.equity,exploration:true,profile_version:profile.version,nominalUSD:policy.nominalUSD,leverage:policy.leverage,execution_mode:Object.values(policy.modes).every(mode=>mode==='TAKER_IOC')?'taker IOC simulada':Object.entries(policy.modes).map(([pattern,mode])=>pattern+': '+mode).join(', ')},[profile.version,key,'enabled']);runtime.state.profile_status_notice_queued=key;}
 }else if(!runtime.state.status_notice_queued){engine.notice('SECONDARY_STATUS',{equity:engine.state.frequency.account.equity},[SECONDARY_VERSION,'enabled']);runtime.state.status_notice_queued=true;}
 const profitPolicy=runtime.state.profit_policy;
 if(profitPolicy?.active&&runtime.state.profit_policy_status_notice_queued!==profitPolicy.policy_hash){
  engine.notice('SECONDARY_PROFIT_POLICY',{profile_version:profitPolicy.version,policy_hash:profitPolicy.policy_hash,policy:profitPolicy.policy},[profitPolicy.version,profitPolicy.policy_hash,'enabled']);
  runtime.state.profit_policy_status_notice_queued=profitPolicy.policy_hash;
 }
 const allocation=capitalAllocationView(engine.state);
 if(allocation?.active&&runtime.state.capital_allocation_status_notice_queued!==allocation.policy_hash){
  engine.notice('SECONDARY_CAPITAL_ALLOCATION',allocation,[allocation.version,allocation.policy_hash,'enabled']);
  runtime.state.capital_allocation_status_notice_queued=allocation.policy_hash;
 }
 const riskBudget=riskBudgetView(engine.state),frames=getSecondaryTimeframes(engine.state);
 if(riskBudget?.active&&runtime.state.risk_budget_status_notice_queued!==riskBudget.policy_hash){engine.notice('SECONDARY_RISK_POLICY',{version:riskBudget.version,policy_hash:riskBudget.policy_hash},[riskBudget.version,riskBudget.policy_hash,'enabled']);runtime.state.risk_budget_status_notice_queued=riskBudget.policy_hash;}
 const quant=runtime.state.quant;
 if(quant?.active&&runtime.state.quant_status_notice_queued!==quant.policy_hash){engine.notice('SECONDARY_QUANT',{version:quant.version,policy_hash:quant.policy_hash},[quant.version,quant.policy_hash,'enabled']);runtime.state.quant_status_notice_queued=quant.policy_hash;}
 if(frames&&runtime.state.timeframe_status_notice_queued!==frames.policy_hash){engine.notice('SECONDARY_TIMEFRAMES',{version:frames.version,policy_hash:frames.policy_hash},[frames.version,frames.policy_hash,'enabled']);runtime.state.timeframe_status_notice_queued=frames.policy_hash;}
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
const planDetails=(view,raw)=>raw?{...view,pattern:raw.pattern,rule_version:raw.rule_version??raw.entry_revision??raw.version,instrument:raw.instrument,holding_ms:raw.holding_ms,execution_contract:clone(raw.execution_contract),quality:clone(raw.quality),quality_classification:clone(raw.quality?.classification??raw.quality_classification??raw.entry_quality),economics:clone(raw.economics),economic_policy:clone(raw.economic_policy),entry_economics:clone(raw.entry_economics),entry_context:clone(raw.entry_context),context_admission:clone(raw.context_admission),exit_policy:clone(raw.exit_policy),quant_contract:clone(raw.quant_contract),timeframe_contract:clone(raw.timeframe_contract),movement_id:raw.movement_id??null,parent_id:raw.parent_id??null,leg_index:raw.leg_index??null,confirmation_id:raw.confirmation_id??null}:view;
function projectOperationalOrders(d,state,now){
 const x=state.secondaryExecution,a=state.frequency.account,account=d.frequency.account,history=state.frequency.history??[];
 for(const p of account.positions??[]){
  const raw=a.positions?.[p.plan.id];if(!raw)continue;p.plan=planDetails(p.plan,raw.plan);p.live_exit=secondaryEstimate(raw,x.market?.quote,now);
  p.profit_protection=clone(raw.profit_protection);p.entry_revalidation=clone(raw.entry_revalidation);p.scale_out=clone(raw.scale_out??null);
  p.exposure=D(raw.qty).mul(raw.entry).toString();p.current_margin=raw.initial_margin;p.leverage=raw.plan.execution_contract?.leverage??2;p.risk=raw.remaining_risk??raw.plan.sizing?.risk??null;
  p.exit_advisory=clone(raw.exit_advisory_status??null);p.margin_surrogate=clone(raw.margin_surrogate??null);p.risk_execution=clone(raw.risk_execution??null);
  p.realized_plus_remaining_net=p.live_exit?.funding_complete?D(raw.realized?.net??0).plus(p.live_exit.net).toString():null;
  Object.assign(p,{execution_state:raw.execution_state??(raw.partial_entry?'EJECUCIÓN_PARCIAL':'POSICIÓN_ABIERTA'),requested_qty:raw.requested_qty??raw.plan.sizing.qty,cumulative_qty:raw.cumulative_qty??raw.initial_qty??raw.qty,open_qty:raw.qty,closed_qty:raw.closed_qty??'0',entry_state:D(raw.initial_qty??raw.qty).lt(raw.plan.sizing.qty)?'EJECUCIÓN_PARCIAL':'EJECUCIÓN_COMPLETA',
   exit_intent:clone(raw.exit_intent),execution_blocker:raw.execution_blocker??null,closed_funding_pending:clone(raw.closed_funding_pending??[]),data_quality:raw.quality,funding_pending:clone(raw.funding_pending??[]),funding_gaps:clone(raw.funding_gaps??[]),data_gaps:clone(raw.data_gaps??[]),excursions:clone(raw.excursions),execution_costs:clone(raw.execution_costs),max_favourable:clone(raw.excursions?.max_favourable_net??raw.max_favourable??raw.mfe),max_adverse:clone(raw.excursions?.max_adverse_net??raw.max_adverse??raw.mae)});
 }
 for(const p of account.pending_orders??[]){
  const raw=a.pendingOrders?.[p.plan.id];if(!raw)continue;p.plan=planDetails(p.plan,raw.plan);p.entry_revalidation=clone(raw.last_entry_economics??raw.entry_revalidation);
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
 account.open_position_ids=[...new Set(values(a.positions).map(p=>p.plan.id))];
 account.pending_order_ids=[...new Set(values(a.pendingOrders).map(p=>p.plan.id))];
 account.position_count=account.open_position_ids.length;account.pending_count=account.pending_order_ids.length;
}
export function attachOperationalProjection(publisher,store,runtime=null){
 if(!publisher)return;const send=publisher.send.bind(publisher);
 // Capture the committed row once before either network await. Live and detail
 // must describe the same revision even if the worker commits during upload.
 publisher.projectSnapshot=(d,state,now)=>{
  if(!state.secondaryExecution)return d;
  const x=state.secondaryExecution,f=state.frequency,policy=SECONDARY_PROTOCOL,exploring=isExploration(state),explorationPolicy=getExplorationPolicy(state),profile=x.exploration;
  const riskBudget=riskBudgetView(state),frames=getSecondaryTimeframes(state);
  // Internal deduplication/liquidity registries remain in SQLite; the panel gets
  // bounded operational summaries rather than duplicate state and all group IDs.
  d.secondary_execution={...x,protocol:policy,seen_signals:undefined,liquidity:undefined,risk_budget:riskBudget};
  d.secondary_risk_budget=riskBudget;
  d.secondary_quant=x.quant?{version:x.quant.version,active:x.quant.active,guard:x.quant.guard,counts:x.quant.counts,opportunities:clone(x.quant.opportunities??null),public_analytics:clone(x.quant.public_analytics??null),fibonacci:clone(x.quant.fibonacci??null),context_pullback:clone(x.quant.context_pullback??null),active_experiment:clone(x.quant.active_experiment??null),strategies:quantStrategySpecs(!!getContextProfile(state)),advanced:x.quant.policy.advanced,validation_status:'EXPERIMENTAL_PROFITABILITY_NOT_PROVEN'}:null;
  d.secondary_exit_advisory={status:'COLLECTING',authority:'NONE',model:null,training_updates:0,source:'BOUNDED_CAUSAL_EVENTS',applies_to:'NEW_V2_PROTECTION_CONTRACTS'};
  d.secondary_neural=neuralView(state,now);
  const allocation=capitalAllocationView(state),nominal=allocation?.base_nominal_usd??explorationPolicy?.nominalUSD;
  d.secondary_capital_allocation=allocation;
  const risk=riskBudget?.active?{version:riskBudget.version,financial_blocks:true,maxSlots:10,maxDirectionSlots:null,openRisk:riskBudget.policy.portfolio_risk_fraction,risk:riskBudget.policy.leg_risk_fraction,maxRiskUSD:riskBudget.policy.leg_risk_cap_usd,movementRisk:riskBudget.policy.movement_risk_fraction,movementRiskCap:riskBudget.policy.movement_risk_cap_usd,portfolioRiskCap:riskBudget.policy.portfolio_risk_cap_usd,dailyLoss:null,drawdown:null,lossCooldown:null,maxGrossExposure:riskBudget.policy.gross_exposure_multiple,maxMarginFraction:riskBudget.policy.margin_fraction,maxLeverage:10,leverageChoices:riskBudget.policy.leverage_choices,finite_capital:true,automatic_topups:false,nominalUSD:null,aspirationalNetTargetUSD:riskBudget.policy.aspirational_net_target_usd,portfolio:riskBudget.portfolio}:exploring?{version:allocation?.active?allocation.version:profile.version,financial_blocks:false,maxSlots:null,maxDirectionSlots:null,openRisk:null,risk:null,maxRiskUSD:null,dailyLoss:null,drawdown:null,cashReserve:null,maxGrossExposure:null,lossCooldown:null,oppositeExposureAllowed:true,nominalUSD:nominal,leverage:explorationPolicy.leverage,finite_capital:Boolean(allocation),automatic_topups:!allocation,preferred_nominal_usd:allocation?.preferred_nominal_usd??null}: {version:SECONDARY_VERSION,maxSlots:policy.maxSlots,openRisk:policy.openRiskFraction,risk:policy.riskFraction,maxRiskUSD:policy.riskCapUSD,dailyLoss:policy.dailyLossFraction};
  d.frequency={...d.frequency,execution_version:SECONDARY_VERSION,execution_status:x.status,exchange:'KRAKEN_FUTURES',instrument:policy.symbol,operation_mode:exploring?'EXPLORATION_PAPER':'CONTINUOUS_PAPER',daily_selection_limit:null,
   exploration_profile:profile?{version:profile.version,active:profile.active,activated_at:profile.activated_at,policy_hash:profile.policy_hash,policy:clone(profile.policy)}:null,
   profit_policy:clone(x.profit_policy??null),capital_allocation:allocation,
   market:x.market,lastDecision:f.lastDecision,pattern_decisions:x.decisions,history:clone((f.history??[]).slice(0,40)),protocol:{...d.frequency.protocol,intervalMs:300000,maxHoldingMinutes:30,fee:policy.takerFee,makerFee:policy.makerFee,risk:exploring?null:policy.riskFraction,dailyLoss:exploring?null:policy.dailyLossFraction,minNetRR:exploring?null:String(policy.minNetRR)},risk_profile:risk,entry_profile:null,context_profile:null,maker_sizing_profile:null};
  if(exploring)d.frequency.account={...d.frequency.account,max_slots:riskBudget?.active?10:null,financial_limits_active:Boolean(riskBudget?.active),nominal_usd:riskBudget?.active?null:nominal,finite_capital:Boolean(allocation),active_order_position_count:riskBudget?.portfolio?.slots??null};
  d.frequency.financial_summary=secondaryFinancialSummary(state,x.market?.quote,now);
  d.secondary_finances=d.frequency.financial_summary;
  projectOperationalOrders(d,state,now);
  const activeTrial={version:SECONDARY_VERSION,status:x.status,started_at:x.activated_at,closed:x.counts.closed,net:D(f.account.net).minus(x.baseline.net).toNumber(),recipe:{id:SECONDARY_VERSION,title:'Secundaria operativa · PF_XBTUSD',tf:5,timeframes:frames?.policy.entry_frames??[5,15]},decisions:x.decisions,report:{status:'EXPERIMENTAL_PAPER',reason:'NO_PROFITABILITY_CLAIM'}};
  d.laboratory={...d.laboratory,previous_trial_status:state.laboratory?.status??d.laboratory.status,status:x.status==='ACTIVE_PAPER'?'ACTIVE':x.status,active:SECONDARY_VERSION,executionRevision:SECONDARY_VERSION,operational:true,lastDecision:f.lastDecision,
   exploration_profile:d.frequency.exploration_profile,profit_policy:d.frequency.profit_policy,financial_summary:d.secondary_finances,
   recipes:(frames?.policy.entry_frames??[5]).flatMap(tf=>policy.patterns.map(id=>({id:frames?tf+':'+id:id,title:id,tf,kind:id,holdingMs:frames?.policy.frames[tf]?.base_holding_ms??policy.holdingMs,minNetRR:exploring?null:String(policy.minNetRR)}))),
   trials:[...(d.laboratory.trials??[]).filter(t=>t.version!==SECONDARY_VERSION),activeTrial]};
  d.secondary_comparison=clone(x.by_pattern_version??x.statistics??{});
  const inventory=Object.fromEntries((frames?.policy.data_frames??[5,15]).map(tf=>[tf,{bars:runtime?.series?.[tf]?.length??null,last_closed_at:runtime?.series?.[tf]?.at(-1)?.end??null}]));
  return projectSecondaryActivity(d,state,now,inventory);
 };
 publisher.send=async(path,body,revision,options)=>{
  if(options?.projected)return send(path,body,revision);
  const d=JSON.parse(body);
  if(d.secondary_activity?.view_version===ACTIVITY_VIEW_VERSION&&d.secondary_activity.revision===revision)return send(path,body,revision);
  const row=store.row();if(row.revision!==revision||!row.state.secondaryExecution)return send(path,body,revision);
  return send(path,JSON.stringify(publisher.projectSnapshot(d,row.state,Date.now())),revision);
 };
}
