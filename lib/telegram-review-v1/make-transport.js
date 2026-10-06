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
export function transportCommand({state,revision,artifact,media,text,reply_markup,screen}) {
  if(artifact)validateArtifact(artifact);
  const id=sha256(JSON.stringify([state.user_id,state.chat_id,state.message_id,revision,artifact?.sha256||null,screen]));
  return {version:'lumi_review:v1',kind:!artifact?'EDIT_PANEL_TEXT':screen.kind==='download'?'DOWNLOAD_MASTER':'EDIT_PANEL_MEDIA',
    method:artifact?'editMessageMedia':'editMessageText',user_id:state.user_id,chat_id:state.chat_id,message_id:state.message_id,
    review_version:revision,artifact_sha:artifact?.sha256||null,idempotency_key:id,
    upload_required:!!artifact&&!state.deliveries[artifact.sha256],artifact:artifact?{...artifact}:null,
    body:{chat_id:state.chat_id,message_id:state.message_id,...(artifact?{media}:{text,link_preview_options:{is_disabled:true}}),reply_markup}};
}
export async function acknowledgeCommand(store,user,chat,commandId,message) {
  const row=await store.get(user);if(!row)fail('review_session_missing');
  const s=row.state,c=s.delivery?.command;
  if(s.user_id!==String(user)||s.chat_id!==String(chat)||!c||c.idempotency_key!==commandId)fail('transport_ack_identity_mismatch');
  if(s.delivery.status==='DELIVERED')return {already_applied:true,message_id:s.message_id};
  if(s.delivery.status!=='EMITTING')fail('transport_ack_state_mismatch');
  if(Number(message.message_id)!==s.message_id||String(message.chat?.id)!==s.chat_id)fail('telegram_message_identity_mismatch');
  if(c.method==='editMessageText'){
    if(message.video?.file_id||message.photo?.length||message.document?.file_id||message.animation?.file_id||message.audio?.file_id||message.caption)fail('telegram_text_representation_mismatch');
    if(message.text_sha?message.text_sha!==sha256(c.body.text):message.text!==c.body.text)fail('telegram_text_representation_mismatch');
    const expected=c.body.reply_markup;
    if(message.reply_markup&&JSON.stringify(message.reply_markup)!==JSON.stringify(expected))fail('telegram_keyboard_mismatch');
    s.panel_content_type='text';s.panel_state=c.body.text?({menu:'HOME',progress:'PRODUCTION_PROGRESS',incident:'INCIDENT'}[s.screen.kind]||s.screen.kind.toUpperCase()):null;
    s.delivery.status='DELIVERED';s.pending_callback=null;s.recovery_state=s.episodes[s.screen.episode_id]?reviewGate(s.episodes[s.screen.episode_id]):null;
    s.LUMI_CANONICAL_PANEL_V1={message_id:s.message_id,chat_id:s.chat_id,verified_at:new Date().toISOString()};
    await store.cas(user,row.revision,s);return {ok:true,message_id:s.message_id,content_type:'text',provider_calls:0};
  }
  const remote=c.body.media.type==='video'?message.video:message.photo?.at(-1);
  if(c.body.media.type==='photo'&&(!message.photo?.length||message.video?.file_id))fail('telegram_media_type_mismatch');
  if(!remote?.file_id||!remote.file_unique_id)fail('telegram_file_identity_missing');
  if(message.caption_sha?message.caption_sha!==sha256(c.body.media.caption):message.caption!==c.body.media.caption)fail('telegram_caption_mismatch');
  // Telegram can retain default 320x320/0 metadata for a native Make upload.
  // Dimensions are authoritative only in the SHA-verified, decoded original;
  // Make also checks the downloaded binary SHA before its upload module runs.
  // A file_id resend cannot change that cached metadata. Do not confuse it
  // with a byte transform or weaken size/file identity checks.
  if(c.artifact.mime==='video/mp4'&&(!message.video||Number(remote.file_size)!==c.artifact.size))fail('telegram_artifact_metadata_mismatch');
  if(message.reply_markup&&JSON.stringify(message.reply_markup)!==JSON.stringify(c.body.reply_markup))fail('telegram_keyboard_mismatch');
  const old=s.deliveries[c.artifact_sha];
  if(old&&old.telegram_file_unique_id!==remote.file_unique_id)fail('telegram_file_binding_mismatch');
  s.deliveries[c.artifact_sha]={artifact_id:c.artifact.artifact_id,artifact_sha:c.artifact_sha,
    telegram_file_id:remote.file_id,telegram_file_unique_id:remote.file_unique_id,
    telegram_message_id:s.message_id,chat:s.chat_id,user:s.user_id,episode_id:s.screen.episode_id||null,
    media_kind:c.body.media.type,upload_timestamp:old?.upload_timestamp||new Date().toISOString(),
    original_metadata:{width:c.artifact.width,height:c.artifact.height,duration:c.artifact.duration,size:c.artifact.size},
    telegram_metadata:{width:remote.width,height:remote.height,duration:remote.duration},
    telegram_metadata_warning:remote.width!==c.artifact.width||remote.height!==c.artifact.height};
  if(c.body.media.type==='photo'&&c.artifact_sha===s.cover.sha256){s.TELEGRAM_HOME_FILE_ID=remote.file_id;s.HOME_ASSET_SHA=c.artifact_sha;}
  s.panel_state={menu:'HOME',progress:'PRODUCTION_PROGRESS',master:'MASTER_REVIEW',master_approved:'MASTER_APPROVED',shot:'SHOT_REVIEW',incident:'INCIDENT'}[s.screen.kind]||s.screen.kind.toUpperCase();
  s.panel_content_type=c.body.media.type;s.delivery.status='DELIVERED';s.media_capable=true;s.pending_callback=null;
  s.recovery_state=s.episodes[s.screen.episode_id]?reviewGate(s.episodes[s.screen.episode_id]):null;
  s.LUMI_CANONICAL_PANEL_V1={message_id:s.message_id,chat_id:s.chat_id,verified_at:new Date().toISOString()};
  await store.cas(user,row.revision,s);
  return {ok:true,message_id:s.message_id,artifact_sha:c.artifact_sha,provider_calls:0};
}
