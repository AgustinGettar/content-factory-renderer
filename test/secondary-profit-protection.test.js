// Isolated, deterministic PAPER state-machine fixtures. No exchange, live
// portfolio, worker, SQLite state or notifications are used by this test file.
import test from 'node:test';
import assert from 'node:assert/strict';
import {D} from '../lib/trading/core.js';
import {SECONDARY_MODEL,secondaryEstimate} from '../lib/trading/secondary-futures-math.js';
import {PROFIT_POLICY,PROFIT_ENTRY_REVISION,makeProfitContracts} from '../lib/trading/secondary-profit-policy.js';
import {initializeProfitProtection,validateProfitProtection,evaluateProfitProtection,markProfitExitPending,scaleProfitProtection,markProfitClosed} from '../lib/trading/secondary-profit-protection.js';

const T=Date.parse('2026-11-02T12:00:00Z');
const clone=x=>JSON.parse(JSON.stringify(x));
const nearly=(a,b)=>assert(D(a).minus(b).abs().lte('0.000000000001'),`${a} != ${b}`);
function position({id='one',direction='LONG',entry='100',qty='1',target,policy=PROFIT_POLICY,legacy=false}={}){
 const p={plan:{id,execution_model:SECONDARY_MODEL,entry_revision:PROFIT_ENTRY_REVISION,direction,pattern:'PULLBACK',target:target??(direction==='LONG'?'100.3':'99.7'),stop:direction==='LONG'?'99':'101',holding_ms:policy.base_holding_ms,
  execution_contract:{slippage:'0.0002',takerFee:'0.0005',participation:'0.1'},sizing:{target_net:'.5'},...(legacy?{}:makeProfitContracts(policy))},
  entry,qty,entry_fee:D(entry).mul(qty).mul('.0005').toString(),accrued_funding:'0',funding_pending:[],closed_funding_pending:[],quality:'OBSERVED',entered_at:T,expires_at:T+policy.base_holding_ms};
 if(!legacy)initializeProfitProtection(p,T);
 return p;
}
function quote(p,at,overrides={}){
 const target=D(p.plan.target),bid=p.plan.direction==='LONG'?target.plus('.1'):target.minus('.11');
 return {source:'KRAKEN_FUTURES_WS_TICKER',symbol:'PF_XBTUSD',event_at:at,received_at:at,bid:bid.toString(),ask:bid.plus('.01').toString(),bid_qty:'100',ask_qty:'100',suspended:false,...overrides};
}
// Exact synthetic net values exercise the pure state transitions separately
// from the real cost/BBO valuation tests below. They never enter a live ledger.
function step(p,net,at,options={}){
 const q=options.quote??quote(p,at),v={...secondaryEstimate(p,q,at),net:String(net),fresh:true,quote_at:q.event_at,side:p.plan.direction==='LONG'?'bid':'ask',funding_complete:options.fundingComplete??!p.funding_pending.length,result_final:options.fundingComplete??!p.funding_pending.length};
 return evaluateProfitProtection(p,q,v,at,{availableQty:options.availableQty??p.qty});
}
function intent(p,reason,at){
 p.exit_intent={reason,decided_at:at,evidence_at:at,evidence_received_at:at,trigger_price:p.plan.target,not_before:at+1000,valid_until:null};
 markProfitExitPending(p,p.exit_intent);return p.exit_intent;
}
function quoteForNet(p,net,at,spread='.01'){
 const short=p.plan.direction==='SHORT',fee=D(p.plan.execution_contract.takerFee),slip=D(p.plan.execution_contract.slippage),qty=D(p.qty),cost=D(p.entry_fee).plus(p.accrued_funding).plus(net);
 const executable=short?D(p.entry).mul(qty).minus(cost).div(qty.mul(D(1).plus(fee))):D(p.entry).mul(qty).plus(cost).div(qty.mul(D(1).minus(fee)));
 const raw=executable.div(short?D(1).plus(slip):D(1).minus(slip));
 return quote(p,at,short?{ask:raw.toString(),bid:raw.minus(spread).toString()}:{bid:raw.toString(),ask:raw.plus(spread).toString()});
}

