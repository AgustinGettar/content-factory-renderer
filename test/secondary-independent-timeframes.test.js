import test from 'node:test';
import assert from 'node:assert/strict';
import {D,hash} from '../lib/trading/core.js';
import {newAccount} from '../lib/trading/simulator.js';
import {enablePortfolio} from '../lib/trading/portfolio.js';
import {OperationalSecondary,SECONDARY_VERSION} from '../lib/trading/secondary-futures.js';
import {entryCandidates} from '../lib/trading/secondary-entry-context.js';
import {MultiPatternPaper,closedBars} from '../lib/trading/multi-pattern-paper.js';
import {installExploration,EXPLORATION_VERSION,EXPLORATION_POLICY} from '../lib/trading/secondary-exploration.js';
import {installProfitPolicy,EARLY_PROFIT_POLICY_VERSION,EARLY_PROFIT_POLICY,validateProfitContracts} from '../lib/trading/secondary-profit-policy.js';
import {installSecondaryTimeframes,getSecondaryTimeframes,SECONDARY_TIMEFRAMES_VERSION,SECONDARY_TIMEFRAMES_PROTOCOL as PROTOCOL} from '../lib/trading/secondary-timeframes.js';
import {projectSecondaryActivity} from '../lib/trading/secondary-monitor-activity.js';
const C=Date.parse('2026-11-03T12:00:00Z'),ENV={LUMI_RUNTIME_ENV:'staging',LUMI_TRADING_MODE:'PAPER',LUMI_TRADING_STORAGE:'SQLITE',LUMI_TRADING_SECONDARY_PROFILE:EXPLORATION_VERSION,LUMI_TRADING_SECONDARY_PROFIT_POLICY:EARLY_PROFIT_POLICY_VERSION,LUMI_TRADING_SECONDARY_TIMEFRAMES:SECONDARY_TIMEFRAMES_VERSION};
const meta={symbol:'PF_XBTUSD',qty_step:.0001,tick_size:.01,checked_at:C};
const quote=(at=C+2000,bid=200.8)=>({source:'KRAKEN_FUTURES_WS_TICKER',symbol:'PF_XBTUSD',event_at:at,received_at:at,bid:String(bid),ask:D(bid).plus('.01').toString(),bid_qty:'100',ask_qty:'100',suspended:false});
const bars=(tf,cutoff=C)=>{const end=Math.floor(cutoff/(tf*60000))*tf*60000;return Array.from({length:96},(_,i)=>({start:end-(96-i)*tf*60000,end:end-(95-i)*tf*60000,open:199.9,close:199.9,high:200.2,low:199.7,volume:1,available_at:C+1000}));};
const allSeries=()=>Object.fromEntries(PROTOCOL.data_frames.map(tf=>[tf,bars(tf)]));
function signalSeries(tf){const s=allSeries();Object.assign(s[tf].at(-1),{open:199.9,high:200.9,low:199.9,close:200.8,volume:2});return s;}
function fixture(){
 let now=C-1000;const a=newAccount();enablePortfolio(a);Object.assign(a,{cash:'1000',equity:'1000',peak:'1000'});
 const root={frequency:{account:a,counts:{evaluations:0,candidates:0,selected:0,filled:0,closed:0,notFilled:0},history:[],grossClosed:'0',closedFees:'0'},laboratory:{status:'RESEARCH_COMPLETE',trials:[],funding:{initial:'1000',added:'0',count:0}},research:{active:'primary',versions:{primary:{account:{cash:'100',equity:'100',net:'0'}}}}};
 const events=[],notices=[],engine={state:root,event:e=>events.push(structuredClone(e)),notice:(...args)=>notices.push(structuredClone(args))};
 const runtime=new OperationalSecondary({engine,now:()=>now}).initialize();installExploration(root,ENV,now);installProfitPolicy(root,ENV,now);installSecondaryTimeframes(root,ENV,now);
 runtime.series=allSeries();runtime.meta=meta;runtime.rates={[Math.floor(C/3600000)*3600000]:0};runtime.quote=quote();runtime.lastRefresh=C+1000;
 return {root,runtime,events,notices,time(t,bid=200.8){now=t;runtime.quote=quote(t,bid);}};
}

