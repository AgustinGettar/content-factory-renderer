import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,createHmac} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {PGlite} from '@electric-sql/pglite';
import {MiniAppAuth} from '../lib/telegram-mini-app/auth.js';
import {MemoryReviewStore} from '../lib/telegram-review-v1/core.js';
import {verifiedAsset,approvalEvidence,reuseContract,LumiLibrary,sessionCandidates} from '../lib/telegram-mini-app/library.js';
const hash=b=>createHash('sha256').update(b).digest('hex');
const bytes=Buffer.alloc(30);Buffer.from('89504e470d0a1a0a','hex').copy(bytes);bytes.writeUInt32BE(90,16);bytes.writeUInt32BE(160,20);
const sha=hash(bytes),env={LUMI_RUNTIME_ENV:'staging',SUPABASE_URL:'https://mofjhwathxzfnjapvvst.supabase.co',LUMI_TELEGRAM_BOT_TOKEN:'123:OFFLINE'};
const media={artifact_id:'original',sha256:sha,size:bytes.length,bucket:'private-originals',path:'ep004/one.png',mime:'image/png',width:90,height:160};
const review={status:'APPROVED',user:'1',timestamp:'2026-10-01T00:00:00Z',artifact_sha:sha,callback_query_id:'offline'};
const candidate=(patch={})=>({a:media,owner:'1',episode:'ep004',shot:'s01',type:'APPROVED_IMAGE',name:'Imagen',description:'Original',review,source:'review-session:synthetic',...patch});
const asset=(patch={})=>verifiedAsset(candidate(patch),bytes);
async function principal(user='1'){
 const store=new MemoryReviewStore();await store.create(user,{user_id:user,chat_id:user,message_id:1});const auth=new MiniAppAuth({store,env,validateOwner:async()=>true});
 const p=new URLSearchParams({auth_date:String(Math.floor(Date.now()/1000)),query_id:'offline-'+user,user:JSON.stringify({id:Number(user)})});
 const secret=createHmac('sha256','WebAppData').update(env.LUMI_TELEGRAM_BOT_TOKEN).digest();
 p.set('hash',createHmac('sha256',secret).update([...p].sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${k}=${v}`).join('\n')).digest('hex'));
 const login=await auth.login(p.toString());return {p:await auth.authenticate(login.cookie),auth,login,store};
}
async function fixture(){const f=await principal(),assets=[asset()],selections=new Map(),protectedState={checkpoint:{status:'PAUSED_INCIDENT',budget:5},q42:{state:'EMISSION_UNKNOWN',reserve:0.3275},reviews:[review]};
 let loads=0,corrupt=false,privateStorage=true;
 const store={list:async o=>assets.filter(a=>a.owner_id===o),get:async(o,id)=>{const a=assets.find(a=>a.owner_id===o&&a.asset_id===id);if(!a)throw Error('LIBRARY_ASSET_NOT_FOUND');return a;},
  target:async(o,e)=>{if(e==='other-owner')throw Error('LIBRARY_TARGET_FORBIDDEN');},selections:async o=>[...selections.values()].filter(s=>s.owner_id===o),
  save:async s=>{if(!selections.has(s.selection_id))selections.set(s.selection_id,structuredClone(s));return selections.get(s.selection_id);},
  selection:async(o,id)=>{const s=selections.get(id);if(!s||s.owner_id!==o)throw Error('LIBRARY_SELECTION_NOT_FOUND');return s;}};
 const library=new LumiLibrary({store,env,privateBucket:async()=>privateStorage,loadBytes:async()=>{loads++;return corrupt?Buffer.from('corrupt'):bytes;}});
 return {...f,assets,selections,library,protectedState,loads:()=>loads,corrupt:()=>corrupt=true,publicBucket:()=>privateStorage=false};
}

test('ASSET_CATALOG + APPROVAL_PROVENANCE: exact hash approval; incomplete and unrelated approvals stay pending',()=>{
 const a=asset();assert.equal(a.approval_status,'HUMAN_APPROVED');assert.equal(a.sha256,sha);assert.equal(a.dimensions.width,90);
 for(const r of [null,{...review,artifact_sha:'a'.repeat(64)},{...review,status:'PASS'},{status:'APPROVED',artifact_sha:sha}]){
  const pending=asset({review:r});assert.equal(pending.approval_status,'PENDING_VERIFICATION');assert.deepEqual(pending.reuse_policy.modes,[]);assert.throws(()=>reuseContract(pending,{target_episode_id:'ep005',target_shot_id:'s1',mode:'REFERENCE_REUSE'}),/NOT_APPROVED/);
 }
 assert.equal(approvalEvidence(media,{status:'HUMAN_APPROVED',statement:'Approved',source_sha:sha},'repository:fixture').status,'HUMAN_APPROVED');
 assert.equal(approvalEvidence(media,{status:'HUMAN_APPROVED',statement:'Approved',source_sha:sha},'review-session:fixture').status,'PENDING_VERIFICATION');
});
test('HASH_VERIFICATION: corrupt bytes, wrong size/dimensions, URLs and traversal fail closed',()=>{
 assert.throws(()=>verifiedAsset(candidate(),Buffer.from('bad')),/HASH/);
 for(const a of [{...media,size:2},{...media,width:91},{...media,path:'../private'},{...media,path:'https://elsewhere/a'},{...media,bucket:'public/url'}])assert.throws(()=>verifiedAsset(candidate({a}),bytes));
});
test('REFERENCE_REUSE + DIRECT_MEDIA_REUSE + DERIVED_ASSET: distinct contracts, no inherited derivative approval or free-generation claim',()=>{
 const a=asset(),target={target_episode_id:'ep005',target_shot_id:'s01'};
 const ref=reuseContract(a,{...target,mode:'REFERENCE_REUSE'}),direct=reuseContract(a,{...target,mode:'DIRECT_MEDIA_REUSE'}),derived=reuseContract(a,{...target,mode:'DERIVED_ASSET'});
 assert.match(ref.generation_cost,/REQUIRES_QUOTE/);assert.equal(direct.regeneration_required,false);assert.equal(direct.sha256,sha);assert.equal(direct.storage_reference.path,media.path);assert.equal(derived.approval_inherited,false);
 for(const c of [ref,direct,derived]){assert.equal(c.generation_authorized,false);assert.equal(c.provider_calls,0);assert.equal(c.status,'DRAFT_NOT_APPLIED');assert.equal(c.approval_reference.decision,undefined);}
 const character=asset({type:'CHARACTER_REFERENCE',subject:'cow'});assert.equal(character.reuse_policy.standalone_model,false);assert.throws(()=>reuseContract(character,{...target,mode:'DIRECT_MEDIA_REUSE'}),/NOT_APPROVED/);
});
test('PRIVATE_MEDIA_ACCESS + AUTH_SECURITY: principal, owner, session and expiry bound; byte verification on access',async()=>{
 const f=await fixture(),list=await f.library.list(f.p),a=list.assets[0],url=new URL(a.media_url,'https://localhost');
 assert.equal(a.storage_reference,undefined);assert.equal(a.approval_reference.decision,undefined);
 const args=[a.asset_id,url.searchParams.get('expires'),url.searchParams.get('ticket')];
 assert.deepEqual((await f.library.media(f.p,...args)).bytes,bytes);
 await assert.rejects(f.library.list({user:'1'}),/SESSION/);
 const other=await principal('2'),sameUserNewSession=await principal('1');
 await assert.rejects(f.library.media(other.p,...args),/NOT_FOUND/);
 await assert.rejects(f.library.media(sameUserNewSession.p,...args),/EXPIRED/);
 await assert.rejects(f.library.media(f.p,a.asset_id,Date.now()-1,args[2]),/EXPIRED/);
 await assert.rejects(f.library.media(f.p,a.asset_id,args[1],'f'.repeat(64)),/EXPIRED/);
 f.corrupt();await assert.rejects(f.library.media(f.p,...args),/HASH/);
 const g=await fixture();g.publicBucket();await assert.rejects(g.library.select(g.p,{asset_id:g.assets[0].asset_id,target_episode_id:'ep005',target_shot_id:'s1',mode:'REFERENCE_REUSE'}),/PRIVATE_STORAGE/);
});
test('DUPLICATE_DETECTION + CROSS_EPISODE_ISOLATION + EP004_PRESERVATION: durable repeat selection, owned resolution, no production writes',async()=>{
 const f=await fixture(),before=JSON.stringify(f.protectedState),input={asset_id:f.assets[0].asset_id,target_episode_id:'ep005',target_shot_id:'s01',mode:'DIRECT_MEDIA_REUSE'};
 const first=await f.library.select(f.p,input),again=await f.library.select(f.p,input);assert.equal(first.selection_id,again.selection_id);assert.equal(f.selections.size,1);
 const second=await f.library.select(f.p,{...input,target_episode_id:'ep006'});assert.notEqual(first.selection_id,second.selection_id);
 const same=await f.library.select(f.p,{...input,target_episode_id:'ep004'});assert.ok(same.selection_id);
 const resolved=await f.library.resolve(f.p,first.selection_id);assert.equal(resolved.contract.sha256,sha);assert.equal(f.loads(),5);
 const other=await principal('2');await assert.rejects(f.library.resolve(other.p,first.selection_id),/NOT_FOUND/);
 await assert.rejects(f.library.select(f.p,{...input,target_episode_id:'other-owner'}),/FORBIDDEN/);
 await assert.rejects(f.library.select(f.p,{...input,generation_authorized:true}),/INPUT/);
 assert.equal(JSON.stringify(f.protectedState),before);
 f.corrupt();await assert.rejects(f.library.resolve(f.p,first.selection_id),/HASH/);
});
test('APPROVAL_PROVENANCE: generic import works across episode and shot IDs; contextual animals share unchanged media',()=>{
 const row={user_id:1,state:{episodes:{any_episode:{title:'Pradera',artifacts:{original:media},review_requests:{r:{artifact_id:'original',artifact_sha:sha,status:'APPROVED',action_key:'image:custom99',human_decision:review},v:{status:'APPROVED',review_contract:{source_sha:sha,inventory:[{id:'horse',color:'brown',shape:'horse',placement:'left'}]}}}}}}};
 const before=JSON.stringify(row),c=sessionCandidates(row,[]);assert.equal(c.length,3);assert.ok(c.some(x=>x.subject==='horse'));assert.equal(c[0].shot,'custom99');assert.ok(c.every(x=>x.a===media));assert.equal(JSON.stringify(row),before);
});
test('VERSIONING + DUPLICATE_DETECTION + AUTH_SECURITY: actual SQL grants, RLS, immutable versions and owner-bound selection',async()=>{
 const db=new PGlite();try{
  await db.exec('create role anon; create role authenticated; create role service_role bypassrls;');
  await db.exec(await readFile(new URL('../supabase/migrations/20261018200623_lumi_reusable_asset_library_v1.sql',import.meta.url),'utf8'));
  const a=asset(),register=async a=>(await db.query('select (public.lumi_library_register_v1($1::jsonb)).*',[JSON.stringify(a)])).rows[0];
  const first=await register(a),again=await register(a);assert.equal(first.asset_id,again.asset_id);assert.equal(first.version,1);
  const next={...a,asset_id:'b'.repeat(64),sha256:'c'.repeat(64),approval_reference:{...a.approval_reference,artifact_sha256:'c'.repeat(64)}};assert.equal((await register(next)).version,2);
  assert.equal((await db.query('select count(*)::int n from lumi_library_assets')).rows[0].n,2);
  await assert.rejects(db.exec("update lumi_library_assets set display_name='changed'"),/immutable/);
  const ins=async(owner,contract)=>db.query('insert into lumi_library_selections(selection_id,owner_id,asset_id,target_episode_id,target_shot_id,mode,contract) values($1,$2,$3,$4,$5,$6,$7)',[hash(JSON.stringify([owner,contract])),owner,a.asset_id,'ep005','s01','DIRECT_MEDIA_REUSE',JSON.stringify(contract)]);
  const contract=reuseContract(a,{target_episode_id:'ep005',target_shot_id:'s01',mode:'DIRECT_MEDIA_REUSE'});
  await ins(1,contract);await assert.rejects(ins(2,contract),/binding/);await assert.rejects(ins(1,{...contract,sha256:null}),/binding/);
  await assert.rejects(db.exec('delete from lumi_library_selections'),/immutable/);
  await db.exec('set role anon');await assert.rejects(db.exec('select * from lumi_library_assets'),/permission denied/);await assert.rejects(register(a),/permission denied/);await db.exec('reset role; set role authenticated');await assert.rejects(db.exec('select * from lumi_library_selections'),/permission denied/);await db.exec('reset role');
  assert.ok((await db.query("select relrowsecurity from pg_class where relname in ('lumi_library_assets','lumi_library_selections')")).rows.every(x=>x.relrowsecurity));
 }finally{await db.close();}
});
test('MOBILE_UI: five library groups, escaped provenance, no unsupported reuse buttons; production remains separate',async()=>{
 const js=await readFile(new URL('../public/lumi-studio/app.js',import.meta.url),'utf8'),element={innerHTML:'',textContent:'',hidden:false};
 const ctx={document:{querySelector:()=>element,addEventListener(){}},window:{},setInterval(){},setTimeout(){},clearTimeout(){}};
 runInNewContext(js.replace('navigation();login();','')+`globalThis.ui={libraryPage,libraryCard,set:d=>libraryData=d};`,ctx);
 const f=await fixture(),data=await f.library.list(f.p);ctx.ui.set(data);const html=ctx.ui.libraryPage();for(const label of ['Personajes','Escenarios','Imágenes','Clips','Masters'])assert.ok(html.includes(label));
 const pending={...data.assets[0],display_name:'<script>alert(1)</script>',reusable:false,reuse_policy:{modes:[]}};const card=ctx.ui.libraryCard(pending);assert.ok(!card.includes('<script>'));assert.ok(!card.includes('data-library-use'));assert.match(card,/Pendiente/);
});

test('HTTP_INTEGRATION: existing Mini App guards protect catalog, range media, selection and exact original resolution',async()=>{
 const {mountMiniApp}=await import('../lib/telegram-mini-app/runtime.js');
 const f=await principal(),a=asset(),tables={lumi_library_assets:[a],lumi_library_selections:[],lumi_pipeline_checkpoints:[]};
 const db={storage:{getBucket:async()=>({data:{public:false}})},from(name){
   let rows=tables[name],filters=[],single=false,insert=null;
   const q={select(){return q;},eq(k,v){filters.push([k,v]);return q;},order(){return q;},limit(){return q;},maybeSingle(){single=true;return q;},upsert(v){insert=v;return q;},then(resolve,reject){
     try{if(!rows)throw Error('UNEXPECTED_TABLE_ACCESS:'+name);if(insert&&!rows.some(r=>r.selection_id===insert.selection_id))rows.push(structuredClone(insert));
       const data=rows.filter(r=>filters.every(([k,v])=>String(r[k])===String(v)));return Promise.resolve({data:single?data[0]??null:data,error:null}).then(resolve,reject);
     }catch(e){return Promise.reject(e).then(resolve,reject);}
   }};return q;
 }};
 const routes=new Map(),middleware=[];const app={get:(p,fn)=>routes.set('GET '+p,fn),post:(p,fn)=>routes.set('POST '+p,fn),use:(_p,fn)=>middleware.push(fn)};
 mountMiniApp(app,{db,store:f.store,adapter:{},production:{},loadBytes:async()=>bytes,validateOwner:async()=>true,env,configureEntry:false});
 const call=async(method,path,{body={},params={},query={},headers={},cookie=f.login.cookie,csrf=f.login.csrf}={})=>{
   const req={method,headers:{origin:'https://content-factory-av2-staging.onrender.com','content-type':'application/json',cookie:'__Secure-lumi_studio='+cookie,'x-lumi-csrf':csrf,...headers},body,params,query};
   const res={statusCode:200,headers:{},status(n){this.statusCode=n;return this;},set(k,v){if(typeof k==='object')Object.assign(this.headers,k);else this.headers[k]=v;return this;},type(t){this.headers.type=t;return this;},json(v){this.data=v;this.ended=true;return this;},send(v){this.data=v;this.ended=true;return this;},end(){this.ended=true;return this;}};
   for(const fn of middleware){fn(req,res,()=>{});if(res.ended)return res;}
   await routes.get(method+' /lumi/studio/api'+path)(req,res);return res;
 };
 const denied=await call('GET','/library',{cookie:''});assert.equal(denied.statusCode,401);
 const list=await call('GET','/library');assert.equal(list.statusCode,200);assert.equal(list.headers['Cache-Control'],'no-store');assert.equal(list.data.assets.length,1);
 const ticket=new URL(list.data.assets[0].media_url,'https://localhost');
 const range=await call('GET','/library/media/:id',{params:{id:a.asset_id},query:Object.fromEntries(ticket.searchParams),headers:{range:'bytes=1-5'}});assert.equal(range.statusCode,206);assert.deepEqual(range.data,bytes.subarray(1,6));
 const input={asset_id:a.asset_id,target_episode_id:'ep005',target_shot_id:'shot77',mode:'DIRECT_MEDIA_REUSE'};
 assert.equal((await call('POST','/library/selections',{body:input,csrf:'forged'})).statusCode,401);
 assert.equal((await call('POST','/library/selections',{body:input,headers:{origin:'https://evil.invalid'}})).statusCode,403);
 const selected=await call('POST','/library/selections',{body:input});assert.equal(selected.statusCode,200);assert.equal(selected.data.status,'DRAFT_NOT_APPLIED');
 const resolved=await call('GET','/library/selections/:id',{params:{id:selected.data.selection_id}});assert.equal(resolved.data.contract.sha256,sha);assert.equal(tables.lumi_library_selections.length,1);
 assert.deepEqual(tables.lumi_pipeline_checkpoints,[]);
 assert.equal(globalThis.LUMI_OFFLINE_GUARD?.attempts.length,0);
});

// V2 uses the actual checkpoint manager and stage-result/review pipeline. All
// media, transport and storage below are synthetic in-memory inputs only.
async function productionLibraryFixture(){
 const f=await principal(),{MemoryLumiRecoveryStore,LumiRecoveryIncidentManager}=await import('../lib/lumi-recovery-incident-manager-v1.js');
 const {prepareGenericV2Episode,ep004ProductionRequest}=await import('../lib/lumi-generic-v2-adapter.js');
 const store=new MemoryLumiRecoveryStore(),manager=new LumiRecoveryIncidentManager({store}),objects=new Map(),assets=[],selections=new Map(),journals=new Map();
 const png=Buffer.from(bytes);png.writeUInt32BE(1520,16);png.writeUInt32BE(2688,20);const sha=hash(png),original={...media,sha256:sha,width:1520,height:2688,path:'source/original.png'};
 const approved={...review,artifact_sha:sha};
 assets.push(verifiedAsset(candidate({a:original,review:approved,episode:'ep_library_source',shot:'q41'}),png));objects.set(original.bucket+'/'+original.path,png);
 for(const episode of ['ep_library_source','ep_fixture_005','ep_fixture_006','ep_fixture_004']){
  const request=structuredClone(ep004ProductionRequest({episode_id:'ep_lumi_granja_004_20261008_ee7ab4b3',sha256:sha}));request.episodePlan.episode.id=episode;for(const shot of request.shotPlans){shot.director_input.episode_id=episode;shot.director_input.contract.REQUIRED_OBJECTS=['cow','sheep','hen'].map(id=>({id,count:1,color:'synthetic color',shape:id,placement:'synthetic placement'}));}const prepared=prepareGenericV2Episode(request);
  await manager.startEpisode({episodeId:episode,actions:prepared.actions,authorizedCeilingUsd:episode==='ep_fixture_006'?9:8,metadata:{runtime_revision:1,user:'1',generic_v2:prepared,provider_generation_authorized:false,episode_ledger:{currency:'USD',entries:{}}}});
  await manager.checkpoint(episode,d=>{for(const a of d.actions.slice(0,2)){a.status='COMPLETE';a.evidence={provider_succeeded:true,artifact_persisted:true,sha_verified:true,artifact_verified:true};}});
  const row=await f.store.get('1');row.state.episodes||={};row.state.episodes[episode]={episode_id:episode,title:'Synthetic',profile_sha:prepared.profile_sha,artifacts:{},review_requests:{},reviews:{}};await f.store.cas('1',row.revision,row.state);
 }
 await manager.checkpoint('ep_fixture_004',d=>{d.status='PAUSED_INCIDENT';d.metadata.budget_reservations={'image:q42':{amount_usd:.3275}};});
 const catalog={list:async o=>assets.filter(a=>a.owner_id===o),get:async(o,id)=>{const a=assets.find(a=>a.owner_id===o&&a.asset_id===id);if(!a)throw Error('LIBRARY_ASSET_NOT_FOUND');return structuredClone(a);},target:async(o,id)=>{const cp=await store.getEpisode(id);if(cp&&cp.metadata.user!==o)throw Error('LIBRARY_TARGET_FORBIDDEN');return cp;},targets:async o=>[...store.episodes.values()].filter(c=>c.metadata.user===o),
  selections:async()=>[...selections.values()],selection:async(o,id)=>{const s=selections.get(id);if(!s||s.owner_id!==o)throw Error('LIBRARY_SELECTION_NOT_FOUND');return s;},save:async s=>{if(!selections.has(s.selection_id))selections.set(s.selection_id,structuredClone(s));return selections.get(s.selection_id);}};
 let deriveCalls=0;
 const library=new LumiLibrary({store:catalog,manager,reviewStore:f.store,journal:{get:async id=>journals.get(id)},env,privateBucket:async()=>true,
  loadBytes:async a=>objects.get(a.bucket+'/'+a.path),artifactStorage:{download:async(b,p)=>objects.get(b+'/'+p)},
  inspect:async(b,stage,sha)=>({ok:true,status:'PASS',sha256:sha,decode:'PASS',width:1520,height:2688}),
  derive:async({application:r})=>{deriveCalls++;const data=Buffer.from('synthetic derived bytes'),artifact={...r.artifact,path:'derived/'+r.selection_id,sha256:hash(data),size:data.length};objects.set(artifact.bucket+'/'+artifact.path,data);return {artifact,qa:{ok:true,status:'PASS',sha256:artifact.sha256}};}});
 const select=(episode,mode='DIRECT_MEDIA_REUSE')=>library.select(f.p,{asset_id:assets[0].asset_id,target_episode_id:episode,target_shot_id:'q41',mode});
 const apply=async(s,extra={})=>library.apply(f.p,s.selection_id,{expected_revision:2,confirmation:{decision:'APPLY',narrative:true,continuity:true,rights:true},...extra});
 return {...f,cpStore:store,manager,objects,assets,journals,library,select,apply,catalog,deriveCalls:()=>deriveCalls};
}

test('V2 REUSE_APPLICATION HUMAN_REVIEW BUDGET_PRESERVATION SESSION_REOPEN: EP005/EP006 use exact originals and preserve paused EP004',async()=>{
 const f=await productionLibraryFixture(),protectedCp=await f.cpStore.getEpisode('ep_fixture_004');
 for(const ep of ['ep_fixture_005','ep_fixture_006']){
  const original=await f.cpStore.getEpisode(ep),s=await f.select(ep);
  assert.equal((await f.apply(s)).status,'AWAITING_HUMAN_REVIEW');
  const cp=await f.cpStore.getEpisode(ep),req=Object.values(cp.metadata.review_requests)[0],row=await f.store.get('1');
  assert.equal(cp.first_pending_action,'image:q41');assert.equal(cp.actions[2].status,'HUMAN_REVIEW_REQUIRED');
  assert.equal(cp.metadata.stage_results['image:q41'].result.artifacts[0].path,'source/original.png');
  assert.deepEqual(cp.metadata.stage_results['image:q41'].result.provider_job_ids,[]);
  assert.equal(req.status,'PENDING');assert.equal(row.state.episodes[ep].review_requests[req.review_request_id].status,'PENDING');
  assert.equal(cp.authorized_ceiling_usd,original.authorized_ceiling_usd);assert.deepEqual(cp.metadata.budget_reservations,{});
  const before=JSON.stringify(cp);assert.equal((await f.apply(s)).provider_calls,0);assert.equal(JSON.stringify(await f.cpStore.getEpisode(ep)),before);
 }
 assert.deepEqual(await f.cpStore.getEpisode('ep_fixture_004'),protectedCp);assert.equal(f.objects.size,1);assert.equal(f.journals.size,0);
});
test('V2 CAS_CONCURRENCY DUPLICATE_EVENT: one application wins; ACK loss repairs projection without a second artifact or decision',async()=>{
 const f=await productionLibraryFixture(),s=await f.select('ep_fixture_005');
 const results=await Promise.allSettled([f.apply(s),f.apply(s)]);assert.ok(results.some(r=>r.status==='fulfilled'));
 let cp=await f.cpStore.getEpisode('ep_fixture_005');assert.equal(Object.keys(cp.metadata.library_reuse).length,1);
 // The checkpoint application is authoritative even if the UI and review projection ACK disappear.
 const row=await f.store.get('1');row.state.episodes[cp.episode_id].review_requests={};await f.store.cas('1',row.revision,row.state);
 await f.apply(s);cp=await f.cpStore.getEpisode(cp.episode_id);assert.equal(Object.keys(cp.metadata.review_requests).length,1);
 assert.equal(Object.keys((await f.store.get('1')).state.episodes[cp.episode_id].review_requests).length,1);assert.equal(f.objects.size,1);
});
test('V2 Q42_AMBIGUITY_PRESERVATION AUTH_SECURITY HASH_INTEGRITY: blocked targets, reservations, revisions, ownership and missing approval fail closed',async()=>{
 for(const fault of ['paused','reservation','journal','stale','owner','hash','approval','pending_operation']){
  const f=await productionLibraryFixture(),ep=fault==='paused'?'ep_fixture_004':'ep_fixture_005',s=await f.select(ep);
  if(fault==='reservation')await f.manager.checkpoint(ep,d=>{d.metadata.budget_reservations={'image:q41':{amount_usd:.5}};});
  if(fault==='journal'){const cp=await f.cpStore.getEpisode(ep);f.journals.set(hash(ep+':'+cp.metadata.generic_v2.binding_sha+':image:q41'),{state:'EMISSION_UNKNOWN'});}
  if(fault==='owner')await f.manager.checkpoint(ep,d=>{d.metadata.user='2';});
  if(fault==='hash')f.objects.set('private-originals/source/original.png',Buffer.from('corrupt'));
  if(fault==='approval')f.assets[0].approval_status='PENDING_VERIFICATION';
  if(fault==='pending_operation'){const row=await f.store.get('1');row.state.mini_app.operations.pending={kind:'generate',status:'QUEUED',binding:{proposal_id:ep,next_action:'image:q41'}};await f.store.cas('1',row.revision,row.state);}
  const before=await f.cpStore.getEpisode(ep);
  await assert.rejects(f.apply(s,fault==='stale'?{expected_revision:1}:{}));assert.deepEqual(await f.cpStore.getEpisode(ep),before);
 }
});
test('V2 REFERENCE_REUSE ASSET_PROVENANCE: canonical image stays first; actual provider payload includes approved supplemental reference',async()=>{
 const f=await productionLibraryFixture(),s=await f.select('ep_fixture_005','REFERENCE_REUSE');await f.apply(s);
 const cp=await f.cpStore.getEpisode('ep_fixture_005'),{buildSceneImagePayload}=await import('../lib/lumi-v2-executor-bindings.js');
 const resolved=await f.library.verifiedApplication(cp,'image:q41');assert.equal(resolved.application.reuse_mode,'REFERENCE_REUSE');
 const payload=buildSceneImagePayload(cp.metadata.generic_v2,cp.metadata.generic_v2.shot_plans[0],'https://private.invalid/canonical',['https://private.invalid/reference']);
 assert.deepEqual(payload.image_urls,['https://private.invalid/canonical','https://private.invalid/reference']);assert.equal(cp.actions[2].status,'PENDING');
 assert.equal(resolved.application.expected_cost_impact.potential_saving_usd,0);assert.equal(resolved.application.expected_cost_impact.verified_saving_usd,null);
 assert.equal(cp.metadata.budget_reservations,undefined);
});
test('V2 DERIVED_ASSET: explicit local recipe preserves original, new artifact awaits approval and repeat never derives twice',async()=>{
 const f=await productionLibraryFixture(),s=await f.select('ep_fixture_006','DERIVED_ASSET'),input={derivation:{kind:'CROP_IMAGE',x:0,y:0,width:1080,height:1920}};
 await f.apply(s,input);const cp=await f.cpStore.getEpisode('ep_fixture_006'),r=cp.metadata.stage_results['image:q41'].result;
 assert.notEqual(r.artifacts[0].sha256,f.assets[0].sha256);assert.equal(r.human_review_requirement,true);assert.equal(f.deriveCalls(),1);
 await f.apply(s,input);assert.equal(f.deriveCalls(),1);assert.equal(f.objects.size,2);assert.equal(f.assets.length,1);
 await assert.rejects(f.apply(s,{derivation:{...input.derivation,x:10}}),/DERIVATION_CHANGED/);
});
test('V2 REUSE_COMPATIBILITY: incompatible scene, character, format, duration, version and owner cannot be inferred compatible',async()=>{
 const {reuseCompatibility,reuseCostImpact}=await import('../lib/telegram-mini-app/library.js'),f=await productionLibraryFixture();
 const cp=await f.cpStore.getEpisode('ep_fixture_005'),source=await f.cpStore.getEpisode('ep_library_source'),shot=cp.metadata.generic_v2.shot_plans[0],a=f.assets[0];
 assert.equal(reuseCompatibility(a,cp,shot,'DIRECT_MEDIA_REUSE',source).status,'COMPATIBLE');
 for(const changed of [{...a,dimensions:{width:1920,height:1080}},{...a,owner_id:'2'},{...a,approval_status:'PENDING_VERIFICATION'},{...a,asset_type:'MASTER'}])assert.equal(reuseCompatibility(changed,cp,shot,'DIRECT_MEDIA_REUSE',source).status,'INCOMPATIBLE');
 source.metadata.generic_v2.plan.scenes[0].educational_goal='Incompatible topic';assert.equal(reuseCompatibility(a,cp,shot,'DIRECT_MEDIA_REUSE',source).status,'INCOMPATIBLE');
 assert.equal(reuseCostImpact(cp,cp.actions[2],'DIRECT_MEDIA_REUSE').potential_saving_usd,null);
 const selected=await f.select('ep_fixture_005');f.assets[0].version++;await assert.rejects(f.apply(selected),/CONTRACT_CHANGED/);
});

test('V2 DIRECT_MEDIA_REUSE MATERIALIZATION: approved destination advances through existing review and Source QA without a fake provider journal',async()=>{
 const f=await productionLibraryFixture(),s=await f.select('ep_fixture_005'),priced=await f.store.get('1');
 priced.state.production_commands={synthetic_quote:{status:'COMPLETE',result:{status:'AWAITING_HUMAN_AUTHORIZATION',budget_gate:'PASS',episode_id:'ep_fixture_005',action_key:'image:q41',checkpoint_version:2,quote_id:'fixture-quote',quote_usd:.2,expires_at:new Date(Date.now()+60000).toISOString()}}};await f.store.cas('1',priced.revision,priced.state);
 await f.apply(s);assert.equal((await f.library.plan(f.p,'ep_fixture_005','q41')).applications[0].expected_cost_impact.verified_saving_usd,null);
 const {inputDigest}=await import('../lib/lumi-v2-activation-context.js'),{reconcileStageReview}=await import('../lib/lumi-stage-result-v2.js'),{createV2InputMaterializer,checkpointIdentity}=await import('../lib/lumi-v2-input-materializer.js');
 const cp=await f.cpStore.getEpisode('ep_fixture_005'),req=Object.values(cp.metadata.review_requests)[0],row=await f.store.get('1');
 const decision={user:'1',chat_id:'1',message_id:1,status:'APPROVED',timestamp:new Date().toISOString(),callback_query_id:'synthetic-human-decision',artifact_sha:req.artifact_sha,review_version:req.review_version,
  checklist_decision:{contract_sha:inputDigest(req.review_contract),pose:'FRONT',wand_hand:'RIGHT',full_playback:true,source_comparison:true}};
 Object.assign(row.state.episodes[cp.episode_id].review_requests[req.review_request_id],{status:'APPROVED',human_decision:decision});await f.store.cas('1',row.revision,row.state);
 const storage={download:async(b,p)=>f.objects.get(b+'/'+p)};
 await reconcileStageReview({manager:f.manager,reviewStore:f.store,user:'1',episodeId:cp.episode_id,requestId:req.review_request_id,artifactStorage:storage,strict:true});
 const after=await f.cpStore.getEpisode(cp.episode_id);assert.equal(after.first_pending_action,'source_qa:q41');
 const result=await createV2InputMaterializer({store:f.cpStore,storage,reviewStore:f.store,journal:{get:async()=>{throw Error('NO_NEW_PROVIDER_JOURNAL');}},library:f.library})({episode_id:cp.episode_id,stage_id:'SOURCE_QA',checkpoint_id:checkpointIdentity(after),profile_version:2,execution_context:{user:'1',profile_sha:after.metadata.generic_v2.profile_sha,action_key:after.first_pending_action}});
 assert.equal(result.materialized_stage_input.source.artifact.sha256,f.assets[0].sha256);assert.equal(result.provenance.library_reuse[0].selection_id,s.selection_id);assert.equal(result.MATERIALIZE_PROVIDER_CALLS,0);
 assert.equal((await f.library.plan(f.p,'ep_fixture_005','q41')).applications[0].expected_cost_impact.verified_saving_usd,.2);
});

test('V2 VIDEO_PLAYBACK PRIVATE_MEDIA_PREVIEW: all catalog types use private original bytes and session-scoped fresh access',async()=>{
 const f=await fixture();f.assets.length=0;
 for(const type of ['CHARACTER_REFERENCE','SCENE_REFERENCE','APPROVED_IMAGE','APPROVED_VIDEO','MASTER']){
  const video=['APPROVED_VIDEO','MASTER'].includes(type),a=asset({type,...(video?{a:{...media,mime:'video/mp4',duration:4}}:{})});f.assets.push(a);
  const access=await f.library.access(f.p,a.asset_id),url=new URL(access.media.media_url,'https://fixture.invalid');
  assert.equal(access.state,'LOADING');assert.equal(access.media.media_type,video?'video/mp4':'image/png');
  const result=await f.library.media(f.p,a.asset_id,url.searchParams.get('expires'),url.searchParams.get('ticket'));
  assert.deepEqual(result.bytes,bytes);assert.equal(result.asset.sha256,sha);
 }
 assert.equal(f.assets.length,5);assert.equal((await f.library.list(f.p)).selections.length,0);
});

test('V2 DIRECT_MEDIA_REUSE CLIPS: exact compatible video enters its own review, preserves source and educational pause',async()=>{
 const f=await productionLibraryFixture(),data=Buffer.from('synthetic-mp4-original'),sha256=hash(data);
 const original={...media,artifact_id:'source-clip',path:'source/clip.mp4',mime:'video/mp4',sha256,size:data.length,width:1080,height:1920,duration:4};
 const a=verifiedAsset(candidate({a:original,review:{...review,artifact_sha:sha256},episode:'ep_library_source',shot:'q41',type:'APPROVED_VIDEO'}),data);f.assets.push(a);f.objects.set(original.bucket+'/'+original.path,data);
 const cp=await f.manager.checkpoint('ep_fixture_006',d=>{for(const action of d.actions.slice(2,5)){action.status='COMPLETE';action.evidence={provider_succeeded:true,artifact_persisted:true,sha_verified:true,artifact_verified:true};}d.metadata.source_artifacts={q41:{artifact:{...media,sha256:f.assets[0].sha256}}};});
 assert.equal(cp.first_pending_action,'video:q41');const s=await f.library.select(f.p,{asset_id:a.asset_id,target_episode_id:cp.episode_id,target_shot_id:'q41',mode:'DIRECT_MEDIA_REUSE'});
 await f.apply(s,{expected_revision:cp.metadata.runtime_revision});const after=await f.cpStore.getEpisode(cp.episode_id);
 assert.equal(after.metadata.stage_results['video:q41'].result.artifacts[0].sha256,sha256);assert.equal(after.first_pending_action,'video:q41');assert.equal(after.actions[5].status,'HUMAN_REVIEW_REQUIRED');
 assert.equal(f.journals.size,0);assert.equal(f.objects.size,2);assert.equal(after.authorized_ceiling_usd,9);assert.deepEqual(after.metadata.budget_reservations,cp.metadata.budget_reservations||{});
 const {reuseCompatibility}=await import('../lib/telegram-mini-app/library.js'),source=await f.cpStore.getEpisode('ep_library_source'),shot=after.metadata.generic_v2.shot_plans[0];
 assert.equal(reuseCompatibility(a,after,{...shot,response_window_seconds:2.5},'DIRECT_MEDIA_REUSE',source).status,'INCOMPATIBLE');
});

test('V2 HUMAN_APPROVAL_CAPTURE DUPLICATE_EVENT: shared review controller captures only after durable reconciliation; split decisions are excluded',async()=>{
 const {ProductionReviewController}=await import('../lib/telegram-review-v1/production.js');
 const f=await productionLibraryFixture(),s=await f.select('ep_fixture_005');await f.apply(s);
 const cp=await f.cpStore.getEpisode('ep_fixture_005'),row=await f.store.get('1'),r=Object.values(row.state.episodes[cp.episode_id].review_requests)[0];
 r.status='APPROVED';r.human_decision={...review,artifact_sha:r.artifact_sha};
 assert.equal(sessionCandidates({user_id:1,state:row.state},[cp]).filter(c=>c.episode===cp.episode_id).length,0);
 Object.assign(cp.metadata.review_requests[r.review_request_id],structuredClone(r));
 const candidates=sessionCandidates({user_id:1,state:row.state},[cp]).filter(c=>c.episode===cp.episode_id),registered=new Map();assert.ok(candidates.length);
 const c=Object.create(ProductionReviewController.prototype);c.row=async()=>({state:{episodes:{[cp.episode_id]:{pipeline:'test'}}}});let reconciled=false;
 c.adapters={test:{handleReview:async()=>{reconciled=true;return {status:'READY_TO_CONTINUE'};}}};
 c.captureApproved=async()=>{assert.equal(reconciled,true);for(const candidate of candidates){const a=verifiedAsset(candidate,f.objects.get(candidate.a.bucket+'/'+candidate.a.path));registered.set(a.asset_id,a);}};
 await c.reviewed({user:'1',episodeId:cp.episode_id,requestId:r.review_request_id});await c.reviewed({user:'1',episodeId:cp.episode_id,requestId:r.review_request_id});
 assert.equal(registered.size,candidates.length);assert.ok([...registered.values()].every(a=>a.approval_status==='HUMAN_APPROVED'));assert.equal(f.objects.size,1);
});

test('V2 PRIVATE_MEDIA_PREVIEW SIGNED_URL_EXPIRATION TELEGRAM_WEBVIEW: fresh authenticated read, image/video MIME, no optimistic READY and retry never POSTs',async()=>{
 const js=await readFile(new URL('../public/lumi-studio/app.js',import.meta.url),'utf8'),f=await fixture(),a=(await f.library.list(f.p)).assets[0],calls=[],element={innerHTML:'',textContent:'',hidden:false};
 let accessError=false;
 const ctx={document:{querySelector:()=>element,addEventListener(){},querySelectorAll:()=>[]},window:{},setInterval(){},setTimeout(){},clearTimeout(){},AbortController,Blob,
  URL:{createObjectURL:b=>'blob:verified-'+b.size,revokeObjectURL(){}},fetch:async(url,opts)=>{calls.push({url,opts});return {ok:true,headers:{get:()=>a.media_type},blob:async()=>new Blob([bytes],{type:a.media_type})};}};
 runInNewContext(js.replace('navigation();login();','')+`request=async path=>{if(globalThis.accessError)throw Object.assign(Error('MINI_SESSION_EXPIRED'),{status:401});globalThis.accessPaths.push(path);return {media:{media_url:'/fresh-authenticated-ticket'}};};globalThis.accessPaths=[];globalThis.ui={libraryMediaUrl,libraryPreview,clearLibraryMedia};`,ctx);
 const html=ctx.ui.libraryPreview(a);assert.match(html,/LOADING/);assert.doesNotMatch(html,/READY/);
 assert.equal(await ctx.ui.libraryMediaUrl(a),'blob:verified-30');assert.equal(calls[0].opts.credentials,'same-origin');assert.equal(calls[0].opts.cache,'no-store');
 assert.deepEqual(Array.from(ctx.accessPaths),['/library/access/'+a.asset_id]);assert.ok(calls.every(c=>!c.opts.method||c.opts.method==='GET'));
 ctx.ui.clearLibraryMedia();ctx.accessError=true;await assert.rejects(ctx.ui.libraryMediaUrl(a),/SESSION_EXPIRED/);ctx.accessError=false;assert.equal(await ctx.ui.libraryMediaUrl(a),'blob:verified-30');
 assert.match(js,/EXPIRED_ACCESS/);assert.match(js,/data-library-retry/);assert.match(js,/m\.playsInline=true/);assert.match(js,/addEventListener\(a\.media_type==='video\/mp4'\?'loadedmetadata':'load'/);
});
