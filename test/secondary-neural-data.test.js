// Synthetic fixtures only. Never accesses the operational portfolio or network.
import test from 'node:test';
import assert from 'node:assert/strict';
import {D,hash} from '../lib/trading/core.js';
import {entryCandidates} from '../lib/trading/secondary-entry-context.js';
import {EXPLORATION_POLICY,EXPLORATION_VERSION,installExploration} from '../lib/trading/secondary-exploration.js';
import {PROFIT_POLICY,PROFIT_POLICY_VERSION,installProfitPolicy} from '../lib/trading/secondary-profit-policy.js';
import {SecondaryBroker} from '../lib/trading/secondary-futures-engine.js';
import {newAccount} from '../lib/trading/simulator.js';
import {enablePortfolio} from '../lib/trading/portfolio.js';
import {captureSecondaryNeuralSignal,validateSecondaryNeuralSnapshot,buildSecondaryNeuralLabel,NEURAL_FEATURE_VERSION,NEURAL_FEATURE_NAMES,NEURAL_FEATURE_SCHEMA_HASH,NEURAL_DATA_LIMITS} from '../lib/trading/secondary-neural-data.js';

const C=Date.parse('2026-11-02T02:00:00Z'),T=C+2000,H=Math.floor(T/3600000)*3600000;
const ENV={LUMI_RUNTIME_ENV:'staging',LUMI_TRADING_MODE:'PAPER',LUMI_TRADING_STORAGE:'SQLITE',LUMI_TRADING_SECONDARY_PROFILE:EXPLORATION_VERSION,LUMI_TRADING_SECONDARY_PROFIT_POLICY:PROFIT_POLICY_VERSION};
const META={symbol:'PF_XBTUSD',qty_step:.0001,tick_size:.01,checked_at:T};
const quote=(at=T,bid=200.8,size=100)=>({source:'KRAKEN_FUTURES_WS_TICKER',symbol:'PF_XBTUSD',event_at:at,received_at:at,bid:D(bid).toString(),ask:D(bid).plus('.01').toString(),bid_qty:String(size),ask_qty:String(size),suspended:false});
const bars=(tf,fn)=>Array.from({length:96},(_,i)=>({start:C-(96-i)*tf*60000,end:C-(95-i)*tf*60000,volume:1,...fn(i)}));
const invert=series=>Object.fromEntries(Object.entries(series).map(([tf,rows])=>[tf,rows.map(row=>({...row,open:400-row.open,close:400-row.close,high:400-row.low,low:400-row.high}))]));
function fixture(pattern='BREAKOUT',direction='LONG',funding=0){
 let series,bid;
 if(pattern==='BREAKOUT'){series={5:bars(5,()=>({open:199.9,high:200.2,low:199.7,close:199.9})),15:bars(15,()=>({open:199.9,high:200.2,low:199.7,close:199.9}))};Object.assign(series[5].at(-1),{open:199.9,high:200.9,low:199.9,close:200.8,volume:2});bid=200.8;}
 else if(pattern==='PULLBACK'){const fn=i=>({open:190+i*.1-.01,close:190+i*.1,low:190+i*.1-.03,high:190+i*.1+.06});series={5:bars(5,fn),15:bars(15,fn)};series[5].at(-5).high=202;Object.assign(series[5].at(-1),{open:199.45,close:199.6,low:198.8,high:199.65});bid=199.6;}
 else{series={5:bars(5,i=>{const p=i%2?201:199;return {open:p,close:p,low:p-.1,high:p+.1};}),15:bars(15,()=>({open:200,close:200,low:199.9,high:200.1}))};Object.assign(series[5].at(-1),{open:198.2,close:198.3,low:197.7,high:198.5});bid=198.3;}
 if(direction==='SHORT'){series=invert(series);bid=400-bid-.01;}
 const q=quote(T,bid),decision=entryCandidates(series,q,META,C,T,funding,EXPLORATION_POLICY,PROFIT_POLICY).find(row=>row.pattern===pattern);assert(decision.plan,JSON.stringify(decision));
 const args={decision,series,quote:q,meta:META,existing:{positions:[],pendingOrders:[]},cutoff:C,now:T,explorationPolicy:EXPLORATION_POLICY,profitPolicy:PROFIT_POLICY};
 return {args,decision,plan:decision.plan,series,q,bid,snapshot:captureSecondaryNeuralSignal(args)};
}
const value=(snapshot,name)=>snapshot.x[NEURAL_FEATURE_NAMES.indexOf(name)];
const near=(a,b)=>assert(D(a).minus(b).abs().lte('0.000000000001'),`${a} != ${b}`);
function closedFixture({net='.5',funding='0',qty='.3',quality='OBSERVED'}={}){
 const f=fixture(),entry=f.plan.entry,fees='.1',entered=T+1100,at=T+60000;
 const closed={type:'CLOSED',id:f.plan.id,plan:structuredClone(f.plan),at,entered_at:entered,entry,qty,remaining_qty:'0',pnl:net,gross:D(net).plus(fees).toString(),fees,funding,quality,reason:'TRAILING_RETRACEMENT',ledger:'FREQUENT_PAPER',realTrading:false,management_override:false,result_final:true,funding_complete:true,data_gaps:[],excursions:{max_adverse_net:'-.2',max_favourable_net:'.8'},entry_fills:[{id:'isolated-fill-1',at:entered,qty,price:entry,fee:D(entry).mul(qty).mul('.0005').toString()}]};
 return {...f,closed};
}

