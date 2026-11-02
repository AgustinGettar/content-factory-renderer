// Optional, causal PAPER learning records. No orders, balances or plans are mutated.
// Data is joined by operation/signal IDs; the durable event log is the dataset source.
import {D,hash,validBar} from './core.js';
import {SECONDARY_VERSION,SECONDARY_MODEL,secondaryFresh} from './secondary-futures-math.js';
import {explorationContract} from './secondary-exploration.js';
import {buildEntryContext} from './secondary-entry-economics.js';
import {makeProfitContracts} from './secondary-profit-policy.js';

export const NEURAL_SIGNAL_VERSION='secondary-neural-signal-1.0.0';
export const NEURAL_FEATURE_VERSION='secondary-neural-features-1.0.0';
export const NEURAL_LABEL_VERSION='secondary-neural-label-1.0.0';
export const NEURAL_FEATURE_NAMES=Object.freeze([
 'pattern_breakout','pattern_pullback','pattern_range_reentry','direction',
 'trend_5_atr','trend_15_atr','efficiency_15','atr_5_fraction','atr_15_fraction',
 'relative_volume','candle_body_fraction','candle_signed_body_fraction','upper_wick_fraction','lower_wick_fraction',
 'stop_distance_fraction','target_distance_fraction','spread_fraction','entry_fee_fraction','exit_fee_fraction','slippage_fraction',
 'expected_funding_fraction','expected_net_target_fraction','expected_net_risk_fraction','min_expected_net_fraction',
 'quote_age_seconds','candle_age_seconds','open_position_count','pending_order_count','related_structure_count','shared_target_count',
 'same_direction_exposure_nominals','same_confirmation_count','confirmation_age_seconds',
]);
export const NEURAL_FEATURE_SCHEMA_HASH=hash({version:NEURAL_FEATURE_VERSION,names:NEURAL_FEATURE_NAMES});
export const NEURAL_DATA_LIMITS=Object.freeze({barsPerFrame:1024,contextRows:512,fillEvents:4096,snapshotBytes:65536,maxAbsFeature:1000000});
const SYMBOL='PF_XBTUSD',LEDGER='FREQUENT_PAPER',PATTERNS=['BREAKOUT','PULLBACK','RANGE_REENTRY'];
const finite=value=>value!==null&&value!==undefined&&Number.isFinite(Number(value));
const positive=value=>finite(value)&&D(value).gt(0);
const time=value=>Number.isSafeInteger(value)&&value>=0;
const closeEnough=(a,b)=>D(a).minus(b).abs().lte('0.000000001');
const copy=value=>structuredClone(value);
const hashWithout=(value,key)=>hash({...value,[key]:undefined});
const paper=({mode='PAPER',realTrading=false,symbol=SYMBOL,ledger=LEDGER}={})=>{
 if(mode!=='PAPER'||realTrading!==false||symbol!==SYMBOL||ledger!==LEDGER)throw Error('NEURAL_DATA_PAPER_ONLY');
};
const factsKeys=['atr5','atr15','efficiency15','fast5','slow5','fast15','slow15','relative_volume','body_fraction','regime','strong_up','strong_down','trigger'];
const pick=(object,keys)=>Object.fromEntries(keys.filter(key=>object?.[key]!==undefined).map(key=>[key,object[key]]));

function frames(series,cutoff,now){
 const result={};
 for(const tf of [5,15]){
  const source=series?.[tf];if(!Array.isArray(source)||source.length>NEURAL_DATA_LIMITS.barsPerFrame)throw Error('NEURAL_BAR_INPUT_LIMIT_OR_MISSING');
  const rows=source.filter(row=>row.end<=cutoff&&(row.available_at==null||row.available_at<=now)).slice(-256);
  if(rows.length<64||rows.at(-1).end!==Math.floor(cutoff/(tf*60000))*tf*60000||rows.some((row,i)=>!validBar(row)||!time(row.start)||!time(row.end)||row.end-row.start!==tf*60000||row.available_at!=null&&!time(row.available_at)||i&&row.start!==rows[i-1].end))throw Error('NEURAL_CAUSAL_CANDLES_INCOMPLETE');
  result[tf]=rows.map(row=>pick(row,['start','end','available_at','open','high','low','close','volume']));
 }
 return result;
}

