// Isolated PAPER fixtures. No worker, network, exchange orders or real messages.
import test from 'node:test';
import assert from 'node:assert/strict';
import {D,hash} from '../lib/trading/core.js';
import {newAccount} from '../lib/trading/simulator.js';
import {enablePortfolio} from '../lib/trading/portfolio.js';
import {SecondaryBroker,SECONDARY_MODEL,secondaryEstimate} from '../lib/trading/secondary-futures-engine.js';
import {EXPLORATION_VERSION,installExploration,explorationContract,getExplorationPolicy} from '../lib/trading/secondary-exploration.js';
import {CAPITAL_ALLOCATION_VERSION,CAPITAL_ALLOCATION_POLICY,CAPITAL_TOPUP_REASON,installCapitalAllocation,applyCapitalAllocationFunding,getCapitalAllocationPolicy,hasFiniteCapitalAllocation,capitalAllocationFreeCash,capitalUnitReserve,allocationContract,validateCapitalAllocationContract,allocateCapitalCandidates,capitalAllocationView} from '../lib/trading/secondary-capital-allocation.js';

const NOW=Date.parse('2026-11-02T13:10:02Z'),META={qty_step:'0.001'},ENV={LUMI_RUNTIME_ENV:'staging',LUMI_TRADING_MODE:'PAPER',LUMI_TRADING_STORAGE:'SQLITE',LUMI_TRADING_SECONDARY_PROFILE:EXPLORATION_VERSION,LUMI_TRADING_SECONDARY_CAPITAL_ALLOCATION:CAPITAL_ALLOCATION_VERSION};
const quote={source:'KRAKEN_FUTURES_WS_TICKER',symbol:'PF_XBTUSD',event_at:NOW,received_at:NOW,bid:'99.99',ask:'100',bid_qty:'100',ask_qty:'100'};
function fixture(cash='469.14'){
 const account=newAccount();enablePortfolio(account);Object.assign(account,{cash,equity:cash,net:'-30.86',fees:'10',peak:'500',maxDrawdown:'0.06172',closed:3,wins:1,losses:2});
 const root={frequency:{account,counts:{},history:[{type:'CLOSED',id:'old',pnl:'-1'}]},laboratory:{status:'RESEARCH_COMPLETE',funding:{initial:'500',added:'0'}},primary:{cash:'100',history:['KEEP']}};
 const events=[],broker=new SecondaryBroker({root,now:()=>NOW,event:e=>events.push(e)});installExploration(root,ENV,NOW,e=>events.push(e));
 return {root,account,broker,events,install:(env=ENV)=>installCapitalAllocation(root,env,NOW,e=>events.push(e))};
}
function plan(root,id,fraction='.005',rr='2'){
 return {id,pattern:'PULLBACK',direction:'LONG',decision_at:NOW,entry:'100',stop:'99',target:'101',execution_contract:explorationContract(getExplorationPolicy(root),'PULLBACK',NOW),economics:{gain:D(fraction).mul(100).toString(),loss:'.3',netRR:rr,fundingAllowance:'0'}};
}
function preflight(p,{qty}){return {accepted:p.id!=='rejected',reason:p.id==='rejected'?'EXPECTED_NET_TARGET_BELOW_MINIMUM':'OK',entry_economics:{expected_net_target_fraction:D(p.economics.gain).div(p.entry).toString(),net_rr:p.economics.netRR,quantity:qty},context_admission:{accepted:true}};}
const decisions=(root,items)=>items.map(([id,fraction,rr])=>({pattern:'PULLBACK',reason:'CANDIDATE',plan:plan(root,id,fraction,rr)}));

