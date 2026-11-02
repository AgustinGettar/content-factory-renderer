// Isolated causal series and context checks. No account, feed or operational rows.
import test from 'node:test';
import assert from 'node:assert/strict';
import {D} from '../lib/trading/core.js';
import {entryCandidates,ENTRY_REVISION} from '../lib/trading/secondary-entry-context.js';
import {buildEntryContext,evaluateEntryContext,evaluateEntryEconomics} from '../lib/trading/secondary-entry-economics.js';
import {PROFIT_POLICY,PROFIT_ENTRY_REVISION,makeProfitContracts,validateProfitContracts} from '../lib/trading/secondary-profit-policy.js';
import {EXPLORATION_POLICY,EXPLORATION_ENTRY_REVISION} from '../lib/trading/secondary-exploration.js';
const C=Date.parse('2026-11-02T02:00:00Z'),T=C+2000,META={tick_size:.01,qty_step:.0001};
const quote=(price,at=T)=>({source:'KRAKEN_FUTURES_WS_TICKER',symbol:'PF_XBTUSD',event_at:at,received_at:at,bid:String(price),ask:D(price).plus('.01').toString(),bid_qty:'100',ask_qty:'100'});
const bars=(tf,fn,length=96)=>Array.from({length},(_,i)=>({start:C-(96-i)*tf*60000,end:C-(95-i)*tf*60000,volume:1,...fn(i)}));
function fixture(pattern){
 if(pattern==='BREAKOUT'){
  const s={5:bars(5,()=>({open:199.9,high:200.2,low:199.7,close:199.9})),15:bars(15,()=>({open:199.9,high:200.2,low:199.7,close:199.9}))};
  Object.assign(s[5].at(-1),{open:199.9,high:200.9,low:199.9,close:200.8,volume:2});return {s,price:200.8};
 }
 if(pattern==='PULLBACK'){
  const fn=i=>({open:190+i*.1-.01,close:190+i*.1,low:190+i*.1-.03,high:190+i*.1+.06}),s={5:bars(5,fn),15:bars(15,fn)};
  s[5].at(-5).high=200;Object.assign(s[5].at(-1),{open:199.45,close:199.6,low:198.8,high:199.65});return {s,price:199.6};
 }
 const s={5:bars(5,i=>{const p=i%2?201:199;return {open:p,close:p,low:p-.1,high:p+.1};}),15:bars(15,()=>({open:200,close:200,low:199.9,high:200.1}))};
 Object.assign(s[5].at(-1),{open:198.2,close:198.3,low:197.7,high:198.5});return {s,price:198.3};
}
const invert=s=>Object.fromEntries(Object.entries(s).map(([tf,b])=>[tf,b.map(x=>({...x,open:400-x.open,close:400-x.close,high:400-x.low,low:400-x.high}))]));
const candidate=(pattern,s,price,rate=0,policy=PROFIT_POLICY)=>entryCandidates(s,quote(price),META,C,T,rate,EXPLORATION_POLICY,policy).find(row=>row.pattern===pattern);

for(const pattern of ['BREAKOUT','PULLBACK','RANGE_REENTRY'])test(pattern+' detection and barriers stay unchanged while a separate new contract governs admission',()=>{
 const {s,price}=fixture(pattern);
 for(const [series,mark,direction] of [[s,price,'LONG'],[invert(s),400-price-.01,'SHORT']]){
  const old=candidate(pattern,series,mark,0,null),current=candidate(pattern,series,mark);
  assert(old.plan,JSON.stringify(old));assert(current.plan,JSON.stringify(current));
  assert.equal(current.facts.pattern_detected,true);assert.equal(current.facts.trigger,old.facts.trigger);assert.equal(current.plan.direction,direction);
  for(const key of ['entry','stop','target','execution_contract','quality'])assert.deepEqual(current.plan[key],old.plan[key]);
  assert.equal(current.plan.entry_revision,PROFIT_ENTRY_REVISION);assert.equal(old.plan.entry_revision,EXPLORATION_ENTRY_REVISION);assert.notEqual(current.plan.signal_key,old.plan.signal_key);
  assert.equal(validateProfitContracts(current.plan),true);assert.equal(old.plan.economic_policy,undefined);assert.equal(old.plan.exit_policy,undefined);
  assert.equal(current.plan.entry_context.data_basis,'CLOSED_CAUSAL_5M_BARS');assert.equal(current.plan.entry_context.confirmation_at,C);assert(current.plan.entry_context.confirmation_event_at<=C);
  const receipt=evaluateEntryEconomics(current.plan,{quote:quote(mark),qty:D(100).div(current.plan.entry).div('.0001').floor().mul('.0001').toString(),fundingRate:0,now:T});
  assert.equal(receipt.applied,true);assert.equal(evaluateEntryContext(current.plan,[]).accepted,true);
 }
});

