// Synthetic long-running state; actual publisher and actual Site ingestion
// handler, with an in-memory bucket and no network or operational data.
import test from 'node:test';
import assert from 'node:assert/strict';
import {DashboardPublisher,liveBody,snapshot} from '../lib/trading/dashboard-publisher.js';
import {initialState} from '../lib/trading/engine.js';
import {newAccount} from '../lib/trading/simulator.js';
import {enablePortfolio} from '../lib/trading/portfolio.js';
import {SecondaryBroker} from '../lib/trading/secondary-futures-engine.js';
import {attachOperationalProjection} from '../lib/trading/secondary-futures-runtime.js';
import {installExploration,EXPLORATION_VERSION} from '../lib/trading/secondary-exploration.js';
import {installProfitPolicy,EARLY_PROFIT_POLICY_VERSION} from '../lib/trading/secondary-profit-policy.js';
import {installCapitalAllocation,CAPITAL_ALLOCATION_VERSION} from '../lib/trading/secondary-capital-allocation.js';
import {installRiskBudget,QUANT_RISK_VERSION} from '../lib/trading/secondary-risk-budget.js';
import {installSecondaryTimeframes,QUANT_TIMEFRAMES_VERSION} from '../lib/trading/secondary-timeframes.js';
import {installQuant,QUANT_VERSION,QUANT_STRATEGIES} from '../lib/trading/quant-strategies.js';
import {awsMonitor} from './fixtures/published-site-contract/deploy/trading/site/lib/aws-monitor.mjs';
import {secondaryView} from './fixtures/published-site-contract/deploy/trading/site/lib/secondary-operational.mjs';
import {viewModel} from './fixtures/published-site-contract/deploy/trading/compact-panel/model.js';
const T=Date.parse('2026-11-13T10:00:00Z'),LIMIT=1024*1024,KEY='isolated-synthetic-ingest-key-only-32-bytes';
const serialized=x=>JSON.parse(JSON.stringify(x));

