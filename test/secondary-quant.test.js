import test from 'node:test';
import assert from 'node:assert/strict';
import {closedBars} from '../lib/trading/multi-pattern-paper.js';
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
import {QuantResearchBroker,partitionQuantity,planScaleIn,checkScaleInLeg} from '../lib/trading/quant-experiments.js';
import {projectSecondaryActivity} from '../lib/trading/secondary-monitor-activity.js';
import {operationExitView,liveBody} from '../lib/trading/dashboard-publisher.js';
import {evaluateQuantMeta,META_FEATURES,quantMetaDataset} from '../lib/trading/quant-meta-label.js';
import {OPPORTUNITY_VERSION,OPPORTUNITY_POLICY,installOpportunities,getOpportunityProfile,opportunityContract,flowComparison} from '../lib/trading/quant-opportunities.js';
import {normalizeAnalytics,analyticsSnapshot,PublicAnalyticsFeed} from '../lib/trading/quant-public-analytics.js';
import {evaluateEntryEconomics} from '../lib/trading/secondary-entry-economics.js';
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

test('opportunity activation preserves ledger and requires explicit PAPER flag; repeat is idempotent',()=>{
 const h=fixture(),before=structuredClone(h.root.frequency),env={...ENV,LUMI_TRADING_SECONDARY_OPPORTUNITIES:OPPORTUNITY_VERSION};
 assert(installOpportunities(h.root,env,T));assert(!installOpportunities(h.root,env,T+1));assert.deepEqual(h.root.frequency,before);assert(getOpportunityProfile(h.root));
 assert.throws(()=>installOpportunities(h.root,{...env,LUMI_TRADING_MODE:'REAL'},T),/PAPER_ONLY/);assert.throws(()=>installOpportunities(h.root,ENV,T),/FLAG_REQUIRED/);
 installOpportunities(h.root,{...env,LUMI_TRADING_SECONDARY_OPPORTUNITIES:'OFF'},T+2);assert.equal(getOpportunityProfile(h.root),null);
});
test('volatility cannot erase a confirmed trend; pullback volume is strategy-specific',()=>{
 const b=bars(),f={...featureSnapshot(b,{timeframe:1,cutoff:C,now:T,quote:quote()}),ema9:100,ema21:99.8,plus_di:30,minus_di:10,relative_volume:.5};
 const context={...f,normalized_slope:.1,adx:28},regime={regime:'HIGH_VOLATILITY',trend:'UPTREND',accelerated:false};
 Object.assign(b.at(-1),{open:100,close:100.8,high:100.9,low:99.9});
 assert.equal(detectQuantPattern('SCALP_CONTINUATION',b,f,context,regime).reason,'REGIME_NOT_ELIGIBLE');
 assert.equal(detectQuantPattern('SCALP_CONTINUATION',b,f,context,regime,{opportunities:true}).direction,'LONG');
 assert.equal(detectQuantPattern('SCALP_CONTINUATION',b,{...f,relative_volume:.1},context,regime,{opportunities:true}).reason,'VOLUME_NOT_CONFIRMED');
 assert.equal(detectQuantPattern('SCALP_REVERSION',b,f,context,regime,{opportunities:true}).reason,'REGIME_NOT_ELIGIBLE');
 assert.equal(detectQuantPattern('MOMENTUM',b,f,context,regime,{opportunities:true}).reason,'VOLUME_NOT_CONFIRMED');
 assert.equal(detectQuantPattern('SCALP_CONTINUATION',b,f,context,{...regime,regime:'ILLIQUID'},{opportunities:true}).reason,'REGIME_NOT_ELIGIBLE');
});
test('five independent timeframe positions share the same original risk cap and survive restart/individual close',()=>{
 const h=fixture(),plans=[1,5,15,60,240].map(tf=>{
  const p=signal(h,{id:'reserve-'+tf,timeframe:tf,stop:98,target:105}),pattern=tf<=5?'SCALP_CONTINUATION':'TREND_FOLLOWING';p.pattern=pattern;
  const q={version:QUANT_VERSION,policy_hash:hash(QUANT_POLICY),strategy:pattern,regime:'UPTREND',features:featureSnapshot(bars(tf),{timeframe:tf,cutoff:C,now:T,quote:quote()}),statistically_validated:false,probability:null,opportunities:opportunityContract({execution_mode:'TAKER_IOC',flow_authority:OPPORTUNITY_POLICY.flow_authority})};q.hash=hash(q);p.quant_contract=q;return p;
 });
 const batch=prepare(h,plans);assert.equal(batch.eligible_count,5,JSON.stringify(batch.receipts));
 const risk=batch.receipts.filter(x=>x.accepted).reduce((s,r)=>s+Number(r.risk),0);assert(risk<=10);assert(batch.receipts.every(r=>Number(r.risk)<=2));
 for(const d of batch.ordered)assert.equal(h.b.choose(d.plan,quote(),META,T),'ENTRY_PENDING');
 h.time(T+1100);h.b.market(quote(T+1100),null,{[C]:0},T+1100);assert.equal(Object.keys(h.b.a.positions).length,5);
 const root=JSON.parse(JSON.stringify(h.root));assert.doesNotThrow(()=>new SecondaryBroker({root,now:()=>T+1200}));
 const p=h.b.a.positions['reserve-1'];h.b.close(p,quote(T+2200),T+2200,'MANUAL_CLOSE');h.b.close(p,quote(T+3300),T+3300,'MANUAL_CLOSE');assert.equal(Object.keys(h.b.a.positions).length,4);
 assert.deepEqual(h.root.primary,{untouched:true});
});
test('analytics normalize seconds/milliseconds, positive buy delta, completed buckets and causal availability',()=>{
 const stamps=[C/1000-180,C/1000-120,C/1000-60,C/1000],receivedAt=T;
 const cvd=normalizeAnalytics('cvd',{result:{timestamp:stamps,data:{buy_volume:[3,4,5,999],sell_volume:[1,2,1,0],cvd:[2,4,8,999]}},errors:[]},{receivedAt});
 assert.equal(cvd.rows.length,3);assert.equal(cvd.rows[0].delta,2);assert.equal(cvd.rows[0].end,C-120000);
 const oi=normalizeAnalytics('open-interest',{result:{timestamp:[C/1000-240,...stamps.slice(0,3)],data:[[10,10,10,10],[11,11,11,11],[12,12,12,12],[13,13,13,13]]}},{receivedAt});
 const snapshot=analyticsSnapshot({cvd,'open-interest':oi},C,T);assert.equal(snapshot.status,'READY');assert.equal(snapshot.flow_imbalance,.5);assert(Math.abs(snapshot.open_interest_change-.3)<1e-10);assert.equal(flowComparison(snapshot,'LONG').status,'CONFIRMS');assert.equal(flowComparison(snapshot,'SHORT').status,'OPPOSES');
 assert.equal(analyticsSnapshot({cvd},C,T-1).status,'UNAVAILABLE');assert.equal(analyticsSnapshot({cvd},C,T+180001).status,'UNAVAILABLE');
 const funding=normalizeAnalytics('funding',{result:{timestamp:[C-60000],data:{rate:[[1,2,0,1]],relativeRate:[[.1,.2,0,.1]]}}},{receivedAt});assert.equal(funding.rows[0].end,C);
 assert.throws(()=>normalizeAnalytics('funding',{result:{timestamp:[C/1000-60],data:{rate:[[1,2,0,1]],relativeRate:[[.1,.2,0,.1]]}}},{receivedAt}),/TIMESTAMP/);
 assert.throws(()=>normalizeAnalytics('cvd',{result:{timestamp:[C/1000-60],data:{buy_volume:[null],sell_volume:[1]}}},{receivedAt}),/VALUE/);
 const slip=normalizeAnalytics('slippage',{result:{timestamp:[C/1000-60],data:{bid:{slippage_1k:[80000]},ask:{slippage_1k:[80001]}}}},{receivedAt});assert.equal(slip.units,'EXECUTION_PRICE_NOT_PERCENT');assert.equal(slip.rows[0].ask.slippage_1k,80001);
});
test('analytics failures are isolated, bounded and cannot manufacture confirmations',async()=>{
 let calls=0;const feed=new PublicAnalyticsFeed({now:()=>T,fetchImpl:async()=>{calls++;throw Error('offline');}});await feed.refresh();assert.equal(calls,10);assert.equal(Object.keys(feed.errors).length,10);assert.equal(feed.view().snapshot.status,'UNAVAILABLE');await feed.refresh();assert.equal(calls,10);assert.equal(flowComparison(feed.view().snapshot,'LONG').authority,'NONE');
});
test('opportunity RR is revalidated after latency even when net profit exceeds the minimum',()=>{
 const h=fixture(),p=signal(h,{stop:99,target:101.5});p.quant_contract={opportunities:{version:OPPORTUNITY_VERSION}};
 const receipt=evaluateEntryEconomics(p,{quote:quote(T+1100,100.5),qty:'1',entryPrice:'100.52',fundingRate:0,now:T+1100,stage:'PRE_EXECUTION'});
 assert(Number(receipt.expected_net_target)>Number(receipt.minimum_expected_net_target));assert.equal(receipt.accepted,false);assert.equal(receipt.reason,'QUANT_NET_RR_DETERIORATED');
});
test('cost-constrained range entry uses a short-lived passive order, never fills on a quote or a touch',()=>{
 const h=fixture(),b=bars(),context=bars(5);for(const xs of [b,context])xs.forEach((x,i)=>{x.open=100;x.close=i%2?100.1:99.9;});
 Object.assign(b.at(-2),{open:99.8,close:99.55,high:100,low:99.4});Object.assign(b.at(-1),{open:99.5,close:99.7,high:99.8,low:99.45});
 const q=quote(T,99.7),options={timeframe:1,contextTimeframe:5,timeframeVersion:QUANT_TIMEFRAMES_VERSION},args=[{1:b,5:context},q,META,C,T,0,EXPLORATION_POLICY,EARLY_PROFIT_POLICY];
 assert.equal(quantCandidates(...args,options).find(x=>x.pattern==='RANGE_TRADING').reason,'QUANT_COST_OR_NET_RR');
 const candidate=quantCandidates(...args,{...options,opportunities:true}).find(x=>x.pattern==='RANGE_TRADING');assert(candidate.plan);assert.equal(candidate.plan.execution_contract.mode,'MAKER_LIMIT');assert.equal(candidate.plan.expires_at,T+120000);assert(candidate.plan.economics.netRR>=1);assert(validateQuantContract(candidate.plan));
 const d=prepareRiskCandidates(h.root,[candidate],{quote:q,meta:META,now:T,preflight:h.b.preflight.bind(h.b)}).ordered[0];assert.equal(d.capital_allocation_rejection,undefined);assert.equal(h.b.choose(d.plan,q,META,T),'ENTRY_PENDING');
 h.time(T+1100);h.b.market(quote(T+1100,99.7),null,{[C]:0},T+1100);assert.equal(Object.keys(h.b.a.positions).length,0);
 const trade=(at,price)=>({source:'KRAKEN_FUTURES_WS_TRADE',symbol:'PF_XBTUSD',id:'maker-'+at,event_at:at,received_at:at,price,qty:100,side:'sell',type:'fill'});
 h.b.market(quote(T+2100,99.4),trade(T+2100,99.4),{[C]:0},T+2100);assert.equal(Object.keys(h.b.a.positions).length,0);
 h.b.market(quote(T+3100,99.38),trade(T+3100,99.39),{[C]:0},T+3100);assert.equal(Object.keys(h.b.a.positions).length,1);
 assert.doesNotThrow(()=>new SecondaryBroker({root:JSON.parse(JSON.stringify(h.root)),now:()=>T+3200}));
});

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
 const settled=structuredClone(h.root.frequency.account),count=h.events.length;
 assert.equal(h.b.close(first,quote(T+4400),T+4400,'MANUAL_CLOSE'),false);
 assert.deepEqual(h.root.frequency.account,settled);assert.equal(h.events.length,count);
 const stale=structuredClone(h.b.a.positions.slow);
 assert.equal(h.b.close(stale,quote(T+4400),T+4400,'MANUAL_CLOSE'),false);
 assert.deepEqual(h.root.frequency.account,settled);
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

