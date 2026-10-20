import {randomUUID,timingSafeEqual,createHmac} from 'node:crypto';
import {sha256} from './core.js';
import {miniAppEnabled,MINI_ORIGIN,MINI_PATH} from '../telegram-mini-app/auth.js';

export const DIRECT_PATH='/lumi/telegram-review/telegram/webhook';
export const CUTOVER_PATH='/lumi/telegram-review/telegram/cutover';
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
const cutoverOpen=env=>directConfigured(env)&&/^[A-Za-z0-9_-]{32,256}$/.test(env.LUMI_TELEGRAM_CUTOVER_KEY||'')
  &&![env.LUMI_TELEGRAM_BOT_TOKEN,env.LUMI_TELEGRAM_WEBHOOK_SECRET,env.LUMI_TELEGRAM_CALLBACK_SECRET].includes(env.LUMI_TELEGRAM_CUTOVER_KEY)
  &&Date.parse(env.LUMI_TELEGRAM_CUTOVER_EXPIRES_AT)>Date.now();

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
  async cutoverOwner(){
    const owners=[];
    for(const u of (this.env.LUMI_TELEGRAM_REVIEW_TEST_USERS||'').split(',').filter(Boolean))if(await this.owner(u))owners.push(u);
    if(owners.length!==1)fail('DIRECT_CUTOVER_OWNER_REQUIRED');
    const row=await this.store.get(owners[0]);if(row?.state.chat_id!==owners[0])fail('DIRECT_CUTOVER_OWNER_REQUIRED');
    return owners[0];
  }
  async inspectCutover(){
    if(!cutoverOpen(this.env))fail('DIRECT_CUTOVER_CLOSED');
    await this.verify();const user=await this.cutoverOwner();
    const info=await this.transport.call('getWebhookInfo',{}),menu=await this.transport.call('getChatMenuButton',{chat_id:user});
    const row=await this.store.get(user),key=`direct:${this.env.LUMI_TELEGRAM_BOT_ID}:cutover:v1`;
    // Never return the old webhook URL, provider descriptions, keys or headers.
    return {bot_id:this.env.LUMI_TELEGRAM_BOT_ID,username:'AppMultimedia_VideosBot',identity_verified:true,
      destination_direct:info.url===MINI_ORIGIN+DIRECT_PATH,destination_sha256:sha256(info.url||''),
      pending_update_count:info.pending_update_count,allowed_updates:info.allowed_updates||null,
      last_error_date:info.last_error_date||null,last_error_present:!!info.last_error_message,
      menu_verified:menu?.type==='web_app'&&menu?.text==='Abrir Lumi Studio'&&menu?.web_app?.url===MINI_ORIGIN+MINI_PATH,
      cutover_receipt:row.state.make_requests?.[key]||null};
  }
  async configureCutover(expected){
    const before=await this.inspectCutover();
    if(before.destination_sha256!==expected)fail('DIRECT_CUTOVER_DESTINATION_CHANGED');
    if(before.destination_direct)return before;
    if(!before.menu_verified)fail('DIRECT_CUTOVER_MENU_REQUIRED');
    const user=await this.cutoverOwner(),key=`direct:${this.env.LUMI_TELEGRAM_BOT_ID}:cutover:v1`,row=await this.store.get(user);
    row.state.make_requests||={};
    if(row.state.make_requests[key])return before; // uncertain/restarted request: inspect only, never resubmit
    const dispatch_id=randomUUID();
    row.state.make_requests[key]={transport:'TELEGRAM_DIRECT',kind:'OPERATOR_CUTOVER',status:'DISPATCHING',dispatch_id,
      created_at:new Date().toISOString(),prior_destination_sha256:expected,staging_sha:this.env.RENDER_GIT_COMMIT};
    // Use the same session CAS as all other transport effects. No new journal.
    await this.store.cas(user,row.revision,row.state);
    if(!cutoverOpen(this.env)||!await this.owner(user))fail('DIRECT_CUTOVER_CLOSED');
    const current=await this.transport.call('getWebhookInfo',{});
    if(sha256(current.url||'')!==expected)fail('DIRECT_CUTOVER_DESTINATION_CHANGED');
    let acknowledged=false;
    try{acknowledged=await this.transport.call('setWebhook',{url:MINI_ORIGIN+DIRECT_PATH,
      secret_token:this.env.LUMI_TELEGRAM_WEBHOOK_SECRET,allowed_updates:['message','callback_query'],drop_pending_updates:false})===true;}
    catch{/* Lost response is reconciled by inspection, never a second setWebhook. */}
    const after=await this.inspectCutover();
    for(let i=0;i<8;i++){
      const latest=await this.store.get(user),r=latest.state.make_requests?.[key];
      if(r?.dispatch_id!==dispatch_id)fail('DIRECT_CUTOVER_CLAIM_CONFLICT');
      r.status=after.destination_direct?'VERIFIED':'UNKNOWN';r.acknowledged=acknowledged;r.finished_at=new Date().toISOString();
      r.pending_update_count=after.pending_update_count;
      try{await this.store.cas(user,latest.revision,latest.state);after.cutover_receipt=r;return after;}
      catch(e){if(e.message!=='concurrent_update')throw e;}
    }
    fail('DIRECT_CUTOVER_CAS_CONFLICT');
  }
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
  // Explicit, expiring operator control. Not a startup hook and not available
  // to Mini App callers. Secret stays inside Render -> Telegram transport.
  app.post(CUTOVER_PATH,async(req,res)=>{
    const body=req.body,ts=req.headers['x-lumi-cutover-timestamp'],signature=req.headers['x-lumi-cutover-signature'];
    if(!cutoverOpen(env))return res.status(404).json({error:'DIRECT_CUTOVER_CLOSED'});
    if(!body||Array.isArray(body)||Buffer.byteLength(JSON.stringify(body))>1024||!req.is('application/json')
      ||!/^[0-9]{10}$/.test(ts||'')||Math.abs(Date.now()/1000-Number(ts))>60
      ||!equal(signature,createHmac('sha256',env.LUMI_TELEGRAM_CUTOVER_KEY).update(ts+'\n'+JSON.stringify(body)).digest('hex')))
      return res.status(401).json({error:'UNAUTHORIZED'});
    if(!['INSPECT','CONFIGURE'].includes(body.action)||body.expected_staging_sha!==env.RENDER_GIT_COMMIT
      ||Object.keys(body).some(k=>!['action','expected_staging_sha','expected_destination_sha256'].includes(k))
      ||body.action==='CONFIGURE'&&!/^[a-f0-9]{64}$/.test(body.expected_destination_sha256||''))
      return res.status(400).json({error:'DIRECT_CUTOVER_REQUEST_INVALID'});
    try{res.json(body.action==='INSPECT'?await service.inspectCutover():await service.configureCutover(body.expected_destination_sha256));}
    catch(e){res.status(409).json({error:/^DIRECT_[A-Z_]+$/.test(e.message)?e.message:'DIRECT_CUTOVER_RECONCILE_REQUIRED'});}
  });
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
