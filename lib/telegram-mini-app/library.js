import {createHash,createHmac,timingSafeEqual} from 'node:crypto';
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {assertMiniPrincipal,miniAppSecret,MINI_PATH} from './auth.js';
import {inputDigest} from '../lumi-v2-activation-context.js';
import {handleStageResult} from '../lumi-stage-result-v2.js';
import {createArtifactStorage,inspectMaterializedArtifact} from '../lumi-artifact-materialization-v2.js';
import {ep004ReviewContract} from '../lumi-generic-v2-adapter.js';

export const ASSET_TYPES=Object.freeze(['CHARACTER_REFERENCE','SCENE_REFERENCE','APPROVED_IMAGE','APPROVED_VIDEO','BACKGROUND','MASTER']);
export const REUSE_MODES=Object.freeze(['REFERENCE_REUSE','DIRECT_MEDIA_REUSE','DERIVED_ASSET']);
const digest=v=>createHash('sha256').update(typeof v==='string'||Buffer.isBuffer(v)?v:JSON.stringify(v)).digest('hex');
const fail=(code,status=409)=>{throw Object.assign(Error(code),{status});};
const id=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(v);
const safeRef=a=>a&&/^[a-z0-9-]+$/.test(a.bucket||'')&&typeof a.path==='string'&&a.path.length<1000&&!/(^\/|\.\.|:\/\/)/.test(a.path);
const isHash=v=>/^[a-f0-9]{64}$/.test(v||'');
const canonicalFile=new URL('../../docs/LUMI_EP004_FIRST_SOURCE_PROPOSAL.json',import.meta.url);
const approvalFile=new URL('../../docs/cinematic-director-v1/evidence/LUMI_SERIES_V2_QUALITY_GATE_REPORT.json',import.meta.url);

