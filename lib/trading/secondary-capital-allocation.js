// Additive allocation for the existing secondary PAPER ledger. No orders/network.
// The exploration/execution/profit protocols and outstanding contracts stay intact.
import {D,hash} from './core.js';
import {isExploration,getExplorationPolicy} from './secondary-exploration.js';
import {secondaryFresh,secondaryEstimate} from './secondary-futures-math.js';

export const CAPITAL_ALLOCATION_VERSION='secondary-capital-allocation-1.0.0';
export const CAPITAL_ALLOCATION_CONTRACT_VERSION='secondary-capital-allocation-contract-1.0.0';
export const CAPITAL_TOPUP_REASON='USER_REQUESTED_CAPITAL_TARGET';
export const CAPITAL_ALLOCATION_POLICY=Object.freeze({
 version:CAPITAL_ALLOCATION_VERSION,mode:'PAPER',realTrading:false,symbol:'PF_XBTUSD',ledger:'FREQUENT_PAPER',
 baseNominalUSD:'300',preferredMultiplier:'1.5',leverage:2,fundingMode:'FINITE_EXISTING_CAPITAL',automaticPaperTopups:false,
 ranking:['EXPECTED_NET_TARGET_FRACTION','NET_RR','STABLE_SIGNAL_ID'],preferredRequires:'STRICTLY_BETTER_AMONG_TWO_OR_MORE_ELIGIBLE',
 sizeAfterLoss:'UNCHANGED',minimumSize:'FULL_ROUNDED_BASE_QUANTITY',positionCountTarget:null,
 parameterStatus:'EXPERIMENTAL_NOT_STATISTICALLY_VALIDATED',existingContracts:'PRESERVED',
});
const values=o=>Object.values(o??{}),finite=x=>x!==null&&x!==undefined&&Number.isFinite(Number(x));
const positive=x=>finite(x)&&D(x).gt(0),nonnegative=x=>finite(x)&&D(x).gte(0);
const min=(a,b)=>D(a).lte(b)?D(a):D(b),max=(a,b)=>D(a).gte(b)?D(a):D(b);
const decimal=(value,error)=>{const raw=String(value).trim();if(!/^(?:\d+\.?\d*|\.\d+)$/.test(raw)||!positive(raw))throw Error(error);return D(raw).toString();};
const timestamp=now=>{if(!Number.isSafeInteger(now)||now<0)throw Error('SECONDARY_CAPITAL_ALLOCATION_TIMESTAMP_INVALID');};

