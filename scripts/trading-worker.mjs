import {PaperControlClient} from '../lib/trading/paper-controls.js';
// Dedicated supervised Render, Compute Engine or EC2 worker. Does NOT start server.js,
// mount routes, consume Telegram updates, invoke media, or access order APIs.
import {readFile} from 'node:fs/promises';
import {createClient} from '@supabase/supabase-js';
import {KrakenFeed} from '../lib/trading/feed.js';
import {SQLiteStore} from '../lib/trading/sqlite-store.js';
import {DashboardPublisher} from '../lib/trading/dashboard-publisher.js';
import {TradingStore} from '../lib/trading/store.js';
import {TradingEngine} from '../lib/trading/engine.js';
import {TradingNotifier} from '../lib/trading/notifier.js';
import {POLICY,hash} from '../lib/trading/core.js';
import {assertTradingRuntime} from '../lib/trading/runtime-guard.js';
import {failureDetails} from '../lib/trading/failure.js';
const env=process.env;
const runtime=await assertTradingRuntime(env);
const seed=JSON.parse(await readFile(new URL('../data/trading/bootstrap.json',import.meta.url),'utf8'));
if(seed.kind!=='HISTORICAL_ONLY'||seed.exchange!=='KRAKEN'||seed.instrument!=='BTC/USD_SPOT')throw Error('HISTORICAL_MARKET_MISMATCH');
const local=env.LUMI_TRADING_STORAGE==='SQLITE';
const db=local?null:createClient(env.SUPABASE_URL,env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false},global:{fetch:(url,opts={})=>fetch(url,{...opts,signal:AbortSignal.timeout(8000)})}});
if(env.LUMI_TRADING_SECONDARY_PROFILE&&env.LUMI_TRADING_SECONDARY_PROFILE!=='secondary-growth-1.0.0')throw Error('SECONDARY_RISK_PROFILE_UNKNOWN');
if(env.LUMI_TRADING_ENTRY_PROFILE&&env.LUMI_TRADING_ENTRY_PROFILE!=='agile-5bars-1.0.0')throw Error('ENTRY_PROFILE_UNKNOWN');
if(env.LUMI_TRADING_CONTEXT_PROFILE&&env.LUMI_TRADING_CONTEXT_PROFILE!=='context-maker-1.0.0')throw Error('CONTEXT_PROFILE_UNKNOWN');
if(env.LUMI_TRADING_MAKER_SIZING&&env.LUMI_TRADING_MAKER_SIZING!=='maker-sizing-1.0.0')throw Error('MAKER_SIZING_UNKNOWN');
if(env.LUMI_TRADING_NET_EXITS&&env.LUMI_TRADING_NET_EXITS!=='net-exit-1.0.0')throw Error('NET_EXITS_UNKNOWN');
if(env.LUMI_TRADING_LEVERAGE_PROFILE&&env.LUMI_TRADING_LEVERAGE_PROFILE!=='secondary-boost-1.0.0')throw Error('SECONDARY_BOOST_UNKNOWN');
const store=local?new SQLiteStore(env.LUMI_TRADING_DB_PATH):new TradingStore(db),feed=new KrakenFeed({seed:seed.bars240}),engine=new TradingEngine({store,feed,secondaryRiskRequested:local&&env.LUMI_TRADING_SECONDARY_PROFILE==='secondary-growth-1.0.0',entryProfileRequested:local&&env.LUMI_TRADING_ENTRY_PROFILE==='agile-5bars-1.0.0',contextProfileRequested:local&&env.LUMI_TRADING_CONTEXT_PROFILE==='context-maker-1.0.0',makerSizingRequested:local&&env.LUMI_TRADING_MAKER_SIZING==='maker-sizing-1.0.0',netExitsRequested:local&&env.LUMI_TRADING_NET_EXITS==='net-exit-1.0.0',boostRequested:local&&env.LUMI_TRADING_LEVERAGE_PROFILE==='secondary-boost-1.0.0'});
const controls=local&&env.LUMI_TRADING_NET_EXITS==='net-exit-1.0.0'?new PaperControlClient({env,store}):null;engine.controls=controls;
if(env.LUMI_TRADING_ALERTS==='true')engine.notifier=new TradingNotifier({store,db,env,feed,pending:id=>engine.pending(id)});
await engine.initialize();engine.event({type:'BOOTSTRAP_MANIFEST',sources:seed.sources,input_hash:hash(seed),at:Date.now()});if(local){if(!engine.state.aws_sqlite_enabled_at){engine.state.aws_sqlite_enabled_at=Date.now();engine.notice('VERSION',{type:'AWS_SQLITE_ENABLED',at:engine.state.aws_sqlite_enabled_at},'aws-sqlite-v1');await engine.flush();}}feed.start();
const publisher=local?new DashboardPublisher({store,feed,env,controls}):null;
const publishTimer=publisher?setInterval(()=>{void publisher.publish();},15000):null;
if(publisher)void publisher.publish();
const controlTimer=controls?setInterval(()=>{void controls.poll();},3000):null;
let shutting=false;
const fail=(error)=>{if(shutting)return;shutting=true;feed.stop();console.error(JSON.stringify({event:'lumi_trading_worker_attention_required',...failureDetails(error)}));process.exitCode=1;setTimeout(()=>process.exit(1),100).unref();};
const timer=setInterval(()=>{void engine.tick().catch(fail);},1000);
let oldCPU=process.cpuUsage(),oldTime=Date.now();
const resourceTimer=setInterval(()=>{const usage=process.cpuUsage(oldCPU),now=Date.now(),cpu=(usage.user+usage.system)/(now-oldTime)/1000;oldCPU=process.cpuUsage();oldTime=now;const rss=process.memoryUsage().rss;
  console.log(JSON.stringify({event:'lumi_trading_health',connected:feed.state.connected,reconciled:feed.state.reconciled,quotes:feed.counters.quotes,trades:feed.counters.trades,quote_age_ms:feed.state.quote?now-feed.state.quote.event_at:null,cpu_fraction:cpu,rss_bytes:rss,revision:store.revision,mode:'PAPER'}));
  if(rss>320*1024*1024||cpu>.5){engine.cancelPending('RESOURCE_LIMIT');engine.event({type:'DATA_INCIDENT',reason:'RESOURCE_LIMIT',at:now});void engine.flush().finally(fail);}
},60000);
async function stop(){if(shutting)return;shutting=true;clearInterval(timer);clearInterval(resourceTimer);clearInterval(publishTimer);clearInterval(controlTimer);feed.stop();engine.cancelPending('ORDER_CANCELLED_ON_SHUTDOWN');try{if(!engine.busy)await engine.flush();await store.tx({phase:'RELEASE'});}finally{process.exit(0);}}
process.on('SIGTERM',stop);process.on('SIGINT',stop);process.on('unhandledRejection',fail);process.on('uncaughtException',fail);
console.log(JSON.stringify({event:'lumi_trading_started',mode:'PAPER',platform:runtime.platform,policy_hash:hash(POLICY),notifications:!!engine.notifier}));
