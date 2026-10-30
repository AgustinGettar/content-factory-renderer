// Explicit PAPER experiment. Entry changes never move money or change risk caps.
import {hash} from './core.js';
export const ENTRY_VERSION='agile-5bars-1.0.0';
export const ENTRY_PROTOCOL=Object.freeze({version:ENTRY_VERSION,lookback:5,fast:9,slow:21,kind:'BREAKOUT_OR_PULLBACK',minNetRR:'1',realTrading:false});
export function entryProfile(a){
 if(!a?.entryProfile)return null;
 if(a.entryProfile.version!==ENTRY_VERSION||a.entryProfile.protocol_hash!==hash(ENTRY_PROTOCOL))throw Error('ENTRY_PROFILE_MISMATCH');
 return ENTRY_PROTOCOL;
}
export function initializeEntryProfile(s,now,requested=false){
 if(s.entryProfile){
  if(s.entryProfile.version!==ENTRY_VERSION||s.entryProfile.protocol_hash!==hash(ENTRY_PROTOCOL))throw Error('ENTRY_PROFILE_MISMATCH');
  if(s.entryProfile.status==='ACTIVE'&&!entryProfile(s.frequency?.account))throw Error('ENTRY_PROFILE_MISMATCH');return;
 }
 if(!requested)return;
 if(s.schema!==5||!s.secondaryRisk||!s.margin)throw Error('ENTRY_PROFILE_REQUIRES_SECONDARY_RISK');
 s.entryProfile={version:ENTRY_VERSION,protocol_hash:hash(ENTRY_PROTOCOL),protocol:structuredClone(ENTRY_PROTOCOL),requested_at:now,status:'WAITING_FLAT'};
 s.schema=6;
}
