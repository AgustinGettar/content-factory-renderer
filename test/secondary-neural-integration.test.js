// Synthetic market streams and temporary SQLite only. No exchange or live ledger I/O.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {D,hash} from '../lib/trading/core.js';
import {newAccount} from '../lib/trading/simulator.js';
import {enablePortfolio} from '../lib/trading/portfolio.js';
import {OperationalSecondary,SecondaryBroker,secondaryEconomics,SECONDARY_MODEL,SECONDARY_VERSION} from '../lib/trading/secondary-futures.js';
import {entryCandidates} from '../lib/trading/secondary-entry-context.js';
import {EXPLORATION_VERSION,installExploration,getExplorationPolicy,explorationContract} from '../lib/trading/secondary-exploration.js';
import {PROFIT_POLICY_VERSION,PROFIT_ENTRY_REVISION,installProfitPolicy,getProfitPolicy,makeProfitContracts} from '../lib/trading/secondary-profit-policy.js';
import {installSecondaryNeural,SecondaryNeural,neuralView} from '../lib/trading/secondary-neural.js';
import {captureSecondaryNeuralSignal,NEURAL_FEATURE_NAMES,NEURAL_FEATURE_VERSION,NEURAL_FEATURE_SCHEMA_HASH} from '../lib/trading/secondary-neural-data.js';
import {NEURAL_ARTIFACT_VERSION,NEURAL_MODEL_VERSION} from '../lib/trading/secondary-neural-runtime.js';
import {initialState,TradingEngine} from '../lib/trading/engine.js';
import {KrakenFeed} from '../lib/trading/feed.js';
import {SQLiteStore} from '../lib/trading/sqlite-store.js';

