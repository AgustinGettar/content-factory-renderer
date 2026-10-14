import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {GenericLumiV2Adapter,ep004ProductionRequest} from './lumi-generic-v2-adapter.js';
import {LumiV2ExecutionOrchestrator,ReviewStageReceiptStore} from './lumi-v2-execution-orchestrator.js';
import {ControlledV2Authorization,inputDigest,assertV2Context,verifyFirstImageEvidence,verifySupervisedPolicy,FIRST_IMAGE_SCOPE,FIRST_IMAGE_EPISODE,FIRST_IMAGE_OPERATION} from './lumi-v2-activation-context.js';
import {isolatedQ41Input} from './lumi-isolated-usd-preflight.js';
import {firstImageAccountGate,firstImagePrepaidGate,supervisedRequestGate,SUPERVISED_BUDGET_POLICY,estimateHiggsfieldUsd,sumUsd} from './higgsfield-usd-budget-v1.js';
import {submitSeriesProviderRequest,recoverSeriesProviderResult} from './lumi-series-v2-execution.js';
import {materializeStageArtifact,inspectMaterializedArtifact} from './lumi-artifact-materialization-v2.js';
import {sourceGate} from './lumi-series-v2-gates.js';
import {sourceQaRecord,createV2InputMaterializer,checkpointIdentity} from './lumi-v2-input-materializer.js';
import {buildDirectedVideoPayload} from './lumi-v2-executor-bindings.js';
import {evaluateTopology} from './cinematic-director-v1/topology.js';
import {reconcileStageReview,validateStageResult} from './lumi-stage-result-v2.js';
import {assertEp004ImportCommand,EP004_IMPORT_OP} from './lumi-v2-activation-context.js';
import {PROFILE_SHA,LUMI_PRODUCTION_PROFILE_V2 as profile} from './lumi-production-profile-v2.js';
import {journaledFetch,confirmedInsufficientBalance} from './provider-emission-journal-v1.js';
import {sha256,validateArtifact} from './telegram-review-v1/core.js';
import {createTtsStorageProbe,inspectLumiAudio} from './lumi-tts-stage-v2.js';
const realRuntimes=new WeakSet();
export const isGenericV2Runtime=adapter=>realRuntimes.has(adapter);

