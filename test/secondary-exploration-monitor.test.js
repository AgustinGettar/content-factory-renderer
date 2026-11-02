import test from 'node:test';
import assert from 'node:assert/strict';
import {initialState} from '../lib/trading/engine.js';
import {initializeFrequency} from '../lib/trading/frequency.js';
import {initializeLaboratory} from '../lib/trading/laboratory.js';
import {enablePortfolio} from '../lib/trading/portfolio.js';
import {initializeSecondary,SECONDARY_VERSION,SECONDARY_MODEL,OperationalSecondary} from '../lib/trading/secondary-futures.js';
import {EXPLORATION_VERSION,installExploration,explorationContract} from '../lib/trading/secondary-exploration.js';
import {attachOperationalProjection,secondaryFinancialSummary,secondaryMessage,SecondaryNotifier,installOperational} from '../lib/trading/secondary-futures-runtime.js';
import {planView,accountView} from '../lib/trading/monitor-projection.js';
const NOW=Date.parse('2026-11-02T02:25:05Z'),CUT=NOW-5000;
const ENV={LUMI_TRADING_SECONDARY_EXECUTION:SECONDARY_VERSION,LUMI_TRADING_SECONDARY_PROFILE:EXPLORATION_VERSION,LUMI_TRADING_MODE:'PAPER',LUMI_RUNTIME_ENV:'staging',LUMI_TRADING_STORAGE:'SQLITE'};
function fixture(){
 const state=initialState(NOW-7200000);initializeFrequency(state,NOW-7200000);initializeLaboratory(state,NOW-7200000);enablePortfolio(state.frequency.account);state.laboratory.status='RESEARCH_COMPLETE';state.laboratory.trials=[{version:'historical-rejected',status:'REJECTED',net:-30}];
 Object.assign(state.frequency.account,{cash:'470',equity:'470',net:'-30',fees:'35',availableCash:'470',peak:'500'});state.laboratory.funding={initial:'100',added:'400',count:0,history:[]};
 const x=initializeSecondary(state,NOW-7200000);installExploration(state,ENV,NOW-1000);x.market={quote:{source:'KRAKEN_FUTURES_WS_TICKER',symbol:'PF_XBTUSD',event_at:NOW,received_at:NOW,bid:'100',ask:'100.01',bid_qty:'1',ask_qty:'1'},quote_at:NOW,last_refresh:NOW,closed_at:{5:CUT,15:Math.floor(CUT/900000)*900000}};
 x.decisions=Object.fromEntries(['BREAKOUT','PULLBACK','RANGE_REENTRY'].map(pattern=>[pattern,{pattern,at:NOW-1000,cutoff:CUT,timeframe:5,reason:'WAIT_'+pattern,criteria:{atr15:1,entry_revision:'secondary-entry-exploration-1.0.0'}}]));x.counts.evaluations=3;
 x.capital={version:'secondary-paper-capital-1.0.0',initial_contributed:'500',contribution_source:'LEGACY_FUNDING_LEDGER',topups:'50',total_contributed:'550',count:1,events:[{id:'topup1',amount:'50',balance_before:'470',balance_after:'520',at:NOW}]};Object.assign(state.frequency.account,{cash:'520',equity:'520',availableCash:'520'});
 return {state,x};
}
function plan(){return {id:'a'.repeat(32),version:SECONDARY_VERSION,execution_model:SECONDARY_MODEL,pattern:'BREAKOUT',direction:'LONG',instrument:'PAPER:KRAKEN_FUTURES:PF_XBTUSD',recipe_title:'Ruptura',entry:'100',stop:'99',target:'103',holding_ms:1800000,decision_at:NOW,execution_contract:{version:'secondary-exploration-execution-1.0.0',mode:'TAKER_IOC',takerFee:'0.0005',makerFee:'0.0002'},quality:{classification:'COSTS_NOT_COVERED',labels:['EXPECTED_NET_NEGATIVE'],validated:false},sizing:{qty:'1',exposure:'100',initial_margin:'50',leverage:2,risk:'1.12',target_net:'-0.01',entry_fee_rate:'0.0005',reserved:'50.05'}};}
test('monitor separates fictitious contributions and net results while leaving the primary and rejected trial intact',()=>{
 const {state,x}=fixture(),before=structuredClone(state),primary={cash:'100',equity:'100',net:'0'},legacy=structuredClone(state.laboratory.trials[0]);
 const d={revision:7,updated_at:new Date(NOW).toISOString(),lease_until:new Date(NOW+45000).toISOString(),account:primary,frequency:{account:accountView(state.frequency.account),protocol:{}},laboratory:{status:'RESEARCH_COMPLETE',trials:[legacy]},timeframes:{frames:[1,15,60,240],series:{}},operations:[]};
 const publisher={send:async()=>{}};attachOperationalProjection(publisher,{row(){throw Error('unexpected second read');}});publisher.projectSnapshot(d,state,NOW);
 assert.equal(d.frequency.operation_mode,'EXPLORATION_PAPER');assert.equal(d.frequency.risk_profile.financial_blocks,false);assert.equal(d.frequency.risk_profile.maxSlots,null);assert.equal(d.frequency.account.max_slots,null);assert.equal(d.frequency.risk_profile.nominalUSD,'100');
 assert.equal(d.secondary_finances.capital_contributed,'550');assert.equal(d.secondary_finances.fictitious_topups,'50');assert.equal(d.secondary_finances.realized_net,'-30');assert.equal(d.secondary_finances.unrealized_net,'0');assert.equal(d.secondary_finances.total_net,'-30');assert.equal(d.secondary_finances.equity_less_contributions,'-30');assert.equal(d.secondary_finances.deposits_are_profit,false);
 assert.equal(d.secondary_activity.market.usable,true);assert.equal(d.secondary_activity.process.status,'RECENT_COMMIT_AND_LEASE');assert.equal(d.secondary_activity.patterns.length,3);assert.equal(d.secondary_activity.last_evaluation_at,NOW-1000);assert.equal(d.secondary_activity.profile.version,EXPLORATION_VERSION);
 assert.deepEqual(d.account,primary);assert.deepEqual(d.laboratory.trials[0],legacy);assert.equal(d.laboratory.previous_trial_status,'RESEARCH_COMPLETE');assert.deepEqual(state,before);
});
test('stale market values are not promoted to current unrealized profits',()=>{
 const {state,x}=fixture(),p=plan();state.frequency.account.positions[p.id]={plan:p,qty:'1',entry:'100',entry_fee:'0.05',initial_margin:'50',entered_at:NOW-1000,accrued_funding:'0',quality:'OBSERVED'};
 const current=secondaryFinancialSummary(state,x.market.quote,NOW);assert.equal(current.valuation_quality,'CURRENT_ESTIMATE');assert(Number(current.unrealized_net)<0);
 const stale=secondaryFinancialSummary(state,x.market.quote,NOW+6000);assert.equal(stale.valuation_quality,'INCOMPLETE_DATA');assert.equal(stale.unrealized_net,null);assert.equal(stale.total_net,null);assert.equal(stale.capital_contributed,'550');
});
test('plan projection retains the execution contract and unfavorable cost label',()=>{
 const p=plan(),v=planView(p);assert.deepEqual(v.execution_contract,p.execution_contract);assert.deepEqual(v.quality,p.quality);assert.equal(v.pattern,'BREAKOUT');assert.equal(v.holding_ms,1800000);
});
test('operational projection preserves exit intent, uncertain funding, execution costs and complete lifecycle events',()=>{
 const {state}=fixture(),p=plan(),raw={plan:p,qty:'0.2',entry:'100',entry_fee:'0.01',initial_margin:'10',entered_at:NOW-1000,accrued_funding:'0',quality:'FUNDING_GAP',
  exit_intent:{reason:'STOP',decided_at:NOW,not_before:NOW+1000},execution_blocker:'EXIT_LATENCY_PENDING',funding_pending:[{hour:1,from:0,to:1,qty:'0.2'}],closed_funding_pending:[{hour:1,from:0,to:1,qty:'0.1'}],excursions:{max_favourable_net:'0.1',max_adverse_net:'-0.2',observations:2},data_gaps:[{from:NOW-2000,to:NOW-1000,status:'UNRESOLVED_PRICE_PATH'}],execution_costs:{entry_fees:'0.01',entry_slippage:'0.004',entry_spread_vs_mid:'0.001'}};
 state.frequency.account.positions[p.id]=raw;state.frequency.history=[{id:p.id,type:'FILLED',execution_state:'EJECUCIÓN_PARCIAL',qty:'0.2',remaining_qty:'0.8',at:NOW,plan:p},{id:'topup',type:'PAPER_CAPITAL_TOPUP',amount:'50',balance_before:'470',balance_after:'520',at:NOW},{id:'closed',type:'CLOSED',pnl:'-1',result_final:false,quality:'FUNDING_GAP',at:NOW}];
 const account=accountView(state.frequency.account),keys=['exit_intent','execution_blocker','funding_pending','closed_funding_pending','excursions','data_gaps','execution_costs'];for(const k of keys)assert.deepEqual(account.positions[0][k],raw[k]);
 const d={frequency:{account,protocol:{}},laboratory:{trials:[]},operations:[]},before=structuredClone(state),publisher={send:async()=>{}};attachOperationalProjection(publisher,{});publisher.projectSnapshot(d,state,NOW);
 const saved=JSON.parse(JSON.stringify(d));for(const k of keys)assert.deepEqual(saved.frequency.account.positions[0][k],raw[k]);
 assert.equal(saved.frequency.history[0].execution_state,'EJECUCIÓN_PARCIAL');assert.equal(saved.frequency.history[0].remaining_qty,'0.8');assert.equal(saved.frequency.history[1].amount,'50');assert.equal(saved.frequency.history[2].result_final,false);assert.equal(saved.secondary_finances.realized_result_final,false);assert.deepEqual(state,before);
});
test('Telegram distinguishes selected, partial, open, expired, closed and fictitious deposits',()=>{
 const p=plan(),base={id:p.id,plan:p,qty:'0.2',price:'100.03',fee:'0.010003',requested_qty:'1',cumulative_qty:'0.2',remaining_qty:'0.8'};
 assert.match(secondaryMessage({kind:'SECONDARY_SELECTED',payload:base}),/ORDEN_PENDIENTE[\s\S]*Todavía no hay una ejecución/);
 assert.match(secondaryMessage({kind:'SECONDARY_PARTIAL',payload:base}),/EJECUCIÓN_PARCIAL[\s\S]*0.2 \/ 1 BTC[\s\S]*Remanente: 0.8/);
 assert.match(secondaryMessage({kind:'SECONDARY_OPEN',payload:base}),/POSICIÓN_ABIERTA[\s\S]*taker IOC[\s\S]*0.05 %[\s\S]*CALIDAD DESFAVORABLE/);
 assert.match(secondaryMessage({kind:'SECONDARY_UNFILLED',payload:{id:p.id,order_state:'ORDEN_VENCIDA',reason:'VENCIDA'}}),/ORDEN_VENCIDA[\s\S]*sin ejecución[\s\S]*no es una pérdida/);
 assert.match(secondaryMessage({kind:'SECONDARY_UNFILLED',payload:{...base,had_partial:true,reason:'IOC_REMAINDER_CANCELLED'}}),/únicamente el remanente[\s\S]*conserva su posición/);
 assert.match(secondaryMessage({kind:'SECONDARY_TOPUP',payload:{id:'deposit',order_id:p.id,amount:'50',balance_before:'1',balance_after:'51',capital_contributed_total:'550',reason:'ORDER_RESERVATION'}}),/PAPER_CAPITAL_TOPUP[\s\S]*no una ganancia/);
 assert.match(secondaryMessage({kind:'SECONDARY_CLOSE',payload:{id:p.id,direction:'LONG',entry:'100',price:'99',pnl:'-0.2',fees:'0.1',quality:'DATA_GAP_UNRESOLVED',reason:'STOP'}}),/POSICIÓN_CERRADA[\s\S]*incertidumbre/);
});
test('new notification kinds use the verified transport and claimed outbox exactly once',async()=>{
 for(const kind of ['SECONDARY_SELECTED','SECONDARY_PARTIAL','SECONDARY_UNFILLED','SECONDARY_TOPUP']){
  let calls=0;const item={id:kind,kind,status:'QUEUED',payload:{id:'notice1',plan:plan(),qty:'0.2',price:'100.01',fee:'0.01',requested_qty:'1',cumulative_qty:'0.2',remaining_qty:'0.8',amount:'50',balance_before:'1',balance_after:'51',capital_contributed_total:'550',reason:'TEST_ISOLATED'}};
  const store={async queued(){return item.status==='QUEUED'?[item]:[];},async tx(x){if(x.phase==='CLAIM'){Object.assign(item,{status:'DISPATCHING',claim_id:x.claim_id});return {...item};}Object.assign(item,x);return {...item};}};
  const transport={async call(method,body){assert.equal(method,'sendMessage');assert.equal(body.chat_id,'123');calls++;return {message_id:11,chat:{id:123},date:1};}};
  const notifier=new SecondaryNotifier({store,transport,env:{LUMI_TRADING_STORAGE:'SQLITE',LUMI_TRADING_OWNER_ID:'123',LUMI_TELEGRAM_REVIEW_TEST_USERS:'123'},feed:{state:{},metadata:{}},pending:()=>false});notifier.identityAt=Date.now();await notifier.drain();await notifier.drain();assert.equal(item.status,'DELIVERED');assert.equal(calls,1);
 }
});
test('LIVE mode is rejected before starting a secondary runtime',()=>{
 assert.throws(()=>installOperational({}, {...ENV,LUMI_TRADING_MODE:'LIVE'}),/PAPER_ONLY/);
});

