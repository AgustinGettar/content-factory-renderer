// External research archive. Public data only; never runs against the worker DB.
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {gzipSync} from 'node:zlib';
import {ANALYTICS_TYPES,normalizeAnalytics} from '../lib/trading/quant-public-analytics.js';
import {requireExternalResearch} from '../lib/trading/quant-experiments.js';
import {hash} from '../lib/trading/core.js';
requireExternalResearch();
const args=Object.fromEntries(process.argv.slice(2).reduce((a,x,i,all)=>x.startsWith('--')?[...a,[x.slice(2),all[i+1]]]:a,[]));
const hours=Number(args.hours??24),end=Number(args.end??Math.floor(Date.now()/60000)*60);
if(!args.output||!Number.isInteger(hours)||hours<1||hours>168||!Number.isSafeInteger(end)||end%60||end*1000>Date.now())throw Error('OUTPUT_HOURS_1_TO_168_AND_CLOSED_END_REQUIRED');
await mkdir(args.output,{recursive:true});const manifest={version:1,symbol:'PF_XBTUSD',interval_seconds:60,start:end-hours*3600,end,generated_at:Date.now(),types:{},realTrading:false,retrospective_data_not_available_at_original_decisions:true};
for(const type of ANALYTICS_TYPES){const rows=[],requests=[];
 for(let since=end-hours*3600;since<end;since+=3600){const to=Math.min(end,since+3600),url=`https://futures.kraken.com/api/charts/v1/analytics/PF_XBTUSD/${type}?since=${since}&to=${to}&interval=60`;
  const r=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(10000)});if(!r.ok)throw Error('ANALYTICS_HTTP_'+r.status);const payload=await r.json(),normalized=normalizeAnalytics(type,payload,{receivedAt:Date.now()});
  if(normalized.more)throw Error('ANALYTICS_PAGINATION_REQUIRED');rows.push(...normalized.rows.filter(x=>x.start>=since*1000&&x.end<=to*1000));requests.push({url,source_hash:normalized.source_hash,received_at:normalized.received_at,units:normalized.units});
 }
 const ordered=[...new Map(rows.map(r=>[r.start,r])).values()].sort((a,b)=>a.start-b.start),gaps=ordered.slice(1).filter((r,i)=>r.start!==ordered[i].end).map(r=>r.start);
 const archive={version:1,type,rows:ordered,requests},file=type+'.json.gz';await writeFile(path.join(args.output,file),gzipSync(JSON.stringify(archive)));
 manifest.types[type]={file,rows:ordered.length,expected_rows:hours*60,gaps,first:ordered[0]?.start,last:ordered.at(-1)?.end,hash:hash(archive)};console.log(JSON.stringify({type,rows:ordered.length,gaps:gaps.length}));
}
await writeFile(path.join(args.output,'manifest.json'),JSON.stringify(manifest,null,2));
