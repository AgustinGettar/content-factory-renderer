// Read-only L100 diagnostics. Not imported by the worker or used for admission.
// A conditional structural target is not a calibrated prediction or an order.
import {D, hash} from './core.js';
import {evaluateEntryEconomics} from './secondary-entry-economics.js';
import {riskUnitLoss} from './secondary-risk-budget.js';
import {secondaryEstimate, secondaryFresh} from './secondary-futures-math.js';

export const L100_DIAGNOSTIC_VERSION = 'lumi-l100-diagnostic-1.0.0';
const decimal = value => value !== null && value !== undefined && typeof value !== 'boolean'
 && String(value).trim() !== '' && (() => { try { return D(value).isFinite(); } catch { return false; } })();
const positive = value => decimal(value) && D(value).gt(0);
const nonnegative = value => decimal(value) && D(value).gte(0);
const min = values => values.map(D).reduce((a, b) => a.lte(b) ? a : b);
const base = target => ({version:L100_DIAGNOSTIC_VERSION, scope:'OFFLINE_DIAGNOSTIC', authority:'NONE',
 mode:'PAPER', realTrading:false, target_net_usd:target, target_scope:'COMPLETE_POSITION_CYCLE',
 target_is_exit_veto:false, exploration_unchanged:true, budget_may_increase:false,
 order_created:false, forecast_guaranteed:false, probability:null});
const finish = result => ({...result, hash:hash(result)});

/**
 * Bounds are a single, explicitly supplied pretrade snapshot AFTER existing
 * reservations. This function never reserves them and does not certify that
 * they are current on AWS. Concurrent admission must use the existing broker.
 * The existing signed plan supplies price, cost, lot and risk semantics.
 */
