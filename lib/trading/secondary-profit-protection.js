// Per-position PAPER profit protection. No portfolio decisions, I/O or order sends.
// The broker owns durable exit intents and executes their remaining quantity.
import {D,hash} from './core.js';
import {secondaryFresh} from './secondary-futures-math.js';
import {validateProfitContracts,isEarlyProfitContract} from './secondary-profit-policy.js';

const STATES=new Set(['OPEN_BEFORE_TARGET','TRAILING_ACTIVE','EXIT_PENDING','PARTIALLY_CLOSED','CLOSED']);
const fail=()=>{throw Error('SECONDARY_PROFIT_PROTECTION_STATE_INTEGRITY');};
const finite=x=>{try{return x!==null&&x!==undefined&&typeof x!=='boolean'&&String(x).trim()!==''&&Number.isFinite(Number(x))&&D(x).isFinite();}catch{return false;}};
const positive=x=>finite(x)&&D(x).gt(0);
const timestamp=x=>Number.isSafeInteger(x)&&x>=0;
const near=(a,b)=>finite(a)&&finite(b)&&D(a).minus(b).abs().lte(D(b).abs().mul('1e-15').plus('1e-16'));
const max=(a,b)=>D(a).gte(b)?D(a):D(b);
const active=s=>s.trailing_activated_at!==null;
const policy=p=>validateProfitContracts(p?.plan)?p.plan.exit_policy:null;
const early=p=>isEarlyProfitContract(p.plan.exit_policy);
// An execution buffer is uncertainty beyond the costs already inside broker N(t).
// It is not charged again to cash or the liquidation estimate.
const uncertainty=(p,q=null)=>max(D(p.entry).mul(p.plan.exit_policy.execution_uncertainty_fraction),q?D(q.ask).minus(q.bid).div(2):0);
const minimum=(p,quantity=p.qty)=>{
 if(!early(p))return D(p.entry).mul(quantity).mul(p.plan.exit_policy.min_activation_net_fraction).toString();
 const c=p.plan.exit_policy,s=p.profit_protection,minFloor=D(s?.min_protected_net_per_unit??D(c.min_protected_net_usd).div(quantity)),buffer=D(s?.execution_uncertainty_per_unit??uncertainty(p));
 return max(minFloor.div(D(1).minus(c.retracement_fraction)),minFloor.plus(buffer)).mul(quantity).toString();
};
const allowance=(p,peakUnit,q)=>early(p)?max(D(peakUnit).mul(p.plan.exit_policy.retracement_fraction),uncertainty(p,q)):D(peakUnit).mul(p.plan.exit_policy.retracement_fraction);
const deadlineReason=p=>early(p)?'POSITIVE_NET_PROTECTION_EXTENSION':'TARGET_REACHED_TRAILING_EXTENSION';
const totals=s=>{
 if(!active(s))return;
 for(const name of ['activation_net','peak_net','protected_net','retracement_allowance'])s[name]=D(s[name+'_per_unit']).mul(s.basis_qty).toString();
};
const event=(p,type,at,detail={})=>({type,id:p.plan.id,at,ledger:'FREQUENT_PAPER',realTrading:false,exit_policy_version:p.plan.exit_policy.version,...detail});
const valuationValid=v=>v&&['net','gross','entry_cost','exit_fee','funding','costs','slippage_cost'].every(key=>finite(v[key]))&&['entry_cost','exit_fee','slippage_cost'].every(key=>D(v[key]).gte(0))&&positive(v.price);
function captureEvidence(p,q,v,at,availableQty){
 const evidence={version:'secondary-net-trailing-evidence-1.0.0',at,quote:structuredClone(q),quote_hash:hash(q),available_qty:String(availableQty),
  valuation:{net:String(v.net),quantity:String(p.qty),entry:String(p.entry),price:String(v.price),side:v.side,gross:String(v.gross),entry_cost:String(v.entry_cost),exit_fee:String(v.exit_fee),funding:String(v.funding),costs:String(v.costs),slippage_cost:String(v.slippage_cost),funding_complete:v.funding_complete===true,result_final:v.result_final!==false,model:v.model??null,data_quality:v.data_quality??p.quality??'OBSERVED'},
  capacity_basis:'OBSERVED_SHARED_REMAINING_BBO',quantity_basis:'BTC_AT_OBSERVATION',mode:'PAPER',realTrading:false};
 evidence.hash=hash(evidence);return evidence;
}
function validateEvidence(e,p){
 if(!e||e.version!=='secondary-net-trailing-evidence-1.0.0'||e.mode!=='PAPER'||e.realTrading!==false||!timestamp(e.at)||!e.quote||e.quote_hash!==hash(e.quote)||e.hash!==hash({...e,hash:undefined})||e.capacity_basis!=='OBSERVED_SHARED_REMAINING_BBO'||e.quantity_basis!=='BTC_AT_OBSERVATION')fail();
 const q=e.quote,v=e.valuation;
 if(!secondaryFresh(q,e.at)||q.post_only===true||q.event_at<p.entered_at||q.received_at<p.entered_at||q.event_at>q.received_at+1000||!valuationValid(v)||v.funding_complete!==true||v.result_final!==true||!positive(v.quantity)||!positive(v.entry)||!D(v.entry).eq(p.entry)||!finite(e.available_qty)||D(e.available_qty).lt(v.quantity)||v.side!==(p.plan.direction==='LONG'?'bid':'ask'))fail();
 return e;
}

