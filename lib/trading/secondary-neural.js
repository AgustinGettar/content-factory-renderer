// Optional sidecar records inside the existing fenced PAPER writer.
// No training, network, account mutations or plan enrichment occurs here.
import {open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {dirname,join} from 'node:path';
import {hash} from './core.js';
import {captureSecondaryNeuralSignal,buildSecondaryNeuralLabel,NEURAL_FEATURE_VERSION,NEURAL_FEATURE_SCHEMA_HASH} from './secondary-neural-data.js';
import {SecondaryNeuralRuntime} from './secondary-neural-runtime.js';

export const SECONDARY_NEURAL_VERSION='secondary-neural-1.0.0';
export const SECONDARY_NEURAL_PROTOCOL=Object.freeze({version:SECONDARY_NEURAL_VERSION,feature_version:NEURAL_FEATURE_VERSION,feature_schema_hash:NEURAL_FEATURE_SCHEMA_HASH,mode:'PAPER',symbol:'PF_XBTUSD',ledger:'FREQUENT_PAPER',realTrading:false,training_location:'EXTERNAL_RUNNER_ONLY',target:'FINAL_NET_DIVIDED_BY_EXECUTED_EXPOSURE',assistance:'PRIORITIZATION_ONLY',max_candidate_models:1,max_networks_per_decision:2,max_pending:128,max_recent:64,max_fragment_events:256,max_state_bytes:1500000,refresh_ms:60000,max_status_bytes:65536});
const LIMIT=SECONDARY_NEURAL_PROTOCOL,MODES=['OFF','COLLECTING','ADVISORY','ASSISTED'];
const pick=(o,keys)=>Object.fromEntries(keys.filter(k=>o?.[k]!==undefined).map(k=>[k,o[k]]));
const copy=x=>structuredClone(x);
const safeCode=e=>/^[A-Z][A-Z0-9_]{1,100}$/.test(e?.message??'')?e.message:'NEURAL_OPTIONAL_COMPONENT_FAILED';
const integrity=e=>/^TRADING_|^SQLITE_|^SECONDARY_.*(HASH|INTEGRITY|PAPER_ONLY)/.test(e?.message??'');
const planKeys=['id','version','entry_revision','instrument','execution_model','execution_contract','economic_policy','exit_policy','sizing'];
const eventKeys=['type','id','fill_id','at','price','qty','fee','pnl','fees','gross','funding','entered_at','remaining_qty','reason','quality','management_override','result_final','funding_complete','entry_fills','excursions','data_gaps','amount','net_adjustment','net_after','position_open','remaining_intervals'];
const compactEvent=e=>({...copy(pick(e,eventKeys)),...(e.plan?{plan:copy(pick(e.plan,planKeys))}:{})});
const freshState=(now,mode)=>({version:SECONDARY_NEURAL_VERSION,protocol:{...LIMIT},protocol_hash:hash(LIMIT),started_at:now,requested_mode:mode,runtime:{},candidate_runtime:{},counts:{evaluations:0,captures:0,valid_features:0,excluded_features:0,usable:0,excluded:0,pending_labels:0,unfilled:0,label_revisions:0},feature_exclusions:{},label_exclusions:{},pending:{},recent:{},last_decisions:[],last_capture_at:null,last_label_at:null,last_failure:null,training:null});

export class SecondaryNeural {
 constructor({engine,env={},now=()=>Date.now(),runtimeFactory=options=>new SecondaryNeuralRuntime(options)}){
  if(env.LUMI_TRADING_MODE!=='PAPER'||env.LUMI_RUNTIME_ENV!=='staging'||env.LUMI_TRADING_STORAGE!=='SQLITE')throw Error('SECONDARY_NEURAL_PAPER_ONLY');
  this.engine=engine;this.now=now;this.env=env;this.current=new Map();this.refreshing=false;this.lastRefresh=-Infinity;
  const requested=env.LUMI_TRADING_SECONDARY_NEURAL_MODE??'OFF',mode=MODES.includes(requested)?requested:'OFF';
  const previous=engine.state.secondaryNeural;
  if(previous&&(previous.version!==SECONDARY_NEURAL_VERSION||previous.protocol_hash!==hash(LIMIT))){
   // Preserve incompatible history verbatim. An optional schema cannot crash boot.
   this.state=previous;this.disabled=true;previous.last_failure={at:now(),reason:'NEURAL_PERSISTED_SCHEMA_INCOMPATIBLE'};previous.effective_mode='DEGRADED';return;
  }
  this.state=engine.state.secondaryNeural??=freshState(now(),mode);this.state.requested_mode=mode;
  this.runtime=runtimeFactory({state:this.state.runtime,mode,context:{mode:'PAPER',environment:'staging',storage:'SQLITE'},now,event:e=>this.runtimeEvent(e)});
  this.state.candidate_runtime??={};
  try{this.candidateRuntime=runtimeFactory({state:this.state.candidate_runtime,mode:mode==='OFF'?'OFF':mode==='COLLECTING'?'COLLECTING':'ADVISORY',context:{mode:'PAPER',environment:'staging',storage:'SQLITE'},now,event:e=>this.runtimeEvent(e,'CANDIDATE')});}catch(error){this.candidateFailure(error);}
  if(!previous)this.emit({type:'NEURAL_ENABLED',at:now(),version:SECONDARY_NEURAL_VERSION,mode,protocol_hash:this.state.protocol_hash});
  if(requested!==mode)this.failure(Error('NEURAL_REQUESTED_MODE_INVALID'));
 }
 emit(e){this.engine.event({...e,ledger:'FREQUENT_PAPER',realTrading:false});}
 failure(error){
  if(integrity(error))throw error;
  const failure={at:this.now(),reason:safeCode(error)},before=this.state.last_failure;
  this.state.last_failure=failure;this.state.effective_mode='DEGRADED';
  if(this.runtime?.fail)this.runtime.fail(failure.reason);
  if(before?.reason!==failure.reason)this.emit({type:'NEURAL_FALLBACK',...failure,behavior:'BASE_RULES_CONTINUE'});
 }
 guard(fn,fallback=null){if(this.disabled)return fallback;try{return fn();}catch(error){this.failure(error);return fallback;}}
 candidateFailure(error){
  if(integrity(error))throw error;
  const failure={at:this.now(),reason:safeCode(error)},before=this.state.candidate_failure;this.state.candidate_failure=failure;
  this.candidateRuntime?.fail(failure.reason);
  if(before?.reason!==failure.reason)this.emit({type:'NEURAL_CANDIDATE_FALLBACK',...failure,behavior:'ACTIVE_MODEL_AND_BASE_RULES_UNCHANGED'});
 }
 runtimeEvent(e,scope='OPERATIONAL'){
  const event={...e,type:String(e.type??'NEURAL_RUNTIME_STATUS'),at:e.at??this.now(),scope};
  if(!event.type.startsWith('NEURAL_'))event.type='NEURAL_RUNTIME_STATUS';
  this.emit(event);
  if(scope==='CANDIDATE')return; // Candidate telemetry cannot claim that operational assistance changed.
  const mode=event.effective_mode??event.mode??event.to;
  if(mode&&['COLLECTING','ADVISORY','ASSISTED','DEGRADED','OFF'].includes(mode)){
   const key=hash([mode,event.reason??null,event.model_id??null]);
   if(this.state.notice_key!==key){this.state.notice_key=key;this.engine.notice?.('SECONDARY_NEURAL',{mode,reason:event.reason??null,model_id:event.model_id??null,base_rules_continue:true},['secondary-neural-state',key,event.at]);}
  }
 }
 prepare(decisions,context){
  const supplied=context.baseOrder,validOrder=Array.isArray(supplied)&&supplied.length===decisions.length&&new Set(supplied).size===decisions.length&&supplied.every(d=>decisions.includes(d));
  const base=validOrder?[...supplied]:[...decisions].sort((a,b)=>(b.plan?.economics.netRR??-1)-(a.plan?.economics.netRR??-1));
  return this.guard(()=>{
   this.current.clear();this.state.counts.evaluations+=decisions.length;this.state.last_evaluation_at=context.now;
   if(this.state.requested_mode==='OFF')return base;
   const snapshots=[];
   for(const decision of decisions){
    if(!decision.plan&&!decision.facts?.pattern_detected)continue;
    const snapshot=captureSecondaryNeuralSignal({...context,decision,existing:this.engine.state.frequency.account});
    this.emit({type:'NEURAL_SIGNAL_CAPTURED',at:context.now,id:snapshot.snapshot_id,snapshot});
    this.state.counts.captures++;this.state.last_capture_at=context.now;
    if(snapshot.x)this.state.counts.valid_features++;else{this.state.counts.excluded_features++;const reason=snapshot.exclusion??'FEATURES_UNAVAILABLE';this.state.feature_exclusions[reason]=(this.state.feature_exclusions[reason]??0)+1;}
    this.current.set(snapshot.signal_id,{snapshot,decision,prediction:null,candidate_predictions:[],base_rank:base.indexOf(decision)});snapshots.push(snapshot);
   }
   const result=this.runtime.prioritize(base,snapshots);
   const ordered=result?.decisions??base,predictions=result?.predictions??[];
   for(const row of this.current.values())row.prediction=Array.isArray(predictions)?predictions.find(p=>p.signal_id===row.snapshot.signal_id)??null:predictions[row.snapshot.signal_id]??null;
   if(ordered.length!==base.length||ordered.some(d=>!base.includes(d))||new Set(ordered).size!==new Set(base).size)throw Error('NEURAL_CANDIDATE_SET_CHANGED');
   if(this.candidateRuntime&&this.state.requested_mode!=='COLLECTING'&&this.runtime.view().requested_mode!=='OFF'){
    try{
     const candidate=this.candidateRuntime.view().model,operational=this.runtime.view().model;
     if(candidate&&candidate.model_id!==operational?.model_id){
      // One frozen candidate shares the same causal photographs. Its return
      // value is recorded, but its ordering is never consulted or executed.
      if(this.candidateRuntime.view().requested_mode!=='ADVISORY')this.candidateRuntime.setMode('ADVISORY');
      const extra=this.candidateRuntime.prioritize(base,snapshots).predictions??[];
      for(const row of this.current.values()){const prediction=extra.find(p=>p.signal_id===row.snapshot.signal_id);if(prediction)row.candidate_predictions=[{...prediction,authority:'NONE',role:'CANDIDATE_ADVISORY'}];}
     }
    }catch(error){this.candidateFailure(error);}
   }
   this.state.effective_mode=this.runtime.view().effective_mode??this.runtime.view().mode;
   return ordered;
  },base);
 }
 finish(decisions,context){return this.guard(()=>{
  if(this.state.requested_mode==='OFF')return;
  const candidates=decisions.filter(d=>d.plan),eligible=candidates.filter(d=>d.reason==='ENTRY_PENDING'),cohort=hash([SECONDARY_NEURAL_VERSION,context.cutoff]);
  const records=[];
  for(const row of this.current.values()){
   const d=row.decision,record={version:SECONDARY_NEURAL_VERSION,signal_id:row.snapshot.signal_id,operation_id:d.plan?.id??null,snapshot_hash:row.snapshot.snapshot_hash,at:context.now,mode:this.runtime.view().effective_mode??this.runtime.view().mode,model_id:row.prediction?.model_id??row.prediction?.model??null,prediction:row.prediction??{status:'UNAVAILABLE',reason:'NO_TRAINED_MODEL',estimated_net_return:null},candidate_predictions:row.candidate_predictions??[],base_reason:row.snapshot.base_reason,base_rank:row.base_rank,base_candidate_count:candidates.length,base_eligible:d.reason==='ENTRY_PENDING',cohort_id:cohort,cohort_eligible_count:eligible.length,effective_action:d.reason,pattern:d.pattern};
   this.emit({type:'NEURAL_ENTRY_DECISION',at:context.now,id:row.snapshot.signal_id,decision:record});records.push(record);
  }
  this.state.last_decisions=records;this.current.clear();
 });}
 observe(e){return this.guard(()=>{
  if(this.state.requested_mode==='OFF'||e.ledger!=='FREQUENT_PAPER'||e.version!=='secondary-futures-1.0.0'||!e.id)return;
  const state=this.state,id=e.id;
  if(e.type==='SELECTED'){
   if(state.pending[id])return;
   const row=this.current.get(id);if(!row)return;
   if(Object.keys(state.pending).length>=LIMIT.max_pending)throw Error('NEURAL_PENDING_RESOURCE_LIMIT');
   state.pending[id]={snapshot:copy(row.snapshot),entries:[],exits:[],funding:[],label:null,closed:null};return;
  }
  if(e.type==='NOT_FILLED'){if(state.pending[id]){delete state.pending[id];state.counts.unfilled++;}return;}
  if(!['FILLED','PARTIAL_FILL','PARTIAL_CLOSE','CLOSED','FUNDING_RECONCILED'].includes(e.type))return;
  let row=state.pending[id]??state.recent[id];
  if(!row&&e.type==='CLOSED')row={snapshot:null,entries:[],exits:[],funding:[],label:null,closed:null};
  if(!row){if(e.type==='FUNDING_RECONCILED'&&!e.position_open)this.emit({type:'NEURAL_RECONCILIATION_REQUIRED',id,at:e.at,reason:'LABEL_OUTSIDE_LIVE_CACHE',source_event:compactEvent(e)});return;}
  const append=(key,value)=>{const k=value.fill_id??hash(value);if(row[key].some(r=>(r.fill_id??hash(r))===k))return;if(row[key].length>=LIMIT.max_fragment_events)throw Error('NEURAL_FRAGMENT_RESOURCE_LIMIT');row[key].push(value);
   if(Buffer.byteLength(JSON.stringify(state))>LIMIT.max_state_bytes){row[key].pop();delete state.pending[id];delete state.recent[id];this.emit({type:'NEURAL_RECONCILIATION_REQUIRED',id,at:e.at,reason:'NEURAL_STATE_RESOURCE_LIMIT'});throw Error('NEURAL_STATE_RESOURCE_LIMIT');}};
  if(['FILLED','PARTIAL_FILL'].includes(e.type)){append('entries',compactEvent(e));return;}
  if(e.type==='PARTIAL_CLOSE'){append('exits',compactEvent(e));return;}
  if(e.type==='FUNDING_RECONCILED'){append('funding',compactEvent(e));if(!row.closed)return;}
  if(e.type==='CLOSED'){row.closed=compactEvent(e);append('exits',row.closed);}
  const label=buildSecondaryNeuralLabel({snapshot:row.snapshot,closed:row.closed,entryEvents:row.entries,exitEvents:row.exits,fundingEvents:row.funding,previous:row.label});
  if(!label||label.label_hash===row.label?.label_hash)return;
  const keys={MATURE:'usable',EXCLUDED:'excluded',PENDING:'pending_labels'};
  if(row.label){state.counts[keys[row.label.status]]--;if(row.label.exclusion)state.label_exclusions[row.label.exclusion]=Math.max(0,(state.label_exclusions[row.label.exclusion]??0)-1);state.counts.label_revisions++;}
  state.counts[keys[label.status]]++;if(label.exclusion)state.label_exclusions[label.exclusion]=(state.label_exclusions[label.exclusion]??0)+1;
  row.label=label;state.last_label_at=label.mature_at;this.emit({type:'NEURAL_LABEL_RECORDED',id,at:e.at,label});
  delete state.pending[id];state.recent[id]=row;
  const ids=Object.keys(state.recent);while(ids.length>LIMIT.max_recent)delete state.recent[ids.shift()];
  if(Buffer.byteLength(JSON.stringify(state))>LIMIT.max_state_bytes)throw Error('NEURAL_STATE_RESOURCE_LIMIT');
 });}
 async refresh(){
  if(this.disabled||this.state.requested_mode==='OFF'||this.refreshing||this.now()-this.lastRefresh<LIMIT.refresh_ms)return;
  this.refreshing=true;this.lastRefresh=this.now();
  try{
   const path=this.env.LUMI_TRADING_NEURAL_STATUS_PATH;
   if(path){
    try{
     const file=await open(path,constants.O_RDONLY|constants.O_NONBLOCK);let raw;
     try{const info=await file.stat();if(!info.isFile()||info.size>LIMIT.max_status_bytes)throw Error('NEURAL_TRAINING_STATUS_SIZE');const buffer=Buffer.alloc(LIMIT.max_status_bytes+1),{bytesRead}=await file.read(buffer,0,buffer.length,0);if(bytesRead>LIMIT.max_status_bytes)throw Error('NEURAL_TRAINING_STATUS_SIZE');raw=buffer.subarray(0,bytesRead).toString('utf8');}finally{await file.close();}
     const report=JSON.parse(raw);if(report.version!=='secondary-neural-training-status-1.0.0'||report.mode!=='PAPER'||report.realTrading!==false||!Number.isSafeInteger(report.at)||report.at>this.now()+10000)throw Error('NEURAL_TRAINING_STATUS_INVALID');
     if(report.revoked_model_ids!==undefined){this.runtime.revokeModels(report.revoked_model_ids);this.candidateRuntime?.revokeModels(report.revoked_model_ids);}
     if(report.last_training_at!==undefined&&report.last_training_at!==null&&(!Number.isSafeInteger(report.last_training_at)||report.last_training_at>this.now()+10000))throw Error('NEURAL_TRAINING_STATUS_INVALID');
     const summary=pick(report,['version','mode','realTrading','at','last_training_at','status','reason','dataset','checkpoint','model_id','candidate_id','validation','scheduler','duration_ms','revoked_model_ids']);
     if(hash(summary)!==this.state.training_hash){this.state.training=summary;this.state.training_hash=hash(summary);this.emit({type:'NEURAL_TRAINING_STATUS',at:this.now(),report:summary});}
    }catch(error){if(error.code!=='ENOENT')throw error;}
   }
   const modelPath=this.env.LUMI_TRADING_NEURAL_MODEL_PATH,candidatePath=this.env.LUMI_TRADING_NEURAL_CANDIDATE_PATH??(modelPath?join(dirname(modelPath),'candidate.json'):null);
   if(modelPath)await this.runtime.refreshFile(modelPath,{fallbackPath:this.env.LUMI_TRADING_NEURAL_LAST_GOOD_PATH??null});
   if(candidatePath&&this.candidateRuntime){
    try{
     const result=await this.candidateRuntime.refreshFile(candidatePath);
     if(!result.ok&&!result.expected_while_collecting)this.candidateRuntime.clearModel(result.reason);
     if(result.ok&&Object.hasOwn(this.state.training??{},'candidate_id')&&this.state.training.candidate_id!==result.model.model_id)this.candidateRuntime.clearModel('NEURAL_CANDIDATE_MANIFEST_MISMATCH');
    }catch(error){this.candidateRuntime.clearModel(safeCode(error));this.candidateFailure(error);}
   }
  }catch(error){if(integrity(error))throw error;this.runtime?.clearModel(safeCode(error),{retainLastGood:true});this.candidateRuntime?.clearModel(safeCode(error));this.failure(error);}finally{this.refreshing=false;}
 }
 view(){return neuralView(this.engine.state,this.now(),this.runtime?.view(),this.candidateRuntime?.view());}
}

export function installSecondaryNeural(engine,env){
 if(!env.LUMI_TRADING_SECONDARY_NEURAL_MODE&&!engine.state.secondaryNeural)return null;
 if(env.LUMI_TRADING_MODE!=='PAPER'||env.LUMI_RUNTIME_ENV!=='staging'||env.LUMI_TRADING_STORAGE!=='SQLITE')throw Error('SECONDARY_NEURAL_PAPER_ONLY');
 let neural;try{neural=new SecondaryNeural({engine,env,now:engine.now??(()=>Date.now())});}catch(error){
  if(integrity(error))throw error;
  engine.state.secondaryNeuralFault={at:(engine.now??Date.now)(),reason:safeCode(error),effective_mode:'DEGRADED'};
  engine.event({type:'NEURAL_FALLBACK',...engine.state.secondaryNeuralFault,behavior:'BASE_RULES_CONTINUE',realTrading:false});return null;
 }
 if(!neural.disabled&&neural.runtime&&engine.state.secondaryNeuralFault){
  engine.event({type:'NEURAL_COMPONENT_RECOVERED',at:(engine.now??Date.now)(),previous_failure:copy(engine.state.secondaryNeuralFault),behavior:'BASE_RULES_UNCHANGED',realTrading:false});
  delete engine.state.secondaryNeuralFault;
 }
 const original=engine.event.bind(engine);engine.event=e=>{original(e);if(!String(e.type).startsWith('NEURAL_'))neural.observe(e);};
 engine.secondaryNeural=neural;return neural;
}
export function neuralView(root,now=Date.now(),runtimeView=null,candidateView=null){
 if(root.secondaryNeuralFault)return {version:SECONDARY_NEURAL_VERSION,mode:'DEGRADED',last_failure:copy(root.secondaryNeuralFault),base_rules_continue:true};
 const s=root.secondaryNeural;if(!s||typeof s!=='object')return root.secondaryNeuralFault?{version:SECONDARY_NEURAL_VERSION,mode:'DEGRADED',last_failure:copy(root.secondaryNeuralFault),base_rules_continue:true}:null;
 const r=runtimeView??s.runtime??{},mode=s.last_failure?.reason==='NEURAL_PERSISTED_SCHEMA_INCOMPATIBLE'?'DEGRADED':r.effective_mode??s.effective_mode??(s.requested_mode==='OFF'?'OFF':'COLLECTING');
 const runtimeKeys=['effective_mode','requested_mode','reason','model_id','model','candidate','validation','last_failure','last_prediction_at','inference_latency','artifact_load_latency','counts','limits','last_model_check_at','revoked_model_count','model_trained_after','revocation_issue'];
 return {version:s.version,mode,requested_mode:s.requested_mode,feature_version:NEURAL_FEATURE_VERSION,target:LIMIT.target,trained:Boolean(r.model_id??r.model?.model_id),influencing:mode==='ASSISTED',counts:copy(s.counts??{}),feature_exclusions:copy(s.feature_exclusions??{}),label_exclusions:copy(s.label_exclusions??{}),last_capture_at:s.last_capture_at??null,last_evaluation_at:s.last_evaluation_at??null,last_label_at:s.last_label_at??null,last_failure:s.last_failure??r.last_failure??null,last_decisions:copy(s.last_decisions??[]),runtime:copy(pick(r,runtimeKeys)),candidate_runtime:copy(pick(candidateView??s.candidate_runtime??{},runtimeKeys)),candidate_failure:copy(s.candidate_failure??null),training:copy(s.training??null),training_location:LIMIT.training_location,base_rules_continue:true,as_of:now};
}
