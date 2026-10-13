import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHmac} from 'node:crypto';
import {deflateSync} from 'node:zlib';
import {MemoryReviewStore,newSession,ReviewService,sha256} from '../lib/telegram-review-v1/core.js';
import {signRequest} from '../lib/telegram-review-v1/make-transport.js';
import {mountMakeTransportEndpoint} from '../lib/telegram-review-v1/make-endpoint.js';
import {MemoryLumiRecoveryStore,LumiRecoveryIncidentManager} from '../lib/lumi-recovery-incident-manager-v1.js';
import {createGenericV2Runtime} from '../lib/lumi-v2-telegram-runtime.js';
import {ProductionReviewController} from '../lib/telegram-review-v1/production.js';
import {isolatedQ41Input} from '../lib/lumi-isolated-usd-preflight.js';
import {authenticateFirstImageCallback,inputDigest,FIRST_IMAGE_SCOPE as scope,FIRST_IMAGE_EPISODE as episode,
  FIRST_IMAGE_OPERATION as operation,diagnosticOperationId,DIAGNOSTIC_Q41_KEY,DIAGNOSTIC_Q41_SCOPE} from '../lib/lumi-v2-activation-context.js';

// Offline transport/economics only. No live quote, billing assertion or provider.
const secret='offline-first-image-secret-'.repeat(3),d=isolatedQ41Input();
const canonical=await readFile(new URL('./fixtures/ep004-canonical-source.png',import.meta.url));
const sourceUrl='https://q41-offline.supabase.co/storage/v1/object/sign/'+d.canonical_artifact.bucket+'/'+d.canonical_artifact.path+'?token=OFFLINE';
const seal=evidence=>({evidence,seal:createHmac('sha256',secret).update(scope+'\n'+inputDigest(evidence)).digest('hex')});
// A tiny compressed, flat-color raster for decode/dimension tests, not a Lumi
// creative output. Never used as canonical source or visual-QA evidence.
function raster(width=1152,height=2048){
  const crc=buf=>{let c=0xffffffff;for(const b of buf){c^=b;for(let i=0;i<8;i++)c=c&1?0xedb88320^(c>>>1):c>>>1;}return (c^0xffffffff)>>>0;};
  const chunk=(type,data)=>{const b=Buffer.concat([Buffer.from(type),data]),n=Buffer.alloc(4),c=Buffer.alloc(4);n.writeUInt32BE(data.length);c.writeUInt32BE(crc(b));return Buffer.concat([n,b,c]);};
  const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=2;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(Buffer.alloc((width*3+1)*height))),chunk('IEND',Buffer.alloc(0))]);
}
const image=raster();
async function fixture({inject,mode='complete',imageBytes=image,estimateUsd=0.271,estimateMode='success',transportPatch={},supervised=false,readProviderBalance=null,actualCostUsd=null}={}){
  const reviewStore=new MemoryReviewStore(),store=new MemoryLumiRecoveryStore(),manager=new LumiRecoveryIncidentManager({store});
  const objects=new Map([[d.canonical_artifact.bucket+'/'+d.canonical_artifact.path,canonical]]),journalRows=new Map(),calls=[],telegramCalls=[];
  const env={LUMI_RUNTIME_ENV:'staging',LUMI_TELEGRAM_CALLBACK_SECRET:secret,LUMI_TELEGRAM_TRANSPORT_AUTHORITY:'MAKE',
    LUMI_TELEGRAM_REVIEW_TEST_USERS:'1',HF_API_KEY:'OFFLINE_KEY',SUPABASE_URL:'https://q41-offline.supabase.co'};
  const cover={artifact_id:'home',sha256:sha256(canonical),size:canonical.length,bucket:d.canonical_artifact.bucket,path:d.canonical_artifact.path,mime:'image/png'};
  await reviewStore.create('1',newSession({user_id:'1',chat_id:'1',message_id:138,cover}));
  const proofBytes=raster(1,1),proof={artifact_id:'OFFLINE_BILLING_PROOF',bucket:cover.bucket,path:'offline/proof.png',
    mime:'image/png',size:proofBytes.length,sha256:sha256(proofBytes)};
  objects.set(proof.bucket+'/'+proof.path,proofBytes);
  const now=Date.now(),evidence={source:'VERIFIED_SAME_API_ACCOUNT',proof_reference:proof.sha256,account_id:'fixture-account',
    verification_method:'BILLING_REVIEW',billing_origin:'https://open.higgsfield.ai',reviewed_by:'OFFLINE_REVIEWER',proof_artifact:proof,
    user_id:'1',episode_id:episode,shot_id:'q41',descriptor_sha256:d.descriptor_sha256,api_key_sha256:sha256(env.HF_API_KEY),
    checked_at:new Date(now).toISOString(),expires_at:new Date(now+59000).toISOString(),
    prepaid_only:true,auto_recharge:false,credit_billing:false,negative_balance_allowed:false,external_funding_locked:true,balance_usd:4.64};
  const quote={episode_id:episode,shot_id:'q41',model:d.model,canonical_source_verified:true,canonical_source_sha256:d.canonical_artifact.sha256,
    descriptor_sha256:d.descriptor_sha256,prompt_sha256:d.prompt_sha256,status:'QUOTE_VERIFIED',http_status:200,
    payload_sha256:sha256(JSON.stringify({...d.input,image_urls:[sourceUrl]})),quote_usd:0.271,quote_timestamp:new Date(now).toISOString(),quote_expiration:null};
  const diag=diagnosticOperationId('1',DIAGNOSTIC_Q41_KEY,DIAGNOSTIC_Q41_SCOPE);
  await store.putEpisode({episode_id:diag,metadata:{isolated_validation:{q41_quote_attempt:{result:quote}}}});
  const edit=async fn=>{const row=await reviewStore.get('1');fn(row.state);await reviewStore.cas('1',row.revision,row.state);};
  await edit(s=>{if(!supervised)s.q41_prepaid_evidence=seal(evidence);s.episodes.historical={episode_id:'historical',master:{...cover,mime:'video/mp4'},reviews:{approved:{status:'APPROVED'}}};});
  const storage={download:async(b,p)=>objects.get(b+'/'+p)??null,upload:async(b,p,bytes)=>{assert.ok(!objects.has(b+'/'+p));objects.set(b+'/'+p,Buffer.from(bytes));}};
  // Mirror the existing SQL FK/admission contract, not only the JS interface.
  const journal={get:async id=>structuredClone(journalRows.get(id)||null),prepare:async row=>{
    assert.ok(await store.getEpisode(row.episode_id),'journal requires its durable checkpoint');
    if(journalRows.has(row.attempt_id))throw Error('DUPLICATE');journalRows.set(row.attempt_id,structuredClone(row));},
    transition:async(id,from,patch)=>{const row=journalRows.get(id);assert.equal(row.state,from);Object.assign(row,structuredClone(patch));return structuredClone(row);}};
  const fetchImpl=async(url,options={})=>{
    calls.push({url,method:options.method||'GET',body:options.body});assert.equal(options.redirect,'error');
    if(url==='https://api.higgsfield.ai/estimate/marketing-studio/image'){
      assert.equal(options.method,'POST');assert.ok([...journalRows.values()].every(j=>j.incident_classification==='INSUFFICIENT_PROVIDER_BALANCE'));
      assert.equal((await store.getEpisode(operation)).metadata.first_image.state,'ESTIMATING');
      assert.equal((await reviewStore.get('1')).state.v2_authorizations[operation].status,'PREFLIGHT_CLAIMED');
      if(estimateMode==='timeout')throw Error('OFFLINE_ESTIMATE_TIMEOUT');
      if(estimateMode==='malformed')return new Response('{');
      if(estimateMode==='non-usd')return Response.json({credits:1});
      if(estimateMode==='http-error')return Response.json({error:'OFFLINE'}, {status:503});
      return Response.json({usd:estimateUsd,expires_at:estimateMode==='expired'?'2026-01-01T00:00:00Z':undefined});
    }
    if(options.method==='POST'){
      assert.equal(url,'https://api.higgsfield.ai/marketing-studio/image');
      const cp=await store.getEpisode(operation);assert.equal(cp.metadata.first_image.state,'EMITTING');
      assert.equal(cp.metadata.budget_reservations['image:q41'].amount_usd,supervised?Math.ceil(estimateUsd*1.25*1e6)/1e6:4.64);assert.equal(journalRows.get(cp.metadata.first_image.attempt_id??operation).state,'EMITTING');
      assert.equal(sha256(options.body),quote.payload_sha256);
      if(mode==='insufficient')return Response.json({error:{code:'insufficient_balance'}},{status:402,headers:{'x-request-id':'billing-denial'}});
      if(mode==='generic-402')return Response.json({error:{code:'payment_required'}},{status:402});
      if(mode==='queued-error')return Response.json({error:{code:'insufficient_balance'},status:'queued'},{status:402});
      if(mode==='accepted-error')return Response.json({error:{code:'insufficient_balance'},request_id:'maybe-job'},{status:402});
      if(mode==='timeout')throw Error('OFFLINE_TIMEOUT');
      if(mode==='malformed')return new Response('{');
      return Response.json({request_id:'offline-job',status_url:'https://api.higgsfield.ai/requests/offline-job'});
    }
    if(url==='https://api.higgsfield.ai/requests/offline-job')return Response.json({request_id:'offline-job',status:mode==='pending'?'processing':'completed',cost:actualCostUsd===null?undefined:{usd:actualCostUsd},images:[{url:'https://media.example.test/offline.png'}]});
    assert.equal(url,'https://media.example.test/offline.png');return new Response(imageBytes);
  };
  const sourceCalls=[];
  const makeAdapter=()=>createGenericV2Runtime({manager,reviewStore,artifactStorage:storage,journal,validateOwner:async(u,c)=>u==='1'&&c==='1',env,fetchImpl,inject,readProviderBalance,
    mediaTransport:async a=>{sourceCalls.push(a);return {url:sourceUrl,sha256:a.sha256,expires_at:new Date(Date.now()+300000).toISOString(),...transportPatch};}});
  let adapter=makeAdapter();
  const production=new ProductionReviewController({store:reviewStore,adapters:{LUMI_PRODUCTION_PROFILE_V2:adapter}});
  const svc=new ReviewService({store:reviewStore,production,validateOwner:async(u,c)=>u==='1'&&c==='1',loadBytes:a=>storage.download(a.bucket,a.path),
    telegram:{call:async(method,body)=>{
      telegramCalls.push({method,body:structuredClone(body)});if(method==='answerCallbackQuery')return true;
      assert.equal(method,'editMessageMedia');assert.equal(body.message_id,138);assert.equal(body.media.type,'photo');
      return {message_id:138,chat:{id:1},photo:[{file_id:'offline-image',file_unique_id:'offline-unique'}]};
    }}});
  let count=0;
  const callback=async action=>{
    const s=(await reviewStore.get('1')).state,t=Object.entries(s.tokens).reverse().find(([,t])=>t.action===action);assert.ok(t,action);
    return {id:'offline-callback-'+(++count),from:{id:1},message:{message_id:138,chat:{id:1}},data:'lr:'+t[0]};
  };
  const envelope=cb=>{const body={op:'callback',user_id:'1',chat_id:'1',callback_query:cb},signed={method:'POST',path:'/lumi/telegram-review/make/v1',
    timestamp:String(Math.floor(Date.now()/1000)),requestId:'offline-request-'+(++count),body:Buffer.from(JSON.stringify(body))};return {body,signed,signature:signRequest(secret,signed)};};
  const command=cb=>authenticateFirstImageCallback({env,panelMessageId:138,...envelope(cb)});
  const click=async action=>{const cb=await callback(action);return svc.callback(cb,{firstImageCommand:action==='q41_prepare'?null:command(cb)});};
  const prepare=async()=>{await svc.show('1','1',{kind:'menu'});await click('create_v2_ideas');await click('create_v2_budget');await click('q41_prepare');if(supervised)await click('q41_budget');};
  const restart=()=>{adapter=makeAdapter();production.adapters.LUMI_PRODUCTION_PROFILE_V2=adapter;return adapter;};
  return {store,manager,reviewStore,storage,objects,journal,journalRows,calls,sourceCalls,telegramCalls,env,evidence,quote,diag,edit,callback,envelope,command,click,prepare,svc,production,restart,get adapter(){return adapter;},setMode:v=>{mode=v;}};
}