test('33 ordered futures features and schema fingerprint are fixed',()=>{
 assert.equal(NEURAL_FEATURE_NAMES.length,33);assert.equal(new Set(NEURAL_FEATURE_NAMES).size,33);assert(Object.isFrozen(NEURAL_FEATURE_NAMES));assert.equal(NEURAL_FEATURE_SCHEMA_HASH,hash({version:NEURAL_FEATURE_VERSION,names:NEURAL_FEATURE_NAMES}));
});
for(const pattern of ['BREAKOUT','PULLBACK','RANGE_REENTRY'])for(const direction of ['LONG','SHORT'])test(pattern+' '+direction+' captures causal futures features before selection',()=>{
 const {snapshot,plan}=fixture(pattern,direction);assert.equal(snapshot.exclusion,null);assert.equal(validateSecondaryNeuralSnapshot(snapshot),snapshot);assert.equal(snapshot.x.length,33);assert.equal(value(snapshot,'direction'),direction==='SHORT'?-1:1);assert(value(snapshot,'candle_signed_body_fraction')>0);assert(value(snapshot,'stop_distance_fraction')>0);assert(value(snapshot,'target_distance_fraction')>0);assert.equal(value(snapshot,'entry_fee_fraction'),.0005);assert.equal(value(snapshot,'exit_fee_fraction'),.0005);assert.notEqual(value(snapshot,'entry_fee_fraction'),.008);assert.equal(plan.atr1,undefined);assert.equal(snapshot.domain.exit_policy_version,'secondary-net-trailing-1.0.0');assert.equal(snapshot.provenance.bar_availability,'OBSERVED_IN_MEMORY_AT_CAPTURE');
});
test('snapshot does not mutate the plan or open contracts; post-decision and future fields cannot leak into inputs',()=>{
 const f=fixture(),before=structuredClone(f.args),snapshot=f.snapshot;
 Object.assign(f.decision.facts,{final_pnl:999,peak_net:999,closed_at:T+999999});
 for(const tf of [5,15]){
  f.series[tf].push({...f.series[tf].at(-1),start:C,end:C+tf*60000,close:99999,high:99999});
  f.series[tf].push({...f.series[tf].at(-2),available_at:T+1000,close:99999,high:99999});
 }
 const result=captureSecondaryNeuralSignal(f.args);assert.deepEqual(result,snapshot);assert.deepEqual(f.plan,before.decision.plan);assert.deepEqual(f.args.existing,before.existing);assert.equal(JSON.stringify(result).includes('final_pnl'),false);
 const tampered=structuredClone(result);tampered.x[4]+=1;assert.throws(()=>validateSecondaryNeuralSnapshot(tampered),/HASH/);
});
test('a detected economic rejection keeps its negative margin vector without any order or false label',()=>{
 const f=fixture('BREAKOUT','LONG',100);assert(f.plan.economics.gain<0);assert.equal(f.snapshot.exclusion,null);assert(value(f.snapshot,'expected_net_target_fraction')<0);assert(value(f.snapshot,'expected_funding_fraction')>0);
 assert.equal(buildSecondaryNeuralLabel({snapshot:f.snapshot,closed:{type:'NOT_FILLED',id:f.plan.id}}),null);
 assert.equal(buildSecondaryNeuralLabel({snapshot:f.snapshot,closed:{type:'SECONDARY_ENTRY_REJECTED',id:f.plan.id}}),null);
});
test('detected structural rejection without a plan retains a stable causal signal and signed direction',()=>{
 const f=fixture();const facts={...f.decision.facts,target:190,entry:201,stop:199,gain:-12,loss:3,pattern_detected:true};
 const decision={pattern:'BREAKOUT',direction:'LONG',reason:'STRUCTURAL_TARGET_ALREADY_PASSED',facts};
 const snapshot=captureSecondaryNeuralSignal({...f.args,decision});assert.equal(snapshot.exclusion,null);assert.equal(snapshot.operation_id,null);assert(value(snapshot,'target_distance_fraction')<0);assert.equal(snapshot.signal_id,captureSecondaryNeuralSignal({...f.args,decision}).signal_id);
 delete decision.direction;assert.equal(captureSecondaryNeuralSignal({...f.args,decision}).exclusion,'NEURAL_DIRECTION_UNAVAILABLE');
});
test('absence of a pattern is explicitly unlabelled, not encoded as a losing example',()=>{
 const f=fixture(),snapshot=captureSecondaryNeuralSignal({...f.args,decision:{pattern:'BREAKOUT',reason:'WAIT_BREAKOUT',facts:{entry_revision:f.plan.entry_revision}}});assert.equal(snapshot.x,null);assert.equal(snapshot.exclusion,'NO_DETECTED_SIGNAL');assert.equal(snapshot.detected,false);
});
test('prior position context separates actual positions and order remainders without changing either',()=>{
 const f=fixture(),same={...structuredClone(f.plan),id:'old-same'},opposite={...structuredClone(f.plan),id:'old-opposite',direction:'SHORT'};
 const existing={positions:[{plan:same,qty:'.2',entry:'200'},{plan:opposite,qty:'.1',entry:'200'}],pendingOrders:[{plan:same,remaining_qty:'.1'}]},before=structuredClone(existing);
 const snapshot=captureSecondaryNeuralSignal({...f.args,existing});assert.equal(snapshot.exclusion,null);assert.equal(value(snapshot,'open_position_count'),2);assert.equal(value(snapshot,'pending_order_count'),1);assert.equal(value(snapshot,'shared_target_count'),2);assert.equal(value(snapshot,'same_confirmation_count'),2);near(value(snapshot,'same_direction_exposure_nominals'),D(40).plus(D(f.plan.entry).mul('.1')).div(100));assert.deepEqual(existing,before);
});
test('missing prior context or immutable historical photo is excluded rather than filled with zeros',()=>{
 const f=fixture();assert.equal(captureSecondaryNeuralSignal({...f.args,existing:undefined}).exclusion,'NO_PRE_ENTRY_POSITION_CONTEXT');assert.equal(captureSecondaryNeuralSignal({...f.args,provenance:'RECONSTRUCTED_FROM_LATER_MARKET'}).exclusion,'NO_IMMUTABLE_PRE_ENTRY_SNAPSHOT');
 const old=closedFixture();assert.equal(buildSecondaryNeuralLabel({closed:old.closed}).exclusion,'NO_PRE_ENTRY_SNAPSHOT');
 const signed={...f.plan,hash:hash(f.plan)};assert.equal(captureSecondaryNeuralSignal({...f.args,decision:{...f.decision,plan:signed}}).exclusion,'CAPTURE_NOT_PRE_SELECTION');
});
test('market staleness, NaN, ahead timestamps and bounded inputs do not fabricate a usable vector',()=>{
 const f=fixture();assert.equal(captureSecondaryNeuralSignal({...f.args,quote:{...f.q,event_at:T-5001}}).exclusion,'NEURAL_EXECUTABLE_QUOTE_UNAVAILABLE');assert.equal(captureSecondaryNeuralSignal({...f.args,quote:{...f.q,event_at:T+1}}).x,null);
 assert.equal(captureSecondaryNeuralSignal({...f.args,decision:{...f.decision,facts:{...f.decision.facts,atr5:NaN}}}).exclusion,'NEURAL_PRE_ENTRY_VALUES_INCOMPLETE');
 assert.equal(captureSecondaryNeuralSignal({...f.args,series:{...f.series,5:Array(NEURAL_DATA_LIMITS.barsPerFrame+1).fill(f.series[5][0])}}).exclusion,'NEURAL_BAR_INPUT_LIMIT_OR_MISSING');
 assert.equal(captureSecondaryNeuralSignal({...f.args,existing:Array(NEURAL_DATA_LIMITS.contextRows+1).fill({})}).exclusion,'NEURAL_POSITION_CONTEXT_LIMIT');
});
test('all data entry points reject real mode explicitly',()=>{
 const f=fixture();assert.throws(()=>captureSecondaryNeuralSignal({...f.args,mode:'REAL'}),/PAPER_ONLY/);assert.throws(()=>captureSecondaryNeuralSignal({...f.args,realTrading:true}),/PAPER_ONLY/);assert.throws(()=>validateSecondaryNeuralSnapshot({...f.snapshot,mode:'REAL'}),/PAPER_ONLY/);assert.throws(()=>buildSecondaryNeuralLabel({mode:'REAL',closed:closedFixture().closed}),/PAPER_ONLY/);
 assert.throws(()=>captureSecondaryNeuralSignal({...f.args,decision:{...f.decision,plan:{...f.plan,mode:'REAL'}}}),/PAPER_ONLY/);assert.throws(()=>buildSecondaryNeuralLabel({closed:{...closedFixture().closed,mode:'REAL'}}),/PAPER_ONLY/);
});

