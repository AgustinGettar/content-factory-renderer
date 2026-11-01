// Bounded public-data replay. Does not open a database, load credentials, or trade.
import {mkdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {PROTOCOL,closedBars,evaluatePatterns,economics} from '../lib/trading/multi-pattern-paper.js';
const out=process.argv[2]??'/tmp/lumi-multi-pattern-study';
const end=Math.floor(Date.now()/60000)*60000,start=end-14*86400000,warm=start-2*86400000,split=start+10*86400000;
async function get(path){const r=await fetch('https://futures.kraken.com'+path,{method:'GET',redirect:'error',signal:AbortSignal.timeout(12000)});if(!r.ok)throw Error('PUBLIC_DATA_HTTP_'+r.status);return r.json();}
async function history(tf){
 let to=Math.floor(end/1000)-1;const result=new Map();
 for(let page=0;page<16;page++){
  const path='/api/charts/v1/trade/PF_XBTUSD/'+tf+'m?count=2000&from='+Math.floor(warm/1000)+'&to='+to;
  const d=await get(path),rows=closedBars(d,tf,end);if(!rows.length)break;
  for(const b of rows)if(b.start>=warm&&b.end<=end)result.set(b.start,b);
  const next=Math.floor(rows[0].start/1000)-1;if(next>=to)throw Error('PUBLIC_DATA_PAGINATION_STALLED');to=next;
  if(rows[0].start<=warm||!d.more_candles)break;
 }
 return [...result.values()].sort((a,b)=>a.start-b.start);
}
const bars={};for(const tf of [1,5,15])bars[tf]=await history(tf);
const rawRates=await get('/derivatives/api/v3/historical-funding-rates?symbol=PF_XBTUSD');
const rates=Object.fromEntries((rawRates.rates??[]).map(r=>[Date.parse(r.timestamp),Number(r.fundingRate)]));
const index=new Map(bars[1].map(b=>[b.start,b]));
const results={};
function funding(qty,entry,direction,from,to){let n=0,missing=false;while(from<to){const hour=Math.floor(from/3600000)*3600000,last=Math.min(to,hour+3600000),rate=rates[hour];if(!Number.isFinite(rate)){missing=true;n+=qty*entry*0.005*(last-from)/3600000;}else n+=(direction==='LONG'?1:-1)*qty*rate*(last-from)/3600000;from=last;}return {amount:n,missing};}
function metrics(rows){let equity=1000,peak=1000,dd=0;for(const x of rows){equity+=x.net;peak=Math.max(peak,equity);dd=Math.max(dd,1-equity/peak);}const wins=rows.filter(x=>x.net>0),losses=rows.filter(x=>x.net<=0),profits=wins.reduce((s,x)=>s+x.net,0),loss=-losses.reduce((s,x)=>s+x.net,0);return {n:rows.length,net:rows.reduce((s,x)=>s+x.net,0),gross:rows.reduce((s,x)=>s+x.gross,0),fees:rows.reduce((s,x)=>s+x.fees,0),funding:rows.reduce((s,x)=>s+x.funding,0),wins:wins.length,win_rate:rows.length?wins.length/rows.length:null,profit_factor:loss>0?profits/loss:null,average_net:rows.length?rows.reduce((s,x)=>s+x.net,0)/rows.length:null,max_drawdown:dd,stress_net:rows.reduce((s,x)=>s+x.stress_net,0),ambiguous:rows.filter(x=>x.ambiguous).length,funding_missing:rows.filter(x=>x.funding_missing).length};}
for(const pattern of PROTOCOL.patterns){
 const trades=[],decisions={};let freeAt=start;
 for(let i=64;i<bars[5].length;i++){
  const cutoff=bars[5][i].end;if(cutoff<start||cutoff>=end-PROTOCOL.holdingMs||cutoff<freeAt)continue;
  if(cutoff<split&&cutoff+PROTOCOL.holdingMs>=split)continue;
  const first=index.get(cutoff);if(!first)continue;
  const quote={bid:first.open-0.5,ask:first.open+0.5};
  const data={5:bars[5].slice(Math.max(0,i-255),i+1),15:bars[15].filter(b=>b.end<=cutoff).slice(-256)};
  const d=evaluatePatterns(data,quote,cutoff,rates[Math.floor(cutoff/3600000)*3600000]??0).find(x=>x.pattern===pattern);
  decisions[d.reason]=(decisions[d.reason]??0)+1;if(!d.plan)continue;
  const p=d.plan,sign=p.direction==='LONG'?1:-1,qty=Math.floor((1000/p.entry)/0.0001)*0.0001;
  if(!(qty>0))continue;
  let price=null,at=null,reason=null,ambiguous=false,missing=false;
  for(let t=cutoff;t<cutoff+PROTOCOL.holdingMs;t+=60000){
   const b=index.get(t);if(!b){missing=true;break;}
   const stop=sign>0?b.low-0.5<=p.stop:b.high+0.5>=p.stop,target=sign>0?b.high-0.5>=p.target:b.low+0.5<=p.target;
   if(stop||target){ambiguous=stop&&target;reason=stop?'STOP':'TARGET';const level=stop?p.stop:p.target;
    const raw=stop?(sign>0?Math.min(level,b.open-0.5):Math.max(level,b.open+0.5)):level;price=raw*(1-sign*PROTOCOL.slippage);at=b.end;break;}
   if(b.end>=cutoff+PROTOCOL.holdingMs){price=(b.close-sign*0.5)*(1-sign*PROTOCOL.slippage);at=b.end;reason='TIMEOUT';}
  }
  if(missing||price===null){decisions.MISSING_1M_PATH=(decisions.MISSING_1M_PATH??0)+1;continue;}
  const gross=sign*(price-p.entry)*qty,fees=(price+p.entry)*qty*PROTOCOL.takerFee,f=funding(qty,p.entry,p.direction,cutoff,at),net=gross-fees-f.amount;
  const stress=net-fees*0.5-(p.entry+price)*qty*0.0005-Math.abs(f.amount)*0.5;
  trades.push({pattern,at:cutoff,exit_at:at,entry:p.entry,price,direction:p.direction,qty,reason,gross,fees,funding:f.amount,net,stress_net:stress,ambiguous,funding_missing:f.missing});freeAt=at;
 }
 results[pattern]={all:metrics(trades),development:metrics(trades.filter(t=>t.at<split)),holdout:metrics(trades.filter(t=>t.at>=split)),decisions,trades};
}
const dataset={symbol:PROTOCOL.symbol,from:new Date(warm).toISOString(),to:new Date(end).toISOString(),counts:Object.fromEntries(Object.entries(bars).map(([k,v])=>[k,v.length])),sha256:createHash('sha256').update(JSON.stringify({bars,rates})).digest('hex')};
const summary={generated_at:new Date().toISOString(),kind:'COARSE_OHLC_RESEARCH_NOT_EXECUTION_EVIDENCE',protocol:PROTOCOL,window:{start:new Date(start).toISOString(),split:new Date(split).toISOString(),end:new Date(end).toISOString()},dataset,assumptions:['Closed 5m signals and closed 15m context; no parameter optimization.','Next 1m open entry, assumed one USD full spread, two taker fees and 2 bps slippage on each side.','One position per pattern, 1000 USD fixed notional before quantity rounding; independent comparisons, not summed portfolio returns.','One-minute intrabar path is unknown; both barriers resolves stop first.','Funding uses public hourly rates; missing funding is charged conservatively and flagged.','Stress adds 50% trading fees and 5 bps slippage on each side.','Missing minute paths are counted separately and excluded, not called fills.','Four-day chronological holdout is too short to establish profitability.'],results:Object.fromEntries(Object.entries(results).map(([k,v])=>[k,{...v,trades:undefined}])),automatic_promotion:false};
await mkdir(out,{recursive:true,mode:0o700});await writeFile(out+'/data.json',JSON.stringify({dataset,bars,rates}),{mode:0o600});await writeFile(out+'/trades.json',JSON.stringify(results),{mode:0o600});await writeFile(out+'/summary.json',JSON.stringify(summary,null,2),{mode:0o600});console.log(JSON.stringify(summary));
