// Compact operational messages for the quantitative PAPER engine only.
import {D} from './core.js';
const money=x=>x==null?'—':D(x).toFixed(D(x).abs().lt(.1)?4:2);
const frame=x=>({1:'1m',5:'5m',15:'15m',60:'1h',240:'4h'}[x]??'—');
const reasons={ACTIVE_SCALE_OUT:'Toma parcial de beneficio neto',QUANT_NET_RR_DETERIORATED:'RR neto insuficiente',PRE_EXECUTION_QUANT_NET_RR_DETERIORATED:'RR neto insuficiente antes de ejecutar',STOP:'Stop loss',TRAILING_RETRACEMENT:'Retroceso del beneficio neto',TRAILING_STAGNATION:'Impulso estancado',QUANT_TECHNICAL_TRAILING:'Stop técnico protegido',QUANT_MOMENTUM_EXHAUSTION:'Agotamiento del impulso',TIMEOUT:'Tiempo máximo',TIMEOUT_EXTENDED:'Fin de la extensión',MANUAL_CLOSE:'Cierre solicitado',MANUAL_PROFIT:'Ganancia tomada',TARGET:'Objetivo',STRUCTURAL_TARGET:'Objetivo estructural',MARGIN_STRESS:'Estrés de margen',IOC_NO_LIQUIDITY:'Sin liquidez al ejecutar',IOC_REMAINDER_CANCELLED:'Remanente IOC cancelado',VENCIDA:'Orden vencida',ENTRY_EXPIRED:'Orden vencida',PRE_EXECUTION_EXPECTED_NET_TARGET_BELOW_MINIMUM:'El neto previsto ya no alcanza el mínimo',ENTRY_ECONOMICS_CHANGED_BEFORE_FILL:'Costes cambiaron antes de ejecutar'};
export function compactQuantMessage(n){
 const e=n.payload??{},p=e.plan;if(!p?.quant_contract)return null;
 const s=p.sizing??{},r=e.entry_revalidation??p.entry_economics??{},f=p.quant_contract.fibonacci;
 const head=`PAPER · BTC/USD · ${p.direction} · ${frame(p.timeframe)} · ${s.leverage??p.execution_contract?.leverage??'—'}×`;
 const name=p.recipe_title??p.pattern,ref=`Ref. ${String(e.id??p.id).slice(0,10)}`;
 const fib=f?.confluence?` · Fib ${(f.confirmed_level.ratio*100).toFixed(1)}%`:f?.status==='READY'?' · Fib registrado':'';
 const barriers=`SL ${money(p.stop)} · TP ${money(p.target)} USD`;
 const estimate=`Riesgo est. ${money(r.expected_loss_stop??s.risk)} · neto al TP est. ${money(r.expected_net_target??s.target_net)} USD`;
 const reason=reasons[e.reason]??'Motivo registrado en el panel';
 if(n.kind==='SECONDARY_SELECTED')return `SEÑAL · ${p.execution_contract?.mode==='MAKER_LIMIT'?'límite pendiente (vence en '+Math.round((p.expires_at-p.decision_at)/60000)+' min)':'pendiente de ejecución'}\n${head}\n${name}${fib}\nEntrada prevista ${money(p.entry)} · ${barriers}\n${estimate}\n${ref}`;
 if(['SECONDARY_OPEN','SECONDARY_PARTIAL'].includes(n.kind)){
  const partial=n.kind==='SECONDARY_PARTIAL',qty=e.cumulative_qty??e.qty,exposure=e.qty!=null&&e.price!=null?D(e.qty).mul(e.price):null;
  return `${partial?'APERTURA PARCIAL':'ABIERTA'} · ${head}\n${name}${fib}\nEntrada ${money(e.price)} USD · ${qty??'—'} BTC${partial?' acumulados':''}\n${barriers}\n${estimate}\n${partial?'Fragmento':'Exposición ejecutada'} ${money(exposure)} USD${partial?' · resta '+(e.remaining_qty??'—')+' BTC':''}\n${ref}`;
 }
 if(['SECONDARY_CLOSE','SECONDARY_PARTIAL_CLOSE'].includes(n.kind)){
  const partial=n.kind==='SECONDARY_PARTIAL_CLOSE',provisional=e.result_final!==true||e.funding_complete===false;
  return `${partial?'CIERRE PARCIAL':'CERRADA'} · ${head}\n${name}\nNeto${provisional?' provisional':''}: ${money(e.pnl)} USD · costes ${money(e.fees)} USD\n${reason}\nEntrada ${money(e.entry)} → salida ${money(e.price)} USD${partial?' · resta '+e.remaining_qty+' BTC':''}\n${e.quality!=='OBSERVED'?'Datos incompletos; resultado con incertidumbre.\n':''}${ref}`;
 }
 if(n.kind==='SECONDARY_TRAILING'){
  const t=e.profit_protection??e.protection??e;
  return `PROTECCIÓN ACTIVA · ${head}\n${name}\nMáximo neto ${money(t.peak_net)} · piso de salida ${money(t.protected_net)} USD\nEl piso dispara el cierre; el resultado puede variar.\n${ref}`;
 }
 if(n.kind==='SECONDARY_UNFILLED')return `${e.had_partial?'REMANENTE CANCELADO':'SIN EJECUCIÓN'} · ${head}\n${name}\n${reason}${e.had_partial?'\nLa cantidad ejecutada sigue abierta.':'\nNo es una operación cerrada ni una pérdida.'}\n${ref}`;
 return null;
}
export const legacyTradingNotice=n=>['SIGNAL','RESULT'].includes(n.kind)||(n.kind==='SECONDARY_SELECTED'&&!n.payload?.plan?.quant_contract);
