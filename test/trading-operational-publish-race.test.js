import test from 'node:test';
import assert from 'node:assert/strict';
import {DashboardPublisher} from '../lib/trading/dashboard-publisher.js';
import {attachOperationalProjection} from '../lib/trading/secondary-futures-runtime.js';
import {initialState} from '../lib/trading/engine.js';
import {initializeFrequency} from '../lib/trading/frequency.js';
import {initializeLaboratory} from '../lib/trading/laboratory.js';
import {initializeSecondary} from '../lib/trading/secondary-futures.js';
import {enablePortfolio} from '../lib/trading/portfolio.js';
const NOW=Date.parse('2026-11-02T00:27:24Z'),CUT=Date.parse('2026-11-02T00:25:00Z');
function harness(){
 let revision=4,reads=0;let state=initialState(NOW-7200000);initializeFrequency(state,NOW-7200000);initializeLaboratory(state,NOW-7200000);enablePortfolio(state.frequency.account);state.laboratory.status='RESEARCH_COMPLETE';
 const x=initializeSecondary(state,NOW-7200000);x.counts.evaluations=60;x.market={last_refresh:NOW-1000,closed_at:{5:CUT,15:Date.parse('2026-11-02T00:15:00Z')}};
 x.decisions=Object.fromEntries(['BREAKOUT','PULLBACK','RANGE_REENTRY'].map(pattern=>[pattern,{at:CUT+7000,cutoff:CUT,pattern,timeframe:5,reason:'WAIT_'+pattern,criteria:{atr15:100}}]));state.frequency.lastDecision=x.decisions.BREAKOUT;
 const calls=[],store={row(){reads++;return {state:structuredClone(state),revision,updated_at:new Date(NOW).toISOString(),lease_until:new Date(NOW+45000).toISOString()};},latest:()=>[],notices:()=>[],db:{prepare:()=>({run(){}})}};
 const feed={state:{connected:true,reconciled:true,system:'online',clock:{checked_at:NOW,error_ms:0},quote:{ask:'100.01',bid:'100',event_at:NOW,received_at:NOW},trade:{price:'100',event_at:NOW,received_at:NOW}},metadata:{status:'online',checked_at:NOW},counters:{quotes:1,trades:1,reconnects:0}};
 const publisher=new DashboardPublisher({store,feed,env:{},now:()=>NOW,fetchImpl:async(url,opts)=>{
  const body=JSON.parse(opts.body);calls.push({url,body});
  if(url.endsWith('/live')){revision++;state=structuredClone(state);for(const d of Object.values(state.secondaryExecution.decisions))d.at+=300000;state.secondaryExecution.counts.evaluations+=3;}
  return Response.json({revision:body.revision});
 }});publisher.backup=async()=>{};publisher.lastBackup=NOW;
 attachOperationalProjection(publisher,store,{series:{5:Array.from({length:256},()=>({end:CUT})),15:Array.from({length:256},()=>({end:x.market.closed_at[15]}))}});
 return {publisher,calls,reads:()=>reads,state:()=>state};
}
test('a commit during live upload cannot strip the operational fields from the detail channel',async()=>{
 const h=harness();await h.publisher.publish();assert.equal(h.calls.length,2);
 const [live,detail]=h.calls.map(x=>x.body);assert.equal(live.revision,4);assert.equal(detail.revision,4);
 assert.equal(h.reads(),1,'one decoded committed row for both payloads; no second-row race');
 assert.deepEqual(live.secondary_activity,detail.secondary_activity);assert.equal(live.secondary_activity.last_evaluation_at,CUT+7000);
 assert.equal(detail.laboratory.active,'secondary-futures-1.0.0');assert.equal(detail.laboratory.trials.at(-1).decisions[5].at,CUT+7000);
 assert.equal(detail.timeframes.series[5].bars,256);assert.equal(detail.frequency.execution_status,'ACTIVE_PAPER');
 assert.equal(detail.secondary_activity.pattern_evaluations,60);assert.equal(h.state().secondaryExecution.counts.evaluations,63);
 assert.equal(h.publisher.error,null);assert.equal(h.publisher.detailError,null);
});
test('next live publication advances to the new committed decision instead of resetting the cards',async()=>{
 const h=harness();await h.publisher.publish();await h.publisher.publish();const next=h.calls.at(-1).body;
 assert.equal(next.revision,5);assert.equal(next.secondary_activity.pattern_evaluations,63);assert.equal(next.secondary_activity.last_evaluation_at,CUT+307000);
 assert.equal(next.frequency.account.cash,'100');assert.equal(next.frequency.account.closed,0);assert.equal(next.account.cash,'100');
});
test('legacy serialized send compatibility still uses the actual persisted data and preserves money',async()=>{
 const h=harness();const original=structuredClone(h.state());let output;h.publisher.fetchImpl=async(url,o)=>{output=JSON.parse(o.body);return Response.json({revision:output.revision});};
 await h.publisher.send('api/aws/live',JSON.stringify({revision:4,frequency:{account:{positions:[],cash:'100',closed:0},protocol:{}},laboratory:{status:'RESEARCH_COMPLETE',trials:[]},operations:[]}),4);
 assert.equal(output.secondary_activity.last_evaluation_at,CUT+7000);assert.deepEqual(h.state(),original);assert.equal(output.frequency.account.cash,'100');
});