test('negative target economics remains a recorded detected pattern rather than becoming a missing signal',()=>{
 const {s,price}=fixture('BREAKOUT'),normal=candidate('BREAKOUT',s,price),costly=candidate('BREAKOUT',s,price,100);
 assert(costly.plan);assert.equal(costly.reason,'CANDIDATE');assert.equal(costly.facts.pattern_detected,true);assert.equal(costly.plan.quality.classification,'COSTS_NOT_COVERED');
 assert.equal(costly.plan.target,normal.plan.target);assert.equal(costly.plan.stop,normal.plan.stop);
 const receipt=evaluateEntryEconomics(costly.plan,{quote:quote(price),qty:'.49',fundingRate:100,now:T});assert.equal(receipt.accepted,false);assert.equal(receipt.reason,'EXPECTED_NET_TARGET_BELOW_MINIMUM');assert(D(receipt.expected_net_target).lt(0));
});

test('profit policy does not manufacture signals when the pattern is absent',()=>{
 const {s,price}=fixture('BREAKOUT');Object.assign(s[5].at(-1),{open:199.9,close:199.9,high:200.2,low:199.7,volume:1});
 const decisions=entryCandidates(s,quote(price),META,C,T,0,EXPLORATION_POLICY,PROFIT_POLICY);assert.equal(decisions.length,3);assert(decisions.every(row=>!row.plan));assert(decisions.every(row=>row.facts.entry_revision===PROFIT_ENTRY_REVISION));
});

test('future candles and unavailable observations cannot alter new contracts or causal signal keys',()=>{
 const {s,price}=fixture('BREAKOUT'),before=candidate('BREAKOUT',s,price);
 for(const tf of [5,15]){
  s[tf].push({...s[tf].at(-1),start:C,end:C+tf*60000,close:9999,high:9999});
  s[tf].push({...s[tf].at(-2),available_at:T+1000,close:9998,high:9998});
 }
 assert.deepEqual(candidate('BREAKOUT',s,price),before);
 const noExploration=entryCandidates(fixture('BREAKOUT').s,quote(price),META,C,T,0,null,PROFIT_POLICY).find(row=>row.pattern==='BREAKOUT');assert.equal(noExploration.plan.entry_revision,ENTRY_REVISION);assert.equal(noExploration.plan.economic_policy,undefined);
});

function context(pattern,b,direction='LONG',trigger){return buildEntryContext({pattern,direction,bars:b,tickSize:'.01',entry:direction==='LONG'?200:300,target:direction==='LONG'?240:260,trigger,cutoff:b.at(-1).end});}
test('successive breakout bars identify one movement; a later fresh break after an inside bar is a new confirmation',()=>{
 const b=bars(5,()=>({open:100,close:100,low:99,high:101}),98);
 for(let i=92;i<96;i++)Object.assign(b[i],{open:100+i-92,close:101.5+i-92,low:99.8+i-92,high:102+i-92});
 Object.assign(b[96],{open:104.5,close:104,low:103.5,high:104.8});Object.assign(b[97],{open:104,close:106,low:104,high:106.2});
 const first=context('BREAKOUT',b.slice(0,93)),continuation=context('BREAKOUT',b.slice(0,96)),fresh=context('BREAKOUT',b);
 assert.equal(first.confirmation_event_start_at,b[92].start);assert.equal(continuation.confirmation_key,first.confirmation_key);assert.equal(continuation.structure_key,first.structure_key);
 assert.notEqual(fresh.confirmation_key,first.confirmation_key);assert.equal(fresh.confirmation_event_start_at,b[97].start);
});

test('a continuous EMA retest is one confirmation for both LONG and SHORT; a separated retest permits a new one',()=>{
 const b=bars(5,i=>({open:100+i-.1,close:100+i,low:100+i-.2,high:100+i+.2}),97);
 Object.assign(b[92],{low:187});Object.assign(b[93],{low:188});Object.assign(b[94],{low:189});Object.assign(b[96],{low:191});
 for(const [series,direction] of [[b,'LONG'],[b.map(x=>({...x,open:500-x.open,close:500-x.close,high:500-x.low,low:500-x.high})),'SHORT']]){
  const first=context('PULLBACK',series.slice(0,93),direction,'SAME_CANDLE_PULLBACK'),same=context('PULLBACK',series.slice(0,95),direction,'PRIOR_CANDLE_PULLBACK'),fresh=context('PULLBACK',series,direction,'SAME_CANDLE_PULLBACK');
  assert.equal(first.confirmation_event_start_at,series[92].start);assert.equal(same.confirmation_key,first.confirmation_key);assert.notEqual(fresh.confirmation_key,first.confirmation_key);assert.equal(fresh.confirmation_event_start_at,series[96].start);
 }
});

