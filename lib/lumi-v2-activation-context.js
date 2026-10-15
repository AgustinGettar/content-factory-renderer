import {SUPERVISED_BUDGET_POLICY} from './higgsfield-usd-budget-v1.js';
import {verifyRequest,scopedEnabled} from './telegram-review-v1/make-transport.js';
import {createHmac,timingSafeEqual} from 'node:crypto';
import {sha256} from './telegram-review-v1/core.js';
import {stableStringify} from './cinematic-director-v1/PROMPT_COMPILER_V3.mjs';
import {LUMI_PRODUCTION_PROFILE_V2 as profile,PROFILE_SHA} from './lumi-production-profile-v2.js';
import {assertMiniPrincipal} from './telegram-mini-app/auth.js';

const authenticated = new WeakSet(), capabilities = new WeakSet();
const diagnosticCommands=new WeakSet(), diagnosticStores=new WeakMap();
const firstImageCommands=new WeakSet();
const miniAppCommands=new WeakSet();
export function authenticateMiniAppCommand({principal,operationId}){
  assertMiniPrincipal(principal);
  const command=Object.freeze({user:principal.user,chat:principal.chat,message_id:null,
    channel:'TELEGRAM_MINI_APP',principal,session_id:principal.session,token:operationId,
    operation_id:operationId,callback_id:null,nonce:operationId});
  miniAppCommands.add(command);return command;
}
export function currentCommandTransport(state,command){
  if(miniAppCommands.has(command)){
    const session=state.mini_app?.sessions?.[command.session_id],op=state.mini_app?.operations?.[command.operation_id];
    return session?.expires_at>Date.now()&&session.user===command.user&&session.chat===command.chat
      &&op?.session_id===command.session_id&&op.status==='RUNNING';
  }
  return state.delivery?.status==='DELIVERED'&&state.delivery.tokens?.includes(command.token)&&!state.pending_callback;
}
const episodeImportCommands=new WeakSet();
export const EP004_IMPORT_OP='CREATE_EP004_FROM_APPROVED_Q41';
export const EP004_IMPORT_AUTH='LUMI_EP004_COMPLETE_AV2_CONTRACT_Q41_IMPORT_20261014';
export function authenticateEp004Import({env,signed,signature}){
  verifyRequest(env.LUMI_TELEGRAM_CALLBACK_SECRET,signed,signature);
  const body=JSON.parse(signed.body.toString());
  if(env.LUMI_RUNTIME_ENV!=='staging'||signed.method!=='POST'||signed.path!=='/lumi/telegram-review/make/v1'
    ||body.op!==EP004_IMPORT_OP||body.authorization_reference!==EP004_IMPORT_AUTH||body.provider_generation!==false
    ||Object.keys(body).some(k=>!['op','user_id','chat_id','authorization_reference','provider_generation'].includes(k))
    ||!scopedEnabled(env,String(body.user_id),String(body.chat_id)))throw Error('EP004_IMPORT_AUTH_REQUIRED');
  const command=Object.freeze({user:String(body.user_id),chat:String(body.chat_id),authorization_reference:EP004_IMPORT_AUTH,nonce:signed.requestId});
  episodeImportCommands.add(command);return command;
}
export function assertEp004ImportCommand(command){if(!episodeImportCommands.has(command))throw Error('EP004_IMPORT_AUTH_REQUIRED');}
export const FIRST_IMAGE_SCOPE='EP004_Q41_FIRST_IMAGE';
export const FIRST_IMAGE_EPISODE='ep_lumi_granja_004_20261008_ee7ab4b3';
export function studioEpisodeId(state){
  const id=state.mini_app?.active_episode_id||FIRST_IMAGE_EPISODE;
  const e=state.episodes?.[id];
  if(!e||e.pipeline!==profile.id)throw Error('MINI_EPISODE_REQUIRED');
  return id;
}
export const FIRST_IMAGE_OPERATION='ep004_q41_first_image';
export function durableTtsDecision(quote,decision){
  return quote?.action_key==='tts'&&quote.currency==='ELEVENLABS_CHARACTER_QUOTA'
    &&decision?.continuation_scope==='FROZEN_TTS_REQUEST_SET_V1'
    &&decision.maximum_quota_units===quote.quota_units&&decision.maximum_requests===quote.request_count
    &&Number.isSafeInteger(quote.request_count)&&quote.request_count>0&&Number.isSafeInteger(quote.quota_units)&&quote.quota_units>0
    &&decision.max_reservation_usd===0&&quote.proposed_reserve_usd===0;
}
export function authenticateFirstImageCallback({env,signed,signature,panelMessageId}) {
  verifyRequest(env.LUMI_TELEGRAM_CALLBACK_SECRET,signed,signature);
  const body=JSON.parse(signed.body.toString()),cb=body.update?.callback_query||body.callback_query;
  if(env.LUMI_RUNTIME_ENV!=='staging'||signed.method!=='POST'||signed.path!=='/lumi/telegram-review/make/v1'
    ||['prompt','image_urls','source_url','model','payload','input','api_key'].some(k=>k in body||cb&&k in cb)
    ||body.op&&body.op!=='callback'||!cb?.id||!/^lr:[a-f0-9]{24}$/.test(cb.data)
    ||!scopedEnabled(env,String(cb.from?.id),String(cb.message?.chat?.id))
    ||(!Number.isSafeInteger(cb.message?.message_id)||cb.message.message_id<=0||cb.message.message_id!==panelMessageId))throw Error('Q41_HMAC_CALLBACK_REQUIRED');
  const command=Object.freeze({user:String(cb.from.id),chat:String(cb.message.chat.id),message_id:cb.message.message_id,
    callback_id:cb.id,token:cb.data.slice(3),nonce:signed.requestId});
  firstImageCommands.add(command);return command;
}
// Verification only: no endpoint accepts, signs or imports an economic assertion.
// A separately verified server record is required; user-reported balance is not one.
export function verifyFirstImageEvidence(record,secret) {
  if(!secret||!record?.evidence||!(/^[a-f0-9]{64}$/).test(record.seal||''))throw Error('Q41_VERIFIED_PREPAID_EVIDENCE_REQUIRED');
  const expected=createHmac('sha256',secret).update(FIRST_IMAGE_SCOPE+'\n'+inputDigest(record.evidence)).digest('hex');
  if(!timingSafeEqual(Buffer.from(expected),Buffer.from(record.seal)))throw Error('Q41_EVIDENCE_SIGNATURE_INVALID');
  const e=record.evidence;
  // The signature authenticates a trusted server review, not the truth of a
  // user assertion. The private proof bytes are verified by the runtime too.
  if(e.verification_method!=='BILLING_REVIEW'||e.billing_origin!=='https://open.higgsfield.ai'
    ||!e.reviewed_by||!e.proof_artifact||e.proof_reference!==e.proof_artifact.sha256)
    throw Error('Q41_BILLING_PROOF_REQUIRED');
  return structuredClone(record.evidence);
}
export function verifySupervisedPolicy(record,secret,{user,chat,apiKeySha,panelIds,now=Date.now()}) {
  const p=record?.policy;
  if(!secret||!p||!(/^[a-f0-9]{64}$/).test(record.seal||''))throw Error('Q41_SUPERVISED_POLICY_REQUIRED');
  const expected=createHmac('sha256',secret).update(SUPERVISED_BUDGET_POLICY+'\n'+inputDigest(p)).digest('hex');
  if(!timingSafeEqual(Buffer.from(expected),Buffer.from(record.seal))||p.version!==SUPERVISED_BUDGET_POLICY
    ||p.user!==user||p.chat!==chat||(!Number.isSafeInteger(p.message_id)||p.message_id<=0||panelIds&&!panelIds.includes(p.message_id))||p.episode_id!==FIRST_IMAGE_EPISODE
    ||p.api_key_sha256!==apiKeySha||p.hard_episode_budget_usd!==5||p.max_request_reservation_usd!==5||p.max_q41_reservation_usd!==0.5
    ||p.provider_charge_guaranteed!==false||p.billing_verified!==false||!p.callback_query_id
    ||!Number.isFinite(Date.parse(p.expires_at))||Date.parse(p.expires_at)<=now)throw Error('Q41_SUPERVISED_POLICY_INVALID');
  return structuredClone(p);
}
export const DIAGNOSTIC_OP='ISOLATED_V2_VALIDATION';
export const DIAGNOSTIC_SCOPE='LUMI_V2_FIVE_GATES_DRY_RUN';
export const DIAGNOSTIC_TTS_SCOPE='LUMI_V2_TTS_PREFLIGHT_DRY_RUN';
export const DIAGNOSTIC_USD_SCOPE='LUMI_EP004_USD_PREFLIGHT_DRY_RUN';
export const DIAGNOSTIC_Q41_SCOPE='EP004_Q41_IMAGE_QUOTE';
// v1 is historical and recoverable only through the existing signed GET.
export const DIAGNOSTIC_Q41_KEY='ep004:q41:source-bound-quote:v2';
export const DIAGNOSTIC_TTL_MS=15*60*1000;
export const diagnosticOperationId=(user,key,scope=DIAGNOSTIC_SCOPE)=>'diag_v2_'+sha256(JSON.stringify([scope,String(user),key]));
export const inputDigest = value => sha256(stableStringify(JSON.parse(JSON.stringify(value))));