test('legacy contracts bypass every helper without changing historical positions',()=>{
 const p=position({legacy:true}),before=clone(p),q=quote(p,T+1000);
 assert.equal(initializeProfitProtection(p,T+1000),null);
 assert.equal(validateProfitProtection(p),false);
 assert.deepEqual(evaluateProfitProtection(p,q,secondaryEstimate(p,q,T+1000),T+1000,{availableQty:'1'}),{events:[],reason:null,blocker:null,activated:false});
 assert.equal(markProfitExitPending(p,{reason:'STRUCTURAL_TARGET'}),null);
 assert.equal(scaleProfitProtection(p,'1','.5',T+1000),null);
 assert.equal(markProfitClosed(p,T+1000),null);
 assert.deepEqual(p,before);
});

test('resume validates new state and rejects missing state or corrupted maxima, quantity, deadlines or intents',()=>{
 const p=position();step(p,'.2',T+1000);step(p,'.8',T+2000);
 const resumed=clone(p);assert.equal(validateProfitProtection(resumed),true);assert.deepEqual(resumed,p);
 for(const mutate of [x=>delete x.profit_protection,x=>x.profit_protection.peak_net='.81',x=>x.profit_protection.protected_net='.59',x=>x.profit_protection.basis_qty='.5',x=>x.profit_protection.effective_expires_at++,x=>x.profit_protection.stagnation_deadline_at++,x=>x.profit_protection.required_activation_net='.1']){
  const bad=clone(p);mutate(bad);assert.throws(()=>validateProfitProtection(bad),/SECONDARY_PROFIT_PROTECTION_STATE/);
 }
 intent(p,'TRAILING_RETRACEMENT',T+3000);const bad=clone(p);bad.exit_intent.not_before++;assert.throws(()=>validateProfitProtection(bad),/STATE_INTEGRITY/);
});

for(const direction of ['LONG','SHORT'])test(`${direction} uses the correct executable BBO, all liquidation costs and original structural target to activate without closing`,()=>{
 const p=position({direction,entry:'80000',qty:'.0012',target:direction==='LONG'?'80300':'79700'}),planBefore=clone(p.plan);
 p.accrued_funding='.005';
 const wrongSide=quote(p,T+1000,direction==='LONG'?{bid:'80299',ask:'80301'}:{bid:'79699',ask:'79701'});
 assert.equal(step(p,'.5',T+1000,{quote:wrongSide}).activated,false);
 const q=quote(p,T+2000,direction==='LONG'?{bid:'80350',ask:'80351'}:{bid:'79649',ask:'79650'}),v=secondaryEstimate(p,q,T+2000),result=evaluateProfitProtection(p,q,v,T+2000,{availableQty:p.qty});
 assert.equal(result.activated,true);assert.equal(result.reason,null);assert.equal(result.events.length,1);assert.equal(result.events[0].type,'TARGET_REACHED');
 assert.equal(p.profit_protection.state,'TRAILING_ACTIVE');nearly(p.profit_protection.activation_net,v.net);nearly(p.profit_protection.required_activation_net,'.192');
 nearly(D(v.gross).minus(v.entry_cost).minus(v.exit_fee).minus(v.funding),v.net);assert(D(v.slippage_cost).gt(0));
 assert.equal(p.exit_intent,undefined);assert.equal(p.qty,'.0012');assert.deepEqual(p.plan,planBefore);
});

