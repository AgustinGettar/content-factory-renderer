import { createHmac, timingSafeEqual } from 'node:crypto';
import { sha256, validateArtifact, reviewGate } from './core.js';

export const AUTH_WINDOW_SECONDS = 120;
export const TRANSPORT_AUTHORITY = 'MAKE';
export const COMMAND_METHODS = Object.freeze({
  EDIT_PANEL_TEXT:'editMessageText', EDIT_PANEL_MEDIA:'editMessageMedia',
  EDIT_PANEL_CAPTION:'editMessageCaption', EDIT_PANEL_KEYBOARD:'editMessageReplyMarkup',
  SEND_OR_REUSE_FILE:'editMessageMedia', DOWNLOAD_MASTER:'editMessageMedia',
  ACK_CALLBACK:'answerCallbackQuery'
});
const fail = message => { throw new Error(message); };
export function canonicalRequest({timestamp,requestId,method='POST',path,body}) {
  if(!/^\d{10}$/.test(String(timestamp)) || !/^[\w:-]{1,128}$/.test(requestId) || !/^\/lumi\/telegram-review\/[\w/-]+$/.test(path))fail('invalid_auth_envelope');
  return ['lumi_review:v1',method,path,String(timestamp),requestId,sha256(body)].join('\n');
}
export function signRequest(secret,request) {
  if(typeof secret!=='string'||secret.length<40)fail('callback_secret_missing');
  return createHmac('sha256',secret).update(canonicalRequest(request)).digest('hex');
}
export function verifyRequest(secret,request,signature,now=Date.now()) {
  if(typeof signature!=='string'||!/^[a-f0-9]{64}$/.test(signature))fail('signature_missing_or_invalid');
  const expected=signRequest(secret,request);
  if(!timingSafeEqual(Buffer.from(signature,'hex'),Buffer.from(expected,'hex')))fail('signature_invalid');
  if(Math.abs(Math.floor(now/1000)-Number(request.timestamp))>AUTH_WINDOW_SECONDS)fail('signature_expired');
  return true;
}
export function scopedEnabled(env,user,chat) {
  return env.LUMI_RUNTIME_ENV==='staging' && env.LUMI_TELEGRAM_TRANSPORT_AUTHORITY==='MAKE' &&
    !!user && String(user)===String(chat) && (env.LUMI_TELEGRAM_REVIEW_TEST_USERS||'').split(',').includes(String(user));
}
// CAS durably claims each signed request before any mutation or transport work.
// Claims survive process restart. Expired claims may be removed only after their
// signatures have become unconditionally invalid.
export async function claimRequest(store,user,request,now=Date.now()) {
  const row=await store.get(user);if(!row)fail('existing_operational_message_required');
  row.state.make_requests||={};
  if(row.state.make_requests[request.requestId])fail('replayed_request');
  row.state.make_requests=Object.fromEntries(Object.entries(row.state.make_requests).filter(([,v])=>v.expires_at>=now));
  if(Object.keys(row.state.make_requests).length>=1000)fail('request_window_capacity');
  row.state.make_requests[request.requestId]={body_hash:sha256(request.body),expires_at:(Number(request.timestamp)+AUTH_WINDOW_SECONDS+1)*1000};
  await store.cas(user,row.revision,row.state);
}
export class MakeTransport {
  constructor(){this.authority=TRANSPORT_AUTHORITY;this.commands=[];}
  async call(method,body){
    if(method!=='answerCallbackQuery')fail('make_transport_requires_outbox');
    this.commands.push({kind:'ACK_CALLBACK',method,body});return true;
  }
}
export function transportCommand({state,revision,artifact,media,reply_markup,screen}) {
  validateArtifact(artifact);
  const id=sha256(JSON.stringify([state.user_id,state.chat_id,state.message_id,revision,artifact.sha256,screen]));
  return {version:'lumi_review:v1',kind:screen.kind==='download'?'DOWNLOAD_MASTER':'EDIT_PANEL_MEDIA',
    method:'editMessageMedia',user_id:state.user_id,chat_id:state.chat_id,message_id:state.message_id,
    review_version:revision,artifact_sha:artifact.sha256,idempotency_key:id,
    upload_required:!state.deliveries[artifact.sha256],artifact:{...artifact},
    body:{chat_id:state.chat_id,message_id:state.message_id,media,reply_markup}};
}
export async function acknowledgeCommand(store,user,chat,commandId,message) {
  const row=await store.get(user);if(!row)fail('review_session_missing');
  const s=row.state,c=s.delivery?.command;
  if(s.user_id!==String(user)||s.chat_id!==String(chat)||!c||c.idempotency_key!==commandId)fail('transport_ack_identity_mismatch');
  if(s.delivery.status==='DELIVERED')return {already_applied:true,message_id:s.message_id};
  if(s.delivery.status!=='EMITTING')fail('transport_ack_state_mismatch');
  if(Number(message.message_id)!==s.message_id||String(message.chat?.id)!==s.chat_id)fail('telegram_message_identity_mismatch');
  const remote=message.video||message.photo?.at(-1);
  if(!remote?.file_id||!remote.file_unique_id)fail('telegram_file_identity_missing');
  if(message.caption_sha?message.caption_sha!==sha256(c.body.media.caption):message.caption!==c.body.media.caption)fail('telegram_caption_mismatch');
  if(c.artifact.mime==='video/mp4'&&(!message.video||Number(remote.file_size)!==c.artifact.size||remote.width!==c.artifact.width||remote.height!==c.artifact.height))fail('telegram_artifact_metadata_mismatch');
  const old=s.deliveries[c.artifact_sha];
  if(old&&old.telegram_file_unique_id!==remote.file_unique_id)fail('telegram_file_binding_mismatch');
  s.deliveries[c.artifact_sha]={artifact_id:c.artifact.artifact_id,artifact_sha:c.artifact_sha,
    telegram_file_id:remote.file_id,telegram_file_unique_id:remote.file_unique_id,
    telegram_message_id:s.message_id,chat:s.chat_id,user:s.user_id,episode_id:s.screen.episode_id||null,
    media_kind:c.body.media.type,upload_timestamp:old?.upload_timestamp||new Date().toISOString()};
  s.delivery.status='DELIVERED';s.media_capable=true;s.pending_callback=null;
  s.recovery_state=s.episodes[s.screen.episode_id]?reviewGate(s.episodes[s.screen.episode_id]):null;
  s.LUMI_CANONICAL_PANEL_V1={message_id:s.message_id,chat_id:s.chat_id,verified_at:new Date().toISOString()};
  await store.cas(user,row.revision,s);
  return {ok:true,message_id:s.message_id,artifact_sha:c.artifact_sha,provider_calls:0};
}
