// Functional fixtures only: isolated PAPER accounts and synthetic executable BBO.
// These tests do not insert trades into the worker or claim historical returns.
import test from 'node:test';
import assert from 'node:assert/strict';
import {D,hash} from '../lib/trading/core.js';
import {SECONDARY_MODEL,SECONDARY_VERSION,secondaryEstimate} from '../lib/trading/secondary-futures-math.js';
import {SecondaryBroker,secondaryEconomics} from '../lib/trading/secondary-futures-engine.js';
import {newAccount} from '../lib/trading/simulator.js';
import {enablePortfolio} from '../lib/trading/portfolio.js';
import {installExploration,getExplorationPolicy,explorationContract,EXPLORATION_VERSION} from '../lib/trading/secondary-exploration.js';
import {PROFIT_POLICY,PROFIT_ENTRY_REVISION,EARLY_PROFIT_POLICY,EARLY_PROFIT_POLICY_VERSION,EARLY_PROFIT_ENTRY_REVISION,EARLY_PROFIT_HORIZONS,makeProfitContracts,validateProfitContracts,installProfitPolicy} from '../lib/trading/secondary-profit-policy.js';
import {initializeProfitProtection,validateProfitProtection,evaluateProfitProtection,markProfitExitPending,scaleProfitProtection} from '../lib/trading/secondary-profit-protection.js';
const T=Date.parse('2026-11-03T10:00:02Z'),H=Math.floor(T/3600000)*3600000;
const clone=x=>structuredClone(x),near=(a,b)=>assert(D(a).minus(b).abs().lt('1e-12'),`${a} != ${b}`);
const ENV={LUMI_RUNTIME_ENV:'staging',LUMI_TRADING_MODE:'PAPER',LUMI_TRADING_STORAGE:'SQLITE',LUMI_TRADING_SECONDARY_PROFILE:EXPLORATION_VERSION,LUMI_TRADING_SECONDARY_PROFIT_POLICY:EARLY_PROFIT_POLICY_VERSION};
function position({direction='LONG',qty='3',entry='100',timeframe=5,policy=EARLY_PROFIT_POLICY}={}){
 const contracts=makeProfitContracts(policy,{timeframe}),holding=contracts.exit_policy.base_holding_ms;
 const p={plan:{id:'synthetic-protection',version:SECONDARY_VERSION,execution_model:SECONDARY_MODEL,instrument:'PAPER:KRAKEN_FUTURES:PF_XBTUSD',entry_revision:policy.entryRevision,direction,pattern:'PULLBACK',timeframe,target:direction==='LONG'?'100.5':'99.5',stop:direction==='LONG'?'98':'102',holding_ms:holding,execution_contract:{version:'synthetic',realTrading:false,slippage:'0.0002',takerFee:'0.0005',participation:'.1'},sizing:{target_net:'.6'},...contracts},entry,qty,entry_fee:D(entry).mul(qty).mul('.0005').toString(),accrued_funding:'0',funding_pending:[],closed_funding_pending:[],quality:'OBSERVED',entered_at:T,expires_at:T+holding};
 initializeProfitProtection(p,T);return p;
}
function quoteForNet(p,net,at,spread='.01',size='100'){
 const short=p.plan.direction==='SHORT',fee=D(p.plan.execution_contract.takerFee),slip=D(p.plan.execution_contract.slippage),qty=D(p.qty),cost=D(p.entry_fee).plus(p.accrued_funding).plus(net);
 const price=(short?D(p.entry).mul(qty).minus(cost).div(qty.mul(D(1).plus(fee))):D(p.entry).mul(qty).plus(cost).div(qty.mul(D(1).minus(fee)))).div(short?D(1).plus(slip):D(1).minus(slip));
 return {source:'KRAKEN_FUTURES_WS_TICKER',symbol:'PF_XBTUSD',event_at:at,received_at:at,bid:(short?price.minus(spread):price).toString(),ask:(short?price:price.plus(spread)).toString(),bid_qty:size,ask_qty:size,suspended:false};
}
function observe(p,net,at,options={}){
 const q=options.quote??quoteForNet(p,net,at,options.spread),v=secondaryEstimate(p,q,at);
 return evaluateProfitProtection(p,q,v,at,{availableQty:options.availableQty??p.qty});
}
function latch(p,reason,at){p.exit_intent={reason,decided_at:at,evidence_at:at,evidence_received_at:at,trigger_price:'100',not_before:at+1000,valid_until:null};markProfitExitPending(p,p.exit_intent);}

