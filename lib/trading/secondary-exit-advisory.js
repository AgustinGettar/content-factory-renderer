// Causal, bounded exit-research evidence only. It cannot send orders, change
// contracts, move a protection floor, allocate money or run the entry network.
import {D,hash} from './core.js';
import {SECONDARY_MODEL,secondaryFresh} from './secondary-futures-math.js';
export const EXIT_ADVISORY_VERSION='secondary-exit-advisory-snapshot-1.0.0';
export const EXIT_ADVISORY_PROTOCOL=Object.freeze({version:'secondary-exit-advisory-protocol-1.0.0',authority:'NONE',mode:'PAPER',realTrading:false,max_samples_per_operation:256,max_transition_samples:32,min_sample_ms:60000,max_sample_ms:900000,momentum_window_ms:60000,labels:'EXTERNAL_OBSERVED_MARKET_ONLY',candidate_actions:['HOLD_WITH_SIGNED_STOP_AND_DEADLINE','PROTECT_WITH_SIGNED_FLOOR','CLOSE_AFTER_CONTRACT_LATENCY']});
const finite=x=>x!==null&&x!==undefined&&Number.isFinite(Number(x));
const str=x=>finite(x)?String(x):null;
const positive=x=>finite(x)&&D(x).gt(0);
const boundedReason=x=>typeof x==='string'&&x.length<=120?x:null;
const cleanHash=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x)?x:null;
const max=(a,b)=>D(a).gte(b)?D(a):D(b);

/** Called only after the deterministic management decision, before broker close.
 * Returns a durable-event payload or null. The optional research cursor lives in
 * the existing position object; no new SQLite connection or writer is created.
 */
