// Versioned amendments for NEW secondary PAPER contracts. No exchange I/O.
import {D,hash} from './core.js';
export const REPAIR_VERSION='secondary-execution-repair-1.0.0';
export const REPAIR_POLICY=Object.freeze({version:REPAIR_VERSION,mode:'PAPER',realTrading:false,
 remainder:'RESIZE_WITHIN_ORIGINAL_BUDGET',floor_target_fraction:'0.10',
 partial_target_fractions:['0.50','0.80'],minimum_fragment_net:'0.10',
 latency_horizon_ms:3000,latency_window_ms:60000,latency_min_samples:8,
 latency_max_peak_fraction:'0.25',statistically_validated:false});
const min=(a,b)=>D(a).lte(b)?D(a):D(b),max=(a,b)=>D(a).gte(b)?D(a):D(b);
export function repairProfile(root){const p=root?.secondaryExecution?.quant?.execution_repair;
 if(!p)return null;if(p.version!==REPAIR_VERSION||p.policy_hash!==hash(REPAIR_POLICY)||typeof p.active!=='boolean')throw Error('EXECUTION_REPAIR_PROFILE_INTEGRITY');return p.active?p:null;}
export function installExecutionRepair(root,env,at,event=()=>{}){
 const p=repairProfile(root),flag=env.LUMI_TRADING_SECONDARY_EXECUTION_REPAIR;
 if(!flag){if(p)throw Error('EXECUTION_REPAIR_FLAG_REQUIRED');return false;}
 if(env.LUMI_TRADING_MODE!=='PAPER'||env.LUMI_TRADING_STORAGE!=='SQLITE'||env.LUMI_RUNTIME_ENV!=='staging')throw Error('EXECUTION_REPAIR_PAPER_ONLY');
 if(flag==='OFF'){if(p)p.active=false;return !!p;}
 if(flag!==REPAIR_VERSION||!root.secondaryExecution?.quant?.active_experiment?.active)throw Error('EXECUTION_REPAIR_REQUIRES_ACTIVE_PAPER');
 if(p)return false;root.secondaryExecution.quant.execution_repair={version:REPAIR_VERSION,policy_hash:hash(REPAIR_POLICY),policy:structuredClone(REPAIR_POLICY),active:true,activated_at:at,baseline:{equity:root.frequency.account.equity,net:root.frequency.account.net,closed:root.frequency.account.closed}};
 event({type:'SECONDARY_EXECUTION_REPAIR_ENABLED',at,version:REPAIR_VERSION,policy_hash:hash(REPAIR_POLICY),ledger:'FREQUENT_PAPER',realTrading:false});return true;
}
export function attachExecutionRepair(root,plan){if(!repairProfile(root)||!plan.quant_contract?.active_experiment)return plan;
 const c={version:REPAIR_VERSION,policy_hash:hash(REPAIR_POLICY),mode:'PAPER',realTrading:false};return {...plan,execution_repair:{...c,hash:hash(c)}};}
export function repaired(plan){const c=plan?.execution_repair;if(!c)return false;
 if(c.version!==REPAIR_VERSION||c.policy_hash!==hash(REPAIR_POLICY)||c.hash!==hash({...c,hash:undefined})||c.mode!=='PAPER'||c.realTrading!==false||!plan.quant_contract?.active_experiment)throw Error('EXECUTION_REPAIR_CONTRACT_INTEGRITY');return true;}
