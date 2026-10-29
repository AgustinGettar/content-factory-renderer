import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {POLICY,D,riskPlan} from '../lib/trading/core.js';
import {initialState,TradingEngine} from '../lib/trading/engine.js';
import {reconcilePaperCapital} from '../lib/trading/capital.js';
import {newAccount} from '../lib/trading/simulator.js';
import {renderNotice} from '../lib/trading/notifier.js';

function legacy(){
  const s=initialState(1000);delete s.capital;
  s.alert=newAccount({...POLICY,initialCash:'10000'});
  const v=s.research.versions[s.research.active];v.account=newAccount({...POLICY,initialCash:'10000'});v.lastDayEquity=10000;
  s.counters.incidents=37;s.counters.delivered=1;s.counters.candidates=2;s.counters.suppressed=2;s.technicalQueued=true;
  return s;
}
test('new simulated accounts and initial risk budget are exactly USD 100 and 0.25',()=>{
  const s=initialState(1000);assert.equal(s.alert.cash,'100');assert.equal(s.research.versions[s.research.active].account.cash,'100');
  assert.equal(D(POLICY.initialCash).mul(POLICY.risk).toString(),'0.25');assert.equal(reconcilePaperCapital(s,2000),null);
});
test('unused legacy accounts migrate once with preserved observations and an audit snapshot',()=>{
  const s=legacy(),counters=structuredClone(s.counters),e=reconcilePaperCapital(s,2000);
  assert.equal(e.from,'10000');assert.equal(e.to,'100');assert.equal(e.before.accounts[0].cash,'10000');
  for(const a of [s.alert,s.research.versions[s.research.active].account])for(const k of ['cash','equity','peak','dayStart'])assert.equal(a[k],'100');
  assert.equal(s.research.versions[s.research.active].lastDayEquity,100);assert.deepEqual(s.counters,counters);assert(s.technicalQueued);
  assert.equal(reconcilePaperCapital(s,3000),null);
});
test('capital change rejects any filled/open/ambiguous activity without mutating it',()=>{
  for(const patch of [{position:{}},{pending:{}},{closed:1},{fees:'0.01'},{net:'-1'},{cash:'9999'},{wins:1},{ambiguousClosed:1},{halted:true}]){
    const s=legacy();Object.assign(s.alert,patch);const before=structuredClone(s);
    assert.throws(()=>reconcilePaperCapital(s,2000),/UNUSED_LEDGER/);assert.deepEqual(s,before);
  }
  const s=legacy();s.research.campaigns.push({});assert.throws(()=>reconcilePaperCapital(s,2000),/UNUSED_LEDGER/);
});
test('migration, audit event and deduplicated notice commit together; restart does not repeat',async()=>{
  let saved=legacy(),events=[],notices=[];
  const store={async acquire(){return structuredClone(saved)},async commit(state,e,n){saved=structuredClone(state);events.push(...e);notices.push(...n)}};
  await new TradingEngine({store,feed:new EventEmitter(),now:()=>2000}).initialize();
  await new TradingEngine({store,feed:new EventEmitter(),now:()=>3000}).initialize();
  assert.equal(saved.capital.initialCash,'100');assert.equal(events.filter(e=>e.type==='PAPER_INITIAL_CAPITAL_CHANGED').length,1);
  assert.equal(notices.filter(n=>n.payload.type==='PAPER_INITIAL_CAPITAL_CHANGED').length,1);
});
test('USD 100 sizing obeys quarter-dollar risk and refuses exchange minimums instead of raising risk',()=>{
  const plan={direction:'LONG',family:'A',limit:'100000',stop:'99000',target:'106000',atr1:500};
  const q={ask:'99999',bid:'99998',ask_qty:'1',bid_qty:'1'},meta={lot_decimals:8,ordermin:'.00005',costmin:'5'};
  const p=riskPlan(plan,newAccount(),q,meta);assert(!p.reason);assert.equal(p.risk_budget,'0.25');assert(D(p.risk).lte('.25'));assert(D(p.reserved).lte('90'));
  assert.equal(riskPlan(plan,newAccount(),q,{...meta,costmin:'20'}).reason,'MINIMUM_OR_LIQUIDITY');
});
test('capital update and technical messages report USD 100 and never the old amount',()=>{
  const change=reconcilePaperCapital(legacy(),2000),notice={id:'x'.repeat(64),kind:'VERSION',payload:change};
  const text=renderNotice(notice,{},2000);assert.match(text,/100\.00 USD/);assert.match(text,/0\.25 USD/);assert.doesNotMatch(text,/10\.000|10000/);
  const technical=renderNotice({...notice,kind:'TECHNICAL'},{quote:{event_at:2000,bid:'1',ask:'1'},trade:{event_at:2000}},2000);
  assert.match(technical,/100\.00 USD/);assert.doesNotMatch(technical,/10\.000|10000/);
});
