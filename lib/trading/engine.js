import {POLICY,VERSION,M15,hash,freshness,iso} from './core.js';
import {evaluate} from './strategies.js';
import {newAccount,select,step,cancel,invalidate,repairPosition,mark} from './simulator.js';
import {newResearch,monthlyReview,compareCandidate,promote} from './research.js';
import {publicREST,restBars} from './feed.js';
import {initialCapital,reconcilePaperCapital} from './capital.js';
export function initialState(now){return {schema:1,capital:initialCapital(now),started_at:now,last_checkpoint:now,last_cutoff:Math.floor(now/M15)*M15,research:newResearch(),alert:newAccount(),delivered:{},counters:{criticalIncidents:0,mature:0,candidates:0,selected:0,suppressed:0,notFilled:0,incidents:0,delivered:0,rejected:0,unknown:0},last_summary:now,last_daily:null,last_research_eval:null};}
export class TradingEngine {
  constructor({feed,store,notifier=null,now=()=>Date.now()}){Object.assign(this,{feed,store,notifier,now});this.events=[];this.notices=[];this.busy=false;this.evaluating=false;this.repairing=true;this.lastFlush=0;this.lastFeedAudit=0;this.lastQuality=null;this.lastLease=0;}
  active(){return this.state.research.versions[this.state.research.active];}
  ledgers(){return [...Object.values(this.state.research.versions).filter(v=>v.version===this.state.research.active||v.status==='CANDIDATE'||v.account.position||v.account.pending),...this.state.research.campaigns.filter(c=>c.status==='PROSPECTIVE').map(c=>c.comparator)];}
  event(e){this.events.push(e);if(e.type==='DATA_INCIDENT')this.state.counters.incidents++;if(this.events.length>10000)throw Error('TRADING_EVENT_BUFFER_LIMIT');}
  notice(kind,payload,key){this.notices.push({id:hash(['lumi-trading',kind,key]),kind,payload});}
  pending(id){return this.active().account.pending?.plan.id===id;}
  async initialize(){
    const restored=await this.store.acquire();this.lastLease=this.now();this.state=restored.schema?restored:initialState(this.now());
    if(this.state.schema!==1)throw Error('TRADING_STATE_VERSION_UNSUPPORTED');
    const capitalChange=reconcilePaperCapital(this.state,this.now());
    if(capitalChange){this.event(capitalChange);this.notice('VERSION',capitalChange,'capital-100-v1');}
    this.event({type:'BOOT',at:this.now(),restored:Boolean(restored.schema),version:VERSION,policy:POLICY,realTrading:false});
    for(const v of this.ledgers()){if(v.account.pending)this.record({type:'ENTRY_RECONCILIATION_REQUIRED',id:v.account.pending.plan.id,at:this.now()},v);v.strategy.setups={};}
    if(this.state.alert.pending)this.record({type:'ENTRY_RECONCILIATION_REQUIRED',id:this.state.alert.pending.plan.id,at:this.now()},{version:this.state.research.active,ledger:'ALERT_PLUS_60S'});
    this.state.last_cutoff=Math.floor(this.now()/M15)*M15;
    this.feed.on('incident',e=>this.event(e));
    this.feed.on('reconciliation',e=>this.event(e));
    this.feed.on('disconnect',()=>{this.repairing=true;this.cancelPending('FEED_DISCONNECT');});
    this.feed.on('ready',e=>{void this.recover(e).catch(()=>{this.repairing=true;this.event({type:'DATA_INCIDENT',reason:'RECOVERY_FAILED',at:this.now()});});});
    // Process every trade/quote in wire order; timers only flush/evaluate.
    this.feed.on('trade',()=>this.onMarket());this.feed.on('quote',()=>this.onMarket());
    await this.flush();return this;
  }
  cancelPending(reason){for(const v of this.ledgers()){const e=cancel(v.account,reason,this.now());if(e)this.record(e,v);v.strategy.setups={};}const e=cancel(this.state.alert,reason,this.now());if(e)this.record(e,{version:this.state.research.active,ledger:'ALERT_PLUS_60S'});}
  record(e,v){const ledger=v.ledger||(v.comparator?'CAMPAIGN_BASELINE':v.version===this.state.research.active?'ENGINE':'CANDIDATE');e={...e,version:v.version,ledger};this.event(e);
    if(ledger==='ENGINE'){if(e.type==='SELECTED')this.state.counters.selected++;if(e.type==='SUPPRESSED')this.state.counters.suppressed++;if(e.type==='NOT_FILLED')this.state.counters.notFilled++;}
    if(e.type==='CLOSED'){if(e.quality==='UNRESOLVED_GAP')this.state.counters.criticalIncidents=(this.state.counters.criticalIncidents||0)+1;if(ledger==='ENGINE'&&e.quality==='OBSERVED')this.state.counters.mature=(this.state.counters.mature||0)+1;v.fills=(v.fills||0)+1;if(v.strategy)v.strategy.cooldowns[(e.family||'A')+'LONG']=this.now()+4*M15;if(['ENGINE','ALERT_PLUS_60S'].includes(ledger))this.notice('RESULT',e,[ledger,e.id]);}
  }
  onMarket(){
    if(!this.state||this.repairing||this.now()-this.lastLease>30000)return;
    const now=this.now(),bad=freshness(this.feed.state,now,this.feed.metadata);
    if(bad){if(this.lastQuality!==bad){this.event({type:'DATA_INCIDENT',reason:bad,at:now});this.cancelPending(bad);this.gapAt??=now;}this.lastQuality=bad;return;}
    if(this.gapAt){this.repairing=true;void this.recover({gapStart:this.gapAt}).catch(()=>{});return;}
    this.lastQuality=null;
    for(const v of this.ledgers())for(const e of step(v.account,this.feed.state,now))this.record(e,v);
    for(const e of step(this.state.alert,this.feed.state,now))this.record(e,{version:this.state.research.active,ledger:'ALERT_PLUS_60S'});
  }
  async recover({gapStart}){
    this.repairing=true;const now=this.now();if(freshness(this.feed.state,now,this.feed.metadata)){this.gapAt=gapStart||now;return;}const hasOpen=this.ledgers().some(v=>v.account.position||v.account.pending)||this.state.alert.position||this.state.alert.pending;
    if(hasOpen){const response=await publicREST('OHLC',{pair:'XBTUSD',interval:'1'},this.feed.fetchImpl),bars=restBars(response,1,this.now(),{includeOpen:true});
      for(const v of this.ledgers())for(const e of repairPosition(v.account,bars,this.feed.state,this.now(),Math.min(gapStart||now,this.state.last_checkpoint)))this.record(e,v);
      for(const e of repairPosition(this.state.alert,bars,this.feed.state,this.now(),Math.min(gapStart||now,this.state.last_checkpoint)))this.record(e,{version:this.state.research.active,ledger:'ALERT_PLUS_60S'});
    }
    this.gapAt=null;this.state.last_cutoff=Math.floor(this.now()/M15)*M15;this.repairing=false;
    this.event({type:'FEED_RECOVERED',at:this.now(),gapStart,bars:Object.fromEntries(Object.entries(this.feed.series).map(([k,b])=>[k,{n:b.length,last:b.at(-1)?.end,hash:hash(b)}]))});
    if(!this.state.technicalQueued){this.notice('TECHNICAL',{version:VERSION},'connection-v1');this.state.technicalQueued=true;}
  }
  async boundary(){
    const now=this.now(),cutoff=Math.floor(now/M15)*M15;
    if(this.evaluating||cutoff<=this.state.last_cutoff||now-cutoff<1500)return;
    this.evaluating=true;this.state.last_cutoff=cutoff;
    try{
      if(now-cutoff>10000||this.repairing){this.event({type:'EVALUATION_SKIPPED',cutoff,at:now,reason:'LATE_OR_RECONCILING'});return;}
      await this.feed.reconcile();const decision=this.now();
      if(decision-cutoff>10000){this.event({type:'EVALUATION_SKIPPED',cutoff,at:decision,reason:'BAR_RECONCILIATION_DEADLINE'});return;}
      for(const v of this.ledgers()){
        const r=evaluate(v.strategy,this.feed.series,cutoff,decision,this.feed.metadata,{version:v.version,rules:v.rules});
        this.event({type:'RULE_EVALUATION',at:decision,cutoff,version:v.version,reason:r.reason,context:r.context,feed:this.feed.snapshot()});
        if(v.version===this.state.research.active&&!v.comparator)this.feed.context=r.context;
        for(const e of r.log){this.record(e,v);if(e.type==='CANDIDATE'&&v.version===this.state.research.active&&!v.comparator)this.state.counters.candidates++;}
        if(v.account.pending){const p=v.account.pending.plan,bad=invalidate(p,this.feed.state,decision,r.context);if(bad){const e=cancel(v.account,bad,decision);if(e)this.record(e,v);}}
        for(const p of r.plans){
          const bad=(this.state.research.paused?'RESEARCH_PAUSED':null)||freshness(this.feed.state,decision,this.feed.metadata)||invalidate(p,this.feed.state,decision,r.context);
          const e=bad?{type:'SUPPRESSED',id:p.id,reason:bad}:select(v.account,p,this.feed.state.quote,this.feed.metadata,decision);
          this.record(e,v);
          if(e.type==='SELECTED'&&v.version===this.state.research.active&&!v.comparator)this.notice('SIGNAL',{plan:e.plan},p.id);
        }
      }
    }finally{this.evaluating=false;}
  }
  async flush(){
    const count=this.events.length,n=this.notices.length,snapshot=structuredClone(this.state);snapshot.last_checkpoint=this.now();
    await this.store.commit(snapshot,this.events.slice(0,count),this.notices.slice(0,n));this.state.last_checkpoint=snapshot.last_checkpoint;this.events.splice(0,count);this.notices.splice(0,n);this.lastFlush=this.now();
  }
  acceptDelivery(n){
    const p=n.payload.plan;if(this.state.delivered[n.id])return;this.state.delivered[n.id]=true;
    const response=n.receipt.response_at,now=this.now(),bad=freshness(this.feed.state,now,this.feed.metadata)||invalidate(p,this.feed.state,now,this.feed.context);
    // Do not install the order retrospectively if this receipt was recovered
    // after a restart, the trigger passed, or the response is already old.
    let e;if(bad||now-response>5000||!this.pending(p.id))e={type:'NOT_FILLED',id:p.id,reason:bad||'DELIVERY_RECOVERY_OR_ENGINE_TRIGGER_PASSED',at:now};
    else e=select(this.state.alert,p,this.feed.state.quote,this.feed.metadata,now,{latency:Math.max(0,response+POLICY.manualLatency-now)});
    this.record(e,{version:p.version,ledger:'ALERT_PLUS_60S'});
  }
  daily(now){
    const day=iso(now).slice(0,10);if(this.state.last_daily===day)return;
    const previous=this.state.last_daily;this.state.last_daily=day;
    for(const v of this.ledgers()){
      const equity=Number(v.account.equity);v.days||={};if(previous)v.days[previous]=v.lastDayEquity?equity/v.lastDayEquity-1:equity/Number(POLICY.initialCash)-1;v.lastDayEquity=equity;
    }
    const mature=this.state.counters.mature||0;
    for(const e of monthlyReview(this.state.research,mature,now))this.event(e);
    for(const c of this.state.research.campaigns.filter(c=>c.status==='PROSPECTIVE')){
      for(const id of c.candidates){const v=this.state.research.versions[id],base=c.comparator;if(v.evaluationFinal)continue;
        const stats=x=>({days:x.days||{},fills:x.account.observedClosed||0,drawdown:+x.account.maxDrawdown,net:+x.account.net,incidents:this.state.counters.criticalIncidents||0});
        const report=compareCandidate(c,stats(v),stats(base),{now,attempts:this.state.research.attempts,historical:v.historical});
        this.event({type:'VERSION_EVALUATION',campaign:c.id,version:id,at:now,report});
        if(report.status==='REJECTED'){v.evaluationFinal=report;v.status='REJECTED';}
        if(report.status==='ELIGIBLE_PAPER'){const e=promote(this.state.research,c,id,report,now);this.event(e);this.notice('VERSION',e,[c.id,id]);if(e.type==='VERSION_PROMOTED_PAPER')for(const other of c.candidates)if(other!==id){this.state.research.versions[other].status='NOT_PROMOTED';this.event({type:'CANDIDATE_ENDED',version:other,campaign:c.id,reason:'PREDECLARED_FIRST_ELIGIBLE_PROMOTED',at:now});}break;}
      }
      if(c.candidates.every(id=>this.state.research.versions[id].evaluationFinal))c.status='REJECTED';
    }
  }
  async tick(){
    if(this.busy)return;this.busy=true;
    try{
      const now=this.now();if(now-this.lastLease>=10000){await this.store.renew();this.lastLease=this.now();}
      if(this.repairing&&this.feed.state.reconciled&&!freshness(this.feed.state,now,this.feed.metadata))await this.recover({gapStart:this.gapAt||this.state.last_checkpoint});
      this.onMarket();await this.boundary();this.daily(this.now());
      if(now-this.lastFeedAudit>=60000){this.event({type:'FEED_AUDIT',at:now,feed:this.feed.snapshot(),resource:process.resourceUsage(),memory:process.memoryUsage()});this.lastFeedAudit=now;}
      if(now-this.state.last_summary>=7*86400000){const summary={initialCash:this.state.capital.initialCash,...this.state.counters,from:iso(this.state.started_at),to:iso(now),engine:structuredClone(this.active().account),alert:structuredClone(this.state.alert)};this.notice('SUMMARY',summary,Math.floor(now/(7*86400000)));this.state.last_summary=now;}
      if(now-this.lastFlush>=2000||this.notices.length)await this.flush();
      if(this.notifier&&now-(this.lastNotify||0)>=5000){this.lastNotify=now;const outcomes=await this.notifier.drain();for(const e of outcomes){this.event({type:'NOTICE_RESULT',...e,at:this.now()});if(e.status==='DELIVERED')this.state.counters.delivered++;else if(e.status==='UNKNOWN')this.state.counters.unknown++;else this.state.counters.rejected++;}
        if(outcomes.length){for(const n of await this.store.deliveredSince(now-60000))this.acceptDelivery(n);await this.flush();}}
    }finally{this.busy=false;}
  }
}
