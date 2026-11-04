// External-only experiments reuse the real PAPER broker on an isolated clone.
// Nothing imports this module in the worker or enables an experimental policy.
import {existsSync} from 'node:fs';
import {D,hash} from './core.js';
import {SecondaryBroker,secondaryEstimate} from './secondary-futures-engine.js';
import {secondaryFresh} from './secondary-futures-math.js';
import {validateProfitProtection} from './secondary-profit-protection.js';
export const QUANT_EXPERIMENT_VERSION='secondary-quant-experiments-1.0.0';
const positive=x=>x!=null&&typeof x!=='boolean'&&String(x).trim()!==''&&Number.isFinite(Number(x))&&D(x).gt(0);
const min=(a,b)=>D(a).lt(b)?D(a):D(b);
export function requireExternalResearch(){
 if(existsSync('/etc/lumi-trading/worker.env')||process.env.LUMI_TRADING_DB_PATH)throw Error('EXTERNAL_RESEARCH_HOST_REQUIRED');
}
export function partitionQuantity(qty,step,fractions=['0.3','0.3','0.4']){
 if(!positive(qty)||!positive(step)||!Array.isArray(fractions)||fractions.length<2||fractions.length>10||fractions.some(x=>!positive(x))||!fractions.reduce((s,x)=>s.plus(x),D(0)).eq(1))throw Error('EXPERIMENT_PARTITION_INVALID');
 const total=D(qty).div(step).floor().mul(step);let used=D(0);
 const legs=fractions.map((f,i)=>{const n=i===fractions.length-1?total.minus(used):total.mul(f).div(step).floor().mul(step);used=used.plus(n);return n.toString();});
 if(legs.some(x=>!D(x).gt(0)))throw Error('EXPERIMENT_LEG_BELOW_LOT');
 return {quantity:total.toString(),rounding_remainder:D(qty).minus(total).toString(),step:String(step),fractions:fractions.map(String),legs};
}
// Risk is reserved for ALL planned legs from inception, never multiplied later.
// Each later leg still needs an independent confirmation and live broker admission.
export function planScaleIn({id,qty,step,riskPerBTC,marginPerBTC,costPerBTC,equity,availableCash,existingRisk,portfolioRiskFraction='.03',perTradeRiskFraction='.005',fractions=['0.5','0.3','0.2'],now,expiresAt}){
 if(typeof id!=='string'||!id||![riskPerBTC,marginPerBTC,equity].every(positive)||![costPerBTC,availableCash,existingRisk].every(x=>x!=null&&Number.isFinite(Number(x))&&D(x).gte(0))||![portfolioRiskFraction,perTradeRiskFraction].every(x=>positive(x)&&D(x).lte('.03'))||!Number.isSafeInteger(now)||!Number.isSafeInteger(expiresAt)||expiresAt<=now)throw Error('SCALE_IN_INPUT_INVALID');
 const partition=partitionQuantity(qty,step,fractions),total=D(partition.quantity),risk=total.mul(riskPerBTC),cash=total.mul(D(marginPerBTC).plus(costPerBTC));
 const rejection=risk.gt(D(equity).mul(perTradeRiskFraction))?'TRADE_RISK_BUDGET':risk.plus(existingRisk).gt(D(equity).mul(portfolioRiskFraction))?'PORTFOLIO_RISK_BUDGET':cash.gt(availableCash)?'CASH_RESERVATION':null;
 const plan={version:QUANT_EXPERIMENT_VERSION,id,authority:'RESEARCH_ONLY',mode:'PAPER',realTrading:false,at:now,expires_at:expiresAt,status:rejection?'REJECTED':'PLANNED_NOT_ADMITTED',rejection,quantity:partition.quantity,reserved_risk:risk.toString(),reserved_cash:cash.toString(),legs:partition.legs.map((quantity,index)=>({id:hash([id,index]),index,quantity,risk:D(quantity).mul(riskPerBTC).toString(),cash:D(quantity).mul(D(marginPerBTC).plus(costPerBTC)).toString(),requires_new_confirmation:true,requires_broker_revalidation:true})),automatic_execution:false};
 return {...plan,hash:hash(plan)};
}
export function checkScaleInLeg(plan,index,{now,confirmationId,confirmationAt,usedConfirmations=[],previousLegs=[],remainingRisk,remainingCash,previousNet=null,protectedNet=null}={}){
 if(plan?.hash!==hash({...plan,hash:undefined})||plan.status!=='PLANNED_NOT_ADMITTED')return {accepted:false,reason:'SCALE_IN_PLAN_INVALID'};
 const leg=plan.legs[index];if(!leg||!Number.isSafeInteger(now)||now<plan.at||now>=plan.expires_at)return {accepted:false,reason:'SCALE_IN_EXPIRED_OR_LEG_INVALID'};
 if(typeof confirmationId!=='string'||!confirmationId||usedConfirmations.includes(confirmationId)||!Number.isSafeInteger(confirmationAt)||confirmationAt<plan.at||confirmationAt>now)return {accepted:false,reason:'NEW_CONFIRMATION_REQUIRED'};
 if(previousLegs.length!==index||previousLegs.some((id,i)=>id!==plan.legs[i].id))return {accepted:false,reason:'SCALE_IN_LEG_ORDER'};
 if(index>0&&(!positive(previousNet)||!positive(protectedNet)))return {accepted:false,reason:'WINNING_PROTECTED_PREVIOUS_LEG_REQUIRED'};
 if(!positive(remainingRisk)||!positive(remainingCash)||D(leg.risk).gt(remainingRisk)||D(leg.cash).gt(remainingCash))return {accepted:false,reason:'SCALE_IN_REVALIDATION_FAILED'};
 return {accepted:true,leg,confirmation_id:confirmationId,requires_broker_revalidation:true,authority:'RESEARCH_ONLY'};
}
export class QuantResearchBroker extends SecondaryBroker{
 constructor(options){requireExternalResearch();super({...options,root:structuredClone(options.root),notice:()=>{}});this.root.quant_experiment??={version:QUANT_EXPERIMENT_VERSION,authority:'RESEARCH_ONLY',requests:{}};}
 requestReduction(id,{requestId,quantity,quote,now}){
  if(typeof requestId!=='string'||!/^[a-zA-Z0-9_-]{1,128}$/.test(requestId)||['__proto__','prototype','constructor'].includes(requestId))return {status:'REJECTED',reason:'INVALID_REQUEST_ID'};
  const state=this.root.quant_experiment,old=Object.hasOwn(state.requests,requestId)?state.requests[requestId]:null;
  if(old)return {status:old.status,id:requestId,duplicate:true};
  const p=this.a.positions[id];if(!p||p.exit_intent||p.exit_requested)return {status:'REJECTED',reason:'POSITION_NOT_AVAILABLE'};
  if(typeof requestId!=='string'||!requestId||requestId.length>128||!positive(quantity)||!secondaryFresh(quote,now))return {status:'REJECTED',reason:'INVALID_REDUCTION'};
  const v=secondaryEstimate(p,quote,now);if(!v?.funding_complete||!D(v.net).gt(0))return {status:'REJECTED',reason:'POSITIVE_FINAL_NET_REQUIRED'};
  const step=p.plan.sizing.qty_step??'0.00000001',amount=min(quantity,p.qty).div(step).floor().mul(step);
  if(!amount.gt(0)||amount.gte(p.qty))return {status:'REJECTED',reason:'PARTIAL_QUANTITY_REQUIRED'};
  const request={id:requestId,operation_id:id,quantity:amount.toString(),closed_before:p.closed_qty??'0',status:'PENDING',at:now};
  state.requests[requestId]=request;p.research_reduction_id=requestId;
  this.close(p,quote,now,'RESEARCH_SCALE_OUT');return {status:request.status,id:requestId};
 }
 exitQuantity(p,requested){
  const r=this.root.quant_experiment?.requests[p.research_reduction_id];
  return r?.status==='PENDING'&&p.exit_intent?.reason==='RESEARCH_SCALE_OUT'?min(requested,D(r.quantity).minus(D(p.closed_qty??0).minus(r.closed_before))):requested;
 }
 close(p,q,now,reason){
  const request=this.root.quant_experiment?.requests[p?.research_reduction_id];
  if(request?.status==='PENDING'&&reason!=='RESEARCH_SCALE_OUT'){request.status='SUPERSEDED_BY_MANDATORY_EXIT';delete p.research_reduction_id;}
  const before=D(p?.closed_qty??0),closed=super.close(p,q,now,reason);
  if(request?.status!=='PENDING'||D(p.closed_qty??0).eq(before))return closed;
  // IOC semantics: execute observed capacity once; do not chase a missing
  // fraction. A subsequent stage must create a new independently dated intent.
  request.filled_quantity=D(p.closed_qty).minus(request.closed_before).toString();request.status=D(request.filled_quantity).eq(request.quantity)?'FILLED':'PARTIAL_IOC_REMAINDER_CANCELLED';request.completed_at=now;
  if(this.a.positions[p.plan.id]===p){
   delete p.exit_intent;delete p.exit_requested;delete p.research_reduction_id;delete p.execution_blocker;
   if(p.profit_protection){const s=p.profit_protection;s.state=s.trailing_activated_at!==null?'TRAILING_ACTIVE':'OPEN_BEFORE_TARGET';for(const k of ['exit_reason','exit_intent_at','exit_intent_not_before','exit_intent'])s[k]=null;validateProfitProtection(p);}
  }
  this.record({type:'RESEARCH_SCALE_OUT_SETTLED',id:p.plan.id,at:now,request:structuredClone(request),authority:'RESEARCH_ONLY',plan:p.plan});return closed;
 }
}
