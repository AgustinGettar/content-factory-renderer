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
 a.reservedCash=orders(a).reduce((s,p)=>s.plus(p.plan.sizing.reserved),D(0)).toString();
 a.openRiskReserved=[...positions(a),...orders(a)].reduce((s,p)=>s.plus(p.plan.sizing.risk),D(0)).toString();
 a.availableCash=D(a.cash).minus(a.reservedCash).toString();
}
export function enablePortfolio(a){
 if(!a)return;if(a.portfolio){if(a.portfolio.version!==PORTFOLIO_VERSION)throw Error('PORTFOLIO_VERSION_MISMATCH');syncPortfolio(a);return;}
 a.positions=a.position?{[a.position.plan.id]:a.position}:{};a.pendingOrders=a.pending?{[a.pending.plan.id]:a.pending}:{};
 a.portfolio={version:PORTFOLIO_VERSION,seen:[]};syncPortfolio(a);
}
export function initializePortfolio(s,now){
 if(s.portfolio){if(s.schema!==2||s.portfolio.protocol_hash!==hash(PORTFOLIO_PROTOCOL))throw Error('PORTFOLIO_PROTOCOL_MISMATCH');return null;}
 s.portfolio={version:PORTFOLIO_VERSION,protocol:structuredClone(PORTFOLIO_PROTOCOL),protocol_hash:hash(PORTFOLIO_PROTOCOL),started_at:now};
 for(const v of Object.values(s.research.versions))enablePortfolio(v.account);
 for(const c of s.research.campaigns)if(c.comparator)enablePortfolio(c.comparator.account);
 enablePortfolio(s.frequency.account);enablePortfolio(s.alert);
 s.schema=2; // Old single-position workers must refuse this persisted state.
 return {type:'PORTFOLIO_ENABLED',at:now,version:PORTFOLIO_VERSION,realTrading:false};
}
export function portfolioPolicy(plan,quote,base=POLICY){
 const p={...base,minNetRR:PORTFOLIO_PROTOCOL.minNetRR,openRisk:PORTFOLIO_PROTOCOL.openRisk,riskCapUSD:PORTFOLIO_PROTOCOL.maxRiskUSD};
 const e=D(plan.limit),fee=D(p.fee),slip=D(p.slippage),spread=D(quote.ask).minus(quote.bid),stop=D(plan.stop).minus(spread).mul(D(1).minus(slip)),target=D(plan.target).minus(spread).mul(D(1).minus(slip));
 const loss=e.mul(D(1).plus(fee)).minus(stop.mul(D(1).minus(fee))),gain=target.mul(D(1).minus(fee)).minus(e.mul(D(1).plus(fee)));
 const rr=loss.gt(0)?gain.div(loss).toNumber():0;
 p.risk=PORTFOLIO_PROTOCOL.riskTiers.filter(t=>rr>=t.minRR).at(-1)?.risk??POLICY.risk;
 return p;
}