test('all operational and auxiliary intervals, including 30m, pass candle normalization',()=>{
 for(const tf of [1,5,15,30,60,240,1440]){
  const end=Math.floor(C/(tf*60000))*tf*60000;
  const rows=bars(tf,{end}).map(x=>({...x,time:x.start}));
  assert.equal(closedBars({candles:rows},tf,C).length,256);
 }
 assert.throws(()=>closedBars({candles:[]},2,C),/RESEARCH_CANDLES_INVALID/);
});

test('planned scale-out uses actual broker costs, exact lots, latency, restoration and isolated positions',()=>{
 const h=fixture(),batch=prepare(h,[signal(h,{id:'reduce'}),signal(h,{id:'other',timeframe:60})]);
 for(const d of batch.ordered)assert.equal(h.b.choose(d.plan,quote(),META,T),'ENTRY_PENDING');
 h.time(T+1100);h.b.market(quote(T+1100),null,{[C]:0},T+1100);
 const untouched=structuredClone(h.root),events=[];let b=new QuantResearchBroker({root:h.root,event:e=>events.push(e),now:()=>T+2200});
 const originalQty=b.a.positions.reduce.qty,partition=partitionQuantity(originalQty,'.0001');
 assert(D(partition.legs.reduce((s,n)=>s.plus(n),D(0))).eq(originalQty));
 const initialAccount=structuredClone(b.a),other=JSON.parse(JSON.stringify(b.a.positions.other));
 const first=b.requestReduction('reduce',{requestId:'leg-1',quantity:partition.legs[0],quote:quote(T+2200,101),now:T+2200});assert.equal(first.status,'PENDING');assert.equal(b.a.positions.reduce.qty,originalQty);
 b=new QuantResearchBroker({root:JSON.parse(JSON.stringify(b.root)),event:e=>events.push(e),now:()=>T+3300});
 b.close(b.a.positions.reduce,quote(T+3300,101),T+3300,'RESEARCH_SCALE_OUT');
 assert.equal(b.root.quant_experiment.requests['leg-1'].status,'FILLED');assert.equal(b.a.positions.reduce.exit_intent,undefined);
 assert(D(b.a.positions.reduce.qty).eq(D(originalQty).minus(partition.legs[0])));assert.equal(b.a.closed,initialAccount.closed);
 const afterFirst=structuredClone(b.a);assert(b.requestReduction('reduce',{requestId:'leg-1',quantity:partition.legs[0],quote:quote(T+4400,101),now:T+4400}).duplicate);assert.deepEqual(b.a,afterFirst);
 const remaining=b.a.positions.reduce,valuation=b.observePosition(remaining,quote(T+4300,101),T+4300);assert(D(remaining.excursions.max_favourable_net).eq(D(remaining.realized.net).plus(valuation.net)));
 assert.doesNotThrow(()=>new QuantResearchBroker({root:JSON.parse(JSON.stringify(b.root)),now:()=>T+4400}));
 b.requestReduction('reduce',{requestId:'leg-2',quantity:partition.legs[1],quote:quote(T+4400,102),now:T+4400});b.close(b.a.positions.reduce,quote(T+5500,102),T+5500,'RESEARCH_SCALE_OUT');
 const last=b.a.positions.reduce;assert(D(last.qty).eq(partition.legs[2]));b.close(last,quote(T+6600,103),T+6600,'MANUAL_CLOSE');b.close(last,quote(T+7700,103),T+7700,'MANUAL_CLOSE');
 const fragments=events.filter(e=>['PARTIAL_CLOSE','CLOSED'].includes(e.type)),final=fragments.at(-1);assert.equal(fragments.length,3);assert.equal(final.type,'CLOSED');
 assert(D(final.pnl).eq(fragments.reduce((s,e)=>s.plus(e.fill_pnl),D(0))));assert(D(final.fees).eq(fragments.reduce((s,e)=>s.plus(e.fill_exit_fee).plus(e.fill_funding).plus(D(initialAccount.positions.reduce.entry_fee).mul(D(e.execution_receipt.quantity).div(originalQty))),D(0))));
 assert.equal(b.a.closed,initialAccount.closed+1);assert.deepEqual(b.a.positions.other,other);assert.deepEqual(h.root,untouched);
 const settled=structuredClone(b.a);b.close(last,quote(T+8800,103),T+8800,'MANUAL_CLOSE');assert.deepEqual(b.a,settled);
});

