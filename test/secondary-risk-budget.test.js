// External, synthetic PAPER fixtures. No network, active worker DB or Telegram.
import test from 'node:test';
import assert from 'node:assert/strict';
import {D,hash} from '../lib/trading/core.js';
import {newAccount} from '../lib/trading/simulator.js';
import {enablePortfolio} from '../lib/trading/portfolio.js';
import {SecondaryBroker,secondaryEconomics,SECONDARY_MODEL,SECONDARY_VERSION,secondaryEstimate} from '../lib/trading/secondary-futures-engine.js';
import {EXPLORATION_VERSION,installExploration,getExplorationPolicy,explorationContract} from '../lib/trading/secondary-exploration.js';
import {EARLY_PROFIT_POLICY_VERSION,EARLY_PROFIT_ENTRY_REVISION,PROFIT_POLICY_VERSION,PROFIT_ENTRY_REVISION,installProfitPolicy,getProfitPolicy,makeProfitContracts} from '../lib/trading/secondary-profit-policy.js';
import {CAPITAL_ALLOCATION_VERSION,installCapitalAllocation,applyCapitalAllocationFunding,capitalUnitReserve} from '../lib/trading/secondary-capital-allocation.js';
import {RISK_BUDGET_VERSION,RISK_EXECUTION_VERSION,RISK_BUDGET_POLICY,installRiskBudget,getRiskBudgetPolicy,prepareRiskCandidates,validateRiskContract,riskPortfolioSnapshot,riskBudgetView,marginSurrogate,riskUnitLoss} from '../lib/trading/secondary-risk-budget.js';
const T=Date.parse('2026-11-03T16:00:02Z'),H=Math.floor(T/3600000)*3600000;
const ENV={LUMI_RUNTIME_ENV:'staging',LUMI_TRADING_MODE:'PAPER',LUMI_TRADING_STORAGE:'SQLITE',LUMI_TRADING_SECONDARY_PROFILE:EXPLORATION_VERSION,LUMI_TRADING_SECONDARY_PROFIT_POLICY:EARLY_PROFIT_POLICY_VERSION,LUMI_TRADING_SECONDARY_CAPITAL_ALLOCATION:CAPITAL_ALLOCATION_VERSION,LUMI_TRADING_SECONDARY_RISK_BUDGET:RISK_BUDGET_VERSION};
const META={symbol:'PF_XBTUSD',qty_step:'0.0001',tick_size:'0.01',checked_at:T};
const quote=(at=T,bid=100,size=1000,spread='.01')=>({source:'KRAKEN_FUTURES_WS_TICKER',symbol:'PF_XBTUSD',event_at:at,received_at:at,bid:String(bid),ask:D(bid).plus(spread).toString(),bid_qty:String(size),ask_qty:String(size)});
const near=(a,b)=>assert(D(a).minus(b).abs().lt('1e-10'),`${a} != ${b}`);
function fixture({cash='1000',risk=true,profit=EARLY_PROFIT_POLICY_VERSION}={}){
 let now=T;const a=newAccount();enablePortfolio(a);Object.assign(a,{cash,equity:cash,peak:cash});const events=[];
 const root={frequency:{account:a,counts:{},history:[]},laboratory:{status:'RESEARCH_COMPLETE',funding:{initial:cash,added:'0'}},primary:{account:{cash:'100',net:'-4'},keep:'UNCHANGED'}};
 const b=new SecondaryBroker({root,now:()=>now,event:e=>events.push(structuredClone(e))});installExploration(root,ENV,now);installProfitPolicy(root,{...ENV,LUMI_TRADING_SECONDARY_PROFIT_POLICY:profit},now);installCapitalAllocation(root,ENV,now);if(risk)installRiskBudget(root,ENV,now);
 return {root,b,events,time(at){now=at;},now:()=>now};
}
function plan(h,{id='one',at=T,bid=100,direction='LONG',pattern='BREAKOUT',target,stop,timeframe=5,confirmation=at-2000,confirmationKey=id,spread='.01'}={}){
 const c=explorationContract(getExplorationPolicy(h.root),pattern,at),short=direction==='SHORT',q=quote(at,bid,1000,spread),entry=D(q[short?'bid':'ask']).mul(short?'.9998':'1.0002');target??=short?98.5:101.5;stop??=short?100.4:99.6;
 const contracts=makeProfitContracts(getProfitPolicy(h.root),{timeframe});
 return {id,signal_key:hash(['RISK-FIXTURE',id]),version:SECONDARY_VERSION,entry_revision:getProfitPolicy(h.root).entryRevision,execution_model:SECONDARY_MODEL,instrument:'PAPER:KRAKEN_FUTURES:PF_XBTUSD',pattern,direction,timeframe,entry:entry.toString(),limit:String(bid),stop:String(stop),target:String(target),confirmed_at:confirmation,decision_at:at,expires_at:c.expires_at,holding_ms:contracts.exit_policy.base_holding_ms,execution_contract:c,order:'FUTURES_TAKER_IOC',fill_model:c.liquidity_model,economics:secondaryEconomics(entry,stop,target,direction,0,c,contracts.economic_policy.funding_estimation_ms),...contracts,entry_context:{version:'secondary-entry-context-economics-1.0.0',structure_key:'structure:'+id,movement_key:'movement:'+id,confirmation_key:confirmationKey,confirmation_event_at:confirmation,confirmation_at:confirmation,price_tick:'.01',remaining_distance:D(target).minus(entry).mul(short?-1:1).toString(),remaining_distance_fraction:D(target).minus(entry).abs().div(entry).toString()}};
}
function prepare(h,plans,{at=plans[0]?.decision_at??T,bid=100,size=1000,spread='.01'}={}){return prepareRiskCandidates(h.root,plans.map(p=>({plan:p,pattern:p.pattern,reason:'CANDIDATE'})),{quote:quote(at,bid,size,spread),meta:META,now:at,preflight:h.b.preflight.bind(h.b)});}
function choose(h,p,{at=p.decision_at,bid=100,spread='.01'}={}){return h.b.choose(p,quote(at,bid,1000,spread),META,at);}
function market(h,at,bid=100,size=1000,spread='.01'){h.time(at);h.b.market(quote(at,bid,size,spread),null,{[H]:0,[H+3600000]:0},at);}
function open(h,p=plan(h),opts={}){const d=prepare(h,[p],opts).ordered[0];assert.equal(d.capital_allocation_rejection,undefined,d.capital_allocation_rejection);assert.equal(choose(h,d.plan,opts),'ENTRY_PENDING');market(h,p.decision_at+1100,opts.bid??100,opts.size??1000,opts.spread??'.01');assert(h.b.a.positions[p.id]);return h.b.a.positions[p.id];}
function restart(h,at){h.time(at);const root=JSON.parse(JSON.stringify(h.root));h.root=root;h.b=new SecondaryBroker({root,now:h.now,event:e=>h.events.push(structuredClone(e))});return h;}