test('DOUBLE_CLICK_IDEMPOTENCY: concurrent confirmation and restarted replay emit once',async()=>{
  const f=await fixture();await f.prepare();const cb=await f.callback('q41_confirm'),command=f.command(cb);
  await Promise.allSettled([f.adapter.firstImageAction({command}),f.adapter.firstImageAction({command})]);
  await f.restart().firstImageAction({command:f.command(cb)});
  assert.equal(f.calls.filter(c=>c.url==='https://api.higgsfield.ai/marketing-studio/image'&&c.method==='POST').length,1);assert.equal(f.journalRows.size,1);
  assert.equal(await f.store.getEpisode(episode),null);assert.equal((await f.store.getEpisode(operation)).metadata.budget_reservations['image:q41'].amount_usd,4.64);
});

test('FORGED_CALLBACK_REJECTION: HMAC, scope, owner, panel and serialized grants cannot emit',async()=>{
  const f=await fixture();await f.prepare();const cb=await f.callback('q41_confirm'),e=f.envelope(cb);
  assert.throws(()=>authenticateFirstImageCallback({env:f.env,...e,signature:'0'.repeat(64)}));
  for(const mutate of [c=>c.from.id=2,c=>c.message.message_id=139,c=>c.message.chat.id=2]){const bad=structuredClone(cb);mutate(bad);assert.throws(()=>f.command(bad));}
  assert.throws(()=>authenticateFirstImageCallback({env:{...f.env,LUMI_RUNTIME_ENV:'production'},...e}));
  await assert.rejects(f.adapter.firstImageAction({command:{...f.command(cb)}}),/HMAC/);
  const tampered={...e.signed,body:Buffer.from(JSON.stringify({...e.body,authorized:true}))};
  assert.throws(()=>authenticateFirstImageCallback({env:f.env,signed:tampered,signature:e.signature}));
  for(const k of ['prompt','image_urls','source_url','model','payload','input','api_key']){
    const signed={...e.signed,body:Buffer.from(JSON.stringify({...e.body,[k]:'CLIENT_INPUT_FORBIDDEN'}))};
    assert.throws(()=>authenticateFirstImageCallback({env:f.env,signed,signature:signRequest(secret,signed)}),/HMAC/);
  }
  await f.edit(s=>{s.tokens[cb.data.slice(3)].proposal_id='other';});
  await assert.rejects(f.adapter.firstImageAction({command:f.command(cb)}),/SCOPE/);assert.equal(f.calls.length,0);
});