test('timeframe activation is additive, idempotent, signed and cannot mint capital or mutate old contracts',()=>{
 const h=fixture(),a=structuredClone(h.root.frequency.account),primary=structuredClone(h.root.research),x=h.root.secondaryExecution;
 assert.equal(installSecondaryTimeframes(h.root,ENV,C),false);assert.deepEqual(h.root.frequency.account,a);assert.deepEqual(h.root.research,primary);
 const saved=structuredClone(x.timeframe_execution);assert.equal(hash(saved.policy),saved.policy_hash);assert.equal(getSecondaryTimeframes(h.root).policy.entry_frames.length,4);
 assert.throws(()=>installSecondaryTimeframes(h.root,{...ENV,LUMI_TRADING_MODE:'REAL'},C),/PAPER_ONLY/);
 assert.throws(()=>installSecondaryTimeframes(h.root,{...ENV,LUMI_TRADING_SECONDARY_TIMEFRAMES:undefined},C),/FLAG_REQUIRED/);
 x.timeframe_execution.frames[60].last_cutoff++;assert.throws(()=>getSecondaryTimeframes(h.root),/CURSOR_INVALID/);x.timeframe_execution=saved;
 assert.equal(installSecondaryTimeframes(h.root,{...ENV,LUMI_TRADING_SECONDARY_TIMEFRAMES:'OFF'},C),true);assert.deepEqual(h.root.frequency.account,a);
});

for(const tf of PROTOCOL.entry_frames)test(tf+'m creates a causal futures candidate with its own immutable horizon and identity',()=>{
 const context=PROTOCOL.frames[tf].context_timeframe,s=signalSeries(tf),options={timeframe:tf,contextTimeframe:context,timeframeVersion:SECONDARY_TIMEFRAMES_VERSION};
 const candidates=entryCandidates(s,quote(),meta,C,C+2000,.001,EXPLORATION_POLICY,EARLY_PROFIT_POLICY,options),d=candidates.find(d=>d.pattern==='BREAKOUT');
 assert(d.plan,JSON.stringify(d));const p=d.plan;assert.equal(p.timeframe,tf);assert.equal(p.evidence.default_tf,tf);assert.equal(p.evidence.panels[1].tf,context);assert.equal(p.holding_ms,PROTOCOL.frames[tf].base_holding_ms);assert.equal(p.exit_policy.trailing_extension_ms,PROTOCOL.frames[tf].extension_ms);assert.equal(validateProfitContracts(p),true);
 assert.equal(p.economic_policy.funding_estimation_ms,p.holding_ms+p.exit_policy.trailing_extension_ms);assert.equal(p.economics.fundingAllowance,.001*p.economic_policy.funding_estimation_ms/3600000);assert(p.entry_context.confirmation_key);assert.equal(p.entry_context.timeframe,tf);
 assert.equal(p.instrument,'PAPER:KRAKEN_FUTURES:PF_XBTUSD');assert.equal(p.timeframe_contract.source,'KRAKEN_FUTURES_TRADE_CANDLES');
 for(const [frame,b] of Object.entries(s))b.push({...b.at(-1),start:C,end:C+Number(frame)*60000,high:99999,close:99999,available_at:C+999999});
 assert.deepEqual(entryCandidates(s,quote(),meta,C,C+2000,.001,EXPLORATION_POLICY,EARLY_PROFIT_POLICY,options),candidates);
 const unavailable=signalSeries(tf);unavailable[tf].at(-1).available_at=C+3000;assert(entryCandidates(unavailable,quote(),meta,C,C+2000,0,EXPLORATION_POLICY,EARLY_PROFIT_POLICY,options).every(d=>d.reason==='CONTEXT_NOT_SYNCHRONIZED'));
});

