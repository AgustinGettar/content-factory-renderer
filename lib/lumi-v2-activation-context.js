import {verifyRequest,scopedEnabled} from './telegram-review-v1/make-transport.js';
import {createHmac,timingSafeEqual} from 'node:crypto';
import {sha256} from './telegram-review-v1/core.js';
import {stableStringify} from './cinematic-director-v1/PROMPT_COMPILER_V3.mjs';
import {LUMI_PRODUCTION_PROFILE_V2 as profile,PROFILE_SHA} from './lumi-production-profile-v2.js';

const authenticated = new WeakSet(), capabilities = new WeakSet();
const diagnosticCommands=new WeakSet(), diagnosticStores=new WeakMap();
const firstImageCommands=new WeakSet();
export const FIRST_IMAGE_SCOPE='EP004_Q41_FIRST_IMAGE';
export const FIRST_IMAGE_EPISODE='ep_lumi_granja_004_20261008_ee7ab4b3';
export const FIRST_IMAGE_OPERATION='ep004_q41_first_image';
export function authenticateFirstImageCallback({env,signed,signature}) {
  verifyRequest(env.LUMI_TELEGRAM_CALLBACK_SECRET,signed,signature);
  const body=JSON.parse(signed.body.toString()),cb=body.update?.callback_query||body.callback_query;
  if(env.LUMI_RUNTIME_ENV!=='staging'||signed.method!=='POST'||signed.path!=='/lumi/telegram-review/make/v1'
    ||['prompt','image_urls','source_url','model','payload','input','api_key'].some(k=>k in body||cb&&k in cb)
    ||body.op&&body.op!=='callback'||!cb?.id||!/^lr:[a-f0-9]{24}$/.test(cb.data)
    ||!scopedEnabled(env,String(cb.from?.id),String(cb.message?.chat?.id))
    ||cb.message?.message_id!==138)throw Error('Q41_HMAC_CALLBACK_REQUIRED');
  const command=Object.freeze({user:String(cb.from.id),chat:String(cb.message.chat.id),message_id:138,
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
  async firstImageCommand(command,actions){
    if(!firstImageCommands.has(command))throw Error('Q41_HMAC_CALLBACK_REQUIRED');
    const row=await this.store.get(command.user),s=row?.state,t=s?.tokens?.[command.token];
    if(!s||s.user_id!==command.user||s.chat_id!==command.chat||s.message_id!==138
      ||!await this.validateOwner(command.user,command.chat)||!actions.includes(t?.action)
      ||t.proposal_id!==FIRST_IMAGE_EPISODE)throw Error('Q41_CALLBACK_SCOPE_INVALID');
    return {row,token:t};
  }
  async claimFirstImageConfirmation({command,binding,ceilingUsd,expiresAt}){
    const {row,token}=await this.firstImageCommand(command,['q41_confirm']),s=row.state;
    if(s.screen?.kind!=='q41_confirm'||!s.delivery?.tokens?.includes(command.token)||s.delivery.status!=='DELIVERED'
      ||token.binding_sha!==binding||token.expires_at!==expiresAt||Date.parse(expiresAt)<=this.clock()
      ||!Number.isFinite(ceilingUsd)||ceilingUsd<=0||ceilingUsd>5)throw Error('Q41_CONFIRMATION_STALE');
    const id=FIRST_IMAGE_OPERATION;
    // A new callback/nonce never renews or replaces a consumed grant.
    if(s.v2_authorizations?.[id])throw Error('Q41_AUTHORIZATION_ALREADY_ISSUED');
    const grant={authorization_id:id,version:1,status:'PREFLIGHT_CLAIMED',scope:FIRST_IMAGE_SCOPE,scopes:[FIRST_IMAGE_SCOPE],
      user:command.user,chat:command.chat,message_id:138,episode_id:FIRST_IMAGE_EPISODE,shot_id:'q41',
      operation_id:id,request_sha:binding,profile_sha:PROFILE_SHA,dry_run:false,
      maximum_provider_emissions:1,authorized_ceiling_usd:ceilingUsd,expires_at:expiresAt,
      callback_query_id:command.callback_id,nonce:command.nonce};
    s.v2_authorizations||={};s.v2_authorizations[id]=grant;
    await this.store.cas(command.user,row.revision,s);
    return structuredClone(grant);
  }
  async authorizeFirstImage({command,binding,confirmationBinding,ceilingUsd,expiresAt}){
    const {row}=await this.firstImageCommand(command,['q41_confirm']),s=row.state,g=s.v2_authorizations?.[FIRST_IMAGE_OPERATION];
    if(!g||g.status!=='PREFLIGHT_CLAIMED'||g.request_sha!==confirmationBinding
      ||g.callback_query_id!==command.callback_id||g.nonce!==command.nonce
      ||g.authorized_ceiling_usd!==ceilingUsd||!Number.isFinite(Date.parse(expiresAt))
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
      ||g.message_id!==s.message_id||scope==='CREATE'&&command.message_id!==s.message_id
      ||g.operation_id!==operationId||g.episode_id!==episodeId||g.profile_id!==profile.id
      ||g.profile_version!==profile.version||g.profile_sha!==PROFILE_SHA||g.request_sha!==requestSha
      ||!Number.isSafeInteger(g.version)||g.version<1||!Number.isFinite(Date.parse(g.expires_at))
      ||Date.parse(g.expires_at)<=this.clock()||!Array.isArray(g.scopes)||!g.scopes.includes(scope)
      ||g.scopes.some(s=>!['CREATE','RESUME'].includes(s))||g.readiness_status!=='PASS'
      ||typeof g.dry_run!=='boolean'||!Number.isFinite(g.authorized_ceiling_usd)||g.authorized_ceiling_usd<0)
      throw Error('CONTROLLED_ACTIVATION_REQUIRED');
    const context=Object.freeze({authorization_id:authorizationId,authorization_version:g.version,
      user:String(user),chat:String(chat),message_id:s.message_id,episode_id:episodeId,operation_id:operationId,
      request_sha:requestSha,profile_id:profile.id,profile_version:profile.version,profile_sha:PROFILE_SHA,
      scope,dry_run:g.dry_run,authorized_ceiling_usd:g.authorized_ceiling_usd,expires_at:g.expires_at,
      explicit_user_authorization:true});
    capabilities.add(context);return context;
  }
}

export function assertV2Context(context,{episodeId,user,scope,dry_run}) {
  if(!capabilities.has(context)||context.episode_id!==episodeId||context.user!==String(user)
    ||context.scope!==scope||context.profile_sha!==PROFILE_SHA||context.dry_run!==dry_run
    ||Date.parse(context.expires_at)<=Date.now())throw Error('CONTROLLED_ACTIVATION_REQUIRED');
  return context;
}