test('scale-out IOC cancels unfilled fraction and scale-in reserves all legs without averaging losses',()=>{
 const h=fixture(),d=prepare(h,[signal(h)]).ordered[0];h.b.choose(d.plan,quote(),META,T);h.time(T+1100);h.b.market(quote(T+1100),null,{[C]:0},T+1100);
 const b=new QuantResearchBroker({root:h.root,now:()=>T+2200}),p=b.a.positions.one,part=partitionQuantity(p.qty,'.0001');
 b.requestReduction('one',{requestId:'limited',quantity:part.legs[0],quote:quote(T+2200,101),now:T+2200});
 const available=D(part.legs[0]).div(2),bookSize=available.div(p.plan.execution_contract.participation);b.close(p,quote(T+3300,101,bookSize),T+3300,'RESEARCH_SCALE_OUT');
 assert.equal(b.root.quant_experiment.requests.limited.status,'PARTIAL_IOC_REMAINDER_CANCELLED');assert(!p.exit_intent);assert(D(p.qty).gt(part.legs[2]));
 const args={id:'planned',qty:'.01',step:'.0001',riskPerBTC:400,marginPerBTC:8000,costPerBTC:80,equity:1000,availableCash:100,existingRisk:0,now:T,expiresAt:T+60000};
 const plan=planScaleIn(args);assert.equal(plan.status,'PLANNED_NOT_ADMITTED');assert.equal(plan.reserved_risk,'4');assert.equal(plan.reserved_cash,'80.8');assert.equal(plan.automatic_execution,false);
 assert.equal(planScaleIn({...args,availableCash:60}).rejection,'CASH_RESERVATION');
 const evidence={now:T+1000,confirmationId:'new',confirmationAt:T+500,remainingRisk:4,remainingCash:81};assert(checkScaleInLeg(plan,0,evidence).accepted);
 assert.equal(checkScaleInLeg(plan,1,{...evidence,previousLegs:[plan.legs[0].id],previousNet:-1,protectedNet:1}).reason,'WINNING_PROTECTED_PREVIOUS_LEG_REQUIRED');
 assert.equal(checkScaleInLeg(plan,0,{...evidence,usedConfirmations:['new']}).reason,'NEW_CONFIRMATION_REQUIRED');
 assert(checkScaleInLeg(plan,1,{...evidence,previousLegs:[plan.legs[0].id],previousNet:1,protectedNet:.1}).accepted);
 assert.throws(()=>partitionQuantity('.0002','.0001'),/BELOW_LOT/);
});