function validateState(p,{allowQuantityTransition=false,allowIntentTransition=false}={}){
 const c=policy(p);if(!c)return false;
 const s=p.profit_protection;if(!s)throw Error('SECONDARY_PROFIT_PROTECTION_STATE_MISSING');
 if(s.schema!==(early(p)?2:1)||s.exit_policy_version!==c.version||s.contract_hash!==c.hash||s.policy_hash!==c.policy_hash||s.quantity_basis!==c.quantity_basis||!STATES.has(s.state))fail();
 if(!positive(p.qty)||!positive(p.entry)||!positive(s.basis_qty)||!timestamp(p.entered_at)||!timestamp(p.expires_at)||p.expires_at!==p.entered_at+c.base_holding_ms||s.base_expires_at!==p.expires_at||!timestamp(s.effective_expires_at))fail();
 if(!allowQuantityTransition&&!D(s.basis_qty).eq(p.qty))fail();
 if(!finite(s.remaining_qty)||D(s.remaining_qty).lt(0)||(s.state==='CLOSED'?!D(s.remaining_qty).eq(0):!D(s.remaining_qty).eq(s.basis_qty)))fail();
 if(!positive(s.required_activation_net)||!timestamp(s.initialized_at)||s.initialized_at<p.entered_at)fail();
 if(early(p)){
  if(!positive(s.min_protected_net_per_unit)||!positive(s.min_protected_basis_qty)||!near(D(s.min_protected_net_per_unit).mul(s.min_protected_basis_qty),c.min_protected_net_usd)||!positive(s.execution_uncertainty_per_unit)||!allowQuantityTransition&&D(s.execution_uncertainty_per_unit).lt(D(p.entry).mul(c.execution_uncertainty_fraction)))fail();
  if(!allowQuantityTransition&&D(s.min_protected_basis_qty).lt(p.qty))fail();
  if(s.uncertainty_basis!==c.uncertainty_basis||s.activation_target_required!==false)fail();
  if(active(s)&&!D(s.min_protected_basis_qty).eq(s.activation_qty))fail();
  if(!active(s)&&(s.floor_evidence!==null||s.floor_at!==null))fail();
 }
 if(!allowQuantityTransition&&!near(s.required_activation_net,minimum(p)))fail();
 for(const key of ['last_valid_quote_at','last_valid_received_at','last_evaluated_at','target_net_insufficient_at'])if(s[key]!==null&&!timestamp(s[key]))fail();
 if(s.last_valid_received_at!==null&&(s.last_evaluated_at===null||s.last_valid_received_at>s.last_evaluated_at))fail();
 if(s.last_valid_quote_at!==null&&(s.last_evaluated_at===null||s.last_valid_quote_at>s.last_evaluated_at+1000))fail();
 if(s.last_net===null){if(s.last_net_per_unit!==null||s.last_net_funding_complete!==null)fail();}
 else if(!finite(s.last_net)||!finite(s.last_net_per_unit)||typeof s.last_net_funding_complete!=='boolean'||!near(s.last_net,D(s.last_net_per_unit).mul(s.basis_qty)))fail();
 if(s.current_retracement!==null&&(!finite(s.current_retracement)||D(s.current_retracement).lt(0)))fail();
 if(s.target_net_insufficient_at!==null&&(!s.target_net_insufficient||s.target_net_insufficient.at!==s.target_net_insufficient_at))fail();
 if(!active(s)){
  if(s.state==='TRAILING_ACTIVE'||s.effective_expires_at!==s.base_expires_at||s.deadline_reason!=='BASE_HOLDING_LIMIT'||s.stagnation_deadline_at!==null)fail();
  for(const key of ['activation_net','activation_net_original','activation_qty','activation_net_per_unit','peak_net','peak_net_per_unit','peak_at','peak_quote_at','peak_received_at','protected_net','protected_net_per_unit','retracement_allowance','retracement_allowance_per_unit','activation_evidence','peak_evidence'])if(s[key]!==null)fail();
 }else{
  if(!timestamp(s.trailing_activated_at)||s.trailing_activated_at<p.entered_at||s.trailing_activated_at>s.base_expires_at||!timestamp(s.peak_at)||s.peak_at<s.trailing_activated_at||!timestamp(s.peak_quote_at)||!timestamp(s.peak_received_at))fail();
  if(s.state==='OPEN_BEFORE_TARGET'||s.effective_expires_at!==s.base_expires_at+c.trailing_extension_ms||s.deadline_reason!==deadlineReason(p)||s.stagnation_deadline_at!==s.peak_at+c.stagnation_ms)fail();
  for(const key of ['activation_net','activation_net_original','activation_qty','activation_net_per_unit','peak_net','peak_net_per_unit','protected_net','protected_net_per_unit','retracement_allowance','retracement_allowance_per_unit'])if(!positive(s[key]))fail();
  if(D(s.peak_net_per_unit).lt(s.activation_net_per_unit)||D(s.protected_net_per_unit).gt(s.peak_net_per_unit)||!near(s.retracement_allowance_per_unit,allowance(p,s.peak_net_per_unit,s.peak_evidence?.quote)))fail();
  if(D(s.protected_net_per_unit).lt(D(s.peak_net_per_unit).minus(s.retracement_allowance_per_unit).minus('1e-16')))fail();
  if(early(p)&&D(s.protected_net_per_unit).plus('1e-16').lt(s.min_protected_net_per_unit))fail();
  for(const key of ['activation_net','peak_net','protected_net','retracement_allowance'])if(!near(s[key],D(s[key+'_per_unit']).mul(s.basis_qty)))fail();
  if(!near(s.activation_net_original,D(s.activation_net_per_unit).mul(s.activation_qty))||s.last_valid_quote_at<s.peak_quote_at||s.last_valid_received_at<s.peak_received_at)fail();
  const activation=validateEvidence(s.activation_evidence,p),peak=validateEvidence(s.peak_evidence,p);
  if(early(p)){
   const floorEvidence=validateEvidence(s.floor_evidence,p),floorUnit=D(floorEvidence.valuation.net).div(floorEvidence.valuation.quantity),floorAllowance=allowance(p,floorUnit,floorEvidence.quote);
   if(s.floor_at!==floorEvidence.at||s.floor_at<s.trailing_activated_at||s.floor_at>s.peak_at||!near(s.protected_net_per_unit,floorUnit.minus(floorAllowance)))fail();
  }
  if(activation.at!==s.trailing_activated_at||!D(activation.valuation.quantity).eq(s.activation_qty)||!near(activation.valuation.net,s.activation_net_original)||peak.at!==s.peak_at||peak.quote.event_at!==s.peak_quote_at||peak.quote.received_at!==s.peak_received_at||!near(D(peak.valuation.net).div(peak.valuation.quantity),s.peak_net_per_unit))fail();
 }
 if(s.state==='CLOSED'&&(!timestamp(s.closed_at)||s.closed_at<p.entered_at))fail();
 if(!allowIntentTransition){
  if(p.exit_intent){
   if(!['EXIT_PENDING','PARTIALLY_CLOSED','CLOSED'].includes(s.state)||s.exit_reason!==p.exit_intent.reason||s.exit_intent_at!==p.exit_intent.decided_at||s.exit_intent_not_before!==p.exit_intent.not_before||!s.exit_intent||hash(s.exit_intent)!==hash(p.exit_intent))fail();
  }else if(['EXIT_PENDING','PARTIALLY_CLOSED'].includes(s.state)&&!String(s.exit_reason??'').startsWith('MANUAL_'))fail();
 }
 return true;
}

