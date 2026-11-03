// Independent clocks for NEW PF_XBTUSD PAPER entries in the existing worker.
// Historical spot frames and already signed contracts are never migrated.
import {hash} from './core.js';
export const SECONDARY_TIMEFRAMES_VERSION='secondary-timeframes-1.0.0';
export const SECONDARY_TIMEFRAMES_PROTOCOL=Object.freeze({
 version:SECONDARY_TIMEFRAMES_VERSION,mode:'PAPER',realTrading:false,ledger:'FREQUENT_PAPER',symbol:'PF_XBTUSD',
 entry_frames:[5,15,60,240],data_frames:[5,15,60,240,1440],simultaneous_order:[240,60,15,5],
 minimum_closed_bars:64,maximum_bars:256,evaluation_delay_ms:2000,evaluation_window_ms:30000,
 frames:{
  5:{timeframe:5,context_timeframe:15,base_holding_ms:1800000,extension_ms:900000,stagnation_ms:600000},
  15:{timeframe:15,context_timeframe:60,base_holding_ms:5400000,extension_ms:2700000,stagnation_ms:1800000},
  60:{timeframe:60,context_timeframe:240,base_holding_ms:21600000,extension_ms:10800000,stagnation_ms:7200000},
  240:{timeframe:240,context_timeframe:1440,base_holding_ms:86400000,extension_ms:43200000,stagnation_ms:28800000},
 },
 source:'KRAKEN_FUTURES_TRADE_CANDLES',exit_clock:'FRESH_QUOTES_EACH_WORKER_TICK',
 history_replay:false,shared_ledger:true,shared_risk:true,parameter_status:'EXPERIMENTAL_NOT_STATISTICALLY_VALIDATED',
});
export const secondaryResolution=tf=>({5:'5m',15:'15m',60:'1h',240:'4h',1440:'1d'}[tf]??null);
export const secondaryFrameSpec=tf=>SECONDARY_TIMEFRAMES_PROTOCOL.frames[Number(tf)]??null;
const stamp=v=>Number.isSafeInteger(v)&&v>=0;
export function getSecondaryTimeframes(root){
 const x=root?.secondaryExecution?.timeframe_execution;if(!x?.active)return null;
 if(x.version!==SECONDARY_TIMEFRAMES_VERSION||x.policy_hash!==hash(SECONDARY_TIMEFRAMES_PROTOCOL)||hash(x.policy)!==x.policy_hash)throw Error('SECONDARY_TIMEFRAMES_INTEGRITY');
 for(const tf of x.policy.entry_frames){
  const frame=x.frames?.[tf];if(!frame||frame.timeframe!==tf||frame.context_timeframe!==x.policy.frames[tf].context_timeframe||!stamp(frame.last_cutoff)||frame.last_cutoff%(tf*60000))throw Error('SECONDARY_TIMEFRAME_CURSOR_INVALID');
  if(!frame.counts||!['completed','missed','transient_blocks','recovered','pattern_checks','selected'].every(key=>stamp(frame.counts[key])))throw Error('SECONDARY_TIMEFRAME_COUNTS_INVALID');
 }
 return x;
}
export function installSecondaryTimeframes(root,env,now,event=()=>{}){
 const execution=root.secondaryExecution;if(!execution)throw Error('SECONDARY_EXECUTION_REQUIRED');
 const current=execution.timeframe_execution,requested=env.LUMI_TRADING_SECONDARY_TIMEFRAMES;
 if(current?.active)getSecondaryTimeframes(root);
 if(!requested){if(current?.active)throw Error('SECONDARY_TIMEFRAMES_FLAG_REQUIRED');return false;}
 if(env.LUMI_TRADING_MODE!=='PAPER'||env.LUMI_RUNTIME_ENV!=='staging'||env.LUMI_TRADING_STORAGE!=='SQLITE')throw Error('SECONDARY_TIMEFRAMES_PAPER_ONLY');
 if(requested==='OFF'){
  if(!current?.active)return false;current.active=false;current.disabled_at=now;
  event({type:'SECONDARY_TIMEFRAMES_DISABLED',at:now,version:SECONDARY_TIMEFRAMES_VERSION,existing_contracts_preserved:true,ledger:'FREQUENT_PAPER',realTrading:false});return true;
 }
 if(requested!==SECONDARY_TIMEFRAMES_VERSION)throw Error('SECONDARY_TIMEFRAMES_VERSION_UNSUPPORTED');
 // Only the separately versioned early-protection contracts support these exact horizons.
 if(!execution.profit_policy?.active||execution.profit_policy.policy?.entryRevision!=='secondary-entry-useful-margin-2.0.0')throw Error('SECONDARY_TIMEFRAMES_REQUIRES_V2_PROFIT_CONTRACTS');
 if(current?.active)return false;
 if(!stamp(now))throw Error('SECONDARY_TIMEFRAMES_TIME_INVALID');
 const policy=structuredClone(SECONDARY_TIMEFRAMES_PROTOCOL),frames={};
 for(const tf of policy.entry_frames){
  const lastCutoff=Math.floor(now/(tf*60000))*tf*60000,previous=current?.frames?.[tf];
  frames[tf]={...previous,timeframe:tf,context_timeframe:policy.frames[tf].context_timeframe,last_cutoff:Math.max(previous?.last_cutoff??0,lastCutoff),
   activated_at:previous?.activated_at??now,last_evaluation_at:previous?.last_evaluation_at??null,last_completed_at:previous?.last_completed_at??null,
   last_status:previous?.last_status??'WAITING_FIRST_NATURAL_CLOSE',blocker:null,decisions:previous?.decisions??{},
   counts:previous?.counts??{completed:0,missed:0,transient_blocks:0,recovered:0,pattern_checks:0,selected:0},reasons:previous?.reasons??{},
   neural_entry_status:tf===5?'EXISTING_5M_AUTHORITY':'TIMEFRAME_NOT_IN_NEURAL_DOMAIN'};
 }
 execution.timeframe_execution={version:SECONDARY_TIMEFRAMES_VERSION,active:true,policy,policy_hash:hash(policy),activated_at:current?.activated_at??now,updated_at:now,frames};
 event({type:'SECONDARY_TIMEFRAMES_ENABLED',at:now,version:SECONDARY_TIMEFRAMES_VERSION,entry_frames:policy.entry_frames,context_frames:[15,60,240,1440],policy_hash:hash(policy),capital_added:'0',existing_contracts_preserved:true,ledger:'FREQUENT_PAPER',realTrading:false});
 return true;
}
