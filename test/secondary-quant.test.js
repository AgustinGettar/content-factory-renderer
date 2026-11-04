import test from 'node:test';
import assert from 'node:assert/strict';
import {D,hash} from '../lib/trading/core.js';
import {newAccount} from '../lib/trading/simulator.js';
import {enablePortfolio} from '../lib/trading/portfolio.js';
import {SecondaryBroker,secondaryEconomics,SECONDARY_MODEL,SECONDARY_VERSION,secondaryEstimate} from '../lib/trading/secondary-futures-engine.js';
import {OperationalSecondary} from '../lib/trading/secondary-futures.js';
import {EXPLORATION_POLICY,EXPLORATION_VERSION,installExploration,getExplorationPolicy,explorationContract} from '../lib/trading/secondary-exploration.js';
import {EARLY_PROFIT_POLICY,EARLY_PROFIT_POLICY_VERSION,installProfitPolicy,getProfitPolicy,makeProfitContracts,validateProfitContracts} from '../lib/trading/secondary-profit-policy.js';
import {CAPITAL_ALLOCATION_VERSION,installCapitalAllocation} from '../lib/trading/secondary-capital-allocation.js';
import {RISK_BUDGET_VERSION,QUANT_RISK_VERSION,installRiskBudget,prepareRiskCandidates,validateRiskContract} from '../lib/trading/secondary-risk-budget.js';
import {SECONDARY_TIMEFRAMES_VERSION,QUANT_TIMEFRAMES_VERSION,QUANT_TIMEFRAMES_PROTOCOL,installSecondaryTimeframes,getSecondaryTimeframes} from '../lib/trading/secondary-timeframes.js';
import {QUANT_VERSION,QUANT_POLICY,QUANT_STRATEGIES,installQuant,quantPortfolioGuard,quantCandidates,detectQuantPattern,validateQuantContract} from '../lib/trading/quant-strategies.js';
import {featureSnapshot,causalBars,atr,timeCycles,classifyQuantRegime} from '../lib/trading/quant-features.js';
import {referenceLiquidation,quantMarkMargin,evaluateQuantExit,updateQuantPositionContext,observeQuantMicrostructure} from '../lib/trading/quant-management.js';
import {quantitativeMetrics,blockBootstrap,walkForwardSplits,compareExitPaths,calibration,promotionDecision} from '../lib/trading/quant-evaluation.js';
import {secondaryMessage} from '../lib/trading/secondary-futures-runtime.js';
const C=Date.parse('2026-11-04T12:00:00Z'),T=C+2000;
const ENV={LUMI_RUNTIME_ENV:'staging',LUMI_TRADING_MODE:'PAPER',LUMI_TRADING_STORAGE:'SQLITE',LUMI_TRADING_SECONDARY_PROFILE:EXPLORATION_VERSION,LUMI_TRADING_SECONDARY_PROFIT_POLICY:EARLY_PROFIT_POLICY_VERSION,LUMI_TRADING_SECONDARY_CAPITAL_ALLOCATION:CAPITAL_ALLOCATION_VERSION,LUMI_TRADING_SECONDARY_RISK_BUDGET:QUANT_RISK_VERSION,LUMI_TRADING_SECONDARY_TIMEFRAMES:QUANT_TIMEFRAMES_VERSION,LUMI_TRADING_SECONDARY_QUANT:QUANT_VERSION};
const META={symbol:'PF_XBTUSD',qty_step:.0001,tick_size:.01,checked_at:T,margin_schedule:[{numNonContractUnits:0,initialMargin:.1,maintenanceMargin:.05},{numNonContractUnits:30000000,initialMargin:.2,maintenanceMargin:.1}]};
const quote=(at=T,bid=100,size=1000)=>({source:'KRAKEN_FUTURES_WS_TICKER',symbol:'PF_XBTUSD',event_at:at,received_at:at,bid:String(bid),ask:String(bid+.01),bid_qty:String(size),ask_qty:String(size),mark_price:String(bid+.005)});
const bars=(tf=1,{end=C,trend=0}={})=>Array.from({length:256},(_,i)=>{const v=100+trend*i;return {start:end-(256-i)*tf*60000,end:end-(255-i)*tf*60000,open:v,close:v+.02,high:v+.5,low:v-.5,volume:10};});
function fixture({version=QUANT_RISK_VERSION,quant=true}={}){
 let now=C-1000;const account=newAccount();enablePortfolio(account);Object.assign(account,{cash:'1000',equity:'1000',peak:'1000'});const events=[];
 const root={frequency:{account,counts:{evaluations:0,candidates:0},history:[]},laboratory:{status:'RESEARCH_COMPLETE',funding:{initial:'1000',added:'0'}},primary:{untouched:true}};
 const engine={state:root,event:e=>events.push(structuredClone(e)),notice:()=>{}},runtime=new OperationalSecondary({engine,now:()=>now}).initialize();
 installExploration(root,ENV,now);installProfitPolicy(root,ENV,now);installCapitalAllocation(root,ENV,now);installRiskBudget(root,{...ENV,LUMI_TRADING_SECONDARY_RISK_BUDGET:version},now);installSecondaryTimeframes(root,ENV,now);if(quant)installQuant(root,ENV,now);
 return {root,runtime,b:runtime.broker,events,time(t){now=t;},quote,engine};
}
function signal(h,{id='one',timeframe=1,at=T,stop=99.6,target=103,direction='LONG'}={}){
 const c=explorationContract(getExplorationPolicy(h.root),'BREAKOUT',at),entry=D(quote(at)[direction==='LONG'?'ask':'bid']).mul(direction==='LONG'?'1.0002':'.9998'),pc=makeProfitContracts(getProfitPolicy(h.root),{timeframe});
 return {id,signal_key:id,version:SECONDARY_VERSION,execution_model:SECONDARY_MODEL,entry_revision:getProfitPolicy(h.root).entryRevision,instrument:'PAPER:KRAKEN_FUTURES:PF_XBTUSD',pattern:'BREAKOUT',direction,timeframe,entry:entry.toString(),stop:String(stop),target:String(target),limit:'100',confirmed_at:C,decision_at:at,expires_at:c.expires_at,holding_ms:pc.exit_policy.base_holding_ms,execution_contract:c,...pc,order:'FUTURES_TAKER_IOC',fill_model:c.liquidity_model,economics:secondaryEconomics(entry,stop,target,direction,0,c,pc.economic_policy.funding_estimation_ms),entry_context:{structure_key:id,confirmation_key:id,confirmation_event_at:C,price_tick:'.01',remaining_distance:'3'}};
}
const prepare=(h,plans)=>prepareRiskCandidates(h.root,plans.map(plan=>({plan,pattern:plan.pattern})),{quote:quote(),meta:META,now:T,preflight:h.b.preflight.bind(h.b)});