test('continuous range excursions retain a key and a fresh excursion after recovery gets another',()=>{
 const b=bars(5,i=>{const p=i%2?101:99;return {open:p,close:p,low:p-.1,high:p+.1};});
 Object.assign(b[92],{open:98.3,close:98.5,low:97.5,high:98.7});Object.assign(b[93],{open:98.5,close:98.7,low:97.8,high:98.9});Object.assign(b[94],{open:100,close:100,low:99.9,high:100.1});Object.assign(b[95],{open:98.3,close:98.7,low:97,high:98.9});
 const first=context('RANGE_REENTRY',b.slice(0,93),'LONG','WICK_REENTRY'),same=context('RANGE_REENTRY',b.slice(0,94),'LONG','PRIOR_CANDLE_REENTRY'),fresh=context('RANGE_REENTRY',b,'LONG','WICK_REENTRY');
 assert.equal(first.confirmation_event_start_at,b[92].start);assert.equal(same.confirmation_key,first.confirmation_key);assert.notEqual(fresh.confirmation_key,first.confirmation_key);assert.equal(fresh.confirmation_event_start_at,b[95].start);
});

function contextPlan(id,overrides={}){
 return {id,pattern:'PULLBACK',direction:'SHORT',entry:'80000',stop:'81000',target:'78000',confirmed_at:200,
  ...makeProfitContracts(PROFIT_POLICY),entry_context:{version:'secondary-entry-context-economics-1.0.0',structure_key:'structure-a',movement_key:'structure-a',confirmation_key:'episode-a',confirmation_event_at:150,confirmation_at:200,price_tick:'1',remaining_distance:'2000',remaining_distance_fraction:'.025'},...overrides};
}
test('pending orders and open positions prevent a repeated confirmation without mutating their targets or states',()=>{
 const old=contextPlan('first'),fresh=contextPlan('candidate',{confirmed_at:300}),rows=[{plan:old,qty:'.0012',entry:'79999',state:'OPEN_BEFORE_TARGET'},{plan:{...old,id:'pending'},remaining_qty:'.0012'}],before=structuredClone(rows);
 const receipt=evaluateEntryContext(fresh,rows);assert.equal(receipt.accepted,false);assert.equal(receipt.reason,'REPEATED_CONFIRMATION');assert.deepEqual(receipt.related_position_ids,['first','pending']);assert.deepEqual(rows,before);
});

test('a changed key alone cannot turn an old retest into a new opportunity',()=>{
 const previous=contextPlan('first'),current=contextPlan('candidate',{confirmed_at:300});current.entry_context={...current.entry_context,confirmation_key:'different-label',confirmation_event_at:199};
 const receipt=evaluateEntryContext(current,[{plan:previous,qty:'.0012'}]);assert.equal(receipt.accepted,false);assert.equal(receipt.reason,'LATE_REPETITION_NO_NEW_CONFIRMATION');
});

test('a genuinely later confirmation may add to a shared target while retaining independent plans',()=>{
 const previous=contextPlan('first'),current=contextPlan('candidate',{confirmed_at:400,entry:'79500'});current.entry_context={...current.entry_context,confirmation_key:'episode-b',confirmation_event_at:350,confirmation_at:400};
 current.entry_economics={expected_net_target:'0.35',minimum_expected_net_target:'0.1908'};
 const receipt=evaluateEntryContext(current,[{plan:previous,qty:'.0012'}]);assert.equal(receipt.accepted,true);assert.equal(receipt.reason,'ADDITION_NEW_CONFIRMATION');assert.equal(receipt.expected_net_target,'0.35');assert.equal(receipt.related_positions[0].shared_target,true);assert.equal(previous.target,'78000');
});

test('old open contracts require a new confirmation for a shared target but are never rewritten',()=>{
 const legacy={id:'legacy',pattern:'PULLBACK',direction:'SHORT',entry:'80000',target:'78000',confirmed_at:200},before=structuredClone(legacy),candidate=contextPlan('candidate');
 assert.equal(evaluateEntryContext(candidate,[{plan:legacy}]).reason,'LATE_REPETITION_NO_NEW_CONFIRMATION');
 candidate.entry_context.confirmation_event_at=201;assert.equal(evaluateEntryContext(candidate,[{plan:legacy}]).accepted,true);assert.deepEqual(legacy,before);
});

test('unrelated patterns, directions and structures do not create a global position veto',()=>{
 const current=contextPlan('candidate'),rows=[contextPlan('other-pattern',{pattern:'BREAKOUT'}),contextPlan('other-direction',{direction:'LONG'}),contextPlan('other-target',{target:'77000',entry_context:{structure_key:'different',confirmation_key:'different'}})];
 const receipt=evaluateEntryContext(current,rows);assert.equal(receipt.accepted,true);assert.equal(receipt.classification,'NEW_OPPORTUNITY');assert.deepEqual(receipt.related_position_ids,[]);
 assert.equal(evaluateEntryContext(current,[{plan:current}]).accepted,true,'self is excluded during per-fill revalidation');
});

test('context missing from a new plan fails visibly while a legacy plan keeps its original contract',()=>{
 const current=contextPlan('new');delete current.entry_context;assert.equal(evaluateEntryContext(current,[]).reason,'ENTRY_CONTEXT_REQUIRED');
 delete current.economic_policy;assert.equal(evaluateEntryContext(current,[]).reason,'LEGACY_ENTRY_POLICY');
});
