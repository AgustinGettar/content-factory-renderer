import {initializeMargin} from './margin.js';
import {initializeSecondaryRisk} from './secondary-risk.js';
import {initializeTimeframes,recipeComponents,componentVersion} from './timeframes.js';
import {POLICY,VERSION,M15,hash,freshness,iso} from './core.js';
import {evaluate} from './strategies.js';
import {newAccount,select,step,cancel,cancelAll,invalidate,repairPosition,mark} from './simulator.js';
import {positions,orders,findPosition,findOrder,initializePortfolio,stampPlan,portfolioPolicy} from './portfolio.js';
import {newResearch,monthlyReview,compareCandidate,promote} from './research.js';
import {publicREST,restBars} from './feed.js';
import {initialCapital,reconcilePaperCapital} from './capital.js';
import {initializeFrequency,FrequencyExperiment} from './frequency.js';
import {initializeLearning,TradingLearning} from './learning.js';
import {initializeLaboratory,TradingLaboratory,laboratoryPlan,laboratoryPolicy} from './laboratory.js';
export function initialState(now){return {schema:1,capital:initialCapital(now),started_at:now,last_checkpoint:now,last_cutoff:Math.floor(now/M15)*M15,research:newResearch(),alert:newAccount(),delivered:{},counters:{criticalIncidents:0,mature:0,candidates:0,selected:0,suppressed:0,notFilled:0,incidents:0,delivered:0,rejected:0,unknown:0},last_summary:now,last_daily:null,last_research_eval:null};}
export class TradingEngine {
  constructor({feed,store,notifier=null,now=()=>Date.now(),secondaryRiskRequested=false}){Object.assign(this,{feed,store,notifier,now,secondaryRiskRequested});this.events=[];this.notices=[];this.busy=false;this.evaluating=false;this.repairing=true;this.lastFlush=0;this.lastFeedAudit=0;this.lastQuality=null;this.lastLease=0;}
  active(){return this.state.research.versions[this.state.research.active];}
  ledgers(){return [...Object.values(this.state.research.versions).filter(v=>v.version===this.state.research.active||v.status==='CANDIDATE'||v.account.position||v.account.pending),...this.state.research.campaigns.filter(c=>c.status==='PROSPECTIVE').map(c=>c.comparator)];}
  event(e){if(this.learning&&['SELECTED','CLOSED','NOT_FILLED'].includes(e.type))this.learning.observe(e,e.ledger,e.version);this.laboratory?.observe(e);this.events.push(e);if(e.type==='DATA_INCIDENT')this.state.counters.incidents++;if(this.events.length>10000)throw Error('TRADING_EVENT_BUFFER_LIMIT');}
  notice(kind,payload,key){this.notices.push({id:hash(['lumi-trading',kind,key]),kind,payload});}
  pending(id){return Boolean(findOrder(this.active().account,id)||findOrder(this.state.frequency?.account,id));}
  async initialize(){
    const restored=await this.store.acquire();this.lastLease=this.now();this.state=restored.schema?restored:initialState(this.now());
    if(![1,2,3,4,5].includes(this.state.schema))throw Error('TRADING_STATE_VERSION_UNSUPPORTED');
    const capitalChange=reconcilePaperCapital(this.state,this.now());
    if(capitalChange){this.event(capitalChange);this.notice('VERSION',capitalChange,'capital-100-v1');}
    const frequencyStarted=initializeFrequency(this.state,this.now());
    this.frequency=new FrequencyExperiment({state:this.state.frequency,feed:this.feed,now:this.now,event:e=>this.event(e),notice:(...args)=>this.notice(...args),prepare:(p,bars)=>this.learning.prepare(p,'FREQUENT_PAPER',bars,this.feed.state.quote)});
    if(frequencyStarted){this.event(frequencyStarted);this.notice('VERSION',frequencyStarted,'frequency-1.0.0-started');}
    const learningStarted=initializeLearning(this.state,this.now());
    this.learning=new TradingLearning({state:this.state.learning,now:this.now,event:e=>this.event(e)});
    if(learningStarted){this.event(learningStarted);this.notice('VERSION',learningStarted,'learning-1.0.0-enabled');}
    const labStarted=initializeLaboratory(this.state,this.now());
    this.laboratory=new TradingLaboratory({state:this.state,feed:this.feed,now:this.now,event:e=>this.event(e),notice:(...args)=>this.notice(...args),frequency:this.frequency,learning:this.learning});
    this.frequency.activeVersion=this.state.laboratory.active;
    if(labStarted){this.event(labStarted);this.notice('VERSION',labStarted,'laboratory-1.0.0-enabled');}
    const portfolioStarted=initializePortfolio(this.state,this.now());
    if(portfolioStarted){this.event(portfolioStarted);this.notice('VERSION',portfolioStarted,portfolioStarted.version);}
    const framesStarted=initializeTimeframes(this.state,this.now());if(framesStarted)this.event(framesStarted);
    const marginStarted=initializeMargin(this.state,this.now());if(marginStarted)this.event(marginStarted);
    initializeSecondaryRisk(this.state,this.now(),this.secondaryRiskRequested);
    this.state.last_frame_cutoff=Math.floor(this.now()/60000)*60000;
    this.event({type:'BOOT',at:this.now(),restored:Boolean(restored.schema),version:VERSION,policy:POLICY,realTrading:false});
    for(const v of this.ledgers()){for(const p of orders(v.account))this.record({type:'ENTRY_RECONCILIATION_REQUIRED',id:p.plan.id,policy_version:p.plan.version,at:this.now()},v);v.strategy.setups={};}
    for(const p of orders(this.state.alert))this.record({type:'ENTRY_RECONCILIATION_REQUIRED',id:p.plan.id,policy_version:p.plan.version,at:this.now()},{version:this.state.research.active,ledger:'ALERT_PLUS_60S'});
    this.state.last_cutoff=Math.floor(this.now()/M15)*M15;
    this.feed.on('incident',e=>this.event(e));
    this.feed.on('reconciliation',e=>this.event(e));
    this.feed.on('disconnect',()=>{this.repairing=true;this.cancelPending('FEED_DISCONNECT');});
    this.feed.on('ready',e=>{void this.recover(e).catch(()=>{this.repairing=true;this.event({type:'DATA_INCIDENT',reason:'RECOVERY_FAILED',at:this.now()});});});
    // Process every trade/quote in wire order; timers only flush/evaluate.
    this.feed.on('trade',()=>this.onMarket());this.feed.on('quote',()=>this.onMarket());
    await this.flush();return this;
  }
  cancelPending(reason){this.frequency?.cancel(reason);for(const v of this.ledgers()){for(const e of cancelAll(v.account,reason,this.now()))this.record(e,v);v.strategy.setups={};}for(const e of cancelAll(this.state.alert,reason,this.now()))this.record(e,{version:this.state.research.active,ledger:'ALERT_PLUS_60S'});}
  record(e,v){const ledger=v.ledger||(v.comparator?'CAMPAIGN_BASELINE':v.version===this.state.research.active?'ENGINE':'CANDIDATE');e={...e,version:e.plan?.version??e.policy_version??v.version,ledger};this.event(e);
    if(ledger==='ENGINE'){if(e.type==='SELECTED')this.state.counters.selected++;if(e.type==='SUPPRESSED')this.state.counters.suppressed++;if(e.type==='NOT_FILLED')this.state.counters.notFilled++;}
    if(e.type==='FILLED'&&ledger==='ENGINE')this.notice('RESULT',{...e,type:'PAPER_OPENED',ledger,plan:e.plan??findPosition(v.account,e.id).plan},['opened',ledger,e.id]);
    if(e.type==='CLOSED'){if(e.quality==='UNRESOLVED_GAP')this.state.counters.criticalIncidents=(this.state.counters.criticalIncidents||0)+1;if(ledger==='ENGINE'&&e.quality==='OBSERVED')this.state.counters.mature=(this.state.counters.mature||0)+1;v.fills=(v.fills||0)+1;if(v.strategy)v.strategy.cooldowns[(e.family||'A')+'LONG']=this.now()+4*M15;if(['ENGINE','ALERT_PLUS_60S'].includes(ledger))this.notice('RESULT',e,[ledger,e.id]);}
  }
  onMarket(){
    if(!this.state||this.repairing||this.now()-this.lastLease>30000)return;
    const now=this.now(),bad=freshness(this.feed.state,now,this.feed.metadata);
    if(bad){if(this.lastQuality!==bad){this.event({type:'DATA_INCIDENT',reason:bad,at:now});this.cancelPending(bad);this.gapAt??=now;}this.lastQuality=bad;return;}
    if(this.gapAt){this.repairing=true;void this.recover({gapStart:this.gapAt}).catch(()=>{});return;}
    this.lastQuality=null;
    if(this.state.frequency)for(const p of positions(this.state.frequency.account))this.learning?.track('FREQUENT_PAPER',p.plan.version,p,this.feed.state.quote);
    for(const p of positions(this.active().account))this.learning?.track('ENGINE',p.plan.version,p,this.feed.state.quote);
    this.frequency?.market();
    for(const v of this.ledgers())for(const e of step(v.account,this.feed.state,now))this.record(e,v);
    for(const e of step(this.state.alert,this.feed.state,now))this.record(e,{version:this.state.research.active,ledger:'ALERT_PLUS_60S'});
  }
  async recover({gapStart}){
    this.repairing=true;const now=this.now();if(freshness(this.feed.state,now,this.feed.metadata)){this.gapAt=gapStart||now;return;}const hasOpen=this.ledgers().some(v=>v.account.position||v.account.pending)||this.state.alert.position||this.state.alert.pending||this.state.frequency?.account.position||this.state.frequency?.account.pending;
    if(hasOpen){const response=await publicREST('OHLC',{pair:'XBTUSD',interval:'1'},this.feed.fetchImpl),bars=restBars(response,1,this.now(),{includeOpen:true});
      this.frequency?.recover(bars,Math.min(gapStart||now,this.state.last_checkpoint));
      for(const v of this.ledgers())for(const e of repairPosition(v.account,bars,this.feed.state,this.now(),Math.min(gapStart||now,this.state.last_checkpoint)))this.record(e,v);
      for(const e of repairPosition(this.state.alert,bars,this.feed.state,this.now(),Math.min(gapStart||now,this.state.last_checkpoint)))this.record(e,{version:this.state.research.active,ledger:'ALERT_PLUS_60S'});
    }
    if(this.state.frequency)this.state.frequency.lastCutoff=Math.floor(this.now()/60000)*60000;
    const trial=this.laboratory?.trial();if(trial)trial.frameCutoffs=Object.fromEntries(recipeComponents(trial.recipe).map(r=>[r.tf,Math.floor(this.now()/(r.tf*60000))*r.tf*60000]));
    this.state.last_frame_cutoff=Math.floor(this.now()/60000)*60000;
    this.gapAt=null;this.state.last_cutoff=Math.floor(this.now()/M15)*M15;this.repairing=false;
    this.event({type:'FEED_RECOVERED',at:this.now(),gapStart,bars:Object.fromEntries(Object.entries(this.feed.series).map(([k,b])=>[k,{n:b.length,last:b.at(-1)?.end,hash:hash(b)}]))});
    if(!this.state.technicalQueued){this.notice('TECHNICAL',{version:VERSION},'connection-v1');this.state.technicalQueued=true;}
  }
  async boundary(){
    const now=this.now(),cutoff=Math.floor(now/60000)*60000;
    const legacyDue=cutoff%M15===0&&cutoff>this.state.last_cutoff;
    if(this.evaluating||(!legacyDue&&cutoff<=(this.state.last_frame_cutoff??0))||now-cutoff<1500)return;
    this.evaluating=true;this.state.last_frame_cutoff=cutoff;if(legacyDue)this.state.last_cutoff=cutoff;
    try{
      if(now-cutoff>10000||this.repairing){this.event({type:'EVALUATION_SKIPPED',cutoff,at:now,reason:'LATE_OR_RECONCILING'});return;}
      const reconciled=await this.feed.reconcile({timeframes:[1,15,60,240].filter(tf=>cutoff%(tf*60000)===0)});const decision=this.now();
      if(this.state.timeframes)this.state.timeframes.series=Object.fromEntries([1,15,60,240].map(tf=>[tf,{last_closed_at:this.feed.series[tf]?.at(-1)?.end??null,bars:this.feed.series[tf]?.length??0,checked_at:decision}]));
      if(reconciled===false){this.event({type:'EVALUATION_SKIPPED',cutoff,at:decision,reason:'FEED_RECONCILING'});return;}
      if(decision-cutoff>10000){this.event({type:'EVALUATION_SKIPPED',cutoff,at:decision,reason:'BAR_RECONCILIATION_DEADLINE'});return;}
      for(const v of this.ledgers()){
        if(v.recipe){
          for(const recipe of [...recipeComponents(v.recipe)].sort((a,b)=>b.tf-a.tf)){
            const tf=recipe.tf*60000;if(cutoff%tf!==0)continue;
            const version=componentVersion(v.version,v.recipe,recipe.tf);
            const bad=freshness(this.feed.state,decision,this.feed.metadata);if(bad){this.event({type:'EVALUATION_SKIPPED',at:decision,cutoff,version,reason:bad,timeframe:recipe.tf});continue;}
            if(v.recipe.components){const day=iso(decision).slice(0,10);if(v.selectionDay!==day){v.selectionDay=day;v.daySelections=0;}if(v.daySelections>=12){this.event({type:'EVALUATION_SKIPPED',at:decision,cutoff,version,reason:'DAILY_SELECTION_LIMIT',timeframe:recipe.tf});continue;}}
            const r=laboratoryPlan(recipe,version,this.feed.series,this.feed.state,this.feed.metadata,cutoff,decision);
            this.event({type:'RULE_EVALUATION',at:decision,cutoff,version,reason:r.reason,timeframe:recipe.tf,feed:this.feed.snapshot()});
            if(!r.plan||this.state.research.paused||freshness(this.feed.state,decision,this.feed.metadata))continue;
            const p=this.learning.prepare(stampPlan(this.state,r.plan),'ENGINE',r.bars,this.feed.state.quote),e=select(v.account,p,this.feed.state.quote,this.feed.metadata,decision,{policy:laboratoryPolicy(p.version)});
            this.record(e,v);if(e.type==='SELECTED'){if(v.recipe.components)v.daySelections++;this.notice('SIGNAL',{plan:e.plan},p.id);}
          }
          continue;
        }
        if(!legacyDue)continue;
        const r=evaluate(v.strategy,this.feed.series,cutoff,decision,this.feed.metadata,{version:v.version,rules:v.rules});
        this.event({type:'RULE_EVALUATION',at:decision,cutoff,version:v.version,reason:r.reason,context:r.context,feed:this.feed.snapshot()});
        if(v.version===this.state.research.active&&!v.comparator)this.feed.context=r.context;
        for(const e of r.log){this.record(e,v);if(e.type==='CANDIDATE'&&v.version===this.state.research.active&&!v.comparator)this.state.counters.candidates++;}
        for(const order of orders(v.account)){const p=order.plan,bad=invalidate(p,this.feed.state,decision,r.context);if(bad){const e=cancel(v.account,bad,decision,p.id);if(e)this.record(e,v);}}
        const ranked=r.plans.map(p=>stampPlan(this.state,p));if(this.feed.state.quote)ranked.sort((a,b)=>Number(portfolioPolicy(b,this.feed.state.quote).risk)-Number(portfolioPolicy(a,this.feed.state.quote).risk)||a.id.localeCompare(b.id));
        for(const raw of ranked){
          const p=v.version===this.state.research.active&&!v.comparator?this.learning.prepare(raw,'ENGINE',this.feed.series['15'],this.feed.state.quote):raw;
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
    if(n.payload.account==='FREQUENT_PAPER')return;
    const p=n.payload.plan;if(this.state.delivered[n.id])return;this.state.delivered[n.id]=true;
    const response=n.receipt.response_at,now=this.now(),bad=freshness(this.feed.state,now,this.feed.metadata)||invalidate(p,this.feed.state,now,this.feed.context);
    // Do not install the order retrospectively if this receipt was recovered
    // after a restart, the trigger passed, or the response is already old.
    let e;if(bad||now-response>5000||!this.pending(p.id))e={type:'NOT_FILLED',id:p.id,reason:bad||'DELIVERY_RECOVERY_OR_ENGINE_TRIGGER_PASSED',at:now};
    else e=select(this.state.alert,p,this.feed.state.quote,this.feed.metadata,now,{latency:Math.max(0,response+POLICY.manualLatency-now),policy:p.family==='L'?laboratoryPolicy(p.version):POLICY});
    this.record(e,{version:p.version,ledger:'ALERT_PLUS_60S'});
  }
  daily(now){
    const day=iso(now).slice(0,10);if(this.state.last_daily===day)return;
    const previous=this.state.last_daily;this.state.last_daily=day;
    for(const v of this.ledgers()){
      const equity=Number(v.account.equity);v.days||={};if(previous)v.days[previous]=v.lastDayEquity?equity/v.lastDayEquity-1:equity/Number(POLICY.initialCash)-1;v.lastDayEquity=equity;
    }
    const mature=this.state.counters.mature||0;
    if(!this.state.laboratory)for(const e of monthlyReview(this.state.research,mature,now))this.event(e);
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
      this.onMarket();await this.boundary();
      if(!this.repairing){if(this.laboratory){await this.laboratory.boundary();this.frequency.activeVersion=this.state.laboratory.active;}else await this.frequency?.boundary();}
      this.daily(this.now());
      if(now-this.lastFeedAudit>=60000){this.event({type:'FEED_AUDIT',at:now,feed:this.feed.snapshot(),resource:process.resourceUsage(),memory:process.memoryUsage()});this.lastFeedAudit=now;}
      if(now-this.state.last_summary>=7*86400000){const summary={initialCash:this.state.capital.initialCash,...this.state.counters,from:iso(this.state.started_at),to:iso(now),engine:structuredClone(this.active().account),alert:structuredClone(this.state.alert),frequency:structuredClone(this.state.frequency?.account)};this.notice('SUMMARY',summary,Math.floor(now/(7*86400000)));this.state.last_summary=now;}
      if(now-this.lastFlush>=2000||this.notices.length)await this.flush();
      if(this.notifier&&now-(this.lastNotify||0)>=5000){this.lastNotify=now;const outcomes=await this.notifier.drain();for(const e of outcomes){this.event({type:'NOTICE_RESULT',...e,at:this.now()});if(e.status==='DELIVERED')this.state.counters.delivered++;else if(e.status==='UNKNOWN')this.state.counters.unknown++;else this.state.counters.rejected++;}
        if(outcomes.length){for(const n of await this.store.deliveredSince(now-60000))this.acceptDelivery(n);await this.flush();}}
    }finally{this.busy=false;}
  }
}