export function validateCapitalAllocationPolicy(policy){
 if(policy?.version!==CAPITAL_ALLOCATION_VERSION||policy.mode!=='PAPER'||policy.realTrading!==false||policy.symbol!=='PF_XBTUSD'||policy.ledger!=='FREQUENT_PAPER')throw Error('SECONDARY_CAPITAL_ALLOCATION_PAPER_ONLY');
 if(!positive(policy.baseNominalUSD)||!positive(policy.preferredMultiplier)||D(policy.preferredMultiplier).lt(1)||D(policy.preferredMultiplier).gt(2)||policy.leverage!==2)throw Error('SECONDARY_CAPITAL_ALLOCATION_PARAMETERS_INVALID');
 for(const key of ['fundingMode','automaticPaperTopups','preferredRequires','sizeAfterLoss','minimumSize','positionCountTarget','parameterStatus','existingContracts'])if(policy[key]!==CAPITAL_ALLOCATION_POLICY[key])throw Error('SECONDARY_CAPITAL_ALLOCATION_POLICY_INVALID');
 if(hash(policy.ranking)!==hash(CAPITAL_ALLOCATION_POLICY.ranking))throw Error('SECONDARY_CAPITAL_ALLOCATION_POLICY_INVALID');
 return policy;
}
function checkedState(root){
 const state=root?.secondaryExecution?.capital_allocation;if(!state)return null;
 validateCapitalAllocationPolicy(state.policy);
 if(state.version!==CAPITAL_ALLOCATION_VERSION||state.policy_hash!==hash(state.policy)||!Array.isArray(state.history))throw Error('SECONDARY_CAPITAL_ALLOCATION_INTEGRITY');
 for(const request of [...(state.funding_history??[]),...(state.funding_request?[state.funding_request]:[])]){
  if(request.mode!=='PAPER'||request.realTrading!==false||!positive(request.target_equity)||typeof request.request_id!=='string'||request.id!==hash([CAPITAL_ALLOCATION_VERSION,'USER_REQUESTED_EQUITY_TARGET',request.request_id])||!['PENDING','WAITING_MARKET_DATA','APPLIED'].includes(request.status))throw Error('SECONDARY_CAPITAL_REQUEST_INTEGRITY');
  if(request.status==='APPLIED'){
   const receipt=request.receipt;
   if(!receipt||receipt.id!==request.id||receipt.target_equity!==request.target_equity||!nonnegative(receipt.amount)||![receipt.balance_before,receipt.balance_after,receipt.equity_before,receipt.equity_after].every(finite)||!D(receipt.balance_after).minus(receipt.balance_before).eq(receipt.amount)||!D(receipt.equity_after).minus(receipt.equity_before).eq(receipt.amount))throw Error('SECONDARY_CAPITAL_RECEIPT_INTEGRITY');
  }
 }
 return state;
}
export const getCapitalAllocationPolicy=root=>{const s=checkedState(root);return s?.active?s.policy:null;};
// OFF disables preference, never silently restores unlimited fictional deposits.
export const hasFiniteCapitalAllocation=root=>Boolean(checkedState(root));
export const getAllocationContract=plan=>plan?.execution_contract?.capital_allocation??null;
export function capitalAllocationView(root){
 const state=checkedState(root);if(!state)return null;
 const request=state.funding_request,base=state.active?state.policy.baseNominalUSD:getExplorationPolicy(root)?.nominalUSD??'100';
 return {version:state.version,active:state.active,finite_capital:true,policy_hash:state.policy_hash,policy:structuredClone(state.policy),base_nominal_usd:base,
  preferred_nominal_usd:state.active?D(state.policy.baseNominalUSD).mul(state.policy.preferredMultiplier).toString():base,
  target_equity:request?.target_equity??null,available_cash:capitalAllocationFreeCash(root.frequency.account),automatic_topups:false,
  funding_request:request?{status:request.status,reason:request.reason??null,request_id:request.request_id,target_equity:request.target_equity,applied_at:request.applied_at??null,receipt:request.receipt?structuredClone(request.receipt):null}:null,
  last_batch:state.last_batch?structuredClone(state.last_batch):null};
}

