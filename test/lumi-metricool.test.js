import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac,createHash} from 'node:crypto';
import {MemoryReviewStore,reviewKey} from '../lib/telegram-review-v1/core.js';
import {MiniAppAuth,MINI_ORIGIN} from '../lib/telegram-mini-app/auth.js';
import {METRICOOL,MetricoolConnection,metricoolView,sealMetricool,openMetricool} from '../lib/telegram-mini-app/metricool.js';
import {PublicationStore,publicationPackage,mountPublication} from '../lib/telegram-mini-app/publication-store.js';
const env={LUMI_RUNTIME_ENV:'staging',SUPABASE_URL:'https://mofjhwathxzfnjapvvst.supabase.co',LUMI_TELEGRAM_BOT_TOKEN:'1:OFFLINE_ONLY'};
const master={artifact_id:'fixture-master',sha256:'a'.repeat(64),bucket:'private-fixtures',path:'master.mp4',size:100,mime:'video/mp4',width:1080,height:1920};
const brand={id:METRICOOL.brand,userId:METRICOOL.owner,ownerUserId:METRICOOL.owner,label:METRICOOL.label,timezone:METRICOOL.timezone,networksData:Object.fromEntries(Object.entries(METRICOOL.channels).map(([n,c])=>[n+'Data',c]))};
async function fixture(){
 const store=new MemoryReviewStore();await store.create('1',{user_id:'1',chat_id:'1',message_id:1,episodes:{ep1:{episode_id:'ep1',title:'Lumi y los animales de la granja'},ep2:{episode_id:'ep2',title:'Lumi y las tres flores de colores'}}});
 let owner=true;const validateOwner=async()=>owner,auth=new MiniAppAuth({store,env,validateOwner});
 const p=new URLSearchParams({auth_date:String(Math.floor(Date.now()/1000)),user:'{"id":1}',query_id:'fixture'}),secret=createHmac('sha256','WebAppData').update(env.LUMI_TELEGRAM_BOT_TOKEN).digest();
 p.set('hash',createHmac('sha256',secret).update([...p].sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>k+'='+v).join('\n')).digest('hex'));
 const session=await auth.login(p.toString()),principal=await auth.authenticate(session.cookie,session.csrf);
 return {store,auth,principal,session,validateOwner,revoke:()=>owner=false,packages:new PublicationStore({store})};
}
async function change(f,fn){const r=await f.store.get('1');fn(r.state);await f.store.cas('1',r.revision,r.state);}
function remote({identity=brand,tokenError=false,readError=false,missingReader=false}={}){
 const calls=[];
 const fetchImpl=async(url,options)=>{calls.push({url,options});assert.equal(options.redirect,'error');
  if(url===METRICOOL.token){if(tokenError)throw Error('lost ACK');return Response.json({access_token:'fixture-access',refresh_token:'fixture-refresh',expires_in:3600,token_type:'Bearer',scope:'mcp:read mcp:write'});}
  assert.equal(url,METRICOOL.resource);const body=JSON.parse(options.body);assert.match(options.headers.authorization,/Bearer fixture-access/);
  if(body.method==='notifications/initialized')return new Response(null,{status:202});
  let result;
  if(body.method==='initialize')result={protocolVersion:'2025-03-26',capabilities:{tools:{}}};
  else if(body.method==='tools/list')result={tools:[{name:missingReader?'unknown_reader':'getBrandSettings',inputSchema:{type:'object'}},{name:'createScheduledPost',inputSchema:{type:'object',required:['blogId','date','info'],properties:{mediaFiles:{type:'array'}}}}]};
  else{assert.equal(body.method,'tools/call');assert.equal(body.params.name,'getBrandSettings');assert.deepEqual(body.params.arguments,{});if(readError)return Response.json({}, {status:401});result={content:[{type:'text',text:JSON.stringify({data:[{...identity,id:6912906},identity]})}]};}
  return Response.json({jsonrpc:'2.0',id:body.id,result},{headers:{'mcp-session-id':'fixture-session'}});
 };return {fetchImpl,calls};
}
async function begin(f,net){const connection=new MetricoolConnection({...f,env,fetchImpl:net.fetchImpl});const start=await connection.start(f.principal);const handoff=await connection.handoffStart(start.url.split('/').at(-1));return {connection,start,handoff,state:new URL(handoff.url).searchParams.get('state')};}