export function targetForQuantity(p,quantity=p.qty){return D(p.plan.entry_economics?.expected_net_target??p.plan.sizing.target_net).div(p.plan.sizing.qty).mul(quantity);}
export function protectedFloor(p,quantity=p.qty){const base=D(p.plan.exit_policy.min_protected_net_usd);return repaired(p.plan)?min(base,targetForQuantity(p,quantity).mul(REPAIR_POLICY.floor_target_fraction)):base;}
export function scaleOutFeasibility(p){
 if(!repaired(p.plan))return null;
 const basis=D(p.qty).plus(p.closed_qty??0),step=D(p.plan.sizing.qty_step),fragment=basis.mul('.3').div(step).floor().mul(step),target=targetForQuantity(p,basis),risk=D(p.plan.sizing.risk).mul(basis).div(p.plan.sizing.qty);
 const thresholds=['.25','.50'].map((r,i)=>min(max(i?'.80':'.40',risk.mul(r)),target.mul(REPAIR_POLICY.partial_target_fractions[i])).toString());
 const possible=fragment.gt(0)&&basis.minus(fragment.mul(2)).gte(step)&&D(thresholds[0]).mul(fragment).div(basis).gte(REPAIR_POLICY.minimum_fragment_net)&&D(thresholds[1]).mul(fragment).div(basis).gte(REPAIR_POLICY.minimum_fragment_net);
 return {version:REPAIR_VERSION,basis_qty:basis.toString(),fragment_qty:fragment.toString(),expected_target_net:target.toString(),thresholds,mode:possible?'PARTIALS_AND_TRAILING':'FULL_EXIT_AT_TARGET_OR_PROTECTION',reason:fragment.eq(0)?'LOT_NOT_DIVISIBLE':possible?'FEASIBLE':'FRAGMENT_NET_BELOW_MINIMUM'};
}
export function validateOrderAmendment(o){
 if(!repaired(o.plan))return;
 const c=D(o.cancelled_qty??0),r=D(o.remaining_qty),f=D(o.filled_qty),step=D(o.plan.sizing.qty_step),a=o.amendment;
 if(c.lt(0)||!c.div(step).isInteger()||!r.plus(f).plus(c).eq(o.plan.sizing.qty))throw Error('EXECUTION_REPAIR_QUANTITY_INTEGRITY');
 if(c.gt(0)&&(!a||a.hash!==hash({...a,hash:undefined})||a.version!==REPAIR_VERSION||a.cancelled_total!==c.toString()||!D(a.remaining_qty).gte(r)||!Number.isSafeInteger(a.at)||a.at<o.plan.decision_at))throw Error('EXECUTION_REPAIR_AMENDMENT_INTEGRITY');
 if(o.reserve_unit!=null&&(!D(o.reserve_unit).gt(0)||!D(o.risk_unit).gt(0)||!D(o.remaining_reserved).eq(r.mul(o.reserve_unit))||!D(o.remaining_risk).eq(r.mul(o.risk_unit))))throw Error('EXECUTION_REPAIR_RESERVE_INTEGRITY');
}
// Observe executable-side prices, not hindsight MFE. Gaps reset the sample.
export function observeExecutionBuffer(p,q,now){
 if(!repaired(p.plan)||!Number.isSafeInteger(q.event_at)||q.event_at>now||q.event_at<p.entered_at||q.received_at>now||now-q.event_at>5000)return;
 const s=p.execution_buffer??={version:REPAIR_VERSION,quotes:[],moves:[],buffer_per_btc:'0'},at=q.event_at,price=D(q[p.plan.direction==='SHORT'?'ask':'bid']);
 if(s.quotes.at(-1)?.at>=at)return;
 if(s.quotes.length&&at-s.quotes.at(-1).at>5000){s.quotes=[];s.moves=[];}
 const previous=s.quotes.at(-1),old=[...s.quotes].reverse().find(x=>at-x.at>=REPAIR_POLICY.latency_horizon_ms);
 if(old&&at-old.at<=5000){const move=D(old.price).minus(price).mul(p.plan.direction==='SHORT'?-1:1);s.moves.push({at,value:max(0,move).toString(),from_at:old.at,from_received_at:old.received_at??null,from_price:old.price,to_price:price.toString(),received_at:q.received_at});}
 s.quotes.push({at,price:price.toString(),received_at:q.received_at});s.quotes=s.quotes.filter(x=>at-x.at<=10000).slice(-64);s.moves=s.moves.filter(x=>at-x.at<=REPAIR_POLICY.latency_window_ms).slice(-64);
 const values=s.moves.map(x=>Number(x.value)).sort((a,b)=>a-b);s.buffer_per_btc=values.length>=REPAIR_POLICY.latency_min_samples?String(values[Math.ceil(values.length*.95)-1]):'0';s.samples=values.length;s.at=at;
 s.adverse=!!previous&&price.minus(previous.price).mul(p.plan.direction==='SHORT'?-1:1).lt(0);
}
export function repairExit(p,q,v,now){
 if(!repaired(p.plan)||!v.funding_complete||D(v.net).lte(0))return null;
 const feasibility=scaleOutFeasibility(p);p.exit_feasibility=feasibility;
 const targetHit=p.plan.direction==='SHORT'?D(q.ask).lte(p.plan.target):D(q.bid).gte(p.plan.target);
 if(targetHit&&feasibility.mode==='FULL_EXIT_AT_TARGET_OR_PROTECTION')return 'EXECUTABLE_TARGET_FULL_EXIT';
 const s=p.profit_protection,b=p.execution_buffer;
 if(s?.trailing_activated_at!=null&&b?.adverse&&b.at===q.event_at&&b.samples>=REPAIR_POLICY.latency_min_samples){
  const reserve=min(D(b.buffer_per_btc).mul(p.qty),D(s.peak_net).mul(REPAIR_POLICY.latency_max_peak_fraction));
  p.execution_buffer.trigger_net=D(s.protected_net).plus(reserve).toString();p.execution_buffer.trigger_at=q.event_at;
  if(reserve.gt(0)&&D(v.net).lte(p.execution_buffer.trigger_net))return 'EXECUTION_BUFFER_PROTECTION';
 }return null;
}
