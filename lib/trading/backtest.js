// Chronological event replay; never publishes Telegram notices. Historical
// OHLC-only research must declare conservative intrabar paths separately.
import {hash,POLICY,M15,D,indicators} from './core.js';
import {evaluate,newStrategyState} from './strategies.js';
import {newAccount,select,step,invalidate} from './simulator.js';
import {metrics} from './research.js';
export function chronologicalSplit(rows,{trainEnd,calibrationEnd,testEnd,purge=86400000}){
  const split={development:[],calibration:[],test:[],purged:[]};
  for(const r of rows){if(r.label_end<=trainEnd-purge)split.development.push(r);else if(r.setup_at>=trainEnd+purge&&r.label_end<=calibrationEnd-purge)split.calibration.push(r);else if(r.setup_at>=calibrationEnd+purge&&r.label_end<=testEnd)split.test.push(r);else split.purged.push(r);}return split;
}
export function calibrationMetrics(rows){
  const valid=rows.filter(x=>x.executed&&Number.isFinite(x.probability)&&x.probability>=0&&x.probability<=1&&['TARGET','STOP','TIMEOUT'].includes(x.outcome));
  if(!valid.length)return {status:'NO DISPONIBLE',n:0};let brier=0,loss=0;const bins=Array.from({length:10},()=>({n:0,p:0,y:0}));
  for(const r of valid){const y=+(r.outcome==='TARGET'),p=r.probability,clip=Math.max(1e-12,Math.min(1-1e-12,p));brier+=(p-y)**2;loss-=y*Math.log(clip)+(1-y)*Math.log(1-clip);const b=bins[Math.min(9,Math.floor(p*10))];b.n++;b.p+=p;b.y+=y;}
  const reliability=bins.filter(b=>b.n).map(b=>({n:b.n,forecast:b.p/b.n,observed:b.y/b.n}));return {n:valid.length,brier:brier/valid.length,logLoss:loss/valid.length,reliability,ece:reliability.reduce((s,b)=>s+b.n*Math.abs(b.forecast-b.observed),0)/valid.length};
}
export function replay(input,{latency=60000,policy=POLICY}={}){
  if(input.instrument!==POLICY.instrument||!input.source_manifest||!Array.isArray(input.events))throw Error('REPLAY_PROVENANCE_REQUIRED');
  const account=newAccount(policy),strategy=newStrategyState(),events=[],series={'15':[],'60':[],'240':[]};let quote=null,trade=null,prior=-Infinity,exposedMs=0,priorTime=null,maxDD=0;
  for(const e of input.events){if(!Number.isFinite(e.received_at)||e.received_at<prior)throw Error('REPLAY_NOT_CHRONOLOGICAL');prior=e.received_at;const now=e.received_at;
    if(priorTime!=null&&account.position)exposedMs+=now-priorTime;priorTime=now;
    if(e.kind==='QUOTE')quote=e.quote;
    else if(e.kind==='TRADE')trade=e.trade;
    else if(e.kind==='BAR'){if(e.bar.available_at>now||e.bar.end>now)throw Error('REPLAY_FUTURE_BAR');series[e.tf].push(e.bar);}
    else if(e.kind==='CLOSE'){
      const result=evaluate(strategy,series,e.cutoff,now,input.metadata);
      events.push(...result.log);
      for(const p of result.plans){const bad=!quote||!trade?'REPLAY_EXECUTABLE_PRICE_MISSING':invalidate(p,{quote,trade},now,result.context);events.push(bad?{type:'SUPPRESSED',id:p.id,reason:bad}:select(account,p,quote,input.metadata,now,{latency,policy}));}
    }
    if(quote&&trade&&now-quote.event_at<=5000&&now-trade.event_at<=30000)events.push(...step(account,{quote,trade},now,policy));
    maxDD=Math.max(maxDD,+account.maxDrawdown);
  }
  const closed=events.filter(e=>e.type==='CLOSED'),m=metrics(closed),first=input.events[0]?.received_at,last=input.events.at(-1)?.received_at;
  return {kind:'EXPLORATORY_EVENT_REPLAY',approved:false,input_hash:hash(input),policy_hash:hash(policy),latency,from:first,to:last,...m,returnNet:D(account.equity).div(policy.initialCash).minus(1).toNumber(),drawdown:maxDD,exposedMs,exposureFraction:last>first?exposedMs/(last-first):0,lossStreak:account.maxLossStreak,candidates:events.filter(e=>e.type==='CANDIDATE').length,suppressed:events.filter(e=>e.type==='SUPPRESSED').length,notFilled:events.filter(e=>e.type==='NOT_FILLED').length,open:account.position,pending:account.pending,events,account,benchmarks:{cash:{returnNet:0},buyHold:benchmark(input,{latency,policy,type:'BUY_HOLD'}),ema200:benchmark(input,{latency,policy,type:'EMA200'})},validation:'INCONCLUSO'};
}
export function benchmark(input,{latency,policy,type}){
  let cash=D(policy.initialCash),qty=D(0),fees=D(0),pending=null,first=true,lastQuote=null,peak=cash,maxDD=0;const bars=[];
  for(const e of input.events){
    if(e.kind==='BAR'&&e.tf==='240'){bars.push(e.bar);if(type==='EMA200'&&bars.length>=policy.warmup240){const b=indicators(bars).at(-1);pending={buy:+b.close>b.ema200,at:e.received_at+latency};}}
    if(e.kind!=='QUOTE'||e.received_at-e.quote.event_at>5000)continue;lastQuote=e.quote;
    if(type==='BUY_HOLD'&&first){pending={buy:true,at:e.received_at+latency};first=false;}
    if(pending&&e.received_at>=pending.at){
      if(pending.buy&&qty.isZero()){
        const price=D(lastQuote.ask).mul(D(1).plus(policy.slippage));
        const capacity=D(lastQuote.ask_qty).mul('.1');let q=cash.mul('.9').div(price.mul(D(1).plus(policy.fee)));if(q.gt(capacity))q=capacity;
        const step=D(10).pow(-input.metadata.lot_decimals);q=q.div(step).floor().mul(step);
        if(q.gte(input.metadata.ordermin)&&q.mul(price).gte(input.metadata.costmin)){const cost=q.mul(price),fee=cost.mul(policy.fee);cash=cash.minus(cost).minus(fee);fees=fees.plus(fee);qty=q;pending=null;}
      }else if(!pending.buy&&!qty.isZero()){const proceeds=qty.mul(lastQuote.bid).mul(D(1).minus(policy.slippage)),fee=proceeds.mul(policy.fee);cash=cash.plus(proceeds).minus(fee);fees=fees.plus(fee);qty=D(0);pending=null;}
    }
    const equity=cash.plus(qty.mul(lastQuote.bid).mul(D(1).minus(policy.fee)));if(equity.gt(peak))peak=equity;maxDD=Math.max(maxDD,peak.minus(equity).div(peak).toNumber());
  }
  if(!lastQuote)return {status:'INSUFFICIENT_QUOTES'};
  const liquidation=qty.mul(lastQuote.bid).mul(D(1).minus(policy.slippage)),exitFee=liquidation.mul(policy.fee);cash=cash.plus(liquidation).minus(exitFee);fees=fees.plus(exitFee);
  return {type,returnNet:cash.div(policy.initialCash).minus(1).toNumber(),net:cash.minus(policy.initialCash).toString(),fees:fees.toString(),drawdown:maxDD,finalMark:'TERMINAL_LIQUIDATION_AT_LAST_EXECUTABLE_BID',capital:policy.initialCash};
}