function contextRows(existing){
 if(existing===undefined||existing===null)throw Error('NO_PRE_ENTRY_POSITION_CONTEXT');
 const boundedValues=value=>{
  if(Array.isArray(value)){if(value.length>NEURAL_DATA_LIMITS.contextRows)throw Error('NEURAL_POSITION_CONTEXT_LIMIT');return value;}
  const out=[];for(const key in value??{})if(Object.hasOwn(value,key)){if(out.length===NEURAL_DATA_LIMITS.contextRows)throw Error('NEURAL_POSITION_CONTEXT_LIMIT');out.push(value[key]);}return out;
 };
 let pairs;
 if(Array.isArray(existing))pairs=boundedValues(existing).map(row=>[row,row?.qty!==undefined?'OPEN':'PENDING']);
 else{
  const open=boundedValues(existing.positions),pending=boundedValues(existing.pendingOrders);
  pairs=[...open.map(row=>[row,'OPEN']),...pending.map(row=>[row,'PENDING'])];
 }
 if(pairs.length>NEURAL_DATA_LIMITS.contextRows)throw Error('NEURAL_POSITION_CONTEXT_LIMIT');
 const ids=new Set();return pairs.map(([row,state])=>{
  const plan=row?.plan??row;if(!plan?.id||plan.instrument!=='PAPER:KRAKEN_FUTURES:PF_XBTUSD'||plan.execution_model!==SECONDARY_MODEL||!['LONG','SHORT'].includes(plan.direction))throw Error('NEURAL_POSITION_CONTEXT_INVALID');
  // One partly filled order may coexist with its position. Count each exposure
  // separately, while retaining state in the identity rather than dropping it.
  const key=state+':'+plan.id;if(ids.has(key))throw Error('NEURAL_POSITION_CONTEXT_DUPLICATE');ids.add(key);
  const qty=state==='OPEN'?row.qty:row.remaining_qty??plan.sizing?.qty,entry=state==='OPEN'?row.entry:plan.entry;
  if(!positive(qty)||!positive(entry)||!positive(plan.target))throw Error('NEURAL_POSITION_CONTEXT_INVALID');
  return {operation_id:plan.id,state,pattern:plan.pattern,direction:plan.direction,entry:String(entry),target:String(plan.target),qty:String(qty),confirmed_at:plan.confirmed_at??null,structure_key:plan.entry_context?.structure_key??null,confirmation_key:plan.entry_context?.confirmation_key??null};
 });
}