test('timeframe namespaces separate simultaneous confirmations without treating each new bar as a new event',()=>{
 const ids=[],confirmations=[];for(const tf of PROTOCOL.entry_frames){const p=entryCandidates(signalSeries(tf),quote(),meta,C,C+2000,0,EXPLORATION_POLICY,EARLY_PROFIT_POLICY,{timeframe:tf,contextTimeframe:PROTOCOL.frames[tf].context_timeframe,timeframeVersion:SECONDARY_TIMEFRAMES_VERSION}).find(d=>d.plan)?.plan;ids.push(p.id);confirmations.push(p.entry_context.confirmation_key);}
 assert.equal(new Set(ids).size,4);assert.equal(new Set(confirmations).size,4);
 assert(entryCandidates(signalSeries(60),quote(),meta,C,C+2000,0,EXPLORATION_POLICY,EARLY_PROFIT_POLICY,{timeframe:60,contextTimeframe:240}).every(d=>d.reason==='ENTRY_TIMEFRAME_CONTRACT_REQUIRED'));
});

test('simultaneous 5m/15m/1h/4h closes evaluate once each; repeat ticks and restart cannot consume or duplicate a clock',()=>{
 const h=fixture();h.time(C+2000);h.runtime.tick();const f=getSecondaryTimeframes(h.root).frames;
 for(const tf of PROTOCOL.entry_frames){assert.equal(f[tf].counts.completed,1);assert.equal(f[tf].counts.pattern_checks,3);assert.equal(f[tf].last_status,'COMPLETE');}
 const evaluationEvents=()=>h.events.filter(e=>e.type==='SECONDARY_PATTERN_EVALUATION');assert.equal(evaluationEvents().length,12);
 h.time(C+3000);h.runtime.tick();assert.equal(evaluationEvents().length,12);
 const restarted=new OperationalSecondary({engine:{state:JSON.parse(JSON.stringify(h.root)),event:e=>h.events.push(e),notice:()=>{}},now:()=>C+4000}).initialize();restarted.series=h.runtime.series;restarted.quote=quote(C+4000);restarted.meta=meta;restarted.rates=h.runtime.rates;restarted.tick();assert.equal(evaluationEvents().length,12);
});

test('missing 4h/daily data cannot block 5m and 15m; transient recovery is counted separately from missed evaluations',()=>{
 const h=fixture();h.runtime.series[240]=[];h.runtime.series[1440]=[];h.time(C+2000);h.runtime.tick();const frames=getSecondaryTimeframes(h.root).frames;
 assert.equal(frames[5].counts.completed,1);assert.equal(frames[15].counts.completed,1);assert.equal(frames[60].last_status,'TRANSIENT_BLOCKED');assert.equal(frames[240].last_status,'TRANSIENT_BLOCKED');
 h.runtime.series[240]=bars(240);h.runtime.series[1440]=bars(1440);h.time(C+15000);h.runtime.tick();
 for(const tf of [60,240]){assert.equal(frames[tf].counts.completed,1);assert.equal(frames[tf].counts.recovered,1);assert.equal(frames[tf].counts.missed,0);assert.equal(frames[tf].last_status,'RECOVERED');}
 assert.equal(frames[5].counts.completed,1);assert.equal(h.events.filter(e=>e.type==='SECONDARY_FRAME_EVALUATION_RECOVERED').length,2);
});

test('an expired evaluation window is recorded once and never fabricates an historical entry',()=>{
 const h=fixture();h.time(C+2000);h.runtime.quote=quote(C-10000);h.runtime.tick();h.time(C+31000);h.runtime.tick();
 for(const f of Object.values(getSecondaryTimeframes(h.root).frames)){assert.equal(f.counts.completed,0);assert.equal(f.counts.missed,1);assert.equal(f.last_status,'MISSED');}
 h.time(C+35000);h.runtime.tick();assert.equal(Object.keys(h.root.frequency.account.positions).length,0);assert.equal(Object.keys(h.root.frequency.account.pendingOrders).length,0);
 for(const f of Object.values(getSecondaryTimeframes(h.root).frames))assert.equal(f.counts.missed,1);
});

