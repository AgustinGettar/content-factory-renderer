// Additive hypothesis: higher-frame trend/structure, lower-frame reclaim.
// Its signed policy is independent of the immutable nine-strategy baseline.
import {hash} from './core.js';
import {classifyQuantRegime} from './quant-features.js';
export const CONTEXT_VERSION='secondary-context-pullback-1.0.0';
export const CONTEXT_PATTERN='CONTEXT_PULLBACK';
export const CONTEXT_SPEC=Object.freeze({title:'Retroceso con contexto superior',frames:[1,5,15],base:'PULLBACK',regimes:['HIGHER_FRAME_TREND']});
export const CONTEXT_POLICY=Object.freeze({version:CONTEXT_VERSION,mode:'PAPER',realTrading:false,ledger:'FREQUENT_PAPER',strategy:CONTEXT_SPEC,
 min_relative_volume:.5,min_body_fraction:.25,max_chase_atr:1,stop_buffer_atr:.15,opposing_local_adx:30,
 target:'NEAREST_UNBROKEN_LOCAL_OR_CONTEXT_STRUCTURE',execution:'EXISTING_TAKER_WITH_FULL_REVALIDATION',
 probability_authority:'NONE',parameter_status:'PREDECLARED_PAPER_EXPERIMENT_NOT_PROVEN_PROFITABLE'});
export function getContextProfile(root){const p=root?.secondaryExecution?.quant?.context_pullback;if(!p)return null;
 if(p.version!==CONTEXT_VERSION||p.policy_hash!==hash(CONTEXT_POLICY)||hash(p.policy)!==p.policy_hash||typeof p.active!=='boolean')throw Error('CONTEXT_POLICY_INTEGRITY');return p.active?p:null;}