// This is an extension of the existing activation authority, not a user or
// Telegram session. Every phase must enter through the same signed endpoint.
export function authenticateDiagnosticCommand({env,signed,signature,now=Date.now()}) {
  verifyRequest(env.LUMI_TELEGRAM_CALLBACK_SECRET,signed,signature,now);
  if(signed.method!=='POST'||signed.path!=='/lumi/telegram-review/make/v1')throw Error('DIAGNOSTIC_AUTH_REQUIRED');
  const body=JSON.parse(signed.body.toString()),fields=['op','user_id','chat_id','operation_id','idempotency_key',
    'scope','audience','expires_at','dry_run','provider_generation','publication','telegram_mutation','phase','request','decision'];
  const ttsOnly=body.scope===DIAGNOSTIC_TTS_SCOPE,usdOnly=body.scope===DIAGNOSTIC_USD_SCOPE,q41Only=body.scope===DIAGNOSTIC_Q41_SCOPE;
  if(body.op!==DIAGNOSTIC_OP||Object.keys(body).some(k=>!fields.includes(k))
    ||!['CONTEXT','CREATE','RESUME','REVIEW','RESULT','STATUS','TTS_PREFLIGHT','USD_PREFLIGHT',DIAGNOSTIC_Q41_SCOPE].includes(body.phase)
    ||(body.phase==='CONTEXT'&&!ttsOnly&&!usdOnly&&!q41Only)!==(body.request!==undefined)
    ||(body.phase==='REVIEW')!==(body.decision!==undefined)
    ||body.phase==='REVIEW'&&!['APPROVED','REJECTED'].includes(body.decision))throw Error('DIAGNOSTIC_PAYLOAD_INVALID');
  const requester=String(body.user_id),requesterChat=String(body.chat_id);
  if(!scopedEnabled(env,requester,requesterChat)||body.audience!=='staging'||![DIAGNOSTIC_SCOPE,DIAGNOSTIC_TTS_SCOPE,DIAGNOSTIC_USD_SCOPE,DIAGNOSTIC_Q41_SCOPE].includes(body.scope)
    ||(q41Only?!['CONTEXT',DIAGNOSTIC_Q41_SCOPE,'STATUS'].includes(body.phase):usdOnly?!['CONTEXT','USD_PREFLIGHT','STATUS'].includes(body.phase):ttsOnly?!['CONTEXT','TTS_PREFLIGHT','STATUS'].includes(body.phase):['TTS_PREFLIGHT','USD_PREFLIGHT',DIAGNOSTIC_Q41_SCOPE].includes(body.phase))
    ||body.dry_run!==true||body.provider_generation!==false||body.publication!==false||body.telegram_mutation!==false)
    throw Error('DIAGNOSTIC_SCOPE_DENIED');
  if(q41Only&&body.idempotency_key!==DIAGNOSTIC_Q41_KEY)throw Error('DIAGNOSTIC_OPERATION_MISMATCH');
  if(typeof body.idempotency_key!=='string'||!/^[a-z][a-zA-Z0-9_.:-]{7,95}$/.test(body.idempotency_key)||body.idempotency_key===signed.requestId
    ||body.operation_id!==diagnosticOperationId(requester,body.idempotency_key,body.scope))throw Error('DIAGNOSTIC_OPERATION_MISMATCH');
  const expires=Date.parse(body.expires_at);
  if(typeof body.expires_at!=='string'||!Number.isFinite(expires)||expires<=now||expires>now+DIAGNOSTIC_TTL_MS)
    throw Error('DIAGNOSTIC_EXPIRED');
  const suffix=body.operation_id.slice(8),command=Object.freeze({...body,request:undefined,
    requester,requesterChat,user:'diagnostic:'+suffix,chat:null,message_id:null,
    episode_id:'diag_ep_'+suffix.slice(0,56),authorization_id:'diag_auth_'+suffix,
    requested_profile:profile.id,nonce:signed.requestId,body_sha:sha256(signed.body),
    request_sha:body.request?inputDigest(body.request):null});
  diagnosticCommands.add(command);return {command,request:body.request};
}

