import {createHash,createHmac,timingSafeEqual} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {assertMiniPrincipal,miniAppSecret,MINI_PATH} from './auth.js';

export const ASSET_TYPES=Object.freeze(['CHARACTER_REFERENCE','SCENE_REFERENCE','APPROVED_IMAGE','APPROVED_VIDEO','BACKGROUND','MASTER']);
export const REUSE_MODES=Object.freeze(['REFERENCE_REUSE','DIRECT_MEDIA_REUSE','DERIVED_ASSET']);
const digest=v=>createHash('sha256').update(typeof v==='string'||Buffer.isBuffer(v)?v:JSON.stringify(v)).digest('hex');
const fail=(code,status=409)=>{throw Object.assign(Error(code),{status});};
const id=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(v);
const safeRef=a=>a&&/^[a-z0-9-]+$/.test(a.bucket||'')&&typeof a.path==='string'&&a.path.length<1000&&!/(^\/|\.\.|:\/\/)/.test(a.path);
const isHash=v=>/^[a-f0-9]{64}$/.test(v||'');
const canonicalFile=new URL('../../docs/LUMI_EP004_FIRST_SOURCE_PROPOSAL.json',import.meta.url);
const approvalFile=new URL('../../docs/cinematic-director-v1/evidence/LUMI_SERIES_V2_QUALITY_GATE_REPORT.json',import.meta.url);

export function approvalEvidence(a,review,source){
  const matches=(review?.artifact_sha??review?.source_sha)===a.sha256;
  const human=review?.status==='APPROVED'&&review.user&&review.timestamp&&(review.callback_query_id||review.mini_app_operation_id||review.callback_provenance?.source==='AUTHENTIC_TELEGRAM_CALLBACK');
  const historical=source.startsWith('repository:')&&review?.status==='HUMAN_APPROVED'&&review.statement;
  if(!matches||!(human||historical))return {status:'PENDING_VERIFICATION',source,artifact_sha256:a.sha256,scope:'ORIGINAL_MEDIA',reason:'EXACT_HASH_HUMAN_APPROVAL_REQUIRED'};
  return {status:'HUMAN_APPROVED',source,artifact_sha256:a.sha256,evidence_sha256:digest(review),scope:'ORIGINAL_MEDIA',
    reviewed_at:review.timestamp??null,review_version:review.review_version??1,
    decision:structuredClone(review)};
}
export function verifiedAsset(candidate,bytes){
  const {a,owner,episode,shot=null,type,subject='',name,description,review,source,canonical=null,tags=[]}=candidate;
  if(!safeRef(a)||!isHash(a.sha256)||!ASSET_TYPES.includes(type)||!/^\d+$/.test(String(owner))||!id(episode))fail('LIBRARY_METADATA_INVALID');
  if(!Buffer.isBuffer(bytes)||bytes.length!==a.size||bytes.length>100000000||digest(bytes)!==a.sha256)fail('LIBRARY_HASH_MISMATCH');
  let width=a.width,height=a.height;
  if(a.mime==='image/png'){
    if(bytes.length<24||bytes.subarray(0,8).toString('hex')!=='89504e470d0a1a0a')fail('LIBRARY_MEDIA_INVALID');
    width=bytes.readUInt32BE(16);height=bytes.readUInt32BE(20);
    if(a.width&&a.width!==width||a.height&&a.height!==height)fail('LIBRARY_DIMENSIONS_MISMATCH');
  }
  if(!['image/png','image/jpeg','video/mp4'].includes(a.mime)||!Number.isSafeInteger(width)||width<=0||!Number.isSafeInteger(height)||height<=0||a.mime==='video/mp4'&&!(a.duration>0))fail('LIBRARY_METADATA_INVALID');
  const approval=approvalEvidence(a,review,source),approved=approval.status==='HUMAN_APPROVED';
  if(subject)approval.scope='WHOLE_IMAGE_CONTEXT_REFERENCE';
  const series=digest([String(owner),episode,shot,type,subject]);
  return {asset_id:digest([series,a.sha256,approval.status,approval.evidence_sha256??null]),owner_id:String(owner),series_key:series,
    asset_type:type,subject_key:subject,display_name:name,description,source_episode_id:episode,source_shot_id:shot,
    storage_reference:{bucket:a.bucket,path:a.path},sha256:a.sha256,media_type:a.mime,size_bytes:a.size,
    dimensions:{width,height},duration:a.mime==='video/mp4'?a.duration:null,approval_status:approval.status,approval_reference:approval,
    version:1,reuse_policy:{modes:approved?(a.mime.startsWith('image/')?['REFERENCE_REUSE',...(subject||type==='CHARACTER_REFERENCE'||type==='SCENE_REFERENCE'?[]:['DIRECT_MEDIA_REUSE']),'DERIVED_ASSET']:['DIRECT_MEDIA_REUSE','DERIVED_ASSET']):[],
      reference_generation_has_cost:true,derivative_requires_new_approval:true,original_immutable:true,standalone_model:false},
    continuity_tags:tags,canonical_reference:canonical,integrity_verified_at:new Date().toISOString()};
}
export function reuseContract(asset,{target_episode_id,target_shot_id,mode}){
  if(!id(target_episode_id)||!id(target_shot_id)||!REUSE_MODES.includes(mode))fail('LIBRARY_REUSE_INPUT_INVALID',400);
  if(asset.approval_status!=='HUMAN_APPROVED'||!asset.reuse_policy.modes.includes(mode))fail('LIBRARY_REUSE_NOT_APPROVED');
  return {schema:'LUMI_ASSET_REUSE_V1',status:'DRAFT_NOT_APPLIED',mode,target_episode_id,target_shot_id,
    asset_id:asset.asset_id,asset_version:asset.version,sha256:asset.sha256,storage_reference:asset.storage_reference,
    media_type:asset.media_type,dimensions:asset.dimensions,duration:asset.duration,
    source_episode_id:asset.source_episode_id,source_shot_id:asset.source_shot_id,approval_reference:Object.fromEntries(Object.entries(asset.approval_reference).filter(([k])=>k!=='decision')),
    continuity_tags:asset.continuity_tags,canonical_reference:asset.canonical_reference,
    use:mode==='REFERENCE_REUSE'?'IDENTITY_OR_SCENE_REFERENCE':mode==='DIRECT_MEDIA_REUSE'?'EXACT_ORIGINAL_MEDIA':'NEW_DERIVATIVE_REQUIRES_APPROVAL',
    generation_authorized:false,provider_calls:0,regeneration_required:mode==='DIRECT_MEDIA_REUSE'?false:null,
    generation_cost:mode==='REFERENCE_REUSE'?'NEW_GENERATION_REQUIRES_QUOTE_AND_AUTHORIZATION':mode==='DERIVED_ASSET'?'PROCESSING_NOT_AUTHORIZED':'NO_GENERATION',
    approval_inherited:mode==='DIRECT_MEDIA_REUSE',source_approval_preserved:true};
}

