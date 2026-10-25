import {createHash} from 'node:crypto';
import {publicationDraft} from './publication.js';
import {METRICOOL,MetricoolConnection,metricoolView,publicationFail as fail} from './metricool.js';
import {MINI_PATH,assertMiniPrincipal,mutateMiniState} from './auth.js';
import {artifactReview,validateArtifact} from '../telegram-review-v1/core.js';

export const NETWORK_LIMITS={instagram:2200,tiktok:2000,youtube:5000};
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
export function publicationPackage(state,id,{objective}={}){
  const e=Object.hasOwn(state.episodes||{},id)?state.episodes[id]:null;if(!e)fail('PUBLICATION_EPISODE_NOT_FOUND',404);
  const base=publicationDraft({title:e.title,objective}),saved=state.mini_app?.publication_packages?.[id];
  const networks=Object.fromEntries(Object.keys(METRICOOL.channels).map(network=>[network,{title:String(e.title||'Una aventura de Lumi').slice(0,100),
    text:network==='youtube'?base.text+' #Shorts':base.text,privacy:null,made_for_kids:network==='youtube'?true:null,ai_generated:true}]));
  const pkg=saved?.versions?.find(v=>v.version===saved.current);
  let master=null;try{validateArtifact(e.master);if(e.master.mime==='video/mp4')master={sha256:e.master.sha256,version:e.master.artifact_id,width:e.master.width??null,height:e.master.height??null,approved:artifactReview(e,e.master)?.status==='APPROVED'};}catch{}
  return {...base,version:pkg?.version||0,text:pkg?.networks.instagram.text||base.text,networks:pkg?.networks||networks,
    package_sha:pkg?.master_sha===(master?.sha256||null)?pkg.package_sha:null,saved_at:pkg?.saved_at||null,master,
    authorization:null,status:'PREPARED_LOCAL',publication_enabled:false};
}
function validateNetworks(value){
  if(!value||Object.keys(value).sort().join(',')!=='instagram,tiktok,youtube')fail('PUBLICATION_NETWORKS_INVALID',400);
  return Object.fromEntries(Object.keys(NETWORK_LIMITS).map(n=>{
    const v=value[n];if(!v||Object.keys(v).sort().join(',')!=='ai_generated,made_for_kids,privacy,text,title')fail('PUBLICATION_FIELDS_INVALID',400);
    for(const [key,max] of [['text',NETWORK_LIMITS[n]],['title',100]])if(typeof v[key]!=='string'||!v[key].trim()||Array.from(v[key]).length>max||/[\u0000-\u0008\u000b-\u001f]/.test(v[key]))fail('PUBLICATION_TEXT_LIMIT',400);
    // Privacy choices and their provider enums must come from verified capabilities.
    // Preparation deliberately cannot turn a guessed privacy into an authorization.
    if(v.privacy!==null||v.ai_generated!==true||v.made_for_kids!==(n==='youtube'?true:null))fail('PUBLICATION_METADATA_UNVERIFIED',400);
    return [n,{title:v.title,text:v.text,privacy:null,made_for_kids:v.made_for_kids,ai_generated:true}];
  }));
}
export class PublicationStore {
  constructor({store}){this.store=store;}
  async save(p,id,body){
    assertMiniPrincipal(p);
    if(Object.keys(body).sort().join(',')!=='networks,version'||!Number.isInteger(body.version)||body.version<0)fail('PUBLICATION_BODY_INVALID',400);
    const networks=validateNetworks(body.networks);
    return mutateMiniState(this.store,p.user,(m,state)=>{
      if(m.sessions?.[p.session]?.expires_at<=Date.now()||!m.sessions?.[p.session])fail('MINI_SESSION_EXPIRED',401);
      publicationPackage(state,id);m.publication_packages||={};
      const draft=m.publication_packages[id]||={current:0,versions:[]};
      if(Object.values(m.publication_intents||{}).some(i=>i.episode_id===id&&!['CANCELED_BEFORE_SEND','REJECTED_BEFORE_SEND'].includes(i.status)))fail('PUBLICATION_EXISTING_INTENT_REQUIRES_ATTENTION');
      const master=publicationPackage(state,id).master;
      const content=hash({owner:p.user,episode:id,brand:METRICOOL.brand,master_sha:master?.sha256||null,networks});
      const previous=draft.versions.find(v=>v.version===draft.current);
      if(previous?.content_sha===content)return publicationPackage(state,id); // double tap/lost save ACK
      if(draft.current!==body.version)fail('PUBLICATION_VERSION_CONFLICT');
      if(draft.versions.length>=256)fail('PUBLICATION_VERSION_LIMIT');
      const version=draft.current+1;
      draft.versions.push({version,content_sha:content,package_sha:hash({owner:p.user,episode:id,brand:METRICOOL.brand,master_sha:master?.sha256||null,version,networks}),networks,saved_by:p.user,saved_at:new Date().toISOString(),master_sha:master?.sha256||null,authorization:null});
      draft.current=version;return publicationPackage(state,id);
    });
  }
  async refuseSubmission(p,id,body){
    assertMiniPrincipal(p);const row=await this.store.get(p.user),pkg=publicationPackage(row.state,id);
    if(body?.brand_id!==undefined&&body.brand_id!==METRICOOL.brand)fail('PUBLICATION_BRAND_MISMATCH');
    if(!pkg.master)fail('PUBLICATION_MASTER_REQUIRED');
    if(!pkg.master.approved)fail('PUBLICATION_MASTER_HUMAN_REVIEW_REQUIRED');
    // Old artistic approval, a chosen destination or an OAuth grant is never social consent.
    // No remote write adapter is installed until the actual video/capability/receipt
    // schemas have been verified independently of the ChatGPT connector.
    fail(metricoolView(row.state.mini_app).backend_verified?'PUBLICATION_PROVIDER_CONTRACT_UNVERIFIED':'METRICOOL_BACKEND_AUTHORIZATION_REQUIRED');
  }
}