for(const direction of ['LONG','SHORT'])test(`${direction}: negative → +.40 → retracement activates before structural target and protects +.30`,()=>{
 const p=position({direction}),signed=clone(p.plan);
 assert.equal(observe(p,'-.15',T+1000).activated,false);assert.equal(p.profit_protection.activation_blocker,'NET_BELOW_ACTIVATION_MINIMUM');
 const q=quoteForNet(p,'.40',T+2000);assert(direction==='LONG'?D(q.bid).lt(p.plan.target):D(q.ask).gt(p.plan.target));
 const r=observe(p,'.40',T+2000,{quote:q});assert(r.activated);assert.equal(r.events[0].type,'PROFIT_PROTECTION_ACTIVATED');near(p.profit_protection.required_activation_net,'.08');near(p.profit_protection.peak_net,'.40');near(p.profit_protection.protected_net,'.30');near(p.profit_protection.retracement_allowance,'.10');
 assert.equal(observe(p,'.31',T+3000).reason,null);assert.equal(observe(p,'.29',T+4000).reason,'TRAILING_RETRACEMENT');assert.deepEqual(p.plan,signed);
});
test('continued gains lift the floor; wider uncertainty never lowers it or charges costs twice',()=>{
 const p=position();assert(!observe(p,'.01',T+1000).activated);observe(p,'.4',T+2000);assert.equal(observe(p,'.8',T+3000).reason,null);near(p.profit_protection.protected_net,'.6');
 const oldFloor=p.profit_protection.protected_net;assert.equal(observe(p,'.85',T+4000,{spread:'.4'}).reason,null);assert(D(p.profit_protection.protected_net).gte(oldFloor));near(p.profit_protection.retracement_allowance,'.6');
 // Liquidation already contains bid/ask, adverse slip, entry and exit fees.
 const q=quoteForNet(p,'.85',T+5000,'.4'),v=secondaryEstimate(p,q,T+5000);near(v.net,'.85');near(v.net,D(v.gross).minus(v.entry_cost).minus(v.exit_fee).minus(v.funding));assert.equal(p.accrued_funding,'0');assert.equal(p.plan.exit_policy.min_activation_net_fraction,undefined);
});
test('an insufficient small positive mark reports its effective floor threshold without waiting for the target',()=>{
 const p=position();const r=observe(p,'.04',T+1000);assert(!r.activated);assert.equal(r.blocker,'NET_BELOW_ACTIVATION_MINIMUM');assert.equal(r.events[0].type,'PROFIT_PROTECTION_NOT_EXECUTABLE');near(r.events[0].required_net,'.08');assert.equal(p.profit_protection.activation_target_required,false);
 const r2=observe(p,'.07',T+2000);assert(!r2.activated);assert.equal(r2.events.length,0);assert.equal(p.profit_protection.activation_blocker,'NET_BELOW_ACTIVATION_MINIMUM');
});
test('funding, stale quotes and shared liquidity cannot manufacture executable peaks; recovery is causal',()=>{
 const p=position();assert.equal(observe(p,'.4',T+1000,{availableQty:'1'}).blocker,'EXECUTABLE_LIQUIDITY_INSUFFICIENT');assert.equal(p.profit_protection.peak_net,null);
 p.funding_pending=[{hour:H,qty:p.qty,from:T,to:T+1000}];assert.equal(observe(p,'.4',T+2000).blocker,'FUNDING_UNRESOLVED');p.funding_pending=[];
 const stale=quoteForNet(p,'9',T+1000);assert.equal(observe(p,'9',T+8000,{quote:stale}).blocker,'TRAILING_MARKET_DATA_UNUSABLE');assert.equal(p.profit_protection.peak_net,null);
 observe(p,'.4',T+9000);assert.equal(observe(p,'5',T+10000,{availableQty:'0'}).blocker,'TRAILING_PEAK_LIQUIDITY_INSUFFICIENT');near(p.profit_protection.peak_net,'.4');assert.equal(observe(p,'-.1',T+11000,{availableQty:'0'}).reason,'TRAILING_RETRACEMENT');
});
test('latched exit survives a loss, rebound, incomplete funding, partial quantity and restart',()=>{
 const p=position();observe(p,'.4',T+1000);assert.equal(observe(p,'-.10',T+2000).reason,'TRAILING_RETRACEMENT');latch(p,'TRAILING_RETRACEMENT',T+2000);
 const intent=clone(p.exit_intent),unitFloor=p.profit_protection.protected_net_per_unit;p.realized={net:'-.02'};p.closed_qty='1';p.qty='2';p.entry_fee=D(p.entry_fee).mul(2).div(3).toString();
 scaleProfitProtection(p,'3','2',T+4000);assert.equal(p.profit_protection.protected_net_per_unit,unitFloor);near(p.profit_protection.protected_net,'.20');near(p.profit_protection.required_activation_net,D('.08').mul(2).div(3));assert(validateProfitProtection(clone(p)));
 p.funding_pending=[{hour:H,qty:p.qty,from:T,to:T+3000}];assert.equal(observe(p,'-.2',T+5000).reason,'TRAILING_RETRACEMENT');assert.equal(observe(p,'1',T+6000).reason,'TRAILING_RETRACEMENT');assert.deepEqual(p.exit_intent,intent);
});
test('entry fragments before protection rebase the small floor; additions after activation require a separate contract',()=>{
 const p=position({qty:'1'});observe(p,'.02',T+1000);p.qty='3';p.entry='100.01';p.entry_fee='0.150015';initializeProfitProtection(p,T+2000);near(p.profit_protection.min_protected_net_per_unit,D('.05').div(3));assert.equal(p.profit_protection.min_protected_basis_qty,'3');
 observe(p,'.4',T+3000);const bad=clone(p);bad.qty='4';assert.throws(()=>initializeProfitProtection(bad,T+4000),/STATE_INTEGRITY/);
});
test('all new horizons are signed, bounded and independent of repeated progress; old contracts retain target gate and coupling',()=>{
 for(const timeframe of [5,15,60,240]){
  const p=position({timeframe}),h=EARLY_PROFIT_HORIZONS[timeframe];assert(validateProfitContracts(p.plan));assert.equal(p.plan.economic_policy.funding_estimation_ms,h.base_holding_ms+h.trailing_extension_ms);observe(p,'.4',T+1000);assert.equal(p.profit_protection.effective_expires_at,T+h.base_holding_ms+h.trailing_extension_ms);observe(p,'.8',T+2000);assert.equal(p.profit_protection.effective_expires_at,T+h.base_holding_ms+h.trailing_extension_ms);
  assert.equal(observe(p,'1',p.profit_protection.effective_expires_at).reason,'TIMEOUT_EXTENDED');
 }
 const old=position({policy:PROFIT_POLICY,qty:'1'});old.plan.target='103';const signed=clone(old.plan);assert.equal(old.plan.entry_revision,PROFIT_ENTRY_REVISION);assert(!observe(old,'.4',T+1000).activated);assert.deepEqual(old.plan,signed);
 const bad=clone(old.plan);bad.exit_policy.min_activation_net_fraction='.0001';bad.exit_policy.hash=hash({...bad.exit_policy,hash:undefined});assert.throws(()=>validateProfitContracts(bad),/PARAMETERS_INVALID/);
 const fresh=position().plan;fresh.economic_policy.min_expected_net_target_fraction='.003';fresh.economic_policy.hash=hash({...fresh.economic_policy,hash:undefined});assert(validateProfitContracts(fresh));fresh.exit_policy.hash='0'.repeat(64);assert.throws(()=>validateProfitContracts(fresh),/INTEGRITY/);
});