test('restart inside a current window counts earlier skipped candles once while the current data retry remains eligible',()=>{
 const h=fixture();h.time(C+2000);h.runtime.tick();const root=JSON.parse(JSON.stringify(h.root)),cutoff=C+20*60000;let now=cutoff+5000;
 const events=[],runtime=new OperationalSecondary({engine:{state:root,event:e=>events.push(structuredClone(e)),notice:()=>{}},now:()=>now}).initialize();
 runtime.series=Object.fromEntries(PROTOCOL.data_frames.map(tf=>[tf,bars(tf,cutoff).map(b=>({...b,available_at:cutoff+1000}))]));const ready=runtime.series[5];runtime.series[5]=[];runtime.meta={...meta,checked_at:now};runtime.quote=quote(now);runtime.rates={[Math.floor(now/3600000)*3600000]:0};runtime.tick();
 const frame=getSecondaryTimeframes(root).frames[5];assert.equal(frame.counts.missed,3);assert.equal(frame.counts.completed,1);assert.equal(frame.last_cutoff,cutoff-5*60000);assert.equal(frame.last_status,'TRANSIENT_BLOCKED');
 now=cutoff+6000;runtime.quote=quote(now);runtime.tick();assert.equal(frame.counts.missed,3);assert.equal(frame.counts.completed,1);
 runtime.series[5]=ready;now=cutoff+15000;runtime.quote=quote(now);runtime.tick();assert.equal(frame.counts.completed,2);assert.equal(frame.counts.recovered,1);assert.equal(frame.counts.missed,3);assert.equal(frame.last_cutoff,cutoff);
 const skipped=events.filter(e=>e.type==='SECONDARY_FRAME_EVALUATIONS_MISSED'&&e.timeframe===5);assert.equal(skipped.length,1);assert.equal(skipped[0].count,3);assert.equal(skipped[0].from_cutoff,C+5*60000);assert.equal(skipped[0].to_cutoff,C+15*60000);assert.equal(skipped[0].history_replay,false);
 assert.equal(events.some(e=>['SELECTED','FILLED'].includes(e.type)),false);assert.deepEqual(root.research,h.root.research);assert.equal(root.frequency.account.cash,h.root.frequency.account.cash);
});

for(const tf of PROTOCOL.entry_frames)test(tf+'m candidate reaches real existing PAPER broker and post-latency fill in isolated test',()=>{
 const h=fixture();h.runtime.series=signalSeries(tf);h.time(C+2000);h.runtime.tick();const pending=Object.values(h.root.frequency.account.pendingOrders).filter(o=>o.plan.timeframe===tf);assert(pending.length>0,'candidate was not selected');
 const id=pending[0].plan.id,originalPrimary=structuredClone(h.root.research);h.time(C+3100);h.runtime.tick();const p=h.root.frequency.account.positions[id];assert(p);assert.equal(p.plan.timeframe,tf);assert.equal(p.expires_at-p.entered_at,PROTOCOL.frames[tf].base_holding_ms);assert.deepEqual(h.root.research,originalPrimary);
 assert(h.events.some(e=>e.type==='FILLED'&&e.id===id));assert.equal(h.events.filter(e=>e.type==='FILLED'&&e.id===id).length,1);
});

for(const tf of [15,60,240])test(tf+'m pending order naturally expires with its signed timeframe in event, history and outbox payload',()=>{
 const h=fixture();h.runtime.series=signalSeries(tf);h.time(C+2000);h.runtime.tick();
 const pending=Object.values(h.root.frequency.account.pendingOrders).find(o=>o.plan.timeframe===tf);assert(pending,'candidate was not selected');
 const plan=structuredClone(pending.plan),id=plan.id,account=h.root.frequency.account,before={cash:account.cash,net:account.net,fees:account.fees,closed:account.closed},primary=structuredClone(h.root.research);
 // With no post-latency quote, expiry remains an observable clock event. No
 // direct cancellation or execution helper is used to obtain this result.
 h.time(plan.expires_at);h.runtime.quote=null;h.runtime.tick();
 const canceled=h.events.filter(e=>e.type==='NOT_FILLED'&&e.id===id);assert.equal(canceled.length,1);assert.equal(canceled[0].reason,'VENCIDA');assert.equal(canceled[0].order_state,'ORDEN_VENCIDA');assert.equal(canceled[0].timeframe,tf);assert.deepEqual(canceled[0].plan,plan);
 assert.equal(h.root.frequency.history.find(e=>e.type==='NOT_FILLED'&&e.id===id).timeframe,tf);
 const notice=h.notices.find(n=>n[0]==='SECONDARY_UNFILLED'&&n[1].id===id);assert(notice);assert.equal(notice[1].timeframe,tf);assert.equal(notice[1].plan.timeframe,tf);
 assert.equal(account.pendingOrders[id],undefined);assert.equal(account.positions[id],undefined);assert.equal(h.events.some(e=>e.id===id&&['FILLED','PARTIAL_FILL','CLOSED'].includes(e.type)),false);assert.deepEqual({cash:account.cash,net:account.net,fees:account.fees,closed:account.closed},before);assert.deepEqual(h.root.research,primary);
 h.time(plan.expires_at+1000);h.runtime.quote=null;h.runtime.tick();assert.equal(h.events.filter(e=>e.type==='NOT_FILLED'&&e.id===id).length,1);
});