const C=Date.parse('2026-11-02T02:00:00Z'),T=C+2000,H=Math.floor(T/3600000)*3600000;
const ENV={LUMI_RUNTIME_ENV:'staging',LUMI_TRADING_MODE:'PAPER',LUMI_TRADING_STORAGE:'SQLITE',LUMI_TRADING_SECONDARY_PROFILE:EXPLORATION_VERSION,LUMI_TRADING_SECONDARY_PROFIT_POLICY:PROFIT_POLICY_VERSION};
const META={symbol:'PF_XBTUSD',qty_step:.0001,tick_size:.01,checked_at:T};
const quote=(at=T,bid=200.8,size=100)=>({source:'KRAKEN_FUTURES_WS_TICKER',symbol:'PF_XBTUSD',event_at:at,received_at:at,bid:D(bid).toString(),ask:D(bid).plus('.01').toString(),bid_qty:String(size),ask_qty:String(size),suspended:false});
const bars=(tf,fn)=>Array.from({length:96},(_,i)=>({start:C-(96-i)*tf*60000,end:C-(95-i)*tf*60000,volume:1,...fn(i)}));
function marketFixture(pattern='BREAKOUT'){
 if(pattern==='BREAKOUT'){
  const series={5:bars(5,()=>({open:199.9,high:200.2,low:199.7,close:199.9})),15:bars(15,()=>({open:199.9,high:200.2,low:199.7,close:199.9}))};Object.assign(series[5].at(-1),{open:199.9,high:200.9,low:199.9,close:200.8,volume:2});return {series,bid:200.8};
 }
 if(pattern==='PULLBACK'){
  const fn=i=>({open:190+i*.1-.01,close:190+i*.1,low:190+i*.1-.03,high:190+i*.1+.06}),series={5:bars(5,fn),15:bars(15,fn)};series[5].at(-5).high=202;Object.assign(series[5].at(-1),{open:199.45,close:199.6,low:198.8,high:199.65});return {series,bid:199.6};
 }
 if(pattern==='RANGE_REENTRY'){
  const series={5:bars(5,i=>{const p=i%2?201:199;return {open:p,close:p,low:p-.1,high:p+.1};}),15:bars(15,()=>({open:200,close:200,low:199.9,high:200.1}))};Object.assign(series[5].at(-1),{open:198.2,close:198.3,low:197.7,high:198.5});return {series,bid:198.3};
 }
 return {series:{5:bars(5,()=>({open:200,high:200.1,low:199.9,close:200})),15:bars(15,()=>({open:200,high:200.1,low:199.9,close:200}))},bid:200};
}
function testArtifact(domain,id='nn_isolated_integration'){
 const n=NEURAL_FEATURE_NAMES.length,dims=[n,16,8,1];
 const p={version:NEURAL_MODEL_VERSION,model_id:id,feature_version:NEURAL_FEATURE_VERSION,feature_schema_hash:NEURAL_FEATURE_SCHEMA_HASH,feature_names:[...NEURAL_FEATURE_NAMES],domain,trained_at:T-30000,created_at:T-30000,expires_at:T+86400000,training_cutoff:T-40000,max_label_mature_at:T-50000,architecture:{input:n,hidden:[16,8],output:1,activation:'tanh',output_activation:'identity'},normalization:{mean:Array(n).fill(0),scale:Array(n).fill(1)},input_domain:{min:Array(n).fill(-1000000),max:Array(n).fill(1000000)},output_transform:{mean:0,scale:.01},layers:dims.slice(1).map((out,k)=>({weights:Array.from({length:dims[k]},()=>Array(out).fill(.01)),bias:Array(out).fill(0)})),validation:{status:'PROSPECTIVE',criteria_version:'secondary-neural-validation-1.0.0',assistance_authorized:false}};
 const payload_json=JSON.stringify(p);return JSON.stringify({version:NEURAL_ARTIFACT_VERSION,payload_json,sha256:hash(payload_json)});
}
const ordinary=e=>!String(e.type).startsWith('NEURAL_');
function fakeHarness({pattern='BREAKOUT',variant='BASE',cash='500'}={}){
 let now=C-500;const a=newAccount();enablePortfolio(a);Object.assign(a,{cash,equity:cash,peak:cash});
 const state={frequency:{account:a,counts:{evaluations:0,candidates:0,selected:0,filled:0,closed:0,notFilled:0},history:[],grossClosed:'0',closedFees:'0'},laboratory:{status:'RESEARCH_COMPLETE',trials:[{status:'REJECTED',net:'-25'}],funding:{initial:cash,added:'0',count:0}},research:{active:'primary',versions:{primary:{account:{cash:'100',equity:'100',net:'0'}}}}};
 const events=[],notices=[],engine={state,now:()=>now,event(e){if(variant==='CAPTURE_FAILURE'&&e.type==='NEURAL_SIGNAL_CAPTURED')throw Error('ISOLATED_CAPTURE_FAILURE');if(variant==='DATABASE_FAILURE'&&e.type==='NEURAL_SIGNAL_CAPTURED')throw Error('TRADING_EVENT_CONFLICT');events.push(structuredClone(e));},notice:(...args)=>notices.push(structuredClone(args))};
 const runtime=new OperationalSecondary({engine,now:()=>now,fetchImpl:()=>{throw Error('ISOLATED_NETWORK_FORBIDDEN');},socketFactory:()=>{throw Error('ISOLATED_NETWORK_FORBIDDEN');}}).initialize();
 installExploration(state,ENV,now,e=>engine.event(e));installProfitPolicy(state,ENV,now,e=>engine.event(e));
 const fixture=marketFixture(pattern);runtime.series=fixture.series;runtime.meta=META;runtime.rates={[H]:0};runtime.feedError=null;
 const env={...ENV,LUMI_TRADING_SECONDARY_NEURAL_MODE:['OFF','COLLECTING'].includes(variant)?variant:'ADVISORY'};
 if(variant==='CONSTRUCTOR_FAILURE'){
  const temporary={state:structuredClone(state),now:()=>now,event:()=>{},notice:()=>{}};new SecondaryNeural({engine:temporary,env,now:()=>now});state.secondaryNeural=structuredClone(temporary.state.secondaryNeural);Object.freeze(state.secondaryNeural.runtime);
 }
 const neural=variant==='BASE'?null:installSecondaryNeural(engine,env);
 if(neural?.runtime)neural.runtime.clock=()=>0; // deterministic equivalence; real timing has its own bounded-load test
 if(neural&&['ADVISORY','SLOW'].includes(variant)){
  const candidate=entryCandidates(fixture.series,quote(T,fixture.bid),META,C,T,0,getExplorationPolicy(state),getProfitPolicy(state)).find(d=>d.plan);
  if(candidate){const snapshot=captureSecondaryNeuralSignal({decision:candidate,series:fixture.series,quote:quote(T,fixture.bid),meta:META,existing:a,cutoff:C,now:T,explorationPolicy:getExplorationPolicy(state),profitPolicy:getProfitPolicy(state)});assert.equal(snapshot.exclusion,null);assert(neural.runtime.loadArtifactText(testArtifact(snapshot.domain)).ok);}
 }
 if(variant==='CORRUPT')neural.runtime.loadArtifactText('{');
 if(variant==='SLOW'){let clock=0;neural.runtime.clock=()=>clock+=10;}
 if(variant==='INFERENCE_EXCEPTION')neural.runtime.prioritize=()=>{throw Error('NEURAL_ISOLATED_INFERENCE_EXCEPTION');};
 const tick=(at,bid=fixture.bid,size=100)=>{now=at;runtime.quote=quote(at,bid,size);runtime.tick();};
 return {engine,runtime,neural,events,notices,fixture,tick,time(at){now=at;},get now(){return now;}};
}
function runFlow(options={}){
 const h=fakeHarness(options),primary=structuredClone(h.engine.state.research);h.tick(T);const selected=h.events.filter(e=>e.type==='SELECTED');assert(selected.length>0);h.tick(T+1100);
 const positions=Object.values(h.engine.state.frequency.account.positions);assert(positions.length>0);const position=positions.find(p=>p.plan.pattern===(options.pattern??'BREAKOUT'))??positions[0],id=position.plan.id,target=Number(position.plan.target);
 h.tick(T+2200,target);assert.equal(position.profit_protection.state,'TRAILING_ACTIVE');h.tick(T+3300,target+1);h.tick(T+4400,target);assert(position.exit_intent);h.tick(T+5500,target);assert(!h.engine.state.frequency.account.positions[id]);assert.deepEqual(h.engine.state.research,primary);
 return {...h,id,operational:{account:structuredClone(h.engine.state.frequency.account),execution:structuredClone(h.engine.state.secondaryExecution),events:h.events.filter(ordinary),notices:h.notices.filter(n=>n[0]!=='SECONDARY_NEURAL')}};
}