test('risk migration is additive, fixed and does not create funding, change balances, history or principal',()=>{
 const h=fixture({risk:false}),before=structuredClone(h.root);assert.equal(installRiskBudget(h.root,ENV,T),true);assert.deepEqual(h.root.frequency,before.frequency);assert.deepEqual(h.root.primary,before.primary);assert.deepEqual(h.root.secondaryExecution.capital_allocation,before.secondaryExecution.capital_allocation);assert.equal(installRiskBudget(h.root,ENV,T+1),false);assert.deepEqual(getRiskBudgetPolicy(h.root),RISK_BUDGET_POLICY);assert.equal(riskBudgetView(h.root).policy.max_leverage,10);
 assert.throws(()=>installRiskBudget(h.root,{...ENV,LUMI_TRADING_MODE:'REAL'},T),/PAPER_ONLY/);
});
test('size is limited by signed stop fees funding and stress; one dollar remains aspiration',()=>{
 const h=fixture(),d=prepare(h,[plan(h,{stop:98,target:100.5})]).ordered[0];assert.equal(d.capital_allocation_rejection,undefined);const r=d.plan.execution_contract.risk_budget.receipt;
 assert(D(r.risk).lte(5));assert(D(r.risk).eq(D(r.unit_stop_loss).plus(r.unit_stress).mul(r.qty)));assert(D(r.exposure).lt(300));assert.equal(r.aspiration_achievable,false);assert.equal(choose(h,d.plan),'ENTRY_PENDING');assert.equal(h.b.a.pendingOrders.one.plan.sizing.risk,r.risk);assert.equal(h.b.a.pendingOrders.one.plan.sizing.expected_loss_stop,D(r.unit_stop_loss).mul(r.qty).toString());assert.equal(h.events.some(e=>e.type==='PAPER_CAPITAL_TOPUP'),false);
});
test('leverage selection chooses smallest 2/5/10 that fits declared margin; P&L never multiplied',()=>{
 const normal=fixture(),d=prepare(normal,[plan(normal)]).ordered[0];assert.equal(d.plan.execution_contract.leverage,2);
 const small=fixture({cash:'80'}),p=plan(small,{stop:100.019,target:103,spread:'0'}),prepared=prepare(small,[p],{spread:'0'}).ordered[0];assert.equal(prepared.capital_allocation_rejection,undefined);assert.equal(prepared.plan.execution_contract.leverage,10);const r=prepared.plan.execution_contract.risk_budget.receipt;assert(D(r.initial_margin).lte(40));assert(D(r.risk).lte('.4'));assert.equal(choose(small,prepared.plan,{spread:'0'}),'ENTRY_PENDING');market(small,T+1100,100,1000,'0');const position=small.b.a.positions.one;assert(position);assert.equal(position.plan.execution_contract.leverage,10);near(position.initial_margin,D(position.qty).mul(position.entry).div(10));
 const at=T+2200,q=quote(at,100.4),v=secondaryEstimate(position,q,at),copy=structuredClone(position);copy.plan.execution_contract.leverage=2;near(secondaryEstimate(copy,q,at).net,v.net);restart(small,T+1200);assert.equal(small.b.a.positions.one.plan.execution_contract.leverage,10);
});
test('one union slot for partial order and position; risk and margin use remaining quantities exactly once',()=>{
 const h=fixture(),p=prepare(h,[plan(h)]).ordered[0].plan;assert.equal(choose(h,p),'ENTRY_PENDING');const order=h.b.a.pendingOrders.one,r=order.plan.sizing,qty=D(r.qty).div(2).div(META.qty_step).floor().mul(META.qty_step),price=p.entry;h.b.currentFundingRate=0;
 assert(h.b.fillOrder(order,qty,price,quote(T+1100),T+1100,{id:'partial-fixture',at:T+1100}));const snapshot=riskPortfolioSnapshot(h.root);assert.equal(snapshot.slots,1);near(snapshot.gross_exposure,r.exposure);near(snapshot.open_risk,r.risk);near(snapshot.margin,r.initial_margin);
});
test('winning pyramid needs new causal confirmation and protection; max three lifetime legs; independent closes',()=>{
 const h=fixture(),parent=open(h,plan(h,{id:'initial',target:102.5}));
 let rejected=prepare(h,[plan(h,{id:'unprotected',at:T+2200,bid:100.1,target:102.5,confirmation:T+2000})],{bid:100.1}).ordered[0];assert.equal(rejected.capital_allocation_rejection,'PYRAMID_INITIAL_NOT_PROTECTED');
 market(h,T+2200,100.5);assert.equal(parent.profit_protection.state,'TRAILING_ACTIVE');const floor=parent.profit_protection.protected_net;
 let p2=plan(h,{id:'second',at:T+3300,bid:100.5,target:102.5,stop:100.1,confirmation:T+3000});let r=prepare(h,[p2],{bid:100.5}).ordered[0];assert.equal(r.capital_allocation_rejection,undefined);assert.equal(r.plan.parent_id,'initial');assert.equal(r.plan.leg_index,1);assert.equal(r.plan.movement_id,parent.plan.movement_id);assert.equal(choose(h,r.plan,{bid:100.5}),'ENTRY_PENDING');market(h,T+4400,100.5);assert(h.b.a.positions.second);assert.equal(parent.profit_protection.protected_net,floor);
 const repeated=prepare(h,[plan(h,{id:'repeat',at:T+5500,bid:100.5,target:102.5,confirmation:T+3000,confirmationKey:'second'})],{bid:100.5}).ordered[0];assert.equal(repeated.capital_allocation_rejection,'REPEATED_CONFIRMATION');
 const p3=plan(h,{id:'third',at:T+5500,bid:100.5,target:102.5,stop:100.1,confirmation:T+5000}),r3=prepare(h,[p3],{bid:100.5}).ordered[0];assert.equal(r3.capital_allocation_rejection,undefined);assert.equal(choose(h,r3.plan,{bid:100.5}),'ENTRY_PENDING');market(h,T+6600,100.5);
 assert.equal(prepare(h,[plan(h,{id:'fourth',at:T+7700,bid:100.5,target:103,confirmation:T+7000})],{bid:100.5}).ordered[0].capital_allocation_rejection,'MOVEMENT_MAX_THREE_LEGS');
 const child=h.b.a.positions.second;h.b.close(child,quote(T+7700,100.5),T+7700,'MANUAL_CLOSE');h.b.close(child,quote(T+8800,100.5),T+8800,'MANUAL_CLOSE');assert(!h.b.a.positions.second);assert(h.b.a.positions.initial);assert(h.b.a.positions.third);assert.equal(prepare(h,[plan(h,{id:'fifth',at:T+9900,bid:100.5,target:103,confirmation:T+9000})],{bid:100.5}).ordered[0].capital_allocation_rejection,'MOVEMENT_MAX_THREE_LEGS');
});
test('simultaneous correlated timeframes share a pending parent and cannot multiply movement budget',()=>{
 const h=fixture(),plans=[plan(h,{id:'fast',timeframe:5}),plan(h,{id:'slow',timeframe:60})],batch=prepare(h,plans);assert.equal(batch.eligible_count,1);assert.equal(batch.ordered.filter(d=>d.capital_allocation_rejection==='PYRAMID_INITIAL_POSITION_NOT_OPEN').length,1);assert.deepEqual(h.b.a.pendingOrders,{});
});
test('losses and lack of cash never trigger topups or recovery multipliers',()=>{
 const h=fixture({cash:'.01'}),before=structuredClone(h.b.a),d=prepare(h,[plan(h)]).ordered[0];assert(d.capital_allocation_rejection);assert.deepEqual(h.b.a,before);assert.equal(h.events.some(e=>e.type==='PAPER_CAPITAL_TOPUP'),false);
 const a=fixture(),beforeP=prepare(a,[plan(a)]).ordered[0].plan.execution_contract.risk_budget.receipt;a.b.a.cash=a.b.a.equity='800';a.b.a.net='-200';const after=prepare(a,[plan(a,{id:'after'})]).ordered[0].plan.execution_contract.risk_budget.receipt;assert(D(after.risk).lte(beforeP.risk));assert.equal(after.protected_profit_budget_credit,'0');
});
test('restart preserves pending identity, capacity and ×2 old contracts while new risk contracts remain independently valid OFF',()=>{
 const h=fixture({risk:false,profit:PROFIT_POLICY_VERSION}),old=plan(h,{id:'old'});assert.equal(h.b.choose(old,quote(),META,T),'CAPITAL_ALLOCATION_CONTRACT_REQUIRED');
 installCapitalAllocation(h.root,{...ENV,LUMI_TRADING_SECONDARY_CAPITAL_ALLOCATION:'OFF'},T);assert.equal(h.b.choose(old,quote(),META,T),'ENTRY_PENDING');market(h,T+1100);const oldSnapshot=structuredClone(h.b.a.positions.old);
 installProfitPolicy(h.root,ENV,T+1200);installRiskBudget(h.root,ENV,T+1200);const p=plan(h,{id:'new-short',at:T+2200,direction:'SHORT',target:98.5,stop:100.4}),d=prepare(h,[p]).ordered[0];assert.equal(d.capital_allocation_rejection,undefined);assert.equal(choose(h,d.plan),'ENTRY_PENDING');const pending=structuredClone(h.b.a.pendingOrders['new-short']);restart(h,T+2300);assert.deepEqual(h.b.a.positions.old,oldSnapshot);assert.deepEqual(h.b.a.pendingOrders['new-short'],pending);assert.equal(choose(h,d.plan,{at:T+2300}),'DUPLICATE_SIGNAL');
 installRiskBudget(h.root,{...ENV,LUMI_TRADING_SECONDARY_RISK_BUDGET:'OFF'},T+2400);market(h,T+3300);assert(h.b.a.positions['new-short']);assert.equal(h.b.a.positions.old.plan.execution_contract.leverage,2);assert(validateRiskContract(h.b.a.positions['new-short'].plan));assert.equal(h.events.some(e=>e.type==='PAPER_CAPITAL_TOPUP'),false);
});
test('signed contract tampering cannot relax budgets, leverage or quantity',()=>{
 const h=fixture(),p=prepare(h,[plan(h)]).ordered[0].plan;assert(validateRiskContract(p));for(const mutate of [x=>x.execution_contract.leverage=11,x=>x.execution_contract.nominalUSD='9000',x=>x.execution_contract.risk_budget.policy.max_leverage=20,x=>x.parent_id='unrelated']){const bad=structuredClone(p);mutate(bad);assert.throws(()=>validateRiskContract(bad),/INTEGRITY/);}
 assert.equal(choose(h,p),'ENTRY_PENDING');const bad=structuredClone(h.b.a.pendingOrders.one.plan);bad.sizing.qty=D(bad.sizing.qty).mul(2).toString();bad.hash=hash({...bad,hash:undefined});assert.throws(()=>validateRiskContract(bad),/SIZING_INTEGRITY/);
});
test('post-latency price stress clips executable quantity to original signed risk and preserves actual costs',()=>{
 const h=fixture(),p=prepare(h,[plan(h,{target:103,stop:99.6})]).ordered[0].plan;assert.equal(choose(h,p),'ENTRY_PENDING');const requested=D(h.b.a.pendingOrders.one.plan.sizing.qty),ceiling=D(p.execution_contract.risk_budget.receipt.risk);market(h,T+1100,100.5);const position=h.b.a.positions.one;assert(position);assert(D(position.qty).lt(requested));assert(D(position.remaining_risk).lte(ceiling));assert(h.events.some(e=>e.type==='ORDER_REMAINDER_CANCELLED'));assert.equal(h.b.a.pendingOrders.one,undefined);assert.equal(h.events.some(e=>e.type==='PAPER_CAPITAL_TOPUP'),false);
});
test('post-latency budget uses current losses on other positions without booking that valuation twice',()=>{
 const h=fixture(),parent=open(h,plan(h,{id:'existing-long',stop:90,target:110}));
 const at=T+2200,decision=prepare(h,[plan(h,{id:'new-short',at,direction:'SHORT',stop:102,target:90,confirmation:T})]).ordered[0];
 assert.equal(decision.capital_allocation_rejection,undefined);assert.equal(choose(h,decision.plan),'ENTRY_PENDING');
 const oldEquity=h.b.a.equity,atFill=T+3300,q=quote(atFill,95),before=structuredClone(h.root),fresh=riskPortfolioSnapshot(h.root,{excludePendingId:'new-short',quote:q,now:atFill});
 assert.deepEqual(h.root,before);assert(D(fresh.equity).lt(oldEquity));assert.equal(fresh.valuation_complete,true);assert.equal(fresh.valuation_quote_at,atFill);
 const parentValue=secondaryEstimate(parent,q,atFill);near(fresh.equity,D(h.b.a.cash).plus(parent.initial_margin).plus(parentValue.gross).minus(parentValue.exit_fee).minus(parentValue.funding));
 const cashBefore=h.b.a.cash,netBefore=h.b.a.net,parentPlan=structuredClone(parent.plan);market(h,atFill,95);
 const child=h.b.a.positions['new-short'];assert(child);assert(D(child.remaining_risk).lte(D(fresh.equity).mul(RISK_BUDGET_POLICY.leg_risk_fraction)));assert(D(child.remaining_risk).lt(decision.plan.execution_contract.risk_budget.receipt.risk));
 near(h.b.a.cash,D(cashBefore).minus(child.initial_margin).minus(child.entry_fee));assert.equal(h.b.a.net,netBefore);assert.deepEqual(parent.plan,parentPlan);assert.equal(parent.exit_intent,undefined);
 assert.equal(child.risk_execution.budget_revalidation.quote_at,atFill);near(child.risk_execution.budget_revalidation.equity,fresh.equity);assert.equal(h.b.a.pendingOrders['new-short'],undefined);
 const cashAfter=h.b.a.cash;restart(h,atFill);market(h,atFill,95);assert.equal(h.b.a.cash,cashAfter);assert.equal(h.events.filter(e=>e.type==='FILLED'&&e.id==='new-short').length,1);
});
test('fresh portfolio marking rejects unresolved funding and stale quotes, and never credits floating profit',()=>{
 const h=fixture(),p=open(h,plan(h,{id:'existing-long',stop:90,target:110})),at=T+2200,positive=riskPortfolioSnapshot(h.root,{quote:quote(at,105),now:at});
 near(positive.equity,D(h.b.a.cash).plus(p.initial_margin));assert(D(positive.marked_equity).gt(positive.equity));
 const stale=riskPortfolioSnapshot(h.root,{quote:quote(T+1100,100),now:T+10000});assert.equal(stale.valuation_complete,false);assert.equal(stale.marked_equity,null);assert.equal(stale.equity,'0');
 p.funding_pending=[{hour:H,from:T+1100,to:at,qty:p.qty}];const before=structuredClone(h.root),unresolved=riskPortfolioSnapshot(h.root,{quote:quote(at,100),now:at});assert.deepEqual(h.root,before);assert.equal(unresolved.valuation_complete,false);
 const d=prepare(h,[plan(h,{id:'opposite-unknown-funding',at,direction:'SHORT',stop:102,target:90})],{at}).ordered[0];assert.equal(d.capital_allocation_rejection,'PORTFOLIO_VALUATION_UNAVAILABLE');
});
test('selection rejects an earlier risk receipt when another position lost equity before reserving the order',()=>{
 const h=fixture();open(h,plan(h,{id:'existing-long',stop:90,target:110}));const at=T+2200,d=prepare(h,[plan(h,{id:'new-short',at,direction:'SHORT',stop:102,target:90})]).ordered[0];assert.equal(d.capital_allocation_rejection,undefined);
 const before=structuredClone(h.b.a);assert.equal(choose(h,d.plan,{at:T+2500,bid:95}),'SHARED_RISK_BUDGET_EXHAUSTED');assert.equal(h.b.a.pendingOrders['new-short'],undefined);assert.equal(h.b.a.cash,before.cash);assert.equal(h.b.a.net,before.net);assert.deepEqual(h.b.a.positions,before.positions);
});
test('shared quote liquidity is never reused for simultaneous opposite entries or after restart',()=>{
 const h=fixture(),batch=prepare(h,[plan(h,{id:'long'}),plan(h,{id:'short',direction:'SHORT'})]);for(const d of batch.ordered)assert.equal(choose(h,d.plan),'ENTRY_PENDING');market(h,T+1100,100,.1);const ps=Object.values(h.b.a.positions);assert.equal(ps.length,2);assert(ps.every(p=>D(p.qty).lte('.01')));near(h.root.secondaryExecution.liquidity.quote_used.ask,'.01');near(h.root.secondaryExecution.liquidity.quote_used.bid,'.01');const unchanged=structuredClone(h.b.a.positions);restart(h,T+1100);market(h,T+1100,100,.1);assert.deepEqual(h.b.a.positions,unchanged);
});
test('isolated BBO margin stress triggers durable real-quote exit, can lose more than deposited margin, never credits a floor',()=>{
 const h=fixture({cash:'80'}),p=open(h,plan(h,{stop:100.019,target:103,spread:'0'}),{spread:'0'});assert.equal(p.plan.execution_contract.leverage,10);const at=T+2200,s=marginSurrogate(p,quote(at,80,1000,'0'),at);assert(s.triggered);assert.equal(s.model,'ISOLATED_ADVERSE_BBO_SURROGATE_NOT_KRAKEN_LIQUIDATION');market(h,at,80,1000,'0');assert.equal(p.exit_intent.reason,'ISOLATED_MARGIN_STRESS');const intent=structuredClone(p.exit_intent);restart(h,at+100);assert.deepEqual(h.b.a.positions.one.exit_intent,intent);market(h,T+3300,79,1000,'0');assert(!h.b.a.positions.one);const close=h.events.find(e=>e.type==='CLOSED');assert(D(close.pnl).lt(D(p.initial_margin).negated()));assert.equal(close.reason,'ISOLATED_MARGIN_STRESS');assert.equal(h.events.filter(e=>e.type==='CLOSED').length,1);near(h.b.a.cash,D(80).plus(close.pnl));
});
test('funding horizon follows new contract duration and stress is separately disclosed',()=>{
 const h=fixture(),p=plan(h,{timeframe:240}),c=p.execution_contract,one=secondaryEconomics(p.entry,p.stop,p.target,p.direction,.01,c,3600000),long=secondaryEconomics(p.entry,p.stop,p.target,p.direction,.01,c,36*3600000);near(long.fundingAllowance,D(one.fundingAllowance).mul(36));const u=riskUnitLoss(p,{fundingRate:'.01'});near(u.funding,'.36');near(D(u.total).minus(u.loss),D(p.entry).mul('.0005'));
});