export function captureSecondaryExitAdvisory({position:p,quote:q,valuation:v,now,availableQty,action='HOLD',reason=null}={}){
 if(p?.plan?.execution_model!==SECONDARY_MODEL||p.plan.instrument!=='PAPER:KRAKEN_FUTURES:PF_XBTUSD'||p.plan.execution_contract?.realTrading!==false||p.plan.exit_policy?.mode!=='PAPER'||p.plan.exit_policy?.realTrading!==false)throw Error('EXIT_ADVISORY_PAPER_ONLY');
 if(!['HOLD','PROTECT','CLOSE'].includes(action))throw Error('EXIT_ADVISORY_ACTION_INVALID');
 // Missing diagnostic input never becomes a blocker for the existing manager.
 if(!secondaryFresh(q,now)||!v||v.quote_at!==q.event_at||q.event_at<p.entered_at||q.received_at<p.entered_at||q.event_at>now||q.received_at>now||!positive(p.qty)||!positive(p.entry)||!finite(v.net)||!finite(availableQty))return null;
 let s=p.exit_advisory;
 if(s&&(s.version!==EXIT_ADVISORY_VERSION||s.authority!=='NONE'||!Number.isSafeInteger(s.samples)||s.samples<0||s.samples>EXIT_ADVISORY_PROTOCOL.max_samples_per_operation||![s.ewma_return,s.ewma_return_squared].every(Number.isFinite)||!Number.isSafeInteger(s.transition_samples)||s.transition_samples<0||s.transition_samples>EXIT_ADVISORY_PROTOCOL.max_transition_samples)){p.exit_advisory_status={status:'DEGRADED',reason:'EXIT_ADVISORY_CURSOR_INVALID',authority:'NONE'};return null;}
 if(!s)s=p.exit_advisory={version:EXIT_ADVISORY_VERSION,authority:'NONE',samples:0,transition_samples:0,last_sample_at:null,last_signature:null,last_quote_at:null,last_mid:null,ewma_return:0,ewma_return_squared:0,segment:null,segment_peak_per_unit:null,suppressed:0};
 if(s.last_quote_at!==null&&q.event_at<=s.last_quote_at)return null;
 const mid=D(q.bid).plus(q.ask).div(2),elapsed=s.last_quote_at===null?0:q.event_at-s.last_quote_at,ret=s.last_mid===null?0:Math.log(mid.div(s.last_mid).toNumber()),weight=elapsed>0?1-Math.exp(-elapsed/EXIT_ADVISORY_PROTOCOL.momentum_window_ms):0;
 s.ewma_return=(1-weight)*s.ewma_return+weight*ret;s.ewma_return_squared=(1-weight)*s.ewma_return_squared+weight*ret*ret;s.last_mid=mid.toString();s.last_quote_at=q.event_at;
 const quantity=D(p.qty),unitNet=D(v.net).div(quantity),full=D(availableQty).gte(quantity)&&q.post_only!==true,complete=v.funding_complete===true&&v.result_final!==false;
 // Each quantity/cost segment has its own causal peak; a partial close is not
 // interpreted as a market drawdown. The signed manager retains its unit floor.
 const segment=hash([p.entry,p.qty,D(p.entry_fee).div(quantity).toString()]);
 if(s.segment!==segment){s.segment=segment;s.segment_peak_per_unit=null;}
 if(full&&complete)s.segment_peak_per_unit=max(s.segment_peak_per_unit??unitNet,unitNet).toString();
 const protection=p.profit_protection??{},signature=hash([protection.state??null,action,reason,p.qty]),transition=s.last_signature!==signature,sampleMs=Math.max(EXIT_ADVISORY_PROTOCOL.min_sample_ms,Math.min(EXIT_ADVISORY_PROTOCOL.max_sample_ms,(p.plan.timeframe??5)*60000));
 const due=s.last_sample_at===null||now-s.last_sample_at>=sampleMs,allowedTransition=transition&&s.transition_samples<EXIT_ADVISORY_PROTOCOL.max_transition_samples;
 if(s.samples>=EXIT_ADVISORY_PROTOCOL.max_samples_per_operation||!due&&!allowedTransition){s.suppressed++;return null;}
 if(allowedTransition)s.transition_samples++;
 const peak=str(protection.peak_net_per_unit??s.segment_peak_per_unit),manual=Boolean(p.management?.override||String(reason??'').startsWith('MANUAL_'));
 const domain={symbol:'PF_XBTUSD',ledger:'FREQUENT_PAPER',mode:'PAPER',realTrading:false,timeframe:p.plan.timeframe??5,entry_revision:p.plan.entry_revision??null,execution_version:p.plan.execution_contract.version??null,execution_policy_hash:cleanHash(p.plan.execution_contract.policy_hash),economic_policy_version:p.plan.economic_policy?.version??null,economic_policy_hash:cleanHash(p.plan.economic_policy?.hash),exit_policy_version:p.plan.exit_policy.version,exit_policy_hash:p.plan.exit_policy.hash};
 const snapshot={version:EXIT_ADVISORY_VERSION,protocol_version:EXIT_ADVISORY_PROTOCOL.version,authority:'NONE',mode:'PAPER',realTrading:false,observation_id:hash([EXIT_ADVISORY_VERSION,p.plan.id,q.event_at,signature]),operation_id:p.plan.id,movement_id:p.plan.movement_id??p.plan.movement?.movement_id??p.plan.entry_context?.movement_key??null,parent_id:p.plan.parent_id??null,domain,domain_hash:hash(domain),at:now,quote_at:q.event_at,quote_received_at:q.received_at,entered_at:p.entered_at,segment_id:segment,
  variables:{quantity:p.qty,entry:p.entry,side:v.side,liquidation_price:v.price,net_liquidation:v.net,net_liquidation_per_unit:unitNet.toString(),causal_peak_net_per_unit:peak,causal_drawdown_per_unit:peak===null||!complete?null:max(0,D(peak).minus(unitNet)).toString(),realized_net:str(p.realized?.net??'0'),realized_plus_remaining_net:complete?D(p.realized?.net??0).plus(v.net).toString():null,elapsed_ms:now-p.entered_at,remaining_horizon_ms:Math.max(0,(protection.effective_expires_at??p.expires_at)-now),causal_ewma_return_60s:s.ewma_return,causal_ewma_return_volatility_60s:Math.sqrt(Math.max(0,s.ewma_return_squared-s.ewma_return*s.ewma_return)),spread:D(q.ask).minus(q.bid).toString(),available_exit_quantity:String(availableQty),full_exit_liquidity:full,entry_fee:str(v.entry_cost),exit_fee:str(v.exit_fee),accrued_funding:str(v.funding),slippage_embedded_in_price:str(v.slippage_cost),funding_complete:complete,protection_state:protection.state??null,protection_peak_per_unit:str(protection.peak_net_per_unit),protected_net_per_unit:str(protection.protected_net_per_unit),effective_activation_net:str(protection.required_activation_net),additional_uncertainty_per_unit:str(protection.execution_uncertainty_per_unit),data_quality:p.quality??'UNKNOWN'},
  action:{taken:action,reason:boundedReason(reason),authority:manual?'MANUAL_REQUEST':'SIGNED_DETERMINISTIC_POLICY',exit_intent_latched:Boolean(p.exit_intent),advisory_prediction:null},evaluation:{status:'COLLECTING',label:null,exclusion:manual?'MANUAL_MANAGEMENT_OVERRIDE':!complete?'FUNDING_UNRESOLVED':!full?'FULL_LIQUIDATION_NOT_OBSERVED':null,post_exit_path:'SEPARATE_MARKET_EVIDENCE_REQUIRED',candidate_actions:[...EXIT_ADVISORY_PROTOCOL.candidate_actions]},costs_already_in_liquidation_net:true};
 snapshot.snapshot_hash=hash(snapshot);
 if(Buffer.byteLength(JSON.stringify(snapshot))>8192){p.exit_advisory_status={status:'DEGRADED',reason:'EXIT_ADVISORY_SNAPSHOT_LIMIT',authority:'NONE'};return null;}
 s.samples++;s.last_sample_at=now;s.last_signature=signature;p.exit_advisory_status={status:'COLLECTING',authority:'NONE',samples:s.samples,training_updates:0,model:null};
 return {type:'SECONDARY_EXIT_ADVISORY_SNAPSHOT',id:p.plan.id,at:now,version:p.plan.version,ledger:'FREQUENT_PAPER',realTrading:false,snapshot};
}
export function validateExitAdvisorySnapshot(snapshot){
 if(snapshot?.version!==EXIT_ADVISORY_VERSION||snapshot.authority!=='NONE'||snapshot.mode!=='PAPER'||snapshot.realTrading!==false||snapshot.domain?.symbol!=='PF_XBTUSD'||snapshot.domain?.ledger!=='FREQUENT_PAPER')throw Error('EXIT_ADVISORY_SNAPSHOT_DOMAIN');
 if(snapshot.snapshot_hash!==hash({...snapshot,snapshot_hash:undefined})||snapshot.domain_hash!==hash(snapshot.domain)||!Number.isSafeInteger(snapshot.at)||snapshot.quote_at>snapshot.at||snapshot.quote_received_at>snapshot.at||snapshot.entered_at>snapshot.quote_at||snapshot.evaluation?.label!==null||snapshot.action?.advisory_prediction!==null)throw Error('EXIT_ADVISORY_SNAPSHOT_INTEGRITY');
 return true;
}
