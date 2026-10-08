import {verifyRequest,scopedEnabled} from './telegram-review-v1/make-transport.js';
import {sha256} from './telegram-review-v1/core.js';
import {stableStringify} from './cinematic-director-v1/PROMPT_COMPILER_V3.mjs';
import {LUMI_PRODUCTION_PROFILE_V2 as profile,PROFILE_SHA} from './lumi-production-profile-v2.js';

const authenticated = new WeakSet(), capabilities = new WeakSet();
const diagnosticCommands=new WeakSet(), diagnosticStores=new WeakMap();
export const DIAGNOSTIC_OP='ISOLATED_V2_VALIDATION';
export const DIAGNOSTIC_SCOPE='LUMI_V2_FIVE_GATES_DRY_RUN';
export const DIAGNOSTIC_TTS_SCOPE='LUMI_V2_TTS_PREFLIGHT_DRY_RUN';
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
  const ttsOnly=body.scope===DIAGNOSTIC_TTS_SCOPE;
  if(body.op!==DIAGNOSTIC_OP||Object.keys(body).some(k=>!fields.includes(k))
    ||!['CONTEXT','CREATE','RESUME','REVIEW','RESULT','STATUS','TTS_PREFLIGHT'].includes(body.phase)
    ||(body.phase==='CONTEXT'&&!ttsOnly)!==(body.request!==undefined)
    ||(body.phase==='REVIEW')!==(body.decision!==undefined)
    ||body.phase==='REVIEW'&&!['APPROVED','REJECTED'].includes(body.decision))throw Error('DIAGNOSTIC_PAYLOAD_INVALID');
  const requester=String(body.user_id),requesterChat=String(body.chat_id);
  if(!scopedEnabled(env,requester,requesterChat)||body.audience!=='staging'||![DIAGNOSTIC_SCOPE,DIAGNOSTIC_TTS_SCOPE].includes(body.scope)
    ||(ttsOnly?!['CONTEXT','TTS_PREFLIGHT','STATUS'].includes(body.phase):body.phase==='TTS_PREFLIGHT')
    ||body.dry_run!==true||body.provider_generation!==false||body.publication!==false||body.telegram_mutation!==false)
    throw Error('DIAGNOSTIC_SCOPE_DENIED');
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
    profile_sha:PROFILE_SHA,request_sha:requestSha,scopes:command.scope===DIAGNOSTIC_TTS_SCOPE?['TTS_PREFLIGHT']:['CREATE','RESUME','REVIEW'],readiness_status:'DIAGNOSTIC_ONLY',
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
