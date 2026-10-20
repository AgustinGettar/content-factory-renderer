import {randomUUID,timingSafeEqual} from 'node:crypto';
import {sha256} from './core.js';
import {miniAppEnabled,MINI_ORIGIN,MINI_PATH} from '../telegram-mini-app/auth.js';

export const DIRECT_PATH='/lumi/telegram-review/telegram/webhook';
const fail=code=>{throw Error(code);};
const equal=(a,b)=>typeof a==='string'&&typeof b==='string'&&Buffer.byteLength(a)===Buffer.byteLength(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
export function directConfigured(env){
  return miniAppEnabled(env)&&env.LUMI_TELEGRAM_TRANSPORT_AUTHORITY==='DIRECT'
    &&/^\d+$/.test(env.LUMI_TELEGRAM_BOT_ID||'')&&!!env.LUMI_TELEGRAM_BOT_TOKEN
    &&/^[A-Za-z0-9_-]{32,256}$/.test(env.LUMI_TELEGRAM_WEBHOOK_SECRET||'')
    &&env.LUMI_TELEGRAM_WEBHOOK_SECRET!==env.LUMI_TELEGRAM_CALLBACK_SECRET
    &&env.LUMI_TELEGRAM_WEBHOOK_SECRET!==env.LUMI_TELEGRAM_BOT_TOKEN;
}
const studioMarkup={inline_keyboard:[[{text:'Abrir Lumi Studio',web_app:{url:MINI_ORIGIN+MINI_PATH}}]]};

// Protocol adaptation only. All effects use the existing session's transport
// receipts and row CAS transaction. No production adapter is imported or called.
export class DirectTelegram {
  constructor({db,store,transport,validateOwner,env}){Object.assign(this,{db,store,transport,validateOwner,env});this.verified=false;}
  async tx(p){const {data,error}=await this.db.rpc('lumi_direct_telegram_v1',{p:{bot_id:this.env.LUMI_TELEGRAM_BOT_ID,...p}});if(error)fail(/^DIRECT_[A-Z_]+$/.test(error.message)?error.message:'DIRECT_STORAGE_UNAVAILABLE');return data;}
  async verify(){
    this.verified=false;
    if(!directConfigured(this.env))return false;
    const me=await this.transport.call('getMe',{});
    if(!me?.is_bot||String(me.id)!==this.env.LUMI_TELEGRAM_BOT_ID||me.username!=='AppMultimedia_VideosBot')fail('DIRECT_BOT_IDENTITY_MISMATCH');
    await this.tx({phase:'READINESS'});this.verified=true;return true;
  }
  async owner(user){return (this.env.LUMI_TELEGRAM_REVIEW_TEST_USERS||'').split(',').includes(user)&&await this.validateOwner(user,user);}
  async accept(update){
    if(!this.verified)fail('DIRECT_NOT_READY');
    if(!update||Array.isArray(update)||!Number.isSafeInteger(update.update_id)||update.update_id<0
      ||Buffer.byteLength(JSON.stringify(update))>16384||Object.keys(update).some(k=>!['update_id','message','callback_query'].includes(k))
      ||!!update.message===!!update.callback_query)fail('DIRECT_UPDATE_INVALID');
    const cb=update.callback_query,msg=cb?.message||update.message,from=cb?.from||msg?.from;
    if(!Number.isSafeInteger(from?.id)||from.id<=0||from.is_bot||msg?.chat?.type!=='private'
      ||from.id!==msg.chat.id||!Number.isSafeInteger(msg.message_id)||msg.message_id<=0)fail('DIRECT_OWNER_REQUIRED');
    const user=String(from.id);if(!await this.owner(user))fail('DIRECT_OWNER_REQUIRED');
    const row=await this.store.get(user);if(row?.state.chat_id!==user)fail('DIRECT_OWNER_REQUIRED');
    let kind=typeof msg.text==='string'?'STUDIO_ENTRY':'UNSUPPORTED';
    if(cb){
      if(typeof cb.data!=='string'||Buffer.byteLength(cb.data)>64||!/^[A-Za-z0-9_-]{1,128}$/.test(cb.id||''))fail('DIRECT_CALLBACK_INVALID');
      const token=cb.data.startsWith('lr:')?row.state.tokens?.[cb.data.slice(3)]:null;
      kind=token&&msg.message_id===row.state.message_id&&(!token.expires_at||Date.parse(token.expires_at)>Date.now())?'LEGACY_CALLBACK':'STALE_CALLBACK';
    }
    const key=`direct:${this.env.LUMI_TELEGRAM_BOT_ID}:update:${update.update_id}`;
    // Do not store personal messages, raw callbacks, initData or tokens.
    const descriptor={update_id:update.update_id,user,message_id:msg.message_id,callback_id:cb?.id||null,content_hash:sha256(cb?.data||msg.text||'')};
    return this.tx({phase:'ACCEPT',user_id:user,key,kind,update_id:update.update_id,callback_id:cb?.id,payload_hash:sha256(JSON.stringify(descriptor))});
  }
  notices(state){
    const out=[];
    for(const e of Object.values(state.episodes||{})){
      for(const r of Object.values(e.review_requests||{}))if(r.status==='PENDING'&&r.artifact_sha)
        out.push({kind:'REVIEW_READY',id:sha256(JSON.stringify([e.episode_id,r.review_request_id,r.artifact_sha]))});
      if(e.master?.sha256)out.push({kind:'MASTER_READY',id:sha256(JSON.stringify([e.episode_id,'master',e.master.sha256]))});
    }
    return out;
  }
  async drainUser(user){
    if(!this.verified||!await this.owner(user))return;
    const row=await this.store.get(user);if(!row||row.state.chat_id!==user)return;
    const bot=this.env.LUMI_TELEGRAM_BOT_ID,notices=this.notices(row.state);
    const baseline=await this.tx({phase:'BASELINE',user_id:user,key:`direct:${bot}:baseline`,notices:notices.map(x=>x.id)});
    for(const n of notices)if(!baseline.notices.includes(n.id))await this.tx({phase:'ACCEPT',user_id:user,key:`direct:${bot}:notice:${n.id}`,kind:n.kind,payload_hash:n.id});
    const latest=await this.store.get(user);
    for(const [key,r] of Object.entries(latest.state.make_requests||{})){
      if(r.transport!=='TELEGRAM_DIRECT'||r.bot_id!==bot||r.status!=='QUEUED')continue;
      const dispatch_id=randomUUID(),claim=await this.tx({phase:'CLAIM',user_id:user,key,dispatch_id});
      if(claim.status!=='DISPATCHING'||claim.dispatch_id!==dispatch_id)continue;
      let receipt,status='DELIVERED';
      try{
        // Recheck revocation immediately before transport. Never claim again,
        // even when a process dies after this durable DISPATCHING marker.
        if(!await this.owner(user))throw Object.assign(Error('DIRECT_OWNER_REQUIRED'),{definite:true});
        if(['LEGACY_CALLBACK','STALE_CALLBACK'].includes(claim.kind)){
          const ok=await this.transport.call('answerCallbackQuery',{callback_query_id:claim.callback_id,
            text:'Este control fue retirado. Abrí Lumi Studio desde el menú del bot.',show_alert:true});
          if(ok!==true)fail('DIRECT_RECEIPT_INVALID');receipt={callback_answered:true};
        }else{
          const text=claim.kind==='REVIEW_READY'?'Tenés un resultado listo para revisar en Lumi Studio.':claim.kind==='MASTER_READY'?'Tu master está disponible en Lumi Studio para revisión y descarga.':'Continuá tu episodio en Lumi Studio. Tu progreso y tus aprobaciones están guardados.';
          const message=await this.transport.call('sendMessage',{chat_id:user,text,reply_markup:studioMarkup});
          if(!Number.isSafeInteger(message?.message_id)||message.message_id<=0||String(message.chat?.id)!==user)fail('DIRECT_RECEIPT_INVALID');
          receipt={message_id:message.message_id,chat_id:user,date:message.date};
        }
      }catch(e){status=e.definite?'REJECTED':'UNKNOWN';}
      // Lost response or failed persistence leaves UNKNOWN/DISPATCHING. Never
      // replay a Telegram send: the API has no message-send idempotency key.
      await this.tx({phase:'FINISH',user_id:user,key,dispatch_id,status,receipt});
    }
  }
  async drain(){
    if(!this.verified)return;
    for(const user of (this.env.LUMI_TELEGRAM_REVIEW_TEST_USERS||'').split(',').filter(x=>/^\d+$/.test(x)))await this.drainUser(user);
  }
}

export function mountDirectTelegram(app,{db,store,transport,validateOwner,env,startWorker=true}){
  if(!miniAppEnabled(env))return null;
  const service=new DirectTelegram({db,store,transport,validateOwner,env});
  app.get('/lumi/telegram-review/telegram/readiness',(_req,res)=>res.json({version:1,authority:env.LUMI_TELEGRAM_TRANSPORT_AUTHORITY||null,
    bot_credential:!!env.LUMI_TELEGRAM_BOT_TOKEN,webhook_secret_configured:!!env.LUMI_TELEGRAM_WEBHOOK_SECRET,
    configured:directConfigured(env),identity_verified:service.verified,staging_sha:env.RENDER_GIT_COMMIT||null,
    persistence:'EXISTING_REVIEW_SESSION_CAS',provider_generation_calls:0}));
  app.post(DIRECT_PATH,async(req,res)=>{
    if(!directConfigured(env)||!service.verified)return res.status(503).json({error:'DIRECT_NOT_READY'});
    if(!equal(req.headers['x-telegram-bot-api-secret-token'],env.LUMI_TELEGRAM_WEBHOOK_SECRET))return res.status(401).json({error:'UNAUTHORIZED'});
    if(!req.is('application/json'))return res.status(415).json({error:'JSON_REQUIRED'});
    try{const accepted=await service.accept(req.body);res.json({ok:true,disposition:accepted.status});}
    catch(e){const code=e.message;res.status(code==='DIRECT_OWNER_REQUIRED'?403:['DIRECT_STORAGE_UNAVAILABLE','DIRECT_RECEIPT_CAPACITY'].includes(code)?503:code.includes('CONFLICT')?409:400).json({error:code.startsWith('DIRECT_')?code:'DIRECT_ACCEPT_FAILED'});}
  });
  let busy=false;
  const tick=async()=>{if(busy||!directConfigured(env))return;busy=true;try{if(!service.verified)await service.verify();await service.drain();}
    catch{console.error(JSON.stringify({event:'lumi_direct_transport_attention_required'}));}finally{busy=false;}};
  // This poller only delivers already durable transport receipts. On restart
  // QUEUED work resumes from DB. It cannot run generation or recover paid jobs.
  const timer=startWorker?setInterval(tick,5000):null;timer?.unref?.();if(startWorker)void tick();
  return {service,stop:()=>clearInterval(timer)};
}
