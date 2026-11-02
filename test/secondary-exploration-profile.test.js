// Isolated, deterministic market fixtures. Never runs the operational worker or sends notices.
import test from 'node:test';
import assert from 'node:assert/strict';
import {D,hash} from '../lib/trading/core.js';
import {newAccount} from '../lib/trading/simulator.js';
import {enablePortfolio} from '../lib/trading/portfolio.js';
import {SecondaryBroker,OperationalSecondary,secondaryCandidates,SECONDARY_PROTOCOL} from '../lib/trading/secondary-futures.js';
import {ENTRY_RULES,installEntryRevision} from '../lib/trading/secondary-entry-context.js';
import {EXPLORATION_VERSION,EXPLORATION_ENTRY_REVISION,EXPLORATION_POLICY,installExploration,isExploration,getExplorationPolicy,explorationContract} from '../lib/trading/secondary-exploration.js';
const C=Date.parse('2026-11-02T02:00:00Z'),T=C+2000,H=Math.floor(T/3600000)*3600000;
const ENV={LUMI_RUNTIME_ENV:'staging',LUMI_TRADING_MODE:'PAPER',LUMI_TRADING_STORAGE:'SQLITE',LUMI_TRADING_SECONDARY_PROFILE:EXPLORATION_VERSION};
const META={tick_size:.01,qty_step:.0001,checked_at:T};
const quote=(price=200.8,at=T,size=100)=>({source:'KRAKEN_FUTURES_WS_TICKER',symbol:'PF_XBTUSD',event_at:at,received_at:at,bid:String(price),ask:D(price).plus('.01').toString(),bid_qty:String(size),ask_qty:String(size)});
function accountRoot(){
 const account=newAccount();enablePortfolio(account);Object.assign(account,{cash:'470.46',equity:'470.46',net:'-29.54',fees:'21.62',closed:12,wins:0,losses:12,peak:'500',maxDrawdown:'.05908'});
 return {frequency:{account,counts:{evaluations:0,candidates:0,selected:0,filled:0,closed:0},history:[{type:'CLOSED',id:'historical-loss',pnl:'-5'}],grossClosed:'-7.92',closedFees:'21.62',daySelections:1000},laboratory:{status:'RESEARCH_COMPLETE',active:'rejected-trial',trials:[{status:'REJECTED',net:-29.54}]},primary:{cash:'99',positions:{keep:'unchanged'}}};
}
function setup(){const root=accountRoot(),events=[];let now=T;const broker=new SecondaryBroker({root,now:()=>now,event:e=>events.push(e)});installEntryRevision(root,T,e=>events.push(e));return {root,broker,events,setTime:t=>now=t};}
function bars(tf,fn){return Array.from({length:96},(_,i)=>({start:C-(96-i)*tf*60000,end:C-(95-i)*tf*60000,volume:1,...fn(i)}));}
function fixture(pattern){
 if(pattern==='BREAKOUT'){
  const s={5:bars(5,()=>({open:199.9,high:200.2,low:199.7,close:199.9})),15:bars(15,()=>({open:199.9,high:200.2,low:199.7,close:199.9}))};
  Object.assign(s[5].at(-1),{open:199.9,high:200.9,low:199.9,close:200.8,volume:2});return {s,price:200.8};
 }
 if(pattern==='PULLBACK'){
  const fn=i=>({open:190+i*.1-.01,close:190+i*.1,low:190+i*.1-.03,high:190+i*.1+.06}),s={5:bars(5,fn),15:bars(15,fn)};
  s[5].at(-5).high=200.0;Object.assign(s[5].at(-1),{open:199.45,close:199.6,low:198.8,high:199.65});return {s,price:199.6};
 }
 const s={5:bars(5,i=>{const p=i%2?201:199;return {open:p,close:p,low:p-.1,high:p+.1};}),15:bars(15,()=>({open:200,close:200,low:199.9,high:200.1}))};
 Object.assign(s[5].at(-1),{open:198.2,close:198.3,low:197.7,high:198.5});return {s,price:198.3};
}
function candidate(pattern,policy=EXPLORATION_POLICY,rate=0){const {s,price}=fixture(pattern);return secondaryCandidates(s,quote(price),META,C,T,rate,policy).find(x=>x.pattern===pattern);}
test('exploration migration preserves ledgers, history, legacy hashes and rejected research; repeated install is inert',()=>{
 const h=setup(),before=structuredClone(h.root),count=h.events.length;
 h.root.secondaryExecution.status='HALTED_DRAWDOWN';
 assert.equal(installExploration(h.root,ENV,T,e=>h.events.push(e)),true);
 assert.deepEqual(h.root.frequency,before.frequency);assert.deepEqual(h.root.primary,before.primary);assert.deepEqual(h.root.laboratory,before.laboratory);
 assert.equal(h.root.secondaryExecution.protocol_hash,hash(SECONDARY_PROTOCOL));assert.equal(h.root.secondaryExecution.entry_rules.hash,hash(ENTRY_RULES));
 assert.equal(h.root.secondaryExecution.exploration.baseline.execution_status,'HALTED_DRAWDOWN');assert.equal(h.root.secondaryExecution.status,'ACTIVE_PAPER');
 assert.equal(isExploration(h.root),true);assert.equal(getExplorationPolicy(h.root).nominalUSD,'100');assert.equal(installExploration(h.root,ENV,T+1,e=>h.events.push(e)),false);assert.equal(h.events.length,count+1);
});
test('profile toggles and explicit sizing changes are versioned without rewriting outstanding order contracts',()=>{
 const h=setup();installExploration(h.root,ENV,T);const p=candidate('BREAKOUT').plan;assert(p);h.root.frequency.account.pendingOrders[p.id]={plan:p,placed_at:T+1000};const pending=structuredClone(h.root.frequency.account.pendingOrders);
 assert.equal(installExploration(h.root,{...ENV,LUMI_TRADING_SECONDARY_NOMINAL_USD:'75'},T+1),true);assert.equal(getExplorationPolicy(h.root).nominalUSD,'75');assert.deepEqual(h.root.frequency.account.pendingOrders,pending);
 assert.equal(installExploration(h.root,{...ENV,LUMI_TRADING_SECONDARY_PROFILE:'OFF'},T+2),true);assert.equal(isExploration(h.root),false);assert.equal(getExplorationPolicy(h.root),null);assert.deepEqual(h.root.frequency.account.pendingOrders,pending);
 assert.equal(h.root.secondaryExecution.exploration.history.length,3);assert.equal(installExploration(h.root,{...ENV,LUMI_TRADING_SECONDARY_PROFILE:'OFF'},T+3),false);
});
test('profile rejects live mode, corrupted policy, nonfinite sizes and a missing activation flag after migration',()=>{
 for(const mode of ['LIVE','REAL']){const h=setup();assert.throws(()=>installExploration(h.root,{...ENV,LUMI_TRADING_MODE:mode},T),/PAPER_ONLY/);}
 for(const size of ['Infinity','NaN','0','-1','1e99','']){const h=setup();assert.throws(()=>installExploration(h.root,{...ENV,LUMI_TRADING_SECONDARY_NOMINAL_USD:size},T),/NOMINAL_INVALID/);}
 const h=setup();installExploration(h.root,ENV,T);assert.throws(()=>installExploration(h.root,{...ENV,LUMI_TRADING_SECONDARY_PROFILE:undefined},T),/FLAG_REQUIRED/);
 h.root.secondaryExecution.exploration.policy.nominalUSD='1000';assert.throws(()=>installExploration(h.root,ENV,T),/PROTOCOL_MISMATCH/);
});
test('every confirmed pattern creates an explicit causal taker contract without validation or RR veto',()=>{
 for(const pattern of ['BREAKOUT','PULLBACK','RANGE_REENTRY']){
  const d=candidate(pattern);assert(d.plan,JSON.stringify(d));const p=d.plan;
  assert.equal(p.entry_revision,EXPLORATION_ENTRY_REVISION);assert.equal(p.execution_contract.mode,'TAKER_IOC');assert.equal(p.execution_contract.not_before,T+1000);assert.equal(p.execution_contract.exitLatencyMs,1000);assert.equal(p.expires_at,T+30000);assert.equal(p.execution_contract.nominalUSD,'100');assert.equal(p.quality.validated,false);assert.equal(p.evidence.signal_at,C);assert.equal(p.evidence.decision_at,T);assert(p.evidence.input_hash);
 }
});
test('negative expected net is explicitly labelled, with the same structural stop and target',()=>{
 const before=candidate('BREAKOUT'),costly=candidate('BREAKOUT',EXPLORATION_POLICY,100);
 assert(costly.plan,JSON.stringify(costly));assert(costly.plan.economics.gain<0);assert.equal(costly.plan.quality.classification,'COSTS_NOT_COVERED');assert(costly.plan.quality.labels.includes('ESTIMATED_COSTS_EXCEED_TARGET'));assert.equal(costly.plan.stop,before.plan.stop);assert.equal(costly.plan.target,before.plan.target);
 const legacy=fixture('BREAKOUT');assert.equal(secondaryCandidates(legacy.s,quote(legacy.price),META,C,T,100).find(x=>x.pattern==='BREAKOUT').reason,'COST_OR_NET_RR');
});
test('lack of a pattern, unavailable funding, wrong instrument and future candles never create artificial signals',()=>{
 const {s,price}=fixture('BREAKOUT');Object.assign(s[5].at(-1),{open:199.9,close:199.9,high:200.2,low:199.7,volume:1});assert(secondaryCandidates(s,quote(price),META,C,T,0,EXPLORATION_POLICY).every(x=>!x.plan));
 const f=fixture('BREAKOUT'),before=secondaryCandidates(f.s,quote(f.price),META,C,T,0,EXPLORATION_POLICY);
 for(const tf of [5,15])f.s[tf].push({...f.s[tf].at(-1),start:C,end:C+tf*60000,high:99999,close:99999});assert.deepEqual(secondaryCandidates(f.s,quote(f.price),META,C,T,0,EXPLORATION_POLICY),before);
 assert(secondaryCandidates(f.s,quote(f.price),META,C,T,NaN,EXPLORATION_POLICY).every(x=>!x.plan));assert(secondaryCandidates(f.s,{...quote(f.price),symbol:'BTC/USD'},META,C,T,0,EXPLORATION_POLICY).every(x=>!x.plan));
});
test('maker remains an explicit retest hypothesis with a three-candle expiry and unchanged barriers',()=>{
 const policy=structuredClone(EXPLORATION_POLICY);policy.modes.PULLBACK='MAKER_LIMIT';const d=candidate('PULLBACK',policy);assert(d.plan,JSON.stringify(d));assert.equal(d.plan.execution_contract.mode,'MAKER_LIMIT');assert.equal(d.plan.expires_at,T+900000);assert.equal(d.plan.execution_contract.remainder_policy,'UNTIL_EXPIRY');assert.equal(d.plan.entry,d.plan.limit);
 const taker=candidate('PULLBACK').plan;assert.equal(d.plan.stop,taker.stop);assert.equal(d.plan.target,taker.target);assert.notEqual(d.plan.entry,taker.entry);
});
for(const pattern of ['BREAKOUT','PULLBACK','RANGE_REENTRY'])test('isolated '+pattern+' reaches fill and closure through the existing ledger',()=>{
 const h=setup();installExploration(h.root,ENV,T);const d=candidate(pattern,getExplorationPolicy(h.root)),p=d.plan;assert(p,JSON.stringify(d));const {price}=fixture(pattern),before=D(h.root.frequency.account.cash),oldNet=D(h.root.frequency.account.net);
 assert.equal(h.broker.choose(p,quote(price),META,T),'ENTRY_PENDING');h.setTime(T+1100);h.broker.market(quote(price,T+1100),null,{[H]:0},T+1100);assert(h.root.frequency.account.positions[p.id]);
 h.setTime(T+2200);h.broker.market(quote(Number(p.target)+1,T+2200),null,{[H]:0},T+2200);assert(h.root.frequency.account.positions[p.id]);assert.equal(h.root.frequency.account.positions[p.id].exit_intent.not_before,T+3200);h.setTime(T+3300);h.broker.market(quote(D(p.target).plus('.5').toNumber(),T+3300),null,{[H]:0},T+3300);assert(!h.root.frequency.account.positions[p.id]);const close=h.events.find(x=>x.type==='CLOSED'&&x.id===p.id);assert(close);assert(D(h.root.frequency.account.cash).minus(before).eq(close.pnl),JSON.stringify({cashBefore:before.toString(),cashAfter:h.root.frequency.account.cash,pnl:close.pnl,delta:D(h.root.frequency.account.cash).minus(before).toString()}));assert(D(h.root.frequency.account.net).minus(oldNet).eq(close.pnl));
});

