import {randomUUID} from 'node:crypto';
import {DiagnosticHttpObservability,diagnosticHttpError} from './lumi-diagnostic-http.js';
import {authenticateDiagnosticCommand,diagnosticGrant,bindDiagnosticAuthorizationStore,inputDigest} from './lumi-v2-activation-context.js';
import {DRY_OPERATION_TYPE} from './lumi-durable-dry-run.js';
import {prepareGenericV2Episode} from './lumi-generic-v2-adapter.js';
import {createGenericV2Runtime} from './lumi-v2-telegram-runtime.js';
import {LumiRecoveryIncidentManager} from './lumi-recovery-incident-manager-v1.js';
import {ProductionReviewController} from './telegram-review-v1/production.js';
import {sha256,reviewGate,persistStageDecision} from './telegram-review-v1/core.js';
import {LUMI_PRODUCTION_PROFILE_V2 as profile} from './lumi-production-profile-v2.js';

const phases=['CONTEXT','CREATE','RESUME','REVIEW','RESULT'];
const copy=x=>structuredClone(x), fail=code=>{throw Error(code);};
const deny=()=>fail('DIAGNOSTIC_CAPABILITY_FORBIDDEN');
const fixtureBytes=Buffer.from('LUMI DIAGNOSTIC INPUT V1: TEXT BYTES, NOT GENERATED OR PLAYABLE MEDIA');

