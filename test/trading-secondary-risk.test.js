// Synthetic bookkeeping/risk checks; these are not evidence of profitability.
import test from 'node:test';
import assert from 'node:assert/strict';
import {D,POLICY} from '../lib/trading/core.js';
import {initialState} from '../lib/trading/engine.js';
import {initializeFrequency,FrequencyExperiment} from '../lib/trading/frequency.js';
import {initializeLearning,TradingLearning} from '../lib/trading/learning.js';
import {initializeLaboratory,TradingLaboratory,promotionReport,refillSecondary} from '../lib/trading/laboratory.js';
import {initializePortfolio,portfolioPolicy,orders} from '../lib/trading/portfolio.js';
import {initializeTimeframes} from '../lib/trading/timeframes.js';
import {initializeMargin,MARGIN_VERSION,marginRiskPlan} from '../lib/trading/margin.js';
import {initializeSecondaryRisk,applySecondaryRisk,accountRiskPolicy,SECONDARY_RISK_PROTOCOL as R} from '../lib/trading/secondary-risk.js';
import {select,mark,step} from '../lib/trading/simulator.js';
import {projectMonitor} from '../lib/trading/monitor-projection.js';
import {renderNotice} from '../lib/trading/notifier.js';
const NOW=Date.parse('2026-10-30T21:00:00Z'),DAY=86400000;
const quote={ask:'100',bid:'100',ask_qty:'100',bid_qty:'100',event_at:NOW,received_at:NOW};
const meta={lot_decimals:8,ordermin:'.00001',costmin:'.1',tick_size:'.01',leverage_buy:[2,3,4,5],leverage_sell:[2,3,4,5]};
const plan=(i=1)=>({id:String(i),version:'growth-test',family:'L',recipe:'r'+i,confirmed_at:NOW,execution_model:MARGIN_VERSION,direction:'LONG',entry:'100',limit:'100',stop:'99',target:'110',holding_ms:1800000,expires_at:NOW+120000,setup:{family:'L'}});
function setup(){
 const s=initialState(NOW);initializeFrequency(s,NOW);initializeLearning(s,NOW);initializeLaboratory(s,NOW);initializePortfolio(s,NOW);initializeTimeframes(s,NOW);initializeMargin(s,NOW);
 const events=[],notices=[],feed={series:{},metadata:meta,state:{quote,trade:{price:'100',event_at:NOW}}};
 const frequency=new FrequencyExperiment({state:s.frequency,feed,now:()=>NOW,event:e=>events.push(e),notice:(...a)=>notices.push(a)});
 const lab=new TradingLaboratory({state:s,feed,now:()=>NOW,event:e=>events.push(e),notice:(...a)=>notices.push(a),frequency,learning:new TradingLearning({state:s.learning,now:()=>NOW,event:()=>{}})});
 lab.maintain();return {s,lab,events,notices,a:s.frequency.account};
}
test('capital is opt-in, waits for flat and is recorded once as a deposit without erasing results',()=>{
 const h=setup(),{s,a}=h,primary=structuredClone(s.research);Object.assign(a,{cash:'99.26',equity:'99.26',net:'-.74',fees:'.82',closed:4,maxDrawdown:'.009'});
 initializeSecondaryRisk(s,NOW);assert.equal(s.secondaryRisk,undefined);
 initializeSecondaryRisk(s,NOW,true);a.pendingOrders.old={plan:{id:'old'}};assert.equal(applySecondaryRisk(s,NOW),null);assert.equal(a.cash,'99.26');delete a.pendingOrders.old;
 const e=applySecondaryRisk(s,NOW);assert.equal(e.after,'300');assert.equal(e.amount,'200.74');assert.equal(a.net,'-.74');assert.equal(a.closed,4);assert.equal(a.fees,'.82');assert.equal(a.maxDrawdown,'.009');assert.equal(a.peak,'300.74');assert.deepEqual(s.research,primary);
 assert.equal(s.laboratory.funding.added,'200.74');assert.equal(s.laboratory.funding.count,0);assert.equal(s.laboratory.funding.history.at(-1).kind,'USER_CAPITAL_ADDITION');
 const restored=JSON.parse(JSON.stringify(s));initializeSecondaryRisk(restored,NOW+1,true);assert.equal(applySecondaryRisk(restored,NOW+1),null);assert.equal(restored.frequency.account.cash,'300');assert.equal(restored.schema,5);
});
test('secondary risk tiers and 3 USD cap do not affect primary or baseline policy',()=>{
 const h=setup();initializeSecondaryRisk(h.s,NOW,true);h.lab.maintain();
 const p=portfolioPolicy(plan(),quote,POLICY,h.a),base=portfolioPolicy(plan(),quote,POLICY,h.s.research.versions[h.s.research.active].account);
 assert.equal(p.riskCapUSD,'3');assert.equal(p.openRisk,'0.02');assert.equal(p.dailyLoss,'0.03');assert.equal(p.drawdown,'0.10');assert.equal(base.riskCapUSD,'1');assert.equal(base.dailyLoss,'0.01');assert.equal(base.marginLeverage,undefined);
 const selected=select(h.a,plan(),quote,meta,NOW);assert.equal(selected.type,'SELECTED');assert(D(selected.plan.sizing.risk).lte(3));assert(D(selected.plan.sizing.risk).gt(1));assert(D(selected.plan.sizing.exposure).lte(900));
});
test('up to 5x is chosen only when needed and metadata permits it; stop and net-cost guards remain',()=>{
 const h=setup();initializeSecondaryRisk(h.s,NOW,true);h.lab.maintain();h.a.cash='95';
 const policy={...accountRiskPolicy(h.a),risk:'.01',fee:'0',slippage:'0'};
 const x=marginRiskPlan(plan(),h.a,quote,meta,policy);assert.equal(x.leverage,5);assert(D(x.risk).lte(3));assert(D(x.reserved).lte(65));
 assert(marginRiskPlan(plan(),h.a,quote,{...meta,leverage_buy:[2,3]},policy).reason);
 const costly=marginRiskPlan({...plan(),target:'100.1'},h.a,quote,meta,accountRiskPolicy(h.a));assert.equal(costly.reason,'NET_RR_TOO_LOW');
 const unsafe=marginRiskPlan({...plan(),stop:'80',target:'200'},h.a,quote,meta,{...policy,marginLeverage:[5]});assert.equal(unsafe.reason,'STOP_TOO_CLOSE_TO_LIQUIDATION');
});
test('simultaneous entries share 2 percent risk and cancel when daily budget is breached',()=>{
 const h=setup();initializeSecondaryRisk(h.s,NOW,true);h.lab.maintain();
 for(let i=0;i<3;i++)select(h.a,plan(i),quote,meta,NOW);assert(D(h.a.openRiskReserved).lte(6));assert(orders(h.a).length<=3);
 h.a.cash='291';const f={quote,trade:{price:'101',event_at:NOW}};step(h.a,f,NOW);
 assert.equal(orders(h.a).length,0);assert.equal(select(h.a,plan(10),quote,meta,NOW).type,'SUPPRESSED');
});
test('account drawdown limit follows the profile after serialization, and historical maximum survives',()=>{
 const h=setup();initializeSecondaryRisk(h.s,NOW,true);h.lab.maintain();const a=JSON.parse(JSON.stringify(h.a));
 a.cash='282';mark(a,quote,NOW);assert.equal(a.halted,false);a.cash='269';mark(a,quote,NOW);assert.equal(a.halted,true);assert(+a.maxDrawdown>.1);
 a.riskProfile.protocol_hash='bad';assert.throws(()=>mark(a,quote,NOW),/MISMATCH/);
});
test('changed risk starts a separate research round and projection and notice show its real settings',()=>{
 const h=setup(),old=h.s.laboratory.active;initializeSecondaryRisk(h.s,NOW,true);h.lab.maintain();const current=h.s.laboratory.active;
 assert.notEqual(current,old);assert(current.includes(R.version));assert(h.s.laboratory.execution_archives.some(x=>x.active===old));assert.equal(h.lab.trial().training,0);
 h.lab.maintain();assert.equal(h.s.laboratory.active,current);assert.equal(h.events.filter(e=>e.type==='SECONDARY_RISK_ENABLED').length,1);
 const d=projectMonitor({states:[{state:h.s}],now:NOW});assert.equal(d.secondary_risk.status,'ACTIVE');assert.equal(d.frequency.risk_profile.targetEquity,'300');assert.equal(d.account.equity,'100');
 const text=renderNotice({kind:'VERSION',payload:h.events.find(e=>e.type==='SECONDARY_RISK_ENABLED')},{},NOW);assert.match(text,/300.00 USD ficticios/);assert.match(text,/5×/);assert.match(text,/Abrir panel/);
});
test('growth-profile evidence cannot automatically promote the different risk policy to primary',()=>{
 const h=setup(),t=h.lab.trial();t.riskProfile=R.version;t.training=100;t.frames=Object.fromEntries([1,15,60,240].map(tf=>[tf,{training:25,validation:50}]));
 t.validation={after:NOW,clean:200,closed:200,net:5,fees:1,notional:100,drawdown:.01,incomplete:0,unresolved:0,days:Array.from({length:90},(_,i)=>({day:new Date(NOW+(i+1)*DAY).toISOString().slice(0,10),secondary:.0005,primary:.0001,valid:true}))};
 assert.equal(promotionReport(t,NOW+100*DAY).status,'REQUIRES_PRIMARY_RISK_VALIDATION');
 t.status='ELIGIBLE_PAPER';t.report={status:'ELIGIBLE_PAPER'};assert.equal(h.lab.promote(t,NOW+100*DAY),false);
});
test('emergency refills still require strictly less than 1 USD and stay distinct from the capital increase',()=>{
 const h=setup();initializeSecondaryRisk(h.s,NOW,true);h.lab.maintain();h.a.cash=h.a.equity='1';assert.equal(refillSecondary(h.s,NOW),null);
 h.a.cash=h.a.equity='.99';h.a.net='-299.01';const e=refillSecondary(h.s,NOW);assert.equal(e.after,'300');assert.equal(e.amount,'299.01');assert.equal(h.a.net,'-299.01');assert.equal(h.s.laboratory.funding.count,1);
 assert.equal(h.s.laboratory.funding.history.length,2);assert.equal(refillSecondary(h.s,NOW),null);
});
test('a requested profile stops new entry evaluation while legacy reservations finish',async()=>{
 const h=setup();initializeSecondaryRisk(h.s,NOW,true);
 h.a.pendingOrders.legacy={plan:{id:'legacy'}};
 h.lab.now=()=>NOW+2000;h.lab.trial().frameCutoffs[1]=NOW-60000;
 const before=h.s.frequency.counts.evaluations;
 await h.lab.boundary();
 assert.equal(h.s.secondaryRisk.status,'WAITING_FLAT');
 assert.equal(h.s.frequency.counts.evaluations,before);
 assert.equal(h.a.cash,'100');assert(h.a.pendingOrders.legacy);
});
