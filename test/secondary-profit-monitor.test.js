import test from 'node:test';
import assert from 'node:assert/strict';
import {initialState} from '../lib/trading/engine.js';
import {initializeFrequency} from '../lib/trading/frequency.js';
import {initializeLaboratory} from '../lib/trading/laboratory.js';
import {enablePortfolio} from '../lib/trading/portfolio.js';
import {initializeSecondary,SECONDARY_VERSION,SECONDARY_MODEL,OperationalSecondary} from '../lib/trading/secondary-futures.js';
import {EXPLORATION_VERSION,installExploration} from '../lib/trading/secondary-exploration.js';
import {attachOperationalProjection,secondaryMessage,SecondaryNotifier,installOperational} from '../lib/trading/secondary-futures-runtime.js';
import {planView,accountView,reasonText} from '../lib/trading/monitor-projection.js';

// Synthetic, isolated projection/transport fixtures. Never insert into an operational account.
const NOW=Date.parse('2026-11-02T08:00:00Z');
const POLICY={version:'secondary-profit-policy-1.0.0',mode:'PAPER',min_expected_net_target_fraction:'0.002',retracement_fraction:'0.25',realTrading:false};
const EXIT={version:'secondary-net-trailing-1.0.0',min_activation_net_fraction:'0.002',retracement_fraction:'0.25',base_holding_ms:1800000,trailing_extension_ms:900000,stagnation_ms:600000,quantity_basis:'PER_REMAINING_BTC',target_net_insufficient_action:'KEEP_STOP_AND_BASE_TIMEOUT'};
function plan(id='isolated-a'){
 return {id,hash:id+'-hash',version:SECONDARY_VERSION,execution_model:SECONDARY_MODEL,instrument:'PAPER:KRAKEN_FUTURES:PF_XBTUSD',pattern:'PULLBACK',direction:'SHORT',timeframe:5,recipe_title:'Retroceso',entry:'100',stop:'102',target:'99',holding_ms:1800000,
  execution_contract:{mode:'TAKER_IOC',takerFee:'0.0005',slippage:'0.0002'},sizing:{qty:'1',exposure:'100',initial_margin:'50',reserved:'50.05',risk:'2.12',target_net:'0.85',leverage:2},
  economic_policy:{version:'secondary-entry-economics-1.0.0',min_expected_net_target_fraction:'0.002',policy_version:POLICY.version,policy_hash:'isolated-policy-hash'},
  entry_economics:{version:'secondary-entry-economics-1.0.0',stage:'SELECTION',expected_net_target:'0.85',minimum_expected_net_target:'0.2',effective_exposure:'100',quantity:'1',passes:true},
  entry_context:{structure_id:'isolated-structure',confirmation_id:'isolated-confirmation'},context_admission:{classification:'NEW_OPPORTUNITY',related_position_ids:[]},exit_policy:EXIT};
}
function protection(state='TRAILING_ACTIVE'){
 return {state,exit_policy_version:EXIT.version,trailing_activated_at:NOW-1000,activation_net:'0.2',peak_net:'0.8',peak_at:NOW-500,protected_net:'0.6',retracement_allowance:'0.2',basis_qty:'1',peak_net_per_unit:'0.8',protected_net_per_unit:'0.6',last_valid_quote_at:NOW,base_expires_at:NOW+120000,effective_expires_at:NOW+900000,stagnation_deadline_at:NOW+600000,deadline_reason:'TRAILING_EXTENSION'};
}
function fixture(){
 const s=initialState(NOW-3600000);initializeFrequency(s,NOW-3600000);initializeLaboratory(s,NOW-3600000);enablePortfolio(s.frequency.account);s.laboratory.status='RESEARCH_COMPLETE';s.laboratory.trials=[{version:'isolated-historical-rejected',status:'REJECTED',net:-30}];
 const x=initializeSecondary(s,NOW-3600000);installExploration(s,{LUMI_TRADING_SECONDARY_PROFILE:EXPLORATION_VERSION,LUMI_TRADING_MODE:'PAPER',LUMI_RUNTIME_ENV:'staging',LUMI_TRADING_STORAGE:'SQLITE'},NOW-2000);
 x.profit_policy={version:POLICY.version,active:true,policy:POLICY,policy_hash:'isolated-policy-hash',activated_at:NOW-1000,history:[]};
 x.market={quote:{source:'KRAKEN_FUTURES_WS_TICKER',symbol:'PF_XBTUSD',event_at:NOW,received_at:NOW,bid:'98.9',ask:'98.91',bid_qty:'1',ask_qty:'1'}};
 const p=plan();s.frequency.account.positions[p.id]={plan:p,qty:'1',entry:'100',entry_fee:'0.05',initial_margin:'50',entered_at:NOW-10000,expires_at:NOW+120000,accrued_funding:'0',quality:'OBSERVED',profit_protection:protection(),entry_revalidation:{...p.entry_economics,stage:'PRE_EXECUTION',expected_net_target:'0.84'}};
 return s;
}
function project(s){
 const d={revision:7,updated_at:new Date(NOW).toISOString(),lease_until:new Date(NOW+45000).toISOString(),account:{positions:[],cash:'100'},frequency:{account:accountView(s.frequency.account),protocol:{}},laboratory:{trials:[]},operations:[],timeframes:{frames:[15],series:{}}};
 const publisher={send:async()=>{}};attachOperationalProjection(publisher,{});return publisher.projectSnapshot(d,s,NOW);
}

