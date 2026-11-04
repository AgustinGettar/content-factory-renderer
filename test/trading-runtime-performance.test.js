import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SQLiteStore} from '../lib/trading/sqlite-store.js';
import {TradingEngine,initialState} from '../lib/trading/engine.js';
import {DashboardReadCache,RuntimePerformance} from '../lib/trading/runtime-performance.js';
import {DashboardPublisher} from '../lib/trading/dashboard-publisher.js';
const NOW=1793793600000;
async function setup(t){
 const dir=await mkdtemp(join(tmpdir(),'paper-performance-')),path=join(dir,'ledger.sqlite');let now=NOW;
 const store=new SQLiteStore(path,{allowEmpty:true,now:()=>now});
 store.import({schema:1,exported_at:new Date(now).toISOString(),state:{id:'KRAKEN_BTCUSD_PAPER',revision:1,fence:0,last_batch:null,state:initialState(now),updated_at:new Date(now).toISOString()},counts:{events:0,outbox:0},events:[],outbox:[]});
 const state=await store.acquire();t.after(async()=>{store.close();await rm(dir,{recursive:true,force:true});});
 return {store,state,path,now:()=>now,advance:n=>now+=n};
}
test('lease, commit and outbox transactions do not decode a previous checkpoint',async t=>{
 const {store,state}=await setup(t);store.row=()=>{throw Error('UNNECESSARY_STATE_READ');};
 await store.renew();await store.commit(state,[{type:'CLOSED',pnl:'1'}],[{id:'n',kind:'VERSION',payload:{type:'TEST'}}]);
 await store.tx({phase:'CLAIM',id:'n',claim_id:'claim'});await store.tx({phase:'FINISH',id:'n',claim_id:'claim',status:'DELIVERED'});await store.tx({phase:'RELEASE'});
 assert.equal(store.notices()[0].status,'DELIVERED');
});
test('UTF-8 payload budget still rejects oversize checkpoint atomically',async t=>{
 const {store,state}=await setup(t),revision=store.revision;
 await assert.rejects(store.commit({...state,large:'€'.repeat(2700000)},[{type:'CLOSED'}]),/TRADING_PAYLOAD_LIMIT/);
 assert.equal(store.row().revision,revision);assert.equal(store.latest(['CLOSED']).length,0);
});
test('synchronous SQLite checkpoint captures values before subsequent in-memory mutation',async t=>{
 const h=await setup(t),engine=new TradingEngine({store:h.store,feed:{},now:h.now});engine.state=h.state;engine.state.test={value:'before'};
 const saving=engine.flush();engine.state.test.value='after';engine.events.push({type:'AFTER_CHECKPOINT'});await saving;
 assert.equal(h.store.row().state.test.value,'before');assert.equal(engine.state.test.value,'after');assert.equal(engine.events.length,1);assert.equal(engine.events[0].type,'AFTER_CHECKPOINT');
});
test('bounded immutable history cache invalidates by relevant event, outbox and external commit',async t=>{
 const {store,state,path}=await setup(t),cache=new DashboardReadCache(store);
 await store.commit(state,[{type:'CLOSED',id:'one',pnl:'1'}],[{id:'n',kind:'VERSION',payload:{type:'TEST'}}]);
 const first=cache.latest(['CLOSED'],30);assert.equal(cache.latest(['CLOSED'],30),first);assert.throws(()=>{first[0].payload.pnl='999';});
 await store.commit(state,[{type:'FEED_AUDIT'}]);assert.equal(cache.latest(['CLOSED'],30),first);
 await store.commit(state,[{type:'CLOSED',id:'two',pnl:'-2'}]);assert.equal(cache.latest(['CLOSED'],30).length,2);
 assert.equal(cache.notices(20)[0].status,'QUEUED');await store.tx({phase:'CLAIM',id:'n',claim_id:'claim'});assert.equal(cache.notices(20)[0].status,'DISPATCHING');
 const other=new DatabaseSync(path);try{other.prepare('INSERT INTO events VALUES(?,?,?,?)').run('external','CLOSED',JSON.stringify({type:'CLOSED',id:'three'}),new Date(NOW).toISOString());}finally{other.close();}
 assert.equal(cache.latest(['CLOSED'],30).length,3);
 const tiny=new DashboardReadCache(store,{maxBytes:100,maxEntries:2});tiny.latest(['CLOSED'],30);assert(tiny.status().serialized_bytes<=100);assert(tiny.status().entries<=2);
});
test('slow detail transport never blocks fresh live publication or queues more detail',async t=>{
 const h=await setup(t),feed={state:{connected:true,reconciled:true,system:'online'},metadata:{},counters:{}},calls=[];let release;
 const p=new DashboardPublisher({store:h.store,feed,env:{},now:h.now,fetchImpl:async(url,options)=>{const data=JSON.parse(options.body);calls.push({url,data});if(url.endsWith('/snapshot'))await new Promise(r=>release=r);return Response.json({revision:data.revision});}});
 p.startBackup=()=>{};await p.publish();assert(p.detailBusy);assert(!p.busy);
 h.advance(2000);await h.store.commit(h.state,[]);await p.publish();assert.equal(calls.filter(c=>c.url.endsWith('/live')).length,2);assert.equal(calls.filter(c=>c.url.endsWith('/snapshot')).length,1);assert(calls.at(-1).data.revision>calls[0].data.revision);
 release();await p.detailTask;assert(!p.detailBusy);
});
test('slow Telegram send leaves market ticks free, settles once and preserves receipt accounting',async t=>{
 const h=await setup(t);let release,calls=0,markets=0;
 const engine=new TradingEngine({store:h.store,feed:{state:{reconciled:false},snapshot:()=>({})},now:h.now,notifier:{drain:()=>{calls++;return new Promise(r=>release=r);}}});
 engine.state=h.state;engine.repairing=true;engine.lastLease=NOW;engine.lastFlush=NOW;engine.lastFeedAudit=NOW;engine.state.last_summary=NOW;engine.backgroundNotifications=true;
 engine.onMarket=()=>markets++;engine.boundary=async()=>{};engine.daily=()=>{};
 await engine.tick();assert.equal(calls,1);assert(engine.notificationTask);assert(!engine.busy);
 h.advance(1000);await engine.tick();assert.equal(markets,2);assert.equal(calls,1);
 release([{id:'n',status:'DELIVERED'}]);await engine.notificationTask;await engine.tick();assert.equal(engine.state.counters.delivered,1);assert.equal(engine.notificationResult,null);await engine.tick();assert.equal(engine.state.counters.delivered,1);
});
test('performance sampling stays bounded and resets intervals',()=>{
 const p=new RuntimePerformance();try{for(let i=0;i<2000;i++)p.record('tick',i);for(let i=0;i<30;i++)p.record('stage'+i,1);assert.equal(p.samples.get('tick').last.length,120);assert.equal(p.samples.size,16);const r=p.report();assert.equal(r.stages.tick.count,2000);assert.equal(r.stages.tick.max_ms,1999);assert.equal(p.samples.size,0);}finally{p.close();}
});
