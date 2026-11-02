// Synthetic PAPER ledgers and market fixtures only. No network or operational DB.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {D,hash} from '../lib/trading/core.js';
import {newAccount} from '../lib/trading/simulator.js';
import {enablePortfolio} from '../lib/trading/portfolio.js';
import {OperationalSecondary,SecondaryBroker,secondaryEconomics,SECONDARY_MODEL,SECONDARY_VERSION} from '../lib/trading/secondary-futures.js';
import {EXPLORATION_VERSION,installExploration,getExplorationPolicy,explorationContract} from '../lib/trading/secondary-exploration.js';
import {PROFIT_POLICY_VERSION,PROFIT_ENTRY_REVISION,installProfitPolicy,getProfitPolicy,makeProfitContracts} from '../lib/trading/secondary-profit-policy.js';
import {CAPITAL_ALLOCATION_VERSION,installCapitalAllocation,applyCapitalAllocationFunding,allocateCapitalCandidates,getCapitalAllocationPolicy,hasFiniteCapitalAllocation,capitalAllocationFreeCash} from '../lib/trading/secondary-capital-allocation.js';
import {installSecondaryNeural} from '../lib/trading/secondary-neural.js';
import {captureSecondaryNeuralSignal,NEURAL_FEATURE_NAMES,NEURAL_FEATURE_VERSION,NEURAL_FEATURE_SCHEMA_HASH} from '../lib/trading/secondary-neural-data.js';
import {NEURAL_ARTIFACT_VERSION,NEURAL_MODEL_VERSION} from '../lib/trading/secondary-neural-runtime.js';
import {initialState,TradingEngine} from '../lib/trading/engine.js';
import {KrakenFeed} from '../lib/trading/feed.js';
import {SQLiteStore} from '../lib/trading/sqlite-store.js';