test('PAYLOAD_MUTATION_REJECTION: evidence and confirmed binding must remain exact',async()=>{
  for(const kind of ['url','evidence-seal','after-confirmation']){
    const f=await fixture();await f.prepare();const cb=await f.callback('q41_confirm');
    await f.edit(s=>{
      if(kind==='url'){const e={...f.evidence,source_url:sourceUrl+'changed'};s.q41_prepaid_evidence=seal(e);}
      if(kind==='evidence-seal')s.q41_prepaid_evidence.evidence.balance_usd=1;
      if(kind==='after-confirmation')s.q41_prepaid_evidence=seal({...f.evidence,proof_reference:'OTHER_OFFLINE_PROOF'});
    });
    await assert.rejects(f.adapter.firstImageAction({command:f.command(cb)}));assert.equal(f.calls.length,0);assert.equal(await f.store.getEpisode(operation),null);
  }
});

test('RESERVATION_BEFORE_SUBMISSION_CRASH: restart retains reservation and never dispatches',async()=>{
  const f=await fixture({inject:async({point})=>{if(point==='Q41_RESERVED_BEFORE_JOURNAL')throw Error('OFFLINE_CRASH');}});
  await f.prepare();const cb=await f.callback('q41_confirm');await assert.rejects(f.adapter.firstImageAction({command:f.command(cb)}),/CRASH/);
  await f.restart().firstImageAction({command:f.command(cb)});assert.equal(f.calls.length,1);
  const cp=await f.store.getEpisode(operation);assert.equal(cp.metadata.budget_reservations['image:q41'].amount_usd,4.64);assert.equal(cp.metadata.first_image.state,'EMITTING');
  let continued=0;
  const recovered=await f.manager.resume(operation,{continueAction:async()=>{continued++;return {};}});
  assert.equal(continued,0);assert.equal(recovered.status,'Q41_SCOPED_CALLBACK_RECOVERY_REQUIRED');
});

test('SUBMISSION_OUTCOME_UNKNOWN: timeout or malformed JSON consumes the only attempt',async()=>{
  for(const mode of ['timeout','malformed']){const f=await fixture({mode});await f.prepare();await f.click('q41_confirm');
    assert.equal(f.calls.filter(c=>c.url==='https://api.higgsfield.ai/marketing-studio/image'&&c.method==='POST').length,1);await f.restart();await f.click('q41_status');await f.click('q41_status');
    assert.equal(f.calls.length,2);assert.equal((await f.reviewStore.get('1')).state.q41_first_image.blocker,'Q41_EMISSION_OUTCOME_UNKNOWN_NO_RESUBMIT');
  }
});