test('technical blocker is an actual per-pattern evaluation once, then recovers inside the same decision window',()=>{
 const h=setup();installExploration(h.root,ENV,T);let now=T;const engine={state:h.root,event:e=>h.events.push(e),notice(){}};
 const runtime=new OperationalSecondary({engine,now:()=>now}).initialize();runtime.state.last_cutoff=C-300000;runtime.quote=quote();
 const before=runtime.state.counts.evaluations;runtime.tick();
 assert.equal(runtime.state.counts.evaluations,before+3);assert.equal(runtime.state.decisions.BREAKOUT.reason,'INSTRUMENT_METADATA_STALE');assert.equal(runtime.state.decisions.BREAKOUT.at,T);
 runtime.tick();assert.equal(runtime.state.counts.evaluations,before+3);
 now=T+1000;runtime.meta=META;runtime.quote=quote(200.8,now);runtime.series=fixture('BREAKOUT').s;runtime.rates={[H]:0};runtime.tick();
 assert.equal(runtime.state.counts.evaluations,before+6);assert.equal(runtime.state.last_cutoff,C);assert.equal(runtime.state.evaluation_blocker,null);assert.equal(runtime.state.decisions.BREAKOUT.at,now);assert.equal(runtime.state.decisions.BREAKOUT.reason,'ENTRY_PENDING');
});

test('compatible release reads the legacy profile before activation and requires explicit OFF afterwards',()=>{
 const h=setup(),legacy={...ENV,LUMI_TRADING_SECONDARY_PROFILE:'secondary-growth-1.0.0'};assert.equal(installExploration(h.root,legacy,T),false);assert.equal(h.root.secondaryExecution.exploration,undefined);
 installExploration(h.root,ENV,T+1);assert.throws(()=>installExploration(h.root,legacy,T+2),/EXPLICIT_DISABLE_REQUIRED/);assert.equal(installExploration(h.root,{...ENV,LUMI_TRADING_SECONDARY_PROFILE:'OFF'},T+2),true);
});