test('the specified .20 → .50 → .80 net path protects .60 and a retracement requests a durable exit',()=>{
 const p=position();assert.equal(step(p,'.2',T+1000).activated,true);
 assert.equal(p.profit_protection.peak_net,'0.2');assert.equal(p.profit_protection.protected_net,'0.15');
 step(p,'.5',T+2000);assert.equal(p.profit_protection.protected_net,'0.375');
 step(p,'.8',T+3000);assert.equal(p.profit_protection.peak_net,'0.8');assert.equal(p.profit_protection.protected_net,'0.6');assert.equal(p.profit_protection.retracement_allowance,'0.2');
 assert.equal(step(p,'.7',T+4000).reason,null);assert.equal(p.profit_protection.protected_net,'0.6');assert.equal(p.profit_protection.current_retracement,'0.1');
 assert.equal(step(p,'.6',T+5000).reason,'TRAILING_RETRACEMENT');intent(p,'TRAILING_RETRACEMENT',T+5000);
 const pending=clone(p.profit_protection);markProfitExitPending(p,p.exit_intent);assert.deepEqual(p.profit_protection,pending);
 for(const net of ['1.4','-.3'])assert.equal(step(p,net,T+6000,{fundingComplete:false}).reason,'TRAILING_RETRACEMENT');
 assert.deepEqual(p.profit_protection,pending);assert.equal(p.profit_protection.exit_intent.not_before,T+6000);
});

test('fresh, causal evidence must be new; duplicate, out-of-order, stale and wrong-instrument quotes cannot invent maxima',()=>{
 const p=position();step(p,'.2',T+2000);const initial=clone(p.profit_protection);
 assert.equal(step(p,'9',T+2000).activated,false);assert.deepEqual(p.profit_protection,initial);
 assert.equal(step(p,'9',T+2001,{quote:{...quote(p,T+2000),received_at:T+2001}}).reason,null);assert.equal(p.profit_protection.peak_net,'0.2');
 assert.equal(step(p,'9',T+3000,{quote:quote(p,T+1000)}).blocker,'TRAILING_QUOTE_OUT_OF_ORDER');
 for(const q of [{...quote(p,T+4000),symbol:'BTC/USD'},quote(p,T+1000),{...quote(p,T+7000),received_at:T+8000},{...quote(p,T+7500),received_at:T+5000}]){
  assert.equal(step(p,'9',T+7000,{quote:q}).blocker,'TRAILING_MARKET_DATA_UNUSABLE');assert.equal(p.profit_protection.peak_net,'0.2');
 }
 assert.equal(p.profit_protection.peak_at,T+2000);assert.equal(p.profit_protection.stagnation_deadline_at,T+602000);
});

test('activation and later peak retain executable evidence; a corrupt checksum fails resume and repeated quotes cannot replace it',()=>{
 const p=position();step(p,'.2',T+1000);const activation=clone(p.profit_protection.activation_evidence);
 step(p,'.8',T+2000);const peak=clone(p.profit_protection.peak_evidence);
 assert.equal(peak.quote.event_at,T+2000);assert.equal(peak.valuation.net,'.8');assert.equal(peak.valuation.quantity,'1');assert.equal(peak.valuation.side,'bid');assert.equal(peak.valuation.funding_complete,true);assert.equal(peak.available_qty,'1');assert(peak.quote_hash);assert(peak.hash);
 assert.deepEqual(p.profit_protection.activation_evidence,activation);assert.notEqual(peak.hash,activation.hash);assert.equal(validateProfitProtection(clone(p)),true);
 step(p,'5',T+2000);assert.deepEqual(p.profit_protection.peak_evidence,peak);
 for(const mutate of [x=>x.profit_protection.peak_evidence.hash='0'.repeat(64),x=>x.profit_protection.peak_evidence.quote.bid='1000',x=>x.profit_protection.activation_evidence.valuation.net='1']){
  const bad=clone(p);mutate(bad);assert.throws(()=>validateProfitProtection(bad),/STATE_INTEGRITY/);
 }
});

