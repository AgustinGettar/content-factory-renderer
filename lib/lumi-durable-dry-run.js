import {randomUUID} from 'node:crypto';
import {sha256} from './telegram-review-v1/core.js';
import {scopedEnabled} from './telegram-review-v1/make-transport.js';

export const DRY_OPERATION_TYPE = 'AUTHENTICATED_DRY_RUN_V1';
export const DRY_API_OPS = new Set(['START_DRY_RUN','GET_DRY_RUN_STATUS','GET_DRY_RUN_RESULT']);
export const DRY_STAGES = ['TTS_PREFLIGHT','GENERIC_DRY_RUN','RUNTIME'];
const terminal = new Set(['SUCCEEDED','FAILED','OUTCOME_AMBIGUOUS']);
const keyPattern = /^[a-z][a-zA-Z0-9_.:-]{7,95}$/;
const opPattern = /^dry_[a-f0-9]{64}$/;
const allowedError = new Set(['DRY_LEASE_LOST','DRY_CHECKPOINT_WRITE_FAILED','DRY_CHECKPOINT_READ_FAILED',
  'DRY_SCOPE_DISABLED','DRY_OWNER_INACTIVE','DRY_REVISION_CHANGED','DRY_INTERRUPTION_LIMIT','DRY_RESULT_INVALID','DRY_STAGE_TIMEOUT']);
const fail = code => {throw Error(code);};
const opOf = row => row?.metadata?.dry_run_operation;
export const dryOperationId = (user,key) => 'dry_'+sha256(JSON.stringify([DRY_OPERATION_TYPE,String(user),key]));
const iso = ms => new Date(ms).toISOString();

// Only this fixed diagnostic contract can become durable work. No provider,
// episode, callback, publication or arbitrary command payload is accepted.
export function validateDryPayload(body,nonce) {
  const common = ['op','user_id','chat_id','message_id','idempotency_key'];
  const start = body.op === 'START_DRY_RUN';
  const allowed = new Set([...common,...(start?['verify_tts_preflight','dry_run','provider_generation','publication','crash_matrix']:['operation_id'])]);
  if(!DRY_API_OPS.has(body.op)||Object.keys(body).some(k=>!allowed.has(k))) fail('DRY_PAYLOAD_INVALID');
  if(body.idempotency_key!==undefined&&(!keyPattern.test(body.idempotency_key)||body.idempotency_key===nonce)) fail('DRY_IDEMPOTENCY_KEY_INVALID');
  if(start) {
    if(!body.idempotency_key||body.verify_tts_preflight!==true||body.dry_run!==true||body.provider_generation!==false
      ||body.publication!==false||body.crash_matrix!==true||!Number.isSafeInteger(body.message_id)) fail('DRY_SAFETY_FLAGS_REQUIRED');
  } else if((!body.operation_id&&!body.idempotency_key)||(body.operation_id&&!opPattern.test(body.operation_id))) fail('DRY_OPERATION_ID_REQUIRED');
  return start?{verify_tts_preflight:true,dry_run:true,provider_generation:false,publication:false,crash_matrix:true,message_id:body.message_id}:null;
}

