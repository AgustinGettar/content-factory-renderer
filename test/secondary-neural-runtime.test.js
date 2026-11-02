// Synthetic examples only, isolated files/state; never reads the operational ledger.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {performance} from 'node:perf_hooks';
import {hash} from '../lib/trading/core.js';
import {NEURAL_SIGNAL_VERSION,NEURAL_FEATURE_NAMES,NEURAL_FEATURE_VERSION,NEURAL_FEATURE_SCHEMA_HASH} from '../lib/trading/secondary-neural-data.js';
import {SecondaryNeuralRuntime,parseNeuralArtifact,neuralPriorityPreservesCandidates,NEURAL_LIMITS,NEURAL_ARTIFACT_VERSION,NEURAL_MODEL_VERSION,NEURAL_VALIDATION_VERSION} from '../lib/trading/secondary-neural-runtime.js';

const T=Date.parse('2026-11-02T08:00:00Z');
const DOMAIN={mode:'PAPER',realTrading:false,symbol:'PF_XBTUSD',ledger:'FREQUENT_PAPER',engine_version:'secondary-futures-1.0.0',entry_revision:'secondary-entry-useful-margin-1.0.0',execution_version:'secondary-exploration-execution-1.0.0',economic_policy_version:'secondary-entry-economics-1.0.0',exit_policy_version:'secondary-net-trailing-1.0.0',execution_policy_hash:'1'.repeat(64),economic_policy_hash:'2'.repeat(64),exit_policy_hash:'3'.repeat(64)};
const clone=x=>structuredClone(x);
function payload({id='nn_isolated_fixture',authorized=false}={}){
 const dims=[NEURAL_FEATURE_NAMES.length,16,8,1];
 return {version:NEURAL_MODEL_VERSION,model_id:id,feature_version:NEURAL_FEATURE_VERSION,feature_schema_hash:NEURAL_FEATURE_SCHEMA_HASH,feature_names:[...NEURAL_FEATURE_NAMES],domain:clone(DOMAIN),trained_at:T-20000,created_at:T-20000,expires_at:T+86400000,training_cutoff:T-30000,max_label_mature_at:T-40000,architecture:{input:dims[0],hidden:[16,8],output:1,activation:'tanh',output_activation:'identity'},normalization:{mean:Array(dims[0]).fill(0),scale:Array(dims[0]).fill(1)},input_domain:{min:Array(dims[0]).fill(-10),max:Array(dims[0]).fill(10)},output_transform:{mean:0,scale:.01},layers:dims.slice(1).map((n,k)=>({weights:Array.from({length:dims[k]},(_,i)=>Array.from({length:n},(_,j)=>Number(i===0&&j===0))),bias:Array(n).fill(0)})),validation:{status:authorized?'PASSED':'PROSPECTIVE',criteria_version:NEURAL_VALIDATION_VERSION,assistance_authorized:authorized}};
}
function artifact(p=payload()){const payload_json=JSON.stringify(p);return JSON.stringify({version:NEURAL_ARTIFACT_VERSION,payload_json,sha256:hash(payload_json)});}
function seal(s){const x={...s};delete x.snapshot_hash;return {...x,snapshot_hash:hash(x)};}
function snapshot(id='one',value=.2){
 const x=Array(NEURAL_FEATURE_NAMES.length).fill(0);x[0]=value;
 const inputs={description:'ISOLATED SYNTHETIC TEST ONLY',at:T};
 return seal({version:NEURAL_SIGNAL_VERSION,feature_version:NEURAL_FEATURE_VERSION,feature_schema_hash:NEURAL_FEATURE_SCHEMA_HASH,feature_names:[...NEURAL_FEATURE_NAMES],snapshot_id:hash(['ISOLATED',id]),signal_id:id,operation_id:id,at:T,decision_at:T,signal_at:T-2000,stage:'PRE_SELECTION',mode:'PAPER',realTrading:false,domain:clone(DOMAIN),group_key:hash({feature_version:NEURAL_FEATURE_VERSION,domain:DOMAIN}),context:{movement_key:'isolated-'+id,confirmation_key:'confirm-'+id},inputs,input_hash:hash(inputs),x,exclusion:null,data_quality:'PRE_DECISION_OBSERVED'});
}
function runtime(options={}){return new SecondaryNeuralRuntime({now:()=>T,clock:()=>0,...options});}
const decisions=()=>[{pattern:'BREAKOUT',plan:{id:'one',stop:'90',target:'110',sizing:{qty:'1'},hash:'immutable-one'}},{pattern:'PULLBACK',plan:{id:'two',stop:'90',target:'112',sizing:{qty:'1'},hash:'immutable-two'}},{pattern:'RANGE_REENTRY',reason:'WAIT_RANGE_REENTRY'}];