// Compare authored semantics, not episode/shot IDs. Missing provenance stays
// incompatible; a human confirmation cannot override a structural mismatch.
function sceneSignature(cp,shot){
  const p=cp?.metadata?.generic_v2;
  if(!p||!shot)return null;
  return inputDigest(shot.scene_ids.map(id=>{const s=p.plan.scenes.find(s=>s.id===id);if(!s)fail('LIBRARY_SCENE_MISSING');
    return {goal:s.educational_goal,stage:s.stage,entities:p.plan.entities,camera:s.camera,actions:s.actions,assertions:s.assertions,continuity:s.continuity,text:s.text};}));
}
export function reuseCompatibility(asset,cp,shot,mode,source){
  const reasons=[],p=cp?.metadata?.generic_v2,sourceShot=source?.metadata?.generic_v2?.shot_plans.find(s=>s.shot_id===asset.source_shot_id);
  if(asset.approval_status!=='HUMAN_APPROVED'||asset.approval_reference?.artifact_sha256!==asset.sha256)reasons.push('APPROVAL_REQUIRED');
  if(!asset.reuse_policy?.modes?.includes(mode)||!asset.reuse_policy.original_immutable)reasons.push('REUSE_RIGHTS_REQUIRED');
  if(!p||!shot)reasons.push('TARGET_SHOT_REQUIRED');
  if(String(cp?.metadata?.user)!==String(asset.owner_id))reasons.push('OWNER_MISMATCH');
  if(asset.canonical_reference?.sha256&&asset.canonical_reference.sha256!==p?.character_profile?.source_sha
    ||source?.metadata?.generic_v2?.profile_sha&&source.metadata.generic_v2.profile_sha!==p?.profile_sha)reasons.push('VISUAL_PROFILE_INCOMPATIBLE');
  const {width,height}=asset.dimensions||{};
  if(!(width>0&&height>0)||Math.abs(width/height-9/16)>0.03)reasons.push('FORMAT_INCOMPATIBLE');
  if(mode==='REFERENCE_REUSE'){
    if(!asset.media_type.startsWith('image/'))reasons.push('IMAGE_REFERENCE_REQUIRED');
    if(asset.subject_key&&!['scene','lumi'].includes(asset.subject_key)&&!p?.plan.entities.some(e=>e.id===asset.subject_key))reasons.push('CHARACTER_NOT_IN_TARGET');
    if(asset.asset_type==='SCENE_REFERENCE'&&(!sourceShot||sceneSignature(source,sourceShot)!==sceneSignature(cp,shot)))reasons.push('SCENE_CONTEXT_INCOMPATIBLE');
  }else{
    if(!sourceShot||sceneSignature(source,sourceShot)!==sceneSignature(cp,shot))reasons.push('NARRATIVE_OR_CONTINUITY_INCOMPATIBLE');
    if(asset.asset_type==='MASTER'||asset.approval_reference?.scope!=='ORIGINAL_MEDIA')reasons.push('WHOLE_MEDIA_SCOPE_INCOMPATIBLE');
    if(width<1080||height<1800)reasons.push('RESOLUTION_INCOMPATIBLE');
    if(asset.media_type==='video/mp4'&&mode==='DIRECT_MEDIA_REUSE'&&Math.abs(asset.duration-shot?.duration)>0.06)reasons.push('DURATION_INCOMPATIBLE');
    if(asset.media_type==='video/mp4'&&mode==='DERIVED_ASSET'&&asset.duration<shot?.duration)reasons.push('DURATION_INCOMPATIBLE');
    if((sourceShot?.response_window_seconds||0)!==(shot?.response_window_seconds||0))reasons.push('EDUCATIONAL_PAUSE_INCOMPATIBLE');
  }
  return {status:reasons.length?'INCOMPATIBLE':'COMPATIBLE',reasons,requires_human_confirmation:true,
    target_binding_sha:p?.binding_sha??null,source_version:asset.version,source_sha256:asset.sha256,
    generation_required:mode==='REFERENCE_REUSE',human_review_required:mode!=='REFERENCE_REUSE'};
}
export function reuseCostImpact(cp,action,mode,quote=null){
  const baseline=quote?.status==='AWAITING_HUMAN_AUTHORIZATION'&&quote.episode_id===cp.episode_id&&quote.action_key===action.key
    &&quote.checkpoint_version===cp.metadata.runtime_revision&&quote.budget_gate==='PASS'
    &&Date.parse(quote.expires_at)>Date.now()&&Number.isFinite(quote.quote_usd)&&quote.quote_usd>=0?quote:null;
  return {currency:'USD',potential_saving_usd:mode==='REFERENCE_REUSE'?0:baseline?.quote_usd??(action.estimated_cost_usd>0?action.estimated_cost_usd:null),
    verified_saving_usd:null,basis:baseline?'EXISTING_CURRENT_QUOTE':action.estimated_cost_usd>0?'HISTORICAL_PLAN_ESTIMATE':'NO_PRICE_EVIDENCE',
    quote_id:baseline?.quote_id??null,generation_avoided:mode!=='REFERENCE_REUSE',provider_charge_refund:false};
}

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
  async target(owner,episode){const {data,error}=await this.db.from('lumi_pipeline_checkpoints').select('*').eq('episode_id',episode).maybeSingle();if(error)fail('LIBRARY_UNAVAILABLE',503);if(data&&String(data.metadata?.user)!==String(owner))fail('LIBRARY_TARGET_FORBIDDEN',403);return data;}
  async targets(owner){const {data,error}=await this.db.from('lumi_pipeline_checkpoints').select('*').eq('metadata->>user',String(owner)).limit(100);if(error)fail('LIBRARY_UNAVAILABLE',503);return data||[];}
}
export class LumiLibrary {
  constructor({store,loadBytes,privateBucket,env,manager,reviewStore,journal,artifactStorage,inspect=inspectMaterializedArtifact,derive}){Object.assign(this,{store,loadBytes,privateBucket,env,manager,reviewStore,journal,artifactStorage,inspect,derive});this.byteCache=new Map();}
  descriptor(a){return {artifact_id:a.asset_id,sha256:a.sha256,size:a.size_bytes,mime:a.media_type,...a.storage_reference,...a.dimensions,duration:a.duration};}
  async bytes(a){if(!await this.privateBucket(a.storage_reference.bucket))fail('LIBRARY_PRIVATE_STORAGE_REQUIRED',403);const b=await this.loadBytes(this.descriptor(a));if(b.length!==a.size_bytes||digest(b)!==a.sha256)fail('LIBRARY_HASH_MISMATCH');return b;}
  async previewBytes(a){return this.bytes(a);}
  ticket(p,a,expires){return createHmac('sha256',miniAppSecret(this.env)).update(JSON.stringify(['library-v1',p.session,p.user,a.asset_id,a.sha256,expires])).digest('hex');}
  publicAsset(p,a){const expires=Math.min(Date.now()+300000,p.expires_at);const {owner_id,series_key,storage_reference,approval_reference,...visible}=a;
    // Keep internal principal/callback identifiers off the client.
    return {...visible,approval_reference:{source:approval_reference.source,status:approval_reference.status,artifact_sha256:approval_reference.artifact_sha256,
      evidence_sha256:approval_reference.evidence_sha256,scope:approval_reference.scope,reviewed_at:approval_reference.reviewed_at,review_version:approval_reference.review_version,reason:approval_reference.reason},
      reusable:a.approval_status==='HUMAN_APPROVED',media_url:`${MINI_PATH}/api/library/media/${a.asset_id}?expires=${expires}&ticket=${this.ticket(p,a,expires)}`,expires_at:expires};
  }
  async list(p){assertMiniPrincipal(p);const assets=await this.store.list(p.user),selections=[];
    for(const s of await this.store.selections(p.user)){const cp=await this.store.target(p.user,s.target_episode_id),r=Object.values(cp?.metadata?.library_reuse||{}).find(r=>r.selection_id===s.selection_id);
      selections.push({selection_id:s.selection_id,asset_id:s.asset_id,target_episode_id:s.target_episode_id,target_shot_id:s.target_shot_id,mode:s.mode,created_at:s.created_at,status:r?.application_status??s.contract.status});}
    return {version:2,assets:assets.map(a=>this.publicAsset(p,a)),counts:Object.fromEntries(ASSET_TYPES.map(t=>[t,assets.filter(a=>a.asset_type===t).length])),selections,provider_calls:0};}
  async media(p,assetId,expires,ticket){assertMiniPrincipal(p);if(!isHash(assetId))fail('LIBRARY_ASSET_NOT_FOUND',404);const a=await this.store.get(p.user,assetId),n=Number(expires);
    if(!Number.isSafeInteger(n)||n<=Date.now()||n>Math.min(p.expires_at,Date.now()+300000)||!isHash(ticket)||!timingSafeEqual(Buffer.from(this.ticket(p,a,n)),Buffer.from(ticket)))fail('LIBRARY_MEDIA_EXPIRED',403);
    return {asset:a,bytes:await this.previewBytes(a)};
  }
  async access(p,assetId){assertMiniPrincipal(p);const a=await this.store.get(p.user,assetId);return {media:this.publicAsset(p,a),state:'LOADING',provider_calls:0};}
  async plan(p,episodeId,shotId){assertMiniPrincipal(p);const cp=await this.store.target(p.user,episodeId);if(!cp?.metadata?.generic_v2)fail('LIBRARY_TARGET_NOT_CREATED');
    const shot=cp.metadata.generic_v2.shot_plans.find(s=>s.shot_id===shotId);if(!shot)fail('LIBRARY_TARGET_SHOT_UNKNOWN');
    const assets=await this.store.list(p.user),suggestions=[];
    const row=await this.reviewStore?.get(p.user),quotes=Object.values(row?.state.production_commands||{}).filter(r=>r.status==='COMPLETE').map(r=>r.result);
    for(const a of assets){if(a.approval_status!=='HUMAN_APPROVED')continue;const source=await this.store.target(p.user,a.source_episode_id);
      for(const mode of a.reuse_policy.modes){const compatibility=reuseCompatibility(a,cp,shot,mode,source);
        const key=(mode==='REFERENCE_REUSE'||a.media_type.startsWith('image/')?'image:':'video:')+shotId,action=cp.actions.find(x=>x.key===key)||{};
        suggestions.push({asset:this.publicAsset(p,a),mode,compatibility,expected_cost_impact:reuseCostImpact(cp,action,mode,quotes.find(q=>q?.episode_id===cp.episode_id&&q.action_key===key&&q.checkpoint_version===cp.metadata.runtime_revision&&Date.parse(q.expires_at)>Date.now()))});}}
    return {episode_id:episodeId,shot_id:shotId,checkpoint_revision:cp.metadata.runtime_revision,status:cp.status,
      suggestions:suggestions.sort((a,b)=>(a.compatibility.status==='COMPATIBLE'?0:1)-(b.compatibility.status==='COMPATIBLE'?0:1)),
      applications:Object.values(cp.metadata.library_reuse||{}).filter(r=>r.target_shot_id===shotId).map(r=>({selection_id:r.selection_id,reuse_mode:r.reuse_mode,application_status:r.application_status,
        expected_cost_impact:{...r.expected_cost_impact,verified_saving_usd:r.reuse_mode==='DIRECT_MEDIA_REUSE'&&cp.actions.find(a=>a.key===r.target_action)?.status==='COMPLETE'&&r.expected_cost_impact.basis==='EXISTING_CURRENT_QUOTE'?r.expected_cost_impact.potential_saving_usd:null}})),provider_calls:0};
  }
  async targets(p){assertMiniPrincipal(p);return {targets:(await this.store.targets(p.user)).filter(c=>c.metadata?.generic_v2).map(c=>({episode_id:c.episode_id,title:c.metadata.generic_v2.plan.episode.title,status:c.status,revision:c.metadata.runtime_revision,
    shots:c.metadata.generic_v2.shot_plans.map(s=>({shot_id:s.shot_id,duration:s.duration}))})),provider_calls:0};}
  async verifiedApplication(cp,key){
    const r=cp.metadata.library_reuse?.[key];if(!r||r.target_episode_id!==cp.episode_id||r.target_binding_sha!==cp.metadata.generic_v2.binding_sha||r.application_sha!==inputDigest(Object.fromEntries(Object.entries(r).filter(([k])=>k!=='application_sha'))))fail('LIBRARY_APPLICATION_BINDING_CHANGED');
    const a=await this.store.get(cp.metadata.user,r.source_asset_id);
    if(a.sha256!==r.provenance.sha256||a.version!==r.provenance.version||a.approval_status!=='HUMAN_APPROVED'||a.approval_reference.evidence_sha256!==r.provenance.approval_evidence_sha256)fail('LIBRARY_SOURCE_APPROVAL_CHANGED');
    await this.bytes(a);return {application:r,asset:a};
  }
  async apply(p,selectionId,input){
    assertMiniPrincipal(p);
    if(Object.keys(input).some(k=>!['expected_revision','confirmation','derivation'].includes(k))||!Number.isSafeInteger(input.expected_revision)
      ||input.confirmation?.decision!=='APPLY'||['narrative','continuity','rights'].some(k=>input.confirmation[k]!==true))fail('LIBRARY_EXPLICIT_CONFIRMATION_REQUIRED',400);
    if(!this.manager||!this.reviewStore||!this.journal)fail('LIBRARY_ENGINE_UNAVAILABLE',503);
    const s=await this.store.selection(p.user,selectionId),a=await this.store.get(p.user,s.asset_id),contract=reuseContract(a,s);
    if(inputDigest(contract)!==inputDigest(s.contract))fail('LIBRARY_CONTRACT_CHANGED');
    const cp=await this.manager.store.getEpisode(s.target_episode_id);
    if(!cp||cp.metadata.user!==p.user)fail('LIBRARY_TARGET_FORBIDDEN',403);
    const key=(s.mode==='REFERENCE_REUSE'||a.media_type.startsWith('image/')?'image:':'video:')+s.target_shot_id;
    const prior=cp.metadata.library_reuse?.[key];
    if(prior){if(prior.selection_id!==selectionId)fail('LIBRARY_TARGET_ALREADY_BOUND');await this.verifiedApplication(cp,key);
      if(prior.derivation&&inputDigest(prior.derivation)!==inputDigest(input.derivation))fail('LIBRARY_DERIVATION_CHANGED');
      return this.finishApplication(p,cp,key,prior,a);}
    const action=cp.actions.find(x=>x.key===key),shot=cp.metadata.generic_v2?.shot_plans.find(x=>x.shot_id===s.target_shot_id),source=await this.store.target(p.user,a.source_episode_id);
    const compatibility=reuseCompatibility(a,cp,shot,s.mode,source);
    if(compatibility.status!=='COMPATIBLE')fail('LIBRARY_INCOMPATIBLE:'+compatibility.reasons.join(','));
    const row=await this.reviewStore.get(p.user),attempt=action?.active_attempt_id??digest(cp.episode_id+':'+cp.metadata.generic_v2.binding_sha+':'+key);
    if(cp.status!=='RUNNING'||cp.active_incident_id||cp.runner_enabled||cp.autorun||cp.metadata.runtime_revision!==input.expected_revision
      ||!action||action.status!=='PENDING'||action.dispatch_state!=='NOT_DISPATCHED'||action.provider_request_id||action.artifact
      ||cp.metadata.budget_reservations?.[key]||await this.journal.get(attempt)||row?.state.production_commands?.[attempt]
      ||Object.values(row?.state.mini_app?.operations||{}).some(o=>o.binding?.proposal_id===cp.episode_id&&o.binding.next_action===key&&['generate','first_animation','second_image','authorize'].includes(o.kind))
      ||s.mode!=='REFERENCE_REUSE'&&cp.first_pending_action!==key)fail('LIBRARY_TARGET_CONFLICT');
    const bytes=await this.bytes(a),qa=s.mode==='REFERENCE_REUSE'?null:await this.inspect(bytes,a.media_type==='video/mp4'?'VIDEO':'IMAGE',a.sha256,{...a.dimensions,duration:a.duration});
    if(qa&&qa.ok!==true)fail('LIBRARY_MEDIA_QA_REQUIRED');
    if(s.mode!=='REFERENCE_REUSE')ep004ReviewContract(cp,action,this.descriptor(a));
    let derivation=null;
    if(s.mode==='DERIVED_ASSET'){
      const d=input.derivation;
      if(d?.kind==='TRIM_VIDEO'&&a.media_type==='video/mp4'){
        if(!Number.isFinite(d.start_seconds)||d.start_seconds<0||d.duration!==shot.duration||d.start_seconds+d.duration>a.duration||Object.keys(d).some(k=>!['kind','start_seconds','duration'].includes(k)))fail('LIBRARY_DERIVATION_INVALID');
        derivation={kind:d.kind,start_seconds:d.start_seconds,duration:d.duration};
      }else if(d?.kind==='CROP_IMAGE'&&a.media_type.startsWith('image/')){
        if(['x','y','width','height'].some(k=>!Number.isSafeInteger(d[k]))||d.x<0||d.y<0||d.width<1080||d.height<1800||d.x+d.width>a.dimensions.width||d.y+d.height>a.dimensions.height||Math.abs(d.width/d.height-9/16)>0.03||Object.keys(d).some(k=>!['kind','x','y','width','height'].includes(k)))fail('LIBRARY_DERIVATION_INVALID');
        derivation={kind:d.kind,x:d.x,y:d.y,width:d.width,height:d.height};
      }else fail('LIBRARY_DERIVATION_INVALID');
    }else if(input.derivation)fail('LIBRARY_DERIVATION_INVALID');
    const quotes=Object.values(row?.state.production_commands||{}).filter(r=>r.status==='COMPLETE'&&r.result?.action_key===key&&r.result?.episode_id===cp.episode_id).map(r=>r.result);
    const impact=reuseCostImpact(cp,action,s.mode,quotes.find(q=>Date.parse(q.expires_at)>Date.now()));
    const application={selection_id:selectionId,source_asset_id:a.asset_id,target_episode_id:cp.episode_id,target_shot_id:s.target_shot_id,target_action:key,reuse_mode:s.mode,
      target_binding_sha:cp.metadata.generic_v2.binding_sha,compatibility_result:compatibility,human_selection:{user:p.user,chat:p.chat,session:p.session,decision:'APPLY',confirmation:input.confirmation,timestamp:new Date().toISOString()},
      application_status:s.mode==='REFERENCE_REUSE'?'APPLIED_REFERENCE':'APPLIED_AWAITING_HUMAN_REVIEW',provenance:{source_episode_id:a.source_episode_id,source_shot_id:a.source_shot_id,sha256:a.sha256,version:a.version,approval_evidence_sha256:a.approval_reference.evidence_sha256},
      artifact:{...this.descriptor(a),artifact_id:digest([selectionId,cp.episode_id,key]),episode_id:cp.episode_id,profile_sha:cp.metadata.generic_v2.profile_sha},qa,derivation,expected_cost_impact:impact,provider_calls:0};
    application.application_sha=inputDigest(application);
    // Claim in the existing checkpoint CAS; paid dispatch rejects this action
    // revision/dispatch state. Recovery reuses this exact claim after ACK loss.
    const saved=await this.manager.checkpoint(cp.episode_id,d=>{
      if(inputDigest(d)!==inputDigest(cp))fail('STALE_CHECKPOINT');
      d.metadata.library_reuse||={};d.metadata.library_reuse[key]=application;
      if(s.mode!=='REFERENCE_REUSE')d.actions.find(x=>x.key===key).dispatch_state='LIBRARY_APPLY_PENDING';
    });
    return this.finishApplication(p,saved,key,application,a);
  }
  async finishApplication(p,cp,key,r,a){
    if(r.reuse_mode==='REFERENCE_REUSE')return {status:r.application_status,selection_id:r.selection_id,already_applied:true,provider_calls:0};
    const old=cp.metadata.stage_results?.[key]?.result;
    const action=cp.actions.find(x=>x.key===key);
    if(cp.status==='CANCELLED'||!action||action.status!=='COMPLETE'&&cp.first_pending_action!==key
      ||!old&&(cp.status!=='RUNNING'||cp.active_incident_id||action.dispatch_state!=='LIBRARY_APPLY_PENDING')
      ||old&&(old.reuse?.selection_id!==r.selection_id||old.reuse?.application_sha!==r.application_sha))fail('LIBRARY_TARGET_CONFLICT');
    let artifact=r.artifact,qa=r.qa;
    if(r.reuse_mode==='DERIVED_ASSET'&&!old){
      if(!this.derive)fail('LIBRARY_DERIVER_UNAVAILABLE');
      ({artifact,qa}=await this.derive({application:r,asset:a,bytes:await this.bytes(a)}));
    }else if(old){artifact=old.artifacts[0];qa=old.qa;}
    const result=old||{status:'SUCCEEDED',episode_id:cp.episode_id,stage_id:cp.actions.find(x=>x.key===key).stage,artifacts:[artifact],qa,provider_job_ids:[],claims:[r.selection_id],human_review_requirement:true,
      reuse:{selection_id:r.selection_id,application_sha:r.application_sha,source_asset_id:r.source_asset_id,mode:r.reuse_mode},estimated_cost:null,actual_cost:null,output:{original_preserved:true,source_sha256:a.sha256}};
    await handleStageResult({manager:this.manager,episodeId:cp.episode_id,action:cp.actions.find(x=>x.key===key),receiptId:'library:'+r.selection_id,result,
      artifactStorage:this.artifactStorage,reviewStore:this.reviewStore});
    return {status:'AWAITING_HUMAN_REVIEW',selection_id:r.selection_id,provider_calls:0};
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
    const cp=await this.store.target(p.user,s.target_episode_id),source=await this.store.target(p.user,a.source_episode_id),shot=cp?.metadata?.generic_v2?.shot_plans.find(x=>x.shot_id===s.target_shot_id);
    return {selection_id:s.selection_id,contract,media:this.publicAsset(p,a),checkpoint_revision:cp?.metadata?.runtime_revision??null,target_status:cp?.status??'NOT_CREATED',
      compatibility:reuseCompatibility(a,cp,shot,s.mode,source),application:Object.values(cp?.metadata?.library_reuse||{}).find(r=>r.selection_id===s.selection_id)?.application_status??null,provider_calls:0};
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
      if(a&&['image/png','image/jpeg','video/mp4'].includes(a.mime))all.set(a.sha256,{a,type:e.master?.sha256===a.sha256||['MASTER','MASTER_REVIEW'].includes(r.stage_id)?'MASTER':a.mime==='video/mp4'?'APPROVED_VIDEO':'APPROVED_IMAGE',shot:r.action_key?.split(':').slice(1).join(':')||null});}
    for(const {a,type,shot} of all.values()){
      const request=reviews.find(r=>r.artifact_sha===a.sha256&&r.status==='APPROVED');
      const review=request?.human_decision??Object.values(e.reviews||{}).find(r=>r.artifact_sha===a.sha256&&r.status==='APPROVED');
      const bound=request&&cp?.metadata?.review_requests?.[request.review_request_id];
      if(request&&cp&&(!bound||bound.status!=='APPROVED'||inputDigest(bound.human_decision)!==inputDigest(request.human_decision)))continue;
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
    const cache=new Map(),existing=new Set((await store.list(String(owner.user_id))).map(a=>a.asset_id));
    for(const candidate of candidates){try{
      const proof=approvalEvidence(candidate.a,candidate.review,candidate.source),series=digest([String(candidate.owner),candidate.episode,candidate.shot??null,candidate.type,candidate.subject??'']);
      if(existing.has(digest([series,candidate.a.sha256,proof.status,proof.evidence_sha256??null]))){summary.registered++;continue;}
      if(!safeRef(candidate.a)||!await privateBucket(candidate.a.bucket)){summary.skipped++;continue;}
      const key=candidate.a.bucket+'/'+candidate.a.path;
      if(!cache.has(key))cache.set(key,await loadBytes(candidate.a));
      const asset=verifiedAsset(candidate,cache.get(key));
      if(asset.approval_status!=='HUMAN_APPROVED'){summary.skipped++;continue;}
      await store.register(asset);summary.registered++;
    }catch(e){summary.failed++;console.error(JSON.stringify({event:'lumi_library_candidate_failed',error:/^[A-Z_]+$/.test(e.message)?e.message:'SOURCE_UNAVAILABLE',sha256:candidate.a?.sha256}));}}
  }
  return summary;
}
export function mountLibrary(app,{api,principal,wrap,db,loadBytes,env,adapter,reviewStore,production,bootstrap=true}){
  const store=new SupabaseLibraryStore(db);
  const privateBucket=async bucket=>{const {data,error}=await db.storage.getBucket(bucket);return !error&&data?.public===false;};
  const artifactStorage=createArtifactStorage(db);
  const derive=async({application:r,asset:a,bytes})=>{
    const dir=await mkdtemp(join(tmpdir(),'lumi-library-'));
    try{const video=r.derivation.kind==='TRIM_VIDEO',extension=video?'mp4':'png',src=join(dir,'source'),out=join(dir,'derived.'+extension),d=r.derivation;await writeFile(src,bytes);
      const filters=video?['-ss',String(d.start_seconds),'-t',String(d.duration),'-an','-c:v','libx264','-profile:v','high','-crf','17','-preset','slow','-pix_fmt','yuv420p','-movflags','+faststart']:['-vf',`crop=${d.width}:${d.height}:${d.x}:${d.y}`,'-frames:v','1'];
      await promisify(execFile)('ffmpeg',['-v','error','-nostdin','-i',src,...filters,out],{maxBuffer:1024*1024});
      const data=await readFile(out),sha256=digest(data),artifact={...r.artifact,sha256,size:data.length,mime:video?'video/mp4':'image/png',width:video?a.dimensions.width:d.width,height:video?a.dimensions.height:d.height,duration:video?d.duration:null,path:`lumi-library-derived/${r.target_episode_id}/${r.selection_id}/${sha256}.${extension}`,provenance:r.provenance};
      const qa=await inspectMaterializedArtifact(data,video?'VIDEO':'IMAGE',sha256,{width:artifact.width,height:artifact.height,duration:artifact.duration});if(!qa.ok)fail('LIBRARY_DERIVATION_QA_FAILED');
      const prior=await artifactStorage.download(artifact.bucket,artifact.path);
      if(prior){if(digest(prior)!==sha256)fail('LIBRARY_HASH_MISMATCH');}
      else{try{await artifactStorage.upload(artifact.bucket,artifact.path,data,{contentType:artifact.mime});}catch{
        const check=await artifactStorage.download(artifact.bucket,artifact.path);if(!check||digest(check)!==sha256)fail('LIBRARY_DERIVATION_STORAGE_FAILED');}}
      return {artifact,qa};
    }finally{await rm(dir,{recursive:true,force:true});}
  };
  const library=new LumiLibrary({store,loadBytes,privateBucket,env,manager:adapter?.manager,journal:adapter?.journal,reviewStore,artifactStorage,derive});
  const sync=ownerId=>syncLibrary({db,store,loadBytes,privateBucket,ownerId});
  if(adapter)adapter.assetLibrary=library;
  // Approval capture uses the existing reconciliation entrypoint; failure leaves
  // the original decision intact and is repaired by the same idempotent sync.
  if(production)production.captureApproved=async user=>{try{return await sync(String(user));}catch{return {status:'CAPTURE_PENDING_RECOVERY',provider_calls:0};}};
  app.get(api+'/library',wrap(async(req,res)=>res.json(await library.list(await principal(req)))));
  app.get(api+'/library/targets',wrap(async(req,res)=>res.json(await library.targets(await principal(req)))));
  app.get(api+'/library/plan',wrap(async(req,res)=>res.json(await library.plan(await principal(req),req.query.episode,req.query.shot))));
  app.get(api+'/library/access/:id',wrap(async(req,res)=>res.json(await library.access(await principal(req),req.params.id))));
  app.post(api+'/library/sync',wrap(async(req,res)=>{const p=await principal(req);if(Object.keys(req.body||{}).length)fail('LIBRARY_REUSE_INPUT_INVALID',400);res.json(await sync(p.user));}));
  app.post(api+'/library/selections',wrap(async(req,res)=>res.json(await library.select(await principal(req),req.body||{}))));
  app.get(api+'/library/selections/:id',wrap(async(req,res)=>res.json(await library.resolve(await principal(req),req.params.id))));
  app.post(api+'/library/selections/:id/apply',wrap(async(req,res)=>res.json(await library.apply(await principal(req),req.params.id,req.body||{}))));
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