// One existing diagnostic CAS row owns everything. No Telegram session/admin,
// production checkpoint, incident, storage object or provider journal is created.
// VALIDATION_CONTEXT is deliberately outside the durable dry-run worker queue.
export class IsolatedV2Validation {
  constructor({store,env,validateOwner,clock=Date.now,leaseMs=60000,inject=async()=>{}}){
    Object.assign(this,{store,env,validateOwner,clock,leaseMs,inject});
    this.http=new DiagnosticHttpObservability(this);
  }
  async load(c){
    if(this.env.LUMI_RUNTIME_ENV!=='staging'||Date.parse(c.expires_at)<=this.clock())fail('DIAGNOSTIC_EXPIRED');
    const row=await this.store.getEpisode(c.operation_id),v=row?.metadata?.isolated_validation;
    if(!v||row.metadata.operation_type!==DRY_OPERATION_TYPE||row.status!=='VALIDATION_CONTEXT'
      ||v.requester!==c.requester||v.requester_chat!==c.requesterChat||v.operation_id!==c.operation_id
      ||v.idempotency_key!==c.idempotency_key||v.expires_at!==c.expires_at
      ||v.staging_revision!==this.env.RENDER_GIT_COMMIT||v.request_sha!==inputDigest(v.request)
      ||inputDigest(v.grant)!==inputDigest(diagnosticGrant(c,v.request_sha)))fail('DIAGNOSTIC_BINDING_MISMATCH');
    if(Date.parse(c.expires_at)<=this.clock())fail('DIAGNOSTIC_EXPIRED');
    return row;
  }
  async mutate(c,change){
    for(let i=0;i<6;i++){
      const row=await this.load(c),revision=row.metadata.diagnostic_revision;
      const value=change(row.metadata.isolated_validation);
      row.metadata.diagnostic_revision=revision+1;row.updated_at=new Date(this.clock()).toISOString();
      if(await this.store.casDiagnostic(row,revision))return value;
    }
    fail('DIAGNOSTIC_CAS_CONFLICT');
  }
  async context(c,request,httpAttempt){
    if(!/^[a-f0-9]{40}$/.test(this.env.RENDER_GIT_COMMIT||''))fail('DIAGNOSTIC_REVISION_REQUIRED');
    if(request?.episodePlan?.episode?.id!==c.episode_id)fail('DIAGNOSTIC_EPISODE_MISMATCH');
    prepareGenericV2Episode(request);
    const grant=diagnosticGrant(c,c.request_sha),now=new Date(this.clock()).toISOString();
    const result={status:'DIAGNOSTIC_CONTEXT_READY',diagnostic_identity:c.user,operation_id:c.operation_id,
      episode_id:c.episode_id,expires_at:c.expires_at,audience:'staging',dry_run:true,
      provider_generation:false,publication:false,telegram_mutation:false};
    const value={operation_id:c.operation_id,requester:c.requester,requester_chat:c.requesterChat,
      idempotency_key:c.idempotency_key,expires_at:c.expires_at,staging_revision:this.env.RENDER_GIT_COMMIT,
      request_sha:c.request_sha,request:copy(request),grant,nonces:{[c.nonce]:c.body_sha},results:{CONTEXT:result},
      inputs_loaded:false,lease:null,checkpoint:null,incidents:{},objects:{},journal:{},materializations:{},
      review:{revision:0,state:{user_id:c.user,chat_id:null,message_id:null,diagnostic:true,
        v2_authorizations:{[c.authorization_id]:grant},episodes:{},reviews:[],production_commands:{}}}};
    value.http_observability_version=1;
    value.http_records=httpAttempt?[this.http.received(httpAttempt,value)]:[];
    const row={episode_id:c.operation_id,pipeline_version:'v1_1_2',preset_version:'1.1.2',status:'VALIDATION_CONTEXT',
      runner_enabled:false,autorun:false,current_cost_usd:0,authorized_ceiling_usd:0,last_completed_action:null,
      first_pending_action:null,active_incident_id:null,cancellation_reason:null,actions:[],created_at:now,updated_at:now,
      metadata:{diagnostic:true,operation_type:DRY_OPERATION_TYPE,diagnostic_revision:0,isolated_validation:value}};
    if(this.env.LUMI_RUNTIME_ENV!=='staging'||Date.parse(c.expires_at)<=this.clock())fail('DIAGNOSTIC_EXPIRED');
    const created=await this.store.createDiagnostic(row);
    if(!created){
      if(httpAttempt)await this.http.append(httpAttempt);
      const old=(await this.load(c)).metadata.isolated_validation;
      if(old.request_sha!==c.request_sha)fail('DIAGNOSTIC_IDEMPOTENCY_CONFLICT');
      await this.claimNonce(c);
    }
    await this.inject({point:'CONTEXT_PERSISTED'});
    return result;
  }
  async claimNonce(c){
    await this.mutate(c,v=>{
      if(v.nonces[c.nonce])fail('replayed_request');
      if(Object.keys(v.nonces).length>=256)fail('DIAGNOSTIC_NONCE_CAPACITY');
      v.nonces[c.nonce]=c.body_sha;
    });
  }
  // Every access is fenced by operation, TTL and the current phase lease.
  // A timed-out process cannot write after a replacement has taken the lease.
  namespace(c,token){
    const fence=v=>{if(v.lease?.token!==token||v.lease.until<=this.clock())fail('DIAGNOSTIC_LEASE_LOST');};
    const read=async()=>{const v=(await this.load(c)).metadata.isolated_validation;fence(v);return v;};
    const write=change=>this.mutate(c,v=>{fence(v);return change(v);});
    const episode=id=>{if(id!==c.episode_id)fail('DIAGNOSTIC_NAMESPACE_DENIED');};
    const user=id=>{if(id!==c.user)fail('DIAGNOSTIC_NAMESPACE_DENIED');};
    const validCheckpoint=p=>{
      episode(p.episode_id);
      if(p.metadata?.user!==c.user||p.metadata?.dry_run!==true||p.metadata.activation_context?.diagnostic!==true
        ||p.metadata.activation_context.operation_id!==c.operation_id||p.runner_enabled!==false||p.autorun!==false
        ||p.authorized_ceiling_usd!==0||p.current_cost_usd!==0)fail('DIAGNOSTIC_NAMESPACE_DENIED');
    };
    const checkpointStore={
      getEpisode:async id=>{episode(id);return copy((await read()).checkpoint);},
      createGenericEpisode:async p=>{validCheckpoint(p);return write(v=>{if(v.checkpoint)return null;v.checkpoint=copy(p);return copy(p);});},
      casGenericEpisode:async(p,revision)=>{validCheckpoint(p);return write(v=>{
        if(v.checkpoint?.metadata.runtime_revision!==revision)return null;v.checkpoint=copy(p);return copy(p);});},
      // Recovery uses putEpisode only for a pre-existing checkpoint. Still CAS
      // and operation fenced; no pass-through to the underlying production store.
      putEpisode:async p=>{validCheckpoint(p);return write(v=>{
        if(!v.checkpoint||p.metadata.runtime_revision!==v.checkpoint.metadata.runtime_revision)fail('STALE_CHECKPOINT');
        const next=copy(p);next.metadata.runtime_revision++;v.checkpoint=next;return copy(next);});},
      putIncident:async i=>{episode(i.episode_id);return write(v=>{v.incidents[i.incident_id]=copy(i);return copy(i);});},
      getIncident:async id=>copy((await read()).incidents[id]||null),
      listIncidents:async id=>{episode(id);return copy(Object.values((await read()).incidents));},
      reviewState:async id=>{episode(id);const e=(await read()).review.state.episodes[id];return e?reviewGate(e):null;}
    };
    const reviewStore={
      get:async id=>{user(id);return copy((await read()).review);},
      cas:async(id,revision,state)=>{user(id);return write(v=>{
        if(v.review.revision!==revision)fail('concurrent_update');
        if(state.user_id!==c.user||state.chat_id!==null||state.message_id!==null||state.diagnostic!==true
          ||Object.keys(state.episodes).some(id=>id!==c.episode_id)
          ||inputDigest(state.v2_authorizations)!==inputDigest(v.review.state.v2_authorizations))fail('DIAGNOSTIC_NAMESPACE_DENIED');
        v.review={revision:revision+1,state:copy(state)};return revision+1;
      });}
    };
    const storage={download:async(bucket,path)=>{
      if(bucket!=='lumi-diagnostic-inline'||!path.startsWith(c.operation_id+'/'))fail('DIAGNOSTIC_NAMESPACE_DENIED');
      const bytes=(await read()).objects[path];return bytes?Buffer.from(bytes,'base64'):null;
    },upload:deny,remove:deny};
    const journal={get:async id=>copy((await read()).journal[id]||null),prepare:deny,transition:deny};
    bindDiagnosticAuthorizationStore(reviewStore,c);
    return {read,write,checkpointStore,reviewStore,storage,journal};
  }
  async handle({signed,signature,httpAttempt}){
    const {command:c,request}=authenticateDiagnosticCommand({env:this.env,signed,signature,now:this.clock()});
    if(!await this.validateOwner(c.requester,c.requesterChat))fail('DIAGNOSTIC_OWNER_INACTIVE');
    if(c.phase==='CONTEXT')return this.response(c,await this.context(c,request,httpAttempt));
    await this.claimNonce(c);
    if(c.phase==='STATUS')return this.response(c,{status:'DIAGNOSTIC_STATUS',results:(await this.load(c)).metadata.isolated_validation.results});
    const token=randomUUID();
    const prior=await this.mutate(c,v=>{
      if(v.results[c.phase]){
        if(c.phase==='REVIEW'&&v.decision!==c.decision)fail('DIAGNOSTIC_IDEMPOTENCY_CONFLICT');
        return v.results[c.phase];
      }
      if(!v.results[phases[phases.indexOf(c.phase)-1]])fail('DIAGNOSTIC_PHASE_ORDER');
      if(v.lease&&v.lease.until>this.clock())fail('DIAGNOSTIC_BUSY');
      if(c.phase==='REVIEW'){
        if(v.decision&&v.decision!==c.decision)fail('DIAGNOSTIC_IDEMPOTENCY_CONFLICT');v.decision=c.decision;
      }
      v.lease={token,phase:c.phase,until:this.clock()+this.leaseMs};return null;
    });
    if(prior)return this.response(c,{...prior,already_applied:true});
    const ns=this.namespace(c,token),manager=new LumiRecoveryIncidentManager({store:ns.checkpointStore});
    const adapter=createGenericV2Runtime({manager,reviewStore:ns.reviewStore,artifactStorage:ns.storage,journal:ns.journal,
      validateOwner:async(user,chat)=>{await ns.read();return user===c.user&&chat===null;},
      mediaTransport:deny,fetchImpl:deny,ttsRuntime:{},env:{LUMI_RUNTIME_ENV:'staging'},inject:async event=>{
        if(event.point==='RESUME_AFTER_MATERIALIZATION')await ns.write(v=>{
          v.materializations[event.materialization.action_key]=event.materialization;
        });
        await this.inject(event);
      }});
    const production=new ProductionReviewController({store:ns.reviewStore,adapters:{[profile.id]:adapter}});
    try{
      let result;
      if(c.phase==='CREATE'){
        result=await production.create({user:c.user,chat:null,request:(await ns.read()).request,
          requested_profile:profile.id,authenticatedCommand:c});
        await this.inject({point:'CREATE_PERSISTED'});
      }else if(c.phase==='RESUME'){
        // One real stage per signed HTTP request. Combining both planning stages
        // and review made 119 serial DB accesses share the 60s phase lease.
        // Continue only through another explicit signed request for this context;
        // no worker, retry, larger timeout or implicit next-stage dispatch.
        const state=await ns.checkpointStore.getEpisode(c.episode_id);
        if(['planning','source-planning'].includes(state.first_pending_action)){
          result=await production.resume({user:c.user,episodeId:c.episode_id,expectedAction:state.first_pending_action});
          if(result.status!=='STAGE_COMPLETE')fail('DIAGNOSTIC_PLANNING_NOT_COMPLETE');
          result={...result,continuation_required:true};
        }else{
          // Explicitly labelled persisted input data, never an executor.
          await this.loadReviewInput(c,ns);
          const v=await ns.read(),key=v.checkpoint.first_pending_action;
          // After a killed process, reconcile only a durably completed receipt.
          // Missing receipt remains ambiguous; no executor replacement.
          if(!Object.keys(v.review.state.episodes[c.episode_id].review_requests).length)
            await production.resume({user:c.user,episodeId:c.episode_id,expectedAction:key});
          const after=await ns.read(),requests=Object.values(after.review.state.episodes[c.episode_id].review_requests);
          if(requests.length!==1||requests[0].status!=='PENDING'
            ||after.checkpoint.actions.find(a=>a.key===key)?.status!=='HUMAN_REVIEW_REQUIRED'
            ||inputDigest(after.checkpoint.metadata.review_requests?.[requests[0].review_request_id]??null)!==inputDigest(requests[0]))
            fail('DIAGNOSTIC_REVIEW_NOT_REACHED');
          result={status:'HUMAN_REVIEW_REQUIRED',first_pending_action:after.checkpoint.first_pending_action,
            review_request:requests[0],materializer:'DURABLE_CHECKPOINT_AND_ARTIFACT_REGISTRY',
            input_scope:'SYNTHETIC_TEXT_BYTES_NOT_MEDIA'};
          await this.inject({point:'RESUME_PERSISTED'});
        }
      }else if(c.phase==='REVIEW'){
        const v=await ns.read(),r=Object.values(v.review.state.episodes[c.episode_id].review_requests)[0];
        result=await persistStageDecision({store:ns.reviewStore,production,user:c.user,chat:null,episodeId:c.episode_id,
          requestId:r.review_request_id,decision:c.decision,artifactSha:r.artifact_sha,reviewVersion:r.review_version,
          evidence:{diagnostic:true,operation_id:c.operation_id,diagnostic_decision_id:sha256(c.operation_id+':REVIEW')}});
      }else{
        const v=await ns.read(),r=Object.values(v.checkpoint.metadata.review_requests||{})[0],m=v.materializations[r?.action_key];
        const gates={
          CREATE_ROUTE:v.results.CREATE.status==='PREPARED'&&v.checkpoint.metadata.generic_v2.episode_id===c.episode_id,
          RESUME_ROUTE:['planning','source-planning',r?.action_key].every(key=>v.checkpoint.metadata.stage_results?.[key]),
          REVIEW_ROUTE:r?.continuation_applied&&v.review.state.reviews.length===1
            &&['READY_TO_CONTINUE','REPAIR_PLAN_REQUIRED'].includes(v.results.REVIEW.status),
          REAL_INPUT_MATERIALIZER:m?.readiness_status==='READY'&&m.provenance.source==='DURABLE_CHECKPOINT_AND_ARTIFACT_REGISTRY'
            &&m.artifact_count===1&&m.provider_calls===0&&m.new_artifacts===0,
          CONTROLLED_ACTIVATION:v.checkpoint.metadata.activation_context?.diagnostic===true
            &&v.checkpoint.metadata.activation_context.operation_id===c.operation_id&&v.checkpoint.metadata.dry_run===true
        };
        if(Object.values(gates).some(ok=>!ok))
          fail('DIAGNOSTIC_RESULT_INCOMPLETE');
        result={status:'PASS',gates:Object.fromEntries(Object.keys(gates).map(key=>[key,'PASS'])),
          materialization_evidence:m,duplicate_operations:0,duplicate_review_rows:0,
          duplicate_provider_calls:0,evidence_scope:'REAL_ROUTES_WITH_ISOLATED_SYNTHETIC_INPUTS; NO_MEDIA_QUALITY_OR_HUMAN_APPROVAL_CLAIM',
          review_decision:v.decision};
      }
      await ns.write(v=>{
        // REVIEW remains gated until the actual human pause is durable.
        if(c.phase==='RESUME'&&result.continuation_required)v.resume_progress=result;
        else v.results[c.phase]=result;
        v.last_event={phase:c.phase,status:result.status,first_pending_action:v.checkpoint?.first_pending_action??null,
          at:new Date(this.clock()).toISOString()};v.lease=null;
      });
      if(c.phase==='RESULT')await this.inject({point:'RESULT_PERSISTED'});
      return this.response(c,result);
    }catch(error){
      // Preserve a bounded code, never raw provider data or credentials. A stale
      // process cannot overwrite a replacement owner's phase evidence.
      const code=diagnosticHttpError(error).error_code==='DIAGNOSTIC_STORAGE_FAILED'?'DIAGNOSTIC_STORAGE_FAILED':['DIAGNOSTIC_LEASE_LOST','ARTIFACT_MISSING','ARTIFACT_INTEGRITY_FAILURE','QA_NOT_ELIGIBLE',
        'CHECKPOINT_CONSISTENCY_FAILURE','STALE_CHECKPOINT','PROVIDER_JOURNAL_MISMATCH',
        'DIAGNOSTIC_REVIEW_NOT_REACHED','DIAGNOSTIC_PLANNING_NOT_COMPLETE'].includes(error.message)
        ?error.message:'DIAGNOSTIC_PHASE_FAILED';
      await this.mutate(c,v=>{if(v.lease?.token===token){
        v.last_event={phase:c.phase,status:'BLOCKED',error_code:code,
          first_pending_action:v.checkpoint?.first_pending_action??null,at:new Date(this.clock()).toISOString()};v.lease=null;
      }}).catch(()=>{fail('DIAGNOSTIC_LEASE_RELEASE_FAILED');});
      throw Error(code.startsWith('DIAGNOSTIC_')?code:'DIAGNOSTIC_'+code);
    }finally{
      // A killed process never reaches this. A later signed request can reclaim
      // the expired lease, using the same operation/checkpoint/decision receipts.
      try{
        const lease=(await this.load(c)).metadata.isolated_validation.lease;
        if(lease?.token===token)await this.mutate(c,v=>{if(v.lease?.token===token)v.lease=null;});
      }catch{fail('DIAGNOSTIC_LEASE_RELEASE_FAILED');}
    }
  }
  async loadReviewInput(c,ns){
    await ns.write(v=>{
      if(v.inputs_loaded)return;
      const d=v.checkpoint,e=v.review.state.episodes[c.episode_id],shot=d.metadata.generic_v2.shot_plans[0];
      if(d.first_pending_action!=='image:'+shot.shot_id)fail('DIAGNOSTIC_PHASE_ORDER');
      const action=d.actions.find(a=>a.stage==='SHOT_REVIEW'),key='video:'+shot.shot_id;
      const id='diagnostic_video_input',claim='diagnostic_input_receipt',job='diagnostic_input_job';
      const a={artifact_id:id,episode_id:c.episode_id,stage_id:'VIDEO',provider_job_id:job,diagnostic:true,
        input_scope:'SYNTHETIC_TEXT_BYTES_NOT_MEDIA',sha256:sha256(fixtureBytes),size:fixtureBytes.length,mime:'video/mp4',
        bucket:'lumi-diagnostic-inline',path:c.operation_id+'/input.txt'};
      const result={status:'SUCCEEDED',episode_id:c.episode_id,stage_id:'VIDEO',artifacts:[a],provider_job_ids:[job],
        claims:[claim],qa:{ok:true,status:'PASS',sha256:a.sha256,scope:'SYNTHETIC_INPUT_ONLY'},human_review_requirement:false};
      for(const prev of d.actions.filter(x=>x.index<action.index&&x.status!=='COMPLETE')){
        prev.status='COMPLETE';prev.evidence={provider_succeeded:true,artifact_persisted:true,sha_verified:true,artifact_verified:true,
          scope:'DIAGNOSTIC_INPUT_FIXTURE_ONLY'};
      }
      d.metadata.artifacts={[id]:a};d.metadata.stage_results||={};
      d.metadata.stage_results[key]={receipt_id:claim,hash_version:'CANONICAL_JSON_V1',sha256:inputDigest(result),result};
      d.metadata.stage_qa||={};d.metadata.stage_qa[key]=result.qa;
      d.first_pending_action=action.key;d.last_completed_action=d.actions[action.index-1].key;d.metadata.runtime_revision++;
      e.artifacts[id]=a;e.next_action=action.key;e.first_pending_action=action.key;
      v.objects[a.path]=fixtureBytes.toString('base64');
      v.journal[claim]={attempt_id:claim,episode_id:c.episode_id,stage:'VIDEO',provider_request_id:job,state:'ACKNOWLEDGED',diagnostic:true};
      v.review.revision++;v.inputs_loaded=true;
    });
  }
  response(c,result){return {...result,operation_id:c.operation_id,authenticated:true,dry_run:true,
    provider_generation_calls:0,publication_calls:0,telegram_mutation_calls:0,actions:[],commands:[]};}
}
