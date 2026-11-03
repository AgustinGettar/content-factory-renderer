// Public-data-only, prospective PAPER comparison. Never submits exchange orders.
import {createHash} from 'node:crypto';
export const VERSION='multi-pattern-paper-1.0.0';
export const PROTOCOL=Object.freeze({version:VERSION,mode:'SHADOW_PAPER',symbol:'PF_XBTUSD',entryMinutes:5,contextMinutes:15,holdingMs:900000,makerFee:0.0002,takerFee:0.0005,slippage:0.0002,feeSource:'https://www.kraken.com/pro/fees',feeVerifiedAt:'2026-11-01',execution:'TAKER_BOTH_SIDES',riskFraction:0.005,notionalFraction:2,participation:0.05,dailyLoss:0.03,maxDrawdown:0.05,lossCooldown:900000,minNetRR:1.5,maxTargetMove:0.012,patterns:['BREAKOUT','PULLBACK','RANGE_REENTRY'],realTrading:false});
const digest=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const fixed=x=>Number(x.toFixed(8));
const finite=x=>Number.isFinite(Number(x));
const mean=x=>x.reduce((s,v)=>s+v,0)/x.length;
const ema=(bars,n)=>{let v=mean(bars.slice(0,n).map(b=>b.close));for(const b of bars.slice(n))v+=2/(n+1)*(b.close-v);return v;};
const atr=bars=>mean(bars.slice(-14).map((b,i)=>{const prev=bars[bars.length-14+i-1]?.close??b.open;return Math.max(b.high-b.low,Math.abs(b.high-prev),Math.abs(b.low-prev));}));
export function closedBars(payload,tf,now){
 if(!Array.isArray(payload?.candles)||![1,5,15,60,240,1440].includes(tf))throw Error('RESEARCH_CANDLES_INVALID');
 const duration=tf*60000,rows=payload.candles.map(r=>({start:Number(r.time),end:Number(r.time)+duration,...Object.fromEntries(['open','high','low','close','volume'].map(k=>[k,Number(r[k])]))})).sort((a,b)=>a.start-b.start);
 if(rows.some((b,i)=>!Number.isSafeInteger(b.start)||b.start%duration||!['open','high','low','close','volume'].every(k=>finite(b[k]))||Math.min(b.open,b.high,b.low,b.close)<=0||b.volume<0||b.low>Math.min(b.open,b.close)||b.high<Math.max(b.open,b.close)||i&&b.start===rows[i-1].start))throw Error('RESEARCH_CANDLES_INVALID');
 return rows.filter(b=>b.end<=now);
}
const seriesOK=(bars,tf,end)=>bars.length>=64&&bars.at(-1).end===end&&bars.every((b,i)=>!i||b.start===bars[i-1].end)&&bars.every(b=>b.end-b.start===tf*60000);
export function economics(entry,stop,target,direction,rate=0,protocol=PROTOCOL){
 const sign=direction==='LONG'?1:-1,exit=p=>p*(1-sign*protocol.slippage);
 // Adverse funding allowance only for eligibility; realized funding is signed.
 const funding=Math.abs(rate)*protocol.holdingMs/3600000;
 const result=p=>sign*(exit(p)-entry)-entry*protocol.takerFee-exit(p)*protocol.takerFee-funding;
 const gain=result(target),loss=-result(stop);
 return {gain,loss,netRR:loss>0?gain/loss:null,fundingAllowance:funding};
}
export function evaluatePatterns(series,quote,cutoff,rate=0,protocol=PROTOCOL){
 const b=(series[5]??[]).filter(x=>x.end<=cutoff).slice(-256),c=(series[15]??[]).filter(x=>x.end<=cutoff).slice(-256);
 const reject=reason=>protocol.patterns.map(pattern=>({pattern,reason}));
 if(!seriesOK(b,5,cutoff)||!seriesOK(c,15,Math.floor(cutoff/900000)*900000))return reject('CONTEXT_NOT_SYNCHRONIZED');
 if(!quote||![quote.bid,quote.ask].every(x=>Number.isFinite(x)&&x>0)||quote.ask<quote.bid)return reject('QUOTE_INVALID');
 const a=atr(b),ca=atr(c),fast=ema(c,20),slow=ema(c,50),slope=fast-ema(c.slice(0,-3),20);
 if(!(a>0&&ca>0))return reject('VOLATILITY_INVALID');
 const er=Math.abs(c.at(-1).close-c.at(-21).close)/Math.max(1e-12,c.slice(-20).reduce((s,x,i)=>s+Math.abs(x.close-c[c.length-21+i].close),0));
 const up=fast>slow&&slope>0&&fast-slow>=0.35*ca,down=fast<slow&&slope<0&&slow-fast>=0.35*ca;
 const range=er<=0.28&&Math.abs(fast-slow)<=0.6*ca,prior=b.slice(0,-1),last=b.at(-1),prev=b.at(-2),priorClose=prior.slice(-20).map(x=>x.close),center=mean(priorClose),sd=Math.sqrt(mean(priorClose.map(x=>(x-center)**2)));
 const e9=ema(b,9),prev9=ema(prior,9),volume=mean(prior.slice(-20).map(x=>x.volume)),high=Math.max(...prior.slice(-8).map(x=>x.high)),low=Math.min(...prior.slice(-8).map(x=>x.low));
 const facts={atr5:a,atr15:ca,efficiency15:er,regime:up?'UP':down?'DOWN':range?'RANGE':'NEUTRAL'};
 return protocol.patterns.map(pattern=>{
  let direction=null;
  if(pattern==='BREAKOUT'){
   if(up&&last.close>high&&last.close>last.open&&last.close>=last.low+0.75*(last.high-last.low)&&last.volume>=1.15*volume)direction='LONG';
   if(down&&last.close<low&&last.close<last.open&&last.close<=last.low+0.25*(last.high-last.low)&&last.volume>=1.15*volume)direction='SHORT';
  }else if(pattern==='PULLBACK'){
   if(up&&prev.low<=prev9&&last.close>e9&&last.close>last.open&&last.close>prev.close)direction='LONG';
   if(down&&prev.high>=prev9&&last.close<e9&&last.close<last.open&&last.close<prev.close)direction='SHORT';
  }else if(pattern==='RANGE_REENTRY'&&range){
   if(prev.close<center-2*sd&&last.close>=center-2*sd&&last.close>last.open)direction='LONG';
   if(prev.close>center+2*sd&&last.close<=center+2*sd&&last.close<last.open)direction='SHORT';
  }
  if(!direction)return {pattern,reason:'WAIT_'+pattern,facts};
  const sign=direction==='LONG'?1:-1,entry=(sign>0?quote.ask:quote.bid)*(1+sign*protocol.slippage);
  const local=b.slice(-3),stop=sign>0?Math.min(...local.map(x=>x.low))-0.1*a:Math.max(...local.map(x=>x.high))+0.1*a;
  const distance=sign*(entry-stop);
  if(distance<0.75*a||distance>2.5*a)return {pattern,reason:'STRUCTURAL_STOP_DISTANCE',facts};
  let target=pattern==='RANGE_REENTRY'?center:entry+sign*3*a;
  if(pattern==='PULLBACK'){
   const structure=sign>0?Math.max(...prior.slice(-20).map(x=>x.high)):Math.min(...prior.slice(-20).map(x=>x.low));
   if(sign*(structure-entry)>0)target=sign>0?Math.min(target,structure):Math.max(target,structure);
  }
  const move=sign*(target-entry)/entry,econ=economics(entry,stop,target,direction,rate,protocol);
  if(move<=0||move>protocol.maxTargetMove)return {pattern,reason:'TARGET_OUTSIDE_SHORT_HORIZON',facts};
  if(!(econ.gain>0&&econ.loss>0&&econ.netRR>=protocol.minNetRR))return {pattern,reason:'COST_OR_NET_RR',facts:{...facts,...econ}};
  const plan={id:digest([protocol.version,pattern,cutoff]),pattern,direction,entry,stop,target,confirmed_at:cutoff,holding_ms:protocol.holdingMs,...econ,facts};
  return {pattern,reason:'CANDIDATE',plan,facts};
 });
}
export function newStudy(initial,now){
 if(!(Number.isFinite(initial)&&initial>0))throw Error('RESEARCH_INITIAL_BALANCE_INVALID');
 return {version:VERSION,protocol:{...PROTOCOL},protocol_hash:digest(PROTOCOL),mode:'SHADOW_PAPER',created_at:now,source_balance:initial,capital_note:'Independent virtual mirrors. Do not add balances or treat them as deposits.',last_cutoff:Math.floor(now/300000)*300000,last_quote_at:0,market_issue:'WARMUP',accounts:Object.fromEntries(PROTOCOL.patterns.map(pattern=>[pattern,{pattern,initial,cash:initial,equity:initial,net:0,fees:0,funding:0,peak:initial,max_drawdown:0,closed:0,wins:0,losses:0,clean_closed:0,loss_streak:0,cooldown_until:0,day:null,day_start:initial,halted:false,position:null,last_decision:null,reasons:{},history:[]}]))};
}
export function enter(a,plan,quote,meta,now,event=()=>{}){
 const p=PROTOCOL,day=new Date(now).toISOString().slice(0,10);
 if(a.day!==day){a.day=day;a.day_start=a.equity;}
 const lossToday=Math.max(0,a.day_start-a.equity),riskBudget=Math.min(a.equity*p.riskFraction,a.day_start*p.dailyLoss-lossToday);
 if(a.halted||a.position||now<a.cooldown_until||riskBudget<=0)return false;
 const liquidity=(plan.direction==='LONG'?quote.ask_qty:quote.bid_qty)*p.participation;
 const qty=Math.floor(Math.min(riskBudget/plan.loss,a.equity*p.notionalFraction/plan.entry,liquidity)/meta.qty_step+1e-10)*meta.qty_step;
 if(!(qty>=meta.qty_step&&qty*plan.loss<=riskBudget+1e-7&&qty*plan.entry<=a.equity*p.notionalFraction+1e-7))return false;
 const fee=qty*plan.entry*p.takerFee;
 a.cash=fixed(a.cash-fee);a.fees=fixed(a.fees+fee);
 a.position={...plan,qty,entry_fee:fee,entered_at:now,expires_at:now+plan.holding_ms,last_funding_at:now,funding:0,quality:'CONTINUOUS_QUOTES',gap:false,net_peak:0};
 event({type:'MULTI_PAPER_OPENED',at:now,pattern:a.pattern,plan:{...plan,qty},fee,mode:'SHADOW_PAPER',realTrading:false});return true;
}
export function closePosition(a,q,now,reason,event=()=>{}){
 const x=a.position;if(!x)return null;const sign=x.direction==='LONG'?1:-1,raw=sign>0?q.bid:q.ask,price=raw*(1-sign*PROTOCOL.slippage);
 const gross=sign*(price-x.entry)*x.qty,exitFee=price*x.qty*PROTOCOL.takerFee,fees=x.entry_fee+exitFee,net=gross-fees-x.funding;
 a.cash=fixed(a.cash+gross-exitFee-x.funding);a.equity=a.cash;a.net=fixed(a.net+net);a.fees=fixed(a.fees+exitFee);a.funding=fixed(a.funding+x.funding);a.closed++;if(net>0){a.wins++;a.loss_streak=0;}else{a.losses++;a.loss_streak++;}
 if(x.quality==='CONTINUOUS_QUOTES')a.clean_closed++;if(a.loss_streak>=3)a.cooldown_until=now+PROTOCOL.lossCooldown;
 a.peak=Math.max(a.peak,a.equity);a.max_drawdown=Math.max(a.max_drawdown,1-a.equity/a.peak);if(a.max_drawdown>=PROTOCOL.maxDrawdown)a.halted=true;
 const result={type:'MULTI_PAPER_CLOSED',id:x.id,at:now,entered_at:x.entered_at,pattern:a.pattern,direction:x.direction,reason,entry:x.entry,price,qty:x.qty,gross,fees,funding:x.funding,net,quality:x.quality,mode:'SHADOW_PAPER',realTrading:false};
 a.history.unshift(result);a.history=a.history.slice(0,100);a.position=null;event(result);return result;
}
export function processQuote(s,q,meta,rates,now,event=()=>{}){
 const valid=q&&now-q.at>=-1000&&now-q.at<=5000&&now-q.received_at<=5000&&q.ask>=q.bid&&q.bid>0&&q.ask_qty>=0&&q.bid_qty>=0&&!q.suspended;
 if(!valid){s.market_issue='STALE_OR_INVALID_FUTURES_QUOTE';for(const a of Object.values(s.accounts))if(a.position&&now-(s.last_quote_at||a.position.entered_at)>10000){a.position.gap=true;a.position.quality='DATA_GAP';}return false;}
 s.market_issue=null;if(q.at<=s.last_quote_at)return false;
 for(const a of Object.values(s.accounts)){
  const x=a.position;if(!x)continue;
  if(s.last_quote_at&&q.at-s.last_quote_at>10000){x.gap=true;x.quality='DATA_GAP';}
  const sign=x.direction==='LONG'?1:-1;
  let from=x.last_funding_at;
  while(from<now){const hour=Math.floor(from/3600000)*3600000,end=Math.min(now,hour+3600000),r=rates[hour];
   if(!Number.isFinite(r)){x.quality='FUNDING_GAP';x.gap=true;x.funding+=x.qty*x.entry*0.005*(end-from)/3600000;}
   else x.funding+=sign*x.qty*r*(end-from)/3600000;
   from=end;
  }
  x.last_funding_at=now;
  const raw=sign>0?q.bid:q.ask,price=raw*(1-sign*PROTOCOL.slippage),net=sign*(price-x.entry)*x.qty-x.entry_fee-price*x.qty*PROTOCOL.takerFee-x.funding;
  a.equity=fixed(a.cash+sign*(price-x.entry)*x.qty-price*x.qty*PROTOCOL.takerFee-x.funding);x.net_peak=Math.max(x.net_peak,net);
  // A data gap closes at a fresh observed quote; never invent a stop-price fill.
  const reason=x.exit_requested??(x.gap?'DATA_GAP_CLOSE':sign*(raw-x.stop)<=0?'STOP':sign*(raw-x.target)>=0?'TARGET':now>=x.expires_at?'TIMEOUT':null);
  if(reason){x.exit_requested=reason;const available=(sign>0?q.bid_qty:q.ask_qty)*PROTOCOL.participation;if(x.qty<=available+1e-12)closePosition(a,q,now,reason,event);}
 }
 s.last_quote_at=q.at;return true;
}
export function researchView(s){
 if(!s)return null;
 return {...s,accounts:Object.fromEntries(Object.entries(s.accounts).map(([k,a])=>[k,{...a,history:a.history.slice(0,20),validation:{status:a.clean_closed<50?'COLLECTING':'REVIEW_REQUIRED',minimum_clean_closes:50,automatic_promotion:false}}]))};
}
export class MultiPatternPaper {
 constructor({engine,fetchImpl=fetch,now=()=>Date.now(),socketFactory=url=>new WebSocket(url)}){Object.assign(this,{engine,fetchImpl,now,socketFactory});this.series={5:[],15:[]};this.rates={};this.quote=null;this.meta=null;this.stopped=true;this.refreshing=false;this.timers=[];}
 initialize(){
  const root=this.engine.state;
  if(!root.multiStrategy){root.multiStrategy=newStudy(Number(root.frequency.account.equity),this.now());this.engine.event({type:'MULTI_RESEARCH_STARTED',at:this.now(),protocol_hash:digest(PROTOCOL),source_balance:root.multiStrategy.source_balance,mode:'SHADOW_PAPER',realTrading:false});}
  const s=root.multiStrategy;if(s.version!==VERSION||s.protocol_hash!==digest(PROTOCOL)||digest(s.protocol)!==digest(PROTOCOL))throw Error('MULTI_RESEARCH_PROTOCOL_MISMATCH');
  s.last_cutoff=Math.floor(this.now()/300000)*300000;
  for(const a of Object.values(s.accounts))if(a.position){a.position.gap=true;a.position.quality='RESTART_GAP';}
  this.state=s;return this;
 }
 async read(path){
  if(!/^\/(derivatives\/api\/v3\/(instruments|historical-funding-rates\?symbol=PF_XBTUSD)|api\/charts\/v1\/trade\/PF_XBTUSD\/((5|15)m|(1|4)h|1d)\?count=256)$/.test(path))throw Error('PUBLIC_RESEARCH_ENDPOINT_ONLY');
  const r=await this.fetchImpl('https://futures.kraken.com'+path,{method:'GET',redirect:'error',signal:AbortSignal.timeout(5000)});if(!r.ok)throw Error('PUBLIC_RESEARCH_FEED_HTTP');const d=await r.json();if(d.error||d.errors?.length)throw Error('PUBLIC_RESEARCH_FEED_ERROR');return d;
 }
 async refresh(){
  if(this.refreshing||this.stopped)return;this.refreshing=true;
  try{
   const now=this.now();
   if(!this.meta||now-this.meta.checked_at>3600000){const d=await this.read('/derivatives/api/v3/instruments'),i=d.instruments?.find(x=>x.symbol==='PF_XBTUSD');
    if(!i||i.type!=='flexible_futures'||i.base!=='BTC'||i.quote!=='USD'||i.contractSize!==1||!i.tradeable||i.suspended||i.isExpired||!Number.isInteger(i.contractValueTradePrecision)||i.contractValueTradePrecision>8||i.contractValueTradePrecision<0||!(i.tickSize>0))throw Error('RESEARCH_INSTRUMENT_MISMATCH');
    this.meta={symbol:i.symbol,qty_step:10**-i.contractValueTradePrecision,tick_size:i.tickSize,checked_at:now};
   }
   if(Array.isArray(this.candleFrames)){
    this.frameErrors??={};this.frameRefreshAt??={};
    // Fetch each closed series only when its latest close is due. A slow-frame
    // failure stays local and cannot veto a healthy five-minute evaluation.
    await Promise.allSettled(this.candleFrames.map(async tf=>{
     const expected=Math.floor(now/(tf*60000))*tf*60000;
     if(this.series[tf]?.length>=64&&this.series[tf].at(-1).end===expected)return;
     try{
      const resolution=({5:'5m',15:'15m',60:'1h',240:'4h',1440:'1d'})[tf];if(!resolution)throw Error('FUTURES_RESOLUTION_UNSUPPORTED');
      const payload=await this.read('/api/charts/v1/trade/PF_XBTUSD/'+resolution+'?count=256'),available=this.now();
      const bars=closedBars(payload,tf,available).slice(-256).map(bar=>({...bar,available_at:available}));
      if(bars.length<64||bars.at(-1)?.end!==expected||bars.some((bar,i)=>i&&bar.start!==bars[i-1].end))throw Error('CONTEXT_NOT_SYNCHRONIZED');
      this.series[tf]=bars;this.frameRefreshAt[tf]=available;delete this.frameErrors[tf];
     }catch(error){this.frameErrors[tf]=/^[A-Z_]+$/.test(error.message)?error.message:'FUTURES_CANDLE_FEED_UNAVAILABLE';}
    }));
   }else for(const tf of [5,15]){const d=await this.read('/api/charts/v1/trade/PF_XBTUSD/'+tf+'m?count=256');this.series[tf]=closedBars(d,tf,this.now()).slice(-256);}
   if(!this.fundingChecked||now-this.fundingChecked>300000){
    try{const d=await this.read('/derivatives/api/v3/historical-funding-rates?symbol=PF_XBTUSD');for(const r of d.rates??[]){const at=Date.parse(r.timestamp);if(Number.isFinite(at)&&Number.isFinite(Number(r.fundingRate)))this.rates[at]=Number(r.fundingRate);}this.fundingChecked=now;this.fundingRefreshError=null;}
    catch(error){if(!Array.isArray(this.candleFrames))throw error;this.fundingRefreshError=/^[A-Z_]+$/.test(error.message)?error.message:'FUTURES_FUNDING_HISTORY_UNAVAILABLE';}
   }
   this.lastRefresh=this.now();this.feedError=null;
  }catch(e){this.feedError=/^[A-Z_]+$/.test(e.message)?e.message:'PUBLIC_RESEARCH_FEED_UNAVAILABLE';}
  finally{this.refreshing=false;}
 }
 connect(){
  if(this.stopped)return;const ws=this.socketFactory('wss://futures.kraken.com/ws/v1');this.ws=ws;
  ws.addEventListener('open',()=>ws.send(JSON.stringify({event:'subscribe',feed:'ticker',product_ids:['PF_XBTUSD']})));
  ws.addEventListener('message',e=>{try{const x=JSON.parse(e.data);if(x.feed!=='ticker'||x.product_id!=='PF_XBTUSD')return;const at=Number(x.time);if(!Number.isSafeInteger(at)||at>this.now()+1000||this.now()-at>5000||this.quote&&at<=this.quote.at)return;
   const q={at,received_at:this.now(),bid:Number(x.bid),ask:Number(x.ask),bid_qty:Number(x.bid_size),ask_qty:Number(x.ask_size),suspended:x.suspended===true};if(![q.bid,q.ask,q.bid_qty,q.ask_qty].every(Number.isFinite))return;
   this.quote=q;const rate=Number(x.funding_rate??0);if(Number.isFinite(rate))this.rates[Math.floor(at/3600000)*3600000]=rate;
  }catch{this.feedError='PUBLIC_RESEARCH_MESSAGE_INVALID';}});
  ws.addEventListener('error',()=>{this.feedError='PUBLIC_RESEARCH_WS_ERROR';});
  ws.addEventListener('close',()=>{if(!this.stopped&&this.ws===ws)this.reconnect=setTimeout(()=>this.connect(),5000);});
 }
 start(){this.stopped=false;void this.refresh();this.connect();this.timers.push(setInterval(()=>{void this.refresh();if(this.quote&&this.now()-this.quote.received_at>30000)this.ws?.close();},15000));}
 stop(){this.stopped=true;for(const t of this.timers)clearInterval(t);clearTimeout(this.reconnect);this.ws?.close();}
 tick(){
  const s=this.state,now=this.now(),event=e=>this.engine.event(e);
  const healthy=processQuote(s,this.quote,this.meta,this.rates,now,event);
  s.market={symbol:PROTOCOL.symbol,quote_at:this.quote?.at??null,last_refresh:this.lastRefresh??null,error:this.feedError??s.market_issue,closed_at:Object.fromEntries([5,15].map(tf=>[tf,this.series[tf].at(-1)?.end??null]))};
  const cutoff=Math.floor(now/300000)*300000;if(cutoff<=s.last_cutoff||now-cutoff<2000)return;
  if(now-cutoff>30000){s.last_cutoff=cutoff;for(const a of Object.values(s.accounts)){a.last_decision={at:now,cutoff,reason:'EVALUATION_WINDOW_MISSED'};a.reasons.EVALUATION_WINDOW_MISSED=(a.reasons.EVALUATION_WINDOW_MISSED??0)+1;}return;}
  if(!healthy||!this.meta||now-this.meta.checked_at>3600000||this.feedError)return;
  const decisions=evaluatePatterns(this.series,this.quote,cutoff,this.rates[Math.floor(now/3600000)*3600000]??0);
  if(decisions.some(d=>d.reason==='CONTEXT_NOT_SYNCHRONIZED'))return;
  s.last_cutoff=cutoff;
  for(const d of decisions){const a=s.accounts[d.pattern];let reason=d.reason;
   if(d.plan){if(a.position)reason='POSITION_ALREADY_OPEN';else if(a.halted)reason='DRAWDOWN_HALT';else if(now<a.cooldown_until)reason='LOSS_STREAK_COOLDOWN';else reason=enter(a,d.plan,this.quote,this.meta,now,event)?'PAPER_OPENED':'RISK_OR_OBSERVED_LIQUIDITY';}
   a.last_decision={at:now,cutoff,reason,facts:d.facts};a.reasons[reason]=(a.reasons[reason]??0)+1;event({type:'MULTI_PATTERN_EVALUATION',at:now,cutoff,pattern:d.pattern,reason,facts:d.facts,mode:'SHADOW_PAPER'});
  }
 }
}
export function installMultiPattern(engine,env){
 const key=env.LUMI_TRADING_MULTI_PATTERN;if(!key)return null;
 if(key!==VERSION||env.LUMI_TRADING_MODE!=='PAPER'||env.LUMI_TRADING_STORAGE!=='SQLITE'||env.LUMI_RUNTIME_ENV!=='staging')throw Error('MULTI_RESEARCH_PAPER_ONLY');
 const r=new MultiPatternPaper({engine}).initialize(),tick=engine.tick.bind(engine);
 engine.tick=async()=>{if(engine.busy)return;r.tick();await tick();};r.start();process.once('SIGTERM',()=>r.stop());process.once('SIGINT',()=>r.stop());return r;
}
// Add the durable comparison to the existing private snapshot, never to balances.
export function attachResearchProjection(publisher,store){
 if(!publisher)return;const send=publisher.send.bind(publisher);
 publisher.send=async(path,body,revision)=>{
  const d=JSON.parse(body),row=store.row();
  if(row.revision===revision&&row.state.multiStrategy)d.multi_strategy=researchView(row.state.multiStrategy);
  return send(path,JSON.stringify(d),revision);
 };
}