const C=Date.parse('2026-11-02T02:00:00Z'),T=C+2000,H=Math.floor(T/3600000)*3600000;
const ENV={LUMI_RUNTIME_ENV:'staging',LUMI_TRADING_MODE:'PAPER',LUMI_TRADING_STORAGE:'SQLITE',LUMI_TRADING_SECONDARY_PROFILE:EXPLORATION_VERSION,LUMI_TRADING_SECONDARY_PROFIT_POLICY:PROFIT_POLICY_VERSION,LUMI_TRADING_SECONDARY_CAPITAL_ALLOCATION:CAPITAL_ALLOCATION_VERSION,LUMI_TRADING_SECONDARY_ALLOCATION_BASE_USD:'300',LUMI_TRADING_SECONDARY_PREFERRED_MULTIPLIER:'1.5',LUMI_TRADING_SECONDARY_TARGET_EQUITY_USD:'1000',LUMI_TRADING_SECONDARY_CAPITAL_REQUEST_ID:'ISOLATED-CAPITAL-INTEGRATION'};
const META={symbol:'PF_XBTUSD',qty_step:.0001,tick_size:.01,checked_at:T};
const quote=(at=T,bid=100,size=100)=>({source:'KRAKEN_FUTURES_WS_TICKER',symbol:'PF_XBTUSD',event_at:at,received_at:at,bid:D(bid).toString(),ask:D(bid).plus('.01').toString(),bid_qty:String(size),ask_qty:String(size),suspended:false});
const near=(a,b)=>assert(D(a).minus(b).abs().lt('0.000000000001'),`${a} != ${b}`);
function fixture({cash='1000',allocation=true,fund=true}={}){
 let now=T;const a=newAccount();enablePortfolio(a);Object.assign(a,{cash,equity:cash,peak:cash});
 const state={frequency:{account:a,counts:{evaluations:0,candidates:0,selected:0,filled:0,closed:0,notFilled:0},history:[],grossClosed:'0',closedFees:'0'},laboratory:{status:'RESEARCH_COMPLETE',trials:[{status:'REJECTED',net:'-25'}],funding:{initial:cash,added:'0',count:0}},research:{active:'primary',versions:{primary:{account:{cash:'100',equity:'100',net:'0'}}}}};
 const events=[],notices=[],engine={state,now:()=>now,event:e=>events.push(structuredClone(e)),notice:(...args)=>notices.push(structuredClone(args))};
 const h={engine,events,notices,now:()=>now,time(at){now=at;},get root(){return engine.state;}};
 h.b=new SecondaryBroker({root:state,now:h.now,event:e=>engine.event(e),notice:(...args)=>engine.notice(...args)});
 installExploration(state,ENV,T);installProfitPolicy(state,ENV,T);
 if(allocation){installCapitalAllocation(state,ENV,T,e=>engine.event(e));if(fund)applyCapitalAllocationFunding(state,T,h.b.topup.bind(h.b));}
 return h;
}
function plan(h,{id='ISOLATED-CAPITAL',pattern='BREAKOUT',direction='LONG',at=T,entryBid=100,target,stop,confirmation=C,mode='TAKER_IOC'}={}){
 if(mode!==getExplorationPolicy(h.root).modes[pattern])installExploration(h.root,{...ENV,['LUMI_TRADING_SECONDARY_'+pattern+'_EXECUTION']:mode},at);
 const c=explorationContract(getExplorationPolicy(h.root),pattern,at),short=direction==='SHORT',entry=mode==='MAKER_LIMIT'?D(entryBid):D(short?quote(at,entryBid).bid:quote(at,entryBid).ask).mul(short?'.9998':'1.0002');
 target??=short?97:103;stop??=short?101:99;
 return {id,signal_key:hash(['ISOLATED-CAPITAL',id,confirmation]),version:SECONDARY_VERSION,entry_revision:PROFIT_ENTRY_REVISION,execution_model:SECONDARY_MODEL,instrument:'PAPER:KRAKEN_FUTURES:PF_XBTUSD',pattern,direction,recipe:pattern,recipe_title:'ISOLATED CAPITAL TEST ONLY',timeframe:5,entry:entry.toString(),limit:String(entryBid),stop:String(stop),target:String(target),confirmed_at:confirmation,decision_at:at,expires_at:c.expires_at,holding_ms:1800000,order:mode==='TAKER_IOC'?'FUTURES_TAKER_IOC':'FUTURES_POST_ONLY_LIMIT',execution_contract:c,fill_model:c.liquidity_model,economics:secondaryEconomics(entry,stop,target,direction,0,c),...makeProfitContracts(getProfitPolicy(h.root)),entry_context:{version:'secondary-entry-context-economics-1.0.0',structure_key:'isolated-structure:'+id,movement_key:'isolated-movement:'+id,confirmation_key:'confirmation:'+id,confirmation_event_at:confirmation,confirmation_at:confirmation,price_tick:'.01',remaining_distance:D(target).minus(entry).mul(short?-1:1).toString(),remaining_distance_fraction:D(target).minus(entry).abs().div(entry).toString()}};
}
function allocate(h,plans,{at=T,bid=100}={}){
 const decisions=plans.map(p=>({pattern:p.pattern,direction:p.direction,reason:'CANDIDATE',plan:p}));
 return {decisions,...allocateCapitalCandidates(h.root,decisions,{quote:quote(at,bid),meta:META,now:at,preflight:h.b.preflight.bind(h.b)})};
}
function choose(h,allocation,{at=T,bid=100}={}){
 for(const d of allocation.ordered){d.reason=d.capital_allocation_rejection??h.b.choose(d.plan,quote(at,bid),META,at);}
 return allocation.ordered;
}
function market(h,at,bid=100,size=100,rates={[H]:0}){h.time(at);h.b.market(quote(at,bid,size),null,rates,at);}
function open(h,p=plan(h),options={}){const allocated=allocate(h,[p],{at:p.decision_at,bid:options.bid??100});choose(h,allocated,{at:p.decision_at,bid:options.bid??100});assert.equal(allocated.ordered[0].reason,'ENTRY_PENDING');market(h,p.decision_at+1100,options.bid??100,options.size??100);return h.b.a.positions[p.id];}
function restart(h,at){h.time(at);h.engine.state=JSON.parse(JSON.stringify(h.root));h.b=new SecondaryBroker({root:h.root,now:h.now,event:e=>h.engine.event(e),notice:(...args)=>h.engine.notice(...args)});return h.b;}

