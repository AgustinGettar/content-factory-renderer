// All fixtures are synthetic; forecasts from this file are never user signals.
import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {initializeLearning,TradingLearning,entryFeatures,fitModel,score,validationReport,publishedPrediction,LEARNING_PROTOCOL} from '../lib/trading/learning.js';
import {TradingEngine,initialState} from '../lib/trading/engine.js';
import {renderNotice,PANEL_URL} from '../lib/trading/notifier.js';
const start=Date.parse('2026-10-29T12:00Z'),ledger='FREQUENT_PAPER',version='fixture-v1',key=ledger+':'+version;
function harness(){const root={};initializeLearning(root,start);let clock=start;const events=[],learn=new TradingLearning({state:root.learning,now:()=>clock,event:e=>events.push(e)});return {root,learn,events,time:t=>clock=t,g:()=>root.learning.groups[key]};}
function outcome(h,i,{quality='OBSERVED',pnl=i%2?'.1':'-.1',features=true,at=start+i*10000,shadow=null,prediction={status:'UNAVAILABLE'}}={}){
 const plan={id:'fixture-'+i,decision_at:at,sizing:{risk:'.25'},study:{features:features?{at,x:[1,i%2?1:-1]}:null,shadow,prediction}};
 h.time(at);h.learn.observe({type:'SELECTED',id:plan.id,plan},ledger,version);
 const e={type:'CLOSED',id:plan.id,at:at+2000,entered_at:at+1000,quality,pnl,fees:'.2',reason:'TIMEOUT'};
 h.time(e.at);h.learn.observe(e,ledger,version);return e;
}
test('initialization preserves account/position state and never fabricates previous features',()=>{
 const root=initialState(start);root.frequency={account:{cash:'86',position:{entry:'80116'}}};const before=structuredClone(root);
 assert.equal(initializeLearning(root,start).type,'LEARNING_ENABLED');assert.deepEqual(root.frequency,before.frequency);assert.deepEqual(root.research,before.research);assert.equal(initializeLearning(root,start+1),null);
 root.learning.protocol_hash='bad';assert.throws(()=>initializeLearning(root,start),/PROTOCOL_MISMATCH/);
});
test('features exclude future/unavailable candles and use only entry-time inputs',()=>{
 const bars=Array.from({length:60},(_,i)=>({end:start-(59-i)*60000,available_at:start,open:100+i,close:101+i,high:102+i,low:99+i})),plan={confirmed_at:start,atr1:3,limit:162,stop:155,target:170},q={ask:160,bid:159.99};
 const f=entryFeatures(plan,bars,q,start);assert.equal(f.x.length,10);assert(f.x.every(Number.isFinite));
 assert.deepEqual(entryFeatures(plan,[...bars,{...bars.at(-1),end:start+60000,close:1e9}],q,start),f);
 const late=structuredClone(bars);late.at(-1).available_at=start+1;assert.equal(entryFeatures(plan,late,q,start),null);
});
test('each closed trade gets a cost diagnosis; duplicates, gaps and legacy positions cannot train',()=>{
 const h=harness();const e=outcome(h,0);h.learn.observe(e,ledger,version);assert.equal(h.g().usable,1);assert.equal(h.g().lastAnalysis.diagnosis,'COSTS_EXCEEDED_GROSS_GAIN');assert.equal(h.g().lastAnalysis.gross,'0.1');
 outcome(h,1,{quality:'GAP_CONSERVATIVE'});outcome(h,2,{features:false});assert.equal(h.g().usable,1);assert.equal(h.g().excluded,2);assert.equal(h.g().exclusions.INCOMPLETE_MARKET_DATA,1);assert.equal(h.g().exclusions.NO_PRE_ENTRY_FEATURES,1);
 h.learn.observe({type:'SELECTED',id:'cancel',plan:{decision_at:start,study:null,sizing:{risk:'.25'}}},ledger,version);h.learn.observe({type:'NOT_FILLED',id:'cancel'},ledger,version);assert.equal(h.g().unfilled,1);assert.equal(h.g().rows.length,1);
});
test('training starts only with sufficient observed labels and both outcomes; frozen weights change with examples',()=>{
 const h=harness();for(let i=0;i<99;i++)outcome(h,i);assert.equal(h.g().candidate,null);outcome(h,99);const m=h.g().candidate;assert(m);assert.equal(m.train_n,100);assert(score(m,[1,1])>.8);assert(score(m,[1,-1])<.2);assert.equal(h.g().active,null);
 const weights=[...m.w];outcome(h,100);assert.deepEqual(m.w,weights);assert.equal(h.g().attempts,1);assert.equal(m.validation.length,0);
 const losing=harness();for(let i=0;i<120;i++)outcome(losing,i,{pnl:'-.1'});assert.equal(losing.g().candidate,null);
 assert.throws(()=>fitModel(h.g().rows,start,'bad'),/TRAINING_WINDOW/);
});
test('shadow predictions are recorded before the outcome, purge one day, and survive restart',()=>{
 const h=harness();for(let i=0;i<100;i++)outcome(h,i);const m=h.g().candidate;
 outcome(h,101,{at:m.train_last_at+10000,shadow:{model:m.id,p:.9,base:.5}});assert.equal(m.validation.length,0);
 outcome(h,102,{at:m.train_last_at+86400001,shadow:{model:m.id,p:.9,base:.5}});assert.equal(m.validation.length,1);assert.equal(m.validation[0].p,.9);assert.equal(m.validation[0].y,0);
 const restored=JSON.parse(JSON.stringify(h.root.learning));assert.equal(restored.groups[key].candidate.validation.length,1);assert.deepEqual(restored.groups[key].candidate.w,m.w);
});
function validation(){return Array.from({length:300},(_,i)=>({at:start+Math.floor(i/10)*86400000,p:i%10<5?.2:.8,base:.5,y:i%10===0||i%10>=6?1:0}));}
test('promotion requires separate future samples, calibration, class balance and block-adjusted improvement',()=>{
 const rows=validation(),report=validationReport({validation:rows},start+31*86400000,1);assert.equal(report.status,'VALIDATED');assert.equal(report.days,30);assert(report.ci.lower>0);assert(report.brier<report.baselineBrier);
 assert.equal(validationReport({validation:rows.slice(0,100)},start,1).status,'VALIDATING');
 assert.equal(validationReport({validation:rows.map(r=>({...r,p:1-r.p}))},start,1).status,'REJECTED');
 assert.equal(validationReport({validation:rows.map(r=>({...r,y:0}))},start,1).status,'VALIDATING');
});
test('probability stays unavailable for unsupported inputs, expired model or broad calibration intervals',()=>{
 const report=validationReport({validation:validation()},start+31*86400000,1),g={active:{id:'m',w:[Math.log(4),0],bounds:[[1,1],[-1,1]],validated_at:start,report}},f={x:[1,0]};
 assert.equal(publishedPrediction(g,f,start).status,'AVAILABLE');assert.equal(publishedPrediction(g,{x:[1,4]},start).status,'UNAVAILABLE');assert.equal(publishedPrediction(g,f,start+91*86400000).status,'UNAVAILABLE');g.active.report.bins[4].interval=[0,1];assert.equal(publishedPrediction(g,f,start).status,'UNAVAILABLE');
});
test('systematic prospective degradation suspends an active prediction model',()=>{
 const h=harness();outcome(h,0);h.g().active={id:'m',prior:.5,recent:[],validated_at:start};
 for(let i=1;i<=50;i++)outcome(h,i,{pnl:'-.1',prediction:{status:'AVAILABLE',model:'m',p:.9}});
 assert.equal(h.g().active.suspended,true);assert.equal(h.g().status,'PREDICTION_SUSPENDED');assert(h.events.some(e=>e.type==='LEARNING_DRIFT'));
});
test('engine initialization persists learning once and does not reset either balance',async()=>{
 let saved=initialState(start),notices=[];const store={async acquire(){return structuredClone(saved);},async commit(s,e,n){saved=structuredClone(s);notices.push(...n);}};
 await new TradingEngine({store,feed:new EventEmitter(),now:()=>start}).initialize();saved.frequency.account.cash='86';
 await new TradingEngine({store,feed:new EventEmitter(),now:()=>start+1}).initialize();assert.equal(saved.frequency.account.cash,'86');assert.equal(notices.filter(n=>n.payload.type==='LEARNING_ENABLED').length,1);assert.equal(saved.learning.protocol.changesEntryRules,false);
});
test('brief Telegram messages include the panel, event status, costs and uncertainty without raw model payloads',()=>{
 const p={id:'x'.repeat(64),family:'F',entry:'80000',limit:'80040',stop:'79900',target:'81500',expires_at:start+120000,sizing:{qty:'.0001',risk:'.25',fee:'.008',slippage:'.0002',spread:'.1',net_rr:'1.5'},study:{prediction:{status:'UNAVAILABLE'}}};
 const signal=renderNotice({kind:'SIGNAL',payload:{plan:p,account:ledger}},{quote:{event_at:start}},start);assert(signal.length<850);assert(signal.includes(PANEL_URL));assert.match(signal,/Todavía no se ejecutó/);assert.match(signal,/NO DISPONIBLE/);assert.doesNotMatch(signal,/\{.*\}|policy_hash/);
 const open=renderNotice({kind:'RESULT',payload:{type:'PAPER_OPENED',ledger,plan:p,price:'80001',qty:'.0001',at:start,id:p.id}},null,start);assert.match(open,/abrí una compra simulada/);assert(open.includes(PANEL_URL));
 const close=renderNotice({kind:'RESULT',payload:{ledger,entry:'80001',price:'79900',pnl:'-.25',fees:'.21',at:start,id:p.id,quality:'GAP_CONSERVATIVE',reason:'STOP'}},null,start);assert.match(close,/Resultado neto: -0.25/);assert.match(close,/datos incompletos/);assert(close.includes(PANEL_URL));
});