test('multi-frame public candle fetches are bounded, use actual futures resolutions and isolate a daily failure',async()=>{
 const calls=[],now=C+5000,engine={state:{}};
 const fetchImpl=async url=>{calls.push(url);if(url.includes('/1d?'))return {ok:false};if(url.endsWith('/instruments'))return {ok:true,json:async()=>({instruments:[{symbol:'PF_XBTUSD',type:'flexible_futures',base:'BTC',quote:'USD',contractSize:1,tradeable:true,contractValueTradePrecision:4,tickSize:.01}]})};if(url.includes('historical-funding'))return {ok:true,json:async()=>({rates:[]})};const resolution=url.match(/PF_XBTUSD\/(.*?)\?/)[1],tf=({'5m':5,'15m':15,'1h':60,'4h':240})[resolution];return {ok:true,json:async()=>({candles:bars(tf).map(({start,...b})=>({...b,time:start}))})};};
 const r=new MultiPatternPaper({engine,now:()=>now,fetchImpl});r.stopped=false;r.candleFrames=PROTOCOL.data_frames;await r.refresh();assert.equal(r.feedError,null);assert.equal(r.frameErrors[1440],'PUBLIC_RESEARCH_FEED_HTTP');assert.equal(r.series[5].length,96);assert.equal(r.series[240].length,96);assert(calls.some(url=>url.includes('/1h?')));assert(calls.some(url=>url.includes('/4h?')));assert(calls.every(url=>!url.includes('/spot/')));
 const countBefore=calls.length;await r.refresh();assert.equal(calls.length-countBefore,1,'only the failed due daily frame should retry');assert.equal(closedBars({candles:[{time:C,open:1,high:1,low:1,close:1,volume:0}]},240,C+1).length,0);
});

test('monitor describes each entry clock and keeps historical spot 1m explicitly inactive',()=>{
 const h=fixture();h.time(C+2000);h.runtime.tick();const d={revision:9,updated_at:new Date(C+2000).toISOString(),lease_until:new Date(C+60000).toISOString(),frequency:{},timeframes:{frames:[1,15,60,240],series:{1:{bars:700,last_closed_at:C}}},laboratory:{trials:[{version:SECONDARY_VERSION,net:0,recipe:{}}]}};
 const inventory=Object.fromEntries(Object.entries(h.runtime.series).map(([tf,b])=>[tf,{bars:b.length,last_closed_at:b.at(-1)?.end}]));const out=projectSecondaryActivity(d,h.root,C+2000,inventory);
 assert.deepEqual(out.timeframes.entry_frames,[5,15,60,240]);assert.equal(out.timeframes.series[1].entry_enabled,false);assert.equal(out.timeframes.series[1].source,'KRAKEN_SPOT_LEGACY');assert.equal(out.timeframes.series[1440].role,'CONTEXT');
 for(const tf of PROTOCOL.entry_frames){const f=out.secondary_activity.frames[tf];assert.equal(f.entry_enabled,true);assert.equal(f.data_complete,true);assert.equal(f.last_evaluation_at,C+2000);assert.equal(f.counts.completed,1);assert.equal(out.laboratory.trials[0].decisions[tf].timeframe,tf);}
 assert.equal(out.secondary_evaluations.length,12);assert(Buffer.byteLength(JSON.stringify(out))<150000,String(Buffer.byteLength(JSON.stringify(out))));assert(!JSON.stringify(out).includes('"candles":['));
});
