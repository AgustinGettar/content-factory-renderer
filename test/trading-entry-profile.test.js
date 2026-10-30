// Causal synthetic cases; no profitability claim.
import test from 'node:test';
import assert from 'node:assert/strict';
import {D,POLICY} from '../lib/trading/core.js';
import {initialState,TradingEngine} from '../lib/trading/engine.js';
import {KrakenFeed} from '../lib/trading/feed.js';
import {initializeFrequency,FrequencyExperiment} from '../lib/trading/frequency.js';
import {initializeLearning,TradingLearning} from '../lib/trading/learning.js';
import {initializeLaboratory,TradingLaboratory,laboratoryPlan,AGILE_RECIPES,MARGIN_RECIPES} from '../lib/trading/laboratory.js';
import {initializePortfolio,portfolioPolicy} from '../lib/trading/portfolio.js';
import {initializeTimeframes} from '../lib/trading/timeframes.js';
import {initializeMargin,MARGIN_VERSION} from '../lib/trading/margin.js';
import {initializeSecondaryRisk} from '../lib/trading/secondary-risk.js';
import {initializeEntryProfile,ENTRY_VERSION} from '../lib/trading/entry-profile.js';
import {select} from '../lib/trading/simulator.js';
import {projectMonitor} from '../lib/trading/monitor-projection.js';
import {renderNotice} from '../lib/trading/notifier.js';
const NOW=Date.parse('2026-10-30T21:00:00Z');
const meta={tick_size:'.1',lot_decimals:8,ordermin:'.00001',costmin:'.1',leverage_buy:[2,3,4,5],leverage_sell:[2,3,4,5]};
const quote={ask:'100',bid:'100',ask_qty:'100',bid_qty:'100',event_at:NOW,received_at:NOW};
function setup(){
 const s=initialState(NOW);initializeFrequency(s,NOW);initializeLearning(s,NOW);initializeLaboratory(s,NOW);initializePortfolio(s,NOW);initializeTimeframes(s,NOW);initializeMargin(s,NOW);
 const events=[],feed={series:{},metadata:meta,state:{quote}},frequency=new FrequencyExperiment({state:s.frequency,feed,now:()=>NOW,event:e=>events.push(e),notice:()=>{}});
 const lab=new TradingLaboratory({state:s,feed,now:()=>NOW,event:e=>events.push(e),notice:()=>{},frequency,learning:new TradingLearning({state:s.learning,now:()=>NOW,event:()=>{}})});
 lab.maintain();initializeSecondaryRisk(s,NOW,true);lab.maintain();return {s,lab,events,a:s.frequency.account};
}
function bars(){return Array.from({length:120},(_,i)=>{const c=50000+i*300;return {start:NOW-(120-i)*60000,end:NOW-(119-i)*60000,open:c-150,close:c,high:c+100,low:c-1500,volume:10,trades:10,available_at:NOW+2000};});}
function evaluate(b,r=AGILE_RECIPES[0].components[0]){return laboratoryPlan(r,'test',{'1':b},{quote:{...quote,ask:String(b.filter(x=>x.end<=NOW).at(-1).close),bid:String(b.filter(x=>x.end<=NOW).at(-1).close-.1)}},meta,NOW,NOW+2000);}
test('5-bar entry passes an old 20-bar obstruction and evidence uses causal EMA9/21',()=>{
 const b=bars();b.at(-15).high=90000;
 const old=evaluate(b,MARGIN_RECIPES[0].components[0]);assert.equal(old.reason,'LAB_WAIT_BREAKOUT');
 const r=evaluate(b);assert(r.plan,JSON.stringify(r));assert.equal(r.criteria.lookback,5);assert.equal(r.criteria.breakout,true);
 const lines=r.plan.evidence.panels[0].lines;assert.deepEqual(lines.map(l=>l.name),['EMA 9','EMA 21']);assert.equal(lines[0].points.at(-1).value,r.criteria.fast);assert.equal(lines[1].points.at(-1).value,r.criteria.slow);
 assert.match(r.plan.criteria.join(','),/EMA9_ABOVE_EMA21/);assert.match(r.plan.criteria.join(','),/NET_RR_1/);
 const future={...b.at(-1),end:NOW+60000,close:999999,available_at:NOW+2001};assert.equal(evaluate([...b,future]).plan.hash,r.plan.hash);
});
test('alternative pullback can qualify without a breakout in either direction',()=>{
 const b=bars();b.at(-2).high=b.at(-1).close+100;const long=evaluate(b);assert(long.plan);assert.equal(long.criteria.breakout,false);assert.equal(long.criteria.pullback,true);
 const shortBars=b.map(x=>({...x,open:180000-x.open,close:180000-x.close,high:180000-x.low,low:180000-x.high}));const short=evaluate(shortBars);assert(short.plan,JSON.stringify(short));assert.equal(short.plan.direction,'SHORT');assert.equal(short.criteria.breakout,false);assert.equal(short.criteria.pullback,true);
});
test('relaxed pattern still rejects targets overwhelmed by full transaction costs',()=>{
 const b=bars().map(x=>({...x,open:x.close-50,high:x.close+100,low:x.close-100}));const r=evaluate(b);assert.equal(r.criteria.trigger,true);assert.equal(r.reason,'LAB_COSTS_TOO_HIGH');assert.equal(r.plan,undefined);
});
test('migration waits for flat, archives once, preserves cash and history and isolates primary',async()=>{
 const h=setup(),old=h.s.laboratory.active,primary=structuredClone(h.s.research),money=structuredClone(h.a),funding=structuredClone(h.s.laboratory.funding);
 initializeEntryProfile(h.s,NOW);assert.equal(h.s.entryProfile,undefined);initializeEntryProfile(h.s,NOW,true);
 h.a.pendingOrders.old={plan:{id:'old'}};h.lab.now=()=>NOW+2000;h.lab.trial().frameCutoffs[1]=NOW-60000;
 await h.lab.boundary();assert.equal(h.s.entryProfile.status,'WAITING_FLAT');assert.equal(h.s.frequency.counts.evaluations,0);
 delete h.a.pendingOrders.old;h.lab.maintain();assert.equal(h.s.entryProfile.status,'ACTIVE');assert.notEqual(h.s.laboratory.active,old);assert.equal(h.lab.trial().recipe.entryRevision,ENTRY_VERSION);assert(h.s.laboratory.execution_archives.some(a=>a.active===old));
 for(const k of ['cash','equity','net','fees','closed','peak','dayStart','maxDrawdown'])assert.equal(h.a[k],money[k],k);assert.deepEqual(h.s.laboratory.funding,funding);assert.deepEqual(h.s.research,primary);
 h.lab.maintain();assert.equal(h.events.filter(e=>e.type==='ENTRY_PROFILE_ENABLED').length,1);assert.equal(h.lab.trial().training,0);
 let saved=structuredClone(h.s);const store={async acquire(){return structuredClone(saved)},async renew(){},async commit(s){saved=structuredClone(s)}};
 const reboot=await new TradingEngine({feed:new KrakenFeed({now:()=>NOW+3000}),store,now:()=>NOW+3000,entryProfileRequested:true,secondaryRiskRequested:true}).initialize();assert.equal(reboot.state.schema,6);assert.equal(reboot.state.laboratory.active,h.s.laboratory.active);assert.equal(reboot.state.frequency.account.cash,'300');
});
test('net RR between 1 and 1.5 is eligible only in agile secondary, with unchanged caps',()=>{
 const h=setup();initializeEntryProfile(h.s,NOW,true);h.lab.maintain();const primary=h.s.research.versions[h.s.research.active].account;
 const p={id:'rr',version:'test',family:'L',recipe:'agile',confirmed_at:NOW,execution_model:MARGIN_VERSION,direction:'LONG',entry:'100',limit:'100',stop:'99',target:'105',holding_ms:1800000,expires_at:NOW+120000,setup:{family:'L'}};
 const policy=portfolioPolicy(p,quote,POLICY,h.a);assert.equal(policy.minNetRR,'1');assert.equal(policy.risk,'0.005');assert.equal(policy.riskCapUSD,'3');assert.equal(policy.openRisk,'0.02');assert.equal(portfolioPolicy(p,quote,POLICY,primary).minNetRR,'1.5');
 const selected=select(h.a,p,quote,meta,NOW);assert.equal(selected.type,'SELECTED',JSON.stringify(selected));assert(D(selected.plan.sizing.net_rr).gte(1)&&D(selected.plan.sizing.net_rr).lt(1.5));assert(D(selected.plan.sizing.risk).lte('1.5'));assert.equal(select(primary,p,quote,meta,NOW).reason,'NET_RR_TOO_LOW');
});
test('projection and activation notice identify actual filters and do not promise automatic rule changes',()=>{
 const h=setup();initializeEntryProfile(h.s,NOW,true);h.lab.maintain();const d=projectMonitor({states:[{state:h.s}],now:NOW});assert.equal(d.entry_profile.status,'ACTIVE');assert.equal(d.frequency.entry_profile.minNetRR,'1');assert.equal(d.laboratory.recipes[0].fast,9);assert.equal(d.laboratory.recipes[0].lookback,5);
 const message=renderNotice({kind:'VERSION',payload:h.events.find(e=>e.type==='ENTRY_PROFILE_ENABLED')},{},NOW);assert.match(message,/5 velas/);assert.match(message,/medias 9\/21/);assert.match(message,/filtros quedan fijos/);assert.match(message,/ficticio/);
});