test('one-time contribution and tripled base travel through real broker without changing profit, primary or legacy contracts',()=>{
 const h=fixture({cash:'469.14',allocation:false}),a=h.b.a;Object.assign(a,{net:'-30.86',fees:'10',peak:'500',maxDrawdown:'.06172'});h.root.laboratory.funding.initial='500';
 const protectedState={net:a.net,fees:a.fees,peak:a.peak,maxDrawdown:a.maxDrawdown,primary:structuredClone(h.root.research),history:structuredClone(h.root.frequency.history)},oldPolicy=structuredClone(h.b.x.exploration);
 installCapitalAllocation(h.root,ENV,T,e=>h.engine.event(e));assert.equal(a.cash,'469.14');const receipt=applyCapitalAllocationFunding(h.root,T,h.b.topup.bind(h.b));assert.equal(receipt.amount,'530.86');assert.equal(a.cash,'1000');assert.equal(a.equity,'1000');assert.equal(h.b.x.capital.total_contributed,'1030.86');
 for(const key of ['net','fees','peak','maxDrawdown'])assert.equal(a[key],protectedState[key]);assert.deepEqual(h.root.research,protectedState.primary);assert.deepEqual(h.b.x.exploration,oldPolicy);assert.equal(h.events.filter(e=>e.type==='PAPER_CAPITAL_TOPUP').length,1);
 restart(h,T+1);installCapitalAllocation(h.root,ENV,T+1);assert.equal(applyCapitalAllocationFunding(h.root,T+1,h.b.topup.bind(h.b)),null);assert.equal(h.b.x.capital.count,1);
 const p=open(h,plan(h,{at:T+2}));assert(p);assert.equal(p.plan.sizing.nominal_usd,'300');assert.equal(p.plan.sizing.leverage,2);near(p.plan.entry_economics.minimum_expected_net_target,D(p.plan.entry_economics.effective_exposure).mul('.002'));assert.equal(p.plan.exit_policy.version,'secondary-net-trailing-1.0.0');
});

test('strict best receives450 first; available cash funds six of seven synthetic opportunities without a ten-position target',()=>{
 const h=fixture(),patterns=['BREAKOUT','PULLBACK','RANGE_REENTRY'],plans=Array.from({length:7},(_,i)=>plan(h,{id:'candidate-'+i,pattern:patterns[i%3],target:103+i*.2}));
 const batch=allocate(h,plans);choose(h,batch);assert.equal(batch.ordered[0].plan.id,'candidate-6');assert.equal(batch.ordered[0].plan.execution_contract.nominalUSD,'450');assert.equal(batch.ordered.filter(d=>d.reason==='ENTRY_PENDING').length,6);assert.equal(batch.ordered.at(-1).reason,'PAPER_CAPITAL_INSUFFICIENT');
 assert.equal(Object.keys(h.b.a.pendingOrders).length,6);assert(D(capitalAllocationFreeCash(h.b.a)).gte(0));assert(!h.events.some(e=>e.type==='PAPER_CAPITAL_TOPUP'));
 market(h,T+1100,100,1000);assert.equal(Object.keys(h.b.a.positions).length,6);assert.equal(Object.keys(h.b.a.pendingOrders).length,0);assert(D(h.b.a.cash).gte(0));assert(h.b.a.positions['candidate-6']);assert.equal(h.b.a.positions['candidate-6'].plan.sizing.nominal_usd,'450');assert(Object.values(h.b.a.positions).filter(p=>p.plan.id!=='candidate-6').every(p=>p.plan.sizing.nominal_usd==='300'));
});

test('economic rejection remains a rejection with capital available; no deposit or order is manufactured',()=>{
 const h=fixture(),before=structuredClone(h.b.a),batch=allocate(h,[plan(h,{target:100.18})]);choose(h,batch);assert.equal(batch.ordered[0].reason,'EXPECTED_NET_TARGET_BELOW_MINIMUM');assert.deepEqual(h.b.a,before);assert.equal(h.events.filter(e=>e.type==='SELECTED').length,0);assert.equal(batch.preferred_id,null);
});

