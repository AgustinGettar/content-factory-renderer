import {verifyRequest} from './telegram-review-v1/make-transport.js';
import {sha256} from './telegram-review-v1/core.js';
import {stableStringify} from './cinematic-director-v1/PROMPT_COMPILER_V3.mjs';
import {LUMI_PRODUCTION_PROFILE_V2 as profile,PROFILE_SHA} from './lumi-production-profile-v2.js';

const authenticated = new WeakSet(), capabilities = new WeakSet();
export const inputDigest = value => sha256(stableStringify(JSON.parse(JSON.stringify(value))));

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
    if(scope==='CREATE'&&(!authenticated.has(command)||command.user!==String(user)||command.chat!==String(chat)
      ||command.episode_id!==episodeId||command.operation_id!==operationId||command.authorization_id!==authorizationId
      ||command.request_sha!==requestSha||command.requested_profile!==profile.id))throw Error('CONTROLLED_ACTIVATION_REQUIRED');
    const row=await this.store.get(user),s=row?.state,g=s?.v2_authorizations?.[authorizationId];
    // Grants are server-owned records in the existing CAS session, never copied
    // from activation/readiness in the callback body. No grant-creation endpoint.
    if(!s||s.user_id!==String(user)||s.chat_id!==String(chat)||!await this.validateOwner(user,chat)
      ||!g||g.status!=='AUTHORIZED'||g.user_id!==String(user)||g.chat_id!==String(chat)
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
