import {randomUUID} from 'node:crypto';
import {verifyRequest,scopedEnabled} from './telegram-review-v1/make-transport.js';
import {DIAGNOSTIC_OP,diagnosticOperationId,inputDigest} from './lumi-v2-activation-context.js';
import {DRY_OPERATION_TYPE} from './lumi-durable-dry-run.js';
import {sha256} from './telegram-review-v1/core.js';

const trusted=new WeakSet(), phases=['CONTEXT','CREATE','RESUME','REVIEW','RESULT','STATUS'];
const fail=code=>{throw Error(code);};
const statuses=new Map([
  ...['DIAGNOSTIC_PAYLOAD_INVALID','DIAGNOSTIC_OPERATION_MISMATCH'].map(c=>[c,400]),
  ['DIAGNOSTIC_AUTH_REQUIRED',401],
  ...['DIAGNOSTIC_SCOPE_DENIED','DIAGNOSTIC_OWNER_INACTIVE','DIAGNOSTIC_NAMESPACE_DENIED',
    'DIAGNOSTIC_CAPABILITY_FORBIDDEN','DIAGNOSTIC_EXPIRED'].map(c=>[c,403]),
  ...['replayed_request','DIAGNOSTIC_REQUEST_ID_CONFLICT','DIAGNOSTIC_BUSY','DIAGNOSTIC_PHASE_ORDER',
    'DIAGNOSTIC_BINDING_MISMATCH','DIAGNOSTIC_IDEMPOTENCY_CONFLICT','DIAGNOSTIC_CAS_CONFLICT',
    'DIAGNOSTIC_LEASE_LOST','DIAGNOSTIC_STALE_CHECKPOINT','DIAGNOSTIC_CHECKPOINT_CONSISTENCY_FAILURE',
    'DIAGNOSTIC_NONCE_CAPACITY','DIAGNOSTIC_HTTP_CAPACITY','DIAGNOSTIC_HTTP_OBSERVABILITY_REQUIRED'].map(c=>[c,409]),
  ...['DIAGNOSTIC_EPISODE_MISMATCH','DIAGNOSTIC_ARTIFACT_MISSING','DIAGNOSTIC_ARTIFACT_INTEGRITY_FAILURE',
    'DIAGNOSTIC_QA_NOT_ELIGIBLE','DIAGNOSTIC_PROVIDER_JOURNAL_MISMATCH','DIAGNOSTIC_REVIEW_NOT_REACHED',
    'DIAGNOSTIC_PLANNING_NOT_COMPLETE','DIAGNOSTIC_RESULT_INCOMPLETE'].map(c=>[c,422]),
  ...['DIAGNOSTIC_RUNTIME_UNAVAILABLE','DIAGNOSTIC_REVISION_REQUIRED','DIAGNOSTIC_PHASE_FAILED'].map(c=>[c,500]),
  ...['DIAGNOSTIC_HTTP_PERSISTENCE_FAILED','DIAGNOSTIC_LEASE_RELEASE_FAILED','DIAGNOSTIC_STORAGE_FAILED'].map(c=>[c,503])
]);
export function diagnosticHttpError(error){
  const storage=['DRY_CHECKPOINT_WRITE_FAILED','DRY_CHECKPOINT_READ_FAILED','lumi_checkpoint_read_failed','lumi_checkpoint_write_failed'];
  const auth=['signature_expired','signature_missing_or_invalid','signature_invalid','invalid_auth_envelope','callback_secret_missing'];
  const code=auth.includes(error?.message)?'DIAGNOSTIC_AUTH_REQUIRED':storage.includes(error?.message)?'DIAGNOSTIC_STORAGE_FAILED':statuses.has(error?.message)?error.message:'DIAGNOSTIC_PHASE_FAILED';
  // Static dictionary only. Never persist error.message, stack, cause or bodies.
  return {http_status:statuses.get(code),error_code:code,sanitized_error_message:code};
}
const safePhase=phase=>phases.includes(phase)?phase:'INVALID';
const safeStage=stage=>['CONTEXT','CREATE','REVIEW','RESULT','STATUS','INVALID','PLANNING','SOURCE_PLANNING',
  'IMAGE','DIRECTOR','VIDEO','TEMPORAL_QA','SHOT_REVIEW','TTS','TTS_STORAGE','ASSEMBLY','MASTER','MASTER_REVIEW'].includes(stage)?stage:null;
