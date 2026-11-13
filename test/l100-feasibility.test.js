// All capital, positions, quotes and targets below are SYNTHETIC, not AWS data.
import test from 'node:test';
import assert from 'node:assert/strict';
import {D} from '../lib/trading/core.js';
import {diagnoseL100Feasibility,l100CycleView} from '../lib/trading/l100-feasibility.js';
import {PROFIT_POLICY,makeProfitContracts} from '../lib/trading/secondary-profit-policy.js';
import {EXPLORATION_POLICY,explorationContract} from '../lib/trading/secondary-exploration.js';
import {SECONDARY_MODEL,secondaryEstimate} from '../lib/trading/secondary-futures-math.js';
import {RISK_BUDGET_POLICY} from '../lib/trading/secondary-risk-budget.js';

const T=Date.parse('2026-11-13T10:00:00Z');
const quote=()=>({source:'KRAKEN_FUTURES_WS_TICKER',symbol:'PF_XBTUSD',event_at:T,received_at:T,
 bid:'99.98',ask:'100',bid_qty:'100000',ask_qty:'100000'});
const plan=(direction='LONG')=>({id:'synthetic-l100',direction,timeframe:15,
 entry:direction==='LONG'?'100.02':'99.960004',target:direction==='LONG'?'102':'98',
 stop:direction==='LONG'?'99':'101',execution_model:SECONDARY_MODEL,
 execution_contract:{...explorationContract(EXPLORATION_POLICY,'BREAKOUT',T),
  risk_budget:{policy:structuredClone(RISK_BUDGET_POLICY)}},
 economics:{fundingAllowance:'0.01'},...makeProfitContracts(PROFIT_POLICY),
 sizing:{qty:'1',qty_step:'0.001',target_net:'1.8'}});
const bounds=()=>({source:'SYNTHETIC_EXISTING_BUDGET',at:T,revision:1,leverage:2,
 risk_available_usd:'1000',margin_available_usd:'10000',free_cash_usd:'10000',
 gross_exposure_available_usd:'20000',observed_entry_quantity:'1000',reference_exposure_cap_usd:'20000'});
const diagnose=(p=plan(),changes={})=>diagnoseL100Feasibility(p,{quote:quote(),now:T,fundingRate:'0.02',bounds:bounds(),...changes});

for(const direction of ['LONG','SHORT']) test(direction+' conditional structural target rounds up to a lot without raising any bounds',()=>{
 const p=plan(direction),b=bounds(),q=quote(),before=structuredClone({p,b,q});
 const r=diagnoseL100Feasibility(p,{quote:q,now:T,fundingRate:'0.02',bounds:b});
 assert.equal(r.status,'CONDITIONALLY_FEASIBLE');assert.equal(r.target_achievable_in_scenario,true);
 assert(D(r.compatible_target_net).gte('100'));assert(D(r.selected_quantity).div(p.sizing.qty_step).isInteger());
 assert(D(r.selected_quantity).minus(p.sizing.qty_step).mul(r.economics.expected_net_target).lt('100'));
 assert(D(r.reserved_cash).lte(b.free_cash_usd));assert(D(r.expected_loss_with_stress).lte(b.risk_available_usd));
 assert.equal(r.authority,'NONE');assert.equal(r.order_created,false);assert.equal(r.probability,null);
 assert.equal(r.target_is_exit_veto,false);assert.equal(r.budget_verified_in_runtime,false);
 assert.deepEqual({p,b,q},before);
});

test('target incompatible with fixed risk returns a smaller scenario and preserves exploration',()=>{
 const b={...bounds(),risk_available_usd:'2'},r=diagnose(plan(),{bounds:b});
 assert.equal(r.status,'TARGET_REDUCED');assert.equal(r.target_achievable_in_scenario,false);
 assert(D(r.compatible_target_net).gt(0));assert(D(r.compatible_target_net).lt(100));
 assert(D(r.expected_loss_with_stress).lte(2));assert(r.limiting_factors.includes('risk'));
 assert.equal(r.exploration_unchanged,true);assert.equal(r.budget_may_increase,false);
});

for (const field of ['margin_available_usd','free_cash_usd','gross_exposure_available_usd','observed_entry_quantity','reference_exposure_cap_usd'])
 test(field+' bounds the rounded hypothetical quantity independently',()=>{
  const b=bounds();b[field]=field==='observed_entry_quantity'?'0.005':'1';
  const r=diagnose(plan(),{bounds:b});
  assert.equal(r.status,'TARGET_REDUCED');assert(D(r.selected_quantity).lt('1'));
  assert(D(r.selected_quantity).div('.001').isInteger());
 });

test('available entry book remains a bound even if caller supplies greater quantity',()=>{
 const q={...quote(),ask_qty:'0.1'},r=diagnose(plan(),{quote:q});
 assert(D(r.selected_quantity).lte(D(q.ask_qty).mul(plan().execution_contract.participation)));
 assert.equal(r.status,'TARGET_REDUCED');
});

test('missing, stale and future budget snapshots are unknown rather than zero or unlimited',()=>{
 for(const b of [null,{...bounds(),risk_available_usd:null},{...bounds(),free_cash_usd:''},
  {...bounds(),at:T-5001},{...bounds(),at:T+1}]){
  const r=diagnose(plan(),{bounds:b});assert.equal(r.status,'NOT_EVALUABLE');
  assert.equal(r.compatible_target_net,null);assert.equal(r.selected_quantity,null);
 }
});

