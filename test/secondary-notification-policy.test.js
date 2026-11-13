// Synthetic positions and isolated SQLite only. Telegram is an in-memory double.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SECONDARY_NOTICE_POLICY,configuredSecondaryNoticePolicy,secondaryLifecycleNotice} from '../lib/trading/secondary-notification-policy.js';
import {SecondaryNotifier} from '../lib/trading/secondary-futures-runtime.js';
import {SQLiteStore} from '../lib/trading/sqlite-store.js';
import {initialState} from '../lib/trading/engine.js';
import {D,hash} from '../lib/trading/core.js';
import {SecondaryBroker,secondaryEconomics,SECONDARY_MODEL,SECONDARY_VERSION} from '../lib/trading/secondary-futures.js';
import {installExploration,explorationContract,getExplorationPolicy,EXPLORATION_VERSION,EXPLORATION_ENTRY_REVISION} from '../lib/trading/secondary-exploration.js';
import {newAccount} from '../lib/trading/simulator.js';
import {enablePortfolio} from '../lib/trading/portfolio.js';

const T=Date.parse('2026-11-13T09:00:00Z');
const ENV={LUMI_RUNTIME_ENV:'staging',LUMI_TRADING_MODE:'PAPER',LUMI_TRADING_STORAGE:'SQLITE',LUMI_TRADING_SECONDARY_NOTICES:SECONDARY_NOTICE_POLICY,LUMI_TRADING_OWNER_ID:'123',LUMI_TELEGRAM_REVIEW_TEST_USERS:'123'};
const plan={id:'SYNTHETIC-15m',timeframe:15,direction:'LONG',stop:'99',target:'103'};
const opened={type:'FILLED',id:plan.id,plan,ledger:'FREQUENT_PAPER',realTrading:false,at:T,qty:'.2',cumulative_qty:'.2',price:'100.01',remaining_qty:'.8',execution_state:'EJECUCIÓN_PARCIAL'};
const closed={...opened,type:'CLOSED',at:T+3000,qty:'1',cumulative_qty:'1',remaining_qty:'0',entry:'100.01',price:'100.10',pnl:'.0675',fees:'.04',fill_pnl:'-.0325',reason:'TRAILING_RETRACEMENT',result_final:true,funding_complete:true,quality:'OBSERVED'};
const notice=(kind,payload,key=kind)=>({id:hash(['synthetic',key]),kind,payload});

test('policy is explicit, versioned and PAPER-only; no flag preserves existing delivery',()=>{
 assert.equal(configuredSecondaryNoticePolicy({}),null);
 assert.equal(configuredSecondaryNoticePolicy(ENV),SECONDARY_NOTICE_POLICY);
 assert.throws(()=>configuredSecondaryNoticePolicy({...ENV,LUMI_TRADING_SECONDARY_NOTICES:'unknown'}),/UNKNOWN/);
 for(const change of [{LUMI_TRADING_MODE:'LIVE'},{LUMI_RUNTIME_ENV:'production'},{LUMI_TRADING_STORAGE:'REMOTE'}])assert.throws(()=>configuredSecondaryNoticePolicy({...ENV,...change}),/PAPER_ONLY/);
});

test('first partial entry is an opening; subsequent fills and pending signals are silent',()=>{
 const first=secondaryLifecycleNotice(notice('SECONDARY_PARTIAL',opened));assert.equal(first.action,'SEND');
 assert.match(first.text,/OPERACIÓN ABIERTA[\s\S]*15m[\s\S]*0.2 BTC[\s\S]*parte de lo solicitado/);
 assert.equal(secondaryLifecycleNotice(notice('SECONDARY_PARTIAL',{...opened,type:'PARTIAL_FILL'})).action,'SUPPRESS');
 for(const kind of ['SECONDARY_SELECTED','SECONDARY_PARTIAL_CLOSE','SECONDARY_UNFILLED','SECONDARY_TRAILING','SECONDARY_STATUS','SECONDARY_RISK_POLICY'])assert.equal(secondaryLifecycleNotice(notice(kind,opened)).action,'SUPPRESS');
});