test('target without sufficient net, resolved funding or full shared capacity records one persistent issue and can recover',()=>{
 const p=position(),first=step(p,'.01677',T+1000);assert.equal(first.activated,false);assert.equal(first.events[0].type,'TARGET_REACHED_NET_INSUFFICIENT');
 assert.equal(first.blocker,'NET_BELOW_ACTIVATION_MINIMUM');assert.equal(p.profit_protection.target_net_insufficient.net,'.01677');
 assert.equal(p.profit_protection.target_net_insufficient.required_net,'0.2');assert.equal(p.profit_protection.effective_expires_at,p.expires_at);
 assert.equal(step(p,'-.02563',T+2000).events.length,0);assert.equal(step(p,'-.06048',T+3000).events.length,0);
 assert.equal(step(p,'.8',T+4000,{fundingComplete:false}).blocker,'FUNDING_UNRESOLVED');
 assert.equal(step(p,'.8',T+5000,{availableQty:'.5'}).blocker,'EXECUTABLE_LIQUIDITY_INSUFFICIENT');
 assert.equal(step(p,'.8',T+6000,{quote:{...quote(p,T+6000),post_only:true}}).blocker,'EXECUTABLE_LIQUIDITY_INSUFFICIENT');
 const activation=step(p,'.8',T+7000);assert.equal(activation.activated,true);assert.equal(activation.events.length,1);assert.equal(p.profit_protection.activation_blocker,null);
 assert.equal(p.profit_protection.target_net_insufficient.at,T+1000);assert.equal(p.profit_protection.target_net_insufficient.net,'.01677');
});

test('insufficient liquidity blocks activation/peaks but does not block the retracement decision',()=>{
 const p=position();assert.equal(step(p,'.8',T+1000,{availableQty:'0'}).activated,false);
 step(p,'.8',T+2000);const peakAt=p.profit_protection.peak_at;
 assert.equal(step(p,'1.2',T+3000,{availableQty:'.5'}).blocker,'TRAILING_PEAK_LIQUIDITY_INSUFFICIENT');assert.equal(p.profit_protection.peak_net,'0.8');assert.equal(p.profit_protection.peak_at,peakAt);
 assert.equal(step(p,'.59',T+4000,{availableQty:'0'}).reason,'TRAILING_RETRACEMENT');
});

test('partial exits scale only the remaining exposure; unit peaks/protection and the original activation audit survive restart',()=>{
 const p=position({entry:'80000',qty:'.00125',target:'80300'});step(p,'.2',T+1000);step(p,'.8',T+2000);intent(p,'TRAILING_RETRACEMENT',T+3000);
 p.realized={net:'100'};p.closed_qty='.00075';p.qty='.0005';
 const e=scaleProfitProtection(p,'.00125','.0005',T+4000);assert.equal(e.type,'TRAILING_QUANTITY_SCALED');assert.equal(e.realized_profit_excluded,true);assert.equal(e.quantity_ratio,'0.4');
 assert.equal(p.profit_protection.state,'PARTIALLY_CLOSED');assert.equal(p.profit_protection.peak_net,'0.32');assert.equal(p.profit_protection.protected_net,'0.24');assert.equal(p.profit_protection.last_net,'0.32');
 assert.equal(p.profit_protection.peak_net_per_unit,'640');assert.equal(p.profit_protection.protected_net_per_unit,'480');assert.equal(p.profit_protection.activation_net_original,'.2');assert.equal(p.profit_protection.activation_net,'0.08');
 assert.equal(p.profit_protection.required_activation_net,'0.08');assert.equal(p.profit_protection.effective_expires_at,T+2700000);
 const saved=clone(p);assert.equal(scaleProfitProtection(p,'.00125','.0005',T+5000),null);assert.deepEqual(p,saved);assert.equal(validateProfitProtection(clone(p)),true);
 assert.equal(step(p,'-.3',T+6000,{availableQty:'0',fundingComplete:false}).reason,'TRAILING_RETRACEMENT');assert.equal(p.profit_protection.peak_net,'0.32');
 markProfitClosed(p,T+7000);assert.equal(p.profit_protection.state,'CLOSED');assert.equal(p.profit_protection.remaining_qty,'0');assert.equal(validateProfitProtection(p),true);
 const closed=clone(p);markProfitClosed(p,T+8000);assert.deepEqual(p,closed);
});

test('additional maker entry fragments update pre-target basis without extending time; activated contracts reject additions',()=>{
 const p=position({qty:'.4'});step(p,'.03',T+500);p.qty='.7';p.entry='100.01';initializeProfitProtection(p,T+1000);
 assert.equal(p.profit_protection.basis_qty,'.7');assert.equal(p.profit_protection.required_activation_net,'0.140014');assert.equal(p.profit_protection.base_expires_at,T+1800000);
 assert.equal(p.profit_protection.last_net,null);assert.equal(p.profit_protection.last_valid_quote_at,T+500);assert.equal(p.profit_protection.target_net_insufficient.required_qty,'.4');
 step(p,'.2',T+2000);const bad=clone(p);bad.qty='.8';assert.throws(()=>initializeProfitProtection(bad,T+3000),/STATE_INTEGRITY/);
});

