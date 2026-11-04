// Additive policies for NEW secondary PAPER signals. Historical contracts retain
// their exact versions, hashes, entry conditions and target-gated exit semantics.
import {D,hash} from './core.js';
import {isExploration} from './secondary-exploration.js';
export const PROFIT_POLICY_VERSION='secondary-profit-policy-1.0.0';
export const PROFIT_ENTRY_REVISION='secondary-entry-useful-margin-1.0.0';
export const PROFIT_ECONOMIC_VERSION='secondary-entry-economics-1.0.0';
export const PROFIT_EXIT_VERSION='secondary-net-trailing-1.0.0';
export const PROFIT_POLICY=Object.freeze({
 version:PROFIT_POLICY_VERSION,entryRevision:PROFIT_ENTRY_REVISION,economicVersion:PROFIT_ECONOMIC_VERSION,exitVersion:PROFIT_EXIT_VERSION,
 mode:'PAPER',symbol:'PF_XBTUSD',ledger:'FREQUENT_PAPER',realTrading:false,
 min_expected_net_target_fraction:'0.002',retracement_fraction:'0.25',
 funding_estimation_ms:1800000,base_holding_ms:1800000,trailing_extension_ms:900000,stagnation_ms:600000,
 exposure_basis:'EXECUTABLE_ENTRY_PRICE_TIMES_QUANTITY',quantity_basis:'PER_REMAINING_BTC',
 target_net_insufficient_action:'KEEP_STOP_AND_BASE_TIMEOUT',require_full_liquidity_for_peak:true,
 admission_recheck:'POST_LATENCY_EACH_FILL',parameter_status:'EXPERIMENTAL_NOT_STATISTICALLY_VALIDATED',
 financial_loss_limits:false,nominal_size_and_leverage_unchanged:true,
});
export const EARLY_PROFIT_POLICY_VERSION='secondary-profit-policy-2.0.0';
export const EARLY_PROFIT_ENTRY_REVISION='secondary-entry-useful-margin-2.0.0';
export const EARLY_PROFIT_EXIT_VERSION='secondary-net-protection-2.0.0';
export const EARLY_HORIZON_VERSION='secondary-protection-horizons-1.0.0';
export const EARLY_PROFIT_HORIZONS=Object.freeze({
 1:Object.freeze({base_holding_ms:600000,trailing_extension_ms:300000,stagnation_ms:180000}),
 5:Object.freeze({base_holding_ms:1800000,trailing_extension_ms:900000,stagnation_ms:600000}),
 15:Object.freeze({base_holding_ms:5400000,trailing_extension_ms:2700000,stagnation_ms:1800000}),
 60:Object.freeze({base_holding_ms:21600000,trailing_extension_ms:10800000,stagnation_ms:7200000}),
 240:Object.freeze({base_holding_ms:86400000,trailing_extension_ms:43200000,stagnation_ms:28800000}),
});
export const EARLY_PROFIT_POLICY=Object.freeze({...PROFIT_POLICY,
 version:EARLY_PROFIT_POLICY_VERSION,entryRevision:EARLY_PROFIT_ENTRY_REVISION,exitVersion:EARLY_PROFIT_EXIT_VERSION,
 funding_estimation_ms:2700000,min_protected_net_usd:'0.05',execution_uncertainty_fraction:'0.0001',
 activation:'EXECUTABLE_POSITIVE_FLOOR',target_activation_required:false,
 uncertainty_basis:'MAX_EXPOSURE_FRACTION_HALF_OBSERVED_SPREAD_ADDITIONAL_TO_BOOKED_COSTS',
 horizon_version:EARLY_HORIZON_VERSION,
});
const fraction=v=>v!==null&&v!==undefined&&Number.isFinite(Number(v))&&D(v).gt(0)&&D(v).lt(1);
const positive=v=>v!==null&&v!==undefined&&Number.isFinite(Number(v))&&D(v).gt(0);
const duration=v=>Number.isSafeInteger(v)&&v>0&&v<=86400000;
const early=p=>p?.version===EARLY_PROFIT_POLICY_VERSION;
export const isEarlyProfitContract=c=>c?.version===EARLY_PROFIT_EXIT_VERSION;
function earlyFields(p){
 return positive(p.min_protected_net_usd)&&D(p.min_protected_net_usd).lte(100)&&fraction(p.execution_uncertainty_fraction)&&D(p.execution_uncertainty_fraction).lte('.01')&&p.activation===EARLY_PROFIT_POLICY.activation&&p.target_activation_required===false&&p.uncertainty_basis===EARLY_PROFIT_POLICY.uncertainty_basis&&p.horizon_version===EARLY_HORIZON_VERSION;
}
export function validateProfitPolicy(p){
 const isEarly=early(p),expected=isEarly?EARLY_PROFIT_POLICY:PROFIT_POLICY;
 if(p?.version!==expected.version||p.entryRevision!==expected.entryRevision||p.economicVersion!==expected.economicVersion||p.exitVersion!==expected.exitVersion)throw Error('SECONDARY_PROFIT_POLICY_VERSION_UNSUPPORTED');
 if(p.mode!=='PAPER'||p.realTrading!==false||p.symbol!=='PF_XBTUSD'||p.ledger!=='FREQUENT_PAPER')throw Error('SECONDARY_PROFIT_POLICY_PAPER_ONLY');
 if(!fraction(p.min_expected_net_target_fraction)||!fraction(p.retracement_fraction)||![p.funding_estimation_ms,p.base_holding_ms,p.trailing_extension_ms,p.stagnation_ms].every(duration))throw Error('SECONDARY_PROFIT_POLICY_PARAMETERS_INVALID');
 if(p.exposure_basis!==PROFIT_POLICY.exposure_basis||p.quantity_basis!==PROFIT_POLICY.quantity_basis||p.target_net_insufficient_action!==PROFIT_POLICY.target_net_insufficient_action||p.admission_recheck!==PROFIT_POLICY.admission_recheck||p.require_full_liquidity_for_peak!==true||p.financial_loss_limits!==false||p.nominal_size_and_leverage_unchanged!==true)throw Error('SECONDARY_PROFIT_POLICY_CONTRACT_INVALID');
 if(isEarly&&(!earlyFields(p)||Object.entries(EARLY_PROFIT_HORIZONS[5]).some(([key,value])=>p[key]!==value)||p.funding_estimation_ms!==2700000))throw Error('SECONDARY_PROFIT_POLICY_PARAMETERS_INVALID');
 return p;
}
export const getProfitPolicy=root=>root?.secondaryExecution?.profit_policy?.active===true?root.secondaryExecution.profit_policy.policy:null;
export function requestedProfitPolicy(env){
 const requested=env.LUMI_TRADING_SECONDARY_PROFIT_POLICY;
 const p=structuredClone(requested===EARLY_PROFIT_POLICY_VERSION?EARLY_PROFIT_POLICY:PROFIT_POLICY);
 const decimalKeys={LUMI_TRADING_SECONDARY_MIN_EXPECTED_NET_TARGET_FRACTION:'min_expected_net_target_fraction',LUMI_TRADING_SECONDARY_TRAILING_RETRACEMENT_FRACTION:'retracement_fraction'};
 const timeKeys={LUMI_TRADING_SECONDARY_TRAILING_EXTENSION_MS:'trailing_extension_ms',LUMI_TRADING_SECONDARY_TRAILING_STAGNATION_MS:'stagnation_ms'};
 for(const [name,key] of Object.entries(decimalKeys))if(env[name]!==undefined){
  const raw=String(env[name]).trim();if(!/^(?:\d+\.?\d*|\.\d+)$/.test(raw)||!fraction(raw))throw Error('SECONDARY_PROFIT_POLICY_PARAMETERS_INVALID');p[key]=D(raw).toString();
 }
 for(const [name,key] of Object.entries(timeKeys))if(env[name]!==undefined){
  const raw=String(env[name]).trim();if(!/^\d+$/.test(raw)||!duration(Number(raw)))throw Error('SECONDARY_PROFIT_POLICY_PARAMETERS_INVALID');p[key]=Number(raw);
 }
 return validateProfitPolicy(p);
}
export function installProfitPolicy(root,env,now,event=()=>{}){
 const x=root.secondaryExecution;if(!x)throw Error('SECONDARY_EXECUTION_REQUIRED');
 const current=x.profit_policy,requested=env.LUMI_TRADING_SECONDARY_PROFIT_POLICY;
 if(current){validateProfitPolicy(current.policy);if(current.version!==current.policy.version||current.policy_hash!==hash(current.policy))throw Error('SECONDARY_PROFIT_POLICY_INTEGRITY');}
 if(!requested){if(current?.active)throw Error('SECONDARY_PROFIT_POLICY_FLAG_REQUIRED');return false;}
 if(env.LUMI_TRADING_MODE!=='PAPER'||env.LUMI_RUNTIME_ENV!=='staging'||env.LUMI_TRADING_STORAGE!=='SQLITE')throw Error('SECONDARY_PROFIT_POLICY_PAPER_ONLY');
 if(requested==='OFF'){
  if(!current?.active)return false;current.active=false;current.disabled_at=now;current.history.push({at:now,action:'DISABLED',policy_hash:current.policy_hash});
  event({type:'SECONDARY_PROFIT_POLICY_DISABLED',at:now,version:current.version,policy_hash:current.policy_hash,existing_contracts_preserved:true,ledger:'FREQUENT_PAPER',realTrading:false});return true;
 }
 if(![PROFIT_POLICY_VERSION,EARLY_PROFIT_POLICY_VERSION].includes(requested))throw Error('SECONDARY_PROFIT_POLICY_VERSION_UNSUPPORTED');
 if(!isExploration(root))throw Error('SECONDARY_PROFIT_POLICY_REQUIRES_EXPLORATION');
 const policy=requestedProfitPolicy(env),fingerprint=hash(policy);
 if(current?.active&&current.policy_hash===fingerprint)return false;
 const previous=current?{version:current.version,active:current.active,policy_hash:current.policy_hash,policy:structuredClone(current.policy)}:null;
 const a=root.frequency.account,baseline=current?.baseline??{at:now,cash:a.cash,equity:a.equity,net:a.net,fees:a.fees,closed:a.closed,positions:Object.keys(a.positions??{}),pending:Object.keys(a.pendingOrders??{})};
 x.profit_policy={...(current??{}),version:policy.version,active:true,policy,policy_hash:fingerprint,activated_at:current?.activated_at??now,updated_at:now,baseline,history:[...(current?.history??[]),{at:now,action:current?'POLICY_ACTIVATED':'MIGRATED',previous,policy_hash:fingerprint}]};
 event({type:'SECONDARY_PROFIT_POLICY_ENABLED',at:now,version:policy.version,entry_revision:policy.entryRevision,exit_policy_version:policy.exitVersion,policy_hash:fingerprint,parameters:policy,previous,existing_contracts_preserved:true,ledger:'FREQUENT_PAPER',realTrading:false});return true;
}
export function makeProfitContracts(policy,{timeframe=5}={}){
 validateProfitPolicy(policy);const common={policy_version:policy.version,policy_hash:hash(policy),mode:'PAPER',realTrading:false};
 const isEarly=early(policy),horizon=isEarly?EARLY_PROFIT_HORIZONS[timeframe]:null;
 if(isEarly&&!horizon)throw Error('SECONDARY_PROFIT_TIMEFRAME_UNSUPPORTED');
 const economic_policy={version:policy.economicVersion,...common,min_expected_net_target_fraction:policy.min_expected_net_target_fraction,funding_estimation_ms:isEarly?horizon.base_holding_ms+horizon.trailing_extension_ms:policy.funding_estimation_ms,exposure_basis:policy.exposure_basis,admission_recheck:policy.admission_recheck,parameter_status:policy.parameter_status};
 const exit_policy={version:policy.exitVersion,...common,...(!isEarly?{min_activation_net_fraction:policy.min_expected_net_target_fraction}:{}),retracement_fraction:policy.retracement_fraction,base_holding_ms:policy.base_holding_ms,trailing_extension_ms:policy.trailing_extension_ms,stagnation_ms:policy.stagnation_ms,target_net_insufficient_action:policy.target_net_insufficient_action,quantity_basis:policy.quantity_basis,require_full_liquidity_for_peak:true,parameter_status:policy.parameter_status};
 if(isEarly)Object.assign(exit_policy,horizon,{timeframe,horizon_version:policy.horizon_version,min_protected_net_usd:policy.min_protected_net_usd,execution_uncertainty_fraction:policy.execution_uncertainty_fraction,activation:policy.activation,target_activation_required:false,uncertainty_basis:policy.uncertainty_basis});
 economic_policy.hash=hash(economic_policy);exit_policy.hash=hash(exit_policy);return {economic_policy,exit_policy};
}
export function validateProfitContracts(plan){
 const e=plan?.economic_policy,t=plan?.exit_policy;if(!e&&!t)return false;
 const isEarly=isEarlyProfitContract(t),expected=isEarly?EARLY_PROFIT_POLICY:PROFIT_POLICY;
 if(!e||!t||e.version!==PROFIT_ECONOMIC_VERSION||t.version!==expected.exitVersion||e.policy_version!==expected.version||t.policy_version!==expected.version||e.policy_hash!==t.policy_hash||!/^([a-f0-9]{64})$/.test(e.policy_hash??'')||plan.entry_revision!==expected.entryRevision)throw Error('SECONDARY_PROFIT_CONTRACT_VERSION_INVALID');
 for(const c of [e,t])if(c.mode!=='PAPER'||c.realTrading!==false||c.hash!==hash({...c,hash:undefined}))throw Error('SECONDARY_PROFIT_CONTRACT_INTEGRITY');
 const timing=isEarly?EARLY_PROFIT_HORIZONS[t.timeframe]:null;
 const validTiming=isEarly?timing&&plan.timeframe===t.timeframe&&Object.entries(timing).every(([key,value])=>t[key]===value)&&e.funding_estimation_ms===t.base_holding_ms+t.trailing_extension_ms:[e.funding_estimation_ms,t.base_holding_ms,t.trailing_extension_ms,t.stagnation_ms].every(duration);
 if(!fraction(e.min_expected_net_target_fraction)||(!isEarly?e.min_expected_net_target_fraction!==t.min_activation_net_fraction:!earlyFields(t)||t.min_activation_net_fraction!==undefined)||!fraction(t.retracement_fraction)||!validTiming||e.exposure_basis!==PROFIT_POLICY.exposure_basis||e.admission_recheck!==PROFIT_POLICY.admission_recheck||t.quantity_basis!==PROFIT_POLICY.quantity_basis||t.target_net_insufficient_action!==PROFIT_POLICY.target_net_insufficient_action||t.require_full_liquidity_for_peak!==true||plan.holding_ms!==t.base_holding_ms)throw Error('SECONDARY_PROFIT_CONTRACT_PARAMETERS_INVALID');
 return true;
}