export function installCapitalAllocation(root,env,now,event=()=>{}){
 timestamp(now);const x=root?.secondaryExecution;if(!x)throw Error('SECONDARY_EXECUTION_REQUIRED');
 const current=checkedState(root),requested=env.LUMI_TRADING_SECONDARY_CAPITAL_ALLOCATION;
 if(!requested){if(current?.active)throw Error('SECONDARY_CAPITAL_ALLOCATION_FLAG_REQUIRED');return false;}
 if(env.LUMI_TRADING_MODE!=='PAPER'||env.LUMI_RUNTIME_ENV!=='staging'||env.LUMI_TRADING_STORAGE!=='SQLITE')throw Error('SECONDARY_CAPITAL_ALLOCATION_PAPER_ONLY');
 if(requested==='OFF'){
  if(!current?.active)return false;current.active=false;current.disabled_at=now;
  current.history.push({at:now,action:'DISABLED',policy_hash:current.policy_hash,finite_capital_preserved:true});
  event({type:'SECONDARY_CAPITAL_ALLOCATION_DISABLED',at:now,version:CAPITAL_ALLOCATION_VERSION,finite_capital_preserved:true,existing_contracts_preserved:true,ledger:'FREQUENT_PAPER',realTrading:false});return true;
 }
 if(requested!==CAPITAL_ALLOCATION_VERSION)throw Error('SECONDARY_CAPITAL_ALLOCATION_VERSION_UNSUPPORTED');
 if(!isExploration(root))throw Error('SECONDARY_CAPITAL_ALLOCATION_REQUIRES_EXPLORATION');
 const policy=structuredClone(CAPITAL_ALLOCATION_POLICY);
 if(env.LUMI_TRADING_SECONDARY_ALLOCATION_BASE_USD!==undefined)policy.baseNominalUSD=decimal(env.LUMI_TRADING_SECONDARY_ALLOCATION_BASE_USD,'SECONDARY_CAPITAL_ALLOCATION_PARAMETERS_INVALID');
 if(env.LUMI_TRADING_SECONDARY_PREFERRED_MULTIPLIER!==undefined)policy.preferredMultiplier=decimal(env.LUMI_TRADING_SECONDARY_PREFERRED_MULTIPLIER,'SECONDARY_CAPITAL_ALLOCATION_PARAMETERS_INVALID');
 validateCapitalAllocationPolicy(policy);
 const target=decimal(env.LUMI_TRADING_SECONDARY_TARGET_EQUITY_USD??'1000','SECONDARY_CAPITAL_TARGET_INVALID');
 const requestId=String(env.LUMI_TRADING_SECONDARY_CAPITAL_REQUEST_ID??'user-capital-20261102-1000');
 if(!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(requestId))throw Error('SECONDARY_CAPITAL_REQUEST_INVALID');
 const id=hash([CAPITAL_ALLOCATION_VERSION,'USER_REQUESTED_EQUITY_TARGET',requestId]),fingerprint=hash(policy);
 const priorRequests=[...(current?.funding_history??[]),...(current?.funding_request?[current.funding_request]:[])];
 const prior=priorRequests.find(request=>request.id===id);
 if(prior&&prior.target_equity!==target)throw Error('SECONDARY_CAPITAL_REQUEST_CONFLICT');
 if(current?.active&&current.policy_hash===fingerprint&&current.funding_request?.id===id)return false;
 const a=root.frequency.account,previous=current?{active:current.active,policy_hash:current.policy_hash,policy:structuredClone(current.policy)}:null;
 const request=prior?structuredClone(prior):{id,request_id:requestId,target_equity:target,status:'PENDING',requested_at:now,mode:'PAPER',realTrading:false};
 x.capital_allocation={...(current??{}),version:CAPITAL_ALLOCATION_VERSION,active:true,policy,policy_hash:fingerprint,
  activated_at:current?.activated_at??now,updated_at:now,
  baseline:current?.baseline??{at:now,cash:a.cash,equity:a.equity,net:a.net,fees:a.fees,closed:a.closed,peak:a.peak,maxDrawdown:a.maxDrawdown},
  funding_request:request,funding_history:priorRequests.filter(item=>item.id!==id),
  history:[...(current?.history??[]),{at:now,action:current?'POLICY_ACTIVATED':'MIGRATED',previous,policy_hash:fingerprint,funding_request_id:id}]};
 event({type:'SECONDARY_CAPITAL_ALLOCATION_ENABLED',at:now,version:CAPITAL_ALLOCATION_VERSION,policy_hash:fingerprint,base_nominal_usd:policy.baseNominalUSD,preferred_multiplier:policy.preferredMultiplier,target_equity:target,funding_request_id:id,automatic_topups:false,existing_contracts_preserved:true,ledger:'FREQUENT_PAPER',realTrading:false});return true;
}

// Caller supplies the existing broker's durable topup method; this module never
// creates a second ledger or writer. The worker commits receipt and cash together.
export function applyCapitalAllocationFunding(root,now,topup,{quote}={}){
 timestamp(now);const state=checkedState(root),request=state?.funding_request;
 if(!state?.active||!request||request.status==='APPLIED')return null;
 if(request.mode!=='PAPER'||request.realTrading!==false||!positive(request.target_equity)||typeof topup!=='function')throw Error('SECONDARY_CAPITAL_FUNDING_INVALID');
 const a=root.frequency.account,positions=values(a.positions);let equity=D(a.cash);
 if(!finite(a.cash)||!finite(a.equity))throw Error('SECONDARY_CAPITAL_BALANCE_INVALID');
 if(positions.length){
  const estimates=secondaryFresh(quote,now)?positions.map(position=>secondaryEstimate(position,quote,now)):[];
  if(estimates.length!==positions.length||estimates.some(v=>!v?.funding_complete||!finite(v.net))){request.status='WAITING_MARKET_DATA';request.reason='CAPITAL_TARGET_VALUATION_UNAVAILABLE';return null;}
  for(let i=0;i<positions.length;i++)equity=equity.plus(positions[i].initial_margin).plus(estimates[i].gross).minus(estimates[i].exit_fee).minus(estimates[i].funding);
  // Requiring the broker's preceding mark prevents using a stale equity baseline.
  if(!equity.eq(a.equity)){request.status='WAITING_MARKET_DATA';request.reason='CAPITAL_TARGET_REQUIRES_CURRENT_MARK';return null;}
 }else if(!equity.eq(a.equity)){request.status='WAITING_MARKET_DATA';request.reason='CAPITAL_TARGET_REQUIRES_CURRENT_MARK';return null;}
 const amount=max(D(request.target_equity).minus(equity),0),before={cash:a.cash,equity:a.equity,net:a.net,fees:a.fees,peak:a.peak,maxDrawdown:a.maxDrawdown};
 if(amount.gt(0))topup(amount.toString(),{id:request.id},CAPITAL_TOPUP_REASON,'ONE_TIME_EQUITY_TARGET',now);
 if(!D(a.cash).eq(D(before.cash).plus(amount))||!D(a.equity).eq(D(before.equity).plus(amount))||a.net!==before.net||a.fees!==before.fees||a.peak!==before.peak||a.maxDrawdown!==before.maxDrawdown)throw Error('SECONDARY_CAPITAL_CONTRIBUTION_INVARIANT');
 const receipt={request_id:request.request_id,id:request.id,at:now,target_equity:request.target_equity,amount:amount.toString(),balance_before:before.cash,balance_after:a.cash,equity_before:before.equity,equity_after:a.equity,capital_contributed_total:root.secondaryExecution.capital?.total_contributed??null,reason:amount.gt(0)?CAPITAL_TOPUP_REASON:'TARGET_ALREADY_FUNDED',mode:'PAPER',realTrading:false};
 Object.assign(request,{status:'APPLIED',applied_at:now,reason:receipt.reason,receipt});return receipt;
}