const q=(at=T)=>({source:'KRAKEN_FUTURES_WS_TICKER',symbol:'PF_XBTUSD',event_at:at,received_at:at,bid:'100',ask:'100.01',bid_qty:'100',ask_qty:'100',suspended:false});
function fixture(){
 let now=T;const account=newAccount();enablePortfolio(account);Object.assign(account,{cash:'500',equity:'500',peak:'500'});
 let root={frequency:{account,counts:{evaluations:0,candidates:0,selected:0,filled:0,closed:0,notFilled:0},history:[],grossClosed:'0',closedFees:'0'},laboratory:{status:'RESEARCH_COMPLETE',trials:[],funding:{initial:'500',added:'0',count:0}},research:{active:'primary',versions:{primary:{account:{cash:'100'}}}}};
 const events=[],notices=[];let broker;const restart=()=>{root=JSON.parse(JSON.stringify(root));broker=new SecondaryBroker({root,now:()=>now,event:e=>events.push(clone(e)),notice:(...args)=>notices.push(clone(args))});};restart();installExploration(root,ENV,T);installProfitPolicy(root,ENV,T);
 return {get broker(){return broker;},get root(){return root;},events,notices,restart,market(quote,at=quote.event_at){now=at;broker.market(quote,null,{[H]:0},at);}};
}
function open(h,{id='new-v2',direction='LONG',at=T,policy=EARLY_PROFIT_POLICY}={}){
 const contract=explorationContract(getExplorationPolicy(h.root),'BREAKOUT',at),short=direction==='SHORT',entry=D(short?q(at).bid:q(at).ask).mul(short?'.9998':'1.0002'),stop=short?'102':'98',target=short?'97':'103';
 const plan={id,signal_key:hash(['v2-test',id]),version:SECONDARY_VERSION,entry_revision:policy.entryRevision,execution_model:SECONDARY_MODEL,instrument:'PAPER:KRAKEN_FUTURES:PF_XBTUSD',pattern:'BREAKOUT',direction,recipe:'BREAKOUT',recipe_title:'SYNTHETIC ONLY',timeframe:5,entry:entry.toString(),limit:'100',stop,target,confirmed_at:Math.floor(at/300000)*300000,decision_at:at,expires_at:contract.expires_at,holding_ms:1800000,order:'FUTURES_TAKER_IOC',execution_contract:contract,fill_model:contract.liquidity_model,economics:secondaryEconomics(entry,stop,target,direction,0,contract),...makeProfitContracts(policy),entry_context:{version:'secondary-entry-context-economics-1.0.0',structure_key:'s:'+id,movement_key:'m:'+id,confirmation_key:'c:'+id,confirmation_event_at:at-1000,confirmation_at:at-1000,price_tick:'.01',remaining_distance:'3',remaining_distance_fraction:'.03'}};
 assert.equal(h.broker.choose(plan,q(at),{symbol:'PF_XBTUSD',qty_step:.0001,tick_size:.01,checked_at:at},at),'ENTRY_PENDING');h.market(q(at+1100));const p=h.broker.a.positions[id];assert(p);return p;
}
for(const direction of ['LONG','SHORT'])test(`${direction} broker executes a gap below +.30 at actual later quote, never at the floor`,()=>{
 const h=fixture(),p=open(h,{direction}),cash='500';h.market(quoteForNet(p,'.4',T+2200));near(p.profit_protection.protected_net,'.3');assert(!p.exit_intent);
 h.market(quoteForNet(p,'-.05',T+3300));assert.equal(p.exit_intent.reason,'TRAILING_RETRACEMENT');const trigger=clone(p.exit_intent);h.market(quoteForNet(p,'-.08',T+3800));assert(h.broker.a.positions[p.plan.id]);h.restart();const restored=h.broker.a.positions[p.plan.id];assert.deepEqual(restored.exit_intent,trigger);
 h.market(quoteForNet(restored,'-.2',T+4400));assert(!h.broker.a.positions[p.plan.id]);const close=h.events.find(e=>e.type==='CLOSED');assert(close);near(close.pnl,'-.2');near(D(h.broker.a.cash).minus(cash),close.pnl);assert(D(close.pnl).lt(close.profit_protection.protected_net));assert.equal(h.events.filter(e=>e.type==='CLOSED').length,1);
});
test('partial broker closes consume liquidity once and preserve unit protection until final reconciliation',()=>{
 const h=fixture(),p=open(h);h.market(quoteForNet(p,'.4',T+2200));h.market(quoteForNet(p,'.28',T+3300));const floor=p.profit_protection.protected_net_per_unit;
 h.market(quoteForNet(p,'.26',T+4400,'.01','1'));assert.equal(p.profit_protection.state,'PARTIALLY_CLOSED');assert.equal(p.profit_protection.protected_net_per_unit,floor);const qty=p.qty;h.restart();let restored=h.broker.a.positions[p.plan.id];assert.equal(restored.qty,qty);h.market(quoteForNet(restored,'.2',T+4400,'.01','1'));assert.equal(restored.qty,qty);
 h.market(quoteForNet(restored,'.2',T+5500));const e=h.events.find(e=>e.type==='CLOSED');assert(e);const fragments=h.events.filter(e=>e.type==='PARTIAL_CLOSE');near(e.pnl,fragments.reduce((sum,r)=>sum.plus(r.pnl),D(0)).plus(e.fill_pnl));near(D(h.broker.a.cash).minus(500),e.pnl);assert.equal(h.events.filter(e=>e.type==='CLOSED').length,1);
});
test('activating v2 changes admission only and preserves existing v1 pending and open contracts',()=>{
 const h=fixture();installProfitPolicy(h.root,{...ENV,LUMI_TRADING_SECONDARY_PROFIT_POLICY:PROFIT_POLICY.version},T);const old=open(h,{policy:PROFIT_POLICY}),before=clone(h.broker.a),primary=clone(h.root.research);
 installProfitPolicy(h.root,ENV,T+1500);assert.deepEqual(h.broker.a,before);assert.deepEqual(h.root.research,primary);h.market(quoteForNet(old,'.4',T+2200));assert.equal(old.profit_protection.trailing_activated_at,null);assert.equal(old.plan.entry_revision,PROFIT_ENTRY_REVISION);
});
