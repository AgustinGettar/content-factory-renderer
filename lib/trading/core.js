import Decimal from 'decimal.js';
import {createHash} from 'node:crypto';
export const D=x=>new Decimal(x);
export const M15=900000, H1=3600000, H4=14400000;
export const VERSION='lumi-paper-1.1.0';
export const POLICY=Object.freeze({version:VERSION,instrument:'KRAKEN:BTC/USD:SPOT',initialCash:'10000',risk:'0.0025',openRisk:'0.005',dailyLoss:'0.01',drawdown:'0.05',cashReserve:'0.10',fee:'0.008',slippage:'0.0002',feeVerifiedAt:'2026-10-28T22:42:00Z',feeSource:'https://www.kraken.com/features/fee-schedule',quoteAge:5000,tradeAge:30000,noticeAge:30000,spreadBps:5,clockError:1000,manualLatency:60000,engineLatency:1000,warmup240:1000,experimental:true});
export function stable(v){if(Array.isArray(v))return v.map(stable);if(v&&typeof v==='object')return Object.fromEntries(Object.keys(v).sort().map(k=>[k,stable(v[k])]));return v;}
export const hash=v=>createHash('sha256').update(typeof v==='string'?v:JSON.stringify(stable(v))).digest('hex');
export const iso=t=>new Date(t).toISOString();
export const floorTick=(v,t)=>D(v).div(t).floor().mul(t).toString();
export const ceilTick=(v,t)=>D(v).div(t).ceil().mul(t).toString();
export function validBar(b){return Number.isSafeInteger(b.start)&&b.end>b.start&&[b.open,b.high,b.low,b.close].every(x=>Number.isFinite(+x)&&+x>0)&&+b.volume>=0&&+b.low<=Math.min(+b.open,+b.close)&&+b.high>=Math.max(+b.open,+b.close)&&+b.high>=+b.low;}
export function available(bars,cutoff,now){return bars.filter(b=>b.end<=cutoff&&b.available_at<=now);}
export function checkSeries(bars,tf,min){
  if(bars.length<min)return 'INSUFFICIENT_WARMUP';
  for(let i=0;i<bars.length;i++)if(!validBar(bars[i])||bars[i].end-bars[i].start!==tf||bars[i].start%tf||i&&bars[i].start!==bars[i-1].end)return 'BAR_GAP_OR_INVALID';
  return null;
}
export function freshness(feed,now,metadata,policy=POLICY){
  if(!feed.connected||!feed.reconciled)return 'FEED_RECONCILING';
  if(feed.system!=='online'||feed.maintenanceBlocked)return 'EXCHANGE_NOT_ONLINE';
  if(!feed.clock||now-feed.clock.checked_at>90000||feed.clock.error_ms>policy.clockError)return 'CLOCK_UNCERTAIN';
  if(!metadata||now-metadata.checked_at>86400000||metadata.status!=='online')return 'METADATA_EXPIRED';
  const q=feed.quote,t=feed.trade;
  if(!q||now-q.event_at>policy.quoteAge||now-q.received_at>policy.quoteAge||q.event_at>now+1000)return 'STALE_QUOTE';
  if(!t||now-t.event_at>policy.tradeAge||now-t.received_at>policy.tradeAge||t.event_at>now+1000)return 'STALE_TRADE';
  if(!(Number(q.ask)>=Number(q.bid)&&Number(q.bid)>0&&Number(q.ask_qty)>0&&Number(q.bid_qty)>0))return 'INVALID_QUOTE';
  if(D(q.ask).minus(q.bid).div(D(q.ask).plus(q.bid).div(2)).mul(10000).gt(policy.spreadBps))return 'SPREAD_TOO_WIDE';
  return null;
}
export function indicators(bars){
  const out=bars.map(b=>({...b})), n=bars.length;
  const smooth=(xs,len,alpha)=>{let prev=null,run=[];return xs.map(x=>{if(x==null||!Number.isFinite(x)){prev=null;run=[];return null;}if(prev==null){run.push(x);if(run.length<len)return null;prev=run.reduce((a,b)=>a+b,0)/len;}else prev=alpha*x+(1-alpha)*prev;return prev;});};
  const c=bars.map(b=>+b.close),tr=[],plus=[],minus=[];
  for(let i=0;i<n;i++){const b=bars[i],p=bars[i-1];tr.push(p?Math.max(+b.high-b.low,Math.abs(b.high-p.close),Math.abs(b.low-p.close)):null);const up=p?b.high-p.high:0,down=p?p.low-b.low:0;plus.push(p?(up>down&&up>0?up:0):null);minus.push(p?(down>up&&down>0?down:0):null);}
  const atr=smooth(tr,14,1/14),pdm=smooth(plus,14,1/14),mdm=smooth(minus,14,1/14);
  const dx=atr.map((a,i)=>a>0?100*Math.abs(pdm[i]-mdm[i])/(pdm[i]+mdm[i]||1):null),adx=smooth(dx,14,1/14);
  const emas=[20,50,200].map(p=>smooth(c,p,2/(p+1)));
  for(let i=0;i<n;i++){Object.assign(out[i],{atr:atr[i],adx:adx[i],ema20:emas[0][i],ema50:emas[1][i],ema200:emas[2][i]});if(i>=19){const a=c.slice(i-19,i+1),mid=a.reduce((s,x)=>s+x,0)/20,std=Math.sqrt(a.reduce((s,x)=>s+(x-mid)**2,0)/20);Object.assign(out[i],{mid,lower:mid-2*std,upper:mid+2*std});}if(i>=20){const a=bars.slice(i-20,i).map(x=>+x.volume).sort((a,b)=>a-b),med=(a[9]+a[10])/2;out[i].rvol=med>0?+bars[i].volume/med:null;}}
  return out;
}
export function riskPlan(plan,account,quote,meta,policy=POLICY){
  if(plan.direction!=='LONG')return {reason:'SPOT_SHORT_NOT_EXECUTABLE'};
  const entry=D(plan.limit),stop=D(plan.stop),target=D(plan.target),fee=D(policy.fee),slip=D(policy.slippage),spread=D(quote.ask).minus(quote.bid);
  const exitStop=stop.minus(spread).mul(D(1).minus(slip)),exitTP=target.minus(spread).mul(D(1).minus(slip));
  const loss=entry.minus(exitStop).plus(entry.plus(exitStop).mul(fee));
  const gain=exitTP.minus(entry).minus(entry.plus(exitTP).mul(fee));
  if(loss.lte(0)||gain.lte(0)||gain.div(loss).lt(plan.family==='C'?'1.2':'1.5'))return {reason:'NET_RR_TOO_LOW'};
  const equity=D(account.equity),budget=equity.mul(policy.risk),availableCash=Decimal.min(D(account.cash).minus(equity.mul(policy.cashReserve)),equity.mul('0.9'));
  const qtyStep=D(10).pow(-meta.lot_decimals);
  const q=Decimal.min(plan.sizing?.qty||Number.MAX_VALUE,budget.div(loss),availableCash.div(entry.mul(D(1).plus(fee))),D(quote.ask_qty).mul('0.1'),D(quote.bid_qty).mul('0.1')).div(qtyStep).floor().mul(qtyStep);
  if(q.lt(meta.ordermin)||q.mul(entry).lt(meta.costmin)||q.lte(0))return {reason:'MINIMUM_OR_LIQUIDITY'};
  const risk=q.mul(loss),consumed=Decimal.max(0,D(account.dayStart).minus(equity));
  if(account.halted||equity.lte(D(account.peak).mul(D(1).minus(policy.drawdown))))return {reason:'DRAWDOWN_HALT'};
  if(consumed.plus(risk).gt(D(account.dayStart).mul(policy.dailyLoss)))return {reason:'DAILY_RISK_LIMIT'};
  if(risk.gt(equity.mul(policy.openRisk)))return {reason:'OPEN_RISK_LIMIT'};
  return {risk_budget:budget.toString(),spread:spread.toString(),qty:q.toString(),risk:risk.toString(),risk_pct:risk.div(equity).mul(100).toString(),exposure:q.mul(entry).toString(),reserved:q.mul(entry).mul(D(1).plus(fee)).toString(),effective_leverage:q.mul(entry).div(equity).toString(),financing:'SPOT_CASH_1X',net_rr:gain.div(loss).toString(),estimated_cost_loss:q.mul(entry.plus(exitStop).mul(fee).plus(spread).plus(stop.minus(spread).mul(slip))).toString(),stress_loss:q.mul(entry.minus(stop.minus(plan.atr1).minus(spread.mul(2)).mul(D(1).minus(slip.mul(2))))).plus(q.mul(entry.plus(stop).mul(fee))).toString(),fee:policy.fee,slippage:policy.slippage};
}