function fixture(){
 let now=T,revision=5;const state=initialState(T),account=newAccount();enablePortfolio(account);Object.assign(account,{cash:'500',equity:'500',peak:'500'});
 Object.assign(state,{frequency:{account,counts:{evaluations:0,candidates:0},history:[]},laboratory:{status:'RESEARCH_COMPLETE',trials:[],funding:{initial:'500',added:'0'}}});
 const env={LUMI_RUNTIME_ENV:'staging',LUMI_TRADING_MODE:'PAPER',LUMI_TRADING_STORAGE:'SQLITE',LUMI_TRADING_SECONDARY_PROFILE:EXPLORATION_VERSION,LUMI_TRADING_SECONDARY_PROFIT_POLICY:EARLY_PROFIT_POLICY_VERSION,LUMI_TRADING_SECONDARY_CAPITAL_ALLOCATION:CAPITAL_ALLOCATION_VERSION,LUMI_TRADING_SECONDARY_RISK_BUDGET:QUANT_RISK_VERSION,LUMI_TRADING_SECONDARY_TIMEFRAMES:QUANT_TIMEFRAMES_VERSION,LUMI_TRADING_SECONDARY_QUANT:QUANT_VERSION};
 const broker=new SecondaryBroker({root:state,now:()=>now});installExploration(state,env,T);installProfitPolicy(state,env,T);installCapitalAllocation(state,env,T);installRiskBudget(state,env,T);installSecondaryTimeframes(state,env,T);installQuant(state,env,T);
 // Existing runtime retains up to 2,000 outcomes and 366 daily equity marks.
 // Fill those documented limits without changing counts or authoritatively
 // recalculating the account from this intentionally synthetic history.
 const q=state.secondaryExecution.quant;
 q.outcomes=Array.from({length:2000},(_,i)=>({id:'SYNTHETIC-OUTCOME-'+String(i).padStart(5,'0'),start:T-20000000+i*1000,end:T-19000000+i*1000,net:i%2?-.0675:.09,gross:.1,costs:.04,initial_risk:2,mfe:.2,mae:-.1,holding_ms:1000000,strategy:Object.keys(QUANT_STRATEGIES)[i%9],regime:'LEGACY_UNKNOWN',timeframe:[1,5,15,60,240][i%5],final:true,quality:'OBSERVED',model:QUANT_VERSION,execution_repair:'secondary-execution-repair-1.0.0',active_policy:'a'.repeat(64),fibonacci_policy:'b'.repeat(64)}));
 q.daily_equity=Array.from({length:366},(_,i)=>({at:T-(366-i)*86400000,equity:500}));
 for(const timeframe of [1,5,15,60,240])for(const pattern of Object.keys(QUANT_STRATEGIES))for(let i=0;i<3;i++)broker.stats({pattern,timeframe,version:'synthetic-contract-'+i,entry_revision:'synthetic-entry-'+i,timeframe_contract:{version:QUANT_TIMEFRAMES_VERSION}});
 const quote=()=>({source:'KRAKEN_FUTURES_WS_TICKER',symbol:'PF_XBTUSD',bid:'100000',ask:'100001',bid_qty:'1',ask_qty:'1',event_at:now,received_at:now});state.secondaryExecution.market={quote:quote(),closed_at:{},frame_refresh_at:{},last_refresh:T};
 const metadata=[],store={row:()=>({state,revision,updated_at:new Date(now).toISOString(),lease_until:new Date(now+45000).toISOString()}),latest:()=>[],notices:()=>[],db:{prepare:()=>({run:(k,v)=>metadata.push(JSON.parse(v))})}};
 const feed={state:{connected:true,reconciled:true,system:'online',quote:quote(),trade:{price:'100000',event_at:T,received_at:T},clock:{checked_at:T,error_ms:0}},metadata:{status:'online',checked_at:T},counters:{quotes:1,trades:1,reconnects:0}};
 const objects=new Map(),requests=[];let etag=0;
 const BUCKET={async get(key){const value=objects.get(key);return value?{etag:value.etag,json:async()=>JSON.parse(value.body)}:null;},async put(key,body,options){const old=objects.get(key),condition=options.onlyIf;if(condition?.etagMatches&&condition.etagMatches!==old?.etag||condition?.etagDoesNotMatch==='*'&&old)return null;objects.set(key,{body:new TextDecoder().decode(body),etag:String(++etag)});return {etag:String(etag)};}};
 const publisher=new DashboardPublisher({store,feed,env:{LUMI_TRADING_PUBLISH_KEY:KEY},now:()=>now,fetchImpl:async(url,options)=>{requests.push({path:new URL(url).pathname,bytes:Buffer.byteLength(options.body),revision:JSON.parse(options.body).revision});return awsMonitor(new Request(url,{...options,headers:{'Content-Type':'application/json','X-Trading-Ingest-Key':KEY}}),{BUCKET,LUMI_TRADING_PUBLISH_KEY:KEY},now);}});
 publisher.startBackup=()=>{};attachOperationalProjection(publisher,store,{series:{}});
 return {publisher,store,feed,state,metadata,objects,requests,BUCKET,now:()=>now,tick(){now+=2000;revision++;state.secondaryExecution.market.quote=quote();feed.state.quote=quote();},projection:()=>snapshot(store,feed,now,null,publisher.projectSnapshot)};
}

test('normal publisher keeps live refreshing at documented outcome retention limit; complete history remains in detail',async t=>{
 const h=fixture(),d=h.projection(),before=JSON.stringify(h.state),detail=JSON.stringify(d),live=liveBody(d),view=JSON.parse(live);
 t.diagnostic(JSON.stringify({synthetic_outcomes:2000,comparison_domains:Object.keys(d.secondary_comparison).length,live_bytes:Buffer.byteLength(live),detail_bytes:Buffer.byteLength(detail),site_live_limit:LIMIT}));
 assert(Buffer.byteLength(detail)>LIMIT,'fixture must expose real growth beyond the live contract');
 await h.publisher.publish();await h.publisher.detailTask;assert.equal(h.publisher.error,null);assert.equal(h.publisher.detailError,null);
 assert.equal(JSON.stringify(h.state),before,'publication cannot modify the ledger or research state');
 assert(Buffer.byteLength(live)<LIMIT,'live must not ship full internal outcome history');
 assert.deepEqual(view.secondary_comparison,serialized(d.secondary_comparison));assert.deepEqual(view.secondary_quant,serialized(d.secondary_quant));assert.deepEqual(view.secondary_execution.market,serialized(d.secondary_execution.market));assert.deepEqual(view.secondary_finances,serialized(d.secondary_finances));assert.deepEqual(view.secondary_activity.frames,serialized(d.secondary_activity.frames));
 assert.deepEqual(serialized(viewModel(view,T,T)),serialized(viewModel(d,T,T)),'simple panel uses the same economic and freshness fields');
 assert.deepEqual(serialized(secondaryView(view,T)),serialized(secondaryView(d,T)),'full panel uses the same economic and timeframe fields');
 const first=JSON.parse(h.objects.get('trading/live.json').body);h.tick();await h.publisher.publish();const second=JSON.parse(h.objects.get('trading/live.json').body);
 assert.equal(second.revision,first.revision+1);assert.equal(second.secondary_execution.market.quote.event_at,T+2000);
 const storedDetail=JSON.parse(h.objects.get('trading/snapshot.json').body);assert.equal(storedDetail.secondary_execution.quant.outcomes.length,2000);assert.equal(Object.keys(storedDetail.secondary_execution.by_pattern_version).length,135);
 const expected=JSON.parse(before);expected.secondaryExecution.market=serialized(h.state.secondaryExecution.market);assert.deepEqual(serialized(h.state),expected,'only the explicit next synthetic market tick changed');
});