test('features are causal, contain Wilder ATR and preserve missing data as unavailable',()=>{
 const b=bars(),f=featureSnapshot(b,{timeframe:1,cutoff:C,now:T,quote:quote()});assert.equal(f.status,'READY');assert.equal(f.atr14,1);assert(Math.abs(f.ema200-100.02)<1e-10);assert.equal(f.rsi14,50);assert.equal(f.open_interest,null);assert.equal(f.microstructure.full_depth_available,false);assert.equal(f.volume_profile.status,'UNAVAILABLE');
 const future={...b.at(-1),start:C,end:C+60000,close:999,high:1000};assert.deepEqual(featureSnapshot([...b,future],{timeframe:1,cutoff:C,now:T,quote:quote()}),f);
 b.at(-1).available_at=T+1;assert.equal(causalBars(b,{timeframe:1,cutoff:C,now:T}),null);
 b.at(-1).available_at=T;b.at(-1).volume=null;assert.equal(causalBars(b,{timeframe:1,cutoff:C,now:T}),null);
 assert.equal(timeCycles(C).timezone,'UTC');assert(Math.abs(timeCycles(C).hour_sin)<1e-10);
});
test('every registered strategy has regime and timeframe vetoes; reversal cannot trade accelerated trend',()=>{
 const b=bars(),f=featureSnapshot(b,{timeframe:1,cutoff:C,now:T,quote:quote()});
 for(const id of Object.keys(QUANT_STRATEGIES)){assert.equal(detectQuantPattern(id,b,{...f,timeframe:999},f,{regime:'RANGE'}).reason,'STRATEGY_TIMEFRAME_NOT_ENABLED');assert.equal(detectQuantPattern(id,b,{...f,timeframe:QUANT_STRATEGIES[id].frames[0]},f,{regime:'ILLIQUID'}).reason,'REGIME_NOT_ELIGIBLE');}
 assert.equal(detectQuantPattern('SCALP_REVERSION',b,f,{...f,adx:40},{regime:'RANGE',accelerated:true}).reason,'REVERSAL_AGAINST_STRONG_TREND');
 assert.equal(classifyQuantRegime({...f,microstructure:{spread_bps:100}}).regime,'ILLIQUID');
});
test('all nine detectors require specific independent confirmations and recognize their fixture',()=>{
 for(const id of Object.keys(QUANT_STRATEGIES)){
  const b=bars(),f={...featureSnapshot(b,{timeframe:1,cutoff:C,now:T,quote:quote()}),timeframe:QUANT_STRATEGIES[id].frames[0],ema9:100,ema21:99.8,plus_di:30,minus_di:10,relative_volume:2,rsi14:40,macd_histogram:.1};
  const c={...f,normalized_slope:.1,adx:10},r={regime:QUANT_STRATEGIES[id].regimes[0],accelerated:false};
  Object.assign(b.at(-1),{open:100,close:100.8,high:100.9,low:99.9});
  if(['SCALP_REVERSION','MEAN_REVERSION','RANGE_TRADING','LIQUIDITY_SWEEP'].includes(id))Object.assign(b.at(-1),{open:99.6,close:100.1,high:100.2,low:99.2});
  if(id==='BREAKOUT_RETEST'){Object.assign(b.at(-2),{close:101,high:101.1,volume:20});Object.assign(b.at(-1),{open:100.4,close:100.8,high:100.9,low:100.45});}
  if(id==='VOLATILITY_EXPANSION')for(const x of b.slice(-6,-1))Object.assign(x,{high:100.1,low:99.9});
  const d=detectQuantPattern(id,b,f,c,r);assert.equal(d.direction,'LONG',id+': '+JSON.stringify(d));assert(d.stop<d.target);assert(d.confirmation_at<=C);
 }
});
test('timeframe v2 migration preserves cursors/accounts, adds 1m and 30m, and requires PAPER',()=>{
 const h=fixture({quant:false});installSecondaryTimeframes(h.root,{...ENV,LUMI_TRADING_SECONDARY_TIMEFRAMES:SECONDARY_TIMEFRAMES_VERSION},C);
 const before=structuredClone(h.root.frequency),prior=structuredClone(getSecondaryTimeframes(h.root).frames[60]);installSecondaryTimeframes(h.root,ENV,C);
 assert.deepEqual(h.root.frequency,before);assert.deepEqual(getSecondaryTimeframes(h.root).frames[60],prior);assert(getSecondaryTimeframes(h.root).policy.data_frames.includes(30));assert(getSecondaryTimeframes(h.root).frames[1]);assert.equal(validateProfitContracts(signal(h)),true);assert.throws(()=>installQuant(h.root,{...ENV,LUMI_TRADING_MODE:'REAL'},T),/PAPER_ONLY/);
});
test('1m/15m/1h/4h can reserve independently but BTC directional risk stays within 1%',()=>{
 const h=fixture(),batch=prepare(h,[signal(h,{id:'fast',timeframe:1}),signal(h,{id:'slow',timeframe:60})]);assert.equal(batch.eligible_count,2,JSON.stringify(batch.receipts));
 let risk=D(0);for(const d of batch.ordered){assert.equal(d.capital_allocation_rejection,undefined);assert.equal(d.plan.parent_id,null);validateRiskContract(d.plan);risk=risk.plus(d.plan.execution_contract.risk_budget.receipt.risk);assert.equal(h.b.choose(d.plan,quote(),META,T),'ENTRY_PENDING');}
 assert(risk.lte(10));assert.equal(new Set(batch.ordered.map(d=>d.plan.movement_id)).size,2);
 h.time(T+1100);h.b.market(quote(T+1100),null,{[C]:0},T+1100);assert.equal(Object.keys(h.b.a.positions).length,2);
 const root=JSON.parse(JSON.stringify(h.root));assert.doesNotThrow(()=>new SecondaryBroker({root,now:()=>T+1200}));
 const first=h.b.a.positions.fast;h.b.close(first,quote(T+2200),T+2200,'MANUAL_CLOSE');h.b.close(first,quote(T+3300),T+3300,'MANUAL_CLOSE');assert(!h.b.a.positions.fast);assert(h.b.a.positions.slow);
});
test('risk v2 retains old signed positions and blocks unsupported hedging',()=>{
 const h=fixture({version:RISK_BUDGET_VERSION,quant:false}),p=prepare(h,[signal(h,{timeframe:5})]).ordered[0].plan;assert.equal(h.b.choose(p,quote(),META,T),'ENTRY_PENDING');h.time(T+1100);h.b.market(quote(T+1100),null,{[C]:0},T+1100);const before=structuredClone(h.b.a.positions.one);
 installRiskBudget(h.root,ENV,T+1200);assert.deepEqual(h.b.a.positions.one,before);assert.doesNotThrow(()=>new SecondaryBroker({root:JSON.parse(JSON.stringify(h.root)),now:()=>T+1300}));
 assert.equal(prepare(h,[signal(h,{id:'hedge',direction:'SHORT',stop:101,target:97})]).ordered[0].capital_allocation_rejection,'HEDGE_MODE_NOT_VALIDATED');
});
test('risk cap survives concurrent preparations and rechecks before selection',()=>{
 const h=fixture(),plans=[1,5,15,60,240].map(tf=>signal(h,{id:'f'+tf,timeframe:tf,stop:98,target:105}));const batch=prepare(h,plans);const risk=batch.receipts.filter(x=>x.accepted).reduce((s,x)=>s+Number(x.risk),0);assert(risk<=10+1e-8);assert(batch.eligible_count<=3);assert(batch.ordered.some(d=>d.capital_allocation_rejection));
});
test('daily/drawdown guards stop only new admissions, never mutate positions or replenish capital',()=>{
 const h=fixture(),before=structuredClone(h.root.frequency.account.positions);assert(quantPortfolioGuard(h.root,T).accepted);h.b.a.equity='960';assert.equal(quantPortfolioGuard(h.root,T+1).reason,'QUANT_DAILY_LOSS_LIMIT');h.b.a.equity='890';assert.equal(quantPortfolioGuard(h.root,T+2).reason,'QUANT_DRAWDOWN_REVIEW_REQUIRED');h.b.a.equity='1100';assert.equal(quantPortfolioGuard(h.root,T+86400000).accepted,false);assert.deepEqual(h.root.frequency.account.positions,before);assert.equal(h.root.frequency.account.cash,'1000');
});
test('reference liquidation balances mark equity and maintenance for long and short',()=>{
 for(const direction of ['LONG','SHORT']){const r=referenceLiquidation({entry:100,qty:2,margin:20,direction}),p=Number(r.price),equity=20+(direction==='LONG'?1:-1)*(p-100)*2;assert(Math.abs(equity-p*2*.0505)<1e-10);assert.equal(r.actual_exchange_liquidation,false);}
});
test('bounded microstructure uses real signed trade quantities and labels incomplete coverage',()=>{
 const s={};observeQuantMicrostructure(s,{q:quote()},T);observeQuantMicrostructure(s,{t:{event_at:T,side:'buy',qty:.4,type:'fill'}},T);observeQuantMicrostructure(s,{t:{event_at:T,side:'sell',qty:.1,type:'liquidation'}},T);assert.equal(s.microstructure.windows[0].cvd_btc,.4-.1);assert.equal(s.microstructure.windows[0].liquidation_btc,.1);assert.equal(s.microstructure.windows[0].authority,'OBSERVATION_ONLY');
});
test('all clocks evaluate naturally once, including 1m, without using neural model outside its domain',()=>{
 const h=fixture();h.runtime.series=Object.fromEntries(QUANT_TIMEFRAMES_PROTOCOL.data_frames.map(tf=>[tf,bars(tf,{end:Math.floor(C/(tf*60000))*tf*60000})]));h.runtime.meta=META;h.runtime.quote=quote();h.runtime.rates={[C]:0};h.engine.secondaryNeural={prepare(){throw Error('wrong domain');}};h.time(T);h.runtime.tick();
 for(const tf of [1,5,15,60,240]){const f=getSecondaryTimeframes(h.root).frames[tf];assert.equal(f.counts.completed,1,String(tf));assert.equal(f.counts.pattern_checks,9);assert(f.quant_regime);}
 const count=h.events.length;h.runtime.tick();assert.equal(h.events.length,count);assert.equal(h.root.secondaryExecution.quant.counts.errors,0);
});
test('net statistics do not turn gross or win rate into profit; consistent daily intervals required',()=>{
 const m=quantitativeMetrics([{net:1,gross:2,costs:1},{net:1,gross:2,costs:1},{net:-5,gross:-4,costs:1}]);assert.equal(m.net_realized,-3);assert.equal(m.win_rate,2/3);assert.equal(m.profit_factor,.4);assert.equal(m.expectancy,-1);assert.equal(m.sharpe,null);assert.equal(m.periodicity_valid,false);
 assert.equal(blockBootstrap([1,2,3]).status,'INSUFFICIENT_DATA');assert.deepEqual(blockBootstrap(Array(100).fill(1)),blockBootstrap(Array(100).fill(1)));assert(Math.abs(calibration([1,0],[.8,.2]).brier-.04)<1e-12);
});
test('purged walk-forward excludes overlapping outcomes and embargo; no automatic promotion',()=>{
 const rows=Array.from({length:40},(_,i)=>({start:i*1000,end:i*1000+2500}));for(const f of walkForwardSplits(rows,{embargoMs:1000}))for(const i of f.train)assert(rows[i].end<f.test_start-1000);
 assert.equal(promotionDecision({metrics:{eligible:5}}).decision,'RESEARCH_ONLY');
});
test('replay compares +0.40 before a missed +0.60 target without claiming a live fill',()=>{
 const r=compareExitPaths([{id:'observed-shape',target_net:.6,original_net:-.3,samples:[{net:-.1},{net:.4},{net:.28},{net:-.3}]}]);assert.equal(r.variants.ORIGINAL.net_realized,-.3);assert.equal(r.variants.MFE_TRAILING.net_realized,.28);assert.equal(r.execution_validated,false);assert.equal(r.variants.MFE_TRAILING.bootstrap.status,'INSUFFICIENT_DATA');
});

