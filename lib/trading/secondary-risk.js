import {boostProfile} from './secondary-boost.js';
import {entryProfile} from './entry-profile.js';
// User-requested PAPER-only capital/risk profile. Never attaches to the primary.
import {D,POLICY,hash} from './core.js';
export const SECONDARY_RISK_VERSION='secondary-growth-1.0.0';
export const SECONDARY_RISK_PROTOCOL=Object.freeze({version:SECONDARY_RISK_VERSION,targetEquity:'300',maxRiskUSD:'3',risk:'0.005',maxRiskFraction:'0.01',openRisk:'0.02',dailyLoss:'0.03',drawdown:'0.10',cashReserve:'0.10',minNetRR:'1.5',riskTiers:[{minRR:1.5,risk:'0.005'},{minRR:1.75,risk:'0.0075'},{minRR:2.25,risk:'0.01'}],leverage:[1,2,3,4,5],maxGrossExposure:'3',maxMarginFraction:'0.75',realTrading:false});
export function secondaryRisk(a){
 if(!a?.riskProfile)return null;
 if(a.riskProfile.version!==SECONDARY_RISK_VERSION||a.riskProfile.protocol_hash!==hash(SECONDARY_RISK_PROTOCOL))throw Error('SECONDARY_RISK_PROFILE_MISMATCH');
 return SECONDARY_RISK_PROTOCOL;
}
export function effectiveSecondaryRisk(a){const base=secondaryRisk(a),boost=boostProfile(a);return base&&boost?{...base,...boost}:base;}
export function accountRiskPolicy(a,base=POLICY){
 const r=effectiveSecondaryRisk(a),entry=entryProfile(a);return r?{...base,risk:r.risk,riskCapUSD:r.maxRiskUSD,openRisk:r.openRisk,dailyLoss:r.dailyLoss,drawdown:r.drawdown,cashReserve:r.cashReserve,minNetRR:entry?.minNetRR??r.minNetRR,marginLeverage:r.leverage,...(r.preferredLeverage?{marginPreferredLeverage:r.preferredLeverage}:{}),marginMaxGrossExposure:r.maxGrossExposure,marginMaxFraction:r.maxMarginFraction}:base;
}
export function initializeSecondaryRisk(s,now,requested=false){
 if(s.secondaryRisk){
  if(s.secondaryRisk.version!==SECONDARY_RISK_VERSION||s.secondaryRisk.protocol_hash!==hash(SECONDARY_RISK_PROTOCOL))throw Error('SECONDARY_RISK_PROFILE_MISMATCH');
  const active=secondaryRisk(s.frequency?.account);if(s.secondaryRisk.status==='ACTIVE'&&!active)throw Error('SECONDARY_RISK_PROFILE_MISMATCH');return;
 }
 if(!requested)return;
 if(s.schema!==4||!s.margin||!s.portfolio||!s.laboratory)throw Error('SECONDARY_RISK_REQUIRES_MARGIN');
 s.secondaryRisk={version:SECONDARY_RISK_VERSION,protocol_hash:hash(SECONDARY_RISK_PROTOCOL),protocol:structuredClone(SECONDARY_RISK_PROTOCOL),requested_at:now,status:'WAITING_FLAT'};
 s.schema=5; // Previous workers must refuse the new state, never silently roll back risk.
}
export function applySecondaryRisk(s,now){
 const request=s.secondaryRisk,a=s.frequency?.account;
 if(!request||request.status==='ACTIVE')return null;
 if(s.margin?.status!=='ACTIVE'||!a?.portfolio||Object.keys(a.positions??{}).length||Object.keys(a.pendingOrders??{}).length||a.position||a.pending||!D(a.cash).eq(a.equity))return null;
 const before=a.equity,amount=D(SECONDARY_RISK_PROTOCOL.targetEquity).minus(before).clamp(0,Infinity);
 const after=D(before).plus(amount).toString();a.cash=a.equity=after;
 // Additions are external fictitious deposits, not wins. Preserve P&L and drawdowns.
 a.peak=D(a.peak).plus(amount).toString();a.dayStart=D(a.dayStart).plus(amount).toString();
 a.riskProfile={version:SECONDARY_RISK_VERSION,protocol_hash:hash(SECONDARY_RISK_PROTOCOL),activated_at:now};
 a.availableCash=after;
 const e={type:'SECONDARY_RISK_ENABLED',id:hash([SECONDARY_RISK_VERSION,'capital']),at:now,ledger:'FREQUENT_PAPER',before,amount:amount.toString(),after,realTrading:false};
 const f=s.laboratory.funding;f.added=D(f.added).plus(amount).toString();f.history.push({...e,kind:'USER_CAPITAL_ADDITION'});f.history=f.history.slice(-100);
 // Emergency refill count stays unchanged; the old round is archived separately.
 Object.assign(request,{status:'ACTIVE',activated_at:now,capital_event:e});return e;
}
