import { MakeTransport, verifyRequest, scopedEnabled, claimRequest, acknowledgeCommand } from './make-transport.js';
import { ReviewService, sha256 } from './core.js';
import {handleUpdate as legacyUpdate} from './legacy-core.mjs';

// No webhook registration and no Telegram credential. Make owns every Bot API call.
export function mountMakeTransportEndpoint(app,{db,store,env,loadBytes,validateOwner,production}) {
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
      const svc=new ReviewService({store,telegram:transport,loadBytes,validateOwner,production});
      await svc.read(user,chat,body.message_id);
      await claimRequest(store,user,signed);
      let result;
      if(body.op==='callback'||(!body.op&&callback?.data?.startsWith('lr:'))){
        const cb=body.update?.callback_query||callback;
        if(!cb?.id||String(cb.from?.id)!==user||String(cb.message?.chat?.id)!==chat||!/^lr:[a-f0-9]{24}$/.test(cb.data))throw Error('invalid_callback');
        await svc.reconcile(cb);result=await svc.callback(cb);
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
      const code=error.message==='replayed_request'?'replayed_request':'review_transport_pending';
      res.status(409).json({error:code,provider_calls:0});
    }
  });
}
