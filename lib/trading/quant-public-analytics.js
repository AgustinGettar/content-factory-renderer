// Public Kraken analytics: strict timestamps, explicit units, no order capability.
import {hash} from './core.js';
export const ANALYTICS_VERSION='kraken-public-analytics-normalization-1.0.0';
export const ANALYTICS_TYPES=Object.freeze(['open-interest','cvd','trade-volume','aggressor-differential','liquidation-volume','spreads','liquidity','slippage','future-basis','funding']);
const numeric=x=>x!==null&&x!==undefined&&typeof x!=='boolean'&&String(x).trim()!==''&&Number.isFinite(Number(x));
const number=x=>numeric(x)?Number(x):null;
const at=(d,path,i)=>path.reduce((v,k)=>v?.[k],d)?.[i];
export function normalizeAnalytics(type,payload,{receivedAt,interval=60}={}){
 if(!ANALYTICS_TYPES.includes(type)||!Number.isSafeInteger(receivedAt)||interval!==60||payload?.errors?.length||!Array.isArray(payload?.result?.timestamp))throw Error('ANALYTICS_SCHEMA_INVALID');
 const {timestamp,data}=payload.result,rows=[];let previous=-Infinity;
 for(let i=0;i<timestamp.length;i++){
  const start=Number(timestamp[i])*(type==='funding'?1:1000),end=start+interval*1000;
  if(!Number.isSafeInteger(start)||start%60000||start<=previous)throw Error('ANALYTICS_TIMESTAMP_INVALID');previous=start;
  if(end>receivedAt)continue; // only complete buckets, never a future feature
  let values;
  if(type==='cvd'){
   const buy=number(at(data,['buy_volume'],i)),sell=number(at(data,['sell_volume'],i));
   values={buy_volume:buy,sell_volume:sell,delta:buy!=null&&sell!=null?buy-sell:null,imbalance:buy!=null&&sell!=null&&buy+sell>0?(buy-sell)/(buy+sell):null};
   if(buy==null||sell==null||buy<0||sell<0)throw Error('ANALYTICS_VALUE_INVALID');
  }else if(type==='open-interest'){
   const ohlc=data?.[i];if(!Array.isArray(ohlc)||ohlc.length!==4||!ohlc.every(numeric)||ohlc.some(x=>Number(x)<0))throw Error('ANALYTICS_VALUE_INVALID');
   values={open:Number(ohlc[0]),high:Number(ohlc[1]),low:Number(ohlc[2]),close:Number(ohlc[3])};
  }else if(type==='spreads'){
   const bid=number(at(data,['bid','best_price'],i)),ask=number(at(data,['ask','best_price'],i));
   if(!(bid>0&&ask>=bid))throw Error('ANALYTICS_VALUE_INVALID');values={bid,ask,spread_bps:10000*(ask-bid)/((ask+bid)/2)};
  }else if(type==='slippage'||type==='liquidity'){
   values={};for(const side of ['bid','ask']){values[side]={};for(const key of Object.keys(data?.[side]??{})){const v=number(at(data,[side,key],i));if(v==null||v<0)throw Error('ANALYTICS_VALUE_INVALID');values[side][key]=v;}}
   if(!Object.keys(values.bid).length||!Object.keys(values.ask).length)throw Error('ANALYTICS_SCHEMA_INVALID');
  }else if(type==='funding'){
   values={};for(const key of ['rate','relativeRate']){const row=at(data,[key],i);if(!Array.isArray(row)||row.length!==4||!row.every(numeric))throw Error('ANALYTICS_VALUE_INVALID');values[key]=row.map(Number);}
  }else {const v=number(type==='future-basis'?at(data,['basis'],i):data?.[i]);if(v==null)throw Error('ANALYTICS_VALUE_INVALID');values={value:v};}
  rows.push({start,end,available_at:receivedAt,...values});
 }
 const units={cvd:'PROVIDER_VOLUME_RELATIVE_ONLY','open-interest':'PROVIDER_UNITS_RELATIVE_CHANGE_ONLY',slippage:'EXECUTION_PRICE_NOT_PERCENT',liquidity:'PROVIDER_UNITS_NOT_EXECUTABLE_QUANTITY',funding:'PROVIDER_OHLC_NOT_SETTLED_LEDGER_FUNDING','aggressor-differential':'RAW_SIGN_UNTRUSTED_USE_CVD_BUY_MINUS_SELL'};
 return {version:ANALYTICS_VERSION,type,source:'KRAKEN_PUBLIC_ANALYTICS_PF_XBTUSD',units:units[type]??'PROVIDER_REPORTED',received_at:receivedAt,source_hash:hash(payload),more:payload.result.more===true,rows,authority:'OBSERVATION_ONLY'};
}
export function analyticsSnapshot(cache,cutoff,now){
 const available=type=>(cache?.[type]?.rows??[]).filter(r=>r.end<=cutoff&&r.available_at<=now);
 const cvd=available('cvd').slice(-3),oi=available('open-interest').slice(-4),last=cvd.at(-1);
 if(cvd.length!==3||last.end<cutoff-120000||cvd.some((x,i)=>i&&x.start!==cvd[i-1].end)||now-(cache?.cvd?.received_at??0)>180000)return {version:ANALYTICS_VERSION,status:'UNAVAILABLE',reason:'FLOW_STALE_INCOMPLETE_OR_NOT_YET_AVAILABLE',cutoff,authority:'NONE'};
 const buy=cvd.reduce((s,r)=>s+r.buy_volume,0),sell=cvd.reduce((s,r)=>s+r.sell_volume,0),firstOI=oi[0],lastOI=oi.at(-1),oiValid=oi.length===4&&lastOI.end===last.end&&firstOI.close>0&&oi.every((x,i)=>!i||x.start===oi[i-1].end);
 return {version:ANALYTICS_VERSION,status:'READY',cutoff:last.end,available_at:Math.max(...cvd.map(r=>r.available_at)),flow_imbalance:buy+sell>0?(buy-sell)/(buy+sell):null,open_interest_change:oiValid?lastOI.close/firstOI.close-1:null,window_ms:180000,source_hash:hash(cvd),authority:'SHADOW_COMPARISON_ONLY'};
}
export class PublicAnalyticsFeed{
 constructor({fetchImpl=fetch,now=()=>Date.now()}={}){Object.assign(this,{fetchImpl,now});this.cache={};this.errors={};this.busy=false;this.lastAttempt=null;this.stopped=false;}
 async refresh(){if(this.stopped||this.busy||this.lastAttempt!=null&&this.now()-this.lastAttempt<60000)return;this.busy=true;this.lastAttempt=this.now();
  try{const to=Math.floor(this.now()/60000)*60,since=to-600;
   // Bounded pairs keep failures and endpoint load isolated from the trading feed.
   for(let i=0;i<ANALYTICS_TYPES.length&&!this.stopped;i+=2)await Promise.allSettled(ANALYTICS_TYPES.slice(i,i+2).map(async type=>{
    try{const url=`https://futures.kraken.com/api/charts/v1/analytics/PF_XBTUSD/${type}?since=${since}&to=${to}&interval=60`,r=await this.fetchImpl(url,{method:'GET',redirect:'error',signal:AbortSignal.timeout(3000)});
     if(!r.ok)throw Error('ANALYTICS_HTTP_ERROR');const payload=await r.json(),normalized=normalizeAnalytics(type,payload,{receivedAt:this.now()});
     if(!normalized.rows.length)throw Error('ANALYTICS_NO_CLOSED_BUCKETS');this.cache[type]={...normalized,rows:normalized.rows.slice(-10)};delete this.errors[type];
    }catch(error){this.errors[type]={at:this.now(),reason:/^[A-Z_]+$/.test(error.message)?error.message:'ANALYTICS_UNAVAILABLE'};}
   }));
  }finally{this.busy=false;}
 }
 view(now=this.now()){return {version:ANALYTICS_VERSION,authority:'OBSERVATION_ONLY',last_attempt:this.lastAttempt,errors:{...this.errors},sources:Object.fromEntries(ANALYTICS_TYPES.map(type=>{const c=this.cache[type],r=c?.rows.at(-1);return [type,{status:r&&now-c.received_at<=180000?'READY':'UNAVAILABLE',last_closed_at:r?.end??null,received_at:c?.received_at??null,source_hash:c?.source_hash??null,units:c?.units??null}];})),snapshot:analyticsSnapshot(this.cache,Math.floor(now/60000)*60000,now)};}
}
