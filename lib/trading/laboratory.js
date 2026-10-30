import {BOOST_VERSION,BOOST_PROTOCOL} from './secondary-boost.js';
import {EXIT_VERSION} from './paper-exits.js';
import {MAKER_SIZING_VERSION,MAKER_SIZING_PROTOCOL} from './maker-sizing.js';
import {CONTEXT_VERSION,CONTEXT_PROTOCOL,MAKER_ORDER,contextBars} from './context-profile.js';
import {ENTRY_VERSION,ENTRY_PROTOCOL} from './entry-profile.js';
import {MARGIN_VERSION,marginEconomics} from './margin.js';
import {applySecondaryRisk,secondaryRisk} from './secondary-risk.js';
import {TIMEFRAME_VERSION,MULTIFRAME_RECIPES,recipeComponents,componentVersion,recipeVersions} from './timeframes.js';
import {laboratoryEvidence} from './chart-evidence.js';
// Bounded, prospective PAPER research. Web content is evidence, never executable rules.
import Decimal from 'decimal.js';
import {D,POLICY,hash,ceilTick,floorTick,checkSeries,indicators,freshness} from './core.js';
import {select} from './simulator.js';
import {newStrategyState} from './strategies.js';
import {bootstrapDifference} from './research.js';
import {executionVersion,reserved,PORTFOLIO_PROTOCOL} from './portfolio.js';
export const LAB_VERSION='lumi-laboratory-1.0.0';
const DAY=86400000,HOUR=3600000;
export const SOURCES=Object.freeze([
 {id:'costs-2026',url:'https://arxiv.org/abs/2606.00060',title:'Bitcoin forecasting under transaction costs (2026)',evidence:'PREPRINT',lesson:'Measure net outcomes and turnover; published lower costs are not our costs.'},
 {id:'carver-video',url:'https://www.youtube.com/watch?v=vGhzvJbJzEc',title:'Rob Carver: three ways traders kill strategies (2021)',evidence:'EDUCATIONAL_INTERVIEW',lesson:'Limit parameters and trials; freeze before prospective validation.'},
 {id:'clenow-video',url:'https://www.youtube.com/watch?v=tdGGZd68bLw',title:'Andreas Clenow: trend following and risk',evidence:'EDUCATIONAL_INTERVIEW',lesson:'Trends and regimes vary; simulation is not execution evidence.'},
 {id:'fees',url:'https://www.kraken.com/features/fee-schedule',title:'Kraken spot fee schedule',evidence:'OFFICIAL',lesson:'Keep both-side fees, spread and slippage in every outcome.'}
]);
// Original hypotheses inspired by research, NOT claimed replicas of a trader's returns.
export const RECIPES=Object.freeze([
 {id:'trend-breakout-h1',title:'Ruptura de 20 horas con tendencia',tf:60,kind:'BREAKOUT',lookback:20,fast:20,slow:50,stopATR:2,targetATR:6,holdingMs:48*HOUR,minNetRR:'1.5'},
 {id:'trend-pullback-h1',title:'Retroceso y recuperación en tendencia',tf:60,kind:'PULLBACK',lookback:20,fast:20,slow:50,stopATR:2,targetATR:6,holdingMs:48*HOUR,minNetRR:'1.5'},
 {id:'trend-breakout-h4',title:'Ruptura de 20 velas de cuatro horas',tf:240,kind:'BREAKOUT',lookback:20,fast:20,slow:50,stopATR:2,targetATR:6,holdingMs:7*DAY,minNetRR:'1.5'}
]);
export const LAB_PROTOCOL=Object.freeze({version:LAB_VERSION,maxTrials:3,minTraining:100,minValidation:200,minCalendarDays:90,purgeMs:DAY,maxTrialDays:365,alpha:.05,minNetDailyImprovement:0,maxDrawdown:.05,maxIncompleteFraction:.05,stressFeeMultiplier:1.5,stressExtraSlippageBps:5,refillBelow:'1',refillTo:'100',risk:POLICY.risk,dailyLoss:POLICY.dailyLoss,realTrading:false,recipes:RECIPES,sources:SOURCES});
export const MULTIFRAME_PROTOCOL=Object.freeze({...LAB_PROTOCOL,version:TIMEFRAME_VERSION,maxTrials:2,maxHypotheses:5,recipes:MULTIFRAME_RECIPES,minTrainingPerFrame:25,minValidationPerFrame:50,promotionScope:'WHOLE_SHARED_PORTFOLIO'});
export const MARGIN_RECIPES=Object.freeze(MULTIFRAME_RECIPES.map(r=>({...r,id:r.id+'-margin',title:r.title+' · compra/venta',margin:true,components:r.components.map(c=>({...c,id:c.id+'-margin',margin:true,title:c.title+' · compra/venta'}))})));
export const MARGIN_LAB_PROTOCOL=Object.freeze({...MULTIFRAME_PROTOCOL,version:MARGIN_VERSION,recipes:MARGIN_RECIPES,maxHypotheses:7});
export const AGILE_RECIPES=Object.freeze([ {...MARGIN_RECIPES[0],id:'agile-four-frames',title:'Ruptura de 5 velas o retroceso · 1 m / 15 m / 1 h / 4 h',entryRevision:ENTRY_VERSION,components:MARGIN_RECIPES[0].components.map(r=>({...r,id:'agile-'+r.tf+'m',title:'Ruptura de 5 velas o retroceso · '+r.tf+' min',...Object.fromEntries(['lookback','fast','slow','kind','minNetRR'].map(k=>[k,ENTRY_PROTOCOL[k]]))}))} ]);
export const AGILE_LAB_PROTOCOL=Object.freeze({...MARGIN_LAB_PROTOCOL,version:ENTRY_VERSION,recipes:AGILE_RECIPES,maxTrials:1,maxHypotheses:10});
export const CONTEXT_RECIPES=Object.freeze([{...AGILE_RECIPES[0],id:'context-maker-four-frames',title:'Entrada ágil maker con contexto de plazos mayores',entryRevision:CONTEXT_VERSION,components:AGILE_RECIPES[0].components.map(r=>({...r,id:'context-maker-'+r.tf+'m',title:'Patrón '+r.tf+' min · maker con contexto',order:MAKER_ORDER,stopTf:CONTEXT_PROTOCOL.contexts[r.tf].stop,targetTf:CONTEXT_PROTOCOL.contexts[r.tf].target,holdingMs:CONTEXT_PROTOCOL.contexts[r.tf].holdingMs}))}]);
export const CONTEXT_LAB_PROTOCOL=Object.freeze({...AGILE_LAB_PROTOCOL,version:CONTEXT_VERSION,recipes:CONTEXT_RECIPES,maxHypotheses:11});
export const MAKER_SIZING_RECIPES=Object.freeze(CONTEXT_RECIPES.map(r=>({...r,sizingRevision:MAKER_SIZING_VERSION})));
export const MAKER_SIZING_LAB_PROTOCOL=Object.freeze({...CONTEXT_LAB_PROTOCOL,version:MAKER_SIZING_VERSION,recipes:MAKER_SIZING_RECIPES,maxHypotheses:12});
export const NET_EXIT_LAB_PROTOCOL=Object.freeze({...MAKER_SIZING_LAB_PROTOCOL,version:EXIT_VERSION,maxHypotheses:13,recipes:MAKER_SIZING_RECIPES.map(r=>({...r,exitRevision:EXIT_VERSION,components:r.components.map(c=>({...c,exitRevision:EXIT_VERSION}))}))});
export const BOOST_LAB_PROTOCOL=Object.freeze({...NET_EXIT_LAB_PROTOCOL,version:BOOST_VERSION,maxHypotheses:14,risk:BOOST_PROTOCOL.risk,dailyLoss:BOOST_PROTOCOL.dailyLoss});
export const laboratoryPolicy=version=>({...POLICY,version,minNetRR:'1.5'});
export function initializeLaboratory(s,now){
 if(s.laboratory){if(![hash(LAB_PROTOCOL),hash(MULTIFRAME_PROTOCOL),hash(MARGIN_LAB_PROTOCOL),hash(AGILE_LAB_PROTOCOL),hash(CONTEXT_LAB_PROTOCOL),hash(MAKER_SIZING_LAB_PROTOCOL),hash(NET_EXIT_LAB_PROTOCOL),hash(BOOST_LAB_PROTOCOL)].includes(s.laboratory.protocol_hash))throw Error('LABORATORY_PROTOCOL_MISMATCH');return null;}
 s.laboratory={version:LAB_VERSION,protocol_hash:hash(LAB_PROTOCOL),protocol:structuredClone(LAB_PROTOCOL),started_at:now,status:'WAITING_FLAT',trials:[],active:null,primary:null,funding:{initial:'100',added:'0',count:0,history:[],peak:'100',maxDrawdown:'0'},lastDecision:null};
 return {type:'LABORATORY_ENABLED',at:now,version:LAB_VERSION,realTrading:false};
}
export function refillSecondary(s,now){
 const l=s.laboratory,a=s.frequency.account;
 // Cash alone is not balance when BTC is open. Never refill a reserved ledger.
 if(reserved(a)||!D(a.cash).eq(a.equity)||!D(a.equity).lt(l.protocol.refillBelow))return null;
 const refillTo=secondaryRisk(a)?.targetEquity??l.protocol.refillTo,before=a.equity,amount=D(refillTo).minus(before).toString();
 const event={type:'LABORATORY_REFILLED',id:hash([LAB_VERSION,l.funding.count,now,before]),at:now,before,amount,after:refillTo,ledger:'FREQUENT_PAPER',realTrading:false};
 l.funding.added=D(l.funding.added).plus(amount).toString();l.funding.count++;l.funding.history.push(event);l.funding.history=l.funding.history.slice(-100);
 a.cash=a.equity=refillTo;a.peak=a.dayStart=a.equity;a.halted=false;
 // Closed P&L, costs, loss streaks, history and lifetime maximum drawdown survive.
 return event;
}
const ema=(bars,n)=>{let v=bars.slice(0,n).reduce((s,b)=>s+ +b.close,0)/n;for(const b of bars.slice(n))v=2/(n+1)*b.close+(1-2/(n+1))*v;return v;};
export function laboratoryPlan(recipe,version,series,feed,meta,cutoff,now){
 const tf=recipe.tf*60000,bars=(series[String(recipe.tf)]??[]).filter(b=>b.end<=cutoff&&b.available_at<=now).slice(-120),bad=checkSeries(bars,tf,60);
 if(bad||bars.at(-1)?.end!==cutoff)return {reason:bad||'LAB_BARS_NOT_SYNCHRONIZED'};
 const b=bars.at(-1),prior=bars.slice(0,-1),fast=ema(bars,recipe.fast),slow=ema(bars,recipe.slow),atr=indicators(bars).at(-1).atr;
 const direction=recipe.margin&&fast<slow&&+b.close<slow?'SHORT':'LONG',short=direction==='SHORT';
 const trend=short?fast<slow&&+b.close<slow:fast>slow&&+b.close>slow;
 const bound=short?Math.min(...prior.slice(-recipe.lookback).map(x=>+x.low)):Math.max(...prior.slice(-recipe.lookback).map(x=>+x.high));
 const breakout=short?+b.close<bound:+b.close>bound;
 const pullback=short?+prior.at(-1).high>=ema(prior,recipe.fast)&&+b.close<fast&&+b.close<+b.open:+prior.at(-1).low<=ema(prior,recipe.fast)&&+b.close>fast&&+b.close>+b.open;
 const trigger=recipe.kind==='BREAKOUT'?breakout:recipe.kind==='BREAKOUT_OR_PULLBACK'?breakout||pullback:pullback;
 const criteria={trend,trigger,breakout,pullback,lookback:recipe.lookback,fastPeriod:recipe.fast,slowPeriod:recipe.slow,kind:recipe.kind,costRoom:null,direction,close:+b.close,fast,slow,atr,bound,minNetRR:+recipe.minNetRR,netRR:null};
 if(!trend||!trigger||!(atr>0))return {reason:recipe.margin?(!trend?'LAB_WAIT_TREND':recipe.kind==='BREAKOUT'?'LAB_WAIT_BREAKOUT':recipe.kind==='BREAKOUT_OR_PULLBACK'?'LAB_WAIT_ENTRY_PATTERN':'LAB_WAIT_PULLBACK'):'LAB_WAIT_PATTERN',criteria};
 const context=recipe.order===MAKER_ORDER?contextBars(recipe,series,cutoff,now):null;
 if(context?.reason)return {reason:context.reason,criteria};
 const stopAtr=context?.[recipe.stopTf]?.atr??atr,targetAtr=context?.[recipe.targetTf]?.atr??atr;
 if(context)Object.assign(criteria,{order:MAKER_ORDER,stopTf:recipe.stopTf,targetTf:recipe.targetTf,stopAtr,targetAtr,holdingMs:recipe.holdingMs,makerFee:CONTEXT_PROTOCOL.makerFee,takerFee:CONTEXT_PROTOCOL.takerFee});
 const entry=context?(short?ceilTick(feed.quote.ask,meta.tick_size):floorTick(feed.quote.bid,meta.tick_size)):short?floorTick(Decimal.min(+b.low,+feed.quote.bid).minus(meta.tick_size),meta.tick_size):ceilTick(Decimal.max(+b.high,+feed.quote.ask).plus(meta.tick_size),meta.tick_size);
 const limit=context?entry:short?floorTick(D(entry).mul('.9995'),meta.tick_size):ceilTick(D(entry).mul('1.0005'),meta.tick_size);
 const stop=short?ceilTick(D(entry).plus(D(stopAtr).mul(recipe.stopATR)),meta.tick_size):floorTick(D(entry).minus(D(stopAtr).mul(recipe.stopATR)),meta.tick_size);
 const target=short?floorTick(D(entry).minus(D(targetAtr).mul(recipe.targetATR)),meta.tick_size):ceilTick(D(entry).plus(D(targetAtr).mul(recipe.targetATR)),meta.tick_size);
 if(Decimal.min(stop,target,entry).lte(0))return {reason:'STOP_DISTANCE',criteria};
 const costs=marginEconomics({direction,limit,stop,target,holding_ms:recipe.holdingMs,order:recipe.order},feed.quote,context?{...POLICY,makerFee:CONTEXT_PROTOCOL.makerFee}:POLICY,short);
 criteria.netRR=costs.rr.toNumber();criteria.targetMovePct=D(target).minus(limit).abs().div(limit).mul(100).toNumber();criteria.targetCostsPct=costs.fees(costs.target).div(limit).mul(100).toNumber();
 criteria.costRoom=costs.loss.gt(0)&&costs.gain.gt(0)&&costs.rr.gte(recipe.minNetRR);
 if(!criteria.costRoom)return {reason:'LAB_COSTS_TOO_HIGH',criteria};
 const plan={version,...(recipe.exitRevision?{exit_management:recipe.exitRevision}:{}),instrument:recipe.margin?'PAPER:KRAKEN:BTC/USD:MARGIN_MODEL':POLICY.instrument,...(recipe.margin?{execution_model:MARGIN_VERSION}:{}),family:'L',timeframe:recipe.tf,direction,confirmed_at:cutoff,decision_at:now,entry,limit,stop,target,atr1:atr,H:recipe.holdingMs/900000,holding_ms:recipe.holdingMs,expires_at:now+120000,trigger_source:'LAST',order:recipe.order??'SIMULATED_STOP_LIMIT',setup:{family:'L'},recipe:recipe.id,recipe_title:recipe.title,criteria:['CLOSED_'+recipe.tf+'M','EMA'+recipe.fast+(short?'_BELOW_EMA':'_ABOVE_EMA')+recipe.slow,recipe.kind,'NATURAL_ATR_TARGET','NET_RR_'+recipe.minNetRR.replace('.','_')],input_hash:hash(context?{bars,context}:bars),...(context?{context:{stopTf:recipe.stopTf,targetTf:recipe.targetTf,stopAtr,targetAtr,holdingMs:recipe.holdingMs},fill_model:CONTEXT_PROTOCOL.fillModel}:{}),experiment:true};
 plan.evidence=laboratoryEvidence(plan,recipe,bars,indicators(bars),{fast,slow,atr,trend,trigger,costRoom:criteria.costRoom,context});
 plan.id=hash([version,cutoff]);plan.hash=hash(plan);return {reason:'CANDIDATES',criteria,plan,bars};
}
export function promotionReport(t,now){
 const g=t.leverageProfile===BOOST_VERSION?BOOST_LAB_PROTOCOL:t.recipe?.sizingRevision===MAKER_SIZING_VERSION?MAKER_SIZING_LAB_PROTOCOL:t.recipe?.entryRevision===CONTEXT_VERSION?CONTEXT_LAB_PROTOCOL:t.recipe?.entryRevision===ENTRY_VERSION?AGILE_LAB_PROTOCOL:t.recipe?.margin?MARGIN_LAB_PROTOCOL:t.recipe?.components?MULTIFRAME_PROTOCOL:LAB_PROTOCOL,v=t.validation;
 if(t.recipe?.components&&recipeComponents(t.recipe).some(r=>(t.frames?.[r.tf]?.training??0)<g.minTrainingPerFrame||(t.frames?.[r.tf]?.validation??0)<g.minValidationPerFrame))return {status:'COLLECTING',reason:'MORE_FUTURE_OUTCOMES_PER_FRAME',n:v?.clean??0,days:v?.days.length??0};
 if(v?.interventions)return {status:'REJECTED',reason:'MANUAL_INTERVENTION_IN_VALIDATION',n:v.clean,days:v.days.length};
 if(!v||v.clean<g.minValidation||v.days.length<g.minCalendarDays)return {status:'COLLECTING',reason:'MORE_FUTURE_OUTCOMES',n:v?.clean??0,days:v?.days.length??0};
 const days=v.days,today=new Date(now).toISOString().slice(0,10),complete=t.training>=g.minTraining&&days.every((d,i)=>d.valid&&d.day<today&&Date.parse(d.day)>=Math.ceil(v.after/DAY)*DAY&&Number.isFinite(d.secondary)&&Number.isFinite(d.primary)&&(!i||Date.parse(d.day)-Date.parse(days[i-1].day)===DAY));
 const own=days.map(d=>d.secondary),base=days.map(d=>d.primary),alpha=g.alpha/((g.maxHypotheses??g.maxTrials)*2);
 const cashCI=bootstrapDifference(Array(days.length).fill(0),own,{alpha}),primaryCI=bootstrapDifference(base,own,{alpha});
 const stress=v.net-v.fees*(g.stressFeeMultiplier-1)-v.notional*g.stressExtraSlippageBps/10000;
 const pass=complete&&cashCI?.lower>0&&primaryCI?.lower>g.minNetDailyImprovement&&v.net>0&&stress>0&&v.drawdown<=g.maxDrawdown&&v.unresolved===0&&v.incomplete/Math.max(1,v.closed)<=g.maxIncompleteFraction&&!t.refilled;
 return {status:pass?(t.riskProfile?'REQUIRES_PRIMARY_RISK_VALIDATION':'ELIGIBLE_PAPER'):'REJECTED',reason:pass?(t.riskProfile?'SECONDARY_RISK_DIFFERS_FROM_PRIMARY':'PROSPECTIVE_NET_GATES'):'NO_CONFIRMED_NET_ADVANTAGE',at:now,n:v.clean,closed:v.closed,days:days.length,net:v.net,stressNet:stress,drawdown:v.drawdown,cashCI,primaryCI,complete,realTrading:false};
}
export class TradingLaboratory{
 constructor({state,feed,now,event,notice,frequency,learning}){Object.assign(this,{state,feed,now,event,notice,frequency,learning});}
 trial(){return this.state.laboratory.trials.find(t=>t.version===this.state.laboratory.active);}
 primary(){return this.state.research.versions[this.state.research.active];}
 observe(e){
  if(e.ledger!=='FREQUENT_PAPER')return;
  const active=this.trial(),t=[...this.state.laboratory.trials,...(this.state.laboratory.execution_archives??[]).flatMap(x=>x.trials??[])].find(t=>recipeVersions(t.version,t.recipe).includes(e.version));
  if(!t)return;
  const frame=recipeComponents(t.recipe).find(r=>componentVersion(t.version,t.recipe,r.tf)===e.version)?.tf;
  t.frames??={};const f=t.frames[frame]??={training:0,validation:0,closed:0,net:0};
  if(e.type==='SELECTED')t.pending[e.id]={at:e.plan.decision_at,eligible:Boolean(e.plan.study?.features)};
  if(e.type==='NOT_FILLED')delete t.pending[e.id];
  if(e.type!=='CLOSED'||t.seen.includes(e.id))return;
  const p=t.pending[e.id];delete t.pending[e.id];t.seen.push(e.id);t.seen=t.seen.slice(-2000);t.closed++;t.net+=+e.pnl;f.closed++;f.net+=+e.pnl;
  // Late settlements belong to their archived round, never to the new experiment.
  if(t!==active)return;
  const clean=e.quality==='OBSERVED'&&!e.management_override&&p?.eligible;
  if(e.management_override){t.interventions=(t.interventions??0)+1;if(t.validation)t.validation.interventions=(t.validation.interventions??0)+1;return;}
  if(!t.validation){if(clean){t.training++;f.training++;}if(t.training>=this.state.laboratory.protocol.minTraining&&(!t.recipe.components||recipeComponents(t.recipe).every(r=>(t.frames[r.tf]?.training??0)>=MULTIFRAME_PROTOCOL.minTrainingPerFrame)))t.validation={after:this.now()+DAY,awaitingFlat:Boolean(this.state.portfolio),clean:0,closed:0,incomplete:0,unresolved:0,net:0,fees:0,notional:0,drawdown:0,days:[],last:null};}
  else if(!t.validation.awaitingFlat&&p?.at>=t.validation.after){const v=t.validation;v.closed++;if(clean){v.clean++;f.validation++;}else v.incomplete++;if(e.quality==='UNRESOLVED_GAP')v.unresolved++;v.net+=+e.pnl;v.fees+=+e.fees;v.notional+=(+e.entry+ +e.price)* +e.qty;}
 }
 maintain(){
  const now=this.now(),s=this.state,l=s.laboratory,a=s.frequency.account;let t=this.trial(),prospectiveStart=false;
  const changed=applySecondaryRisk(s,now);if(changed){this.event(changed);this.notice('VERSION',changed,changed.id);}
  const adjusted=D(a.equity).minus(l.funding.added);if(adjusted.gt(l.funding.peak))l.funding.peak=adjusted.toString();const lifetimeDD=D(l.funding.peak).minus(adjusted).div(l.funding.peak);if(lifetimeDD.gt(l.funding.maxDrawdown))l.funding.maxDrawdown=lifetimeDD.toString();
  const refill=refillSecondary(s,now);if(refill){if(t)t.refilled=true;this.event(refill);this.notice('VERSION',refill,refill.id);}
  const flat=!reserved(a);
  if(s.timeframes&&![TIMEFRAME_VERSION,MARGIN_VERSION].includes(l.version)){
   if(!flat){s.timeframes.status='WAITING_FLAT';return;}
   l.execution_archives??=[];l.execution_archives.push({at:now,revision:l.executionRevision,version:l.version,protocol:l.protocol,protocol_hash:l.protocol_hash,trials:l.trials,active:l.active,reason:'USER_REQUESTED_FOUR_TIMEFRAMES'});
   l.version=TIMEFRAME_VERSION;l.protocol=structuredClone(MULTIFRAME_PROTOCOL);l.protocol_hash=hash(MULTIFRAME_PROTOCOL);l.trials=[];l.active=null;l.status='WAITING_FLAT';l.lastDecision=null;l.executionRevision=s.portfolio?.version;t=null;
   s.timeframes.status='ACTIVE';s.timeframes.activated_at=now;
   const e={type:'TIMEFRAMES_ENABLED',at:now,frames:s.timeframes.frames,version:TIMEFRAME_VERSION,realTrading:false};this.event(e);this.notice('VERSION',e,TIMEFRAME_VERSION);
  }
  if(s.margin&&l.version!==MARGIN_VERSION){
   if(!flat){s.margin.status='WAITING_FLAT';return;}
   l.execution_archives??=[];l.execution_archives.push({at:now,version:l.version,protocol:l.protocol,protocol_hash:l.protocol_hash,trials:l.trials,active:l.active,reason:'USER_REQUESTED_AUTO_PAPER_MARGIN'});
   l.version=MARGIN_VERSION;l.protocol=structuredClone(MARGIN_LAB_PROTOCOL);l.protocol_hash=hash(MARGIN_LAB_PROTOCOL);l.trials=[];l.active=null;l.status='WAITING_FLAT';l.lastDecision=null;l.executionRevision=s.portfolio?.version;t=null;
   s.margin.status='ACTIVE';s.margin.activated_at=now;
   const e={type:'MARGIN_ENABLED',at:now,version:MARGIN_VERSION,maxLeverage:3,realTrading:false};this.event(e);this.notice('VERSION',e,MARGIN_VERSION);
  }
  // A risk/execution change starts a new prospective round only once old trades
  // have closed. Preserve the previous trials and every financial outcome.
  if(s.portfolio&&l.executionRevision!==s.portfolio.version){
   if(!flat)return;
   l.execution_archives??=[];if(l.trials.length)l.execution_archives.push({at:now,revision:l.executionRevision??'SINGLE_POSITION',trials:l.trials,active:l.active});
   l.trials=[];l.active=null;l.status='WAITING_FLAT';l.executionRevision=s.portfolio.version;t=null;
  }
  if(a.riskProfile&&l.secondaryRiskRevision!==a.riskProfile.version){
   if(!flat)return;
   l.execution_archives??=[];l.execution_archives.push({at:now,version:l.version,protocol:l.protocol,protocol_hash:l.protocol_hash,trials:l.trials,active:l.active,reason:'USER_SECONDARY_CAPITAL_AND_RISK_CHANGE'});
   l.trials=[];l.active=null;l.status='WAITING_FLAT';l.lastDecision=null;l.secondaryRiskRevision=a.riskProfile.version;t=null;
  }
  if(s.entryProfile?.status==='WAITING_FLAT'){
   if(!flat||s.secondaryRisk?.status!=='ACTIVE'||s.margin?.status!=='ACTIVE')return;
   l.execution_archives??=[];l.execution_archives.push({at:now,version:l.version,protocol:l.protocol,protocol_hash:l.protocol_hash,trials:l.trials,active:l.active,reason:'USER_REQUESTED_AGILE_ENTRY'});
   l.protocol=structuredClone(AGILE_LAB_PROTOCOL);l.protocol_hash=hash(AGILE_LAB_PROTOCOL);l.trials=[];l.active=null;l.status='WAITING_FLAT';l.lastDecision=null;t=null;
   a.entryProfile={version:ENTRY_VERSION,protocol_hash:hash(ENTRY_PROTOCOL),activated_at:now};
   Object.assign(s.entryProfile,{status:'ACTIVE',activated_at:now});
   const e={type:'ENTRY_PROFILE_ENABLED',id:hash([ENTRY_VERSION,'activation']),at:now,version:ENTRY_VERSION,realTrading:false};this.event(e);this.notice('VERSION',e,e.id);
  }
  if(s.contextProfile?.status==='WAITING_FLAT'){
   if(!flat||s.entryProfile?.status!=='ACTIVE')return;
   l.execution_archives??=[];l.execution_archives.push({at:now,version:l.version,protocol:l.protocol,protocol_hash:l.protocol_hash,trials:l.trials,active:l.active,reason:'USER_REQUESTED_CONTEXT_MAKER'});
   l.protocol=structuredClone(CONTEXT_LAB_PROTOCOL);l.protocol_hash=hash(CONTEXT_LAB_PROTOCOL);l.trials=[];l.active=null;l.status='WAITING_FLAT';l.lastDecision=null;t=null;
   a.contextProfile={version:CONTEXT_VERSION,protocol_hash:hash(CONTEXT_PROTOCOL),activated_at:now};
   Object.assign(s.contextProfile,{status:'ACTIVE',activated_at:now});
   const e={type:'CONTEXT_PROFILE_ENABLED',id:hash([CONTEXT_VERSION,'activation']),at:now,version:CONTEXT_VERSION,realTrading:false};this.event(e);this.notice('VERSION',e,e.id);
  }
  if(s.leverageProfile?.status==='REQUESTED'){
   if(s.contextProfile?.status!=='ACTIVE'||!s.makerSizing||!s.exitManagement)throw Error('SECONDARY_BOOST_PREREQUISITES_CHANGED');
   // New risk applies only to future plans. Old positions/orders retain their
   // exact contracts and remain included in shared cash, risk and exposure caps.
   l.execution_archives??=[];l.execution_archives.push({at:now,version:l.version,protocol:l.protocol,protocol_hash:l.protocol_hash,trials:l.trials,active:l.active,reason:'USER_REQUESTED_PROSPECTIVE_LEVERAGE'});
   l.protocol=structuredClone(BOOST_LAB_PROTOCOL);l.protocol_hash=hash(BOOST_LAB_PROTOCOL);l.trials=[];l.active=null;l.status='WAITING_FLAT';l.lastDecision=null;t=null;prospectiveStart=true;
   a.makerSizingProfile={version:MAKER_SIZING_VERSION,protocol_hash:hash(MAKER_SIZING_PROTOCOL),activated_at:s.makerSizing.activated_at??now};
   Object.assign(s.makerSizing,{status:'ACTIVE',activated_at:s.makerSizing.activated_at??now});
   Object.assign(s.exitManagement,{status:'ACTIVE',activated_at:s.exitManagement.activated_at??now});
   a.leverageProfile={version:BOOST_VERSION,protocol_hash:hash(BOOST_PROTOCOL),activated_at:now};
   Object.assign(s.leverageProfile,{status:'ACTIVE',activated_at:now});
   const e={type:'SECONDARY_BOOST_ENABLED',id:hash([BOOST_VERSION,'activation']),at:now,version:BOOST_VERSION,realTrading:false};this.event(e);this.notice('VERSION',e,e.id);
  }
  if(s.makerSizing?.status==='WAITING_FLAT'){
   if(!flat||s.contextProfile?.status!=='ACTIVE')return;
   l.execution_archives??=[];l.execution_archives.push({at:now,version:l.version,protocol:l.protocol,protocol_hash:l.protocol_hash,trials:l.trials,active:l.active,reason:'MAKER_PASSIVE_SIZING_CORRECTION'});
   l.protocol=structuredClone(MAKER_SIZING_LAB_PROTOCOL);l.protocol_hash=hash(MAKER_SIZING_LAB_PROTOCOL);l.trials=[];l.active=null;l.status='WAITING_FLAT';l.lastDecision=null;t=null;
   a.makerSizingProfile={version:MAKER_SIZING_VERSION,protocol_hash:hash(MAKER_SIZING_PROTOCOL),activated_at:now};
   Object.assign(s.makerSizing,{status:'ACTIVE',activated_at:now});
   const e={type:'MAKER_SIZING_ENABLED',id:hash([MAKER_SIZING_VERSION,'activation']),at:now,version:MAKER_SIZING_VERSION,realTrading:false};this.event(e);this.notice('VERSION',e,e.id);
  }
  if(s.exitManagement?.status==='WAITING_FLAT'){
   if(!flat||s.makerSizing?.status!=='ACTIVE')return;
   l.execution_archives??=[];l.execution_archives.push({at:now,version:l.version,protocol:l.protocol,protocol_hash:l.protocol_hash,trials:l.trials,active:l.active,reason:'USER_REQUESTED_NET_EXIT'});
   l.protocol=structuredClone(NET_EXIT_LAB_PROTOCOL);l.protocol_hash=hash(NET_EXIT_LAB_PROTOCOL);l.trials=[];l.active=null;l.status='WAITING_FLAT';l.lastDecision=null;t=null;
   Object.assign(s.exitManagement,{status:'ACTIVE',activated_at:now});
  }
  if(t&&['TRAINING','VALIDATING'].includes(t.status)){
   const dd=1-Number(a.equity)/t.peak;t.peak=Math.max(t.peak,+a.equity);t.drawdown=Math.max(t.drawdown,dd);
   if(t.validation?.awaitingFlat&&flat){t.validation.awaitingFlat=false;t.validation.after=now+DAY;}
   if(t.validation&&!t.validation.awaitingFlat&&now>=t.validation.after){
    t.status='VALIDATING';const v=t.validation,day=new Date(now).toISOString().slice(0,10),primary=+this.primary().account.equity,validMarket=!freshness(this.feed.state,now,this.feed.metadata);
    if(!v.last){v.last={day,at:now,secondary:+a.equity,primary,full:now%DAY<300000,valid:validMarket};v.peak=+a.equity;}
    if(now-v.last.at>=300000||!validMarket)v.last.valid=false;
    if(v.last.day!==day){if(v.last.full)v.days.push({day:v.last.day,secondary:+a.equity/v.last.secondary-1,primary:primary/v.last.primary-1,valid:v.last.valid});v.last={day,at:now,secondary:+a.equity,primary,full:now%DAY<300000,valid:validMarket};}
    else v.last.at=now;
    v.peak=Math.max(v.peak,+a.equity);v.drawdown=Math.max(v.drawdown,1-Number(a.equity)/v.peak);
    // One economic decision per registered recipe; never repeatedly peek at p-values.
    if(flat&&!t.report&&v.clean>=l.protocol.minValidation&&v.days.length>=l.protocol.minCalendarDays){const report=promotionReport(t,now);if(report.status!=='COLLECTING'){t.report=report;t.status=t.report.status;this.event({type:'LABORATORY_REVIEW',at:now,version:t.version,report:t.report});}}
   }
   if(flat&&(a.halted||t.drawdown>=l.protocol.maxDrawdown||now-t.started_at>l.protocol.maxTrialDays*DAY||t.refilled)){t.status='REJECTED';t.report??={status:'REJECTED',reason:t.refilled?'REFILL_OCCURRED':a.halted?'RISK_LIMIT':'TRIAL_LIMIT',at:now};this.event({type:'LABORATORY_REVIEW',at:now,version:t.version,report:t.report});}
  }
  if(t?.status==='REQUIRES_PRIMARY_RISK_VALIDATION'){l.status='RESEARCH_COMPLETE';return;}
  if(t?.status==='ELIGIBLE_PAPER'&&flat)this.promote(t,now);
  if((flat||prospectiveStart)&&(!t||['REJECTED','PROMOTED'].includes(t.status))){
   if(l.trials.length>=l.protocol.maxTrials){l.status='RESEARCH_COMPLETE';return;}
   const recipe=l.protocol.recipes[l.trials.length],version=executionVersion(s,l.protocol.version+'-'+recipe.id+(a.riskProfile?'-'+a.riskProfile.version:''));
   t={version,recipe:structuredClone(recipe),started_at:now,status:'TRAINING',training:0,closed:0,net:0,drawdown:0,peak:+a.equity,pending:{},seen:[],validation:null,lastCutoff:Math.floor(now/((recipe.tf??1)*60000))*(recipe.tf??1)*60000,frameCutoffs:Object.fromEntries(recipeComponents(recipe).map(r=>[r.tf,Math.floor(now/(r.tf*60000))*r.tf*60000]))};
   l.trials.push(t);l.active=version;l.status='ACTIVE';
   if(a.riskProfile)t.riskProfile=a.riskProfile.version;
   if(a.leverageProfile)t.leverageProfile=a.leverageProfile.version;
   // A new, bounded research trial keeps the remaining cash and cumulative losses.
   // Risk anchor is per trial; historical maximum drawdown is retained separately.
   a.lifetimeMaxDrawdown=String(Math.max(+a.lifetimeMaxDrawdown||0,+a.maxDrawdown));if(!s.timeframes){a.peak=a.equity;a.halted=false;}
   this.event({type:'LABORATORY_TRIAL_STARTED',at:now,version,recipe:recipe.id,starting_equity:a.equity});
  }
 }
 promote(t,now){
  const s=this.state,l=s.laboratory,previous=this.primary();
  if(t.status!=='ELIGIBLE_PAPER'||!l.trials.includes(t)||promotionReport(t,now).status!=='ELIGIBLE_PAPER'||t.report?.status!=='ELIGIBLE_PAPER'||previous.account.position||previous.account.pending||s.alert.position||s.alert.pending)return false;
  const version=t.version+'-primary',before=s.research.active;
  s.research.versions[version]={version,rules:{...previous.rules},recipe:structuredClone(t.recipe),status:'EXPERIMENTAL',strategy:newStrategyState(),account:structuredClone(previous.account),started_at:now};
  s.research.active=version;l.primary={version,source:t.version,at:now,report:structuredClone(t.report)};t.status='PROMOTED';
  const e={type:'LABORATORY_PROMOTED_PAPER',at:now,before,after:version,source:t.version,recipe:t.recipe.title,realTrading:false};s.research.history.push(e);this.event(e);this.notice('VERSION',e,version);return true;
 }
 async boundary(){
  this.maintain();const t=this.trial(),s=this.state.frequency;
  if(!t||!['TRAINING','VALIDATING'].includes(t.status)||this.state.timeframes?.status==='WAITING_FLAT'||this.state.margin?.status==='WAITING_FLAT'||this.state.secondaryRisk?.status==='WAITING_FLAT'||this.state.entryProfile?.status==='WAITING_FLAT'||this.state.contextProfile?.status==='WAITING_FLAT'||this.state.makerSizing?.status==='WAITING_FLAT'||this.state.exitManagement?.status==='WAITING_FLAT')return;
  // Longest frame first is a fixed priority when bars close together, not an
  // after-the-fact choice. Capital, slots and daily selections remain shared.
  for(const recipe of [...recipeComponents(t.recipe)].sort((a,b)=>b.tf-a.tf)){
   const now=this.now(),cutoff=Math.floor(now/(recipe.tf*60000))*recipe.tf*60000;
   t.frameCutoffs??={};const previous=t.frameCutoffs[recipe.tf]??t.lastCutoff;
   if(cutoff<=previous||now-cutoff<1500)continue;
   // A late REST close gets bounded engine retries without consuming this decision.
   if(now-cutoff<=10000&&((this.feed.series[recipe.tf]??[]).at(-1)?.end!==cutoff||(recipe.order===MAKER_ORDER&&contextBars(recipe,this.feed.series,cutoff,now).reason)))continue;
   t.frameCutoffs[recipe.tf]=cutoff;t.lastCutoff=Math.max(t.lastCutoff??0,cutoff);s.counts.evaluations++;
   const version=componentVersion(t.version,t.recipe,recipe.tf);
   const decide=(reason,criteria)=>{
    s.lastDecision={at:this.now(),cutoff,reason,criteria,timeframe:recipe.tf,version};
    this.state.laboratory.lastDecision={...s.lastDecision};t.decisions??={};t.decisions[recipe.tf]={...s.lastDecision};
    t.diagnostics??={};const d=t.diagnostics[recipe.tf]??={evaluations:0,trend:0,trigger:0,costRoom:0,selected:0,reasons:{}};d.evaluations++;for(const k of ['trend','trigger','costRoom'])if(criteria?.[k]===true)d[k]++;if(reason==='ENTRY_SELECTED')d.selected++;d.reasons[reason]=(d.reasons[reason]??0)+1;
    this.event({type:'LABORATORY_EVALUATION',...s.lastDecision,ledger:'FREQUENT_PAPER'});
   };
   const bad=freshness(this.feed.state,now,this.feed.metadata);if(bad||now-cutoff>10000){decide(bad||'LATE_EVALUATION');continue;}
   if(this.state.portfolio&&this.state.laboratory.executionRevision!==this.state.portfolio.version){decide('WAITING_LEGACY_POSITIONS');continue;}
   if(t.validation?.awaitingFlat||t.validation&&now<t.validation.after){decide('VALIDATION_PURGE');continue;}
   if(!s.account.portfolio&&reserved(s.account)){decide('POSITION_OR_ENTRY_IN_PROGRESS');continue;}
   const day=new Date(now).toISOString().slice(0,10);if(s.selectionDay!==day){s.selectionDay=day;s.daySelections=0;}if(s.daySelections>=12){decide('DAILY_SELECTION_LIMIT');continue;}
   const r=laboratoryPlan(recipe,version,this.feed.series,this.feed.state,this.feed.metadata,cutoff,now);if(!r.plan){decide(r.reason,r.criteria);continue;}
   s.counts.candidates++;r.plan=this.learning.prepare(r.plan,'FREQUENT_PAPER',r.bars,this.feed.state.quote);
   const e=select(s.account,r.plan,this.feed.state.quote,this.feed.metadata,now,{policy:laboratoryPolicy(version)});this.frequency.record(e,version);decide(e.type==='SELECTED'?'ENTRY_SELECTED':e.reason,{...r.criteria,...(e.sizing_diagnostics?{sizing:e.sizing_diagnostics}:{}),...(e.type==='SELECTED'?{selectedQty:e.plan.sizing.qty,selectedNotional:e.plan.sizing.exposure}: {})});
  }
 }
}