// Used on resume. Never reconstruct a missing state or reset a persisted maximum.
export function validateProfitProtection(p){return validateState(p);}

// Call after the first fill, and after further entry fills before activation.
export function initializeProfitProtection(p,now){
 const c=policy(p);if(!c)return null;
 if(p.profit_protection){
  const s=p.profit_protection;
  if(!active(s)&&s.state==='OPEN_BEFORE_TARGET'&&positive(p.qty)&&D(p.qty).gt(s.basis_qty)){
   validateState(p,{allowQuantityTransition:true});s.basis_qty=String(p.qty);s.remaining_qty=String(p.qty);
   if(early(p)){s.min_protected_basis_qty=String(p.qty);s.min_protected_net_per_unit=D(c.min_protected_net_usd).div(p.qty).toString();s.execution_uncertainty_per_unit=uncertainty(p).toString();}
   s.required_activation_net=minimum(p);s.last_quantity_change_at=now;
   // A further entry changes average cost and quantity. Keep quote chronology,
   // but do not display the old liquidation estimate as the new exposure's net.
   s.last_net=null;s.last_net_per_unit=null;s.last_net_funding_complete=null;s.current_retracement=null;
  }
  validateState(p);return s;
 }
 if(!positive(p.qty)||!positive(p.entry)||!timestamp(now)||now<p.entered_at||!timestamp(p.expires_at)||p.expires_at!==p.entered_at+c.base_holding_ms)fail();
 p.profit_protection={schema:early(p)?2:1,state:'OPEN_BEFORE_TARGET',exit_policy_version:c.version,contract_hash:c.hash,policy_hash:c.policy_hash,quantity_basis:c.quantity_basis,
  initialized_at:now,basis_qty:String(p.qty),remaining_qty:String(p.qty),required_activation_net:minimum(p),
  base_expires_at:p.expires_at,effective_expires_at:p.expires_at,deadline_reason:'BASE_HOLDING_LIMIT',stagnation_deadline_at:null,
  trailing_activated_at:null,activation_net:null,activation_net_original:null,activation_qty:null,activation_net_per_unit:null,
  peak_net:null,peak_net_per_unit:null,peak_at:null,peak_quote_at:null,peak_received_at:null,activation_evidence:null,peak_evidence:null,
  protected_net:null,protected_net_per_unit:null,retracement_allowance:null,retracement_allowance_per_unit:null,
  last_valid_quote_at:null,last_valid_received_at:null,last_evaluated_at:null,last_net:null,last_net_per_unit:null,last_net_funding_complete:null,current_retracement:null,
  activation_blocker:null,target_net_insufficient_at:null,target_net_insufficient:null,
  exit_reason:null,exit_intent_at:null,exit_intent_not_before:null,exit_intent:null};
 if(early(p))Object.assign(p.profit_protection,{min_protected_basis_qty:String(p.qty),min_protected_net_per_unit:D(c.min_protected_net_usd).div(p.qty).toString(),execution_uncertainty_per_unit:uncertainty(p).toString(),uncertainty_basis:c.uncertainty_basis,activation_target_required:false,floor_evidence:null,floor_at:null});
 validateState(p);return p.profit_protection;
}