for(const pattern of ['BREAKOUT','PULLBACK','RANGE_REENTRY'])test(pattern+' full operational stream is identical in base/OFF/collecting/advisory and neural failure modes',()=>{
 const base=runFlow({pattern});
 for(const variant of ['OFF','COLLECTING','ADVISORY','CORRUPT','SLOW','INFERENCE_EXCEPTION','CAPTURE_FAILURE','CONSTRUCTOR_FAILURE']){
  const h=runFlow({pattern,variant});assert.deepEqual(h.operational,base.operational,pattern+': '+variant);
  for(const event of h.events.filter(e=>e.plan)){
   const plan=event.plan;if(plan.hash)assert.equal(plan.hash,hash({...plan,hash:undefined}));
   assert.equal(Object.keys(plan).some(key=>key.toLowerCase().includes('neural')),false);
  }
  if(variant==='ADVISORY'){assert(h.events.some(e=>e.type==='NEURAL_ENTRY_DECISION'&&e.decision.prediction.status==='PREDICTED'));assert.equal(h.engine.state.secondaryNeural.counts.usable,1);}
  if(variant==='SLOW')assert(h.engine.state.secondaryNeural.runtime.counts.slow>0);
  if(variant==='CONSTRUCTOR_FAILURE'){assert.equal(h.neural,null);assert.equal(h.engine.state.secondaryNeuralFault.effective_mode,'DEGRADED');assert.equal(neuralView(h.engine.state).mode,'DEGRADED');}
 }
});

test('no pattern creates no artificial operation or losing label in any optional mode',()=>{
 for(const variant of ['BASE','OFF','COLLECTING','ADVISORY','CORRUPT']){
  const h=fakeHarness({pattern:'NONE',variant});h.tick(T);h.tick(T+1100);assert.equal(h.events.filter(e=>['SELECTED','FILLED','CLOSED','NEURAL_LABEL_RECORDED'].includes(e.type)).length,0);assert.deepEqual(h.engine.state.frequency.account.positions,{});assert.equal(h.engine.state.frequency.account.cash,'500');
 }
});

test('actual capture precedes selection and one complete operation supplies one mature continuous label',()=>{
 const h=runFlow({variant:'ADVISORY'}),capture=h.events.find(e=>e.type==='NEURAL_SIGNAL_CAPTURED'&&e.snapshot.operation_id===h.id),decision=h.events.find(e=>e.type==='NEURAL_ENTRY_DECISION'&&e.decision.operation_id===h.id),selected=h.events.find(e=>e.type==='SELECTED'&&e.id===h.id),closed=h.events.find(e=>e.type==='CLOSED'&&e.id===h.id),labels=h.events.filter(e=>e.type==='NEURAL_LABEL_RECORDED'&&e.id===h.id);
 assert(capture&&decision&&selected&&closed);assert(h.events.indexOf(capture)<h.events.indexOf(selected));assert.equal(capture.snapshot.decision_at,selected.at);assert.equal(labels.length,1);assert.equal(labels[0].label.status,'MATURE');assert.equal(labels[0].label.exposure,D(closed.entry).mul(closed.qty).toString());assert.equal(labels[0].label.net_return,D(closed.pnl).div(labels[0].label.exposure).toString());assert(decision.decision.prediction.generated_at<=closed.entered_at);
 h.neural.observe(closed);h.neural.observe(closed);assert.equal(h.events.filter(e=>e.type==='NEURAL_LABEL_RECORDED'&&e.id===h.id).length,1);assert.equal(h.engine.state.secondaryNeural.counts.usable,1);
});

