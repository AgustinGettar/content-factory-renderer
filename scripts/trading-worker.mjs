import {installOperational,attachOperationalProjection} from '../lib/trading/secondary-futures-runtime.js';
import {installMultiPattern,attachResearchProjection} from '../lib/trading/multi-pattern-paper.js';
import {PaperControlClient} from '../lib/trading/paper-controls.js';
// Dedicated supervised PAPER worker. Does not start Lumi or submit exchange orders.
import {readFile} from 'node:fs/promises';
import {createClient} from '@supabase/supabase-js';
import {KrakenFeed} from '../lib/trading/feed.js';
import {SQLiteStore} from '../lib/trading/sqlite-store.js';
import {DashboardPublisher,LIVE_PUBLISH_MS} from '../lib/trading/dashboard-publisher.js';
import {TradingStore} from '../lib/trading/store.js';
import {TradingEngine} from '../lib/trading/engine.js';
import {TradingNotifier} from '../lib/trading/notifier.js';
import {POLICY,hash} from '../lib/trading/core.js';
import {assertTradingRuntime} from '../lib/trading/runtime-guard.js';
import {failureDetails} from '../lib/trading/failure.js';
import {RuntimePerformance} from '../lib/trading/runtime-performance.js';
const env=process.env;
const runtime=await assertTradingRuntime(env);
const seed=JSON.parse(await readFile(new URL('../data/trading/bootstrap.json',import.meta.url),'utf8'));
if(seed.kind!=='HISTORICAL_ONLY'||seed.exchange!=='KRAKEN'||seed.instrument!=='BTC/USD_SPOT')throw Error('HISTORICAL_MARKET_MISMATCH');
const local=env.LUMI_TRADING_STORAGE==='SQLITE';
const db=local?null:createClient(env.SUPABASE_URL,env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false},global:{fetch:(url,opts={})=>fetch(url,{...opts,signal:AbortSignal.timeout(8000)})}});
if(env.LUMI_TRADING_SECONDARY_PROFILE&&!['secondary-growth-1.0.0','secondary-paper-exploration-1.0.0','OFF'].includes(env.LUMI_TRADING_SECONDARY_PROFILE))throw Error('SECONDARY_RISK_PROFILE_UNKNOWN');
if(env.LUMI_TRADING_SECONDARY_PROFIT_POLICY&&!['secondary-profit-policy-1.0.0','secondary-profit-policy-2.0.0','OFF'].includes(env.LUMI_TRADING_SECONDARY_PROFIT_POLICY))throw Error('SECONDARY_PROFIT_POLICY_UNKNOWN');
if(env.LUMI_TRADING_SECONDARY_RISK_BUDGET&&!['secondary-risk-budget-1.0.0','secondary-risk-budget-2.0.0','OFF'].includes(env.LUMI_TRADING_SECONDARY_RISK_BUDGET))throw Error('SECONDARY_RISK_BUDGET_UNKNOWN');
if(env.LUMI_TRADING_SECONDARY_TIMEFRAMES&&!['secondary-timeframes-1.0.0','secondary-timeframes-2.0.0','OFF'].includes(env.LUMI_TRADING_SECONDARY_TIMEFRAMES))throw Error('SECONDARY_TIMEFRAMES_UNKNOWN');
if(env.LUMI_TRADING_SECONDARY_QUANT&&!['secondary-quant-1.0.0','OFF'].includes(env.LUMI_TRADING_SECONDARY_QUANT))throw Error('SECONDARY_QUANT_UNKNOWN');
if(env.LUMI_TRADING_SECONDARY_CONTEXT_PULLBACK&&!['secondary-context-pullback-1.0.0','OFF'].includes(env.LUMI_TRADING_SECONDARY_CONTEXT_PULLBACK))throw Error('SECONDARY_CONTEXT_PULLBACK_UNKNOWN');
if(env.LUMI_TRADING_SECONDARY_OPPORTUNITIES&&!['secondary-quant-opportunities-1.0.0','OFF'].includes(env.LUMI_TRADING_SECONDARY_OPPORTUNITIES))throw Error('SECONDARY_OPPORTUNITIES_UNKNOWN');
if(env.LUMI_TRADING_ENTRY_PROFILE&&env.LUMI_TRADING_ENTRY_PROFILE!=='agile-5bars-1.0.0')throw Error('ENTRY_PROFILE_UNKNOWN');
if(env.LUMI_TRADING_CONTEXT_PROFILE&&env.LUMI_TRADING_CONTEXT_PROFILE!=='context-maker-1.0.0')throw Error('CONTEXT_PROFILE_UNKNOWN');
if(env.LUMI_TRADING_MAKER_SIZING&&env.LUMI_TRADING_MAKER_SIZING!=='maker-sizing-1.0.0')throw Error('MAKER_SIZING_UNKNOWN');
if(env.LUMI_TRADING_NET_EXITS&&env.LUMI_TRADING_NET_EXITS!=='net-exit-1.0.0')throw Error('NET_EXITS_UNKNOWN');
if(env.LUMI_TRADING_LEVERAGE_PROFILE&&env.LUMI_TRADING_LEVERAGE_PROFILE!=='secondary-boost-1.0.0')throw Error('SECONDARY_BOOST_UNKNOWN');
if(env.LUMI_TRADING_CAPACITY_PROFILE&&env.LUMI_TRADING_CAPACITY_PROFILE!=='secondary-capacity-1.0.0')throw Error('SECONDARY_CAPACITY_UNKNOWN');
const store=local?new SQLiteStore(env.LUMI_TRADING_DB_PATH):new TradingStore(db),feed=new KrakenFeed({seed:seed.bars240}),engine=new TradingEngine({store,feed,secondaryRiskRequested:local&&env.LUMI_TRADING_SECONDARY_PROFILE==='secondary-growth-1.0.0',entryProfileRequested:local&&env.LUMI_TRADING_ENTRY_PROFILE==='agile-5bars-1.0.0',contextProfileRequested:local&&env.LUMI_TRADING_CONTEXT_PROFILE==='context-maker-1.0.0',makerSizingRequested:local&&env.LUMI_TRADING_MAKER_SIZING==='maker-sizing-1.0.0',netExitsRequested:local&&env.LUMI_TRADING_NET_EXITS==='net-exit-1.0.0',boostRequested:local&&env.LUMI_TRADING_LEVERAGE_PROFILE==='secondary-boost-1.0.0',capacityRequested:local&&env.LUMI_TRADING_CAPACITY_PROFILE==='secondary-capacity-1.0.0'});
const controls=local&&env.LUMI_TRADING_NET_EXITS==='net-exit-1.0.0'?new PaperControlClient({env,store}):null;engine.controls=controls;
if(env.LUMI_TRADING_ALERTS==='true')engine.notifier=new TradingNotifier({store,db,env,feed,pending:id=>engine.pending(id)});
await engine.initialize();
engine.backgroundNotifications=local;
const performanceMonitor=new RuntimePerformance();
const flush=engine.flush.bind(engine);engine.flush=()=>performanceMonitor.measure('checkpoint',flush);
const operational=installOperational(engine,env),multiResearch=operational??installMultiPattern(engine,env);
// Optional local artifacts are refreshed off the tick path. No training/download
// is awaited by startup, lease renewal, feed or position management.
const neuralTimer=engine.secondaryNeural?setInterval(()=>{void engine.secondaryNeural.refresh();},60000):null;
if(engine.secondaryNeural)void engine.secondaryNeural.refresh();
engine.event({type:'BOOTSTRAP_MANIFEST',sources:seed.sources,input_hash:hash(seed),at:Date.now()});
if(local&&!engine.state.aws_sqlite_enabled_at){engine.state.aws_sqlite_enabled_at=Date.now();engine.notice('VERSION',{type:'AWS_SQLITE_ENABLED',at:engine.state.aws_sqlite_enabled_at},'aws-sqlite-v1');await engine.flush();}
feed.start();
const publisher=local?new DashboardPublisher({store,feed,env,controls}):null;
if(operational)attachOperationalProjection(publisher,store,operational);else if(multiResearch)attachResearchProjection(publisher,store);
const publishTimer=publisher?setInterval(()=>{if(!publisher.busy)void performanceMonitor.measure('dashboard',()=>publisher.publish());},LIVE_PUBLISH_MS):null;
if(publisher)void publisher.publish();
const controlTimer=controls?setInterval(()=>{void controls.poll();},3000):null;
let shutting=false;
const fail=(error)=>{if(shutting)return;shutting=true;multiResearch?.stop();feed.stop();console.error(JSON.stringify({event:'lumi_trading_worker_attention_required',...failureDetails(error)}));process.exitCode=1;setTimeout(()=>process.exit(1),100).unref();};
let tickTask=null;
const timer=setInterval(()=>{if(!engine.busy)tickTask=performanceMonitor.measure('tick',()=>engine.tick()).catch(fail);},1000);
let oldCPU=process.cpuUsage(),oldTime=Date.now();
const resourceTimer=setInterval(()=>{const usage=process.cpuUsage(oldCPU),now=Date.now(),cpu=(usage.user+usage.system)/(now-oldTime)/1000;oldCPU=process.cpuUsage();oldTime=now;const rss=process.memoryUsage().rss;
  console.log(JSON.stringify({event:'lumi_trading_health',connected:feed.state.connected,reconciled:feed.state.reconciled,quotes:feed.counters.quotes,trades:feed.counters.trades,quote_age_ms:feed.state.quote?now-feed.state.quote.event_at:null,cpu_fraction:cpu,rss_bytes:rss,revision:store.revision,mode:'PAPER',secondary_execution:operational?.state.version??null,multi_pattern:operational?null:multiResearch?.state.version??null,performance:performanceMonitor.report(),memory:process.memoryUsage(),queues:{events:engine.events.length,notices:engine.notices.length,market:operational?.queue?.length??0,telegram_busy:Boolean(engine.notificationTask),detail_busy:Boolean(publisher?.detailBusy)},dashboard_cache:publisher?.readCache.status()}));
  if(rss>320*1024*1024||cpu>.5){engine.event({type:'DATA_INCIDENT',reason:'RESOURCE_LIMIT',at:now});void stop('RESOURCE_LIMIT',1);}
},60000);
async function stop(reason='ORDER_CANCELLED_ON_SHUTDOWN',exitCode=0){
 if(shutting)return;shutting=true;clearInterval(timer);clearInterval(resourceTimer);clearInterval(publishTimer);clearInterval(controlTimer);clearInterval(neuralTimer);multiResearch?.stop();feed.stop();
 let timeout;
 try{
  await Promise.race([(async()=>{await tickTask;await engine.notificationTask;})(),new Promise((_,reject)=>{timeout=setTimeout(()=>reject(Error('TRADING_SHUTDOWN_TIMEOUT')),15000);})]);
  clearTimeout(timeout);
  if(engine.notificationResult){const r=engine.notificationResult;await engine.applyNotificationOutcomes(r.outcomes,r.since);engine.notificationResult=null;}
  engine.cancelPending(reason);await engine.flush();await store.tx({phase:'RELEASE'});performanceMonitor.close();process.exit(exitCode);
 }catch(error){console.error(JSON.stringify({event:'lumi_trading_worker_attention_required',...failureDetails(error)}));process.exit(1);}
}
process.on('SIGTERM',stop);process.on('SIGINT',stop);process.on('unhandledRejection',fail);process.on('uncaughtException',fail);
console.log(JSON.stringify({event:'lumi_trading_started',mode:'PAPER',platform:runtime.platform,policy_hash:hash(POLICY),notifications:!!engine.notifier,secondary_execution:operational?.state.version??null}));
