// Dedicated supervised Render background worker. Does NOT start server.js,
// mount routes, consume Telegram updates, invoke media, or access order APIs.
import {readFile} from 'node:fs/promises';
import {createClient} from '@supabase/supabase-js';
import {KrakenFeed} from '../lib/trading/feed.js';
import {TradingStore} from '../lib/trading/store.js';
import {TradingEngine} from '../lib/trading/engine.js';
import {TradingNotifier} from '../lib/trading/notifier.js';
import {POLICY,hash} from '../lib/trading/core.js';
const env=process.env;
if(env.LUMI_RUNTIME_ENV!=='staging'||env.LUMI_TRADING_MODE!=='PAPER'||env.SUPABASE_URL!=='https://mofjhwathxzfnjapvvst.supabase.co'||env.RENDER_GIT_BRANCH!=='lumi-telegram-review-v1'||!env.LUMI_TRADING_RENDER_SERVICE_ID||env.RENDER_SERVICE_ID!==env.LUMI_TRADING_RENDER_SERVICE_ID||env.RENDER_SERVICE_ID==='srv-dapgakqd0e5s73fottig')throw Error('TRADING_DEDICATED_STAGING_WORKER_REQUIRED');
if(Object.keys(env).some(k=>/KRAKEN.*(SECRET|PRIVATE|API_KEY)/.test(k)))throw Error('TRADING_PUBLIC_MARKET_ONLY');
const seed=JSON.parse(await readFile(new URL('../data/trading/bootstrap.json',import.meta.url),'utf8'));
if(seed.kind!=='HISTORICAL_ONLY'||seed.exchange!=='KRAKEN'||seed.instrument!=='BTC/USD_SPOT')throw Error('HISTORICAL_MARKET_MISMATCH');
const db=createClient(env.SUPABASE_URL,env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false},global:{fetch:(url,opts={})=>fetch(url,{...opts,signal:AbortSignal.timeout(8000)})}});
const store=new TradingStore(db),feed=new KrakenFeed({seed:seed.bars240}),engine=new TradingEngine({store,feed});
if(env.LUMI_TRADING_ALERTS==='true')engine.notifier=new TradingNotifier({store,db,env,feed,pending:id=>engine.pending(id)});
await engine.initialize();engine.event({type:'BOOTSTRAP_MANIFEST',sources:seed.sources,input_hash:hash(seed),at:Date.now()});feed.start();
let shutting=false;
const fail=(error)=>{if(shutting)return;shutting=true;feed.stop();console.error(JSON.stringify({event:'lumi_trading_worker_attention_required',code:/^[A-Z0-9_]+$/.test(error?.message||'')?error.message:'TRADING_UNEXPECTED_FAILURE'}));process.exitCode=1;setTimeout(()=>process.exit(1),100).unref();};
const timer=setInterval(()=>{void engine.tick().catch(fail);},1000);
let oldCPU=process.cpuUsage(),oldTime=Date.now();
const resourceTimer=setInterval(()=>{const usage=process.cpuUsage(oldCPU),now=Date.now(),cpu=(usage.user+usage.system)/(now-oldTime)/1000;oldCPU=process.cpuUsage();oldTime=now;const rss=process.memoryUsage().rss;
  console.log(JSON.stringify({event:'lumi_trading_health',connected:feed.state.connected,reconciled:feed.state.reconciled,quotes:feed.counters.quotes,trades:feed.counters.trades,quote_age_ms:feed.state.quote?now-feed.state.quote.event_at:null,cpu_fraction:cpu,rss_bytes:rss,revision:store.revision,mode:'PAPER'}));
  if(rss>320*1024*1024||cpu>.5){engine.cancelPending('RESOURCE_LIMIT');engine.event({type:'DATA_INCIDENT',reason:'RESOURCE_LIMIT',at:now});void engine.flush().finally(fail);}
},60000);
async function stop(){if(shutting)return;shutting=true;clearInterval(timer);clearInterval(resourceTimer);feed.stop();engine.cancelPending('ORDER_CANCELLED_ON_SHUTDOWN');try{if(!engine.busy)await engine.flush();await store.tx({phase:'RELEASE'});}finally{process.exit(0);}}
process.on('SIGTERM',stop);process.on('SIGINT',stop);process.on('unhandledRejection',fail);process.on('uncaughtException',fail);
console.log(JSON.stringify({event:'lumi_trading_started',mode:'PAPER',policy_hash:hash(POLICY),notifications:!!engine.notifier}));