test('new momentum plan traverses risk, broker fill and restart; causal proofs cannot be mutated',()=>{
 const h=fixture(),b=bars(1,{trend:.05}),context=bars(5,{trend:.05});Object.assign(b.at(-1),{open:112.75,low:112.65,high:113.6,close:113.5,volume:30});
 const q=quote(T,113.5),args=[{1:b,5:context},q,META,C,T,0,EXPLORATION_POLICY,EARLY_PROFIT_POLICY,{timeframe:1,contextTimeframe:5,timeframeVersion:QUANT_TIMEFRAMES_VERSION}];
 const decisions=quantCandidates(...args),unchanged=structuredClone(decisions),candidate=decisions.find(x=>x.pattern==='MOMENTUM');assert(candidate.plan,JSON.stringify(candidate));
 assert(validateQuantContract(candidate.plan));assert(validateProfitContracts(candidate.plan));
 const bad=structuredClone(candidate.plan);bad.quant_contract.features.close++;assert.throws(()=>validateQuantContract(bad),/INTEGRITY/);
 const prepared=prepareRiskCandidates(h.root,[candidate],{quote:q,meta:META,now:T,preflight:h.b.preflight.bind(h.b)}).ordered[0];assert.equal(prepared.capital_allocation_rejection,undefined);assert.equal(h.b.choose(prepared.plan,q,META,T),'ENTRY_PENDING');
 h.time(T+1100);h.b.market(quote(T+1100,113.5),null,{[C]:0},T+1100);const p=h.b.a.positions[prepared.plan.id];assert(p);assert(p.plan.quant_contract);assert.doesNotThrow(()=>new SecondaryBroker({root:JSON.parse(JSON.stringify(h.root)),now:()=>T+1200}));
 assert.equal(quantMarkMargin(p,quote(T+1200,113.5),T+1200).mark_basis,'OBSERVED_MARK_PRICE');
 const noMeta=quantCandidates(...[args[0],q,{...META,margin_schedule:[]},...args.slice(3)]);assert(noMeta.every(d=>d.reason==='QUANT_MARGIN_SCHEDULE_UNVERIFIED'));
 b.push({...b.at(-1),start:C,end:C+60000,close:10000,high:10001});assert.deepEqual(quantCandidates(...args),unchanged);
});

