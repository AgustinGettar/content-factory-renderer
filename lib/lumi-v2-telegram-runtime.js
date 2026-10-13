import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {GenericLumiV2Adapter} from './lumi-generic-v2-adapter.js';
import {LumiV2ExecutionOrchestrator,ReviewStageReceiptStore} from './lumi-v2-execution-orchestrator.js';
import {ControlledV2Authorization,inputDigest,assertV2Context,verifyFirstImageEvidence,verifySupervisedPolicy,FIRST_IMAGE_SCOPE,FIRST_IMAGE_EPISODE,FIRST_IMAGE_OPERATION} from './lumi-v2-activation-context.js';
import {isolatedQ41Input} from './lumi-isolated-usd-preflight.js';
import {firstImageAccountGate,firstImagePrepaidGate,supervisedRequestGate,SUPERVISED_BUDGET_POLICY,estimateHiggsfieldUsd,sumUsd} from './higgsfield-usd-budget-v1.js';
import {submitSeriesProviderRequest,recoverSeriesProviderResult} from './lumi-series-v2-execution.js';
import {materializeStageArtifact,inspectMaterializedArtifact} from './lumi-artifact-materialization-v2.js';
import {sourceGate} from './lumi-series-v2-gates.js';
import {reconcileStageReview} from './lumi-stage-result-v2.js';
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
  const projectCheckpoint=async(user,episodeId)=>{
    const state=await manager.store.getEpisode(episodeId),row=await reviewStore.get(user),e=row?.state.episodes[episodeId];
    if(!e||state.metadata.user!==user)throw Error('REVIEW_EPISODE_REQUIRED');
    const projection={next_action:state.first_pending_action,first_pending_action:state.first_pending_action,
      last_completed_action:state.last_completed_action,current_stage:state.actions.find(a=>a.key===state.first_pending_action)?.stage||'HUMAN_REVIEW',
      balance_pause:state.status==='PAUSED_INSUFFICIENT_BALANCE'?state.metadata.balance_pause:null,budget_exhausted:state.metadata.budget_exhausted===true,
      resume_available:state.status==='RUNNING'&&!state.metadata.repair_plan_required};
    if(Object.entries(projection).some(([k,v])=>e[k]!==v)){Object.assign(e,projection);await reviewStore.cas(user,row.revision,row.state);}
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
  adapter.firstImageAction=async({command})=>{
    if(env.LUMI_RUNTIME_ENV!=='staging')throw Error('Q41_STAGING_ONLY');
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