test('final close reports the whole cycle, not the losing last fragment or fees subtracted again',()=>{
 const result=secondaryLifecycleNotice(notice('SECONDARY_CLOSE',closed));
 assert.equal(result.action,'SEND');assert.match(result.text,/CERRADA · GANANCIA/);assert.match(result.text,/Neto realizado del ciclo: \+0.067500 USD/);
 assert.doesNotMatch(result.text,/-0.0325|0.0275/);assert.match(result.text,/todos los parciales/);assert.match(result.text,/SYNTHETIC-15m/);
 assert.match(secondaryLifecycleNotice(notice('SECONDARY_CLOSE',{...closed,pnl:'-.001'})).text,/PÉRDIDA[\s\S]*-0.001000 USD/);
 assert.match(secondaryLifecycleNotice(notice('SECONDARY_CLOSE',{...closed,pnl:'0'})).text,/SIN GANANCIA NI PÉRDIDA/);
});

test('unknown funding or market quality never claims a final gain and never fabricates zero',()=>{
 for(const change of [{funding_complete:false},{result_final:false},{quality:'UNRESOLVED_MARKET_GAP'},{pnl:null}]){
  const text=secondaryLifecycleNotice(notice('SECONDARY_CLOSE',{...closed,...change})).text;
  assert.match(text,/RESULTADO PROVISIONAL/);assert.doesNotMatch(text,/Neto realizado/);
 }
 assert.match(secondaryLifecycleNotice(notice('SECONDARY_CLOSE',{...closed,pnl:null})).text,/no disponible/);
 const received=secondaryLifecycleNotice(notice('SECONDARY_CLOSE',{...closed,fees:'-.02'})).text;
 assert.match(received,/-0.020000 USD/);
});

test('wrong ledger, incomplete close and unexecuted payload cannot masquerade as lifecycle receipts',()=>{
 for(const payload of [{...closed,ledger:'ENGINE'},{...closed,realTrading:true},{...closed,remaining_qty:'.1'},{...closed,remaining_qty:null},{...closed,qty:'0',cumulative_qty:'0'},{...closed,type:'SELECTED'}])assert.equal(secondaryLifecycleNotice(notice('SECONDARY_CLOSE',payload)).action,'REJECT');
 assert.equal(secondaryLifecycleNotice(notice('SECONDARY_OPEN',{...opened,type:'SELECTED'})).action,'REJECT');
});

async function database(t){
 const dir=await mkdtemp(join(tmpdir(),'lumi-lifecycle-notices-')),path=join(dir,'synthetic.sqlite');let now=T,store=new SQLiteStore(path,{now:()=>now,allowEmpty:true});
 store.import({schema:1,exported_at:new Date(T).toISOString(),state:{id:'KRAKEN_BTCUSD_PAPER',revision:1,fence:0,lease_until:null,last_batch:null,state:initialState(T),updated_at:new Date(T).toISOString()},counts:{events:0,outbox:0},events:[],outbox:[]});await store.acquire();
 t.after(async()=>{try{store.close();}catch{}await rm(dir,{recursive:true,force:true});});
 return {get store(){return store;},async restart(){await store.tx({phase:'RELEASE'});store.close();now+=1000;store=new SQLiteStore(path,{now:()=>now});await store.acquire();},async commit(rows){await store.commit(store.row().state,[],rows);}};
}
function notifier(store,{fail=false,calls=[],policy=true}={}){
 const env=policy?ENV:{...ENV,LUMI_TRADING_SECONDARY_NOTICES:''};
 const result=new SecondaryNotifier({store,env,transport:{async call(method,args){calls.push({method,...args});if(fail)throw Error('NETWORK_AMBIGUOUS');return {message_id:calls.length,chat:{id:123},date:1};}},feed:{state:{},metadata:{},snapshot:()=>({})},pending:()=>false});result.identityAt=Date.now();return result;
}

test('real SQLite outbox suppresses noise, sends two lifecycle notices once across repeat/restart, and leaves primary queued',async t=>{
 const db=await database(t),rows=[notice('SECONDARY_SELECTED',{plan}),notice('SECONDARY_PARTIAL',opened),notice('SECONDARY_PARTIAL',{...opened,type:'PARTIAL_FILL'},'later-fill'),notice('SECONDARY_PARTIAL_CLOSE',{...closed,type:'PARTIAL_CLOSE'},'partial-close'),notice('SECONDARY_CLOSE',closed),notice('RESULT',{ledger:'ENGINE',type:'CLOSED'},'primary')];
 await db.commit(rows);const economicBefore=db.store.row().state,calls=[];let sender=notifier(db.store,{calls});
 await sender.drain();await db.restart();await db.commit(rows);sender=notifier(db.store,{calls});await sender.drain();
 assert.equal(calls.length,2);assert.match(calls[0].text,/OPERACIÓN ABIERTA/);assert.match(calls[1].text,/OPERACIÓN CERRADA · GANANCIA/);
 const stored=db.store.notices(20);assert.equal(stored.filter(x=>x.status==='DELIVERED').length,2);assert.equal(stored.filter(x=>x.status==='REJECTED').length,3);
 assert.equal(stored.find(x=>x.kind==='RESULT').status,'QUEUED');assert.deepEqual(db.store.row().state,economicBefore);
 assert(stored.filter(x=>x.status==='REJECTED').every(x=>x.receipt.sent===false&&x.receipt.notification_policy===SECONDARY_NOTICE_POLICY));
});

