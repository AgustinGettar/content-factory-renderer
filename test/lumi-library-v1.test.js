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