export function diagnosticGrant(command,requestSha) {
  if(!diagnosticCommands.has(command))throw Error('DIAGNOSTIC_AUTH_REQUIRED');
  return {diagnostic:true,status:'AUTHORIZED',version:1,user_id:command.user,chat_id:null,message_id:null,
    operation_id:command.operation_id,episode_id:command.episode_id,profile_id:profile.id,profile_version:profile.version,
    profile_sha:PROFILE_SHA,request_sha:requestSha,scopes:command.scope===DIAGNOSTIC_Q41_SCOPE?[DIAGNOSTIC_Q41_SCOPE]:command.scope===DIAGNOSTIC_USD_SCOPE?['USD_PREFLIGHT']:command.scope===DIAGNOSTIC_TTS_SCOPE?['TTS_PREFLIGHT']:['CREATE','RESUME','REVIEW'],readiness_status:'DIAGNOSTIC_ONLY',
    expires_at:command.expires_at,audience:'staging',diagnostic_scope:command.scope,dry_run:true,
    provider_generation:false,publication:false,telegram_mutation:false,authorized_ceiling_usd:0};
}

export function bindDiagnosticAuthorizationStore(store,command) {
  if(!diagnosticCommands.has(command))throw Error('DIAGNOSTIC_AUTH_REQUIRED');
  diagnosticStores.set(store,command);
}