test('ARTIFACT_RECOVERY: pending original and storage crash recover via GET with one immutable upload',async()=>{
  let crashed=false;const f=await fixture({mode:'pending',inject:async({point})=>{if(point==='Q41:ARTIFACT_PERSISTED_QA_NOT_PERSISTED'&&!crashed){crashed=true;throw Error('OFFLINE_CRASH');}}});
  await f.prepare();await f.click('q41_confirm');f.setMode('complete');await f.click('q41_status');await f.restart();await f.click('q41_status');
  const s=(await f.reviewStore.get('1')).state;assert.equal(s.q41_first_image.artifact.sha256,sha256(image));assert.equal(s.q41_first_image.technical_qa.ok,true);
  assert.equal(s.q41_first_image.visual_qa,'REQUIRES_HUMAN_VISUAL_REVIEW');assert.equal(f.objects.size,3);assert.equal(f.calls.filter(c=>c.url==='https://api.higgsfield.ai/marketing-studio/image'&&c.method==='POST').length,1);
});

test('SAME_ARTIFACT_SHA_BINDING: stale review and corrupted storage cannot approve',async()=>{
  const f=await fixture();await f.prepare();await f.click('q41_confirm');const cb=await f.callback('q41_approve');
  await f.edit(s=>{s.tokens[cb.data.slice(3)].artifact_sha='b'.repeat(64);});
  await assert.rejects(f.adapter.firstImageAction({command:f.command(cb)}),/REVIEW_STALE/);
  await f.edit(s=>{s.tokens[cb.data.slice(3)].artifact_sha=sha256(image);});
  const a=(await f.reviewStore.get('1')).state.q41_first_image.artifact;f.objects.set(a.bucket+'/'+a.path,Buffer.from('corrupt'));
  await assert.rejects(f.adapter.firstImageAction({command:f.command(cb)}),/SHA_MISMATCH/);assert.equal(f.calls.filter(c=>c.url==='https://api.higgsfield.ai/marketing-studio/image'&&c.method==='POST').length,1);
});

test('HUMAN_REVIEW_GATE and NO_AUTOMATIC_KLING: approve/reject are immutable pauses',async()=>{
  for(const action of ['q41_approve','q41_reject']){const f=await fixture();await f.prepare();await f.click('q41_confirm');
    const cb=await f.callback(action),other=await f.callback(action==='q41_approve'?'q41_reject':'q41_approve');
    await f.click(action);await f.adapter.firstImageAction({command:f.command(cb)});
    await assert.rejects(f.adapter.firstImageAction({command:f.command(other)}),/IMMUTABLE/);
    const cp=await f.store.getEpisode(operation);assert.equal(cp.actions.length,1);assert.match(cp.metadata.first_image.state,/_PAUSED$/);
    assert.equal(cp.runner_enabled,false);assert.equal(cp.autorun,false);assert.equal(f.calls.filter(c=>c.url==='https://api.higgsfield.ai/marketing-studio/image'&&c.method==='POST').length,1);
    assert.equal(await f.store.getEpisode(episode),null);
  }
});

test('SINGLE_MESSAGE_TELEGRAM: HOME photo, image, return HOME preserve panel 138 and historical master',async()=>{
  const f=await fixture(),historical=(await f.reviewStore.get('1')).state.episodes.historical;
  await f.prepare();await f.click('q41_confirm');await f.click('q41_approve');await f.click('menu');
  const s=(await f.reviewStore.get('1')).state;assert.equal(s.message_id,138);assert.equal(s.panel_state,'HOME');assert.equal(s.panel_content_type,'photo');
  assert.deepEqual(s.episodes.historical,historical);assert.equal(s.episodes[episode],undefined);
  assert.ok(f.telegramCalls.every(c=>c.method==='editMessageMedia'||c.method==='answerCallbackQuery'));
  assert.ok(f.telegramCalls.filter(c=>c.method==='editMessageMedia').every(c=>c.body.message_id===138));
});

test('budget fail-closed: unverified account, credit, stale quote and insufficient balance never authorize',async()=>{
  for(const change of [{source:'USER_REPORTED'},{api_key_sha256:'wrong'},{auto_recharge:true},{credit_billing:true},
    {negative_balance_allowed:true},{external_funding_locked:false},{balance_usd:0},{balance_usd:5},{checked_at:'2026-01-01T00:00:00Z'}]){
    const f=await fixture();await f.edit(s=>{s.q41_prepaid_evidence=seal({...f.evidence,...change});});await f.prepare();
    const s=(await f.reviewStore.get('1')).state;assert.equal(s.q41_first_image.status,'BLOCKED');assert.equal(s.v2_authorizations,undefined);assert.equal(f.calls.length,0);
  }
});

test('canonical HMAC endpoint rejects forged raw bytes and carries genuine callback capability',async()=>{
  const f=await fixture();await f.prepare();const cb=await f.callback('q41_confirm'),e=f.envelope(cb),routes=new Map();
  mountMakeTransportEndpoint({get:()=>{},post:(path,fn)=>routes.set(path,fn)}, {store:f.reviewStore,env:f.env,loadBytes:async()=>canonical,
    validateOwner:async()=>true,production:f.production});
  const run=async signature=>{let body,status=200;const res={status(n){status=n;return this;},json(v){body=v;return this;}};
    await routes.get(e.signed.path)({body:e.body,rawBody:e.signed.body,path:e.signed.path,headers:{'x-lumi-timestamp':e.signed.timestamp,
      'x-lumi-request-id':e.signed.requestId,'x-lumi-signature':signature}},res);return {body,status};};
  assert.equal((await run('0'.repeat(64))).status,401);assert.equal(f.calls.length,0);
  // Use pending result so the existing cached HOME photo needs no new upload.
  f.setMode('pending');const result=await run(e.signature);assert.equal(result.status,200);assert.equal(f.calls.filter(c=>c.url==='https://api.higgsfield.ai/marketing-studio/image'&&c.method==='POST').length,1);
  assert.equal((await run(e.signature)).status,409);assert.equal(f.calls.filter(c=>c.url==='https://api.higgsfield.ai/marketing-studio/image'&&c.method==='POST').length,1);
});

