#!/usr/bin/env node
// Single-run public-market observation. Does not start an exchange client,
// use private credentials, write SQLite, or place PAPER/real orders.
import {DatabaseSync} from 'node:sqlite';
import {classifySecondaryMarketRegime} from '../lib/trading/secondary-market-regime.js';
import {observeSecondaryScalpingShadow} from '../lib/trading/secondary-scalping-shadow.js';
const SYMBOL='PF_XBTUSD',BASE='https://futures.kraken.com/api/charts/v1/trade/';
async function candles(resolution,minutes,now) {
 const url=BASE+SYMBOL+'/'+resolution+'?count=230';
 const r=await fetch(url,{signal:AbortSignal.timeout(9000)});
 if(!r.ok)throw Error('PUBLIC_CHARTS_HTTP_'+r.status);
 const body=await r.json();
 if(!Array.isArray(body.candles))throw Error('PUBLIC_CHARTS_BAD_BODY');
 // The observed futures charts timestamps mark the candle END, unlike spot
 // OHLC starts. Never admit a chart candle ending after the decision cutoff.
 const duration=minutes*60000;
 return body.candles.map(c=>({start:Number(c.time)-duration,end:Number(c.time),
  open:Number(c.open),high:Number(c.high),low:Number(c.low),close:Number(c.close),
  volume:Number(c.volume),available_at:now,source:'KRAKEN_FUTURES_PUBLIC_TRADE_CHARTS'}))
  .sort((a,b)=>a.end-b.end);
}
async function publicFundingRate(){
 try {
  const r=await fetch('https://futures.kraken.com/derivatives/api/v3/tickers',{signal:AbortSignal.timeout(8000)});
  if(!r.ok)return null;
  const j=await r.json(),ticker=(j.tickers??[]).find(t=>t.symbol===SYMBOL);
  const f=ticker?.fundingRate??ticker?.funding_rate;
  return f!==null&&f!==undefined&&Number.isFinite(Number(f))?Number(f):null;
 } catch{return null;}
}
const start=Date.now(),dbPath='/var/lib/lumi-trading/trading.sqlite';
const [series5,series15,fundingRate]=await Promise.all([
 candles('5m',5,start),candles('15m',15,start),publicFundingRate()
]);
const db=new DatabaseSync(dbPath,{readOnly:true,timeout:3000});
let quote,revision,account;
try {
 const row=db.prepare('SELECT state,revision FROM state LIMIT 1').get();
 if(!row)throw Error('PAPER_STATE_MISSING');
 const root=JSON.parse(row.state);
 if(!root.secondaryExecution||root.secondaryExecution.market?.symbol!==SYMBOL)
  throw Error('PAPER_FUTURES_STATE_REQUIRED');
 quote=root.secondaryExecution.market.quote;
 revision=row.revision;
 account=root.frequency?.account?.closed;
}finally{db.close();}
const now=Date.now(),cutoff=Math.floor(now/300000)*300000;
const filtered5=series5.filter(b=>b.end<=cutoff);
const filtered15=series15.filter(b=>b.end<=Math.floor(cutoff/900000)*900000);
const regime5=classifySecondaryMarketRegime(filtered5,{timeframe:5,cutoff,now,quote});
const regime15=classifySecondaryMarketRegime(filtered15,{timeframe:15,cutoff:Math.floor(cutoff/900000)*900000,now,quote});
const observation=observeSecondaryScalpingShadow({
 series:filtered5,quote,regime:regime5,contextRegime:regime15,fundingRate,cutoff,now});
console.log(JSON.stringify({mode:'PAPER',authority:'NONE',source:'PUBLIC_KRAKEN_FUTURES_CHARTS_AND_READONLY_LOCAL_QUOTE',
 observation_at:new Date(now).toISOString(),state_revision:revision,account_closed_unchanged:account,
 series:{five_minutes:filtered5.length,fifteen_minutes:filtered15.length},
 regime_5m:regime5.regime,regime_15m:regime15.regime,
 funding_observed:fundingRate!==null,observation},null,2));