/** Capture BEFORE selection. No field is added to the signed operational plan. */
export function captureSecondaryNeuralSignal({decision,series,quote,meta,existing,cutoff,now,explorationPolicy=null,profitPolicy=null,mode='PAPER',realTrading=false,provenance='LIVE_PRE_DECISION'}={}){
 paper({mode,realTrading});
 const plan=decision?.plan,facts=decision?.facts??{},pattern=decision?.pattern,direction=decision?.direction??plan?.direction??null;
 if(plan?.mode&&plan.mode!=='PAPER'||plan?.realTrading===true||plan?.instrument&&plan.instrument!=='PAPER:KRAKEN_FUTURES:PF_XBTUSD'||plan?.execution_contract?.realTrading===true||plan?.economic_policy?.mode&&plan.economic_policy.mode!=='PAPER'||plan?.exit_policy?.mode&&plan.exit_policy.mode!=='PAPER')throw Error('NEURAL_DATA_PAPER_ONLY');
 const detected=Boolean(plan||facts.pattern_detected),revision=plan?.entry_revision??facts.entry_revision??null;
 const signalId=plan?.id??hash([NEURAL_SIGNAL_VERSION,SECONDARY_VERSION,revision,pattern??null,cutoff??null,direction]);
 const base={version:NEURAL_SIGNAL_VERSION,feature_version:NEURAL_FEATURE_VERSION,feature_schema_hash:NEURAL_FEATURE_SCHEMA_HASH,snapshot_id:hash([NEURAL_SIGNAL_VERSION,signalId]),signal_id:signalId,operation_id:plan?.id??null,at:now,decision_at:now,signal_at:cutoff,pattern,direction,detected,stage:'PRE_SELECTION',mode:'PAPER',realTrading:false,feature_names:[...NEURAL_FEATURE_NAMES],x:null,data_quality:'UNAVAILABLE',exclusion:null,base_reason:decision?.reason??null,provenance:{kind:provenance,available_at:now}};
 const finish=extra=>{const result={...base,...extra};result.snapshot_hash=hash(result);return result;};
 try{
  if(provenance!=='LIVE_PRE_DECISION')throw Error('NO_IMMUTABLE_PRE_ENTRY_SNAPSHOT');
  if(!time(now)||!time(cutoff)||cutoff>now||cutoff%300000||!PATTERNS.includes(pattern))throw Error('NEURAL_SIGNAL_TIME_OR_PATTERN_INVALID');
  if(!detected)return finish({exclusion:'NO_DETECTED_SIGNAL',data_quality:'NO_SIGNAL',input_hash:hash({pattern,cutoff,reason:base.base_reason})});
  if(!['LONG','SHORT'].includes(direction))throw Error('NEURAL_DIRECTION_UNAVAILABLE');
  if(plan&&(plan.hash!==undefined||plan.sizing!==undefined||plan.confirmed_at!==cutoff||plan.decision_at!==now))throw Error('CAPTURE_NOT_PRE_SELECTION');
  if(!secondaryFresh(quote,now)||quote.event_at>now||quote.received_at>now)throw Error('NEURAL_EXECUTABLE_QUOTE_UNAVAILABLE');
  if(!positive(meta?.tick_size)||!positive(meta?.qty_step)||meta?.symbol&&meta.symbol!==SYMBOL)throw Error('NEURAL_INSTRUMENT_METADATA_INVALID');
  const bars=frames(series,cutoff,now),last=bars[5].at(-1),rows=contextRows(existing),sign=direction==='SHORT'?-1:1;
  const contract=plan?.execution_contract??(explorationPolicy?explorationContract(explorationPolicy,pattern,now):null);
  const profitContracts=plan?.economic_policy&&plan?.exit_policy?{economic_policy:plan.economic_policy,exit_policy:plan.exit_policy}:profitPolicy?makeProfitContracts(profitPolicy):null;
  if(!contract||contract.realTrading!==false||contract.symbol!==SYMBOL||!['TAKER_IOC','MAKER_LIMIT'].includes(contract.mode)||!profitContracts)throw Error('NEURAL_EFFECTIVE_CONTRACT_UNAVAILABLE');
  const economic=profitContracts.economic_policy,exit=profitContracts.exit_policy;
  paper({mode:economic.mode,realTrading:economic.realTrading});paper({mode:exit.mode,realTrading:exit.realTrading});
  const entry=plan?.entry??facts.entry,stop=plan?.stop??facts.stop,target=plan?.target??facts.target,econ=plan?.economics??facts;
  if(![entry,stop,target,contract.nominalUSD,facts.atr5,facts.atr15].every(positive)||!['fast5','slow5','fast15','slow15','efficiency15','relative_volume','body_fraction'].every(key=>finite(facts[key]))||![econ.gain,econ.loss,econ.fundingAllowance,economic.min_expected_net_target_fraction].every(finite))throw Error('NEURAL_PRE_ENTRY_VALUES_INCOMPLETE');
  if(![contract.makerFee,contract.takerFee,contract.slippage].every(value=>finite(value)&&D(value).gte(0)&&D(value).lt(1))||D(econ.fundingAllowance).lt(0))throw Error('NEURAL_FUTURES_COST_CONTRACT_INVALID');
  const structure=plan?.entry_context??buildEntryContext({pattern,direction,bars:bars[5],tickSize:meta.tick_size,target,entry,trigger:facts.trigger,cutoff});
  if(!structure?.movement_key||!structure.confirmation_key||!time(structure.confirmation_event_at)||structure.confirmation_event_at>cutoff)throw Error('NEURAL_CAUSAL_STRUCTURE_UNAVAILABLE');
  const span=Number(last.high)-Number(last.low);if(!(span>0))throw Error('NEURAL_CANDLE_SHAPE_UNAVAILABLE');
  const nominal=D(contract.nominalUSD),qty=nominal.div(entry).div(meta.qty_step).floor().mul(meta.qty_step),exposure=qty.mul(entry);
  if(!qty.gt(0))throw Error('NEURAL_EFFECTIVE_QUANTITY_UNAVAILABLE');
  const sameDirection=rows.filter(row=>row.direction===direction),samePattern=sameDirection.filter(row=>row.pattern===pattern);
  const related=samePattern.filter(row=>row.structure_key===structure.structure_key),shared=samePattern.filter(row=>D(row.target).minus(target).abs().lte(meta.tick_size)),sameConfirmation=samePattern.filter(row=>row.confirmation_key===structure.confirmation_key);
  const values=[
   ...PATTERNS.map(name=>Number(pattern===name)),sign,
   sign*(Number(facts.fast5)-Number(facts.slow5))/Number(facts.atr5),sign*(Number(facts.fast15)-Number(facts.slow15))/Number(facts.atr15),Number(facts.efficiency15),Number(facts.atr5)/Number(entry),Number(facts.atr15)/Number(entry),
   Number(facts.relative_volume),Math.abs(Number(last.close)-Number(last.open))/span,sign*(Number(last.close)-Number(last.open))/span,(Number(last.high)-Math.max(Number(last.open),Number(last.close)))/span,(Math.min(Number(last.open),Number(last.close))-Number(last.low))/span,
   sign*(Number(entry)-Number(stop))/Number(entry),sign*(Number(target)-Number(entry))/Number(entry),D(quote.ask).minus(quote.bid).div(D(quote.ask).plus(quote.bid).div(2)).toNumber(),Number(contract.mode==='TAKER_IOC'?contract.takerFee:contract.makerFee),Number(contract.takerFee),Number(contract.slippage),
   Number(econ.fundingAllowance)/Number(entry),Number(econ.gain)/Number(entry),Number(econ.loss)/Number(entry),Number(economic.min_expected_net_target_fraction),
   (now-quote.event_at)/1000,(now-last.end)/1000,rows.filter(row=>row.state==='OPEN').length,rows.filter(row=>row.state==='PENDING').length,related.length,shared.length,
   sameDirection.reduce((sum,row)=>sum.plus(D(row.entry).mul(row.qty)),D(0)).div(nominal).toNumber(),sameConfirmation.length,(now-structure.confirmation_event_at)/1000,
  ];
  if(values.length!==NEURAL_FEATURE_NAMES.length||values.some(value=>!Number.isFinite(value)||Math.abs(value)>NEURAL_DATA_LIMITS.maxAbsFeature))throw Error('NEURAL_FEATURE_NUMERIC_OR_RESOURCE_LIMIT');
  const domain={mode:'PAPER',realTrading:false,symbol:SYMBOL,ledger:LEDGER,engine_version:plan?.version??SECONDARY_VERSION,entry_revision:revision,execution_version:contract.version,economic_policy_version:economic.version,exit_policy_version:exit.version,execution_policy_hash:contract.policy_hash,economic_policy_hash:economic.hash,exit_policy_hash:exit.hash};
  const context={movement_key:structure.movement_key,confirmation_key:structure.confirmation_key,structure_key:structure.structure_key,confirmation_event_at:structure.confirmation_event_at,open_position_count:values[26],pending_order_count:values[27],related_structure_count:related.length,shared_target_count:shared.length,same_confirmation_count:sameConfirmation.length,positions_hash:hash(rows)};
  const inputs={facts:pick(facts,factsKeys),direction,pattern,entry:String(entry),stop:String(stop),target:String(target),economics:pick(econ,['gain','loss','netRR','fundingAllowance']),quote:pick(quote,['source','symbol','event_at','received_at','bid','ask','bid_qty','ask_qty','suspended','post_only']),last_closed_5m:last,last_closed_15m:bars[15].at(-1),closed_bars_hash:hash(bars),context,effective_quantity:qty.toString(),effective_exposure:exposure.toString(),domain};
  const result=finish({x:values,input_hash:hash(inputs),inputs,domain,group_key:hash({feature_version:NEURAL_FEATURE_VERSION,domain}),context,data_quality:'PRE_DECISION_OBSERVED',exclusion:null,provenance:{kind:provenance,available_at:now,bar_availability:bars[5].every(bar=>bar.available_at!=null)&&bars[15].every(bar=>bar.available_at!=null)?'EXPLICIT_AVAILABLE_AT':'OBSERVED_IN_MEMORY_AT_CAPTURE'}});
  if(Buffer.byteLength(JSON.stringify(result))>NEURAL_DATA_LIMITS.snapshotBytes)throw Error('NEURAL_SNAPSHOT_RESOURCE_LIMIT');
  return result;
 }catch(error){return finish({exclusion:/^[A-Z_]+$/.test(error.message)?error.message:'NEURAL_CAPTURE_FAILED',data_quality:'EXCLUDED',input_hash:null});}
}