test('a database integrity error is not treated as an optional neural outage',()=>{
 const h=fakeHarness({variant:'DATABASE_FAILURE'});assert.throws(()=>h.tick(T),/TRADING_EVENT_CONFLICT/);assert.equal(h.events.some(e=>e.type==='SELECTED'),false);assert.deepEqual(h.engine.state.frequency.account.pendingOrders,{});
});

test('a successful reinstall clears the optional constructor fault and preserves its durable recovery history',()=>{
 const h=fakeHarness({variant:'CONSTRUCTOR_FAILURE'}),root=h.engine.state,fault=structuredClone(root.secondaryNeuralFault),account=structuredClone(root.frequency.account),primary=structuredClone(root.research),history=structuredClone(root.laboratory),started=root.secondaryNeural.started_at;
 assert.equal(neuralView(root).mode,'DEGRADED');root.secondaryNeural.runtime=structuredClone(root.secondaryNeural.runtime);
 const restored=installSecondaryNeural(h.engine,{...ENV,LUMI_TRADING_SECONDARY_NEURAL_MODE:'ADVISORY'});assert(restored?.runtime);assert.equal(root.secondaryNeuralFault,undefined);assert.equal(restored.view().mode,'COLLECTING');assert.equal(root.secondaryNeural.started_at,started);
 const recovery=h.events.find(e=>e.type==='NEURAL_COMPONENT_RECOVERED');assert.deepEqual(recovery.previous_failure,fault);assert.deepEqual(root.frequency.account,account);assert.deepEqual(root.research,primary);assert.deepEqual(root.laboratory,history);
 const incompatible=fakeHarness({variant:'BASE'});incompatible.engine.state.secondaryNeuralFault=structuredClone(fault);incompatible.engine.state.secondaryNeural={version:'UNSUPPORTED_NEURAL_HISTORY',raw_history:['preserve']};installSecondaryNeural(incompatible.engine,{...ENV,LUMI_TRADING_SECONDARY_NEURAL_MODE:'ADVISORY'});assert.deepEqual(incompatible.engine.state.secondaryNeuralFault,fault);assert.deepEqual(incompatible.engine.state.secondaryNeural.raw_history,['preserve']);assert.equal(neuralView(incompatible.engine.state).mode,'DEGRADED');
});