export class SupabaseLibraryStore {
  constructor(db){this.db=db;}
  async list(owner){const {data,error}=await this.db.from('lumi_library_assets').select('*').eq('owner_id',owner).order('created_at',{ascending:false}).limit(500);if(error)fail('LIBRARY_UNAVAILABLE',503);return data||[];}
  async get(owner,asset){const {data,error}=await this.db.from('lumi_library_assets').select('*').eq('owner_id',owner).eq('asset_id',asset).maybeSingle();if(error)fail('LIBRARY_UNAVAILABLE',503);if(!data)fail('LIBRARY_ASSET_NOT_FOUND',404);return data;}
  async register(candidate){const {data,error}=await this.db.rpc('lumi_library_register_v1',{candidate});if(error)fail('LIBRARY_REGISTRATION_FAILED');return data;}
  async selections(owner){const {data,error}=await this.db.from('lumi_library_selections').select('*').eq('owner_id',owner).order('created_at',{ascending:false}).limit(100);if(error)fail('LIBRARY_UNAVAILABLE',503);return data||[];}
  async save(selection){const {error}=await this.db.from('lumi_library_selections').upsert(selection,{onConflict:'selection_id',ignoreDuplicates:true});if(error)fail('LIBRARY_SELECTION_FAILED');return this.selection(selection.owner_id,selection.selection_id);}
  async selection(owner,selection){const {data,error}=await this.db.from('lumi_library_selections').select('*').eq('owner_id',owner).eq('selection_id',selection).maybeSingle();if(error)fail('LIBRARY_UNAVAILABLE',503);if(!data)fail('LIBRARY_SELECTION_NOT_FOUND',404);return data;}
  async target(owner,episode){const {data,error}=await this.db.from('lumi_pipeline_checkpoints').select('metadata').eq('episode_id',episode).maybeSingle();if(error)fail('LIBRARY_UNAVAILABLE',503);if(data&&String(data.metadata?.user)!==String(owner))fail('LIBRARY_TARGET_FORBIDDEN',403);}
}
export class LumiLibrary {
  constructor({store,loadBytes,privateBucket,env}){Object.assign(this,{store,loadBytes,privateBucket,env});}
  descriptor(a){return {artifact_id:a.asset_id,sha256:a.sha256,size:a.size_bytes,mime:a.media_type,...a.storage_reference,...a.dimensions,duration:a.duration};}
  async bytes(a){if(!await this.privateBucket(a.storage_reference.bucket))fail('LIBRARY_PRIVATE_STORAGE_REQUIRED',403);const b=await this.loadBytes(this.descriptor(a));if(b.length!==a.size_bytes||digest(b)!==a.sha256)fail('LIBRARY_HASH_MISMATCH');return b;}
  ticket(p,a,expires){return createHmac('sha256',miniAppSecret(this.env)).update(JSON.stringify(['library-v1',p.session,p.user,a.asset_id,a.sha256,expires])).digest('hex');}
  publicAsset(p,a){const expires=Math.min(Date.now()+300000,p.expires_at);const {owner_id,series_key,storage_reference,approval_reference,...visible}=a;
    // Keep internal principal/callback identifiers off the client.
    return {...visible,approval_reference:{source:approval_reference.source,status:approval_reference.status,artifact_sha256:approval_reference.artifact_sha256,
      evidence_sha256:approval_reference.evidence_sha256,scope:approval_reference.scope,reviewed_at:approval_reference.reviewed_at,review_version:approval_reference.review_version,reason:approval_reference.reason},
      reusable:a.approval_status==='HUMAN_APPROVED',media_url:`${MINI_PATH}/api/library/media/${a.asset_id}?expires=${expires}&ticket=${this.ticket(p,a,expires)}`,expires_at:expires};
  }
  async list(p){assertMiniPrincipal(p);const assets=await this.store.list(p.user);return {version:1,assets:assets.map(a=>this.publicAsset(p,a)),counts:Object.fromEntries(ASSET_TYPES.map(t=>[t,assets.filter(a=>a.asset_type===t).length])),selections:(await this.store.selections(p.user)).map(s=>({selection_id:s.selection_id,asset_id:s.asset_id,target_episode_id:s.target_episode_id,target_shot_id:s.target_shot_id,mode:s.mode,created_at:s.created_at,status:s.contract.status})),provider_calls:0};}
  async media(p,assetId,expires,ticket){assertMiniPrincipal(p);if(!isHash(assetId))fail('LIBRARY_ASSET_NOT_FOUND',404);const a=await this.store.get(p.user,assetId),n=Number(expires);
    if(!Number.isSafeInteger(n)||n<=Date.now()||n>Math.min(p.expires_at,Date.now()+300000)||!isHash(ticket)||!timingSafeEqual(Buffer.from(this.ticket(p,a,n)),Buffer.from(ticket)))fail('LIBRARY_MEDIA_EXPIRED',403);
    return {asset:a,bytes:await this.bytes(a)};
  }
  async select(p,input){assertMiniPrincipal(p);if(Object.keys(input).some(k=>!['asset_id','target_episode_id','target_shot_id','mode'].includes(k))||!isHash(input.asset_id))fail('LIBRARY_REUSE_INPUT_INVALID',400);
    const a=await this.store.get(p.user,input.asset_id),contract=reuseContract(a,input);
    await this.store.target(p.user,input.target_episode_id);await this.bytes(a);
    const selection_id=digest([p.user,a.asset_id,contract.target_episode_id,contract.target_shot_id,contract.mode]);
    const saved=await this.store.save({selection_id,owner_id:p.user,asset_id:a.asset_id,target_episode_id:contract.target_episode_id,target_shot_id:contract.target_shot_id,mode:contract.mode,contract});
    return {selection_id:saved.selection_id,status:'DRAFT_NOT_APPLIED',provider_calls:0};
  }
  async resolve(p,selectionId){assertMiniPrincipal(p);if(!isHash(selectionId))fail('LIBRARY_SELECTION_NOT_FOUND',404);const s=await this.store.selection(p.user,selectionId),a=await this.store.get(p.user,s.asset_id);
    const contract=reuseContract(a,s);await this.store.target(p.user,s.target_episode_id);await this.bytes(a);
    if(digest(contract)!==digest(s.contract))fail('LIBRARY_CONTRACT_CHANGED');
    return {selection_id:s.selection_id,contract,media:this.publicAsset(p,a),provider_calls:0};
  }
}