test('a pending addition is cancelled if the protected parent crosses its floor before the child fill',()=>{
 const h=fixture(),parent=open(h,plan(h,{id:'initial',target:102.5}));market(h,T+2200,100.5);const candidate=prepare(h,[plan(h,{id:'child',at:T+3300,bid:100.5,stop:99.6,target:102.5,confirmation:T+3000})],{bid:100.5}).ordered[0];assert.equal(candidate.capital_allocation_rejection,undefined);assert.equal(choose(h,candidate.plan,{bid:100.5}),'ENTRY_PENDING');market(h,T+4400,100.01);assert.equal(h.b.a.positions.child,undefined);assert.equal(h.b.a.pendingOrders.child,undefined);assert(h.events.some(e=>e.type==='SECONDARY_ENTRY_REJECTED'&&e.id==='child'&&e.reason==='PYRAMID_PARENT_NOT_FAVORABLE_BEFORE_FILL'));assert(parent.exit_intent);
});

test('slot capacity rejects the eleventh unique order, no daily gate is consulted',()=>{
 const h=fixture(),p=prepare(h,[plan(h)]).ordered[0].plan;assert.equal(choose(h,p),'ENTRY_PENDING');const order=h.b.a.pendingOrders.one;
 for(let i=1;i<10;i++){const id='historical-slot-'+i;h.b.a.pendingOrders[id]={...structuredClone(order),plan:{...structuredClone(order.plan),id}};}
 h.root.frequency.daySelections=9999;const d=prepare(h,[plan(h,{id:'eleventh',direction:'SHORT'})]).ordered[0];assert.equal(d.capital_allocation_rejection,'PORTFOLIO_CAPACITY');assert.equal(riskPortfolioSnapshot(h.root).slots,10);
});

