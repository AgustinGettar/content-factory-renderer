import {makerSizingProfile} from './maker-sizing.js';
import {contextProfile} from './context-profile.js';
import {entryProfile} from './entry-profile.js';
import {isMarginPlan,marginEconomics} from './margin.js';
import {accountRiskPolicy,secondaryRisk} from './secondary-risk.js';
// One cash ledger per paper account, shared by all positions and conditional orders.
import {D,POLICY,hash} from './core.js';
export const PORTFOLIO_VERSION='lumi-portfolio-1.0.0';
export const PORTFOLIO_PROTOCOL=Object.freeze({version:PORTFOLIO_VERSION,maxSlots:3,maxRiskUSD:'1',maxRiskFraction:'0.01',openRisk:'0.01',dailyLoss:POLICY.dailyLoss,cashReserve:POLICY.cashReserve,minNetRR:'1.5',riskTiers:[{minRR:1.5,risk:'0.0025'},{minRR:1.75,risk:'0.005'},{minRR:2.25,risk:'0.01'}],realTrading:false});
export const positions=a=>a?.portfolio?Object.values(a.positions??{}):a?.position?[a.position]:[];
export const orders=a=>a?.portfolio?Object.values(a.pendingOrders??{}):a?.pending?[a.pending]:[];
export const reserved=a=>positions(a).length+orders(a).length>0;
export const findPosition=(a,id)=>positions(a).find(p=>p.plan.id===id);
export const findOrder=(a,id)=>orders(a).find(p=>p.plan.id===id);
export const executionVersion=(s,version)=>s.portfolio&&!version.endsWith('@'+PORTFOLIO_VERSION)?version+'@'+PORTFOLIO_VERSION:version;
export function stampPlan(s,p){const version=executionVersion(s,p.version);if(version===p.version)return p;const out={...p,version,id:hash([p.id,version])};out.hash=hash({...out,hash:undefined});return out;}
export function syncPortfolio(a){
 if(!a.portfolio)return;
 // Compatibility views only. All writes and calculations use the maps.
 a.position=positions(a)[0]??null;a.pending=orders(a)[0]??null;
 a.fundingReserve=positions(a).reduce((s,p)=>s.plus(p.plan.sizing.funding_reserved??0),D(0)).toString();
 a.reservedCash=orders(a).reduce((s,p)=>s.plus(p.plan.sizing.reserved),D(a.fundingReserve)).toString();
 a.openRiskReserved=[...positions(a),...orders(a)].reduce((s,p)=>s.plus(p.plan.sizing.risk),D(0)).toString();
 a.availableCash=D(a.cash).minus(a.reservedCash).toString();
}
export function enablePortfolio(a){
 if(!a)return;if(a.portfolio){if(a.portfolio.version!==PORTFOLIO_VERSION)throw Error('PORTFOLIO_VERSION_MISMATCH');syncPortfolio(a);return;}
 a.positions=a.position?{[a.position.plan.id]:a.position}:{};a.pendingOrders=a.pending?{[a.pending.plan.id]:a.pending}:{};
 a.portfolio={version:PORTFOLIO_VERSION,seen:[]};syncPortfolio(a);
}
export function initializePortfolio(s,now){
 if(s.portfolio){if(![2,3,4,5,6,7,8,9].includes(s.schema)||s.portfolio.protocol_hash!==hash(PORTFOLIO_PROTOCOL))throw Error('PORTFOLIO_PROTOCOL_MISMATCH');return null;}
 s.portfolio={version:PORTFOLIO_VERSION,protocol:structuredClone(PORTFOLIO_PROTOCOL),protocol_hash:hash(PORTFOLIO_PROTOCOL),started_at:now};
 for(const v of Object.values(s.research.versions))enablePortfolio(v.account);
 for(const c of s.research.campaigns)if(c.comparator)enablePortfolio(c.comparator.account);
 enablePortfolio(s.frequency.account);enablePortfolio(s.alert);
 s.schema=2; // Old single-position workers must refuse this persisted state.
 return {type:'PORTFOLIO_ENABLED',at:now,version:PORTFOLIO_VERSION,realTrading:false};
}
export function portfolioPolicy(plan,quote,base=POLICY,account=null){
 const profile=secondaryRisk(account),protocol=profile??PORTFOLIO_PROTOCOL;
 const p={...accountRiskPolicy(account,base),...(makerSizingProfile(account)?{makerSizingModel:makerSizingProfile(account).model}:{}),...(contextProfile(account)?{makerFee:contextProfile(account).makerFee}:{}),minNetRR:entryProfile(account)?.minNetRR??protocol.minNetRR,openRisk:protocol.openRisk,riskCapUSD:protocol.maxRiskUSD};
 if(isMarginPlan(plan)){const c=marginEconomics(plan,quote,p,true);p.risk=protocol.riskTiers.filter(t=>c.rr.gte(t.minRR)).at(-1)?.risk??(entryProfile(account)?protocol.risk:POLICY.risk);return p;}
 const e=D(plan.limit),fee=D(p.fee),slip=D(p.slippage),spread=D(quote.ask).minus(quote.bid),stop=D(plan.stop).minus(spread).mul(D(1).minus(slip)),target=D(plan.target).minus(spread).mul(D(1).minus(slip));
 const loss=e.mul(D(1).plus(fee)).minus(stop.mul(D(1).minus(fee))),gain=target.mul(D(1).minus(fee)).minus(e.mul(D(1).plus(fee)));
 const rr=loss.gt(0)?gain.div(loss).toNumber():0;
 p.risk=protocol.riskTiers.filter(t=>rr>=t.minRR).at(-1)?.risk??(entryProfile(account)?protocol.risk:POLICY.risk);
 return p;
}
