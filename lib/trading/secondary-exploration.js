// Versioned secondary PAPER policy. The historical execution/entry protocols remain immutable.
import {D,hash} from './core.js';
export const EXPLORATION_VERSION='secondary-paper-exploration-1.0.0';
export const EXPLORATION_EXECUTION_VERSION='secondary-exploration-execution-1.0.0';
export const EXPLORATION_ENTRY_REVISION='secondary-entry-exploration-1.0.0';
export const EXPLORATION_POLICY=Object.freeze({
 version:EXPLORATION_VERSION,executionVersion:EXPLORATION_EXECUTION_VERSION,
 entryRevision:EXPLORATION_ENTRY_REVISION,mode:'PAPER',symbol:'PF_XBTUSD',ledger:'FREQUENT_PAPER',
 entryMinutes:5,contextMinutes:15,nominalUSD:'100',leverage:2,latencyMs:1000,exitLatencyMs:1000,
 takerExpiryMs:30000,makerExpiryMs:900000,holdingMs:1800000,
 participation:'0.10',makerParticipation:'0.10',slippage:'0.0002',makerFee:'0.0002',takerFee:'0.0005',
 modes:{BREAKOUT:'TAKER_IOC',PULLBACK:'TAKER_IOC',RANGE_REENTRY:'TAKER_IOC'},
 financialBlocks:false,automaticPaperTopups:true,minNetRR:null,requirePositiveExpectedNet:false,
 sizeBasis:'FIXED_NOMINAL_PER_SIGNAL',sizeAfterLoss:'UNCHANGED',realTrading:false,
 liquidityModel:'OBSERVED_BBO_SHARED_CAPACITY_IOC_OR_POST_ORDER_TRADE_VOLUME',
 disabledFinancialGates:['DAILY_LOSS','DRAWDOWN','LOSS_STREAK','LOSS_COOLDOWN','HISTORICAL_TRIAL_REJECTED','DAILY_SELECTIONS','POSITION_COUNT','PATTERN_COUNT','DIRECTION_COUNT','OPPOSITE_EXPOSURE','ENTRY_RISK','AGGREGATE_RISK','CASH_RESERVE','GROSS_EXPOSURE','PAPER_CAPITAL','TRAINING_OR_PROMOTION'],
});
export function isExploration(root){return root?.secondaryExecution?.exploration?.active===true;}
export function getExplorationPolicy(root){return isExploration(root)?root.secondaryExecution.exploration.policy:null;}
function validatePolicy(policy){
 if(policy?.version!==EXPLORATION_VERSION||policy.mode!=='PAPER'||policy.realTrading!==false||policy.symbol!=='PF_XBTUSD'||policy.ledger!=='FREQUENT_PAPER')throw Error('SECONDARY_EXPLORATION_PAPER_ONLY');
 if(!Number.isFinite(Number(policy.nominalUSD))||!D(policy.nominalUSD).gt(0)||!D(policy.nominalUSD).isFinite())throw Error('SECONDARY_EXPLORATION_NOMINAL_INVALID');
 if(policy.leverage!==2||!['BREAKOUT','PULLBACK','RANGE_REENTRY'].every(k=>['TAKER_IOC','MAKER_LIMIT'].includes(policy.modes[k])))throw Error('SECONDARY_EXPLORATION_POLICY_INVALID');
}
function requestedPolicy(env){
 const policy=structuredClone(EXPLORATION_POLICY);
 if(env.LUMI_TRADING_SECONDARY_NOMINAL_USD!==undefined){
  const raw=String(env.LUMI_TRADING_SECONDARY_NOMINAL_USD).trim();
  if(!/^(?:\d+\.?\d*|\.\d+)$/.test(raw)||!Number.isFinite(Number(raw))||!D(raw).gt(0))throw Error('SECONDARY_EXPLORATION_NOMINAL_INVALID');
  policy.nominalUSD=D(raw).toString();
 }
 for(const pattern of Object.keys(policy.modes)){
  const value=env['LUMI_TRADING_SECONDARY_'+pattern+'_EXECUTION'];
  if(value!==undefined)policy.modes[pattern]=value;
 }
 validatePolicy(policy);return policy;
}
export function installExploration(root,env,now,event=()=>{}){
 const x=root.secondaryExecution;if(!x)throw Error('SECONDARY_EXECUTION_REQUIRED');
 const current=x.exploration,requested=env.LUMI_TRADING_SECONDARY_PROFILE;
 if(current){
  validatePolicy(current.policy);
  if(current.version!==EXPLORATION_VERSION||current.policy_hash!==hash(current.policy))throw Error('SECONDARY_EXPLORATION_PROTOCOL_MISMATCH');
 }
 if(!requested){if(current?.active)throw Error('SECONDARY_EXPLORATION_FLAG_REQUIRED');return false;}
 // This environment key already named the legacy risk profile. A compatible
 // bridge release may boot before exploration is activated without renaming it.
 if(requested==='secondary-growth-1.0.0'){if(!current)return false;throw Error('SECONDARY_EXPLORATION_EXPLICIT_DISABLE_REQUIRED');}
 if(env.LUMI_TRADING_MODE!=='PAPER'||env.LUMI_RUNTIME_ENV!=='staging'||env.LUMI_TRADING_STORAGE!=='SQLITE')throw Error('SECONDARY_EXPLORATION_PAPER_ONLY');
 if(requested==='OFF'||requested==='disabled'){
  if(!current?.active)return false;
  current.active=false;current.disabled_at=now;
  current.history.push({at:now,action:'DISABLED',version:current.version,policy_hash:current.policy_hash});
  event({type:'SECONDARY_EXPLORATION_DISABLED',at:now,version:current.version,policy_hash:current.policy_hash,ledger:'FREQUENT_PAPER',existing_contracts_preserved:true,capital_added:'0',realTrading:false});return true;
 }
 if(requested!==EXPLORATION_VERSION)throw Error('SECONDARY_EXPLORATION_VERSION_UNSUPPORTED');
 const policy=requestedPolicy(env),fingerprint=hash(policy);
 if(current?.active&&current.policy_hash===fingerprint)return false;
 const previous=current?{version:current.version,active:current.active,policy_hash:current.policy_hash,policy:structuredClone(current.policy)}:null;
 const a=root.frequency.account;
 const baseline=current?.baseline??{at:now,cash:a.cash,equity:a.equity,net:a.net,fees:a.fees,closed:a.closed,wins:a.wins,losses:a.losses,peak:a.peak,maxDrawdown:a.maxDrawdown,legacy_trial_status:root.laboratory?.status,execution_status:x.status,cooldown_until:x.cooldown_until,loss_streak:x.loss_streak,account_halted:a.halted??false};
 x.exploration={...(current??{}),version:EXPLORATION_VERSION,active:true,policy,policy_hash:fingerprint,activated_at:current?.activated_at??now,updated_at:now,baseline,
  history:[...(current?.history??[]),{at:now,action:current?'POLICY_ACTIVATED':'MIGRATED',previous,policy_hash:fingerprint}]};
 // Preserve the original terminal status and baselines above. The broker bypasses
 // financial vetoes only for new exploration selections; old contracts are unchanged.
 if(x.status==='HALTED_DRAWDOWN')x.status='ACTIVE_PAPER';
 event({type:'SECONDARY_EXPLORATION_ENABLED',at:now,version:EXPLORATION_VERSION,execution_version:EXPLORATION_EXECUTION_VERSION,entry_revision:EXPLORATION_ENTRY_REVISION,policy_hash:fingerprint,previous,nominal_usd:policy.nominalUSD,leverage:policy.leverage,financial_blocks:false,capital_added:'0',ledger:'FREQUENT_PAPER',realTrading:false});return true;
}
export function explorationContract(policy,pattern,now){
 validatePolicy(policy);const mode=policy.modes[pattern];if(!mode)throw Error('SECONDARY_EXPLORATION_PATTERN_INVALID');
 const expiry=mode==='TAKER_IOC'?policy.takerExpiryMs:policy.makerExpiryMs;
 return {version:policy.executionVersion,profile_version:policy.version,policy_hash:hash(policy),mode,
  symbol:policy.symbol,decision_at:now,not_before:now+policy.latencyMs,expires_at:now+expiry,
  latencyMs:policy.latencyMs,exitLatencyMs:policy.exitLatencyMs,participation:mode==='TAKER_IOC'?policy.participation:policy.makerParticipation,
  slippage:policy.slippage,makerFee:policy.makerFee,takerFee:policy.takerFee,nominalUSD:policy.nominalUSD,leverage:policy.leverage,
  remainder_policy:mode==='TAKER_IOC'?'CANCEL_AFTER_FIRST_EXECUTABLE_QUOTE':'UNTIL_EXPIRY',
  liquidity_model:mode==='TAKER_IOC'?'OBSERVED_BBO_SHARED_CAPACITY':'POST_ORDER_TRADE_THROUGH_SHARED_VOLUME',realTrading:false};
}