test('uncertainty in funding and stale quotes prevent expansions, not base exit supervision',()=>{
 const h=fixture(),parent=open(h,plan(h,{id:'initial',target:102.5}));market(h,T+2200,100.5);parent.funding_pending=[{hour:H,from:T,to:T+100,qty:parent.qty}];
 let d=prepare(h,[plan(h,{id:'funding-child',at:T+3300,bid:100.5,target:103,confirmation:T+3000})],{bid:100.5}).ordered[0];assert.equal(d.capital_allocation_rejection,'PYRAMID_INITIAL_NOT_FAVORABLE_LIQUID');parent.funding_pending=[];
 const stale=prepareRiskCandidates(h.root,[{plan:plan(h,{id:'stale-child',at:T+10000,bid:100.5,target:103,confirmation:T+9000}),pattern:'BREAKOUT'}],{quote:quote(T+3300,100.5),meta:META,now:T+10000,preflight:h.b.preflight.bind(h.b)}).ordered[0];assert.equal(stale.capital_allocation_rejection,'FUTURES_DATA_NOT_FRESH');assert(h.b.a.positions.initial);
});

test('positive parent below its locked floor and expired protection both veto additions before execution',()=>{
 const h=fixture(),p=open(h,plan(h,{id:'initial',target:103}));market(h,T+2200,100.5);const child=prepare(h,[plan(h,{id:'child-positive',at:T+3300,bid:100.5,stop:99.6,target:103,confirmation:T+3000})],{bid:100.5}).ordered[0];assert.equal(choose(h,child.plan,{bid:100.5}),'ENTRY_PENDING');
 const desiredNet=D(p.profit_protection.protected_net).mul('.9'),c=p.plan.execution_contract,bid=D(p.entry).mul(p.qty).plus(p.entry_fee).plus(p.accrued_funding).plus(desiredNet).div(D(p.qty).mul(D(1).minus(c.takerFee))).div(D(1).minus(c.slippage));const v=secondaryEstimate(p,quote(T+4400,bid),T+4400);assert(D(v.net).gt(0));assert(D(v.net).lt(p.profit_protection.protected_net));market(h,T+4400,bid.toString());assert(!h.b.a.positions['child-positive']);assert(h.events.some(e=>e.type==='SECONDARY_ENTRY_REJECTED'&&e.id==='child-positive'&&e.reason==='PYRAMID_PARENT_NOT_FAVORABLE_BEFORE_FILL'));
 const due=fixture(),parent=open(due,plan(due,{id:'timed-parent',target:103}));market(due,T+2200,100.5);const deadline=Math.min(parent.profit_protection.effective_expires_at,parent.profit_protection.stagnation_deadline_at),at=deadline-1100,expiring=prepare(due,[plan(due,{id:'timed-child',at,bid:100.5,target:103,confirmation:at-2000})],{at,bid:100.5}).ordered[0];assert.equal(expiring.capital_allocation_rejection,undefined);assert.equal(choose(due,expiring.plan,{at,bid:100.5}),'ENTRY_PENDING');market(due,deadline+1,100.5);assert(!due.b.a.positions['timed-child']);assert(due.events.some(e=>e.type==='SECONDARY_ENTRY_REJECTED'&&e.id==='timed-child'));assert(parent.exit_intent);
});

test('recomputed hashes cannot bypass receipt arithmetic or the smallest sufficient leverage rule',()=>{
 const h=fixture(),p=prepare(h,[plan(h)]).ordered[0].plan;
 const reseal=x=>{const r=x.execution_contract.risk_budget;r.receipt.hash=hash({...r.receipt,hash:undefined});r.hash=hash({...r,hash:undefined});};
 const bad=structuredClone(p);bad.execution_contract.risk_budget.receipt.initial_margin=D(bad.execution_contract.risk_budget.receipt.initial_margin).plus(1).toString();reseal(bad);assert.throws(()=>validateRiskContract(bad),/ARITHMETIC_INTEGRITY/);
 const raised=structuredClone(p),c=raised.execution_contract,r=c.risk_budget.receipt;c.leverage=r.leverage=5;r.initial_margin=D(r.exposure).div(5).toString();r.reserved=D(r.initial_margin).plus(D(r.exposure).mul(c.takerFee)).plus(r.funding_reserved).toString();reseal(raised);assert.throws(()=>validateRiskContract(raised),/LEVERAGE_NOT_MINIMUM/);
});