test('current frame summaries exclude preserved legacy patterns and older candles',()=>{
 const h=fixture(),f=getSecondaryTimeframes(h.root).frames[5];
 const fresh={at:T,cutoff:C,pattern:'BREAKOUT_RETEST',reason:'WAIT_RETEST',timeframe:5};
 f.decisions={BREAKOUT:{...fresh,pattern:'BREAKOUT',cutoff:C-300000},BREAKOUT_RETEST:fresh,MOMENTUM:{...fresh,pattern:'MOMENTUM',cutoff:C-300000}};f.last_decision=fresh;f.last_evaluation_at=T;f.last_cutoff=C;
 const d=projectSecondaryActivity({revision:1,updated_at:new Date(T).toISOString()},h.root,T);
 assert.deepEqual(d.secondary_activity.frames[5].last_evaluation.pattern_decisions.map(x=>x.pattern),['BREAKOUT_RETEST']);
 assert.equal(Object.keys(f.decisions).length,3);
});

test('live close evidence preserves finality and reconciled net without relabelling open positions',()=>{
 const closed={id:'closed',type:'CLOSED',ledger:'FREQUENT_PAPER',at:T,pnl:'.0675',result_final:true,funding_complete:true,quality:'OBSERVED',reason:'TRAILING_RETRACEMENT'};
 const exit=operationExitView(closed);assert.equal(exit.result_final,true);assert.equal(JSON.parse(liveBody({operations:[{id:closed.id,ledger:closed.ledger,status:'CLOSED',exit}]})).operations[0].exit.result_final,true);
 const pending={...closed,pnl:'-.1',result_final:false,funding_complete:false},reconciled={id:'closed',ledger:'FREQUENT_PAPER',type:'FUNDING_RECONCILED',at:T+1000,net_after:'-.12',funding_complete:true};
 assert.equal(operationExitView(pending,reconciled).pnl,'-.12');assert.equal(operationExitView(pending,reconciled).result_final,true);
 assert.equal(operationExitView(pending,{...reconciled,id:'another'}).result_final,false);assert.equal(operationExitView(null),null);
});

