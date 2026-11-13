// Advisory-only exit experiment. No I/O, broker authority, or mutable references.
import {D, hash} from './core.js';
import {secondaryFresh} from './secondary-futures-math.js';
export const HORIZON_SHADOW_VERSION = 'secondary-horizon-shadow-1.0.0';
export const HORIZON_SHADOW_POLICY = Object.freeze({version:HORIZON_SHADOW_VERSION,authority:'NONE',mode:'SHADOW',
 atr_period:14,activation_risk_fraction:'0.25',atr_fraction:'0.5',retracement_fraction:'0.25',
 adverse_retracement_fraction:'0.20',supportive_retracement_fraction:'0.30',partial_fraction:'0.30',
 minimum_fragment_net:'0.10',flow_max_age_ms:5000,max_risk_multiplier:'1.25',timeframes:Object.freeze([1,5,15,60,240])});
const finite=x=>x!==null&&x!==undefined&&x!==''&&Number.isFinite(Number(x));
const positive=x=>finite(x)&&D(x).gt(0);
const max=(...xs)=>xs.reduce((a,b)=>D(a).gte(b)?D(a):D(b));
const freeze=x=>{if(x&&typeof x==='object'){for(const v of Object.values(x))freeze(v);Object.freeze(x);}return x;};
const action=(kind,reason,more={})=>({action:kind,reason,...more});
const baseline=reason=>action(reason==='ACTIVE_SCALE_OUT'?'REDUCE':reason?'CLOSE':'HOLD',reason??'BASELINE_HOLD');
const protective=reason=>!!reason&&/^(STOP|ISOLATED_MARGIN|TECHNICAL|QUANT_TECHNICAL|STRUCTURAL|RISK|PORTFOLIO|LIQUIDATION|MANUAL|DATA_GAP|TIMEOUT)/.test(reason);

