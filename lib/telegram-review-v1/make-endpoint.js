import {realExecutorReadiness} from '../lumi-v2-executor-bindings.js';
import {createElevenLabsDirectClient,bindApprovedFernanda,elevenLabsError} from '../lumi-elevenlabs-direct-v3.js';
import {createElevenLabsDiscoveryClient} from '../lumi-elevenlabs-discovery-v3.js';
import {ReviewStageReceiptStore} from '../lumi-v2-execution-orchestrator.js';
import {discoverElevenLabsSpanishVoices,discoverElevenLabsVoicePreviews} from '../lumi-elevenlabs-discovery-v3.js';
import {prepareElevenLabsPreviewReview} from '../lumi-elevenlabs-preview-review-v3.js';
import {LUMI_PRODUCTION_PROFILE_V2,PROFILE_SHA} from '../lumi-production-profile-v2.js';
import {artifactReview} from './core.js';
import { MakeTransport, verifyRequest, scopedEnabled, claimRequest, acknowledgeCommand,multipartBody,multipartPhotoAction,isRecoverablePreviewAudioAck } from './make-transport.js';
import { ReviewService, sha256 } from './core.js';
import {handleUpdate as legacyUpdate} from './legacy-core.mjs';
import {DRY_API_OPS,validateDryPayload} from '../lumi-durable-dry-run.js';
import {authenticateV2Command,authenticateFirstImageCallback,authenticateEp004Import,EP004_IMPORT_OP,DIAGNOSTIC_OP} from '../lumi-v2-activation-context.js';