const snapshot=(v,now)=>({
  checkpoint_version:v.checkpoint?.metadata?.runtime_revision??null,
  checkpoint_sha256:v.checkpoint?inputDigest(v.checkpoint):null,
  lease_state:!v.lease?'FREE':v.lease.until>now?'HELD':'EXPIRED',
  lease_phase:v.lease?safePhase(v.lease.phase):null,
  lease_until:v.lease&&Number.isFinite(v.lease.until)?v.lease.until:null
});

// An append-only, bounded field of the EXISTING diagnostic CAS row, not a second
// journal. It never grants execution authority or changes checkpoint/nonces.
export class DiagnosticHttpObservability {
  constructor(runtime){this.runtime=runtime;}
  async identity({signed,signature}){
    const {env,clock,validateOwner}=this.runtime;
    try{verifyRequest(env.LUMI_TELEGRAM_CALLBACK_SECRET,signed,signature,clock());}
    catch{fail('DIAGNOSTIC_AUTH_REQUIRED');}
    if(signed.method!=='POST'||signed.path!=='/lumi/telegram-review/make/v1')fail('DIAGNOSTIC_AUTH_REQUIRED');
    let body;try{body=JSON.parse(signed.body.toString());}catch{fail('DIAGNOSTIC_PAYLOAD_INVALID');}
    if(!body||body.op!==DIAGNOSTIC_OP)fail('DIAGNOSTIC_PAYLOAD_INVALID');
    const user=String(body.user_id),chat=String(body.chat_id);
    if(!scopedEnabled(env,user,chat))fail('DIAGNOSTIC_SCOPE_DENIED');
    if(!await validateOwner(user,chat))fail('DIAGNOSTIC_OWNER_INACTIVE');
    if(typeof body.idempotency_key!=='string'||!/^[a-z][a-zA-Z0-9_.:-]{7,95}$/.test(body.idempotency_key)
      ||body.operation_id!==diagnosticOperationId(user,body.idempotency_key))fail('DIAGNOSTIC_OPERATION_MISMATCH');
    const a=Object.freeze({id:randomUUID(),request_id:signed.requestId,operation_id:body.operation_id,
      request_phase:safePhase(body.phase),user,chat,body_sha256:sha256(signed.body)});
    trusted.add(a);return a;
  }
  bound(row,a){
    const v=row?.metadata?.isolated_validation;
    if(!trusted.has(a)||row?.status!=='VALIDATION_CONTEXT'||row.metadata.operation_type!==DRY_OPERATION_TYPE
      ||v?.operation_id!==a.operation_id||v.requester!==a.user||v.requester_chat!==a.chat)
      fail('DIAGNOSTIC_BINDING_MISMATCH');
    return v;
  }
  received(a,v){
    if(!trusted.has(a))fail('DIAGNOSTIC_AUTH_REQUIRED');
    const now=this.runtime.clock(),stage=a.request_phase==='RESUME'
      ?v.checkpoint?.actions?.find(x=>x.key===v.checkpoint.first_pending_action)?.stage:a.request_phase;
    return {http_attempt_id:a.id,event_kind:'RECEIVED',request_id:a.request_id,operation_id:a.operation_id,
      request_phase:a.request_phase,stage_id:safeStage(stage),timestamp:new Date(now).toISOString(),
      http_status:null,error_code:null,sanitized_error_message:null,...snapshot(v,now),
      runtime_revision:/^[a-f0-9]{40}$/.test(this.runtime.env.RENDER_GIT_COMMIT||'')?this.runtime.env.RENDER_GIT_COMMIT:null,result_status:'OUTCOME_UNKNOWN',
      evidence_reference:`diagnostic:${a.operation_id}:http:${a.id}:RECEIVED`,body_sha256:a.body_sha256};
  }
  async append(a,terminal,initialRow){
    const {store,clock,env}=this.runtime;
    for(let i=0;i<6;i++){
      const row=i===0&&initialRow?initialRow:await store.getEpisode(a.operation_id),v=this.bound(row,a);
      // No migration/backfill of the historical diagnostic, even on an error.
      if(v.http_observability_version!==1)fail('DIAGNOSTIC_HTTP_OBSERVABILITY_REQUIRED');
      const records=v.http_records,kind=terminal?'HTTP_RESULT':'RECEIVED';
      const existing=records.find(e=>e.http_attempt_id===a.id&&e.event_kind===kind);
      if(existing)return existing;
      let event;
      if(!terminal){
        // Reserve the terminal slot; never evict previous evidence or nonces.
        if(records.filter(e=>e.event_kind==='RECEIVED').length>=256)fail('DIAGNOSTIC_HTTP_CAPACITY');
        const prior=records.find(e=>e.request_id===a.request_id);
        event={...this.received(a,v),duplicate_identity:!!prior,
          identity_conflict:!!prior&&prior.body_sha256!==a.body_sha256};
      }else{
        const received=records.find(e=>e.http_attempt_id===a.id&&e.event_kind==='RECEIVED');
        if(!received)fail('DIAGNOSTIC_HTTP_PERSISTENCE_FAILED');
        const now=clock();
        event={...received,...snapshot(v,now),event_kind:'HTTP_RESULT',timestamp:new Date(now).toISOString(),
          runtime_revision:/^[a-f0-9]{40}$/.test(env.RENDER_GIT_COMMIT||'')?env.RENDER_GIT_COMMIT:null,http_status:terminal.http_status,
          error_code:terminal.error_code??null,sanitized_error_message:terminal.sanitized_error_message??null,
          result_status:terminal.http_status>=400?'HTTP_ERROR_PERSISTED':'HTTP_RESULT_PERSISTED',
          evidence_reference:`diagnostic:${a.operation_id}:http:${a.id}:HTTP_RESULT`};
      }
      records.push(event);
      const revision=row.metadata.diagnostic_revision;row.metadata.diagnostic_revision++;
      row.updated_at=new Date(clock()).toISOString();
      if(await store.casDiagnostic(row,revision))return event;
    }
    fail('DIAGNOSTIC_HTTP_PERSISTENCE_FAILED');
  }
  async run(envelope){
    let a,received,result,error;
    try{
      a=await this.identity(envelope);
      try{
        const row=await this.runtime.store.getEpisode(a.operation_id);
        if(row){
          await this.runtime.inject({point:'HTTP_BEFORE_RECEIVED_PERSISTENCE',request_id:a.request_id});
          received=await this.append(a,undefined,row);
          await this.runtime.inject({point:'HTTP_RECEIVED_PERSISTED',request_id:a.request_id});
        }
      }catch(e){
        if(['DIAGNOSTIC_BINDING_MISMATCH','DIAGNOSTIC_HTTP_OBSERVABILITY_REQUIRED','DIAGNOSTIC_HTTP_CAPACITY'].includes(e.message))throw e;
        fail('DIAGNOSTIC_HTTP_PERSISTENCE_FAILED');
      }
      if(received?.duplicate_identity)fail(received.identity_conflict?'DIAGNOSTIC_REQUEST_ID_CONFLICT':'replayed_request');
      // New CONTEXT embeds RECEIVED atomically with context creation. Invalid
      // requests without a bound row cannot manufacture protected state.
      result=await this.runtime.handle({...envelope,httpAttempt:a});
    }catch(e){error=diagnosticHttpError(e);}
    let event;
    if(a){
      try{
        if(!received){
          const row=await this.runtime.store.getEpisode(a.operation_id);
          if(row){
            const v=this.bound(row,a);
            if(v.http_observability_version===1)
              received=v.http_records.find(e=>e.http_attempt_id===a.id&&e.event_kind==='RECEIVED');
          }
        }
        if(received){
          await this.runtime.inject({point:'HTTP_BEFORE_RESULT_PERSISTENCE',request_id:a.request_id});
          event=await this.append(a,error||{http_status:result.continuation_required?202:200});
          await this.runtime.inject({point:'HTTP_RESULT_PERSISTED',request_id:a.request_id});
        }
      }catch{
        return this.failure('DIAGNOSTIC_HTTP_PERSISTENCE_FAILED',a.request_id,'HTTP_RESULT_NOT_CONFIRMED');
      }
    }
    if(!event&&!error)return this.failure('DIAGNOSTIC_HTTP_PERSISTENCE_FAILED',a?.request_id,'HTTP_RESULT_NOT_CONFIRMED');
    const status=event?.http_status??error.http_status;
    const body=error?{error:error.error_code,provider_generation_calls:0,actions:[],commands:[]} : result;
    return {status,body:{...body,request_id:a?.request_id??null,http_attempt_id:a?.id??null,
      http_result_persisted:!!event,evidence_reference:event?.evidence_reference??null,
      ...(!event?{observability_limit:'NO_WRITABLE_BOUND_CONTEXT_OR_TRUSTED_IDENTITY'}:{})}};
  }
  failure(code,requestId,limit){const e=diagnosticHttpError(Error(code));return {status:e.http_status,
    body:{error:e.error_code,request_id:requestId??null,http_result_persisted:false,observability_limit:limit,
      provider_generation_calls:0,actions:[],commands:[]}};}
  async query({signed,signature,user,operationId,requestId,requestIdHex}){
    const {env,clock,validateOwner,store}=this.runtime;
    const path=`/lumi/telegram-review/make/diagnostic/${user}/${operationId}`+(requestIdHex?`/request/${requestIdHex}`:requestId?`/${requestId}`:'');
    try{
      if(signed.method!=='GET'||signed.path!==path||signed.body.length!==0)fail('DIAGNOSTIC_AUTH_REQUIRED');
      try{verifyRequest(env.LUMI_TELEGRAM_CALLBACK_SECRET,signed,signature,clock());}catch{fail('DIAGNOSTIC_AUTH_REQUIRED');}
      if(!scopedEnabled(env,user,user)||!await validateOwner(user,user))fail('DIAGNOSTIC_SCOPE_DENIED');
      // A colon is valid in request IDs but forbidden by the existing signed
      // path grammar. Hex encoding preserves that HMAC contract unchanged.
      if(requestIdHex){
        if(!/^(?:[a-f0-9]{2}){1,128}$/.test(requestIdHex))fail('DIAGNOSTIC_PAYLOAD_INVALID');
        requestId=Buffer.from(requestIdHex,'hex').toString('utf8');
      }
      if(!/^diag_v2_[a-f0-9]{64}$/.test(operationId)||requestId&&!/^[\w:-]{1,128}$/.test(requestId))fail('DIAGNOSTIC_PAYLOAD_INVALID');
      const row=await store.getEpisode(operationId),a={operation_id:operationId,user,chat:user};trusted.add(a);
      const v=this.bound(row,a),records=(v.http_records||[]).filter(e=>!requestId||e.request_id===requestId);
      // GET never claims a nonce, releases a lease, repairs a result or executes.
      return {status:200,body:{operation_id:operationId,request_id:requestId??null,http_records:records,
        status:records.length?'DURABLE_HTTP_EVIDENCE':'HTTP_EVIDENCE_NOT_AVAILABLE',
        observation:'PERSISTED_INTENT_ONLY; DELIVERY_UNKNOWN; RECEIVED_WITHOUT_RESULT_IS_OUTCOME_UNKNOWN',
        provider_generation_calls:0,actions:[],commands:[]}};
    }catch(e){return this.failure(diagnosticHttpError(e).error_code,signed.requestId,'READ_ONLY_QUERY');}
  }
}