export function capitalAllocationFreeCash(account,{excludeOrderId}={}){
 if(!finite(account?.cash))throw Error('SECONDARY_CAPITAL_BALANCE_INVALID');
 const pending=values(account.pendingOrders).filter(order=>order.plan?.id!==excludeOrderId).reduce((sum,order)=>{const reserve=order.remaining_reserved??order.plan?.sizing?.reserved;if(!nonnegative(reserve))throw Error('SECONDARY_CAPITAL_RESERVATION_INVALID');return sum.plus(reserve);},D(0));
 const funding=values(account.positions).reduce((sum,position)=>{const reserve=position.funding_reserved??position.plan?.sizing?.funding_reserved??'0';if(!nonnegative(reserve))throw Error('SECONDARY_CAPITAL_RESERVATION_INVALID');return sum.plus(reserve);},D(0));
 return max(D(account.cash).minus(pending).minus(funding),0).toString();
}
export function capitalUnitReserve(plan,entry=plan?.entry){
 const contract=plan?.execution_contract,fee=contract?.mode==='TAKER_IOC'?contract.takerFee:contract?.makerFee;
 if(!positive(entry)||contract?.leverage!==2||!nonnegative(fee)||!nonnegative(plan?.economics?.fundingAllowance))throw Error('SECONDARY_CAPITAL_SIZE_INVALID');
 return D(entry).div(contract.leverage).plus(D(entry).mul(fee)).plus(plan.economics.fundingAllowance).toString();
}
function compositeHash(base,allocation){return hash({version:CAPITAL_ALLOCATION_VERSION,exploration_policy_hash:base,allocation_policy_hash:allocation});}
export function allocationContract(contract,policy,{nominalUSD=policy.baseNominalUSD,preferred=false,rank=0,eligibleCount=1,cohortId,score,at,capitalLimited=false}={}){
 validateCapitalAllocationPolicy(policy);timestamp(at);
 if(!/^[a-f0-9]{64}$/.test(contract?.policy_hash??'')||contract.realTrading!==false||contract.symbol!=='PF_XBTUSD'||contract.leverage!==2||contract.capital_allocation)throw Error('SECONDARY_CAPITAL_BASE_CONTRACT_INVALID');
 const nominal=decimal(nominalUSD,'SECONDARY_CAPITAL_SIZE_INVALID');
 if(D(nominal).gt(D(policy.baseNominalUSD).mul(policy.preferredMultiplier))||!preferred&&!D(nominal).eq(policy.baseNominalUSD))throw Error('SECONDARY_CAPITAL_SIZE_INVALID');
 const policyHash=hash(policy),allocation={version:CAPITAL_ALLOCATION_CONTRACT_VERSION,policy:structuredClone(policy),policy_hash:policyHash,base_policy_hash:contract.policy_hash,
  base_nominal_usd:policy.baseNominalUSD,nominal_usd:nominal,preferred:Boolean(preferred),rank,eligible_count:eligibleCount,cohort_id:cohortId??hash(['SINGLE',at]),score:score??null,at,capital_limited:Boolean(capitalLimited),mode:'PAPER',realTrading:false};
 allocation.hash=hash(allocation);
 return {...contract,nominalUSD:nominal,base_policy_hash:contract.policy_hash,policy_hash:compositeHash(contract.policy_hash,policyHash),capital_allocation:allocation};
}
export function validateCapitalAllocationContract(plan,{root,current=false}={}){
 const c=plan?.execution_contract,a=c?.capital_allocation;if(!a)return false;
 validateCapitalAllocationPolicy(a.policy);
 if(a.version!==CAPITAL_ALLOCATION_CONTRACT_VERSION||a.mode!=='PAPER'||a.realTrading!==false||a.hash!==hash({...a,hash:undefined})||a.policy_hash!==hash(a.policy)||c.mode!=='TAKER_IOC'&&c.mode!=='MAKER_LIMIT'||c.realTrading!==false||c.leverage!==2||c.symbol!=='PF_XBTUSD')throw Error('SECONDARY_CAPITAL_CONTRACT_INTEGRITY');
 if(!/^[a-f0-9]{64}$/.test(a.base_policy_hash??'')||c.base_policy_hash!==a.base_policy_hash||c.policy_hash!==compositeHash(a.base_policy_hash,a.policy_hash)||a.base_nominal_usd!==a.policy.baseNominalUSD||c.nominalUSD!==a.nominal_usd||!positive(c.nominalUSD)||D(c.nominalUSD).gt(D(a.policy.baseNominalUSD).mul(a.policy.preferredMultiplier))||!Number.isSafeInteger(a.at)||a.at!==plan.decision_at||!Number.isSafeInteger(a.rank)||a.rank<0||!Number.isSafeInteger(a.eligible_count)||a.eligible_count<0)throw Error('SECONDARY_CAPITAL_CONTRACT_INTEGRITY');
 if(a.preferred&&(a.eligible_count<2||a.rank!==0)||!a.preferred&&!D(c.nominalUSD).eq(a.policy.baseNominalUSD))throw Error('SECONDARY_CAPITAL_PREFERENCE_INVALID');
 if(current){const policy=getCapitalAllocationPolicy(root);if(!policy||hash(policy)!==a.policy_hash||hash(getExplorationPolicy(root))!==a.base_policy_hash)throw Error('SECONDARY_CAPITAL_CONTRACT_POLICY_MISMATCH');}
 return true;
}

