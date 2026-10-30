// Opt-in prospective PAPER experiment. Existing frozen plans are never resized.
import {hash} from './core.js';
export const BOOST_VERSION='secondary-boost-1.0.0';
export const BOOST_PROTOCOL=Object.freeze({version:BOOST_VERSION,preferredLeverage:3,leverage:[1,2,3,4,5],selection:'MAX_SIZE_PREFERRED_GROUP',risk:'0.01',maxRiskFraction:'0.02',maxRiskUSD:'6',openRisk:'0.04',dailyLoss:'0.05',drawdown:'0.10',cashReserve:'0.10',maxGrossExposure:'3',maxMarginFraction:'0.75',riskTiers:[{minRR:1,risk:'0.01'},{minRR:1.75,risk:'0.015'},{minRR:2.25,risk:'0.02'}],realTrading:false});
export function boostProfile(a){
 if(!a?.leverageProfile)return null;
 if(a.leverageProfile.version!==BOOST_VERSION||a.leverageProfile.protocol_hash!==hash(BOOST_PROTOCOL)||!a.riskProfile)throw Error('SECONDARY_BOOST_PROFILE_MISMATCH');
 return BOOST_PROTOCOL;
}
export function initializeBoost(s,now,requested=false){
 if(s.leverageProfile){
  if(s.leverageProfile.version!==BOOST_VERSION||s.leverageProfile.protocol_hash!==hash(BOOST_PROTOCOL))throw Error('SECONDARY_BOOST_PROFILE_MISMATCH');
  if(s.leverageProfile.status==='ACTIVE'&&!boostProfile(s.frequency?.account))throw Error('SECONDARY_BOOST_PROFILE_MISMATCH');return;
 }
 if(!requested)return;
 if(s.schema!==9||s.secondaryRisk?.status!=='ACTIVE'||s.contextProfile?.status!=='ACTIVE'||!s.makerSizing||!s.exitManagement||s.margin?.status!=='ACTIVE')throw Error('SECONDARY_BOOST_REQUIRES_NET_EXIT_CONTEXT');
 s.leverageProfile={version:BOOST_VERSION,protocol_hash:hash(BOOST_PROTOCOL),protocol:structuredClone(BOOST_PROTOCOL),requested_at:now,status:'REQUESTED'};
 s.schema=10;
}
