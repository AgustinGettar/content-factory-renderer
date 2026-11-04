// Additive, signed PAPER protocol. Legacy quant/risk policies remain immutable.
import {hash} from './core.js';
export const OPPORTUNITY_VERSION='secondary-quant-opportunities-1.0.0';
export const OPPORTUNITY_POLICY=Object.freeze({version:OPPORTUNITY_VERSION,mode:'PAPER',realTrading:false,
 regime_routing:'TREND_AND_VOLATILITY_ARE_ORTHOGONAL',pullback_min_relative_volume:.35,other_min_relative_volume:.8,
 passive_entry_patterns:['SCALP_CONTINUATION','SCALP_REVERSION','TREND_FOLLOWING','MEAN_REVERSION','RANGE_TRADING','BREAKOUT_RETEST'],
 passive_max_wait_ms:300000,passive_max_distance_atr:.5,risk_reserve_frames:5,
 scalping_min_net_fraction:'0.0005',scalping_frames:[1,5],
 flow_authority:'SHADOW_COMPARISON_ONLY',flow_exit_authority:'SHADOW_COMPARISON_ONLY',model_authority:'NONE',
 parameter_status:'PREDECLARED_PAPER_EXPERIMENT_NOT_PROVEN_PROFITABLE'});
export function getOpportunityProfile(root){const s=root?.secondaryExecution?.quant?.opportunities;if(!s)return null;
 if(s.version!==OPPORTUNITY_VERSION||s.policy_hash!==hash(OPPORTUNITY_POLICY)||hash(s.policy)!==s.policy_hash||typeof s.active!=='boolean')throw Error('OPPORTUNITY_POLICY_INTEGRITY');return s.active?s:null;}
export function installOpportunities(root,env,now,event=()=>{}){
 const old=getOpportunityProfile(root),flag=env.LUMI_TRADING_SECONDARY_OPPORTUNITIES;
 if(!flag){if(old)throw Error('OPPORTUNITY_FLAG_REQUIRED');return false;}
 if(env.LUMI_TRADING_MODE!=='PAPER'||env.LUMI_RUNTIME_ENV!=='staging'||env.LUMI_TRADING_STORAGE!=='SQLITE')throw Error('OPPORTUNITY_PAPER_ONLY');
 if(flag==='OFF'){if(old)old.active=false;return !!old;}
 if(flag!==OPPORTUNITY_VERSION||root.secondaryExecution.quant?.active!==true)throw Error('OPPORTUNITY_QUANT_REQUIRED');
 if(old)return false;
 root.secondaryExecution.quant.opportunities={version:OPPORTUNITY_VERSION,active:true,policy:structuredClone(OPPORTUNITY_POLICY),policy_hash:hash(OPPORTUNITY_POLICY),activated_at:now,counts:{evaluations:0,candidates:0,maker_candidates:0,selected:0},baseline:{net:root.frequency.account.net,equity:root.frequency.account.equity}};
 event({type:'SECONDARY_OPPORTUNITIES_ENABLED',at:now,version:OPPORTUNITY_VERSION,policy_hash:hash(OPPORTUNITY_POLICY),ledger:'FREQUENT_PAPER',realTrading:false});return true;
}
export function opportunityRegimeEligible(spec,regime){
 if(regime.regime==='ILLIQUID')return false;
 return spec.regimes.includes(regime.regime)||(['HIGH_VOLATILITY','VOLATILITY_COMPRESSION'].includes(regime.regime)&&regime.trend!=null&&spec.regimes.includes(regime.trend));
}
export function opportunityVolumeMinimum(pattern,regime){return ['SCALP_CONTINUATION','TREND_FOLLOWING','BREAKOUT_RETEST'].includes(pattern)&&regime.trend?OPPORTUNITY_POLICY.pullback_min_relative_volume:OPPORTUNITY_POLICY.other_min_relative_volume;}
export function opportunityContract(extra={}){const c={version:OPPORTUNITY_VERSION,policy_hash:hash(OPPORTUNITY_POLICY),...extra};return {...c,hash:hash(c)};}
export function applyOpportunityEconomics(contracts,timeframe){
 const e=contracts.economic_policy;if(!OPPORTUNITY_POLICY.scalping_frames.includes(timeframe))return contracts;
 const base=e.min_expected_net_target_fraction;e.base_min_expected_net_target_fraction=base;e.opportunity_policy_hash=hash(OPPORTUNITY_POLICY);
 e.min_expected_net_target_fraction=String(Math.min(Number(base),Number(OPPORTUNITY_POLICY.scalping_min_net_fraction)));e.hash=hash({...e,hash:undefined});return contracts;
}
export function validateOpportunityContract(plan){const c=plan?.quant_contract?.opportunities;if(!c)return false;
 if(c.version!==OPPORTUNITY_VERSION||c.policy_hash!==hash(OPPORTUNITY_POLICY)||c.hash!==hash({...c,hash:undefined})||!['TAKER_IOC','MAKER_LIMIT'].includes(c.execution_mode)||c.execution_mode!==plan.execution_contract?.mode||c.flow_authority!==OPPORTUNITY_POLICY.flow_authority)throw Error('OPPORTUNITY_CONTRACT_INTEGRITY');
 const e=plan.economic_policy;if(e?.opportunity_policy_hash&&(e.opportunity_policy_hash!==c.policy_hash||!OPPORTUNITY_POLICY.scalping_frames.includes(plan.timeframe)||!(Number(e.base_min_expected_net_target_fraction)>0)||Number(e.min_expected_net_target_fraction)!==Math.min(Number(e.base_min_expected_net_target_fraction),Number(OPPORTUNITY_POLICY.scalping_min_net_fraction))))throw Error('OPPORTUNITY_ECONOMICS_INTEGRITY');
 if(c.analytics?.status==='READY'&&(!Number.isSafeInteger(c.analytics.cutoff)||!Number.isSafeInteger(c.analytics.available_at)||c.analytics.cutoff>plan.confirmed_at||c.analytics.available_at>plan.decision_at))throw Error('OPPORTUNITY_CAUSAL_DATA_REQUIRED');return true;}
export function flowComparison(snapshot,direction){
 if(snapshot?.status!=='READY'||snapshot.flow_imbalance==null)return {status:'UNAVAILABLE',reason:snapshot?.reason??'PUBLIC_FLOW_NOT_READY',authority:'NONE'};
 const signed=(direction==='SHORT'?-1:1)*snapshot.flow_imbalance;
 return {status:signed>=.1?'CONFIRMS':signed<=-.1?'OPPOSES':'NEUTRAL',signed_imbalance:signed,open_interest_change:snapshot.open_interest_change??null,cutoff:snapshot.cutoff,available_at:snapshot.available_at,authority:OPPORTUNITY_POLICY.flow_authority};
}