test('changed leverage is not used to make the monetary target feasible',()=>{
 const r=diagnose(plan(),{bounds:{...bounds(),leverage:10}});
 assert.equal(r.reason,'LEVERAGE_DIFFERS_FROM_EXISTING_CONTRACT');assert.equal(r.selected_quantity,null);
});

test('stale or wrong-market quotes cannot support objective feasibility',()=>{
 for(const q of [{...quote(),event_at:T-5001},{...quote(),symbol:'BTC/USD'}, {...quote(),received_at:T+1}])
  assert.equal(diagnose(plan(),{quote:q}).reason,'FUTURES_DATA_NOT_FRESH');
});

test('new entry uses current executable BBO rather than a more favorable old plan price',()=>{
 const p=plan();p.entry='90';
 const r=diagnose(p);assert.equal(r.economics.estimated_entry_price,'100.02');
 assert.equal(r.economics.expected_net_target,diagnose().economics.expected_net_target);
 const changed=diagnose(plan(),{quote:{...quote(),bid:'102',ask:'102.02'}});
 assert.equal(changed.status,'NOT_EVALUABLE');assert.equal(changed.reason,'INVALID_STRUCTURAL_BARRIERS');
});

test('malformed execution participation is rejected as unknown before sizing',()=>{
 for(const value of [null,'0','2','NaN']){
  const p=plan();p.execution_contract.participation=value;
  assert.equal(diagnose(p).reason,'EXECUTION_PARTICIPATION_INVALID');
 }
});

test('negative or near-zero net after actual cost model never produces unlimited size',()=>{
 const p=plan();p.target='100.021';
 const bad=diagnose(p);assert.equal(bad.status,'TARGET_NOT_SUPPORTED_AFTER_COSTS');assert.equal(bad.required_quantity,null);
 p.target='100.16';const thin=diagnose(p);
 assert.equal(thin.status,'EXISTING_POLICY_OR_CAPACITY_REJECTS');
 assert(D(thin.selected_quantity).lte(thin.max_quantity));
 assert.equal(thin.entry_policy_accepted,false);
});

test('unresolved funding or missing original lot is not substituted with zero',()=>{
 assert.equal(diagnose(plan(),{fundingRate:null}).status,'NOT_EVALUABLE');
 const p=plan();delete p.economics.fundingAllowance;
 assert.equal(diagnose(p,{fundingRate:undefined}).status,'NOT_EVALUABLE');
 delete p.sizing.qty_step;assert.equal(diagnose(p).reason,'SIGNED_SIZE_OR_LOT_MISSING');
});

test('diagnostics reserve nothing: two simultaneous reports cannot claim atomic admission',()=>{
 const b=bounds(),before=structuredClone(b),first=diagnose(plan(),{bounds:b}),second=diagnose(plan(),{bounds:b});
 assert.equal(first.selected_quantity,second.selected_quantity);assert.deepEqual(b,before);
 for(const r of [first,second]){assert.equal(r.reservation_atomicity_verified,false);assert.match(r.reservation_status,/NOT_RESERVED/);}
});

const position=()=>({plan:plan(),qty:'1',entry:'100.02',entry_fee:'0.05001',accrued_funding:'-0.02',
 closed_qty:'0.5',closed_funding_pending:[],funding_pending:[],realized:{net:'99.9'}});
test('partial realized net plus remaining valuation is one cycle; received funding retains its sign',()=>{
 const p=position(),q={...quote(),bid:'101',ask:'101.02'},r=l100CycleView(p,{quote:q,now:T}),v=secondaryEstimate(p,q,T);
 assert.equal(r.realized_net,'99.9');assert.equal(r.remaining_net_estimate,v.net);
 assert.equal(r.cycle_net_estimate,D('99.9').plus(v.net).toString());
 assert.equal(r.target_reached_estimated,true);assert.equal(r.target_realized,false);assert.equal(r.result_final,false);
 assert.equal(v.funding,'-0.02');assert.equal(r.target_net_usd,'100');
});

test('expired remaining price preserves confirmed partials without presenting current cycle net',()=>{
 const r=l100CycleView(position(),{quote:quote(),now:T+5001});
 assert.equal(r.realized_net,'99.9');assert.equal(r.remaining_net_estimate,null);assert.equal(r.cycle_net_estimate,null);
 assert.equal(r.target_reached_estimated,null);
});

test('final CLOSED total already aggregates partials and is not summed twice',()=>{
 const r=l100CycleView({type:'CLOSED',id:'synthetic',pnl:'100.01234567890123456',
  result_final:true,funding_complete:true,realized:{net:'99.9'}});
 assert.equal(r.realized_net,'100.01234567890123456');assert.equal(r.target_realized,true);
 assert.equal(r.cycle_net_estimate,null);assert.equal(r.result_final,true);
});

test('unresolved final funding and missing partial history stay explicitly unknown',()=>{
 const pending=l100CycleView({type:'CLOSED',pnl:'101',result_final:false,funding_complete:false});
 assert.equal(pending.realized_net,null);assert.equal(pending.provisional_realized_net,'101');assert.equal(pending.target_realized,null);
 const p=position();delete p.realized;
 const r=l100CycleView(p,{quote:quote(),now:T});assert.equal(r.realized_net,null);assert.equal(r.cycle_net_estimate,null);
});

test('target is configurable and validates finite positive decimal values',()=>{
 for(const value of [null,0,-1,'NaN','Infinity',true,''])assert.throws(()=>diagnose(plan(),{targetNetUSD:value}),/L100_TARGET_INVALID/);
 const r=diagnose(plan(),{targetNetUSD:'0.1'});assert.equal(r.target_net_usd,'0.1');assert(D(r.compatible_target_net).gte('.1'));
});
