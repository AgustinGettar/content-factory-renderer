// Read-only, bounded diagnostic. Never a deployed monitor or an alert source.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {KrakenFeed} from '../lib/trading/feed.js';
import {freshness,hash,VERSION} from '../lib/trading/core.js';
import {evaluate,newStrategyState} from '../lib/trading/strategies.js';
const seed=JSON.parse(await readFile(new URL('../data/trading/bootstrap.json',import.meta.url),'utf8'));
const feed=new KrakenFeed({seed:seed.bars240}),samples=[],incidents=[];let last=0;
feed.on('incident',e=>incidents.push(e));
feed.on('quote',()=>{const now=Date.now();if(feed.state.reconciled&&now-last>=1000&&samples.length<15){last=now;const s=feed.snapshot();samples.push({at:now,quote:s.quote,trade:s.trade,clock:s.clock,quality:freshness(s,now,feed.metadata)});}});
feed.start();await new Promise(resolve=>setTimeout(resolve,60000));feed.stop();
const now=Date.now(),cutoff=Math.floor(now/900000)*900000;
const rules=evaluate(newStrategyState(),feed.series,cutoff,now,feed.metadata||{});
const live=feed.snapshot();const stale={...live,connected:true,reconciled:true,quote:live.quote?{...live.quote,event_at:now-6000,received_at:now-6000}:null};
const report={kind:'READ_ONLY_LIVE_DIAGNOSTIC_NOT_DEPLOYMENT',at:now,version:VERSION,bootstrap_hash:hash(seed),metadata:feed.metadata,samples,incidents,bars:Object.fromEntries(Object.entries(feed.series).map(([k,v])=>[k,{count:v.length,first:v[0]?.start,last:v.at(-1)?.end}])),ruleEvaluation:{reason:rules.reason,context:rules.context,plans:rules.plans.length},staleInjection:{synthetic:true,result:freshness(stale,now,feed.metadata)},resources:{memory:process.memoryUsage(),usage:process.resourceUsage()},telegram_calls:0};
await mkdir('docs/trading/evidence',{recursive:true});await writeFile('docs/trading/evidence/live-probe.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({samples:samples.length,valid:samples.filter(s=>s.quality===null).length,bars:report.bars,rules:report.ruleEvaluation,stale:report.staleInjection,incidents:incidents.map(x=>x.reason)}));
if(samples.length<3||!samples.some(s=>s.quality===null)||report.staleInjection.result!=='STALE_QUOTE')process.exitCode=1;