export class DurableDryRun {
  constructor({store,reviewStore,env,validateOwner,runStage,clock=Date.now,leaseMs=90000,stageTimeoutMs=180000,inject=async()=>{},logger=console}) {
    Object.assign(this,{store,reviewStore,env,validateOwner,runStage,clock,leaseMs,stageTimeoutMs,inject,logger});
    this.busy=false;
  }
  async owner(user,chat,messageId) {
    if(!scopedEnabled(this.env,user,chat)) fail('DRY_SCOPE_DISABLED');
    if(!await this.validateOwner(user,chat)) fail('DRY_OWNER_INACTIVE');
    const row=await this.reviewStore.get(user),s=row?.state;
    if(!s||s.user_id!==user||s.chat_id!==chat||s.message_id!==messageId) fail('DRY_OWNER_INACTIVE');
    return s;
  }
  async start({user,chat,body,nonce}) {
    const request=validateDryPayload(body,nonce);
    await this.owner(user,chat,request.message_id);
    if(!/^[a-f0-9]{40}$/.test(this.env.RENDER_GIT_COMMIT||'')) fail('DRY_REVISION_REQUIRED');
    const operation_id=dryOperationId(user,body.idempotency_key),request_fingerprint=sha256(JSON.stringify({user,chat,...request}));
    const now=iso(this.clock());
    const operation={operation_id,operation_type:DRY_OPERATION_TYPE,idempotency_key:body.idempotency_key,request_fingerprint,
      created_at:now,started_at:null,completed_at:null,status:'QUEUED',stage:DRY_STAGES[0],result_json:null,
      error_classification:null,staging_revision:this.env.RENDER_GIT_COMMIT,attempt_count:0,provider_generation_calls:0,publication_calls:0,
      user,chat,request,authorization:'SIGNED_SCOPED_DIAGNOSTIC_ONLY',accepted_nonce_sha256:sha256(nonce),checkpoints:{},lease:null};
    // The existing Recovery Manager table is both queue and result authority.
    const row={episode_id:operation_id,pipeline_version:'v1_1_2',preset_version:'1.1.2',status:'QUEUED',runner_enabled:false,autorun:false,
      current_cost_usd:0,authorized_ceiling_usd:0,last_completed_action:null,first_pending_action:DRY_STAGES[0],active_incident_id:null,
      cancellation_reason:null,actions:DRY_STAGES.map(key=>({key,stage:key,status:'PENDING'})),
      metadata:{diagnostic:true,operation_type:DRY_OPERATION_TYPE,diagnostic_revision:0,dry_run_operation:operation},created_at:now,updated_at:now};
    const created=await this.store.createDiagnostic(row),saved=created||await this.store.getEpisode(operation_id),old=opOf(saved);
    if(!old||old.user!==user||old.request_fingerprint!==request_fingerprint) fail('DRY_IDEMPOTENCY_CONFLICT');
    this.log(old);
    await this.inject('PERSISTED_BEFORE_RESPONSE',old);
    return {...this.view(old),already_exists:!created};
  }
  log(op) {this.logger.info(JSON.stringify({event:'lumi_durable_dry_run',operation_id:op.operation_id,status:op.status,
    stage:op.stage,staging_revision:op.staging_revision,attempt_count:op.attempt_count}));}
  async get({user,chat,body}) {
    validateDryPayload(body);
    const id=body.operation_id||dryOperationId(user,body.idempotency_key),op=opOf(await this.store.getEpisode(id));
    if(!op||op.user!==user||op.chat!==chat||body.idempotency_key&&op.idempotency_key!==body.idempotency_key) fail('DRY_OPERATION_NOT_FOUND');
    await this.owner(user,chat,op.request.message_id);
    return this.view(op,body.op==='GET_DRY_RUN_RESULT');
  }
  view(op,includeResult=false) {
    return {authenticated:true,operation_id:op.operation_id,operation_type:op.operation_type,idempotency_key:op.idempotency_key,
      request_fingerprint:op.request_fingerprint,created_at:op.created_at,started_at:op.started_at,completed_at:op.completed_at,
      status:op.status,stage:op.stage,error_classification:op.error_classification,staging_revision:op.staging_revision,
      attempt_count:op.attempt_count,provider_generation_calls:op.provider_generation_calls,publication_calls:op.publication_calls,
      result_available:op.result_json!==null,result_sha256:op.result_sha256||null,
      ...(includeResult?{result_json:op.result_json}:{}),actions:[],commands:[]};
  }
  async update(id,mutate) {
    for(let i=0;i<6;i++) {
      const row=await this.store.getEpisode(id);if(!opOf(row)) fail('DRY_OPERATION_NOT_FOUND');
      const revision=row.metadata.diagnostic_revision;
      if(mutate(opOf(row),row)===false)return null;
      row.metadata.diagnostic_revision=revision+1;row.updated_at=iso(this.clock());row.status=opOf(row).status;
      if(await this.store.casDiagnostic(row,revision))return opOf(row);
    }
    fail('DRY_CHECKPOINT_WRITE_FAILED');
  }
  async assertLease(id,token) {
    const op=opOf(await this.store.getEpisode(id));
    if(op?.status!=='RUNNING'||op.lease?.token!==token||op.lease.until<=this.clock())fail('DRY_LEASE_LOST');
  }
  async process(id) {
    const token=randomUUID();
    let op=await this.update(id,(d,row)=>{
      if(terminal.has(d.status)||d.status==='RUNNING'&&d.lease?.until>this.clock())return false;
      if(d.authorization!=='SIGNED_SCOPED_DIAGNOSTIC_ONLY')return false;
      if(d.staging_revision!==this.env.RENDER_GIT_COMMIT||d.attempt_count>=3) {
        d.status='OUTCOME_AMBIGUOUS';d.error_classification=d.attempt_count>=3?'DRY_INTERRUPTION_LIMIT':'DRY_REVISION_CHANGED';
        d.completed_at=iso(this.clock());d.lease=null;return;
      }
      d.status='RUNNING';d.started_at??=iso(this.clock());d.attempt_count++;
      d.lease={token,until:this.clock()+this.leaseMs};row.first_pending_action=d.stage;
    });
    if(!op||op.status!=='RUNNING')return;
    const heartbeat=setInterval(()=>this.update(id,d=>{
      if(d.status!=='RUNNING'||d.lease?.token!==token||d.lease.until<=this.clock())return false;
      d.lease.until=this.clock()+this.leaseMs;
    }).catch(()=>{}),Math.floor(this.leaseMs/3));heartbeat.unref?.();
    try {
      await this.inject('CLAIMED',op);
      for(const stage of DRY_STAGES) {
        if(op.checkpoints[stage])continue;
        await this.assertLease(id,token);
        await this.owner(op.user,op.chat,op.request.message_id);
        // Every external diagnostic read/probe is fenced. Restart can repeat
        // read-only checks; no live episode or provider submission is reachable.
        let expired=false,timer;
        const guard=async()=>{if(expired)fail('DRY_STAGE_TIMEOUT');await this.assertLease(id,token);};
        let result;
        try {
          result=await Promise.race([this.runStage(stage,op,guard),new Promise((_,reject)=>{
            timer=setTimeout(()=>{expired=true;reject(Error('DRY_STAGE_TIMEOUT'));},this.stageTimeoutMs);
          })]);
        } finally {clearTimeout(timer);}
        await this.inject('STAGE_FINISHED_BEFORE_PERSIST',op);
        await this.assertLease(id,token);
        op=await this.update(id,(d,row)=>{
          if(d.status!=='RUNNING'||d.lease?.token!==token||d.lease.until<=this.clock())fail('DRY_LEASE_LOST');
          d.checkpoints[stage]=result;d.stage=DRY_STAGES[DRY_STAGES.indexOf(stage)+1]||'COMPLETE';
          row.actions.find(a=>a.key===stage).status='COMPLETE';row.last_completed_action=stage;row.first_pending_action=d.stage;
        });
        this.log(op);
        await this.inject('STAGE_PERSISTED',op);
      }
      const result=buildDryResult(op.checkpoints);
      const completed=await this.update(id,(d,row)=>{
        if(d.status!=='RUNNING'||d.lease?.token!==token||d.lease.until<=this.clock())fail('DRY_LEASE_LOST');
        d.status=result.status==='PASS'?'SUCCEEDED':'FAILED';d.result_json=result;d.result_sha256=sha256(JSON.stringify(result));
        d.error_classification=result.status==='PASS'?null:'DRY_READINESS_GATES_BLOCKED';d.completed_at=iso(this.clock());d.lease=null;
        row.first_pending_action=null;
      });
      this.log(completed);
      await this.inject('RESULT_PERSISTED',op);
    } catch(error) {
      // Test-only interruption mimics a killed process, leaving its lease durable.
      if(error?.simulatedProcessDeath)throw error;
      if(error.message==='DRY_LEASE_LOST')return;
      await this.update(id,d=>{
        if(d.status!=='RUNNING'||d.lease?.token!==token||d.lease.until<=this.clock())return false;
        d.status='FAILED';d.error_classification=allowedError.has(error.message)?error.message:'DRY_DIAGNOSTIC_FAILED';
        d.result_json={status:'BLOCKED',error_classification:d.error_classification,failed_stage:d.stage,
          provider_generation_calls:0,publication_calls:0};d.result_sha256=sha256(JSON.stringify(d.result_json));
        d.completed_at=iso(this.clock());d.lease=null;
      });
    } finally {clearInterval(heartbeat);}
  }
  async tick() {
    if(this.busy||this.env.LUMI_RUNTIME_ENV!=='staging')return;
    this.busy=true;
    try {for(const row of await this.store.pendingDiagnostics())await this.process(row.episode_id);}
    finally {this.busy=false;}
  }
  startPolling() {
    // Timer is only a wake-up. Accepted work, leases, stage receipts and results
    // live in Postgres. Boot/redeploy scans the same queue, never creates a job.
    const wake=()=>this.tick().catch(()=>this.logger.warn(JSON.stringify({event:'lumi_dry_checkpoint_unavailable'})));
    const timer=setInterval(wake,3000);timer.unref?.();void wake();
    return ()=>clearInterval(timer);
  }
}