test('two pending reservations cannot spend the same capital and a later quote only fills affordable quantities',()=>{
 const h=fixture({cash:'302',fund:false}),batch=allocate(h,[plan(h,{id:'a',target:110}),plan(h,{id:'b',pattern:'PULLBACK',target:110})]);choose(h,batch);assert(batch.ordered.every(d=>d.reason==='ENTRY_PENDING'));assert.equal(batch.preferred_id,null);
 const requested=Object.values(h.b.a.pendingOrders).reduce((sum,o)=>sum.plus(o.plan.sizing.qty),D(0));market(h,T+1100,103);
 const positions=Object.values(h.b.a.positions),filled=positions.reduce((sum,p)=>sum.plus(p.qty),D(0));assert.equal(positions.length,2);assert(filled.lt(requested));assert(D(h.b.a.cash).gte(0));assert.equal(Object.keys(h.b.a.pendingOrders).length,0);assert(h.events.some(e=>e.type==='FILLED'&&e.capital_limit));assert(h.events.some(e=>e.type==='ORDER_REMAINDER_CANCELLED'&&e.reason==='PAPER_CAPITAL_REMAINDER_CANCELLED'));assert(!h.events.some(e=>e.type==='PAPER_CAPITAL_TOPUP'));
 const debits=positions.reduce((sum,p)=>sum.plus(p.initial_margin).plus(p.entry_fee),D(0));near(D(h.b.a.cash).plus(debits),'302');for(const p of positions)near(p.entry_revalidation.effective_exposure,D(p.entry).mul(p.qty));
});

test('shared observed liquidity permits one partial entry, never a second reuse or a phantom full nominal',()=>{
 const h=fixture(),batch=allocate(h,[plan(h,{id:'a'}),plan(h,{id:'b',pattern:'PULLBACK'})]);choose(h,batch);market(h,T+1100,100,.3);
 const positions=Object.values(h.b.a.positions);assert.equal(positions.length,1);assert.equal(positions[0].qty,'.03'.replace(/^\./,'0.'));near(positions[0].entry_revalidation.effective_exposure,D(positions[0].entry).mul('.03'));assert.equal(h.b.x.liquidity.quote_used.ask,'0.03');assert(h.events.some(e=>e.type==='NOT_FILLED'&&e.reason==='IOC_NO_OBSERVED_LIQUIDITY'));const before=structuredClone(h.b.a);
 restart(h,T+1100);market(h,T+1100,100,.3);assert.deepEqual(h.b.a,before);assert.equal(h.events.filter(e=>e.type==='FILLED').length,1);
});

test('300-dollar position preserves net trailing, partial closure basis, exit intent and consumed liquidity through restart',()=>{
 const h=fixture(),cash=h.b.a.cash,p=open(h);assert(p);market(h,T+2200,104);assert.equal(p.profit_protection.state,'TRAILING_ACTIVE');assert(h.b.a.positions[p.plan.id]);market(h,T+3300,102.5);assert.equal(p.exit_intent.reason,'TRAILING_RETRACEMENT');
 const unit=p.profit_protection.peak_net_per_unit,intent=structuredClone(p.exit_intent);market(h,T+4400,102.4,1);assert.equal(p.profit_protection.state,'PARTIALLY_CLOSED');assert.equal(p.profit_protection.peak_net_per_unit,unit);near(p.profit_protection.peak_net,D(unit).mul(p.qty));const remaining=p.qty,protection=structuredClone(p.profit_protection),liquidity=structuredClone(h.b.x.liquidity);
 restart(h,T+4400);assert.deepEqual(h.b.a.positions[p.plan.id].profit_protection,protection);assert.deepEqual(h.b.a.positions[p.plan.id].exit_intent,intent);assert.deepEqual(h.b.x.liquidity,liquidity);market(h,T+4400,102.4,1);assert.equal(h.b.a.positions[p.plan.id].qty,remaining);market(h,T+5500,102.3);assert(!h.b.a.positions[p.plan.id]);const closed=h.events.find(e=>e.type==='CLOSED');assert.equal(closed.reason,'TRAILING_RETRACEMENT');near(D(h.b.a.cash).minus(cash),closed.pnl);near(h.b.a.net,closed.pnl);assert.equal(h.events.filter(e=>e.type==='CLOSED').length,1);
});

