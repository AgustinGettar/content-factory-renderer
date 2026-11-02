// Pure admission and context checks for the existing secondary PAPER broker.
// Detection remains separate. Neither function reserves capital or changes a target.
import {D,hash} from './core.js';
import {secondaryFresh} from './secondary-futures-math.js';
import {PROFIT_ECONOMIC_VERSION} from './secondary-profit-policy.js';

const SYMBOL='PF_XBTUSD';
const finite=v=>v!==null&&v!==undefined&&Number.isFinite(Number(v));
const positive=v=>finite(v)&&D(v).gt(0);
const freezeCopy=value=>structuredClone(value);
const finish=receipt=>({...receipt,hash:hash(receipt)});

export function evaluateEntryEconomics(plan,{quote,qty,entryPrice=plan?.entry,fundingRate,fundingAllowancePerUnit,now,stage='SELECTION'}={}){
 const policy=plan?.economic_policy;
 if(!policy)return {applied:false,accepted:true,reason:'LEGACY_ENTRY_POLICY'};
 const base={version:PROFIT_ECONOMIC_VERSION,policy_version:policy.policy_version,policy_hash:policy.policy_hash,stage,evaluated_at:now,operation_id:plan?.id,mode:'PAPER',realTrading:false,applied:true};
 const reject=reason=>finish({...base,accepted:false,reason});
 try{
  if(policy.version!==PROFIT_ECONOMIC_VERSION||policy.mode!=='PAPER'||policy.realTrading!==false||policy.exposure_basis!=='EXECUTABLE_ENTRY_PRICE_TIMES_QUANTITY'||policy.admission_recheck!=='POST_LATENCY_EACH_FILL'||policy.hash!==hash({...policy,hash:undefined}))return reject('ENTRY_ECONOMIC_POLICY_INVALID');
  if(!positive(policy.min_expected_net_target_fraction)||D(policy.min_expected_net_target_fraction).gte(1)||!Number.isSafeInteger(policy.funding_estimation_ms)||policy.funding_estimation_ms<=0)return reject('ENTRY_ECONOMIC_POLICY_INVALID');
  if(!Number.isSafeInteger(now)||!secondaryFresh(quote,now))return reject('FUTURES_DATA_NOT_FRESH');
  if(!['LONG','SHORT'].includes(plan.direction)||![qty,entryPrice,plan.stop,plan.target].every(positive))return reject('ENTRY_ECONOMICS_INVALID');
  const c=plan.execution_contract;
  if(!c||c.realTrading!==false||c.symbol!==SYMBOL||!['TAKER_IOC','MAKER_LIMIT'].includes(c.mode)||![c.slippage,c.takerFee,c.makerFee].every(v=>finite(v)&&D(v).gte(0)&&D(v).lt(1)))return reject('ENTRY_ECONOMICS_INVALID');
  const short=plan.direction==='SHORT',sign=D(short?-1:1),quantity=D(qty),entry=D(entryPrice),target=D(plan.target),stop=D(plan.stop);
  if(target.minus(entry).mul(sign).lte(0)||entry.minus(stop).mul(sign).lte(0))return reject('INVALID_STRUCTURAL_BARRIERS');
  let unitFunding,rate=null,source;
  if(fundingRate!==undefined){
   if(!finite(fundingRate))return reject('FUNDING_NOT_AVAILABLE');
   rate=D(fundingRate);unitFunding=rate.abs().mul(policy.funding_estimation_ms).div(3600000);source='CURRENT_HOURLY_RATE_CONSERVATIVE_ABSOLUTE';
  }else{
   if(stage==='PRE_EXECUTION')return reject('FUNDING_NOT_AVAILABLE');
   const allowance=fundingAllowancePerUnit??plan.economics?.fundingAllowance;
   if(!finite(allowance)||D(allowance).lt(0))return reject('FUNDING_NOT_AVAILABLE');
   unitFunding=D(allowance);source='SIGNAL_ESTIMATE_ALLOWANCE';
  }
  const taker=c.mode==='TAKER_IOC',entryFeeRate=D(taker?c.takerFee:c.makerFee),exitFeeRate=D(c.takerFee),slippage=D(c.slippage),exitFactor=D(1).minus(sign.mul(slippage));
  const targetExit=target.mul(exitFactor),stopExit=stop.mul(exitFactor),entryFee=entry.mul(quantity).mul(entryFeeRate),targetFee=targetExit.mul(quantity).mul(exitFeeRate),stopFee=stopExit.mul(quantity).mul(exitFeeRate),funding=unitFunding.mul(quantity);
  const targetGross=targetExit.minus(entry).mul(sign).mul(quantity),stopGross=stopExit.minus(entry).mul(sign).mul(quantity),targetNet=targetGross.minus(entryFee).minus(targetFee).minus(funding),stopLoss=stopGross.minus(entryFee).minus(stopFee).minus(funding).negated();
  if(!stopLoss.gt(0))return reject('ENTRY_ECONOMICS_INVALID');
  const exposure=entry.mul(quantity),fraction=D(policy.min_expected_net_target_fraction),minimum=exposure.mul(fraction),accepted=targetNet.gte(minimum),rawEntry=taker?D(quote[short?'bid':'ask']):entry,spread=D(quote.ask).minus(quote.bid);
  return finish({...base,accepted,reason:accepted?'EXPECTED_NET_TARGET_SUFFICIENT':'EXPECTED_NET_TARGET_BELOW_MINIMUM',
   symbol:SYMBOL,direction:plan.direction,quantity:quantity.toString(),effective_exposure:exposure.toString(),exposure_basis:policy.exposure_basis,
   estimated_entry_price:entry.toString(),raw_entry_quote_price:rawEntry.toString(),structural_target:target.toString(),structural_stop:stop.toString(),target_exit_price:targetExit.toString(),stop_exit_price:stopExit.toString(),
   entry_fee_rate:entryFeeRate.toString(),exit_fee_rate:exitFeeRate.toString(),entry_fee:entryFee.toString(),target_exit_fee:targetFee.toString(),stop_exit_fee:stopFee.toString(),estimated_funding:funding.toString(),funding_allowance_per_unit:unitFunding.toString(),funding_rate:rate?.toString()??null,funding_estimation_ms:policy.funding_estimation_ms,funding_estimate_source:source,
   expected_gross_target:targetGross.toString(),expected_net_target:targetNet.toString(),expected_loss_stop:stopLoss.toString(),net_rr:targetNet.div(stopLoss).toString(),expected_net_target_fraction:targetNet.div(exposure).toString(),min_expected_net_target_fraction:fraction.toString(),minimum_expected_net_target:minimum.toString(),
   quote_at:quote.event_at,quote_received_at:quote.received_at,quote:freezeCopy(quote),costs_embedded_in_prices:true,observed_spread_usd_per_btc:spread.toString(),entry_spread_cost_vs_mid:taker?spread.mul(quantity).div(2).toString():null,entry_slippage_cost:taker?entry.minus(rawEntry).abs().mul(quantity).toString():'0',target_slippage_cost:targetExit.minus(target).abs().mul(quantity).toString(),stop_slippage_cost:stopExit.minus(stop).abs().mul(quantity).toString(),
   target_quote_basis:short?'STRUCTURAL_ASK_LEVEL':'STRUCTURAL_BID_LEVEL',forecast_guaranteed:false});
 }catch{return reject('ENTRY_ECONOMICS_INVALID');}
}

