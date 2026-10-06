import { handleUpdate as legacyUpdate, HOME } from './legacy-core.mjs';
import { sha256 } from './core.js';
export const legacyMenu = HOME.map(row=>row.map(([text,callback_data])=>({text,callback_data})));
// The existing Make module may be pointed here only after staging registration.
// Existing Edge/Make production deployment stays intact; unregistered users delegate.
export function mountMakeBridge(app,{db,service,enabled,legacyEndpoint,serviceRoleKey,fetchImpl=fetch}){
  app.post('/lumi/telegram-review/make',async(req,res)=>{
    if(!enabled())return res.status(404).json({error:'review_feature_disabled'});
    try{
      const secret=req.headers['x-cf-secret'];if(typeof secret!=='string'||secret.length<40)return res.status(401).json({error:'unauthorized'});
      const settings=await db.from('cf_bot_settings').select('secret_hash').eq('id',true).single();
      if(settings.error||sha256(secret)!==settings.data.secret_hash)return res.status(401).json({error:'unauthorized'});
      // Forward async completion into the SAME media shell; legacy jobs still own
      // their original state changes and no new provider request is issued here.
      if(req.headers['x-cf-job']||req.headers['x-cf-render-event']==='1'){
        const headers={'x-cf-secret':secret,'content-type':'application/json'};
        for(const k of ['x-cf-job','x-cf-render-event'])if(req.headers[k])headers[k]=req.headers[k];
        const response=await fetchImpl(legacyEndpoint,{method:'POST',headers,body:JSON.stringify(req.body),signal:AbortSignal.timeout(30000)});
        const output=await response.json();if(!response.ok)return res.status(response.status).json(output);
        const remaining=[];
        for(const action of output.actions||[]){
          const b=action.body||{},r=await db.from('lumi_telegram_review_sessions').select('user_id,state').eq('chat_id',String(b.chat_id)).maybeSingle();
          if(r.error)throw Error('review_storage_unavailable');
          if(!r.data){remaining.push(action);continue;}
          if(action.method!=='editMessageText'||Number(b.message_id)!==r.data.state.message_id)throw Error('async_single_message_mismatch');
          await service().legacy(String(r.data.user_id),String(b.chat_id),b.text,b.reply_markup?.inline_keyboard||[]);
        }
        return res.json({...output,actions:remaining});
      }
      const input=req.body,cb=input.callback_query,msg=cb?.message||input.message,user=String(cb?.from?.id||msg?.from?.id||''),chat=String(msg?.chat?.id||'');
      const registered=await db.from('lumi_telegram_review_sessions').select('state').eq('user_id',user).maybeSingle();
      if(registered.error)throw Error('review_storage_unavailable');
      if(!registered.data){
        const response=await fetchImpl(legacyEndpoint,{method:'POST',headers:{'x-cf-secret':secret,'content-type':'application/json'},body:JSON.stringify(input),signal:AbortSignal.timeout(30000)});
        return res.status(response.status).json(await response.json());
      }
      const svc=service();await svc.read(user,chat,cb?msg.message_id:undefined);
      if(cb?.data?.startsWith('lr:')){await svc.reconcile(cb);await svc.callback(cb);return res.json({actions:[]});}
      if(cb?.id)await svc.telegram.call('answerCallbackQuery',{callback_query_id:cb.id});
      if((cb?.data==='home'||cb?.data==='close')||(!cb&&/^\/(menu|start)(@\w+)?(?:\s|$)/.test(msg.text||''))){await svc.show(user,chat,{kind:'menu'});return res.json({actions:[]});}
      const query=async(table,params={})=>{
        // Translate the canonical legacy PostgREST query syntax without exposing credentials.
        const url=new URL(`${legacyEndpoint.split('/functions/')[0]}/rest/v1/${table}`);for(const [k,v] of Object.entries(params))url.searchParams.set(k,String(v));
        const r=await fetchImpl(url,{headers:{apikey:serviceRoleKey,Authorization:`Bearer ${serviceRoleKey}`},signal:AbortSignal.timeout(15000)});
        if(!r.ok)throw Error('legacy_query_failed');return r.json();
      };
      const command=async(u,c,key,action,args)=>{const r=await db.rpc('cf_bot_command',{p_user:u,p_chat:c,p_key:key,p_action:action,p_args:args});if(r.error)throw Error('legacy_command_failed');return r.data;};
      const output=await legacyUpdate(input,{db:query,command});
      // Keep AI work on the existing Make branch. Its completion adapter must also
      // be routed through this shell before activation; readiness documentation lists it.
      for(const action of output.actions||[]){
        if(action.method==='answerCallbackQuery')continue;
        if(action.method==='deleteMessage'&&Number(action.body.message_id)!==registered.data.state.message_id)continue;
        if(action.method!=='editMessageText')throw Error('single_message_legacy_action_blocked');
        if(Number(action.body.message_id)!==registered.data.state.message_id)throw Error('legacy_message_mismatch');
        const body=action.body;
        const text=body.text??String(body.rich_message?.html||'').replace(/<[^>]+>/g,'').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>');
        await svc.legacy(user,chat,text,body.reply_markup?.inline_keyboard||[]);
      }
      res.json({...output,actions:[]});
    }catch{res.status(409).json({error:'telegram_callback_pending',actions:[]});}
  });
}