test('projection preserves immutable entry and exit contracts plus each position protection without changing state',()=>{
 const s=fixture(),raw=s.frequency.account.positions['isolated-a'],before=structuredClone(s),d=project(s),p=d.frequency.account.positions[0];
 for(const key of ['economic_policy','entry_economics','entry_context','context_admission','exit_policy'])assert.deepEqual(planView(raw.plan)[key],raw.plan[key]);
 assert.deepEqual(p.entry_revalidation,raw.entry_revalidation);
 assert.deepEqual(p.profit_protection,raw.profit_protection);assert.equal(p.expires_at,raw.expires_at);assert.equal(p.profit_protection.effective_expires_at,NOW+900000);
 assert.deepEqual(d.frequency.profit_policy,s.secondaryExecution.profit_policy);assert.deepEqual(d.secondary_activity.profit_policy,s.secondaryExecution.profit_policy);
 assert.deepEqual(d.frequency.account.open_position_ids,['isolated-a']);assert.deepEqual(d.secondary_activity.orders.open_position_ids,['isolated-a']);assert.deepEqual(s,before);
 p.profit_protection.peak_net='999';assert.equal(raw.profit_protection.peak_net,'0.8');
});
test('legacy projection has no invented trailing policy and pending exit survives serialization',()=>{
 const s=fixture(),p=s.frequency.account.positions['isolated-a'];p.profit_protection=protection('EXIT_PENDING');p.exit_intent={reason:'TRAILING_RETRACEMENT',decided_at:NOW-500,not_before:NOW+500};
 const legacy={...plan('isolated-legacy')};delete legacy.exit_policy;delete legacy.economic_policy;delete legacy.entry_economics;delete legacy.entry_context;
 s.frequency.account.positions[legacy.id]={...p,plan:legacy,profit_protection:undefined,exit_intent:undefined};
 const d=JSON.parse(JSON.stringify(project(s))),positions=d.frequency.account.positions;
 assert.deepEqual(positions.find(x=>x.plan.id===p.plan.id).exit_intent,p.exit_intent);
 assert.equal(positions.find(x=>x.plan.id===legacy.id).plan.exit_policy,undefined);assert.equal(positions.find(x=>x.plan.id===legacy.id).profit_protection,undefined);
});
test('four persisted positions count four, one close leaves exactly the other three IDs',()=>{
 const s=fixture(),first=s.frequency.account.positions['isolated-a'];
 for(const id of ['isolated-b','isolated-c','isolated-d'])s.frequency.account.positions[id]={...structuredClone(first),plan:plan(id),profit_protection:protection('OPEN_BEFORE_TARGET')};
 assert.equal(project(s).frequency.account.position_count,4);
 delete s.frequency.account.positions['isolated-a'];s.frequency.history.unshift({id:'isolated-a',type:'CLOSED',reason:'TRAILING_RETRACEMENT',at:NOW,pnl:'0.57'});
 const d=project(s);assert.equal(d.frequency.account.position_count,3);assert.deepEqual(d.frequency.account.open_position_ids,['isolated-b','isolated-c','isolated-d']);assert.equal(d.secondary_activity.orders.open_positions,3);
 for(const p of d.frequency.account.positions)assert.equal(p.profit_protection.state,'OPEN_BEFORE_TARGET');
});
test('economic rejects preserve pattern detection and the true evaluation time',()=>{
 const s=fixture(),at=NOW-15000;s.secondaryExecution.decisions.PULLBACK={pattern:'PULLBACK',at,cutoff:NOW-20000,reason:'EXPECTED_NET_TARGET_BELOW_MINIMUM',criteria:{pattern_detected:true,entry_economics:{...plan().entry_economics,expected_net_target:'0.01677',passes:false}}};
 const p=project(s).secondary_activity.patterns.find(p=>p.pattern==='PULLBACK');assert.equal(p.last_evaluation_at,at);assert.equal(p.criteria.pattern_detected,true);assert.equal(p.criteria.entry_economics.expected_net_target,'0.01677');assert.match(p.reason_text,/Patrón detectado[\s\S]*mínimo útil/);
 assert.match(reasonText('ENTRY_ECONOMICS_CHANGED_BEFORE_FILL'),/latencia[\s\S]*no se ejecuta/);
});
test('Telegram activation is a per-position notice, distinguishes trigger from guaranteed profit, and preserves small-net precision',()=>{
 const p=plan(),payload={id:p.id,plan:p,profit_protection:protection()},text=secondaryMessage({kind:'SECONDARY_TRAILING',payload});
 assert.match(text,/OBJETIVO ALCANZADO: DEJANDO CORRER/);assert.match(text,/0\.800000 USD/);assert.match(text,/Umbral neto de cierre: 0\.600000/);assert.match(text,/25 %/);assert.match(text,/no la liquida automáticamente/);assert.match(text,/otras posiciones conservan/);assert.doesNotMatch(text,/POSICIÓN_CERRADA/);
 p.entry_economics.expected_net_target='0.01677';const selected=secondaryMessage({kind:'SECONDARY_SELECTED',payload:{id:p.id,plan:p}});assert.match(selected,/0\.016770 USD/);assert.match(selected,/mínimo experimental: 0\.200000 USD/);
 const close=secondaryMessage({kind:'SECONDARY_CLOSE',payload:{...payload,direction:'SHORT',reason:'TRAILING_RETRACEMENT',entry:'100',price:'99.43',pnl:'0.57',fees:'0.1',quality:'OBSERVED',result_final:false}});assert.match(close,/retroceso del beneficio neto/);assert.match(close,/Resultado neto provisional/);
});
test('new activation kinds reuse the claimed verified outbox and send no second message on another drain',async()=>{
 for(const kind of ['SECONDARY_TRAILING','SECONDARY_PROFIT_POLICY']){
  let calls=0;const item={id:'isolated-'+kind,kind,status:'QUEUED',payload:{id:'isolated-a',plan:plan(),profit_protection:protection(),policy:POLICY,profile_version:POLICY.version}};
  const store={async queued(){return item.status==='QUEUED'?[item]:[];},async tx(command){if(command.phase==='CLAIM'){Object.assign(item,{status:'DISPATCHING',claim_id:command.claim_id});return {...item};}Object.assign(item,command);return {...item};}};
  const transport={async call(method,body){assert.equal(method,'sendMessage');assert.equal(body.chat_id,'123');assert(body.text.length<4000);calls++;return {message_id:11,chat:{id:123},date:1};}};
  const notifier=new SecondaryNotifier({store,transport,env:{LUMI_TRADING_STORAGE:'SQLITE',LUMI_TRADING_OWNER_ID:'123',LUMI_TELEGRAM_REVIEW_TEST_USERS:'123'},feed:{state:{},metadata:{}},pending:()=>false});notifier.identityAt=Date.now();
  await notifier.drain();await notifier.drain();assert.equal(calls,1);assert.equal(item.status,'DELIVERED');assert.equal(item.receipt.read_confirmed,false);
 }
});
test('Telegram partials and cancellations show the post-latency quantity receipt instead of the full signal economics',()=>{
 const p=plan(),receipt={...p.entry_economics,stage:'PRE_EXECUTION',quantity:'0.4',effective_exposure:'40',expected_net_target:'0.32',expected_loss_stop:'0.85',minimum_expected_net_target:'0.08'},payload={id:p.id,plan:p,price:'100',qty:'0.4',cumulative_qty:'0.4',remaining_qty:'0.6',fee:'0.02',entry_revalidation:receipt};
 const partial=secondaryMessage({kind:'SECONDARY_PARTIAL',payload});assert.match(partial,/Economía revalidada para 0\.4 BTC/);assert.match(partial,/nominal efectivo 40\.00 USD/);assert.match(partial,/0\.080000 USD/);assert.doesNotMatch(partial,/nominal efectivo 100\.00 USD/);
 const open=secondaryMessage({kind:'SECONDARY_OPEN',payload});assert.match(open,/Exposición revalidada para la ejecución: 40\.00 USD/);assert.match(open,/objetivo neto estimado: 0\.320000 USD/);
 const cancelled=secondaryMessage({kind:'SECONDARY_UNFILLED',payload:{...payload,reason:'PRE_EXECUTION_EXPECTED_NET_TARGET_BELOW_MINIMUM',entry_revalidation:{...receipt,expected_net_target:'0.01677'}}});assert.match(cancelled,/posterior a la latencia/);assert.match(cancelled,/0\.016770 USD/);assert.match(cancelled,/no es una pérdida/);
});
test('policy activation notice is committed by policy hash and is not requeued after restart',()=>{
 const s=fixture();delete s.secondaryExecution.profit_policy;s.frequency.account.positions={};
 const env={LUMI_TRADING_SECONDARY_EXECUTION:SECONDARY_VERSION,LUMI_TRADING_SECONDARY_PROFILE:EXPLORATION_VERSION,LUMI_TRADING_SECONDARY_PROFIT_POLICY:POLICY.version,LUMI_TRADING_MODE:'PAPER',LUMI_RUNTIME_ENV:'staging',LUMI_TRADING_STORAGE:'SQLITE'},notices=[];
 const makeEngine=state=>({state,event(){},notice:(...args)=>notices.push(args),frequency:{},laboratory:{},learning:{track(){}},tick:async()=>{},acceptDelivery(){},lastLease:Date.now()});
 const own=Object.hasOwn(OperationalSecondary.prototype,'start'),start=OperationalSecondary.prototype.start;OperationalSecondary.prototype.start=function(){};
 try{
  installOperational(makeEngine(s),env);const saved=JSON.parse(JSON.stringify(s));
  assert.equal(saved.secondaryExecution.profit_policy_status_notice_queued,saved.secondaryExecution.profit_policy.policy_hash);
  installOperational(makeEngine(saved),env);assert.equal(notices.filter(([kind])=>kind==='SECONDARY_PROFIT_POLICY').length,1);
  assert.equal(saved.laboratory.trials[0].status,'REJECTED');assert.equal(saved.secondaryExecution.profit_policy.active,true);
 }finally{if(own)OperationalSecondary.prototype.start=start;else delete OperationalSecondary.prototype.start;}
});