test('different internal and public comparison values are not silently dropped as duplicate aliases',()=>{
 const h=fixture(),d=h.projection();d.secondary_execution.by_pattern_version={notPublic:{net:'-3'}};const p=JSON.parse(liveBody(d));assert.deepEqual(p.secondary_execution.by_pattern_version,{notPublic:{net:'-3'}});assert.deepEqual(p.secondary_comparison,serialized(d.secondary_comparison));
});

test('unknown quant version, incomplete or mismatched summary is retained rather than projected under a guessed contract',()=>{
 const h=fixture(),d=h.projection();d.secondary_execution.quant={version:'unknown-new-version',active:true,outcomes:[{id:'retained'}]};const view=JSON.parse(liveBody(d));assert.deepEqual(view.secondary_execution.quant,d.secondary_execution.quant);
 d.secondary_execution.quant.version=QUANT_VERSION;d.secondary_quant.active=false;assert.deepEqual(JSON.parse(liveBody(d)).secondary_execution.quant,d.secondary_execution.quant);
 const full=h.projection();full.secondary_quant={version:QUANT_VERSION,active:true};assert.deepEqual(JSON.parse(liveBody(full)).secondary_execution.quant,serialized(full.secondary_execution.quant));
 const mismatch=h.projection();mismatch.secondary_quant.counts={evaluations:999999};assert.deepEqual(JSON.parse(liveBody(mismatch)).secondary_execution.quant,serialized(mismatch.secondary_execution.quant));
});

test('Site rejects oversized live bodies and preserves its previously accepted snapshot',async()=>{
 const h=fixture();const valid={schema:1,storage:'AWS_SQLITE',revision:1,generated_at:T,updated_at:new Date(T).toISOString()},make=body=>new Request('https://synthetic.invalid/api/aws/live',{method:'PUT',headers:{'X-Trading-Ingest-Key':KEY},body:JSON.stringify(body)});
 assert.equal((await awsMonitor(make(valid),{BUCKET:h.BUCKET,LUMI_TRADING_PUBLISH_KEY:KEY},T)).status,200);
 const rejected=await awsMonitor(make({...valid,revision:2,unbounded:'x'.repeat(LIMIT)}),{BUCKET:h.BUCKET,LUMI_TRADING_PUBLISH_KEY:KEY},T);
 assert.equal(rejected.status,400);assert.equal((await rejected.json()).error,'INVALID_BODY_OR_STORAGE');assert.equal(JSON.parse(h.objects.get('trading/live.json').body).revision,1);
});

test('unexpected uncompactable growth exposes its byte limit without sending or masking the last good receipt',async()=>{
 const h=fixture();await h.publisher.publish();await h.publisher.detailTask;const last=h.publisher.lastSuccess,before=h.requests.length,project=h.publisher.projectSnapshot;
 h.publisher.projectSnapshot=(...args)=>({...project(...args),unknown_diagnostic:'x'.repeat(LIMIT)});h.tick();await h.publisher.publish();
 assert.equal(h.publisher.error,'DASHBOARD_LIVE_PAYLOAD_LIMIT');assert.equal(h.publisher.lastSuccess,last);assert.equal(h.requests.length,before);assert(h.publisher.attemptedLiveBytes>LIMIT);assert.equal(h.metadata.at(-1).live_max_bytes,LIMIT);assert.equal(h.metadata.at(-1).attempted_live_bytes,h.publisher.attemptedLiveBytes);
});