export function buildDryResult(c) {
  const t=c.TTS_PREFLIGHT,g=c.GENERIC_DRY_RUN,r=c.RUNTIME;
  if(!t||!g||!r)fail('DRY_RESULT_INVALID');
  const gates={HMAC:'PASS',OPERATION_PERSISTED:'PASS',ELEVENLABS_AUTH:t.ELEVENLABS_AUTH,
    MODEL_VALIDATION:t.MODEL_VALIDATION,
    FERNANDA_CALLABLE:t.FERNANDA_CALLABLE,TTS_QUOTA:t.TTS_QUOTA,TTS_BUDGET_GATE:t.TTS_BUDGET_GATE,
    TTS_STORAGE_GATE:t.TTS_STORAGE_GATE,TTS_DRY_BOUNDARY:t.TTS_DRY_BOUNDARY,
    REAL_EXECUTOR_BINDINGS:g.bound===14&&g.total===14?'PASS':'BLOCKED',GENERIC_V2_DRY_RUN:g.status,
    GENERIC_CONTINUATION:g.continuation,RECOVERY_MANAGER:g.recovery,TELEGRAM_SINGLE_PANEL:r.TELEGRAM_SINGLE_PANEL,
    ROLLBACK_TO_LEGACY:g.rollback==='PASS'&&r.legacy_preserved?'PASS':'BLOCKED',RUNTIME_SAFETY:r.status};
  const blockers=Object.entries(gates).filter(([,v])=>v!=='PASS').map(([k])=>k);
  return {status:blockers.length?'BLOCKED':'PASS',blockers,gates,real_executor_bindings:`${g.bound}/${g.total}`,
    tts_preflight:t,generic_dry_run:g,runtime:r,duplicate_operations:0,duplicate_provider_calls:0,
    provider_generation_calls:0,publication_calls:0,
    evidence_scope:'Authenticated native TTS reads and isolated storage probe; existing fixture through 14 real dry wrappers. Media QA and crash matrix are fixture contract evidence, not a generated episode or human review.',
    production_acceptance_started:false};
}