const average=values=>values.reduce((sum,value)=>sum+Number(value),0)/values.length;
function emaSeries(bars,length){
 const result=Array(bars.length).fill(null);if(bars.length<length)return result;
 let value=average(bars.slice(0,length).map(bar=>bar.close));result[length-1]=value;
 for(let i=length;i<bars.length;i++){value+=(Number(bars[i].close)-value)*2/(length+1);result[i]=value;}
 return result;
}
const tickValue=(value,tick)=>D(value).div(tick).toNearest(1).mul(tick).toString();

// The key identifies the excursion/break, not the candle that happens to be
// evaluating it. A new closed bar alone does not create a new confirmation.
export function buildEntryContext({pattern,direction,bars,tickSize,target,entry,trigger,cutoff}){
 const short=direction==='SHORT',last=bars.length-1;
 if(!['LONG','SHORT'].includes(direction)||last<21||!positive(tickSize)||!Number.isSafeInteger(cutoff))throw Error('ENTRY_CONTEXT_INVALID');
 let origin=last,kind,level,structureAt;
 if(pattern==='PULLBACK'){
  const averages=emaSeries(bars,9),touch=i=>i>=8&&(short?Number(bars[i].high)>=averages[i]:Number(bars[i].low)<=averages[i]);
  origin=trigger==='PRIOR_CANDLE_PULLBACK'?last-1:last;
  while(origin>8&&touch(origin-1))origin--;
  kind='EMA9_RETEST_EPISODE';
  const prior=bars.slice(Math.max(0,last-20),last),extreme=short?Math.min(...prior.map(bar=>Number(bar.low))):Math.max(...prior.map(bar=>Number(bar.high))),pivot=prior.find(bar=>Number(bar[short?'low':'high'])===extreme);
  level=tickValue(extreme,tickSize);structureAt=pivot.start;
 }else if(pattern==='BREAKOUT'){
  const broken=i=>i>=8&&(short?Number(bars[i].close)<Math.min(...bars.slice(i-8,i).map(bar=>Number(bar.low))):Number(bars[i].close)>Math.max(...bars.slice(i-8,i).map(bar=>Number(bar.high))));
  while(origin>8&&broken(origin-1))origin--;
  const prior=bars.slice(origin-8,origin);level=tickValue(short?Math.min(...prior.map(bar=>Number(bar.low))):Math.max(...prior.map(bar=>Number(bar.high))),tickSize);structureAt=bars[origin].start;kind='CHANNEL8_BREAK_EPISODE';
 }else if(pattern==='RANGE_REENTRY'){
  const band=i=>{const closes=bars.slice(i-20,i).map(bar=>Number(bar.close)),center=average(closes),sd=Math.sqrt(average(closes.map(value=>(value-center)**2)));return center+(short?2:-2)*sd;};
  const outside=i=>i>=20&&(short?Number(bars[i].high)>band(i):Number(bars[i].low)<band(i));
  origin=trigger==='PRIOR_CANDLE_REENTRY'?last-1:last;
  while(origin>20&&outside(origin-1))origin--;
  level=tickValue(band(origin),tickSize);structureAt=bars[origin].start;kind='BAND_REENTRY_EPISODE';
 }else throw Error('ENTRY_CONTEXT_PATTERN_INVALID');
 const start=bars[origin].start,end=bars[origin].end,structureKey=hash([SYMBOL,pattern,direction,kind==='EMA9_RETEST_EPISODE'?'PIVOT20':kind,structureAt,level]);
 return {version:'secondary-entry-context-economics-1.0.0',symbol:SYMBOL,pattern,direction,structure_key:structureKey,movement_key:structureKey,confirmation_key:hash([SYMBOL,pattern,direction,kind,start]),confirmation_kind:kind,confirmation_event_start_at:start,confirmation_event_at:end,confirmation_at:cutoff,structure_at:structureAt,structure_level:level,price_tick:String(tickSize),structural_target:String(target),remaining_distance:D(target).minus(entry).mul(short?-1:1).toString(),remaining_distance_fraction:D(target).minus(entry).mul(short?-1:1).div(entry).toString(),data_basis:'CLOSED_CAUSAL_5M_BARS',lookback_left_censored:origin===(pattern==='RANGE_REENTRY'?20:8)};
}

