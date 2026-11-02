// Isolated manual-control receipts. These fixtures do not reach a real worker,
// exchange, Telegram transport, live database or operational PAPER portfolio.
import test from 'node:test';
import assert from 'node:assert/strict';
import {D,hash} from '../lib/trading/core.js';
import {acceptControl,checkControls,settleControl} from '../lib/trading/paper-controls.js';
import {EXIT_VERSION} from '../lib/trading/paper-exits.js';
import {SECONDARY_MODEL} from '../lib/trading/secondary-futures-math.js';
import {PROFIT_POLICY,PROFIT_ENTRY_REVISION,makeProfitContracts} from '../lib/trading/secondary-profit-policy.js';
import {initializeProfitProtection,markProfitExitPending,scaleProfitProtection} from '../lib/trading/secondary-profit-protection.js';

const T=Date.parse('2026-11-02T12:00:00Z');
const copy=x=>JSON.parse(JSON.stringify(x));
function position(id,{legacy=false,principal=false}={}){
 const plan={id,execution_model:principal?'lumi-margin-paper-1.0.0':SECONDARY_MODEL,direction:'LONG',entry_revision:PROFIT_ENTRY_REVISION,entry:'100',stop:'99',target:'101',holding_ms:1800000,sizing:{target_net:'0.5'},...(!legacy&&!principal?makeProfitContracts(PROFIT_POLICY):{})};
 plan.hash=hash(plan);const p={plan,qty:'1',entry:'100',entry_fee:'.05',accrued_funding:'0',entered_at:T,expires_at:T+1800000};
 if(plan.exit_policy)initializeProfitProtection(p,T);return p;
}
function fixture(){
 const primary=position('primary',{principal:true}),newPositions=Object.fromEntries(['one','two','three','four'].map(id=>[id,position(id)])),legacy=position('legacy',{legacy:true});
 return {exitManagement:{version:EXIT_VERSION},controls:{receipts:[]},frequency:{account:{portfolio:{},positions:{...newPositions,legacy}}},research:{active:'active',versions:{active:{account:{portfolio:{},positions:{primary}}}}}};
}
function command(p,{id='00000000-0000-4000-8000-000000000001',ledger='FREQUENT_PAPER',action='CLOSE',mode='ANY',...extra}={}){
 return {id,ledger,operation_id:p.plan.id,plan_hash:p.plan.hash,action,mode,created_at:T,expires_at:T+120000,...extra};
}

test('new trailing contracts reject SET_NET_GOAL explicitly and idempotently without changing plan or position',()=>{
 const s=fixture(),p=s.frequency.account.positions.one,before=copy(p),events=[],c=command(p,{action:'SET_NET_GOAL',net_goal:'0.02'});
 const result=acceptControl(s,c,T,e=>events.push(e));assert.equal(result.status,'REJECTED');assert.equal(result.reason,'IMMUTABLE_TRAILING_EXIT_CONTRACT');assert.deepEqual(p,before);
 const retry=acceptControl(s,copy(c),T+1000,e=>events.push(e));assert.deepEqual(retry,result);assert.equal(s.controls.receipts.length,1);assert.equal(events.length,1);
});

test('manual CLOSE targets exactly the requested operation ID and leaves three peers, legacy and primary untouched',()=>{
 const s=fixture(),p=s.frequency.account.positions.two,others=copy({...s.frequency.account.positions,two:undefined}),primary=copy(s.research),c=command(p),events=[];
 const r=acceptControl(s,c,T,e=>events.push(e));assert.equal(r.status,'WAITING_MARKET');assert.equal(p.close_request.id,c.id);assert.equal(p.close_request.mode,'ANY');
 assert.deepEqual({...s.frequency.account.positions,two:undefined},{...others,two:undefined});assert.deepEqual(s.research,primary);
 acceptControl(s,{...c,operation_id:'three',plan_hash:s.frequency.account.positions.three.plan.hash},T+1000,e=>events.push(e));assert.equal(s.frequency.account.positions.three.close_request,undefined);assert.equal(events.length,1);
 settleControl(s,{type:'CLOSED',id:'one',ledger:'FREQUENT_PAPER',at:T+3000,reason:'STOP',pnl:'-.1'});assert.equal(r.status,'WAITING_MARKET');
 settleControl(s,{type:'CLOSED',id:'two',ledger:'ENGINE',at:T+3000,reason:'STOP',pnl:'-.1'});assert.equal(r.status,'WAITING_MARKET');
 settleControl(s,{type:'CLOSED',id:'two',ledger:'FREQUENT_PAPER',at:T+3000,reason:'MANUAL_CLOSE',pnl:'-.1'});assert.equal(r.status,'CLOSED');assert.equal(r.pnl,'-.1');assert.deepEqual(s.research,primary);
});