test('ambiguous Telegram delivery remains UNKNOWN and is never retried after process recovery',async t=>{
 const db=await database(t),calls=[];await db.commit([notice('SECONDARY_OPEN',{...opened,execution_state:'POSICIÓN_ABIERTA'})]);
 await notifier(db.store,{calls,fail:true}).drain();assert.equal(db.store.notices()[0].status,'UNKNOWN');
 await db.restart();await notifier(db.store,{calls}).drain();assert.equal(calls.length,1);
});

test('crash after durable claim cannot resend an uncertain lifecycle notification',async t=>{
 const db=await database(t),n=notice('SECONDARY_CLOSE',closed),calls=[];await db.commit([n]);await db.store.tx({phase:'CLAIM',id:n.id,claim_id:'synthetic-claim'});
 await db.restart();assert.equal(db.store.notices()[0].status,'UNKNOWN');await notifier(db.store,{calls}).drain();assert.equal(calls.length,0);
});

test('suppression persistence failure is visible, cannot call transport, and can recover without lost receipt',async t=>{
 const db=await database(t),n=notice('SECONDARY_STATUS',{equity:'500'}),calls=[];await db.commit([n]);
 db.store.db.exec("CREATE TRIGGER reject_notice BEFORE UPDATE ON outbox BEGIN SELECT RAISE(ABORT,'SYNTHETIC_STORAGE_FAILURE'); END;");
 await assert.rejects(notifier(db.store,{calls}).drain(),/SYNTHETIC_STORAGE_FAILURE/);assert.equal(calls.length,0);assert.equal(db.store.notices()[0].status,'QUEUED');
 db.store.db.exec('DROP TRIGGER reject_notice');await notifier(db.store,{calls}).drain();assert.equal(db.store.notices()[0].status,'REJECTED');assert.equal(calls.length,0);
});

test('same implementation without explicit policy still delivers legacy secondary notifications',async t=>{
 const db=await database(t),calls=[];await db.commit([notice('SECONDARY_STATUS',{equity:'500'})]);await notifier(db.store,{calls,policy:false}).drain();assert.equal(calls.length,1);assert.equal(db.store.notices()[0].status,'DELIVERED');
});

test('backlog suppression is bounded and a deferred identity check retains lifecycle notification and outcomes',async t=>{
 const db=await database(t),calls=[];await db.commit([...Array.from({length:25},(_,i)=>notice('SECONDARY_STATUS',{equity:'500'},'noise-'+i)),notice('SECONDARY_OPEN',opened)]);
 const sender=notifier(db.store,{calls});const first=await sender.drain();assert.equal(first.length,20);assert.equal(calls.length,0);assert.equal(db.store.notices(40).filter(x=>x.status==='REJECTED').length,20);
 sender.readyToDrain=async()=>false;const second=await sender.drain();assert.equal(second.length,5);assert.equal(calls.length,0);assert.equal(db.store.notices(40).find(x=>x.kind==='SECONDARY_OPEN').status,'QUEUED');
 sender.readyToDrain=async()=>true;await sender.drain();assert.equal(calls.length,1);assert.match(calls[0].text,/OPERACIÓN ABIERTA/);
});

test('private owner mismatch remains a hard failure before any lifecycle send',async t=>{
 const db=await database(t),calls=[];await db.commit([notice('SECONDARY_OPEN',opened)]);const sender=notifier(db.store,{calls});sender.env={...ENV,LUMI_TRADING_OWNER_ID:'456'};
 await assert.rejects(sender.drain(),/TRADING_PRIVATE_OWNER_NOT_UNIQUE/);assert.equal(calls.length,0);assert.equal(db.store.notices()[0].status,'QUEUED');
});

