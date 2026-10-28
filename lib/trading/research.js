import {hash,VERSION,POLICY,D} from './core.js';
import {BASE_RULES,newStrategyState} from './strategies.js';
import {newAccount} from './simulator.js';
export const GATES=Object.freeze({newMature:100,maxCandidates:3,maxAttempts:30,minDays:90,minProspectiveFills:100,minOOS:300,minFinal:100,minOOSMonths:12,minEffective:200,minExpectancy:.10,minPF:1.20,maxDD:.05,maxStressDD:.075,minPositiveFolds:.70,minSensitivity:.70,minEconomicImprovement:.0002,alpha:.05,purgeHours:24});
export function newResearch(){return {active:VERSION,attempts:0,lastCampaignMature:0,lastReviewMonth:null,versions:{[VERSION]:{version:VERSION,rules:{...BASE_RULES},status:'EXPERIMENTAL',strategy:newStrategyState(),account:newAccount()}},campaigns:[],history:[],probability:'NO DISPONIBLE'};}
// Circular block bootstrap of common UTC daily equity returns INCLUDING zero
// activity days. Fixed seed makes reports exactly reproducible.
export function bootstrapDifference(active,candidate,{block=7,reps=2000,alpha=.05}={}){
  if(active.length!==candidate.length||active.length<30)return null;
  const diff=candidate.map((x,i)=>x-active[i]);let seed=1793220001;
  const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
  const sample=[];for(let j=0;j<reps;j++){let sum=0,n=0;while(n<diff.length){const start=Math.floor(random()*diff.length);for(let k=0;k<block&&n<diff.length;k++,n++)sum+=diff[(start+k)%diff.length];}sample.push(sum/diff.length);}sample.sort((a,b)=>a-b);
  return {mean:diff.reduce((a,b)=>a+b,0)/diff.length,lower:sample[Math.floor(alpha/2*reps)],upper:sample[Math.min(reps-1,Math.floor((1-alpha/2)*reps))],days:diff.length,block,reps,seed:1793220001};
}
export function historicalGate(report){
  if(!report||report.kind!=='CHRONOLOGICAL_OOS'||!report.input_hash||!report.protocol_hash||report.criticalIncidents!==0)return false;
  const g=GATES;return report.fills>=g.minOOS&&report.finalFills>=g.minFinal&&report.months>=g.minOOSMonths&&report.effectiveN>=g.minEffective&&report.expectancyR>=g.minExpectancy&&report.lower95R>0&&report.finalLower95R>0&&report.profitFactor>=g.minPF&&report.drawdown<=g.maxDD&&report.positiveFoldFraction>=g.minPositiveFolds&&report.sensitivityPositiveFraction>=g.minSensitivity&&report.stressExpectancy>=0&&report.stressDD<=g.maxStressDD&&report.purgeHours>=g.purgeHours&&report.selectionAdjusted===true&&report.zeroFutureReads===true&&report.zeroUnresolvedGaps===true&&report.calibration?.brier<=report.calibration?.baselineBrier&&report.calibration?.logLoss<=report.calibration?.baselineLogLoss&&report.calibration?.ece<=.05&&report.calibration?.intervalWidth<=.20;
}
export function compareCandidate(campaign,candidate,active,{now,attempts,historical}={}){
  const g=campaign.gates,age=(now-campaign.started_at)/86400000;
  if(age<g.minDays||candidate.fills<g.minProspectiveFills||!historicalGate(historical))return {status:'INCONCLUSO',reason:'SAMPLE_OR_HISTORICAL_GATES'};
  const days=Object.keys(active.days).filter(k=>k>=campaign.start_day&&k<new Date(now).toISOString().slice(0,10)).sort();
  if(days.length<g.minDays||days.some((d,i)=>candidate.days[d]==null||i&&Date.parse(d)-Date.parse(days[i-1])!==86400000))return {status:'INCONCLUSO',reason:'COMMON_CALENDAR_INCOMPLETE'};
  const a=days.map(d=>active.days[d]),b=days.map(d=>candidate.days[d]);
  // Bonferroni across ALL recorded attempts; never reset after a failed search.
  const ci=bootstrapDifference(a,b,{alpha:g.alpha/Math.max(1,attempts)});
  const pass=ci&&ci.lower>g.minEconomicImprovement&&candidate.drawdown<=Math.min(g.maxDD,active.drawdown+.005)&&candidate.incidents===0&&candidate.net>=0;
  return {status:pass?'ELIGIBLE_PAPER':'REJECTED',ci,reason:pass?'PREDECLARED_GATES':'NO_NET_IMPROVEMENT_OR_RISK'};
}
export function monthlyReview(research,matureCount,now){
  const month=new Date(now).toISOString().slice(0,7);if(month===research.lastReviewMonth)return [];
  research.lastReviewMonth=month;
  if(research.campaigns.some(c=>c.status==='PROSPECTIVE')||matureCount-research.lastCampaignMature<GATES.newMature||research.attempts>=GATES.maxAttempts)return [{type:'RESEARCH_REVIEW',at:now,status:'INCONCLUSO',matureCount,attempts:research.attempts}];
  const variants=[{adxTrend:23,rvol:1.2},{adxTrend:27,rvol:1.2},{adxTrend:25,rvol:1.3}];
  const campaign={id:hash([month,research.attempts,research.active]),started_at:now,start_day:new Date(now).toISOString().slice(0,10),active:research.active,status:'PROSPECTIVE',gates:{...GATES},hypothesis:'Improve net daily equity return after costs at identical risk and capital',primary:'COMMON_UTC_DAILY_NET_RETURN',candidates:[],reports:[]};
  for(const rules of variants.slice(0,Math.min(GATES.maxCandidates,GATES.maxAttempts-research.attempts))){research.attempts++;const version=VERSION+'-candidate-'+research.attempts;research.versions[version]={version,rules,status:'CANDIDATE',strategy:newStrategyState(),account:newAccount(),days:{},fills:0,started_at:now};campaign.candidates.push(version);}
  campaign.protocol_hash=hash(campaign);research.campaigns.push(campaign);research.lastCampaignMature=matureCount;
  // Independent, equal-capital comparator starts on the same date. Never reset
  // the actual active ledger or compare the candidate only to selected winners.
  campaign.comparator={comparator:true,version:research.active,rules:{...research.versions[research.active].rules},strategy:newStrategyState(),account:newAccount(),days:{},fills:0,started_at:now};
  return [{type:'CAMPAIGN_REGISTERED',campaign:structuredClone(campaign),at:now}];
}
export function promote(research,campaign,version,report,now){
  if(report.status!=='ELIGIBLE_PAPER'||!campaign.candidates.includes(version)||research.active!==campaign.active)throw Error('PROMOTION_NOT_ELIGIBLE');
  const v=research.versions[version];if(v.account.position||v.account.pending||research.versions[research.active].account.position||research.versions[research.active].account.pending)return {type:'PROMOTION_DEFERRED_OPEN_PLAN',at:now};
  const before=research.active;v.prospective_account=structuredClone(v.account);v.account=structuredClone(research.versions[before].account);research.active=version;v.status='EXPERIMENTAL';campaign.status='PROMOTED_PAPER';
  const event={type:'VERSION_PROMOTED_PAPER',at:now,before,after:version,report,policy_hash:hash(POLICY),realTrading:false};research.history.push(event);return event;
}
export function rollback(research,version,reason,now){
  if(!research.versions[version]||!reason.startsWith('TECHNICAL_'))throw Error('ROLLBACK_REQUIRES_TECHNICAL_REASON');
  const before=research.active;const account=research.versions[before].account;if(account.position||account.pending){research.paused=true;return {type:'ROLLBACK_DEFERRED_OPEN_PLAN',at:now,before,requested:version,reason};}research.versions[version].account=structuredClone(account);research.active=version;const event={type:'VERSION_ROLLBACK_PAPER',before,after:version,reason,at:now};research.history.push(event);return event;
}
export function metrics(closed){
  let gains=D(0),losses=D(0),net=D(0),fees=D(0);for(const e of closed){const p=D(e.pnl);net=net.plus(p);fees=fees.plus(e.fees);if(p.gt(0))gains=gains.plus(p);else losses=losses.minus(p);}
  return {fills:closed.length,net:net.toString(),fees:fees.toString(),profitFactor:losses.gt(0)?gains.div(losses).toNumber():null,expectancyR:closed.length?closed.reduce((s,e)=>s+ +e.R,0)/closed.length:null,targets:closed.filter(e=>e.outcome==='TARGET').length,stops:closed.filter(e=>e.outcome==='STOP').length,timeouts:closed.filter(e=>e.outcome==='TIMEOUT').length,probability:'NO DISPONIBLE'};
}
