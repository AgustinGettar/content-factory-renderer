import {ACTIVE_POLICY,activeContract,validateActiveContract,activeVolumeMinimum,activeRegime} from './quant-active-paper.js';
import {FIBONACCI_POLICY,fibonacciContext,fibonacciTarget,fibonacciContract,validateFibonacci} from './quant-fibonacci.js';
import {OPPORTUNITY_POLICY,opportunityRegimeEligible,opportunityVolumeMinimum,opportunityContract,validateOpportunityContract,flowComparison,applyOpportunityEconomics} from './quant-opportunities.js';
import {CONTEXT_PATTERN,CONTEXT_SPEC,CONTEXT_POLICY,detectContextPullback,contextContract,validateContextContract} from './quant-context-pullback.js';
// Predeclared hypotheses, evaluated causally on the existing PAPER contract.
// A detection is not a probability or proof of positive expectancy.
import {D,hash} from './core.js';
import {causalBars,featureSnapshot,classifyQuantRegime,mean} from './quant-features.js';
import {SECONDARY_VERSION,SECONDARY_MODEL,secondaryFresh} from './secondary-futures-math.js';
import {explorationContract} from './secondary-exploration.js';
import {makeProfitContracts} from './secondary-profit-policy.js';
import {secondaryEconomics} from './secondary-futures-engine.js';

export const QUANT_VERSION='secondary-quant-1.0.0';
const trend=['UPTREND','DOWNTREND','BREAKOUT_EXPANSION'],range=['RANGE'];
export const QUANT_STRATEGIES=Object.freeze({
 SCALP_CONTINUATION:{title:'Scalping de continuación',frames:[1,5],regimes:trend,base:'PULLBACK'},
 SCALP_REVERSION:{title:'Scalping de reversión',frames:[1,5],regimes:range,base:'RANGE_REENTRY'},
 BREAKOUT_RETEST:{title:'Ruptura con retesteo',frames:[1,5,15,60,240],regimes:[...trend,'ERRATIC'],base:'BREAKOUT'},
 MOMENTUM:{title:'Aceleración de momentum',frames:[1,5,15,60],regimes:trend,base:'BREAKOUT'},
 TREND_FOLLOWING:{title:'Continuación de tendencia',frames:[15,60,240],regimes:trend,base:'PULLBACK'},
 MEAN_REVERSION:{title:'Retorno a VWAP',frames:[5,15,60],regimes:range,base:'RANGE_REENTRY'},
 RANGE_TRADING:{title:'Rechazo en extremo de rango',frames:[1,5,15,60],regimes:range,base:'RANGE_REENTRY'},
 VOLATILITY_EXPANSION:{title:'Expansión tras compresión',frames:[1,5,15,60,240],regimes:['BREAKOUT_EXPANSION','HIGH_VOLATILITY',...trend],base:'BREAKOUT'},
 LIQUIDITY_SWEEP:{title:'Barrido y recuperación de nivel',frames:[1,5,15,60,240],regimes:[...range,...trend,'ERRATIC'],base:'RANGE_REENTRY'},
});
export const ADVANCED_RESEARCH=Object.freeze({
 ORDER_FLOW_IMBALANCE:{authority:'NONE',requires:['CONTIGUOUS_L2_EVENTS','INDEPENDENT_OOS']},
 MICROPRICE:{authority:'OBSERVATION',requires:['OOS_PRICE_IMPACT_VALIDATION']},
 CUMULATIVE_VOLUME_DELTA:{authority:'OBSERVATION',requires:['CONTIGUOUS_TRADE_WINDOW','INDEPENDENT_OOS']},
 SESSION_OPENING_RANGE:{authority:'NONE',requires:['PREDECLARED_SESSION','INDEPENDENT_OOS']},
 ANCHORED_VWAP:{authority:'FEATURE_ONLY',requires:['COMPLETE_ANCHOR_HISTORY','INDEPENDENT_OOS']},
 VOLATILITY_TARGETING:{authority:'RISK_CAP_ONLY',requires:['NO_UPSIZING_AFTER_LOSS']},
 META_LABELING:{authority:'NONE',requires:['PURGED_TEMPORAL_LABELS','CALIBRATION','PROMOTION_APPROVAL']},
 ENSEMBLE:{authority:'DETERMINISTIC_CANDIDATE_RANKING',requires:['INDEPENDENT_OOS_FOR_LEARNED_WEIGHTS']},
 REGIME_CHANGE:{authority:'DETERMINISTIC_ROUTING',requires:['OOS_VALIDATION_FOR_EDGE_CLAIM']},
 FUNDING_BASIS:{authority:'NONE',requires:['TWO_COMPATIBLE_CONTRACTS','HEDGE_ACCOUNT_MODEL','BOTH_LEG_COSTS','INDEPENDENT_OOS']},
 GRID:{authority:'NONE',requires:['INVENTORY_LIMITS','QUEUE_MODEL','INDEPENDENT_OOS']},
 MARKET_MAKING:{authority:'NONE',requires:['L2_QUEUE_MODEL','ADVERSE_SELECTION','INDEPENDENT_OOS']},
 STATISTICAL_ARBITRAGE:{authority:'NONE',requires:['MULTI_ASSET_DATA','COINTEGRATION_STABILITY','INDEPENDENT_OOS']},
});
export const QUANT_POLICY=Object.freeze({version:QUANT_VERSION,mode:'PAPER',realTrading:false,ledger:'FREQUENT_PAPER',symbol:'PF_XBTUSD',
 strategies:QUANT_STRATEGIES,min_net_rr:1,min_relative_volume:.8,max_spread_bps:8,max_stop_atr:3,minimum_history:64,
 regime_authority:'ROUTE_NEW_SIGNALS',neural_authority:'NONE_FOR_NEW_DOMAIN',advanced:ADVANCED_RESEARCH,
 daily_loss_fraction:.03,drawdown_fraction:.10,partial_exit_authority:'REPLAY_ONLY_UNTIL_INDEPENDENT_VALIDATION',
 parameter_status:'FIXED_EXPERIMENTAL_NOT_PROVEN_PROFITABLE',existing_contracts:'PRESERVED'});
