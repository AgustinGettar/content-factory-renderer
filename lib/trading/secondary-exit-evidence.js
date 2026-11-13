// Diagnostic receipts only. Prices already contain spread/slippage; never debit
// these explanations from the ledger. All monetary arithmetic uses engine D.
import {D,hash} from './core.js';
export const EXIT_EVIDENCE_VERSION='secondary-exit-decision-evidence-1.0.0';
const copy=x=>structuredClone(x);
const fields=(x,keys)=>Object.fromEntries(keys.filter(k=>x?.[k]!==undefined).map(k=>[k,copy(x[k])]));
export function exitDecisionEvidence(p,q,v,now,reason){
 if(p?.plan?.instrument!=='PAPER:KRAKEN_FUTURES:PF_XBTUSD'||p.plan.execution_contract?.realTrading!==false)return null;
 const b=p.execution_buffer,s=p.profit_protection;
 const out={version:EXIT_EVIDENCE_VERSION,authority:'NONE',mode:'PAPER',realTrading:false,
  operation_id:p.plan.id,timeframe_minutes:p.plan.timeframe,side:p.plan.direction,
  execution_version:p.plan.execution_contract.version,exit_policy_version:p.plan.exit_policy?.version??null,
  reason,intent_kind:reason==='ACTIVE_SCALE_OUT'?'DISCRETIONARY_REDUCTION':'FULL_EXIT',
  entered_at:p.entered_at,decision_at:now,market_at:q.event_at,received_at:q.received_at,
  quantity_btc:p.qty,already_closed_btc:p.closed_qty??'0',already_realized_net_usd:p.realized?.net??'0',
  entry:p.entry,initial_stop:p.plan.stop,current_stop:p.quant_management?.stop??p.plan.stop,target:p.plan.target,
  quote:fields(q,['source','symbol','event_at','received_at','bid','ask','bid_qty','ask_qty','post_only']),
  valuation:fields(v,['side','quote_price','price','gross','entry_cost','exit_fee','funding','costs','net','funding_complete','data_quality']),
  spread_usd_per_btc:D(q.ask).minus(q.bid).toString(),ordinary_floor_net_usd:s?.protected_net??null,
  peak_net_usd:s?.peak_net??null,buffer:b?{version:b.version,buffer_per_btc:b.buffer_per_btc,unit:'USD/BTC',
   samples:b.samples,adverse:b.adverse,at:b.at,trigger_net:b.trigger_at===q.event_at?b.trigger_net??null:null,trigger_at:b.trigger_at??null,
   quotes:copy((b.quotes??[]).slice(-64)),moves:copy((b.moves??[]).slice(-64)),
   horizon_ms:3000,window_ms:60000,quantile:.95,min_samples:8,peak_cap_fraction:'0.25'}:null,
  funding_sign:'positive=paid; negative=received',costs_embedded_in_prices:true,
  units:{money:'USD',quantity:'BTC',price:'USD/BTC',timestamps:'Unix milliseconds'},
  quality:p.quality??'UNKNOWN',funding_complete:v.funding_complete===true};
 if(out.buffer&&s?.peak_net!=null&&s?.protected_net!=null){
  const raw=D(b.buffer_per_btc).mul(p.qty),cap=D(s.peak_net).mul('.25');
  out.buffer.reserve_net_usd=(raw.lte(cap)?raw:cap).toString();
  out.buffer.recomputed_trigger_net_usd=D(s.protected_net).plus(out.buffer.reserve_net_usd).toString();
 }
 out.hash=hash(out);return out;
}
export function observeExitWait(p,q,now){
 const e=p.exit_decision_evidence;if(!e)return;
 const samples=p.exit_wait_observations??=[];
 if(samples.at(-1)?.market_at>=q.event_at||q.event_at<e.market_at||q.received_at>now)return;
 samples.push({market_at:q.event_at,received_at:q.received_at,observed_at:now,bid:q.bid,ask:q.ask,bid_qty:q.bid_qty,ask_qty:q.ask_qty});
 if(samples.length>16)samples.splice(1,samples.length-16);
}
export function exitFillComparison(p,q,v,qty,now){
 const e=p.exit_decision_evidence;
 if(!e)return {status:'NOT_EVALUABLE',reason:'DECISION_EVIDENCE_NOT_RECORDED',version:EXIT_EVIDENCE_VERSION};
 const ratio=D(qty).div(e.quantity_btc),estimate=D(e.valuation.net).mul(ratio),sign=p.plan.direction==='SHORT'?-1:1;
 const priceEffect=D(v.price).minus(e.valuation.price).mul(sign).mul(qty),feeChange=D(v.exit_fee).minus(D(e.valuation.exit_fee).mul(ratio)),
  fundingChange=D(v.funding).minus(D(e.valuation.funding).mul(ratio)),entryChange=D(v.entry_cost).minus(D(e.valuation.entry_cost).mul(ratio));
 const delta=D(v.net).minus(estimate),explained=priceEffect.minus(feeChange).minus(fundingChange).minus(entryChange);
 return {version:EXIT_EVIDENCE_VERSION,status:e.funding_complete&&v.funding_complete?'OBSERVED':'FUNDING_INCOMPLETE',
  decision_hash:e.hash,intent_kind:e.intent_kind,comparison_origin:'FIRST_LATCHED_DECISION',supersessions:copy(p.exit_decision_supersessions??[]),scope:'EXECUTION_FRAGMENT',quantity_btc:String(qty),
  decision_at:e.decision_at,decision_market_at:e.market_at,decision_received_at:e.received_at,
  fill_at:now,fill_market_at:q.event_at,fill_received_at:q.received_at,decision_to_fill_ms:now-e.decision_at,
  market_elapsed_ms:q.event_at-e.market_at,decision_net_allocated_usd:estimate.toString(),realized_fragment_net_usd:v.net,
  change_net_usd:delta.toString(),executable_quote_move_usd_per_btc:D(v.quote_price).minus(e.valuation.quote_price).toString(),
  price_effect_usd:priceEffect.toString(),exit_fee_change_usd:feeChange.toString(),funding_change_usd:fundingChange.toString(),
  entry_fee_allocation_change_usd:entryChange.toString(),identity_residual_usd:delta.minus(explained).toString(),
  wait_observations:copy(p.exit_wait_observations??[]),path_complete:false,costs_embedded_in_prices:true,
  spread_and_slippage_are_explanations_not_additional_debits:true};
}