test('legacy100 open and pending contracts survive activation, restart and OFF without reinterpretation',()=>{
 const h=fixture({allocation:false}),old=plan(h,{id:'old-open'});assert.equal(h.b.choose(old,quote(),META,T),'ENTRY_PENDING');market(h,T+1100);const pending=plan(h,{id:'old-pending',pattern:'PULLBACK',at:T+1100});assert.equal(h.b.choose(pending,quote(T+1100),META,T+1100),'ENTRY_PENDING');const original=structuredClone(h.b.a);
 installCapitalAllocation(h.root,ENV,T+1200);assert.deepEqual(h.b.a,original);restart(h,T+1300);assert.deepEqual(h.b.a.positions,original.positions);assert.deepEqual(h.b.a.pendingOrders,original.pendingOrders);installCapitalAllocation(h.root,{...ENV,LUMI_TRADING_SECONDARY_CAPITAL_ALLOCATION:'OFF'},T+1400);assert(hasFiniteCapitalAllocation(h.root));assert.equal(getCapitalAllocationPolicy(h.root),null);assert.deepEqual(h.b.a.positions,original.positions);assert.deepEqual(h.b.a.pendingOrders,original.pendingOrders);
 market(h,T+2200);assert.equal(Object.keys(h.b.a.positions).length,2);for(const p of Object.values(h.b.a.positions)){assert.equal(p.plan.sizing.nominal_usd,'100');assert.equal(p.plan.execution_contract.capital_allocation,undefined);assert.equal(p.plan.hash,hash({...p.plan,hash:undefined}));}
});

test('allocation300 pending survives OFF, and OFF cannot restore automatic fictional funding',()=>{
 const h=fixture(),batch=allocate(h,[plan(h)]);choose(h,batch);const old=structuredClone(h.b.a.pendingOrders);installCapitalAllocation(h.root,{...ENV,LUMI_TRADING_SECONDARY_CAPITAL_ALLOCATION:'OFF'},T+100);restart(h,T+200);assert.deepEqual(h.b.a.pendingOrders,old);market(h,T+1100);assert.equal(Object.values(h.b.a.positions)[0].plan.sizing.nominal_usd,'300');
 const low=fixture({cash:'1',fund:false});installCapitalAllocation(low.root,{...ENV,LUMI_TRADING_SECONDARY_CAPITAL_ALLOCATION:'OFF'},T+1);const p=plan(low,{at:T+2});assert.equal(low.b.choose(p,quote(T+2),META,T+2),'PAPER_CAPITAL_INSUFFICIENT');assert.equal(low.b.a.cash,'1');assert.equal(low.events.filter(e=>e.type==='PAPER_CAPITAL_TOPUP').length,0);
});

test('losses do not change the next300 nominal, reactivate rejected trials, or refill the finite budget',()=>{
 const h=fixture({cash:'1'}),primary=structuredClone(h.root.research),p=open(h);market(h,T+2200,98.9);market(h,T+3300,98.8);assert(!h.b.a.positions[p.plan.id]);assert(D(h.b.a.net).lt(0));const after=h.b.a.cash;restart(h,T+4400);assert.equal(applyCapitalAllocationFunding(h.root,T+4400,h.b.topup.bind(h.b)),null);assert.equal(h.b.a.cash,after);
 const next=allocate(h,[plan(h,{id:'after-loss',at:T+4400,confirmation:T+3300})],{at:T+4400});choose(h,next,{at:T+4400});assert.equal(next.ordered[0].reason,'ENTRY_PENDING');assert.equal(h.b.a.pendingOrders['after-loss'].plan.sizing.nominal_usd,'300');assert.equal(h.b.a.pendingOrders['after-loss'].plan.sizing.leverage,2);assert.equal(h.root.laboratory.trials[0].status,'REJECTED');assert.equal(h.events.filter(e=>e.type==='PAPER_CAPITAL_TOPUP').length,1);assert.deepEqual(h.root.research,primary);
});