function markIssue(p,q,v,now,reason,availableQty,events){
 const s=p.profit_protection;s.activation_blocker=reason;
 if(s.target_net_insufficient_at!==null)return;
 const issue={at:now,quote_at:q.event_at,reason,net:v.funding_complete===true?v.net:null,estimated_net:v.net,required_net:s.required_activation_net,available_qty:String(availableQty),required_qty:String(p.qty),quote_hash:hash(q)};
 s.target_net_insufficient_at=now;s.target_net_insufficient=issue;
 events.push(event(p,early(p)?'PROFIT_PROTECTION_NOT_EXECUTABLE':'TARGET_REACHED_NET_INSUFFICIENT',now,{...issue,management_action:p.plan.exit_policy.target_net_insufficient_action,base_expires_at:s.base_expires_at,profit_protection:structuredClone(s)}));
}

// The supplied valuation is the broker's net liquidation estimate for p.qty.
// New peaks require full shared BBO capacity; a triggered exit may fill in parts.
export function evaluateProfitProtection(p,q,v,now,{availableQty='0'}={}){
 if(!policy(p))return {events:[],reason:null,blocker:null,activated:false};
 validateState(p);const c=p.plan.exit_policy,s=p.profit_protection,events=[];
 const out=(reason=null,blocker=null,activated=false)=>({events,reason,blocker,activated});
 if(s.state==='CLOSED')return out();
 if(p.exit_intent)return out(p.exit_intent.reason,null);
 // Only an explicitly expired/cancelled manual request can restore management.
 if(['EXIT_PENDING','PARTIALLY_CLOSED'].includes(s.state)){
  s.state=active(s)?'TRAILING_ACTIVE':'OPEN_BEFORE_TARGET';s.exit_reason=null;s.exit_intent_at=null;s.exit_intent_not_before=null;s.exit_intent=null;
 }
 if(!secondaryFresh(q,now)||q.event_at<p.entered_at||q.received_at<p.entered_at||q.event_at>q.received_at+1000||!v||v.fresh!==true||v.quote_at!==q.event_at||v.side!==(p.plan.direction==='LONG'?'bid':'ask')||!finite(v.net))return out(null,'TRAILING_MARKET_DATA_UNUSABLE');
 if(!valuationValid(v))return out(null,'TRAILING_VALUATION_INVALID');
 if(!finite(availableQty)||D(availableQty).lt(0))return out(null,'TRAILING_LIQUIDITY_INVALID');
 const newQuote=(s.last_valid_quote_at===null||q.event_at>s.last_valid_quote_at)&&(s.last_valid_received_at===null||q.received_at>=s.last_valid_received_at);
 if(q.event_at<(s.last_valid_quote_at??0)||q.received_at<(s.last_valid_received_at??0))return out(null,'TRAILING_QUOTE_OUT_OF_ORDER');
 const complete=v.funding_complete===true&&v.result_final!==false;
 if(newQuote){s.last_valid_quote_at=q.event_at;s.last_valid_received_at=q.received_at;s.last_evaluated_at=now;s.last_net=String(v.net);s.last_net_per_unit=D(v.net).div(p.qty).toString();s.last_net_funding_complete=complete;s.last_data_quality=v.data_quality??p.quality??'OBSERVED';}
 const targetHit=p.plan.direction==='SHORT'?D(q.ask).lte(p.plan.target):D(q.bid).gte(p.plan.target);
 const fullLiquidity=D(availableQty).gte(p.qty)&&q.post_only!==true;
 if(early(p)&&newQuote){s.execution_uncertainty_per_unit=uncertainty(p,q).toString();s.required_activation_net=minimum(p);}
 const unit=D(v.net).div(p.qty);
 if(!active(s)){
  s.required_activation_net=minimum(p);
  // At the original deadline a new valid target can activate; afterwards it cannot.
  if(newQuote&&(early(p)||targetHit)&&now<=s.base_expires_at){
   let issue=!complete?'FUNDING_UNRESOLVED':!fullLiquidity?'EXECUTABLE_LIQUIDITY_INSUFFICIENT':D(v.net).lt(s.required_activation_net)?'NET_BELOW_ACTIVATION_MINIMUM':null;
   if(issue){
    // Keep the effective reason visible before any structural target is reached.
    s.activation_blocker=issue;
    if(!early(p)||D(v.net).gt(0))markIssue(p,q,v,now,issue,availableQty,events);
   }
   else{
    s.state='TRAILING_ACTIVE';s.trailing_activated_at=now;s.activation_net_original=String(v.net);s.activation_qty=String(p.qty);s.activation_net_per_unit=unit.toString();
    s.activation_evidence=captureEvidence(p,q,v,now,availableQty);s.peak_evidence=structuredClone(s.activation_evidence);
    if(early(p)){s.floor_evidence=structuredClone(s.activation_evidence);s.floor_at=now;}
    s.peak_net_per_unit=unit.toString();s.peak_at=now;s.peak_quote_at=q.event_at;s.peak_received_at=q.received_at;
    s.retracement_allowance_per_unit=allowance(p,unit,q).toString();s.protected_net_per_unit=unit.minus(s.retracement_allowance_per_unit).toString();
    s.effective_expires_at=s.base_expires_at+c.trailing_extension_ms;s.deadline_reason=deadlineReason(p);s.stagnation_deadline_at=now+c.stagnation_ms;s.activation_blocker=null;s.current_retracement='0';totals(s);
    events.push(event(p,early(p)?'PROFIT_PROTECTION_ACTIVATED':'TARGET_REACHED',now,{state:'TRAILING_ACTIVE',activation_net:s.activation_net,peak_net:s.peak_net,protected_net:s.protected_net,retracement_allowance:s.retracement_allowance,basis_qty:s.basis_qty,required_net:s.required_activation_net,effective_expires_at:s.effective_expires_at,quote:structuredClone(q),quote_hash:hash(q),available_qty:String(availableQty),profit_protection:structuredClone(s)}));
    validateState(p);return out(null,null,true);
   }
  }else if(!early(p)&&!targetHit&&newQuote)s.activation_blocker=null;
  if(now>=s.base_expires_at)return out('TIMEOUT');
  return out(null,s.activation_blocker);
 }
 // The hard deadline is fixed at activation. Neither a new high nor a restart extends it.
 if(now>=s.effective_expires_at)return out('TIMEOUT_EXTENDED');
 if(newQuote&&complete){
  if(fullLiquidity&&unit.gt(s.peak_net_per_unit)){
   s.peak_net_per_unit=unit.toString();s.peak_at=now;s.peak_quote_at=q.event_at;s.peak_received_at=q.received_at;
   s.peak_evidence=captureEvidence(p,q,v,now,availableQty);
   s.retracement_allowance_per_unit=allowance(p,unit,q).toString();
   const candidateFloor=unit.minus(s.retracement_allowance_per_unit);
   if(early(p)&&candidateFloor.gt(s.protected_net_per_unit)){s.floor_evidence=structuredClone(s.peak_evidence);s.floor_at=now;}
   s.protected_net_per_unit=max(s.protected_net_per_unit,candidateFloor).toString();
   s.stagnation_deadline_at=now+c.stagnation_ms;totals(s);
  }
  s.current_retracement=max(0,D(s.peak_net).minus(v.net)).toString();
  // A missing/partial book must not erase the intent. The broker deals with capacity.
  if(unit.lte(s.protected_net_per_unit)){validateState(p);return out('TRAILING_RETRACEMENT');}
 }
 if(now>=s.stagnation_deadline_at)return out('TRAILING_STAGNATION');
 const blocker=!complete?'TRAILING_FUNDING_UNRESOLVED':q.post_only===true?'INSTRUMENT_POST_ONLY_TRAILING':!fullLiquidity?'TRAILING_PEAK_LIQUIDITY_INSUFFICIENT':null;
 validateState(p);return out(null,blocker);
}