export function installContextPullback(root,env,now,event=()=>{}){
 const old=getContextProfile(root),flag=env.LUMI_TRADING_SECONDARY_CONTEXT_PULLBACK;
 if(!flag){if(old)throw Error('CONTEXT_FLAG_REQUIRED');return false;}
 if(env.LUMI_TRADING_MODE!=='PAPER'||env.LUMI_RUNTIME_ENV!=='staging'||env.LUMI_TRADING_STORAGE!=='SQLITE')throw Error('CONTEXT_PAPER_ONLY');
 if(flag==='OFF'){if(old)old.active=false;return !!old;}
 if(flag!==CONTEXT_VERSION||root.secondaryExecution?.quant?.active!==true||root.secondaryExecution.quant.opportunities?.active!==true)throw Error('CONTEXT_OPPORTUNITIES_REQUIRED');
 if(old)return false;
 root.secondaryExecution.quant.context_pullback={version:CONTEXT_VERSION,policy:structuredClone(CONTEXT_POLICY),policy_hash:hash(CONTEXT_POLICY),active:true,activated_at:now,counts:{evaluations:0,detected:0,candidates:0,selected:0},baseline:{net:root.frequency.account.net,equity:root.frequency.account.equity}};
 event({type:'SECONDARY_CONTEXT_PULLBACK_ENABLED',at:now,version:CONTEXT_VERSION,policy_hash:hash(CONTEXT_POLICY),ledger:'FREQUENT_PAPER',realTrading:false});return true;
}
export function detectContextPullback(b,f,c){
 const p=CONTEXT_POLICY;
 if(!CONTEXT_SPEC.frames.includes(f.timeframe))return {reason:'STRATEGY_TIMEFRAME_NOT_ENABLED'};
 if(f.status!=='READY'||c.status!=='READY'||c.timeframe<=f.timeframe||c.cutoff>f.cutoff)return {reason:'CONTEXT_NOT_SYNCHRONIZED'};
 if(f.microstructure?.spread_bps==null||f.microstructure.spread_bps>8)return {reason:'LIQUIDITY_NOT_CONFIRMED'};
 const contextRegime=classifyQuantRegime(c),side=contextRegime.trend==='UPTREND'?1:contextRegime.trend==='DOWNTREND'?-1:0;
 if(!side)return {reason:'CONTEXT_TREND_NOT_CONFIRMED'};
 const local=classifyQuantRegime(f);
 if(f.adx>=p.opposing_local_adx&&local.direction===(side>0?'DOWN':'UP'))return {reason:'CONTEXT_PULLBACK_OPPOSING_TREND'};
 if(!(f.atr14>0)||f.relative_volume==null||f.relative_volume<p.min_relative_volume)return {reason:'VOLUME_NOT_CONFIRMED'};
 const last=b.at(-1),prev=b.at(-2),a=f.atr14,span=last.high-last.low,body=span?side*(last.close-last.open)/span:0;
 const touched=side>0?Math.min(prev.low,last.low)<=f.ema9:Math.max(prev.high,last.high)>=f.ema9;
 const reclaimed=side*(last.close-f.ema9)>0&&side*(last.close-(side>0?prev.high:prev.low))>0;
 if(!touched||!reclaimed||body<p.min_body_fraction)return {reason:'WAIT_CONTEXT_PULLBACK'};
 if(Math.abs(last.close-f.ema9)>p.max_chase_atr*a)return {reason:'CONTEXT_PULLBACK_TOO_EXTENDED'};
 // A closer known obstacle wins. Never enlarge a target to pass the fee filter.
 const key=side>0?'high':'low',swings=side>0?'highs':'lows',levels=[];
 for(const features of [f,c]){
  levels.push({price:features.donchian[key],timeframe:features.timeframe,cutoff:features.cutoff,kind:'PRIOR_20_BAR_EXTREME'});
  for(const s of features.structure?.[swings]??[])if(s.confirmed_at<=features.cutoff)levels.push({price:s.price,timeframe:features.timeframe,cutoff:s.confirmed_at,kind:'CONFIRMED_SWING'});
 }
 const target=levels.filter(x=>Number.isFinite(x.price)&&side*(x.price-last.close)>0).sort((x,y)=>side*(x.price-y.price))[0];
 if(!target)return {reason:'CONTEXT_STRUCTURAL_TARGET_UNAVAILABLE'};
 const recent=b.slice(-3),stop=side>0?Math.min(...recent.map(x=>x.low))-p.stop_buffer_atr*a:Math.max(...recent.map(x=>x.high))+p.stop_buffer_atr*a;
 return {direction:side>0?'LONG':'SHORT',anchor:f.ema9,stop,target:target.price,target_source:target,trigger:CONTEXT_PATTERN,
  origin_at:prev.start,confirmation_at:last.end,reason:'PATTERN_CONFIRMED',context_regime:contextRegime.trend};
}
export function contextContract(c,detected){const body={version:CONTEXT_VERSION,policy_hash:hash(CONTEXT_POLICY),context:c,target_source:detected.target_source,context_regime:detected.context_regime};return {...body,hash:hash(body)};}
export function validateContextContract(plan){const p=plan?.quant_contract?.context_pullback;if(!p){if(plan?.pattern===CONTEXT_PATTERN)throw Error('CONTEXT_CONTRACT_REQUIRED');return false;}
 const c=p.context,s=p.target_source,q=plan.quant_contract;
 if(plan.pattern!==CONTEXT_PATTERN||p.version!==CONTEXT_VERSION||p.policy_hash!==hash(CONTEXT_POLICY)||p.hash!==hash({...p,hash:undefined})||!CONTEXT_SPEC.frames.includes(plan.timeframe)||c?.status!=='READY'||c.timeframe!==plan.timeframe_contract?.context_timeframe||c.timeframe<=plan.timeframe||c.cutoff!==Math.floor(plan.confirmed_at/(c.timeframe*60000))*c.timeframe*60000||q.context_features_hash!==hash(c)||!Number.isFinite(s?.price)||s.cutoff>plan.confirmed_at||![plan.timeframe,c.timeframe].includes(s.timeframe)||!['UPTREND','DOWNTREND'].includes(p.context_regime)||p.context_regime!==classifyQuantRegime(c).trend||(plan.direction==='LONG')!==(p.context_regime==='UPTREND'))throw Error('CONTEXT_CONTRACT_INTEGRITY');
 const source=s.timeframe===plan.timeframe?q.features:c,long=plan.direction==='LONG',known=s.kind==='PRIOR_20_BAR_EXTREME'?s.price===source.donchian[long?'high':'low']&&s.cutoff===source.cutoff:s.kind==='CONFIRMED_SWING'&&(source.structure?.[long?'highs':'lows']??[]).some(x=>x.price===s.price&&x.confirmed_at===s.cutoff);
 if(!known||s.cutoff>source.cutoff||q.fibonacci?.original_target!==s.price||(long?1:-1)*(s.price-Number(plan.target))<0)throw Error('CONTEXT_TARGET_INTEGRITY');return true;
}