export function causalOriginContext(series,timeframe,now){
 const duration=timeframe*60000, rows=series?.[timeframe];
 if(!Array.isArray(rows))return {valid:false,reason:'ORIGIN_CANDLES_MISSING'};
 const bars=rows.filter(b=>Number.isSafeInteger(b.end)&&b.end<=now&&Number.isSafeInteger(b.received_at??b.available_at)&&(b.received_at??b.available_at)<=now).slice(-15);
 if(bars.length!==15||bars.some((b,i)=>!Number.isSafeInteger(b.start)||b.end-b.start!==duration||i>0&&b.start!==bars[i-1].end||!['high','low','close'].every(k=>positive(b[k]))||D(b.low).gt(b.high)||D(b.close).lt(b.low)||D(b.close).gt(b.high)))return {valid:false,reason:'ORIGIN_CANDLES_INCOMPLETE_OR_NONCAUSAL'};
 if(now-bars.at(-1).end>duration)return {valid:false,reason:'ORIGIN_CANDLES_STALE'};
 const ranges=bars.slice(1).map((b,i)=>max(D(b.high).minus(b.low),D(b.high).minus(bars[i].close).abs(),D(b.low).minus(bars[i].close).abs()));
 const atr=ranges.reduce((s,x)=>s.plus(x),D(0)).div(14);
 return {valid:atr.gt(0),reason:atr.gt(0)?null:'ORIGIN_ATR_ZERO',atr_usd_per_btc:atr.toString(),timeframe_minutes:timeframe,
  candle_end:bars.at(-1).end,received_at:Math.max(...bars.map(b=>b.received_at??b.available_at)),
  structure_low:String(bars.at(-1).low),structure_high:String(bars.at(-1).high),
  completed_close:String(bars.at(-1).close),previous_close:String(bars.at(-2).close),input_hash:hash(bars)};
}
// The adapter supplies normalized evidence. A large book order alone cannot act.
export function directionalFlow(flow,direction,now){
 const available=flow?.available===true||flow?.valid===true;
 const received=flow?.received_at??flow?.as_of_received_at;
 const market=flow?.event_at??flow?.market_at??flow?.as_of;
 if(!available||!Number.isSafeInteger(received)||received>now||now-received>5000||(!Number.isSafeInteger(market)||market>now+1000||now-market>5000))return {usable:false,reason:'FLOW_UNAVAILABLE_STALE_OR_NONCAUSAL',directional_score:0};
 const band=flow.bands?.find(b=>Number(b.bps??b.band_bps)===10)??flow.bands?.[0];
 const imbalance=flow.imbalance??band?.imbalance;
 const delta=flow.aggressive_net_btc??flow.trades?.net_btc??flow.trades?.aggressive_net_btc;
 const total=flow.aggressive_volume_btc??flow.trades?.total_btc??flow.trades?.volume_btc;
 const persistence=flow.persistence_ms??band?.persistence_ms??flow.book?.persistence_ms;
 if(!finite(imbalance)||!finite(delta)||!positive(total)||!finite(persistence)||Number(persistence)<3000)return {usable:false,reason:'FLOW_NOT_CORROBORATED',directional_score:0};
 const book=Number(imbalance),aggressor=Math.max(-1,Math.min(1,Number(delta)/Number(total))),sign=direction==='SHORT'?-1:1;
 const corroborated=Math.sign(book)===Math.sign(aggressor)&&Math.abs(book)>=.15&&Math.abs(aggressor)>=.15;
 return {usable:true,reason:corroborated?'BOOK_AND_TRADES_CORROBORATED':'NO_DIRECTIONAL_CORROBORATION',corroborated,
  directional_score:corroborated?sign*(book+aggressor)/2:0,received_at:received,event_at:market??null,
  imbalance:book,aggressive_net_btc:String(delta),aggressive_volume_btc:String(total),persistence_ms:Number(persistence),
  source_hash:flow.hash??hash(flow)};
}
function partial(p,v,uncertainty,state,now,reason){
 const step=p.plan.sizing?.qty_step,initial=p.initial_qty??p.plan.sizing?.qty??p.qty;
 if(!positive(step)||!positive(initial)||!v.liquidity_ok)return null;
 const qty=D(initial).mul('.30').div(step).floor().mul(step);
 if(!qty.gt(0)||D(p.qty).minus(qty).lt(step)||D(p.closed_qty??0).gte(qty)||state.partial_basis!==undefined)return null;
 const net=D(v.net).mul(qty).div(p.qty),remaining=D(v.net).minus(net),u=D(uncertainty).mul(qty).div(p.qty);
 if(net.lt(max('.10',u))||remaining.lte(D(uncertainty).minus(u)))return null;
 state.partial_basis=String(p.qty);
 return action('REDUCE',reason,{quantity_btc:qty.toString(),fraction:'0.30',estimated_fragment_net_usd:net.toString(),
  estimated_remaining_net_usd:remaining.toString(),proposal_id:hash([p.plan.id,HORIZON_SHADOW_VERSION,'REDUCE']),
  proposed_at:now,execution_required:true,filled:false});
}
function branch(input,old,context,flow,useFlow){
 const {position:p,quote:q,valuation:v,now,controlReason}=input,base=baseline(controlReason),qty=D(p.qty);
 const s=structuredClone(old??{peak_per_btc:null,floor_per_btc:null,last_quote_at:null,last_candle_end:null,armed_at:null});
 const result=(decision,extra={})=>({decision,state:s,...extra});
 const short=p.plan.direction==='SHORT';
 if(short?D(q.ask).gte(p.plan.stop):D(q.bid).lte(p.plan.stop))return result(action('CLOSE','STOP'));
 const technical=p.quant_management?.stop;
 if(positive(technical)&&(short?D(q.ask).gte(technical):D(q.bid).lte(technical)))return result(action('CLOSE','TECHNICAL_STOP'));
 if(protective(controlReason))return result(base);
 if(p.exit_intent)return result(action(p.exit_intent.reason==='ACTIVE_SCALE_OUT'?'REDUCE':'CLOSE','EXISTING_DURABLE_INTENT',{intent_reason:p.exit_intent.reason}));
 const deadline=p.profit_protection?.effective_expires_at??p.expires_at;
 if(Number.isSafeInteger(deadline)&&now>=deadline)return result(action('CLOSE','TIMEOUT'));
 if(!context.valid||!positive(p.plan.sizing?.risk)||!positive(p.plan.sizing?.qty))return result(base,{fallback:context.reason??'RISK_UNKNOWN'});
 if(!v.funding_complete||!v.result_final||!v.liquidity_ok||!secondaryFresh(q,now))return result(base,{fallback:'VALUATION_OR_EXECUTABLE_LIQUIDITY_INCOMPLETE'});
 if(s.last_quote_at!==null&&q.event_at<=s.last_quote_at)return result(action('HOLD','REPEATED_OR_OLD_OBSERVATION'),{duplicate:true});
 s.last_quote_at=q.event_at;
 // Unknown latency is visible, never silently a learned zero-risk estimate.
 const buffer=p.execution_buffer;
 const knownBuffer=finite(buffer?.buffer_per_btc)&&D(buffer.buffer_per_btc).gte(0)&&buffer.at<=now&&now-buffer.at<=5000&&buffer.samples>=8;
 const contractFloor=D(p.entry).mul(p.plan.exit_policy?.execution_uncertainty_fraction??'.0001');
 const executable=input.flow?.execution,expectedSide=p.plan.direction==='SHORT'?'buy':'sell';
 const sideMatches=executable?.side===expectedSide||executable?.side===(expectedSide==='buy'?'ask':'bid');
 const bookCostKnown=useFlow&&flow.usable&&executable?.complete===true&&sideMatches&&positive(executable.quantity_btc)&&D(executable.quantity_btc).eq(qty)&&finite(executable.impact_usd)&&D(executable.impact_usd).gte(0)&&finite(v.slippage_cost);
 // Broker price already contains spread and modeled slippage. Only excess
 // depth cost informs uncertainty; neither amount is debited again here.
 const extraDepth=bookCostKnown?max(0,D(executable.impact_usd).minus(v.slippage_cost)):D(0);
 const uncertaintyUnit=max(contractFloor,knownBuffer?buffer.buffer_per_btc:0,extraDepth.div(qty));
 const uncertainty=uncertaintyUnit.mul(qty),plannedRisk=D(p.plan.sizing.risk).mul(qty).div(p.plan.sizing.qty);
 const risk=positive(p.remaining_risk)?D(p.remaining_risk):plannedRisk;
 const vol=D(context.atr_usd_per_btc).mul('.5').mul(qty);
 const threshold=max(risk.mul('.25'),vol,uncertainty);
 const unit=D(v.net).div(qty),newCandle=s.last_candle_end!==context.candle_end;
 if(s.peak_per_btc===null||unit.gt(s.peak_per_btc))s.peak_per_btc=unit.toString();
 const corroborated=useFlow&&flow.usable&&flow.corroborated;
 const fraction=corroborated?(flow.directional_score<0?'.20':'.30'):'.25';
 const allowance=max(D(s.peak_per_btc).mul(fraction),D(context.atr_usd_per_btc).mul('.5'),uncertaintyUnit);
 const proposedFloor=D(s.peak_per_btc).minus(allowance);
 if(newCandle){s.last_candle_end=context.candle_end;
  if(unit.mul(qty).gte(threshold)&&proposedFloor.gt(uncertaintyUnit)){
   s.armed_at??=now;s.floor_per_btc=max(s.floor_per_btc??proposedFloor,proposedFloor).toString();
  }
 }
 const metrics={activation_usd:threshold.toString(),risk_usd:risk.toString(),risk_basis:positive(p.remaining_risk)?'BROKER_REMAINING_RISK':'PLANNED_PROPORTIONAL_ESTIMATE',planned_proportional_risk_usd:plannedRisk.toString(),atr_usd_per_btc:context.atr_usd_per_btc,
  uncertainty_usd:uncertainty.toString(),latency_samples_available:knownBuffer,additional_depth_uncertainty_usd:bookCostKnown?extraDepth.toString():null,depth_cost_already_in_slippage_excluded:true,floor_usd:s.floor_per_btc===null?null:D(s.floor_per_btc).mul(qty).toString(),
  allowance_usd:allowance.mul(qty).toString(),flow_used:!!corroborated,remaining_quantity_btc:p.qty};
 if(s.floor_per_btc!==null&&unit.lte(s.floor_per_btc))return result(action('CLOSE','HORIZON_TRAILING_RETRACEMENT'),{metrics});
 const exhausted=short?D(context.completed_close).gt(context.previous_close):D(context.completed_close).lt(context.previous_close);
 if(newCandle&&s.armed_at!==null&&(exhausted||corroborated&&flow.directional_score<-.25)){
  const reduce=partial(p,v,uncertainty,s,now,'HORIZON_PARTIAL_PROTECT_AND_RUN');if(reduce)return result(reduce,{metrics});
 }
 return result(action('HOLD',s.armed_at===null?'HORIZON_NOT_ARMED':'HORIZON_KEEP_THESIS'),{metrics});
}
export function evaluateHorizonShadow(input,previousState=null){
 const {position:p,quote:q,valuation:rawValue,now,controlReason}=input;
 const v=rawValue&&{...rawValue,liquidity_ok:input.availableQty!==undefined?finite(input.availableQty)&&D(input.availableQty).gte(p?.qty??0):rawValue.liquidity_ok};
 input={...input,valuation:v};
 if(!p?.plan||p.plan.instrument!=='PAPER:KRAKEN_FUTURES:PF_XBTUSD'||p.plan.execution_contract?.realTrading!==false||!HORIZON_SHADOW_POLICY.timeframes.includes(p.plan.timeframe)||!positive(p.qty)||!positive(p.plan.stop)||!['LONG','SHORT'].includes(p.plan.direction))throw Error('SHADOW_SECONDARY_PAPER_CONTRACT_REQUIRED');
 if(!Number.isSafeInteger(now)||!secondaryFresh(q,now)||q.received_at>now||!v||!finite(v.net)||v.quote_at!==q.event_at||!Number.isSafeInteger(v.at)||v.at>now)throw Error('SHADOW_CAUSAL_VALUATION_REQUIRED');
 if(previousState&&(previousState.version!==HORIZON_SHADOW_VERSION||previousState.operation_id!==p.plan.id))throw Error('SHADOW_STATE_POSITION_MISMATCH');
 const state=structuredClone(previousState??{version:HORIZON_SHADOW_VERSION,operation_id:p.plan.id,branches:{}});
 const context=causalOriginContext(input.series,p.plan.timeframe,now),flow=directionalFlow(input.flow,p.plan.direction,now),base=baseline(controlReason);
 const aFlowState=state.branches.A_flow??{};let aFlow=structuredClone(base);
 if(base.action==='HOLD'&&flow.usable&&flow.corroborated&&flow.directional_score<-.25&&v.funding_complete&&v.liquidity_ok){
  aFlow=partial(p,v,D(p.entry).mul('.0001').mul(p.qty),aFlowState,now,'FLOW_CORROBORATED_REDUCTION')??aFlow;
 }
 state.branches.A_flow=aFlowState;
 const noFlow=branch(input,state.branches.B_no_flow,context,flow,false),withFlow=branch(input,state.branches.B_flow,context,flow,true);
 state.branches.B_no_flow=noFlow.state;state.branches.B_flow=withFlow.state;
 const features={timeframe_minutes:p.plan.timeframe,direction:p.plan.direction,quantity_btc:String(p.qty),entry_price_usd_per_btc:String(p.entry),
  hard_stop_usd_per_btc:String(p.plan.stop),target_usd_per_btc:String(p.plan.target),entered_at:p.entered_at,elapsed_ms:now-p.entered_at,
  quote_at:q.event_at,received_at:q.received_at,bid:String(q.bid),ask:String(q.ask),net_liquidation_usd:String(v.net),signed_funding_usd:String(v.funding),
  realised_before_usd:String(p.realized?.net??0),remaining_risk_usd:positive(p.remaining_risk)?String(p.remaining_risk):null,funding_complete:v.funding_complete===true,context,flow};
 const record={type:'SECONDARY_HORIZON_SHADOW_SNAPSHOT',schema:1,version:HORIZON_SHADOW_VERSION,mode:'SHADOW',authority:'NONE',ledger:'FREQUENT_PAPER',realTrading:false,
  id:p.plan.id,at:now,quote_at:q.event_at,feature_provenance:'CAPTURED_PREDECISION',policy_hash:hash(HORIZON_SHADOW_POLICY),features,
  control:{reason:controlReason??null,used_as_predictor:false},arms:{A_no_flow:{decision:base},A_flow:{decision:aFlow,flow_used:aFlow.reason==='FLOW_CORROBORATED_REDUCTION'},
   B_no_flow:{decision:noFlow.decision,metrics:noFlow.metrics??null,fallback:noFlow.fallback??null},B_flow:{decision:withFlow.decision,metrics:withFlow.metrics??null,fallback:withFlow.fallback??null}},
  hypothetical_fills:false,training_label:null};
 record.hash=hash(record);return freeze({record,state});
}
// Ranking only; all eligible candidates remain. No veto, entry, sizing or stop mutation.
export function rankShadowOpportunities(candidates,flow,now,{useFlow=true}={}){
 return candidates.map((candidate,index)=>{const plan=candidate.plan,context=directionalFlow(flow,plan?.direction,now),base=Number(plan?.economics?.netRR??0);
  const flowScore=useFlow&&context.usable&&context.corroborated?context.directional_score*.1:0;
  return {candidate:structuredClone(candidate),original_index:index,score:base+flowScore,flow_score:flowScore,
   eligible:!!plan,reason:plan?'RANK_ONLY_NO_VETO':candidate.reason??'NO_ELIGIBLE_PLAN'};
 }).sort((a,b)=>Number(b.eligible)-Number(a.eligible)||b.score-a.score||a.original_index-b.original_index);
}
// Sizing a future independent synthetic opportunity, never an existing position.
export function shadowRiskSize({baseQty,baseRisk,unitRisk,step,multiplier='1',remainingPortfolioRisk,remainingMovementRisk,remainingMargin,marginPerBtc,remainingGross,grossPerBtc}){
 if(![baseQty,baseRisk,unitRisk,step,marginPerBtc,grossPerBtc].every(positive)||![remainingPortfolioRisk,remainingMovementRisk,remainingMargin,remainingGross].every(x=>finite(x)&&D(x).gte(0))||!positive(multiplier)||D(multiplier).lt(1)||D(multiplier).gt('1.25'))throw Error('SHADOW_EXPLICIT_BOUNDED_RISK_REQUIRED');
 const caps=[D(baseQty).mul(multiplier),D(baseRisk).mul(multiplier).div(unitRisk),D(remainingPortfolioRisk).div(unitRisk),D(remainingMovementRisk).div(unitRisk),D(remainingMargin).div(marginPerBtc),D(remainingGross).div(grossPerBtc)];
 const qty=caps.reduce((a,b)=>a.lte(b)?a:b).div(step).floor().mul(step);
 return {mode:'LOCAL_EXPERIMENT_ONLY',quantity_btc:qty.toString(),risk_usd:qty.mul(unitRisk).toString(),multiplier:String(multiplier),accepted:qty.gt(0),reason:qty.gt(0)?'WITHIN_UNCHANGED_AGGREGATE_CAPS':'CAPACITY_EXHAUSTED'};
}
// Labels require explicit executable counterfactual outcomes, never OHLC extremes.
export function exitLearningExample(record,outcomes,{availableAt,coverageComplete}={}){
 if(record?.version!==HORIZON_SHADOW_VERSION||record.feature_provenance!=='CAPTURED_PREDECISION')throw Error('PREDECISION_SHADOW_RECORD_REQUIRED');
 const valid=coverageComplete===true&&Number.isSafeInteger(availableAt)&&availableAt>record.at&&['HOLD','REDUCE','CLOSE'].every(a=>positive(outcomes?.[a]?.risk_usd)&&finite(outcomes[a].net_usd)&&outcomes[a].execution_path_complete===true&&D(outcomes[a].risk_usd).eq(outcomes.HOLD.risk_usd));
 const label=valid?['HOLD','REDUCE','CLOSE'].sort((a,b)=>D(outcomes[b].net_usd).div(outcomes[b].risk_usd).comparedTo(D(outcomes[a].net_usd).div(outcomes[a].risk_usd)))[0]:null;
 return {schema:1,operation_id:record.id,at:record.at,feature_hash:hash(record.features),features:structuredClone(record.features),label,
  label_available_at:valid?availableAt:null,status:valid?'LABELED_FROM_COUNTERFACTUAL_PATH':'NO_EVALUABLE',outcomes:valid?structuredClone(outcomes):null};
}
export function chronologicalExitSplit(rows,{calibrationStart,testStart,embargoMs}){
 if(![calibrationStart,testStart,embargoMs].every(Number.isSafeInteger)||testStart<=calibrationStart||embargoMs<0)throw Error('CHRONOLOGICAL_BOUNDARIES_REQUIRED');
 const links=new Map();const find=x=>{if(!links.has(x))links.set(x,x);if(links.get(x)!==x)links.set(x,find(links.get(x)));return links.get(x);};
 for(const row of rows){if(!row.operation_id||!Number.isSafeInteger(row.feature_start)||!Number.isSafeInteger(row.label_end)||row.label_end<row.feature_start)throw Error('GROUPED_FEATURE_LABEL_INTERVAL_REQUIRED');
  const operation=find('op:'+row.operation_id);if(row.movement_id)links.set(operation,find('movement:'+row.movement_id));if(row.parent_id)links.set(find('op:'+row.operation_id),find('op:'+row.parent_id));}
 const groups=new Map();for(const row of rows){const group=find('op:'+row.operation_id),list=groups.get(group)??[];list.push(row);groups.set(group,list);}
 const result={train:[],calibration:[],test:[],purged:[]};
 for(const group of groups.values()){const start=Math.min(...group.map(r=>r.feature_start)),end=Math.max(...group.map(r=>r.label_end));
  const part=end<calibrationStart-embargoMs?'train':start>=calibrationStart&&end<testStart-embargoMs?'calibration':start>=testStart?'test':'purged';result[part].push(...structuredClone(group));}
 return result;
}
