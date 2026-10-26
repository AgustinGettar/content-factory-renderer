import {sendPrivateMedia,processDiagnostic} from './private-media.js';
import {randomUUID} from 'node:crypto';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {assertMiniPrincipal,mutateMiniState} from './auth.js';
import {validateArtifact} from '../telegram-review-v1/core.js';
import {buildAssemblyCommand,executeAssemblyCommand} from '../lumi-third-short-master-v1.js';
import {emptyEdit,instance,normalize,validateEdit,clone,RATE} from '../../public/lumi-studio/editor-model.js';
import {digest,fail,mediaLane,probeFile} from './editor-media.js';
import {mediaRange} from './library.js';
const now=()=>new Date().toISOString();
const identifier=v=>typeof v==='string'&&/^[a-zA-Z0-9_-]{1,100}$/.test(v);
const own=(o,k)=>Object.hasOwn(o||{},k)?o[k]:null;
const current=p=>p.revisions.find(r=>r.revision===p.current);
const validSession=(m,p)=>{if(!m.sessions?.[p.session]||m.sessions[p.session].expires_at<=Date.now())fail('MINI_SESSION_EXPIRED',401);};
export class EditorStore {
 constructor({store,manager,media,validateOwner,encode=executeAssemblyCommand}){Object.assign(this,{store,manager,media,validateOwner,encode});this.running=false;}
 async owner(user){const r=await this.store.get(user);if(!r||r.state.user_id!==user||!await this.validateOwner(user,r.state.chat_id))fail('MINI_OWNER_REQUIRED',401);return r;}
 project(state,id){const p=own(state.mini_app?.editor_projects,id);if(!p)fail('EDITOR_PROJECT_NOT_FOUND',404);return p;}
 view(p,m){return {id:p.id,episode_id:p.episode_id,title:p.title,status:p.status,error:p.error??null,current:p.current,sources:Object.fromEntries(Object.entries(p.sources).map(([id,{artifact,...s}])=>[id,s])),missing:p.missing,
  revision:p.current?clone(current(p)):null,versions:p.revisions.map(r=>({revision:r.revision,sha256:r.sha256,saved_at:r.saved_at})),jobs:Object.values(m.operations||{}).filter(o=>o.binding?.project_id===p.id).map(({result,...o})=>({...o,result:result?{sha256:result.sha256,duration_ticks:result.duration_ticks,partial:result.partial}:null})),approval:null,publication_authorization:null};}
 async list(p){assertMiniPrincipal(p);const {state}=await this.owner(p.user);return Object.values(state.mini_app?.editor_projects||{}).map(x=>({id:x.id,title:x.title,status:x.status,episode_id:x.episode_id,current:x.current,last_export:Object.values(state.mini_app?.operations||{}).filter(o=>o.kind==='editor_render'&&o.binding?.project_id===x.id).map(o=>({status:o.status,revision:o.binding.revision,error:o.error||null})).at(-1)||null}));}
 async get(p,id){assertMiniPrincipal(p);const {state}=await this.owner(p.user);return this.view(this.project(state,id),state.mini_app);}
 async import(p,body){assertMiniPrincipal(p);const {episode_id,command_id}=body;if(Object.keys(body).sort().join()!=='command_id,episode_id'||!identifier(episode_id)||!identifier(command_id))fail('EDITOR_IMPORT_BODY',400);
  return this.queueImport(p.user,episode_id,command_id,p);
 }
 async queueImport(user,episode,commandId,p=null){const {state}=await this.owner(user),e=own(state.episodes,episode);if(!e)fail('EDITOR_EPISODE_NOT_FOUND',404);
  const id='edit_'+digest([user,episode,commandId]).slice(0,24);
  return mutateMiniState(this.store,user,m=>{if(p)validSession(m,p);m.editor_projects||={};if(m.editor_projects[id])return this.view(m.editor_projects[id],m);
   if(Object.keys(m.editor_projects).length>=32)fail('EDITOR_PROJECT_LIMIT');m.editor_projects[id]={id,episode_id:episode,title:e.title+' · candidata',status:'IMPORTING',sources:{},missing:[],current:0,revisions:[],receipts:{}};
   m.operations||={};m.operations[id]={id,kind:'editor_import',status:'QUEUED',started_at:now(),binding:{project_id:id,episode_id:episode},command_id:commandId};return this.view(m.editor_projects[id],m);});
 }
 async save(p,id,b){assertMiniPrincipal(p);if(Object.keys(b).sort().join()!=='base_revision,command_id,edit,fork'||!Number.isInteger(b.base_revision)||!identifier(b.command_id)||typeof b.fork!=='boolean'||JSON.stringify(b).length>120000)fail('EDITOR_SAVE_BODY',400);
  await this.owner(p.user);return mutateMiniState(this.store,p.user,(m,state)=>{validSession(m,p);let project=this.project(state,id);if(project.status!=='READY')fail('EDITOR_IMPORT_PENDING');
   const fingerprint=digest(b),receipt=project.receipts[b.command_id];if(receipt){if(receipt.fingerprint!==fingerprint)fail('EDITOR_COMMAND_CONFLICT');return {...this.view(this.project(state,receipt.project_id),m),receipt_revision:receipt.revision};}
   validateEdit(b.edit,project.sources);if(project.current!==b.base_revision&&!b.fork)fail('EDITOR_REVISION_CONFLICT');
   if(b.fork){if(Object.keys(m.editor_projects).length>=32)fail('EDITOR_PROJECT_LIMIT');const forkId='edit_'+digest([id,b.command_id]).slice(0,24);project={...clone(project),id:forkId,title:project.title+' · alternativa',current:0,revisions:[],receipts:{}};m.editor_projects[forkId]=project;}
   if(project.revisions.length>=128)fail('EDITOR_REVISION_LIMIT');
   const revision=project.current+1,manifest={policy:'LUMI_NATURAL_TIMELINE_V2',sources:Object.values(project.sources).map(({id,sha256,artifact,streams,rights,episode_id,shot_id})=>({id,sha256,asset_id:artifact.artifact_id,streams,rights,episode_id,shot_id})),edit:b.edit};
   const r={revision,sha256:digest(manifest),edit:clone(b.edit),saved_at:now(),command_id:b.command_id,approval:null};project.revisions.push(r);project.current=revision;
   this.project(state,id).receipts[b.command_id]={fingerprint,project_id:project.id,revision};return this.view(project,m);});
 }
 async render(p,id,b){assertMiniPrincipal(p);if(Object.keys(b).sort().join()!=='manifest_sha,revision'||!Number.isInteger(b.revision))fail('EDITOR_RENDER_BODY',400);await this.owner(p.user);
  return mutateMiniState(this.store,p.user,(m,state)=>{validSession(m,p);const project=this.project(state,id),r=project.revisions.find(r=>r.revision===b.revision);if(!r||r.sha256!==b.manifest_sha)fail('EDITOR_VERSION_MISMATCH');validateEdit(r.edit,project.sources,{render:true});
   const jobId=digest(['editor_render',p.user,id,r.revision,r.sha256]);m.operations||={};if(m.operations[jobId])return m.operations[jobId];
   const op={id:jobId,kind:'editor_render',status:'QUEUED',started_at:now(),binding:{project_id:id,revision:r.revision,manifest_sha:r.sha256},approval:null};m.operations[jobId]=op;return op;});
 }
 async gather(user,project){
  const {state}=await this.owner(user),e=state.episodes[project.episode_id],cp=await this.manager?.store.getEpisode(project.episode_id);
  if(cp&&String(cp.metadata.user)!==user)fail('MINI_OWNER_REQUIRED',401);
  const sources={},missing=[],edit=emptyEdit(),artifacts=[],seen=new Set();
  const add=(a,shot,role)=>{try{validateArtifact(a);}catch{return;}if(!/^(video\/mp4|audio\/)/.test(a.mime)||seen.has(a.sha256))return;seen.add(a.sha256);artifacts.push({a,shot,role});};
  for(const shot of e.shots||[]){if(shot.artifact)add(shot.artifact,shot.shot_id,'clip');else missing.push('Toma '+shot.shot_id+' pendiente');}
  for(const a of Object.values({...e.artifacts,...cp?.metadata.artifacts})){const action=cp?.actions?.find(x=>x.artifact?.sha256===a.sha256);add(a,(e.shots||[]).find(s=>s.artifact?.sha256===a.sha256)?.shot_id||action?.scene_id||action?.key?.split(':')[1]||null,a.sha256===e.master?.sha256?'mixed_master':a.mime?.startsWith('audio/')?'voice':'clip');}
  // Recover a known automatic assembly's source descriptors before falling back to a mix.
  const segments=cp?.metadata?.assembly_segments||[];
  const tts=cp?.metadata?.stage_results?.tts?.result,narrations=tts?.output?.narration_units||[];
  for(const u of narrations){const a=tts.artifacts?.find(a=>a.artifact_id===u.artifact_id);add(a,u.shot_id,'voice');}
  for(const s of segments){add(s.video_artifact,s.shot_id,'clip');add(s.audio_artifact,s.shot_id,'voice');}
  if(!artifacts.some(s=>s.a.mime==='video/mp4')&&e.master){add(e.master,null,'mixed_master');missing.push('Solo master mezclado disponible: no se puede separar la voz.');}
  let cursor=0;
  for(const {a,shot,role} of artifacts){const unit=narrations.find(u=>u.artifact_id===a.artifact_id),sourceShot=unit?.shot_id||shot;
   let meta;try{meta=await this.media.probe(user,a);}catch{missing.push('Fuente no disponible: '+(sourceShot||a.artifact_id));continue;}const id=digest([a.artifact_id,a.sha256]);sources[id]={id,sha256:a.sha256,artifact:clone(a),type:role,label:sourceShot|| (role==='mixed_master'?'Master mezclado':a.mime.startsWith('audio/')?((a.provider_job_id||'').startsWith('existing-preview-')?'Prueba de voz':'Audio fuente')+' · '+(meta.audio_ticks/RATE).toFixed(3)+' s · '+a.artifact_id.slice(0,18):'Clip'),episode_id:project.episode_id,shot_id:sourceShot,auto_place_audio:!!unit||segments.some(s=>s.audio_artifact?.sha256===a.sha256),provenance:'EXISTING_PRIVATE_ARTIFACT_SHA_VERIFIED',rights:{use:'OWNER_PROJECT_EDITORIAL_DERIVATIVE',external_reuse:'NOT_INFERRED'},...meta};
   if(meta.video){const v=instance(sources[id],'video',cursor,'v_'+id.slice(0,16));edit.clips.push(v);if(meta.audio)edit.clips.push(instance(sources[id],'voice',cursor,'a_'+id.slice(0,16),v.id));cursor+=Math.ceil(meta.video_ticks/1600)*1600;}
  }
  for(const s of Object.values(sources).filter(s=>s.audio&&!s.video&&s.auto_place_audio)){const v=edit.clips.find(c=>c.track==='video'&&sources[c.source_id].shot_id===s.shot_id&&s.shot_id);const item=instance(s,'voice',v?.timeline_start||0,'a_'+s.id.slice(0,16),v?.id||null),shot=cp?.metadata?.generic_v2?.shot_plans?.find(x=>x.shot_id===s.shot_id),segment=segments.find(x=>x.audio_artifact?.sha256===s.sha256);item.timeline_start+=Math.round((segment?.audio_start_seconds??shot?.editorial?.entry_seconds??0)*RATE);item.pause_ticks=Math.round((segment?.pause??shot?.response_window_seconds??0)*RATE);item.closure_ticks=Math.round((segment?.closure_margin_seconds??shot?.editorial?.closure_seconds??0)*RATE);edit.clips.push(item);}
  if(Object.values(sources).some(s=>s.audio&&!s.video&&!s.auto_place_audio))missing.push('Hay audios disponibles sin asociación editorial acreditada: elegilos y ubicalos explícitamente.');
  if(!edit.clips.some(c=>c.track==='voice'))missing.push('Voz fuente pendiente; edición visual parcial sin narración.');
  normalize(edit);validateEdit(edit,sources);return {sources,missing,edit};
 }
 async processPending(user){if(this.running)return;this.running=true;try{
  const {state}=await this.owner(user),m=state.mini_app||{};
  // Do not compete with an accepted production transport/encode. Navigation and saves remain free.
  if(Object.values(m.episode_jobs||{}).some(j=>['QUEUED','RUNNING'].includes(j.status)))return;
  const op=Object.values(m.operations||{}).find(o=>['editor_import','editor_render'].includes(o.kind)&&(['QUEUED','RECOVERING'].includes(o.status)||o.status==='RUNNING'&&o.lease_until<Date.now()));if(!op)return;
  const lease=randomUUID(),claimed=await mutateMiniState(this.store,user,m=>{const o=m.operations[op.id];if(o.lease_until>Date.now()||!['QUEUED','RUNNING','RECOVERING'].includes(o.status))return false;Object.assign(o,{status:'RUNNING',lease,lease_until:Date.now()+600000});return true;});if(!claimed)return;
  const project=this.project((await this.store.get(user)).state,op.binding.project_id);
  const jobStarted=performance.now();
  try{let result;if(op.kind==='editor_import'){result=await this.gather(user,project);await mutateMiniState(this.store,user,m=>{const o=m.operations[op.id];if(o.lease!==lease)fail('EDITOR_LEASE_LOST');const p=m.editor_projects[project.id];p.sources=result.sources;p.missing=result.missing;p.status='READY';p.current=1;p.revisions=[{revision:1,edit:result.edit,sha256:digest({sources:result.sources,edit:result.edit}),saved_at:now(),approval:null}];Object.assign(o,{status:'COMPLETE',lease_until:0});});}
   else {result=await mediaLane(()=>this.export(user,project,op));await mutateMiniState(this.store,user,m=>{const o=m.operations[op.id];if(o.lease!==lease)fail('EDITOR_LEASE_LOST');Object.assign(o,{status:'COMPLETE',result,lease_until:0,completed_at:now()});});}
  }catch(e){await mutateMiniState(this.store,user,m=>{const o=m.operations[op.id];if(o.lease!==lease)return;Object.assign(o,{status:e.message==='EDITOR_MEDIA_BUSY'?'QUEUED':'NEEDS_ATTENTION',error:/^[A-Z_]+$/.test(e.message)?e.message:'EDITOR_JOB_FAILED',lease_until:0,diagnostic:e.editorDiagnostic||processDiagnostic(e,op.kind==='editor_render'?480000:null,jobStarted)});if(op.kind==='editor_import')Object.assign(m.editor_projects[project.id],{status:'NEEDS_ATTENTION',error:o.error});});}
 }finally{this.running=false;}}
 async export(user,project,op){
  const r=project.revisions.find(r=>r.revision===op.binding.revision);if(!r||r.sha256!==op.binding.manifest_sha)fail('EDITOR_VERSION_MISMATCH');validateEdit(r.edit,project.sources,{render:true});
  const bucket=Object.values(project.sources)[0].artifact.bucket,base=`lumi-v2/editor/${digest(user)}/${project.id}/${r.sha256}`,storage=this.media.storage;
  const saved=await storage.download(bucket,base+'/result.json');if(saved){const result=JSON.parse(saved),bytes=await storage.download(bucket,result.path);if(!bytes||digest(bytes)!==result.sha256||result.manifest_sha!==r.sha256)fail('EDITOR_RENDER_INTEGRITY');return result;}
  // An output committed before its receipt is recovered without another encode.
  const existing=await storage.download(bucket,base+'/candidate.mp4');
  const dir=await mkdtemp(join(tmpdir(),'lumi-editor-export-')),start=performance.now();
  try{const output=join(dir,'candidate.mp4');if(existing)await writeFile(output,existing);else{
    const paths={};for(const id of new Set(r.edit.clips.map(c=>c.source_id))){const s=project.sources[id];paths[id]=join(dir,id);await writeFile(paths[id],await this.media.original(s.artifact));}
    const encodeStarted=performance.now();try{await this.encode({command:buildAssemblyCommand({editorial:r.edit,sources:project.sources,sourcePaths:paths,outputPath:output}),timeout:480000});}catch(e){e.editorDiagnostic={...processDiagnostic(e,480000,encodeStarted),phase:'ENCODE'};throw e;}
   }
   const meta=await probeFile(output),bytes=await readFile(output),v=meta.streams.find(s=>s.codec_type==='video');if(v?.width!==1080||v.height!==1920||v.codec_name!=='h264'||v.profile!=='High')fail('EDITOR_EXPORT_PROFILE');
   const result={path:base+'/candidate.mp4',bucket,sha256:digest(bytes),size:bytes.length,mime:'video/mp4',manifest_sha:r.sha256,revision:r.revision,duration_ticks:meta.video_ticks,partial:project.missing.length>0,approval:null,elapsed_ms:Math.round(performance.now()-start),streams:meta.streams};
   if(!existing)await this.media.put(bucket,result.path,bytes,'video/mp4');await this.media.put(bucket,base+'/manifest.json',Buffer.from(JSON.stringify({project_id:project.id,revision:r,sources:project.sources})),'application/json');await this.media.put(bucket,base+'/result.json',Buffer.from(JSON.stringify(result)),'application/json');return result;
  }finally{await rm(dir,{recursive:true,force:true});}
 }
}
export function sendEditorMedia(req,res,v){if(!v)return res.status(202).set('Retry-After','2').json({status:'PREPARING'});const r=mediaRange(req.headers.range,v.bytes.length);res.type(v.mime).set({'Accept-Ranges':'bytes','X-Content-SHA256':v.sha256});if(r===false)return res.status(416).set('Content-Range','bytes */'+v.bytes.length).end();if(r)return res.status(206).set('Content-Range',`bytes ${r.start}-${r.end}/${v.bytes.length}`).send(v.bytes.subarray(r.start,r.end+1));return res.send(v.bytes);}
export function mountEditor(app,{api,principal,wrap,editor}){
 app.get(api+'/editor/projects',wrap(async(req,res)=>res.json({projects:await editor.list(await principal(req))})));
 app.post(api+'/editor/projects',wrap(async(req,res)=>res.json(await editor.import(await principal(req),req.body))));
 app.get(api+'/editor/projects/:id',wrap(async(req,res)=>res.json(await editor.get(await principal(req),req.params.id))));
 app.post(api+'/editor/projects/:id',wrap(async(req,res)=>res.json(await editor.save(await principal(req),req.params.id,req.body))));
 app.get(api+'/editor/projects/:id/revision/:revision',wrap(async(req,res)=>{const p=await principal(req),{state}=await editor.owner(p.user),project=editor.project(state,req.params.id),r=project.revisions.find(r=>r.revision===Number(req.params.revision));if(!r)fail('EDITOR_VERSION_MISMATCH');res.json(r);}));
 app.post(api+'/editor/projects/:id/render',wrap(async(req,res)=>res.json(await editor.render(await principal(req),req.params.id,req.body))));
 app.get(api+'/editor/projects/:id/package',wrap(async(req,res)=>{const p=await principal(req),{state}=await editor.owner(p.user),project=editor.project(state,req.params.id);res.set('Content-Disposition','attachment; filename="Lumi-editor-'+project.id+'.json"').json({project,approval:null,publication_authorization:null});}));
 const source=async(req)=>{const p=await principal(req),{state}=await editor.owner(p.user),project=editor.project(state,req.params.id),s=own(project.sources,req.params.source);if(!s)fail('EDITOR_SOURCE_MISSING',404);return {p,s};};
 app.get(api+'/editor/projects/:id/sources/:source',wrap(async(req,res)=>{const {p,s}=await source(req),b=await editor.media.bundle(p.user,s.artifact,req.query.variant||'all',req.params.id);if(!b)return res.status(202).json({status:'PREPARING'});const {base,...publicBundle}=b;res.json(publicBundle);}));
 app.get(api+'/editor/projects/:id/sources/:source/:file',wrap(async(req,res)=>{const {p,s}=await source(req);const a=await editor.media.descriptor(p.user,s.artifact,req.params.file,req.params.id);if(!a)return res.status(202).set('Retry-After','1').json({status:'PREPARING'});await sendPrivateMedia(req,res,editor.media.storage,a);}));
 app.get(api+'/editor/projects/:id/renders/:job',wrap(async(req,res)=>{const p=await principal(req),{state}=await editor.owner(p.user);editor.project(state,req.params.id);const op=own(state.mini_app.operations,req.params.job);if(op?.kind!=='editor_render'||op.binding.project_id!==req.params.id||op.status!=='COMPLETE')fail('EDITOR_RESULT_PENDING');const a=op.result;if(!await editor.media.privateBucket(a.bucket))fail('EDITOR_PRIVATE_SOURCE_REQUIRED');if(req.query.download==='1')res.set('Content-Disposition',`attachment; filename="Lumi-candidata-v${a.revision}.mp4"`);await sendPrivateMedia(req,res,editor.media.storage,a);}));
}
