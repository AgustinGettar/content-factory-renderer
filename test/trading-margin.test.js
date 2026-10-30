// Synthetic accounting/causality checks, not a profitability backtest.
import test from 'node:test';
import assert from 'node:assert/strict';
import {D,POLICY} from '../lib/trading/core.js';
import {MARGIN_VERSION,MARGIN_PROTOCOL,initializeMargin,marginRiskPlan,marginFunding,marginValue,marginOpen} from '../lib/trading/margin.js';
import {newAccount,select,step,repairPosition} from '../lib/trading/simulator.js';
import {enablePortfolio,initializePortfolio,orders,positions,syncPortfolio} from '../lib/trading/portfolio.js';
import {initialState} from '../lib/trading/engine.js';
import {initializeFrequency,FrequencyExperiment} from '../lib/trading/frequency.js';
import {initializeLearning,TradingLearning,entryFeatures} from '../lib/trading/learning.js';
import {initializeTimeframes,recipeComponents} from '../lib/trading/timeframes.js';
import {initializeLaboratory,TradingLaboratory,laboratoryPlan,MARGIN_RECIPES,MARGIN_LAB_PROTOCOL} from '../lib/trading/laboratory.js';
import {renderNotice} from '../lib/trading/notifier.js';
import {projectMonitor} from '../lib/trading/monitor-projection.js';
const NOW=Date.parse('2026-10-30T00:00:00Z');
const meta={lot_decimals:8,ordermin:'.00000001',costmin:'.01',tick_size:'.1',leverage_buy:[2,3,4,5],leverage_sell:[2,3,4,5]};
const quote={ask:'100',bid:'100',ask_qty:'100',bid_qty:'100',event_at:NOW,received_at:NOW};
const policy={...POLICY,risk:'.01',openRisk:'.01',riskCapUSD:'1',fee:'0',slippage:'0',minNetRR:'1.5'};
const account=()=>newAccount({...POLICY,initialCash:'100'});
const plan=(direction='LONG',over={})=>({id:'a'.repeat(64),hash:'hash',version:'margin-test',family:'L',timeframe:1,recipe:'test',recipe_title:'Prueba',execution_model:MARGIN_VERSION,direction,entry:'100',limit:'100',stop:direction==='SHORT'?'101':'99',target:direction==='SHORT'?'92':'108',holding_ms:3600000,expires_at:NOW+120000,confirmed_at:NOW,decision_at:NOW,setup:{family:'L'},...over});
const feed=(price,at)=>({quote:{...quote,ask:String(price),bid:String(price),event_at:at},trade:{price:String(price),event_at:at}});
const sized=(direction='LONG',over={})=>{const p=plan(direction,over);p.sizing=marginRiskPlan(p,account(),quote,meta,policy);assert(!p.sizing.reason,p.sizing.reason);return p;};
test('automatic leverage chooses the lowest feasible 1x/2x/3x without increasing the risk cap',()=>{
 const p=plan(),a=account();let x=marginRiskPlan(p,a,quote,meta,{...policy,risk:'.005'});assert.equal(x.leverage,1);assert(D(x.risk).lte('.5'));
 x=marginRiskPlan(p,a,quote,meta,policy);assert.equal(x.leverage,2);assert(D(x.risk).lte(1));
 a.cash='50';x=marginRiskPlan(p,a,quote,meta,policy);assert.equal(x.leverage,3);assert(D(x.risk).lte(1));assert(D(x.reserved).lte(40));
 a.cash='20';assert(marginRiskPlan(p,a,quote,meta,policy).reason);assert.deepEqual(MARGIN_PROTOCOL.leverage,[1,2,3]);
});
test('short borrowing requires pair metadata and cannot use unsupported leverage',()=>{
 assert.equal(sized('SHORT').sizing.leverage,2);
 assert.equal(marginRiskPlan(plan('SHORT'),account(),quote,{...meta,leverage_sell:[]},policy).reason,'MARGIN_METADATA_UNAVAILABLE');
 assert.equal(marginRiskPlan(plan('SHORT'),account(),quote,meta,{...policy,riskCapUSD:'0'}).reason,'PORTFOLIO_RISK_COMMITTED');
});
test('fees and funding reject unprofitable targets; liquidation boundary precedes unsafe stops',()=>{
 assert.equal(marginRiskPlan(plan('SHORT',{target:'99.9'}),account(),quote,meta,POLICY).reason,'NET_RR_TOO_LOW');
 const a=account();a.cash='10.6';const x=marginRiskPlan(plan('SHORT',{stop:'120',target:'30'}),a,quote,meta,policy);assert(x.reason);assert(!x.leverage);
});
test('long and short P&L return collateral once and include opening, exit and rollover costs',()=>{
 for(const direction of ['LONG','SHORT']){
  const a=account(),p=sized(direction);p.sizing.fee='.008';marginOpen(a,p,'100',NOW);const initial=a.position.initial_margin;
  const funding=marginFunding(a.position,direction==='LONG'?108:92,NOW+14400000);assert(funding.gt(0));
  const e=step(a,feed(direction==='LONG'?108:92,NOW+14400000),NOW+14400000)[0];assert.equal(e.type,'CLOSED');assert.equal(e.reason,'TARGET');
  const gross=D(8).mul(p.sizing.qty);assert(D(e.pnl).eq(gross.minus(e.fees)));assert(D(a.cash).eq(D(100).plus(e.pnl)));assert.equal(a.position,null);assert(D(initial).lt(100));
  assert.equal(step(a,feed(100,NOW+14400001),NOW+14400001).length,0);
 }
});
test('short adverse movement loses money and liquidations are conservatively charged',()=>{
 const a=account(),p=sized('SHORT');marginOpen(a,p,'100',NOW);
 const e=step(a,feed(115,NOW+5000),NOW+5000)[0];assert.equal(e.reason,'LIQUIDATION_MODEL');assert(D(e.pnl).lt(0));assert(D(e.fees).gte(D(115).mul(p.sizing.qty).mul('.02')));assert(D(a.cash).eq(D(100).plus(e.pnl)));
});
test('a short conditional entry uses bid, activates only after placement, and reserves actual collateral',()=>{
 const a=account(),p=plan('SHORT',{entry:'100',limit:'99.95'});const selected=select(a,p,quote,meta,NOW,{latency:1000,policy});assert.equal(selected.type,'SELECTED');
 assert.equal(step(a,feed(101,NOW+1000),NOW+1000)[0].reason,'BARRIER_BEFORE_ENTRY');
 const b=account();select(b,p,quote,meta,NOW,{latency:1000,policy});let events=step(b,feed(100,NOW+1100),NOW+1100);assert(events.some(e=>e.type==='FILLED'));assert(b.position);assert(D(b.cash).gte(0));
 const c=account();select(c,p,quote,meta,NOW,{latency:1000,policy});events=step(c,feed(99,NOW+1100),NOW+1100);assert.equal(events.at(-1).reason,'ENTRY_GAP_BEYOND_LIMIT');assert.equal(c.position,null);
});
test('multiple margin orders and positions share capital, risk, funding reserves and displayed liquidity',()=>{
 const a=account();enablePortfolio(a);
 for(let i=0;i<4;i++)select(a,plan('SHORT',{id:String(i),recipe:'r'+i}),{...quote,ask_qty:'.4',bid_qty:'.4'},meta,NOW,{policy});
 assert.equal(orders(a).length,3);assert(D(a.openRiskReserved).lte(1));const funding=orders(a).reduce((v,p)=>v.plus(p.plan.sizing.funding_reserved),D(0));
 step(a,feed(100,NOW+1100),NOW+1100);assert.equal(positions(a).length,3);assert(D(a.fundingReserve).eq(funding));assert(D(a.availableCash).gte(0));
 for(const p of positions(a))assert(marginValue(p,quote,NOW+1100).lte(p.initial_margin));
 const restored=JSON.parse(JSON.stringify(a));syncPortfolio(restored);assert.deepEqual(restored,a);
});
test('gap recovery for a short uses adverse high, labels uncertainty and is idempotent',()=>{
 const a=account(),p=sized('SHORT');marginOpen(a,p,'100',NOW);const rows=[{start:NOW,end:NOW+60000,open:100,high:120,low:90,close:100}];
 const events=repairPosition(a,rows,feed(100,NOW+60000),NOW+60000,NOW),closed=events.find(e=>e.type==='CLOSED');assert.equal(closed.reason,'LIQUIDATION_MODEL');assert.equal(closed.quality,'GAP_CONSERVATIVE');assert(D(closed.price).gte(120));const cash=a.cash;
 repairPosition(a,rows,feed(100,NOW+60000),NOW+60000,NOW);assert.equal(a.cash,cash);
});
function rows(short=false,narrow=false){return Array.from({length:120},(_,i)=>{const close=short?100000-i*300:50000+i*300;return {start:NOW-(120-i)*60000,end:NOW-(119-i)*60000,open:close+(short?50:-50),high:close+(short&&!narrow?1500:100),low:close-(!short&&!narrow?1500:100),close,volume:10,trades:10,available_at:NOW+2000};});}
test('both trend directions produce causal plans; a narrow minute target is rejected without alteration',()=>{
 const recipe=MARGIN_RECIPES[0].components[0];
 for(const short of [false,true]){const bars=rows(short),close=bars.at(-1).close,f=feed(close,NOW+2000),decision=laboratoryPlan(recipe,'test',{1:bars},f,meta,NOW,NOW+2000);assert(decision.plan,decision.reason);assert.equal(decision.plan.direction,short?'SHORT':'LONG');assert.equal(decision.plan.execution_model,MARGIN_VERSION);
 const future={...bars.at(-1),start:NOW,end:NOW+60000,close:999999};const repeated=laboratoryPlan(recipe,'test',{1:[...bars,future]},f,meta,NOW,NOW+2000);assert.equal(repeated.plan.hash,decision.plan.hash);
 const features=entryFeatures(decision.plan,bars,f.quote,NOW+2000);assert.equal(features.feature_version,2);assert.equal(features.x.at(-1),short?-1:1);assert(features.x[7]>0&&features.x[8]>0);
 }
 const bars=rows(true,true),r=laboratoryPlan(recipe,'test',{1:bars},feed(bars.at(-1).close,NOW+2000),meta,NOW,NOW+2000);assert.equal(r.reason,'LAB_COSTS_TOO_HIGH');assert(r.criteria.netRR<1.5);assert(!r.plan);
});
test('margin research waits for flat, preserves money, archives prior trials and never oscillates on restart',()=>{
 const s=initialState(NOW);initializeFrequency(s,NOW);initializeLearning(s,NOW);initializeLaboratory(s,NOW);initializePortfolio(s,NOW);initializeTimeframes(s,NOW);
 const events=[],f={metadata:meta,state:feed(100,NOW)},frequency=new FrequencyExperiment({state:s.frequency,feed:f,now:()=>NOW,event:e=>events.push(e),notice:()=>{}}),learning=new TradingLearning({state:s.learning,now:()=>NOW,event:()=>{}});
 const lab=new TradingLaboratory({state:s,feed:f,now:()=>NOW,event:e=>events.push(e),notice:()=>{},frequency,learning});lab.maintain();const old=s.laboratory.active;s.frequency.account.cash=s.frequency.account.equity='99.26';s.frequency.account.net='-.74';
 s.frequency.account.pendingOrders.legacy={plan:{id:'legacy'}};initializeMargin(s,NOW);lab.maintain();assert.equal(s.margin.status,'WAITING_FLAT');assert.equal(s.laboratory.active,old);
 delete s.frequency.account.pendingOrders.legacy;lab.maintain();const current=s.laboratory.active;assert.equal(s.margin.status,'ACTIVE');assert.equal(s.schema,4);assert.equal(s.frequency.account.cash,'99.26');assert.equal(s.frequency.account.net,'-.74');assert.equal(s.research.versions[s.research.active].account.cash,'100');
 for(let i=0;i<5;i++){initializeMargin(s,NOW);initializeLaboratory(s,NOW);initializePortfolio(s,NOW);initializeTimeframes(s,NOW);lab.maintain();}assert.equal(s.laboratory.active,current);assert.equal(events.filter(e=>e.type==='MARGIN_ENABLED').length,1);assert.equal(MARGIN_LAB_PROTOCOL.maxHypotheses,7);
 assert(s.laboratory.execution_archives.some(a=>a.active===old));assert.equal(recipeComponents(lab.trial().recipe).length,4);
 const d=projectMonitor({states:[{state:s,updated_at:new Date(NOW).toISOString()}],now:NOW});assert.equal(d.margin.status,'ACTIVE');assert.equal(d.margin.protocol.realTrading,false);
});
test('Telegram distinguishes short direction, simulated leverage and net objectives',()=>{
 const p=sized('SHORT'),n={kind:'RESULT',payload:{type:'PAPER_OPENED',plan:p,qty:p.sizing.qty,price:'100',account:'FREQUENT_PAPER',at:NOW,id:p.id}};
 const text=renderNotice(n,feed(100,NOW),NOW);assert.match(text,/venta en corto simulada/);assert.match(text,/2× ficticio/);assert.match(text,/margen/);assert.match(text,/https:\/\/lumi-trading-monitor/);assert(text.length<1200);assert(!text.includes('Sin préstamo'));
});
