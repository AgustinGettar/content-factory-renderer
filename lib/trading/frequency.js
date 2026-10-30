// Separate paper ledger. The laboratory may transfer validated rules, never its cash.
import Decimal from 'decimal.js';
import {D,POLICY,hash,ceilTick,floorTick,checkSeries,freshness,indicators} from './core.js';
import {newAccount,select,step,cancelAll,repairPosition} from './simulator.js';
import {findPosition} from './portfolio.js';
import {publicREST,restBars} from './feed.js';
export const FREQUENCY_VERSION='lumi-frequency-1.0.0';
export const FREQUENCY_POLICY=Object.freeze({...POLICY,version:FREQUENCY_VERSION,minNetRR:'0.1'});
export const FREQUENCY_PROTOCOL=Object.freeze({version:FREQUENCY_VERSION,initialCash:'100',intervalMs:60000,fastEMA:9,slowEMA:21,minBars:60,entryExpiryMs:120000,cooldownMs:60000,maxSelectionsPerUTCDate:12,maxHoldingMinutes:30,minNetTargetFraction:'0.0015',minNetRR:'0.1',risk:POLICY.risk,dailyLoss:POLICY.dailyLoss,drawdown:POLICY.drawdown,fee:POLICY.fee,slippage:POLICY.slippage,feeSource:POLICY.feeSource,feeVerifiedAt:'2026-10-29',hypothesis:'More frequent entry opportunities; measure net results after unchanged taker costs. No assumed win probability or profitability.',realTrading:false});
export function initializeFrequency(state,now){
 if(state.frequency){if(state.frequency.version!==FREQUENCY_VERSION||state.frequency.protocol_hash!==hash(FREQUENCY_PROTOCOL))throw Error('FREQUENCY_PROTOCOL_MISMATCH');return null;}
 const base=state.research.versions[state.research.active].account;
 state.frequency={version:FREQUENCY_VERSION,protocol:{...FREQUENCY_PROTOCOL},protocol_hash:hash(FREQUENCY_PROTOCOL),started_at:now,account:newAccount(FREQUENCY_POLICY),lastCutoff:Math.floor(now/60000)*60000,lastDecision:null,cooldownUntil:0,selectionDay:null,daySelections:0,counts:{evaluations:0,candidates:0,selected:0,filled:0,closed:0,notFilled:0,suppressed:0},history:[],grossClosed:'0',closedFees:'0',baseline_at_start:{at:now,version:state.research.active,equity:base.equity,net:base.net,fees:base.fees,closed:base.closed}};
 return {type:'FREQUENCY_ACCOUNT_STARTED',at:now,version:FREQUENCY_VERSION,initialCash:'100',protocol:{...FREQUENCY_PROTOCOL},protocol_hash:state.frequency.protocol_hash,baseline_at_start:state.frequency.baseline_at_start,realTrading:false};
}
const ema=(bars,n)=>{let value=bars.slice(0,n).reduce((s,b)=>s+ +b.close,0)/n;for(const b of bars.slice(n))value=2/(n+1)*b.close+(1-2/(n+1))*value;return value;};
export function frequencyPlan(bars,feed,metadata,cutoff,now){
 const closed=bars.filter(b=>b.end<=cutoff&&b.available_at<=now).slice(-120),bad=checkSeries(closed,60000,60);
 if(bad)return {reason:bad};if(closed.at(-1).end!==cutoff)return {reason:'UNSYNCHRONIZED_1'};
 const j=closed.at(-1),previous=closed.at(-2),fast=ema(closed,9),slow=ema(closed,21),atr=indicators(closed).at(-1).atr;
 const criteria={fastAboveSlow:fast>slow,positiveCandle:+j.close>+j.open,aboveFast:+j.close>fast,positiveMomentum:+j.close>=+previous.close};
 if(!Object.values(criteria).every(Boolean)||!(atr>0))return {reason:'FREQUENCY_WAIT_MOMENTUM',criteria};
 const entry=ceilTick(Decimal.max(+j.high,+feed.quote.ask).plus(metadata.tick_size),metadata.tick_size);
 const limit=ceilTick(D(entry).mul('1.0005'),metadata.tick_size);
 const stop=floorTick(D(entry).minus(Decimal.max(D(entry).mul('.002'),D(atr).mul('1.5'))),metadata.tick_size);
 const fee=D(POLICY.fee),slip=D(POLICY.slippage),spread=D(feed.quote.ask).minus(feed.quote.bid),e=D(limit),exitStop=D(stop).minus(spread).mul(D(1).minus(slip));
 const loss=e.minus(exitStop).plus(e.plus(exitStop).mul(fee));
 const gain=Decimal.max(e.mul(FREQUENCY_PROTOCOL.minNetTargetFraction),loss.mul(FREQUENCY_PROTOCOL.minNetRR).mul('1.001'));
 // Solve the target from the desired NET gain. Never call a gross rise a net profit.
 const target=ceilTick(e.mul(D(1).plus(fee)).plus(gain).div(D(1).minus(fee)).div(D(1).minus(slip)).plus(spread),metadata.tick_size);
 const plan={version:FREQUENCY_VERSION,instrument:POLICY.instrument,family:'F',direction:'LONG',confirmed_at:cutoff,decision_at:now,entry,limit,stop,target,atr1:atr,H:2,holding_ms:1800000,expires_at:now+120000,trigger_source:'LAST',order:'SIMULATED_STOP_LIMIT',setup:{family:'F'},criteria:['CLOSED_1M','EMA9_ABOVE_EMA21','POSITIVE_MOMENTUM','NET_TARGET_AFTER_COSTS'],input_hash:hash(closed),experiment:true};
 plan.id=hash([FREQUENCY_VERSION,cutoff]);plan.hash=hash(plan);return {reason:'CANDIDATES',criteria,plan};
}
export class FrequencyExperiment {
 constructor({state,feed,now=()=>Date.now(),event,notice,prepare=p=>p}){Object.assign(this,{state,feed,now,event,notice,prepare});}
 record(e,version){
  const s=this.state,e2={...e,at:e.at??this.now(),version:version??e.plan?.version??e.policy_version??this.state.account.position?.plan.version??this.state.account.pending?.plan.version??this.activeVersion??FREQUENCY_VERSION,ledger:'FREQUENT_PAPER'};
  const key={SELECTED:'selected',FILLED:'filled',CLOSED:'closed',NOT_FILLED:'notFilled',SUPPRESSED:'suppressed'}[e.type];if(key)s.counts[key]++;
  if(e.type==='SELECTED')s.daySelections++;
  if(e.type==='CLOSED'){s.grossClosed=D(s.grossClosed).plus(e.pnl).plus(e.fees).toString();s.closedFees=D(s.closedFees).plus(e.fees).toString();}
  if(['CLOSED','NOT_FILLED'].includes(e.type))s.cooldownUntil=this.now()+60000;
  if(['SELECTED','FILLED','CLOSED','NOT_FILLED','SUPPRESSED'].includes(e.type)){s.history.unshift({type:e.type,at:e2.at,id:e.id,reason:e.reason,entry:e.entry,price:e.price,qty:e.qty,pnl:e.pnl,fees:e.fees,quality:e.quality,direction:e.direction??e.plan?.direction,leverage:e.leverage??e.plan?.sizing?.leverage,timeframe:e.timeframe??e.plan?.timeframe,version:e2.version});s.history=s.history.slice(0,40);}
  this.event(e2);
  if(e.type==='SELECTED')this.notice('SIGNAL',{plan:e.plan,account:'FREQUENT_PAPER'},e.plan.id);
  if(e.type==='FILLED')this.notice('RESULT',{...e2,type:'PAPER_OPENED',plan:e.plan??findPosition(s.account,e.id).plan},['opened','FREQUENT_PAPER',e.id]);
  if(e.type==='CLOSED')this.notice('RESULT',e2,['FREQUENT_PAPER',e.id]);
 }
 market(){const version=this.state.account.position?.plan.version??this.state.account.pending?.plan.version??this.activeVersion;for(const e of step(this.state.account,this.feed.state,this.now(),FREQUENCY_POLICY))this.record(e,e.policy_version??version);}
 cancel(reason){const version=this.state.account.pending?.plan.version;for(const e of cancelAll(this.state.account,reason,this.now()))this.record(e,e.policy_version??version);}
 recover(bars,gapStart){const version=this.state.account.position?.plan.version??this.state.account.pending?.plan.version;for(const e of repairPosition(this.state.account,bars,this.feed.state,this.now(),gapStart))this.record(e,e.policy_version??version);this.state.lastCutoff=Math.floor(this.now()/60000)*60000;}
 async boundary(){
  const now=this.now(),cutoff=Math.floor(now/60000)*60000,s=this.state;
  if(cutoff<=s.lastCutoff||now-cutoff<1500)return;
  s.lastCutoff=cutoff;s.counts.evaluations++;
  const day=new Date(now).toISOString().slice(0,10);if(s.selectionDay!==day){s.selectionDay=day;s.daySelections=0;}
  const decide=(reason,extra={})=>{s.lastDecision={at:this.now(),cutoff,reason,...extra};this.event({type:'FREQUENCY_EVALUATION',...s.lastDecision,version:FREQUENCY_VERSION,ledger:'FREQUENT_PAPER'});};
  const bad=freshness(this.feed.state,now,this.feed.metadata);
  if(bad||now-cutoff>10000){decide(bad||'LATE_EVALUATION');return;}
  if(s.account.halted){decide('DRAWDOWN_HALT');return;}
  if(s.account.position||s.account.pending){decide('POSITION_OR_ENTRY_IN_PROGRESS');return;}
  if(now<s.cooldownUntil){decide('COOLDOWN');return;}
  if(s.daySelections>=12){decide('DAILY_SELECTION_LIMIT');return;}
  try{
   const raw=await publicREST('OHLC',{pair:'XBTUSD',interval:'1'},this.feed.fetchImpl),decision=this.now();
   const stale=freshness(this.feed.state,decision,this.feed.metadata);
   if(stale||decision-cutoff>10000){decide(stale||'BAR_RECONCILIATION_DEADLINE');return;}
   const bars=restBars(raw,1,decision),r=frequencyPlan(bars,this.feed.state,this.feed.metadata,cutoff,decision);
   if(!r.plan){decide(r.reason,{criteria:r.criteria});return;}
   s.counts.candidates++;
   if(+this.feed.state.trade.price<=+r.plan.stop||+this.feed.state.trade.price>=+r.plan.target){decide('BARRIER_BEFORE_ENTRY');return;}
   r.plan=this.prepare(r.plan,bars);
   const e=select(s.account,r.plan,this.feed.state.quote,this.feed.metadata,decision,{policy:FREQUENCY_POLICY});
   this.record(e);decide(e.type==='SELECTED'?'ENTRY_SELECTED':e.reason,{criteria:r.criteria});
  }catch{decide('ONE_MINUTE_DATA_UNAVAILABLE');}
 }
}