for(const net of ['.01677','-.5','0'])test('continuous label uses actual executed exposure for net '+net,()=>{
 const f=closedFixture({net}),label=buildSecondaryNeuralLabel(f);assert.equal(label.status,'MATURE');assert.equal(label.funding_final,true);near(label.exposure,D(f.plan.entry).mul('.3'));near(label.net_return,D(net).div(label.exposure));assert.equal(label.net,D(net).toString());assert.equal(label.label_revision,1);assert.equal(label.exit_policy_version,'secondary-net-trailing-1.0.0');near(label.adverse_return,D('-.2').div(label.exposure));
 assert.deepEqual(buildSecondaryNeuralLabel({...f,previous:label}),label,'retry is exactly the same label rather than another sample');
});
test('partial entry IDs deduplicate and CLOSED aggregate is not augmented by earlier partial profits',()=>{
 const f=closedFixture(),entryEvents=[{type:'FILLED',id:f.plan.id,fill_id:'first',at:f.closed.entered_at,qty:'.1',price:'200',fee:'.01'},{type:'PARTIAL_FILL',id:f.plan.id,fill_id:'second',at:f.closed.entered_at+1,qty:'.2',price:'201',fee:'.0201'}];entryEvents.push(structuredClone(entryEvents[0]));
 const exits=[{type:'PARTIAL_CLOSE',id:f.plan.id,fill_id:'out1',at:f.closed.at-1000,pnl:'.2',management_override:false,reason:'TRAILING_RETRACEMENT',data_gaps:[]}];
 const label=buildSecondaryNeuralLabel({...f,entryEvents,exitEvents:exits});assert.equal(label.status,'MATURE');assert.equal(label.entry_fill_count,2);assert.equal(label.exposure,'60.2');assert.equal(label.net,'0.5');near(label.net_return,D('.5').div('60.2'));
 const duplicate=structuredClone(entryEvents[0]);duplicate.qty='.2';assert.equal(buildSecondaryNeuralLabel({...f,entryEvents:[...entryEvents,duplicate]}).exclusion,'NEURAL_EXECUTION_ID_CONFLICT');
});
test('incomplete fill history and unresolved quantity cannot supply a guessed denominator',()=>{
 const f=closedFixture();f.closed.entry_fills[0].qty='.1';assert.equal(buildSecondaryNeuralLabel(f).exclusion,'ENTRY_QUANTITY_NOT_RECONCILED');f.closed.entry_fills=[];assert.equal(buildSecondaryNeuralLabel(f).exclusion,'ENTRY_EXECUTIONS_INCOMPLETE');
 const good=closedFixture();assert.equal(buildSecondaryNeuralLabel({...good,entryEvents:Array(NEURAL_DATA_LIMITS.fillEvents+1).fill({})}).exclusion,'NEURAL_LABEL_EVENT_LIMIT');
});
test('complete versus partial entry is explicit for comparable admission cohorts',()=>{
 const f=closedFixture();f.closed.plan.sizing={qty:'.5'};const partial=buildSecondaryNeuralLabel(f);assert.equal(partial.status,'MATURE');assert.equal(partial.full_fill,false);assert.equal(partial.planned_quantity,'0.5');assert.equal(partial.executed_quantity,'0.3');
 f.closed.plan.sizing.qty='.3';const complete=buildSecondaryNeuralLabel(f);assert.equal(complete.full_fill,true);assert.equal(complete.net_return,partial.net_return);
});
test('funding matures one operation and corrections version its label rather than duplicating profit',()=>{
 const f=closedFixture({quality:'FUNDING_GAP'});Object.assign(f.closed,{result_final:false,funding_complete:false});
 const pending=buildSecondaryNeuralLabel(f);assert.equal(pending.status,'PENDING');assert.equal(pending.net_return,null);
 const correction={type:'FUNDING_RECONCILED',event_id:'funding-1',id:f.plan.id,at:f.closed.at+1000,amount:'.1',net_adjustment:'-.1',net_after:'.4',funding_complete:true,result_quality:'RECONSTRUCTED_FUNDING'};
 const label=buildSecondaryNeuralLabel({...f,previous:pending,fundingEvents:[correction,structuredClone(correction)]});assert.equal(label.status,'MATURE');assert.equal(label.label_revision,2);assert.equal(label.net,'0.4');assert.equal(label.costs,'0.2');assert.equal(label.quality,'OBSERVED_PRICE_RECONCILED_FUNDING');assert.equal(label.mature_at,correction.at);assert.equal(label.supersedes_label_hash,pending.label_hash);
 assert.deepEqual(buildSecondaryNeuralLabel({...f,previous:label,fundingEvents:[correction]}),label);
 const second={...correction,event_id:'funding-2',at:correction.at+1000,amount:'.05',net_adjustment:'-.05',net_after:'.35'};
 const revised=buildSecondaryNeuralLabel({...f,previous:label,fundingEvents:[correction,second]});assert.equal(revised.label_revision,3);assert.equal(revised.net,'0.35');assert.equal(revised.costs,'0.25');assert.equal(revised.operation_id,label.operation_id);
 const included={...correction,event_id:'earlier-open',at:f.closed.at-1000,position_open:true,amount:'123',net_after:'999'};assert.deepEqual(buildSecondaryNeuralLabel({...f,previous:label,fundingEvents:[included,correction]}),label);
 const compact={...correction};delete compact.event_id;delete compact.result_quality;assert.deepEqual(buildSecondaryNeuralLabel({...f,previous:label,fundingEvents:[compact]}),label,'optional source-event wrapper metadata cannot revise the economic label');
});
test('a conflicting funding revision remains excluded, while pure financing recovery can mature',()=>{
 const f=closedFixture({quality:'FUNDING_GAP'}),valid=buildSecondaryNeuralLabel(f);assert.equal(valid.status,'MATURE');assert.equal(valid.quality,'OBSERVED_PRICE_RECONCILED_FUNDING');
 const correction={type:'FUNDING_RECONCILED',id:f.plan.id,at:f.closed.at+1000,amount:'.1',net_adjustment:'-.1',net_after:'999',funding_complete:true};assert.equal(buildSecondaryNeuralLabel({...f,fundingEvents:[correction]}).exclusion,'FUNDING_REVISION_NOT_RECONCILED');
});
test('market gaps and manual partials remain excluded even when final PnL is positive',()=>{
 const f=closedFixture();f.closed.data_gaps=[{from:T+2000,to:T+3000,status:'UNRESOLVED_PRICE_PATH'}];assert.equal(buildSecondaryNeuralLabel(f).exclusion,'INCOMPLETE_MARKET_DATA');f.closed.data_gaps=[];
 const manual={type:'PARTIAL_CLOSE',id:f.plan.id,fill_id:'manual-fragment',at:f.closed.at-1000,reason:'MANUAL_CLOSE',management_override:true};assert.equal(buildSecondaryNeuralLabel({...f,exitEvents:[manual]}).exclusion,'MANUAL_OR_MANAGEMENT_OVERRIDE');
 f.closed.management_override=undefined;assert.equal(buildSecondaryNeuralLabel(f).exclusion,'MANAGEMENT_EVIDENCE_UNAVAILABLE');
});
test('15m, 1h and 4h closes cannot silently enter the 5m neural training domain',()=>{
 for(const timeframe of [15,60,240]){
  const f=closedFixture();f.closed.plan.timeframe=timeframe;
  const label=buildSecondaryNeuralLabel(f);
  assert.equal(label.status,'EXCLUDED');assert.equal(label.exclusion,'TIMEFRAME_NOT_IN_NEURAL_DOMAIN');
  assert.equal(label.net_return,null);
 }
});
test('exit versions, chronology, balances and topups cannot become a label shortcut',()=>{
 const f=closedFixture(),before=structuredClone(f);f.closed.plan.exit_policy={...f.closed.plan.exit_policy,version:'LEGACY_FIXED_EXIT'};assert.equal(buildSecondaryNeuralLabel(f).exclusion,'ENTRY_OR_EXIT_CONTRACT_MISMATCH');
 f.closed=before.closed;f.closed.entered_at=T-1;assert.equal(buildSecondaryNeuralLabel(f).exclusion,'INVALID_LABEL_CHRONOLOGY');f.closed=before.closed;f.closed.entered_at=T+1100;
 const normal=buildSecondaryNeuralLabel(f),noise={type:'PAPER_CAPITAL_TOPUP',id:f.plan.id,at:T+5000,amount:'1000000',net_after:'1000000'};assert.deepEqual(buildSecondaryNeuralLabel({...f,fundingEvents:[noise],exitEvents:[noise]}),normal);assert.equal(buildSecondaryNeuralLabel({closed:noise}),null);
});
test('one new-engine signal retains its pre-entry vector, closes with observed evidence and produces one mature label',()=>{
 const f=fixture(),a=newAccount();enablePortfolio(a);Object.assign(a,{cash:'500',equity:'500',peak:'500'});let now=T;
 const root={frequency:{account:a,counts:{evaluations:0,candidates:0,selected:0,filled:0,closed:0,notFilled:0},history:[],grossClosed:'0',closedFees:'0'},laboratory:{status:'RESEARCH_COMPLETE',trials:[{status:'REJECTED'}],funding:{initial:'500',added:'0'}}};
 const events=[],b=new SecondaryBroker({root,now:()=>now,event:event=>events.push(structuredClone(event))});installExploration(root,ENV,T);installProfitPolicy(root,ENV,T);const snapshot=captureSecondaryNeuralSignal({...f.args,existing:{positions:a.positions,pendingOrders:a.pendingOrders}}),saved=structuredClone(snapshot);
 assert.equal(b.choose(f.plan,f.q,META,T),'ENTRY_PENDING');now=T+1100;b.market(quote(now,f.bid),null,{[H]:0},now);assert(a.positions[f.plan.id]);
 const target=Number(f.plan.target);now=T+2200;b.market(quote(now,target),null,{[H]:0},now);assert.equal(a.positions[f.plan.id].profit_protection.state,'TRAILING_ACTIVE');now=T+3300;b.market(quote(now,target+1),null,{[H]:0},now);now=T+4400;b.market(quote(now,target),null,{[H]:0},now);now=T+5500;b.market(quote(now,target),null,{[H]:0},now);
 const closed=events.find(event=>event.type==='CLOSED');assert(closed);const label=buildSecondaryNeuralLabel({snapshot,closed,entryEvents:events,exitEvents:events,fundingEvents:events});assert.equal(label.status,'MATURE',JSON.stringify(label));assert.deepEqual(snapshot,saved);assert.deepEqual(buildSecondaryNeuralLabel({snapshot,closed,entryEvents:events,exitEvents:events,fundingEvents:events,previous:label}),label);assert.equal(events.filter(event=>event.type==='CLOSED').length,1);
 const persisted=JSON.parse(JSON.stringify({snapshot,label}));assert.equal(validateSecondaryNeuralSnapshot(persisted.snapshot).input_hash,snapshot.input_hash);assert.deepEqual(buildSecondaryNeuralLabel({snapshot:persisted.snapshot,closed,entryEvents:events,exitEvents:events,fundingEvents:events,previous:persisted.label}),label);
});