test('daily Calmar uses one consistent equity series and realized drawdown follows close order',()=>{
 const rows=[{net:20,end:3},{net:-10,end:1},{net:-10,end:2}],m=quantitativeMetrics(rows,{initialEquity:100});assert.equal(m.max_closed_equity_drawdown_usd,20);
 const dates=[{at:0,equity:100},{at:86400000,equity:90},{at:172800000,equity:100}];
 const daily=quantitativeMetrics([],{dailyEquity:dates});assert.equal(daily.max_daily_equity_drawdown,.1);assert.equal(daily.calmar,0);
 assert.equal(quantitativeMetrics([],{dailyEquity:[...dates,{at:259200000,equity:NaN}]}).periodicity_valid,false);
 assert.equal(quantitativeMetrics([{net:true},{net:''}]).eligible,0);
});

test('external meta-label baseline purges overlapping labels and never fits on the test period',()=>{
 assert.equal(evaluateQuantMeta([]).status,'INSUFFICIENT_DATA');
 const rows=Array.from({length:500},(_,i)=>({id:'sample-'+i,start:i*3600000,end:(i+2)*3600000,net:i%3===0?-1:.5,label:i%3===0?0:1,domain:'synthetic-only',features:META_FEATURES.map((_,j)=>j===0?null:Math.sin(i+j)),final:true,quality:'SYNTHETIC_TEST_ONLY'}));
 const first=evaluateQuantMeta(rows),changed=structuredClone(rows);for(const r of changed.slice(400)){r.features=r.features.map(v=>v===null?null:v*100);r.net=-r.net;r.label=1-r.label;}
 const second=evaluateQuantMeta(changed);assert.equal(first.status,'EVALUATED_NOT_PROMOTED');assert(first.splits.purged>0);assert(first.model.trained_through<first.splits.test_start-first.embargo_ms);
 assert.equal(first.walk_forward.length,3);for(const f of first.walk_forward){assert.equal(f.status,'EVALUATED_NOT_PROMOTED');assert(f.trained_through<f.splits.test_start-first.embargo_ms);}
 assert.deepEqual(first.model.preprocessing,second.model.preprocessing);assert.deepEqual(first.model.logistic,second.model.logistic);assert.deepEqual(first.model.platt,second.model.platt);assert.equal(first.automatic_promotion,false);assert.equal(first.execution_authority,'NONE');
 assert.throws(()=>evaluateQuantMeta([...rows,rows[0]]),/DATASET_INVALID/);
 assert.equal(quantMetaDataset([{type:'CLOSED',plan:{}}]).excluded.QUANT_FEATURE_SNAPSHOT_REQUIRED,1);
});

