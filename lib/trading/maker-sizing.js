// Separate prospective sizing revision. Passive posting does not consume BBO liquidity.
import {hash} from './core.js';
export const MAKER_SIZING_VERSION='maker-sizing-1.0.0';
export const MAKER_SIZING_PROTOCOL=Object.freeze({version:MAKER_SIZING_VERSION,model:'RISK_CAPITAL_AT_POSTING',liquidityCheck:'AT_OBSERVED_FILL',riskCapsUnchanged:true,realTrading:false});
export function makerSizingProfile(a){
 if(!a?.makerSizingProfile)return null;
 if(a.makerSizingProfile.version!==MAKER_SIZING_VERSION||a.makerSizingProfile.protocol_hash!==hash(MAKER_SIZING_PROTOCOL))throw Error('MAKER_SIZING_PROFILE_MISMATCH');
 return MAKER_SIZING_PROTOCOL;
}
export function initializeMakerSizing(s,now,requested=false){
 if(s.makerSizing){
  if(s.makerSizing.version!==MAKER_SIZING_VERSION||s.makerSizing.protocol_hash!==hash(MAKER_SIZING_PROTOCOL))throw Error('MAKER_SIZING_PROFILE_MISMATCH');
  if(s.makerSizing.status==='ACTIVE'&&!makerSizingProfile(s.frequency?.account))throw Error('MAKER_SIZING_PROFILE_MISMATCH');return;
 }
 if(!requested)return;
 if(s.schema!==7||s.contextProfile?.status!=='ACTIVE')throw Error('MAKER_SIZING_REQUIRES_CONTEXT');
 s.makerSizing={version:MAKER_SIZING_VERSION,protocol_hash:hash(MAKER_SIZING_PROTOCOL),protocol:structuredClone(MAKER_SIZING_PROTOCOL),requested_at:now,status:'WAITING_FLAT'};s.schema=8;
}