export const quantStrategySpecs=(contextual=false)=>contextual?{...QUANT_STRATEGIES,[CONTEXT_PATTERN]:CONTEXT_SPEC}:QUANT_STRATEGIES;
export function getQuantProfile(root){const p=root?.secondaryExecution?.quant;if(!p)return null;
 if(p.version!==QUANT_VERSION||p.policy_hash!==hash(QUANT_POLICY)||hash(p.policy)!==p.policy_hash||typeof p.active!=='boolean')throw Error('QUANT_POLICY_INTEGRITY');return p.active?p:null;}
export function installQuant(root,env,now,event=()=>{}){
 const old=root.secondaryExecution?.quant;if(old)getQuantProfile(root);
 const flag=env.LUMI_TRADING_SECONDARY_QUANT;
 if(!flag){if(old?.active)throw Error('QUANT_FLAG_REQUIRED');return false;}
 if(env.LUMI_TRADING_MODE!=='PAPER'||env.LUMI_RUNTIME_ENV!=='staging'||env.LUMI_TRADING_STORAGE!=='SQLITE')throw Error('QUANT_PAPER_ONLY');
 if(flag==='OFF'){if(!old?.active)return false;old.active=false;old.disabled_at=now;return true;}
 if(flag!==QUANT_VERSION)throw Error('QUANT_VERSION_UNSUPPORTED');
 if(root.secondaryExecution.profit_policy?.version!=='secondary-profit-policy-2.0.0')throw Error('QUANT_REQUIRES_EARLY_PROTECTION_POLICY');
 if(root.secondaryExecution.timeframe_execution?.version!=='secondary-timeframes-2.0.0'||!['secondary-risk-budget-2.0.0','secondary-risk-budget-3.0.0'].includes(root.secondaryExecution.risk_budget?.version))throw Error('QUANT_REQUIRES_TIMEFRAME_AND_RISK_V2');
 if(old?.active){old.fibonacci={...FIBONACCI_POLICY,policy_hash:hash(FIBONACCI_POLICY)};return false;}const a=root.frequency.account;
 root.secondaryExecution.quant={...(old??{}),version:QUANT_VERSION,active:true,fibonacci:{...FIBONACCI_POLICY,policy_hash:hash(FIBONACCI_POLICY)},policy:structuredClone(QUANT_POLICY),policy_hash:hash(QUANT_POLICY),activated_at:old?.activated_at??now,updated_at:now,
  baseline:old?.baseline??{at:now,equity:a.equity,cash:a.cash,net:a.net,closed:a.closed},guard:old?.guard??{day:new Date(now).toISOString().slice(0,10),day_start:a.equity,peak:a.equity},counts:old?.counts??{evaluations:0,candidates:0,errors:0}};
 event({type:'SECONDARY_QUANT_ENABLED',at:now,version:QUANT_VERSION,policy_hash:hash(QUANT_POLICY),strategies:Object.keys(QUANT_STRATEGIES),realTrading:false,ledger:'FREQUENT_PAPER',capital_added:'0'});return true;
}
export function quantPortfolioGuard(root,now){
 const p=getQuantProfile(root);if(!p)return {accepted:true};const g=p.guard,eq=Number(root.frequency.account.equity),day=new Date(now).toISOString().slice(0,10);
 if(!(eq>0))return {accepted:false,reason:'QUANT_EQUITY_INVALID'};
 if(g.day!==day){const boundary=Math.floor(now/86400000)*86400000;if(g.last_mark&&boundary-g.last_mark.at>=0&&boundary-g.last_mark.at<=90000&&now-boundary<=90000){p.daily_equity??=[];p.daily_equity.push({at:boundary,equity:g.last_mark.equity});p.daily_equity=p.daily_equity.slice(-366);}g.day=day;g.day_start=String(eq);g.daily_blocked=false;}
 g.last_mark={at:now,equity:eq};
 g.peak=String(Math.max(Number(g.peak),eq));g.daily_loss_fraction=Math.max(0,1-eq/Number(g.day_start));g.drawdown_fraction=Math.max(0,1-eq/Number(g.peak));
 g.daily_blocked=g.daily_blocked||g.daily_loss_fraction>=p.policy.daily_loss_fraction;g.review_required=g.review_required||g.drawdown_fraction>=p.policy.drawdown_fraction;g.at=now;
 return {accepted:!g.daily_blocked&&!g.review_required,reason:g.review_required?'QUANT_DRAWDOWN_REVIEW_REQUIRED':g.daily_blocked?'QUANT_DAILY_LOSS_LIMIT':'QUANT_RISK_AVAILABLE',...g};
}
const round=(v,t,up=false)=>D(v).div(t)[up?'ceil':'floor']().mul(t).toNumber();
// Public for deterministic testing/research. Inputs contain CLOSED bars only.
export function detectQuantPattern(id,b,f,context,regime,{opportunities=false,active=false}={}){
 const spec=QUANT_STRATEGIES[id];if(!spec)return {reason:'STRATEGY_UNKNOWN'};
 if(active)regime=activeRegime(spec,regime,f);
 if(!spec.frames.includes(f.timeframe))return {reason:'STRATEGY_TIMEFRAME_NOT_ENABLED'};
 if(!(opportunities?opportunityRegimeEligible(spec,regime):spec.regimes.includes(regime.regime)))return {reason:'REGIME_NOT_ELIGIBLE'};
 if(regime.regime==='ILLIQUID'||f.microstructure.spread_bps==null||f.microstructure.spread_bps>8)return {reason:'LIQUIDITY_NOT_CONFIRMED'};
 const volumeMinimum=opportunities?opportunityVolumeMinimum(id,regime):.8;
 if(!(f.atr14>0)||f.relative_volume==null||f.relative_volume<(active?activeVolumeMinimum(id,volumeMinimum):volumeMinimum))return {reason:'VOLUME_NOT_CONFIRMED'};
 const last=b.at(-1),prev=b.at(-2),prior=b.slice(0,-1),a=f.atr14,span=last.high-last.low,body=span?(last.close-last.open)/span:0;
 const high=Math.max(...prior.slice(-20).map(x=>x.high)),low=Math.min(...prior.slice(-20).map(x=>x.low));
 const up=f.ema9>f.ema21&&f.plus_di>f.minus_di,down=f.ema9<f.ema21&&f.minus_di>f.plus_di;
 const contextUp=context.ema9>context.ema21&&context.normalized_slope>=0,contextDown=context.ema9<context.ema21&&context.normalized_slope<=0;
 const againstLong=context.adx>=30&&contextDown,againstShort=context.adx>=30&&contextUp;
 let side=0,anchor=null,origin=last,trigger=id,target=null;
 if(id==='SCALP_CONTINUATION'||id==='TREND_FOLLOWING'){
  const touchLong=Math.min(prev.low,last.low)<=Math.max(f.ema9,f.ema21),touchShort=Math.max(prev.high,last.high)>=Math.min(f.ema9,f.ema21);
  if(up&&contextUp&&touchLong&&body>.2&&last.close>prev.close&&last.close>f.ema9){side=1;anchor=f.ema9;origin=prev;}
  if(down&&contextDown&&touchShort&&body<-.2&&last.close<prev.close&&last.close<f.ema9){side=-1;anchor=f.ema9;origin=prev;}
  if(side)target=side>0?high:low;
 }else if(['SCALP_REVERSION','MEAN_REVERSION','RANGE_TRADING'].includes(id)){
  if(regime.accelerated||context.adx>=30)return {reason:'REVERSAL_AGAINST_STRONG_TREND'};
  const lower=id==='RANGE_TRADING'?low:f.bollinger.lower,upper=id==='RANGE_TRADING'?high:f.bollinger.upper;
  if(last.low<=lower+.15*a&&last.close>lower&&body>.1&&last.close>prev.close&&f.rsi14<55){side=1;anchor=lower;}
  if(last.high>=upper-.15*a&&last.close<upper&&body<-.1&&last.close<prev.close&&f.rsi14>45){side=-1;anchor=upper;}
  target=id==='MEAN_REVERSION'?f.vwap20:(high+low)/2;
 }else if(id==='BREAKOUT_RETEST'){
  // Freeze the level BEFORE the breakout; retest must be on a later candle.
  for(let offset=2;offset<=5&&!side;offset++){
   const i=b.length-offset,breakBar=b[i],before=b.slice(i-20,i),hi=Math.max(...before.map(x=>x.high)),lo=Math.min(...before.map(x=>x.low)),rv=mean(before.map(x=>x.volume));
   if(breakBar.volume<1.2*rv)continue;
   if(breakBar.close>hi+.1*a&&last.low<=hi+.2*a&&last.low>=hi-.5*a&&last.close>hi&&body>.15&&!againstLong){side=1;anchor=hi;origin=breakBar;}
   if(breakBar.close<lo-.1*a&&last.high>=lo-.2*a&&last.high<=lo+.5*a&&last.close<lo&&body<-.15&&!againstShort){side=-1;anchor=lo;origin=breakBar;}
  }
 }else if(id==='MOMENTUM'){
  if(f.relative_volume>=1.5&&Math.abs(body)>=.6&&Math.abs(last.close-f.ema9)<=2*a){
   if(up&&last.close>high&&!againstLong&&f.macd_histogram>0){side=1;anchor=high;}
   if(down&&last.close<low&&!againstShort&&f.macd_histogram<0){side=-1;anchor=low;}
  }
 }else if(id==='VOLATILITY_EXPANSION'){
  const ranges=prior.slice(-20).map(x=>x.high-x.low),compression=mean(ranges.slice(-5))<=.7*mean(ranges.slice(0,15));
  if(compression&&span>=1.5*mean(ranges.slice(-5))&&f.relative_volume>=1.3){
   if(last.close>high&&body>.5&&!againstLong){side=1;anchor=high;}
   if(last.close<low&&body<-.5&&!againstShort){side=-1;anchor=low;}
  }
 }else if(id==='LIQUIDITY_SWEEP'){
  if(last.low<low-.1*a&&last.close>low&&body>.2&&last.close-last.low>=.65*span&&!againstLong){side=1;anchor=low;}
  if(last.high>high+.1*a&&last.close<high&&body<-.2&&last.high-last.close>=.65*span&&!againstShort){side=-1;anchor=high;}
  target=(high+low)/2;
 }
 if(!side)return {reason:'WAIT_'+id};
 const local=b.slice(-3),stop=side>0?Math.min(...local.map(x=>x.low))-.15*a:Math.max(...local.map(x=>x.high))+.15*a;
 if(target==null)target=last.close+side*Math.min(3*a,Math.max(2*a,(high-low)*.5));
 // One excursion cannot produce another signal merely by advancing the clock.
 let originIndex=b.indexOf(origin);
 if(['SCALP_CONTINUATION','TREND_FOLLOWING'].includes(id))while(originIndex>20&&(side>0?b[originIndex-1].low<=f.ema9:b[originIndex-1].high>=f.ema9))originIndex--;
 return {direction:side>0?'LONG':'SHORT',anchor,stop,target,trigger,origin_at:b[originIndex].start,confirmation_at:last.end,reason:'PATTERN_CONFIRMED'};
}
export function quantCandidates(series,q,meta,cutoff,now,rate,policy,profitPolicy,{timeframe,contextTimeframe,timeframeVersion,opportunities=false,contextual=false,active=false,analytics=null}={}){
 if((contextual||active)&&!opportunities)throw Error('CONTEXT_OPPORTUNITIES_REQUIRED');
 const strategies=quantStrategySpecs(contextual),specs=Object.keys(strategies),reject=reason=>specs.map(pattern=>({pattern,reason,facts:{quant_version:QUANT_VERSION,timeframe}}));
 if(!secondaryFresh(q,now))return reject('FUTURES_DATA_NOT_FRESH');
 if(!Number.isFinite(rate))return reject('FUNDING_NOT_AVAILABLE');
 if(!(meta?.tick_size>0)||!(meta?.qty_step>0)||!policy||!profitPolicy)return reject('QUANT_CONTRACT_CONTEXT_REQUIRED');
 const tier=meta.margin_schedule?.[0],nextTier=meta.margin_schedule?.[1];
 if(!tier||tier.numNonContractUnits!==0||tier.initialMargin!==.1||tier.maintenanceMargin!==.05||!(nextTier?.numNonContractUnits>=30000000))return reject('QUANT_MARGIN_SCHEDULE_UNVERIFIED');
 if(q.mark_price==null||!(Number(q.mark_price)>0))return reject('QUANT_MARK_PRICE_UNAVAILABLE');
 const contextCutoff=Math.floor(cutoff/(contextTimeframe*60000))*contextTimeframe*60000;
 const b=causalBars(series[timeframe],{timeframe,cutoff,now}),f=featureSnapshot(series[timeframe],{timeframe,cutoff,now,quote:q}),c=featureSnapshot(series[contextTimeframe],{timeframe:contextTimeframe,cutoff:contextCutoff,now,quote:q});
 if(!b||f.status!=='READY'||c.status!=='READY')return reject('CONTEXT_NOT_SYNCHRONIZED');
 if(opportunities)f.public_analytics=analytics?.status==='READY'?analytics:null;
 const minimumRR=active?ACTIVE_POLICY.min_net_rr:QUANT_POLICY.min_net_rr,maxStopATR=active?ACTIVE_POLICY.max_stop_atr:QUANT_POLICY.max_stop_atr;
 const regime=classifyQuantRegime(f),contracts=makeProfitContracts(profitPolicy,{timeframe});
 if(opportunities)applyOpportunityEconomics(contracts,timeframe);
 return specs.map(pattern=>{
  const contextualPattern=pattern===CONTEXT_PATTERN,detected=contextualPattern?detectContextPullback(b,f,c):detectQuantPattern(pattern,b,f,c,regime,{opportunities,active}),facts={quant_version:QUANT_VERSION,timeframe,regime:regime.regime,regime_detail:regime,atr:f.atr14,adx:f.adx,relative_volume:f.relative_volume,feature_hash:hash(f),pattern_detected:!!detected.direction,...(contextualPattern?{context_regime:classifyQuantRegime(c).trend,context_timeframe:contextTimeframe,target_source:detected.target_source??null}:{}),...(opportunities?{opportunity_version:OPPORTUNITY_POLICY.version,minimum_relative_volume:contextualPattern?CONTEXT_POLICY.min_relative_volume:active?activeVolumeMinimum(pattern,opportunityVolumeMinimum(pattern,regime)):opportunityVolumeMinimum(pattern,regime),minimum_net_rr:minimumRR,max_stop_atr:maxStopATR}:{})};
  if(!detected.direction)return {pattern,reason:detected.reason,facts};
  const short=detected.direction==='SHORT',sign=short?-1:1,tick=meta.tick_size,base=strategies[pattern].base;
  let execution=explorationContract(policy,base,now);
  const limit=round(short?Math.max(Number(q.ask),detected.anchor):Math.min(Number(q.bid),detected.anchor),tick,short);
  let taker=execution.mode==='TAKER_IOC',entry=taker?round(Number(short?q.bid:q.ask)*(1+sign*Number(execution.slippage)),tick,!short):limit;
  const fib=fibonacciContext(b,{direction:detected.direction,atr:f.atr14,cutoff,timeframe}),fibTarget=fibonacciTarget(fib,entry,detected.target);
  const stop=round(detected.stop,tick,short);let target=round(fibTarget.target,tick,short),distance=sign*(entry-stop);
  let econ=secondaryEconomics(entry,stop,target,detected.direction,rate,execution,contracts.economic_policy.funding_estimation_ms);
  const immediate={mode:execution.mode,entry,stop,target,...econ};let executionReason=econ.gain>0&&econ.loss>0&&econ.netRR>=minimumRR&&econ.gain/entry>=Number(contracts.economic_policy.min_expected_net_target_fraction)?'IMMEDIATE_NET_RR_VALID':'IMMEDIATE_ECONOMICS_REJECTED';
  // Passive orders are an alternative only; never pretend a touch is a fill.
  // Momentum/breakout expansion cannot be converted to a late chasing order.
  if(opportunities&&taker&&!(econ.gain>0&&econ.netRR>=minimumRR&&econ.gain/entry>=Number(contracts.economic_policy.min_expected_net_target_fraction))&&OPPORTUNITY_POLICY.passive_entry_patterns.includes(pattern)&&Math.abs(limit-Number(short?q.ask:q.bid))<=OPPORTUNITY_POLICY.passive_max_distance_atr*f.atr14){
   const makerPolicy={...policy,modes:{...policy.modes,[base]:'MAKER_LIMIT'},makerExpiryMs:Math.min(OPPORTUNITY_POLICY.passive_max_wait_ms,timeframe*120000)};
   const candidate=explorationContract(makerPolicy,base,now),makerTarget=round(fibonacciTarget(fib,limit,detected.target).target,tick,short),makerEcon=secondaryEconomics(limit,stop,makerTarget,detected.direction,rate,candidate,contracts.economic_policy.funding_estimation_ms);
   if(makerEcon.gain>0&&makerEcon.loss>0&&makerEcon.netRR>=minimumRR&&makerEcon.gain/limit>=Number(contracts.economic_policy.min_expected_net_target_fraction)&&sign*(limit-stop)>0&&sign*(limit-stop)<=maxStopATR*f.atr14&&sign*(makerTarget-limit)>0){execution=candidate;taker=false;entry=limit;target=makerTarget;distance=sign*(entry-stop);econ=makerEcon;executionReason='PASSIVE_ONLY_NET_RR_VALID';}
  }
  const fibonacci=fibonacciContract(fib,entry,detected.target,target);
  const detail={...facts,...econ,entry,stop,target,fibonacci:{version:fib.version,status:fib.status,reason:fib.reason,confluence:fib.confluence,confirmed_level:fib.confirmed_level??null,target_limited:fibTarget.limited},stop_atr:distance/f.atr14,...(opportunities?{execution_comparison:{immediate,selected_mode:execution.mode,reason:executionReason},flow_comparison:flowComparison(analytics,detected.direction)}:{})};
  const invalid=!(entry>0&&stop>0&&target>0)?'NUMERIC_PLAN_INVALID':sign*(target-entry)<=0?'STRUCTURAL_TARGET_ALREADY_PASSED':distance<=0?'QUANT_STOP_ALREADY_INVALIDATED':distance>maxStopATR*f.atr14?'QUANT_STOP_TOO_WIDE':null;
  if(invalid)return {pattern,reason:invalid,facts:detail};
  if(!(econ.gain>0&&econ.loss>0&&econ.netRR>=minimumRR))return {pattern,reason:'QUANT_COST_OR_NET_RR',facts:detail};
  const ctx={version:'secondary-quant-context-1.0.0',symbol:'PF_XBTUSD',pattern,direction:detected.direction,timeframe,structure_key:hash([QUANT_VERSION,timeframe,pattern,detected.direction,detected.origin_at,round(detected.anchor,tick)]),confirmation_key:hash([QUANT_VERSION,timeframe,pattern,detected.direction,detected.origin_at]),confirmation_kind:detected.trigger,confirmation_event_start_at:detected.origin_at,confirmation_event_at:detected.confirmation_at,confirmation_at:cutoff,structure_at:detected.origin_at,structure_level:String(round(detected.anchor,tick)),price_tick:String(tick),structural_target:String(target),remaining_distance:String(sign*(target-entry)),remaining_distance_fraction:String(sign*(target-entry)/entry),data_basis:'CLOSED_CAUSAL_BARS'};
  ctx.movement_key=ctx.structure_key;
  const quant={version:QUANT_VERSION,fibonacci,policy_hash:hash(QUANT_POLICY),strategy:pattern,regime:regime.regime,features:f,context_features_hash:hash(c),margin_reference:{verified:true,source:meta.margin_schedule_source??'PUBLIC_INSTRUMENT_EUROPA_RETAIL_REFERENCE',checked_at:meta.checked_at,initial_margin:.1,maintenance_margin:.05,tier_cap_usd:nextTier.numNonContractUnits,schedule_hash:hash(meta.margin_schedule)},statistically_validated:false,probability:null};
  if(active)quant.active_experiment=activeContract();
  if(contextualPattern)quant.context_pullback=contextContract(c,detected);
  if(opportunities)quant.opportunities=opportunityContract({execution_mode:execution.mode,execution_reason:executionReason,immediate_economics:immediate,flow_authority:OPPORTUNITY_POLICY.flow_authority,flow_comparison:flowComparison(analytics,detected.direction),analytics});quant.hash=hash(quant);
  const plan={id:hash([QUANT_VERSION,timeframe,pattern,cutoff]),signal_key:ctx.confirmation_key,version:SECONDARY_VERSION,entry_revision:profitPolicy.entryRevision,execution_model:SECONDARY_MODEL,instrument:'PAPER:KRAKEN_FUTURES:PF_XBTUSD',family:'L',pattern,recipe:pattern,recipe_title:strategies[pattern].title,direction:detected.direction,timeframe,entry:String(entry),limit:String(limit),stop:String(stop),target:String(target),confirmed_at:cutoff,decision_at:now,expires_at:execution.expires_at,holding_ms:contracts.exit_policy.base_holding_ms,order:taker?'FUTURES_TAKER_IOC':'FUTURES_POST_ONLY_LIMIT',fill_model:execution.liquidity_model,execution_contract:execution,economics:econ,...contracts,entry_context:ctx,quant_contract:quant,experiment:true,quality:{classification:'QUANT_EXPERIMENTAL',validated:false,expected_net_positive:true,net_rr:econ.netRR,labels:[]},
   timeframe_contract:{version:timeframeVersion,timeframe,context_timeframe:contextTimeframe,source:'KRAKEN_FUTURES_TRADE_CANDLES',closed_candles_only:true},context:{symbol:'PF_XBTUSD',stopTf:timeframe,targetTf:detected.target_source?.timeframe??timeframe,contextTf:contextTimeframe,holdingMs:contracts.exit_policy.base_holding_ms},criteria:['REGIME_ROUTED','CAUSAL_PATTERN',active?'NET_RR_AT_LEAST_0_8':'NET_RR_AT_LEAST_1','POST_LATENCY_ECONOMICS_REQUIRED','AGGREGATE_RISK_REQUIRED'],study:{prediction:{status:'UNAVAILABLE',event:'NET_POSITIVE_AT_CLOSE'}}};
  plan.evidence={schema:1,at:now,signal_at:cutoff,decision_at:now,default_tf:timeframe,closed_bars:true,input_hash:hash({b,context:c}),decision_quote:q,panels:[{tf:timeframe,candles:b.slice(-80),lines:[]}],levels:[{name:'Confirmación causal',value:detected.anchor},...fib.levels.map(l=>({name:'Fib '+(l.ratio*100).toFixed(1)+'%',value:l.price})),...fib.extensions.map(l=>({name:'Fib extensión '+(l.ratio*100).toFixed(1)+'%',value:l.price}))],facts:Object.entries(detail).map(([label,value])=>({label,value})),rules:['Hipótesis PAPER sin rentabilidad demostrada.','Régimen y contexto cerrados; ejecución posterior con costes y liquidez observados.']};
  return {pattern,reason:'CANDIDATE',facts:detail,plan};
 });
}
export function validateQuantContract(plan){const q=plan?.quant_contract;if(!q)return false;
 if(q.version!==QUANT_VERSION||q.hash!==hash({...q,hash:undefined})||q.policy_hash!==hash(QUANT_POLICY)||q.strategy!==plan.pattern||!quantStrategySpecs(!!q.context_pullback)[q.strategy]?.frames.includes(plan.timeframe)||q.probability!==null||q.statistically_validated!==false||q.features?.cutoff!==plan.confirmed_at||q.features?.timeframe!==plan.timeframe||q.features?.status!=='READY')throw Error('QUANT_CONTRACT_INTEGRITY');validateFibonacci(plan);validateOpportunityContract(plan);validateContextContract(plan);validateActiveContract(plan);return true;}
