// Prospective PAPER experiment. Fixed horizons; never widen a target to pass costs.
import {hash,checkSeries,indicators} from './core.js';
export const CONTEXT_VERSION='context-maker-1.0.0';
export const MAKER_ORDER='SIMULATED_POST_ONLY_LIMIT';
export const CONTEXT_PROTOCOL=Object.freeze({version:CONTEXT_VERSION,makerFee:'0.004',takerFee:'0.008',minNetRR:'1',order:MAKER_ORDER,fillModel:'POST_ONLY_TRADE_THROUGH_10X',queuePosition:'NOT_MODELED',partialFills:false,stopATR:2,targetATR:6,contexts:{1:{stop:15,target:60,holdingMs:43200000},15:{stop:60,target:240,holdingMs:172800000},60:{stop:240,target:240,holdingMs:604800000},240:{stop:240,target:240,holdingMs:604800000}},realTrading:false});
export function contextProfile(a){
 if(!a?.contextProfile)return null;
 if(a.contextProfile.version!==CONTEXT_VERSION||a.contextProfile.protocol_hash!==hash(CONTEXT_PROTOCOL))throw Error('CONTEXT_PROFILE_MISMATCH');
 return CONTEXT_PROTOCOL;
}
export function initializeContextProfile(s,now,requested=false){
 if(s.contextProfile){
  if(s.contextProfile.version!==CONTEXT_VERSION||s.contextProfile.protocol_hash!==hash(CONTEXT_PROTOCOL))throw Error('CONTEXT_PROFILE_MISMATCH');
  if(s.contextProfile.status==='ACTIVE'&&!contextProfile(s.frequency?.account))throw Error('CONTEXT_PROFILE_MISMATCH');return;
 }
 if(!requested)return;
 if(s.schema!==6||!s.entryProfile||!s.secondaryRisk)throw Error('CONTEXT_PROFILE_REQUIRES_AGILE_SECONDARY');
 s.contextProfile={version:CONTEXT_VERSION,protocol_hash:hash(CONTEXT_PROTOCOL),protocol:structuredClone(CONTEXT_PROTOCOL),requested_at:now,status:'WAITING_FLAT'};s.schema=7;
}
export function contextBars(recipe,series,cutoff,now){
 const result={};
 for(const tf of new Set([recipe.stopTf,recipe.targetTf])){
  const end=Math.floor(cutoff/(tf*60000))*tf*60000;
  const bars=(series[tf]??[]).filter(b=>b.end<=end&&b.available_at<=now).slice(-120);
  if(checkSeries(bars,tf*60000,60)||bars.at(-1)?.end!==end)return {reason:'LAB_CONTEXT_NOT_SYNCHRONIZED'};
  result[tf]={bars,atr:indicators(bars).at(-1).atr,end};
 }
 return result;
}
