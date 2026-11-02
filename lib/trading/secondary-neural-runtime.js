// Optional, bounded PAPER inference. No training, market I/O or portfolio writes.
import {createHash} from 'node:crypto';
import {open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {performance} from 'node:perf_hooks';
import {NEURAL_FEATURE_NAMES,NEURAL_FEATURE_VERSION,NEURAL_FEATURE_SCHEMA_HASH,validateSecondaryNeuralSnapshot} from './secondary-neural-data.js';

export const NEURAL_RUNTIME_VERSION='secondary-neural-runtime-1.0.0';
export const NEURAL_ARTIFACT_VERSION='secondary-neural-artifact-1.0.0';
export const NEURAL_MODEL_VERSION='secondary-neural-model-1.0.0';
export const NEURAL_VALIDATION_VERSION='secondary-neural-validation-1.0.0';
export const NEURAL_MODES=Object.freeze(['OFF','COLLECTING','ADVISORY','ASSISTED','DEGRADED']);
export const NEURAL_LIMITS=Object.freeze({artifact_bytes:131072,features:64,parameters:4096,batch:8,inference_ms:5,artifact_load_ms:50,timing_samples:256,history:16,revoked_models:256,max_model_age_ms:90*86400000});
const COUNT_KEYS=['predictions','unavailable','failures','out_of_domain','slow','loads','load_failures','assisted_batches','priority_changes','suppression_prevented'];
const DOMAIN_KEYS=Object.freeze(['mode','realTrading','symbol','ledger','engine_version','entry_revision','execution_version','economic_policy_version','exit_policy_version','execution_policy_hash','economic_policy_hash','exit_policy_hash']);
const SHA=/^[a-f0-9]{64}$/;
const digest=text=>createHash('sha256').update(text,'utf8').digest('hex');
const record=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const finite=(x,bound=1e12)=>typeof x==='number'&&Number.isFinite(x)&&Math.abs(x)<=bound;
const stamp=x=>Number.isSafeInteger(x)&&x>0;
const modelId=x=>typeof x==='string'&&/^[A-Za-z0-9_.:-]{1,128}$/.test(x);
const error=code=>Object.assign(Error(code),{code});
const integrityError=e=>[e?.code,e?.message].some(value=>/^(TRADING_|SQLITE_)|^SECONDARY_.*(HASH|INTEGRITY|PAPER_ONLY)/.test(String(value??'')));
const reasonOf=e=>{if(integrityError(e))throw e;return typeof e?.code==='string'&&/^NEURAL_[A-Z_]+$/.test(e.code)?e.code:'NEURAL_INFERENCE_EXCEPTION';};
const namesEqual=(a,b)=>Array.isArray(a)&&a.length===b.length&&a.every((x,i)=>x===b[i]);
function checkedVector(x,n,check=finite){if(!Array.isArray(x)||x.length!==n||!x.every(v=>check(v)))throw error('NEURAL_NUMERIC_INVALID');return x.slice();}
function checkedDomain(domain){
 if(!record(domain)||Object.keys(domain).length!==DOMAIN_KEYS.length||DOMAIN_KEYS.some(k=>!(k in domain)))throw error('NEURAL_DOMAIN_INVALID');
 if(domain.mode!=='PAPER'||domain.realTrading!==false||domain.symbol!=='PF_XBTUSD'||domain.ledger!=='FREQUENT_PAPER')throw error('NEURAL_PAPER_ONLY');
 for(const key of DOMAIN_KEYS.slice(4))if(typeof domain[key]!=='string'||!domain[key].length||domain[key].length>256||(key.endsWith('_hash')&&!SHA.test(domain[key])))throw error('NEURAL_DOMAIN_INVALID');
 return Object.freeze(Object.fromEntries(DOMAIN_KEYS.map(k=>[k,domain[k]])));
}
const domainEqual=(a,b)=>record(a)&&Object.keys(a).length===DOMAIN_KEYS.length&&DOMAIN_KEYS.every(k=>a[k]===b[k]);
const frozenVector=x=>Object.freeze(x);
const finiteTiming=x=>typeof x==='number'&&Number.isFinite(x)&&x>=0&&x<=3600000;
const compactFailure=(reason,at,model_id=null)=>({reason,at,model_id});
function boundSnapshot(snapshot){
 // Bound the real work before the shared hash validator visits optional metadata.
 const pending=[[snapshot,0]];let nodes=0,characters=0;
 while(pending.length){
  const [value,depth]=pending.pop();if(++nodes>1024||depth>12)throw error('NEURAL_SNAPSHOT_LIMIT');
  if(typeof value==='string'){characters+=value.length;if(value.length>4096||characters>65536)throw error('NEURAL_SNAPSHOT_LIMIT');}
  else if(Array.isArray(value)){if(value.length>64)throw error('NEURAL_SNAPSHOT_LIMIT');for(const child of value)pending.push([child,depth+1]);}
  else if(record(value)){let keys=0;for(const key in value)if(Object.hasOwn(value,key)){if(++keys>64||key.length>128)throw error('NEURAL_SNAPSHOT_LIMIT');pending.push([value[key],depth+1]);}}
 }
}
function summary(samples){
 const sorted=samples.slice().sort((a,b)=>a-b),n=sorted.length;
 return {n,p95_ms:n?sorted[Math.ceil(n*.95)-1]:null,p99_ms:n?sorted[Math.ceil(n*.99)-1]:null,max_ms:n?sorted[n-1]:null};
}

/** Parsing and matrix validation are bounded by byte and dimension limits. */
export function parseNeuralArtifact(text,{now=Date.now()}={}){
 if(typeof text!=='string'||text.length>NEURAL_LIMITS.artifact_bytes||Buffer.byteLength(text,'utf8')>NEURAL_LIMITS.artifact_bytes)throw error('NEURAL_ARTIFACT_SIZE');
 let envelope,p;
 try{envelope=JSON.parse(text);}catch{throw error('NEURAL_ARTIFACT_JSON');}
 if(!record(envelope)||envelope.version!==NEURAL_ARTIFACT_VERSION||typeof envelope.payload_json!=='string'||envelope.payload_json.length>NEURAL_LIMITS.artifact_bytes||!SHA.test(envelope.sha256??''))throw error('NEURAL_ARTIFACT_ENVELOPE');
 if(digest(envelope.payload_json)!==envelope.sha256)throw error('NEURAL_ARTIFACT_CHECKSUM');
 try{p=JSON.parse(envelope.payload_json);}catch{throw error('NEURAL_ARTIFACT_JSON');}
 if(!record(p)||p.version!==NEURAL_MODEL_VERSION||p.feature_version!==NEURAL_FEATURE_VERSION||p.feature_schema_hash!==NEURAL_FEATURE_SCHEMA_HASH||!namesEqual(p.feature_names,NEURAL_FEATURE_NAMES))throw error('NEURAL_FEATURE_SCHEMA');
 if(!modelId(p.model_id))throw error('NEURAL_MODEL_ID');
 if(!stamp(now)||!stamp(p.trained_at)||!stamp(p.created_at)||!stamp(p.expires_at)||!stamp(p.training_cutoff)||!stamp(p.max_label_mature_at)||p.trained_at>now+1000||p.created_at<p.trained_at||p.created_at>now+1000||p.max_label_mature_at>p.training_cutoff||p.training_cutoff>p.trained_at||p.expires_at<=p.trained_at||p.expires_at-p.trained_at>NEURAL_LIMITS.max_model_age_ms)throw error('NEURAL_MODEL_TIME');
 if(now>=p.expires_at)throw error('NEURAL_MODEL_EXPIRED');
 const domain=checkedDomain(p.domain),a=p.architecture,n=NEURAL_FEATURE_NAMES.length;
 if(n>NEURAL_LIMITS.features||!record(a)||a.input!==n||!namesEqual(a.hidden,[16,8])||a.output!==1||a.activation!=='tanh'||a.output_activation!=='identity')throw error('NEURAL_ARCHITECTURE');
 if(!record(p.normalization)||!record(p.input_domain)||!record(p.output_transform))throw error('NEURAL_TRANSFORM_INVALID');
 const mean=checkedVector(p.normalization.mean,n),scale=checkedVector(p.normalization.scale,n,v=>finite(v)&&v>=1e-12),min=checkedVector(p.input_domain.min,n),max=checkedVector(p.input_domain.max,n);
 if(min.some((v,i)=>v>max[i]))throw error('NEURAL_DOMAIN_INVALID');
 // This fixed scale is part of the engineering protocol, never fitted on future returns.
 if(p.output_transform.mean!==0||p.output_transform.scale!==.01)throw error('NEURAL_OUTPUT_TRANSFORM');
 if(!Array.isArray(p.layers)||p.layers.length!==3)throw error('NEURAL_ARCHITECTURE');
 const dims=[n,16,8,1];let parameters=0;
 const layers=p.layers.map((layer,k)=>{
  if(!record(layer)||!Array.isArray(layer.weights)||layer.weights.length!==dims[k])throw error('NEURAL_ARCHITECTURE');
  const weights=layer.weights.map(row=>frozenVector(checkedVector(row,dims[k+1],v=>finite(v,1e6)))),bias=frozenVector(checkedVector(layer.bias,dims[k+1],v=>finite(v,1e6)));
  parameters+=dims[k]*dims[k+1]+dims[k+1];return Object.freeze({weights:Object.freeze(weights),bias});
 });
 if(parameters>NEURAL_LIMITS.parameters)throw error('NEURAL_PARAMETER_LIMIT');
 const v=record(p.validation)?p.validation:{};
 if(['REJECTED','FAILED'].includes(v.status))throw error('NEURAL_MODEL_REJECTED');
 const validation=Object.freeze({status:typeof v.status==='string'?v.status.slice(0,80):'UNVALIDATED',criteria_version:typeof v.criteria_version==='string'?v.criteria_version.slice(0,128):null,assistance_authorized:v.status==='PASSED'&&v.criteria_version===NEURAL_VALIDATION_VERSION&&v.assistance_authorized===true});
 const model={version:p.version,model_id:p.model_id,sha256:envelope.sha256,feature_version:p.feature_version,feature_schema_hash:p.feature_schema_hash,feature_names:NEURAL_FEATURE_NAMES,domain,trained_at:p.trained_at,created_at:p.created_at,expires_at:p.expires_at,training_cutoff:p.training_cutoff,max_label_mature_at:p.max_label_mature_at,architecture:Object.freeze({input:n,hidden:Object.freeze([16,8]),output:1,activation:'tanh',output_activation:'identity'}),normalization:Object.freeze({mean:frozenVector(mean),scale:frozenVector(scale)}),input_domain:Object.freeze({min:frozenVector(min),max:frozenVector(max)}),output_transform:Object.freeze({mean:0,scale:.01}),layers:Object.freeze(layers),parameters,validation};
 return Object.freeze(model);
}

/** No caller-controlled loops: shapes have been checked and execution remains fixed. */
function forward(model,x){
 let input=Array.from({length:NEURAL_FEATURE_NAMES.length},(_,i)=>(x[i]-model.normalization.mean[i])/model.normalization.scale[i]);
 for(let k=0;k<3;k++){
  const {weights,bias}=model.layers[k],output=bias.slice();
  for(let i=0;i<input.length;i++)for(let j=0;j<output.length;j++)output[j]+=input[i]*weights[i][j];
  input=k<2?output.map(Math.tanh):output;
 }
 const value=input[0]*model.output_transform.scale+model.output_transform.mean;
 if(!finite(value,10))throw error('NEURAL_OUTPUT_INVALID');return value;
}

export function neuralPriorityPreservesCandidates(base,ranked){
 if(!Array.isArray(base)||!Array.isArray(ranked)||base.length!==ranked.length||base.length>NEURAL_LIMITS.batch)return false;
 const a=base.filter(x=>x?.plan).map(x=>x.plan.id),b=ranked.filter(x=>x?.plan).map(x=>x.plan.id);
 if(new Set(a).size!==a.length||a.length!==b.length||new Set(b).size!==b.length)return false;
 return base.every(item=>ranked.includes(item))&&a.every(id=>b.includes(id));
}

async function readBounded(path){
 if(typeof path!=='string'||!path.startsWith('/')||path.length>1024)throw error('NEURAL_MODEL_PATH');
 let handle;
 try{
  handle=await open(path,constants.O_RDONLY|constants.O_NONBLOCK);
  const stat=await handle.stat();if(!stat.isFile()||stat.size<=0||stat.size>NEURAL_LIMITS.artifact_bytes)throw error('NEURAL_ARTIFACT_SIZE');
  const bytes=Buffer.alloc(stat.size+1);let length=0;
  while(length<bytes.length){const read=await handle.read(bytes,length,bytes.length-length,null);if(read.bytesRead===0)break;length+=read.bytesRead;}
  if(length!==stat.size)throw error('NEURAL_ARTIFACT_CHANGED_DURING_READ');return new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,length));
 }catch(e){if(e?.code==='ENOENT')throw error('NEURAL_MODEL_ABSENT');if(e?.code?.startsWith('NEURAL_'))throw e;throw error('NEURAL_MODEL_READ_FAILED');}
 finally{if(handle)await handle.close().catch(()=>{});}
}

