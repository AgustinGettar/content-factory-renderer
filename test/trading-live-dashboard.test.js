import test from 'node:test';import assert from 'node:assert/strict';
import {DashboardPublisher,snapshot,liveBody,LIVE_PUBLISH_MS,DETAIL_PUBLISH_MS} from '../lib/trading/dashboard-publisher.js';
import {initialState} from '../lib/trading/engine.js';
import {D,hash} from '../lib/trading/core.js';
import {newAccount} from '../lib/trading/simulator.js';
import {enablePortfolio} from '../lib/trading/portfolio.js';
import {SecondaryBroker,secondaryEconomics,SECONDARY_MODEL,SECONDARY_VERSION} from '../lib/trading/secondary-futures-engine.js';
import {EXPLORATION_VERSION,installExploration,getExplorationPolicy,explorationContract} from '../lib/trading/secondary-exploration.js';
import {EARLY_PROFIT_POLICY_VERSION,installProfitPolicy,getProfitPolicy,makeProfitContracts} from '../lib/trading/secondary-profit-policy.js';
import {CAPITAL_ALLOCATION_VERSION,installCapitalAllocation} from '../lib/trading/secondary-capital-allocation.js';
import {RISK_BUDGET_VERSION,installRiskBudget,prepareRiskCandidates,validateRiskContract} from '../lib/trading/secondary-risk-budget.js';
import {SECONDARY_TIMEFRAMES_VERSION,installSecondaryTimeframes,secondaryFrameSpec} from '../lib/trading/secondary-timeframes.js';
import {attachOperationalProjection} from '../lib/trading/secondary-futures-runtime.js';
const NOW=Date.parse('2026-10-31T01:00:00Z');
function harness(){
 let now=NOW,revision=4;const calls=[],metadata=[];const state=initialState(NOW);
 const row=()=>({state,revision,updated_at:new Date(now).toISOString(),lease_until:new Date(now+45000).toISOString()});
 const store={row,latest:()=>[],notices:()=>[],db:{prepare:()=>({run:(k,v)=>metadata.push(JSON.parse(v))})}};
 const feed={state:{connected:true,reconciled:true,system:'online',clock:{checked_at:NOW,error_ms:0},quote:{ask:'100.1',bid:'100',event_at:NOW,received_at:NOW},trade:{price:'100',event_at:NOW,received_at:NOW}},metadata:{status:'online',checked_at:NOW},counters:{quotes:1,trades:1,reconnects:0}};
 const publisher=new DashboardPublisher({store,feed,env:{},now:()=>now,fetchImpl:async(url,options)=>{const body=JSON.parse(options.body);calls.push({url,body});return Response.json({revision:body.revision});}});publisher.backup=async()=>{};
 return {publisher,calls,metadata,state,tick:n=>{now+=n;revision++;}};
}
test('live body omits candle evidence without changing authoritative balances, plans or net exits',()=>{
 const evidence={panels:[{candles:Array.from({length:120},()=>({open:1,close:2,high:3,low:1}))}]},plan={id:'p',hash:'h',entry:'100',sizing:{risk:'3'},evidence};
 const d={schema:1,revision:4,generated_at:NOW,account:{equity:'299',positions:[{plan,live_exit:{net:'0.25'}}]},operations:[{id:'p',plan}]},before=structuredClone(d),fast=JSON.parse(liveBody(d));
 assert.deepEqual(d,before);assert.equal(fast.account.positions[0].live_exit.net,'0.25');assert.equal(fast.operations[0].plan.hash,'h');assert.equal(fast.operations[0].plan.evidence,undefined);assert.equal(fast.operations[0].plan.evidence_available,true);assert.equal(fast.refresh_ms,2000);assert(liveBody(d).length<JSON.stringify(d).length/10);
});
test('large historical proofs and contracts stay in detail while live preserves closures, partials and current protection',()=>{
 const proof={quote:{bid:'100000',ask:'100001'},panels:Array.from({length:40},()=>({values:'x'.repeat(1000)}))},plan={id:'p',hash:'signed-plan',timeframe:5,entry:'100000',stop:'99000',target:'101000',sizing:{qty:'0.003',exposure:'300',initial_margin:'150',leverage:2},execution_contract:{version:'execution-v1',mode:'TAKER_IOC',largeProof:proof},exit_policy:{version:'secondary-net-protection-2.0.0',target_activation_required:false},entry_economics:{expected_net_target:'.60',minimum_expected_net_target:'.60',quote:proof},evidence:proof};
 const protection={state:'TRAILING_ACTIVE',protected_net:'.30',peak_net:'.40',required_activation_net:'.08',activation_evidence:proof,peak_evidence:proof,floor_evidence:proof};
 const close={type:'CLOSED',id:'old',at:NOW,ledger:'FREQUENT_PAPER',plan,pnl:'0.2460525197',fill_pnl:'.10',reason:'MANUAL_PROFIT',management_override:true,profit_protection:protection,execution_receipt:proof};
 const d={revision:4,feed:{quote:{bid:'100000',ask:'100001'}},frequency:{account:{cash:'299.25',positions:[{qty:'.003',plan,profit_protection:protection,exit_intent:{id:'durable',reason:'TRAILING_RETRACEMENT'},live_exit:{net:'.25',fresh:true}}]},history:Array.from({length:40},(_,i)=>({...close,id:'old-'+i}))}},before=structuredClone(d),detail=JSON.stringify(d),fast=JSON.parse(liveBody(d));
 assert.deepEqual(d,before);assert(detail.includes('largeProof'));assert(liveBody(d).length<detail.length/20);assert.equal(fast.frequency.account.cash,'299.25');assert.equal(fast.feed.quote.bid,'100000');
 const active=fast.frequency.account.positions[0];assert.equal(active.plan.hash,'signed-plan');assert.equal(active.plan.exit_policy.target_activation_required,false);assert.equal(active.profit_protection.protected_net,'.30');assert.equal(active.profit_protection.floor_evidence,undefined);assert.equal(active.exit_intent.id,'durable');assert.equal(active.live_exit.net,'.25');
 const event=fast.frequency.history[0];assert.equal(event.pnl,'0.2460525197');assert.equal(event.fill_pnl,'.10');assert.equal(event.reason,'MANUAL_PROFIT');assert.equal(event.management_override,true);assert.equal(event.plan.sizing.initial_margin,'150');assert.equal(event.plan.execution_contract.largeProof,undefined);assert.equal(event.plan.versions.exit,'secondary-net-protection-2.0.0');
});
test('two-second state publications continue during backup; unchanged detail waits for fifteen seconds',async()=>{
 const h=harness();let finish;h.publisher.backup=()=>new Promise(r=>finish=r);
 await h.publisher.publish();assert.equal(h.publisher.backupBusy,true);assert.equal(h.calls.length,2);
 h.tick(LIVE_PUBLISH_MS);await h.publisher.publish();assert.equal(h.calls.length,3);assert(h.calls[2].url.endsWith('/api/aws/live'));
 h.tick(DETAIL_PUBLISH_MS);await h.publisher.publish();assert.equal(h.calls.length,5);assert.equal(h.metadata.at(-1).interval_ms,2000);assert(h.metadata.at(-1).live_bytes>0);
 finish();await h.publisher.backupTask;assert.equal(h.publisher.backupBusy,false);assert(h.metadata.at(-1).backup_at>=NOW);
});
test('receipt must acknowledge the posted revision and failures preserve last successful timestamp',async()=>{
 const h=harness();await h.publisher.publish();await h.publisher.backupTask;const before=h.publisher.lastSuccess;
 h.tick(2000);h.publisher.fetchImpl=async()=>Response.json({revision:999});await h.publisher.publish();assert.equal(h.publisher.lastSuccess,before);assert.equal(h.publisher.error,'DASHBOARD_RECEIPT_INVALID');
});
test('overlapping publishes are skipped and failed detail does not erase successful live delivery',async()=>{
 const h=harness();let release;h.publisher.fetchImpl=async(url,o)=>{h.calls.push(url);if(url.endsWith('/live'))await new Promise(r=>release=r);return url.endsWith('/snapshot')?new Response('',{status:503}):Response.json({revision:JSON.parse(o.body).revision});};
 const first=h.publisher.publish();await h.publisher.publish();assert.equal(h.calls.length,1);release();await first;await h.publisher.backupTask;assert.equal(h.calls.length,2);assert.equal(h.publisher.error,null);assert.equal(h.publisher.detailError,'DASHBOARD_DETAIL_UNAVAILABLE');assert.equal(h.publisher.lastSuccess,NOW);
});