// The existing adapter delegates to the existing orchestrator. This is dependency
// composition, not a worker registry or another Telegram router.
export function createGenericV2Runtime({manager,reviewStore,artifactStorage,journal,validateOwner,
  mediaTransport,ttsRuntime,readProviderBalance=null,env={},fetchImpl=fetch,inject=async()=>{}}) {
  if(!manager?.store?.casGenericEpisode||!reviewStore?.cas||!artifactStorage?.download||!journal?.get||!validateOwner)
    throw Error('GENERIC_RUNTIME_DEPENDENCIES_REQUIRED');
  const authority=new ControlledV2Authorization({store:reviewStore,validateOwner});
  const firstImageAccount=async user=>{
    if(env.LUMI_RUNTIME_ENV!=='staging')throw Error('Q41_STAGING_ONLY');
    if(!env.HF_API_KEY)throw Error('Q41_HF_API_KEY_MISSING');
    const row=await reviewStore.get(user),d=isolatedQ41Input();
    if((!Number.isSafeInteger(row?.state.message_id)||row.state.message_id<=0)||!await validateOwner(user,row.state.chat_id))throw Error('Q41_OWNER_REQUIRED');
    if(row.state.episodes[FIRST_IMAGE_EPISODE]||await manager.store.getEpisode(FIRST_IMAGE_EPISODE))throw Error('Q41_EPISODE_ALREADY_EXISTS');
    if(row.state.q41_supervised_policy){
      const policy=verifySupervisedPolicy(row.state.q41_supervised_policy,env.LUMI_TELEGRAM_CALLBACK_SECRET,
        {user,chat:row.state.chat_id,panelIds:[row.state.message_id,...Object.keys(row.state.panel_history||{}).map(Number)],apiKeySha:sha256(env.HF_API_KEY)});
      const budget={reserve_usd:policy.max_q41_reservation_usd,hard_episode_budget_usd:5,basis:SUPERVISED_BUDGET_POLICY};
      return {d,policy,budget,binding:inputDigest({scope:FIRST_IMAGE_SCOPE,descriptor:d,policy,budget}),
        expiresAt:policy.expires_at,grant:row.state.v2_authorizations?.[FIRST_IMAGE_OPERATION]};
    }
    const evidence=verifyFirstImageEvidence(row.state.q41_prepaid_evidence,env.LUMI_TELEGRAM_CALLBACK_SECRET);
    if(evidence.user_id!==user||evidence.episode_id!==FIRST_IMAGE_EPISODE||evidence.shot_id!=='q41'
      ||evidence.descriptor_sha256!==d.descriptor_sha256)throw Error('Q41_EVIDENCE_SCOPE_INVALID');
    const budget=firstImageAccountGate({evidence,apiKeySha:sha256(env.HF_API_KEY)});
    const proof=evidence.proof_artifact;
    try{validateArtifact(proof);}catch{throw Error('Q41_BILLING_PROOF_REQUIRED');}
    // Only a previously reviewed private object; never a Telegram URL or body.
    const proofBytes=await artifactStorage.download(proof.bucket,proof.path);
    if(!proofBytes||proofBytes.length!==proof.size||sha256(proofBytes)!==proof.sha256)throw Error('Q41_BILLING_PROOF_SHA_MISMATCH');
    firstImageAccountGate({evidence,apiKeySha:sha256(env.HF_API_KEY)});
    const binding=inputDigest({scope:FIRST_IMAGE_SCOPE,descriptor:d,evidence,budget});
    return {d,evidence,budget,binding,expiresAt:evidence.expires_at,grant:row.state.v2_authorizations?.[FIRST_IMAGE_OPERATION]};
  };
  const requestBudget=(p,args)=>p.policy?supervisedRequestGate({...args,maxReservationUsd:p.policy.max_q41_reservation_usd}):
    firstImagePrepaidGate({...args,evidence:p.evidence,apiKeySha:sha256(env.HF_API_KEY)});
  const checkBalance=async p=>{
    if(!readProviderBalance)return {status:'OFFICIAL_QUERY_UNAVAILABLE',provider_balance_usd:null,
      continuation_basis:p.policy?'EXPLICIT_SUPERVISED_AUTHORIZATION':'VERIFIED_PREPAID_EVIDENCE'};
    // Only a configured server-side official adapter; never a callback URL or amount.
    const r=await readProviderBalance();
    if(r?.source!=='OFFICIAL_API'||r.currency!=='USD'||r.api_key_sha256!==sha256(env.HF_API_KEY)
      ||!r.account_id||typeof r.balance_usd!=='number'||!Number.isFinite(r.balance_usd)||r.balance_usd<0
      ||!Number.isFinite(Date.parse(r.checked_at))||Date.parse(r.checked_at)>Date.now()
      ||Date.now()-Date.parse(r.checked_at)>60000)throw Error('Q41_OFFICIAL_BALANCE_UNVERIFIED');
    return {status:'OFFICIAL_BALANCE_VERIFIED',provider_balance_usd:r.balance_usd,checked_at:r.checked_at,account_id:r.account_id};
  };
  const projectFirstImage=async(user,patch)=>{
    const row=await reviewStore.get(user);
    row.state.q41_first_image={...row.state.q41_first_image,...patch};
    await reviewStore.cas(user,row.revision,row.state);
  };
  const firstImageStatus=async({user})=>{
    let cp=await manager.store.getEpisode(FIRST_IMAGE_OPERATION);
    if(cp){
      if(cp.metadata.user!==user||cp.metadata.operation_type!==FIRST_IMAGE_SCOPE)throw Error('Q41_OPERATION_OWNER_MISMATCH');
      let f=cp.metadata.first_image;
      if(!f.accepted&&!f.artifact&&!f.review&&f.state==='EMITTING'){
        const j=await journal.get(f.attempt_id??FIRST_IMAGE_OPERATION);
        if(confirmedInsufficientBalance(j)){
          cp=await manager.pauseInsufficientBalance({episodeId:FIRST_IMAGE_OPERATION,actionKey:'image:q41',journalRow:j});f=cp.metadata.first_image;
        }
      }
      const view={status:f.state,artifact:f.artifact||null,technical_qa:f.technical_qa||null,visual_qa:f.visual_qa||'PENDING',
        attempt_id:f.attempt_id??FIRST_IMAGE_OPERATION,policy:cp.metadata.budget_policy??null,balance_pause:cp.metadata.balance_pause??null,
        review:f.review||null,review_version:1,blocker:f.blocker||(['PREFLIGHT_CLAIMED','ESTIMATING'].includes(f.state)?'Q41_PREFLIGHT_INCOMPLETE_NO_RETRY':null),
        binding:f.binding,reserve_usd:f.reserve_usd,estimate_usd:f.estimated_cost_usd??null,actual_cost_usd:f.actual_cost_usd??null};
      await projectFirstImage(user,view);return view;
    }
    try{
      const row=await reviewStore.get(user);
      if(row?.state.v2_authorizations?.[FIRST_IMAGE_OPERATION])throw Error('Q41_CONFIRMATION_ALREADY_CONSUMED');
      if(await journal.get(FIRST_IMAGE_OPERATION))throw Error('Q41_PRIOR_EMISSION_NO_RESUBMIT');
      const p=await firstImageAccount(user);
      const view={status:'AWAITING_CONFIRMATION',binding:p.binding,expires_at:p.expiresAt,
        estimate_usd:null,reserve_usd:p.budget.reserve_usd,policy:p.policy?.version??null,blocker:null};
      await projectFirstImage(user,view);return view;
    }catch(error){
      const blocker=/^Q41_[A-Z_]+$/.test(error.message)?error.message:'Q41_PREPARATION_UNVERIFIED';
      const view={status:'BLOCKED',blocker,estimate_usd:null,reserve_usd:null,
        can_approve_supervised_policy:blocker==='Q41_VERIFIED_PREPAID_EVIDENCE_REQUIRED'};
      await projectFirstImage(user,view);return view;
    }
  };
  const recoverFirstImage=async({user})=>{
    let cp=await manager.store.getEpisode(FIRST_IMAGE_OPERATION);
    if(!cp||cp.metadata.user!==user||cp.metadata.operation_type!==FIRST_IMAGE_SCOPE)throw Error('Q41_OPERATION_OWNER_MISMATCH');
    let f=cp.metadata.first_image;
    if(f.artifact||f.review)return firstImageStatus({user});
    if(['PREFLIGHT_CLAIMED','ESTIMATING','QUOTED','PREPARED','PREFLIGHT_BLOCKED'].includes(f.state))return firstImageStatus({user});
    const j=await journal.get(f.attempt_id??FIRST_IMAGE_OPERATION);
    if(confirmedInsufficientBalance(j))return firstImageStatus({user});
    if(!f.accepted||j?.state!=='ACKNOWLEDGED'||j.provider_request_id!==f.accepted.request_id){
      await manager.checkpoint(FIRST_IMAGE_OPERATION,s=>{s.metadata.first_image.blocker='Q41_EMISSION_OUTCOME_UNKNOWN_NO_RESUBMIT';});
      return firstImageStatus({user});
    }
    try{
      const result=await materializeStageArtifact({episode_id:FIRST_IMAGE_EPISODE,stage_id:'IMAGE',action_key:'image:q41',
        provider_job_id:f.accepted.request_id,result_id:'original',review_required:true,
        target:{bucket:isolatedQ41Input().canonical_artifact.bucket,prefix:'lumi-series-v2/'+FIRST_IMAGE_EPISODE+'/q41'}},
      {receipts:new ReviewStageReceiptStore({store:reviewStore,user}),storage:artifactStorage,
        recoverOriginal:async ids=>{
          const result=await recoverSeriesProviderResult({...ids,accepted:f.accepted,stage:'IMAGE',apiKey:env.HF_API_KEY,
            fetchImpl:async(url,options={})=>{if(options.method&&options.method!=='GET')throw Error('Q41_RECOVERY_GET_ONLY');return fetchImpl(url,{...options,redirect:'error'});}});
          if(result.actual_cost_usd!==null)await manager.reconcileRequestCost({episodeId:FIRST_IMAGE_OPERATION,actionKey:'image:q41',
            attemptId:f.attempt_id??FIRST_IMAGE_OPERATION,providerRequestId:f.accepted.request_id,actualCostUsd:result.actual_cost_usd});
          return result;
        },
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
  const confirmFirstImage=async({command,recovery=false})=>{
    const {token}=await authority.firstImageCommand(command,[recovery?'q41_refill':'q41_confirm']);
    const existing=await manager.store.getEpisode(FIRST_IMAGE_OPERATION);
    let retry=null,attemptId=FIRST_IMAGE_OPERATION;
    if(existing){
      const f=existing.metadata.first_image;
      if(!recovery||token.attempt_id!==(f.attempt_id??FIRST_IMAGE_OPERATION))return firstImageStatus({user:command.user});
      const old=await journal.get(token.attempt_id);
      if(existing.metadata.user!==command.user||existing.status!=='PAUSED_INSUFFICIENT_BALANCE'
        ||existing.first_pending_action!=='image:q41'||f.accepted||f.artifact||f.review
        ||!confirmedInsufficientBalance(old))throw Error('Q41_CONFIRMED_BALANCE_REJECTION_REQUIRED');
      attemptId=FIRST_IMAGE_OPERATION+'_'+sha256(token.attempt_id).slice(0,16);
      retry={attempt_id:token.attempt_id,binding:f.binding,next_attempt_id:attemptId};
    }else if(recovery)throw Error('Q41_CONFIRMED_BALANCE_REJECTION_REQUIRED');
    if(await journal.get(attemptId))throw Error('Q41_PRIOR_EMISSION_NO_RESUBMIT');
    const p=await firstImageAccount(command.user);
    const balance=await checkBalance(p);
    if(recovery){
      const needed=existing.metadata.first_image.reserve_usd;
      if(balance.provider_balance_usd!==null&&balance.provider_balance_usd<needed){
        await manager.checkpoint(FIRST_IMAGE_OPERATION,s=>{s.metadata.balance_revalidation=balance;});
        return firstImageStatus({user:command.user});
      }
      const gate=await manager.budgetGate({episodeId:FIRST_IMAGE_OPERATION,actionKey:'image:q41',projectedCallCostUsd:needed});
      if(gate.status!=='PASS'){
        await manager.checkpoint(FIRST_IMAGE_OPERATION,s=>{s.metadata.first_image.state='PAUSED_BUDGET_EXHAUSTED';s.metadata.first_image.blocker='Q41_EPISODE_BUDGET_EXCEEDED';});
        return firstImageStatus({user:command.user});
      }
    }
    await authority.claimFirstImageConfirmation({command,binding:p.binding,ceilingUsd:p.budget.reserve_usd,expiresAt:p.expiresAt,recovery:retry});
    await inject({point:'Q41_CONFIRMATION_CLAIMED_BEFORE_CHECKPOINT'});
    const admitted=retry?await manager.beginBalanceRecovery({episodeId:FIRST_IMAGE_OPERATION,actionKey:'image:q41',
      priorAttempt:retry.attempt_id,nextAttempt:attemptId,confirmationBinding:p.binding,ceilingUsd:p.budget.reserve_usd}):
      await manager.startEpisode({episodeId:FIRST_IMAGE_OPERATION,actions:[{key:'image:q41',stage:'IMAGE',scene_id:'q41'}],authorizedCeilingUsd:5,
      metadata:{operation_type:FIRST_IMAGE_SCOPE,runtime_revision:0,user:command.user,target_episode:FIRST_IMAGE_EPISODE,
        budget_policy:p.policy?.version??null,first_image:{state:'PREFLIGHT_CLAIMED',attempt_id:attemptId,confirmation_binding:p.binding,reserve_usd:p.budget.reserve_usd,
          estimated_cost_usd:null,actual_cost_usd:null,authorization:null,accepted:null}}});
    if(admitted.metadata.user!==command.user||admitted.metadata.first_image.confirmation_binding!==p.binding
      ||admitted.metadata.first_image.state!=='PREFLIGHT_CLAIMED')throw Error('Q41_FIRST_IMAGE_ALREADY_CLAIMED');
    await manager.checkpoint(FIRST_IMAGE_OPERATION,s=>{s.metadata.balance_revalidation=balance;});
    let input,quote,budget,binding,context,payloadExpiresAt;
    try{
      const bytes=await artifactStorage.download(p.d.canonical_artifact.bucket,p.d.canonical_artifact.path);
      if(!bytes||bytes.length!==p.d.canonical_artifact.size||sha256(bytes)!==p.d.canonical_artifact.sha256)throw Error('Q41_CANONICAL_SHA_REQUIRED');
      if(typeof mediaTransport!=='function')throw Error('Q41_SIGNED_SOURCE_REQUIRED');
      const source=await mediaTransport(p.d.canonical_artifact);
      const u=new URL(source?.url),expected='/storage/v1/object/sign/'+p.d.canonical_artifact.bucket+'/'+p.d.canonical_artifact.path;
      payloadExpiresAt=source.expires_at;
      if(source.sha256!==p.d.canonical_artifact.sha256||u.protocol!=='https:'||u.origin!==new URL(env.SUPABASE_URL).origin
        ||u.pathname!==expected||!u.searchParams.get('token')||u.username||u.password||u.hash
        ||!Number.isFinite(Date.parse(payloadExpiresAt))||Date.parse(payloadExpiresAt)<=Date.now()
        ||Date.parse(payloadExpiresAt)>Date.now()+300000)throw Error('Q41_SIGNED_SOURCE_REQUIRED');
      input={...p.d.input,image_urls:[u.href]};const body=JSON.stringify(input),payloadSha=sha256(body);
      if((await firstImageAccount(command.user)).binding!==p.binding)throw Error('Q41_EVIDENCE_CHANGED');
      await manager.checkpoint(FIRST_IMAGE_OPERATION,s=>{
        if(s.metadata.first_image.state!=='PREFLIGHT_CLAIMED')throw Error('Q41_PREFLIGHT_ALREADY_CLAIMED');
        Object.assign(s.metadata.first_image,{state:'ESTIMATING',payload_sha256:payloadSha,payload_expires_at:payloadExpiresAt,
          quote_attempted_at:new Date().toISOString()});
      });
      await inject({point:'Q41_ESTIMATE_INTENT_PERSISTED'});
      let estimateUsed=false;
      const q=await estimateHiggsfieldUsd({apiKey:env.HF_API_KEY,model:p.d.model,input,
        fetchImpl:async(url,options)=>{
          if(estimateUsed||url!=='https://api.higgsfield.ai/estimate/marketing-studio/image'||options.method!=='POST'
            ||options.body!==body||options.headers?.Authorization!==`Key ${env.HF_API_KEY}`)throw Error('Q41_NON_ESTIMATE_FORBIDDEN');
          estimateUsed=true;
          if(await journal.get(attemptId))throw Error('Q41_PRIOR_EMISSION_NO_RESUBMIT');
          return fetchImpl(url,{...options,redirect:'error'});
        }});
      await inject({point:'Q41_ESTIMATE_RETURNED_BEFORE_PERSISTENCE'});
      quote={status:'QUOTE_VERIFIED',http_status:q.http_status,model:p.d.model,episode_id:FIRST_IMAGE_EPISODE,shot_id:'q41',
        quote_usd:q.estimated_cost_usd,quote_timestamp:q.quoted_at,quote_expiration:q.quote_expiration,
        payload_sha256:q.payload_sha256,provider_request_id:q.provider_request_id,
        canonical_source_sha256:p.d.canonical_artifact.sha256,canonical_source_verified:true,
        descriptor_sha256:p.d.descriptor_sha256,prompt_sha256:p.d.prompt_sha256,price_basis:'API_USD_ESTIMATE_NOT_FINAL_CHARGE'};
      if((await firstImageAccount(command.user)).binding!==p.binding)throw Error('Q41_EVIDENCE_CHANGED');
      budget=requestBudget(p,{quote,payloadSha,payloadExpiresAt});
      if(balance.provider_balance_usd!==null&&balance.provider_balance_usd<budget.reserve_usd)throw Error('Q41_INSUFFICIENT_PREPAID_BALANCE');
      binding=inputDigest({confirmation:p.binding,payloadSha,payloadExpiresAt,quote,budget});
      const expiresAt=new Date(Math.min(Date.parse(p.expiresAt),Date.parse(payloadExpiresAt),Date.parse(quote.quote_timestamp)+60000,
        quote.quote_expiration?Date.parse(quote.quote_expiration):Infinity)).toISOString();
      await manager.checkpoint(FIRST_IMAGE_OPERATION,s=>{
        if(s.metadata.first_image.state!=='ESTIMATING'||s.metadata.first_image.payload_sha256!==payloadSha)throw Error('Q41_PAYLOAD_CHANGED');
        Object.assign(s.metadata.first_image,{state:'QUOTED',quote,binding,quote_valid_until:expiresAt,estimated_cost_usd:budget.estimate_usd,reserve_usd:budget.reserve_usd});
      });
      context=await authority.authorizeFirstImage({command,binding,confirmationBinding:p.binding,ceilingUsd:budget.reserve_usd,expiresAt});
      assertV2Context(context,{episodeId:FIRST_IMAGE_EPISODE,user:command.user,scope:FIRST_IMAGE_SCOPE,dry_run:false});
      await manager.checkpoint(FIRST_IMAGE_OPERATION,s=>{
        if(s.metadata.first_image.state!=='QUOTED'||s.metadata.first_image.binding!==binding)throw Error('Q41_PAYLOAD_CHANGED');
        Object.assign(s.metadata.first_image,{state:'PREPARED',authorization:context});
        s.actions[0].estimated_cost_usd=budget.estimate_usd;
      });
      await manager.reserveFirstImage({episodeId:FIRST_IMAGE_OPERATION,actionKey:'image:q41',amountUsd:budget.reserve_usd,binding});
    }catch(error){
      const blocker=/^Q41_[A-Z_]+$/.test(error.message)?error.message:'Q41_PREFLIGHT_FAILED_NO_RETRY';
      await manager.checkpoint(FIRST_IMAGE_OPERATION,s=>{s.metadata.first_image.state='PREFLIGHT_BLOCKED';s.metadata.first_image.blocker=blocker;});
      return firstImageStatus({user:command.user});
    }
    await inject({point:'Q41_RESERVED_BEFORE_JOURNAL'});
    try{
      // The journal FK binds the durable source operation. Its immutable
      // checkpoint metadata binds the target episode without creating EP004.
      const submit=journaledFetch({store:journal,context:{episode_id:FIRST_IMAGE_OPERATION,scene_id:'q41',stage:'IMAGE',
        attempt_id:attemptId,...(retry?{original_attempt_snapshot:{balance_recovery_of:retry.attempt_id}}:{}),provider:'higgsfield_api',model:p.d.model,expected_cost_usd:budget.estimate_usd},
        fetchImpl:async(url,options)=>{
          // Re-read sealed evidence and quote at the final boundary, after CAS.
          const current=await firstImageAccount(command.user),cp=await manager.store.getEpisode(FIRST_IMAGE_OPERATION),f=cp?.metadata.first_image;
          if(current.binding!==p.binding||f?.binding!==binding||inputDigest(f.quote)!==inputDigest(quote)
            ||!current.grant||inputDigest(current.grant)!==inputDigest(context)
            ||f.state!=='EMITTING'||cp.metadata.budget_reservations?.['image:q41']?.amount_usd!==budget.reserve_usd
            ||cp.metadata.budget_reservations['image:q41'].binding!==binding||cp.authorized_ceiling_usd!==5
            ||sumUsd([cp.current_cost_usd,...Object.values(cp.metadata.budget_reservations).map(r=>r.amount_usd)])>5
            ||url!=='https://api.higgsfield.ai/marketing-studio/image'
            ||options.method!=='POST'||sha256(options.body)!==quote.payload_sha256)throw Error('Q41_EMISSION_BINDING_CHANGED');
          requestBudget(current,{quote:f.quote,payloadSha:sha256(options.body),payloadExpiresAt});
          if(balance.status==='OFFICIAL_BALANCE_VERIFIED'&&Date.now()-Date.parse(balance.checked_at)>60000)throw Error('Q41_OFFICIAL_BALANCE_EXPIRED');
          assertV2Context(context,{episodeId:FIRST_IMAGE_EPISODE,user:command.user,scope:FIRST_IMAGE_SCOPE,dry_run:false});
          return fetchImpl(url,{...options,redirect:'error'});
        },persistResponse:async accepted=>{
          if(!/^[A-Za-z0-9_-]{1,120}$/.test(accepted.request_id||''))throw Error('Q41_PROVIDER_HANDLE_INVALID');
          const u=new URL(accepted.status_url);
          if(u.origin!=='https://api.higgsfield.ai'||u.username||u.password||u.hash)throw Error('Q41_PROVIDER_HANDLE_INVALID');
          await manager.checkpoint(FIRST_IMAGE_OPERATION,s=>{s.metadata.first_image.accepted={request_id:accepted.request_id,status_url:u.href};s.metadata.first_image.state='ACCEPTED';});
        }});
      await submitSeriesProviderRequest({model:p.d.model,input,apiKey:env.HF_API_KEY,attemptId,submit});
    }catch{
      const row=await journal.get(attemptId);
      if(confirmedInsufficientBalance(row)){
        await inject({point:'Q41_BALANCE_REJECTION_BEFORE_CHECKPOINT'});
        await manager.pauseInsufficientBalance({episodeId:FIRST_IMAGE_OPERATION,actionKey:'image:q41',journalRow:row});
        return firstImageStatus({user:command.user});
      }
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
  const importedSourceReviewPending=state=>{
    const action=state.actions.find(a=>a.key===state.first_pending_action);
    if(action?.stage!=='SOURCE_QA'||!state.metadata.imported_stage_sources?.['image:'+action.scene_id])return false;
    const imported=state.metadata.imported_stage_sources['image:'+action.scene_id];
    const source=sourceQaRecord(state,action.scene_id,state.metadata.artifacts?.[imported.artifact_id]);
    try{sourceGate(source?.artifact,source?.ledger);
      return evaluateTopology({stage:'SOURCE_PREFLIGHT',sha256:source.artifact.sha256,
        review:source.ledger.result.topology_review}).status!=='PASS';}catch{return true;}
  };
  const videoQuoteId=state=>inputDigest({operation:'EP004_Q41_VIDEO_USD_PREFLIGHT',episode:state.episode_id,
    prepared:state.metadata.generic_v2.binding_sha,director:state.metadata.stage_results?.['director:q41']?.sha256});
  const videoQuoteView=async(user,state)=>{
    const r=await new ReviewStageReceiptStore({store:reviewStore,user}).get(videoQuoteId(state));
    if(!r)return null;
    if(r.status!=='COMPLETE')return {status:'QUOTE_RESULT_UNKNOWN',budget_gate:'BLOCKED'};
    if(inputDigest(r.result)!==r.result_sha)throw Error('VIDEO_QUOTE_RECEIPT_INTEGRITY');
    const q={...structuredClone(r.result),quote_sha:r.result_sha};
    if(q.status==='AWAITING_HUMAN_AUTHORIZATION'){
      const b=await manager.budgetExposure({episodeId:state.episode_id});
      if(q.checkpoint_id!==checkpointIdentity(state)||q.budget_fingerprint!==inputDigest(b))Object.assign(q,{status:'QUOTE_STATE_CHANGED',budget_gate:'BLOCKED'});
      else if(Date.parse(q.expires_at)<=Date.now())Object.assign(q,{status:'QUOTE_EXPIRED',budget_gate:'BLOCKED'});
      else if(r.human_authorization)q.status='HUMAN_SPEND_AUTHORIZED';
    }
    return q;
  };
  const projectCheckpoint=async(user,episodeId)=>{
   for(let attempt=0;attempt<6;attempt++){
    const state=await manager.store.getEpisode(episodeId),row=await reviewStore.get(user),e=row?.state.episodes[episodeId];
    if(!e||state.metadata.user!==user)throw Error('REVIEW_EPISODE_REQUIRED');
    let sourceAuthorizationBlocked=false;
    if(['SOURCE_QA','DIRECTOR'].includes(state.actions.find(a=>a.key===state.first_pending_action)?.stage)){
      const a=state.metadata.activation_context;
      try{await authority.authorize({user,chat:a?.chat,episodeId,operationId:a?.operation_id,
        authorizationId:a?.authorization_id,requestSha:a?.request_sha,scope:'RESUME'});}
      catch(error){if(error.message!=='CONTROLLED_ACTIVATION_REQUIRED')throw error;sourceAuthorizationBlocked=true;}
    }
    const providerBlocked=['IMAGE','VIDEO','TTS'].includes(state.actions.find(a=>a.key===state.first_pending_action)?.stage)
      && state.metadata.provider_generation_authorized===false;
    const director=state.metadata.stage_results?.['director:q41']?.result.output;
    const projection={...(state.first_pending_action==='video:q41'?{video_quote:await videoQuoteView(user,state)}:{}),
      source_authorization_blocked:sourceAuthorizationBlocked,provider_authorization_blocked:providerBlocked,
      director_prepared:!!director,director_duration:director?.DIRECTOR_PLAN?.contract.DURATION??null,
      next_action:state.first_pending_action,first_pending_action:state.first_pending_action,
      last_completed_action:state.last_completed_action,current_stage:state.actions.find(a=>a.key===state.first_pending_action)?.stage||'HUMAN_REVIEW',
      balance_pause:state.status==='PAUSED_INSUFFICIENT_BALANCE'?state.metadata.balance_pause:null,budget_exhausted:state.metadata.budget_exhausted===true,
      source_review_required:importedSourceReviewPending(state),
      resume_available:state.status==='RUNNING'&&!providerBlocked&&!sourceAuthorizationBlocked&&!state.metadata.repair_plan_required&&!importedSourceReviewPending(state)};
    if(!Object.entries(projection).some(([k,v])=>inputDigest(e[k]??null)!==inputDigest(v??null)))return;
    Object.assign(e,projection);
    try{await reviewStore.cas(user,row.revision,row.state);return;}
    catch(error){if(error.message!=='concurrent_update')throw error;}
   }
   throw Error('concurrent_update');
  };
  const forUser=(user,dry_run)=>{
    const receipts=new ReviewStageReceiptStore({store:reviewStore,user}),directories=[];
    const bindInput=async({materialized,state,action,prepared,shot})=>{
      const m={...materialized.materialized_stage_input};
      const attempt=action.active_attempt_id??sha256(state.episode_id+':'+prepared.binding_sha+':'+action.key);
      const recovery=state.metadata.balance_recovery?.attempt_id===attempt?state.metadata.balance_recovery:null;
      let sourceExpiry=null;
      // Transport is regenerated only at execution, from verified durable identity.
      const transport=async a=>{
        if(dry_run)return 'urn:lumi:sha256:'+a.sha256;
        const t=await mediaTransport(a);sourceExpiry=t?.expires_at;if(t?.sha256!==a.sha256||!/^https:\/\//.test(t.url))throw Error('ARTIFACT_TRANSPORT_REQUIRED');return t.url;
      };
      if(['IMAGE','VIDEO'].includes(action.stage)){
        if(!dry_run&&!recovery&&(!m.quote?.expires_at||!Number.isFinite(Date.parse(m.quote.expires_at))||Date.parse(m.quote.expires_at)<=Date.now()
          ||m.quote.episode_id!==state.episode_id||m.quote.action_key!==action.key))throw Error('CURRENT_USD_QUOTE_REQUIRED');
        m.apiKey=env.HF_API_KEY;
        const dispatch=journaledFetch({store:journal,context:{episode_id:state.episode_id,scene_id:action.scene_id,
          stage:action.stage,attempt_id:attempt,provider:'higgsfield_api',model:action.stage==='IMAGE'?profile.image.model:profile.video.endpoint,
          expected_cost_usd:m.quote?.usd},fetchImpl:async(url,options)=>{
            const cp=await manager.store.getEpisode(state.episode_id);
            if(cp.status!=='RUNNING'||cp.first_pending_action!==action.key||Date.parse(m.quote.expires_at)<=Date.now()
              ||!cp.metadata.budget_reservations?.[action.key])throw Error('GENERIC_BUDGET_RESERVATION_REQUIRED');
            if((await manager.budgetGate({episodeId:state.episode_id,actionKey:action.key,projectedCallCostUsd:0})).status!=='PASS')throw Error('BUDGET_EXHAUSTED');
            return fetchImpl(url,{...options,redirect:'error'});
          }});
        m.submit=async(url,options)=>{
          await manager.reservePendingRequest({episodeId:state.episode_id,actionKey:action.key,amountUsd:m.quote.usd,
            binding:sha256(options.body),attemptId:attempt,quote:m.quote});
          return dispatch(url,options);
        };
        if(recovery&&!dry_run){
          let used=false;
          m.submit=async(url,options)=>{
            if(used)throw Error('BALANCE_RECOVERY_ALREADY_CONSUMED');used=true;
            const row=await reviewStore.get(user),policy=verifySupervisedPolicy(row.state.q41_supervised_policy,env.LUMI_TELEGRAM_CALLBACK_SECRET,
              {user,chat:row.state.chat_id,panelIds:[row.state.message_id,...Object.keys(row.state.panel_history||{}).map(Number)],apiKeySha:sha256(env.HF_API_KEY)});
            if(policy.episode_id!==state.episode_id)throw Error('BALANCE_POLICY_SCOPE_INVALID');
            const model=action.stage==='IMAGE'?profile.image.model:profile.video.endpoint;
            if(url!=='https://api.higgsfield.ai/'+model||options.method!=='POST'||!Number.isFinite(Date.parse(sourceExpiry))
              ||Date.parse(sourceExpiry)<=Date.now()||Date.parse(sourceExpiry)>Date.now()+300000)throw Error('BALANCE_PAYLOAD_INVALID');
            if(await journal.get(attempt)||!confirmedInsufficientBalance(await journal.get(recovery.prior_attempt_id)))throw Error('BALANCE_JOURNAL_MISMATCH');
            await manager.checkpoint(state.episode_id,s=>{
              if(s.metadata.balance_recovery?.state!=='REVALIDATING'||s.first_pending_action!==action.key)throw Error('STALE_CHECKPOINT');
              s.metadata.balance_recovery.state='ESTIMATING';s.metadata.balance_recovery.payload_sha256=sha256(options.body);
            });
            const q=await estimateHiggsfieldUsd({apiKey:env.HF_API_KEY,model,input:JSON.parse(Buffer.from(options.body).toString()),
              fetchImpl:(url,opts)=>fetchImpl(url,{...opts,redirect:'error'})});
            const quote={status:'QUOTE_VERIFIED',http_status:q.http_status,quote_usd:q.estimated_cost_usd,quote_timestamp:q.quoted_at,
              quote_expiration:q.quote_expiration,payload_sha256:q.payload_sha256};
            const budget=supervisedRequestGate({quote,payloadSha:sha256(options.body),payloadExpiresAt:sourceExpiry,
              maxReservationUsd:policy.max_request_reservation_usd});
            const b=recovery.balance;
            if(b.status==='OFFICIAL_BALANCE_VERIFIED'&&(Date.now()-Date.parse(b.checked_at)>60000||b.provider_balance_usd<budget.reserve_usd))throw Error('BALANCE_INSUFFICIENT_OR_EXPIRED');
            m.quote={currency:'USD',usd:budget.estimate_usd,expires_at:new Date(Math.min(Date.parse(sourceExpiry),Date.parse(q.quoted_at)+60000)).toISOString(),
              episode_id:state.episode_id,action_key:action.key,payload_sha256:q.payload_sha256};
            const binding=inputDigest({quote,policy,attempt,action_key:action.key});
            await manager.reservePendingRequest({episodeId:state.episode_id,actionKey:action.key,amountUsd:budget.reserve_usd,binding,attemptId:attempt,quote});
            return journaledFetch({store:journal,context:{episode_id:state.episode_id,scene_id:action.scene_id,stage:action.stage,
              attempt_id:attempt,provider:'higgsfield_api',model,expected_cost_usd:budget.estimate_usd,
              original_attempt_snapshot:{balance_recovery_of:recovery.prior_attempt_id}},fetchImpl:async(u,o)=>{
                const cp=await manager.store.getEpisode(state.episode_id),r=cp.metadata.balance_recovery,ac=cp.metadata.activation_context;
                await authority.authorize({user,chat:ac.chat,episodeId:state.episode_id,operationId:ac.operation_id,
                  authorizationId:ac.authorization_id,requestSha:ac.request_sha,scope:'RESUME'});
                const latest=await reviewStore.get(user);
                if(inputDigest(verifySupervisedPolicy(latest.state.q41_supervised_policy,env.LUMI_TELEGRAM_CALLBACK_SECRET,
                  {user,chat:latest.state.chat_id,panelIds:[latest.state.message_id,...Object.keys(latest.state.panel_history||{}).map(Number)],apiKeySha:sha256(env.HF_API_KEY)}))!==inputDigest(policy)
                  ||cp.status!=='RUNNING'||cp.first_pending_action!==action.key||r.attempt_id!==attempt||r.binding!==binding
                  ||cp.metadata.budget_reservations[action.key]?.binding!==binding||sha256(o.body)!==quote.payload_sha256)
                  throw Error('BALANCE_EMISSION_BINDING_CHANGED');
                supervisedRequestGate({quote:r.quote,payloadSha:sha256(o.body),payloadExpiresAt:sourceExpiry,maxReservationUsd:policy.max_request_reservation_usd});
                if((await manager.budgetGate({episodeId:state.episode_id,actionKey:action.key,projectedCallCostUsd:0})).status!=='PASS')throw Error('BUDGET_EXHAUSTED');
                return fetchImpl(u,{...o,redirect:'error'});
              }})(url,options);
          };
        }
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
          if(m.director_input)shot.director_input=m.director_input;
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
      if(importedSourceReviewPending(state)){
        await projectCheckpoint(user,episodeId);
        return {status:'SOURCE_REVIEW_REQUIRED',first_pending_action:state.first_pending_action,provider_calls:0};
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
  adapter.refreshProgress=({user,episodeId})=>projectCheckpoint(user,episodeId);
  // Staging operator acceptance uses the same authorized runtime, with one fixed
  // non-generative action. No client episode, panel, source, grant or next action.
  adapter.verifyEp004SourceQa=async({user,chat})=>{
    const row=await reviewStore.get(user),s=row?.state;
    if(env.LUMI_RUNTIME_ENV!=='staging'||s?.user_id!==user||s.chat_id!==chat
      ||!await validateOwner(user,chat)||s.delivery?.status!=='DELIVERED'||s.pending_callback)
      throw Error('SOURCE_QA_OWNER_OR_DELIVERY_REQUIRED');
    return runtime.resume({user,episodeId:FIRST_IMAGE_EPISODE,expectedAction:'source_qa:q41'});
  };
  adapter.prepareEp004Director=async({user,chat})=>{
    const row=await reviewStore.get(user),s=row?.state;
    if(env.LUMI_RUNTIME_ENV!=='staging'||s?.user_id!==user||s.chat_id!==chat
      ||!await validateOwner(user,chat)||s.delivery?.status!=='DELIVERED'||s.pending_callback)
      throw Error('DIRECTOR_OWNER_OR_DELIVERY_REQUIRED');
    return runtime.resume({user,episodeId:FIRST_IMAGE_EPISODE,expectedAction:'director:q41'});
  };
  // An operator HMAC request may estimate this one pending action. It cannot
  // select a model/payload/panel, reserve money, authorize spending or dispatch.
  const videoQuoteContext=async(user,chat)=>{
    const row=await reviewStore.get(user),s=row?.state,cp=await manager.store.getEpisode(FIRST_IMAGE_EPISODE);
    if(env.LUMI_RUNTIME_ENV!=='staging'||s?.user_id!==user||s.chat_id!==chat||!await validateOwner(user,chat)
      ||s.delivery?.status!=='DELIVERED'||s.pending_callback)throw Error('Q41_QUOTE_OWNER_OR_DELIVERY_REQUIRED');
    const a=cp?.metadata.activation_context,action=cp?.actions.find(a=>a.key==='video:q41');
    await authority.authorize({user,chat,episodeId:FIRST_IMAGE_EPISODE,operationId:a?.operation_id,
      authorizationId:a?.authorization_id,requestSha:a?.request_sha,scope:'RESUME'});
    if(cp.status!=='RUNNING'||cp.metadata.user!==user||cp.first_pending_action!=='video:q41'
      ||cp.last_completed_action!=='director:q41'||action?.status!=='PENDING'||action.dispatch_state!=='NOT_DISPATCHED'
      ||cp.authorized_ceiling_usd!==5||cp.metadata.provider_generation_authorized!==false
      ||cp.runner_enabled||cp.autorun)throw Error('Q41_VIDEO_QUOTE_SCOPE_REQUIRED');
    const receipts=new ReviewStageReceiptStore({store:reviewStore,user}),d=cp.metadata.stage_results?.['director:q41'];
    const receipt=d&&await receipts.get(d.receipt_id);
    if(!d||receipt?.status!=='COMPLETE'||inputDigest(d.result)!==d.sha256||inputDigest(receipt.result)!==d.sha256)
      throw Error('Q41_DIRECTOR_RECEIPT_REQUIRED');
    const attempt=action.active_attempt_id??sha256(cp.episode_id+':'+cp.metadata.generic_v2.binding_sha+':'+action.key);
    if(await journal.get(attempt)||await receipts.get(attempt)||cp.metadata.budget_reservations?.[action.key])
      throw Error('Q41_VIDEO_PRIOR_EMISSION_OR_RESERVATION');
    return {cp,receipts,id:videoQuoteId(cp),budget:await manager.budgetExposure({episodeId:cp.episode_id})};
  };
  adapter.prepareEp004VideoQuote=async({user,chat})=>{
    const ctx=await videoQuoteContext(user,chat),{cp,receipts,id,budget}=ctx;
    const finish=async()=>{await projectCheckpoint(user,cp.episode_id);return {
      ...await videoQuoteView(user,await manager.store.getEpisode(cp.episode_id)),provider_calls:0,commands:[]};};
    if(await receipts.get(id))return finish(); // Includes an ambiguous estimate: never resubmit.
    if(!env.HF_API_KEY)throw Error('Q41_HF_API_KEY_MISSING');
    const m=await createV2InputMaterializer({store:manager.store,storage:artifactStorage,reviewStore,journal,receipts,quoteOnly:true})({
      episode_id:cp.episode_id,stage_id:'VIDEO',checkpoint_id:checkpointIdentity(cp),profile_version:profile.version,
      execution_context:{user,profile_sha:PROFILE_SHA,action_key:'video:q41'}});
    const input=m.materialized_stage_input,a=input.source.artifact,packet=input.director_packet,c=packet.DIRECTOR_PLAN.contract;
    if(c.DURATION!==4||c.CAMERA.type!=='STATIC'||c.CHARACTER_STATE.canonical_wings!==2
      ||c.CHARACTER_STATE.wand_policy!=='VISIBLE_PRESERVE_SOURCE'
      ||inputDigest(c.REQUIRED_OBJECTS.map(o=>o.id).sort())!==inputDigest(['cow','hen','sheep']))throw Error('Q41_VIDEO_DIRECTION_SCOPE_REQUIRED');
    const signed=await mediaTransport(a),url=new URL(signed.url),sourceExpiry=Date.parse(signed.expires_at);
    if(signed.sha256!==a.sha256||url.protocol!=='https:'||url.origin!==new URL(env.SUPABASE_URL).origin
      ||url.pathname!=='/storage/v1/object/sign/'+a.bucket+'/'+a.path||!url.searchParams.get('token')
      ||url.username||url.password||url.hash||!Number.isFinite(sourceExpiry)||sourceExpiry<=Date.now()
      ||sourceExpiry>Date.now()+300000)throw Error('Q41_SIGNED_SOURCE_REQUIRED');
    const payload=buildDirectedVideoPayload({episodeId:cp.episode_id,shotId:'q41',source:input.source,packet,sourceUrl:url.href});
    if(payload.duration!==4||payload.sound!=='off'||payload.multi_shots!==false)throw Error('Q41_VIDEO_PAYLOAD_SCOPE_REQUIRED');
    const body=JSON.stringify(payload),payloadSha=sha256(body),latest=await videoQuoteContext(user,chat);
    if(checkpointIdentity(latest.cp)!==checkpointIdentity(cp)||inputDigest(latest.budget)!==inputDigest(budget))throw Error('STALE_CHECKPOINT');
    if(!await receipts.claim(id,{status:'STARTED',operation:'VIDEO_USD_QUOTE',checkpoint_id:checkpointIdentity(cp),
      payload_sha256:payloadSha,source_sha256:a.sha256,started_at:new Date().toISOString()}))return finish();
    await inject({point:'VIDEO_QUOTE_CLAIMED'});
    let result={quote_id:id,episode_id:cp.episode_id,action_key:'video:q41',model:profile.video.endpoint,
      checkpoint_id:checkpointIdentity(cp),checkpoint_version:cp.metadata.runtime_revision,director_sha256:cp.metadata.stage_results['director:q41'].sha256,
      payload_sha256:payloadSha,source_sha256:a.sha256,prompt_sha256:sha256(payload.prompt),duration:4,sound:'off',
      budget_fingerprint:inputDigest(budget),remaining_before_usd:Number((5-budget.required_total_usd).toFixed(9)),
      existing_exposure_usd:budget.required_total_usd,hard_budget_usd:5,actual_cost_usd:null,
      status:'BLOCKED',budget_gate:'BLOCKED',generation_authorized:false};
    let used=false;
    try{
      const q=await estimateHiggsfieldUsd({apiKey:env.HF_API_KEY,model:profile.video.endpoint,input:payload,
        fetchImpl:async(endpoint,options)=>{
          if(used||endpoint!=='https://api.higgsfield.ai/estimate/'+profile.video.endpoint||options.method!=='POST'
            ||options.body!==body)throw Error('Q41_NON_ESTIMATE_FORBIDDEN');
          const now=await videoQuoteContext(user,chat);
          if(checkpointIdentity(now.cp)!==checkpointIdentity(cp)||inputDigest(now.budget)!==inputDigest(budget))throw Error('STALE_CHECKPOINT');
          used=true;return fetchImpl(endpoint,{...options,redirect:'error'});
        }});
      result={...result,http_status:q.http_status,provider_request_id:q.provider_request_id,quote_usd:q.estimated_cost_usd,
        quote_timestamp:q.quoted_at,quote_expiration:q.quote_expiration,
        expires_at:new Date(Math.min(sourceExpiry,Date.parse(q.quoted_at)+60000,q.quote_expiration?Date.parse(q.quote_expiration):Infinity)).toISOString()};
      const gate=supervisedRequestGate({quote:{...result,status:'QUOTE_VERIFIED'},payloadSha,payloadExpiresAt:signed.expires_at,
        maxReservationUsd:Math.max(0,result.remaining_before_usd)});
      const fresh=await videoQuoteContext(user,chat);
      if(checkpointIdentity(fresh.cp)!==checkpointIdentity(cp)||inputDigest(fresh.budget)!==inputDigest(budget))throw Error('STALE_CHECKPOINT');
      result={...result,status:'AWAITING_HUMAN_AUTHORIZATION',budget_gate:'PASS',proposed_reserve_usd:gate.reserve_usd,
        remaining_after_usd:Number((result.remaining_before_usd-gate.reserve_usd).toFixed(9)),provider_charge_guaranteed:false};
    }catch(error){
      // No response bodies, signed URLs or credentials enter the durable receipt.
      result={...result,status:'BLOCKED',budget_gate:'BLOCKED',error_code:
        /^(?:Q41_[A-Z_]+|STALE_CHECKPOINT|higgsfield_[a-z_0-9]+)$/.test(error.message)?error.message:'QUOTE_OUTCOME_UNKNOWN_NO_RETRY',
        ...(error.quote_receipt?{http_status:error.quote_receipt.http_status,provider_request_id:error.quote_receipt.provider_request_id}:{})};
    }
    await inject({point:'VIDEO_QUOTE_RETURNED_BEFORE_RECEIPT'});
    await receipts.record(id,{status:'COMPLETE',operation:'VIDEO_USD_QUOTE',result,result_sha:inputDigest(result)});
    return finish();
  };
  adapter.authorizeEp004VideoQuote=async({command})=>{
    for(let retry=0;retry<6;retry++){
      const {row,token}=await authority.firstImageCommand(command,['q41_video_authorize']);
      if(row.state.delivery?.status!=='DELIVERED'||!row.state.delivery.tokens?.includes(command.token)||row.state.pending_callback)
        throw Error('Q41_VIDEO_QUOTE_STALE_CALLBACK');
      const {cp,id,budget}=await videoQuoteContext(command.user,command.chat),r=row.state.production_commands?.[id],q=r?.result;
      if(r?.status!=='COMPLETE'||inputDigest(q)!==r.result_sha||q.status!=='AWAITING_HUMAN_AUTHORIZATION'
        ||token.quote_id!==id||token.quote_sha!==r.result_sha||q.checkpoint_id!==checkpointIdentity(cp)
        ||q.budget_fingerprint!==inputDigest(budget)||!Number.isFinite(Date.parse(q.expires_at))||Date.parse(q.expires_at)<=Date.now())
        throw Error('Q41_VIDEO_CURRENT_QUOTE_REQUIRED');
      if(r.human_authorization)return {status:'HUMAN_SPEND_AUTHORIZED',already_applied:true,provider_calls:0};
      // A decision on this quote only. No global/provider permission or reserve.
      r.human_authorization={user:command.user,chat:command.chat,message_id:command.message_id,callback_id:command.callback_id,
        decision:'APPROVED',scope:'VIDEO_Q41_QUOTED_SPEND',quote_sha:r.result_sha,payload_sha256:q.payload_sha256,
        max_reservation_usd:q.proposed_reserve_usd,hard_budget_usd:5,expires_at:q.expires_at,created_at:new Date().toISOString()};
      try{await reviewStore.cas(command.user,row.revision,row.state);return {status:'HUMAN_SPEND_AUTHORIZED',provider_calls:0};}
      catch(error){if(error.message!=='concurrent_update'||retry===5)throw error;}
    }
  };
  // Recover the server-owned pending command, not a replayed Telegram callback.
  // Only pure planning stages may start from an absent receipt. A started claim
  // without a result remains ambiguous; no provider stage can enter this path.
  adapter.recoverPendingResume=async({user,chat})=>{
    const row=await reviewStore.get(user),s=row?.state,p=s?.pending_callback;
    if(!s||s.user_id!==String(user)||s.chat_id!==String(chat)||!await validateOwner(user,chat))throw Error('UNAUTHORIZED_REVIEWER');
    if(!p)return {status:'NO_PENDING_PRODUCTION',provider_calls:0};
    const t=s.tokens?.[String(p.token).replace(/^lr:/,'')],episodeId=t?.episode_id;
    if(p.status!=='PENDING'||t?.action!=='resume'||!t.next_action||s.delivery?.status!=='DELIVERED')throw Error('PENDING_PRODUCTION_RECOVERY_REQUIRED');
    const state=await manager.store.getEpisode(episodeId),action=state?.actions.find(a=>a.key===t.next_action);
    if(state?.metadata.user!==user||!['PLANNING','SOURCE_PLANNING'].includes(action?.stage)||state.status!=='RUNNING')throw Error('LOCAL_PLANNING_RECOVERY_ONLY');
    const id=action.active_attempt_id??sha256(episodeId+':'+state.metadata.generic_v2.binding_sha+':'+action.key);
    const receipt=await new ReviewStageReceiptStore({store:reviewStore,user}).get(id);
    if(await journal.get(id)||receipt&&receipt.status!=='COMPLETE')throw Error('STAGE_RESULT_AMBIGUOUS');
    if(!receipt&&(action.status==='COMPLETE'||action.dispatch_state!=='NOT_DISPATCHED'||state.first_pending_action!==action.key))throw Error('STAGE_RECOVERY_EVIDENCE_REQUIRED');
    await runtime.resume({user,episodeId,expectedAction:action.key});
    const completed=await manager.store.getEpisode(episodeId),result=completed.metadata.stage_results?.[action.key];
    const durable=await new ReviewStageReceiptStore({store:reviewStore,user}).get(id);
    if(completed.actions.find(a=>a.key===action.key)?.status!=='COMPLETE'||!result||result.receipt_id!==id
      ||durable?.status!=='COMPLETE'||result.sha256!==inputDigest(durable.result))throw Error('STAGE_RECOVERY_EVIDENCE_REQUIRED');
    for(let attempt=0;attempt<6;attempt++){
      const current=await reviewStore.get(user),c=current.state,token=c.tokens?.[String(p.token).replace(/^lr:/,'')];
      if(c.applied?.['callback:'+p.id]?.status==='RECOVERED'&&!c.pending_callback)return {status:'PRODUCTION_RECOVERED',already_applied:true,provider_calls:0};
      if(c.user_id!==user||c.chat_id!==String(chat)||c.message_id!==s.message_id||c.pending_callback?.id!==p.id
        ||c.pending_callback.token!==p.token||inputDigest(token)!==inputDigest(t)||c.delivery?.status!=='DELIVERED'
        ||c.delivery.command?.idempotency_key!==s.delivery.command?.idempotency_key)throw Error('PENDING_PRODUCTION_CHANGED');
      c.applied||={};c.applied['callback:'+p.id]={status:'RECOVERED',episode_id:episodeId,action_key:action.key,
        receipt_id:id,checkpoint_version:completed.metadata.runtime_revision};
      c.pending_callback=null;c.recovery_state=importedSourceReviewPending(completed)?'SOURCE_REVIEW_REQUIRED':'READY_TO_CONTINUE';
      try{await reviewStore.cas(user,current.revision,c);return {status:'PRODUCTION_RECOVERED',episode_id:episodeId,
        completed_action:action.key,first_pending_action:completed.first_pending_action,checkpoint_version:completed.metadata.runtime_revision,provider_calls:0};}
      catch(error){if(error.message!=='concurrent_update')throw error;}
    }
    throw Error('concurrent_update');
  };
  adapter.authorizeCreate=({user,chat,request,command})=>authority.authorize({user,chat,episodeId:request?.episodePlan?.episode?.id,
    operationId:command?.operation_id,authorizationId:command?.authorization_id,scope:'CREATE',requestSha:inputDigest(request),command});
  adapter.validateReview=validateReview;
  adapter.pendingReview=runtime.pendingReview;
  adapter.balanceReloaded=async({command})=>{
    const {row,token}=await authority.balanceCommand(command),episodeId=token.episode_id;
    let cp=await manager.store.getEpisode(episodeId),ac=cp?.metadata.activation_context;
    if(!cp||cp.metadata.user!==command.user||!ac||cp.status==='CANCELLED'||row.state.episodes[episodeId].master
      ||row.state.episodes[episodeId].cancelled||Object.values(row.state.episodes[episodeId].review_requests||{}).some(r=>r.status!=='APPROVED'))
      throw Error('BALANCE_RECOVERY_SCOPE_INVALID');
    const context=await authority.authorize({user:command.user,chat:command.chat,episodeId,operationId:ac.operation_id,
      authorizationId:ac.authorization_id,requestSha:ac.request_sha,scope:'RESUME'});
    if(context.dry_run||context.diagnostic)throw Error('BALANCE_RECOVERY_SCOPE_INVALID');
    if(cp.metadata.balance_recovery_history?.[token.attempt_id]){await projectCheckpoint(command.user,episodeId);return {status:cp.status,already_applied:true};}
    const action=cp.actions.find(a=>a.key===cp.first_pending_action),prior=await journal.get(token.attempt_id);
    if(cp.status!=='PAUSED_INSUFFICIENT_BALANCE'||cp.first_pending_action!==token.next_action
      ||cp.metadata.balance_pause?.attempt_id!==token.attempt_id||!confirmedInsufficientBalance(prior)
      ||prior.episode_id!==episodeId||prior.stage!==action?.stage||prior.scene_id!==action?.scene_id)
      throw Error('BALANCE_REJECTION_EVIDENCE_REQUIRED');
    const policy=verifySupervisedPolicy(row.state.q41_supervised_policy,env.LUMI_TELEGRAM_CALLBACK_SECRET,
      {user:command.user,chat:command.chat,panelIds:[row.state.message_id,...Object.keys(row.state.panel_history||{}).map(Number)],apiKeySha:sha256(env.HF_API_KEY)});
    if(policy.episode_id!==episodeId||cp.authorized_ceiling_usd!==policy.hard_episode_budget_usd)throw Error('BALANCE_POLICY_SCOPE_INVALID');
    const balance=await checkBalance({policy});
    if(balance.provider_balance_usd!==null&&balance.provider_balance_usd<prior.expected_cost_usd)
      return {status:'PAUSED_INSUFFICIENT_BALANCE',provider_calls:0};
    if((await manager.budgetGate({episodeId,actionKey:action.key,projectedCallCostUsd:prior.expected_cost_usd})).status!=='PASS'){
      await projectCheckpoint(command.user,episodeId);return {status:'BUDGET_EXHAUSTED',provider_calls:0};
    }
    const nextAttempt=sha256('BALANCE_RECOVERY:'+token.attempt_id);
    if(await journal.get(nextAttempt))throw Error('BALANCE_RECOVERY_ALREADY_CONSUMED');
    await manager.beginGenericBalanceRecovery({episodeId,actionKey:action.key,priorAttempt:token.attempt_id,nextAttempt,
      balance,authorization:{...context,status:'AUTHORIZED',attempt_id:nextAttempt,callback_query_id:command.callback_id,nonce:command.nonce}});
    await inject({point:'BALANCE_RELOAD_CLAIMED'});
    // The existing orchestrator rebuilds only FIRST_PENDING_ACTION. No completed
    // receipt, review or previous IMAGE/VIDEO/TTS action is cleared or replayed.
    try{return await runtime.resume({user:command.user,episodeId,expectedAction:action.key});}
    finally{await projectCheckpoint(command.user,episodeId);}
  };
  adapter.firstImageStatus=firstImageStatus;
  adapter.createEp004FromApprovedQ41=async({command})=>{
    assertEp004ImportCommand(command);
    if(env.LUMI_RUNTIME_ENV!=='staging')throw Error('Q41_STAGING_ONLY');
    // Only local CAS conflicts may be retried. This operation has no provider or
    // Telegram emitter; a crash resumes durable creation/import, never q41.
    for(let retry=0;retry<4;retry++)try{
      const cp=await manager.store.getEpisode(FIRST_IMAGE_OPERATION),f=cp?.metadata.first_image;
      const row=await reviewStore.get(command.user),s=row?.state,a=f?.artifact,review=f?.review;
      const attempt=f?.attempt_id??FIRST_IMAGE_OPERATION,j=await journal.get(attempt);
      if(cp?.metadata.user!==command.user||cp.metadata.target_episode!==FIRST_IMAGE_EPISODE
        ||cp.metadata.operation_type!==FIRST_IMAGE_SCOPE||f?.state!=='APPROVED_PAUSED'
        ||review?.status!=='APPROVED'||review.user!==command.user||review.artifact_sha!==a?.sha256
        ||review.review_version!==1||!review.callback_query_id||!f.technical_qa?.ok
        ||j?.state!=='ACKNOWLEDGED'||j.episode_id!==FIRST_IMAGE_OPERATION||j.stage!=='IMAGE'
        ||j.provider!=='higgsfield_api'||j.model!==profile.image.model
        ||!Number.isFinite(f.estimated_cost_usd)||f.estimated_cost_usd<0||f.estimated_cost_usd!==j.expected_cost_usd
        ||j.provider_request_id!==f.accepted?.request_id||a?.provider_job_id!==j.provider_request_id
        ||a?.episode_id!==FIRST_IMAGE_EPISODE||s?.q41_first_image?.review?.artifact_sha!==a.sha256
        ||inputDigest(s.q41_first_image.review)!==inputDigest(review)||s.delivery?.status!=='DELIVERED')
        throw Error('EP004_APPROVED_SOURCE_EVIDENCE_REQUIRED');
      validateArtifact(a);
      const bytes=await artifactStorage.download(a.bucket,a.path);
      if(!bytes||bytes.length!==a.size||sha256(bytes)!==a.sha256)throw Error('Q41_ARTIFACT_SHA_MISMATCH');
      const source={source_episode_id:FIRST_IMAGE_OPERATION,attempt_id:attempt,provider_request_id:j.provider_request_id,
        artifact_id:a.artifact_id,artifact_sha:a.sha256,human_review:structuredClone(review)};
      const sourceBinding=inputDigest(source),request=ep004ProductionRequest(a);
      const context=await authority.authorizeEp004Import({command,request,sourceBinding});
      await runtime.create({user:command.user,request,execution_context:context});
      await inject({point:'EP004_AFTER_CREATE'});
      const existing=await manager.store.getEpisode(FIRST_IMAGE_EPISODE);
      if(existing.status!=='RUNNING'||existing.authorized_ceiling_usd!==5)throw Error('EP004_CHECKPOINT_NOT_IMPORTABLE');
      const prior=existing.metadata.imported_stage_sources?.['image:q41'];
      if(prior&&inputDigest(prior)!==sourceBinding)throw Error('EP004_IMPORT_IMMUTABLE');
      if(!prior){
        const result={status:'SUCCEEDED',episode_id:FIRST_IMAGE_EPISODE,stage_id:'IMAGE',artifacts:[structuredClone(a)],
          provider_job_ids:[j.provider_request_id],claims:[attempt],qa:structuredClone(f.technical_qa),
          human_review_requirement:false,estimated_cost:{currency:'USD',usd:f.estimated_cost_usd},actual_cost:null,
          output:{imported_original:true,human_review:structuredClone(review)}};
        validateStageResult(result,FIRST_IMAGE_EPISODE,'IMAGE');
        await manager.checkpoint(FIRST_IMAGE_EPISODE,d=>{
          const old=d.metadata.imported_stage_sources?.['image:q41'];
          if(old){if(inputDigest(old)!==sourceBinding)throw Error('EP004_IMPORT_IMMUTABLE');return;}
          const action=d.actions.find(x=>x.key==='image:q41');
          if(d.metadata.activation_context?.operation_id!==EP004_IMPORT_OP||action?.dispatch_state!=='NOT_DISPATCHED'
            ||d.metadata.stage_results?.['image:q41']||d.metadata.budget_reservations?.['image:q41'])throw Error('EP004_IMPORT_CONFLICT');
          d.metadata.imported_stage_sources={'image:q41':source};
          d.metadata.stage_results||={};d.metadata.stage_results['image:q41']={receipt_id:attempt,
            hash_version:'CANONICAL_JSON_V1',sha256:inputDigest(result),result};
          d.metadata.artifacts||={};d.metadata.artifacts[a.artifact_id]=structuredClone(a);
          d.metadata.stage_qa||={};d.metadata.stage_qa['image:q41']=structuredClone(f.technical_qa);
          const reviewId=sha256(JSON.stringify([FIRST_IMAGE_EPISODE,'image:q41',a.artifact_id,a.sha256]));
          d.metadata.review_requests||={};d.metadata.review_requests[reviewId]={review_request_id:reviewId,
            episode_id:FIRST_IMAGE_EPISODE,stage_id:'IMAGE',action_key:'image:q41',artifact_id:a.artifact_id,
            artifact_sha:a.sha256,review_version:review.review_version,status:'APPROVED',human_decision:structuredClone(review),
            original_review_checkpoint:FIRST_IMAGE_OPERATION,allowed_actions:[]};
          Object.assign(action,{status:'COMPLETE',dispatch_state:'RESULT_RECOVERED',provider_request_id:j.provider_request_id,
            artifact:structuredClone(a),estimated_cost_usd:f.estimated_cost_usd,
            evidence:{provider_succeeded:true,artifact_persisted:true,sha_verified:true,artifact_verified:true}});
          // The budget gate already includes target_episode source exposure.
          // This is a reference, not another reservation or confirmed charge.
          d.metadata.episode_ledger.entries['image:q41']={estimated_cost:{currency:'USD',usd:f.estimated_cost_usd},
            actual_cost:null,confirmed_usd:0,reserved_usd:0,reservation_reference:{episode_id:FIRST_IMAGE_OPERATION,action_key:'image:q41'}};
          d.metadata.provider_generation_authorized=false;d.metadata.publication_enabled=false;
          d.runner_enabled=false;d.autorun=false;
        });
      }
      await inject({point:'EP004_AFTER_IMPORT'});
      const state=await manager.store.getEpisode(FIRST_IMAGE_EPISODE),current=await reviewStore.get(command.user);
      const e=current.state.episodes[FIRST_IMAGE_EPISODE];
      if(e.binding_sha!==state.metadata.generic_v2.binding_sha)throw Error('EP004_IMPORT_IMMUTABLE');
      const projection={artifact_sha:a.sha256,source_checkpoint:FIRST_IMAGE_OPERATION,provider_request_id:j.provider_request_id,
        human_status:'HUMAN_APPROVED',estimated_usd:f.estimated_cost_usd,reserved_usd:cp.metadata.budget_reservations?.['image:q41']?.amount_usd??0,
        actual_usd:f.actual_cost_usd??null,hard_budget_usd:5,provider_generation_authorized:false};
      const importedReview=Object.values(state.metadata.review_requests).find(r=>r.action_key==='image:q41');
      if(inputDigest(e.q41_import??null)!==inputDigest(projection)||!e.review_requests[importedReview.review_request_id]){
        e.q41_import=projection;e.artifacts[a.artifact_id]=structuredClone(a);
        e.review_requests[importedReview.review_request_id]=structuredClone(importedReview);
        await reviewStore.cas(command.user,current.revision,current.state);
      }
      await projectCheckpoint(command.user,FIRST_IMAGE_EPISODE);
      return {status:'EP004_CREATED_Q41_IMPORTED',episode_id:FIRST_IMAGE_EPISODE,artifact_sha:a.sha256,
        first_pending_action:state.first_pending_action,already_applied:!!prior,provider_calls:0,commands:[]};
    }catch(error){if(!['concurrent_update','STALE_CHECKPOINT'].includes(error.message)||retry===3)throw error;}
  };
  adapter.firstImageAction=async({command})=>{
    if(env.LUMI_RUNTIME_ENV!=='staging')throw Error('Q41_STAGING_ONLY');
    const selected=(await reviewStore.get(command?.user))?.state.tokens?.[command?.token];
    if(selected?.action==='q41_video_authorize')return {...await adapter.authorizeEp004VideoQuote({command}),
      next_screen:{kind:'progress',episode_id:FIRST_IMAGE_EPISODE}};
    const {token}=await authority.firstImageCommand(command,['q41_budget','q41_refill','q41_confirm','q41_status','q41_approve','q41_reject','q41_continue']);
    if(token.action==='q41_budget'){
      if(!env.HF_API_KEY||await manager.store.getEpisode(FIRST_IMAGE_OPERATION)||await journal.get(FIRST_IMAGE_OPERATION))throw Error('Q41_CONFIRMATION_STALE');
      await authority.approveSupervisedBudget({command,secret:env.LUMI_TELEGRAM_CALLBACK_SECRET,apiKeySha:sha256(env.HF_API_KEY)});
      return firstImageStatus({user:command.user});
    }
    if(token.action==='q41_continue'){
      const cp=await manager.store.getEpisode(FIRST_IMAGE_OPERATION),f=cp?.metadata.first_image;
      if(cp?.metadata.user!==command.user||f?.review?.status!=='APPROVED'||f.artifact?.sha256!==token.artifact_sha)
        throw Error('Q41_REVIEW_STALE');
      const episode=await manager.store.getEpisode(FIRST_IMAGE_EPISODE),row=await reviewStore.get(command.user);
      const source=episode?.metadata.stage_results?.['image:q41']?.result;
      if(episode?.metadata.user!==command.user||!row.state.episodes[FIRST_IMAGE_EPISODE]
        ||source?.artifacts?.[0]?.sha256!==f.artifact.sha256||!source.provider_job_ids?.includes(f.accepted?.request_id)){
        await manager.checkpoint(FIRST_IMAGE_OPERATION,s=>{s.metadata.first_image.blocker='Q41_EPISODE_CONTINUATION_NOT_AUTHORIZED';});
        return firstImageStatus({user:command.user});
      }
      // Navigation only. The existing continuation button still validates its
      // own current authorization, FIRST_PENDING_ACTION, reviews and budget.
      return {...await firstImageStatus({user:command.user}),next_screen:{kind:'progress',episode_id:FIRST_IMAGE_EPISODE}};
    }
    if(token.action==='q41_refill')return confirmFirstImage({command,recovery:true});
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