test('METRICOOL: two episode drafts persist through restart, duplicate save ACK, concurrent edits, owner and material master changes',async()=>{
 const f=await fixture(),read=()=>f.store.get('1');const a=publicationPackage((await read()).state,'ep1'),b=publicationPackage((await read()).state,'ep2');assert.notEqual(a.text,b.text);
 a.networks.instagram.text='🐑 Mensaje editado para la granja. #Lumi';const body={version:0,networks:a.networks};
 const results=await Promise.allSettled(Array.from({length:10},()=>f.packages.save(f.principal,'ep1',body)));assert.ok(results.some(r=>r.status==='fulfilled'));assert.ok(results.every(r=>r.status==='fulfilled'?r.value.version===1:r.reason.message==='concurrent_update')); // Bounded CAS may ask a contending client to retry, never duplicate a version.
 const restarted=new PublicationStore({store:f.store});assert.equal((await restarted.save(f.principal,'ep1',body)).version,1);
 assert.equal(publicationPackage((await read()).state,'ep1').networks.instagram.text,a.networks.instagram.text);assert.equal(publicationPackage((await read()).state,'ep2').version,0);
 assert.equal((await read()).state.mini_app.publication_packages.ep1.versions.length,1);
 const changed=structuredClone(a.networks);changed.youtube.text+=' Más texto.';await assert.rejects(restarted.save(f.principal,'ep1',{version:0,networks:changed}),/VERSION_CONFLICT/);
 const r=await restarted.save(f.principal,'ep1',{version:1,networks:changed});assert.equal(r.version,2);assert.equal(r.authorization,null);
 await change(f,s=>s.episodes.ep1.master=master);assert.equal(publicationPackage((await read()).state,'ep1').package_sha,null);
 const withMaster=await restarted.save(f.principal,'ep1',{version:2,networks:changed});assert.equal(withMaster.version,3);assert.notEqual(withMaster.package_sha,r.package_sha);
 for(const id of ['missing','__proto__','constructor'])await assert.rejects(restarted.save(f.principal,id,body),/EPISODE_NOT_FOUND/);
 await assert.rejects(restarted.save({...f.principal,user:'2'},'ep1',body),/SESSION_REQUIRED/);
 await change(f,s=>s.mini_app.sessions[f.principal.session].expires_at=0);await assert.rejects(restarted.save(f.principal,'ep1',body),/SESSION_EXPIRED/);
});
test('METRICOOL: old master approval, package edits, arbitrary brand, missing fields and pending intent cannot authorize publication',async()=>{
 const f=await fixture(),body={version:0,networks:publicationPackage((await f.store.get('1')).state,'ep1').networks};
 await assert.rejects(f.packages.refuseSubmission(f.principal,'ep1',{}),/MASTER_REQUIRED/);
 await change(f,s=>s.episodes.ep1.master=master);await assert.rejects(f.packages.refuseSubmission(f.principal,'ep1',{}),/MASTER_HUMAN_REVIEW/);
 await change(f,s=>s.episodes.ep1.reviews={[reviewKey('ep1',null,master.sha256)]:{episode_id:'ep1',shot_id:null,artifact_sha:master.sha256,status:'APPROVED'}});
 await assert.rejects(f.packages.refuseSubmission(f.principal,'ep1',{brand_id:6912906}),/BRAND_MISMATCH/);
 await assert.rejects(f.packages.refuseSubmission(f.principal,'ep1',{confirm:true,networks:['instagram'],master_sha:master.sha256}),/BACKEND_AUTHORIZATION_REQUIRED/);
 await change(f,s=>s.mini_app.metricool={status:'BACKEND_VERIFIED',verification:{verified_at:new Date().toISOString(),networks:{}}});
 for(const extra of [{quota:0},{privacy:'PUBLIC_TO_EVERYONE'},{media_url:'https://bad.test/video'},{media_id:'missing'},{received_id:123},{published:true},{schedule:'2026-10-25T02:30:00'}])await assert.rejects(f.packages.refuseSubmission(f.principal,'ep1',{confirm:true,...extra}),/PROVIDER_CONTRACT_UNVERIFIED/);
 for(const edit of [n=>delete n.youtube,n=>delete n.tiktok.title,n=>n.instagram.text='x'.repeat(2201),n=>n.tiktok.text='x'.repeat(2001),n=>n.youtube.made_for_kids=false,n=>n.tiktok.privacy='PUBLIC_TO_EVERYONE',n=>n.instagram.ai_generated=false]){const networks=structuredClone(body.networks);edit(networks);await assert.rejects(f.packages.save(f.principal,'ep1',{version:0,networks}));}
 await change(f,s=>s.mini_app.publication_intents={uncertain:{episode_id:'ep1',status:'ACK_LOST'}});await assert.rejects(f.packages.save(f.principal,'ep1',body),/EXISTING_INTENT/);
 assert.equal((await f.store.get('1')).state.episodes.ep1.reviews[reviewKey('ep1',null,master.sha256)].status,'APPROVED');
});
test('METRICOOL: registered public OAuth client, PKCE, browser binding, restart and one-time callback; only real handler reads in fixture',async()=>{
 const f=await fixture(),net=remote(),flow=await begin(f,net),url=new URL(flow.handoff.url);
 assert.equal(url.origin,'https://app.metricool.com');assert.equal(url.searchParams.get('client_id'),METRICOOL.client);assert.equal(url.searchParams.get('code_challenge_method'),'S256');assert.equal(url.searchParams.get('redirect_uri'),METRICOOL.callback);
 await assert.rejects(flow.connection.handoffStart(flow.start.url.split('/').at(-1)),/RESTART_REQUIRED/);
 await assert.rejects(flow.connection.callback({state:flow.state,code:'fixture-code'},'wrong-browser'),/STATE_INVALID/);assert.equal(net.calls.length,0);
 const restarted=new MetricoolConnection({...f,env,fetchImpl:net.fetchImpl});const results=await Promise.allSettled([restarted.callback({state:flow.state,code:'fixture-code'},flow.handoff.browser),restarted.callback({state:flow.state,code:'fixture-code'},flow.handoff.browser)]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(net.calls.filter(c=>c.url===METRICOOL.token).length,1);
 const tokenBody=new URLSearchParams(net.calls[0].options.body);assert.equal(createHash('sha256').update(tokenBody.get('code_verifier')).digest('base64url'),url.searchParams.get('code_challenge'));
 const view=metricoolView((await f.store.get('1')).state.mini_app);assert.equal(view.backend_verified,true);assert.equal(view.publication_enabled,false);assert.equal(view.quota_remaining,null);assert.ok(view.networks.every(n=>n.linked&&!n.automatic_publication));
 const stored=(await f.store.get('1')).state.mini_app.metricool;assert.ok(stored.credentials);assert.equal(JSON.stringify(stored).includes('fixture-access'),false);assert.equal(JSON.stringify(view).includes('fixture-refresh'),false);
 assert.equal(stored.verification.brand_id,7627207);assert.equal(stored.verification.owner_id,5949429);
 assert.equal(net.calls.filter(c=>c.url===METRICOOL.resource&&JSON.parse(c.options.body).method==='tools/call').length,1);
 const sealed=sealMetricool(env,'1',{access_token:'safe'});assert.equal(openMetricool(env,'1',sealed).access_token,'safe');assert.throws(()=>openMetricool(env,'2',sealed));
});
test('METRICOOL: duplicate connect, wrong brand/owner, revoked owner, unknown tool, declined grant and expired connection fail closed',async()=>{
 const f=await fixture(),net=remote(),connection=new MetricoolConnection({...f,env,fetchImpl:net.fetchImpl});
 const starts=await Promise.all(Array.from({length:5},()=>connection.start(f.principal)));assert.equal(new Set(starts.map(s=>s.url)).size,1);
 for(const identity of [{...brand,id:6912906},{...brand,ownerUserId:5},{...brand,userId:5},{...brand,timezone:'UTC'}]){const a=await fixture(),n=remote({identity}),flow=await begin(a,n);await assert.rejects(flow.connection.callback({state:flow.state,code:'code'},flow.handoff.browser),/OWNER_OR_BRAND_MISMATCH/);assert.equal(metricoolView((await a.store.get('1')).state.mini_app).backend_verified,false);}
 const u=await fixture(),unknown=await begin(u,remote({missingReader:true}));await assert.rejects(unknown.connection.callback({state:unknown.state,code:'code'},unknown.handoff.browser),/BRAND_READ_UNSUPPORTED/);
 const r=await fixture(),revoked=await begin(r,remote());r.revoke();await assert.rejects(revoked.connection.callback({state:revoked.state,code:'code'},revoked.handoff.browser),/OWNER_REQUIRED/);
 const d=await fixture(),decline=await begin(d,remote());await assert.rejects(decline.connection.callback({state:decline.state,error:'access_denied'},decline.handoff.browser),/DECLINED/);
 const a=await fixture(),expired=await begin(a,remote({readError:true}));await assert.rejects(expired.connection.callback({state:expired.state,code:'code'},expired.handoff.browser),/ACCESS_EXPIRED/);assert.equal(metricoolView((await a.store.get('1')).state.mini_app).backend_verified,false);
});
test('METRICOOL: lost OAuth ACK does not replay exchange; refresh ambiguity persists through restart; discovery recovery is read only',async()=>{
 const f=await fixture(),net=remote({tokenError:true}),flow=await begin(f,net);await assert.rejects(flow.connection.callback({state:flow.state,code:'code'},flow.handoff.browser),/CONNECTION_UNAVAILABLE/);
 await assert.rejects(flow.connection.callback({state:flow.state,code:'code'},flow.handoff.browser),/STATE_INVALID/);assert.equal(net.calls.length,1);
 await change(f,s=>s.mini_app.metricool={credentials:sealMetricool(env,'1',{access_token:'fixture-access',refresh_token:'fixture-refresh',expires_at:0})});
 await assert.rejects(flow.connection.verify(f.principal),/CONNECTION_UNAVAILABLE/);
 const count=net.calls.length;await assert.rejects(new MetricoolConnection({...f,env,fetchImpl:net.fetchImpl}).verify(f.principal),/RECONNECT_REQUIRED/);assert.equal(net.calls.length,count);
 const a=await fixture(),good=remote();await change(a,s=>s.mini_app.metricool={candidate:sealMetricool(env,'1',{access_token:'fixture-access',expires_at:Date.now()+3600000}),pending:{phase:'TOKEN_RECEIVED'},refresh_uncertain:true});
 await new MetricoolConnection({...a,env,fetchImpl:good.fetchImpl}).verify(a.principal);assert.equal(good.calls.filter(c=>c.url===METRICOOL.token).length,0);assert.equal(metricoolView((await a.store.get('1')).state.mini_app).backend_verified,true);
});
test('METRICOOL: actual mounted authenticated/CSRF handlers reject anonymous access and arbitrary connection parameters',async()=>{
 const f=await fixture(),routes=new Map(),app={get:(path,fn)=>routes.set('GET '+path,fn),post:(path,fn)=>routes.set('POST '+path,fn)};
 const principal=req=>f.auth.authenticate(req.headers.cookie,req.method==='POST'?req.headers.csrf:null);
 const wrap=fn=>async(req,res)=>{try{await fn(req,res);}catch(e){res.status(e.status||409).json({error:e.message});}};
 mountPublication(app,{...f,api:'/api',principal,wrap,env,fetchImpl:()=>{throw Error('EXTERNAL_CALL_FORBIDDEN');}});
 async function invoke(method,path,body={},authenticated=true){let result,status=200;await routes.get(method+' '+path)({method,body,headers:authenticated?{cookie:f.session.cookie,csrf:f.session.csrf}:{},params:{episode:'ep1'}},{json:v=>result=v,status:s=>{status=s;return {json:v=>result=v};}});return {status,result};}
 let landing;routes.get('GET /lumi/studio/publication/result')({query:{status:'connected'}},{type:()=>({send:value=>landing=value})});assert.doesNotMatch(landing,/Acceso verificado/);assert.match(landing,/Continuá en Lumi Studio/);
 assert.equal((await invoke('GET','/api/publication/status',{},false)).status,401);
 assert.equal((await invoke('POST','/api/publication/connect',{brandId:6912906})).status,400);
 assert.equal((await invoke('GET','/api/publication/status')).result.brand_id,7627207);
 const pkg=(await invoke('GET','/api/publication/episodes/:episode')).result;
 assert.equal((await invoke('POST','/api/publication/episodes/:episode',{version:0,networks:pkg.networks})).result.version,1);
 assert.equal((await invoke('POST','/api/publication/episodes/:episode/submit',{confirm:true})).result.error,'PUBLICATION_MASTER_REQUIRED');
});


test('METRICOOL: resumed verification cannot erase a newer OAuth handoff',async()=>{
 const f=await fixture(),net=remote();await change(f,s=>s.mini_app.metricool={candidate:sealMetricool(env,'1',{access_token:'fixture-access',expires_at:Date.now()+3600000}),pending:{phase:'TOKEN_RECEIVED',nonce_sha:'old',expires_at:0}});
 let next,once=false;const connection=new MetricoolConnection({...f,env,fetchImpl:async(url,options)=>{if(!once){once=true;next=await connection.start(f.principal);}return net.fetchImpl(url,options);}});
 await connection.verify(f.principal);const pending=(await f.store.get('1')).state.mini_app.metricool.pending;assert.equal(pending.phase,'HANDOFF');
 assert.ok((await connection.handoffStart(next.url.split('/').at(-1))).browser);assert.equal(net.calls.filter(c=>c.url===METRICOOL.token).length,0);
});

 test('METRICOOL: stale read preserves the saved connection without presenting OAuth as missing',()=>{
 const m={metricool:{credentials:'ENCRYPTED_FIXTURE',status:'BACKEND_VERIFIED',verification:{verified_at:new Date(Date.now()-86400001).toISOString(),networks:{instagram:true,tiktok:true,youtube:true}}}};
 const v=metricoolView(m);assert.equal(v.connected,true);assert.equal(v.backend_verified,false);assert.equal(v.status,'VERIFICATION_STALE');assert.equal(v.reconnect_required,false);assert.ok(v.blockers.includes('METRICOOL_VERIFICATION_REQUIRED'));assert.ok(!JSON.stringify(v).includes('ENCRYPTED_FIXTURE'));
 });
