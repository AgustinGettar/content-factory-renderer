import test from 'node:test';import assert from 'node:assert/strict';
import {DashboardPublisher,liveBody,LIVE_PUBLISH_MS,DETAIL_PUBLISH_MS} from '../lib/trading/dashboard-publisher.js';
import {initialState} from '../lib/trading/engine.js';
const NOW=Date.parse('2026-10-31T01:00:00Z');
function harness(){
 let now=NOW,revision=4;const calls=[],metadata=[];const state=initialState(NOW);
 const row=()=>({state,revision,updated_at:new Date(now).toISOString(),lease_until:new Date(now+45000).toISOString()});
 const store={row,latest:()=>[],notices:()=>[],db:{prepare:()=>({run:(k,v)=>metadata.push(JSON.parse(v))})}};
 const feed={state:{connected:true,reconciled:true,system:'online',clock:{checked_at:NOW,error_ms:0},quote:{ask:'100.1',bid:'100',event_at:NOW,received_at:NOW},trade:{price:'100',event_at:NOW,received_at:NOW}},metadata:{status:'online',checked_at:NOW},counters:{quotes:1,trades:1,reconnects:0}};
 const publisher=new DashboardPublisher({store,feed,env:{},now:()=>now,fetchImpl:async(url,options)=>{const body=JSON.parse(options.body);calls.push({url,body});return Response.json({revision:body.revision});}});publisher.backup=async()=>{};
 return {publisher,calls,metadata,state,tick:n=>{now+=n;revision++;}};
}
test('live body omits candle evidence without changing authoritative balances, plans or net exits',()=>{
 const evidence={panels:[{candles:Array.from({length:120},()=>({open:1,close:2,high:3,low:1}))}]},plan={id:'p',hash:'h',entry:'100',sizing:{risk:'3'},evidence};
 const d={schema:1,revision:4,generated_at:NOW,account:{equity:'299',positions:[{plan,live_exit:{net:'0.25'}}]},operations:[{id:'p',plan}]},before=structuredClone(d),fast=JSON.parse(liveBody(d));
 assert.deepEqual(d,before);assert.equal(fast.account.positions[0].live_exit.net,'0.25');assert.equal(fast.operations[0].plan.hash,'h');assert.equal(fast.operations[0].plan.evidence,undefined);assert.equal(fast.operations[0].plan.evidence_available,true);assert.equal(fast.refresh_ms,2000);assert(liveBody(d).length<JSON.stringify(d).length/10);
});
test('large historical proofs and contracts stay in detail while live preserves closures, partials and current protection',()=>{
 const proof={quote:{bid:'100000',ask:'100001'},panels:Array.from({length:40},()=>({values:'x'.repeat(1000)}))},plan={id:'p',hash:'signed-plan',timeframe:5,entry:'100000',stop:'99000',target:'101000',sizing:{qty:'0.003',exposure:'300',initial_margin:'150',leverage:2},execution_contract:{version:'execution-v1',mode:'TAKER_IOC',largeProof:proof},exit_policy:{version:'secondary-net-protection-2.0.0',target_activation_required:false},entry_economics:{expected_net_target:'.60',minimum_expected_net_target:'.60',quote:proof},evidence:proof};
 const protection={state:'TRAILING_ACTIVE',protected_net:'.30',peak_net:'.40',required_activation_net:'.08',activation_evidence:proof,peak_evidence:proof,floor_evidence:proof};
 const close={type:'CLOSED',id:'old',at:NOW,ledger:'FREQUENT_PAPER',plan,pnl:'0.2460525197',fill_pnl:'.10',reason:'MANUAL_PROFIT',management_override:true,profit_protection:protection,execution_receipt:proof};
 const d={revision:4,feed:{quote:{bid:'100000',ask:'100001'}},frequency:{account:{cash:'299.25',positions:[{qty:'.003',plan,profit_protection:protection,exit_intent:{id:'durable',reason:'TRAILING_RETRACEMENT'},live_exit:{net:'.25',fresh:true}}]},history:Array.from({length:40},(_,i)=>({...close,id:'old-'+i}))}},before=structuredClone(d),detail=JSON.stringify(d),fast=JSON.parse(liveBody(d));
 assert.deepEqual(d,before);assert(detail.includes('largeProof'));assert(liveBody(d).length<detail.length/20);assert.equal(fast.frequency.account.cash,'299.25');assert.equal(fast.feed.quote.bid,'100000');
 const active=fast.frequency.account.positions[0];assert.equal(active.plan.hash,'signed-plan');assert.equal(active.plan.exit_policy.target_activation_required,false);assert.equal(active.profit_protection.protected_net,'.30');assert.equal(active.profit_protection.floor_evidence,undefined);assert.equal(active.exit_intent.id,'durable');assert.equal(active.live_exit.net,'.25');
 const event=fast.frequency.history[0];assert.equal(event.pnl,'0.2460525197');assert.equal(event.fill_pnl,'.10');assert.equal(event.reason,'MANUAL_PROFIT');assert.equal(event.management_override,true);assert.equal(event.plan.sizing.initial_margin,'150');assert.equal(event.plan.execution_contract.largeProof,undefined);assert.equal(event.plan.versions.exit,'secondary-net-protection-2.0.0');
});
test('two-second state publications continue during backup; unchanged detail waits for fifteen seconds',async()=>{
 const h=harness();let finish;h.publisher.backup=()=>new Promise(r=>finish=r);
 await h.publisher.publish();assert.equal(h.publisher.backupBusy,true);assert.equal(h.calls.length,2);
 h.tick(LIVE_PUBLISH_MS);await h.publisher.publish();assert.equal(h.calls.length,3);assert(h.calls[2].url.endsWith('/api/aws/live'));
 h.tick(DETAIL_PUBLISH_MS);await h.publisher.publish();assert.equal(h.calls.length,5);assert.equal(h.metadata.at(-1).interval_ms,2000);assert(h.metadata.at(-1).live_bytes>0);
 finish();await h.publisher.backupTask;assert.equal(h.publisher.backupBusy,false);assert(h.metadata.at(-1).backup_at>=NOW);
});
test('receipt must acknowledge the posted revision and failures preserve last successful timestamp',async()=>{
 const h=harness();await h.publisher.publish();await h.publisher.backupTask;const before=h.publisher.lastSuccess;
 h.tick(2000);h.publisher.fetchImpl=async()=>Response.json({revision:999});await h.publisher.publish();assert.equal(h.publisher.lastSuccess,before);assert.equal(h.publisher.error,'DASHBOARD_RECEIPT_INVALID');
});
test('overlapping publishes are skipped and failed detail does not erase successful live delivery',async()=>{
 const h=harness();let release;h.publisher.fetchImpl=async(url,o)=>{h.calls.push(url);if(url.endsWith('/live'))await new Promise(r=>release=r);return url.endsWith('/snapshot')?new Response('',{status:503}):Response.json({revision:JSON.parse(o.body).revision});};
 const first=h.publisher.publish();await h.publisher.publish();assert.equal(h.calls.length,1);release();await first;await h.publisher.backupTask;assert.equal(h.calls.length,2);assert.equal(h.publisher.error,null);assert.equal(h.publisher.detailError,'DASHBOARD_DETAIL_UNAVAILABLE');assert.equal(h.publisher.lastSuccess,NOW);
});
