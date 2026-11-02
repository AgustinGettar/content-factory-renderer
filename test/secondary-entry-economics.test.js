// Isolated cost/admission regression fixtures. No worker, account writes or orders.
import test from 'node:test';
import assert from 'node:assert/strict';
import {D,hash} from '../lib/trading/core.js';
import {evaluateEntryEconomics} from '../lib/trading/secondary-entry-economics.js';
import {PROFIT_POLICY,PROFIT_ENTRY_REVISION,makeProfitContracts} from '../lib/trading/secondary-profit-policy.js';
import {EXPLORATION_POLICY,explorationContract} from '../lib/trading/secondary-exploration.js';

const T=Date.parse('2026-11-02T06:30:00Z');
const quote=(bid='99.98',ask='100',now=T)=>({source:'KRAKEN_FUTURES_WS_TICKER',symbol:'PF_XBTUSD',event_at:now,received_at:now,bid,ask,bid_qty:'100',ask_qty:'100'});
function plan(overrides={}){
 return {id:'isolated-economic-fixture',pattern:'BREAKOUT',direction:'LONG',entry:'100.02',target:'101',stop:'99',entry_revision:PROFIT_ENTRY_REVISION,holding_ms:1800000,
  execution_contract:explorationContract(EXPLORATION_POLICY,'BREAKOUT',T-1000),...makeProfitContracts(PROFIT_POLICY),...overrides};
}
const evaluate=(p=plan(),options={})=>evaluateEntryEconomics(p,{quote:quote(),qty:'1',fundingRate:0,now:T,...options});
const closeTo=(actual,expected,tolerance='0.000000000001')=>assert(D(actual).minus(expected).abs().lte(tolerance),`${actual} differs from ${expected}`);

// Reduced immutable values from PAPER ledger events at 2026-11-02T06:19:10.153Z.
// These are input regressions for a NEW contract; historical rows are never modified.
const historicalCases=[
 {event_id:'c67eec860e09217667037ecb40d7e50dce1dd99027573ae9bbcaa8690eb04b90',operation_id:'8a746e37232b11518a3d3153b4cf0e10a751e4eb2922f258c0d1318f13f123fe',entry:'78246',stop:'78370',fundingAllowance:'0.19794040699607554',target_net:'0.01676957495160471',exposure:'93.8952',fill:'78239.349',raw_fill_bid:'78255',realized:'0.012783540845059333039'},
 {event_id:'db4236317555c73a97a1f9f42f641d1db1f2f6ca8b3d05dbc8b7063269fa9fc2',operation_id:'95ec2504d96818dbda6327460a5a89518229262e29c7d4ed97b22ece679e3a71',entry:'78207',stop:'78323',fundingAllowance:'0.23740484246875',target_net:'-0.0300543823709625',exposure:'93.8484',fill:'78207.3554',raw_fill_bid:'78223',realized:'-0.025629312009909663277'},
 {event_id:'604358fcb8e2a74d761c98dda638f0823327c9dd56e957cdc0bfb8ba35d3f1ea',operation_id:'fc2c1bf06e364d1c608dadc687b2bcc5e4527356cff2e2d5e11da05b2d97fbf5',entry:'78184',stop:'78302',fundingAllowance:'0.2975013100125',target_net:'-0.057712698132015',exposure:'93.8208',fill:'78178.3612',raw_fill_bid:'78194',realized:'-0.060483883831318534412'},
];
for(const recorded of historicalCases)test('real PAPER shared-target case '+recorded.operation_id.slice(0,12)+' cannot pass the useful-net minimum',()=>{
 const p=plan({id:recorded.operation_id,pattern:'PULLBACK',direction:'SHORT',entry:recorded.entry,stop:recorded.stop,target:'78138',economics:{fundingAllowance:recorded.fundingAllowance}}),before=structuredClone(p);
 // Quote timing is a synthetic isolated wrapper; exact historical entry/stop/
 // target/funding values above determine the selection economics.
 const bid=D(p.entry).div('.9998').toString(),q=quote(bid,D(bid).plus(1).toString());
 const receipt=evaluateEntryEconomics(p,{quote:q,qty:'.0012',now:T,stage:'SELECTION'});
 assert.equal(receipt.accepted,false);assert.equal(receipt.reason,'EXPECTED_NET_TARGET_BELOW_MINIMUM');
 closeTo(receipt.expected_net_target,recorded.target_net);assert.equal(receipt.effective_exposure,recorded.exposure);
 assert.equal(receipt.minimum_expected_net_target,D(recorded.exposure).mul('.002').toString());
 assert.equal(receipt.structural_target,'78138');assert.deepEqual(p,before);
 const recheck=evaluate(p,{quote:quote(recorded.raw_fill_bid,D(recorded.raw_fill_bid).plus(1).toString()),qty:'.0012',entryPrice:recorded.fill,fundingRate:D(recorded.fundingAllowance).mul(2).toString(),stage:'PRE_EXECUTION'});
 assert.equal(recheck.accepted,false);assert.equal(recheck.estimated_entry_price,recorded.fill);assert.notEqual(recheck.expected_net_target,receipt.expected_net_target);
 assert.equal(recheck.minimum_expected_net_target,D(recorded.fill).mul('.0012').mul('.002').toString());
 assert.notEqual(recheck.expected_net_target,recorded.realized,'forecast is never relabelled as realized history');
});