test('CAS and journal persistence failures occur before the provider boundary',async()=>{
  for(const fault of ['authorization','reservation','journal-prepare','journal-emitting']){
    const f=await fixture();await f.prepare();const cb=await f.callback('q41_confirm');
    if(fault==='authorization'){const cas=f.reviewStore.cas.bind(f.reviewStore);f.reviewStore.cas=async(u,r,s)=>{
      if(s.v2_authorizations?.[operation])throw Error('OFFLINE_STORAGE_FAILURE');return cas(u,r,s);};}
    if(fault==='reservation')f.store.casGenericEpisode=async()=>null;
    if(fault==='journal-prepare')f.journal.prepare=async()=>{throw Error('OFFLINE_STORAGE_FAILURE');};
    if(fault==='journal-emitting')f.journal.transition=async()=>{throw Error('OFFLINE_STORAGE_FAILURE');};
    await f.adapter.firstImageAction({command:f.command(cb)}).catch(()=>null);assert.equal(f.calls.filter(c=>c.url==='https://api.higgsfield.ai/marketing-studio/image').length,0,fault);
  }
});

test('budget records reject missing evidence, expired quote and accumulated exposure above USD 5',async()=>{
  const absent=await fixture();await absent.edit(s=>{delete s.q41_prepaid_evidence;});await absent.prepare();
  assert.equal((await absent.reviewStore.get('1')).state.q41_first_image.blocker,'Q41_VERIFIED_PREPAID_EVIDENCE_REQUIRED');
  const stale=await fixture({estimateMode:'expired'});await stale.prepare();await stale.click('q41_confirm');
  assert.equal((await stale.reviewStore.get('1')).state.q41_first_image.blocker,'Q41_CURRENT_EXACT_PAYLOAD_QUOTE_REQUIRED');
  const f=await fixture();await f.manager.startEpisode({episodeId:operation,actions:[{key:'image:q41',stage:'IMAGE'}],authorizedCeilingUsd:5,
    metadata:{operation_type:scope,runtime_revision:0,first_image:{state:'PREPARED',binding:'fixture'},budget_reservations:{other:{amount_usd:0.2}}}});
  await f.manager.checkpoint(operation,s=>{s.current_cost_usd=0.2;});
  await assert.rejects(f.manager.reserveFirstImage({episodeId:operation,actionKey:'image:q41',amountUsd:4.64,binding:'fixture'}),/BUDGET/);
  assert.equal(f.calls.length,0);
});

test('JIT quote follows delivered human confirmation; historical quote remains immutable',async()=>{
  const f=await fixture({estimateUsd:0.312}),historical=await f.store.getEpisode(f.diag);
  historical.metadata.isolated_validation.q41_quote_attempt.result.quote_timestamp='2026-01-01T00:00:00Z';
  historical.metadata.isolated_validation.q41_quote_attempt.result.payload_sha256='0'.repeat(64);
  await f.store.putEpisode(historical);await f.prepare();
  assert.equal(f.calls.length,0);assert.equal(f.sourceCalls.length,0);assert.equal(await f.store.getEpisode(operation),null);
  await f.click('q41_confirm');
  const cp=await f.store.getEpisode(operation),fstate=cp.metadata.first_image;
  assert.deepEqual(await f.store.getEpisode(f.diag),historical);
  assert.equal(f.calls.filter(c=>c.url.includes('/estimate/')).length,1);assert.equal(f.sourceCalls.length,1);
  assert.deepEqual(Buffer.from(f.calls[1].body),Buffer.from(f.calls[0].body));
  assert.equal(sha256(f.calls[0].body),fstate.quote.payload_sha256);
  assert.equal(fstate.estimated_cost_usd,0.312);assert.equal(fstate.reserve_usd,4.64);assert.equal(fstate.actual_cost_usd,null);
  assert.equal(fstate.authorization.status,'AUTHORIZED');assert.equal(fstate.authorization.request_sha,fstate.binding);
  assert.equal(fstate.authorization.confirmation_sha,fstate.confirmation_binding);
  assert.ok(Date.parse(fstate.quote_valid_until)<=Date.parse(fstate.quote.quote_timestamp)+60000);
  assert.equal(cp.metadata.budget_reservations['image:q41'].amount_usd,4.64);
  assert.equal(JSON.stringify(cp).includes('token=OFFLINE'),false);
});

test('JIT estimate errors, missing USD, expiry and unaffordable estimate block without retries',async()=>{
  for(const options of [{estimateMode:'timeout'},{estimateMode:'malformed'},{estimateMode:'non-usd'},
    {estimateMode:'http-error'},{estimateMode:'expired'},{estimateUsd:4.65}]){
    const f=await fixture(options);await f.prepare();const cb=await f.callback('q41_confirm');await f.click('q41_confirm');
    await f.restart().firstImageAction({command:f.command(cb)});await f.click('q41_status');
    assert.equal(f.calls.length,1);assert.ok(f.calls[0].url.includes('/estimate/'));assert.equal(f.journalRows.size,0);
    const cp=await f.store.getEpisode(operation);assert.equal(cp.metadata.first_image.state,'PREFLIGHT_BLOCKED');
    assert.equal(cp.metadata.budget_reservations,undefined);assert.equal(cp.metadata.first_image.actual_cost_usd,null);
    assert.equal((await f.reviewStore.get('1')).state.v2_authorizations[operation].status,'PREFLIGHT_CLAIMED');
  }
});

