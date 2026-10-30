// A fixed four-timeframe PAPER hypothesis. All entries share one cash/risk ledger.
import {hash} from './core.js';
export const TIMEFRAMES=Object.freeze([1,15,60,240]);
export const TIMEFRAME_VERSION='lumi-timeframes-1.0.0';
export const timeframeLabel=tf=>({1:'1 m',15:'15 m',60:'1 h',240:'4 h'}[tf]??String(tf)+' m');
const holding={1:1800000,15:12*3600000,60:48*3600000,240:7*86400000};
export const MULTIFRAME_RECIPE=Object.freeze({id:'trend-breakout-four-frames',title:'Ruptura con tendencia · 1 m / 15 m / 1 h / 4 h',components:TIMEFRAMES.map(tf=>({id:'trend-breakout-'+tf+'m',title:'Ruptura de 20 velas · '+timeframeLabel(tf),tf,kind:'BREAKOUT',lookback:20,fast:20,slow:50,stopATR:2,targetATR:6,holdingMs:holding[tf],minNetRR:'1.5'}))});
export const MULTIFRAME_RECIPES=Object.freeze([MULTIFRAME_RECIPE,{...MULTIFRAME_RECIPE,id:'trend-pullback-four-frames',title:'Retroceso con tendencia · 1 m / 15 m / 1 h / 4 h',components:MULTIFRAME_RECIPE.components.map(r=>({...r,id:r.id.replace('breakout','pullback'),title:'Retroceso y recuperación · '+timeframeLabel(r.tf),kind:'PULLBACK'}))}]);
export const recipeComponents=recipe=>recipe.components??[recipe];
export function componentVersion(version,recipe,tf){
 if(!recipe.components)return version;
 const [base,...execution]=version.split('@');return base+'-tf'+tf+(execution.length?'@'+execution.join('@'):'');
}
export const recipeVersions=(version,recipe)=>recipeComponents(recipe).map(r=>componentVersion(version,recipe,r.tf));
export function initializeTimeframes(s,now){
 const protocol={version:TIMEFRAME_VERSION,frames:TIMEFRAMES,recipes:MULTIFRAME_RECIPES,realTrading:false};
 if(s.timeframes){if(s.timeframes.protocol_hash!==hash(protocol))throw Error('TIMEFRAME_PROTOCOL_MISMATCH');return null;}
 s.timeframes={version:TIMEFRAME_VERSION,protocol_hash:hash(protocol),frames:[...TIMEFRAMES],requested_at:now,status:'WAITING_FLAT'};
 s.schema=3; // Older workers must refuse this research state instead of reverting it.
 return {type:'TIMEFRAMES_REQUESTED',at:now,frames:TIMEFRAMES,realTrading:false};
}
