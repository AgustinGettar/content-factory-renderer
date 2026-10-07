import {runRealExecutorDryGate} from '../lumi-v2-real-executor-dry-run.js';
import {runElevenLabsTtsRecoveryMatrix} from '../lumi-elevenlabs-recovery-v3.js';
import {selectLumiCreationProfile} from '../lumi-production-profile-v2.js';
import { reviewGate, validateArtifact, sha256, artifactReview } from './core.js';
import {executeLumiTtsStage} from '../lumi-tts-stage-v2.js';
import {readFile} from 'node:fs/promises';
import {createArtifactStorage,inspectMaterializedArtifact} from '../lumi-artifact-materialization-v2.js';
import {LumiRecoveryIncidentManager,SupabaseLumiRecoveryStore} from '../lumi-recovery-incident-manager-v1.js';
import {LumiV2ExecutionOrchestrator,ReviewStageReceiptStore} from '../lumi-v2-execution-orchestrator.js';
import {sourceGate} from '../lumi-series-v2-gates.js';
import {evaluateTemporalTopology,CONFIDENCE_CALIBRATION_VERSION} from '../cinematic-director-v1/temporal-topology-qa-v2.js';
import {isGenericV2Runtime} from '../lumi-v2-telegram-runtime.js';
// An adapter must use the existing canonical Recovery Manager, provider journal,
// budget and authorization gates. Never bypass those gates from a Telegram button.
export class ProductionReviewController {
  constructor({store,db,adapters={},ttsRuntime=null}){this.store=store;this.db=db;this.adapters=adapters;this.ttsRuntime=ttsRuntime;}
  // Narrow, non-generative stages for the durable Recovery Manager diagnostic.
  // Returned values are an explicit projection: never persist provider payloads,
  // headers, credentials, signed URLs, raw errors or account/voice metadata.
  async diagnosticStage(stage,operation,guard,env) {
    const pass = value => value === true ? 'PASS' : 'BLOCKED';
    if(stage==='TTS_PREFLIGHT') {
      const fixture=JSON.parse(await readFile(new URL('../../qa/LUMI_GENERIC_LISTEN_FIXTURE_V1.json',import.meta.url)));
      const receipts=new ReviewStageReceiptStore({store:this.store,user:operation.user}),storage=this.ttsRuntime?.storage;
      const probePath=`lumi-readiness-probe/${operation.operation_id}/probe.mp3`;
      // One immutable technical silence probe per operation. It is retained for
      // recovery, so a killed process cannot orphan a random new object per retry.
      const diagnosticStorage={
        upload:async(bucket,_path,bytes,options)=>{
          await guard();const prior=await storage.download(bucket,probePath);
          if(prior){if(sha256(prior)!==sha256(bytes))throw Error('DRY_PROBE_HASH_MISMATCH');return;}
          await guard();
          try{await storage.upload(bucket,probePath,bytes,options);}
          catch{await guard();const saved=await storage.download(bucket,probePath);if(!saved||sha256(saved)!==sha256(bytes))throw Error('DRY_PROBE_WRITE_FAILED');}
        },
        download:async bucket=>{await guard();return storage.download(bucket,probePath);},
        remove:async()=>{} // retained immutable evidence; no production asset removal
      };
      const guardedReceipts=Object.fromEntries(['get','claim','transition'].map(method=>[method,async(...args)=>{
        for(let i=0;i<6;i++){
          await guard();try{return await receipts[method](...args);}
          catch(error){if(error.message!=='concurrent_update')throw error;}
        }
        throw Error('DRY_RECEIPT_CONTENTION');
      }]));
      const r=await executeLumiTtsStage({episode_id:operation.operation_id,stage_id:'TTS',narration_unit_id:'preflight',
        text:fixture.scenes[0].audio.utterances[0].text,voice_profile_id:'LUMI_VOICE_PROFILE_V3',dry_run:true,require_preflight:true,
        output_artifact_target:{bucket:'generated-audio',prefix:`lumi-readiness-probe/${operation.operation_id}`},
        budget_context:{quota_reserve_characters:1000}},
      {client:{preflight:async request=>{await guard();return this.ttsRuntime.client.preflight(request);}},
        storage:diagnosticStorage,receipts:guardedReceipts});
      return {ELEVENLABS_AUTH:pass(r.ELEVENLABS_AUTH==='PASS'),FERNANDA_CALLABLE:pass(r.quote.FERNANDA_CALLABLE==='PASS'),
        MODEL_VALIDATION:pass(r.quote.MODEL_VALIDATION==='PASS'),TTS_QUOTA:pass(r.quote.QUOTA_OBSERVABILITY==='PASS'),
        TTS_BUDGET_GATE:pass(r.TTS_BUDGET_PREFLIGHT==='PASS'),TTS_STORAGE_GATE:pass(r.storage_gate.status==='PASS'),
        TTS_DRY_BOUNDARY:pass(r.status==='DRY_PROVIDER_BOUNDARY'&&r.emission_journal?.state==='DRY_PROVIDER_BOUNDARY'&&r.TTS_PROVIDER_JOBS_CREATED===0),
        remaining_characters:Number(r.quote.quota.REMAINING_CHARACTERS),estimated_quota_units:Number(r.quote.units),
        budget_scope:'DIAGNOSTIC_ONLY_NOT_EPISODE_BUDGET',storage_probe_sha256:r.storage_gate.sha256,
        request_fingerprint:r.binding.request_fingerprint,provider_generation_calls:0};
    }
    if(stage==='GENERIC_DRY_RUN') {
      await guard();
      const r=await runRealExecutorDryGate({message_id:operation.request.message_id,crashMatrix:true});
      const recovery=await runElevenLabsTtsRecoveryMatrix();
      return {status:pass(r.status==='PASS'&&r.external_calls===0),bound:r.binding.bound,total:r.binding.total,
        continuation:pass(r.end_to_end.status==='PASS'),recovery:pass(r.crash_resume_matrix?.status==='PASS_FOR_BOUND_EXECUTORS'&&recovery.status==='PASS'),
        rollback:pass(r.rollback==='PASS'),stage_count:r.stages.length,crash_cases:r.crash_resume_matrix.rows.length,
        dry_evidence_sha256:sha256(JSON.stringify(r)),provider_generation_calls:0,publication_calls:0,
        scope:'REAL_WRAPPERS_WITH_EXPLICIT_FIXTURE_INPUTS; AUTHENTICATED_TTS_IS_SEPARATE'};
    }
    if(stage==='RUNTIME') {
      await guard();const row=await this.store.get(operation.user),s=row.state;
      const panel=s.message_id===operation.request.message_id&&s.panel_model==='MEDIA_FIRST'&&!!s.TELEGRAM_HOME_FILE_ID
        &&s.HOME_ASSET_SHA===s.cover?.sha256&&s.home_restore_capability?.video_to_photo===true;
      const master=Object.values(s.episodes).some(e=>e.master&&artifactReview(e,e.master)?.human_status==='MASTER_HUMAN_APPROVED'
        &&artifactReview(e,e.master)?.status==='APPROVED'&&s.deliveries[e.master.sha256]?.telegram_file_id);
      const {data,error}=await this.db.from('lumi_pipeline_checkpoints').select('runner_enabled,autorun').or('runner_enabled.eq.true,autorun.eq.true').limit(1);
      const legacy=(env.LUMI_PIPELINE_VERSION||'legacy')==='legacy'&&(env.CREATIVE_ENGINE_VERSION||'legacy')==='legacy';
      const runnersOff=!error&&data?.length===0;
      const route=isGenericV2Runtime(this.adapters?.LUMI_PRODUCTION_PROFILE_V2);
      return {status:pass(panel&&master&&legacy&&runnersOff&&route),TELEGRAM_SINGLE_PANEL:pass(panel),MASTER_HUMAN_APPROVED:pass(master),
        legacy_preserved:legacy,runners_off:runnersOff,autorun:runnersOff?false:null,live_generic_route_registered:route,
        AUTHENTICATED_RUNTIME_RESPONSE:'PASS',DIRECT_HEALTH_HTTP:'NOT_OBSERVED',health_observability:'HEALTH_OBSERVABILITY_WARNING',
        blockers:[...(!route?['TELEGRAM_GENERIC_ROUTE_UNREGISTERED']:[]),...(!runnersOff?['RUNNER_STATE_NOT_PROVEN']:[])],
        provider_generation_calls:0,publication_calls:0};
    }
    throw Error('DRY_STAGE_INVALID');
  }
  async row(user,episodeId){const row=await this.store.get(user);if(!row?.state.episodes[episodeId])throw Error('review_episode_not_found');return row;}
  // Signed staging acceptance replays already completed results. It cannot submit
  // a job, start a real episode or dispatch the next stage. Uses existing stores.
  async replayArtifact({user,episodeId,stage,jobId,audioArtifact,audioBase64}){
    await this.row(user,episodeId);
    if(!['IMAGE','VIDEO','TTS'].includes(stage)||!jobId)throw Error('REPLAY_SCOPE_REQUIRED');
    const storage=createArtifactStorage(this.db);let artifact,provenance,imported=false;
    if(stage==='TTS'){
      validateArtifact(audioArtifact);
      if(audioArtifact.mime!=='audio/mpeg'||audioArtifact.sha256!==audioArtifact.artifact_id
        ||audioArtifact.bucket!=='generated-audio'||audioArtifact.path!==`lumi-originals/${audioArtifact.sha256}.mp3`
        ||audioArtifact.size>1024*1024||!audioArtifact.library_file_id)throw Error('HISTORICAL_AUDIO_BINDING_REQUIRED');
      artifact=audioArtifact;const old=await storage.download(artifact.bucket,artifact.path);
      if(old){if(sha256(old)!==artifact.sha256)throw Error('ARTIFACT_HASH_MISMATCH');}
      else{
        const bytes=Buffer.from(audioBase64||'','base64');
        if(bytes.length!==artifact.size||sha256(bytes)!==artifact.sha256)throw Error('ARTIFACT_HASH_MISMATCH');
        const qa=await inspectMaterializedArtifact(bytes,'TTS',artifact.sha256);
        if(!qa.ok)throw Error('HISTORICAL_AUDIO_INVALID');
        await storage.upload(artifact.bucket,artifact.path,bytes,{contentType:artifact.mime});imported=true;
      }
      provenance={source:'PERSISTED_LIBRARY_ARTIFACT',library_file_id:artifact.library_file_id};
    }else{
      const {data,error}=await this.db.from('lumi_pilot_runs').select('status,provider_request_id,storage_bucket,storage_path,content_hash,result').eq('provider_request_id',jobId).eq('stage',stage).single();
      if(error||data.status!=='SUCCEEDED')throw Error('HISTORICAL_COMPLETION_REQUIRED');
      const bytes=await storage.download(data.storage_bucket,data.storage_path);
      if(!bytes||sha256(bytes)!==data.content_hash)throw Error('ARTIFACT_HASH_MISMATCH');
      artifact={artifact_id:data.content_hash,sha256:data.content_hash,bucket:data.storage_bucket,path:data.storage_path,size:bytes.length,
        mime:stage==='VIDEO'?'video/mp4':data.result.mime||'image/png'};
      provenance={source:'PERSISTED_PROVIDER_COMPLETION',provider_job_id:jobId};
      if(stage==='IMAGE'){sourceGate(artifact,data);provenance.source_qa='PASS';}
      if(stage==='VIDEO'){
        provenance.temporal_qa=evaluateTemporalTopology({sha256:data.content_hash,review:data.result.topology_calibration_layers?.[CONFIDENCE_CALIBRATION_VERSION]?.review??data.result.temporal_qa});
        provenance.historical_human_review=data.result.human_review??null;
      }
    }
    const diagnosticId='diag_media_'+sha256(JSON.stringify([user,stage,jobId,artifact.sha256])).slice(0,32),action={key:'result',stage},
      next={key:'next',stage:stage==='IMAGE'?'SOURCE_QA':stage==='VIDEO'?'TEMPORAL_QA':'ASSEMBLY'},binding=sha256(JSON.stringify([stage,jobId,artifact]));
    const manager=new LumiRecoveryIncidentManager({store:new SupabaseLumiRecoveryStore(this.db)}),receipts=new ReviewStageReceiptStore({store:this.store,user});
    const after=stage==='IMAGE'?{key:'after_qa',stage:'VIDEO'}:stage==='VIDEO'?{key:'after_qa',stage:'SHOT_REVIEW'}:null;
    await manager.startEpisode({episodeId:diagnosticId,actions:[action,next,...(after?[after]:[])],authorizedCeilingUsd:0,
      metadata:{user,diagnostic:true,readiness_replay:true,generic_v2:{episode_id:diagnosticId,binding_sha:binding},historical_provenance:provenance}});
    const id=sha256(diagnosticId+':'+binding+':result');
    if(!await receipts.get(id)){await receipts.claim(id,{status:'STARTED'});await receipts.record(id,{status:'WAITING',result:{provider_job_ids:[jobId]}});}
    const completedResult={episode_id:diagnosticId,stage_id:stage,action_key:'result',provider_job_id:jobId,result_id:'original',
      expected_sha256:artifact.sha256,existing_artifact:artifact,target:{bucket:artifact.bucket,prefix:'replay'},review_required:false};
    const orchestrator=new LumiV2ExecutionOrchestrator({manager,receipts,artifactStorage:storage});
    let continuation=await orchestrator.recoverResult({episodeId:diagnosticId,actionKey:'result',completedResult,runtime:{receipts,storage,
      recoverOriginal:async()=>{throw Error('REPLAY_PROVIDER_RECOVERY_FORBIDDEN');}}});
    const checkpoint=await manager.store.getEpisode(diagnosticId),result=checkpoint.metadata.stage_results.result.result;
    if(after&&result.qa.ok&&(stage==='IMAGE'||['PASS','PASS_WITH_WARNING'].includes(provenance.temporal_qa?.status))){
      continuation=await orchestrator.handleStageResult({episodeId:diagnosticId,action:next,id:id+':qa',
        result:{episode_id:diagnosticId,stage_id:next.stage,status:'SUCCEEDED',artifacts:[],provider_job_ids:[],claims:[],
          qa:{ok:true,status:'PASS',evidence:stage==='IMAGE'?provenance.source_qa:provenance.temporal_qa},human_review_requirement:false}});
    }
    if(stage==='TTS'){
      const row=await this.row(user,episodeId),e=row.state.episodes[episodeId],a=result.artifacts[0],requestId='transport_'+a.sha256;
      e.artifacts||={};e.review_requests||={};e.artifacts[a.artifact_id]=a;
      e.review_requests[requestId]??={review_request_id:requestId,episode_id:episodeId,stage_id:'TTS',artifact_id:a.artifact_id,
        artifact_sha:a.sha256,review_version:1,status:'TRANSPORT_ONLY',transport_only:true,allowed_actions:[]};
      await this.store.cas(user,row.revision,row.state);
    }
    return {status:result.qa.ok&&(!after||continuation.first_pending_action==='after_qa')?'PASS':'BLOCKED',stage,artifact:result.artifacts[0],qa:result.qa,provenance,continuation,
      diagnostic_episode:diagnosticId,new_canonical_objects:imported?1:0,duplicate_artifacts:0,provider_calls:0,publication_calls:0};
  }
  async dryRun({user,message_id,crashMatrix=false,verifyTtsPreflight=false}){
    const row=await this.store.get(user);if(!row||Number(row.state.message_id)!==Number(message_id))throw Error('CANONICAL_DRY_OWNER_REQUIRED');
    const ttsRuntime=verifyTtsPreflight?{...this.ttsRuntime,receipts:new ReviewStageReceiptStore({store:this.store,user})}:null;
    const result=await runRealExecutorDryGate({message_id:row.state.message_id,crashMatrix,ttsRuntime});
    if(verifyTtsPreflight){
      const fixture=JSON.parse(await readFile(new URL('../../qa/LUMI_GENERIC_LISTEN_FIXTURE_V1.json',import.meta.url)));
      try{
        const r=await executeLumiTtsStage({episode_id:fixture.episode.id,stage_id:'TTS',narration_unit_id:'preflight',
          text:fixture.scenes[0].audio.utterances[0].text,voice_profile_id:'LUMI_VOICE_PROFILE_V3',dry_run:true,require_preflight:true,
          output_artifact_target:{bucket:'generated-audio',prefix:'lumi-readiness-probe'},
          budget_context:{quota_reserve_characters:1000}},ttsRuntime??{});
        result.strict_tts_preflight={status:r.status,ELEVENLABS_AUTH:r.ELEVENLABS_AUTH,MODEL_VALIDATION:r.quote.MODEL_VALIDATION,
          VOICE_VALIDATION:r.quote.FERNANDA_CALLABLE,QUOTA_OBSERVABILITY:r.quote.QUOTA_OBSERVABILITY,quota:r.quote.quota,
          TTS_COST_PREFLIGHT:r.TTS_COST_PREFLIGHT,TTS_BUDGET_PREFLIGHT:r.TTS_BUDGET_PREFLIGHT,
          ESTIMATED_PROVIDER_CREDITS:r.quote.units,storage_gate:r.storage_gate.status,emission_journal:r.emission_journal,
          budget:r.budget,budget_scope:'FICTITIOUS_DIAGNOSTIC_ONLY_NOT_PRODUCTION_AUTHORIZATION',TTS_PROVIDER_JOBS_CREATED:0};
      }catch(error){result.status='BLOCKED';result.blockers.push('ELEVENLABS_PREFLIGHT_FAILED');result.strict_tts_preflight={status:'BLOCKED',ELEVENLABS_AUTH:'UNVERIFIED',
        TTS_COST_PREFLIGHT:'NOT_COMPLETED',TTS_BUDGET_PREFLIGHT:'NOT_COMPLETED',TTS_PROVIDER_JOBS_CREATED:0,
        credential_status:this.ttsRuntime?.credential_status??{},NO_CLI_RUNTIME_DEPENDENCY:'PASS',
        reason:'AUTHENTICATED_EXECUTOR_PREFLIGHT_FAILED'};}
      result.tts_recovery=await runElevenLabsTtsRecoveryMatrix();
      if(result.strict_tts_preflight.status!=='DRY_PROVIDER_BOUNDARY'||result.tts_recovery.status!=='PASS'){result.status='BLOCKED';result.blockers.push('TTS_DRY_OR_RECOVERY_FAILED');}
    }
    return result;
  }
  async create({user,chat,request,requested_profile,activation,readiness,authenticatedCommand}){
    const row=await this.store.get(user);if(!row)throw Error('review_owner_required');
    if(requested_profile==='LUMI_PRODUCTION_PROFILE_V2'){
      const adapter=this.adapters[requested_profile];
      if(!adapter?.authorizeCreate)throw Error('CONTROLLED_ACTIVATION_REQUIRED');
      const execution_context=await adapter.authorizeCreate({user,chat,request,command:authenticatedCommand});
      return adapter.create({user,request,execution_context});
    }
    const episodeId=request?.episodePlan?.episode?.id;
    const route=selectLumiCreationProfile({requested:requested_profile,activation,readiness,existingEpisode:!!row.state.episodes[episodeId]});
    if(route.profile==='legacy')return {status:'LEGACY_ROUTE_UNCHANGED',provider_calls:0};
    const adapter=this.adapters[route.profile];if(!adapter?.create)throw Error('GENERIC_WORKER_BINDINGS_REQUIRED');
    return adapter.create({user,request,authorizedCeilingUsd:activation?.authorized_ceiling_usd||0});
  }
  canResume(e){return !!this.adapters[e.pipeline]?.resume && !e.master && !e.cancelled && e.production_authorization && e.budget_approved===true && !e.provider_repair_required && !e.budget_change && reviewGate(e)==='READY_TO_CONTINUE';}
  async validateReview(args){
    const row=await this.row(args.user,args.episodeId),adapter=this.adapters[row.state.episodes[args.episodeId].pipeline];
    if(isGenericV2Runtime(adapter))return adapter.validateReview(args);
  }
  async reviewed({user,episodeId,requestId}){
    const row=await this.row(user,episodeId),e=row.state.episodes[episodeId],adapter=this.adapters[e.pipeline];
    if(!adapter?.handleReview)throw Error('GENERIC_REVIEW_RECOVERY_BINDING_REQUIRED');
    const result=await adapter.handleReview({user,episodeId,requestId});
    // Reconciliation advances the checkpoint, but review itself does not grant a paid dispatch.
    return result;
  }
  async completed({user,episodeId,shotId,artifact,technicalQa,creativeQa,master=false}){
    validateArtifact(artifact);const row=await this.row(user,episodeId),e=row.state.episodes[episodeId];
    if(master)e.master=artifact;
    else {const shot=e.shots.find(x=>x.shot_id===shotId);if(!shot)throw Error('review_shot_not_found');Object.assign(shot,{artifact,technical_qa:technicalQa,creative_qa:creativeQa});}
    e.current_stage=master?'FINAL_HUMAN_REVIEW':reviewGate(e);row.state.recovery_state=reviewGate(e);
    e.resume_available=!!this.canResume(e);
    await this.store.cas(user,row.revision,row.state);
    if(!master&&e.review_mode==='AUTO_WITH_EXCEPTIONS'&&e.resume_available)return this.resume({user,episodeId});
    return {status:row.state.recovery_state,provider_calls:0};
  }
  async resume({user,episodeId,expectedAction}){
    let row=await this.row(user,episodeId),e=row.state.episodes[episodeId];
    if(['EMITTING','UNKNOWN','FAILED'].includes(row.state.delivery?.status))throw Error('telegram_delivery_recovery_required');
    if(!this.canResume(e))throw Error('canonical_resume_gate_closed');
    const adapter=this.adapters[e.pipeline];
    if(isGenericV2Runtime(adapter)){
      // The real orchestrator's CAS stage receipt is the sole execution claim.
      // A second PENDING command here would make safe checkpoint recovery stick.
      return adapter.resume({user,episodeId,expectedAction});
    }
    const key=sha256(JSON.stringify([user,episodeId,e.production_authorization,e.next_action,e.shots.map(x=>x.artifact?.sha256)]));
    row.state.production_commands||={};
    if(row.state.production_commands[key])return {status:row.state.production_commands[key].status,already_applied:true,provider_calls:0};
    row.state.production_commands[key]={status:'PENDING',episode_id:episodeId,created_at:new Date().toISOString()};
    // Atomic claim precedes dispatch. A lost response requires canonical journal
    // reconciliation; neither restarts nor double taps repeat the paid action.
    await this.store.cas(user,row.revision,row.state);
    let result;
    try{result=await this.adapters[e.pipeline].resume({episodeId,idempotencyKey:key,authorization:e.production_authorization,nextAction:e.next_action});}
    catch{throw Error('canonical_resume_reconciliation_required');}
    row=await this.row(user,episodeId);
    row.state.production_commands[key]={...row.state.production_commands[key],status:'APPLIED',result};
    await this.store.cas(user,row.revision,row.state);return result;
  }
  async cancel({user,episodeId}){
    const row=await this.row(user,episodeId),e=row.state.episodes[episodeId];
    e.cancelled=true;e.resume_available=false;row.state.recovery_state='CANCELLED';
    await this.store.cas(user,row.revision,row.state);
    // Canonical cancel is idempotent and never authorizes provider calls.
    if(this.adapters[e.pipeline]?.cancel)await this.adapters[e.pipeline].cancel({episodeId});
    return {status:'CANCELLED',provider_calls:0};
  }
}