// Serialization stress only: compose ten independently admitted synthetic
// contracts. This is not evidence of simultaneous causal trading opportunities.
function tenRiskContractSnapshots(partial,{historyCount=0,pendingCount=0}={}){
 const at=Date.parse('2026-11-03T16:00:02Z'),now=at+6000,protectionAt=at+2200,hour=Math.floor(at/3600000)*3600000;
 const env={LUMI_RUNTIME_ENV:'staging',LUMI_TRADING_MODE:'PAPER',LUMI_TRADING_STORAGE:'SQLITE',
  LUMI_TRADING_SECONDARY_PROFILE:EXPLORATION_VERSION,LUMI_TRADING_SECONDARY_PROFIT_POLICY:EARLY_PROFIT_POLICY_VERSION,
  LUMI_TRADING_SECONDARY_CAPITAL_ALLOCATION:CAPITAL_ALLOCATION_VERSION,LUMI_TRADING_SECONDARY_RISK_BUDGET:RISK_BUDGET_VERSION,
  LUMI_TRADING_SECONDARY_TIMEFRAMES:SECONDARY_TIMEFRAMES_VERSION};
 const quote=(time,bid=100,size=1000)=>({source:'KRAKEN_FUTURES_WS_TICKER',symbol:'PF_XBTUSD',event_at:time,received_at:time,bid:String(bid),ask:D(bid).plus('.01').toString(),bid_qty:String(size),ask_qty:String(size)});
 const meta={symbol:'PF_XBTUSD',qty_step:'0.0001',tick_size:'0.01',checked_at:at},positions={},pending={},movements={},archived=[];let first;
 for(let i=0;i<10+historyCount;i++){
  const account=newAccount();enablePortfolio(account);Object.assign(account,{cash:'10000',equity:'10000',peak:'10000'});
  const root={...initialState(at),frequency:{account,counts:{},history:[]},laboratory:{status:'RESEARCH_COMPLETE',funding:{initial:'10000',added:'0'}}};
  const events=[],historical=i>=10,pendingOnly=i<pendingCount;
  const broker=new SecondaryBroker({root,now:()=>now,event:e=>events.push(structuredClone(e))});installExploration(root,env,at);installProfitPolicy(root,env,at);installCapitalAllocation(root,env,at);installRiskBudget(root,env,at);
  const timeframe=[5,15,60,240][i%4],id=hash(['LIVE_SIZE_FIXTURE',i]),contracts=makeProfitContracts(getProfitPolicy(root),{timeframe});
  const execution=explorationContract(getExplorationPolicy(root),'BREAKOUT',at),entry=D('100.01').mul('1.0002');
  const plan={id,signal_key:hash(['LIVE_SIZE_SIGNAL',i]),version:SECONDARY_VERSION,entry_revision:getProfitPolicy(root).entryRevision,execution_model:SECONDARY_MODEL,instrument:'PAPER:KRAKEN_FUTURES:PF_XBTUSD',pattern:'BREAKOUT',direction:'LONG',timeframe,
   entry:entry.toString(),limit:'100',stop:'99.6',target:'103',confirmed_at:at-2000,decision_at:at,expires_at:execution.expires_at,holding_ms:contracts.exit_policy.base_holding_ms,execution_contract:execution,order:'FUTURES_TAKER_IOC',fill_model:execution.liquidity_model,
   economics:secondaryEconomics(entry,'99.6','103','LONG',0,execution,contracts.economic_policy.funding_estimation_ms),...contracts,
   timeframe_contract:{version:SECONDARY_TIMEFRAMES_VERSION,timeframe,context_timeframe:secondaryFrameSpec(timeframe).context_timeframe,source:'KRAKEN_FUTURES_TRADE_CANDLES',closed_candles_only:true},
   entry_context:{version:'secondary-entry-context-economics-1.0.0',structure_key:'structure:'+id,movement_key:'movement:'+id,confirmation_key:hash(['LIVE_SIZE_CONFIRMATION',i]),confirmation_event_at:at-2000,confirmation_at:at-2000,price_tick:'.01',remaining_distance:D(103).minus(entry).toString(),remaining_distance_fraction:D(103).minus(entry).div(entry).toString()},
   evidence:{schema:1,closed_bars:true,panels:[{tf:timeframe,candles:Array.from({length:80},(_,j)=>({start:at-(81-j)*timeframe*60000,end:at-(80-j)*timeframe*60000,open:100,high:101,low:99,close:100.5,volume:100}))}]}};
  const selected=prepareRiskCandidates(root,[{plan,pattern:'BREAKOUT',reason:'CANDIDATE'}],{quote:quote(at),meta,now:at,preflight:broker.preflight.bind(broker)}).ordered[0];
  assert.equal(selected.capital_allocation_rejection,undefined);assert.equal(broker.choose(selected.plan,quote(at),meta,at),'ENTRY_PENDING');
  if(!pendingOnly){
   const unfilled=historical&&i%3===0;
   broker.market(quote(at+1100,100,unfilled?0:partial?15:1000),null,{[hour]:0},at+1100);
   if(!unfilled){
    const p=account.positions[id];assert(p);
    if(partial)broker.manageProfitPosition(p,quote(protectionAt,100.5),{[hour]:0},protectionAt);
    else broker.market(quote(protectionAt,100.5),null,{[hour]:0},protectionAt);
    assert(p.profit_protection.trailing_activated_at);assert(validateRiskContract(p.plan));
    if(historical){broker.market(quote(at+3300,100.3),null,{[hour]:0},at+3300);broker.market(quote(at+4400,100.29),null,{[hour]:0},at+4400);assert.equal(account.positions[id],undefined);}
    else positions[id]=structuredClone(p);
   }
  }
  new SecondaryBroker({root:structuredClone(root),now:()=>now}); // Real contract/recovery validation.
  if(account.pendingOrders[id])pending[id]=structuredClone(account.pendingOrders[id]);
  if(historical){assert(events.some(e=>['CLOSED','NOT_FILLED'].includes(e.type)));archived.push(...events);}
  Object.assign(movements,structuredClone(root.secondaryExecution.risk_budget.movements));first??=root;
 }
 const empty=structuredClone(first);empty.frequency.account.positions={};empty.frequency.account.pendingOrders={};empty.frequency.account.position=null;empty.frequency.account.pending=null;empty.frequency.history=[];
 empty.secondaryExecution.risk_budget.movements=movements;empty.secondaryExecution.risk_budget.confirmations=Object.values(movements).flatMap(m=>m.legs.map(l=>l.confirmation_id));
 empty.secondaryExecution.market={quote:quote(now,100.5),closed_at:{},frame_refresh_at:{},last_refresh:now};installSecondaryTimeframes(empty,env,at);
 const full=structuredClone(empty);full.frequency.account.positions=positions;full.frequency.account.pendingOrders=pending;
 if(historyCount){
  const plans=[...Object.values(positions),...Object.values(pending)].map(p=>p.plan),x=full.secondaryExecution;
  for(const tf of [5,15,60,240]){
   const p=plans.find(p=>p.timeframe===tf),f=x.timeframe_execution.frames[tf];assert(p);
   const decision={at:protectionAt,cutoff:at-2000,pattern:'BREAKOUT',reason:'ENTRY_PENDING',timeframe:tf,context_timeframe:secondaryFrameSpec(tf).context_timeframe,criteria:{entry_economics:p.entry_economics,context_admission:p.context_admission,risk_allocation:p.execution_contract.risk_budget.receipt,gain:p.economics.gain,netRR:p.economics.netRR}};
   Object.assign(f,{last_evaluation_at:protectionAt,last_completed_at:protectionAt,last_status:'COMPLETED',last_decision:decision,decisions:{BREAKOUT:decision}});
  }
  x.decisions=x.timeframe_execution.frames[5].decisions;full.frequency.lastDecision=x.timeframe_execution.frames[5].last_decision;
  x.last_allocation_batch={at:protectionAt,cutoff:at-2000,timeframe:240,eligible_count:1,preferred_id:null,receipts:[plans.find(p=>p.timeframe===240).execution_contract.risk_budget.receipt]};x.risk_budget.last_batch=x.last_allocation_batch;
 }
 const feed={state:{connected:true,reconciled:true,system:'online',clock:{checked_at:now,error_ms:0},quote:quote(now,100.5),trade:{price:'100.5',event_at:now,received_at:now}},metadata:{status:'online',checked_at:now},counters:{quotes:1,trades:1,reconnects:0}};
 function project(root,withHistory=false){
  const rows=withHistory?archived:[];
  const store={row:()=>({state:root,revision:1,updated_at:new Date(now).toISOString(),lease_until:new Date(now+45000).toISOString()}),
   latest:(kinds,n)=>rows.filter(e=>kinds.includes(e.type)).slice(-n).reverse().map(e=>({kind:e.type,payload:e,created_at:new Date(e.at).toISOString()})),
   notices:()=>rows.filter(e=>e.type==='SELECTED').slice(-20).map(e=>({id:e.id,kind:'SECONDARY_SELECTED',status:'SENT',created_at:new Date(e.at).toISOString(),payload:e}))};
  const publisher={send:async()=>{}};attachOperationalProjection(publisher,store,{series:{}});
  return snapshot(store,feed,now,null,publisher.projectSnapshot);
 }
 return {empty:project(empty),full:project(full,true)};
}