// Read existing durable human decisions. Never call a production adapter or mutate
// a review session/checkpoint. A missing staging object is skipped, never fetched
// from another environment. References to subjects share the original full image.
export function sessionCandidates(row,checkpoints){
  const owner=String(row.user_id),state=row.state,out=[];
  for(const [episode,e] of Object.entries(state.episodes||{})){
    const cp=checkpoints.find(c=>c.episode_id===episode&&String(c.metadata?.user)===owner);
    const reviews=[...Object.values(e.review_requests||{}),...Object.values(cp?.metadata?.review_requests||{})];
    const all=new Map();
    if(e.master)all.set(e.master.sha256,{a:e.master,type:'MASTER',shot:null});
    for(const shot of e.shots||[])if(shot.artifact)all.set(shot.artifact.sha256,{a:shot.artifact,type:shot.artifact.mime==='video/mp4'?'APPROVED_VIDEO':'APPROVED_IMAGE',shot:shot.shot_id});
    for(const r of reviews){const a=e.artifacts?.[r.artifact_id]??cp?.metadata?.artifacts?.[r.artifact_id]??cp?.actions?.find(x=>x.artifact?.sha256===r.artifact_sha)?.artifact;
      if(a&&['image/png','image/jpeg','video/mp4'].includes(a.mime))all.set(a.sha256,{a,type:a.mime==='video/mp4'?'APPROVED_VIDEO':'APPROVED_IMAGE',shot:r.action_key?.split(':').slice(1).join(':')||null});}
    for(const {a,type,shot} of all.values()){
      const request=reviews.find(r=>r.artifact_sha===a.sha256&&r.status==='APPROVED');
      const review=request?.human_decision??Object.values(e.reviews||{}).find(r=>r.artifact_sha===a.sha256&&r.status==='APPROVED');
      const base={a,owner,episode,shot,type,name:type==='MASTER'?e.title:`${type==='APPROVED_IMAGE'?'Imagen':'Clip'} · ${shot||e.title}`,description:'Original conservado, con procedencia y aprobación vinculadas al archivo.',review,source:`review-session:${episode}:${request?.review_request_id||a.sha256}`,canonical:request?.review_contract?.canonical_sha?{sha256:request.review_contract.canonical_sha}:null,tags:[]};
      out.push(base);
      if(type==='APPROVED_IMAGE'&&review){
        const videoReview=reviews.find(r=>r.status==='APPROVED'&&r.review_contract?.source_sha===a.sha256),inventory=videoReview?.review_contract?.inventory;
        if(Array.isArray(inventory)){
          for(const item of inventory)out.push({...base,type:'CHARACTER_REFERENCE',subject:item.id,name:`${({cow:'Vaca',sheep:'Oveja',hen:'Gallina'})[item.id]||item.id} · referencia en imagen`,description:`Aparición en la imagen completa aprobada. ${item.color}; ${item.shape}. No es un modelo 3D ni un recorte independiente.`,canonical:videoReview.review_contract.canonical_sha?{sha256:videoReview.review_contract.canonical_sha}:null,tags:[item.id,item.color,item.shape,item.placement]});
          out.push({...base,type:'SCENE_REFERENCE',subject:'scene',name:`Escenario · ${e.title}`,description:'Escenario visible en la imagen completa aprobada, con sus personajes. No es un fondo separado.',tags:inventory.map(i=>i.id)});
        }
      }
    }
  }
  return out;
}
export async function syncLibrary({db,store,loadBytes,privateBucket,ownerId=null}){
  const {data:owners,error:oe}=await db.from('cf_bot_admins').select('user_id,chat_id').eq('active',true);if(oe)fail('LIBRARY_OWNER_UNAVAILABLE');
  const {data:checkpoints,error:ce}=await db.from('lumi_pipeline_checkpoints').select('*');if(ce)fail('LIBRARY_PROVENANCE_UNAVAILABLE');
  const proposal=JSON.parse(await readFile(canonicalFile,'utf8')),report=JSON.parse(await readFile(approvalFile,'utf8')),canonical=proposal.canonical_reference;
  const summary={registered:0,skipped:0,failed:0,provider_calls:0};
  for(const owner of owners||[]){
    if(ownerId!==null&&String(owner.user_id)!==ownerId)continue;
    const {data:row,error}=await db.from('lumi_telegram_review_sessions').select('user_id,state').eq('user_id',owner.user_id).maybeSingle();
    if(error)fail('LIBRARY_PROVENANCE_UNAVAILABLE');if(!row||row.state.chat_id!==String(owner.chat_id)||row.state.user_id!==String(owner.user_id))continue;
    const candidates=sessionCandidates(row,checkpoints||[]);
    // Explicit source SHA approval in a preserved historical manifest, scoped to
    // the owner who already has this episode; no approval inferred from a master.
    const episode='ep_lumi_flores_003';
    if(row.state.episodes?.[episode])candidates.unshift({owner:String(owner.user_id),episode,shot:'q31',type:'CHARACTER_REFERENCE',subject:'lumi',name:'Lumi · referencia canónica V2',description:'Identidad y estilo de Lumi aprobados. La imagen de referencia no sustituye una nueva generación.',
      a:{artifact_id:canonical.id,bucket:canonical.storage_bucket,path:canonical.storage_path,size:canonical.size_bytes,sha256:canonical.sha256,mime:'image/png'},
      review:report.human_approval,source:'repository:docs/cinematic-director-v1/evidence/LUMI_SERIES_V2_QUALITY_GATE_REPORT.json#/human_approval',canonical:{id:canonical.id,sha256:canonical.sha256},tags:['Lumi','Series V2','two-wings','premium-stylized-3D']});
    const cache=new Map();
    for(const candidate of candidates){try{
      if(!safeRef(candidate.a)||!await privateBucket(candidate.a.bucket)){summary.skipped++;continue;}
      const key=candidate.a.bucket+'/'+candidate.a.path;
      if(!cache.has(key))cache.set(key,await loadBytes(candidate.a));
      await store.register(verifiedAsset(candidate,cache.get(key)));summary.registered++;
    }catch(e){summary.failed++;console.error(JSON.stringify({event:'lumi_library_candidate_failed',error:/^[A-Z_]+$/.test(e.message)?e.message:'SOURCE_UNAVAILABLE',sha256:candidate.a?.sha256}));}}
  }
  return summary;
}
export function mountLibrary(app,{api,principal,wrap,db,loadBytes,env,bootstrap=true}){
  const store=new SupabaseLibraryStore(db);
  const privateBucket=async bucket=>{const {data,error}=await db.storage.getBucket(bucket);return !error&&data?.public===false;};
  const library=new LumiLibrary({store,loadBytes,privateBucket,env});
  const sync=ownerId=>syncLibrary({db,store,loadBytes,privateBucket,ownerId});
  app.get(api+'/library',wrap(async(req,res)=>res.json(await library.list(await principal(req)))));
  app.post(api+'/library/sync',wrap(async(req,res)=>{const p=await principal(req);if(Object.keys(req.body||{}).length)fail('LIBRARY_REUSE_INPUT_INVALID',400);res.json(await sync(p.user));}));
  app.post(api+'/library/selections',wrap(async(req,res)=>res.json(await library.select(await principal(req),req.body||{}))));
  app.get(api+'/library/selections/:id',wrap(async(req,res)=>res.json(await library.resolve(await principal(req),req.params.id))));
  app.get(api+'/library/media/:id',wrap(async(req,res)=>{
    const {asset:a,bytes}=await library.media(await principal(req),req.params.id,req.query.expires,req.query.ticket);
    res.type(a.media_type).set('Accept-Ranges','bytes');
    if(req.query.download==='1')res.set('Content-Disposition',`attachment; filename="Lumi-${a.sha256.slice(0,12)}.${a.media_type==='video/mp4'?'mp4':a.media_type==='image/png'?'png':'jpg'}"`);
    if(req.headers.range){const m=/^bytes=(\d+)-(\d*)$/.exec(req.headers.range);if(!m)return res.status(416).set('Content-Range','bytes */'+bytes.length).end();
      const start=Number(m[1]),end=m[2]?Number(m[2]):bytes.length-1;if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>end||end>=bytes.length)return res.status(416).set('Content-Range','bytes */'+bytes.length).end();
      return res.status(206).set('Content-Range',`bytes ${start}-${end}/${bytes.length}`).send(bytes.subarray(start,end+1));}
    res.send(bytes);
  }));
  if(bootstrap)sync().then(r=>console.log(JSON.stringify({event:'lumi_library_sync',...r}))).catch(()=>console.error(JSON.stringify({event:'lumi_library_sync_unavailable',provider_calls:0})));
  return {library,sync};
}
