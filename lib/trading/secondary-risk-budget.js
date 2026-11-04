// New-contract-only PAPER sizing, movement budgets and isolated-margin surrogate.
// No I/O, cash additions, exchange credentials, orders or second writer.
import {D,hash} from './core.js';
import {secondaryFresh,secondaryEstimate} from './secondary-futures-math.js';
import {evaluateEntryEconomics} from './secondary-entry-economics.js';
import {EXPLORATION_EXECUTION_VERSION,isExploration} from './secondary-exploration.js';

export const RISK_BUDGET_VERSION='secondary-risk-budget-1.0.0';
export const RISK_EXECUTION_VERSION='secondary-risk-execution-1.0.0';
export const RISK_CONTRACT_VERSION='secondary-risk-contract-1.0.0';
export const MARGIN_SURROGATE_VERSION='secondary-isolated-bbo-margin-1.0.0';
export const RISK_BUDGET_POLICY=Object.freeze({
 version:RISK_BUDGET_VERSION,execution_version:RISK_EXECUTION_VERSION,mode:'PAPER',realTrading:false,symbol:'PF_XBTUSD',ledger:'FREQUENT_PAPER',
 leg_risk_fraction:'0.005',leg_risk_cap_usd:'10',movement_risk_fraction:'0.01',movement_risk_cap_usd:'20',portfolio_risk_fraction:'0.03',portfolio_risk_cap_usd:'50',
 margin_fraction:'0.50',gross_exposure_multiple:'3',execution_stress_fraction:'0.0005',maintenance_margin_fraction:'0.01',
 reference_nominal_usd:'300',aspirational_net_target_usd:'1',leverage_choices:[2,5,10],max_leverage:10,max_slots:10,max_movement_legs:3,
 sizing_basis:'STOP_LOSS_FEES_FUNDING_PLUS_SEPARATE_EXECUTION_STRESS',equity_basis:'MIN_MARKED_EQUITY_AND_CASH_PLUS_LOCKED_MARGIN',
 movement_basis:'CONSERVATIVE_OVERLAPPING_BTC_DIRECTION',size_after_loss:'NO_RECOVERY_MULTIPLIER',automatic_topups:false,entry_minimum_is_exit_veto:false,
 margin_model:MARGIN_SURROGATE_VERSION,margin_mark_basis:'OBSERVED_ADVERSE_BBO',liquidation_fee_fraction:'0',negative_balances:'RECORDED_NOT_CAPPED',
 parameter_status:'EXPERIMENTAL_FIXED_BEFORE_OUTCOMES',existing_contracts:'PRESERVED',neural_authority:'UNCHANGED',
});
export const QUANT_RISK_VERSION='secondary-risk-budget-2.0.0';
export const QUANT_RISK_EXECUTION_VERSION='secondary-risk-execution-2.0.0';
export const QUANT_RISK_POLICY=Object.freeze({...RISK_BUDGET_POLICY,version:QUANT_RISK_VERSION,execution_version:QUANT_RISK_EXECUTION_VERSION,leverage_choices:[1,2,3,5,10],maintenance_margin_fraction:'0.05',aspirational_net_target_usd:'0',reference_nominal_usd:'600',movement_basis:'TIMEFRAME_CONFIRMATIONS_WITH_SHARED_BTC_DIRECTION_CAP',sizing_basis:'STOP_RISK_WITH_VOLATILITY_CAP_NO_PROFIT_TARGET_SIZING',margin_model:'PUBLIC_EEA_RETAIL_TIER1_MARK_REFERENCE',margin_mark_basis:'OBSERVED_MARK_PRICE',hedge_mode:false});
const policies={[RISK_BUDGET_VERSION]:RISK_BUDGET_POLICY,[QUANT_RISK_VERSION]:QUANT_RISK_POLICY};
const quantPolicy=p=>p?.version===QUANT_RISK_VERSION;
function directionRisk(root,plan,{excludeId=plan.id}={}){return [...Object.values(root.frequency.account.positions??{}),...Object.values(root.frequency.account.pendingOrders??{})].filter(x=>x.plan.id!==excludeId&&x.plan.direction===plan.direction).reduce((s,x)=>s.plus(x.remaining_risk??x.plan.sizing.risk),D(0));}
const values=o=>Object.values(o??{}),finite=x=>x!==null&&x!==undefined&&typeof x!=='boolean'&&String(x).trim()!==''&&Number.isFinite(Number(x));
const positive=x=>finite(x)&&D(x).gt(0),nonnegative=x=>finite(x)&&D(x).gte(0);
const min=(...xs)=>xs.map(D).reduce((a,b)=>a.lte(b)?a:b),max=(...xs)=>xs.map(D).reduce((a,b)=>a.gte(b)?a:b);
const round=(x,step)=>max(x,0).div(step).floor().mul(step),same=(a,b)=>hash(a)===hash(b);
const near=(a,b)=>finite(a)&&finite(b)&&D(a).minus(b).abs().lte(D(b).abs().mul('1e-15').plus('1e-16'));
const stamp=now=>{if(!Number.isSafeInteger(now)||now<0)throw Error('SECONDARY_RISK_TIMESTAMP_INVALID');};
const seal=x=>({...x,hash:hash(x)});
export const isRiskContract=plan=>[RISK_EXECUTION_VERSION,QUANT_RISK_EXECUTION_VERSION].includes(plan?.execution_contract?.version);
export function validateRiskBudgetPolicy(policy){
 // Parameters are predeclared; changing them requires a new version, never a retrospective env sweep.
 if(!policies[policy?.version]||!same(policy,policies[policy.version]))throw Error('SECONDARY_RISK_POLICY_INTEGRITY');return policy;
}
export function validateRiskBudgetState(root){
 const s=root?.secondaryExecution?.risk_budget;if(!s)return null;
 validateRiskBudgetPolicy(s.policy);
 if(s.version!==s.policy.version||s.policy_hash!==hash(s.policy)||typeof s.active!=='boolean'||!s.movements||!Array.isArray(s.confirmations)||!Array.isArray(s.history))throw Error('SECONDARY_RISK_STATE_INTEGRITY');
 for(const [id,m] of Object.entries(s.movements))if(m.id!==id||!['LONG','SHORT'].includes(m.direction)||!Array.isArray(m.legs)||m.legs.length>3||new Set(m.legs.map(l=>l.id)).size!==m.legs.length||!nonnegative(m.committed_risk)||m.legs.some(l=>!nonnegative(l.risk)||!l.confirmation_id)||m.legs.length&&m.parent_id!==m.legs[0].id||!D(m.committed_risk).eq(m.legs.reduce((total,l)=>total.plus(l.risk),D(0))))throw Error('SECONDARY_MOVEMENT_STATE_INTEGRITY');
 return s;
}
export const getRiskBudgetPolicy=root=>{const s=validateRiskBudgetState(root);return s?.active?s.policy:null;};
export function installRiskBudget(root,env,now,event=()=>{}){
 stamp(now);const s=validateRiskBudgetState(root),requested=env.LUMI_TRADING_SECONDARY_RISK_BUDGET;
 if(!requested){if(s?.active)throw Error('SECONDARY_RISK_FLAG_REQUIRED');return false;}
 if(env.LUMI_TRADING_MODE!=='PAPER'||env.LUMI_RUNTIME_ENV!=='staging'||env.LUMI_TRADING_STORAGE!=='SQLITE')throw Error('SECONDARY_RISK_PAPER_ONLY');
 if(requested==='OFF'){if(!s?.active)return false;s.active=false;s.history.push({at:now,action:'DISABLED',policy_hash:s.policy_hash});event({type:'SECONDARY_RISK_BUDGET_DISABLED',at:now,version:RISK_BUDGET_VERSION,ledger:'FREQUENT_PAPER',existing_contracts_preserved:true,realTrading:false});return true;}
 if(!policies[requested]||!isExploration(root))throw Error('SECONDARY_RISK_VERSION_OR_PROFILE_INVALID');
 // Finite capital must already exist; installing this policy never creates a funding request.
 if(!root.secondaryExecution.capital_allocation)throw Error('SECONDARY_RISK_REQUIRES_FINITE_EXISTING_CAPITAL');
 if(s?.active&&s.version===requested)return false;
 const requestedPolicy=policies[requested];
 const a=root.frequency.account;root.secondaryExecution.risk_budget={...(s??{}),version:requested,active:true,policy:structuredClone(requestedPolicy),policy_hash:hash(requestedPolicy),activated_at:s?.activated_at??now,updated_at:now,movements:s?.movements??{},confirmations:s?.confirmations??[],history:[...(s?.history??[]),{at:now,action:s?'ENABLED':'MIGRATED',policy_hash:hash(requestedPolicy)}],baseline:s?.baseline??{at:now,cash:a.cash,equity:a.equity,net:a.net,fees:a.fees,closed:a.closed,capital_added:'0'}};
 event({type:'SECONDARY_RISK_BUDGET_ENABLED',at:now,version:requested,policy_hash:hash(requestedPolicy),parameters:requestedPolicy,capital_added:'0',existing_contracts_preserved:true,ledger:'FREQUENT_PAPER',realTrading:false});return true;
}
export function riskPortfolioSnapshot(root,{excludePendingId,quote,now}={}){
 const a=root.frequency.account,ps=values(a.positions),os=values(a.pendingOrders).filter(o=>o.plan.id!==excludePendingId);
 let gross=D(0),net=D(0),risk=D(0),margin=D(0),pendingReserve=D(0),funding=D(0);
 for(const p of ps){const exposure=D(p.qty).mul(p.entry);gross=gross.plus(exposure);net=net.plus(exposure.mul(p.plan.direction==='SHORT'?-1:1));risk=risk.plus(p.remaining_risk??p.plan.sizing.risk);margin=margin.plus(p.initial_margin);funding=funding.plus(p.funding_reserved??0);}
 for(const o of os){const qty=D(o.remaining_qty??o.plan.sizing.qty),ratio=qty.div(o.plan.sizing.qty),exposure=qty.mul(o.plan.entry);gross=gross.plus(exposure);net=net.plus(exposure.mul(o.plan.direction==='SHORT'?-1:1));risk=risk.plus(o.remaining_risk??D(o.plan.sizing.risk).mul(ratio));margin=margin.plus(D(o.plan.sizing.initial_margin).mul(ratio));pendingReserve=pendingReserve.plus(o.remaining_reserved??o.plan.sizing.reserved);}
 const locked=ps.reduce((s,p)=>s.plus(p.initial_margin),D(0)),freshMark=quote!==undefined||now!==undefined;
 let marked=D(a.equity),valuationComplete=true;
 if(freshMark){
  // Admission can run before the broker's final account mark. Revalue purely
  // from this quote without booking P&L or paying entry fees a second time.
  valuationComplete=secondaryFresh(quote,now)&&quote.event_at>=(root.secondaryExecution.last_quote_at??0);marked=D(a.cash);
  if(valuationComplete)for(const position of ps){
   const v=secondaryEstimate(position,quote,now);
   if(!v||quote.event_at<position.entered_at||quote.received_at<position.entered_at||!v.funding_complete){valuationComplete=false;break;}
   marked=marked.plus(position.initial_margin).plus(v.gross).minus(v.exit_fee).minus(v.funding);
  }
 }
 const equity=valuationComplete?max(min(marked,D(a.cash).plus(locked)),0):D(0),ids=[...new Set([...ps,...os].map(p=>p.plan.id))];
 return {equity:equity.toString(),marked_equity:valuationComplete?marked.toString():null,cash:a.cash,gross_exposure:gross.toString(),net_exposure:net.toString(),open_risk:risk.toString(),margin:margin.toString(),pending_reserved:pendingReserve.toString(),funding_reserved:funding.toString(),free_cash:max(D(a.cash).minus(pendingReserve).minus(funding),0).toString(),slots:ids.length,ids,
  ...(freshMark?{valuation_basis:'CURRENT_QUOTE_WITH_KNOWN_FUNDING_AND_NO_UNREALIZED_PROFIT_CREDIT',valuation_complete:valuationComplete,valuation_quote_at:quote?.event_at??null,valuation_received_at:quote?.received_at??null}:{}),};
}
const confirmationId=p=>hash([RISK_BUDGET_VERSION,'CAUSAL_CONFIRMATION',p.instrument,p.timeframe,p.direction,p.entry_context?.confirmation_key]);
function parentLiquidatable(root,parent,quote,valuation,now){
 if(!valuation?.funding_complete||!valuation?.liquidity_ok||!positive(valuation.net))return false;
 const protection=parent.profit_protection,l=root.secondaryExecution.liquidity,side=valuation.side,capacity=D(quote[side+'_qty']).mul(parent.plan.execution_contract.participation),used=l?.quote_at===quote.event_at?l.quote_used[side]??0:0;
 if(l?.quote_at>quote.event_at||capacity.minus(used).lt(parent.qty)||D(valuation.net).lte(protection.protected_net))return false;
 if(now>=(protection.effective_expires_at??parent.expires_at)||protection.stagnation_deadline_at!=null&&now>=protection.stagnation_deadline_at)return false;
 return parent.plan.direction==='SHORT'?D(quote.ask).lt(parent.plan.stop):D(quote.bid).gt(parent.plan.stop);
}
function movementAdmission(root,plan,quote,now,{expected}={}){
 const s=validateRiskBudgetState(root),context=plan.entry_context;
 if(!context?.confirmation_key||!Number.isSafeInteger(context.confirmation_event_at)||context.confirmation_event_at>plan.confirmed_at||context.confirmation_event_at>now)return {accepted:false,reason:'MOVEMENT_CAUSAL_CONFIRMATION_REQUIRED'};
 const cid=confirmationId(plan);if(s.confirmations.includes(cid))return {accepted:false,reason:'REPEATED_CONFIRMATION'};
 const rows=[...values(root.frequency.account.positions),...values(root.frequency.account.pendingOrders)].filter(p=>p.plan.direction===plan.direction&&p.plan.id!==plan.id&&(!quantPolicy(s.policy)||p.plan.timeframe===plan.timeframe));
 const unique=[...new Map(rows.map(r=>[r.plan.id,r])).values()],groupIds=[...new Set(unique.map(r=>r.plan.movement_id??hash([RISK_BUDGET_VERSION,'LEGACY_CORRELATED',r.plan.direction])))];
 if(groupIds.length>1)return {accepted:false,reason:'OVERLAPPING_MOVEMENTS_UNRESOLVED'};
 if(!unique.length){
  const id=hash([RISK_BUDGET_VERSION,'MOVEMENT',plan.instrument,plan.direction,cid]);
  if(expected&&(expected.movement_id!==id||expected.parent_id!==null||expected.leg_index!==0))return {accepted:false,reason:'MOVEMENT_IDENTITY_CHANGED'};
  return {accepted:true,reason:'INITIAL_MOVEMENT_ENTRY',movement_id:id,parent_id:null,leg_index:0,confirmation_id:cid,confirmation_event_at:context.confirmation_event_at,committed_risk:'0',related_position_ids:[]};
 }
 const id=groupIds[0],registry=s.movements[id],first=registry?.parent_id??unique.slice().sort((a,b)=>a.plan.confirmed_at-b.plan.confirmed_at||a.plan.id.localeCompare(b.plan.id))[0].plan.id,parent=root.frequency.account.positions[first];
 const legs=registry?.legs??unique.map(r=>({id:r.plan.id,risk:rows.filter(row=>row.plan.id===r.plan.id).reduce((total,row)=>total.plus(row.remaining_risk??row.plan.sizing.risk),D(0)).toString(),confirmation_event_at:r.plan.entry_context?.confirmation_event_at??r.plan.confirmed_at,confirmation_key:r.plan.entry_context?.confirmation_key}));
 if(legs.length>=RISK_BUDGET_POLICY.max_movement_legs)return {accepted:false,reason:'MOVEMENT_MAX_THREE_LEGS'};
 if(!parent)return {accepted:false,reason:'PYRAMID_INITIAL_POSITION_NOT_OPEN'};
 if(parent.exit_intent||parent.exit_requested||parent.profit_protection?.trailing_activated_at==null||parent.profit_protection?.state!=='TRAILING_ACTIVE'||!positive(parent.profit_protection?.protected_net))return {accepted:false,reason:'PYRAMID_INITIAL_NOT_PROTECTED'};
 const v=secondaryEstimate(parent,quote,now);if(!parentLiquidatable(root,parent,quote,v,now))return {accepted:false,reason:'PYRAMID_INITIAL_NOT_FAVORABLE_LIQUID'};
 if(legs.some(l=>l.confirmation_key===context.confirmation_key||l.confirmation_id===cid)||context.confirmation_event_at<=Math.max(...legs.map(l=>l.confirmation_event_at??0)))return {accepted:false,reason:'REPEATED_CONFIRMATION'};
 if(expected&&(expected.movement_id!==id||expected.parent_id!==first||expected.leg_index!==legs.length))return {accepted:false,reason:'MOVEMENT_IDENTITY_CHANGED'};
 const committed=registry?.committed_risk??legs.reduce((sum,l)=>sum.plus(l.risk),D(0)).toString();
 return {accepted:true,reason:'PROTECTED_WINNER_NEW_CONFIRMATION',movement_id:id,parent_id:first,leg_index:legs.length,confirmation_id:cid,confirmation_event_at:context.confirmation_event_at,committed_risk:committed,related_position_ids:unique.map(r=>r.plan.id)};
}
export function riskUnitLoss(plan,{entryPrice=plan.entry,fundingRate}={}){
 const c=plan.execution_contract,policy=c.risk_budget?.policy??RISK_BUDGET_POLICY,sign=plan.direction==='SHORT'?-1:1,entry=D(entryPrice),stopFill=D(plan.stop).mul(D(1).minus(D(c.slippage).mul(sign))),fee=D(c.mode==='TAKER_IOC'?c.takerFee:c.makerFee),horizon=plan.economic_policy?.funding_estimation_ms??plan.holding_ms;
 const funding=fundingRate===undefined?D(plan.economics.fundingAllowance):D(fundingRate).abs().mul(horizon).div(3600000),loss=entry.minus(stopFill).mul(sign).plus(entry.mul(fee)).plus(stopFill.mul(c.takerFee)).plus(funding),stress=entry.mul(policy.execution_stress_fraction);
 return {loss:loss.toString(),stress:stress.toString(),total:loss.plus(stress).toString(),funding:funding.toString(),stop_fill:stopFill.toString()};
}
function marginStopSafe(plan,leverage,unit,entry=plan.entry,policy=null){
 const p=policy??plan.execution_contract.risk_budget?.policy??RISK_BUDGET_POLICY;
 // Stop + stress must precede the surrogate maintenance boundary. No guaranteed stop fill.
 const maintenance=D(unit.stop_fill).mul(p.maintenance_margin_fraction);
 return D(entry).div(leverage).gt(D(unit.total).plus(maintenance));
}
function riskContract(base,policy,receipt){
 const r=seal({version:RISK_CONTRACT_VERSION,policy:structuredClone(policy),policy_hash:hash(policy),base_execution_contract:structuredClone(base),base_contract_hash:hash(base),receipt:structuredClone(receipt),mode:'PAPER',realTrading:false});
 return {...base,version:policy.execution_version,policy_hash:hash({version:policy.execution_version,base:base.policy_hash,risk:r.policy_hash}),nominalUSD:receipt.exposure,leverage:receipt.leverage,risk_budget:r};
}
export function validateRiskContract(plan,{root,current=false}={}){
 if(!isRiskContract(plan)){if(plan?.execution_contract?.risk_budget)throw Error('SECONDARY_RISK_CONTRACT_VERSION_INVALID');return false;}
 const c=plan.execution_contract,r=c.risk_budget,b=r?.base_execution_contract,t=r?.receipt;
 validateRiskBudgetPolicy(r?.policy);
 if(r.version!==RISK_CONTRACT_VERSION||r.mode!=='PAPER'||r.realTrading!==false||r.hash!==hash({...r,hash:undefined})||r.policy_hash!==hash(r.policy)||r.base_contract_hash!==hash(b)||b.version!==EXPLORATION_EXECUTION_VERSION||b.leverage!==2||b.realTrading!==false||b.symbol!=='PF_XBTUSD')throw Error('SECONDARY_RISK_CONTRACT_INTEGRITY');
 const rebuilt=riskContract(b,r.policy,t);if(!same(c,rebuilt)||!r.policy.leverage_choices.includes(c.leverage)||c.leverage>10||t.hash!==hash({...t,hash:undefined}))throw Error('SECONDARY_RISK_CONTRACT_INTEGRITY');
 if(![t.qty,t.qty_step,t.exposure,t.reserved,t.initial_margin,t.risk,t.unit_risk,t.unit_stress,t.risk_ceiling_usd,t.leg_budget_usd,t.movement_budget_usd,t.portfolio_budget_usd].every(positive)||!nonnegative(t.funding_reserved)||t.operation_id!==plan.id||t.at!==plan.decision_at||t.structural_stop!==plan.stop||t.structural_target!==plan.target||t.entry_price!==plan.entry||t.leverage!==c.leverage||!D(t.qty).mul(plan.entry).eq(t.exposure)||!D(t.qty).mul(t.unit_risk).eq(t.risk)||!D(t.risk).eq(t.risk_ceiling_usd)||D(t.risk).gt(t.leg_budget_usd)||D(t.risk).gt(t.movement_risk_available_usd)||D(t.risk).gt(t.portfolio_risk_available_usd))throw Error('SECONDARY_RISK_RECEIPT_INTEGRITY');
 const unit=riskUnitLoss(plan),entry=D(plan.entry),quantity=D(t.qty),fee=c.mode==='TAKER_IOC'?c.takerFee:c.makerFee,eq=D(t.pretrade?.equity??0),legBudget=min(eq.mul(r.policy.leg_risk_fraction),r.policy.leg_risk_cap_usd),movementBudget=min(eq.mul(r.policy.movement_risk_fraction),r.policy.movement_risk_cap_usd),portfolioBudget=min(eq.mul(r.policy.portfolio_risk_fraction),r.policy.portfolio_risk_cap_usd);
 if(t.policy_hash!==r.policy_hash||!quantity.div(t.qty_step).isInteger()||!near(t.initial_margin,D(t.exposure).div(c.leverage))||!near(t.funding_reserved,quantity.mul(unit.funding))||!near(t.reserved,D(t.initial_margin).plus(D(t.exposure).mul(fee)).plus(t.funding_reserved))||!near(t.unit_risk,unit.total)||!near(t.unit_stop_loss,unit.loss)||!near(t.unit_stress,unit.stress)||!marginStopSafe(plan,c.leverage,unit))throw Error('SECONDARY_RISK_ARITHMETIC_INTEGRITY');
 if(!eq.gt(0)||!near(t.leg_budget_usd,legBudget)||!near(t.movement_budget_usd,movementBudget)||!near(t.portfolio_budget_usd,portfolioBudget)||!near(t.movement_risk_available_usd,max(movementBudget.minus(t.committed_risk),0))||!near(t.portfolio_risk_available_usd,max(portfolioBudget.minus(t.pretrade.open_risk),0))||D(t.exposure).plus(t.pretrade.gross_exposure).gt(eq.mul(r.policy.gross_exposure_multiple))||D(t.initial_margin).plus(t.pretrade.margin).gt(eq.mul(r.policy.margin_fraction))||D(t.reserved).gt(t.pretrade.free_cash)||!Number.isInteger(t.pretrade.slots)||t.pretrade.slots<0||t.pretrade.slots>=r.policy.max_slots)throw Error('SECONDARY_RISK_BUDGET_ARITHMETIC_INTEGRITY');
 for(const leverage of r.policy.leverage_choices.filter(value=>value<c.leverage)){const lowerMargin=D(t.exposure).div(leverage),lowerReserve=lowerMargin.plus(D(t.exposure).mul(fee)).plus(t.funding_reserved);if(lowerMargin.plus(t.pretrade.margin).lte(eq.mul(r.policy.margin_fraction))&&lowerReserve.lte(t.pretrade.free_cash)&&marginStopSafe(plan,leverage,unit))throw Error('SECONDARY_RISK_LEVERAGE_NOT_MINIMUM');}
 if(plan.sizing){for(const [key,value] of Object.entries({qty:t.qty,qty_step:t.qty_step,exposure:t.exposure,initial_margin:t.initial_margin,reserved:t.reserved,funding_reserved:t.funding_reserved,risk:t.risk,leverage:t.leverage}))if(String(plan.sizing[key])!==String(value))throw Error('SECONDARY_RISK_SIGNED_SIZING_INTEGRITY');}
 if(plan.movement_id!==t.movement_id||plan.parent_id!==t.parent_id||plan.leg_index!==t.leg_index||plan.confirmation_id!==t.confirmation_id||confirmationId(plan)!==t.confirmation_id||!Number.isInteger(t.leg_index)||t.leg_index<0||t.leg_index>2)throw Error('SECONDARY_MOVEMENT_CONTRACT_INTEGRITY');
 if(current&&(!getRiskBudgetPolicy(root)||root.secondaryExecution.risk_budget.policy_hash!==r.policy_hash))throw Error('SECONDARY_RISK_CURRENT_POLICY_MISMATCH');return true;
}
export function validateRiskRecovery(root,plan){
 if(!isRiskContract(plan))return false;validateRiskContract(plan);const s=validateRiskBudgetState(root),r=plan.execution_contract.risk_budget.receipt,m=s?.movements[r.movement_id],leg=m?.legs?.find(l=>l.id===plan.id);
 if(!leg||leg.confirmation_id!==r.confirmation_id||!D(leg.risk).eq(r.risk)||m.parent_id!==(r.parent_id??plan.id)||m.legs[r.leg_index]?.id!==plan.id)throw Error('SECONDARY_RISK_MOVEMENT_RECOVERY_INTEGRITY');return true;
}
export function revalidatePyramidFill(root,plan,quote,now){
 if(!isRiskContract(plan)||plan.leg_index===0)return {accepted:true};
 const p=root.frequency.account.positions[plan.parent_id];
 if(!p||p.exit_intent||p.exit_requested||p.profit_protection?.trailing_activated_at==null||p.profit_protection?.state!=='TRAILING_ACTIVE'||!positive(p.profit_protection.protected_net))return {accepted:false,reason:'PYRAMID_PARENT_CHANGED_BEFORE_FILL'};
 const v=secondaryEstimate(p,quote,now);if(!parentLiquidatable(root,p,quote,v,now))return {accepted:false,reason:'PYRAMID_PARENT_NOT_FAVORABLE_BEFORE_FILL'};
 return {accepted:true};
}
function prepareOne(root,original,{quote,meta,now}){
 const policy=getRiskBudgetPolicy(root);if(!policy)throw Error('SECONDARY_RISK_PROFILE_REQUIRED');
 if(original.hash||original.sizing||original.execution_contract?.capital_allocation||original.execution_contract?.risk_budget)throw Error('SECONDARY_RISK_UNSIGNED_SIGNAL_REQUIRED');
 if(!secondaryFresh(quote,now)||!positive(meta?.qty_step))return {accepted:false,reason:'FUTURES_DATA_NOT_FRESH'};
 if(quantPolicy(policy)&&[...values(root.frequency.account.positions),...values(root.frequency.account.pendingOrders)].some(x=>x.plan.direction!==original.direction))return {accepted:false,reason:'HEDGE_MODE_NOT_VALIDATED'};
 const snapshot=riskPortfolioSnapshot(root,{quote,now});if(snapshot.slots>=policy.max_slots)return {accepted:false,reason:'PORTFOLIO_CAPACITY'};
 const context=movementAdmission(root,original,quote,now);if(!context.accepted)return context;
 if(!snapshot.valuation_complete)return {accepted:false,reason:'PORTFOLIO_VALUATION_UNAVAILABLE'};
 const eq=D(snapshot.equity);if(!eq.gt(0))return {accepted:false,reason:'PAPER_CAPITAL_INSUFFICIENT'};
 const economics=evaluateEntryEconomics(original,{quote,qty:'1',entryPrice:original.entry,now,stage:'RISK_SIZING'});
 if(!economics.applied||!economics.accepted||!positive(economics.expected_net_target))return {accepted:false,reason:economics.reason??'RISK_ECONOMICS_REQUIRED',entry_economics:economics};
 const unit=riskUnitLoss(original),legBudget=min(eq.mul(policy.leg_risk_fraction),policy.leg_risk_cap_usd),movementBudget=min(eq.mul(policy.movement_risk_fraction),policy.movement_risk_cap_usd),portfolioBudget=min(eq.mul(policy.portfolio_risk_fraction),policy.portfolio_risk_cap_usd),movementAvailable=max(movementBudget.minus(context.committed_risk),0),portfolioAvailable=max(portfolioBudget.minus(snapshot.open_risk),0),riskLimit=min(legBudget,movementAvailable,portfolioAvailable,...(quantPolicy(policy)?[max(movementBudget.minus(directionRisk(root,original)),0)]:[]));
 if(!positive(unit.total)||!riskLimit.gt(0))return {accepted:false,reason:'SHARED_RISK_BUDGET_EXHAUSTED'};
 const entry=D(original.entry),desiredExposure=quantPolicy(policy)?min(policy.reference_nominal_usd,eq.mul('0.6'),eq.mul('0.0015').div(max(original.quant_contract?.features?.atr_relative??'0.0025','0.0025'))):max(policy.reference_nominal_usd,D(policy.aspirational_net_target_usd).div(economics.expected_net_target).mul(entry)),grossFree=max(eq.mul(policy.gross_exposure_multiple).minus(snapshot.gross_exposure),0),marginFree=max(eq.mul(policy.margin_fraction).minus(snapshot.margin),0),fee=original.execution_contract.mode==='TAKER_IOC'?original.execution_contract.takerFee:original.execution_contract.makerFee;
 const side=original.direction==='SHORT'?'bid':'ask',liquidity=max(D(quote[side+'_qty']).mul(original.execution_contract.participation).minus(root.secondaryExecution.liquidity?.quote_at===quote.event_at?root.secondaryExecution.liquidity.quote_used[side]??0:0),0);
 const desired=round(min(desiredExposure.div(entry),riskLimit.div(unit.total),grossFree.div(entry),liquidity),meta.qty_step);
 let chosen=null;
 for(const leverage of policy.leverage_choices){
  if(!marginStopSafe(original,leverage,unit,original.entry,policy))continue;
  const reserve=entry.div(leverage).plus(entry.mul(fee)).plus(unit.funding),qty=round(min(desired,marginFree.mul(leverage).div(entry),D(snapshot.free_cash).div(reserve)),meta.qty_step);
  if(qty.gt(0)&&(!chosen||qty.gt(chosen.qty)))chosen={qty,leverage,reserve};
  if(qty.eq(desired)&&qty.gt(0))break;
 }
 if(!chosen||chosen.qty.lt(meta.qty_step))return {accepted:false,reason:marginFree.lte(0)?'MARGIN_BUDGET_EXHAUSTED':grossFree.lte(0)?'GROSS_EXPOSURE_BUDGET_EXHAUSTED':liquidity.lt(meta.qty_step)?'ENTRY_OBSERVED_LIQUIDITY_INSUFFICIENT':'RISK_MARGIN_OR_MINIMUM_SIZE'};
 const qty=chosen.qty,exposure=qty.mul(entry),risk=qty.mul(unit.total),target=qty.mul(economics.expected_net_target),receipt=seal({version:policy.version,accepted:true,reason:context.reason,mode:'PAPER',realTrading:false,at:now,operation_id:original.id,policy_hash:hash(policy),...context,entry_price:original.entry,structural_stop:original.stop,structural_target:original.target,qty:qty.toString(),qty_step:String(meta.qty_step),exposure:exposure.toString(),initial_margin:exposure.div(chosen.leverage).toString(),reserved:qty.mul(chosen.reserve).toString(),funding_reserved:qty.mul(unit.funding).toString(),leverage:chosen.leverage,risk:risk.toString(),risk_ceiling_usd:risk.toString(),unit_risk:unit.total,unit_stop_loss:unit.loss,unit_stress:unit.stress,leg_budget_usd:legBudget.toString(),movement_budget_usd:movementBudget.toString(),portfolio_budget_usd:portfolioBudget.toString(),movement_risk_available_usd:movementAvailable.toString(),portfolio_risk_available_usd:portfolioAvailable.toString(),pretrade:snapshot,expected_net_target:target.toString(),aspirational_net_target_usd:policy.aspirational_net_target_usd,aspiration_achievable:target.gte(policy.aspirational_net_target_usd),exposure_for_aspiration:entry.mul(policy.aspirational_net_target_usd).div(economics.expected_net_target).toString(),requested_exposure:desiredExposure.toString(),limited:exposure.lt(desiredExposure),limits:{risk:riskLimit.toString(),gross_exposure:grossFree.toString(),margin:marginFree.toString(),observed_entry_quantity:liquidity.toString()},execution_stress_is_additional:true,protected_profit_budget_credit:'0',margin_model:MARGIN_SURROGATE_VERSION});
 const plan={...original,movement_id:context.movement_id,parent_id:context.parent_id,leg_index:context.leg_index,confirmation_id:context.confirmation_id,execution_contract:riskContract(original.execution_contract,policy,receipt)};
 validateRiskContract(plan,{root,current:true});return {accepted:true,plan,receipt,entry_economics:economics};
}
export function recordRiskSelection(root,plan,now){
 if(!isRiskContract(plan))return;validateRiskContract(plan);const s=validateRiskBudgetState(root),r=plan.execution_contract.risk_budget.receipt;
 if(s.confirmations.includes(r.confirmation_id))throw Error('SECONDARY_RISK_CONFIRMATION_ALREADY_SELECTED');
 let m=s.movements[r.movement_id];
 if(!m){const oldParts=r.parent_id?[...values(root.frequency.account.positions),...values(root.frequency.account.pendingOrders)].filter(row=>r.related_position_ids.includes(row.plan.id)):[],oldRows=[...new Map(oldParts.map(row=>[row.plan.id,row])).values()].sort((a,b)=>a.plan.confirmed_at-b.plan.confirmed_at||a.plan.id.localeCompare(b.plan.id)),legs=oldRows.map(row=>({id:row.plan.id,at:row.plan.decision_at,risk:oldParts.filter(part=>part.plan.id===row.plan.id).reduce((total,part)=>total.plus(part.remaining_risk??part.plan.sizing.risk),D(0)).toString(),timeframe:row.plan.timeframe,confirmation_id:confirmationId(row.plan),confirmation_key:row.plan.entry_context?.confirmation_key??null,confirmation_event_at:row.plan.entry_context?.confirmation_event_at??row.plan.confirmed_at,legacy_baseline:true}));m=s.movements[r.movement_id]={id:r.movement_id,parent_id:r.parent_id??plan.id,direction:plan.direction,created_at:now,committed_risk:r.committed_risk,legs};}
 if(m.legs.some(l=>l.id===plan.id)||m.legs.length!==r.leg_index)throw Error('SECONDARY_MOVEMENT_SELECTION_CONFLICT');
 m.legs.push({id:plan.id,at:now,risk:r.risk,timeframe:plan.timeframe,confirmation_id:r.confirmation_id,confirmation_key:plan.entry_context.confirmation_key,confirmation_event_at:r.confirmation_event_at});m.committed_risk=D(m.committed_risk).plus(r.risk).toString();m.updated_at=now;
 s.confirmations.push(r.confirmation_id);if(s.confirmations.length>10000)s.confirmations=s.confirmations.slice(-10000);
 const active=new Set([...values(root.frequency.account.positions),...values(root.frequency.account.pendingOrders)].map(row=>row.plan.movement_id));
 const old=Object.values(s.movements).filter(x=>!active.has(x.id)&&x.id!==m.id).sort((a,b)=>b.updated_at-a.updated_at);for(const x of old.slice(1000))delete s.movements[x.id];
}
export function prepareRiskCandidates(root,decisions,{quote,meta,now,preflight}={}){
 stamp(now);const s=validateRiskBudgetState(root);if(!s?.active)return {ordered:[...decisions],receipts:[],eligible_count:0};
 const account=root.frequency.account,virtual={...root,frequency:{...root.frequency,account:{...account,positions:{...account.positions},pendingOrders:{...account.pendingOrders}}},secondaryExecution:{...root.secondaryExecution,risk_budget:structuredClone(s)}};
 const score=d=>d.plan&&positive(d.plan.entry)&&finite(d.plan.economics?.gain)?Number(d.plan.economics.gain)/Number(d.plan.entry):-Infinity;
 const ordered=[...decisions].sort((a,b)=>score(b)-score(a)||Number(b.plan?.economics?.netRR??-Infinity)-Number(a.plan?.economics?.netRR??-Infinity)||String(a.plan?.id??a.pattern).localeCompare(String(b.plan?.id??b.pattern))),receipts=[];
 for(const decision of ordered){if(!decision.plan)continue;let result;
  try{result=prepareOne(virtual,decision.plan,{quote,meta,now});}catch(error){result={accepted:false,reason:'RISK_CONTRACT_OR_STATE_INVALID'};}
  if(result.accepted&&preflight){const check=preflight(result.plan,{quote,meta,now,qty:result.receipt.qty});if(!check.accepted)result={...check,accepted:false};}
  if(!result.accepted){decision.capital_allocation_rejection=result.reason;decision.facts={...decision.facts,risk_allocation:{version:RISK_BUDGET_VERSION,accepted:false,reason:result.reason,at:now},...(result.entry_economics?{entry_economics:result.entry_economics}:{})};receipts.push(decision.facts.risk_allocation);continue;}
  decision.plan=result.plan;decision.facts={...decision.facts,risk_allocation:result.receipt};receipts.push(result.receipt);
  const r=result.receipt,virtualPlan={...result.plan,sizing:{qty:r.qty,qty_step:r.qty_step,exposure:r.exposure,initial_margin:r.initial_margin,reserved:r.reserved,funding_reserved:r.funding_reserved,risk:r.risk}};
  recordRiskSelection(virtual,result.plan,now);virtual.frequency.account.pendingOrders[result.plan.id]={plan:virtualPlan,remaining_qty:r.qty,remaining_risk:r.risk,remaining_reserved:r.reserved};
 }
 return {ordered,receipts,eligible_count:receipts.filter(r=>r.accepted).length};
}
export function revalidateRiskSelection(root,plan,quote,now){
 validateRiskContract(plan,{root,current:true});const r=plan.execution_contract.risk_budget.receipt,policy=plan.execution_contract.risk_budget.policy,context=movementAdmission(root,plan,quote,now,{expected:r});if(!context.accepted)return context;
 const s=riskPortfolioSnapshot(root,{quote,now}),eq=D(s.equity);if(s.slots>=policy.max_slots)return {accepted:false,reason:'PORTFOLIO_CAPACITY'};
 if(!s.valuation_complete)return {accepted:false,reason:'PORTFOLIO_VALUATION_UNAVAILABLE'};
 if(quantPolicy(policy)&&D(r.risk).plus(directionRisk(root,plan)).gt(min(eq.mul(policy.movement_risk_fraction),policy.movement_risk_cap_usd)))return {accepted:false,reason:'BTC_DIRECTION_RISK_EXHAUSTED'};
 if(D(r.risk).gt(min(eq.mul(policy.leg_risk_fraction),policy.leg_risk_cap_usd))||D(r.risk).plus(s.open_risk).gt(min(eq.mul(policy.portfolio_risk_fraction),policy.portfolio_risk_cap_usd))||D(r.risk).plus(context.committed_risk).gt(min(eq.mul(policy.movement_risk_fraction),policy.movement_risk_cap_usd)))return {accepted:false,reason:'SHARED_RISK_BUDGET_EXHAUSTED'};
 if(D(r.initial_margin).plus(s.margin).gt(eq.mul(policy.margin_fraction))||D(r.exposure).plus(s.gross_exposure).gt(eq.mul(policy.gross_exposure_multiple))||D(r.reserved).gt(s.free_cash))return {accepted:false,reason:'PAPER_CAPITAL_OR_EXPOSURE_INSUFFICIENT'};
 return {accepted:true,reason:'RISK_BUDGET_VALID',receipt:r};
}
export function riskFillQuantity(root,order,proposed,price,{fundingRate,quote,now}={}){
 if(!isRiskContract(order.plan))return D(proposed);const plan=order.plan,r=plan.execution_contract.risk_budget.receipt,p=plan.execution_contract.risk_budget.policy,c=plan.execution_contract,unit=riskUnitLoss(plan,{entryPrice:price,fundingRate});
 if(!marginStopSafe(plan,c.leverage,unit,price))return D(0);
 if(!secondaryFresh(quote,now)){order.risk_fill_limit={version:RISK_BUDGET_VERSION,proposed_qty:String(proposed),allowed_qty:'0',reason:'PORTFOLIO_VALUATION_UNAVAILABLE'};return D(0);}
 const s=riskPortfolioSnapshot(root,{excludePendingId:plan.id,quote,now});
 if(!s.valuation_complete){order.risk_fill_limit={version:RISK_BUDGET_VERSION,proposed_qty:String(proposed),allowed_qty:'0',reason:'PORTFOLIO_VALUATION_UNAVAILABLE'};return D(0);}
 const eq=D(s.equity),own=root.frequency.account.positions[plan.id],ownRisk=D(own?.remaining_risk??0),legAvailable=max(min(r.risk_ceiling_usd,eq.mul(p.leg_risk_fraction),p.leg_risk_cap_usd).minus(ownRisk),0),movement=root.secondaryExecution.risk_budget.movements[plan.movement_id],otherMovementRisk=max(D(movement?.committed_risk??r.risk).minus(r.risk),0),movementAvailable=max(min(r.movement_budget_usd,eq.mul(p.movement_risk_fraction),p.movement_risk_cap_usd).minus(otherMovementRisk).minus(ownRisk),0),portfolioAvailable=max(min(eq.mul(p.portfolio_risk_fraction),p.portfolio_risk_cap_usd).minus(s.open_risk),0),marginFree=max(eq.mul(p.margin_fraction).minus(s.margin),0),grossFree=max(eq.mul(p.gross_exposure_multiple).minus(s.gross_exposure),0);
 const correlatedAvailable=quantPolicy(p)?max(min(eq.mul(p.movement_risk_fraction),p.movement_risk_cap_usd).minus(directionRisk(root,plan)).minus(ownRisk),0):movementAvailable;
 const qty=round(min(proposed,legAvailable.div(unit.total),movementAvailable.div(unit.total),correlatedAvailable.div(unit.total),portfolioAvailable.div(unit.total),marginFree.mul(c.leverage).div(price),grossFree.div(price)),plan.sizing.qty_step);
 order.risk_revalidation={version:RISK_BUDGET_VERSION,at:now,quote_at:quote.event_at,quote_received_at:quote.received_at,equity:s.equity,marked_equity:s.marked_equity,valuation_basis:s.valuation_basis,allowed_qty:qty.toString(),unit_risk:unit.total,leg_risk_available:legAvailable.toString(),movement_risk_available:movementAvailable.toString(),portfolio_risk_available:portfolioAvailable.toString()};
 if(qty.lt(proposed))order.risk_fill_limit={version:RISK_BUDGET_VERSION,proposed_qty:String(proposed),allowed_qty:qty.toString(),unit_risk:unit.total,reason:'POST_LATENCY_RISK_REVALIDATION'};
 const remaining=D(order.remaining_qty).minus(qty);if(ownRisk.plus(D(unit.total).mul(qty)).plus(D(r.unit_risk).mul(remaining)).gt(r.risk_ceiling_usd))order.cancel_unfunded_remainder=true;
 return qty;
}
export function marginSurrogate(position,quote,now){
 if(!isRiskContract(position.plan)||!secondaryFresh(quote,now))return null;
 const c=position.plan.execution_contract,policy=c.risk_budget.policy,v=secondaryEstimate(position,quote,now);if(!v)return null;
 const adverse=D(quote[v.side]),exposure=adverse.mul(position.qty),equity=D(position.initial_margin).plus(v.gross).minus(v.funding),maintenance=exposure.mul(policy.maintenance_margin_fraction),closeReserve=D(v.exit_fee),threshold=maintenance.plus(closeReserve),trigger=equity.lte(threshold);
 return {version:MARGIN_SURROGATE_VERSION,at:now,quote_at:quote.event_at,model:'ISOLATED_ADVERSE_BBO_SURROGATE_NOT_KRAKEN_LIQUIDATION',mark_basis:policy.margin_mark_basis,position_equity:equity.toString(),maintenance_margin:maintenance.toString(),closing_fee_reserve:closeReserve.toString(),threshold:threshold.toString(),triggered:trigger,funding_complete:v.funding_complete,unresolved_funding_policy:'KNOWN_FUNDING_ONLY_RECORDED_UNCERTAINTY',reason:trigger?'ISOLATED_MARGIN_STRESS':null,negative_balances:'RECORDED_NOT_CAPPED',realTrading:false};
}
export function riskBudgetView(root){const s=validateRiskBudgetState(root);if(!s)return null;const activeIds=new Set([...values(root.frequency.account.positions),...values(root.frequency.account.pendingOrders)].map(r=>r.plan.movement_id));return {version:s.version,active:s.active,policy_hash:s.policy_hash,policy:structuredClone(s.policy),portfolio:riskPortfolioSnapshot(root),movements:values(s.movements).filter(m=>activeIds.has(m.id)).map(m=>structuredClone(m)),last_batch:s.last_batch??null};}

export const installSecondaryRiskBudget=installRiskBudget;