test('missing model collects honestly; an advisory model estimates signed net return, never a probability',()=>{
 const r=runtime(),s=snapshot();assert.equal(r.view().effective_mode,'COLLECTING');assert.equal(r.view().reason,'NO_TRAINED_MODEL');
 assert.equal(r.predict(s).estimated_net_return,null);assert.equal(r.state.counts.predictions,0);
 assert(r.loadArtifactText(artifact()).ok);assert.equal(r.view().effective_mode,'ADVISORY');
 const prediction=r.predict(s);assert.equal(prediction.status,'PREDICTED');assert.equal(prediction.kind,'EXPERIMENTAL_NET_RETURN_ESTIMATE');assert(!('probability' in prediction));
 assert(Math.abs(prediction.estimated_net_return-.01*Math.tanh(Math.tanh(.2)))<1e-15);
 assert(r.predict(snapshot('negative',-.2)).estimated_net_return<0);assert.equal(r.view().influences_entries,false);
});
test('OFF, COLLECTING and ADVISORY preserve same decision references, order and immutable contracts',()=>{
 for(const mode of ['OFF','COLLECTING','ADVISORY']){
  const r=runtime({mode}),base=decisions(),before=clone(base);assert(r.loadArtifactText(artifact()).ok);
  const out=r.prioritize(base,[snapshot('one',-.8),snapshot('two',.8)]);
  assert.strictEqual(out.decisions,base);assert.deepEqual(base,before);assert.equal(out.changed_order,false);
  assert.equal(out.predictions.length,mode==='ADVISORY'?2:0);assert.equal(r.view().influences_entries,false);
 }
});
test('ASSISTED needs validated authority and can only reorder the identical base candidates',()=>{
 const r=runtime({mode:'ASSISTED'}),base=decisions(),before=clone(base),rows=[snapshot('one',-.8),snapshot('two',.8)];
 r.loadArtifactText(artifact());let out=r.prioritize(base,rows);assert.strictEqual(out.decisions,base);assert.equal(r.view().effective_mode,'DEGRADED');assert.equal(r.view().reason,'NEURAL_ASSISTANCE_NOT_VALIDATED');
 assert(r.loadArtifactText(artifact(payload({id:'nn_authorized',authorized:true}))).ok);out=r.prioritize(base,rows);
 assert.equal(out.effective_mode,'ASSISTED');assert.equal(out.changed_order,true);assert.deepEqual(out.decisions.map(d=>d.plan?.id),['two','one',undefined]);assert.deepEqual(base,before);
 assert(neuralPriorityPreservesCandidates(base,out.decisions));assert.equal(r.view().counts.priority_changes,1);
 r.setMode('OFF');assert.strictEqual(r.prioritize(base,rows).decisions,base);assert.deepEqual(base,before);
});
test('duplicate, removed or copied plan candidates cannot be substituted by a model',()=>{
 const base=decisions();assert(!neuralPriorityPreservesCandidates(base,base.slice(1)));assert(!neuralPriorityPreservesCandidates(base,clone(base)));assert(!neuralPriorityPreservesCandidates(base,[base[0],base[0],base[2]]));
 const r=runtime({mode:'ASSISTED'});r.loadArtifactText(artifact(payload({authorized:true})));
 const duplicate=[base[0],base[0]],result=r.prioritize(duplicate,[snapshot()]);assert.strictEqual(result.decisions,duplicate);assert.equal(result.reason,'NEURAL_SUPPRESSION_PREVENTED');assert.equal(r.state.counts.suppression_prevented,1);
 const absent=r.prioritize(base,[snapshot()]);assert.strictEqual(absent.decisions,base);assert.equal(absent.reason,'NEURAL_CANDIDATE_PREDICTION_MISSING');
});
test('corrupt artefacts retain the last compatible model atomically and disclose the failure',()=>{
 const r=runtime();r.loadArtifactText(artifact());const before=r.predict(snapshot()).estimated_net_return,old=r.view().model.sha256;
 for(const bad of ['{',JSON.stringify({version:NEURAL_ARTIFACT_VERSION,payload_json:'{}',sha256:'0'.repeat(64)}),'x'.repeat(NEURAL_LIMITS.artifact_bytes+1)]){
  const result=r.loadArtifactText(bad);assert.equal(result.ok,false);assert.equal(result.retained_model,'nn_isolated_fixture');assert.equal(r.view().model.sha256,old);assert.equal(r.predict(snapshot()).estimated_net_return,before);assert(r.view().last_failure);
 }
 const replacement=payload({id:'nn_next'});replacement.layers[2].bias[0]=.1;assert(r.loadArtifactText(artifact(replacement)).ok);assert.equal(r.view().model.model_id,'nn_next');assert(r.predict(snapshot()).estimated_net_return>before);
});
test('schemas, parameter shapes, transforms, nonfinite values and unsupported modes are rejected',()=>{
 const cases=[
  [p=>p.feature_names.reverse(),'NEURAL_FEATURE_SCHEMA'],
  [p=>p.feature_schema_hash='0'.repeat(64),'NEURAL_FEATURE_SCHEMA'],
  [p=>p.architecture.hidden=[1024,1024],'NEURAL_ARCHITECTURE'],
  [p=>p.layers[0].weights[0].push(1),'NEURAL_NUMERIC_INVALID'],
  [p=>p.layers[0].weights[0][0]=Infinity,'NEURAL_NUMERIC_INVALID'],
  [p=>p.normalization.scale[0]=0,'NEURAL_NUMERIC_INVALID'],
  [p=>p.output_transform.scale=1,'NEURAL_OUTPUT_TRANSFORM'],
  [p=>p.domain.mode='LIVE','NEURAL_PAPER_ONLY'],
  [p=>p.domain.realTrading=true,'NEURAL_PAPER_ONLY'],
  [p=>p.domain.symbol='BTC/USD','NEURAL_PAPER_ONLY'],
  [p=>p.validation.status='REJECTED','NEURAL_MODEL_REJECTED'],
 ];
 for(const [mutate,reason]of cases){const p=payload();mutate(p);assert.throws(()=>parseNeuralArtifact(artifact(p),{now:T}),e=>e.code===reason,reason);const r=runtime();assert.equal(r.loadArtifactText(artifact(p)).ok,false);assert.equal(r.view().effective_mode,'DEGRADED');assert.strictEqual(r.prioritize([],[]).decisions.length,0);}
});
test('expired models, future training, and retrospective predictions are unavailable',()=>{
 for(const mutate of [p=>p.expires_at=T,p=>p.trained_at=T+5000,p=>p.max_label_mature_at=T]){const p=payload();mutate(p);assert.equal(runtime().loadArtifactText(artifact(p)).ok,false);}
 let at=T;const r=runtime({now:()=>at});r.loadArtifactText(artifact());at=T+86400001;assert.equal(r.predict(snapshot()).reason,'NEURAL_MODEL_EXPIRED');assert.equal(r.view().effective_mode,'DEGRADED');
 const current=runtime();current.loadArtifactText(artifact());
 for(const decision_at of [T-20001,T+1,T-31000]){const s=seal({...snapshot(),decision_at});assert.equal(current.predict(s).reason,'NEURAL_PREDICTION_NOT_CAUSAL');}
});
test('out of domain, wrong contracts, malformed inputs and modified snapshots fall back without orders',()=>{
 const r=runtime({mode:'ASSISTED'});r.loadArtifactText(artifact(payload({authorized:true})));const base=decisions(),before=clone(base);
 const cases=[
  [seal({...snapshot(),x:[20,...Array(NEURAL_FEATURE_NAMES.length-1).fill(0)]}),'NEURAL_OUT_OF_DOMAIN'],
  [seal({...snapshot(),domain:{...DOMAIN,exit_policy_hash:'9'.repeat(64)}}),'NEURAL_DOMAIN_MISMATCH'],
  [seal({...snapshot(),x:[NaN,...Array(NEURAL_FEATURE_NAMES.length-1).fill(0)]}),'NEURAL_NUMERIC_INVALID'],
  [seal({...snapshot(),x:[0]}),'NEURAL_FEATURE_SCHEMA'],
  [{...snapshot(),x:Array(NEURAL_FEATURE_NAMES.length).fill(.8)},'NEURAL_SNAPSHOT_INTEGRITY'],
  [seal({...snapshot(),extra:Array(65).fill(0)}),'NEURAL_SNAPSHOT_LIMIT'],
 ];
 for(const [s,reason]of cases){const out=r.prioritize(base,[s,snapshot('two')]);assert.strictEqual(out.decisions,base);assert.equal(out.reason,reason);assert.equal(out.effective_mode,'DEGRADED');assert.deepEqual(base,before);}
 const healthy=r.prioritize(base,[snapshot('one'),snapshot('two')]);assert.equal(healthy.effective_mode,'ASSISTED');assert(neuralPriorityPreservesCandidates(base,healthy.decisions));
});
test('a slow complete inference is ignored, bounded work still finishes and later inference recovers',()=>{
 let clock=0,step=0;const r=runtime({clock:()=>clock+=step});r.loadArtifactText(artifact());step=10;
 const base=decisions(),out=r.prioritize(base,[snapshot('one'),snapshot('two')]);assert.strictEqual(out.decisions,base);assert.equal(out.reason,'NEURAL_INFERENCE_SLOW');assert.equal(r.view().counts.slow,2);assert.equal(r.view().inference_latency.p95_ms,10);
 step=0;assert.equal(r.predict(snapshot()).status,'PREDICTED');assert.equal(r.view().effective_mode,'ADVISORY');
});
test('oversized batches are rejected before per-signal work and expose a specific fallback',()=>{
 const r=runtime();r.loadArtifactText(artifact());const base=Array.from({length:NEURAL_LIMITS.batch+1},(_,i)=>({plan:{id:String(i)}}));const out=r.prioritize(base,[]);assert.strictEqual(out.decisions,base);assert.equal(out.reason,'NEURAL_BATCH_LIMIT');assert.equal(r.state.counts.predictions,0);
});
test('file refresh is single-flight, bounded, async and can recover last-good across restart',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'lumi-neural-isolated-'));
 try{
  const path=join(directory,'model.json'),fallback=join(directory,'last-good.json'),r=runtime();await writeFile(path,artifact());
  const first=r.refreshFile(path),second=r.refreshFile(path);assert.strictEqual(first,second);assert((await first).ok);assert.equal(r.predict(snapshot()).status,'PREDICTED');
  await writeFile(fallback,artifact());await writeFile(path,'{');assert.equal((await r.refreshFile(path)).retained_model,'nn_isolated_fixture');
  const restart=runtime({state:clone(r.state)});assert.equal(restart.view().model,null);const recovered=await restart.refreshFile(path,{fallbackPath:fallback});assert(recovered.ok);assert(recovered.recovered_from_last_good);assert.equal(restart.predict(snapshot()).status,'PREDICTED');
  await writeFile(path,'x'.repeat(NEURAL_LIMITS.artifact_bytes+1));assert.equal((await restart.refreshFile(path)).reason,'NEURAL_ARTIFACT_SIZE');
  const missing=runtime();assert((await missing.refreshFile(join(directory,'not-created.json'))).expected_while_collecting);assert.equal(missing.view().effective_mode,'COLLECTING');
  await mkdir(join(directory,'directory'));assert.equal((await runtime().refreshFile(join(directory,'directory'))).reason,'NEURAL_ARTIFACT_SIZE');
 }finally{await rm(directory,{recursive:true,force:true});}
});
test('state transitions are deduplicated and optional failures never conceal portfolio integrity errors',()=>{
 const events=[],r=runtime({event:e=>events.push(e)}),first=events.length;r.setMode('ADVISORY');assert.equal(events.length,first);r.fail('NEURAL_CAPTURE_FAILED');assert.equal(r.view().effective_mode,'DEGRADED');const after=events.length;r.fail('NEURAL_CAPTURE_FAILED');assert.equal(events.length,after);
 assert.throws(()=>r.fail('TRADING_SQLITE_CONFLICT'),/TRADING_SQLITE_CONFLICT/);
 assert.throws(()=>runtime({event:()=>{throw Error('TRADING_STATE_INTEGRITY');}}),/TRADING_STATE_INTEGRITY/);
 assert.throws(()=>runtime({event:()=>{throw Error('SECONDARY_EXECUTION_PLAN_INTEGRITY');}}),/SECONDARY_EXECUTION_PLAN_INTEGRITY/);
 const optional=runtime({event:()=>{throw Error('optional diagnostic failure');}});assert.equal(optional.view().effective_mode,'COLLECTING');assert.equal(optional.state.telemetry_error.reason,'NEURAL_TELEMETRY_FAILED');
});
test('LIVE, production and non-SQLite new inference installations are refused absolutely',()=>{
 for(const context of [{mode:'LIVE',environment:'staging',storage:'SQLITE'},{mode:'PAPER',environment:'production',storage:'SQLITE'},{mode:'PAPER',environment:'staging',storage:'SUPABASE'}])assert.throws(()=>runtime({context}),/NEURAL_PAPER_ONLY/);
});
test('label revisions durably revoke a model across retry, restart and last-good file recovery',async()=>{
 const r=runtime(),text=artifact();r.loadArtifactText(text);assert(r.revokeModels(['nn_isolated_fixture']).active_removed);assert.equal(r.view().effective_mode,'DEGRADED');assert.equal(r.view().model,null);assert.equal(r.view().last_good_model,null);assert.equal(r.predict(snapshot()).estimated_net_return,null);
 assert.equal(r.revokeModels(['nn_isolated_fixture']).added,0);assert.equal(r.loadArtifactText(text).reason,'NEURAL_MODEL_REVOKED');
 const restored=runtime({state:clone(r.state)});assert.equal(restored.loadArtifactText(text).reason,'NEURAL_MODEL_REVOKED');
 const directory=await mkdtemp(join(tmpdir(),'lumi-neural-revoked-isolated-'));try{
  const current=join(directory,'current.json'),previous=join(directory,'previous.json');await writeFile(current,'{');await writeFile(previous,text);const result=await restored.refreshFile(current,{fallbackPath:previous});assert.equal(result.ok,false);assert.equal(restored.view().model,null);
 }finally{await rm(directory,{recursive:true,force:true});}
 assert(restored.loadArtifactText(artifact(payload({id:'nn_retrained_after_revision'}))).ok);assert.equal(restored.view().effective_mode,'ADVISORY');assert.equal(restored.predict(snapshot()).status,'PREDICTED');assert.equal(restored.view().revoked_model_count,1);
});
test('revocation bounds quarantine all older training instead of dropping old IDs and reviving a model',()=>{
 let now=T;const r=runtime({now:()=>now});r.loadArtifactText(artifact());const ids=Array.from({length:NEURAL_LIMITS.revoked_models+1},(_,i)=>'nn_revoked_'+i);const result=r.revokeModels(ids);assert.equal(result.reason,'NEURAL_REVOCATION_CAPACITY');assert.equal(r.view().model,null);assert.equal(r.view().model_trained_after,T);assert.equal(r.state.revoked_model_ids.length,0);assert.equal(r.loadArtifactText(artifact()).reason,'NEURAL_MODEL_REVOKED');
 now=T+2;const p=payload({id:'nn_trained_after_quarantine'});p.trained_at=T+1;p.created_at=T+1;assert(r.loadArtifactText(artifact(p)).ok);assert.equal(r.view().effective_mode,'ADVISORY');assert.equal(r.view().revocation_issue,null);
 const corrupted=runtime({state:{revoked_model_ids:'unreadable'}});assert.equal(corrupted.view().model_trained_after,T);assert.equal(corrupted.loadArtifactText(artifact()).reason,'NEURAL_MODEL_REVOKED');
});
test('full adapter load is bounded, yields between batches and reports p95/p99 with a fixed-size buffer',async t=>{
 const r=runtime(),loaded=r.loadArtifactText(artifact());assert(loaded.ok);r.clock=()=>performance.now();const rows=[snapshot('one'),snapshot('two',-.3)],base=decisions();
 let yielded=false;setImmediate(()=>{yielded=true;});const rssBefore=process.memoryUsage().rss,start=performance.now();
 for(let batch=0;batch<25;batch++){
  for(let i=0;i<10;i++)assert.strictEqual(r.prioritize(base,rows).decisions,base);
  await new Promise(resolve=>setImmediate(resolve));
 }
 const elapsed=performance.now()-start,view=r.view(),rssGrowth=process.memoryUsage().rss-rssBefore;
 assert(yielded);assert.equal(r.state.inference_times.length,NEURAL_LIMITS.timing_samples);assert.equal(view.inference_latency.n,NEURAL_LIMITS.timing_samples);assert(view.inference_latency.p99_ms>=view.inference_latency.p95_ms);assert(view.counts.predictions+view.counts.slow===500);assert(r.state.history.length<=NEURAL_LIMITS.history);assert(Buffer.byteLength(JSON.stringify(r.state))<32768);
 // Generous resource ceilings detect runaway work without treating host scheduling as a trading promise.
 assert(elapsed<10000);assert(rssGrowth<96*1024*1024);t.diagnostic(JSON.stringify({fixture:'ISOLATED_FULL_ADAPTER',calls:500,elapsed_ms:elapsed,rss_growth_bytes:rssGrowth,...view.inference_latency}));
});
