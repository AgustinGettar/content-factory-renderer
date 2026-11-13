// Pure transactional derivation. Only the separate shadow store supplies ctx;
// no engine, account writer, exchange endpoint or notifier is imported.
import {hash} from './core.js';
import {evaluateHorizonShadow,rankShadowOpportunities,HORIZON_SHADOW_VERSION} from './secondary-horizon-shadow.js';
import {secondaryFresh} from './secondary-futures-math.js';
export const SHADOW_STORE_VERSION='secondary-shadow-observation-store-1.0.0';
const clone=x=>structuredClone(x);
const stable=(...x)=>hash([SHADOW_STORE_VERSION,...x]);
const timestamp=x=>Number.isSafeInteger(x)&&x>=0;
const finite=x=>x!==null&&x!==undefined&&x!==''&&Number.isFinite(Number(x));
function lifecycle(ctx,envelope){
 const now=envelope.at;
 for(const task of ctx.pendingTasks()){
  let changed=false;
  for(const target of task.targets){
   if(target.status!=='PENDING'||now<target.due_at)continue;
   const endpoint=ctx.endpoint(target.due_at,target.due_at+ctx.limits.endpointGraceMs,now);
   if(!endpoint&&now<=target.due_at+ctx.limits.endpointGraceMs)continue;
   const through=endpoint?.event_at??target.due_at,coverage=ctx.coverage(task.window_start,through);
   const gapReasons=[...new Set([...(task.initial_issues??[]),...coverage.reasons,...(!endpoint?['QUOTE_MISSING_AT_PREDECLARED_HORIZON']:[])])];
   const complete=!!endpoint&&coverage.complete&&!task.initial_issues?.length;
   const record={type:'SECONDARY_EXIT_POST_PATH',version:SHADOW_STORE_VERSION,authority:'NONE',ledger:'FREQUENT_PAPER',realTrading:false,
    id:task.operation_id,task_id:task.id,at:now,origin_bars:target.bars,timeframe:task.timeframe,closed_at:task.closed_at,due_at:target.due_at,
    status:complete?'OBSERVED_PATH':'NOT_EVALUABLE',reason:gapReasons[0]??null,reasons:gapReasons,
    quote:endpoint?.payload?.quote??null,window_start:task.window_start,window_end:through,path_complete:complete,
    path_reference:{task_id:task.id,from_event_at:task.window_start,to_event_at:through,quote_rows:coverage.quotes,storage:'SEPARATE_SHADOW_SQLITE'},
    market_path_complete:complete,economic_path_complete:false,fully_complete:false,counterfactual_net:null,coverage};
   const id=stable('POST_PATH',task.id,target.bars);ctx.emit({id,type:record.type,at:now,payload:record});
   target.status=complete?'OBSERVED_PATH':'NOT_EVALUABLE';target.record_id=id;target.finished_at=now;target.coverage=coverage;changed=true;
  }
  if(changed){task.status=task.targets.every(t=>t.status!=='PENDING')?'COMPLETE':'PENDING';ctx.putTask(task);}
 }
}
export function processShadowObservation(envelope,ctx,{flow=null}={}){
 const payload=envelope.payload??{},kind=envelope.kind,now=envelope.at;
 const resultMetadata={};
 if(kind==='DECISION'){
  const input=payload.input??payload,p=input.position;if(!p?.plan?.id)throw Error('SHADOW_POSITION_REQUIRED');
  const key='POSITION:'+p.plan.id,old=ctx.cursor(key),previous=old?.value??null;
  if(previous?.cursor?.quote_at>=input.quote?.event_at){ctx.metric('duplicate_quote');lifecycle(ctx,envelope);return {outcome:'DUPLICATE_QUOTE'};}
  ctx.metric('decision_computations');for(const arm of ['A_no_flow','A_flow','B_no_flow','B_flow'])ctx.metric('computed_'+arm);
  const result=evaluateHorizonShadow({...input,flow:flow??input.flow??null,now,controlReason:input.controlReason??null},previous);
  const cursor=previous?.cursor??{samples:0,transitions:0,last_at:null,signature:null};
  const signature=hash([p.qty,...Object.values(result.record.arms).map(a=>a.decision)]),transition=signature!==cursor.signature;
  const due=cursor.last_at===null||now-cursor.last_at>=Math.min(900000,Math.max(60000,p.plan.timeframe*60000));
  const emit=cursor.samples<256&&(due||transition&&cursor.transitions<32);
  const source={position:clone(p),quote:clone(input.quote),valuation:clone(input.valuation),series:clone(input.series??{}),availableQty:input.availableQty??null,controlReason:input.controlReason??null};
  const observation={...clone(result.record),source_input:source,flow_context:flow?clone(flow):null,source_input_hash:hash(source),input_id:envelope.id};
  observation.policy_record_hash=observation.hash;delete observation.hash;observation.hash=hash(observation);
  const next={...clone(result.state),cursor:{...cursor,quote_at:input.quote.event_at}};
  const latestKey='LAST_DECISION:'+p.plan.id,latest=ctx.cursor(latestKey);
  ctx.putCursor(latestKey,latest?.revision??0,{record:observation,flow_context:flow?clone(flow):null});
  if(emit){Object.assign(next.cursor,{samples:cursor.samples+1,transitions:cursor.transitions+(transition?1:0),last_at:now,signature});
   ctx.emit({id:stable('DECISION',envelope.id),type:result.record.type,at:now,payload:observation});ctx.metric('snapshots_emitted');}
  else ctx.metric('snapshots_suppressed_by_cadence_or_limit');
  // A failed emission or commit rolls the cursor back in the same transaction.
  ctx.putCursor(key,old?.revision??0,next);
  Object.assign(resultMetadata,{decision_computed:true,variant_computations:Object.keys(result.record.arms).length,snapshot_emitted:emit});
 }else if(kind==='OPPORTUNITY'){
  const context=payload.context??payload,timeframe=context.timeframe,cutoff=context.cutoff;
  if(![1,5,15,60,240].includes(timeframe)||!timestamp(cutoff)||cutoff>now||!Array.isArray(payload.decisions)||payload.decisions.length>64)throw Error('SHADOW_OPPORTUNITY_INVALID');
  const key='OPPORTUNITY:'+timeframe,old=ctx.cursor(key);
  if(!old||old.value.cutoff<cutoff){
   const compact=r=>({id:r.candidate.plan?.id??null,plan_hash:r.candidate.plan?hash(r.candidate.plan):null,pattern:r.candidate.pattern??null,control_result:r.candidate.reason??null,rank_score:r.score,flow_score:r.flow_score,eligible:r.eligible,reason:r.reason});
   const record={type:'SECONDARY_FLOW_OPPORTUNITY_SHADOW',version:HORIZON_SHADOW_VERSION,at:now,cutoff,timeframe,ledger:'FREQUENT_PAPER',realTrading:false,authority:'NONE',
    ranks:rankShadowOpportunities(payload.decisions,flow,now).map(compact),no_flow:rankShadowOpportunities(payload.decisions,flow,now,{useFlow:false}).map(compact),
    flow_status:flow?.valid?'AVAILABLE':flow?.reason??'UNAVAILABLE',source_hash:flow?hash(flow):null,actual_order_unchanged:true};
   ctx.emit({id:stable('OPPORTUNITY',timeframe,cutoff),type:record.type,at:now,payload:record});ctx.putCursor(key,old?.revision??0,{cutoff});
  }else ctx.metric('duplicate_or_old_opportunity');
 }else if(kind==='CONTEXT'){
  const {timeframe,bars}=payload;
  if(![1,5,15,60,240].includes(timeframe)||!Array.isArray(bars)||bars.length>20)throw Error('SHADOW_CONTEXT_INVALID');
  for(let index=0;index<bars.length;index++){
   const b=bars[index],received=b?.available_at??b?.received_at;
   if(!b||!timestamp(b.start)||!timestamp(b.end)||b.end-b.start!==timeframe*60000||b.end>now||!timestamp(received)||received<b.end||received>now||
    ['available_at','received_at'].some(key=>b[key]!==undefined&&(!timestamp(b[key])||b[key]>now))||
    !['high','low','close'].every(key=>finite(b[key])&&Number(b[key])>0)||Number(b.high)<Number(b.low)||Number(b.close)<Number(b.low)||Number(b.close)>Number(b.high)||
    b.open!==undefined&&(!finite(b.open)||Number(b.open)<Number(b.low)||Number(b.open)>Number(b.high))||
    index>0&&b.end<=bars[index-1].end)throw Error('SHADOW_CONTEXT_CAUSAL_BARS_REQUIRED');
  }
  const cutoff=bars.at(-1)?.end??null;
  if(payload.cutoff!==undefined&&payload.cutoff!==cutoff)throw Error('SHADOW_CONTEXT_CUTOFF_INVALID');
  const key='CONTEXT:'+timeframe,old=ctx.cursor(key),sourceHash=hash({timeframe,cutoff,bars});
  if(cutoff!==null&&old?.value?.cutoff!==null&&old?.value?.cutoff>cutoff)throw Error('SHADOW_CONTEXT_CUTOFF_OLD');
  if(old?.value?.source_hash===sourceHash)ctx.metric('duplicate_context');
  else{
   ctx.emit({id:stable('CONTEXT',envelope.id),type:'SECONDARY_SHADOW_CONTEXT',at:now,payload:{type:'SECONDARY_SHADOW_CONTEXT',version:SHADOW_STORE_VERSION,authority:'NONE',ledger:'FREQUENT_PAPER',realTrading:false,
    at:now,received_at:envelope.received_at,timeframe,cutoff,bars:clone(bars),source_hash:sourceHash,quality:bars.length?'AS_OBSERVED_CLOSED_BARS':'UNAVAILABLE',counterfactual_net:null}});
   ctx.putCursor(key,old?.revision??0,{cutoff:cutoff??old?.value?.cutoff??null,source_hash:sourceHash,last_context_at:now});ctx.metric('context_snapshots');
  }
 }else if(kind==='QUOTE'){
  const q=payload.quote,consumed=payload.consumed_by_simulator===true,old=ctx.cursor('MARKET:QUOTE');
  ctx.metric(consumed?'simulator_quote_inputs':'auxiliary_quote_inputs');
  ctx.appendPath(envelope);
  if(!secondaryFresh(q,now)||q.received_at>envelope.received_at||q.event_at>now){
   ctx.gap({id:stable('INVALID_QUOTE',envelope.id),from_at:now,to_at:now,reason:'QUOTE_INVALID_STALE_OR_CLOCK_SKEW'});
  }else if(consumed&&(!old||q.event_at>old.value.event_at)){
   if(old&&q.event_at-old.value.event_at>ctx.limits.maxQuoteGapMs)ctx.gap({id:stable('QUOTE_GAP',old.value.event_at,q.event_at),from_at:old.value.event_at,to_at:q.event_at,reason:'EXECUTABLE_QUOTE_GAP'});
   const hour=Math.floor(q.event_at/3600000)*3600000;
   if(!finite(payload.rates?.[hour]))ctx.gap({id:stable('FUNDING_GAP',envelope.id),from_at:q.event_at,to_at:q.event_at,reason:'FUNDING_RATE_UNAVAILABLE',domain:'FUNDING'});
   ctx.putCursor('MARKET:QUOTE',old?.revision??0,{event_at:q.event_at,received_at:q.received_at,envelope_id:envelope.id});
  }else if(consumed&&old&&q.event_at<old.value.event_at)ctx.gap({id:stable('REORDERED_QUOTE',envelope.id),from_at:q.event_at,to_at:old.value.event_at,reason:'SIMULATOR_QUOTE_TIME_REORDERED'});
 }else if(kind==='CLOSED'||kind==='ECONOMIC'){
  const event=payload.event;if(!event||typeof event.type!=='string'||event.ledger!=='FREQUENT_PAPER'||event.realTrading!==false)throw Error('SHADOW_SECONDARY_EVENT_REQUIRED');
  if(!['SELECTED','FILLED','PARTIAL_FILL','PARTIAL_CLOSE','CLOSED','FUNDING_RECONCILED','SECONDARY_EXIT_SELECTED','SECONDARY_EXIT_PRIORITY_UPDATED','SECONDARY_ENTRY_REJECTED','NOT_FILLED','ORDER_REMAINDER_CANCELLED','ACTIVE_SCALE_OUT_SELECTED','ACTIVE_SCALE_OUT_SETTLED'].includes(event.type))throw Error('SHADOW_ECONOMIC_TYPE_UNSUPPORTED');
  const eventId=stable('ECONOMIC',event.type,event.id,event.fill_id??null,event.at,event.type==='FUNDING_RECONCILED'?event.net_after:null);
  ctx.emit({id:eventId,type:event.type,at:event.at??now,payload:{...clone(event),shadow_copy:true,authority:'NONE'}});
  if(event.type==='CLOSED'){
   const operation=payload.id??payload.operation_id??event.id,timeframe=payload.timeframe??event.timeframe??event.plan?.timeframe,closed=payload.closed_at??event.at;
   if(typeof operation!=='string'||!operation||![1,5,15,60,240].includes(timeframe)||!timestamp(closed)||closed>now||operation!==event.id)throw Error('SHADOW_CLOSE_TASK_CONTRACT_INVALID');
   const entered=event.entered_at??payload.entered_at,issues=[];
   if(payload.source_receipt_missing||event.source_receipt_missing)issues.push('SOURCE_CLOSE_RECEIPT_MISSING');
   let start=timestamp(entered)&&entered<=closed?entered:closed;
   if(start===closed&&entered!==closed)issues.push('ENTRY_TIME_UNAVAILABLE');
   if(closed-start>ctx.limits.maxActiveWindowMs){start=closed-ctx.limits.maxActiveWindowMs;issues.push('ENTRY_WINDOW_EXCEEDS_RETENTION_CONTRACT');}
   const id=stable('FOLLOWUP',operation,closed),task={id,operation_id:operation,timeframe,direction:payload.direction??event.direction??event.plan?.direction??null,
    closed_at:closed,window_start:start,window_end:closed+3*timeframe*60000,status:'PENDING',created_at:now,
    origin_id:envelope.id,close_record_id:eventId,initial_issues:issues,close_net_usd:event.pnl??payload.net_usd??null,
    close_net_is_final:event.result_final===true&&event.funding_complete===true,
    targets:[1,3].map(bars=>({bars,due_at:closed+bars*timeframe*60000,status:'PENDING',record_id:null}))};
   ctx.schedule(task);
  }
 }else if(kind==='GAP'||kind==='BOOT'){
  const old=ctx.cursor('OBSERVER:LIFECYCLE'),market=ctx.cursor('MARKET:QUOTE');
  const from=timestamp(payload.from_at??payload.first_at)?payload.from_at??payload.first_at:market?.value?.received_at??old?.value?.at??now,to=timestamp(payload.to_at??payload.last_at)?payload.to_at??payload.last_at:now;
  if(payload.gap_key!==undefined&&(typeof payload.gap_key!=='string'||!payload.gap_key||payload.gap_key.length>256))throw Error('SHADOW_GAP_KEY_INVALID');
  if(kind==='BOOT')ctx.closeOpenGaps();
  ctx.gap({id:payload.gap_key?stable('GAP_EPISODE',payload.gap_key):stable('GAP',envelope.id),from_at:Math.min(from,to),to_at:Math.max(from,to),reason:payload.reason??(kind==='BOOT'?'OBSERVER_RESTART':'OBSERVATION_INPUT_LOSS'),domain:payload.flow_only?'FLOW':'MARKET',open:payload.open===true});
  ctx.putCursor('OBSERVER:LIFECYCLE',old?.revision??0,{at:now,stream_id:envelope.stream_id});
  if(kind==='BOOT')ctx.emit({id:stable('BOOT',envelope.id),type:'SHADOW_OBSERVER_BOOT',at:now,payload:{...clone(payload),at:now,authority:'NONE',ledger:'FREQUENT_PAPER',realTrading:false}});
 }else if(kind!=='HEARTBEAT')throw Error('SHADOW_KIND_UNSUPPORTED');
 lifecycle(ctx,envelope);
 return {outcome:'APPLIED',...resultMetadata};
}