test('bounded target extension and stagnation survive restart and cannot be extended indefinitely by ticks or new peaks',()=>{
 const p=position(),base=p.expires_at;
 assert.equal(step(p,'.2',base).activated,true);assert.equal(p.profit_protection.effective_expires_at,base+900000);
 const restored=clone(p);initializeProfitProtection(restored,base+1000);assert.deepEqual(restored,p);
 assert.equal(step(restored,'.21',base+100000).reason,null);assert.equal(restored.profit_protection.effective_expires_at,base+900000);
 assert.equal(step(restored,'.2',base+699999).reason,null);assert.equal(step(restored,'.2',base+700000).reason,'TRAILING_STAGNATION');
 const later=clone(p);step(later,'.3',base+899000);assert.equal(later.profit_protection.effective_expires_at,base+900000);assert.equal(step(later,'.4',base+900000).reason,'TIMEOUT_EXTENDED');
 const missed=position();assert.equal(step(missed,'.8',missed.expires_at+1).reason,'TIMEOUT');assert.equal(missed.profit_protection.trailing_activated_at,null);
 const noTarget=position();assert.equal(step(noTarget,'-.1',noTarget.expires_at,{quote:quote(noTarget,noTarget.expires_at,{bid:'100',ask:'100.01'})}).reason,'TIMEOUT');
});

test('uncertain funding freezes peaks/net retracement decisions, while mandatory deadlines and durable exits remain possible',()=>{
 const p=position();step(p,'.4',T+1000);const peak=clone(p.profit_protection);
 assert.equal(step(p,'2',T+2000,{fundingComplete:false}).blocker,'TRAILING_FUNDING_UNRESOLVED');assert.equal(p.profit_protection.peak_net,peak.peak_net);
 assert.equal(step(p,'-.2',T+3000,{fundingComplete:false}).reason,null);assert.equal(p.profit_protection.protected_net,peak.protected_net);
 assert.equal(step(p,'-.2',T+4000,{fundingComplete:true}).reason,'TRAILING_RETRACEMENT');
 const before=position();assert.equal(step(before,'-.2',before.expires_at,{fundingComplete:false}).reason,'TIMEOUT');
 assert.equal(step(p,'-.2',T+601000,{fundingComplete:false}).reason,'TRAILING_STAGNATION');
 assert.equal(step(p,'-.2',T+2700000,{fundingComplete:false}).reason,'TIMEOUT_EXTENDED');
 intent(p,'STOP',T+2700000);assert.equal(step(p,'-.2',T+2701000,{fundingComplete:false}).reason,'STOP');
});

test('data gaps retain only the observed maximum and preserve explicit uncertainty after recovery',()=>{
 const p=position();step(p,'.4',T+1000);const peakAt=p.profit_protection.peak_at;
 p.quality='UNRESOLVED_MARKET_GAP';p.data_gaps=[{from:T+1000,to:null,reason:'TEST_ISOLATED_DATA_GAP'}];
 assert.equal(step(p,'9',T+20000,{quote:quote(p,T+1000)}).blocker,'TRAILING_MARKET_DATA_UNUSABLE');assert.equal(p.profit_protection.peak_net,'0.4');
 const recovered=clone(p);recovered.data_gaps[0].to=T+21000;step(recovered,'.35',T+21000);
 assert.equal(recovered.profit_protection.peak_at,peakAt);assert.equal(recovered.profit_protection.peak_net,'0.4');assert.equal(recovered.quality,'UNRESOLVED_MARKET_GAP');assert.equal(recovered.profit_protection.last_data_quality,'UNRESOLVED_MARKET_GAP');assert.equal(recovered.data_gaps.length,1);
});