test('JIT crash at confirmation, estimate intent or response cannot requote or submit on restart',async()=>{
  for(const crash of ['Q41_CONFIRMATION_CLAIMED_BEFORE_CHECKPOINT','Q41_ESTIMATE_INTENT_PERSISTED','Q41_ESTIMATE_RETURNED_BEFORE_PERSISTENCE']){
    const f=await fixture({inject:async({point})=>{if(point===crash)throw Error('OFFLINE_CRASH');}});
    await f.prepare();const cb=await f.callback('q41_confirm');await f.adapter.firstImageAction({command:f.command(cb)}).catch(()=>null);
    const calls=f.calls.length;await f.restart().firstImageAction({command:f.command(cb)}).catch(()=>null);
    assert.equal(f.calls.length,calls);assert.equal(calls,crash==='Q41_ESTIMATE_RETURNED_BEFORE_PERSISTENCE'?1:0);
    assert.equal(f.journalRows.size,0);
    const view=await f.adapter.firstImageStatus({user:'1'});assert.notEqual(view.status,'AWAITING_CONFIRMATION');
  }
});

test('JIT final boundary rejects quote, evidence and authorization expiry after reservation',async()=>{
  for(const mutation of ['quote','evidence','expiry','reservation','api-key','accumulated','grant']){
    let f;f=await fixture({inject:async({point})=>{if(point!=='Q41_RESERVED_BEFORE_JOURNAL')return;
      if(mutation==='api-key')f.env.HF_API_KEY='OTHER_OFFLINE_KEY';
      else if(mutation==='grant')await f.edit(s=>{s.v2_authorizations[operation].status='REVOKED';});
      else if(mutation==='evidence'||mutation==='expiry')await f.edit(s=>{s.q41_prepaid_evidence=seal({...f.evidence,
        ...(mutation==='expiry'?{expires_at:'2026-01-01T00:00:00Z'}:{account_id:'OTHER_ACCOUNT'})});});
      else await f.manager.checkpoint(operation,s=>{
        if(mutation==='quote')s.metadata.first_image.quote.payload_sha256='a'.repeat(64);
        else if(mutation==='accumulated')s.current_cost_usd=0.5;
        else s.metadata.budget_reservations['image:q41'].amount_usd=0.271;
      });
    }});await f.prepare();await f.click('q41_confirm');
    assert.equal(f.calls.length,1);assert.ok(f.calls[0].url.includes('/estimate/'));
    assert.equal(f.journalRows.get(operation).state,'EMISSION_UNKNOWN');
    await f.restart();await f.click('q41_status');assert.equal(f.calls.length,1);
  }
});

test('JIT canonical bytes and signed source must be verified before estimator',async()=>{
  for(const patch of [{url:'https://attacker.test/source.png'},{sha256:'bad'},
    {expires_at:'2026-01-01T00:00:00Z'},{expires_at:new Date(Date.now()+600000).toISOString()}]){
    const f=await fixture({transportPatch:patch});await f.prepare();await f.click('q41_confirm');
    assert.equal(f.calls.length,0);assert.equal(f.journalRows.size,0);
  }
  const f=await fixture();await f.prepare();f.objects.set(d.canonical_artifact.bucket+'/'+d.canonical_artifact.path,Buffer.from('corrupt'));
  await f.click('q41_confirm');assert.equal(f.calls.length,0);assert.equal(f.sourceCalls.length,0);
  assert.equal((await f.reviewStore.get('1')).state.q41_first_image.blocker,'Q41_CANONICAL_SHA_REQUIRED');
});

test('Billing proof is bound to sealed review, retained bytes and a maximum sixty-second window',async()=>{
  for(const change of [{verification_method:'USER_REPORTED'},{billing_origin:'https://higgsfield.ai'},
    {reviewed_by:null},{proof_reference:'not-the-proof-sha'},{proof_artifact:null},
    {expires_at:new Date(Date.now()+300000).toISOString()}]){
    const f=await fixture();await f.edit(s=>{s.q41_prepaid_evidence=seal({...f.evidence,...change});});await f.prepare();
    assert.equal((await f.reviewStore.get('1')).state.q41_first_image.status,'BLOCKED');assert.equal(f.calls.length,0);
  }
  const f=await fixture();f.objects.set(f.evidence.proof_artifact.bucket+'/'+f.evidence.proof_artifact.path,Buffer.from('forged'));
  await f.prepare();assert.equal((await f.reviewStore.get('1')).state.q41_first_image.blocker,'Q41_BILLING_PROOF_SHA_MISMATCH');
  assert.equal(f.calls.length,0);
});

test('Orphan journal prevents any quote or new authorization; insufficient fresh balance cannot emit',async()=>{
  const f=await fixture();f.journalRows.set(operation,{state:'EMISSION_UNKNOWN'});await f.prepare();
  assert.equal((await f.reviewStore.get('1')).state.q41_first_image.blocker,'Q41_PRIOR_EMISSION_NO_RESUBMIT');assert.equal(f.calls.length,0);
  const low=await fixture();await low.edit(s=>{s.q41_prepaid_evidence=seal({...low.evidence,balance_usd:0.2});});
  await low.prepare();await low.click('q41_confirm');assert.equal(low.calls.length,1);assert.equal(low.journalRows.size,0);
  assert.equal((await low.reviewStore.get('1')).state.q41_first_image.blocker,'Q41_INSUFFICIENT_PREPAID_BALANCE');
});

test('human review cannot turn an undersized original into a technically approved 2K source',async()=>{
  const f=await fixture({imageBytes:canonical});await f.prepare();await f.click('q41_confirm');
  const s=(await f.reviewStore.get('1')).state;assert.equal(s.q41_first_image.technical_qa.ok,false);
  assert.equal(s.q41_first_image.blocker,'Q41_IMAGE_TECHNICAL_QA_FAILED');
  const active=s.delivery.tokens.map(t=>s.tokens[t]);assert.equal(active.some(t=>t.action==='q41_approve'),false);
  await f.click('q41_reject');assert.equal(f.calls.filter(c=>c.url==='https://api.higgsfield.ai/marketing-studio/image'&&c.method==='POST').length,1);
});