const bars=tf=>Array.from({length:96},(_,i)=>({start:C-(96-i)*tf*60000,end:C-(95-i)*tf*60000,open:99.9,high:100.2,low:99.7,close:100,volume:1}));
function artifact(domain){const dims=[NEURAL_FEATURE_NAMES.length,16,8,1],p={version:NEURAL_MODEL_VERSION,model_id:'nn_capital_isolated',feature_version:NEURAL_FEATURE_VERSION,feature_schema_hash:NEURAL_FEATURE_SCHEMA_HASH,feature_names:[...NEURAL_FEATURE_NAMES],domain,trained_at:T-30000,created_at:T-30000,expires_at:T+86400000,training_cutoff:T-40000,max_label_mature_at:T-50000,architecture:{input:dims[0],hidden:[16,8],output:1,activation:'tanh',output_activation:'identity'},normalization:{mean:Array(dims[0]).fill(0),scale:Array(dims[0]).fill(1)},input_domain:{min:Array(dims[0]).fill(-1000000),max:Array(dims[0]).fill(1000000)},output_transform:{mean:0,scale:.01},layers:dims.slice(1).map((out,k)=>({weights:Array.from({length:dims[k]},()=>Array(out).fill(.01)),bias:Array(out).fill(0)})),validation:{status:'PROSPECTIVE',criteria_version:'secondary-neural-validation-1.0.0',assistance_authorized:false}};const payload_json=JSON.stringify(p);return JSON.stringify({version:NEURAL_ARTIFACT_VERSION,payload_json,sha256:hash(payload_json)});}
function neuralFlow(variant){
 const h=fixture(),batch=allocate(h,[plan(h,{id:'weaker',pattern:'PULLBACK',target:103}),plan(h,{id:'best',target:105})]),context={series:{5:bars(5),15:bars(15)},quote:quote(),meta:META,cutoff:C,now:T,explorationPolicy:getExplorationPolicy(h.root),profitPolicy:getProfitPolicy(h.root),allocationPolicy:getCapitalAllocationPolicy(h.root),baseOrder:batch.ordered};
 for(const decision of batch.decisions)decision.facts={atr5:.5,atr15:.5,fast5:100,slow5:100,fast15:100,slow15:100,efficiency15:0,relative_volume:1,body_fraction:.2};
 const n=variant==='BASE'?null:installSecondaryNeural(h.engine,{...ENV,LUMI_TRADING_SECONDARY_NEURAL_MODE:variant==='OFF'?'OFF':'ADVISORY'});if(n)n.runtime.clock=()=>0;
 if(n&&variant==='ADVISORY'){const snapshot=captureSecondaryNeuralSignal({...context,decision:batch.ordered[0],existing:h.b.a});assert.equal(snapshot.exclusion,null);assert(n.runtime.loadArtifactText(artifact(snapshot.domain)).ok);}
 if(n&&variant==='CORRUPT')n.runtime.loadArtifactText('{');if(n&&variant==='THROW')n.runtime.prioritize=()=>{throw Error('NEURAL_ISOLATED_ALLOCATION_FAILURE');};
 const ordered=n?n.prepare(batch.decisions,context):batch.ordered;assert.deepEqual(ordered.map(d=>d.plan.id),['best','weaker']);choose(h,{ordered});if(n)n.finish(batch.decisions,context);market(h,T+1100);market(h,T+2200,98.9);market(h,T+3300,98.8);
 if(variant==='ADVISORY')assert(h.events.some(e=>e.type==='NEURAL_ENTRY_DECISION'&&e.decision.prediction.status==='PREDICTED'));
 return {account:structuredClone(h.b.a),execution:structuredClone(h.b.x),events:h.events.filter(e=>!e.type.startsWith('NEURAL_')),notices:h.notices.filter(n=>n[0]!=='SECONDARY_NEURAL')};
}
test('new capital base order, 450/300 amounts, executions and balances are identical in neural OFF/advisory/failure',()=>{
 const base=neuralFlow('BASE');for(const variant of ['OFF','ADVISORY','CORRUPT','THROW'])assert.deepEqual(neuralFlow(variant),base,variant);
 const selected=base.events.filter(e=>e.type==='SELECTED');assert.deepEqual(selected.map(e=>[e.id,e.plan.sizing.nominal_usd]),[['best','450'],['weaker','300']]);assert.equal(base.events.filter(e=>e.type==='CLOSED').length,2);
});

