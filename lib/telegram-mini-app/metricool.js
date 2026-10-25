// Official remote MCP only. No scheduler, upload, generative or REST fallback.
// Registration was accepted by Metricool on 2026-10-25 (public PKCE client).
import {createHash,createHmac,createCipheriv,createDecipheriv,randomBytes,timingSafeEqual} from 'node:crypto';
import {MINI_ORIGIN,MINI_PATH,miniAppSecret,mutateMiniState,assertMiniPrincipal} from './auth.js';
export const METRICOOL=Object.freeze({
  resource:'https://ai.metricool.com/mcp',issuer:'https://ai.metricool.com',
  authorize:'https://app.metricool.com/oauth/authorize',token:'https://app.metricool.com/oauth/token',
  client:'client_4d23246b94e346f4bcd3cffa00cb2c25',
  callback:MINI_ORIGIN+MINI_PATH+'/publication/callback',
  brand:7627207,owner:5949429,label:'lumilaluciernaga',timezone:'Europe/Rome',
  channels:{instagram:'lumilaluciernaga',tiktok:'lumilaluciernaga',youtube:'UC1ib2gAOQRCd45F5Ky1r-0Q'}
});
export const publicationFail=(code,status=409)=>{throw Object.assign(Error(code),{status});};
const sha=v=>createHash('sha256').update(v).digest('hex');
const random=()=>randomBytes(32).toString('base64url');
const equal=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.length===b.length&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
const at=()=>new Date().toISOString();
export function sealMetricool(env,user,value){
  const key=createHmac('sha256',miniAppSecret(env)).update('lumi-metricool-v1').digest(),iv=randomBytes(12);
  const c=createCipheriv('aes-256-gcm',key,iv);c.setAAD(Buffer.from('metricool:'+user));
  return [iv,Buffer.concat([c.update(JSON.stringify(value)),c.final()]),c.getAuthTag()].map(x=>x.toString('base64url')).join('.');
}
export function openMetricool(env,user,sealed){
  try{const [iv,bytes,tag]=sealed.split('.').map(x=>Buffer.from(x,'base64url'));
    const key=createHmac('sha256',miniAppSecret(env)).update('lumi-metricool-v1').digest(),d=createDecipheriv('aes-256-gcm',key,iv);
    d.setAAD(Buffer.from('metricool:'+user));d.setAuthTag(tag);return JSON.parse(Buffer.concat([d.update(bytes),d.final()]).toString());
  }catch{publicationFail('METRICOOL_RECONNECT_REQUIRED');}
}
export function metricoolView(m={}){
  const c=m.metricool||{},v=c.verification,valid=c.status==='BACKEND_VERIFIED'&&v?.verified_at&&Date.now()-Date.parse(v.verified_at)<86400000;
  return {version:1,route:'OFFICIAL_MCP_OAUTH',status:valid?'BACKEND_VERIFIED':c.status==='BACKEND_VERIFIED'?'VERIFICATION_STALE':c.status||'AUTHORIZATION_REQUIRED',
    brand_id:METRICOOL.brand,brand:METRICOOL.label,timezone:METRICOOL.timezone,backend_verified:!!valid,verified_at:v?.verified_at||null,
    connection_url:'https://app.metricool.com/brands/connections?blogId='+METRICOOL.brand,
    networks:Object.entries(METRICOOL.channels).map(([network,channel])=>({network,channel,linked:valid?v.networks[network]:null,backend_verified:!!valid,automatic_publication:false})),
    plan:null,quota_remaining:null,publication_enabled:false,
    blockers:[...(valid?[]:[c.error||'METRICOOL_BACKEND_AUTHORIZATION_REQUIRED']),
      'METRICOOL_VIDEO_INGESTION_CONTRACT_UNVERIFIED','METRICOOL_NETWORK_PERMISSIONS_UNVERIFIED','METRICOOL_QUOTA_UNVERIFIED','METRICOOL_DELIVERY_RECONCILIATION_UNVERIFIED'],
    // A tool name, OAuth scope or scheduler ID alone cannot prove these contracts.
    tools_discovered:v?.tools?.map(t=>t.name)||[],last_check_at:c.last_check_at||null};
}
export class MetricoolConnection {
  constructor({store,env,validateOwner,fetchImpl=fetch}){Object.assign(this,{store,env,validateOwner,fetchImpl});}
  async owner(user){const r=await this.store.get(user);if(!r||r.state.user_id!==user||!await this.validateOwner(user,r.state.chat_id))publicationFail('MINI_OWNER_REQUIRED',401);return r;}
  async start(p){
    assertMiniPrincipal(p);await this.owner(p.user);
    return mutateMiniState(this.store,p.user,m=>{
      if(!m.sessions?.[p.session]||m.sessions[p.session].expires_at<=Date.now())publicationFail('MINI_SESSION_EXPIRED',401);
      const c=m.metricool||={},old=c.pending;
      if(old?.expires_at>Date.now()&&old.phase==='HANDOFF')return {url:this.handoff(p.user,openMetricool(this.env,p.user,old.sealed).handoff)};
      if(old?.expires_at>Date.now()&&['AUTHORIZING','EXCHANGING'].includes(old.phase))publicationFail('METRICOOL_AUTHORIZATION_IN_PROGRESS');
      const handoff=random(),nonce=random(),verifier=random();
      c.pending={phase:'HANDOFF',expires_at:Date.now()+600000,nonce_sha:sha(nonce),handoff_sha:sha(handoff),sealed:sealMetricool(this.env,p.user,{handoff,nonce,verifier})};
      return {url:this.handoff(p.user,handoff)};
    });
  }
  handoff(user,token){return MINI_ORIGIN+MINI_PATH+'/publication/connect/'+this.signed(user,token);}
  signed(user,token){const payload=user+'.'+token;return payload+'.'+createHmac('sha256',miniAppSecret(this.env)).update('metricool-state:'+payload).digest('base64url');}
  parse(value){if(typeof value!=='string'||!/^\d+\.[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/.test(value))publicationFail('METRICOOL_OAUTH_STATE_INVALID',400);
    const [user,nonce]=value.split('.');if(!equal(value,this.signed(user,nonce)))publicationFail('METRICOOL_OAUTH_STATE_INVALID',400);return {user,nonce};}
  async handoffStart(value){
    const {user,nonce}=this.parse(value);await this.owner(user);const browser=random();
    const data=await mutateMiniState(this.store,user,m=>{const p=m.metricool?.pending;
      if(!p||p.phase!=='HANDOFF'||p.expires_at<=Date.now()||!equal(p.handoff_sha,sha(nonce)))publicationFail('METRICOOL_OAUTH_RESTART_REQUIRED');
      p.phase='AUTHORIZING';p.browser_sha=sha(browser);return openMetricool(this.env,user,p.sealed);
    });
    const url=new URL(METRICOOL.authorize);url.search=new URLSearchParams({client_id:METRICOOL.client,redirect_uri:METRICOOL.callback,response_type:'code',scope:'mcp:read mcp:write',resource:METRICOOL.resource,
      state:this.signed(user,data.nonce),code_challenge:createHash('sha256').update(data.verifier).digest('base64url'),code_challenge_method:'S256'});
    return {url:url.href,browser};
  }
  async json(url,options){
    let r;try{r=await this.fetchImpl(url,{...options,redirect:'error',signal:AbortSignal.timeout(15000)});}catch{publicationFail('METRICOOL_CONNECTION_UNAVAILABLE');}
    if(!r.ok)publicationFail(r.status===401?'METRICOOL_ACCESS_EXPIRED':r.status===403?'METRICOOL_PERMISSION_DENIED':'METRICOOL_REMOTE_READ_FAILED');
    const reader=r.body?.getReader();let text='';
    if(reader){let size=0;const parts=[];try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>1048576)publicationFail('METRICOOL_RESPONSE_TOO_LARGE');parts.push(Buffer.from(value));}}finally{await reader.cancel().catch(()=>{});}text=Buffer.concat(parts).toString();}
    else text=await r.text();
    if(text.length>1048576)publicationFail('METRICOOL_RESPONSE_TOO_LARGE');
    if(!text)return {r,value:null};
    try{if(r.headers.get('content-type')?.includes('text/event-stream')){
      const messages=text.split(/\r?\n\r?\n/).map(block=>block.split(/\r?\n/).filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trimStart()).join('\n')).filter(Boolean).map(JSON.parse);
      return {r,value:messages.findLast(x=>x.id!==undefined)};
    }return {r,value:JSON.parse(text)};}catch{publicationFail('METRICOOL_RESPONSE_INVALID');}
  }
  async exchange(params){const {value}=await this.json(METRICOOL.token,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({...params,client_id:METRICOOL.client,resource:METRICOOL.resource}).toString()});
    if(!value?.access_token||String(value.token_type).toLowerCase()!=='bearer'||!Number.isFinite(Number(value.expires_in))||Number(value.expires_in)<=0)publicationFail('METRICOOL_TOKEN_RESPONSE_INVALID');
    return {access_token:value.access_token,refresh_token:value.refresh_token||null,scope:value.scope||'',expires_at:Date.now()+Number(value.expires_in)*1000};
  }
  async callback(query,browser){
    const {user,nonce}=this.parse(query.state);await this.owner(user);
    if(typeof browser!=='string'||!browser)publicationFail('METRICOOL_OAUTH_BROWSER_REQUIRED');
    const pending=await mutateMiniState(this.store,user,m=>{const p=m.metricool?.pending;
      if(!p||p.phase!=='AUTHORIZING'||p.expires_at<=Date.now()||!equal(p.nonce_sha,sha(nonce))||!equal(p.browser_sha,sha(browser)))publicationFail('METRICOOL_OAUTH_STATE_INVALID');
      p.phase='EXCHANGING';return openMetricool(this.env,user,p.sealed);
    });
    try{
      if(query.error||typeof query.code!=='string'||!query.code||query.code.length>4096)publicationFail('METRICOOL_AUTHORIZATION_DECLINED');
      const token=await this.exchange({grant_type:'authorization_code',code:query.code,redirect_uri:METRICOOL.callback,code_verifier:pending.verifier});
      // Persist before discovery. A restart can repeat reads, never code exchange.
      await mutateMiniState(this.store,user,m=>{m.metricool.candidate=sealMetricool(this.env,user,token);m.metricool.pending.phase='TOKEN_RECEIVED';});
      return await this.verifyUser(user,{candidate:true});
    }catch(e){await mutateMiniState(this.store,user,m=>{m.metricool.pending=null;m.metricool.last_check_at=at();m.metricool.error=this.code(e);});throw e;}
  }
  code(e){return /^METRICOOL_[A-Z_]+$/.test(e.message)?e.message:'METRICOOL_VERIFICATION_REQUIRED';}
  async verify(p){assertMiniPrincipal(p);await this.owner(p.user);return this.verifyUser(p.user);}
  async verifyUser(user,{candidate=false}={}){
    await this.owner(user);const lease=random();
    const selected=await mutateMiniState(this.store,user,m=>{const c=m.metricool||={};
      if(c.check_until>Date.now())publicationFail('METRICOOL_VERIFICATION_IN_PROGRESS');
      const slot=candidate||c.candidate?'candidate':'credentials';if(!c[slot])publicationFail('METRICOOL_BACKEND_AUTHORIZATION_REQUIRED');
      if(c.refresh_uncertain&&slot!=='candidate')publicationFail('METRICOOL_RECONNECT_REQUIRED');
      c.check_until=Date.now()+120000;c.check_lease=lease;return {sealed:c[slot],slot};
    });
    let token=openMetricool(this.env,user,selected.sealed);
    try{
      if(token.expires_at<=Date.now()+30000){
        if(!token.refresh_token)publicationFail('METRICOOL_RECONNECT_REQUIRED');
        await mutateMiniState(this.store,user,m=>{if(m.metricool.check_lease!==lease)publicationFail('METRICOOL_VERIFICATION_CHANGED');m.metricool.refresh_uncertain=true;});
        const fresh=await this.exchange({grant_type:'refresh_token',refresh_token:token.refresh_token});
        token={...fresh,refresh_token:fresh.refresh_token||token.refresh_token};
        await mutateMiniState(this.store,user,m=>{const c=m.metricool;if(c.check_lease!==lease)publicationFail('METRICOOL_VERIFICATION_CHANGED');c[selected.slot]=sealMetricool(this.env,user,token);c.refresh_uncertain=false;});
      }
      const verification=await this.discover(token);
      await mutateMiniState(this.store,user,m=>{const c=m.metricool;if(c.check_lease!==lease)publicationFail('METRICOOL_VERIFICATION_CHANGED');
        c.credentials=sealMetricool(this.env,user,token);delete c.candidate;c.pending=null;c.verification=verification;c.status='BACKEND_VERIFIED';c.error=null;c.refresh_uncertain=false;});
    }catch(e){await mutateMiniState(this.store,user,m=>{const c=m.metricool;c.error=this.code(e);c.status='REQUIRES_ATTENTION';if(e.message==='METRICOOL_OWNER_OR_BRAND_MISMATCH')delete c.candidate;});throw e;
    }finally{await mutateMiniState(this.store,user,m=>{const c=m.metricool;if(c.check_lease===lease){c.check_until=0;c.last_check_at=at();}});}
    return metricoolView((await this.store.get(user)).state.mini_app);
  }
  async discover(token){
    let session=null,protocol='2025-03-26',id=0;
    const rpc=async(method,params,notification=false)=>{
      // Closed read allowlist even if the provider advertises write tools.
      if(!['initialize','notifications/initialized','tools/list','tools/call'].includes(method)||method==='tools/call'&&!/^get_?brand_?settings$/i.test(params.name))publicationFail('METRICOOL_WRITE_TRANSPORT_DISABLED');
      const requestId=notification?undefined:++id;
      const {r,value}=await this.json(METRICOOL.resource,{method:'POST',headers:{authorization:'Bearer '+token.access_token,accept:'application/json, text/event-stream','content-type':'application/json',...(session?{'mcp-session-id':session}:{}),...(method!=='initialize'?{'mcp-protocol-version':protocol}:{})},body:JSON.stringify({jsonrpc:'2.0',...(notification?{}:{id:requestId}),method,params})});
      session=r.headers.get('mcp-session-id')||session;
      if(notification)return;
      if(value?.id!==requestId||value?.error||!value?.result)publicationFail('METRICOOL_MCP_CONTRACT_INVALID');return value.result;
    };
    const init=await rpc('initialize',{protocolVersion:protocol,capabilities:{},clientInfo:{name:'lumi-studio',version:'1.0.0'}});
    if(!['2024-11-05','2025-03-26','2025-06-18','2025-11-25'].includes(init.protocolVersion))publicationFail('METRICOOL_PROTOCOL_UNSUPPORTED');protocol=init.protocolVersion;
    await rpc('notifications/initialized',{},true);
    const tools=[];let cursor;
    for(let page=0;page<5;page++){const list=await rpc('tools/list',cursor?{cursor}:{});if(!Array.isArray(list.tools))publicationFail('METRICOOL_TOOL_DISCOVERY_REQUIRED');tools.push(...list.tools);cursor=list.nextCursor;if(!cursor)break;}
    if(cursor||tools.length>200)publicationFail('METRICOOL_TOOL_DISCOVERY_REQUIRED');
    const brandTools=tools.filter(t=>/^get_?brand_?settings$/i.test(t.name));
    if(brandTools.length!==1||brandTools[0].inputSchema?.required?.length)publicationFail('METRICOOL_BRAND_READ_UNSUPPORTED');
    const result=await rpc('tools/call',{name:brandTools[0].name,arguments:{}});
    if(result.isError)publicationFail('METRICOOL_BRAND_READ_FAILED');
    let data=result.structuredContent;
    if(!data){try{data=JSON.parse(result.content?.filter(c=>c.type==='text').map(c=>c.text).join('\n'));}catch{publicationFail('METRICOOL_BRAND_RESPONSE_INVALID');}}
    const brands=Array.isArray(data)?data:data?.data;
    const brand=Array.isArray(brands)?brands.find(b=>Number(b.id??b.blogId)===METRICOOL.brand):null;
    if(!brand||Number(brand.userId)!==METRICOOL.owner||Number(brand.ownerUserId)!==METRICOOL.owner||brand.label!==METRICOOL.label||brand.timezone!==METRICOOL.timezone)publicationFail('METRICOOL_OWNER_OR_BRAND_MISMATCH');
    const networks=Object.fromEntries(Object.entries(METRICOOL.channels).map(([n,channel])=>[n,brand.networksData?.[n+'Data']===channel]));
    return {verified_at:at(),brand_id:METRICOOL.brand,owner_id:METRICOOL.owner,networks,scope:token.scope,
      protocol,tools:tools.map(t=>({name:t.name,inputSchema:t.inputSchema})),schema_sha:sha(JSON.stringify(tools.map(t=>[t.name,t.inputSchema])))};
  }
}