test('normal broker partial and recovered final close produce only open/result notices with ledger cumulative net',async t=>{
 const db=await database(t);let state=db.store.row().state,now=T,events=[],pending=[];
 const account=newAccount();enablePortfolio(account);state.frequency={account,counts:{evaluations:0,candidates:0,selected:0,filled:0,closed:0,notFilled:0},history:[],grossClosed:'0',closedFees:'0'};
 state.laboratory={status:'RESEARCH_COMPLETE',trials:[],funding:{initial:'500',added:'0',count:0}};Object.assign(account,{cash:'500',equity:'500',net:'0',fees:'0',peak:'500',closed:0,wins:0,losses:0,halted:false});
 const primary=structuredClone(state.research);
 const makeBroker=()=>new SecondaryBroker({root:state,now:()=>now,event:e=>events.push(structuredClone(e)),notice:(kind,payload,key)=>pending.push({id:hash(['lumi-trading',kind,key]),kind,payload:structuredClone(payload)})});
 let broker=makeBroker();installExploration(state,{...ENV,LUMI_TRADING_SECONDARY_PROFILE:EXPLORATION_VERSION},now);
 const contract=explorationContract(getExplorationPolicy(state),'BREAKOUT',now),entry=D('100.01').mul('1.0002');
 const p={id:'SYNTHETIC-NORMAL-PARTIAL',signal_key:hash(['synthetic-normal',T]),version:SECONDARY_VERSION,entry_revision:EXPLORATION_ENTRY_REVISION,execution_model:SECONDARY_MODEL,instrument:'PAPER:KRAKEN_FUTURES:PF_XBTUSD',pattern:'BREAKOUT',direction:'LONG',family:'L',recipe:'BREAKOUT',recipe_title:'SYNTHETIC ONLY',timeframe:60,entry:entry.toString(),limit:'100',stop:'99',target:'103',confirmed_at:T-2000,decision_at:T,expires_at:contract.expires_at,holding_ms:1800000,order:'FUTURES_TAKER_IOC',fill_model:contract.liquidity_model,execution_contract:contract,economics:secondaryEconomics(entry,99,103,'LONG',0,contract)};
 const quote=(at,bid=100,size=100)=>({source:'KRAKEN_FUTURES_WS_TICKER',symbol:'PF_XBTUSD',event_at:at,received_at:at,bid:String(bid),ask:D(bid).plus('.01').toString(),bid_qty:String(size),ask_qty:String(size),suspended:false});
 const step=(at,bid=100,size=100)=>{now=at;broker.market(quote(at,bid,size),null,{[Math.floor(T/3600000)*3600000]:0},at);};
 const flush=async()=>{await db.store.commit(state,events,pending);events=[];pending=[];};
 assert.equal(broker.choose(p,quote(T),{symbol:'PF_XBTUSD',qty_step:.0001,tick_size:.01,checked_at:T},T),'ENTRY_PENDING');
 step(T+1100);assert(broker.a.positions[p.id]);step(T+2200,98.8);step(T+3300,98.7,1);assert(D(broker.a.positions[p.id].closed_qty).gt(0));await flush();
 const partialNet=broker.a.net,remaining=broker.a.positions[p.id].qty,calls=[];
 await notifier(db.store,{calls}).drain();assert.equal(calls.length,1);await db.restart();state=db.store.row().state;broker=makeBroker();assert.equal(broker.a.net,partialNet);assert.equal(broker.a.positions[p.id].qty,remaining);
 step(T+4400,98.6);assert(!broker.a.positions[p.id]);await flush();const final=(await db.store.history('CLOSED'))[0],part=(await db.store.history('PARTIAL_CLOSE'))[0];
 assert(D(part.fill_pnl).plus(final.fill_pnl).eq(final.pnl));assert(D(broker.a.net).eq(final.pnl));
 const weightedExit=D(part.price).mul(part.qty).plus(D(final.execution_receipt.price).mul(final.execution_receipt.quantity)).div(final.qty);
 assert(D(final.price).minus(weightedExit).abs().lt('0.000000000001'));assert.notEqual(final.price,final.execution_receipt.price);
 const economic=db.store.row().state;await notifier(db.store,{calls}).drain();await notifier(db.store,{calls}).drain();
 assert.equal(calls.length,2);assert.match(calls[1].text,/OPERACIÓN CERRADA · PÉRDIDA/);assert(calls[1].text.includes(D(final.pnl).toFixed(2)));assert.deepEqual(db.store.row().state,economic);assert.deepEqual(state.research,primary);
 assert.equal(db.store.notices(30).filter(x=>x.kind==='SECONDARY_PARTIAL_CLOSE'&&x.status==='REJECTED').length,1);
});