export function diagnoseL100Feasibility(plan, {quote, now, fundingRate, targetNetUSD='100', bounds=null}={}) {
 if (!positive(targetNetUSD)) throw Error('L100_TARGET_INVALID');
 const common = {...base(D(targetNetUSD).toString()), operation_id:plan?.id??null,
  timeframe:plan?.timeframe??null, direction:plan?.direction??null, evaluated_at:now??null,
  budget_verified_in_runtime:false, reservation_atomicity_verified:false};
 const unknown = reason => finish({...common, status:'NOT_EVALUABLE', reason,
  selected_quantity:null, compatible_target_net:null});
 if (!Number.isSafeInteger(now) || !secondaryFresh(quote, now)) return unknown('FUTURES_DATA_NOT_FRESH');
 const step = plan?.sizing?.qty_step;
 if (!positive(step) || !positive(plan?.sizing?.qty)) return unknown('SIGNED_SIZE_OR_LOT_MISSING');
 if (!positive(plan?.execution_contract?.participation) || D(plan.execution_contract.participation).gt(1))
  return unknown('EXECUTION_PARTICIPATION_INVALID');
 let economics, unit;
 try {
  const short=plan.direction==='SHORT', contract=plan.execution_contract;
  const entryPrice=contract.mode==='TAKER_IOC'
   ? D(quote[short?'bid':'ask']).mul(D(1).plus(D(contract.slippage).mul(short?-1:1))).toString()
   : plan.entry;
  economics = evaluateEntryEconomics(plan, {quote, qty:'1', entryPrice, now, fundingRate, stage:'L100_DIAGNOSTIC'});
  if (!economics.applied || !positive(economics.expected_loss_stop) || !decimal(economics.expected_net_target))
   return unknown(economics.reason??'ENTRY_ECONOMICS_UNAVAILABLE');
  unit = riskUnitLoss(plan, {entryPrice, fundingRate});
  if (!positive(unit.total)) return unknown('RISK_UNIT_UNAVAILABLE');
 } catch { return unknown('PLAN_ECONOMICS_INVALID'); }
 const detail = {...common, economics, unit_risk:unit, original_quantity:String(plan.sizing.qty),
  existing_quantity_scenario_target_net:D(plan.sizing.qty).mul(economics.expected_net_target).toString(),
  model:'EXISTING_LINEAR_BBO_FEES_FUNDING_AND_SEPARATE_RISK_STRESS',
  target_basis:'CONDITIONAL_STRUCTURAL_TARGET_NOT_CALIBRATED_FORECAST',
  entry_policy_accepted:economics.accepted, entry_policy_reason:economics.reason,
  funding_basis:economics.funding_estimate_source,
  liquidity_scope:'CURRENT_ENTRY_BBO_ONLY_FUTURE_EXIT_LIQUIDITY_UNKNOWN'};
 if (!positive(economics.expected_net_target)) return finish({...detail, status:'TARGET_NOT_SUPPORTED_AFTER_COSTS',
  reason:'STRUCTURAL_TARGET_NET_NOT_POSITIVE', required_quantity:null,
  selected_quantity:null, compatible_target_net:null});
 const required = D(targetNetUSD).div(economics.expected_net_target).div(step).ceil().mul(step);
 const requiredFields = ['risk_available_usd','margin_available_usd','free_cash_usd',
  'gross_exposure_available_usd','observed_entry_quantity','reference_exposure_cap_usd'];
 const missing = requiredFields.filter(key => !nonnegative(bounds?.[key]));
 if (missing.length || !positive(bounds?.leverage) || !Number.isSafeInteger(bounds?.at)
  || bounds.at > now || now-bounds.at > 5000 || typeof bounds?.source !== 'string' || !bounds.source)
  return finish({...detail, status:'NOT_EVALUABLE', reason:'BUDGET_BOUNDS_MISSING_INVALID_OR_STALE',
   required_quantity:required.toString(), missing_bounds:missing, selected_quantity:null, compatible_target_net:null});
 // This diagnostic is deliberately unable to choose or raise leverage.
 if (!positive(plan.execution_contract.leverage) || !D(bounds.leverage).eq(plan.execution_contract.leverage))
  return finish({...detail, status:'NOT_EVALUABLE', reason:'LEVERAGE_DIFFERS_FROM_EXISTING_CONTRACT',
   required_quantity:required.toString(), selected_quantity:null, compatible_target_net:null});
 const entry = D(economics.estimated_entry_price), leverage = D(bounds.leverage);
 const entryFeeRate = D(plan.execution_contract.mode === 'TAKER_IOC'
  ? plan.execution_contract.takerFee : plan.execution_contract.makerFee);
 const reservePerUnit = entry.div(leverage).plus(entry.mul(entryFeeRate)).plus(unit.funding);
 const maintenance = plan.execution_contract.risk_budget?.policy?.maintenance_margin_fraction;
 if (!nonnegative(maintenance) || D(maintenance).gte(1)) return finish({...detail, status:'NOT_EVALUABLE',
  reason:'MAINTENANCE_MARGIN_CONTRACT_MISSING', required_quantity:required.toString(), selected_quantity:null, compatible_target_net:null});
 const marginSafe = entry.div(leverage).gt(D(unit.total).plus(D(unit.stop_fill).mul(maintenance)));
 const capacities = {
  risk:D(bounds.risk_available_usd).div(unit.total),
  margin:D(bounds.margin_available_usd).mul(leverage).div(entry),
  free_cash:D(bounds.free_cash_usd).div(reservePerUnit),
  gross_exposure:D(bounds.gross_exposure_available_usd).div(entry),
  liquidity:min([bounds.observed_entry_quantity, D(quote[plan.direction==='SHORT'?'bid_qty':'ask_qty'])
   .mul(plan.execution_contract.participation)]),
  existing_reference_cap:D(bounds.reference_exposure_cap_usd).div(entry),
 };
 const maximum = min(Object.values(capacities)).div(step).floor().mul(step);
 const chosen = marginSafe ? min([required, maximum]) : D(0);
 const target = chosen.mul(economics.expected_net_target), risk = chosen.mul(unit.total);
 const limiting = Object.entries(capacities).filter(([,value]) => value.lt(required)).map(([key]) => key);
 if (!marginSafe) limiting.push('maintenance_margin');
 const enough = target.gte(targetNetUSD), accepted = economics.accepted && chosen.gt(0);
 return finish({...detail, status:!accepted?'EXISTING_POLICY_OR_CAPACITY_REJECTS':enough?'CONDITIONALLY_FEASIBLE':'TARGET_REDUCED',
  reason:!marginSafe?'STOP_BEYOND_MARGIN_BUDGET':!economics.accepted?economics.reason:!chosen.gt(0)?'BELOW_CONTRACT_LOT':enough?'WITHIN_SUPPLIED_BOUNDS':'TARGET_EXCEEDS_SUPPLIED_BOUNDS',
  bounds:structuredClone(bounds), required_quantity:required.toString(), max_quantity:maximum.toString(),
  selected_quantity:chosen.toString(), selected_exposure:chosen.mul(entry).toString(),
  compatible_target_net:target.toString(), expected_loss_with_stress:risk.toString(),
  reserved_cash:chosen.mul(reservePerUnit).toString(), margin:chosen.mul(entry).div(leverage).toString(),
  limiting_factors:limiting, target_achievable_in_scenario:accepted&&enough,
  exploration_remains_subject_to_existing_policy:true,
  reservation_status:'NOT_RESERVED_REVALIDATE_ATOMICALLY_IN_EXISTING_BROKER'});
}

