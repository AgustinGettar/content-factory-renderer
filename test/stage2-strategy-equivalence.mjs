// Deterministic comparison of the audited base and repaired local modules.
// Never starts a worker, feed, server, scheduler or operational database.
// All candles, prices, orders and accounts below are explicit synthetic fixtures.
import '../docs/trading/audit-stage1-2026-11-05/no-network.mjs';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,readFileSync,writeFileSync,mkdirSync,symlinkSync,rmSync,openSync,closeSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';

const ROOT=process.env.LUMI_EQ_CANDIDATE_ROOT?resolve(process.env.LUMI_EQ_CANDIDATE_ROOT):resolve(dirname(fileURLToPath(import.meta.url)),'..');
const BASE=process.env.LUMI_EQ_BASE_COMMIT??'9c4dba6729069a2ad3038ad0f65a44634e46fb93';
assert.match(BASE,/^[a-f0-9]{40}$/);
const RUNTIME_BASE='9f8648abe12cb3457814bae9074d8e666fd56cba';
const OUT=process.argv[2]?resolve(process.argv[2]):join(ROOT,'docs/trading/audit-stage1-2026-11-05/stage2-evidence/strategy-equivalence.json');
const temp=mkdtempSync(join(tmpdir(),'lumi-stage2-equivalence-'));
const digest=x=>createHash('sha256').update(typeof x==='string'?x:JSON.stringify(x)).digest('hex');
// File descriptors avoid this environment's known nested-process pipe capture issue.
function command(cmd,args,output){
 const error=join(temp,'command.stderr'),fd=openSync(output,'w'),err=openSync(error,'w');
 let r;try{r=spawnSync(cmd,args,{cwd:ROOT,env:{PATH:process.env.PATH,LANG:'C.UTF-8',TZ:'UTC',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0'},stdio:['ignore',fd,err],timeout:30000});}
 finally{closeSync(fd);closeSync(err);}
 assert.equal(r.status,0,`${cmd} failed: ${r.error?.code??''} ${readFileSync(error,'utf8')}`);
}
async function load(root){
 const m={};
 for(const name of ['core','simulator','portfolio','secondary-futures','secondary-exploration','secondary-profit-policy','secondary-capital-allocation','secondary-risk-budget','secondary-timeframes','quant-strategies','quant-opportunities'])
  Object.assign(m,await import(pathToFileURL(join(root,`lib/trading/${name}.js`))));
 return m;
}
const C=Date.parse('2026-11-04T12:00:00Z'),T=C+2000;
const quote=(at,bid=100,size=1000)=>({source:'KRAKEN_FUTURES_WS_TICKER',symbol:'PF_XBTUSD',event_at:at,received_at:at,bid:String(bid),ask:String(bid+.01),bid_qty:String(size),ask_qty:String(size),mark_price:String(bid+.005),suspended:false});
const meta={symbol:'PF_XBTUSD',qty_step:.0001,tick_size:.01,checked_at:C,
 margin_schedule:[{numNonContractUnits:0,initialMargin:.1,maintenanceMargin:.05},{numNonContractUnits:30000000,initialMargin:.2,maintenanceMargin:.1}]};
const pick=(object,keys)=>Object.fromEntries(keys.filter(k=>object?.[k]!==undefined).map(k=>[k,structuredClone(object[k])]));
function planView(p){return pick(p,['id','signal_key','hash','version','entry_revision','execution_model','instrument','pattern','direction','timeframe','entry','limit','stop','target','confirmed_at','decision_at','expires_at','holding_ms','order','fill_model','execution_contract','economic_policy','exit_policy','timeframe_contract','sizing','economics']);}
function accountView(a){
 const out=pick(a,['cash','equity','net','fees','closed','observedClosed','ambiguousClosed','wins','losses','maxDrawdown','halted','reservedCash','availableCash','committedRisk','maxSlots']);
 for(const name of ['positions','pendingOrders'])out[name]=Object.fromEntries(Object.entries(a[name]??{}).map(([id,p])=>[id,{...pick(p,['qty','initial_qty','entry','entry_fee','initial_margin','accrued_funding','funding_reserved','funding_pending','closed_funding_pending','entered_at','expires_at','remaining_qty','remaining_reserved','filled_qty','cancelled_qty','realized','exit_intent','execution_blocker','profit_protection','management','quant_management']),plan:planView(p.plan)}]));
 return out;
}
const moneyEvents=new Set(['SELECTED','FILLED','PARTIAL_FILL','NOT_FILLED','ORDER_REMAINDER_CANCELLED','PARTIAL_CLOSE','CLOSED','FUNDING_RECONCILED','SECONDARY_ENTRY_REJECTED','PAPER_CAPITAL_TOPUP']);
function eventView(e){return {...pick(e,['type','id','fill_id','at','timeframe','pattern','direction','reason','qty','price','entry','fee','fees','gross','pnl','fill_pnl','fill_exit_fee','funding','fill_funding','amount','net_adjustment','net_after','position_open','funding_complete','result_final','remaining_qty','requested_qty','cumulative_qty','cancelled_qty','execution_state','order_state','raw_quote_price','observed_spread_usd_per_btc','fill_exit_slippage_cost','fill_exit_spread_cost_vs_mid','exit_slippage_cost','exit_spread_cost_vs_mid','slippage_cost','spread_cost_vs_mid','costs_embedded_in_prices','entry_execution_costs','execution_receipt','funding_receipt','liquidity_receipt','realTrading','ledger']),...(e.plan?{plan:planView(e.plan)}:{})};}
function result(h,name){
 const decisions=h.events.filter(e=>e.type==='SECONDARY_PATTERN_EVALUATION').map(e=>pick(e,['type','at','timeframe','context_timeframe','cutoff','pattern','reason','evaluation_status','signal_id','execution_mode']));
 return {name,steps:h.steps,decisions,economic_events:h.events.filter(e=>moneyEvents.has(e.type)).map(eventView),final:accountView(h.root.frequency.account),primary:h.root.primary??null};
}
function record(h,label,at){h.steps.push({label,at,account:accountView(h.root.frequency.account)});}
function baseRoot(m,cash='1000'){
 const a=m.newAccount();m.enablePortfolio(a);Object.assign(a,{cash,equity:cash,peak:cash});
 return {frequency:{account:a,counts:{evaluations:0,candidates:0,selected:0,filled:0,closed:0,notFilled:0},history:[],grossClosed:'0',closedFees:'0'},laboratory:{status:'RESEARCH_COMPLETE',trials:[],funding:{initial:cash,added:'0',count:0}},primary:{must_remain_unchanged:true}};
}
function env(m){return {LUMI_RUNTIME_ENV:'staging',LUMI_TRADING_MODE:'PAPER',LUMI_TRADING_STORAGE:'SQLITE',LUMI_TRADING_SECONDARY_PROFILE:m.EXPLORATION_VERSION,LUMI_TRADING_SECONDARY_PROFIT_POLICY:m.EARLY_PROFIT_POLICY_VERSION,LUMI_TRADING_SECONDARY_CAPITAL_ALLOCATION:m.CAPITAL_ALLOCATION_VERSION,LUMI_TRADING_SECONDARY_RISK_BUDGET:m.QUANT_RISK_VERSION,LUMI_TRADING_SECONDARY_TIMEFRAMES:m.QUANT_TIMEFRAMES_VERSION,LUMI_TRADING_SECONDARY_QUANT:m.QUANT_VERSION,LUMI_TRADING_SECONDARY_OPPORTUNITIES:m.OPPORTUNITY_VERSION};}
function bars(tf,cutoff=C){const end=Math.floor(cutoff/(tf*60000))*tf*60000;return Array.from({length:256},(_,i)=>({start:end-(256-i)*tf*60000,end:end-(255-i)*tf*60000,open:100,close:i%2?100.1:99.9,high:100.5,low:99.5,volume:10}));}
function allBars(cutoff=C){return Object.fromEntries([1,5,15,30,60,240,1440].map(tf=>[tf,bars(tf,cutoff)]));}
function runtimeScenario(m,{opportunities=false,restartWith=m}={}){
 let now=C-1000;const h={root:baseRoot(m),events:[],steps:[]};
 let runtimeModules=m;
 const make=()=>new runtimeModules.OperationalSecondary({engine:{state:h.root,event:e=>h.events.push(e),notice(){}},now:()=>now}).initialize();
 let runtime=make();const settings=env(m);
 m.installExploration(h.root,settings,now);m.installProfitPolicy(h.root,settings,now);m.installCapitalAllocation(h.root,settings,now);m.installRiskBudget(h.root,settings,now);m.installSecondaryTimeframes(h.root,settings,now);m.installQuant(h.root,settings,now);
 if(opportunities)m.installOpportunities(h.root,settings,now);
 const set=()=>{runtime.meta={...meta};runtime.rates={[C]:0};};set();
 const tick=(at,label,bid=opportunities?99.7:100,trade=null)=>{now=at;runtime.quote=quote(at,bid);if(trade)runtime.queue.push({kind:'quote',q:runtime.quote},{kind:'trade',t:trade});runtime.tick();record(h,label,at);};
 tick(T,'context-missing');tick(T+1000,'same-context-retry');
 const input=allBars();if(opportunities){Object.assign(input[1].at(-2),{open:99.8,close:99.55,high:100,low:99.4});Object.assign(input[1].at(-1),{open:99.5,close:99.7,high:99.8,low:99.45});}
 runtime.series=input;tick(T+2000,'recovery-five-timeframes');
 for(const frame of Object.values(h.root.secondaryExecution.timeframe_execution.frames))assert.equal(frame.counts.completed,1);
 tick(T+2100,'same-logical-event-repeat');
 const state=JSON.parse(JSON.stringify(h.root));h.root=state;runtimeModules=restartWith;runtime=make();runtime.series=input;set();tick(T+2500,'restart-same-cutoff');
 if(opportunities){
  const chosen=h.events.filter(e=>e.type==='SELECTED');assert(chosen.length>0,'Synthetic Quant opportunity must exercise actual selection');
  tick(T+3100,'maker-posted');
  tick(T+4200,'maker-observed-trade',99.38,{source:'KRAKEN_FUTURES_WS_TRADE',symbol:'PF_XBTUSD',id:'synthetic-maker-trade',event_at:T+4200,received_at:T+4200,price:99.39,qty:100,side:'sell',type:'fill'});
  assert(h.events.some(e=>e.type==='FILLED'),'Synthetic Quant opportunity must exercise actual fill');
  tick(T+5300,'quant-stop-trigger',98.5);tick(T+6400,'quant-stop-execution',98.4);
  assert.equal(h.events.filter(e=>e.type==='CLOSED').length,1,'Synthetic Quant path must exercise automatic close');
 }else{
  runtime.series=allBars(C+60000);tick(C+62000,'new-1m-cutoff');tick(C+63000,'repeat-new-1m-cutoff');
 }
 return result(h,opportunities?'quant-maker-selection-after-context-retry':'quant-five-timeframe-retry-restart');
}
function brokerFixture(m,{profit=true,cash='1000'}={}){
 let now=T;const h={root:baseRoot(m,cash),events:[],steps:[],now:()=>now};
 h.create=()=>new m.SecondaryBroker({root:h.root,now:()=>now,event:e=>h.events.push(e),notice(){}});h.b=h.create();
 m.installExploration(h.root,env(m),T);if(profit)m.installProfitPolicy(h.root,{...env(m),LUMI_TRADING_SECONDARY_PROFIT_POLICY:m.PROFIT_POLICY_VERSION},T);
 h.market=(at,bid=100,size=100,rate=0,trade=null)=>{now=at;h.b.market(quote(at,bid,size),trade,{[C]:rate},at);record(h,'market',at);};
 h.restart=(at,modules=m)=>{now=at;h.root=JSON.parse(JSON.stringify(h.root));h.b=new modules.SecondaryBroker({root:h.root,now:()=>now,event:e=>h.events.push(e),notice(){}});record(h,'restart',at);};
 return h;
}
function brokerPlan(m,h,{id='synthetic-one',direction='LONG',mode='TAKER_IOC',profit=true,pattern='BREAKOUT',timeframe=5}={}){
 const settings=env(m);
 if(mode!==m.getExplorationPolicy(h.root).modes[pattern])m.installExploration(h.root,{...settings,['LUMI_TRADING_SECONDARY_'+pattern+'_EXECUTION']:mode},T);
 const c=m.explorationContract(m.getExplorationPolicy(h.root),pattern,T),short=direction==='SHORT',entry=mode==='MAKER_LIMIT'?m.D(100):m.D(quote(T)[short?'bid':'ask']).mul(short?'.9998':'1.0002'),target=short?97:103,stop=short?101:99;
 const p={id,signal_key:m.hash(['SYNTHETIC-STAGE2',id,C]),version:m.SECONDARY_VERSION,entry_revision:profit?m.PROFIT_ENTRY_REVISION:m.EXPLORATION_ENTRY_REVISION,execution_model:m.SECONDARY_MODEL,instrument:'PAPER:KRAKEN_FUTURES:PF_XBTUSD',pattern,direction,recipe:pattern,recipe_title:'ISOLATED STAGE2 FIXTURE',timeframe,entry:entry.toString(),limit:'100',stop:String(stop),target:String(target),confirmed_at:C,decision_at:T,expires_at:c.expires_at,holding_ms:1800000,order:mode==='TAKER_IOC'?'FUTURES_TAKER_IOC':'FUTURES_POST_ONLY_LIMIT',execution_contract:c,fill_model:c.liquidity_model,economics:m.secondaryEconomics(entry,stop,target,direction,0,c)};
 if(profit){Object.assign(p,m.makeProfitContracts(m.getProfitPolicy(h.root)));p.entry_context={version:'secondary-entry-context-economics-1.0.0',structure_key:id,confirmation_key:id,confirmation_event_at:C,confirmation_at:C,price_tick:'.01',remaining_distance:m.D(target).minus(entry).mul(short?-1:1).toString(),remaining_distance_fraction:m.D(target).minus(entry).abs().div(entry).toString()};}
 return p;
}
function partialScenario(m,direction,rate,restartWith=m){
 const h=brokerFixture(m),p=brokerPlan(m,h,{direction});
 assert.equal(h.b.choose(p,quote(T),meta,T),'ENTRY_PENDING');record(h,'selected',T);
 h.market(T+1100,100,100,rate);assert(h.b.a.positions[p.id]);
 const peak=direction==='LONG'?104:96,trigger=direction==='LONG'?102.5:97.5,after=direction==='LONG'?102.4:97.6;
 h.market(T+2200,peak,100,rate);h.market(T+3300,trigger,100,rate);h.market(T+4400,after,.5,rate);
 assert.equal(h.events.filter(e=>e.type==='PARTIAL_CLOSE').length,1);
 h.market(T+4400,after,.5,rate); // Replay exactly the consumed quote; must not repeat a fill.
 assert.equal(h.events.filter(e=>e.type==='PARTIAL_CLOSE').length,1);
 h.restart(T+4400,restartWith);h.market(T+4400,after,.5,rate);
 h.market(T+5500,after,.5,rate);assert.equal(h.events.filter(e=>e.type==='PARTIAL_CLOSE').length,2);
 h.market(T+6600,after,100,rate);h.market(T+6600,after,100,rate);
 assert.equal(h.events.filter(e=>e.type==='CLOSED').length,1);assert.equal(Object.keys(h.b.a.positions).length,0);
 return result(h,`${direction.toLowerCase()}-two-partials-final-restart-funding-${rate}`);
}
function makerScenario(m){
 const h=brokerFixture(m,{profit:false}),p=brokerPlan(m,h,{profit:false,mode:'MAKER_LIMIT'});
 assert.equal(h.b.choose(p,quote(T),meta,T),'ENTRY_PENDING');record(h,'maker-selected',T);
 h.market(T+1100);
 const tr={source:'KRAKEN_FUTURES_WS_TRADE',symbol:'PF_XBTUSD',id:'synthetic-partial-maker',event_at:T+2200,received_at:T+2200,price:99.99,qty:1,side:'sell',type:'fill'};
 h.market(T+2200,99.98,100,0,tr);assert(h.b.a.positions[p.id]);assert(h.b.a.pendingOrders[p.id]);
 h.restart(T+2300);h.market(T+2400,99.98,100,0,tr);assert.equal(h.events.filter(e=>e.type==='FILLED').length,1);
 h.b.market(null,null,{[C]:0},p.expires_at+1);record(h,'pending-expired-position-preserved',p.expires_at+1);
 assert(!h.b.a.pendingOrders[p.id]);assert(h.b.a.positions[p.id]);
 h.market(p.expires_at+1100,98.9);h.market(p.expires_at+2200,98.8);
 assert.equal(h.events.filter(e=>e.type==='CLOSED').length,1);
 return result(h,'maker-partial-entry-expiry-and-stop');
}
const scenarios=[m=>runtimeScenario(m),m=>runtimeScenario(m,{opportunities:true}),m=>partialScenario(m,'LONG',.25),m=>partialScenario(m,'LONG',-.25),m=>partialScenario(m,'SHORT',.25),m=>makerScenario(m)];
try{
 const archive=join(temp,'base.tar'),checkout=join(temp,'base');mkdirSync(checkout);
 command('git',['archive',BASE,'package.json','lib/trading'],archive);
 command('tar',['-xf',archive,'-C',checkout],join(temp,'extract.stdout'));
 symlinkSync(join(ROOT,'node_modules'),join(checkout,'node_modules'),'dir');
 const baseline=await load(checkout),repaired=await load(ROOT),checks=[];
 for(const scenario of scenarios){
  const before=scenario(baseline),after=scenario(repaired);
  assert.deepEqual(after,before,`Economic or decision difference: ${before.name}`);
  checks.push({name:before.name,passed:true,steps:before.steps.length,pattern_decisions:before.decisions.length,economic_events:before.economic_events.length,event_types:before.economic_events.reduce((n,e)=>(n[e.type]=(n[e.type]??0)+1,n),{}),trace_sha256:digest(before),final:pick(before.final,['cash','equity','net','fees','closed','wins','losses'])});
 }
 const transitions=[];
 for(const [label,from,to] of [['base-to-candidate',baseline,repaired],['candidate-to-base',repaired,baseline]]){
  for(const kind of ['open-position-partial-remainder','evaluation-cursors']){
   const control=kind==='evaluation-cursors'?runtimeScenario(from):partialScenario(from,'LONG',-.25);
   const switched=kind==='evaluation-cursors'?runtimeScenario(from,{restartWith:to}):partialScenario(from,'LONG',-.25,to);
   assert.deepEqual(switched,control,`Economic or decision difference crossing versions: ${label}/${kind}`);
   transitions.push({direction:label,kind,passed:true,steps:control.steps.length,pattern_decisions:control.decisions.length,trace_sha256:digest(control)});
  }
 }
 const sourceFiles=['lib/trading/secondary-futures.js','lib/trading/secondary-futures-engine.js','lib/trading/secondary-performance-review.js','lib/trading/secondary-futures-runtime.js','lib/trading/dashboard-publisher.js','lib/trading/secondary-notification-policy.js'];
 const evidence={comparison_base_commit:BASE,base_audit_commit:process.env.LUMI_EQ_BASE_COMMIT?null:BASE,base_runtime_commit:RUNTIME_BASE,current_aws_runtime_verified:false,harness_sha256:digest(readFileSync(fileURLToPath(import.meta.url),'utf8')),kind:'SYNTHETIC_DETERMINISTIC_LOCAL_COMPARISON',generated_at:new Date().toISOString(),checks,passed:checks.length,failed:0,version_transitions:transitions,
  compared:'Exact deep equality of economic snapshots after every action, projected signed plans, economic events, and pattern decisions; decimal monetary strings compared exactly.',
  excluded:'Observation counters and ancillary evidence such as mutable excursions/data gaps. Explicit projections in this harness include opening/closing quantities, prices, monetary totals/components, signed plan contracts, stops, targets and decisions; this is not full-state equality.',
  limitations:['Not a market backtest or profitability study','No worker, production restore, broker network or operational database started','Deterministic fixtures are not real historical operations','Does not exhaust every possible strategy input'],
  source_hashes:sourceFiles.map(path=>({path,base_sha256:existsSync(join(checkout,path))?digest(readFileSync(join(checkout,path),'utf8')):null,repaired_sha256:digest(readFileSync(join(ROOT,path),'utf8'))}))};
 mkdirSync(dirname(OUT),{recursive:true});writeFileSync(OUT,JSON.stringify(evidence,null,2)+'\n');
 console.log(JSON.stringify({passed:checks.length,failed:0,transitions_passed:transitions.length,scenarios:checks.map(x=>({name:x.name,steps:x.steps,events:x.event_types})),evidence:OUT}));
}finally{rmSync(temp,{recursive:true,force:true});}