export class SecondaryNeuralRuntime{
 #model=null;#refresh=null;#activeLoadError=null;
 constructor({state={},mode='ADVISORY',context={mode:'PAPER',environment:'staging',storage:'SQLITE'},now=()=>Date.now(),clock=()=>performance.now(),event=()=>{}}={}){
  if(context.mode!=='PAPER'||context.environment!=='staging'||context.storage!=='SQLITE')throw error('NEURAL_PAPER_ONLY');
  this.state=record(state)?state:{};this.now=now;this.clock=clock;this.event=event;
  const s=this.state;s.version=NEURAL_RUNTIME_VERSION;s.started_at??=this.now();s.model=null;s.last_good_model??=null;
  if(s.revoked_model_ids===undefined)s.revoked_model_ids=[];
  if(!Array.isArray(s.revoked_model_ids)||s.revoked_model_ids.length>NEURAL_LIMITS.revoked_models||!s.revoked_model_ids.every(modelId)||s.model_trained_after!==undefined&&!stamp(s.model_trained_after)){
   // Never forget a revocation and silently revive an older model. A bounded
   // temporal quarantine requires a genuinely later training when state is invalid.
   s.revoked_model_ids=[];s.model_trained_after=this.now();s.revocation_issue='NEURAL_REVOCATION_STATE_INVALID';this.#activeLoadError=s.revocation_issue;
  }else s.revoked_model_ids=[...new Set(s.revoked_model_ids)];
  if(s.last_good_model&&this.#revoked(s.last_good_model)){s.last_good_model=null;this.#activeLoadError='NEURAL_MODEL_REVOKED';}
  s.counts=Object.fromEntries(COUNT_KEYS.map(k=>[k,Number.isSafeInteger(s.counts?.[k])&&s.counts[k]>=0?s.counts[k]:0]));
  s.inference_times=(Array.isArray(s.inference_times)?s.inference_times:[]).filter(finiteTiming).slice(-NEURAL_LIMITS.timing_samples);
  s.load_times=(Array.isArray(s.load_times)?s.load_times:[]).filter(finiteTiming).slice(-NEURAL_LIMITS.timing_samples);
  s.inference_latency=summary(s.inference_times);s.artifact_load_latency=summary(s.load_times);
  s.history=(Array.isArray(s.history)?s.history:[]).slice(-NEURAL_LIMITS.history);this.setMode(mode);
 }
 #emit(e){try{this.event({...e,version:NEURAL_RUNTIME_VERSION,ledger:'FREQUENT_PAPER',realTrading:false});}catch(error){if(integrityError(error))throw error;this.state.telemetry_error={reason:'NEURAL_TELEMETRY_FAILED',at:this.now()};}}
 #transition(mode,reason=null){
  const s=this.state;if(s.effective_mode===mode&&s.reason===reason)return;
  const before=s.effective_mode??null;s.effective_mode=mode;s.reason=reason;s.updated_at=this.now();
  const change={at:s.updated_at,from:before,to:mode,reason,requested_mode:s.requested_mode,model_id:this.#model?.model_id??null};
  s.history.push(change);if(s.history.length>NEURAL_LIMITS.history)s.history.splice(0,s.history.length-NEURAL_LIMITS.history);
  this.#emit({type:'SECONDARY_NEURAL_STATE',...change});
 }
 #effective(){
  const s=this.state,requested=s.requested_mode;
  if(requested==='OFF'||requested==='COLLECTING')return [requested,null];
  if(!['ADVISORY','ASSISTED'].includes(requested))return ['DEGRADED','NEURAL_MODE_INVALID'];
  if(!this.#model)return this.#activeLoadError?['DEGRADED',this.#activeLoadError]:['COLLECTING','NO_TRAINED_MODEL'];
  if(this.#revoked(this.#model))return ['DEGRADED','NEURAL_MODEL_REVOKED'];
  if(this.now()>=this.#model.expires_at)return ['DEGRADED','NEURAL_MODEL_EXPIRED'];
  if(requested==='ASSISTED'&&!this.#model.validation.assistance_authorized)return ['DEGRADED','NEURAL_ASSISTANCE_NOT_VALIDATED'];
  return [requested,null];
 }
 #sample(key,value){if(!finiteTiming(value))return;const samples=this.state[key];samples.push(value);if(samples.length>NEURAL_LIMITS.timing_samples)samples.shift();this.state[key==='inference_times'?'inference_latency':'artifact_load_latency']=summary(samples);}
 #revoked(model){return this.state.revoked_model_ids.includes(model.model_id)||!!this.state.model_trained_after&&model.trained_at<=this.state.model_trained_after;}
 #failure(reason,{transition=true,load=false}={}){
  const s=this.state;s.last_failure=compactFailure(reason,this.now(),this.#model?.model_id??null);s.counts[load?'load_failures':'failures']++;
  if(reason==='NEURAL_OUT_OF_DOMAIN')s.counts.out_of_domain++;
  if(reason==='NEURAL_INFERENCE_SLOW')s.counts.slow++;
  if(transition&&!['OFF','COLLECTING'].includes(s.requested_mode))this.#transition('DEGRADED',reason);
 }
 setMode(mode){
  this.state.requested_mode=NEURAL_MODES.includes(mode)?mode:'DEGRADED';
  this.#transition(...this.#effective());return this.view();
 }
 fail(reason='NEURAL_COMPONENT_FAILED'){
  if(integrityError(typeof reason==='string'?Error(reason):reason))throw typeof reason==='string'?Error(reason):reason;
  const code=typeof reason==='string'&&/^[A-Z_]{1,96}$/.test(reason)?reason:'NEURAL_COMPONENT_FAILED';
  this.#failure(code,{transition:false});if(this.state.requested_mode!=='OFF')this.#transition('DEGRADED',code);return this.view();
 }
 clearModel(reason='NEURAL_MODEL_UNAVAILABLE',{retainLastGood=false}={}){
  if(integrityError(Error(reason)))throw Error(reason);
  const code=typeof reason==='string'&&/^[A-Z_]{1,96}$/.test(reason)?reason:'NEURAL_MODEL_UNAVAILABLE';
  this.#model=null;this.state.model=null;if(!retainLastGood)this.state.last_good_model=null;this.#activeLoadError=code;
  this.#failure(code,{transition:false});this.#transition(...this.#effective());return this.view();
 }
 revokeModels(ids){
  const s=this.state,valid=Array.isArray(ids)&&ids.length<=NEURAL_LIMITS.revoked_models&&ids.every(modelId);
  const merged=valid?[...new Set([...s.revoked_model_ids,...ids])]:null;
  let reason=null,added=[];
  if(!merged||merged.length>NEURAL_LIMITS.revoked_models){s.model_trained_after=Math.max(s.model_trained_after??0,this.now());s.revoked_model_ids=[];s.revocation_issue=reason='NEURAL_REVOCATION_CAPACITY';}
  else{added=merged.filter(id=>!s.revoked_model_ids.includes(id));s.revoked_model_ids=merged;}
  const removed=!!this.#model&&this.#revoked(this.#model),old=this.#model?.model_id??null;
  if(removed){this.#model=null;s.model=null;reason??='NEURAL_MODEL_REVOKED';}
  if(s.last_good_model&&this.#revoked(s.last_good_model))s.last_good_model=null;
  if(reason){this.#activeLoadError=reason;this.#failure(reason,{transition:false});this.#transition(...this.#effective());}
  if(added.length||reason)this.#emit({type:'SECONDARY_NEURAL_MODELS_REVOKED',at:this.now(),revoked_model_ids:added,model_trained_after:s.model_trained_after??null,removed_model_id:removed?old:null,reason:reason??'LABEL_REVISION'});
  return {ok:!s.revocation_issue,added:added.length,active_removed:removed,reason,model_trained_after:s.model_trained_after??null};
 }
 loadArtifactText(text){
  const start=this.clock();
  try{
   const candidate=parseNeuralArtifact(text,{now:this.now()});if(this.#revoked(candidate))throw error('NEURAL_MODEL_REVOKED');
   const elapsed=this.clock()-start;this.#sample('load_times',elapsed);
   if(!finiteTiming(elapsed)||elapsed>NEURAL_LIMITS.artifact_load_ms)throw error('NEURAL_ARTIFACT_LOAD_SLOW');
   // Only a fully validated immutable object is made visible to inference.
   const changed=this.#model?.sha256!==candidate.sha256;this.#model=candidate;this.#activeLoadError=null;this.state.revocation_issue=null;
   this.state.model=this.#metadata(candidate);this.state.last_good_model={...this.state.model};this.state.last_model_check_at=this.now();
   if(changed){this.state.counts.loads++;this.#emit({type:'SECONDARY_NEURAL_MODEL_LOADED',at:this.now(),model:this.state.model});}
   this.#transition(...this.#effective());return {ok:true,changed,model:this.state.model};
  }catch(e){
   const reason=reasonOf(e);this.#activeLoadError=reason;this.state.last_model_check_at=this.now();this.#failure(reason,{load:true,transition:!this.#model||this.now()>=this.#model.expires_at});
   if(this.#model&&this.now()<this.#model.expires_at)this.#transition(...this.#effective());
   return {ok:false,reason,retained_model:this.#model&&this.now()<this.#model.expires_at?this.#model.model_id:null};
  }
 }
 #metadata(model){return {model_id:model.model_id,sha256:model.sha256,version:model.version,feature_version:model.feature_version,feature_schema_hash:model.feature_schema_hash,trained_at:model.trained_at,expires_at:model.expires_at,validation:model.validation,parameters:model.parameters};}
 refreshFile(path,{fallbackPath=null}={}){
  if(this.#refresh)return this.#refresh;
  this.#refresh=(async()=>{
   try{
    const result=this.loadArtifactText(await readBounded(path));
    if(!result.ok&&fallbackPath&&!this.#model){try{const fallback=this.loadArtifactText(await readBounded(fallbackPath));if(fallback.ok)return {...fallback,recovered_from_last_good:true,primary_error:result.reason};}catch(e){if(integrityError(e))throw e;}}
    return result;
   }
   catch(e){
    const reason=reasonOf(e);this.state.last_model_check_at=this.now();
    if(fallbackPath&&!this.#model){try{const result=this.loadArtifactText(await readBounded(fallbackPath));if(result.ok)return {...result,recovered_from_last_good:true,primary_error:reason};}catch(e){if(integrityError(e))throw e;}}
    if(reason==='NEURAL_MODEL_ABSENT'&&!this.#model&&!this.state.last_good_model&&!this.#activeLoadError&&!this.state.model_trained_after&&!this.state.revoked_model_ids.length){this.#transition(...this.#effective());return {ok:false,reason,expected_while_collecting:true};}
    this.#activeLoadError=reason;this.#failure(reason,{load:true,transition:!this.#model||this.now()>=this.#model.expires_at});
    if(this.#model&&this.now()<this.#model.expires_at)this.#transition(...this.#effective());
    return {ok:false,reason,retained_model:this.#model&&this.now()<this.#model.expires_at?this.#model.model_id:null};
   }
  })().finally(()=>{this.#refresh=null;});return this.#refresh;
 }
 #predict(snapshot){
  const model=this.#model,at=this.now(),base={signal_id:snapshot?.signal_id??null,operation_id:snapshot?.operation_id??null,input_hash:snapshot?.input_hash??null,generated_at:at,decision_at:snapshot?.decision_at??null,model_id:model?.model_id??null,model_sha256:model?.sha256??null,kind:'EXPERIMENTAL_NET_RETURN_ESTIMATE',estimated_net_return:null};
  if(!snapshot?.x)return {...base,status:'UNAVAILABLE',reason:snapshot?.exclusion??'NO_PRE_ENTRY_FEATURES',technical_failure:false};
  if(!model)return {...base,status:'UNAVAILABLE',reason:this.#activeLoadError??'NO_TRAINED_MODEL',technical_failure:!!this.#activeLoadError};
  let elapsed=null,start;
  try{
   start=this.clock();
   if(this.#revoked(model))throw error('NEURAL_MODEL_REVOKED');
   if(at>=model.expires_at)throw error('NEURAL_MODEL_EXPIRED');
   if(snapshot.feature_version!==model.feature_version||snapshot.feature_schema_hash!==model.feature_schema_hash||!namesEqual(snapshot.feature_names,model.feature_names)||!Array.isArray(snapshot.x)||snapshot.x.length!==model.architecture.input)throw error('NEURAL_FEATURE_SCHEMA');
   if(!domainEqual(snapshot.domain,model.domain))throw error('NEURAL_DOMAIN_MISMATCH');
   if(!stamp(snapshot.decision_at)||snapshot.decision_at<model.trained_at||snapshot.decision_at>at||at-snapshot.decision_at>30000)throw error('NEURAL_PREDICTION_NOT_CAUSAL');
   if(!SHA.test(snapshot.input_hash??'')||snapshot.data_quality!=='PRE_DECISION_OBSERVED'||snapshot.exclusion)throw error('NEURAL_INPUT_NOT_OBSERVED');
   if(!snapshot.x.every(v=>finite(v)))throw error('NEURAL_NUMERIC_INVALID');
   boundSnapshot(snapshot);
   try{validateSecondaryNeuralSnapshot(snapshot);}catch{throw error('NEURAL_SNAPSHOT_INTEGRITY');}
   if(snapshot.x.some((v,i)=>v<model.input_domain.min[i]||v>model.input_domain.max[i]))throw error('NEURAL_OUT_OF_DOMAIN');
   const prediction=forward(model,snapshot.x);elapsed=this.clock()-start;this.#sample('inference_times',elapsed);
   if(!finiteTiming(elapsed)||elapsed>NEURAL_LIMITS.inference_ms)throw error('NEURAL_INFERENCE_SLOW');
   this.state.counts.predictions++;this.state.last_prediction_at=at;
   return {...base,status:'PREDICTED',reason:null,estimated_net_return:prediction,latency_ms:elapsed,technical_failure:false};
  }catch(e){
   if(elapsed===null&&start!==undefined){elapsed=this.clock()-start;this.#sample('inference_times',elapsed);}
   const reason=reasonOf(e);this.#failure(reason,{transition:false});return {...base,status:'UNAVAILABLE',reason,latency_ms:elapsed,technical_failure:true};
  }
 }
 predict(snapshot){
  const [mode,reason]=this.#effective();
  if(['OFF','COLLECTING'].includes(mode)){this.#transition(mode,reason);return {status:'UNAVAILABLE',reason:mode==='OFF'?'NEURAL_OFF':reason??'COLLECTING_ONLY',estimated_net_return:null,model_id:null,signal_id:snapshot?.signal_id??null,generated_at:this.now(),technical_failure:false};}
  const result=this.#predict(snapshot);this.state.counts.unavailable+=result.status==='UNAVAILABLE'?1:0;
  if(result.technical_failure)this.#transition('DEGRADED',result.reason);else this.#transition(mode,reason);return result;
 }
 prioritize(baseOrderedDecisions,snapshots=[]){
  const base=baseOrderedDecisions,[mode,reason]=this.#effective(),result={decisions:base,predictions:[],effective_mode:mode,reason,changed_order:false,policy:'PRIORITY_ONLY_NO_SUPPRESSION'};
  try{
   if(!Array.isArray(base)||base.length>NEURAL_LIMITS.batch||!Array.isArray(snapshots)||snapshots.length>NEURAL_LIMITS.batch)throw error('NEURAL_BATCH_LIMIT');
   if(['OFF','COLLECTING'].includes(mode)){this.#transition(mode,reason);return result;}
   result.predictions=snapshots.map(snapshot=>this.#predict(snapshot));
   this.state.counts.unavailable+=result.predictions.filter(p=>p.status==='UNAVAILABLE').length;
   const failure=result.predictions.find(p=>p.technical_failure);
   if(failure){this.#transition('DEGRADED',failure.reason);return {...result,effective_mode:'DEGRADED',reason:failure.reason};}
   this.#transition(mode,reason);if(mode!=='ASSISTED')return result;
   const predictions=new Map(result.predictions.filter(p=>p.status==='PREDICTED').map(p=>[p.operation_id,p]));
   if(base.some(d=>d?.plan&&!predictions.has(d.plan.id)))throw error('NEURAL_CANDIDATE_PREDICTION_MISSING');
   const ranked=base.map((decision,index)=>({decision,index,prediction:predictions.get(decision?.plan?.id)?.estimated_net_return??-Infinity})).sort((a,b)=>b.prediction-a.prediction||a.index-b.index).map(x=>x.decision);
   if(!neuralPriorityPreservesCandidates(base,ranked)){this.state.counts.suppression_prevented++;throw error('NEURAL_SUPPRESSION_PREVENTED');}
   const changed=ranked.some((d,i)=>d!==base[i]);this.state.counts.assisted_batches++;if(changed)this.state.counts.priority_changes++;
   return {...result,decisions:ranked,changed_order:changed};
  }catch(e){const reason=reasonOf(e);this.#failure(reason);return {...result,effective_mode:'DEGRADED',reason};}
 }
 view(){
  const s=this.state;return {version:s.version,requested_mode:s.requested_mode,effective_mode:s.effective_mode,reason:s.reason,model:s.model,last_good_model:s.last_good_model,last_failure:s.last_failure??null,last_model_check_at:s.last_model_check_at??null,last_prediction_at:s.last_prediction_at??null,counts:{...s.counts},inference_latency:summary(s.inference_times),artifact_load_latency:summary(s.load_times),revoked_model_count:s.revoked_model_ids.length,model_trained_after:s.model_trained_after??null,revocation_issue:s.revocation_issue??null,limits:NEURAL_LIMITS,policy:'PRIORITY_ONLY_NO_SUPPRESSION',influences_entries:s.effective_mode==='ASSISTED',prediction_kind:'EXPERIMENTAL_NET_RETURN_ESTIMATE',realTrading:false};
 }
}
