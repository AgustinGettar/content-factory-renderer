import {createHash,createHmac,createPublicKey,verify,randomBytes,timingSafeEqual} from 'node:crypto';

export const MINI_ORIGIN='https://content-factory-av2-staging.onrender.com';
export const MINI_PATH='/lumi/studio';
export const MINI_COOKIE='__Secure-lumi_studio';
const principals=new WeakSet();
const digest=s=>createHash('sha256').update(s).digest('hex');
const equal=(a,b)=>typeof a==='string'&&typeof b==='string'&&Buffer.byteLength(a)===Buffer.byteLength(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
const fail=code=>{throw Object.assign(Error(code),{status:401});};
const telegramPublicKey=createPublicKey({key:Buffer.from('302a300506032b6570032100e7bf03a2fa4602af4580703d88dda5bb59f32ed8b02a56c187fe7d34caed242d','hex'),format:'der',type:'spki'});
export function miniAppSecret(env){
  // Staging already signs sessions/media with the callback secret. Adding a
  // delivery credential must not rotate CSRF, media or consent signatures.
  const secret=env.LUMI_TELEGRAM_CALLBACK_SECRET||env.LUMI_TELEGRAM_BOT_TOKEN;
  if(!secret)fail('MINI_AUTH_CONFIGURATION_REQUIRED');
  return createHmac('sha256',secret).update('lumi-mini-session-v1').digest();
}
export function miniAuthConfigured(env){return !!(env.LUMI_TELEGRAM_BOT_TOKEN||(/^\d+$/.test(env.LUMI_TELEGRAM_BOT_ID||'')&&env.LUMI_TELEGRAM_CALLBACK_SECRET));}
export function miniAuthCredential(env){return env.LUMI_TELEGRAM_BOT_ID&&env.LUMI_TELEGRAM_CALLBACK_SECRET?{botId:env.LUMI_TELEGRAM_BOT_ID}:env.LUMI_TELEGRAM_BOT_TOKEN;}
export function miniAppEnabled(env){
  return env.LUMI_RUNTIME_ENV==='staging'&&env.SUPABASE_URL==='https://mofjhwathxzfnjapvvst.supabase.co'
    &&(!env.RENDER_SERVICE_ID||env.RENDER_SERVICE_ID==='srv-dapgakqd0e5s73fottig')&&env.LUMI_MINI_APP_ENABLED!=='false';
}
export function assertMiniPrincipal(p){if(!principals.has(p)||p.expires_at<=Date.now())fail('MINI_SESSION_REQUIRED');return p;}
export async function mutateMiniState(store,user,change){
  for(let i=0;i<8;i++){
    const row=await store.get(user);if(!row||row.state.user_id!==String(user))fail('MINI_OWNER_REQUIRED');
    row.state.mini_app||={sessions:{},exchanges:{},operations:{}};
    const result=await change(row.state.mini_app,row.state);
    try{await store.cas(user,row.revision,row.state);return result;}catch(e){if(e.message!=='concurrent_update')throw e;}
  }
  throw Error('concurrent_update');
}
// Both official Telegram verification methods; no browser-supplied identity/key.
// publicKey is a low-level test seam. MiniAppAuth always pins Telegram's production key.
export function validateInitData(raw,credential,now=Date.now(),publicKey=telegramPublicKey){
  if(!credential||typeof raw!=='string'||raw.length>16384||!raw)fail('TELEGRAM_INIT_DATA_REQUIRED');
  const params=new URLSearchParams(raw),keys=[...params.keys()];
  if(new Set(keys).size!==keys.length||keys.some(k=>!/^\w+$/.test(k)))fail('TELEGRAM_INIT_DATA_INVALID');
  const hash=params.get('hash');if(!/^[a-f0-9]{64}$/.test(hash||''))fail('TELEGRAM_SIGNATURE_INVALID');
  params.delete('hash');
  const canonical=()=>[...params.entries()].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>`${k}=${v}`).join('\n');
  let exchange;
  if(typeof credential==='string'){
    const secret=createHmac('sha256','WebAppData').update(credential).digest();
    if(!equal(hash,createHmac('sha256',secret).update(canonical()).digest('hex')))fail('TELEGRAM_SIGNATURE_INVALID');
    exchange=digest(hash);
  }else{
    const signature=params.get('signature');
    if(!/^\d+$/.test(credential.botId||'')||!/^[A-Za-z0-9_-]{86}(==)?$/.test(signature||''))fail('TELEGRAM_SIGNATURE_INVALID');
    params.delete('signature');
    const check=credential.botId+':WebAppData\n'+canonical(),bytes=Buffer.from(signature,'base64url');
    if(bytes.length!==64||!verify(null,Buffer.from(check),publicKey,bytes))fail('TELEGRAM_SIGNATURE_INVALID');
    // hash is deliberately unsigned in Telegram's third-party protocol. Never
    // use it for replay identity: changing hash or base64 padding must not replay.
    exchange=digest(check);
  }
  const date=params.get('auth_date'),seconds=Number(date);
  if(!/^\d+$/.test(date||'')||!Number.isSafeInteger(seconds)||seconds*1000>now+30000||now-seconds*1000>300000)fail('TELEGRAM_AUTH_EXPIRED');
  let user,chat;try{user=JSON.parse(params.get('user'));chat=params.has('chat')?JSON.parse(params.get('chat')):null;}catch{fail('TELEGRAM_IDENTITY_INVALID');}
  if(!Number.isSafeInteger(user?.id)||user.id<=0||user.is_bot)fail('TELEGRAM_IDENTITY_INVALID');
  if(chat&&(!Number.isSafeInteger(chat.id)||chat.type!=='private')||params.has('chat_type')&&!['sender','private'].includes(params.get('chat_type')))fail('TELEGRAM_PRIVATE_CHAT_REQUIRED');
  return {user:String(user.id),chat:chat?String(chat.id):String(user.id),exchange,auth_date:seconds};
}
export class MiniAppAuth {
  constructor({store,validateOwner,env}){Object.assign(this,{store,validateOwner,env});}
  csrf(cookie){return createHmac('sha256',miniAppSecret(this.env)).update('lumi-mini-csrf:'+cookie).digest('hex');}
  async login(raw){
    if(!miniAppEnabled(this.env))fail('MINI_STAGING_REQUIRED');
    if(!miniAuthConfigured(this.env))fail('MINI_AUTH_CONFIGURATION_REQUIRED');
    const credential=miniAuthCredential(this.env);
    const id=validateInitData(raw,credential),row=await this.store.get(id.user);
    if(!row||row.state.user_id!==id.user||row.state.chat_id!==id.chat||!await this.validateOwner(id.user,id.chat))fail('MINI_OWNER_REQUIRED');
    const cookie=id.user+'.'+randomBytes(32).toString('hex'),session=digest(cookie),now=Date.now(),expires=now+1800000;
    await mutateMiniState(this.store,id.user,m=>{
      // Retain an exchange longer than initData's maximum usable lifetime.
      for(const [k,v] of Object.entries(m.exchanges))if(v<now-360000)delete m.exchanges[k];
      for(const [k,v] of Object.entries(m.sessions))if(v.expires_at<now)delete m.sessions[k];
      if(m.exchanges[id.exchange])fail('TELEGRAM_INIT_DATA_REPLAY');
      m.exchanges[id.exchange]=now;
      m.sessions[session]={user:id.user,chat:id.chat,expires_at:expires,created_at:now,auth_date:id.auth_date};
      const oldest=Object.entries(m.sessions).sort((a,b)=>a[1].created_at-b[1].created_at);
      for(const [k] of oldest.slice(0,Math.max(0,oldest.length-8)))delete m.sessions[k];
    });
    return {cookie,csrf:this.csrf(cookie),expires_at:expires};
  }
  async authenticate(cookie,csrf=null){
    if(!miniAppEnabled(this.env)||!/^\d+\.[a-f0-9]{64}$/.test(cookie||''))fail('MINI_SESSION_REQUIRED');
    const user=cookie.split('.')[0],session=digest(cookie);
    const row=this.store.getMiniSession?await this.store.getMiniSession(user,session):await this.store.get(user);
    const s=this.store.getMiniSession?row?.session:row?.state.mini_app?.sessions?.[session];
    const owner=this.store.getMiniSession?row:row?.state;
    if(!s||s.expires_at<=Date.now()||s.user!==user||owner.user_id!==user||s.chat!==owner.chat_id||!await this.validateOwner(user,s.chat))fail('MINI_SESSION_EXPIRED');
    if(csrf!==null&&!equal(csrf,this.csrf(cookie)))fail('MINI_CSRF_INVALID');
    const principal=Object.freeze({user,chat:s.chat,session,expires_at:s.expires_at});principals.add(principal);return principal;
  }
}
export function sessionCookie(req){return String(req.headers.cookie||'').split(';').map(v=>v.trim()).find(v=>v.startsWith(MINI_COOKIE+'='))?.slice(MINI_COOKIE.length+1)||'';}