test('new pyramid snapshots group by signed movement identity while old context and hashes remain unchanged',()=>{
 const f=fixture(),legacy=captureSecondaryNeuralSignal(f.args);assert.equal(legacy.context.movement_key,f.plan.entry_context.movement_key);
 const movement=hash(['ISOLATED_SIGNED_MOVEMENT']),first={...structuredClone(f.plan),movement_id:movement,parent_id:null,leg_index:0},second={...structuredClone(f.plan),id:'second-causal-leg',movement_id:movement,parent_id:f.plan.id,leg_index:1,entry_context:{...f.plan.entry_context,movement_key:'different-pattern-structure',confirmation_key:'new-confirmation'}};
 const a=captureSecondaryNeuralSignal({...f.args,decision:{...f.decision,plan:first}}),b=captureSecondaryNeuralSignal({...f.args,decision:{...f.decision,plan:second}});
 assert.equal(a.exclusion,null);assert.equal(b.exclusion,null);assert.equal(a.context.movement_key,movement);assert.equal(b.context.movement_key,movement);assert.equal(a.domain.execution_policy_hash,legacy.domain.execution_policy_hash);assert.equal(a.domain.economic_policy_hash,legacy.domain.economic_policy_hash);assert.equal(a.domain.exit_policy_hash,legacy.domain.exit_policy_hash);assert.notEqual(a.snapshot_hash,legacy.snapshot_hash);assert.equal(validateSecondaryNeuralSnapshot(a),a);assert.equal(validateSecondaryNeuralSnapshot(b),b);assert.equal(f.plan.movement_id,undefined);
});