// All balances, denials and cost receipts below are OFFLINE fixtures only.
test('supervised policy requires delivered consent and keeps Billing unverified',async()=>{
  const f=await fixture({supervised:true});
  await f.svc.show('1','1',{kind:'menu'});await f.click('create_v2_ideas');await f.click('create_v2_budget');await f.click('q41_prepare');
  assert.equal(f.calls.length,0);
  assert.equal((await f.reviewStore.get('1')).state.q41_first_image.status,'BLOCKED');
  await f.click('q41_budget');assert.equal(f.calls.length,0);
  const policy=(await f.reviewStore.get('1')).state.q41_supervised_policy.policy;
  assert.equal(policy.billing_verified,false);assert.equal(policy.provider_charge_guaranteed,false);assert.equal(policy.hard_episode_budget_usd,5);
  await f.click('q41_confirm');const cp=await f.store.getEpisode(operation);
  assert.equal(cp.metadata.first_image.estimated_cost_usd,0.271);assert.equal(cp.metadata.first_image.reserve_usd,0.33875);
  assert.equal(cp.metadata.first_image.actual_cost_usd,null);assert.equal(cp.current_cost_usd,0);
  assert.equal(cp.metadata.balance_revalidation.provider_balance_usd,null);
  assert.equal((await f.reviewStore.get('1')).state.q41_prepaid_evidence,undefined);
});

test('insufficient balance pauses once with durable evidence and contextual SALDO RECARGADO',async()=>{
  const f=await fixture({supervised:true,mode:'insufficient'});await f.prepare();await f.click('q41_confirm');
  const cp=await f.store.getEpisode(operation),p=cp.metadata.balance_pause;
  assert.equal(cp.status,'PAUSED_INSUFFICIENT_BALANCE');assert.equal(p.episode_id,episode);assert.equal(p.stage,'IMAGE');
  assert.equal(p.provider_request_id,'billing-denial');assert.equal(p.error_code,'insufficient_balance');assert.equal(p.checkpoint,null);
  assert.equal(p.last_known_cost.actual_usd,null);assert.equal(p.last_known_cost.reserved_usd,0.33875);
  assert.equal(cp.first_pending_action,'image:q41');assert.equal(f.calls.length,2);
  const s=(await f.reviewStore.get('1')).state;
  assert.ok(s.delivery.tokens.some(t=>s.tokens[t].action==='q41_refill'));
  assert.ok(f.telegramCalls.some(c=>JSON.stringify(c).includes('SALDO RECARGADO')));
  assert.equal(await f.store.getEpisode(episode),null);
});

test('refill revalidates then resumes only first pending action, preserving history and reservations',async()=>{
  const f=await fixture({supervised:true,mode:'insufficient'});await f.prepare();await f.click('q41_confirm');
  const original=await f.journal.get(operation),historical=(await f.reviewStore.get('1')).state.episodes.historical;
  f.setMode('complete');await f.click('q41_refill');
  const cp=await f.store.getEpisode(operation);
  assert.equal(cp.metadata.first_image.state,'HUMAN_REVIEW_REQUIRED');assert.equal(cp.actions.length,1);
  assert.deepEqual(await f.journal.get(operation),original);assert.equal(f.journalRows.size,2);
  assert.equal(cp.metadata.budget_reservations['rejected:'+operation].amount_usd,0.33875);
  assert.equal(cp.metadata.budget_reservations['image:q41'].amount_usd,0.33875);assert.equal(cp.authorized_ceiling_usd,5);
  assert.equal(cp.metadata.balance_revalidation.continuation_basis,'EXPLICIT_SUPERVISED_AUTHORIZATION');
  await f.click('q41_approve');await f.click('menu');
  assert.deepEqual((await f.reviewStore.get('1')).state.episodes.historical,historical);
  assert.ok(f.telegramCalls.every(c=>c.method==='answerCallbackQuery'||c.method==='editMessageMedia'&&c.body.message_id===138));
  assert.equal(f.calls.filter(c=>c.method==='POST'&&!c.url.includes('/estimate/')).length,2);
});

test('refill double click, fresh nonce replay and restart never duplicate the successor',async()=>{
  const f=await fixture({supervised:true,mode:'insufficient'});await f.prepare();await f.click('q41_confirm');
  const cb=await f.callback('q41_refill');f.setMode('pending');
  await Promise.allSettled([f.adapter.firstImageAction({command:f.command(cb)}),f.adapter.firstImageAction({command:f.command(cb)})]);
  await f.restart().firstImageAction({command:f.command(cb)});
  assert.equal(f.journalRows.size,2);assert.equal(f.calls.filter(c=>c.method==='POST'&&!c.url.includes('/estimate/')).length,2);
});

test('generic errors and ambiguous provider requests never enable balance recovery',async()=>{
  for(const mode of ['timeout','malformed','generic-402','accepted-error','queued-error']){
    const f=await fixture({supervised:true,mode});await f.prepare();await f.click('q41_confirm');
    const s=(await f.reviewStore.get('1')).state;
    assert.ok(s.delivery.tokens.every(t=>s.tokens[t].action!=='q41_refill'),mode);
    const cb=await f.callback('q41_status');await f.edit(s=>{s.tokens[cb.data.slice(3)].action='q41_refill';s.tokens[cb.data.slice(3)].attempt_id=operation;});
    await assert.rejects(f.adapter.firstImageAction({command:f.command(cb)}),/CONFIRMED_BALANCE/);
    assert.equal(f.calls.length,2);
  }
});