export function mountPublication(app,{api,principal,wrap,store,env,validateOwner,fetchImpl}){
  const packages=new PublicationStore({store}),connection=new MetricoolConnection({store,env,validateOwner,fetchImpl});
  app.get(api+'/publication/status',wrap(async(req,res)=>{const p=await principal(req);res.json(metricoolView((await store.get(p.user)).state.mini_app));}));
  app.get(api+'/publication/episodes/:episode',wrap(async(req,res)=>{const p=await principal(req);res.json(publicationPackage((await store.get(p.user)).state,req.params.episode));}));
  app.post(api+'/publication/episodes/:episode',wrap(async(req,res)=>res.json(await packages.save(await principal(req),req.params.episode,req.body||{}))));
  app.post(api+'/publication/episodes/:episode/submit',wrap(async(req,res)=>res.json(await packages.refuseSubmission(await principal(req),req.params.episode,req.body||{}))));
  app.post(api+'/publication/connect',wrap(async(req,res)=>{if(Object.keys(req.body||{}).length)fail('PUBLICATION_BODY_INVALID',400);res.json(await connection.start(await principal(req)));}));
  app.post(api+'/publication/verify',wrap(async(req,res)=>{if(Object.keys(req.body||{}).length)fail('PUBLICATION_BODY_INVALID',400);res.json(await connection.verify(await principal(req)));}));
  const cookie='__Secure-lumi_metricool_oauth',path=MINI_PATH+'/publication';
  app.get(path+'/connect/:ticket',wrap(async(req,res)=>{
    const r=await connection.handoffStart(req.params.ticket);
    res.set('Set-Cookie',`${cookie}=${r.browser}; Path=${path}; Max-Age=600; Secure; HttpOnly; SameSite=Lax`);
    res.redirect(303,r.url);
  }));
  app.get(path+'/callback',async(req,res)=>{
    const browser=String(req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith(cookie+'='))?.slice(cookie.length+1);
    let status='connected';try{await connection.callback(req.query,browser);}catch{status='attention';}
    res.set('Set-Cookie',`${cookie}=; Path=${path}; Max-Age=0; Secure; HttpOnly; SameSite=Lax`);
    res.redirect(303,path+'/result?status='+status);
  });
  app.get(path+'/result',(req,res)=>res.type('html').send('<!doctype html><html lang="es"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Lumi · Metricool</title><h1>'+ (req.query.status==='connected'?'Acceso verificado':'Revisá el estado de la conexión')+'</h1><p>Volvé a Telegram → Lumi Studio → Ajustes → Publicación. Allí queda guardado el resultado.</p><p>No se publicó, programó ni subió ningún video. Conectar una cuenta no autoriza una publicación.</p></html>'));
  return {packages,connection};
}
