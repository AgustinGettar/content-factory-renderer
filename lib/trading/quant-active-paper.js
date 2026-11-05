import {scaleOutFeasibility} from './quant-execution-repair.js';
// Explicit, bounded PAPER experiment. Existing signed contracts stay immutable.
import {D,hash} from './core.js';
const min=(a,b)=>D(a).lte(b)?D(a):D(b),max=(a,b)=>D(a).gte(b)?D(a):D(b);
export const ACTIVE_VERSION='secondary-active-paper-1.0.0';
export const ACTIVE_POLICY=Object.freeze({version:ACTIVE_VERSION,mode:'PAPER',realTrading:false,ledger:'FREQUENT_PAPER',min_net_rr:.8,max_stop_atr:4,
 range_min_volume:.25,pullback_min_volume:.35,other_min_volume:.8,
 range_patterns:['SCALP_REVERSION','MEAN_REVERSION','RANGE_TRADING'],pullback_patterns:['SCALP_CONTINUATION','TREND_FOLLOWING','BREAKOUT_RETEST'],
 range_transition_adx:25,range_transition_efficiency:.4,range_transition_abs_slope:.15,
 scale_out:[{fraction:'0.3',risk_multiple:'0.25',net_floor:'0.40'},{fraction:'0.3',risk_multiple:'0.5',net_floor:'0.80'}],
 minimum_fragment_net:'0.10',partial_ttl_ms:5000,partial_retries:0,remaining_management:'EXISTING_SIGNED_TRAILING',probability:null,statistically_validated:false});