/** Existing snapshots may be replayed; missing historical inputs are never filled. */
export function validateSecondaryNeuralSnapshot(snapshot){
 if(snapshot?.mode!=='PAPER'||snapshot?.realTrading!==false)throw Error('NEURAL_DATA_PAPER_ONLY');
 if(snapshot.version!==NEURAL_SIGNAL_VERSION||snapshot.feature_version!==NEURAL_FEATURE_VERSION||snapshot.feature_schema_hash!==NEURAL_FEATURE_SCHEMA_HASH||hash(snapshot.feature_names)!==hash(NEURAL_FEATURE_NAMES))throw Error('NEURAL_FEATURE_SCHEMA_MISMATCH');
 if(!time(snapshot.signal_at)||!time(snapshot.decision_at)||snapshot.signal_at>snapshot.decision_at||snapshot.stage!=='PRE_SELECTION')throw Error('NEURAL_SNAPSHOT_CHRONOLOGY_INVALID');
 if(snapshot.snapshot_hash!==hashWithout(snapshot,'snapshot_hash'))throw Error('NEURAL_SNAPSHOT_HASH_MISMATCH');
 if(!Array.isArray(snapshot.x)||snapshot.x.length!==NEURAL_FEATURE_NAMES.length||snapshot.x.some(value=>typeof value!=='number'||!Number.isFinite(value)||Math.abs(value)>NEURAL_DATA_LIMITS.maxAbsFeature)||snapshot.exclusion!==null||snapshot.data_quality!=='PRE_DECISION_OBSERVED')throw Error('NEURAL_PRE_ENTRY_FEATURES_UNAVAILABLE');
 paper(snapshot.domain);
 if(snapshot.domain.engine_version!==SECONDARY_VERSION||snapshot.group_key!==hash({feature_version:NEURAL_FEATURE_VERSION,domain:snapshot.domain})||snapshot.input_hash!==hash(snapshot.inputs)||!snapshot.context?.movement_key||!snapshot.context.confirmation_key)throw Error('NEURAL_SNAPSHOT_INPUT_INTEGRITY');
 if(Buffer.byteLength(JSON.stringify(snapshot))>NEURAL_DATA_LIMITS.snapshotBytes)throw Error('NEURAL_SNAPSHOT_RESOURCE_LIMIT');
 return snapshot;
}