// Only the canonical HMAC endpoint can establish this in-process capability.
// Neither a JSON boolean nor a serialized copy is an authenticated command.
export function authenticateV2Command({secret,signed,signature}) {
  verifyRequest(secret,signed,signature);
  const body=JSON.parse(signed.body.toString());
  if(body.op!=='create_v2')throw Error('CONTROLLED_ACTIVATION_REQUIRED');
  const command=Object.freeze({user:String(body.user_id),chat:String(body.chat_id),
    message_id:body.message_id,operation_id:body.operation_id,authorization_id:body.authorization_id,
    episode_id:body.request?.episodePlan?.episode?.id,request_sha:inputDigest(body.request),
    requested_profile:body.requested_profile,nonce:signed.requestId});
  authenticated.add(command);return command;
}

export class ControlledV2Authorization {
  constructor({store,validateOwner,clock=()=>Date.now()}){Object.assign(this,{store,validateOwner,clock});}
  // A callback capability is scoped to one immutable server quote. It never
  // changes the episode-wide generation flag or authorizes the next action.
  async authorizeLocalStage({command,checkpoint}){
    const {row,token}=await this.firstImageCommand(command,['q41_local_continue']);
    const action=checkpoint.actions.find(a=>a.key===checkpoint.first_pending_action);
    if(!currentCommandTransport(row.state,command)
      ||checkpoint.episode_id!==token.proposal_id||checkpoint.metadata.user!==command.user||checkpoint.status!=='RUNNING'
      ||token.next_action!==action?.key||token.checkpoint_version!==checkpoint.metadata.runtime_revision
      ||['IMAGE','VIDEO','TTS'].includes(action.stage))throw Error('Q41_LOCAL_CONTINUATION_REQUIRED');
    const context=Object.freeze({user:command.user,chat:command.chat,message_id:command.message_id,
      episode_id:checkpoint.episode_id,profile_sha:PROFILE_SHA,scope:'RESUME',dry_run:false,
      authorized_ceiling_usd:5,expires_at:new Date(this.clock()+60000).toISOString(),request_sha:checkpoint.metadata.generic_v2.binding_sha,
      action_key:action.key,provider_generation:false,explicit_user_authorization:true});
    capabilities.add(context);return context;
  }
  async authorizeQuotedStage({command,quote,receiptSha,requestSha}){
    const {row,token}=await this.firstImageCommand(command,['q41_video_generate','q41_stage_recover']);
    const receipt=row.state.production_commands?.[quote.quote_id],decision=receipt?.human_authorization;
    const durableContinuation=token.action==='q41_stage_recover'&&durableTtsDecision(quote,decision);
    if(!currentCommandTransport(row.state,command)||token.quote_id!==quote.quote_id||token.quote_sha!==receiptSha
      ||receipt?.result_sha!==receiptSha||inputDigest(receipt.result)!==receiptSha
      ||decision?.decision!=='APPROVED'||decision.user!==command.user||decision.quote_sha!==receiptSha
      ||decision.payload_sha256!==quote.payload_sha256||decision.max_reservation_usd!==quote.proposed_reserve_usd
      ||!Number.isFinite(Date.parse(quote.expires_at))||!durableContinuation&&Date.parse(quote.expires_at)<=this.clock()||quote.episode_id!==token.proposal_id
      ||token.next_action&&quote.action_key!==token.next_action||row.state.episodes[quote.episode_id]?.binding_sha!==requestSha
      ||!/^((image|video):[A-Za-z0-9_-]+|tts)$/.test(quote.action_key))throw Error('Q41_STAGE_AUTHORIZATION_REQUIRED');
    const context=Object.freeze({user:command.user,chat:command.chat,message_id:command.message_id,
      episode_id:quote.episode_id,profile_sha:PROFILE_SHA,scope:'RESUME',dry_run:false,
      authorized_ceiling_usd:5,expires_at:durableContinuation?new Date(this.clock()+60000).toISOString():quote.expires_at,request_sha:requestSha,
      action_key:quote.action_key,stage_authorization_id:quote.quote_id,payload_sha256:quote.payload_sha256,
      provider_generation:true,explicit_user_authorization:true});
    capabilities.add(context);return context;
  }
  async authorizeEp004Import({command,request,sourceBinding}){
    if(!episodeImportCommands.has(command))throw Error('EP004_IMPORT_AUTH_REQUIRED');
    const requestSha=inputDigest(request),authorizationId=EP004_IMPORT_AUTH,operationId=EP004_IMPORT_OP;
    for(let i=0;i<4;i++){
      const row=await this.store.get(command.user),s=row?.state;
      if(!s||s.user_id!==command.user||s.chat_id!==command.chat||!await this.validateOwner(command.user,command.chat)
        ||s.delivery?.status!=='DELIVERED'||!Number.isSafeInteger(s.message_id)
        ||request.episodePlan.episode.id!==FIRST_IMAGE_EPISODE)throw Error('EP004_IMPORT_OWNER_OR_DELIVERY_REQUIRED');
      const old=s.v2_authorizations?.[authorizationId];
      if(old&&(old.source_binding!==sourceBinding||old.request_sha!==requestSha||old.provider_generation!==false
        ||old.authorized_ceiling_usd!==5||old.operation_id!==operationId))throw Error('EP004_IMPORT_AUTH_IMMUTABLE');
      if(!old){
        s.v2_authorizations||={};s.v2_authorizations[authorizationId]={status:'AUTHORIZED',version:1,
          user_id:command.user,chat_id:command.chat,message_id:s.message_id,episode_id:FIRST_IMAGE_EPISODE,
          operation_id:operationId,profile_id:profile.id,profile_version:profile.version,profile_sha:PROFILE_SHA,
          request_sha:requestSha,source_binding:sourceBinding,scopes:['CREATE','RESUME'],readiness_status:'CREATE_AND_LOCAL_ONLY',
          dry_run:false,provider_generation:false,publication:false,authorized_ceiling_usd:5,
          authorization_reference:command.authorization_reference,authorized_at:new Date(this.clock()).toISOString(),
          expires_at:new Date(this.clock()+24*3600000).toISOString()};
        try{await this.store.cas(command.user,row.revision,s);}catch(e){if(e.message==='concurrent_update')continue;throw e;}
      }
      const create=Object.freeze({user:command.user,chat:command.chat,message_id:s.message_id,episode_id:FIRST_IMAGE_EPISODE,
        authorization_id:authorizationId,operation_id:operationId,request_sha:requestSha,requested_profile:profile.id});
      authenticated.add(create);
      return this.authorize({user:command.user,chat:command.chat,episodeId:FIRST_IMAGE_EPISODE,
        authorizationId,operationId,requestSha,scope:'CREATE',command:create});
    }
    throw Error('concurrent_update');
  }
  async balanceCommand(command){
    if(!firstImageCommands.has(command))throw Error('BALANCE_HMAC_CALLBACK_REQUIRED');
    const row=await this.store.get(command.user),s=row?.state,t=s?.tokens?.[command.token];
    if(!s||s.user_id!==command.user||s.chat_id!==command.chat||s.message_id!==command.message_id
      ||!await this.validateOwner(command.user,command.chat)||t?.action!=='balance_reloaded'
      ||!s.delivery?.tokens?.includes(command.token)||s.delivery.status!=='DELIVERED'
      ||!s.episodes[t.episode_id]||!t.attempt_id||!t.next_action)throw Error('BALANCE_CALLBACK_SCOPE_INVALID');
    return {row,token:t};
  }
  async firstImageCommand(command,actions){
    if(miniAppCommands.has(command)){
      assertMiniPrincipal(command.principal);
      const row=await this.store.get(command.user),s=row?.state,token=s?.mini_app?.operations?.[command.operation_id]?.binding;
      if(!s||s.user_id!==command.user||s.chat_id!==command.chat||!await this.validateOwner(command.user,command.chat)
        ||!currentCommandTransport(s,command)||!actions.includes(token?.action)||token.proposal_id!==studioEpisodeId(s))
        throw Error('MINI_COMMAND_SCOPE_INVALID');
      return {row,token};
    }
    if(!firstImageCommands.has(command))throw Error('Q41_HMAC_CALLBACK_REQUIRED');
    const row=await this.store.get(command.user),s=row?.state,t=s?.tokens?.[command.token];
    if(!s||s.user_id!==command.user||s.chat_id!==command.chat||s.message_id!==command.message_id
      ||!await this.validateOwner(command.user,command.chat)||!actions.includes(t?.action)
      ||t.proposal_id!==FIRST_IMAGE_EPISODE)throw Error('Q41_CALLBACK_SCOPE_INVALID');
    return {row,token:t};
  }
  async approveSupervisedBudget({command,secret,apiKeySha}){
    const {row}=await this.firstImageCommand(command,['q41_budget']),s=row.state;
    if(s.delivery?.status!=='DELIVERED'||!s.delivery.tokens?.includes(command.token)
      ||s.screen?.kind!=='q41_confirm'||s.v2_authorizations?.[FIRST_IMAGE_OPERATION])throw Error('Q41_CONFIRMATION_STALE');
    const policy={version:SUPERVISED_BUDGET_POLICY,user:command.user,chat:command.chat,message_id:command.message_id,
      episode_id:FIRST_IMAGE_EPISODE,api_key_sha256:apiKeySha,hard_episode_budget_usd:5,max_request_reservation_usd:5,max_q41_reservation_usd:0.5,
      provider_charge_guaranteed:false,billing_verified:false,approved_at:new Date(this.clock()).toISOString(),
      expires_at:new Date(this.clock()+3600000).toISOString(),callback_query_id:command.callback_id};
    s.q41_supervised_policy={policy,seal:createHmac('sha256',secret).update(SUPERVISED_BUDGET_POLICY+'\n'+inputDigest(policy)).digest('hex')};
    await this.store.cas(command.user,row.revision,s);
  }
  async claimFirstImageConfirmation({command,binding,ceilingUsd,expiresAt,recovery=null}){
    const {row,token}=await this.firstImageCommand(command,[recovery?'q41_refill':'q41_confirm']),s=row.state;
    if(s.screen?.kind!=='q41_confirm'||!s.delivery?.tokens?.includes(command.token)||s.delivery.status!=='DELIVERED'
      ||token.binding_sha!==(recovery?.binding??binding)||(!recovery&&token.expires_at!==expiresAt)||Date.parse(expiresAt)<=this.clock()
      ||!Number.isFinite(ceilingUsd)||ceilingUsd<=0||ceilingUsd>5)throw Error('Q41_CONFIRMATION_STALE');
    const id=FIRST_IMAGE_OPERATION;
    // A new callback/nonce never renews or replaces a consumed grant.
    if(recovery){
      if(token.attempt_id!==recovery.attempt_id||s.q41_first_image?.status!=='PAUSED_INSUFFICIENT_BALANCE'
        ||s.q41_first_image.attempt_id!==recovery.attempt_id||!s.v2_authorizations?.[id]
        ||s.v2_authorizations[id].attempt_id&&s.v2_authorizations[id].attempt_id!==recovery.attempt_id)
        throw Error('Q41_RECOVERY_CONFIRMATION_STALE');
      s.q41_authorization_history||={};
      if(s.q41_authorization_history[recovery.attempt_id])throw Error('Q41_RECOVERY_ALREADY_CLAIMED');
      s.q41_authorization_history[recovery.attempt_id]=s.v2_authorizations[id];
    }else if(s.v2_authorizations?.[id])throw Error('Q41_AUTHORIZATION_ALREADY_ISSUED');
    const grant={attempt_id:recovery?.next_attempt_id??id,authorization_id:id,version:1,status:'PREFLIGHT_CLAIMED',scope:FIRST_IMAGE_SCOPE,scopes:[FIRST_IMAGE_SCOPE],
      user:command.user,chat:command.chat,message_id:command.message_id,episode_id:FIRST_IMAGE_EPISODE,shot_id:'q41',
      operation_id:id,request_sha:binding,profile_sha:PROFILE_SHA,dry_run:false,
      maximum_provider_emissions:1,authorized_ceiling_usd:ceilingUsd,expires_at:expiresAt,
      callback_query_id:command.callback_id,nonce:command.nonce};
    s.v2_authorizations||={};s.v2_authorizations[id]=grant;
    await this.store.cas(command.user,row.revision,s);
    return structuredClone(grant);
  }
  async authorizeFirstImage({command,binding,confirmationBinding,ceilingUsd,expiresAt}){
    const {row}=await this.firstImageCommand(command,['q41_confirm','q41_refill']),s=row.state,g=s.v2_authorizations?.[FIRST_IMAGE_OPERATION];
    if(!g||g.status!=='PREFLIGHT_CLAIMED'||g.request_sha!==confirmationBinding
      ||g.callback_query_id!==command.callback_id||g.nonce!==command.nonce
      ||ceilingUsd>g.authorized_ceiling_usd||!Number.isFinite(Date.parse(expiresAt))
      ||Date.parse(expiresAt)>Date.parse(g.expires_at)||Date.parse(expiresAt)<=this.clock())throw Error('Q41_CONFIRMATION_STALE');
    const grant={...g,status:'AUTHORIZED',confirmation_sha:confirmationBinding,request_sha:binding,expires_at:expiresAt};
    s.v2_authorizations[FIRST_IMAGE_OPERATION]=grant;
    await this.store.cas(command.user,row.revision,s);
    const context=Object.freeze({...grant});capabilities.add(context);return context;
  }
  async authorize({user,chat,episodeId,operationId,authorizationId,scope,requestSha,command}) {
    if(![episodeId,operationId,authorizationId].every(v=>typeof v==='string'&&/^[A-Za-z0-9_:-]{1,128}$/.test(v)))throw Error('CONTROLLED_ACTIVATION_REQUIRED');
    const diagnostic=diagnosticStores.get(this.store);
    if(diagnostic){
      const row=await this.store.get(user),g=row?.state.v2_authorizations?.[authorizationId];
      if(!diagnosticCommands.has(diagnostic)||!['CREATE','RESUME','REVIEW'].includes(scope)
        ||scope==='CREATE'&&command!==diagnostic||diagnostic.user!==user||chat!==null
        ||episodeId!==diagnostic.episode_id||operationId!==diagnostic.operation_id||authorizationId!==diagnostic.authorization_id
        ||row?.state.user_id!==user||row?.state.chat_id!==null||row?.state.message_id!==null
        ||!g||inputDigest(g)!==inputDigest(diagnosticGrant(diagnostic,requestSha))
        ||scope==='CREATE'&&diagnostic.phase!=='CREATE'||scope==='RESUME'&&diagnostic.phase!=='RESUME'
        ||scope==='REVIEW'&&diagnostic.phase!=='REVIEW'
        ||Date.parse(g.expires_at)<=this.clock()||!await this.validateOwner(user,chat))throw Error('CONTROLLED_ACTIVATION_REQUIRED');
      const context=Object.freeze({...g,authorization_id:authorizationId,authorization_version:g.version,
        user,chat:null,message_id:null,scope,explicit_user_authorization:true});
      capabilities.add(context);return context;
    }
    if(scope==='CREATE'&&(!authenticated.has(command)||command.user!==String(user)||command.chat!==String(chat)
      ||command.episode_id!==episodeId||command.operation_id!==operationId||command.authorization_id!==authorizationId
      ||command.request_sha!==requestSha||command.requested_profile!==profile.id))throw Error('CONTROLLED_ACTIVATION_REQUIRED');
    const row=await this.store.get(user),s=row?.state,g=s?.v2_authorizations?.[authorizationId];
    // Grants are server-owned records in the existing CAS session, never copied
    // from activation/readiness in the callback body. No grant-creation endpoint.
    if(!s||s.user_id!==String(user)||s.chat_id!==String(chat)||!await this.validateOwner(user,chat)
      ||!g||g.diagnostic===true||g.status!=='AUTHORIZED'||g.user_id!==String(user)||g.chat_id!==String(chat)
      ||(g.message_id!==s.message_id&&!Object.hasOwn(s.panel_history||{},String(g.message_id)))||scope==='CREATE'&&command.message_id!==s.message_id
      ||g.operation_id!==operationId||g.episode_id!==episodeId||g.profile_id!==profile.id
      ||g.profile_version!==profile.version||g.profile_sha!==PROFILE_SHA||g.request_sha!==requestSha
      ||!Number.isSafeInteger(g.version)||g.version<1||!Number.isFinite(Date.parse(g.expires_at))
      ||Date.parse(g.expires_at)<=this.clock()||!Array.isArray(g.scopes)||!g.scopes.includes(scope)
      ||g.scopes.some(s=>!['CREATE','RESUME'].includes(s))||!(g.readiness_status==='PASS'||
        g.readiness_status==='CREATE_AND_LOCAL_ONLY'&&g.operation_id===EP004_IMPORT_OP&&g.provider_generation===false)
      ||typeof g.dry_run!=='boolean'||!Number.isFinite(g.authorized_ceiling_usd)||g.authorized_ceiling_usd<0)
      throw Error('CONTROLLED_ACTIVATION_REQUIRED');
    const context=Object.freeze({authorization_id:authorizationId,authorization_version:g.version,
      user:String(user),chat:String(chat),message_id:s.message_id,episode_id:episodeId,operation_id:operationId,
      request_sha:requestSha,profile_id:profile.id,profile_version:profile.version,profile_sha:PROFILE_SHA,
      scope,dry_run:g.dry_run,authorized_ceiling_usd:g.authorized_ceiling_usd,expires_at:g.expires_at,
      explicit_user_authorization:true,...(g.provider_generation===false?{provider_generation:false}:{} )});
    capabilities.add(context);return context;
  }
}

export function assertV2Context(context,{episodeId,user,scope,dry_run}) {
  if(!capabilities.has(context)||context.episode_id!==episodeId||context.user!==String(user)
    ||context.scope!==scope||context.profile_sha!==PROFILE_SHA||context.dry_run!==dry_run
    ||Date.parse(context.expires_at)<=Date.now())throw Error('CONTROLLED_ACTIVATION_REQUIRED');
  return context;
}