function assertVisibleRiskPlan(actual,original){
 for(const key of ['id','hash','direction','timeframe','entry','limit','stop','target','holding_ms','movement_id','parent_id','leg_index'])assert.equal(actual[key],original[key]);
 for(const key of ['qty','risk','exposure','reserved','target_net','initial_margin','leverage','financing','liquidation_estimate','net_rr'])assert.equal(actual.sizing[key],original.sizing[key]);
 for(const key of ['version','min_expected_net_target_fraction','funding_estimation_ms'])assert.equal(actual.economic_policy[key],original.economic_policy[key]);
 for(const key of ['version','timeframe','min_activation_net_fraction','target_activation_required','retracement_fraction','min_protected_net_usd','execution_uncertainty_fraction','base_holding_ms','trailing_extension_ms','stagnation_ms'])assert.equal(actual.exit_policy[key],original.exit_policy[key]);
 for(const key of ['expected_net_target','minimum_expected_net_target','effective_exposure','expected_loss_stop','net_rr','quantity'])assert.equal(actual.entry_economics[key],original.entry_economics[key]);
 for(const key of ['movement_budget_usd','exposure_for_aspiration','aspiration_achievable'])assert.equal(actual.execution_contract.risk_budget.receipt[key],original.execution_contract.risk_budget.receipt[key]);
 assert.equal(actual.execution_contract.risk_budget.policy.max_movement_legs,original.execution_contract.risk_budget.policy.max_movement_legs);
 assert.deepEqual(actual.context_admission.related_position_ids,original.context_admission.related_position_ids);assert.deepEqual(actual.timeframe_contract,original.timeframe_contract);
 assert.equal(actual.detail_available,true);assert.equal(actual.canonical_plan_ref,undefined);assert.equal(actual.detail_plan_ref,undefined);
 assert.equal(actual.execution_contract.risk_budget.base_execution_contract,undefined,'full immutable receipt is in detail, not advertised as a live signed contract');
}