export function getActiveProfile(root){const p=root?.secondaryExecution?.quant?.active_experiment;if(!p)return null;if(p.version!==ACTIVE_VERSION||p.policy_hash!==hash(ACTIVE_POLICY)||hash(p.policy)!==p.policy_hash||typeof p.active!=='boolean')throw Error('ACTIVE_POLICY_INTEGRITY');return p.active?p:null;}
export function installActivePaper(root,env,now,event=()=>{}){
 const old=getActiveProfile(root),flag=env.LUMI_TRADING_SECONDARY_ACTIVE;
 if(!flag){if(old)throw Error('ACTIVE_FLAG_REQUIRED');return false;}
 if(env.LUMI_TRADING_MODE!=='PAPER'||env.LUMI_RUNTIME_ENV!=='staging'||env.LUMI_TRADING_STORAGE!=='SQLITE')throw Error('ACTIVE_PAPER_ONLY');
 if(flag==='OFF'){if(old)old.active=false;return !!old;}
 if(flag!==ACTIVE_VERSION||!root.secondaryExecution.quant?.active||!root.secondaryExecution.quant.opportunities?.active||root.secondaryExecution.risk_budget?.version!=='secondary-risk-budget-3.0.0')throw Error('ACTIVE_REQUIRES_RISK_V3_AND_OPPORTUNITIES');
 if(old)return false;root.secondaryExecution.quant.active_experiment={version:ACTIVE_VERSION,active:true,policy:structuredClone(ACTIVE_POLICY),policy_hash:hash(ACTIVE_POLICY),activated_at:now,baseline:{equity:root.frequency.account.equity,net:root.frequency.account.net,closed:root.frequency.account.closed},counts:{evaluations:0,detected:0,candidates:0,selected:0},frames:{}};
 event({type:'SECONDARY_ACTIVE_PAPER_ENABLED',at:now,version:ACTIVE_VERSION,policy_hash:hash(ACTIVE_POLICY),ledger:'FREQUENT_PAPER',realTrading:false});return true;
}
export function activeContract(){const p={version:ACTIVE_VERSION,policy_hash:hash(ACTIVE_POLICY),mode:'PAPER',realTrading:false};return {...p,hash:hash(p)};}
export function validateActiveContract(plan){const p=plan?.quant_contract?.active_experiment;if(!p)return false;if(p.version!==ACTIVE_VERSION||p.policy_hash!==hash(ACTIVE_POLICY)||p.hash!==hash({...p,hash:undefined})||p.mode!=='PAPER'||p.realTrading!==false||!plan.quant_contract.opportunities)throw Error('ACTIVE_CONTRACT_INTEGRITY');return true;}
export const minimumQuantRR=plan=>validateActiveContract(plan)?ACTIVE_POLICY.min_net_rr:1;
export function activeVolumeMinimum(pattern,defaultMinimum){return ACTIVE_POLICY.range_patterns.includes(pattern)?ACTIVE_POLICY.range_min_volume:ACTIVE_POLICY.pullback_patterns.includes(pattern)?Math.min(defaultMinimum,ACTIVE_POLICY.pullback_min_volume):defaultMinimum;}
export function activeRegime(spec,regime,f){
 if(regime.regime==='ERRATIC'&&spec.regimes.includes('RANGE')&&f.adx<ACTIVE_POLICY.range_transition_adx&&f.efficiency<=ACTIVE_POLICY.range_transition_efficiency&&Math.abs(f.normalized_slope)<=ACTIVE_POLICY.range_transition_abs_slope)return {...regime,regime:'RANGE',active_transition:true};return regime;
}
export function validateScaleOutState(p){const s=p.scale_out;if(!s)return true;
 const fail=()=>{throw Error('ACTIVE_SCALE_OUT_STATE_INTEGRITY');},finite=x=>x!=null&&String(x).trim()!==''&&Number.isFinite(Number(x)),near=(a,b)=>D(a).minus(b).abs().lte('1e-12');
 if(!validateActiveContract(p.plan)||s.version!==ACTIVE_VERSION||!finite(s.basis_qty)||!D(s.basis_qty).gt(0)||!finite(s.initial_risk)||!D(s.initial_risk).gt(0)||!Array.isArray(s.stages)||s.stages.length>2)fail();
 if(!near(s.basis_qty,D(p.qty).plus(p.closed_qty??0))||!near(s.initial_risk,D(p.plan.sizing.risk).mul(s.basis_qty).div(p.plan.sizing.qty)))fail();
 for(const [i,r] of s.stages.entries()){
  const expected=D(s.basis_qty).mul(ACTIVE_POLICY.scale_out[i].fraction).div(p.plan.sizing.qty_step).floor().mul(p.plan.sizing.qty_step);
  if(r.id!==hash([p.plan.id,ACTIVE_VERSION,i])||r.index!==i||!['PENDING','FILLED','PARTIAL_IOC_REMAINDER_CANCELLED','CANCELLED','SUPERSEDED'].includes(r.status)||!finite(r.quantity)||!D(r.quantity).eq(expected)||!D(r.quantity).gt(0)||!finite(r.closed_before)||D(r.closed_before).lt(0)||D(r.closed_before).gt(p.closed_qty??0)||!Number.isSafeInteger(r.at)||r.at<p.entered_at||r.expires_at!==r.at+ACTIVE_POLICY.partial_ttl_ms)fail();
  if(r.status==='PENDING'){if(i!==s.stages.length-1||!D(r.closed_before).eq(p.closed_qty??0))fail();}
  else if(!Number.isSafeInteger(r.completed_at)||r.completed_at<r.at||!finite(r.filled_quantity)||D(r.filled_quantity).lt(0)||D(r.filled_quantity).gt(r.quantity)||r.status==='FILLED'&&!D(r.filled_quantity).eq(r.quantity))fail();
 }return true;
}
export function nextScaleOut(p,v,now,{pendingEntry=false}={}){
 if(!validateActiveContract(p.plan)||pendingEntry||p.exit_intent||p.exit_requested||!v?.funding_complete||!D(v.net).gt(0))return null;
 p.scale_out??={version:ACTIVE_VERSION,basis_qty:p.qty,initial_risk:D(p.plan.sizing.risk).mul(p.qty).div(p.plan.sizing.qty).toString(),stages:[]};validateScaleOutState(p);
 const s=p.scale_out,index=s.stages.length,rule=ACTIVE_POLICY.scale_out[index];if(!rule||index>0&&!['FILLED','PARTIAL_IOC_REMAINDER_CANCELLED'].includes(s.stages[index-1].status))return null;
 const feasibility=scaleOutFeasibility(p);if(feasibility){p.exit_feasibility=feasibility;if(feasibility.mode!=='PARTIALS_AND_TRAILING')return null;}
 const normalizedNet=D(v.net).mul(s.basis_qty).div(p.qty),threshold=feasibility?D(feasibility.thresholds[index]):max(rule.net_floor,D(s.initial_risk).mul(rule.risk_multiple));if(normalizedNet.lt(threshold))return null;
 const step=p.plan.sizing.qty_step,quantity=D(s.basis_qty).mul(rule.fraction).div(step).floor().mul(step);if(!quantity.gt(0)||D(p.qty).minus(quantity).lt(step)||D(v.net).mul(quantity).div(p.qty).lt(ACTIVE_POLICY.minimum_fragment_net))return null;
 const r={id:hash([p.plan.id,ACTIVE_VERSION,index]),index,quantity:quantity.toString(),closed_before:p.closed_qty??'0',at:now,expires_at:now+ACTIVE_POLICY.partial_ttl_ms,status:'PENDING',threshold_net:threshold.toString()};s.stages.push(r);return r;
}
export function pendingScaleOut(p){return p?.scale_out?.stages?.find(r=>r.status==='PENDING')??null;}
export function scaleOutQuantity(p,requested){const r=pendingScaleOut(p);return r&&p.exit_intent?.reason==='ACTIVE_SCALE_OUT'?min(requested,D(r.quantity).minus(D(p.closed_qty??0).minus(r.closed_before))):requested;}
export function settleScaleOut(p,now,status){const r=pendingScaleOut(p);if(!r)return null;r.status=status;r.completed_at=now;r.filled_quantity=D(p.closed_qty??0).minus(r.closed_before).toString();return structuredClone(r);}
export function clearScaleOutIntent(p){if(p.exit_intent?.reason==='ACTIVE_SCALE_OUT')delete p.exit_intent;if(p.exit_requested==='ACTIVE_SCALE_OUT')delete p.exit_requested;delete p.execution_blocker;
 const s=p.profit_protection;if(s){s.state=s.trailing_activated_at!=null?'TRAILING_ACTIVE':'OPEN_BEFORE_TARGET';for(const k of ['exit_reason','exit_intent_at','exit_intent_not_before','exit_intent'])s[k]=null;}}
