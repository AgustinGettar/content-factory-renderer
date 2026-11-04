// One existing broker and ledger; entry-rule revision is audited independently.
import {OperationalSecondary as ExecutionRuntime} from './secondary-futures-engine.js';
import {SECONDARY_PROTOCOL as P,SECONDARY_VERSION,secondaryFresh} from './secondary-futures-math.js';
import {entryCandidates,installEntryRevision,ENTRY_REVISION} from './secondary-entry-context.js';
import {getExplorationPolicy,EXPLORATION_ENTRY_REVISION} from './secondary-exploration.js';
import {getProfitPolicy} from './secondary-profit-policy.js';
import {getCapitalAllocationPolicy,allocateCapitalCandidates,applyCapitalAllocationFunding} from './secondary-capital-allocation.js';
import {getSecondaryTimeframes,SECONDARY_TIMEFRAMES_VERSION} from './secondary-timeframes.js';
import {getRiskBudgetPolicy,prepareRiskCandidates} from './secondary-risk-budget.js';
import {classifySecondaryMarketRegime} from './secondary-market-regime.js';
import {observeSecondaryScalpingShadow} from './secondary-scalping-shadow.js';
export {SECONDARY_VERSION,SECONDARY_MODEL,SECONDARY_PROTOCOL,isSecondary,secondaryFresh,secondaryEstimate} from './secondary-futures-math.js';
export {SecondaryBroker,initializeSecondary,secondaryEconomics} from './secondary-futures-engine.js';
export const secondaryCandidates=entryCandidates;
function rejectionStage(decision){
 const reason=decision.reason??'';
 if(decision.facts?.entry_economics?.accepted===false||/ECONOMICS|NET_TARGET|STRUCTURAL_TARGET/.test(reason))return 'ECONOMICS';
 if(/LIQUIDITY/.test(reason))return 'LIQUIDITY';
 if(/CAPITAL|MARGIN|EXPOSURE|PORTFOLIO_CAPACITY|MINIMUM_SIZE/.test(reason))return 'CAPITAL';
 if(/RISK_BUDGET/.test(reason))return 'RISK';
 if(/CONFIRMATION|PYRAMID|MOVEMENT/.test(reason))return 'CONFIRMATION';
 if(decision.facts?.context_admission?.accepted===false)return 'CONTEXT';
 return 'TECHNICAL';
}
export class OperationalSecondary extends ExecutionRuntime {
 initialize(){super.initialize();installEntryRevision(this.engine.state,this.now(),e=>this.engine.event(e));return this;}
 start(){
  const frames=getSecondaryTimeframes(this.engine.state);
  if(frames){this.candleFrames=[...frames.policy.data_frames];for(const tf of this.candleFrames)this.series[tf]??=[];}
  return super.start();
 }
 selectCandidates(decisions,{cutoff,now,policy,profitPolicy,timeframe=5,contextTimeframe=15}){
  const b=this.broker,x=this.state,root=this.engine.state,allocationPolicy=getCapitalAllocationPolicy(root),riskPolicy=getRiskBudgetPolicy(root);
  const allocation=riskPolicy?prepareRiskCandidates(root,decisions,{quote:this.quote,meta:this.meta,now,preflight:b.preflight.bind(b)}):allocationPolicy?allocateCapitalCandidates(root,decisions,{quote:this.quote,meta:this.meta,now,preflight:b.preflight.bind(b)}):null;
  if(allocation){
   const receipt={at:now,cutoff,timeframe,eligible_count:allocation.eligible_count,preferred_id:allocation.preferred_id??null,receipts:allocation.receipts};
   x.last_allocation_batch=receipt;if(riskPolicy&&x.risk_budget)x.risk_budget.last_batch=receipt;else if(x.capital_allocation)x.capital_allocation.last_batch=receipt;
  }
  // The existing 33-feature entry model has a 5m/15m domain. Other frames stay
  // under deterministic rules until a separately validated model exists.
  const neural=timeframe===5&&contextTimeframe===15?this.engine.secondaryNeural:null;
  const context={series:this.series,quote:this.quote,meta:this.meta,cutoff,now,timeframe,contextTimeframe,explorationPolicy:policy,profitPolicy,allocationPolicy,riskPolicy,baseOrder:allocation?.ordered};
  const ordered=neural?neural.prepare(decisions,context):allocation?.ordered??[...decisions].sort((a,b)=>(b.plan?.economics.netRR??-1)-(a.plan?.economics.netRR??-1));
  for(const d of ordered){if(d.plan){
   b.f.counts.candidates++;
   if(d.capital_allocation_rejection){
    d.reason=d.capital_allocation_rejection;
    const stage=rejectionStage(d);
    b.record({type:'SECONDARY_ENTRY_REJECTED',id:d.plan.id,at:now,plan:d.plan,reason:d.reason,rejection_stage:stage,entry_economics:d.facts?.entry_economics,context_admission:d.facts?.context_admission,capital_allocation:d.facts?.capital_allocation,risk_allocation:d.facts?.risk_allocation});
   }else{d.reason=b.choose(d.plan,this.quote,this.meta,now);if(b.lastAdmission)d.facts={...d.facts,...b.lastAdmission};}
  }}
  neural?.finish(decisions,context);
 }
 tick(){
  const now=this.now(),x=this.state,b=this.broker,policy=getExplorationPolicy(this.engine.state),profitPolicy=getProfitPolicy(this.engine.state),revision=profitPolicy?.entryRevision??(policy?EXPLORATION_ENTRY_REVISION:ENTRY_REVISION),frames=getSecondaryTimeframes(this.engine.state);
  if(this.overflow||this.disconnected){b.gap(this.overflow?'EVENT_QUEUE_GAP':'FUTURES_DISCONNECTED');this.overflow=false;this.disconnected=false;}
  for(const e of this.queue.splice(0)){if(e.kind==='quote')this.processingQuote=e.q;b.market(this.processingQuote,e.t??null,this.rates,now);}
  // Exit supervision is always quote driven, before every entry clock.
  b.market(this.quote,null,this.rates,now);
  applyCapitalAllocationFunding(this.engine.state,now,b.topup.bind(b),{quote:this.quote});
  const dataFrames=frames?.policy.data_frames??[5,15];
  x.market={symbol:P.symbol,quote:this.quote,quote_at:this.quote?.event_at??null,last_refresh:this.lastRefresh??null,error:this.feedError??(!secondaryFresh(this.quote,now)?'FUTURES_DATA_NOT_FRESH':null),closed_at:Object.fromEntries(dataFrames.map(tf=>[tf,this.series[tf]?.at(-1)?.end??null])),
   ...(frames?{frame_errors:{...this.frameErrors},frame_refresh_at:{...this.frameRefreshAt},funding_history_error:this.fundingRefreshError??null}:{} )};
  if(frames)return this.evaluateFrames(frames,{now,policy,profitPolicy,revision});
  const cutoff=Math.floor(now/300000)*300000;if(cutoff<=x.last_cutoff||now-cutoff<2000)return;
  if(now-cutoff>30000){x.last_cutoff=cutoff;this.decision(cutoff,P.patterns.map(pattern=>({pattern,reason:'EVALUATION_WINDOW_MISSED',facts:{entry_revision:revision,last_blocker:x.evaluation_blocker??null}})));return;}
  const blocked=reason=>{
   x.evaluation_blocker=reason;const key=String(cutoff)+':'+reason;
   if(x.last_evaluation_blocker_key!==key){x.last_evaluation_blocker_key=key;this.decision(cutoff,P.patterns.map(pattern=>({pattern,reason,facts:{entry_revision:revision,technical_blocker:true,retry_until:cutoff+30000}})));}
  };
  const gate=!this.meta||now-this.meta.checked_at>3600000?'INSTRUMENT_METADATA_STALE':this.feedError??(!secondaryFresh(this.quote,now)?'FUTURES_DATA_NOT_FRESH':null);
  if(gate){blocked(gate);return;}
  const rate=this.rates[Math.floor(now/3600000)*3600000];if(!Number.isFinite(rate)){blocked('FUNDING_NOT_AVAILABLE');return;}
  const fundingRisk=Math.max(Math.abs(rate),Math.abs(this.predictedFunding??rate));
  const decisions=entryCandidates(this.series,this.quote,this.meta,cutoff,now,fundingRisk,policy,profitPolicy);
  if(decisions.some(d=>d.reason==='CONTEXT_NOT_SYNCHRONIZED')){blocked('CONTEXT_NOT_SYNCHRONIZED');return;}
  x.last_cutoff=cutoff;x.evaluation_blocker=null;
  this.selectCandidates(decisions,{cutoff,now,policy,profitPolicy});
  this.decision(cutoff,decisions);
 }
 evaluateFrames(profile,{now,policy,profitPolicy,revision}){
  // A consumed fast clock never consumes a slow clock. Correlated candidates
  // still reserve the same account/risk budget through the shared broker.
  for(const timeframe of profile.policy.simultaneous_order){
   const frame=profile.frames[timeframe],spec=profile.policy.frames[timeframe],contextTimeframe=spec.context_timeframe,duration=timeframe*60000,cutoff=Math.floor(now/duration)*duration;
   if(cutoff<=frame.last_cutoff||now-cutoff<profile.policy.evaluation_delay_ms)continue;
   const diagnostics=reason=>P.patterns.map(pattern=>({pattern,reason,facts:{entry_revision:revision,timeframe,context_timeframe:contextTimeframe,timeframe_version:profile.version,technical_blocker:true,last_blocker:frame.blocker??null,retry_until:cutoff+profile.policy.evaluation_window_ms}}));
   if(now-cutoff>profile.policy.evaluation_window_ms){
    const missed=Math.max(1,Math.floor((cutoff-frame.last_cutoff)/duration));
    frame.last_cutoff=cutoff;frame.counts.missed+=missed;frame.missed_candles_last=missed;
    this.frameDecision(frame,cutoff,diagnostics('EVALUATION_WINDOW_MISSED'),'MISSED');if(timeframe===5)this.state.last_cutoff=cutoff;continue;
   }
   // A restart can return inside the current evaluation window after older closes
   // were skipped. Account for those windows once without replaying signals or
   // consuming the current cutoff, which may still need a transient-data retry.
   const skipped=Math.max(0,Math.floor((cutoff-frame.last_cutoff)/duration)-1);
   if(skipped){
    const from=frame.last_cutoff+duration,to=cutoff-duration;
    frame.last_cutoff=to;frame.counts.missed+=skipped;frame.missed_candles_last=skipped;
    this.engine.event({type:'SECONDARY_FRAME_EVALUATIONS_MISSED',at:now,timeframe,from_cutoff:from,to_cutoff:to,count:skipped,reason:'EVALUATION_WINDOW_MISSED',history_replay:false,ledger:'FREQUENT_PAPER',realTrading:false});
   }
   const blocked=reason=>{
    frame.blocker=reason;const key=cutoff+':'+reason;
    if(frame.last_blocker_key!==key){frame.last_blocker_key=key;frame.blocked_cutoff=cutoff;frame.counts.transient_blocks++;
     this.frameDecision(frame,cutoff,diagnostics(reason),'TRANSIENT_BLOCKED');}
    if(timeframe===5)this.state.evaluation_blocker=reason;
   };
   const gate=!this.meta||now-this.meta.checked_at>3600000?'INSTRUMENT_METADATA_STALE':this.feedError??(!secondaryFresh(this.quote,now)?'FUTURES_DATA_NOT_FRESH':null);
   if(gate){blocked(gate);continue;}
   const frameGate=this.frameErrors?.[timeframe]??this.frameErrors?.[contextTimeframe];if(frameGate){blocked(frameGate);continue;}
   const rate=this.rates[Math.floor(now/3600000)*3600000];if(!Number.isFinite(rate)){blocked('FUNDING_NOT_AVAILABLE');continue;}
   const decisions=entryCandidates(this.series,this.quote,this.meta,cutoff,now,Math.max(Math.abs(rate),Math.abs(this.predictedFunding??rate)),policy,profitPolicy,{timeframe,contextTimeframe,timeframeVersion:SECONDARY_TIMEFRAMES_VERSION});
   const invalid=decisions.find(d=>['CONTEXT_NOT_SYNCHRONIZED','FUTURES_DATA_NOT_FRESH','FUNDING_NOT_AVAILABLE'].includes(d.reason));if(invalid){blocked(invalid.reason);continue;}
   const recovered=frame.blocked_cutoff===cutoff;
   if(recovered){frame.counts.recovered++;frame.last_recovered={at:now,cutoff,previous_blocker:frame.blocker};this.engine.event({type:'SECONDARY_FRAME_EVALUATION_RECOVERED',at:now,cutoff,timeframe,previous_blocker:frame.blocker,ledger:'FREQUENT_PAPER',realTrading:false});}
   // Read-only diagnostics: regime has no control over selection, risk or execution.
   frame.last_regime=classifySecondaryMarketRegime(this.series[timeframe],{timeframe,cutoff,now,quote:this.quote});
   if(timeframe===5){
    // Advisory only. Any research failure is isolated from the signed order flow.
    // Not an entry gate; never changes positions, financial policy or the broker.
    try{
     const observation=observeSecondaryScalpingShadow({
      series:this.series[5],quote:this.quote,regime:frame.last_regime,
      contextRegime:profile.frames[15]?.last_regime??null,
      fundingRate:Math.max(Math.abs(rate),Math.abs(this.predictedFunding??rate)),
      cutoff,now
     });
     frame.last_scalping_shadow=observation;
     this.engine.event({type:'SECONDARY_SCALPING_SHADOW_OBSERVATION',at:now,cutoff,timeframe:5,
      observation,ledger:'FREQUENT_PAPER',realTrading:false});
    }catch{
     frame.last_scalping_shadow={status:'UNAVAILABLE',reason:'RESEARCH_OBSERVER_ERROR',authority:'NONE',
      version:'secondary-scalping-shadow-1.0.0',cutoff,at:now};
    }
   }
   frame.last_cutoff=cutoff;frame.blocker=null;frame.counts.completed++;frame.last_completed_at=now;
   if(timeframe===5){this.state.last_cutoff=cutoff;this.state.evaluation_blocker=null;}
   this.selectCandidates(decisions,{cutoff,now,policy,profitPolicy,timeframe,contextTimeframe});
   this.frameDecision(frame,cutoff,decisions,recovered?'RECOVERED':'COMPLETE');
  }
 }
 frameDecision(frame,cutoff,decisions,status){
  const now=this.now(),complete=['COMPLETE','RECOVERED'].includes(status);
  for(const d of decisions){
   if(d.plan){const stats=this.broker.stats(d.plan);if(stats)stats.signals++;}
   const out={at:now,cutoff,pattern:d.pattern,reason:d.reason,timeframe:frame.timeframe,context_timeframe:frame.context_timeframe,criteria:d.facts??{},version:SECONDARY_VERSION,
    timeframe_version:SECONDARY_TIMEFRAMES_VERSION,evaluation_status:status,entry_revision:d.plan?.entry_revision??d.facts?.entry_revision??null,signal_id:d.plan?.id??null,execution_mode:d.plan?.execution_contract?.mode??null};
   frame.decisions[d.pattern]=out;frame.counts.pattern_checks++;frame.reasons[d.reason]=(frame.reasons[d.reason]??0)+1;
   if(complete&&d.reason==='ENTRY_PENDING')frame.counts.selected++;
   if(frame.timeframe===5)this.state.decisions[d.pattern]=out;
   this.state.counts.evaluations++;this.broker.f.counts.evaluations++;
   this.engine.event({type:'SECONDARY_PATTERN_EVALUATION',...out,ledger:'FREQUENT_PAPER',realTrading:false});
  }
  const selected=decisions.find(d=>d.reason==='ENTRY_PENDING')??decisions.find(d=>!d.reason.startsWith('WAIT_'))??decisions[0];
  frame.last_evaluation_at=now;frame.last_status=status;frame.last_result=selected?.reason??null;
  frame.last_decision=selected?{...frame.decisions[selected.pattern],all_patterns:decisions.map(d=>({pattern:d.pattern,reason:d.reason}))}:null;
  if(complete||!this.broker.f.lastDecision)this.broker.f.lastDecision=frame.last_decision;
 }
}