for(const partial of [false,true])test(`ten protected risk contracts ${partial?'with partial IOC fills':'fully filled'} fit live budget without changing detail or visible values`,t=>{
 const {empty,full}=tenRiskContractSnapshots(partial),detail=JSON.stringify(full),before=structuredClone(full);
 const emptyBytes=Buffer.byteLength(liveBody(empty)),body=liveBody(full),live=JSON.parse(body),delta=Buffer.byteLength(body)-emptyBytes;
 assert(636636+delta<1024*1024,`baseline plus increment exceeds 1 MiB: ${636636+delta}`);
 assert.equal(JSON.stringify(full),detail);assert.deepEqual(full,before);
 assert.equal(live.frequency.account.positions.length,10);assert.equal(live.frequency.account.pending_orders.length,0);assert.equal(live.operations.length,10);
 if(partial)assert(live.frequency.account.positions.every(p=>D(p.qty).lt(p.plan.sizing.qty)),'IOC remainder is cancelled, not a second active slot');
 for(const original of full.frequency.account.positions){
  const active=live.frequency.account.positions.find(p=>p.plan.id===original.plan.id),op=live.operations.find(o=>o.id===original.plan.id);
  assertVisibleRiskPlan(active.plan,original.plan);assertVisibleRiskPlan(op.plan,original.plan);
  const {plan:originalPlan,entry_revalidation:originalReceipt,...numbers}=JSON.parse(liveBody({row:original})).row,{plan:duplicatePlan,entry_revalidation:displayReceipt,...copy}=op.live_position;
  assert.deepEqual(copy,numbers);for(const key of ['expected_net_target','minimum_expected_net_target','quantity'])assert.equal(displayReceipt[key],originalReceipt[key]);
  assert.equal(duplicatePlan.hash,originalPlan.hash);assert.equal(active.profit_protection.protected_net,original.profit_protection.protected_net);
 }
 for(const order of live.frequency.account.pending_orders){const original=full.frequency.account.pending_orders.find(p=>p.plan.id===order.plan.id);for(const key of ['remaining_qty','filled_qty','remaining_reserved','remaining_risk'])assert.equal(order[key],original[key]);}
 assert(detail.includes('base_execution_contract'));assert(detail.includes('candles'));
 t.diagnostic(JSON.stringify({synthetic_empty_bytes:emptyBytes,synthetic_ten_bytes:Buffer.byteLength(body),increment_bytes:delta,observed_empty_baseline_bytes:636636,estimated_total_bytes:636636+delta,margin_to_1MiB:1024*1024-636636-delta,detail_bytes:Buffer.byteLength(detail),partial_entries:partial,pending_remainders:0}));
});