test('causal runtime flow commits one deposit,300 order,capture,trailing and closure across real SQLite restarts',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'lumi-capital-isolated-')),path=join(dir,'paper.sqlite');let now=C-500,store=new SQLiteStore(path,{allowEmpty:true,now:()=>now}),engine,runtime;
 t.after(async()=>{try{store.close();}catch{}await rm(dir,{recursive:true,force:true});});
 store.import({schema:1,exported_at:new Date(now).toISOString(),state:{id:'KRAKEN_BTCUSD_PAPER',revision:1,fence:0,lease_until:null,last_batch:null,state:initialState(now),updated_at:new Date(now).toISOString()},counts:{events:0,outbox:0},events:[],outbox:[]});
 const series=Object.fromEntries([5,15].map(tf=>[tf,bars(tf).map(row=>({...row,open:199.9,high:200.2,low:199.7,close:199.9}))]));Object.assign(series[5].at(-1),{open:199.9,high:200.9,low:199.9,close:200.8,volume:2});
 const initialize=async(first=false)=>{
  engine=new TradingEngine({store,feed:new KrakenFeed({now:()=>now}),now:()=>now});await engine.initialize();
  if(first){engine.state.laboratory.status='RESEARCH_COMPLETE';Object.assign(engine.state.frequency.account,{cash:'469.14',equity:'469.14',net:'-30.86',fees:'10',peak:'500',closed:3,wins:1,losses:2,halted:false});engine.state.laboratory.funding={initial:'500',added:'0',count:0};}
  runtime=new OperationalSecondary({engine,now:()=>now,fetchImpl:()=>{throw Error('ISOLATED_NETWORK_FORBIDDEN');},socketFactory:()=>{throw Error('ISOLATED_NETWORK_FORBIDDEN');}}).initialize();
  installExploration(engine.state,ENV,now,e=>engine.event(e));installProfitPolicy(engine.state,ENV,now,e=>engine.event(e));installCapitalAllocation(engine.state,ENV,now,e=>engine.event(e));installSecondaryNeural(engine,{...ENV,LUMI_TRADING_SECONDARY_NEURAL_MODE:'COLLECTING'});
  runtime.series=series;runtime.meta=META;runtime.rates={[H]:0};runtime.feedError=null;
 };
 const tick=(at,bid=200.8)=>{now=at;runtime.quote=quote(at,bid);runtime.tick();};
 const resume=async at=>{await store.tx({phase:'RELEASE'});store.close();now=at;store=new SQLiteStore(path,{now:()=>now});await initialize();};
 await initialize(true);const primary=structuredClone(engine.active().account);assert.equal(engine.state.secondaryExecution.capital_allocation.funding_request.status,'PENDING');tick(T);
 const order=Object.values(runtime.broker.a.pendingOrders)[0];assert(order);const id=order.plan.id,contract=structuredClone(order.plan);assert.equal(contract.pattern,'BREAKOUT');assert.equal(contract.sizing.nominal_usd,'300');assert.equal(runtime.broker.a.cash,'1000');assert.equal(runtime.broker.a.net,'-30.86');assert.equal(runtime.broker.x.capital_allocation.funding_request.status,'APPLIED');await engine.flush();
 const contributions=await store.history('PAPER_CAPITAL_TOPUP'),captures=await store.history('NEURAL_SIGNAL_CAPTURED');assert.equal(contributions.length,1);assert.equal(contributions[0].amount,'530.86');assert(captures.some(e=>e.snapshot.operation_id===id&&e.snapshot.exclusion===null));
 await resume(T+500);assert.deepEqual(runtime.broker.a.pendingOrders[id].plan,contract);assert.equal(runtime.broker.x.capital_allocation.funding_request.status,'APPLIED');tick(T+1100);let position=runtime.broker.a.positions[id];assert(position);assert.equal(position.plan.sizing.nominal_usd,'300');
 const target=Number(position.plan.target);tick(T+2200,target);assert.equal(position.profit_protection.state,'TRAILING_ACTIVE');const protection=structuredClone(position.profit_protection);await engine.flush();await resume(T+2200);position=runtime.broker.a.positions[id];assert.deepEqual(position.profit_protection,protection);assert.deepEqual(position.plan,contract);
 tick(T+3300,target+1);tick(T+4400,target);assert.equal(position.exit_intent.reason,'TRAILING_RETRACEMENT');tick(T+5500,target);await engine.flush();assert(!runtime.broker.a.positions[id]);
 assert.equal((await store.history('PAPER_CAPITAL_TOPUP')).length,1);assert.equal((await store.history('SELECTED')).length,1);const closed=await store.history('CLOSED');assert.equal(closed.length,1);assert.equal(closed[0].id,id);near(runtime.broker.a.cash,D(1000).plus(closed[0].pnl));near(runtime.broker.a.net,D('-30.86').plus(closed[0].pnl));assert.deepEqual(engine.active().account,primary);assert.equal(store.db.prepare('PRAGMA quick_check').get().quick_check,'ok');
});