function rankingArtifact(domain,id,{authorized=false,invert=false}={}){
 const p=JSON.parse(JSON.parse(testArtifact(domain,id)).payload_json);for(const layer of p.layers)for(const row of layer.weights)row.fill(0);
 p.layers[0].weights[NEURAL_FEATURE_NAMES.indexOf('pattern_pullback')][0]=invert?-1:1;p.layers[1].weights[0][0]=1;p.layers[2].weights[0][0]=1;
 p.validation={status:authorized?'PASSED':'PROSPECTIVE',criteria_version:'secondary-neural-validation-1.0.0',assistance_authorized:authorized};const payload_json=JSON.stringify(p);return JSON.stringify({version:NEURAL_ARTIFACT_VERSION,payload_json,sha256:hash(payload_json)});
}
function twoCausalDecisionFixtures(h){
 const context={series:h.fixture.series,quote:quote(T,h.fixture.bid),meta:META,cutoff:C,now:T,explorationPolicy:getExplorationPolicy(h.engine.state),profitPolicy:getProfitPolicy(h.engine.state)};
 const first=entryCandidates(context.series,context.quote,META,C,T,0,context.explorationPolicy,context.profitPolicy).find(d=>d.plan),second=structuredClone(first);
 // These two hypothetical candidates are isolated inference fixtures, not live signals.
 second.pattern='PULLBACK';second.plan.pattern='PULLBACK';second.plan.id='ISOLATED_SECOND_CANDIDATE';second.plan.signal_key=hash(['ISOLATED_SECOND_CANDIDATE']);
 const snapshot=captureSecondaryNeuralSignal({...context,decision:first,existing:h.engine.state.frequency.account});assert.equal(snapshot.exclusion,null);return {decisions:[first,second],context,domain:snapshot.domain};
}
test('one advisory candidate predicts prospectively beside an assisted model without changing its order or contracts',()=>{
 const h=fakeHarness({variant:'COLLECTING'}),{decisions,context,domain}=twoCausalDecisionFixtures(h),before=structuredClone(decisions),account=structuredClone(h.engine.state.frequency.account),n=h.neural;
 n.state.requested_mode='ASSISTED';n.runtime.setMode('ASSISTED');n.candidateRuntime.setMode('ADVISORY');n.candidateRuntime.clock=()=>0;
 assert(n.runtime.loadArtifactText(rankingArtifact(domain,'nn_operational',{authorized:true})).ok);assert(n.candidateRuntime.loadArtifactText(rankingArtifact(domain,'nn_candidate',{invert:true})).ok);
 h.time(T); // Align decision time without executing the operational fixture.
 const ordered=n.prepare(decisions,context);assert.strictEqual(ordered[0],decisions[1]);assert.deepEqual(decisions,before);assert.deepEqual(h.engine.state.frequency.account,account);
 n.finish(decisions,context);const records=n.state.last_decisions;assert.equal(records.length,2);
 for(const record of records){assert.equal(record.mode,'ASSISTED');assert.equal(record.prediction.model_id,'nn_operational');assert.equal(record.prediction.status,'PREDICTED');assert.equal(record.candidate_predictions.length,1);assert.equal(record.candidate_predictions[0].model_id,'nn_candidate');assert.equal(record.candidate_predictions[0].status,'PREDICTED');assert.equal(record.candidate_predictions[0].authority,'NONE');assert.equal(record.candidate_predictions[0].input_hash,record.prediction.input_hash);}
 const candidateView=n.view().candidate_runtime;assert.equal(candidateView.model.model_id,'nn_candidate');assert.equal(candidateView.inference_latency.n,2);assert.equal(candidateView.inference_latency.p95_ms,0);assert.equal(candidateView.inference_latency.p99_ms,0);
 assert(records[1].candidate_predictions[0].estimated_net_return<records[0].candidate_predictions[0].estimated_net_return,'candidate prefers the opposite order but cannot apply it');
 const previousCount=n.candidateRuntime.state.counts.predictions;assert(n.candidateRuntime.loadArtifactText(rankingArtifact(domain,'nn_operational',{authorized:true})).ok);n.prepare(decisions,context);n.finish(decisions,context);assert.equal(n.candidateRuntime.state.counts.predictions,previousCount);assert(n.state.last_decisions.every(record=>record.candidate_predictions.length===0));
 n.candidateRuntime.loadArtifactText(rankingArtifact(domain,'nn_candidate'));n.candidateRuntime.prioritize=()=>{throw Error('NEURAL_ISOLATED_CANDIDATE_FAILURE');};const stillOrdered=n.prepare(decisions,context);assert.strictEqual(stillOrdered[0],decisions[1]);assert.equal(n.runtime.view().effective_mode,'ASSISTED');assert.equal(n.state.candidate_failure.reason,'NEURAL_ISOLATED_CANDIDATE_FAILURE');assert.deepEqual(h.engine.state.frequency.account,account);
 n.state.requested_mode='OFF';const calls=n.runtime.state.counts.predictions;assert.deepEqual(n.prepare(decisions,context),decisions);assert.equal(n.runtime.state.counts.predictions,calls);
});

