// Durable CLOSED-event attribution for research only. This module never decides
// entries/exits, amends PAPER positions, or mutates the accounting ledger.
import Decimal from 'decimal.js';
import {SECONDARY_MODEL} from './secondary-futures-math.js';
import {hash} from './core.js';
export const SECONDARY_PERFORMANCE_REVIEW_VERSION = 'secondary-performance-review-1.1.0';
// Diagnostic arithmetic must not round decimal strings through binary Number.
// A private constructor leaves the engine's Decimal settings unchanged.
// Covers the finite Number exponent range plus the bounded input precision, so
// string amounts keep their decimal digits even when very different in scale.
const Money = Decimal.clone({precision:768});
const ENGINE_PRECISION = 20;
const DECIMAL = /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;
const numeric = value => {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value).trim();
  if (text.length > 80 || !DECIMAL.test(text) || !Number.isFinite(Number(text)) || typeof value==='number'&&Math.abs(value)>Number.MAX_SAFE_INTEGER) return null;
  const amount=new Money(text);
  return Number(text)===0&&!amount.isZero() ? null : amount;
};
const round = x => Number(x.toFixed(8));
const absent = value => value === null || value === undefined;
function hasAggregateEvidence(row) {
  const receipt=row.execution_receipt, total=numeric(row.qty), fragment=numeric(receipt?.quantity);
  if(row.plan?.execution_model!==SECONDARY_MODEL || row.execution_state!=='POSICIÓN_CERRADA' ||
     receipt?.version!=='secondary-paper-exit-evidence-1.0.0' || receipt.scope!=='EXECUTION_FRAGMENT' ||
     receipt.mode!=='PAPER' || receipt.realTrading!==false || receipt.operation_id!==row.id ||
     receipt.id!==row.fill_id || typeof receipt.id!=='string' || !total?.gt(0) || !fragment?.gt(0) || !fragment.lt(total)) return false;
  if(receipt.hash!==undefined){const {hash:declared,...body}=receipt;if(typeof declared!=='string'||hash(body)!==declared)return false;}
  return true;
}
function accounting(row) {
  const net=numeric(row.pnl), fees=numeric(row.fees), gross=numeric(row.gross), funding=numeric(row.funding);
  const invalid=()=>{throw Error('PAPER_PERFORMANCE_INVALID_ACCOUNTING');};
  if (!net || !fees || !absent(row.gross)&&!gross || !absent(row.funding)&&!funding) invalid();
  // In this CLOSED contract fees is total commission + signed funding. The
  // final funding receipt describes only the last fragment, not the whole close.
  const commissions=funding ? fees.minus(funding) : null;
  if (commissions?.lt(0)) invalid();
  if (fees.lt(0) && (!funding?.lt(0) || !gross || row.plan?.execution_model !== SECONDARY_MODEL)) invalid();
  let identityStatus='UNKNOWN_GROSS', identityDifference=null;
  if (gross) {
    // CLOSED totals can be sums of partials rounded by the engine at 20
    // significant digits. Allow two units in its last place, never a cent-based
    // tolerance. Check the supplied numbers; do not alter or reconstruct them.
    const scale=Money.max(gross.abs(),fees.abs(),net.abs());
    const tolerance=scale.isZero() ? new Money(0) : new Money(10).pow(scale.e-ENGINE_PRECISION+1).mul(2);
    identityDifference=gross.minus(fees).minus(net);
    if (identityDifference.abs().gt(tolerance)) {
      // Gross/net cancellation across partial closes loses the scale of earlier
      // rounding. A last-fragment receipt proves aggregation, not its numerical
      // error bound. Preserve declared totals and expose the unresolved identity
      // rather than rejecting valid broker data or inventing a wider epsilon.
      if(!hasAggregateEvidence(row)) invalid();
      identityStatus='UNVERIFIED_AGGREGATE_IDENTITY';
    } else identityStatus='VERIFIED_WITH_CORE_PRECISION';
  }
  return {net,fees,gross,funding,commissions,identity_status:identityStatus,identity_difference:identityDifference?.toString()??null};
}
const code = (value, fallback) => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,90}$/.test(value) ? value : fallback;
const interval = (wins, total) => {
  if (!total) return null;
  const z = 1.95996398454, p = wins / total, a = 1 + z * z / total;
  const center = (p + z * z / (2 * total)) / a;
  const half = z * Math.sqrt(p * (1 - p) / total + z * z / (4 * total * total)) / a;
  return [round(Math.max(0, center - half)), round(Math.min(1, center + half))];
};
function statistics(operations) {
  let winning = 0, losing = 0, flat = 0, positive = new Money(0), negative = new Money(0);
  let net = new Money(0), fees = new Money(0), gross = new Money(0), grossCoverage = 0, longest = 0;
  let funding = new Money(0), paid = new Money(0), received = new Money(0), commissions = new Money(0), fundingCoverage = 0, identityCoverage=0;
  const reasons = {}, values = [];
  for (const o of operations) {
    const n = o.net;
    values.push(n);
    net = net.plus(n);
    fees = fees.plus(o.fees);
    if (o.gross !== null) { gross = gross.plus(o.gross); grossCoverage++; }
    if(o.identity_status==='VERIFIED_WITH_CORE_PRECISION')identityCoverage++;
    if (o.funding !== null) {
      funding=funding.plus(o.funding); commissions=commissions.plus(o.commissions); fundingCoverage++;
      if(o.funding.gt(0)) paid=paid.plus(o.funding);
      else if(o.funding.lt(0)) received=received.plus(o.funding);
    }
    if (n.gt(0)) { winning++; positive = positive.plus(n); }
    else if (n.lt(0)) { losing++; negative = negative.minus(n); }
    else flat++;
    reasons[o.reason] = (reasons[o.reason] ?? 0) + 1;
    if (o.elapsed_ms !== null) longest = Math.max(longest, o.elapsed_ms);
  }
  const count = operations.length;
  const componentsComplete = fundingCoverage === count;
  const exact = {net_usd:net.toString(),fees_usd:fees.toString(),gross_usd:grossCoverage===count?gross.toString():null,
    commissions_usd:componentsComplete?commissions.toString():null,funding_usd:componentsComplete?funding.toString():null,
    funding_paid_usd:componentsComplete?paid.toString():null,funding_received_usd:componentsComplete?received.toString():null};
  return {count, winning, losing, flat, win_rate:count ? round(winning / count) : null,
    win_rate_wilson95:interval(winning, count), net_usd:round(net), fees_usd:round(fees),
    gross_usd: grossCoverage === count ? round(gross) : null, gross_coverage:grossCoverage,
    average_net_usd:count ? round(net.div(count)) : null,
    profit_factor:negative.gt(0) ? round(positive.div(negative)) : null,
    maximum_win_usd:count ? round(Money.max(...values)) : null,
    maximum_loss_usd:count ? round(Money.min(...values)) : null,
    commissions_usd:componentsComplete?round(commissions):null,funding_usd:componentsComplete?round(funding):null,
    funding_paid_usd:componentsComplete?round(paid):null,funding_received_usd:componentsComplete?round(received):null,
    funding_coverage:fundingCoverage,accounting_identity_coverage:identityCoverage,unverified_identity_count:count-identityCoverage,amounts_exact:exact,
    longest_holding_ms:count ? longest : null, exits:reasons};
}
export function summarizeSecondaryPerformance(events) {
  if (!Array.isArray(events)) throw Error('PAPER_PERFORMANCE_EVENTS_REQUIRED');
  const seen = new Set(), eligible = [], manual = [], unresolved = [], identityUnverified = [];
  let ignoredNonCloses = 0, excludedNonSecondary = 0;
  for (const row of events) {
    if (row?.type !== 'CLOSED') { ignoredNonCloses++; continue; }
    if (row.ledger !== 'FREQUENT_PAPER' || row.realTrading !== false) {
      excludedNonSecondary++; // Legacy PAPER records lack an explicit futures execution contract.
      continue;
    }
    if (typeof row.id !== 'string' || !row.id || seen.has(row.id))
      throw Error('PAPER_PERFORMANCE_DUPLICATE_OR_INVALID_OPERATION');
    seen.add(row.id);
    const amounts=accounting(row);
    if (row.result_final === false || row.funding_complete === false) {
      unresolved.push({operation_id:row.id,reason:'ACCOUNTING_NOT_FINAL'});
      continue;
    }
    const timeframe = Number.isSafeInteger(row.plan?.timeframe ?? row.timeframe)
      ? String(row.plan?.timeframe ?? row.timeframe) : 'UNKNOWN';
    const version = code(row.plan?.entry_revision, 'LEGACY_UNVERSIONED');
    const pattern = code(row.plan?.pattern ?? row.pattern, 'UNKNOWN');
    const reason = code(row.reason, 'UNKNOWN');
    const enteredAt = row.entered_at;
    const elapsed = Number.isSafeInteger(enteredAt) && Number.isSafeInteger(row.at) && row.at >= enteredAt ? row.at - enteredAt : null;
    const operation = {id:row.id, ...amounts, version, timeframe, pattern, reason, elapsed_ms:elapsed};
    if(amounts.identity_status==='UNVERIFIED_AGGREGATE_IDENTITY') {
      identityUnverified.push({...operation,declared_result_final:row.result_final??null,declared_funding_complete:row.funding_complete??null});
      continue;
    }
    (row.management_override === true || reason.startsWith('MANUAL_') ? manual : eligible).push(operation);
  }
  const groups = new Map();
  for (const o of eligible) {
    const key = [o.version,o.timeframe,o.pattern].join('|');
    if (!groups.has(key)) groups.set(key, {version:o.version,timeframe:o.timeframe,pattern:o.pattern,operations:[]});
    groups.get(key).operations.push(o);
  }
  return {version:SECONDARY_PERFORMANCE_REVIEW_VERSION, mode:'PAPER', realTrading:false,
    authority:'RESEARCH_ONLY', statistically_validated:false,
    source:'DURABLE_CLOSED_EVENTS', policy:'NO_EXECUTION_CHANGES',
    accounting_contract:{costs:'COMMISSIONS_PLUS_SIGNED_FUNDING',funding:'POSITIVE_PAID_NEGATIVE_RECEIVED',
      identity:'GROSS_MINUS_COSTS_EQUALS_NET',engine_precision:ENGINE_PRECISION,identity_tolerance:'TWO_ULP_AT_LARGEST_OPERAND',
      missing_components:'UNKNOWN_NOT_ZERO',numeric_output:'ROUNDED_8DP',exact_output:'amounts_exact',
      aggregate_identity:'UNVERIFIED_WHEN_NO_ERROR_BOUND',finality:'FUNDING_STATUS_NOT_IDENTITY_CERTIFICATION'},
    ignored_non_closes:ignoredNonCloses, excluded_non_secondary_closes:excludedNonSecondary, unresolved_count:unresolved.length,
    unresolved_operation_ids:unresolved.map(o=>o.operation_id),
    identity_warnings:[...eligible,...manual,...identityUnverified].filter(o=>o.identity_status!=='VERIFIED_WITH_CORE_PRECISION')
      .map(o=>({operation_id:o.id,status:o.identity_status,difference:o.identity_difference})),
    identity_unverified:statistics(identityUnverified),
    identity_unverified_operations:identityUnverified.map(o=>({operation_id:o.id,status:o.identity_status,difference:o.identity_difference,
      declared_result_final:o.declared_result_final,declared_funding_complete:o.declared_funding_complete,
      recorded_amounts:{net_usd:o.net.toString(),gross_usd:o.gross?.toString()??null,fees_usd:o.fees.toString(),funding_usd:o.funding?.toString()??null}})),
    autonomous:statistics(eligible), manual:statistics(manual),
    all_final:statistics([...eligible,...manual]),
    groups:[...groups.values()].map(g=>({...g, ...statistics(g.operations),operations:undefined})).sort((a,b)=>b.count-a.count||a.version.localeCompare(b.version)||a.timeframe.localeCompare(b.timeframe)),
    limitations:['NO_OPEN_POSITION_PNL','NO_COUNTERFACTUAL_PERFORMANCE','NO_FUNDING_RECONCILIATION','NO_STATISTICAL_VALIDATION','MANUAL_EXCLUDED_FROM_AUTONOMOUS','LEGACY_UNVERSIONED_SCOPE_EXCLUDED','UNVERIFIED_AGGREGATE_IDENTITY_EXCLUDED','MISSING_COMPONENTS_REPORTED_AS_UNKNOWN']};
}