test('mark margin stress supersedes a pending discretionary exit and retains its execution latency',()=>{
 const h=fixture(),d=prepare(h,[signal(h)]).ordered[0];h.b.choose(d.plan,quote(),META,T);h.time(T+1100);h.b.market(quote(T+1100),null,{[C]:0},T+1100);
 const p=h.b.a.positions.one;h.b.close(p,quote(T+2200),T+2200,'MANUAL_CLOSE');const deadline=p.exit_intent.not_before;
 const stressed={...quote(T+2300),mark_price:'20'};h.b.manageProfitPosition(p,stressed,{[C]:0},T+2300);
 assert.equal(p.exit_intent.reason,'ISOLATED_MARGIN_STRESS');assert.equal(p.exit_intent.not_before,deadline);assert(h.b.a.positions.one);
});

test('Fibonacci uses confirmed closed pivots, symmetric levels and only closer targets',async()=>{
 const {fibonacciContext,fibonacciTarget,fibonacciContract,validateFibonacci}=await import('../lib/trading/quant-fibonacci.js');
 const values=[105,104,101,104,107,110,114,111,110,109,108,109];
 const b=values.map((c,i)=>({start:C-(values.length-i)*60000,end:C-(values.length-i-1)*60000,open:c-.2,close:c,high:c+1,low:c-1}));
 const f=fibonacciContext(b,{direction:'LONG',atr:1,cutoff:C,timeframe:1});assert.equal(f.status,'READY');assert.equal(f.anchor_start.price,100);assert.equal(f.anchor_end.price,115);assert.equal(f.levels.find(x=>x.ratio===.618).price,105.73);assert.equal(f.anchor_end.confirmed_at,b[8].end);
 const rejection=b.map(x=>({...x}));rejection.at(-1).low=107.4;const confirmed=fibonacciContext(rejection,{direction:'LONG',atr:1,cutoff:C,timeframe:1});assert.equal(confirmed.confluence,true);assert.equal(confirmed.confirmed_level.ratio,.5);
 const future={...b.at(-1),start:C,end:C+60000,high:999};assert.deepEqual(fibonacciContext([...b,future],{direction:'LONG',atr:1,cutoff:C,timeframe:1}),f);
 const unconfirmed=b.slice(0,8);assert.equal(fibonacciContext(unconfirmed,{direction:'LONG',atr:1,cutoff:unconfirmed.at(-1).end,timeframe:1}).status,'UNAVAILABLE');
 const mirror=b.map(x=>({...x,open:220-x.open,close:220-x.close,high:220-x.low,low:220-x.high})),short=fibonacciContext(mirror,{direction:'SHORT',atr:1,cutoff:C,timeframe:1});assert.equal(short.status,'READY');assert(Math.abs(short.levels[3].price-(220-f.levels[3].price))<1e-10);
 assert.equal(fibonacciTarget(f,110,120).target,115);assert.equal(fibonacciTarget(f,110,113).target,113);assert.equal(fibonacciTarget(short,110,100).target,105);
 const invalid=b.map(x=>({...x}));invalid.at(-1).low=99;assert.equal(fibonacciContext(invalid,{direction:'LONG',atr:1,cutoff:C,timeframe:1}).reason,'FIBONACCI_SWING_INVALIDATED');
 const plan={direction:'LONG',timeframe:1,confirmed_at:C,entry:'110',target:'115',quant_contract:{fibonacci:fibonacciContract(f,110,120,115)}};assert(validateFibonacci(plan));plan.target='116';assert.throws(()=>validateFibonacci(plan),/FIBONACCI_CONTRACT_INTEGRITY/);
});