test('partial reservation uses the remaining quantity and unresolved funding remains explicit',()=>{
 const {state,x}=fixture(),p=plan(),a=state.frequency.account;
 a.pendingOrders[p.id]={plan:p,placed_at:NOW,filled_qty:'0.2',remaining_qty:'0.8',remaining_reserved:'40.04',remaining_risk:'0.896'};
 a.positions[p.id]={plan:p,qty:'0.2',entry:'100',entry_fee:'0.01',initial_margin:'10',entered_at:NOW-1000,accrued_funding:'0',remaining_risk:'0.224',funding_pending:[{hour:Math.floor(NOW/3600000)*3600000,from:NOW-1000,to:NOW,qty:'0.2'}],quality:'FUNDING_GAP'};
 a.fundingReserve='0';const view=accountView(a);assert.equal(view.reserved_cash,40.04);assert.equal(view.committed_risk,1.12);
 const summary=secondaryFinancialSummary(state,x.market.quote,NOW);assert.equal(summary.unrealized_net,null);assert.equal(summary.valuation_quality,'INCOMPLETE_DATA');
 a.positions[p.id].funding_pending=[];a.positions[p.id].closed_funding_pending=[{hour:1,from:0,to:1,qty:'0.1'}];assert.equal(secondaryFinancialSummary(state,x.market.quote,NOW).realized_result_final,false);
 x.closed_funding_pending={older:{intervals:[{hour:1,from:0,to:1,qty:'1'}]}};const provisional=secondaryFinancialSummary(state,x.market.quote,NOW);assert.equal(provisional.realized_result_final,false);assert.equal(provisional.total_net,null);assert.equal(provisional.valuation_quality,'UNRESOLVED_CLOSED_FUNDING');
});
test('operational installation preserves pending contracts on shutdown and cannot install a second writer',()=>{
 const {state}=fixture(),events=[],notices=[];const engine={state,event:e=>events.push(e),notice:(...args)=>notices.push(args),frequency:{},laboratory:{},learning:{track(){}},tick:async()=>{},acceptDelivery(){},lastLease:Date.now()};
 const own=Object.hasOwn(OperationalSecondary.prototype,'start'),start=OperationalSecondary.prototype.start;OperationalSecondary.prototype.start=function(){};
 try{
  const runtime=installOperational(engine,ENV),p=plan();state.frequency.account.pendingOrders[p.id]={plan:p,placed_at:Date.now()+1000,remaining_qty:'1',filled_qty:'0',remaining_reserved:'50.05'};
  engine.frequency.cancel('ORDER_CANCELLED_ON_SHUTDOWN');assert.equal(state.frequency.account.pendingOrders[p.id].plan,p);assert.equal(runtime.state.market_issue,'ORDER_CANCELLED_ON_SHUTDOWN');assert.equal(notices.filter(n=>n[0]==='SECONDARY_STATUS').length,1);
  assert.throws(()=>installOperational(engine,ENV),/ALREADY_INSTALLED/);assert.equal(notices.filter(n=>n[0]==='SECONDARY_STATUS').length,1);
 }finally{if(own)OperationalSecondary.prototype.start=start;else delete OperationalSecondary.prototype.start;}
});