// Pure ranking/virtual reservation before neural capture and actual broker.choose.
// It preserves decision identity and never changes a signed or selected plan.
export function allocateCapitalCandidates(root,decisions,{quote,meta,now,preflight}={}){
 const policy=getCapitalAllocationPolicy(root);if(!policy)return {ordered:[...decisions],eligible_count:0,preferred_id:null,receipts:[]};
 timestamp(now);if(typeof preflight!=='function'||!positive(meta?.qty_step))throw Error('SECONDARY_CAPITAL_PREFLIGHT_REQUIRED');
 const cohort=hash([CAPITAL_ALLOCATION_VERSION,now,decisions.filter(d=>d.plan).map(d=>d.plan.id).sort()]),eligible=[],rejected=[],receipts=[];
 const baseQty=plan=>D(policy.baseNominalUSD).div(plan.entry).div(meta.qty_step).floor().mul(meta.qty_step);
 for(const decision of decisions){
  if(!decision.plan){rejected.push(decision);continue;}
  const original=decision.plan;if(original.hash||original.sizing||getAllocationContract(original))throw Error('SECONDARY_CAPITAL_UNSIGNED_SIGNAL_REQUIRED');
  const plan={...original,execution_contract:allocationContract(original.execution_contract,policy,{at:now,cohortId:cohort})};
  decision.plan=plan;
  let check,quantity;
  try{quantity=baseQty(plan);check=quantity.gte(meta.qty_step)?preflight(plan,{qty:quantity.toString(),quote,meta,now}):{accepted:false,reason:'SIZE_BELOW_MINIMUM'};}catch{check={accepted:false,reason:'CAPITAL_PREFLIGHT_INVALID'};}
  const fraction=check?.entry_economics?.expected_net_target_fraction??(positive(plan.entry)&&finite(plan.economics?.gain)?D(plan.economics.gain).div(plan.entry).toString():null),rr=check?.entry_economics?.net_rr??plan.economics?.netRR;
  if(check?.accepted!==true||!finite(fraction)||!finite(rr)){
   const reason=check?.reason??'CAPITAL_PREFLIGHT_INVALID',receipt={version:CAPITAL_ALLOCATION_VERSION,cohort_id:cohort,eligible:false,reason,base_nominal_usd:policy.baseNominalUSD,at:now};
   decision.capital_allocation_rejection=reason;decision.facts={...decision.facts,...(check?.entry_economics?{entry_economics:check.entry_economics}:{}),...(check?.context_admission?{context_admission:check.context_admission}:{}),capital_allocation:receipt};receipts.push(receipt);rejected.push(decision);continue;
  }
  eligible.push({decision,original,plan,qty:quantity,fraction:D(fraction),rr:D(rr),check});
 }
 const compare=(a,b)=>b.fraction.cmp(a.fraction)||b.rr.cmp(a.rr)||String(a.plan.id).localeCompare(String(b.plan.id));eligible.sort(compare);
 const preferred=eligible.length>=2&&(eligible[0].fraction.gt(eligible[1].fraction)||eligible[0].fraction.eq(eligible[1].fraction)&&eligible[0].rr.gt(eligible[1].rr))?eligible[0]:null;
 let free=D(capitalAllocationFreeCash(root.frequency.account));
 for(let rank=0;rank<eligible.length;rank++){
  const item=eligible[rank],unit=D(capitalUnitReserve(item.plan)),nominal=preferred===item?D(policy.baseNominalUSD).mul(policy.preferredMultiplier):D(policy.baseNominalUSD),desired=nominal.div(item.plan.entry).div(meta.qty_step).floor().mul(meta.qty_step),affordable=free.div(unit).div(meta.qty_step).floor().mul(meta.qty_step),qty=min(desired,affordable),accepted=qty.gte(item.qty)&&qty.gte(meta.qty_step);
  const limited=qty.lt(desired),chosenNominal=accepted&&limited?qty.mul(item.plan.entry):nominal;
  item.decision.plan={...item.original,execution_contract:allocationContract(item.original.execution_contract,policy,{nominalUSD:chosenNominal.toString(),preferred:preferred===item,rank,eligibleCount:eligible.length,cohortId:cohort,score:{expected_net_target_fraction:item.fraction.toString(),net_rr:item.rr.toString()},at:now,capitalLimited:limited})};
  const reserve=accepted?qty.mul(unit):D(0),receipt={version:CAPITAL_ALLOCATION_VERSION,policy_hash:hash(policy),cohort_id:cohort,at:now,eligible:true,accepted,rank,eligible_count:eligible.length,preferred:preferred===item,base_nominal_usd:policy.baseNominalUSD,requested_nominal_usd:nominal.toString(),allocated_nominal_usd:accepted?chosenNominal.toString():'0',qty:accepted?qty.toString():'0',available_cash_before:free.toString(),reserved:reserve.toString(),available_cash_after:free.minus(reserve).toString(),capital_limited:limited,reason:accepted?(preferred===item?'PREFERRED_VALID_CANDIDATE':'BASE_VALID_CANDIDATE'):'PAPER_CAPITAL_INSUFFICIENT',expected_net_target_fraction:item.fraction.toString(),net_rr:item.rr.toString()};
  // Rank uses normalized returns, while the recorded monetary estimates must use
  // the final preferred/affordable quantity captured before actual admission.
  let finalCheck=item.check;
  if(accepted&&!qty.eq(item.qty))try{finalCheck=preflight(item.decision.plan,{qty:qty.toString(),quote,meta,now});}catch{finalCheck={accepted:false,reason:'CAPITAL_PREFLIGHT_INVALID'};}
  if(accepted&&finalCheck?.accepted!==true){
   receipt.accepted=false;receipt.reason=finalCheck?.reason??'CAPITAL_PREFLIGHT_INVALID';receipt.qty='0';receipt.allocated_nominal_usd='0';receipt.reserved='0';receipt.available_cash_after=free.toString();
  }
  item.decision.facts={...item.decision.facts,entry_economics:finalCheck?.entry_economics,...(finalCheck?.context_admission?{context_admission:finalCheck.context_admission}:{}),capital_allocation:receipt};
  if(!receipt.accepted)item.decision.capital_allocation_rejection=receipt.reason;
  free=D(receipt.available_cash_after);receipts.push(receipt);
 }
 return {ordered:[...eligible.map(item=>item.decision),...rejected],eligible_count:eligible.length,preferred_id:preferred?.plan.id??null,receipts};
}
