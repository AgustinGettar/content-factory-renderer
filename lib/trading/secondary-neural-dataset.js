// External-runner reducer of immutable PAPER events. Never used by the worker loop.
// Input is a paginated, consistent SQLite snapshot export, not the monitor's history.
import {D,hash} from './core.js';
import {buildSecondaryNeuralLabel,NEURAL_LABEL_VERSION,NEURAL_SIGNAL_VERSION,NEURAL_DATA_LIMITS} from './secondary-neural-data.js';

export const NEURAL_DATASET_VERSION='secondary-neural-dataset-1.0.0';
export const NEURAL_DATASET_CHECKPOINT_VERSION='secondary-neural-event-checkpoint-1.0.0';
export const NEURAL_DATASET_LIMITS=Object.freeze({page:500,operations:20000,signals:50000,eventBytes:1048576,checkpointBytes:64*1024*1024,recentEvents:2048,labelHistory:8,fragmentsPerOperation:4096});
export const NEURAL_DATASET_EVENT_KINDS=Object.freeze(['NEURAL_SIGNAL_CAPTURED','NEURAL_ENTRY_DECISION','NEURAL_LABEL_RECORDED','SELECTED','FILLED','PARTIAL_FILL','PARTIAL_CLOSE','CLOSED','FUNDING_RECONCILED','NOT_FILLED','ORDER_REMAINDER_CANCELLED']);
const LIMIT=NEURAL_DATASET_LIMITS,SUPPORTED=new Set(NEURAL_DATASET_EVENT_KINDS),COPY=value=>structuredClone(value);
const timestamp=value=>Number.isSafeInteger(value)&&value>=0;
const identifier=value=>typeof value==='string'&&/^[A-Za-z0-9:_-]{1,128}$/.test(value)&&!['__proto__','prototype','constructor'].includes(value);
const pick=(value,keys)=>Object.fromEntries(keys.filter(key=>value?.[key]!==undefined).map(key=>[key,value[key]]));
const paper=(mode,realTrading)=>{if(mode!=='PAPER'||realTrading!==false)throw Error('NEURAL_DATASET_PAPER_ONLY');};
const digestWithout=(value,key)=>hash({...value,[key]:undefined});
const semanticLabel=label=>Object.fromEntries(Object.entries(label).filter(([key])=>!['label_revision','label_hash','content_hash','supersedes_label_hash'].includes(key)));
const planKeys=['id','version','entry_revision','instrument','execution_model','execution_contract','economic_policy','exit_policy','sizing'];
const eventKeys=['type','id','fill_id','at','price','qty','fee','pnl','fees','gross','funding','entered_at','remaining_qty','reason','quality','management_override','result_final','funding_complete','entry_fills','excursions','data_gaps','amount','net_adjustment','net_after','position_open','remaining_intervals'];
const decisionKeys=['version','signal_id','operation_id','snapshot_hash','at','mode','model_id','base_reason','base_rank','base_candidate_count','base_eligible','cohort_id','cohort_eligible_count','effective_action','pattern'];
const predictionKeys=['status','reason','estimated_net_return','model_id','model_sha256','generated_at','decision_at','signal_id','operation_id','input_hash','kind','latency_ms','technical_failure','authority','role'];
const compact=event=>({...COPY(pick(event,eventKeys)),...(event.plan?{plan:COPY(pick(event.plan,planKeys))}:{})});
const opportunity=row=>({operation_id:row.operation_id,signal_id:row.snapshot.signal_id,snapshot_hash:row.snapshot.snapshot_hash,decision_at:row.snapshot.decision_at,movement_key:row.snapshot.context?.movement_key??null,feature_version:row.snapshot.feature_version??null,feature_schema_hash:row.snapshot.feature_schema_hash??null,domain:COPY(row.snapshot.domain??null),decision:{...COPY(pick(row.decision,decisionKeys)),prediction:row.decision.prediction?COPY(pick(row.decision.prediction,predictionKeys)):null,candidate_predictions:Array.isArray(row.decision.candidate_predictions)?row.decision.candidate_predictions.map(value=>COPY(pick(value,predictionKeys))):[]}});
const initial=sourceId=>({version:NEURAL_DATASET_CHECKPOINT_VERSION,mode:'PAPER',realTrading:false,source_id:sourceId,cursor:0,as_of:0,operations:{},signals:{},recent_events:{},counts:{events:0,ignored:0,captures:0,valid_features:0,excluded_features:0,decisions:0,label_updates:0,worker_label_disagreements:0},feature_exclusions:{},first_event_at:null,last_event_at:null});
const usableLabel=label=>label?.status==='MATURE';