for(const pendingCount of [0,5,10])test(`thirty new historical operations plus ${10-pendingCount} open and ${pendingCount} pending contracts stay bounded and keep display values`,t=>{
 const {empty,full}=tenRiskContractSnapshots(false,{historyCount:30,pendingCount}),before=JSON.stringify(full),baseBytes=Buffer.byteLength(liveBody(empty)),body=liveBody(full),live=JSON.parse(body);
 const delta=Buffer.byteLength(body)-baseBytes,total=665427+delta;
 t.diagnostic(JSON.stringify({historical:30,open:10-pendingCount,pending:pendingCount,secondary_notices:live.notices.length,frame_receipts:4,increment_bytes:delta,observed_empty_baseline_bytes:665427,estimated_total_bytes:total,margin_to_1MiB:1024*1024-total,detail_bytes:Buffer.byteLength(before)}));
 assert(total<1024*1024,`worst-case live projection exceeds 1 MiB: ${total}`);assert.equal(JSON.stringify(full),before);
 assert.equal(live.operations.length,40);assert.equal(live.frequency.account.positions.length,10-pendingCount);assert.equal(live.frequency.account.pending_orders.length,pendingCount);assert.equal(live.notices.length,20);
 const historic=live.operations.filter(o=>['CLOSED','NOT_FILLED'].includes(o.status));assert.equal(historic.length,30);assert(historic.some(o=>o.status==='CLOSED'));assert(historic.some(o=>o.status==='NOT_FILLED'));
 for(const o of live.operations){const original=full.operations.find(p=>p.id===o.id);assertVisibleRiskPlan(o.plan,original.plan);assert.deepEqual(o.exit,JSON.parse(JSON.stringify({value:original.exit})).value);assert.deepEqual(o.entry,JSON.parse(JSON.stringify({value:original.entry})).value);}
 for(const n of live.notices){const original=full.notices.find(p=>p.id===n.id);assertVisibleRiskPlan(n.plan,original.plan);assert.equal(n.kind,original.kind);assert.equal(n.status,original.status);}
 for(const p of [...live.frequency.account.positions,...live.frequency.account.pending_orders]){const original=[...full.frequency.account.positions,...full.frequency.account.pending_orders].find(x=>x.plan.id===p.plan.id);assertVisibleRiskPlan(p.plan,original.plan);for(const k of ['qty','remaining_qty','remaining_reserved','remaining_risk','filled_qty','initial_margin','entry','expires_at'])assert.equal(p[k],original[k]);assert.deepEqual(p.live_exit,original.live_exit);}
 for(const tf of [5,15,60,240]){const projected=live.secondary_activity.frames[tf].last_evaluation,original=full.secondary_activity.frames[tf].last_evaluation;assert.equal(projected.reason,original.reason);for(const key of ['expected_net_target','minimum_expected_net_target','effective_exposure','expected_loss_stop','net_rr'])assert.equal(projected.criteria.entry_economics[key],original.criteria.entry_economics[key]);assert.equal(projected.criteria.risk_allocation.risk,original.criteria.risk_allocation.risk);assert.equal(projected.criteria.risk_allocation.pretrade,undefined);}
 const historyOnly={...empty,operations:full.operations.filter(o=>['CLOSED','NOT_FILLED'].includes(o.status)),notices:full.notices},historyBefore=JSON.stringify(historyOnly),serialized=JSON.parse(liveBody(historyOnly));
 assert.equal(serialized.frequency.account.positions.length,0);assert.equal(serialized.operations.length,30);assert.equal(JSON.stringify(historyOnly),historyBefore);
 for(const o of serialized.operations){assert.equal(o.plan.canonical_plan_ref,undefined);assert.equal(o.plan.detail_plan_ref,undefined);assert.equal(o.plan.detail_available,true);assert.equal(o.plan.execution_contract.risk_budget.base_execution_contract,undefined);}
});
