// One explicit fictitious deposit and a prospective secondary-only capacity revision.
import {D,hash} from './core.js';
export const CAPACITY_VERSION='secondary-capacity-1.0.0';
export const CAPACITY_PROTOCOL=Object.freeze({version:CAPACITY_VERSION,capitalAddition:'200',maxSlots:10,preferredLeverage:5,leverage:[1,2,3,4,5,6,7,8,9,10],maxRiskUSD:'10',maxRiskFraction:'0.02',risk:'0.01',riskTiers:[{minRR:1,risk:'0.01'},{minRR:1.75,risk:'0.015'},{minRR:2.25,risk:'0.02'}],openRisk:'0.10',dailyLoss:'0.10',maxGrossExposure:'5',maxMarginFraction:'0.75',cashReserve:'0.10',drawdown:'0.10',realTrading:false});
export function capacityProfile(a){
 if(!a?.capacityProfile)return null;
 if(a.capacityProfile.version!==CAPACITY_VERSION||a.capacityProfile.protocol_hash!==hash(CAPACITY_PROTOCOL)||!a.riskProfile||!a.leverageProfile)throw Error('SECONDARY_CAPACITY_PROFILE_MISMATCH');
 return CAPACITY_PROTOCOL;
}
export function initializeCapacity(s,now,requested=false){
 if(s.secondaryCapacity){
  const r=s.secondaryCapacity;
  if(s.schema!==11||!['REQUESTED','ACTIVE'].includes(r.status)||r.version!==CAPACITY_VERSION||r.protocol_hash!==hash(CAPACITY_PROTOCOL))throw Error('SECONDARY_CAPACITY_PROFILE_MISMATCH');
  if(r.status==='ACTIVE'&&(!capacityProfile(s.frequency?.account)||r.capital_event?.amount!==CAPACITY_PROTOCOL.capitalAddition))throw Error('SECONDARY_CAPACITY_PROFILE_MISMATCH');return;
 }
 if(s.frequency?.account.capacityProfile)throw Error('SECONDARY_CAPACITY_PROFILE_MISMATCH');
 if(!requested)return;
 if(s.schema!==10||s.leverageProfile?.status!=='ACTIVE'||s.makerSizing?.status!=='ACTIVE'||s.exitManagement?.status!=='ACTIVE'||!s.frequency?.account.portfolio)throw Error('SECONDARY_CAPACITY_REQUIRES_BOOST');
 s.secondaryCapacity={version:CAPACITY_VERSION,protocol_hash:hash(CAPACITY_PROTOCOL),protocol:structuredClone(CAPACITY_PROTOCOL),requested_at:now,status:'REQUESTED'};s.schema=11;
}
export function applyCapacity(s,now){
 const r=s.secondaryCapacity;if(!r||r.status==='ACTIVE')return null;
 const a=s.frequency.account,before=a.equity,amount=D(CAPACITY_PROTOCOL.capitalAddition);
 // A deposit changes cash and capital anchors equally. It never changes net
 // returns, costs, closed results, historical drawdown, halts or frozen orders.
 for(const k of ['cash','equity','peak','dayStart'])a[k]=D(a[k]).plus(amount).toString();
 a.availableCash=D(a.cash).minus(a.reservedCash??0).toString();
 a.capacityProfile={version:CAPACITY_VERSION,protocol_hash:hash(CAPACITY_PROTOCOL),activated_at:now};
 const e={type:'SECONDARY_CAPACITY_ENABLED',id:hash([CAPACITY_VERSION,'capital']),at:now,ledger:'FREQUENT_PAPER',before,amount:amount.toString(),after:a.equity,maxSlots:10,preferredLeverage:5,maxLeverage:10,realTrading:false};
 const f=s.laboratory.funding;f.added=D(f.added).plus(amount).toString();f.history.push({...e,kind:'USER_CAPITAL_ADDITION'});f.history=f.history.slice(-100);
 Object.assign(r,{status:'ACTIVE',activated_at:now,capital_event:e});return e;
}
