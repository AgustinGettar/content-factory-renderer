import {MULTIFRAME_RECIPES} from '../lib/trading/timeframes.js';
// Synthetic fixtures. These tests are not market-performance evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import {initialState,TradingEngine} from '../lib/trading/engine.js';
import {KrakenFeed} from '../lib/trading/feed.js';
import {initializeFrequency,FrequencyExperiment} from '../lib/trading/frequency.js';
import {initializeLearning,TradingLearning} from '../lib/trading/learning.js';
import {initializeLaboratory,refillSecondary,laboratoryPlan,TradingLaboratory,RECIPES,promotionReport,LAB_PROTOCOL,laboratoryPolicy} from '../lib/trading/laboratory.js';
import {D,indicators} from '../lib/trading/core.js';
import {select,step,repairPosition,invalidate} from '../lib/trading/simulator.js';
import {renderNotice,PANEL_URL} from '../lib/trading/notifier.js';
const DAY=86400000,HOUR=3600000,start=Date.parse('2026-10-29T14:00:00Z');
function harness(){
 let now=start;const s=initialState(now);initializeFrequency(s,now);initializeLearning(s,now);initializeLaboratory(s,now);
 const events=[],notices=[],feed={series:{},metadata:{tick_size:'.1',lot_decimals:8,ordermin:'.00001',costmin:'1',status:'online',checked_at:now},state:{connected:true,reconciled:true,system:'online',clock:{checked_at:now,error_ms:0},quote:{ask:'80000',bid:'79999.9',ask_qty:'1',bid_qty:'1',event_at:now,received_at:now},trade:{price:'80000',event_at:now,received_at:now}}};
 let lab;const learning=new TradingLearning({state:s.learning,now:()=>now,event:e=>events.push(e)});
 const event=e=>{learning.observe(e,e.ledger,e.version);lab?.observe(e);events.push(e);};
 const frequency=new FrequencyExperiment({state:s.frequency,feed,now:()=>now,event,notice:(...n)=>notices.push(n)});
 lab=new TradingLaboratory({state:s,feed,now:()=>now,event,notice:(...n)=>notices.push(n),frequency,learning});
 return {s,feed,lab,frequency,events,notices,time(n){now=n;feed.metadata.checked_at=n;feed.state.clock.checked_at=n;for(const k of ['quote','trade'])feed.state[k].event_at=feed.state[k].received_at=n;},now:()=>now};
}
function qualifyingTrial(){return {refilled:false,training:100,validation:{after:start,clean:200,closed:200,net:5,fees:1,notional:100,drawdown:.01,incomplete:0,unresolved:0,days:Array.from({length:90},(_,i)=>({day:new Date(start+(i+1)*DAY).toISOString().slice(0,10),secondary:.0005,primary:.0001,valid:true}))}};}
test('laboratory initialization is idempotent and never resets balances or legacy positions',()=>{
 const h=harness(),a=h.s.frequency.account;Object.assign(a,{cash:'88',equity:'99',net:'-1',position:{plan:{id:'legacy'},entry:'80000'}});const before=structuredClone(a);
 assert.equal(initializeLaboratory(h.s,start+1),null);h.lab.maintain();assert.deepEqual(a,before);assert.equal(h.s.laboratory.trials.length,0);
 h.s.laboratory.protocol_hash='changed';assert.throws(()=>initializeLaboratory(h.s,start),/MISMATCH/);
});
test('secondary refills only strictly below USD1 while flat; deposits never alter primary or P&L',()=>{
 const h=harness(),a=h.s.frequency.account,primary=structuredClone(h.s.research);
 a.cash=a.equity='1';assert.equal(refillSecondary(h.s,start),null);
 a.cash='.5';a.equity='30';a.position={};assert.equal(refillSecondary(h.s,start),null);
 a.position=null;a.cash=a.equity='.99';a.pending={};assert.equal(refillSecondary(h.s,start),null);a.pending=null;
 Object.assign(a,{net:'-99.01',fees:'5',closed:100,wins:10,losses:90,maxDrawdown:'.9901'});
 const e=refillSecondary(h.s,start);assert.equal(e.amount,'99.01');assert.equal(a.equity,'100');assert.equal(a.net,'-99.01');assert.equal(a.closed,100);assert.equal(a.maxDrawdown,'.9901');assert.deepEqual(h.s.research,primary);
 assert.equal(h.s.laboratory.funding.added,'99.01');assert.equal(refillSecondary(h.s,start+1),null);
 const restored=JSON.parse(JSON.stringify(h.s));assert.equal(refillSecondary(restored,start+2),null);
});
test('registered trials rotate at loss limit without deleting losses, and stop after three',()=>{
 const h=harness(),a=h.s.frequency.account;h.lab.maintain();const first=h.lab.trial();assert.equal(first.recipe.id,RECIPES[0].id);
 a.cash=a.equity='95';a.net='-5';a.halted=true;h.lab.maintain();assert.equal(first.status,'REJECTED');assert.equal(h.lab.trial().recipe.id,RECIPES[1].id);assert.equal(a.cash,'95');assert.equal(a.net,'-5');assert.equal(h.s.laboratory.funding.count,0);
 a.halted=true;h.lab.maintain();a.halted=true;h.lab.maintain();h.lab.maintain();assert.equal(h.s.laboratory.trials.length,3);assert.equal(h.s.laboratory.status,'RESEARCH_COMPLETE');
 assert(+h.s.laboratory.funding.maxDrawdown>=.05);
});
test('a refill disqualifies the active trial and the next one starts with its own observations',()=>{
 const h=harness();h.lab.maintain();const t=h.lab.trial();h.s.frequency.account.cash=h.s.frequency.account.equity='.5';h.s.frequency.account.net='-99.5';h.lab.maintain();
 assert(t.refilled);assert.equal(t.status,'REJECTED');assert.equal(h.lab.trial().training,0);assert.equal(h.s.frequency.account.net,'-99.5');assert.equal(h.s.laboratory.funding.added,'99.5');assert.equal(h.notices.filter(n=>n[1].type==='LABORATORY_REFILLED').length,1);
});
test('economic validation needs future sample, common calendar, net and stressed advantage',()=>{
 const t=qualifyingTrial();assert.equal(promotionReport(t,start+100*DAY).status,'ELIGIBLE_PAPER');
 for(const mutation of [t=>t.validation.clean=199,t=>t.validation.days.pop()]){const x=structuredClone(t);mutation(x);assert.equal(promotionReport(x,start+100*DAY).status,'COLLECTING');}
 for(const mutation of [t=>t.refilled=true,t=>t.validation.fees=100,t=>t.validation.drawdown=.06,t=>t.validation.unresolved=1,t=>t.validation.days[5].valid=false,t=>t.validation.days[5].day=t.validation.days[4].day,t=>t.validation.days.forEach(d=>d.primary=.01),t=>t.validation.days.forEach(d=>d.secondary=0),t=>t.validation.incomplete=30]){const x=structuredClone(t);mutation(x);assert.equal(promotionReport(x,start+100*DAY).status,'REJECTED');}
});
test('training/validation split excludes prior entries, unfilled plans and duplicate closures',()=>{
 const h=harness();h.lab.maintain();const t=h.lab.trial(),version=t.version;
 const trade=(i,at,quality='OBSERVED')=>{h.time(at);h.lab.observe({type:'SELECTED',ledger:'FREQUENT_PAPER',version,id:String(i),plan:{decision_at:at,study:{features:{}}}});h.lab.observe({type:'CLOSED',ledger:'FREQUENT_PAPER',version,id:String(i),pnl:'.01',fees:'.02',entry:'80000',price:'80010',qty:'.0001',quality});};
 for(let i=0;i<100;i++)trade(i,start+i*1000);assert.equal(t.training,100);const after=t.validation.after;
 trade('purge',after-1);assert.equal(t.validation.closed,0);trade('valid',after+1);assert.equal(t.validation.clean,1);
 h.lab.observe({type:'CLOSED',ledger:'FREQUENT_PAPER',version,id:'valid'});assert.equal(t.validation.clean,1);
 trade('gap',after+2,'UNRESOLVED_GAP');assert.equal(t.validation.incomplete,1);assert.equal(t.validation.unresolved,1);
});
test('validation rejects a stale daily valuation and a missing monitoring interval',()=>{
 const h=harness();h.lab.maintain();const t=h.lab.trial(),midnight=Math.ceil(start/DAY)*DAY;
 t.training=100;t.validation={after:midnight,clean:0,closed:0,incomplete:0,unresolved:0,net:0,fees:0,notional:0,drawdown:0,days:[],last:null};
 h.time(midnight+2000);h.lab.maintain();assert.equal(t.validation.last.valid,true);
 h.time(midnight+4000);h.feed.state.quote.event_at=midnight-10000;h.lab.maintain();assert.equal(t.validation.last.valid,false);
 h.time(midnight+DAY+2000);h.lab.maintain();assert.equal(t.validation.days[0].valid,false);assert.equal(t.validation.last.valid,true);
 h.time(midnight+DAY+400000);h.lab.maintain();assert.equal(t.validation.last.valid,false);
});
test('promotion waits for all primary positions, then copies rule without money, results or confidence',()=>{
 const h=harness();h.lab.maintain();const t=h.lab.trial();Object.assign(t,qualifyingTrial());t.status='ELIGIBLE_PAPER';t.report=promotionReport(t,start+100*DAY);
 const before=h.s.research.active,a=h.s.research.versions[before].account;Object.assign(a,{cash:'97',equity:'97',net:'-3',closed:5,fees:'2'});a.pending={};assert.equal(h.lab.promote(t,start+100*DAY),false);a.pending=null;
 const saved=structuredClone(a);assert.equal(h.lab.promote(t,start+100*DAY),true);const active=h.s.research.versions[h.s.research.active];assert.deepEqual(active.account,saved);assert.deepEqual(active.recipe,t.recipe);assert.equal(active.account.equity,'97');assert.equal(h.s.learning.groups['ENGINE:'+active.version],undefined);assert.equal(h.s.frequency.account.cash,'100');
});
function trendBars(tf,cutoff,now){return Array.from({length:120},(_,i)=>{const p=50000+i*300;return {start:cutoff-(120-i)*tf,end:cutoff-(119-i)*tf,open:p-150,close:p,high:p+100,low:p-1500,volume:10,trades:10,available_at:now};});}
test('laboratory rules use closed causal bars and a natural target, refusing costs instead of inflating TP',()=>{
 const h=harness(),recipe=RECIPES[0],bars=trendBars(HOUR,start,start+2000);h.time(start+2000);h.feed.state.quote.ask=String(bars.at(-1).close);h.feed.state.quote.bid=String(+h.feed.state.quote.ask-.1);h.feed.state.trade.price=h.feed.state.quote.ask;
 const r=laboratoryPlan(recipe,'test',{'60':bars},h.feed.state,h.feed.metadata,start,h.now());assert(r.plan,JSON.stringify(r));assert.equal(r.plan.recipe,recipe.id);assert.equal(r.plan.evidence.at,h.now());assert(r.plan.evidence.panels[0].candles.every(b=>b.end<=start));for(const [name,key] of [['EMA 20','ema20'],['EMA 50','ema50']])assert.equal(r.plan.evidence.panels[0].lines.find(l=>l.name===name).points.at(-1).value,indicators(bars).at(-1)[key]);assert.equal(r.plan.holding_ms,48*HOUR);assert.equal(invalidate(r.plan,h.feed.state,h.now(),{long:false}),null);
 const future={...bars.at(-1),end:start+HOUR,close:999999,available_at:h.now()+1};assert.equal(laboratoryPlan(recipe,'test',{'60':[...bars,future]},h.feed.state,h.feed.metadata,start,h.now()).plan.hash,r.plan.hash);
 const narrow=bars.map(b=>({...b,open:+b.close-50,high:+b.close+100,low:+b.close-100}));assert.equal(laboratoryPlan(recipe,'test',{'60':narrow},h.feed.state,h.feed.metadata,start,h.now()).reason,'LAB_COSTS_TOO_HIGH');
});
test('lab fills and recovery preserve frozen holding time and ledger version',()=>{
 const h=harness();h.lab.maintain();const t=h.lab.trial(),at=start+HOUR+2000;h.time(at);const bars=trendBars(HOUR,start+HOUR,at);h.feed.series['60']=bars;h.feed.state.quote.ask=String(bars.at(-1).close);h.feed.state.quote.bid=String(+h.feed.state.quote.ask-.1);h.feed.state.trade.price=h.feed.state.quote.ask;
 const r=laboratoryPlan(t.recipe,t.version,h.feed.series,h.feed.state,h.feed.metadata,start+HOUR,at);const p=h.lab.learning.prepare(r.plan,'FREQUENT_PAPER',r.bars,h.feed.state.quote),a=h.s.frequency.account,e=select(a,p,h.feed.state.quote,h.feed.metadata,at,{policy:laboratoryPolicy(t.version)});assert.equal(e.type,'SELECTED');h.frequency.record(e,t.version);
 h.time(at+1000);h.feed.state.quote.ask=p.entry;h.feed.state.quote.bid=D(p.entry).minus('.1').toString();h.feed.state.trade.price=p.entry;h.frequency.market();assert.equal(a.position.expires_at,at+1000+48*HOUR);
 h.time(at+48*HOUR+1000);h.frequency.market();assert.equal(a.closed,1);assert.equal(h.events.find(e=>e.type==='CLOSED').version,t.version);assert.equal(h.s.learning.groups['FREQUENT_PAPER:'+t.version].usable,1);
});
test('promoted primary and next secondary trial operate concurrently with independent balances across restart',async()=>{
 const h=harness();let saved=h.s;const feed=Object.assign(new KrakenFeed({now:h.now}),h.feed);feed.reconcile=async()=>true;
 const store={async acquire(){return structuredClone(saved);},async renew(){},async commit(s){saved=structuredClone(s);}};
 const engine=await new TradingEngine({feed,store,now:h.now}).initialize();engine.repairing=false;engine.laboratory.maintain();
 const t=engine.laboratory.trial();Object.assign(t,qualifyingTrial());t.frames=Object.fromEntries([1,15,60,240].map(tf=>[tf,{training:25,validation:50}]));t.status='ELIGIBLE_PAPER';t.report=promotionReport(t,start+100*DAY);
 assert(engine.laboratory.promote(t,start+100*DAY));engine.laboratory.maintain();assert.equal(engine.laboratory.trial().recipe.id,MULTIFRAME_RECIPES[1].id);
 const cutoff=start+HOUR;h.time(cutoff+2000);const bars=trendBars(HOUR,cutoff,h.now());bars.at(-2).low=78000;feed.series['60']=bars;
 feed.state.quote.ask=String(bars.at(-1).close);feed.state.quote.bid=String(+feed.state.quote.ask-.1);feed.state.trade.price=feed.state.quote.ask;
 await engine.tick();const primary=engine.active().account,secondary=engine.state.frequency.account;
 assert(primary.pending);assert(secondary.pending);assert.notEqual(primary.pending.plan.version,secondary.pending.plan.version);assert.notEqual(primary.pending.plan.id,secondary.pending.plan.id);
 const trigger=primary.pending.plan.entry;h.time(h.now()+1000);feed.state.quote.ask=trigger;feed.state.quote.bid=D(trigger).minus('.1').toString();feed.state.trade.price=trigger;engine.onMarket();
 assert(primary.position);assert(secondary.position);assert.notEqual(primary.position,secondary.position);await engine.flush();
 const reboot=await new TradingEngine({feed:new KrakenFeed({now:h.now}),store,now:h.now}).initialize();
 assert.deepEqual(reboot.active().account.position,primary.position);assert.deepEqual(reboot.state.frequency.account.position,secondary.position);assert.equal(reboot.active().account.cash,primary.cash);assert.equal(reboot.state.frequency.account.cash,secondary.cash);
});
test('natural notices accurately separate a pending plan, actual simulated fill, net result and refill',()=>{
 const p={id:'a'.repeat(64),family:'L',recipe_title:'Ruptura de 20 horas',entry:'80000',limit:'80040',stop:'79000',target:'85000',expires_at:start+120000,sizing:{qty:'.0001',risk:'.25',net_rr:'1.5',fee:'.008',slippage:'.0002',spread:'.1'}};
 for(const n of [{kind:'SIGNAL',payload:{plan:p,account:'FREQUENT_PAPER'}},{kind:'RESULT',payload:{type:'PAPER_OPENED',plan:p,ledger:'FREQUENT_PAPER',price:'80000',qty:'.0001',at:start,id:p.id}},{kind:'VERSION',payload:{type:'LABORATORY_REFILLED',before:'.5',amount:'99.5'}}]){const text=renderNotice(n,{quote:{event_at:start}},start);assert.match(text,/Agustín/);assert(text.includes(PANEL_URL));assert(text.length<1000);assert.doesNotMatch(text,/garantizad|\[object Object\]|NaN|undefined/);}
 const text=renderNotice({kind:'RESULT',payload:{type:'PAPER_OPENED',plan:p,ledger:'FREQUENT_PAPER',price:'80000',qty:'.0001',at:start,id:p.id}},null,start);assert.match(text,/Destiné 8.06 USD/);assert.match(text,/Riesgo previsto: 0.25 USD/);assert.match(text,/objetivo neto estimado: 0.37 USD/);
});
