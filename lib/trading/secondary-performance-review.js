// Durable CLOSED-event attribution for research only. This module never decides
// entries/exits, amends PAPER positions, or mutates the accounting ledger.
export const SECONDARY_PERFORMANCE_REVIEW_VERSION = 'secondary-performance-review-1.0.0';
const DECIMAL = /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;
const numeric = value => {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value).trim();
  if (!DECIMAL.test(text)) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
};
const round = x => Number(x.toFixed(8));
const code = (value, fallback) => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,90}$/.test(value) ? value : fallback;
const interval = (wins, total) => {
  if (!total) return null;
  const z = 1.95996398454, p = wins / total, a = 1 + z * z / total;
  const center = (p + z * z / (2 * total)) / a;
  const half = z * Math.sqrt(p * (1 - p) / total + z * z / (4 * total * total)) / a;
  return [round(Math.max(0, center - half)), round(Math.min(1, center + half))];
};
function statistics(operations) {
  let winning = 0, losing = 0, flat = 0, positive = 0, negative = 0;
  let net = 0, fees = 0, gross = 0, grossCoverage = 0, longest = 0;
  const reasons = {}, values = [];
  for (const o of operations) {
    const n = o.net;
    values.push(n);
    net += n;
    fees += o.fees;
    if (o.gross !== null) { gross += o.gross; grossCoverage++; }
    if (n > 0) { winning++; positive += n; }
    else if (n < 0) { losing++; negative -= n; }
    else flat++;
    reasons[o.reason] = (reasons[o.reason] ?? 0) + 1;
    if (o.elapsed_ms !== null) longest = Math.max(longest, o.elapsed_ms);
  }
  const count = operations.length;
  return {count, winning, losing, flat, win_rate:count ? round(winning / count) : null,
    win_rate_wilson95:interval(winning, count), net_usd:round(net), fees_usd:round(fees),
    gross_usd: grossCoverage === count ? round(gross) : null, gross_coverage:grossCoverage,
    average_net_usd:count ? round(net / count) : null,
    profit_factor:negative > 0 ? round(positive / negative) : null,
    maximum_win_usd:count ? round(Math.max(...values)) : null,
    maximum_loss_usd:count ? round(Math.min(...values)) : null,
    longest_holding_ms:count ? longest : null, exits:reasons};
}
export function summarizeSecondaryPerformance(events) {
  if (!Array.isArray(events)) throw Error('PAPER_PERFORMANCE_EVENTS_REQUIRED');
  const seen = new Set(), eligible = [], manual = [], unresolved = [];
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
    const pnl = numeric(row.pnl), fee = numeric(row.fees), gross = numeric(row.gross);
    if (pnl === null || fee === null || fee < 0)
      throw Error('PAPER_PERFORMANCE_INVALID_ACCOUNTING');
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
    const operation = {id:row.id, net:pnl, fees:fee, gross, version, timeframe, pattern, reason, elapsed_ms:elapsed};
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
    ignored_non_closes:ignoredNonCloses, excluded_non_secondary_closes:excludedNonSecondary, unresolved_count:unresolved.length,
    unresolved_operation_ids:unresolved.map(o=>o.operation_id),
    autonomous:statistics(eligible), manual:statistics(manual),
    all_final:statistics([...eligible,...manual]),
    groups:[...groups.values()].map(g=>({...g, ...statistics(g.operations),operations:undefined})).sort((a,b)=>b.count-a.count||a.version.localeCompare(b.version)||a.timeframe.localeCompare(b.timeframe)),
    limitations:['NO_OPEN_POSITION_PNL','NO_COUNTERFACTUAL_PERFORMANCE','NO_FUNDING_RECONCILIATION','NO_STATISTICAL_VALIDATION','MANUAL_EXCLUDED_FROM_AUTONOMOUS','LEGACY_UNVERSIONED_SCOPE_EXCLUDED']};
}