test('four independent positions: one activates and closes without mutating the other three',()=>{
 const all=[position({id:'first'}),position({id:'second',direction:'SHORT'}),position({id:'third',target:'105'}),position({id:'fourth',target:'106'})],others=clone(all.slice(1));
 step(all[0],'.4',T+1000);assert.equal(all[0].profit_protection.state,'TRAILING_ACTIVE');assert.deepEqual(all.slice(1),others);
 step(all[0],'.8',T+2000);assert.equal(step(all[0],'.5',T+3000).reason,'TRAILING_RETRACEMENT');intent(all[0],'TRAILING_RETRACEMENT',T+3000);markProfitClosed(all[0],T+4000);
 assert.equal(all[0].profit_protection.state,'CLOSED');assert.deepEqual(all.slice(1),others);assert.equal(all.filter(p=>p.profit_protection.state!=='CLOSED').length,3);
});

test('shared targets activate independent protection; only each position’s own retracement requests its exit',()=>{
 const p=position({id:'early'}),r=position({id:'later'}),q=quote(p,T+1000);
 step(p,'.8',T+1000,{quote:q});step(r,'.25',T+1000,{quote:q});assert.equal(p.profit_protection.state,'TRAILING_ACTIVE');assert.equal(r.profit_protection.state,'TRAILING_ACTIVE');
 assert.equal(p.profit_protection.protected_net,'0.6');assert.equal(r.profit_protection.protected_net,'0.1875');
 const rBefore=clone(r);assert.equal(step(p,'.59',T+2000).reason,'TRAILING_RETRACEMENT');intent(p,'TRAILING_RETRACEMENT',T+2000);assert.deepEqual(r,rBefore);
 assert.equal(step(r,'.20',T+2000).reason,null);assert.equal(r.profit_protection.state,'TRAILING_ACTIVE');markProfitClosed(p,T+3000);assert.equal(r.profit_protection.state,'TRAILING_ACTIVE');
 assert.equal(step(r,'.18',T+4000).reason,'TRAILING_RETRACEMENT');
});

test('a before-target mandatory stop can become pending and close independently of net profit',()=>{
 const p=position();intent(p,'STOP',T+1000);assert.equal(p.profit_protection.state,'EXIT_PENDING');assert.equal(p.profit_protection.trailing_activated_at,null);
 const restored=clone(p);assert.equal(validateProfitProtection(restored),true);assert.equal(step(restored,'-.5',T+2000,{fundingComplete:false}).reason,'STOP');markProfitClosed(restored,T+3000);assert.equal(restored.profit_protection.state,'CLOSED');
});

test('isolated spread-noise sensitivity retains the explicit 25% rule without tuning the policy',()=>{
 const p=position(),q=quoteForNet(p,'.21',T+1000),v=secondaryEstimate(p,q,T+1000),originalPolicy=clone(p.plan.exit_policy);
 const initial=evaluateProfitProtection(p,q,v,T+1000,{availableQty:'1'});assert.equal(initial.activated,true);nearly(p.profit_protection.retracement_allowance,'.0525');
 // Keep midpoint unchanged: spread widens from .01 to .03, then to .13.
 // Net execution moves through bid, fees and slippage, not LAST/mid price.
 const minor={...q,event_at:T+2000,received_at:T+2000,bid:D(q.bid).minus('.01').toString(),ask:D(q.ask).plus('.01').toString()},minorV=secondaryEstimate(p,minor,T+2000);
 assert.equal(evaluateProfitProtection(p,minor,minorV,T+2000,{availableQty:'1'}).reason,null);nearly(D(v.net).minus(minorV.net),'.009993001');
 const wide={...q,event_at:T+3000,received_at:T+3000,bid:D(q.bid).minus('.06').toString(),ask:D(q.ask).plus('.06').toString()},wideV=secondaryEstimate(p,wide,T+3000);
 assert.equal(evaluateProfitProtection(p,wide,wideV,T+3000,{availableQty:'1'}).reason,'TRAILING_RETRACEMENT');nearly(D(v.net).minus(wideV.net),'.059958006');
 assert.deepEqual(p.plan.exit_policy,originalPolicy);nearly(p.profit_protection.peak_net,'.21');nearly(p.profit_protection.protected_net,'.1575');
});
