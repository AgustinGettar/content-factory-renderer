import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {GenericLumiV2Adapter} from './lumi-generic-v2-adapter.js';
import {LumiV2ExecutionOrchestrator,ReviewStageReceiptStore} from './lumi-v2-execution-orchestrator.js';
import {ControlledV2Authorization,inputDigest} from './lumi-v2-activation-context.js';
import {reconcileStageReview} from './lumi-stage-result-v2.js';
import {PROFILE_SHA,LUMI_PRODUCTION_PROFILE_V2 as profile} from './lumi-production-profile-v2.js';
import {journaledFetch} from './provider-emission-journal-v1.js';
import {sha256} from './telegram-review-v1/core.js';
import {createTtsStorageProbe,inspectLumiAudio} from './lumi-tts-stage-v2.js';
const realRuntimes=new WeakSet();
export const isGenericV2Runtime=adapter=>realRuntimes.has(adapter);

// The existing adapter delegates to the existing orchestrator. This is dependency
// composition, not a worker registry or another Telegram router.
export function createGenericV2Runtime({manager,reviewStore,artifactStorage,journal,validateOwner,
  mediaTransport,ttsRuntime,env={},fetchImpl=fetch,inject=async()=>{}}) {
  if(!manager?.store?.casGenericEpisode||!reviewStore?.cas||!artifactStorage?.download||!journal?.get||!validateOwner)
    throw Error('GENERIC_RUNTIME_DEPENDENCIES_REQUIRED');
  const authority=new ControlledV2Authorization({store:reviewStore,validateOwner});
  const projectCheckpoint=async(user,episodeId)=>{
    const state=await manager.store.getEpisode(episodeId),row=await reviewStore.get(user),e=row?.state.episodes[episodeId];
    if(!e||state.metadata.user!==user)throw Error('REVIEW_EPISODE_REQUIRED');
    const projection={next_action:state.first_pending_action,first_pending_action:state.first_pending_action,
      last_completed_action:state.last_completed_action,current_stage:state.actions.find(a=>a.key===state.first_pending_action)?.stage||'HUMAN_REVIEW',
      resume_available:state.status==='RUNNING'&&!state.metadata.repair_plan_required};
    if(Object.entries(projection).some(([k,v])=>e[k]!==v)){Object.assign(e,projection);await reviewStore.cas(user,row.revision,row.state);}
  };
  const forUser=(user,dry_run)=>{
    const receipts=new ReviewStageReceiptStore({store:reviewStore,user}),directories=[];
    const bindInput=async({materialized,state,action,prepared,shot})=>{
      const m={...materialized.materialized_stage_input};
      const attempt=sha256(state.episode_id+':'+prepared.binding_sha+':'+action.key);
      // Transport is regenerated only at execution, from verified durable identity.
      const transport=async a=>{
        if(dry_run)return 'urn:lumi:sha256:'+a.sha256;
        const t=await mediaTransport(a);if(t?.sha256!==a.sha256||!/^https:\/\//.test(t.url))throw Error('ARTIFACT_TRANSPORT_REQUIRED');return t.url;
      };
      if(['IMAGE','VIDEO'].includes(action.stage)){
        if(!dry_run&&(!m.quote?.expires_at||!Number.isFinite(Date.parse(m.quote.expires_at))||Date.parse(m.quote.expires_at)<=Date.now()
          ||m.quote.episode_id!==state.episode_id||m.quote.action_key!==action.key))throw Error('CURRENT_USD_QUOTE_REQUIRED');
        m.apiKey=env.HF_API_KEY;
        m.submit=journaledFetch({store:journal,context:{episode_id:state.episode_id,scene_id:action.scene_id,
          stage:action.stage,attempt_id:attempt,provider:'higgsfield_api',model:action.stage==='IMAGE'?profile.image.model:profile.video.endpoint,
          expected_cost_usd:m.quote?.usd},fetchImpl});
        if(action.stage==='IMAGE')m.anchor_url=await transport(m.canonical_artifact);
        else m.source_url=await transport(m.source.artifact);
      }
      if(action.stage==='TTS')m.tts_runtime={...ttsRuntime,storage:artifactStorage,receipts};
      if(['DIRECTOR','TEMPORAL_QA','TTS_STORAGE','ASSEMBLY','MASTER'].includes(action.stage)){
        const dir=await mkdtemp(join(tmpdir(),'lumi-runtime-input-'));directories.push(dir);
        const local={};
        for(const a of materialized.artifact_references){
          const ext={'image/png':'png','image/jpeg':'jpg','video/mp4':'mp4','audio/mpeg':'mp3'}[a.mime];
          const path=join(dir,a.sha256+'.'+ext);await writeFile(path,materialized.artifact_bytes[a.artifact_id]);local[a.artifact_id]=path;
        }
        const verification=a=>({filePath:local[a.artifact_id],expectedSha256:a.sha256});
        if(action.stage==='DIRECTOR'){
          // compileGenericV2Direction reads this isolated copy; the persisted plan
          // and canonical identity remain immutable.
          shot.director_input.media=materialized.artifact_references.map(a=>({artifact_id:a.artifact_id,sha256:a.sha256,
            canonical_path:a.path,path:local[a.artifact_id],role:a.artifact_id===m.source.artifact.artifact_id?'source':'qa'}));
          m.director_options={outputDirectory:join(dir,'director'),topologyReview:m.topology_review};
        }
        if(action.stage==='TEMPORAL_QA')m.video_verification=verification(m.video_artifact);
        if(action.stage==='MASTER')m.master_verification=verification(m.master_artifact);
        if(action.stage==='MASTER')m.review_episode={master:m.master_artifact};
        if(action.stage==='TTS_STORAGE'){
          m.audio_verification=verification(m.audio_artifact);
          m.storage_probe={storage:artifactStorage,bucket:m.audio_artifact.bucket,prefix:`lumi-v2/${state.episode_id}/probe`,
            probeBytes:await createTtsStorageProbe(),decodeAudio:async bytes=>(await inspectLumiAudio(bytes,sha256(bytes),{storageProbe:true})).ok};
        }
        if(action.stage==='ASSEMBLY'){
          m.segments=m.segments.map(s=>({...s,videoPath:local[s.video_artifact.artifact_id],audioPath:local[s.audio_artifact.artifact_id]}));
          m.output_path=join(dir,'master.mp4');
        }
      }
      return m;
    };
    return {orchestrator:new LumiV2ExecutionOrchestrator({manager,receipts,artifactStorage,reviewStore,journal,
      controlled:true,dry_run,bindInput,inject}),dispose:async()=>{for(const d of directories)await rm(d,{recursive:true,force:true});}};
  };
  const validateReview=async({user,episodeId,requestId,decision,artifactSha,reviewVersion})=>{
    const row=await reviewStore.get(user),e=row?.state.episodes[episodeId],r=e?.review_requests?.[requestId];
    if(!row||!await validateOwner(user,row.state.chat_id)||row.state.user_id!==user)throw Error('UNAUTHORIZED_REVIEWER');
    const state=await manager.store.getEpisode(episodeId),b=state?.metadata.review_requests?.[requestId];
    if(state?.status==='CANCELLED')throw Error('STALE_CHECKPOINT');
    if(!r||!b||state.metadata.user!==user||r.episode_id!==episodeId||r.artifact_sha!==artifactSha||b.artifact_sha!==artifactSha
      ||r.artifact_id!==b.artifact_id||r.review_version!==reviewVersion||b.review_version!==reviewVersion
      ||r.action_key!==b.action_key||r.stage_id!==b.stage_id)throw Error('STALE_GENERIC_REVIEW');
    if(!['APPROVED','REJECTED'].includes(decision)||!['PENDING',decision].includes(r.status)
      ||!['PENDING',decision].includes(b.status))throw Error('REVIEW_DECISION_IMMUTABLE');
    if(!b.continuation_applied&&state.first_pending_action!==b.action_key)throw Error('STALE_CHECKPOINT');
    const a=state.metadata.artifacts?.[b.artifact_id];
    if(!a||a.sha256!==artifactSha||e.artifacts?.[b.artifact_id]?.sha256!==artifactSha)throw Error('ARTIFACT_INTEGRITY_FAILURE');
    const bytes=await artifactStorage.download(a.bucket,a.path);if(!bytes)throw Error('ARTIFACT_MISSING');
    if(bytes.length!==a.size||sha256(bytes)!==artifactSha)throw Error('ARTIFACT_INTEGRITY_FAILURE');
    return {status:'VALIDATED'};
  };
  const runtime={
    async create({user,request,execution_context}){
      const o=forUser(user,execution_context?.dry_run);
      try{
        const result=await o.orchestrator.create({user,request,execution_context,authorizedCeilingUsd:execution_context?.authorized_ceiling_usd});
        const state=await manager.store.getEpisode(result.episode_id),row=await reviewStore.get(user),prior=row.state.episodes[result.episode_id];
        if(prior&&(prior.binding_sha!==state.metadata.generic_v2.binding_sha||prior.pipeline!==profile.id))throw Error('EXISTING_EPISODE_ROUTING_IMMUTABLE');
        if(!prior){row.state.episodes[result.episode_id]={episode_id:result.episode_id,title:state.metadata.generic_v2.plan.episode.title,
          pipeline:profile.id,profile_sha:PROFILE_SHA,binding_sha:state.metadata.generic_v2.binding_sha,review_mode:'SUPERVISED',
          shots:state.metadata.generic_v2.shot_plans.map(s=>({shot_id:s.shot_id})),artifacts:{},review_requests:{},reviews:{},
          budget_approved:true,production_authorization:{authorization_id:execution_context.authorization_id},
          next_action:state.first_pending_action,resume_available:true,current_stage:'PLANNING'};
          await reviewStore.cas(user,row.revision,row.state);}
        return result;
      }finally{await o.dispose();}
    },
    async resume({user,episodeId,expectedAction}){
      const state=await manager.store.getEpisode(episodeId),a=state?.metadata.activation_context;
      if(!a||a.user!==user)throw Error('CONTROLLED_ACTIVATION_REQUIRED');
      const context=await authority.authorize({user,chat:a.chat,episodeId,operationId:a.operation_id,
        authorizationId:a.authorization_id,requestSha:a.request_sha,scope:'RESUME'});
      if(expectedAction&&expectedAction!==state.first_pending_action){
        const old=state.actions.find(x=>x.key===expectedAction);
        if(old?.status!=='COMPLETE')throw Error('STALE_CHECKPOINT');
        await projectCheckpoint(user,episodeId);
        return {status:'STAGE_COMPLETE',completed_action:old.key,first_pending_action:state.first_pending_action,already_applied:true,provider_calls:0};
      }
      const o=forUser(user,context.dry_run);
      try{const result=await o.orchestrator.resume({user,episodeId,execution_context:context});await projectCheckpoint(user,episodeId);return result;}
      finally{await o.dispose();}
    },
    async handleReview({user,episodeId,requestId}){
      const r=(await reviewStore.get(user))?.state.episodes[episodeId]?.review_requests?.[requestId];
      await validateReview({user,episodeId,requestId,decision:r?.status,artifactSha:r?.artifact_sha,reviewVersion:r?.review_version});
      await inject({point:'REVIEW_AFTER_PERSISTENCE'});
      const result=await reconcileStageReview({manager,reviewStore,user,episodeId,requestId,artifactStorage,strict:true,inject});
      await projectCheckpoint(user,episodeId);
      if(result.status==='READY_TO_CONTINUE'){
        // No continueAction callback is supplied: approval permits Recovery
        // Manager reconciliation, never a new paid submission.
        const recovery=await manager.resume(episodeId);
        return {...result,recovery_manager_status:recovery.status};
      }
      return result;
    }
  };
  const adapter=new GenericLumiV2Adapter({manager,reviewStore,runtime});
  adapter.authorizeCreate=({user,chat,request,command})=>authority.authorize({user,chat,episodeId:request?.episodePlan?.episode?.id,
    operationId:command?.operation_id,authorizationId:command?.authorization_id,scope:'CREATE',requestSha:inputDigest(request),command});
  adapter.validateReview=validateReview;
  // This identifies the concrete composition; acceptance is proven by the
  // integration tests, never inferred from three method names.
  adapter.runtimeBinding='GENERIC_V2_REAL_INPUT_RUNTIME_V1';
  realRuntimes.add(adapter);
  return adapter;
}
