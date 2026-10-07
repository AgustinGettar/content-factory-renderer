import {realExecutorReadiness} from '../lumi-v2-executor-bindings.js';
import {createElevenLabsDirectClient,bindApprovedFernanda,elevenLabsError} from '../lumi-elevenlabs-direct-v3.js';
import {createElevenLabsDiscoveryClient} from '../lumi-elevenlabs-discovery-v3.js';
import {ReviewStageReceiptStore} from '../lumi-v2-execution-orchestrator.js';
import {discoverElevenLabsSpanishVoices,discoverElevenLabsVoicePreviews} from '../lumi-elevenlabs-discovery-v3.js';
import {prepareElevenLabsPreviewReview} from '../lumi-elevenlabs-preview-review-v3.js';
import {LUMI_PRODUCTION_PROFILE_V2,PROFILE_SHA} from '../lumi-production-profile-v2.js';
import {artifactReview} from './core.js';
import { MakeTransport, verifyRequest, scopedEnabled, claimRequest, acknowledgeCommand,isRecoverablePreviewAudioAck } from './make-transport.js';
import { ReviewService, sha256 } from './core.js';
import {handleUpdate as legacyUpdate} from './legacy-core.mjs';
import {DRY_API_OPS,validateDryPayload} from '../lumi-durable-dry-run.js';
import {authenticateV2Command} from '../lumi-v2-activation-context.js';

// No webhook registration and no Telegram credential. Make owns every Bot API call.
export function mountMakeTransportEndpoint(app,{db,store,env,loadBytes,mediaTransportUrl,validateOwner,production,diagnostics}) {
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
  app.post('/lumi/telegram-review/make/v1',async(req,res)=>{
    const body=req.body,callback=body?.callback_query,message=callback?.message||body?.message;
    const user=String(body?.user_id||callback?.from?.id||message?.from?.id||''),chat=String(body?.chat_id||message?.chat?.id||'');
    if(!scopedEnabled(env,user,chat))return res.status(404).json({error:'review_scope_disabled'});
    const signed={timestamp:req.headers['x-lumi-timestamp'],requestId:req.headers['x-lumi-request-id'],method:'POST',path:req.path,body:req.rawBody};
    try{
      if(!Buffer.isBuffer(req.rawBody))throw Error('raw_body_required');
      verifyRequest(env.LUMI_TELEGRAM_CALLBACK_SECRET,signed,req.headers['x-lumi-signature']);
    }catch{return res.status(401).json({error:'invalid_signed_request'});}
    try{
      const transport=new MakeTransport();
      const svc=new ReviewService({store,telegram:transport,loadBytes,mediaTransportUrl,validateOwner,production});
      await svc.read(user,chat,body.message_id);
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
      await claimRequest(store,user,signed);
      let result;
      if(body.op==='probe'){
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
        await svc.reconcile(cb);result=await svc.callback(cb);
      }else if(body.op==='real_executor_dry_run'){
        if(env.LUMI_RUNTIME_ENV!=='staging')throw Error('REPLAY_STAGING_ONLY');
        result={...await production.replayArtifact({...body.replay,user}),authenticated:true,staging_sha:env.RENDER_GIT_COMMIT};
      }else if(body.op==='create_v2'){
        const authenticatedCommand=authenticateV2Command({secret:env.LUMI_TELEGRAM_CALLBACK_SECRET,signed,signature:req.headers['x-lumi-signature']});
        result=await production.create({user,chat,request:body.request,requested_profile:body.requested_profile,authenticatedCommand});
      }else if(body.op==='show'){
        result=await svc.show(user,chat,body.screen);
      }else if(body.op==='ack'){
        result=await acknowledgeCommand(store,user,chat,body.command_id,body.telegram_result);
      }else if(body.op==='artifact'){
        const row=await svc.read(user,chat),c=row.state.delivery?.command;
        if(row.state.delivery.status!=='EMITTING'||!c?.upload_required||c.idempotency_key!==body.command_id)throw Error('artifact_command_mismatch');
        const bytes=await loadBytes(c.artifact);
        if(bytes.length!==c.artifact.size||sha256(bytes)!==c.artifact_sha)throw Error('artifact_bytes_mismatch');
        return res.type(c.artifact.mime).set('Content-Length',String(bytes.length)).send(bytes);
      }else if(!body.op||body.op==='legacy_completion'){
        if(callback?.id)await transport.call('answerCallbackQuery',{callback_query_id:callback.id});
        if(callback?.data==='home'||callback?.data==='close'||(!callback&&/^\/(menu|start)(@\w+)?(?:\s|$)/.test(message?.text||''))){
          result=await svc.show(user,chat,{kind:'menu'});
        }else{
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
      }else throw Error('unknown_transport_operation');
      const row=await svc.read(user,chat);
      const acknowledgements=transport.commands.map((c,i)=>({...c,version:'lumi_review:v1',
        user_id:user,chat_id:chat,message_id:row.state.message_id,review_version:row.revision,
        artifact_sha:null,idempotency_key:sha256(`${signed.requestId}:ack:${i}`)}));
      const commands=[...acknowledgements,...(result.commands||[])];
      // Existing Make iterator and Telegram module consume this native action
      // shape. Binary uploads are deliberately handled by the one-time native
      // EditMediaMessage bootstrap; normal navigation requires cached file_id.
      if(commands.some(c=>c.upload_required))return res.json({...result,actions:[],commands,transport_bootstrap_required:true});
      const actions=commands.map(c=>({method:c.method,body_json:JSON.stringify(c.body),user,chat,
        track_review:c.kind!=='ACK_CALLBACK',command_id:c.idempotency_key,
        review_version:c.review_version,artifact_sha:c.artifact_sha,message_id:c.message_id}));
      res.json({...result,actions,commands});
    }catch(error){
      if(env.LUMI_RUNTIME_ENV==='staging'&&error.message==='telegram_audio_metadata_mismatch'){
        const row=await store.get(user);
        if(row&&isRecoverablePreviewAudioAck(row.state,body))return res.json({status:'AUDIO_CONFIRMATION_PENDING',
          requires_signed_callback_reconciliation:true,message_id:138,actions:[],commands:[],provider_calls:0});
      }
      const dryErrors=['DRY_PAYLOAD_INVALID','DRY_IDEMPOTENCY_KEY_INVALID','DRY_SAFETY_FLAGS_REQUIRED','DRY_OPERATION_ID_REQUIRED',
        'DRY_IDEMPOTENCY_CONFLICT','DRY_OPERATION_NOT_FOUND','DRY_REVISION_REQUIRED','DRY_RUNTIME_UNAVAILABLE'];
      const code=[...dryErrors,'replayed_request','TELEGRAM_MEDIA_TO_TEXT_UNSUPPORTED'].includes(error.message)?error.message:'review_transport_pending';
      if(code==='TELEGRAM_MEDIA_TO_TEXT_UNSUPPORTED'&&callback?.id)return res.json({blocked:true,error:code,actions:[{method:'answerCallbackQuery',body_json:JSON.stringify({callback_query_id:callback.id,text:'Telegram no permite restaurar texto en el panel de video 138.',show_alert:true}),track_review:false}],provider_calls:0});
      res.status(409).json({error:code,provider_calls:0});
    }
  });
}