function uniqueEvents(rows,idKey){
 if(!Array.isArray(rows)||rows.length>NEURAL_DATA_LIMITS.fillEvents)throw Error('NEURAL_LABEL_EVENT_LIMIT');
 const seen=new Map();for(const row of rows){
  const key=row[idKey]??row.event_id??hash(row),before=seen.get(key);
  if(before&&hash(before)!==hash(row))throw Error('NEURAL_EXECUTION_ID_CONFLICT');
  if(!before)seen.set(key,row);
 }
 return [...seen.values()];
}

function revisionedLabel(row,previous){
 const contentHash=hash(row);
 if(previous){
  if(previous.operation_id!==row.operation_id||previous.version!==NEURAL_LABEL_VERSION||!Number.isSafeInteger(previous.label_revision)||previous.label_revision<1||previous.label_hash!==hashWithout(previous,'label_hash'))throw Error('NEURAL_PREVIOUS_LABEL_INVALID');
  if(previous.content_hash===contentHash)return copy(previous);
 }
 const result={...row,label_revision:(previous?.label_revision??0)+1,content_hash:contentHash,supersedes_label_hash:previous?.label_hash??null};result.label_hash=hash(result);return result;
}

/** CLOSED.pnl is already aggregate. PARTIAL_CLOSE is used for evidence, never added again. */
export function buildSecondaryNeuralLabel({snapshot=null,closed,entryEvents=[],exitEvents=[],fundingEvents=[],previous=null,mode='PAPER',realTrading=false}={}){
 paper({mode,realTrading});
 if(!closed||closed.type!=='CLOSED')return null; // NOT_FILLED / rejection is not a loss.
 if(closed.mode&&closed.mode!=='PAPER'||closed.realTrading===true||closed.ledger&&closed.ledger!==LEDGER||closed.plan?.mode&&closed.plan.mode!=='PAPER'||closed.plan?.realTrading===true||closed.plan?.instrument&&closed.plan.instrument!=='PAPER:KRAKEN_FUTURES:PF_XBTUSD'||closed.plan?.execution_contract?.realTrading===true)throw Error('NEURAL_DATA_PAPER_ONLY');
 const plan=closed.plan,id=closed.id??plan?.id;
 if(typeof id!=='string'||!id)throw Error('NEURAL_LABEL_OPERATION_REQUIRED');
 const base={version:NEURAL_LABEL_VERSION,operation_id:id,signal_id:snapshot?.signal_id??null,snapshot_hash:snapshot?.snapshot_hash??null,mode:'PAPER',realTrading:false,status:'EXCLUDED',exclusion:null,net_return:null,exposure:null,net:finite(closed.pnl)?String(closed.pnl):null,costs:finite(closed.fees)?String(closed.fees):null,funding:finite(closed.funding)?String(closed.funding):null,entered_at:closed.entered_at??null,closed_at:closed.at??null,mature_at:closed.at??null,quality:closed.quality??'UNKNOWN',manual_override:Boolean(closed.management_override),funding_final:false,adverse_return:null,duration_ms:time(closed.at)&&time(closed.entered_at)?closed.at-closed.entered_at:null,exit_policy_version:plan?.exit_policy?.version??'LEGACY_FIXED_EXIT',group_key:snapshot?.group_key??null,provenance:'OBSERVED_PAPER_EXECUTIONS',close_reason:closed.reason??null};
 const finish=extra=>revisionedLabel({...base,...extra},previous);
 try{
  if([entryEvents,exitEvents,fundingEvents].some(rows=>!Array.isArray(rows)||rows.length>NEURAL_DATA_LIMITS.fillEvents))return finish({exclusion:'NEURAL_LABEL_EVENT_LIMIT'});
  if(!snapshot)return finish({exclusion:'NO_PRE_ENTRY_SNAPSHOT'});
  try{validateSecondaryNeuralSnapshot(snapshot);}catch(error){return finish({exclusion:error.message});}
  if(snapshot.operation_id!==id||snapshot.domain.exit_policy_version!==base.exit_policy_version||snapshot.domain.entry_revision!==plan?.entry_revision||snapshot.domain.execution_version!==plan?.execution_contract?.version||snapshot.domain.execution_policy_hash!==plan?.execution_contract?.policy_hash||snapshot.domain.economic_policy_hash!==plan?.economic_policy?.hash||snapshot.domain.exit_policy_hash!==plan?.exit_policy?.hash)return finish({exclusion:'ENTRY_OR_EXIT_CONTRACT_MISMATCH'});
  if(!time(closed.entered_at)||!time(closed.at)||snapshot.decision_at>closed.entered_at||closed.entered_at>=closed.at)return finish({exclusion:'INVALID_LABEL_CHRONOLOGY'});
  if(plan?.version!==SECONDARY_VERSION||plan?.execution_model!==SECONDARY_MODEL)return finish({exclusion:'UNSUPPORTED_EXECUTION_MODEL'});
  if([...entryEvents,...exitEvents,...fundingEvents].some(event=>event?.id===id&&(event.realTrading===true||event.mode&&event.mode!=='PAPER'||event.ledger&&event.ledger!==LEDGER||event.plan?.instrument&&event.plan.instrument!=='PAPER:KRAKEN_FUTURES:PF_XBTUSD')))return finish({exclusion:'EXECUTION_EVIDENCE_DOMAIN_MISMATCH'});
  const entries=entryEvents.length?entryEvents.filter(event=>['FILLED','PARTIAL_FILL'].includes(event.type)&&event.id===id).map(event=>({id:event.fill_id,at:event.at,qty:event.qty,price:event.price,fee:event.fee})):closed.entry_fills??[];
  const fills=uniqueEvents(entries,'id').map(fill=>pick(fill,['id','at','qty','price','fee']));
  if(!fills.length||fills.some(fill=>typeof fill.id!=='string'||!positive(fill.qty)||!positive(fill.price)||!finite(fill.fee)||D(fill.fee).lt(0)||!time(fill.at)||fill.at<closed.entered_at||fill.at>=closed.at))return finish({exclusion:'ENTRY_EXECUTIONS_INCOMPLETE'});
  const quantity=fills.reduce((sum,fill)=>sum.plus(fill.qty),D(0)),exposure=fills.reduce((sum,fill)=>sum.plus(D(fill.qty).mul(fill.price)),D(0));
  if(!positive(closed.qty)||!closeEnough(quantity,closed.qty)||!exposure.gt(0)||closed.remaining_qty!==undefined&&!D(closed.remaining_qty).eq(0))return finish({exclusion:'ENTRY_QUANTITY_NOT_RECONCILED'});
  const exits=uniqueEvents(exitEvents.filter(event=>['PARTIAL_CLOSE','CLOSED'].includes(event.type)&&event.id===id),'fill_id');
  const manual=closed.management_override===true||exits.some(event=>event.management_override===true||String(event.reason).startsWith('MANUAL_'))||String(closed.reason).startsWith('MANUAL_');
  if(!finite(closed.pnl)||!finite(closed.fees)||!finite(closed.gross)||!finite(closed.funding)||!closeEnough(D(closed.gross).minus(closed.fees),closed.pnl))return finish({exclusion:'FINAL_ACCOUNTING_INVALID',exposure:exposure.toString(),manual_override:manual});
  let net=D(closed.pnl),costs=D(closed.fees),funding=D(closed.funding),fundingFinal=closed.funding_complete===true&&closed.result_final===true,matureAt=closed.at,reconstructed=false;
  const corrections=uniqueEvents(uniqueEvents(fundingEvents.filter(event=>event.type==='FUNDING_RECONCILED'&&event.id===id&&event.position_open!==true&&event.at>=closed.at),'event_id').map(event=>pick(event,['type','id','at','amount','net_adjustment','net_after','funding_complete','remaining_intervals'])),'event_id').sort((a,b)=>a.at-b.at);
  for(const event of corrections){
   if(!time(event.at)||!finite(event.amount)||!finite(event.net_after)||!finite(event.net_adjustment)||!closeEnough(D(event.amount).negated(),event.net_adjustment)||!closeEnough(net.plus(event.net_adjustment),event.net_after))return finish({exclusion:'FUNDING_REVISION_NOT_RECONCILED',exposure:exposure.toString(),manual_override:manual});
   net=D(event.net_after);costs=costs.plus(event.amount);funding=funding.plus(event.amount);fundingFinal=event.funding_complete===true;matureAt=Math.max(matureAt,event.at);reconstructed=true;
  }
  const plannedQuantity=positive(plan.sizing?.qty)?D(plan.sizing.qty):null;
  const metrics={exposure:exposure.toString(),net:net.toString(),costs:costs.toString(),funding:funding.toString(),funding_final:fundingFinal,mature_at:matureAt,manual_override:manual,planned_quantity:plannedQuantity?.toString()??null,executed_quantity:quantity.toString(),full_fill:plannedQuantity!==null&&quantity.eq(plannedQuantity),entry_fill_count:fills.length,entry_execution_hash:hash(fills),funding_revision_hash:hash(corrections),adverse_return:finite(closed.excursions?.max_adverse_net)?D(closed.excursions.max_adverse_net).div(exposure).toString():null,max_adverse_observed_net:closed.excursions?.max_adverse_net??null,max_favourable_observed_net:closed.excursions?.max_favourable_net??null};
  if(manual)return finish({...metrics,exclusion:'MANUAL_OR_MANAGEMENT_OVERRIDE'});
  if(closed.management_override!==false)return finish({...metrics,exclusion:'MANAGEMENT_EVIDENCE_UNAVAILABLE'});
  if(closed.data_gaps?.length||exits.some(event=>event.data_gaps?.length)||!['OBSERVED','FUNDING_GAP'].includes(closed.quality))return finish({...metrics,exclusion:'INCOMPLETE_MARKET_DATA'});
  if(!fundingFinal)return finish({...metrics,status:'PENDING',exclusion:'FUNDING_UNRESOLVED'});
  const quality=reconstructed||closed.quality==='FUNDING_GAP'?'OBSERVED_PRICE_RECONCILED_FUNDING':'OBSERVED';
  return finish({...metrics,status:'MATURE',exclusion:null,quality,net_return:net.div(exposure).toString()});
 }catch(error){return finish({exclusion:/^[A-Z_]+$/.test(error.message)?error.message:'NEURAL_LABEL_FAILED'});}
}
