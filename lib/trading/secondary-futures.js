// One existing broker and ledger; entry-rule revision is audited independently.
import {OperationalSecondary as ExecutionRuntime} from './secondary-futures-engine.js';
import {SECONDARY_PROTOCOL as P,secondaryFresh} from './secondary-futures-math.js';
import {entryCandidates,installEntryRevision,ENTRY_REVISION} from './secondary-entry-context.js';
import {getExplorationPolicy,EXPLORATION_ENTRY_REVISION} from './secondary-exploration.js';
export {SECONDARY_VERSION,SECONDARY_MODEL,SECONDARY_PROTOCOL,isSecondary,secondaryFresh,secondaryEstimate} from './secondary-futures-math.js';
export {SecondaryBroker,initializeSecondary,secondaryEconomics} from './secondary-futures-engine.js';
export const secondaryCandidates=entryCandidates;
export class OperationalSecondary extends ExecutionRuntime {
 initialize(){super.initialize();installEntryRevision(this.engine.state,this.now(),e=>this.engine.event(e));return this;}
 tick(){
  const now=this.now(),x=this.state,b=this.broker,policy=getExplorationPolicy(this.engine.state),revision=policy?EXPLORATION_ENTRY_REVISION:ENTRY_REVISION;
  if(this.overflow||this.disconnected){b.gap(this.overflow?'EVENT_QUEUE_GAP':'FUTURES_DISCONNECTED');this.overflow=false;this.disconnected=false;}
  for(const e of this.queue.splice(0)){if(e.kind==='quote')this.processingQuote=e.q;b.market(this.processingQuote,e.t??null,this.rates,now);}
  b.market(this.quote,null,this.rates,now);
  x.market={symbol:P.symbol,quote:this.quote,quote_at:this.quote?.event_at??null,last_refresh:this.lastRefresh??null,error:this.feedError??(!secondaryFresh(this.quote,now)?'FUTURES_DATA_NOT_FRESH':null),closed_at:Object.fromEntries([5,15].map(tf=>[tf,this.series[tf].at(-1)?.end??null]))};
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
  const decisions=entryCandidates(this.series,this.quote,this.meta,cutoff,now,fundingRisk,policy);
  if(decisions.some(d=>d.reason==='CONTEXT_NOT_SYNCHRONIZED')){blocked('CONTEXT_NOT_SYNCHRONIZED');return;}
  x.last_cutoff=cutoff;x.evaluation_blocker=null;
  for(const d of [...decisions].sort((a,b)=>(b.plan?.economics.netRR??-1)-(a.plan?.economics.netRR??-1))){if(d.plan){this.broker.f.counts.candidates++;d.reason=b.choose(d.plan,this.quote,this.meta,now);}}
  this.decision(cutoff,decisions);
 }
}