function validateLabel(label){
 if(!label||label.version!==NEURAL_LABEL_VERSION||label.mode!=='PAPER'||label.realTrading!==false||typeof label.operation_id!=='string'||!label.operation_id||label.operation_id.length>128||!['MATURE','PENDING','EXCLUDED'].includes(label.status)||!Number.isSafeInteger(label.label_revision)||label.label_revision<1||label.label_hash!==digestWithout(label,'label_hash')||label.content_hash!==hash(semanticLabel(label)))throw Error('NEURAL_DATASET_LABEL_INVALID');
 if(usableLabel(label)){
  if(!timestamp(label.entered_at)||!timestamp(label.closed_at)||!timestamp(label.mature_at)||!(label.entered_at<label.closed_at&&label.closed_at<=label.mature_at)||label.funding_final!==true||label.manual_override!==false||!['OBSERVED','OBSERVED_PRICE_RECONCILED_FUNDING'].includes(label.quality)||![label.exposure,label.net,label.net_return,label.costs].every(value=>value!==null&&value!==undefined&&Number.isFinite(Number(value)))||!D(label.exposure).gt(0)||D(label.net).div(label.exposure).minus(label.net_return).abs().gt('0.000000000001'))throw Error('NEURAL_DATASET_MATURE_LABEL_INVALID');
 }
 return label;
}

function nextLabel(candidate,previous,forcedExclusion=null){
 let semantics=semanticLabel(candidate);
 if(forcedExclusion)semantics={...semantics,status:'EXCLUDED',exclusion:forcedExclusion,net_return:null};
 const contentHash=hash(semantics);if(previous?.content_hash===contentHash)return previous;
 const label={...semantics,label_revision:(previous?.label_revision??0)+1,content_hash:contentHash,supersedes_label_hash:previous?.label_hash??null};label.label_hash=hash(label);return label;
}

/**
 * The caller persists checkpoint() atomically with the private trainer checkpoint.
 * SQLite rowid is the monotone source cursor; pages may have gaps due to kind filters.
 */