test('refresh revokes operational and candidate models before either file can be reloaded',async()=>{
 const h=fakeHarness({variant:'COLLECTING'}),{domain}=twoCausalDecisionFixtures(h),n=h.neural,dir=await mkdtemp(join(tmpdir(),'lumi-neural-dual-isolated-'));
 try{
  const main=join(dir,'model.json'),candidate=join(dir,'candidate.json'),status=join(dir,'status.json'),previous=join(dir,'previous.json');
  n.state.requested_mode='ADVISORY';n.runtime.setMode('ADVISORY');n.candidateRuntime.setMode('ADVISORY');n.candidateRuntime.clock=()=>0;
  Object.assign(n.env,{LUMI_TRADING_NEURAL_MODEL_PATH:main,LUMI_TRADING_NEURAL_CANDIDATE_PATH:candidate,LUMI_TRADING_NEURAL_LAST_GOOD_PATH:previous,LUMI_TRADING_NEURAL_STATUS_PATH:status});
  const primaryText=testArtifact(domain,'nn_main'),candidateText=testArtifact(domain,'nn_candidate');await writeFile(main,primaryText);await writeFile(previous,primaryText);await writeFile(candidate,candidateText);
  const report={version:'secondary-neural-training-status-1.0.0',mode:'PAPER',realTrading:false,at:C-500,last_training_at:T-30000,status:'PROSPECTIVE',model_id:'nn_main',candidate_id:'nn_candidate',revoked_model_ids:[]};await writeFile(status,JSON.stringify(report));await n.refresh();assert.equal(n.runtime.view().model.model_id,'nn_main');assert.equal(n.candidateRuntime.view().model.model_id,'nn_candidate');assert.equal(n.view().training.last_training_at,T-30000);assert.equal(n.view().training.at,C-500);
  await writeFile(status,JSON.stringify({...report,revoked_model_ids:['nn_main','nn_candidate']}));n.lastRefresh=-Infinity;await n.refresh();assert.equal(n.runtime.view().model,null);assert.equal(n.candidateRuntime.view().model,null);assert(n.runtime.state.revoked_model_ids.includes('nn_main'));assert(n.candidateRuntime.state.revoked_model_ids.includes('nn_candidate'));
  await writeFile(main,testArtifact(domain,'nn_new_main'));await writeFile(candidate,testArtifact(domain,'nn_new_candidate'));await writeFile(status,JSON.stringify({...report,model_id:'nn_new_main',candidate_id:'nn_new_candidate',revoked_model_ids:['nn_main','nn_candidate']}));n.lastRefresh=-Infinity;await n.refresh();assert.equal(n.runtime.view().model.model_id,'nn_new_main');assert.equal(n.candidateRuntime.view().model.model_id,'nn_new_candidate');
  await writeFile(candidate,'{');n.lastRefresh=-Infinity;await n.refresh();assert.equal(n.runtime.view().model.model_id,'nn_new_main');assert.equal(n.candidateRuntime.view().model,null,'candidate cannot keep predicting a stale last-good candidate');
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('neural failure cannot turn historical loss, topup or rejected-trial controls back on',()=>{
 const base=runFlow({cash:'1'}),h=runFlow({cash:'1',variant:'CORRUPT'});assert.deepEqual(h.operational,base.operational);assert.equal(h.engine.state.secondaryExecution.capital.count,1);assert.equal(h.engine.state.laboratory.trials[0].status,'REJECTED');
 const selected=h.events.find(e=>e.type==='SELECTED');assert.equal(selected.plan.sizing.nominal_usd,'100');assert.equal(selected.plan.sizing.leverage,2);assert.equal(h.events.filter(e=>e.type==='PAPER_CAPITAL_TOPUP').length,1);assert.equal(h.events.filter(e=>e.type==='NEURAL_LABEL_RECORDED').length,1);
 const label=h.events.find(e=>e.type==='NEURAL_LABEL_RECORDED').label,closed=h.events.find(e=>e.type==='CLOSED');assert.equal(label.net,closed.pnl);assert.notEqual(label.net,h.engine.state.secondaryExecution.capital.topups);
});

test('partial exits and late funding reconcile one operation and version its label without duplicating net profit',()=>{
 const h=fakeHarness({variant:'COLLECTING'});h.tick(T);h.tick(T+1100);const p=Object.values(h.runtime.broker.a.positions)[0],id=p.plan.id,entryExposure=D(p.entry).mul(p.qty),stop=Number(p.plan.stop)-.1;
 h.runtime.rates={};h.tick(T+2200,stop);assert.equal(p.exit_intent.reason,'STOP');h.tick(T+3300,stop,.5);assert(h.runtime.broker.a.positions[id]);assert(h.events.some(e=>e.type==='PARTIAL_CLOSE'));
 h.tick(T+4400,stop);assert(!h.runtime.broker.a.positions[id]);let labels=h.events.filter(e=>e.type==='NEURAL_LABEL_RECORDED'&&e.id===id);assert.equal(labels.length,1);assert.equal(labels[0].label.status,'PENDING');assert.equal(labels[0].label.exclusion,'FUNDING_UNRESOLVED');assert.equal(h.engine.state.secondaryNeural.counts.usable,0);
 const closed=h.events.find(e=>e.type==='CLOSED'&&e.id===id),provisional=labels[0].label;assert.equal(provisional.net,closed.pnl);assert.equal(provisional.exposure,entryExposure.toString());
 h.runtime.rates={[H]:7};h.tick(T+5500,stop);labels=h.events.filter(e=>e.type==='NEURAL_LABEL_RECORDED'&&e.id===id);assert.equal(labels.length,2);const final=labels.at(-1).label,reconciled=h.events.find(e=>e.type==='FUNDING_RECONCILED'&&e.id===id);
 assert(reconciled);assert.equal(final.status,'MATURE');assert.equal(final.label_revision,2);assert.equal(final.net,reconciled.net_after);assert.equal(final.net_return,D(final.net).div(entryExposure).toString());assert(D(final.net).lt(0),'a resolved loss is usable');assert.equal(h.engine.state.secondaryNeural.counts.usable,1);assert.equal(h.engine.state.secondaryNeural.counts.pending_labels,0);
 h.neural.observe(reconciled);h.neural.observe(closed);assert.equal(h.events.filter(e=>e.type==='NEURAL_LABEL_RECORDED'&&e.id===id).length,2);assert.equal(h.engine.state.secondaryNeural.counts.usable,1);
});

function customPlan(root,{id,at=T,bid=100,target=103,pattern='BREAKOUT',confirmation=C-1000}){
 const c=explorationContract(getExplorationPolicy(root),pattern,at),entry=D(quote(at,bid).ask).mul('1.0002'),stop='99';
 return {id,signal_key:hash(['ISOLATED',id,confirmation]),version:SECONDARY_VERSION,entry_revision:PROFIT_ENTRY_REVISION,execution_model:SECONDARY_MODEL,instrument:'PAPER:KRAKEN_FUTURES:PF_XBTUSD',pattern,direction:'LONG',recipe:pattern,recipe_title:'ISOLATED SQLITE RESTART',timeframe:5,entry:entry.toString(),limit:String(bid),stop,target:String(target),confirmed_at:confirmation,decision_at:at,expires_at:c.expires_at,holding_ms:1800000,order:'FUTURES_TAKER_IOC',execution_contract:c,fill_model:c.liquidity_model,economics:secondaryEconomics(entry,stop,target,'LONG',0,c),...makeProfitContracts(getProfitPolicy(root)),entry_context:{version:'secondary-entry-context-economics-1.0.0',structure_key:'structure:'+pattern+':LONG:'+target,movement_key:'structure:'+pattern,confirmation_key:'confirmation:'+id,confirmation_event_at:confirmation,confirmation_at:confirmation,price_tick:'.01',remaining_distance:D(target).minus(entry).toString(),remaining_distance_fraction:D(target).minus(entry).abs().div(entry).toString()}};
}
async function sqliteHarness(t){
 const dir=await mkdtemp(join(tmpdir(),'lumi-neural-sqlite-isolated-')),path=join(dir,'paper.sqlite');let now=C-500,store=new SQLiteStore(path,{allowEmpty:true,now:()=>now}),engine,runtime;
 t.after(async()=>{try{store.close();}catch{}await rm(dir,{recursive:true,force:true});});
 store.import({schema:1,exported_at:new Date(now).toISOString(),state:{id:'KRAKEN_BTCUSD_PAPER',revision:1,fence:0,lease_until:null,last_batch:null,state:initialState(now),updated_at:new Date(now).toISOString()},counts:{events:0,outbox:0},events:[],outbox:[]});
 const initialize=async(first=false)=>{
  engine=new TradingEngine({store,feed:new KrakenFeed({now:()=>now}),now:()=>now});await engine.initialize();
  if(first){engine.state.laboratory.status='RESEARCH_COMPLETE';Object.assign(engine.state.frequency.account,{cash:'500',equity:'500',net:'0',fees:'0',peak:'500',closed:0,wins:0,losses:0,halted:false});engine.state.laboratory.funding={initial:'500',added:'0',count:0};}
  runtime=new OperationalSecondary({engine,now:()=>now}).initialize();installExploration(engine.state,ENV,now,e=>engine.event(e));installProfitPolicy(engine.state,ENV,now,e=>engine.event(e));installSecondaryNeural(engine,{...ENV,LUMI_TRADING_SECONDARY_NEURAL_MODE:'ADVISORY'});
 };
 await initialize(true);
 return {get engine(){return engine;},get runtime(){return runtime;},get store(){return store;},get now(){return now;},time(at){now=at;},async resume(at){await store.tx({phase:'RELEASE'});store.close();now=at;store=new SQLiteStore(path,{now:()=>now});await initialize();},market(at,bid=100,size=100){now=at;runtime.broker.market(quote(at,bid,size),null,{[H]:0},at);}};
}

test('SQLite restart with four positions retains active trailing, pending close and independent contracts across model/OFF changes',async t=>{
 const h=await sqliteHarness(t),root=h.engine.state,b=h.runtime.broker,primary=structuredClone(h.engine.active().account);h.time(T);
 const early=customPlan(root,{id:'early'}),third=customPlan(root,{id:'third',target:110,pattern:'PULLBACK',confirmation:C-3000}),fourth=customPlan(root,{id:'fourth',target:111,pattern:'RANGE_REENTRY',confirmation:C-4000});
 for(const p of [early,third,fourth])assert.equal(b.choose(p,quote(T,100),META,T),'ENTRY_PENDING');h.market(T+1100,100);
 const late=customPlan(root,{id:'late',at:T+2200,bid:101,target:103,confirmation:T});assert.equal(b.choose(late,quote(T+2200,101),META,T+2200),'ENTRY_PENDING');h.market(T+3300,101);
 h.market(T+4400,103);h.market(T+5500,104);h.market(T+6600,103.15);
 assert.equal(Object.keys(b.a.positions).length,4);assert.equal(b.a.positions.early.profit_protection.state,'TRAILING_ACTIVE');assert.equal(b.a.positions.late.profit_protection.state,'EXIT_PENDING');assert.equal(b.a.positions.late.exit_intent.reason,'TRAILING_RETRACEMENT');
 const before=Object.fromEntries(Object.entries(b.a.positions).map(([id,p])=>[id,{plan:structuredClone(p.plan),qty:p.qty,protection:structuredClone(p.profit_protection),intent:structuredClone(p.exit_intent)}])),liquidity=structuredClone(b.x.liquidity);
 await h.engine.flush();await h.resume(T+6600);const restored=h.runtime.broker;
 for(const [id,saved]of Object.entries(before)){const p=restored.a.positions[id];assert.deepEqual(p.plan,saved.plan);assert.equal(p.qty,saved.qty);assert.deepEqual(p.profit_protection,saved.protection);assert.deepEqual(p.exit_intent,saved.intent);}
 assert.deepEqual(restored.x.liquidity,liquidity);
 const all=structuredClone(restored.a),neural=h.engine.secondaryNeural.runtime,plan=before.early.plan;neural.clock=()=>0;
 const domain={mode:'PAPER',realTrading:false,symbol:'PF_XBTUSD',ledger:'FREQUENT_PAPER',engine_version:plan.version,entry_revision:plan.entry_revision,execution_version:plan.execution_contract.version,economic_policy_version:plan.economic_policy.version,exit_policy_version:plan.exit_policy.version,execution_policy_hash:plan.execution_contract.policy_hash,economic_policy_hash:plan.economic_policy.hash,exit_policy_hash:plan.exit_policy.hash};
 assert(neural.loadArtifactText(testArtifact(domain,'nn_initial')).ok);assert.deepEqual(restored.a,all);neural.setMode('OFF');assert.deepEqual(restored.a,all);assert(neural.loadArtifactText(testArtifact(domain,'nn_replacement')).ok);assert.deepEqual(restored.a,all);neural.loadArtifactText('{');assert.deepEqual(restored.a,all);neural.setMode('ADVISORY');assert.deepEqual(restored.a,all);
 h.market(T+7700,103.15);await h.engine.flush();assert.deepEqual(Object.keys(restored.a.positions).sort(),['early','fourth','third']);assert.equal(restored.a.positions.early.profit_protection.state,'TRAILING_ACTIVE');assert(!restored.a.positions.early.exit_intent);
 assert.equal((await h.store.history('CLOSED')).length,1);assert.equal((await h.store.history('CLOSED'))[0].id,'late');assert.equal((await h.store.history('TARGET_REACHED')).length,2);assert.equal(h.store.notices(100).filter(n=>n.kind==='SECONDARY_TRAILING').length,2);assert.deepEqual(h.engine.active().account,primary);assert.equal(h.store.db.prepare('PRAGMA quick_check').get().quick_check,'ok');
});

test('captured features and mature label survive real SQLite commits and restart without a second example',async t=>{
 const h=await sqliteHarness(t),fixture=marketFixture();h.runtime.series=fixture.series;h.runtime.meta=META;h.runtime.rates={[H]:0};
 const tick=(at,bid)=>{h.time(at);h.runtime.quote=quote(at,bid);h.runtime.tick();};
 tick(T,fixture.bid);tick(T+1100,fixture.bid);const p=Object.values(h.runtime.broker.a.positions)[0];assert(p);const id=p.plan.id,target=Number(p.plan.target);
 tick(T+2200,target);tick(T+3300,target+1);tick(T+4400,target);tick(T+5500,target);await h.engine.flush();
 const captures=await h.store.history('NEURAL_SIGNAL_CAPTURED'),labels=await h.store.history('NEURAL_LABEL_RECORDED');assert.equal(captures.filter(e=>e.snapshot.operation_id===id).length,1);assert.equal(labels.filter(e=>e.id===id).length,1);assert.equal(labels[0].label.status,'MATURE');assert.equal(h.engine.state.secondaryNeural.counts.usable,1);
 const labelHash=labels[0].label.label_hash,closed=(await h.store.history('CLOSED')).find(e=>e.id===id);await h.resume(T+6600);h.engine.secondaryNeural.observe(closed);await h.engine.flush();assert.equal((await h.store.history('NEURAL_LABEL_RECORDED')).length,1);assert.equal(h.engine.state.secondaryNeural.recent[id].label.label_hash,labelHash);assert.equal(h.engine.state.secondaryNeural.counts.usable,1);assert.equal(h.store.db.prepare('PRAGMA quick_check').get().quick_check,'ok');
});