// No webhook registration and no Telegram credential. Make owns every Bot API call.
export function mountMakeTransportEndpoint(app,{db,store,env,loadBytes,mediaTransportUrl,validateOwner,production,diagnostics,isolatedValidation,log=entry=>console.info(JSON.stringify(entry))}) {
  app.get('/lumi/telegram-review/make/artifact/:user/:commandId',async(req,res)=>{
    const user=String(req.params.user);
    if(!scopedEnabled(env,user,user))return res.status(404).json({error:'review_scope_disabled'});
    const signed={timestamp:req.headers['x-lumi-timestamp'],requestId:req.headers['x-lumi-request-id'],method:'GET',path:req.path,body:Buffer.alloc(0)};
    try{verifyRequest(env.LUMI_TELEGRAM_CALLBACK_SECRET,signed,req.headers['x-lumi-signature']);}
    catch{return res.status(401).json({error:'invalid_signed_request'});}
    try{
      const svc=new ReviewService({store,telegram:new MakeTransport(),loadBytes,validateOwner,production});
      const row=await svc.read(user,user),c=row.state.delivery?.command;
      if(row.state.delivery.status!=='EMITTING'||!c?.upload_required||c.idempotency_key!==req.params.commandId)throw Error('artifact_command_mismatch');
      await claimRequest(store,user,signed);
      const bytes=await loadBytes(c.artifact);
      if(bytes.length!==c.artifact.size||sha256(bytes)!==c.artifact_sha)throw Error('artifact_bytes_mismatch');
      res.type(c.artifact.mime).set('Content-Length',String(bytes.length)).set('Content-Disposition',`attachment; filename="${c.artifact.filename||'Lumi.mp4'}"`).send(bytes);
    }catch{res.status(409).json({error:'artifact_transport_pending',provider_calls:0});}
  });
  // Signed path binds the owner, operation and optional request identity. GET
  // reads diagnostic evidence only; no nonce or protected-state writes.
  for(const path of ['/lumi/telegram-review/make/diagnostic/:user/:operationId',
    '/lumi/telegram-review/make/diagnostic/:user/:operationId/:requestId',
    '/lumi/telegram-review/make/diagnostic/:user/:operationId/request/:requestIdHex'])app.get(path,async(req,res)=>{
    if(!isolatedValidation)return res.status(503).json({error:'DIAGNOSTIC_RUNTIME_UNAVAILABLE'});
    const signed={timestamp:req.headers['x-lumi-timestamp'],requestId:req.headers['x-lumi-request-id'],
      method:'GET',path:req.path,body:Buffer.alloc(0)};
    const reply=await isolatedValidation.http.query({signed,signature:req.headers['x-lumi-signature'],
      user:String(req.params.user),operationId:req.params.operationId,requestId:req.params.requestId,requestIdHex:req.params.requestIdHex});
    return res.status(reply.status).json(reply.body);
  });
  app.post('/lumi/telegram-review/make/v1',async(req,res)=>{
    const body=req.body,callback=body?.callback_query,message=callback?.message||body?.message;
    const user=String(body?.user_id||callback?.from?.id||message?.from?.id||''),chat=String(body?.chat_id||message?.chat?.id||'');
    if(!scopedEnabled(env,user,chat))return res.status(404).json({error:'review_scope_disabled'});
    const signed={timestamp:req.headers['x-lumi-timestamp'],requestId:req.headers['x-lumi-request-id'],method:'POST',path:req.path,body:req.rawBody};
    try{
      if(!Buffer.isBuffer(req.rawBody))throw Error('raw_body_required');
      verifyRequest(env.LUMI_TELEGRAM_CALLBACK_SECRET,signed,req.headers['x-lumi-signature']);
    }catch{return res.status(401).json({error:'invalid_signed_request'});}
    let externalEffectPossible=false;
    try{
      // HMAC and allowlist above remain mandatory. Isolated diagnostics never
      // read/claim a nonce in a Telegram session and emit no Bot API commands.
      if(body.op===DIAGNOSTIC_OP){
        if(!isolatedValidation)throw Error('DIAGNOSTIC_RUNTIME_UNAVAILABLE');
        const reply=await isolatedValidation.http.run({signed,signature:req.headers['x-lumi-signature']});
        return res.status(reply.status).json(reply.body);
      }
      const transport=new MakeTransport();
      const svc=new ReviewService({store,telegram:transport,loadBytes,mediaTransportUrl,validateOwner,production});
      await svc.read(user,chat,body.op==='ack'?undefined:body.message_id);
      if(body.op==='ack'){const c=(await store.get(user)).state.delivery?.command;
        if(!c||Number(body.message_id)!==c.message_id)throw Error('transport_ack_identity_mismatch');}
      if(DRY_API_OPS.has(body.op)){
        validateDryPayload(body,signed.requestId);
        if(!diagnostics)throw Error('DRY_RUNTIME_UNAVAILABLE');
        // Queries mutate only the transport nonce, never the operation/queue.
        // Keep original ambiguous transport evidence, including expired claims.
        await claimRequest(store,user,signed,Date.now(),{preserveExpired:true});
        const result=body.op==='START_DRY_RUN'
          ?await diagnostics.start({user,chat,body,nonce:signed.requestId})
          :await diagnostics.get({user,chat,body});
        return res.status(body.op==='START_DRY_RUN'&&!result.already_exists?202:200).json(result);
      }
      if(body.op==='real_executor_dry_run'&&!body.replay)
        return res.status(409).json({error:'DURABLE_DRY_RUN_REQUIRED',start_operation:'START_DRY_RUN',provider_generation_calls:0,publication_calls:0});
      const claim=await claimRequest(store,user,signed,Date.now(),{
        updateId:!body.op&&Number.isSafeInteger(body.update_id)?body.update_id:null});
      if(claim.duplicate_update)return res.json({status:'DUPLICATE_REQUEST',executed:false,
        recovery_required:true,actions:[],commands:[],provider_calls:0});
      let result;
      if(callback&&Number(callback.message?.message_id)!==(await store.get(user)).state.message_id){
        return res.json({status:'STALE_CALLBACK',actions:[{method:'answerCallbackQuery',body_json:JSON.stringify({callback_query_id:callback.id,text:'Este panel ya no está activo. Usá el nuevo panel de Lumi.'})}],commands:[],provider_calls:0});
      }
      if(body.op==='AUTHORIZE_REJECTED_DELIVERY'){
        result=await svc.authorizeRejectedDelivery(user,chat,body);
      }else if(body.op==='RECOVER_TELEGRAM_PANEL'){
        if(Object.keys(body).some(k=>!['op','user_id','chat_id'].includes(k)))throw Error('panel_recovery_input_invalid');
        result=await svc.recoverPanel(user,chat);
      }else if(body.op==='probe'){
        result={ok:true,authenticated:true,message_id:(await svc.read(user,chat)).state.message_id,provider_calls:0};
      }else if(body.op==='elevenlabs_fernanda_binding'){
        try{result={...await bindApprovedFernanda({client:createElevenLabsDirectClient({env}),discovery:createElevenLabsDiscoveryClient({env}),
          receipts:new ReviewStageReceiptStore({store,user}),store,user,env}),authenticated:true,staging_sha:env.RENDER_GIT_COMMIT};}
        catch(error){result={status:'FERNANDA_API_BINDING_BLOCKER',error:elevenLabsError(error),authenticated:true,provider_generation_calls:0};}
      }else if(body.op==='elevenlabs_voice_discovery'){
        result={...await discoverElevenLabsSpanishVoices({env}),authenticated:true,staging_sha:env.RENDER_GIT_COMMIT};
      }else if(body.op==='elevenlabs_preview_readiness'){
        result={...await discoverElevenLabsVoicePreviews({env}),authenticated:true,staging_sha:env.RENDER_GIT_COMMIT};
      }else if(body.op==='elevenlabs_preview_prepare'){
        result={...await prepareElevenLabsPreviewReview({env,db,store,user,chat}),authenticated:true,staging_sha:env.RENDER_GIT_COMMIT};
      }else if(body.op==='elevenlabs_preview_status'){
        const {state:s}=await svc.read(user,chat);
        result={authenticated:true,review:s.voice_preview_review||null,panel_state:s.panel_state,message_id:s.message_id,screen:s.screen,delivery_status:s.delivery?.status,
          candidate_delivery:(s.voice_preview_review?.candidates||[]).map(c=>({letter:c.letter,sha256:c.artifact.sha256,delivered:!!s.deliveries[c.artifact.sha256]?.telegram_file_id})),provider_generation_calls:0};
      }else if(body.op==='production_readiness'){
        const row=await svc.read(user,chat),s=row.state,e=s.episodes[body.episode_id]||Object.values(s.episodes).at(-1),r=e&&artifactReview(e,e.master);
        const home=s.cover?.mime?.startsWith('image/')&&s.TELEGRAM_HOME_FILE_ID&&s.HOME_ASSET_SHA===s.cover.sha256&&s.home_restore_capability?.video_to_photo===true;
        const adapter=realExecutorReadiness();
        result={ok:true,authenticated:true,status:home&&adapter.status==='PASS'?'PASS':'BLOCKED',blockers:[...(!home?['TELEGRAM_MEDIA_FIRST_HOME_NOT_VERIFIED']:[]),...(adapter.status!=='PASS'?adapter.blockers:[])],
          TELEGRAM_HOME_RESTORE:home?'PASS':'BLOCKED',TELEGRAM_MEDIA_FIRST_HOME:home?'PASS':'BLOCKED',GENERIC_V2_ADAPTER:adapter,SINGLE_PANEL_MESSAGE_ID:s.message_id,
          MASTER_HUMAN_APPROVED:r?.human_status==='MASTER_HUMAN_APPROVED'&&r.status==='APPROVED',MASTER_SHA:e?.master?.sha256,
          MASTER_FILE_ID_BOUND:!!s.deliveries[e?.master?.sha256]?.telegram_file_id,LUMI_PRODUCTION_PROFILE_V2:LUMI_PRODUCTION_PROFILE_V2.status,profile_sha:PROFILE_SHA,
          review_flag:env.LUMI_TELEGRAM_REVIEW_V1==='true',global_pipeline_default:env.LUMI_PIPELINE_VERSION||'legacy',global_creative_engine:env.CREATIVE_ENGINE_VERSION||'legacy',
          runtime_env:env.LUMI_RUNTIME_ENV,staging_sha:env.RENDER_GIT_COMMIT,provider_calls:0,publication_calls:0,activation_authorized:false};
      }else if(body.op==='callback'||(!body.op&&callback?.data?.startsWith('lr:'))){
        const cb=body.update?.callback_query||callback;
        if(!cb?.id||String(cb.from?.id)!==user||String(cb.message?.chat?.id)!==chat||!/^lr:[a-f0-9]{24}$/.test(cb.data))throw Error('invalid_callback');
        const token=(await store.get(user))?.state.tokens?.[cb.data.slice(3)];
        const firstImageCommand=(token?.action?.startsWith('q41_')&&token.action!=='q41_prepare'||token?.action==='balance_reloaded')
          ?authenticateFirstImageCallback({env,signed,signature:req.headers['x-lumi-signature'],panelMessageId:(await store.get(user)).state.message_id}):null;
        await svc.reconcile(cb);
        externalEffectPossible=['resume','balance_reloaded','approve_stage','reject_stage','q41_confirm','q41_refill','q41_continue'].includes(token?.action);
        result=await svc.callback(cb,{firstImageCommand});
      }else if(body.op==='real_executor_dry_run'){
        if(env.LUMI_RUNTIME_ENV!=='staging')throw Error('REPLAY_STAGING_ONLY');
        result={...await production.replayArtifact({...body.replay,user}),authenticated:true,staging_sha:env.RENDER_GIT_COMMIT};
      }else if(body.op===EP004_IMPORT_OP){
        const command=authenticateEp004Import({env,signed,signature:req.headers['x-lumi-signature']});
        result=await production.createEp004FromApprovedQ41({command});
      }else if(body.op==='create_v2'){
        const authenticatedCommand=authenticateV2Command({secret:env.LUMI_TELEGRAM_CALLBACK_SECRET,signed,signature:req.headers['x-lumi-signature']});
        externalEffectPossible=true;
        result=await production.create({user,chat,request:body.request,requested_profile:body.requested_profile,authenticatedCommand});
      }else if(body.op==='show'){
        result=await svc.show(user,chat,body.screen);
      }else if(body.op==='ack'){
        result=await acknowledgeCommand(store,user,chat,body.command_id,body.telegram_result);
      }else if(body.op==='artifact'){
        const row=await svc.read(user,chat),c=row.state.delivery?.command;
        if(row.state.delivery.status!=='EMITTING'||!c?.artifact||c.idempotency_key!==body.command_id)throw Error('artifact_command_mismatch');
        const bytes=await loadBytes(c.artifact);
        if(bytes.length!==c.artifact.size||sha256(bytes)!==c.artifact_sha)throw Error('artifact_bytes_mismatch');
        return res.type(c.artifact.mime).set('Content-Length',String(bytes.length)).send(bytes);
      }else if(!body.op||body.op==='legacy_completion'){
        if(callback?.id)await transport.call('answerCallbackQuery',{callback_query_id:callback.id});
        if(!callback&&['/verificar_transporte','/recuperar_entrega'].includes(message?.text)){
          const sentAt=Number.isSafeInteger(message.date)?message.date*1000:typeof message.date==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(message.date)?Date.parse(message.date):NaN;
          if(!Number.isFinite(sentAt)||Math.abs(Date.now()-sentAt)>120000)throw Error('panel_recovery_command_expired');
          if(message.text==='/verificar_transporte')return res.json({actions:[{method:'getChat',...multipartBody({chat_id:chat}),track_review:false,track_menu:false}],provider_calls:0});
          result=await svc.recoverRejectedDelivery(user,chat);
        }else if(!callback&&/^\/recuperar_panel(@\w+)?$/.test(message?.text||'')){
          // Telegram uses epoch seconds; Make WatchUpdates normalizes them to ISO UTC.
          const sentAt=Number.isSafeInteger(message.date)?message.date*1000:
            typeof message.date==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(message.date)?Date.parse(message.date):NaN;
          if(!Number.isFinite(sentAt)||Math.abs(Date.now()-sentAt)>120000)throw Error('panel_recovery_command_expired');
          result=await svc.recoverPanel(user,chat);
        }else if(callback?.data==='home'||callback?.data==='close'||(!callback&&/^\/(menu|start)(@\w+)?(?:\s|$)/.test(message?.text||''))){
          result=await svc.show(user,chat,{kind:'menu'});
        }else{
          // Compatibility for old navigation buttons: keep literal callback IDs,
          // but resolve read-only navigation through the isolated canonical router.
          const alias=callback?.data==='ideas'?'create_v2_ideas':/^reviews:\d+$/.test(callback?.data||'')?'current':
            ['settings','calendar','trends'].includes(callback?.data)||/^(published|stats):\d+$/.test(callback?.data||'')?'settings':null;
          if(alias){result=await svc.show(user,chat,{kind:alias});}
          else if(callback){
            // Historic literal actions can point to production RPCs. Keep their
            // identity but never dispatch an old queue item into generation.
            result={status:'STALE_CALLBACK',blocked:true,error:'legacy_action_unavailable',commands:[]};
            transport.commands=[];
            await transport.call('answerCallbackQuery',{callback_query_id:callback.id,
              text:'Este botón pertenece al menú anterior. Abrí /menu para continuar.',show_alert:true});
          }else {
            let output;
            if(body.op==='legacy_completion'){
              if(!body.job_id)throw Error('completion_job_missing');
              const response=await fetch(`${env.SUPABASE_URL}/functions/v1/content-factory-bot`,{method:'POST',headers:{'content-type':'application/json','x-cf-secret':env.LUMI_TELEGRAM_CALLBACK_SECRET,'x-cf-job':body.job_id},body:JSON.stringify(body.payload),signal:AbortSignal.timeout(30000)});
              if(!response.ok)throw Error('legacy_completion_failed');output=await response.json();
            }else{
              const query=async(table,params={})=>{
                const url=new URL(`${env.SUPABASE_URL}/rest/v1/${table}`);for(const [k,v] of Object.entries(params))url.searchParams.set(k,String(v));
                const response=await fetch(url,{headers:{apikey:env.SUPABASE_SERVICE_ROLE_KEY,Authorization:`Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`},signal:AbortSignal.timeout(15000)});
                if(!response.ok)throw Error('legacy_query_failed');return response.json();
              };
              const command=async(u,c,key,action,args)=>{const r=await db.rpc('cf_bot_command',{p_user:u,p_chat:c,p_key:key,p_action:action,p_args:args});if(r.error)throw Error('legacy_command_failed');return r.data;};
              output=await legacyUpdate(body,{db:query,command});
            }
            const edits=(output.actions||[]).filter(a=>a.method!=='answerCallbackQuery'&&a.method!=='deleteMessage');
            if(edits.length>1)throw Error('multiple_panel_writers');
            result={...output,commands:[]};
            if(edits.length){const a=edits[0],row=await svc.read(user,chat);
              if(a.method!=='editMessageText'||Number(a.body.message_id)!==row.state.message_id||String(a.body.chat_id)!==chat)throw Error('legacy_message_mismatch');
              const text=a.body.text??String(a.body.rich_message?.html||'').replace(/<[^>]+>/g,'').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>');
              result={...result,...await svc.legacy(user,chat,text,a.body.reply_markup?.inline_keyboard||[])};
            }
          }
        }
      }else throw Error('unknown_transport_operation');
      const row=await svc.read(user,chat);
      const acknowledgements=transport.commands.map((c,i)=>({...c,version:'lumi_review:v1',
        user_id:user,chat_id:chat,message_id:row.state.message_id,review_version:row.revision,
        artifact_sha:null,idempotency_key:sha256(`${signed.requestId}:ack:${i}`)}));
      const commands=[...acknowledgements,...(result.commands||[])];
      // Existing Make iterator and Telegram module consume this native action
      // shape. Oversize URL photos use transient multipart bytes through Make;
      // other binary types retain the existing native bootstrap boundary.
      if(commands.some(c=>c.upload_required&&!(c.body.media?.type==='photo'&&c.artifact?.mime==='image/png'&&c.artifact.size>5_000_000&&c.artifact.size<=10_000_000)))return res.json({...result,actions:[],commands,transport_bootstrap_required:true});
      const actions=commands.map(c=>({method:c.method,body_json:JSON.stringify(c.kind==='RECOVER_TELEGRAM_PANEL'?{chat_id:c.chat_id,photo:c.body.media.media,caption:c.body.media.caption,reply_markup:c.body.reply_markup}:c.body),user,chat,
        track_review:c.kind!=='ACK_CALLBACK',command_id:c.idempotency_key,
        review_version:c.review_version,artifact_sha:c.artifact_sha,message_id:c.message_id}));
      for(let i=0;i<commands.length;i++)if(commands[i].upload_required)Object.assign(actions[i],await multipartPhotoAction(commands[i],loadBytes));
      if(body.op==='ack')log({event:'lumi_make_ack',request_id:signed.requestId,
        status:result.already_applied?'ACK_ALREADY_APPLIED':'ACK_APPLIED',checkpoint_version:row.revision,
        message_id:row.state.message_id,delivery_state:row.state.delivery?.status});
      const binary=actions.filter(a=>a.binary_file_base64);
      if(binary.length>1)throw Error('multipart_photo_scope_invalid');
      res.json({...result,actions:actions.filter(a=>!a.binary_file_base64),commands,...(binary.length?{binary_delivery:binary[0]}:{})});
    }catch(error){
      if(env.LUMI_RUNTIME_ENV==='staging'&&error.message==='telegram_audio_metadata_mismatch'){
        const row=await store.get(user);
        if(row&&isRecoverablePreviewAudioAck(row.state,body))return res.json({status:'AUDIO_CONFIRMATION_PENDING',
          requires_signed_callback_reconciliation:true,message_id:138,actions:[],commands:[],provider_calls:0});
      }
      const dryErrors=['DRY_PAYLOAD_INVALID','DRY_IDEMPOTENCY_KEY_INVALID','DRY_SAFETY_FLAGS_REQUIRED','DRY_OPERATION_ID_REQUIRED',
        'DRY_IDEMPOTENCY_CONFLICT','DRY_OPERATION_NOT_FOUND','DRY_REVISION_REQUIRED','DRY_RUNTIME_UNAVAILABLE'];
      const publicErrors=['panel_recovery_command_expired','concurrent_update','replayed_request','update_identity_conflict','invalid_callback',
        'telegram_delivery_reconciliation_required','reconciliation_token_missing','transport_ack_identity_mismatch',
        'transport_ack_state_mismatch','telegram_message_identity_mismatch','telegram_caption_mismatch',
        'telegram_keyboard_mismatch','telegram_file_binding_mismatch','telegram_file_identity_missing',
        'telegram_artifact_metadata_mismatch','telegram_audio_metadata_mismatch','telegram_media_type_mismatch',
        'telegram_text_representation_mismatch','review_state_read_failed','review_state_write_failed',
        'TELEGRAM_MEDIA_TO_TEXT_UNSUPPORTED'];
      const code=/^DIAGNOSTIC_[A-Z_]+$/.test(error.message)||[...dryErrors,...publicErrors].includes(error.message)?error.message:'unexpected_backend_error';
      const classification=code==='concurrent_update'?'CAS_CONFLICT':code==='replayed_request'?'REPLAY_REJECTED':
        code==='reconciliation_token_missing'?'STALE_CALLBACK':code==='telegram_delivery_reconciliation_required'?'DELIVERY_PENDING':'UNEXPECTED_BACKEND_ERROR';
      let snapshot;try{snapshot=await store.get(user);}catch{}
      const evidence={event:'lumi_make_error',request_id:signed.requestId,error_code:code,
        sanitized_error_message:code,classification,checkpoint_version:snapshot?.revision??null,
        idempotency_state:snapshot?.state.make_requests?.[signed.requestId]?'NONCE_CLAIMED':'NONCE_NOT_RECORDED',
        delivery_state:snapshot?.state.delivery?.status??null,lease_state:'NOT_USED_BY_TELEGRAM_TRANSPORT'};
      // A blocked command has emitted no edit. Preserve the pending outbox;
      // this is an explicit pending outcome, never a successful delivery claim.
      if(!externalEffectPossible&&['telegram_delivery_reconciliation_required','reconciliation_token_missing'].includes(code)){
        log({...evidence,http_status:200});
        return res.json({status:classification,executed:false,recovery_required:classification==='DELIVERY_PENDING',error:code,
          request_id:signed.requestId,checkpoint_version:evidence.checkpoint_version,
          actions:callback?.id?[{method:'answerCallbackQuery',body_json:JSON.stringify({callback_query_id:callback.id,
            text:classification==='STALE_CALLBACK'?'Este botón ya no está activo. Usá el panel actual.':'La entrega anterior está pendiente de confirmación. No se repitió la operación.',show_alert:true}),track_review:false}]:[],
          commands:[],provider_calls:0});
      }
      log({...evidence,http_status:409});
      if(code==='TELEGRAM_MEDIA_TO_TEXT_UNSUPPORTED'&&callback?.id)return res.json({blocked:true,error:code,actions:[{method:'answerCallbackQuery',body_json:JSON.stringify({callback_query_id:callback.id,text:'Telegram no permite restaurar texto en el panel de video 138.',show_alert:true}),track_review:false}],provider_calls:0});
      res.status(409).json({error:code,classification,request_id:signed.requestId,checkpoint_version:evidence.checkpoint_version,provider_calls:externalEffectPossible?null:0,recovery_required:externalEffectPossible});
    }
  });
}