test('the tiny positive historical case requires 0.1877904 at its original effective exposure',()=>{
 const r=historicalCases[0],p=plan({direction:'SHORT',entry:r.entry,stop:r.stop,target:'78138'});
 const receipt=evaluate(p,{quote:quote('78261','78262'),qty:'.0012',fundingRate:D(r.fundingAllowance).mul(2).toString()});
 assert.equal(receipt.minimum_expected_net_target,'0.1877904');assert.equal(receipt.accepted,false);
 assert(D(receipt.expected_net_target).gt(0));assert(D(receipt.expected_net_target).lt('.017'));
});

test('sufficient useful net is accepted with explicit fees, spread, slip, funding and net risk',()=>{
 const receipt=evaluate(plan(),{fundingRate:'.01'});
 assert.equal(receipt.accepted,true);assert.equal(receipt.reason,'EXPECTED_NET_TARGET_SUFFICIENT');
 assert.equal(receipt.target_exit_price,'100.9798');assert.equal(receipt.entry_fee,'0.05001');assert.equal(receipt.target_exit_fee,'0.0504899');
 assert.equal(receipt.estimated_funding,'0.005');assert.equal(receipt.expected_net_target,'0.8543001');assert.equal(receipt.expected_loss_stop,'1.1443001');
 assert.equal(receipt.effective_exposure,'100.02');assert.equal(receipt.minimum_expected_net_target,'0.20004');
 assert.equal(receipt.net_rr,D('.8543001').div('1.1443001').toString());
 assert.equal(receipt.observed_spread_usd_per_btc,'0.02');assert.equal(receipt.entry_spread_cost_vs_mid,'0.01');assert.equal(receipt.entry_slippage_cost,'0.02');assert.equal(receipt.target_slippage_cost,'0.0202');assert.equal(receipt.costs_embedded_in_prices,true);
 assert.equal(receipt.hash,hash({...receipt,hash:undefined}));assert.equal(receipt.forecast_guaranteed,false);
});

test('SHORT uses the ask target with adverse exit slip and charges fees once',()=>{
 const p=plan({direction:'SHORT',entry:'99.98',target:'99',stop:'101'}),receipt=evaluate(p,{quote:quote('100','100.02'),fundingRate:'-.01'});
 assert.equal(receipt.accepted,true);assert.equal(receipt.target_exit_price,'99.0198');assert.equal(receipt.target_quote_basis,'STRUCTURAL_ASK_LEVEL');
 assert.equal(receipt.expected_net_target,'0.8557001');assert.equal(receipt.expected_loss_stop,'1.1457001');assert.equal(receipt.estimated_funding,'0.005');
});

test('the denominator is executable price times rounded quantity, independent of margin and leverage',()=>{
 const p=plan({sizing:{qty:'.96',initial_margin:'48.0096',exposure:'9999'},execution_contract:{...explorationContract(EXPLORATION_POLICY,'BREAKOUT',T),leverage:2}}),receipt=evaluate(p,{qty:'.96'});
 assert.equal(receipt.effective_exposure,'96.0192');assert.equal(receipt.minimum_expected_net_target,'0.1920384');
 const changed=evaluate({...p,execution_contract:{...p.execution_contract,leverage:20,nominalUSD:'100000'}},{qty:'.96'});
 assert.equal(changed.expected_net_target,receipt.expected_net_target);assert.equal(changed.minimum_expected_net_target,receipt.minimum_expected_net_target);assert.equal(changed.accepted,receipt.accepted);
});

test('partial quantities scale net, risk and minimum homogeneously instead of imposing a fixed dollar hurdle',()=>{
 const full=evaluate(),partial=evaluate(plan(),{qty:'.1234'});
 for(const key of ['effective_exposure','minimum_expected_net_target','expected_net_target','expected_loss_stop','entry_fee','target_exit_fee'])closeTo(partial[key],D(full[key]).mul('.1234').toString());
 closeTo(full.expected_net_target_fraction,partial.expected_net_target_fraction);closeTo(full.net_rr,partial.net_rr);assert.equal(partial.accepted,full.accepted);
});