test('quant provenance and Fibonacci survive detailed and live monitor projections',async()=>{
 const {planView}=await import('../lib/trading/monitor-projection.js');
 const p={id:'quant-plan',quant_contract:{version:QUANT_VERSION,strategy:'SCALP_CONTINUATION',fibonacci:{version:'secondary-fibonacci-1.0.0',status:'READY'}}};
 assert.deepEqual(planView(p).quant_contract,p.quant_contract);
 const h=fixture();const before=structuredClone(h.root.frequency);installQuant(h.root,ENV,T);assert.equal(h.root.secondaryExecution.quant.fibonacci.version,'secondary-fibonacci-1.0.0');assert.deepEqual(h.root.frequency,before);
});

test('new quant Telegram messages are short, distinguish estimates, partial execution and final net',()=>{
 const h=fixture(),p=signal(h);p.recipe_title='Scalping de continuación';p.quant_contract={version:QUANT_VERSION};p.sizing={qty:'1',risk:'0.6',target_net:'1.2',leverage:2};
 const base={id:p.id,plan:p,price:'100',entry:'99',qty:'1',pnl:'0.067525',fees:'0.06434',quality:'OBSERVED',reason:'TRAILING_RETRACEMENT',result_final:true,funding_complete:true};
 for(const kind of ['SECONDARY_SELECTED','SECONDARY_OPEN','SECONDARY_CLOSE','SECONDARY_TRAILING','SECONDARY_PARTIAL','SECONDARY_UNFILLED']){const text=secondaryMessage({kind,payload:base});assert(text.length<750,text);assert.match(text,/PAPER/);assert.doesNotMatch(text,/Agustín|QUANT_EXPERIMENTAL|undefined/);}
 assert.match(secondaryMessage({kind:'SECONDARY_SELECTED',payload:base}),/pendiente de ejecución/);
 const final=secondaryMessage({kind:'SECONDARY_CLOSE',payload:base});assert.match(final,/Neto: 0\.0675 USD/);assert.doesNotMatch(final,/provisional/);
 assert.match(secondaryMessage({kind:'SECONDARY_CLOSE',payload:{...base,result_final:false}}),/Neto provisional/);
 const partial=secondaryMessage({kind:'SECONDARY_PARTIAL',payload:{...base,qty:'.2',cumulative_qty:'.2',remaining_qty:'.8',entry_revalidation:{expected_loss_stop:'.12',expected_net_target:'.24'}}});assert.match(partial,/Fragmento 20\.00 USD/);assert.match(partial,/neto al TP est\. 0\.24/);
});

test('quant notifier rejects legacy traffic and expires stale signals without sending or replaying',async()=>{
 const {SecondaryNotifier}=await import('../lib/trading/secondary-futures-runtime.js');
 for(const item of [{id:'legacy',kind:'SIGNAL',payload:{plan:{}}},{id:'old-quant',kind:'SECONDARY_SELECTED',payload:{plan:{id:'p',quant_contract:{version:QUANT_VERSION},decision_at:Date.now()-60000,expires_at:Date.now()+60000}}}]){
  item.status='QUEUED';let calls=0;const store={queued:async()=>item.status==='QUEUED'?[item]:[],tx:async args=>{if(args.phase==='CLAIM'){item.status='DISPATCHING';item.claim_id=args.claim_id;}else Object.assign(item,args);return {...item};}};
  const notifier=new SecondaryNotifier({store,env:{},quantOnly:()=>true,secondaryPending:()=>false,transport:{call:async()=>{calls++;throw Error('MUST_NOT_SEND');}},feed:{state:{}}});
  await notifier.drain();assert.equal(item.status,item.id==='legacy'?'REJECTED':'EXPIRED');assert.equal(calls,0);assert.equal((await store.queued()).length,0);
 }
});
