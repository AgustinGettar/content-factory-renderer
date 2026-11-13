// Presentation and delivery selection only. Economic events and the durable
// outbox remain intact; this policy has no broker, transport or ledger access.
import {D} from './core.js';

export const SECONDARY_NOTICE_POLICY = 'secondary-position-lifecycle-1.0.0';

export function configuredSecondaryNoticePolicy(env = {}) {
  const requested = env.LUMI_TRADING_SECONDARY_NOTICES;
  if (!requested) return null;
  if (requested !== SECONDARY_NOTICE_POLICY) throw Error('SECONDARY_NOTICE_POLICY_UNKNOWN');
  if (env.LUMI_TRADING_MODE !== 'PAPER' || env.LUMI_RUNTIME_ENV !== 'staging' || env.LUMI_TRADING_STORAGE !== 'SQLITE') {
    throw Error('SECONDARY_NOTICE_POLICY_PAPER_ONLY');
  }
  return requested;
}

const decimal = x => {
  if (typeof x !== 'string' && typeof x !== 'number') return null;
  try { const n = D(x); return n.isFinite() ? n : null; } catch { return null; }
};
const money = x => {
  const n = decimal(x);
  return n === null ? 'no disponible' : n.toFixed(!n.isZero() && n.abs().lt('.1') ? 6 : 2);
};
const signedMoney = n => `${n.gt(0) ? '+' : ''}${money(n.toString())}`;
const timeframe = x => ({1:'1m',5:'5m',15:'15m',60:'1h',240:'4h'}[x] ?? 'plazo no disponible');
const timestamp = x => Number.isFinite(x) && x > 0 && Number.isFinite(new Date(x).getTime()) ? new Date(x).toISOString() : 'hora no disponible';
const reasons = {
  STOP:'Stop loss', TARGET:'Objetivo', NET_TARGET:'Objetivo neto', STRUCTURAL_TARGET:'Objetivo estructural',
  EXECUTABLE_TARGET_FULL_EXIT:'Objetivo neto; cierre completo', MANUAL_CLOSE:'Cierre solicitado', MANUAL_PROFIT:'Ganancia tomada',
  TRAILING_RETRACEMENT:'Retroceso del beneficio neto', TRAILING_STAGNATION:'Continuación sin progreso',
  QUANT_TECHNICAL_TRAILING:'Stop técnico protegido', QUANT_MOMENTUM_EXHAUSTION:'Agotamiento del impulso',
  EXECUTION_BUFFER_PROTECTION:'Protección ante movimiento adverso', MARGIN_STRESS:'Protección de margen',
  TIMEOUT:'Fin del horizonte', TIMEOUT_EXTENDED:'Fin de la extensión', DATA_GAP_CLOSE:'Cierre con datos incompletos',
};

export function secondaryLifecycleNotice(notice) {
  const e = notice.payload ?? {};
  if (!['SECONDARY_OPEN', 'SECONDARY_PARTIAL', 'SECONDARY_CLOSE'].includes(notice.kind)) {
    return {action:'SUPPRESS', reason:'SECONDARY_LIFECYCLE_ONLY'};
  }
  // FILLED is the first executed entry, including an IOC that fills only part
  // of the request. PARTIAL_FILL is a later fragment, not another opening.
  const opened = ['SECONDARY_OPEN', 'SECONDARY_PARTIAL'].includes(notice.kind) && e.type === 'FILLED';
  if (notice.kind === 'SECONDARY_PARTIAL' && e.type === 'PARTIAL_FILL') {
    return {action:'SUPPRESS', reason:'SECONDARY_LIFECYCLE_ONLY'};
  }
  const closed = notice.kind === 'SECONDARY_CLOSE' && e.type === 'CLOSED';
  const qty = decimal(e.cumulative_qty ?? e.qty);
  const remaining = decimal(e.remaining_qty);
  if ((!opened && !closed) || e.ledger !== 'FREQUENT_PAPER' || e.realTrading !== false ||
      typeof e.id !== 'string' || !e.id || !qty?.gt(0) ||
      (closed && (remaining === null || !remaining.isZero()))) {
    return {action:'REJECT', reason:'SECONDARY_LIFECYCLE_RECEIPT_INVALID'};
  }
  const p = e.plan ?? {}, direction = e.direction ?? p.direction;
  const side = direction === 'LONG' ? 'Compra' : direction === 'SHORT' ? 'Venta en corto' : 'Dirección no disponible';
  const header = `Secundaria PAPER · PF_XBTUSD · ${side} · ${timeframe(e.timeframe ?? p.timeframe)}`;
  const reference = `Posición ${e.id}\nEjecución ${timestamp(e.at)}`;
  if (opened) {
    const price = decimal(e.price), exposure = price === null ? null : price.mul(qty).toString();
    return {action:'SEND', text:`OPERACIÓN ABIERTA\n${header}\nEntrada ejecutada: ${money(e.price)} USD · ${qty.toString()} BTC\nExposición ejecutada: ${money(exposure)} USD\nStop ${money(p.stop)} · objetivo de precio ${money(p.target)} USD\n${e.execution_state === 'EJECUCIÓN_PARCIAL' ? 'Se ejecutó parte de lo solicitado; solo esa cantidad está abierta.\n' : ''}${reference}\nTe avisaré al cerrar toda la posición.`};
  }
  // CLOSED.pnl and CLOSED.fees already aggregate all partials. Never add
  // fill_pnl, charge entry costs twice, or infer a result from the last fill.
  const net = decimal(e.pnl), final = e.result_final === true && e.funding_complete !== false && e.quality === 'OBSERVED';
  const outcome = !final || net === null ? 'RESULTADO PROVISIONAL' : net.gt(0) ? 'GANANCIA' : net.lt(0) ? 'PÉRDIDA' : 'SIN GANANCIA NI PÉRDIDA';
  return {action:'SEND', text:`OPERACIÓN CERRADA · ${outcome}\n${header}\nNeto ${final && net !== null ? 'realizado' : 'registrado, pendiente de confirmar'} del ciclo: ${net === null ? 'no disponible' : signedMoney(net)} USD\nIncluye todos los parciales y costes registrados (${money(e.fees)} USD, financiación con su signo).\nMotivo: ${reasons[e.reason] ?? 'ver detalle registrado en el panel'}\nEntrada ${money(e.entry)} → salida media ${money(e.price)} USD\n${!final ? 'Hay costes pendientes o datos incompletos; el neto puede cambiar.\n' : ''}${reference}`};
}