test('technical trailing only tightens and never invents an executable net break-even',()=>{
 const h=fixture(),d=prepare(h,[signal(h)]).ordered[0];h.b.choose(d.plan,quote(),META,T);h.time(T+1100);h.b.market(quote(T+1100),null,{[C]:0},T+1100);const p=h.b.a.positions.one;
 // Isolate management from plan generation; previous test validates signed plans.
 p.plan.quant_contract={version:QUANT_VERSION};p.profit_protection.trailing_activated_at=T+2000;
 const f={cutoff:C+60000,atr14:.2,ema9:100.7,ema21:100.6,adx:30,macd_histogram:.1,close:101,structure:{lows:[{price:100.5}],highs:[],bos_down:false,bos_up:true}};
 updateQuantPositionContext(h.root,1,f,C+62000);const q=quote(C+62000,101),v=secondaryEstimate(p,q,C+62000),out=evaluateQuantExit(p,q,v,C+62000);assert.equal(out.reason,null);assert(Number(p.quant_management.stop)>Number(p.plan.stop));const stop=p.quant_management.stop;
 const lower=quote(C+63000,100.9);evaluateQuantExit(p,lower,secondaryEstimate(p,lower,C+63000),C+63000);assert(Number(p.quant_management.stop)>=Number(stop));
 const hit=quote(C+64000,Number(stop)-.01);assert.equal(evaluateQuantExit(p,hit,secondaryEstimate(p,hit,C+64000),C+64000).reason,'QUANT_TECHNICAL_TRAILING');
});

test('quant notices describe active clocks, leverage, limits and experimental evidence',()=>{
 assert.match(secondaryMessage({kind:'SECONDARY_TIMEFRAMES',payload:{version:QUANT_TIMEFRAMES_VERSION}}),/1 min, 5 min, 15 min/);
 assert.match(secondaryMessage({kind:'SECONDARY_RISK_POLICY',payload:{version:QUANT_RISK_VERSION}}),/1×, 2×, 3×, 5× o 10×/);
 assert.match(secondaryMessage({kind:'SECONDARY_QUANT',payload:{}}),/no demuestra rentabilidad/);
});