/** Use the broker's remainder estimate; CLOSED.pnl already includes partials. */
export function l100CycleView(positionOrClose, {quote, now, targetNetUSD='100'}={}) {
 if (!positive(targetNetUSD)) throw Error('L100_TARGET_INVALID');
 const p=positionOrClose, common={...base(D(targetNetUSD).toString()), operation_id:p?.plan?.id??p?.id??null};
 if (p?.type==='CLOSED') {
  const confirmed=p.result_final===true&&p.funding_complete===true&&decimal(p.pnl);
  return finish({...common, state:'CLOSED', realized_net:confirmed?D(p.pnl).toString():null,
   provisional_realized_net:decimal(p.pnl)?D(p.pnl).toString():null, result_final:confirmed,
   cycle_net_estimate:null, remaining_net_estimate:null, estimated_at:null,
   target_realized:confirmed?D(p.pnl).gte(targetNetUSD):null, amount_scope:'COMPLETE_POSITION_CYCLE',
   reason:confirmed?'LEDGER_CLOSED_TOTAL_INCLUDES_PARTIALS':'FUNDING_OR_FINAL_RESULT_UNCONFIRMED'});
 }
 const closedKnown=nonnegative(p?.closed_qty), closedSome=closedKnown&&D(p.closed_qty).gt(0);
 const realized=closedKnown&&!closedSome?D(0):decimal(p?.realized?.net)?D(p.realized.net):null;
 const realizedConfirmed=realized!==null&&Array.isArray(p?.closed_funding_pending)&&p.closed_funding_pending.length===0;
 let estimate=null;try{estimate=secondaryEstimate(p,quote,now);}catch{ /* Unknown is not zero. */ }
 const complete=realizedConfirmed&&estimate?.funding_complete===true;
 const cycle=complete?realized.plus(estimate.net):null;
 return finish({...common, state:'OPEN', realized_net:realizedConfirmed?realized.toString():null,
  provisional_realized_net:realized?.toString()??null, result_final:false,
  remaining_net_estimate:estimate?.funding_complete?estimate.net:null,
  cycle_net_estimate:cycle?.toString()??null, estimated_at:estimate?.at??null,
  quote_at:estimate?.quote_at??null, full_exit_liquidity_available:estimate?.liquidity_ok??null,
  target_realized:realizedConfirmed?realized.gte(targetNetUSD):null,
  target_reached_estimated:cycle===null?null:cycle.gte(targetNetUSD),
  reason:cycle===null?'INCOMPLETE_OR_STALE_CYCLE_DATA':'REALIZED_PARTIALS_PLUS_REMAINDER_ESTIMATE',
  no_fill_or_floor_guarantee:true});
}