export function evaluateEntryContext(plan,existingRows=[]){
 if(!plan?.economic_policy)return {applied:false,accepted:true,reason:'LEGACY_ENTRY_POLICY',classification:'LEGACY'};
 const context=plan.entry_context,base={version:'secondary-entry-context-economics-1.0.0',applied:true,operation_id:plan.id,pattern:plan.pattern,direction:plan.direction};
 if(!context?.confirmation_key||!context.structure_key||!positive(context.price_tick)||!Number.isSafeInteger(context.confirmation_event_at))return {...base,accepted:false,reason:'ENTRY_CONTEXT_REQUIRED',classification:'UNRESOLVED_CONTEXT',related_position_ids:[]};
 const related=[];
 for(const row of existingRows){
  const previous=row?.plan??row;if(!previous||previous.id===plan.id||previous.pattern!==plan.pattern||previous.direction!==plan.direction)continue;
  const priorContext=previous.entry_context,sharedTarget=positive(previous.target)&&D(previous.target).minus(plan.target).abs().lte(context.price_tick),sameStructure=priorContext?.structure_key===context.structure_key,sameConfirmation=priorContext?.confirmation_key===context.confirmation_key;
  if(!sharedTarget&&!sameStructure&&!sameConfirmation)continue;
  related.push({id:previous.id,shared_target:sharedTarget,same_structure:sameStructure,same_confirmation:sameConfirmation,confirmed_at:previous.confirmed_at??priorContext?.confirmation_at??0,confirmation_event_at:priorContext?.confirmation_event_at??null,structural_target:previous.target,entry:row?.entry??previous.entry,remaining_quantity:row?.qty??row?.remaining_qty??previous.sizing?.qty??null,legacy_context:!priorContext});
 }
 const snapshot={...base,structure_key:context.structure_key,movement_key:context.movement_key,confirmation_key:context.confirmation_key,confirmation_event_at:context.confirmation_event_at,structural_target:plan.target,remaining_distance:context.remaining_distance,remaining_distance_fraction:context.remaining_distance_fraction,expected_net_target:plan.entry_economics?.expected_net_target??null,minimum_expected_net_target:plan.entry_economics?.minimum_expected_net_target??null,related_position_ids:related.map(row=>row.id),related_positions:related};
 if(!related.length)return {...snapshot,accepted:true,reason:'NEW_OPPORTUNITY',classification:'NEW_OPPORTUNITY'};
 if(related.some(row=>row.same_confirmation))return {...snapshot,accepted:false,reason:'REPEATED_CONFIRMATION',classification:'LATE_REPETITION'};
 const latest=related.reduce((value,row)=>Math.max(value,Number(row.confirmed_at)||0),0);
 if(context.confirmation_event_at<=latest)return {...snapshot,accepted:false,reason:'LATE_REPETITION_NO_NEW_CONFIRMATION',classification:'LATE_REPETITION'};
 return {...snapshot,accepted:true,reason:'ADDITION_NEW_CONFIRMATION',classification:'ADDITION_NEW_CONFIRMATION'};
}