test('additive migration leaves old profile, existing contracts, primary, losses and history intact; install retries are inert',()=>{
 const h=fixture(),oldPlan=plan(h.root,'old');oldPlan.hash=hash(oldPlan);
 h.account.pendingOrders.old={plan:oldPlan,remaining_reserved:'50'};const before=structuredClone(h.root);
 assert.equal(h.install(),true);assert.deepEqual(h.root.frequency,before.frequency);assert.deepEqual(h.root.primary,before.primary);assert.deepEqual(h.root.laboratory,before.laboratory);assert.deepEqual(h.root.secondaryExecution.exploration,before.secondaryExecution.exploration);
 assert.equal(getCapitalAllocationPolicy(h.root).baseNominalUSD,'300');assert.equal(getExplorationPolicy(h.root).nominalUSD,'100');
 const count=h.events.length;assert.equal(h.install(),false);assert.equal(h.events.length,count);assert.equal(h.root.secondaryExecution.capital_allocation.funding_request.status,'PENDING');
});
test('one authorized target contribution uses the existing topup ledger and does not erase losses, fees or historical peaks',()=>{
 const h=fixture();h.install();const original={net:h.account.net,fees:h.account.fees,peak:h.account.peak,maxDrawdown:h.account.maxDrawdown,closed:h.account.closed};
 const receipt=applyCapitalAllocationFunding(h.root,NOW,h.broker.topup.bind(h.broker));
 assert.equal(receipt.amount,'530.86');assert.equal(h.account.cash,'1000');assert.equal(h.account.equity,'1000');
 for(const[k,value]of Object.entries(original))assert.equal(h.account[k],value);
 assert.equal(h.root.secondaryExecution.capital.total_contributed,'1030.86');assert.equal(h.root.secondaryExecution.capital.count,1);
 const event=h.events.find(e=>e.type==='PAPER_CAPITAL_TOPUP');assert.equal(event.reason,CAPITAL_TOPUP_REASON);assert.equal(event.amount,'530.86');assert.equal(event.balance_before,'469.14');assert.equal(event.balance_after,'1000');
 h.account.cash=h.account.equity='800';h.account.net='-230.86';h.root.secondaryExecution.capital.keys=[];
 const copy=structuredClone(h.root),restored=new SecondaryBroker({root:copy,now:()=>NOW+1});
 assert.equal(applyCapitalAllocationFunding(copy,NOW+1,restored.topup.bind(restored)),null);assert.equal(copy.frequency.account.cash,'800');assert.equal(copy.secondaryExecution.capital.count,1);
});
test('already-funded target records an APPLIED zero receipt and never tops up a later loss',()=>{
 const h=fixture('1200');h.install();let calls=0;
 const receipt=applyCapitalAllocationFunding(h.root,NOW,()=>{calls++;});assert.equal(receipt.amount,'0');assert.equal(receipt.reason,'TARGET_ALREADY_FUNDED');assert.equal(calls,0);
 h.account.cash=h.account.equity='900';assert.equal(applyCapitalAllocationFunding(h.root,NOW+1,()=>{calls++;}),null);assert.equal(calls,0);
});
test('an authorized one-time contribution can reconcile a negative fictional balance without hiding its loss',()=>{
 const h=fixture('-20');h.account.net='-520';h.install();const receipt=applyCapitalAllocationFunding(h.root,NOW,h.broker.topup.bind(h.broker));assert.equal(receipt.amount,'1020');assert.equal(h.account.cash,'1000');assert.equal(h.account.net,'-520');
});
test('OFF preserves finite capital and funding receipt; reenabling or revisiting an earlier request cannot fund twice',()=>{
 const h=fixture();h.install();applyCapitalAllocationFunding(h.root,NOW,h.broker.topup.bind(h.broker));
 assert.equal(h.install({...ENV,LUMI_TRADING_SECONDARY_CAPITAL_ALLOCATION:'OFF'}),true);assert.equal(getCapitalAllocationPolicy(h.root),null);assert.equal(hasFiniteCapitalAllocation(h.root),true);
 assert.equal(applyCapitalAllocationFunding(h.root,NOW+1,h.broker.topup.bind(h.broker)),null);h.account.cash=h.account.equity='900';
 h.install();assert.equal(applyCapitalAllocationFunding(h.root,NOW+2,h.broker.topup.bind(h.broker)),null);assert.equal(h.account.cash,'900');
 assert.throws(()=>h.install({...ENV,LUMI_TRADING_SECONDARY_TARGET_EQUITY_USD:'1500'}),/REQUEST_CONFLICT/);
 h.install({...ENV,LUMI_TRADING_SECONDARY_CAPITAL_REQUEST_ID:'second-explicit-request',LUMI_TRADING_SECONDARY_TARGET_EQUITY_USD:'950'});applyCapitalAllocationFunding(h.root,NOW+3,h.broker.topup.bind(h.broker));assert.equal(h.account.cash,'950');
 h.account.cash=h.account.equity='800';h.install();assert.equal(applyCapitalAllocationFunding(h.root,NOW+4,h.broker.topup.bind(h.broker)),null);assert.equal(h.account.cash,'800');
});
test('capital funding rejects REAL, invalid or changed protocols and requires a current mark rather than a stale target valuation',()=>{
 for(const mode of ['REAL','LIVE']){const h=fixture();assert.throws(()=>h.install({...ENV,LUMI_TRADING_MODE:mode}),/PAPER_ONLY/);}
 for(const value of ['0','NaN','Infinity','-1']){const h=fixture();assert.throws(()=>h.install({...ENV,LUMI_TRADING_SECONDARY_ALLOCATION_BASE_USD:value}),/PARAMETERS_INVALID/);}
 const h=fixture();h.install();assert.throws(()=>h.install({...ENV,LUMI_TRADING_SECONDARY_CAPITAL_ALLOCATION:undefined}),/FLAG_REQUIRED/);
 h.account.equity='400';assert.equal(applyCapitalAllocationFunding(h.root,NOW,()=>assert.fail('must not contribute')),null);assert.equal(h.root.secondaryExecution.capital_allocation.funding_request.reason,'CAPITAL_TARGET_REQUIRES_CURRENT_MARK');
 h.account.equity=h.account.cash;h.root.secondaryExecution.capital_allocation.policy.baseNominalUSD='301';assert.throws(()=>hasFiniteCapitalAllocation(h.root),/INTEGRITY/);
});
test('with an existing position, funding waits for fresh quotes and resolved valuation, then preserves the position contract',()=>{
 const h=fixture('450');h.install();const p=plan(h.root,'existing');p.execution_model=SECONDARY_MODEL;p.sizing={target_net:'1'};
 h.account.positions.existing={plan:p,qty:'1',entry:'100',entry_fee:'.05',initial_margin:'50',accrued_funding:'0',funding_pending:[],quality:'OBSERVED'};
 const unchanged=structuredClone(h.account.positions);
 assert.equal(applyCapitalAllocationFunding(h.root,NOW,h.broker.topup.bind(h.broker)),null);assert.equal(h.root.secondaryExecution.capital_allocation.funding_request.reason,'CAPITAL_TARGET_VALUATION_UNAVAILABLE');
 const value=secondaryEstimate(h.account.positions.existing,quote,NOW);h.account.equity=D(h.account.cash).plus(50).plus(value.gross).minus(value.exit_fee).minus(value.funding).toString();
 const receipt=applyCapitalAllocationFunding(h.root,NOW,h.broker.topup.bind(h.broker),{quote});assert.equal(receipt.equity_after,'1000');assert(D(h.account.cash).lt(1000));assert.deepEqual(h.account.positions,unchanged);
});
test('free capital subtracts pending and funding reserves once, not already-debited position margin',()=>{
 const h=fixture('500');h.account.positions.p={initial_margin:'300',funding_reserved:'4',plan:{id:'p'}};h.account.pendingOrders.o={plan:{id:'o',sizing:{reserved:'100'}},remaining_reserved:'70'};
 assert.equal(capitalAllocationFreeCash(h.account),'426');assert.equal(capitalAllocationFreeCash(h.account,{excludeOrderId:'o'}),'496');
 h.account.cash='20';assert.equal(capitalAllocationFreeCash(h.account),'0');
});
test('one valid signal keeps tripled base300; strict best among eligible signals receives450 and existing plans are not mutated',()=>{
 const h=fixture('1000');h.install();const one=decisions(h.root,[['only','.008','2']]),original=structuredClone(one[0].plan),identity=one[0];
 let result=allocateCapitalCandidates(h.root,one,{quote,meta:META,now:NOW,preflight});assert.equal(result.ordered[0],identity);assert.equal(one[0].plan.execution_contract.nominalUSD,'300');assert.equal(result.preferred_id,null);assert.equal(original.execution_contract.nominalUSD,'100');
 const ds=decisions(h.root,[['rejected','.02','10'],['weak','.004','2'],['best','.008','3']]);result=allocateCapitalCandidates(h.root,ds,{quote,meta:META,now:NOW,preflight});
 assert.equal(result.eligible_count,2);assert.equal(result.preferred_id,'best');assert.equal(result.ordered[0].plan.id,'best');assert.equal(ds.find(d=>d.plan.id==='best').plan.execution_contract.nominalUSD,'450');assert.equal(ds.find(d=>d.plan.id==='weak').plan.execution_contract.nominalUSD,'300');assert.equal(ds.find(d=>d.plan.id==='rejected').capital_allocation_rejection,'EXPECTED_NET_TARGET_BELOW_MINIMUM');
 assert.equal(result.ordered[0].facts.entry_economics.quantity,'4.5');
 assert.equal(validateCapitalAllocationContract(result.ordered[0].plan,{root:h.root,current:true}),true);assert.equal(h.account.cash,'1000');assert.deepEqual(h.account.positions,{});assert.deepEqual(h.account.pendingOrders,{});
});
test('monitor view exposes finite budget, preferred size and one-time receipt without full history',()=>{
 const h=fixture();assert.equal(capitalAllocationView(h.root),null);h.install();applyCapitalAllocationFunding(h.root,NOW,h.broker.topup.bind(h.broker));
 const view=capitalAllocationView(h.root);assert.equal(view.base_nominal_usd,'300');assert.equal(view.preferred_nominal_usd,'450');assert.equal(view.available_cash,'1000');assert.equal(view.funding_request.status,'APPLIED');assert.equal(view.funding_request.receipt.amount,'530.86');assert.equal(view.history,undefined);view.policy.baseNominalUSD='1';assert.equal(getCapitalAllocationPolicy(h.root).baseNominalUSD,'300');
 h.install({...ENV,LUMI_TRADING_SECONDARY_CAPITAL_ALLOCATION:'OFF'});const off=capitalAllocationView(h.root);assert.equal(off.base_nominal_usd,'100');assert.equal(off.finite_capital,true);assert.equal(off.automatic_topups,false);
});
test('equal economic scores receive no arbitrary monetary preference; id ordering is deterministic',()=>{
 const h=fixture('1000');h.install();const ds=decisions(h.root,[['z','.005','2'],['a','.005','2']]),result=allocateCapitalCandidates(h.root,ds,{quote,meta:META,now:NOW,preflight});
 assert.equal(result.preferred_id,null);assert.deepEqual(result.ordered.map(d=>d.plan.id),['a','z']);assert(result.ordered.every(d=>d.plan.execution_contract.nominalUSD==='300'));
});
test('virtual reservations prioritize best and never demand ten positions or create a sub-base sliver',()=>{
 const h=fixture('300');h.install();const ds=decisions(h.root,[['weak','.004','2'],['best','.008','3']]),result=allocateCapitalCandidates(h.root,ds,{quote,meta:META,now:NOW,preflight});
 assert.equal(result.ordered[0].plan.id,'best');assert.equal(result.ordered[0].facts.capital_allocation.accepted,true);assert.equal(result.ordered[1].capital_allocation_rejection,'PAPER_CAPITAL_INSUFFICIENT');assert.equal(result.ordered[1].facts.capital_allocation.qty,'0');
 assert.equal(h.root.secondaryExecution.capital,undefined);assert.equal(h.account.cash,'300');
});
test('preferred bonus can be reduced to available capital, but never below rounded base quantity',()=>{
 const h=fixture('180');h.install();const ds=decisions(h.root,[['weak','.004','2'],['best','.008','3']]),result=allocateCapitalCandidates(h.root,ds,{quote,meta:META,now:NOW,preflight});
 const best=result.ordered[0],a=best.facts.capital_allocation;assert.equal(a.accepted,true);assert.equal(a.capital_limited,true);assert(D(a.qty).gte(3));assert(D(a.qty).lt('4.5'));assert(D(a.reserved).lte(180));assert.equal(best.plan.execution_contract.nominalUSD,D(a.qty).mul(100).toString());
 const low=fixture('149');low.install();const r=allocateCapitalCandidates(low.root,decisions(low.root,[['only','.005','2']]),{quote,meta:META,now:NOW,preflight});assert.equal(r.ordered[0].capital_allocation_rejection,'PAPER_CAPITAL_INSUFFICIENT');assert.equal(r.ordered[0].facts.capital_allocation.qty,'0');
});
test('quantity rounding includes margin, entry commission and funding; repeated planning never consumes live cash',()=>{
 const h=fixture('1000');h.install();const p=plan(h.root,'fees');p.economics.fundingAllowance='.02';assert.equal(capitalUnitReserve(p),'50.07');
 const ds=[{plan:p,pattern:'PULLBACK',reason:'CANDIDATE'}],r=allocateCapitalCandidates(h.root,ds,{quote,meta:{qty_step:'.07'},now:NOW,preflight});assert.equal(r.receipts[0].qty,'2.94');assert.equal(r.receipts[0].reserved,D('2.94').mul('50.07').toString());assert.equal(h.account.cash,'1000');
 assert.throws(()=>allocateCapitalCandidates(h.root,ds,{quote,meta:META,now:NOW,preflight}),/UNSIGNED_SIGNAL_REQUIRED/);
});
test('allocation contracts remain independently readable after OFF, and tampering cannot bypass policy limits',()=>{
 const h=fixture('1000');h.install();const p=plan(h.root,'contract');p.execution_contract=allocationContract(p.execution_contract,getCapitalAllocationPolicy(h.root),{at:NOW});assert.equal(validateCapitalAllocationContract(p,{root:h.root,current:true}),true);
 h.install({...ENV,LUMI_TRADING_SECONDARY_CAPITAL_ALLOCATION:'OFF'});assert.equal(validateCapitalAllocationContract(p),true);assert.throws(()=>validateCapitalAllocationContract(p,{root:h.root,current:true}),/POLICY_MISMATCH/);
 const bad=structuredClone(p);bad.execution_contract.nominalUSD='999';assert.throws(()=>validateCapitalAllocationContract(bad),/INTEGRITY/);
 const real=structuredClone(p);real.execution_contract.capital_allocation.policy.mode='REAL';assert.throws(()=>validateCapitalAllocationContract(real),/PAPER_ONLY/);
 assert.throws(()=>allocationContract(plan(h.root,'huge').execution_contract,CAPITAL_ALLOCATION_POLICY,{nominalUSD:'900',at:NOW}),/SIZE_INVALID/);
});
test('no signal causes no allocation, contribution, synthetic operation or artificial preferred candidate',()=>{
 const h=fixture('1000');h.install();const ds=[{pattern:'BREAKOUT',reason:'WAIT_BREAKOUT'},{pattern:'PULLBACK',reason:'WAIT_PULLBACK'}],r=allocateCapitalCandidates(h.root,ds,{quote,meta:META,now:NOW,preflight});assert.deepEqual(r.ordered,ds);assert.equal(r.eligible_count,0);assert.equal(r.preferred_id,null);assert.deepEqual(r.receipts,[]);assert.equal(h.root.secondaryExecution.capital,undefined);
});
