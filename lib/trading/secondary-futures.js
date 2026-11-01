// One operational secondary PAPER ledger. No private exchange endpoints or real orders.
import {MultiPatternPaper} from './multi-pattern-paper.js';
import {D,hash} from './core.js';
import {syncPortfolio} from './portfolio.js';
import {SECONDARY_VERSION,SECONDARY_MODEL,SECONDARY_PROTOCOL,isSecondary,secondaryFresh,secondaryEstimate} from './secondary-futures-math.js';
export {SECONDARY_VERSION,SECONDARY_MODEL,SECONDARY_PROTOCOL,isSecondary,secondaryFresh,secondaryEstimate} from './secondary-futures-math.js';
const P=SECONDARY_PROTOCOL,values=o=>Object.values(o??{}),n=x=>Number(x);
const round=(x,tick,up=false)=>D(x).div(tick)[up?'ceil':'floor']().mul(tick).toNumber();
const mean=x=>x.reduce((a,b)=>a+b,0)/x.length;
const ema=(b,k)=>{let v=mean(b.slice(0,k).map(x=>n(x.close)));for(const x of b.slice(k))v+=(n(x.close)-v)*2/(k+1);return v;};
const atr=b=>mean(b.slice(-14).map((x,i)=>{const c=n(b[b.length-15+i].close);return Math.max(n(x.high)-n(x.low),Math.abs(n(x.high)-c),Math.abs(n(x.low)-c));}));
export function secondaryEconomics(entry,stop,target,direction,rate){
 const sign=direction==='LONG'?1:-1,exit=x=>D(x).mul(D(1).minus(D(P.slippage).mul(sign))),funding=D(rate).abs().mul(P.holdingMs/3600000),pnl=x=>exit(x).minus(entry).mul(sign).minus(D(entry).mul(P.makerFee)).minus(exit(x).mul(P.takerFee)).minus(funding),loss=pnl(stop).negated(),gain=pnl(target);
 return {loss:loss.toNumber(),gain:gain.toNumber(),netRR:loss.gt(0)?gain.div(loss).toNumber():null,fundingAllowance:funding.toNumber()};
}
export function secondaryCandidates(series,q,meta,cutoff,now,rate){
 const reject=reason=>P.patterns.map(pattern=>({pattern,reason}));
 if(!secondaryFresh(q,now))return reject('FUTURES_DATA_NOT_FRESH');
 if(!Number.isFinite(rate))return reject('FUNDING_NOT_AVAILABLE');
 const b=(series[5]??[]).filter(x=>x.end<=cutoff).slice(-256),c=(series[15]??[]).filter(x=>x.end<=cutoff).slice(-256);
 if(![b,c].every(x=>x.length>=64&&x.every((v,i)=>!i||v.start===x[i-1].end))||b.at(-1).end!==cutoff||c.at(-1).end!==Math.floor(cutoff/900000)*900000)return reject('CONTEXT_NOT_SYNCHRONIZED');
 const a=atr(b),ca=atr(c),fast=ema(c,20),slow=ema(c,50),slope=fast-ema(c.slice(0,-3),20),up=fast>slow&&slope>0&&fast-slow>=0.35*ca,down=fast<slow&&slope<0&&slow-fast>=0.35*ca;
 if(!(a>0&&ca>0))return reject('VOLATILITY_INVALID');
 const er=Math.abs(n(c.at(-1).close)-n(c.at(-21).close))/Math.max(1e-12,c.slice(-20).reduce((acc,x,i)=>acc+Math.abs(n(x.close)-n(c[c.length-21+i].close)),0)),range=!up&&!down&&er<=0.28&&Math.abs(fast-slow)<=0.6*ca;
 const last=b.at(-1),prev=b.at(-2),prior=b.slice(0,-1),e9=ema(b,9),prev9=ema(prior,9),center=mean(prior.slice(-20).map(x=>n(x.close))),sd=Math.sqrt(mean(prior.slice(-20).map(x=>(n(x.close)-center)**2))),high=Math.max(...prior.slice(-8).map(x=>n(x.high))),low=Math.min(...prior.slice(-8).map(x=>n(x.low))),vol=mean(prior.slice(-20).map(x=>n(x.volume)));
 const facts={atr5:a,atr15:ca,efficiency15:er,regime:up?'UP':down?'DOWN':range?'RANGE':'NEUTRAL'};
 return P.patterns.map(pattern=>{
  let direction=null,anchor=null;
  if(pattern==='BREAKOUT'){
   if(up&&n(last.close)>high&&n(last.close)>n(last.open)&&n(last.close)>=n(last.low)+0.75*(n(last.high)-n(last.low))&&n(last.volume)>=1.15*vol){direction='LONG';anchor=high;}
   if(down&&n(last.close)<low&&n(last.close)<n(last.open)&&n(last.close)<=n(last.low)+0.25*(n(last.high)-n(last.low))&&n(last.volume)>=1.15*vol){direction='SHORT';anchor=low;}
  }else if(pattern==='PULLBACK'){
   if(up&&n(prev.low)<=prev9&&n(last.close)>e9&&n(last.close)>n(last.open)&&n(last.close)>n(prev.close)){direction='LONG';anchor=e9;}
   if(down&&n(prev.high)>=prev9&&n(last.close)<e9&&n(last.close)<n(last.open)&&n(last.close)<n(prev.close)){direction='SHORT';anchor=e9;}
  }else if(pattern==='RANGE_REENTRY'&&range){
   if(n(prev.close)<center-2*sd&&n(last.close)>=center-2*sd&&n(last.close)>n(last.open)){direction='LONG';anchor=center-2*sd;}
   if(n(prev.close)>center+2*sd&&n(last.close)<=center+2*sd&&n(last.close)<n(last.open)){direction='SHORT';anchor=center+2*sd;}
  }
  if(!direction)return {pattern,reason:'WAIT_'+pattern,facts};
  const short=direction==='SHORT',sign=short?-1:1,tick=meta.tick_size;
  // Improve the entry at an observed level. A later trade must fill the order.
  const entry=round(short?Math.max(n(q.ask),anchor):Math.min(n(q.bid),anchor),tick,short),local=b.slice(-3),stop=round(short?Math.max(...local.map(x=>n(x.high)))+0.1*a:Math.min(...local.map(x=>n(x.low)))-0.1*a,tick,short),distance=sign*(entry-stop),distanceFromQuote=sign*((short?n(q.ask):n(q.bid))-entry);
  if(distance<0.5*a||distance>2.5*a||distanceFromQuote>1.5*a)return {pattern,reason:'STRUCTURAL_ENTRY_DISTANCE',facts};
  let target=pattern==='RANGE_REENTRY'?center:n(last.close)+sign*3*a;
  if(pattern==='PULLBACK'){const structure=short?Math.min(...prior.slice(-20).map(x=>n(x.low))):Math.max(...prior.slice(-20).map(x=>n(x.high)));if(sign*(structure-entry)>0)target=short?Math.max(target,structure):Math.min(target,structure);}
  target=round(target,tick,!short);
  const move=sign*(target-entry)/entry,econ=secondaryEconomics(entry,stop,target,direction,rate),detail={...facts,...econ,entry,stop,target,requiredMovePct:move*100,entryImprovementUSD:distanceFromQuote};
  if(!(entry>0&&stop>0&&target>0&&move>0&&move<=P.maxTargetMove))return {pattern,reason:'TARGET_OUTSIDE_SHORT_HORIZON',facts:detail};
  if(!(econ.gain>0&&econ.loss>0&&econ.netRR>=P.minNetRR))return {pattern,reason:'COST_OR_NET_RR',facts:detail};
  const titles={BREAKOUT:'Ruptura y retesteo',PULLBACK:'Retroceso en tendencia',RANGE_REENTRY:'Reentrada en rango'};
  const plan={id:hash([SECONDARY_VERSION,pattern,cutoff]),version:SECONDARY_VERSION,execution_model:SECONDARY_MODEL,instrument:'PAPER:KRAKEN_FUTURES:PF_XBTUSD',family:'L',pattern,recipe:pattern,recipe_title:'PF_XBTUSD · '+titles[pattern],direction,timeframe:5,entry:String(entry),limit:String(entry),stop:String(stop),target:String(target),confirmed_at:cutoff,decision_at:now,expires_at:now+P.entryExpiryMs,holding_ms:P.holdingMs,order:'FUTURES_POST_ONLY_LIMIT',fill_model:'OBSERVED_TRADE_THROUGH_20X',criteria:['CLOSED_5M','CLOSED_15M_CONTEXT',pattern,'STRUCTURAL_LIMIT_ENTRY','NET_RR_1_5'],context:{symbol:P.symbol,stopTf:5,targetTf:5,holdingMs:P.holdingMs},economics:econ,experiment:true,study:{prediction:{status:'UNAVAILABLE',event:'NET_POSITIVE_AT_CLOSE'}}};
  plan.evidence={schema:1,at:now,default_tf:5,closed_bars:true,input_hash:hash({b,c}),panels:[{tf:5,candles:b.slice(-80),lines:[]},{tf:15,candles:c.slice(-80),lines:[]}],levels:[{name:'Nivel de entrada observado',value:anchor}],facts:Object.entries(detail).map(([label,value])=>({label,value})),rules:['Datos del contrato PF_XBTUSD, no del mercado spot.','Señal con velas cerradas; entrada límite en retesteo, retroceso o extremo del rango.','Ejecución posterior al envío: operación que atraviese el límite con al menos veinte veces la cantidad.','Stop estructural; beneficio/riesgo neto mínimo 1,5, con costes y financiación.','Salida por stop, objetivo neto, control manual o 30 minutos; ninguna ganancia garantizada.']};
  return {pattern,reason:'CANDIDATE',facts:detail,plan};
 });
}
export function initializeSecondary(root,now,event=()=>{}){
 const a=root.frequency.account;
 if(root.secondaryExecution){const x=root.secondaryExecution;if(x.version!==SECONDARY_VERSION||x.protocol_hash!==hash(P)||hash(x.protocol)!==hash(P))throw Error('SECONDARY_EXECUTION_PROTOCOL_MISMATCH');if([...values(a.positions),...values(a.pendingOrders)].some(p=>!isSecondary(p)))throw Error('SECONDARY_MIXED_EXECUTION_MODELS');return x;}
 if(!a.portfolio||values(a.positions).length||values(a.pendingOrders).length||a.position||a.pending)throw Error('SECONDARY_REQUIRES_FLAT_MIGRATION');
 if(root.laboratory.status!=='RESEARCH_COMPLETE'||a.halted)throw Error('SECONDARY_LEGACY_STATE_CHANGED');
 const at=now,baseline={cash:a.cash,equity:a.equity,net:a.net,fees:a.fees,closed:a.closed,wins:a.wins,losses:a.losses};
 const x=root.secondaryExecution={version:SECONDARY_VERSION,protocol:structuredClone(P),protocol_hash:hash(P),activated_at:at,status:'ACTIVE_PAPER',baseline,last_cutoff:Math.floor(now/300000)*300000,last_quote_at:0,peak:a.equity,day:new Date(now).toISOString().slice(0,10),day_start:a.equity,loss_streak:0,cooldown_until:0,decisions:{},counts:{evaluations:0,selected:0,filled:0,closed:0},source:'KRAKEN_FUTURES_PUBLIC',market_issue:'WARMUP',legacy_trial_status:root.laboratory.status};
 event({type:'SECONDARY_EXECUTION_ENABLED',at,version:SECONDARY_VERSION,baseline,ledger:'FREQUENT_PAPER',capital_added:'0',realTrading:false});return x;
}
export class SecondaryBroker{
 constructor({root,now=()=>Date.now(),event=()=>{},notice=()=>{}}){Object.assign(this,{root,now,event,notice});this.f=root.frequency;this.a=this.f.account;this.x=initializeSecondary(root,now(),event);}
 record(e){
  const f=this.f;const out={...e,at:e.at??this.now(),version:SECONDARY_VERSION,ledger:'FREQUENT_PAPER',realTrading:false};
  const k={SELECTED:'selected',FILLED:'filled',CLOSED:'closed',NOT_FILLED:'notFilled',SUPPRESSED:'suppressed'}[e.type];if(k)f.counts[k]=(f.counts[k]??0)+1;if(k in this.x.counts)this.x.counts[k]++;
  if(e.type==='SELECTED'){const day=new Date(out.at).toISOString().slice(0,10);if(f.selectionDay!==day){f.selectionDay=day;f.daySelections=0;}f.daySelections++;}
  if(e.type==='CLOSED'){f.grossClosed=D(f.grossClosed).plus(e.pnl).plus(e.fees).toString();f.closedFees=D(f.closedFees).plus(e.fees).toString();}
  if(k){f.history.unshift({...out,plan:undefined,quote:undefined,trade:undefined,direction:e.direction??e.plan?.direction,timeframe:5});f.history=f.history.slice(0,40);}
  this.event(out);
  if(e.type==='FILLED')this.notice('SECONDARY_OPEN',out,['secondary-open',e.id]);
  if(e.type==='CLOSED')this.notice('SECONDARY_CLOSE',out,['secondary-close',e.id]);
 }
 mark(q,now){
  let equity=D(this.a.cash);
  for(const p of values(this.a.positions)){const v=secondaryEstimate(p,q,now);if(v){p.execution_quote=q;p.live_exit=v;equity=equity.plus(p.initial_margin).plus(v.gross).minus(v.exit_fee).minus(v.funding);}else equity=equity.plus(p.initial_margin);}
  this.a.equity=equity.toString();this.a.peak=D(this.a.peak??equity).gt(equity)?this.a.peak:equity.toString();this.a.maxDrawdown=D(this.a.maxDrawdown??0).gt(D(1).minus(equity.div(this.a.peak)))?this.a.maxDrawdown:D(1).minus(equity.div(this.a.peak)).toString();
  if(equity.gt(this.x.peak))this.x.peak=equity.toString();
  if(D(1).minus(equity.div(this.x.peak)).gte(P.drawdownFraction)){this.x.status='HALTED_DRAWDOWN';this.cancelAll('DRAWDOWN_HALT');}
  syncPortfolio(this.a);
 }
 choose(plan,q,meta,now){
  const a=this.a,x=this.x,all=[...values(a.positions),...values(a.pendingOrders)],day=new Date(now).toISOString().slice(0,10);
  if(day!==x.day){x.day=day;x.day_start=a.equity;}
  if(x.status!=='ACTIVE_PAPER'||a.halted)return 'DRAWDOWN_HALT';
  if(now<x.cooldown_until)return 'LOSS_STREAK_COOLDOWN';
  if(!secondaryFresh(q,now))return 'FUTURES_DATA_NOT_FRESH';
  if(all.some(p=>p.plan.id===plan.id)||this.a.portfolio.seen?.includes(plan.id))return 'DUPLICATE_SIGNAL';
  if(all.some(p=>p.plan.pattern===plan.pattern))return 'PATTERN_ALREADY_OPEN';
  if(all.some(p=>p.plan.direction!==plan.direction))return 'OPPOSITE_BTC_EXPOSURE';
  if(all.length>=P.maxSlots||all.filter(p=>p.plan.direction===plan.direction).length>=P.maxDirectionSlots)return 'PORTFOLIO_CAPACITY';
  const reserved=all.reduce((sum,p)=>sum.plus(p.plan.sizing.risk),D(0)),dailyUsed=D(x.day_start).minus(a.equity).gt(0)?D(x.day_start).minus(a.equity):D(0);
  const limits=[D(a.equity).mul(P.riskFraction),D(P.riskCapUSD),D(a.equity).mul(P.openRiskFraction).minus(reserved),D(x.day_start).mul(P.dailyLossFraction).minus(dailyUsed).minus(reserved)];
  const risk=limits.reduce((v,k)=>k.lt(v)?k:v),pending=values(a.pendingOrders).reduce((sum,p)=>sum.plus(p.plan.sizing.reserved),D(0)),free=D(a.cash).minus(pending).minus(a.fundingReserve??0).minus(D(a.equity).mul(P.cashReserveFraction));
  const gross=all.reduce((sum,p)=>sum.plus(p.plan.sizing.exposure),D(0)),grossFree=D(a.equity).mul(P.maxGrossExposure).minus(gross);
  if(risk.lte(0)||free.lte(0)||grossFree.lte(0))return 'SHARED_RISK_OR_CAPITAL';
  const unitReserve=D(plan.entry).div(P.leverage).plus(D(plan.entry).mul(P.makerFee)).plus(plan.economics.fundingAllowance),bounds=[risk.div(plan.economics.loss),free.div(unitReserve),grossFree.div(plan.entry)],maxQty=bounds.reduce((v,k)=>k.lt(v)?k:v),qty=maxQty.div(meta.qty_step).floor().mul(meta.qty_step);
  if(qty.lt(meta.qty_step)||qty.lte(0))return 'SIZE_BELOW_MINIMUM';
  const exposure=qty.mul(plan.entry),margin=exposure.div(P.leverage),funding=qty.mul(plan.economics.fundingAllowance);
  plan={...plan,sizing:{qty:qty.toString(),risk:qty.mul(plan.economics.loss).toString(),risk_pct:qty.mul(plan.economics.loss).div(a.equity).mul(100).toString(),exposure:exposure.toString(),reserved:qty.mul(unitReserve).toString(),initial_margin:margin.toString(),funding_reserved:funding.toString(),leverage:P.leverage,effective_leverage:exposure.div(a.equity).toString(),target_net:qty.mul(plan.economics.gain).toString(),net_rr:String(plan.economics.netRR),fee:P.takerFee,entry_fee_rate:P.makerFee,slippage:P.slippage,financing:'PF_XBTUSD_HOURLY_SIGNED',fill_model:plan.fill_model}};
  plan.hash=hash({...plan,hash:undefined});a.pendingOrders[plan.id]={plan,placed_at:now+P.latencyMs,posted_at:null};a.portfolio.seen=[...(a.portfolio.seen??[]),plan.id].slice(-2000);syncPortfolio(a);
  this.record({type:'SELECTED',id:plan.id,plan,placed_at:now+P.latencyMs});return 'ENTRY_PENDING';
 }
 cancel(id,reason){const o=this.a.pendingOrders[id];if(!o)return;delete this.a.pendingOrders[id];syncPortfolio(this.a);this.record({type:'NOT_FILLED',id,reason,direction:o.plan.direction,timeframe:5});}
 cancelAll(reason){for(const id of Object.keys(this.a.pendingOrders))this.cancel(id,reason);}
 gap(reason){this.cancelAll(reason);for(const p of values(this.a.positions)){p.quality=reason;p.exit_requested='DATA_GAP_CLOSE';}this.x.market_issue=reason;}
 fill(q,t,now){
  if(!t||!Number.isFinite(t.qty)||t.qty<=0||now-t.received_at>5000||now-t.event_at>5000||t.event_at>now+1000)return;
  let used=D(0);
  for(const o of values(this.a.pendingOrders)){
   const p=o.plan,short=p.direction==='SHORT',qty=D(p.sizing.qty);
   if(!o.posted_at||t.event_at<=o.posted_at||now>=p.expires_at)continue;
   if((short?t.price>=n(p.stop):t.price<=n(p.stop))||(short?t.price<=n(p.target):t.price>=n(p.target))){this.cancel(p.id,'BARRIER_BEFORE_ENTRY');continue;}
   if(t.side!==(short?'buy':'sell')||!(short?t.price>n(p.limit):t.price<n(p.limit))||D(t.qty).mul(P.participation).minus(used).lt(qty))continue;
   const cost=qty.mul(p.entry),fee=cost.mul(P.makerFee),margin=cost.div(P.leverage);
   if(margin.plus(fee).gt(this.a.cash)){this.cancel(p.id,'CAPITAL_CHANGED');continue;}
   delete this.a.pendingOrders[p.id];this.a.cash=D(this.a.cash).minus(margin).minus(fee).toString();this.a.fees=D(this.a.fees).plus(fee).toString();
   this.a.positions[p.id]={plan:p,qty:qty.toString(),entry:p.entry,entry_fee:fee.toString(),initial_margin:margin.toString(),total_entry:margin.plus(fee).toString(),entered_at:now,expires_at:now+p.holding_ms,last_funding_at:now,accrued_funding:'0',quality:'OBSERVED',execution_quote:q};used=used.plus(qty);syncPortfolio(this.a);
   this.record({type:'FILLED',id:p.id,at:now,price:p.entry,qty:qty.toString(),fee:fee.toString(),plan:p,quote:q,trade:t,fill_model:p.fill_model});
  }
 }
 fund(p,rates,now){
  let from=p.last_funding_at??p.entered_at;const sign=p.plan.direction==='LONG'?1:-1;
  while(from<now){const hour=Math.floor(from/3600000)*3600000,end=Math.min(now,hour+3600000),rate=rates[hour];let cost;
   if(!Number.isFinite(rate)){cost=D(p.entry).mul('0.005').mul(p.qty).mul((end-from)/3600000);p.quality='FUNDING_GAP';p.exit_requested='DATA_GAP_CLOSE';}
   else cost=D(rate).mul(p.qty).mul(sign).mul((end-from)/3600000);
   p.accrued_funding=D(p.accrued_funding??0).plus(cost).toString();from=end;
  }p.last_funding_at=now;
 }
 close(p,q,now,reason){
  const a=this.a,v=secondaryEstimate(p,q,now);if(!v?.liquidity_ok)return false;
  if(reason==='NET_TARGET'&&D(v.net).lt(v.net_goal)||reason==='MANUAL_PROFIT'&&D(v.net).lte(0))return false;
  if(this.x.exit_quote!==q.event_at){this.x.exit_quote=q.event_at;this.x.exit_used={bid:'0',ask:'0'};}
  const used=D(this.x.exit_used[v.side]),capacity=D(q[v.side+'_qty']).mul(P.participation);if(used.plus(p.qty).gt(capacity))return false;
  this.x.exit_used[v.side]=used.plus(p.qty).toString();
  a.cash=D(a.cash).plus(p.initial_margin).plus(v.gross).minus(v.exit_fee).minus(v.funding).toString();a.net=D(a.net).plus(v.net).toString();a.fees=D(a.fees).plus(v.exit_fee).plus(v.funding).toString();a.closed++;const profit=D(v.net).gt(0);a.wins+=profit?1:0;a.losses+=profit?0:1;
  if(p.quality==='OBSERVED')a.observedClosed=(a.observedClosed??0)+1;else a.ambiguousClosed=(a.ambiguousClosed??0)+1;
  this.x.loss_streak=profit?0:this.x.loss_streak+1;if(this.x.loss_streak>=P.lossStreak)this.x.cooldown_until=now+P.cooldownMs;
  delete a.positions[p.plan.id];syncPortfolio(a);
  this.record({type:'CLOSED',id:p.plan.id,at:now,entered_at:p.entered_at,entry:p.entry,price:v.price,qty:p.qty,pnl:v.net,fees:v.costs,gross:v.gross,funding:v.funding,reason,quality:p.quality,direction:p.plan.direction,timeframe:5,leverage:P.leverage,pattern:p.plan.pattern,management_override:Boolean(p.management?.override||reason.startsWith('MANUAL_')),control_id:p.close_request?.id??null});return true;
 }
 market(q,t,rates,now){
  if(!secondaryFresh(q,now)){if(this.x.last_quote_at&&now-this.x.last_quote_at>10000)this.gap('FUTURES_DATA_GAP');return;}
  if(this.x.last_quote_at&&q.event_at-this.x.last_quote_at>10000)this.gap('FUTURES_DATA_GAP');
  this.x.market_issue=null;
  for(const o of values(this.a.pendingOrders)){
   const p=o.plan,short=p.direction==='SHORT';
   if(now>=p.expires_at){this.cancel(p.id,'VENCIDA');continue;}
   if(short?n(q.ask)>=n(p.stop):n(q.bid)<=n(p.stop)){this.cancel(p.id,'BARRIER_BEFORE_ENTRY');continue;}
   if(!o.posted_at&&now>=o.placed_at&&q.event_at>=o.placed_at){
    if(short?n(p.limit)<=n(q.bid):n(p.limit)>=n(q.ask)){this.cancel(p.id,'POST_ONLY_WOULD_CROSS');continue;}
    o.posted_at=now;this.event({type:'MAKER_POSTED',id:p.id,at:now,version:SECONDARY_VERSION,ledger:'FREQUENT_PAPER',quote:q});
   }
  }
  this.fill(q,t,now);
  for(const p of values(this.a.positions)){
   // Profit exits must still be profitable when liquidity becomes available.
   if(['NET_TARGET','MANUAL_PROFIT'].includes(p.exit_requested))delete p.exit_requested;
   p.execution_quote=q;this.fund(p,rates,now);const v=secondaryEstimate(p,q,now),short=p.plan.direction==='SHORT',c=p.close_request;
   let reason=p.exit_requested??((short?n(q.ask)>=n(p.plan.stop):n(q.bid)<=n(p.plan.stop))?'STOP':null);
   if(!reason&&c&&now>=c.not_before&&q.event_at>=c.not_before&&now<c.expires_at&&(c.mode==='ANY'||D(v.net).gt(0)))reason=c.mode==='PROFIT'?'MANUAL_PROFIT':'MANUAL_CLOSE';
   if(!reason&&D(v.net).gte(v.net_goal)&&q.event_at>=(p.management?.not_before??p.entered_at))reason='NET_TARGET';
   if(!reason&&now>=p.expires_at)reason='TIMEOUT';
   if(reason){if(!['NET_TARGET','MANUAL_PROFIT'].includes(reason))p.exit_requested=reason;this.close(p,q,now,reason);}
  }
  this.x.last_quote_at=Math.max(this.x.last_quote_at,q.event_at);this.mark(q,now);
 }
}
export class OperationalSecondary extends MultiPatternPaper{
 initialize(){
  this.broker=new SecondaryBroker({root:this.engine.state,now:this.now,event:e=>this.engine.event(e),notice:(...a)=>this.engine.notice(...a)});this.state=this.broker.x;this.queue=[];this.tradeSeen=new Set();this.lastTradeSeq=null;this.processingQuote=null;
  this.state.last_cutoff=Math.floor(this.now()/300000)*300000;
  this.broker.cancelAll('RESTART_PENDING_CANCELLED');for(const p of values(this.broker.a.positions)){p.quality='RESTART_GAP';p.exit_requested='DATA_GAP_CLOSE';}
  return this;
 }
 connect(){
  if(this.stopped)return;const ws=this.socketFactory('wss://futures.kraken.com/ws/v1');this.ws=ws;
  ws.addEventListener('open',()=>{for(const feed of ['ticker','trade'])ws.send(JSON.stringify({event:'subscribe',feed,product_ids:[P.symbol]}));});
  const enqueue=e=>{if(this.queue.length>=2000){this.queue=[];this.overflow=true;}this.queue.push(e);};
  ws.addEventListener('message',event=>{try{
   const m=JSON.parse(event.data),now=this.now();if(m.product_id!==P.symbol)return;
   if(m.feed==='ticker'){
    const q={source:'KRAKEN_FUTURES_WS_TICKER',symbol:P.symbol,event_at:n(m.time),received_at:now,bid:String(m.bid),ask:String(m.ask),bid_qty:String(m.bid_size),ask_qty:String(m.ask_size),suspended:m.suspended===true};
    if(!secondaryFresh(q,now)||this.quote&&q.event_at<=this.quote.event_at)return;
    this.quote=q;const hour=Math.floor(q.event_at/3600000)*3600000;
    if(m.funding_rate!==undefined&&Number.isFinite(n(m.funding_rate)))this.rates[hour]=n(m.funding_rate);
    this.predictedFunding=m.funding_rate_prediction!==undefined&&Number.isFinite(n(m.funding_rate_prediction))?n(m.funding_rate_prediction):null;
    enqueue({kind:'quote',q});
   }else if(m.feed==='trade'&&typeof m.uid==='string'&&!this.tradeSeen.has(m.uid)){
    const t={id:m.uid,side:m.side,price:n(m.price),qty:n(m.qty),event_at:n(m.time),received_at:now,source:'KRAKEN_FUTURES_WS_TRADE'};
    if(!Number.isSafeInteger(t.event_at)||now-t.event_at>5000||t.event_at>now+1000||!['buy','sell'].includes(t.side)||![t.price,t.qty].every(x=>Number.isFinite(x)&&x>0))return;
    this.tradeSeen.add(m.uid);if(this.tradeSeen.size>5000)this.tradeSeen.delete(this.tradeSeen.values().next().value);enqueue({kind:'trade',t});
   }
  }catch{this.feedError='FUTURES_MESSAGE_INVALID';}});
  ws.addEventListener('error',()=>{this.feedError='FUTURES_WS_ERROR';});
  ws.addEventListener('close',()=>{this.disconnected=true;if(!this.stopped&&this.ws===ws)this.reconnect=setTimeout(()=>this.connect(),5000);});
 }
 async refresh(){await super.refresh();const oldest=this.now()-96*3600000;for(const k of Object.keys(this.rates))if(n(k)<oldest)delete this.rates[k];}
 start(){this.stopped=false;void this.refresh();this.connect();this.timers.push(setInterval(()=>{void this.refresh();if(this.quote&&this.now()-this.quote.received_at>30000)this.ws?.close();},10000));}
 tick(){
  const now=this.now(),x=this.state,b=this.broker;
  if(this.overflow||this.disconnected){b.gap(this.overflow?'EVENT_QUEUE_GAP':'FUTURES_DISCONNECTED');this.overflow=false;this.disconnected=false;}
  for(const e of this.queue.splice(0)){if(e.kind==='quote')this.processingQuote=e.q;b.market(this.processingQuote,e.t??null,this.rates,now);}
  b.market(this.quote,null,this.rates,now);
  x.market={symbol:P.symbol,quote:this.quote,quote_at:this.quote?.event_at??null,last_refresh:this.lastRefresh??null,error:this.feedError??(!secondaryFresh(this.quote,now)?'FUTURES_DATA_NOT_FRESH':null),closed_at:Object.fromEntries([5,15].map(tf=>[tf,this.series[tf].at(-1)?.end??null]))};
  const cutoff=Math.floor(now/300000)*300000;if(cutoff<=x.last_cutoff||now-cutoff<2000)return;
  if(now-cutoff>30000){x.last_cutoff=cutoff;this.decision(cutoff,[{pattern:'ALL',reason:'EVALUATION_WINDOW_MISSED'}]);return;}
  if(!this.meta||now-this.meta.checked_at>3600000||this.feedError||!secondaryFresh(this.quote,now))return;
  const rate=this.rates[Math.floor(now/3600000)*3600000];
  if(!Number.isFinite(rate))return;
  const fundingRisk=Math.max(Math.abs(rate),Math.abs(this.predictedFunding??rate));
  const decisions=secondaryCandidates(this.series,this.quote,this.meta,cutoff,now,fundingRisk);if(decisions.some(d=>d.reason==='CONTEXT_NOT_SYNCHRONIZED'))return;
  x.last_cutoff=cutoff;
  for(const d of [...decisions].sort((a,b)=>(b.plan?.economics.netRR??-1)-(a.plan?.economics.netRR??-1))){if(d.plan){this.broker.f.counts.candidates++;d.reason=b.choose(d.plan,this.quote,this.meta,now);}}
  this.decision(cutoff,decisions);
 }
 decision(cutoff,decisions){
  const now=this.now();for(const d of decisions){const out={at:now,cutoff,pattern:d.pattern,reason:d.reason,timeframe:5,criteria:d.facts??{},version:SECONDARY_VERSION};this.state.decisions[d.pattern]=out;this.state.counts.evaluations++;this.broker.f.counts.evaluations++;this.engine.event({type:'SECONDARY_PATTERN_EVALUATION',...out,ledger:'FREQUENT_PAPER'});}
  const selected=decisions.find(d=>d.reason==='ENTRY_PENDING')??decisions.find(d=>!d.reason.startsWith('WAIT_'))??decisions[0];this.broker.f.lastDecision={...this.state.decisions[selected.pattern],all_patterns:decisions.map(d=>({pattern:d.pattern,reason:d.reason}))};
 }
}
