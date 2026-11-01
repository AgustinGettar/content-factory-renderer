import test from 'node:test';
import assert from 'node:assert/strict';
import {hash} from '../lib/trading/core.js';
import {secondaryCandidates as original} from '../lib/trading/secondary-futures-engine.js';
import {secondaryCandidates,SECONDARY_PROTOCOL,SecondaryBroker} from '../lib/trading/secondary-futures.js';
import {ENTRY_REVISION,ENTRY_RULES,installEntryRevision} from '../lib/trading/secondary-entry-context.js';
import {newAccount} from '../lib/trading/simulator.js';
import {enablePortfolio} from '../lib/trading/portfolio.js';
const C=Date.parse('2026-11-01T21:00:00Z'),NOW=C+2000,meta={tick_size:.01,qty_step:.0001};
const quote=(price=200.8,now=NOW)=>({source:'KRAKEN_FUTURES_WS_TICKER',symbol:'PF_XBTUSD',event_at:now,received_at:now,bid:String(price),ask:String(price+.01),bid_qty:'100',ask_qty:'100',suspended:false});
function fixture(){const series={5:[],15:[]};for(const tf of [5,15])for(let i=0;i<96;i++)series[tf].push({start:C-(96-i)*tf*60000,end:C-(95-i)*tf*60000,open:199.9,high:200.2,low:199.7,close:199.9,volume:1});Object.assign(series[5].at(-1),{open:199.9,high:200.9,low:199.9,close:200.8,volume:2});return series;}
function invert(series){return Object.fromEntries(Object.entries(series).map(([k,b])=>[k,b.map(x=>({...x,open:400-x.open,close:400-x.close,high:400-x.low,low:400-x.high}))]));}
test('a confirmed range breakout is not blocked merely because the 15m averages have not crossed',()=>{
 for(const [s,q,direction] of [[fixture(),quote(),'LONG'],[invert(fixture()),quote(199.19),'SHORT']]){
  const old=original(s,q,meta,C,NOW,0).find(x=>x.pattern==='BREAKOUT');assert.equal(old.reason,'WAIT_BREAKOUT');
  const candidate=secondaryCandidates(s,q,meta,C,NOW,0).find(x=>x.pattern==='BREAKOUT');assert.equal(candidate.reason,'CANDIDATE',JSON.stringify(candidate));assert.equal(candidate.plan.direction,direction);assert.equal(candidate.facts.trigger,'RANGE_TRANSITION_BREAKOUT');assert(candidate.plan.economics.netRR>=1.5);assert.equal(candidate.plan.entry_revision,ENTRY_REVISION);
 }
});
test('the new transition must still have volume, a directional candle and no strong opposing context',()=>{
 const low=fixture();low[5].at(-1).volume=.2;const r=secondaryCandidates(low,quote(),meta,C,NOW,0).find(x=>x.pattern==='BREAKOUT');assert.equal(r.reason,'WAIT_BREAKOUT');assert.equal(r.facts.blocked_by,'VOLUME_OR_CANDLE_CONFIRMATION');
 const opposite=fixture();opposite[15]=opposite[15].map((x,i)=>({...x,open:220-i*.2,close:219.9-i*.2,low:219.8-i*.2,high:220.1-i*.2}));const d=secondaryCandidates(opposite,quote(),meta,C,NOW,0).find(x=>x.pattern==='BREAKOUT');assert.equal(d.facts.strong_down,true);assert.equal(d.reason,'WAIT_BREAKOUT');
});
test('cost and structural rejection remain active, even with a valid pattern',()=>{
 const s=fixture(),rate=100;const d=secondaryCandidates(s,quote(),meta,C,NOW,rate).find(x=>x.pattern==='BREAKOUT');assert.equal(d.reason,'COST_OR_NET_RR');assert(d.facts.gain<0);
 const distant=secondaryCandidates(fixture(),quote(210),meta,C,NOW,0).find(x=>x.pattern==='BREAKOUT');assert.equal(distant.reason,'STRUCTURAL_ENTRY_DISTANCE');
});
test('open candles and future corrections cannot change a closed-candle decision',()=>{
 const s=fixture(),before=secondaryCandidates(s,quote(),meta,C,NOW,0);
 for(const tf of [5,15])s[tf].push({...s[tf].at(-1),start:C,end:C+tf*60000,high:99999,close:99999});
 assert.deepEqual(secondaryCandidates(s,quote(),meta,C,NOW,0),before);
 assert(secondaryCandidates(fixture(),{...quote(),symbol:'OTHER'},meta,C,NOW,0).every(x=>x.reason==='FUTURES_DATA_NOT_FRESH'));
 assert(secondaryCandidates(fixture(),quote(),meta,C,NOW,NaN).every(x=>x.reason==='FUNDING_NOT_AVAILABLE'));
});
test('new rule activation does not reset cash, history, losses, halt, cooldown or any risk baseline',()=>{
 const root={frequency:{account:{equity:'469',net:'-31',closed:13}},secondaryExecution:{status:'HALTED_DRAWDOWN',activated_at:1,baseline:{equity:'470.4596514385377772'},peak:'471',day:'2026-11-01',day_start:'470',loss_streak:3,cooldown_until:NOW+10000,counts:{selected:4,filled:1,closed:1}},laboratory:{status:'RESEARCH_COMPLETE'},multiStrategy:{archive:true}};
 const before=structuredClone(root),events=[];assert.equal(installEntryRevision(root,NOW,e=>events.push(e)),true);const rules=root.secondaryExecution.entry_rules;delete root.secondaryExecution.entry_rules;assert.deepEqual(root,before);root.secondaryExecution.entry_rules=rules;assert.equal(rules.hash,hash(ENTRY_RULES));assert.equal(installEntryRevision(root,NOW+1,e=>events.push(e)),false);assert.equal(events.length,1);rules.hash='bad';assert.throws(()=>installEntryRevision(root,NOW+2),/MISMATCH/);
});
test('a transition signal uses the same shared broker and needs a later observed trade to fill',()=>{
 const a=newAccount();enablePortfolio(a);a.cash=a.equity='470.4596514385377772';const root={frequency:{account:a,counts:{evaluations:0,candidates:0,selected:0,filled:0,closed:0},history:[],grossClosed:'0',closedFees:'0',daySelections:0},laboratory:{status:'RESEARCH_COMPLETE'}};let now=NOW;const events=[],b=new SecondaryBroker({root,now:()=>now,event:e=>events.push(e)});
 const c=secondaryCandidates(fixture(),quote(),meta,C,NOW,0).find(x=>x.pattern==='BREAKOUT');assert(c.plan);assert.equal(b.choose(c.plan,quote(),meta,now),'ENTRY_PENDING');assert.equal(Object.keys(a.positions).length,0);
 now+=1100;b.market(quote(200.8,now),null,{[Math.floor(now/3600000)*3600000]:0},now);assert.equal(Object.keys(a.positions).length,0);
 now+=1100;const price=Number(c.plan.entry)-.01;b.market(quote(price-.01,now),{id:'offline-proof',price,side:'sell',qty:100,event_at:now,received_at:now},{[Math.floor(now/3600000)*3600000]:0},now);
 assert.equal(Object.keys(a.positions).length,1);assert.equal(events.filter(x=>x.type==='FILLED').length,1);assert(Number(a.positions[c.plan.id].plan.sizing.risk)<=2);assert.equal(SECONDARY_PROTOCOL.minNetRR,1.5);assert.equal(SECONDARY_PROTOCOL.riskCapUSD,'2');
});