test('legacy secondary and existing primary goal controls preserve their original behavior',()=>{
 const s=fixture(),legacy=s.frequency.account.positions.legacy,primary=s.research.versions.active.account.positions.primary,newBefore=copy(s.frequency.account.positions.one);
 for(const [p,ledger,id] of [[legacy,'FREQUENT_PAPER','00000000-0000-4000-8000-000000000011'],[primary,'ENGINE','00000000-0000-4000-8000-000000000012']]){
  const frozen=copy(p.plan),r=acceptControl(s,command(p,{id,ledger,action:'SET_NET_GOAL',net_goal:'0.20'}),T,()=>{});assert.equal(r.status,'APPLIED');assert.equal(r.reason,'NET_GOAL_UPDATED');assert.equal(p.management.net_goal,'0.20');assert.deepEqual(p.plan,frozen);
 }
 assert.deepEqual(s.frequency.account.positions.one,newBefore);
});

test('a selected durable manual exit survives partial fill, receipt expiry, adverse net and restart until its own CLOSED result',()=>{
 const s=fixture(),p=s.frequency.account.positions.one,events=[],r=acceptControl(s,command(p,{mode:'PROFIT'}),T,e=>events.push(e));
 p.exit_intent={reason:'MANUAL_PROFIT',decided_at:T+2000,evidence_at:T+2000,evidence_received_at:T+2000,not_before:T+3000,valid_until:null};markProfitExitPending(p,p.exit_intent);
 p.closed_qty='.4';p.qty='.6';p.entry_fee=D(p.entry_fee).mul('.6').toString();scaleProfitProtection(p,'1','.6',T+4000);
 const restored=copy(s),q=restored.frequency.account.positions.one;const request=copy(q.close_request),pending=copy(q.exit_intent);
 q.execution_quote={source:'KRAKEN_FUTURES_WS_TICKER',symbol:'PF_XBTUSD',bid:'98',ask:'98.01',bid_qty:'0',ask_qty:'0',event_at:T+121000,received_at:T+121000};
 checkControls(restored,{},T+121000,e=>events.push(e));const receipt=restored.controls.receipts[0];assert.equal(receipt.status,'WAITING_MARKET');assert.equal(receipt.reason,'DURABLE_EXIT_PENDING');assert.deepEqual(q.close_request,request);assert.deepEqual(q.exit_intent,pending);assert.equal(q.profit_protection.state,'PARTIALLY_CLOSED');
 const count=events.length;checkControls(restored,{},T+122000,e=>events.push(e));assert.equal(events.length,count);assert.equal(receipt.status,'WAITING_MARKET');
 settleControl(restored,{type:'CLOSED',ledger:'FREQUENT_PAPER',id:'one',at:T+123000,reason:'MANUAL_PROFIT',pnl:'-.3',price:'98',fees:'.1'});assert.equal(receipt.status,'CLOSED');assert.equal(receipt.pnl,'-.3');assert.equal(receipt.at,T+123000);assert.equal(r.status,'WAITING_MARKET');
});

test('untriggered new requests and all legacy requests keep the original expiry semantics',()=>{
 const s=fixture(),a=s.frequency.account.positions.one,b=s.frequency.account.positions.legacy;
 acceptControl(s,command(a),T,()=>{});acceptControl(s,command(b,{id:'00000000-0000-4000-8000-000000000002'}),T,()=>{});
 // A legacy selected exit does not silently adopt the new durable contract.
 b.exit_intent={reason:'MANUAL_CLOSE',valid_until:null};checkControls(s,{},T+120001,()=>{});
 assert(s.controls.receipts.every(r=>r.status==='EXPIRED'&&r.reason==='REQUEST_EXPIRED'));assert.equal(a.close_request,undefined);assert.equal(b.close_request,undefined);
});