export function markProfitExitPending(p,intent){
 if(!policy(p))return null;
 // The broker sets p.exit_intent first; validate previous financial fields without
 // requiring the previous phase to already describe that just-created intent.
 validateState(p,{allowIntentTransition:true});
 if(!intent||typeof intent.reason!=='string'||!timestamp(intent.decided_at)||!timestamp(intent.not_before)||intent.not_before<intent.decided_at)fail();
 if(!p.exit_intent||hash(p.exit_intent)!==hash(intent)||p.profit_protection.state==='CLOSED')fail();
 const s=p.profit_protection;s.state=D(p.closed_qty??0).gt(0)?'PARTIALLY_CLOSED':'EXIT_PENDING';s.exit_reason=intent.reason;s.exit_intent_at=intent.decided_at;s.exit_intent_not_before=intent.not_before;s.exit_intent=structuredClone(intent);
 validateState(p);
 return s;
}

export function scaleProfitProtection(p,beforeQty,afterQty,at){
 if(!policy(p))return null;
 const s=p.profit_protection;if(!s)throw Error('SECONDARY_PROFIT_PROTECTION_STATE_MISSING');
 if(!positive(beforeQty)||!finite(afterQty)||D(afterQty).lt(0)||D(afterQty).gt(beforeQty)||!timestamp(at))fail();
 if(D(s.basis_qty).eq(afterQty)&&!D(beforeQty).eq(afterQty)){validateState(p);return null;}
 validateState(p,{allowQuantityTransition:true});if(!D(s.basis_qty).eq(beforeQty)||!D(p.qty).eq(beforeQty)&&!D(p.qty).eq(afterQty))fail();
 if(D(beforeQty).eq(afterQty))return null;
 if(D(afterQty).eq(0))return markProfitClosed(p,at);
 const before={basis_qty:s.basis_qty,activation_net:s.activation_net,peak_net:s.peak_net,protected_net:s.protected_net,retracement_allowance:s.retracement_allowance};
 s.basis_qty=D(afterQty).toString();s.remaining_qty=s.basis_qty;s.required_activation_net=minimum(p,afterQty);
 totals(s);s.state='PARTIALLY_CLOSED';s.last_quantity_change_at=at;
 if(s.last_net_per_unit!==null)s.last_net=D(s.last_net_per_unit).mul(s.basis_qty).toString();
 s.current_retracement=active(s)&&s.last_net_funding_complete?max(0,D(s.peak_net).minus(s.last_net)).toString():null;
 const after={basis_qty:s.basis_qty,activation_net:s.activation_net,peak_net:s.peak_net,protected_net:s.protected_net,retracement_allowance:s.retracement_allowance};
 return event(p,'TRAILING_QUANTITY_SCALED',at,{before,after,quantity_ratio:D(afterQty).div(beforeQty).toString(),unit_peak:s.peak_net_per_unit,unit_protected:s.protected_net_per_unit,realized_profit_excluded:true,profit_protection:structuredClone(s)});
}

export function markProfitClosed(p,at){
 if(!policy(p))return null;
 const s=p.profit_protection;if(!s)throw Error('SECONDARY_PROFIT_PROTECTION_STATE_MISSING');
 if(!timestamp(at)||at<p.entered_at)fail();
 if(s.state==='CLOSED'){validateState(p);return s;}
 validateState(p);s.state='CLOSED';s.closed_at=at;s.remaining_qty='0';s.amount_scope='LAST_EXPOSED_REMAINDER';validateState(p);return s;
}
