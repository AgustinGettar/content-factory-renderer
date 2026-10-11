import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {GenericLumiV2Adapter} from './lumi-generic-v2-adapter.js';
import {LumiV2ExecutionOrchestrator,ReviewStageReceiptStore} from './lumi-v2-execution-orchestrator.js';
import {ControlledV2Authorization,inputDigest,assertV2Context,verifyFirstImageEvidence,FIRST_IMAGE_SCOPE,FIRST_IMAGE_EPISODE,FIRST_IMAGE_OPERATION,diagnosticOperationId,DIAGNOSTIC_Q41_KEY,DIAGNOSTIC_Q41_SCOPE} from './lumi-v2-activation-context.js';
import {isolatedQ41Input} from './lumi-isolated-usd-preflight.js';
import {firstImagePrepaidGate} from './higgsfield-usd-budget-v1.js';
import {submitSeriesProviderRequest,recoverSeriesProviderResult} from './lumi-series-v2-execution.js';
import {materializeStageArtifact,inspectMaterializedArtifact} from './lumi-artifact-materialization-v2.js';
import {sourceGate} from './lumi-series-v2-gates.js';
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
  const firstImageInput=async user=>{
    if(env.LUMI_RUNTIME_ENV!=='staging')throw Error('Q41_STAGING_ONLY');
    if(!env.HF_API_KEY)throw Error('Q41_HF_API_KEY_MISSING');
    const row=await reviewStore.get(user),d=isolatedQ41Input();
    if(row?.state.message_id!==138||!await validateOwner(user,row.state.chat_id))throw Error('Q41_OWNER_REQUIRED');
    if(row.state.episodes[FIRST_IMAGE_EPISODE]||await manager.store.getEpisode(FIRST_IMAGE_EPISODE))throw Error('Q41_EPISODE_ALREADY_EXISTS');
    const evidence=verifyFirstImageEvidence(row.state.q41_prepaid_evidence,env.LUMI_TELEGRAM_CALLBACK_SECRET);
    if(evidence.user_id!==user||evidence.episode_id!==FIRST_IMAGE_EPISODE||evidence.shot_id!=='q41'
      ||evidence.descriptor_sha256!==d.descriptor_sha256)throw Error('Q41_EVIDENCE_SCOPE_INVALID');
    const u=new URL(evidence.source_url),expected='/storage/v1/object/sign/'+d.canonical_artifact.bucket+'/'+d.canonical_artifact.path;
    if(u.protocol!=='https:'||u.origin!==new URL(env.SUPABASE_URL).origin||u.pathname!==expected
      ||!u.searchParams.get('token')||u.username||u.password||u.hash)throw Error('Q41_SIGNED_SOURCE_REQUIRED');
    const input={...d.input,image_urls:[u.href]},payloadSha=sha256(JSON.stringify(input));
    const diagnostic=await manager.store.getEpisode(diagnosticOperationId(user,DIAGNOSTIC_Q41_KEY,DIAGNOSTIC_Q41_SCOPE));
    const quote=diagnostic?.metadata?.isolated_validation?.q41_quote_attempt?.result;
    if(quote?.episode_id!==FIRST_IMAGE_EPISODE||quote.shot_id!=='q41'||quote.model!==d.model
      ||quote.canonical_source_verified!==true||quote.canonical_source_sha256!==d.canonical_artifact.sha256
      ||quote.descriptor_sha256!==d.descriptor_sha256||quote.prompt_sha256!==d.prompt_sha256)
      throw Error('Q41_SOURCE_BOUND_QUOTE_REQUIRED');
    const budget=firstImagePrepaidGate({evidence,apiKeySha:sha256(env.HF_API_KEY),quote,payloadSha});
    const binding=inputDigest({scope:FIRST_IMAGE_SCOPE,descriptor:d,payloadSha,evidence,quote,budget});
    const expiresAt=new Date(Math.min(Date.parse(evidence.expires_at),Date.parse(evidence.payload_expires_at),Date.parse(quote.quote_timestamp)+60000,
      quote.quote_expiration?Date.parse(quote.quote_expiration):Infinity)).toISOString();
    return {d,input,evidence,quote,budget,binding,expiresAt};
  };
  const projectFirstImage=async(user,patch)=>{
    const row=await reviewStore.get(user);
    row.state.q41_first_image={...row.state.q41_first_image,...patch};
    await reviewStore.cas(user,row.revision,row.state);
  };
  const firstImageStatus=async({user})=>{
    const cp=await manager.store.getEpisode(FIRST_IMAGE_OPERATION);
    if(cp){
      if(cp.metadata.user!==user||cp.metadata.operation_type!==FIRST_IMAGE_SCOPE)throw Error('Q41_OPERATION_OWNER_MISMATCH');
      const f=cp.metadata.first_image;
      const view={status:f.state,artifact:f.artifact||null,technical_qa:f.technical_qa||null,visual_qa:f.visual_qa||'PENDING',
        review:f.review||null,review_version:1,blocker:f.blocker||null,binding:f.binding,reserve_usd:f.reserve_usd};
      await projectFirstImage(user,view);return view;
    }
    try{
      const p=await firstImageInput(user);
      const view={status:'AWAITING_CONFIRMATION',binding:p.binding,expires_at:p.expiresAt,
        estimate_usd:p.budget.estimate_usd,reserve_usd:p.budget.reserve_usd,blocker:null};
      await projectFirstImage(user,view);return view;
    }catch(error){
      const blocker=/^Q41_[A-Z_]+$/.test(error.message)?error.message:'Q41_PREPARATION_UNVERIFIED';
      const view={status:'BLOCKED',blocker,estimate_usd:0.271,reserve_usd:null};
      await projectFirstImage(user,view);return view;
    }
  };
  const recoverFirstImage=async({user})=>{
    let cp=await manager.store.getEpisode(FIRST_IMAGE_OPERATION);
    if(!cp||cp.metadata.user!==user||cp.metadata.operation_type!==FIRST_IMAGE_SCOPE)throw Error('Q41_OPERATION_OWNER_MISMATCH');
    let f=cp.metadata.first_image;
    if(f.artifact||f.review)return firstImageStatus({user});
    const j=await journal.get(FIRST_IMAGE_OPERATION);
    if(!f.accepted||j?.state!=='ACKNOWLEDGED'||j.provider_request_id!==f.accepted.request_id){
      await manager.checkpoint(FIRST_IMAGE_OPERATION,s=>{s.metadata.first_image.blocker='Q41_EMISSION_OUTCOME_UNKNOWN_NO_RESUBMIT';});
      return firstImageStatus({user});
    }
    try{
      const result=await materializeStageArtifact({episode_id:FIRST_IMAGE_EPISODE,stage_id:'IMAGE',action_key:'image:q41',
        provider_job_id:f.accepted.request_id,result_id:'original',review_required:true,
        target:{bucket:isolatedQ41Input().canonical_artifact.bucket,prefix:'lumi-series-v2/'+FIRST_IMAGE_EPISODE+'/q41'}},
      {receipts:new ReviewStageReceiptStore({store:reviewStore,user}),storage:artifactStorage,
        recoverOriginal:ids=>recoverSeriesProviderResult({...ids,accepted:f.accepted,stage:'IMAGE',apiKey:env.HF_API_KEY,
          fetchImpl:async(url,options={})=>{if(options.method&&options.method!=='GET')throw Error('Q41_RECOVERY_GET_ONLY');return fetchImpl(url,{...options,redirect:'error'});}}),
        inspect:async(bytes,stage,sha)=>{
          const qa=await inspectMaterializedArtifact(bytes,stage,sha);
          // 2K portrait original; no resize or repair is used to obtain a pass.
          if(qa.ok&&(qa.height<2000||qa.width<1100||Math.abs(qa.width/qa.height-9/16)>0.01))
            return {...qa,ok:false,status:'FAIL',error_class:'Q41_IMAGE_RESOLUTION_INVALID'};
          return qa;
        },inject:point=>inject({point:'Q41:'+point})});
      const a=result.artifacts[0],row=await reviewStore.get(user),qa=row.state.q41_visual_qa?.[a.sha256];
      let visual='REQUIRES_HUMAN_VISUAL_REVIEW';
      try{sourceGate(a,{content_hash:a.sha256,result:{visual_qa:qa}});visual='PASS';}catch{/* Never invent visual evidence. */}
      await manager.checkpoint(FIRST_IMAGE_OPERATION,s=>{
        Object.assign(s.metadata.first_image,{state:'HUMAN_REVIEW_REQUIRED',artifact:a,technical_qa:result.qa,
          visual_qa:visual,blocker:result.qa.ok?null:'Q41_IMAGE_TECHNICAL_QA_FAILED'});
        s.actions[0].artifact=a;s.actions[0].provider_request_id=f.accepted.request_id;
        s.actions[0].status='WAITING_HUMAN_REVIEW';s.actions[0].dispatch_state='ACKNOWLEDGED';
      });
    }catch(error){
      const blocker=error.message==='PROVIDER_RESULT_NOT_COMPLETE'?'Q41_ORIGINAL_RESULT_PENDING':
        /HASH|READBACK/.test(error.message)?'Q41_ARTIFACT_SHA_MISMATCH':'Q41_ORIGINAL_RESULT_RECOVERY_REQUIRED';
      await manager.checkpoint(FIRST_IMAGE_OPERATION,s=>{s.metadata.first_image.blocker=blocker;});
    }
    return firstImageStatus({user});
  };
  const confirmFirstImage=async({command})=>{
    await authority.firstImageCommand(command,['q41_confirm']);
    // This identity is constant across users, callbacks, deployments and nonces.
    const existing=await manager.store.getEpisode(FIRST_IMAGE_OPERATION);
    if(existing)return firstImageStatus({user:command.user});
    const p=await firstImageInput(command.user);
    const bytes=await artifactStorage.download(p.d.canonical_artifact.bucket,p.d.canonical_artifact.path);
    if(!bytes||bytes.length!==p.d.canonical_artifact.size||sha256(bytes)!==p.d.canonical_artifact.sha256)throw Error('Q41_CANONICAL_SHA_REQUIRED');
    const context=await authority.authorizeFirstImage({command,binding:p.binding,ceilingUsd:p.budget.reserve_usd,expiresAt:p.expiresAt});
    assertV2Context(context,{episodeId:FIRST_IMAGE_EPISODE,user:command.user,scope:FIRST_IMAGE_SCOPE,dry_run:false});
    await manager.startEpisode({episodeId:FIRST_IMAGE_OPERATION,actions:[{key:'image:q41',stage:'IMAGE',scene_id:'q41'}],authorizedCeilingUsd:5,
      metadata:{operation_type:FIRST_IMAGE_SCOPE,runtime_revision:0,user:command.user,target_episode:FIRST_IMAGE_EPISODE,
        first_image:{state:'PREPARED',binding:p.binding,payload_sha256:sha256(JSON.stringify(p.input)),reserve_usd:p.budget.reserve_usd,
          estimated_cost_usd:p.budget.estimate_usd,authorization:context,accepted:null}}});
    await manager.reserveFirstImage({episodeId:FIRST_IMAGE_OPERATION,actionKey:'image:q41',amountUsd:p.budget.reserve_usd,binding:p.binding});
    await inject({point:'Q41_RESERVED_BEFORE_JOURNAL'});
    try{
      // The journal FK binds the durable source operation. Its immutable
      // checkpoint metadata binds the target episode without creating EP004.
      const submit=journaledFetch({store:journal,context:{episode_id:FIRST_IMAGE_OPERATION,scene_id:'q41',stage:'IMAGE',
        attempt_id:FIRST_IMAGE_OPERATION,provider:'higgsfield_api',model:p.d.model,expected_cost_usd:p.budget.estimate_usd},
        fetchImpl:async(url,options)=>{
          // Re-read sealed evidence and quote at the final boundary, after CAS.
          const current=await firstImageInput(command.user);
          if(current.binding!==p.binding||url!=='https://api.higgsfield.ai/marketing-studio/image'
            ||options.method!=='POST'||sha256(options.body)!==sha256(JSON.stringify(p.input)))throw Error('Q41_EMISSION_BINDING_CHANGED');
          assertV2Context(context,{episodeId:FIRST_IMAGE_EPISODE,user:command.user,scope:FIRST_IMAGE_SCOPE,dry_run:false});
          return fetchImpl(url,{...options,redirect:'error'});
        },persistResponse:async accepted=>{
          if(!/^[A-Za-z0-9_-]{1,120}$/.test(accepted.request_id||''))throw Error('Q41_PROVIDER_HANDLE_INVALID');
          const u=new URL(accepted.status_url);
          if(u.origin!=='https://api.higgsfield.ai'||u.username||u.password||u.hash)throw Error('Q41_PROVIDER_HANDLE_INVALID');
          await manager.checkpoint(FIRST_IMAGE_OPERATION,s=>{s.metadata.first_image.accepted={request_id:accepted.request_id,status_url:u.href};s.metadata.first_image.state='ACCEPTED';});
        }});
      await submitSeriesProviderRequest({model:p.d.model,input:p.input,apiKey:env.HF_API_KEY,attemptId:FIRST_IMAGE_OPERATION,submit});
    }catch{
      await manager.checkpoint(FIRST_IMAGE_OPERATION,s=>{s.metadata.first_image.blocker='Q41_EMISSION_OUTCOME_UNKNOWN_NO_RESUBMIT';});
      return firstImageStatus({user:command.user});
    }
    return recoverFirstImage({user:command.user});
  };
  const reviewFirstImage=async({command})=>{
    const {token}=await authority.firstImageCommand(command,['q41_approve','q41_reject']);
    const cp=await manager.store.getEpisode(FIRST_IMAGE_OPERATION),f=cp?.metadata.first_image;
    if(cp?.metadata.user!==command.user||!f?.artifact||token.artifact_sha!==f.artifact.sha256||token.review_version!==1)
      throw Error('Q41_REVIEW_STALE');
    const status=token.action==='q41_approve'?'APPROVED':'REJECTED';
    if(f.review){if(f.review.status!==status)throw Error('Q41_REVIEW_IMMUTABLE');return firstImageStatus({user:command.user});}
    if(status==='APPROVED'&&!f.technical_qa?.ok)throw Error('Q41_IMAGE_TECHNICAL_QA_FAILED');
    const bytes=await artifactStorage.download(f.artifact.bucket,f.artifact.path);
    if(!bytes||bytes.length!==f.artifact.size||sha256(bytes)!==f.artifact.sha256)throw Error('Q41_ARTIFACT_SHA_MISMATCH');
    await manager.checkpoint(FIRST_IMAGE_OPERATION,s=>{
      if(s.metadata.first_image.review)throw Error('Q41_REVIEW_IMMUTABLE');
      s.metadata.first_image.review={status,artifact_sha:f.artifact.sha256,review_version:1,user:command.user,
        callback_query_id:command.callback_id,visual_checklist:'IDENTITY_TWO_WINGS_WAND_PREMIUM_3D_COW_SHEEP_HEN',timestamp:new Date().toISOString()};
      s.metadata.first_image.state=status+'_PAUSED';s.metadata.first_image.blocker=null;
    });
    return firstImageStatus({user:command.user});
  };
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
    if(state?.metadata.activation_context?.diagnostic){
      const a=state.metadata.activation_context;
      await authority.authorize({user,chat:null,episodeId,operationId:a.operation_id,
        authorizationId:a.authorization_id,requestSha:a.request_sha,scope:'REVIEW'});
    }
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
    async pendingReview({user,episodeId}){
      // Read-only status for a duplicate RESUME. Never enter an executor or
      // reinterpret a pending request as a human decision.
      const state=await manager.store.getEpisode(episodeId),a=state?.metadata.activation_context;
      if(!a||a.user!==user)throw Error('CONTROLLED_ACTIVATION_REQUIRED');
      await authority.authorize({user,chat:a.chat,episodeId,operationId:a.operation_id,
        authorizationId:a.authorization_id,requestSha:a.request_sha,scope:'RESUME'});
      if(state.status==='CANCELLED')throw Error('canonical_resume_gate_closed');
      const row=await reviewStore.get(user),e=row?.state.episodes[episodeId];
      const requests=Object.values(state.metadata.review_requests||{}).filter(r=>
        r.action_key===state.first_pending_action&&r.status==='PENDING');
      if(requests.length!==1)throw Error('STALE_GENERIC_REVIEW');
      const r=requests[0],projected=e?.review_requests?.[r.review_request_id];
      if(!projected||inputDigest(projected)!==inputDigest(r)||r.episode_id!==episodeId
        ||state.metadata.artifacts?.[r.artifact_id]?.sha256!==r.artifact_sha
        ||e.artifacts?.[r.artifact_id]?.sha256!==r.artifact_sha)throw Error('STALE_GENERIC_REVIEW');
      return {status:'HUMAN_REVIEW_REQUIRED',first_pending_action:state.first_pending_action,
        review_request:r,already_applied:true,provider_calls:0};
    },
    async create({user,request,execution_context}){
      const o=forUser(user,execution_context?.dry_run);
      try{
        const result=await o.orchestrator.create({user,request,execution_context,diagnostic:execution_context?.diagnostic===true,authorizedCeilingUsd:execution_context?.authorized_ceiling_usd});
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
      if(context.diagnostic&&!['PLANNING','SOURCE_PLANNING','SHOT_REVIEW'].includes(
        state.actions.find(x=>x.key===state.first_pending_action)?.stage))throw Error('DIAGNOSTIC_STAGE_FORBIDDEN');
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
  adapter.pendingReview=runtime.pendingReview;
  adapter.firstImageStatus=firstImageStatus;
  adapter.firstImageAction=async({command})=>{
    if(env.LUMI_RUNTIME_ENV!=='staging')throw Error('Q41_STAGING_ONLY');
    const {token}=await authority.firstImageCommand(command,['q41_confirm','q41_status','q41_approve','q41_reject']);
    if(token.action==='q41_confirm')return confirmFirstImage({command});
    if(token.action==='q41_status')return recoverFirstImage({user:command.user});
    return reviewFirstImage({command});
  };
  // This identifies the concrete composition; acceptance is proven by the
  // integration tests, never inferred from three method names.
  adapter.runtimeBinding='GENERIC_V2_REAL_INPUT_RUNTIME_V1';
  realRuntimes.add(adapter);
  return adapter;
}
