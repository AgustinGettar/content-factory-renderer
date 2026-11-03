import test from 'node:test';
import assert from 'node:assert/strict';
import {D} from '../lib/trading/core.js';
import {SECONDARY_MODEL,secondaryEstimate} from '../lib/trading/secondary-futures-math.js';
import {EARLY_PROFIT_POLICY,makeProfitContracts} from '../lib/trading/secondary-profit-policy.js';
import {initializeProfitProtection,evaluateProfitProtection} from '../lib/trading/secondary-profit-protection.js';
import {captureSecondaryExitAdvisory,validateExitAdvisorySnapshot,EXIT_ADVISORY_PROTOCOL} from '../lib/trading/secondary-exit-advisory.js';
const T=Date.parse('2026-11-03T11:00:00Z');
function position(){const p={plan:{id:'ISOLATED_EXIT_EVIDENCE',version:'secondary-futures-1.0.0',instrument:'PAPER:KRAKEN_FUTURES:PF_XBTUSD',execution_model:SECONDARY_MODEL,entry_revision:EARLY_PROFIT_POLICY.entryRevision,timeframe:5,direction:'LONG',target:'103',stop:'98',holding_ms:1800000,execution_contract:{version:'test',realTrading:false,slippage:'.0002',takerFee:'.0005',participation:'.1',policy_hash:'a'.repeat(64)},sizing:{target_net:'.6'},entry_context:{movement_key:'movement-1'},...makeProfitContracts(EARLY_PROFIT_POLICY)},qty:'3',entry:'100',entry_fee:'.15',accrued_funding:'0',funding_pending:[],closed_funding_pending:[],quality:'OBSERVED',entered_at:T,expires_at:T+1800000};initializeProfitProtection(p,T);return p;}
const quote=(at,bid='100.3')=>({source:'KRAKEN_FUTURES_WS_TICKER',symbol:'PF_XBTUSD',event_at:at,received_at:at,bid,ask:D(bid).plus('.01').toString(),bid_qty:'100',ask_qty:'100',suspended:false});
function capture(p,at,options={}){const q=options.quote??quote(at),v=secondaryEstimate(p,q,at);return captureSecondaryExitAdvisory({position:p,quote:q,valuation:v,now:at,availableQty:p.qty,...options});}
test('exit research is causal, hashed and advisory with no model, labels, plan or balance mutation',()=>{
 const p=position(),signed=structuredClone(p.plan),q=quote(T+1000),v=secondaryEstimate(p,q,T+1000);evaluateProfitProtection(p,q,v,T+1000,{availableQty:p.qty});const state=structuredClone(p.profit_protection);
 const e=captureSecondaryExitAdvisory({position:p,quote:{...q,future_high:'999999'},valuation:{...v,future_max:'9000'},now:T+1000,availableQty:p.qty,action:'PROTECT'});assert(e);assert(validateExitAdvisorySnapshot(e.snapshot));assert.equal(e.snapshot.authority,'NONE');assert.equal(e.snapshot.evaluation.label,null);assert.equal(e.snapshot.action.advisory_prediction,null);assert(!JSON.stringify(e).includes('999999'));assert(!JSON.stringify(e).includes('future_max'));
 assert.deepEqual(p.plan,signed);assert.deepEqual(p.profit_protection,state);assert.equal(e.snapshot.variables.net_liquidation,v.net);assert.equal(e.snapshot.variables.entry_fee,v.entry_cost);assert.equal(e.snapshot.domain.timeframe,5);assert.equal(e.snapshot.movement_id,'movement-1');assert.equal(p.exit_advisory_status.training_updates,0);assert.equal(p.exit_advisory_status.model,null);
 const corrupted=structuredClone(e.snapshot);corrupted.variables.net_liquidation='100';assert.throws(()=>validateExitAdvisorySnapshot(corrupted),/INTEGRITY/);
});
test('capture is bounded, restart-idempotent and does not turn every quote into an event',()=>{
 let p=position();assert(capture(p,T+1000));assert.equal(capture(p,T+1000),null);for(let i=2;i<20;i++)assert.equal(capture(p,T+i*1000),null);assert.equal(p.exit_advisory.samples,1);
 p=JSON.parse(JSON.stringify(p));assert.equal(capture(p,T+19000),null);assert(capture(p,T+301000));assert.equal(p.exit_advisory.samples,2);
 for(let i=2;i<400;i++)capture(p,T+i*300000+1000);assert.equal(p.exit_advisory.samples,EXIT_ADVISORY_PROTOCOL.max_samples_per_operation);assert(p.exit_advisory.suppressed>100);assert.equal(p.exit_advisory_status.authority,'NONE');
});
test('funding and liquidity missingness remains explicit and cannot fabricate action-value labels',()=>{
 const p=position();p.funding_pending=[{hour:T,qty:'3',from:T,to:T+1000}];const e=capture(p,T+1000,{availableQty:'0'});assert(e);assert.equal(e.snapshot.variables.full_exit_liquidity,false);assert.equal(e.snapshot.variables.funding_complete,false);assert.equal(e.snapshot.variables.causal_peak_net_per_unit,null);assert.equal(e.snapshot.variables.realized_plus_remaining_net,null);assert.equal(e.snapshot.evaluation.exclusion,'FUNDING_UNRESOLVED');assert.equal(e.snapshot.evaluation.label,null);
 p.funding_pending=[];const next=capture(p,T+301000);assert(next);assert(next.snapshot.variables.causal_peak_net_per_unit);assert.equal(next.snapshot.evaluation.exclusion,null);
});
test('manual action is kept as observed evidence, explicitly excluded from autonomous-action labels',()=>{
 const p=position();const e=capture(p,T+1000,{action:'CLOSE',reason:'MANUAL_PROFIT'});assert.equal(e.snapshot.action.authority,'MANUAL_REQUEST');assert.equal(e.snapshot.evaluation.exclusion,'MANUAL_MANAGEMENT_OVERRIDE');assert.equal(e.snapshot.evaluation.label,null);assert.equal(p.exit_intent,undefined);
});
test('quantity changes do not represent price drawdown; realized and remainder are reconciled separately',()=>{
 const p=position();capture(p,T+1000);p.qty='1.5';p.entry_fee='.075';p.realized={net:'.12'};const e=capture(p,T+2000);assert(e);assert.equal(e.snapshot.variables.causal_drawdown_per_unit,'0');assert.equal(e.snapshot.variables.realized_plus_remaining_net,D('.12').plus(e.snapshot.variables.net_liquidation).toString());assert.equal(e.snapshot.variables.quantity,'1.5');
});
test('future/stale/wrong-symbol observations are unavailable, and corrupt optional cursors degrade only research',()=>{
 const p=position(),signed=structuredClone(p.plan);assert.equal(capture(p,T+10000,{quote:quote(T+1000)}),null);assert.equal(capture(p,T+1000,{quote:{...quote(T+1000),symbol:'BTC/USD'}}),null);assert.equal(capture(p,T+1000,{quote:quote(T+1500)}),null);
 capture(p,T+1000);p.exit_advisory.ewma_return=NaN;assert.equal(capture(p,T+2000),null);assert.equal(p.exit_advisory_status.status,'DEGRADED');assert.deepEqual(p.plan,signed);assert.equal(p.exit_intent,undefined);
 const bad=position();bad.plan.exit_policy.mode='LIVE';assert.throws(()=>capture(bad,T+1000),/PAPER_ONLY/);
});
test('separate timeframe/exit domains cannot reuse an old entry-return predictor',()=>{
 const p=position(),a=capture(p,T+1000).snapshot;
 const slower=position();slower.plan.timeframe=240;Object.assign(slower.plan,makeProfitContracts(EARLY_PROFIT_POLICY,{timeframe:240}));slower.plan.holding_ms=slower.plan.exit_policy.base_holding_ms;delete slower.profit_protection;slower.expires_at=T+slower.plan.holding_ms;initializeProfitProtection(slower,T);const b=capture(slower,T+1000).snapshot;assert.notEqual(a.domain_hash,b.domain_hash);assert.equal(b.domain.timeframe,240);assert.equal(b.action.advisory_prediction,null);assert.equal(b.evaluation.label,null);
});