test('refill verifies owner, HMAC, active delivered token and approved policy seal',async()=>{
  const f=await fixture({supervised:true,mode:'insufficient'});await f.prepare();await f.click('q41_confirm');
  const cb=await f.callback('q41_refill'),signed=f.envelope(cb);
  assert.throws(()=>authenticateFirstImageCallback({env:f.env,...signed,signature:'0'.repeat(64)}));
  await assert.rejects(f.adapter.firstImageAction({command:{...f.command(cb)}}),/HMAC/);
  await f.edit(s=>{s.q41_supervised_policy.policy.hard_episode_budget_usd=6;});
  await assert.rejects(f.adapter.firstImageAction({command:f.command(cb)}),/POLICY_INVALID/);assert.equal(f.calls.length,2);
});

test('an official same-credential balance is queried; low balance keeps pause; top-up never raises cap',async()=>{
  let balance=1,reads=0;
  const f=await fixture({supervised:true,mode:'insufficient',readProviderBalance:async()=>{reads++;return {
    source:'OFFICIAL_API',currency:'USD',api_key_sha256:sha256('OFFLINE_KEY'),account_id:'offline-account',balance_usd:balance,checked_at:new Date().toISOString()};}});
  await f.prepare();await f.click('q41_confirm');balance=0;await f.click('q41_refill');
  assert.equal(f.calls.length,2);assert.equal((await f.store.getEpisode(operation)).status,'PAUSED_INSUFFICIENT_BALANCE');
  balance=50;f.setMode('pending');await f.click('q41_refill');
  assert.equal(reads,3);assert.equal((await f.store.getEpisode(operation)).authorized_ceiling_usd,5);
  assert.equal((await f.store.getEpisode(operation)).metadata.balance_revalidation.provider_balance_usd,50);
});

test('exhausted episode budget remains paused after top-up and does not renew quote',async()=>{
  const f=await fixture({supervised:true,mode:'insufficient'});await f.prepare();await f.click('q41_confirm');
  await f.manager.checkpoint(operation,s=>{s.current_cost_usd=4.5;});
  await f.click('q41_refill');const cp=await f.store.getEpisode(operation);
  assert.equal(cp.metadata.first_image.state,'PAUSED_BUDGET_EXHAUSTED');assert.equal(cp.authorized_ceiling_usd,5);assert.equal(f.calls.length,2);
  const s=(await f.reviewStore.get('1')).state;assert.ok(s.delivery.tokens.every(t=>s.tokens[t].action!=='q41_refill'));
});

test('crash after durable rejection before checkpoint restores pause without another submission',async()=>{
  const f=await fixture({supervised:true,mode:'insufficient',inject:async({point})=>{if(point==='Q41_BALANCE_REJECTION_BEFORE_CHECKPOINT')throw Error('CRASH');}});
  await f.prepare();await f.click('q41_confirm');await f.restart().firstImageStatus({user:'1'});
  assert.equal((await f.store.getEpisode(operation)).status,'PAUSED_INSUFFICIENT_BALANCE');assert.equal(f.calls.length,2);
});

test('crash after refill consent does not recreate the consumed authorization',async()=>{
  let crash=false;
  const f=await fixture({supervised:true,mode:'insufficient',inject:async({point})=>{if(crash&&point==='Q41_CONFIRMATION_CLAIMED_BEFORE_CHECKPOINT')throw Error('CRASH');}});
  await f.prepare();await f.click('q41_confirm');const cb=await f.callback('q41_refill');crash=true;
  await assert.rejects(f.adapter.firstImageAction({command:f.command(cb)}),/CRASH/);
  await assert.rejects(f.restart().firstImageAction({command:f.command(cb)}));assert.equal(f.calls.length,2);
});

test('verified actual USD cost reconciles once; overrun pauses and cannot be hidden by recarga',async()=>{
  for(const actualCostUsd of [0.30,5.5]){
    const f=await fixture({supervised:true,actualCostUsd});await f.prepare();await f.click('q41_confirm');await f.manager.reconcileRequestCost({episodeId:operation,actionKey:'image:q41',attemptId:operation,providerRequestId:'offline-job',actualCostUsd});
    const cp=await f.store.getEpisode(operation);assert.equal(cp.current_cost_usd,actualCostUsd);
    assert.equal(cp.metadata.first_image.actual_cost_usd,actualCostUsd);assert.deepEqual(cp.metadata.budget_reservations,{});
    if(actualCostUsd>5){assert.equal(cp.metadata.budget_exhausted,true);assert.equal(cp.status,'PAUSED_INCIDENT');}
    assert.equal(f.calls.filter(c=>c.method==='POST'&&!c.url.includes('/estimate/')).length,1);
  }
});

test('approved q41 exposes explicit continuation but never creates an episode or launches Kling',async()=>{
 const f=await fixture({supervised:true});await f.prepare();await f.click('q41_confirm');await f.click('q41_approve');
 const count=f.calls.length;await f.click('q41_continue');
 assert.equal(f.calls.length,count);assert.equal(await f.store.getEpisode(episode),null);
 assert.equal((await f.reviewStore.get('1')).state.q41_first_image.blocker,'Q41_EPISODE_CONTINUATION_NOT_AUTHORIZED');
 assert.equal((await f.store.getEpisode(operation)).metadata.first_image.review.status,'APPROVED');
});

test('unofficial or malformed balance responses cannot be promoted into verified USD',async()=>{
 for(const balance of [{source:'USER_REPORTED',balance_usd:4.60},{source:'OFFICIAL_API',currency:'credits',balance_usd:10},
   {source:'OFFICIAL_API',currency:'USD',balance_usd:-1}]){
  const f=await fixture({supervised:true,readProviderBalance:async()=>balance});await f.prepare();
  await f.click('q41_confirm');assert.equal(f.calls.length,0);assert.equal(await f.store.getEpisode(operation),null);
 }
});