test('a price change after latency can reject a previously acceptable signal without moving its target',()=>{
 const p=plan({entry:'100.02',target:'100.35'}),before=structuredClone(p),selection=evaluate(p);
 assert.equal(selection.accepted,true);
 const later=evaluate(p,{quote:quote('100.06','100.08',T+1100),entryPrice:'100.100016',now:T+1100,stage:'PRE_EXECUTION'});
 assert.equal(later.accepted,false);assert.equal(later.reason,'EXPECTED_NET_TARGET_BELOW_MINIMUM');assert(later.quote_at>selection.quote_at);assert.equal(later.structural_target,p.target);assert.deepEqual(p,before);
});

test('economy is rechecked for each fill and cannot substitute stale allowance for current funding',()=>{
 const p=plan({economics:{fundingAllowance:'0'}});
 assert.equal(evaluateEntryEconomics(p,{quote:quote(),qty:1,now:T,stage:'SELECTION'}).accepted,true);
 assert.equal(evaluateEntryEconomics(p,{quote:quote(),qty:1,now:T,stage:'PRE_EXECUTION'}).reason,'FUNDING_NOT_AVAILABLE');
 assert.equal(evaluate(p,{fundingRate:NaN}).reason,'FUNDING_NOT_AVAILABLE');assert.equal(evaluate(p,{fundingRate:null}).reason,'FUNDING_NOT_AVAILABLE');
 const expensive=evaluate(p,{fundingRate:5,stage:'PRE_EXECUTION'});assert.equal(expensive.accepted,false);assert.equal(expensive.reason,'EXPECTED_NET_TARGET_BELOW_MINIMUM');
});

test('maker limits retain their original entry and fee model; quote spread is disclosed but not charged twice',()=>{
 const policy=structuredClone(EXPLORATION_POLICY);policy.modes.PULLBACK='MAKER_LIMIT';
 const p=plan({pattern:'PULLBACK',entry:'99.9',execution_contract:explorationContract(policy,'PULLBACK',T)}),receipt=evaluate(p,{quote:quote('100','100.1')});
 assert.equal(receipt.estimated_entry_price,'99.9');assert.equal(receipt.entry_fee,'0.01998');assert.equal(receipt.entry_slippage_cost,'0');assert.equal(receipt.entry_spread_cost_vs_mid,null);
 assert.equal(receipt.expected_net_target,'1.0093301');assert.equal(receipt.accepted,true);
});

test('invalid numbers, directions, stale or wrong-instrument data are technical rejections',()=>{
 for(const qty of [0,-1,'NaN','Infinity'])assert.equal(evaluate(plan(),{qty}).reason,'ENTRY_ECONOMICS_INVALID');
 for(const direction of ['BUY','NONE'])assert.equal(evaluate(plan({direction})).reason,'ENTRY_ECONOMICS_INVALID');
 for(const changed of [{event_at:T-5001},{symbol:'BTC/USD'},{source:'KRAKEN_WS'},{ask:'-1'},{ask:'NaN'},{bid:'101',ask:'100'},{event_at:T+1001}])assert.equal(evaluate(plan(),{quote:{...quote(),...changed}}).reason,'FUTURES_DATA_NOT_FRESH');
 assert.equal(evaluate(plan({target:'100'})).reason,'INVALID_STRUCTURAL_BARRIERS');assert.equal(evaluate(plan({stop:'101'})).reason,'INVALID_STRUCTURAL_BARRIERS');
});

test('live or tampered contracts fail closed and legacy plans remain governed by their original admission',()=>{
 const p=plan();assert.equal(evaluate({...p,economic_policy:{...p.economic_policy,realTrading:true}}).reason,'ENTRY_ECONOMIC_POLICY_INVALID');
 assert.equal(evaluate({...p,economic_policy:{...p.economic_policy,min_expected_net_target_fraction:'.00001'}}).reason,'ENTRY_ECONOMIC_POLICY_INVALID');
 assert.equal(evaluate({...p,execution_contract:{...p.execution_contract,realTrading:true}}).reason,'ENTRY_ECONOMICS_INVALID');
 delete p.economic_policy;assert.deepEqual(evaluate(p),{applied:false,accepted:true,reason:'LEGACY_ENTRY_POLICY'});
});

test('receipt retains exact input evidence when the source quote later changes',()=>{
 const p=plan(),q=quote(),before=structuredClone(p),receipt=evaluate(p,{quote:q});q.bid='1';q.event_at=0;
 assert.equal(receipt.quote.bid,'99.98');assert.equal(receipt.quote.event_at,T);assert.deepEqual(p,before);
});