export class SecondaryNeuralDataset {
 constructor({checkpoint=null,sourceId='AWS:KRAKEN_BTCUSD_PAPER',mode='PAPER',realTrading=false}={}){
  paper(mode,realTrading);if(typeof sourceId!=='string'||!sourceId||sourceId.length>256)throw Error('NEURAL_DATASET_SOURCE_INVALID');
  if(checkpoint){
   if(checkpoint.version!==NEURAL_DATASET_CHECKPOINT_VERSION||checkpoint.source_id!==sourceId||checkpoint.mode!=='PAPER'||checkpoint.realTrading!==false||checkpoint.checkpoint_hash!==digestWithout(checkpoint,'checkpoint_hash')||!timestamp(checkpoint.cursor)||!timestamp(checkpoint.as_of)||!checkpoint.operations||!checkpoint.signals||!checkpoint.recent_events||!checkpoint.counts)throw Error('NEURAL_DATASET_CHECKPOINT_INVALID');
   if(Buffer.byteLength(JSON.stringify(checkpoint))>LIMIT.checkpointBytes)throw Error('NEURAL_DATASET_CHECKPOINT_LIMIT');
   this.state=COPY(checkpoint);delete this.state.checkpoint_hash;
  }else this.state=initial(sourceId);
  this.validateLimits(this.state);
 }
 get cursor(){return this.state.cursor;}
 operation(state,id){
  if(!identifier(id))throw Error('NEURAL_DATASET_OPERATION_INVALID');
  if(!state.operations[id]){
   if(Object.keys(state.operations).length>=LIMIT.operations)throw Error('NEURAL_DATASET_OPERATION_LIMIT');
   state.operations[id]={operation_id:id,snapshot:null,snapshot_rowid:null,decision:null,selected_rowid:null,first_fill_rowid:null,entries:[],exits:[],funding:[],closed:null,worker_label:null,label:null,label_history:[],unfilled:false};
  }
  return state.operations[id];
 }
 validateLimits(state){
  if(Object.keys(state.operations).length>LIMIT.operations||Object.keys(state.signals).length>LIMIT.signals||Object.keys(state.recent_events).length>LIMIT.recentEvents||Buffer.byteLength(JSON.stringify(state))>LIMIT.checkpointBytes)throw Error('NEURAL_DATASET_CHECKPOINT_LIMIT');
 }
 append(row,key,event){
  const id=event.fill_id??hash(event),before=row[key].find(value=>(value.fill_id??hash(value))===id);
  if(before){if(hash(before)!==hash(event))throw Error('NEURAL_DATASET_FRAGMENT_CONFLICT');return;}
  if(row[key].length>=LIMIT.fragmentsPerOperation)throw Error('NEURAL_DATASET_FRAGMENT_LIMIT');row[key].push(COPY(event));
 }
 setLabel(state,row,candidate,rowid,source){
  if(!candidate)return;
  const firstAction=row.selected_rowid??row.first_fill_rowid,late=row.snapshot_rowid!=null&&firstAction!=null&&row.snapshot_rowid>=firstAction;
  const exclusion=!row.snapshot?'NO_PRE_ENTRY_SNAPSHOT':candidate.snapshot_hash!==row.snapshot.snapshot_hash?'LABEL_SNAPSHOT_MISMATCH':late?'PRE_ENTRY_SNAPSHOT_RECORDED_TOO_LATE':null;
  const next=nextLabel(candidate,row.label,exclusion);
  if(next.label_hash===row.label?.label_hash)return;
  row.label=next;row.label_history.push({rowid,source,status:next.status,revision:next.label_revision,label_hash:next.label_hash,supersedes:next.supersedes_label_hash});row.label_history=row.label_history.slice(-LIMIT.labelHistory);state.counts.label_updates++;
 }
 rebuild(state,row,rowid){
  if(!row.closed)return;
  const candidate=buildSecondaryNeuralLabel({snapshot:row.snapshot,closed:row.closed,entryEvents:row.entries,exitEvents:row.exits,fundingEvents:row.funding});
  this.setLabel(state,row,candidate,rowid,'DURABLE_EXECUTION_EVENTS');
 }
 applyEvent(state,event,rowid){
  if(event.realTrading===true||event.mode&&event.mode!=='PAPER')throw Error('NEURAL_DATASET_PAPER_ONLY');
  if(event.ledger&&event.ledger!=='FREQUENT_PAPER'){state.counts.ignored++;return;}
  if(event.type==='NEURAL_SIGNAL_CAPTURED'){
   const snapshot=event.snapshot;
   if(!snapshot||snapshot.version!==NEURAL_SIGNAL_VERSION||snapshot.mode!=='PAPER'||snapshot.realTrading!==false||snapshot.snapshot_hash!==digestWithout(snapshot,'snapshot_hash')||!identifier(snapshot.signal_id)||!timestamp(snapshot.decision_at)||snapshot.decision_at>state.as_of||Buffer.byteLength(JSON.stringify(snapshot))>NEURAL_DATA_LIMITS.snapshotBytes)throw Error('NEURAL_DATASET_CAPTURE_INVALID');
   const old=state.signals[snapshot.signal_id];if(old){if(old.snapshot_hash!==snapshot.snapshot_hash)throw Error('NEURAL_DATASET_CAPTURE_CONFLICT');return;}
   if(Object.keys(state.signals).length>=LIMIT.signals)throw Error('NEURAL_DATASET_SIGNAL_LIMIT');
   state.signals[snapshot.signal_id]={snapshot_hash:snapshot.snapshot_hash,rowid,operation_id:snapshot.operation_id,at:snapshot.decision_at,features_usable:Array.isArray(snapshot.x),exclusion:snapshot.exclusion,decision:null};state.counts.captures++;
   if(Array.isArray(snapshot.x))state.counts.valid_features++;else{state.counts.excluded_features++;const reason=snapshot.exclusion??'FEATURES_UNAVAILABLE';state.feature_exclusions[reason]=(state.feature_exclusions[reason]??0)+1;}
   if(snapshot.operation_id){const row=this.operation(state,snapshot.operation_id);if(row.snapshot&&row.snapshot.snapshot_hash!==snapshot.snapshot_hash)throw Error('NEURAL_DATASET_OPERATION_CAPTURE_CONFLICT');row.snapshot=COPY(snapshot);row.snapshot_rowid=rowid;if(row.closed)this.rebuild(state,row,rowid);else if(row.worker_label)this.setLabel(state,row,row.worker_label,rowid,'DURABLE_WORKER_LABEL');}
   return;
  }
  if(event.type==='NEURAL_ENTRY_DECISION'){
   const decision=event.decision;
   if(!decision||typeof decision.signal_id!=='string'||!timestamp(decision.at)||decision.at>state.as_of)throw Error('NEURAL_DATASET_DECISION_INVALID');
   const signal=state.signals[decision.signal_id];
   if(signal){if(signal.snapshot_hash!==decision.snapshot_hash)throw Error('NEURAL_DATASET_DECISION_SNAPSHOT_MISMATCH');if(signal.decision&&hash(signal.decision)!==hash(decision))throw Error('NEURAL_DATASET_DECISION_CONFLICT');if(!signal.decision)state.counts.decisions++;signal.decision=COPY(decision);}
   if(decision.operation_id){const row=this.operation(state,decision.operation_id);if(row.decision&&hash(row.decision)!==hash(decision))throw Error('NEURAL_DATASET_DECISION_CONFLICT');row.decision=COPY(decision);}
   return;
  }
  if(event.type==='NEURAL_LABEL_RECORDED'){
   const label=validateLabel(event.label);if(label.mature_at!=null&&(!timestamp(label.mature_at)||label.mature_at>state.as_of))throw Error('NEURAL_DATASET_FUTURE_LABEL');
   const row=this.operation(state,label.operation_id);row.worker_label=COPY(label);
   if(row.closed){this.rebuild(state,row,rowid);if(row.label?.content_hash!==label.content_hash)state.counts.worker_label_disagreements++;}
   else this.setLabel(state,row,label,rowid,'DURABLE_WORKER_LABEL');
   return;
  }
  const plan=event.plan;
  if((event.version??plan?.version)!=='secondary-futures-1.0.0'||plan?.instrument&&plan.instrument!=='PAPER:KRAKEN_FUTURES:PF_XBTUSD'){state.counts.ignored++;return;}
  if(!event.id){state.counts.ignored++;return;}
  if(!timestamp(event.at)||event.at>state.as_of)throw Error('NEURAL_DATASET_EVENT_TIME_INVALID');
  const row=this.operation(state,event.id),small=compact(event);
  if(event.type==='SELECTED'){row.selected_rowid??=rowid;return;}
  if(event.type==='NOT_FILLED'){row.unfilled=true;return;}
  if(event.type==='ORDER_REMAINDER_CANCELLED')return;
  if(['FILLED','PARTIAL_FILL'].includes(event.type)){row.first_fill_rowid??=rowid;this.append(row,'entries',small);if(row.closed)this.rebuild(state,row,rowid);return;}
  if(event.type==='PARTIAL_CLOSE'){this.append(row,'exits',small);if(row.closed)this.rebuild(state,row,rowid);return;}
  if(event.type==='FUNDING_RECONCILED'){this.append(row,'funding',small);this.rebuild(state,row,rowid);return;}
  if(event.type==='CLOSED'){
   if(row.closed&&hash(row.closed)!==hash(small))throw Error('NEURAL_DATASET_CLOSE_CONFLICT');
   row.closed=small;this.append(row,'exits',small);this.rebuild(state,row,rowid);
  }
 }
 applyPage(events,{asOf}={}){
  if(!Array.isArray(events)||events.length>LIMIT.page)throw Error('NEURAL_DATASET_PAGE_LIMIT');
  if(!timestamp(asOf)||asOf<this.state.as_of)throw Error('NEURAL_DATASET_SNAPSHOT_TIME_INVALID');
  // A malformed page cannot partially advance its durable cursor or labels.
  const state=COPY(this.state);state.as_of=asOf;let processed=0,replayed=0,previousRowid=-1;
  for(const source of events){
   const rowid=source?.rowid??source?.seq;
   if(!Number.isSafeInteger(rowid)||rowid<1||rowid<previousRowid)throw Error('NEURAL_DATASET_EVENT_CURSOR_INVALID');previousRowid=rowid;
   if(Buffer.byteLength(JSON.stringify(source))>LIMIT.eventBytes)throw Error('NEURAL_DATASET_EVENT_LIMIT');
   const event=typeof source.payload==='string'?JSON.parse(source.payload):source.payload;
   if(!event||typeof event!=='object'||typeof event.type!=='string'||source.kind&&source.kind!==event.type)throw Error('NEURAL_DATASET_EVENT_INVALID');
   const fingerprint=hash({id:source.id??null,kind:source.kind??event.type,payload:event}),remembered=state.recent_events[rowid];
   if(rowid<=state.cursor){if(remembered&&remembered!==fingerprint)throw Error('NEURAL_DATASET_REPLAY_CONFLICT');replayed++;continue;}
   if(SUPPORTED.has(event.type))this.applyEvent(state,event,rowid);else state.counts.ignored++;
   state.cursor=rowid;state.recent_events[rowid]=fingerprint;state.counts.events++;processed++;
   const at=timestamp(event.at)?event.at:null;if(at!==null){state.first_event_at=state.first_event_at===null?at:Math.min(state.first_event_at,at);state.last_event_at=Math.max(state.last_event_at??at,at);}
   const ids=Object.keys(state.recent_events);if(ids.length>LIMIT.recentEvents)delete state.recent_events[ids[0]];
  }
  this.validateLimits(state);this.state=state;return {processed,replayed,cursor:state.cursor,counts:this.summary()};
 }
 acknowledgeExport({cursorEnd,highWatermark,asOf,exportHash,complete}={}){
  if(!timestamp(cursorEnd)||cursorEnd<this.state.cursor||!timestamp(highWatermark)||cursorEnd>highWatermark||!timestamp(asOf)||asOf<this.state.as_of||!/^[a-f0-9]{64}$/.test(exportHash??'')||typeof complete!=='boolean'||complete&&cursorEnd!==highWatermark)throw Error('NEURAL_DATASET_EXPORT_CHECKPOINT_INVALID');
  // An exporter can scan filtered-out primary events after the last emitted
  // secondary event. Acknowledge that source range without manufacturing events.
  this.state.cursor=cursorEnd;this.state.as_of=asOf;this.state.last_export={cursor_end:cursorEnd,snapshot_high_watermark:highWatermark,as_of:asOf,sha256:exportHash,complete};return this.cursor;
 }
 summary(){
  const rows=Object.values(this.state.operations),labels=rows.map(row=>row.label).filter(Boolean),exclusions={};
  for(const label of labels)if(label.exclusion)exclusions[label.exclusion]=(exclusions[label.exclusion]??0)+1;
  return {...this.state.counts,operations:rows.length,usable:labels.filter(usableLabel).length,excluded:labels.filter(label=>label.status==='EXCLUDED').length,pending_labels:labels.filter(label=>label.status==='PENDING').length,unfilled:rows.filter(row=>row.unfilled&&!row.closed).length,unlabelled:rows.filter(row=>!row.label).length,exclusions,feature_exclusions:COPY(this.state.feature_exclusions)};
 }
 checkpoint(){const result=COPY(this.state);result.checkpoint_hash=hash(result);return result;}
 export({asOf=this.state.as_of}={}){
  if(!timestamp(asOf)||asOf<this.state.as_of)throw Error('NEURAL_DATASET_SNAPSHOT_TIME_INVALID');
  const operations=Object.values(this.state.operations),rows=operations.filter(row=>row.label).sort((a,b)=>(a.label.closed_at??0)-(b.label.closed_at??0)||a.operation_id.localeCompare(b.operation_id)).map(row=>({snapshot:COPY(row.snapshot),label:COPY(row.label),decision:COPY(row.decision)}));
  // This separate denominator includes unavailable predictions and unfilled or
  // pending operations. It never assigns a hypothetical outcome or training y.
  const opportunities=operations.filter(row=>row.snapshot&&row.decision).map(opportunity).sort((a,b)=>a.decision_at-b.decision_at||a.operation_id.localeCompare(b.operation_id));
  if(rows.some(row=>row.label.mature_at!=null&&row.label.mature_at>asOf))throw Error('NEURAL_DATASET_FUTURE_LABEL');
  const result={version:NEURAL_DATASET_VERSION,mode:'PAPER',realTrading:false,source:'DURABLE_SQLITE_EVENTS',as_of:asOf,rows,opportunities,opportunities_complete:this.state.last_export?.complete!==false,counts:this.summary(),checkpoint:{version:NEURAL_DATASET_CHECKPOINT_VERSION,source_id:this.state.source_id,cursor:this.state.cursor,checkpoint_hash:this.checkpoint().checkpoint_hash},unexecuted_outcomes:'UNLABELLED_NOT_LOSSES'};
  if(Buffer.byteLength(JSON.stringify(result))>LIMIT.checkpointBytes)throw Error('NEURAL_DATASET_EXPORT_LIMIT');return result;
 }
}
