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
import {renderTelegramPanel} from '../lib/telegram-review-v1/core.js';
import {ReviewStageReceiptStore} from '../lib/lumi-v2-execution-orchestrator.js';
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

test('q41 continuation only opens a checkpoint that already incorporates the exact approved source',async()=>{
 for(const binding of ['matching','wrong-sha','wrong-request']){
  const f=await fixture({supervised:true});await f.prepare();await f.click('q41_confirm');await f.click('q41_approve');
  const image=(await f.store.getEpisode(operation)).metadata.first_image;
  const incorporated={episode_id:episode,status:'PAUSED_HUMAN_REVIEW',first_pending_action:'video:q41',authorized_ceiling_usd:5,
   metadata:{user:'1',stage_results:{'image:q41':{result:{artifacts:[{...image.artifact,sha256:binding==='wrong-sha'?'0'.repeat(64):image.artifact.sha256}],
    provider_job_ids:[binding==='wrong-request'?'unrelated-request':image.accepted.request_id]}}}}};
  await f.store.putEpisode(incorporated);await f.edit(s=>{s.episodes[episode]={episode_id:episode};});
  const count=f.calls.length,journal=JSON.stringify([...f.journalRows]),before=await f.store.getEpisode(episode);
  const result=await f.adapter.firstImageAction({command:f.command(await f.callback('q41_continue'))});
  if(binding==='matching')assert.deepEqual(result.next_screen,{kind:'progress',episode_id:episode});
  else {assert.equal(result.next_screen,undefined);assert.equal(result.blocker,'Q41_EPISODE_CONTINUATION_NOT_AUTHORIZED');}
  assert.deepEqual(await f.store.getEpisode(episode),before);assert.equal(f.calls.length,count);
  assert.equal(JSON.stringify([...f.journalRows]),journal);
  assert.equal((await f.store.getEpisode(operation)).metadata.first_image.review.status,'APPROVED');
 }
});

test('unofficial or malformed balance responses cannot be promoted into verified USD',async()=>{
 for(const balance of [{source:'USER_REPORTED',balance_usd:4.60},{source:'OFFICIAL_API',currency:'credits',balance_usd:10},
   {source:'OFFICIAL_API',currency:'USD',balance_usd:-1}]){
  const f=await fixture({supervised:true,readProviderBalance:async()=>balance});await f.prepare();
  await f.click('q41_confirm');assert.equal(f.calls.length,0);assert.equal(await f.store.getEpisode(operation),null);
 }
});

// Import acceptance uses the existing isolated image fixture only in tests.
// Production descriptors are read from episodes/ and no test path is reachable.
const {authenticateEp004Import,EP004_IMPORT_OP,EP004_IMPORT_AUTH}=await import('../lib/lumi-v2-activation-context.js');
const {acceptEpisodeGeneration}=await import('../lib/av2/creative-engine.js');
const importCommand=(f,patch={})=>{
 const body={op:EP004_IMPORT_OP,user_id:'1',chat_id:'1',authorization_reference:EP004_IMPORT_AUTH,provider_generation:false,...patch};
 const signed={method:'POST',path:'/lumi/telegram-review/make/v1',timestamp:String(Math.floor(Date.now()/1000)),requestId:'import-'+crypto.randomUUID(),body:Buffer.from(JSON.stringify(body))};
 return authenticateEp004Import({env:f.env,signed,signature:signRequest(secret,signed)});
};
async function approvedImportFixture(options={}){
 const f=await fixture({supervised:true,...options});await f.prepare();await f.click('q41_confirm');await f.click('q41_approve');return f;
}
test('EP004 real AV2 contract, approved import, budget reference and duplicate recovery never emit',async()=>{
 const f=await approvedImportFixture(),calls=f.calls.length,journal=structuredClone([...f.journalRows]);
 const source=await f.store.getEpisode(operation),history=(await f.reviewStore.get('1')).state.episodes.historical;
 const result=await f.adapter.createEp004FromApprovedQ41({command:importCommand(f)});assert.equal(result.status,'EP004_CREATED_Q41_IMPORTED');
 const cp=await f.store.getEpisode(episode),e=(await f.reviewStore.get('1')).state.episodes[episode];
 assert.equal(cp.first_pending_action,'planning');assert.equal(cp.metadata.generic_v2.shot_plans.length,7);
 assert.equal(acceptEpisodeGeneration(cp.metadata.generic_v2.plan).episode_sha256,cp.metadata.generic_v2.plan_sha);
 assert.equal(cp.metadata.generic_v2.plan.scenes[4].audio.pauses[0].duration_seconds,2.5);
 assert.equal(cp.actions.find(a=>a.key==='image:q41').status,'COMPLETE');assert.equal(e.q41_import.artifact_sha,source.metadata.first_image.artifact.sha256);
 assert.deepEqual(Object.values(e.review_requests)[0].human_decision,source.metadata.first_image.review);
 assert.equal(cp.metadata.budget_reservations?.['image:q41'],undefined);assert.equal(e.q41_import.actual_usd,null);
 const gate=await f.manager.budgetGate({episodeId:episode,actionKey:'planning',projectedCallCostUsd:0});
 assert.equal(gate.status,'PASS');assert.equal(gate.required_total_usd,0.33875);
 assert.equal(cp.metadata.activation_context.provider_generation,false);assert.equal(cp.runner_enabled,false);assert.equal(cp.autorun,false);
 const again=await f.restart().createEp004FromApprovedQ41({command:importCommand(f)});assert.equal(again.already_applied,true);
 assert.equal((await f.store.getEpisode(episode)).metadata.runtime_revision,cp.metadata.runtime_revision);
 assert.deepEqual(await f.store.getEpisode(operation),source);assert.deepEqual([...f.journalRows],journal);assert.equal(f.calls.length,calls);
 assert.deepEqual((await f.reviewStore.get('1')).state.episodes.historical,history);
 const edits=f.telegramCalls.filter(c=>c.method==='editMessageMedia').length;await f.click('q41_continue');assert.equal(f.telegramCalls.filter(c=>c.method==='editMessageMedia').length,edits+1);
 assert.match(f.telegramCalls.at(-1).body.media.caption,/Episodio 004 creado/);assert.equal(f.telegramCalls.at(-1).body.message_id,138);
});
test('EP004 import concurrent requests and both crash boundaries recover one checkpoint and one approval',async()=>{
 for(const point of ['EP004_AFTER_CREATE','EP004_AFTER_IMPORT','CONCURRENT']){
  let crash=true;const f=await approvedImportFixture({inject:async p=>{if(crash&&p.point===point){crash=false;throw Error('IMPORT_CRASH');}}});
  const calls=f.calls.length;
  if(point==='CONCURRENT'){
   const results=await Promise.allSettled([1,2].map(()=>f.adapter.createEp004FromApprovedQ41({command:importCommand(f)})));
   assert.ok(results.some(r=>r.status==='fulfilled'));
  }else await assert.rejects(f.adapter.createEp004FromApprovedQ41({command:importCommand(f)}),/IMPORT_CRASH/);
  await f.restart().createEp004FromApprovedQ41({command:importCommand(f)});
  const cp=await f.store.getEpisode(episode);assert.equal(Object.keys(cp.metadata.imported_stage_sources).length,1);
  assert.equal(Object.keys(cp.metadata.review_requests).length,1);assert.equal(f.journalRows.size,1);assert.equal(f.calls.length,calls);
  assert.equal((await f.manager.budgetGate({episodeId:episode,actionKey:'planning',projectedCallCostUsd:0})).required_total_usd,.33875);
 }
});
test('EP004 import rejects arbitrary inputs, serialized capabilities, missing ACK, altered bytes, review and journal',async()=>{
 for(const defect of ['client-source','provider-generation','serialized','ack','bytes','review','journal']){
  const f=await approvedImportFixture(),calls=f.calls.length;
  if(defect==='client-source'){assert.throws(()=>importCommand(f,{message_id:148}),/AUTH_REQUIRED/);continue;}
  if(defect==='provider-generation'){assert.throws(()=>importCommand(f,{provider_generation:true}),/AUTH_REQUIRED/);continue;}
  let c=importCommand(f);
  if(defect==='serialized')c=structuredClone(c);
  if(defect==='ack')await f.edit(s=>{s.delivery.status='EMITTING';});
  if(defect==='bytes'){const a=(await f.store.getEpisode(operation)).metadata.first_image.artifact;f.objects.set(a.bucket+'/'+a.path,Buffer.from('corrupt'));}
  if(defect==='review')await f.manager.checkpoint(operation,s=>{s.metadata.first_image.review.status='REJECTED';});
  if(defect==='journal')f.journalRows.get(operation).state='EMISSION_UNKNOWN';
  await assert.rejects(f.adapter.createEp004FromApprovedQ41({command:c}),/REQUIRED|MISMATCH/);
  assert.equal(await f.store.getEpisode(episode),null);assert.equal(f.calls.length,calls);
 }
});
test('EP004 local continuation skips imported IMAGE and paid action is blocked before quote or dispatch',async()=>{
 const f=await approvedImportFixture();await f.adapter.createEp004FromApprovedQ41({command:importCommand(f)});const calls=f.calls.length;
 for(const expectedAction of ['planning','source-planning'])await f.adapter.resume({user:'1',episodeId:episode,expectedAction});
 let cp=await f.store.getEpisode(episode);assert.equal(cp.first_pending_action,'source_qa:q41');
 // Missing detailed source QA must not be invented from the broad human approval.
 const waiting=await f.adapter.resume({user:'1',episodeId:episode,expectedAction:cp.first_pending_action});
 assert.equal(waiting.status,'SOURCE_REVIEW_REQUIRED');assert.equal((await f.reviewStore.get('1')).state.episodes[episode].resume_available,false);
 await f.manager.checkpoint(episode,d=>{for(const a of d.actions){if(a.key==='video:q41')break;a.status='COMPLETE';a.evidence={provider_succeeded:true,artifact_persisted:true,sha_verified:true,artifact_verified:true};}});
 const blocked=await f.adapter.resume({user:'1',episodeId:episode,expectedAction:'video:q41'});
 assert.equal(blocked.status,'SPECIFIC_PROVIDER_AUTHORIZATION_REQUIRED');assert.equal(f.calls.length,calls);
});

test('EP004 canonical endpoint requires HMAC, consumes nonce once and returns no Telegram commands',async()=>{
 const f=await approvedImportFixture(),routes=new Map(),calls=f.calls.length,edits=f.telegramCalls.length;
 mountMakeTransportEndpoint({get:()=>{},post:(path,fn)=>routes.set(path,fn)}, {store:f.reviewStore,env:f.env,loadBytes:async()=>canonical,validateOwner:async()=>true,production:f.production});
 const body={op:EP004_IMPORT_OP,user_id:'1',chat_id:'1',authorization_reference:EP004_IMPORT_AUTH,provider_generation:false};
 const signed={timestamp:String(Math.floor(Date.now()/1000)),requestId:'ep004-http-'+crypto.randomUUID(),method:'POST',path:'/lumi/telegram-review/make/v1',body:Buffer.from(JSON.stringify(body))};
 const run=async signature=>{let value,status=200;const res={status(n){status=n;return this;},json(v){value=v;return this;}};
  await routes.get(signed.path)({body,rawBody:signed.body,path:signed.path,headers:{'x-lumi-timestamp':signed.timestamp,'x-lumi-request-id':signed.requestId,'x-lumi-signature':signature}},res);return {value,status};};
 assert.equal((await run('0'.repeat(64))).status,401);assert.equal(await f.store.getEpisode(episode),null);
 const accepted=await run(signRequest(secret,signed));assert.equal(accepted.status,200);assert.equal(accepted.value.status,'EP004_CREATED_Q41_IMPORTED');assert.deepEqual(accepted.value.actions,[]);
 assert.equal((await run(signRequest(secret,signed))).status,409);assert.equal(f.calls.length,calls);assert.equal(f.telegramCalls.length,edits);
});
test('imported journal binding rejects a cross-episode or altered request before source QA',async()=>{
 for(const defect of ['episode','request','review']){
  const f=await approvedImportFixture();await f.adapter.createEp004FromApprovedQ41({command:importCommand(f)});
  for(const expectedAction of ['planning','source-planning'])await f.adapter.resume({user:'1',episodeId:episode,expectedAction});
  if(defect==='episode')f.journalRows.get(operation).episode_id='unrelated';
  if(defect==='request')f.journalRows.get(operation).provider_request_id='unrelated';
  if(defect==='review')await f.manager.checkpoint(operation,d=>{d.metadata.first_image.review.status='REJECTED';});
  const {createV2InputMaterializer,checkpointIdentity}=await import('../lib/lumi-v2-input-materializer.js');
  const {PROFILE_SHA,LUMI_PRODUCTION_PROFILE_V2}=await import('../lib/lumi-production-profile-v2.js');
  const state=await f.store.getEpisode(episode),materialize=createV2InputMaterializer({store:f.store,storage:f.storage,reviewStore:f.reviewStore,journal:f.journal});
  await assert.rejects(materialize({episode_id:episode,stage_id:'SOURCE_QA',checkpoint_id:checkpointIdentity(state),profile_version:LUMI_PRODUCTION_PROFILE_V2.version,
   execution_context:{user:'1',profile_sha:PROFILE_SHA,action_key:'source_qa:q41'}}),/PROVIDER_JOURNAL_MISMATCH/);
 }
});

test('Make-native /produccion opens imported EP004 on the current panel with one edit and no production execution',async()=>{
 const f=await approvedImportFixture();await f.adapter.createEp004FromApprovedQ41({command:importCommand(f)});
 const routes=new Map(),calls=f.calls.length,cp=await f.store.getEpisode(episode);
 mountMakeTransportEndpoint({get:()=>{},post:(path,fn)=>routes.set(path,fn)}, {store:f.reviewStore,env:f.env,loadBytes:async()=>canonical,validateOwner:async()=>true,production:f.production});
 const body={update_id:-2026101411,message:{from:{id:1},chat:{id:1},text:'/produccion',date:new Date().toISOString()}};
 const signed={timestamp:String(Math.floor(Date.now()/1000)),requestId:'ep004-progress-'+crypto.randomUUID(),method:'POST',path:'/lumi/telegram-review/make/v1',body:Buffer.from(JSON.stringify(body))};
 let result,status=200;const res={status(n){status=n;return this;},json(v){result=v;return this;}};
 await routes.get(signed.path)({body,rawBody:signed.body,path:signed.path,headers:{'x-lumi-timestamp':signed.timestamp,'x-lumi-request-id':signed.requestId,'x-lumi-signature':signRequest(secret,signed)}},res);
 assert.equal(status,200);assert.equal(result.actions.length,1);assert.equal(result.actions[0].method,'editMessageMedia');
 const telegram=JSON.parse(result.actions[0].body_json);assert.equal(telegram.message_id,138);assert.match(telegram.media.caption,/Episodio 004 creado/);
 assert.ok(telegram.reply_markup.inline_keyboard.flat().some(b=>b.text==='▶️ Continuar producción'));
 assert.equal(f.calls.length,calls);assert.deepEqual(await f.store.getEpisode(episode),cp);
});

const sourceProof=JSON.parse(await readFile(new URL('../episodes/ep_lumi_granja_004_20261008_ee7ab4b3/q41-source-qa.json',import.meta.url)));
const {sourceQaRecord}=await import('../lib/lumi-v2-input-materializer.js');
const {evaluateTopology}=await import('../lib/cinematic-director-v1/topology.js');
test('inspected source evidence is exact-byte, exact-episode and approval bound, not a general QA waiver',()=>{
 const artifact={artifact_id:'original',sha256:sourceProof.sha256,size:sourceProof.size,width:sourceProof.width,height:sourceProof.height,mime:'image/png'};
 const state={episode_id:episode,metadata:{imported_stage_sources:{'image:q41':{artifact_id:'original',artifact_sha:artifact.sha256,
  provider_request_id:sourceProof.provider_request_id,human_review:{status:'APPROVED',artifact_sha:artifact.sha256}}}}};
 const r=sourceQaRecord(state,'q41',artifact);assert.equal(r.ledger.result.source_observations.scope,'STATIC_VISIBLE_SOURCE_ONLY');
 assert.equal(evaluateTopology({stage:'SOURCE_PREFLIGHT',sha256:artifact.sha256,review:r.ledger.result.topology_review}).status,'PASS');
 assert.notEqual(evaluateTopology({stage:'SAMPLED_FRAME_TEMPORAL_QA',sha256:artifact.sha256,review:r.ledger.result.topology_review}).status,'PASS');
 for(const patch of [{sha256:'0'.repeat(64)},{size:1},{width:1},{height:1},{mime:'image/jpeg'}])assert.equal(sourceQaRecord(state,'q41',{...artifact,...patch}),null);
 assert.equal(sourceQaRecord({...state,episode_id:'other'},'q41',artifact),null);assert.equal(sourceQaRecord(state,'q42',artifact),null);
 state.metadata.imported_stage_sources['image:q41'].human_review.status='REJECTED';assert.equal(sourceQaRecord(state,'q41',artifact),null);
});
async function sourceQaFixture(options={}){
 const f=await approvedImportFixture(options);await f.adapter.createEp004FromApprovedQ41({command:importCommand(f)});
 for(const expectedAction of ['planning','source-planning'])await f.adapter.resume({user:'1',episodeId:episode,expectedAction});
 const cp=await f.store.getEpisode(episode),artifact=cp.metadata.artifacts[cp.metadata.imported_stage_sources['image:q41'].artifact_id];
 // Policy/transport fixture only: this is not perceptual evidence for this flat raster.
 const ledger=structuredClone(sourceProof.ledger);ledger.content_hash=artifact.sha256;ledger.result.visual_qa.sha256=artifact.sha256;
 ledger.result.topology_review.sha256=artifact.sha256;ledger.result.source_observations={method:'OFFLINE_SYNTHETIC_POLICY_TEST_NOT_VISUAL_EVIDENCE'};
 await f.manager.checkpoint(episode,s=>{s.metadata.source_artifacts={q41:{artifact,ledger}};});
 return f;
}
test('SOURCE_QA contextual button refreshes durable state, executes its bound action and preserves panel, master and budget',async()=>{
 const f=await sourceQaFixture(),before=await f.store.getEpisode(episode),original=await f.store.getEpisode(operation),calls=f.calls.length;
 const master=structuredClone((await f.reviewStore.get('1')).state.episodes.historical);
 f.svc.telegram.authority='MAKE';
 const {acknowledgeCommand}=await import('../lib/telegram-review-v1/make-transport.js');
 const ack=async c=>{assert.equal(c.message_id,138);return acknowledgeCommand(f.reviewStore,'1','1',c.idempotency_key,
  {message_id:138,chat:{id:1},caption:c.body.media.caption,reply_markup:c.body.reply_markup,photo:[{file_id:'offline-image',file_unique_id:'offline-unique'}]});};
 const view=await f.svc.show('1','1',{kind:'progress',episode_id:episode});
 assert.ok(view.commands[0].body.reply_markup.inline_keyboard.flat().some(b=>b.text==='🔎 Verificar imagen para animación'));
 await ack(view.commands[0]);
 const cb=await f.callback('resume');assert.equal((await f.reviewStore.get('1')).state.tokens[cb.data.slice(3)].next_action,'source_qa:q41');
 const delivered=await f.svc.callback(cb);await ack(delivered.commands[0]);const cp=await f.store.getEpisode(episode);
 assert.equal(cp.last_completed_action,'source_qa:q41');assert.equal(cp.first_pending_action,'director:q41');
 assert.equal(cp.metadata.stage_qa['source_qa:q41'].topology_review.sha256,original.metadata.first_image.artifact.sha256);
 assert.equal(cp.metadata.stage_results['source_qa:q41'].result.provider_job_ids.length,0);
 const edits=f.telegramCalls.filter(c=>c.method==='editMessageMedia').length;
 const duplicate=await f.svc.callback(cb);assert.equal(duplicate.status,'DUPLICATE_REQUEST');assert.deepEqual(duplicate.commands,[]);assert.deepEqual(await f.store.getEpisode(episode),cp);
 assert.equal(f.telegramCalls.filter(c=>c.method==='editMessageMedia').length,edits);
 assert.ok(f.telegramCalls.filter(c=>c.method==='editMessageMedia').every(c=>c.body.message_id===138));
 assert.deepEqual(await f.store.getEpisode(operation),original);assert.equal(f.calls.length,calls);
 assert.deepEqual((await f.reviewStore.get('1')).state.episodes.historical,master);
 for(const [k,v] of Object.entries(before.metadata.episode_ledger.entries))assert.deepEqual(cp.metadata.episode_ledger.entries[k],v);
 assert.equal((await f.manager.budgetGate({episodeId:episode,actionKey:'director:q41',projectedCallCostUsd:0})).required_total_usd,.33875);
});
for(const fault of ['expired','scope','missing-evidence','topology-fail'])test('SOURCE_QA hides unavailable action with explicit explanation: '+fault,async()=>{
 const f=await sourceQaFixture();
 if(fault==='expired'||fault==='scope')await f.edit(s=>{const g=Object.values(s.v2_authorizations).find(g=>g.episode_id===episode&&g.operation_id===EP004_IMPORT_OP);
  if(fault==='expired')g.expires_at='2000-01-01T00:00:00Z';else g.scopes=['CREATE'];});
 else await f.manager.checkpoint(episode,s=>{if(fault==='missing-evidence')delete s.metadata.source_artifacts;else s.metadata.source_artifacts.q41.ledger.result.topology_review.checks.NO_STINGER='FAIL';});
 const cp=await f.store.getEpisode(episode),calls=f.calls.length;
 await f.svc.show('1','1',{kind:'progress',episode_id:episode});const view=f.telegramCalls.at(-1).body;
 assert.ok(!view.reply_markup.inline_keyboard.flat().some(b=>/Verificar imagen|Continuar producción/.test(b.text)));
 assert.match(view.media.caption,/autorización|revisión detallada/);
 if(['expired','scope'].includes(fault))await assert.rejects(f.adapter.resume({user:'1',episodeId:episode,expectedAction:'source_qa:q41'}),/CONTROLLED_ACTIVATION_REQUIRED/);
 else assert.equal((await f.adapter.resume({user:'1',episodeId:episode,expectedAction:'source_qa:q41'})).status,'SOURCE_REVIEW_REQUIRED');
 assert.deepEqual(await f.store.getEpisode(episode),cp);assert.equal(f.calls.length,calls);
});
test('SOURCE_QA forged panel, forged token and modified original cannot execute',async()=>{
 const f=await sourceQaFixture();await f.svc.show('1','1',{kind:'progress',episode_id:episode});const cb=await f.callback('resume'),cp=await f.store.getEpisode(episode),calls=f.calls.length;
 await assert.rejects(f.svc.callback({...cb,message:{...cb.message,message_id:999}}));
 await assert.rejects(f.svc.callback({...cb,data:'lr:forged'}));assert.deepEqual(await f.store.getEpisode(episode),cp);
 const a=cp.metadata.source_artifacts.q41.artifact;f.objects.set(a.bucket+'/'+a.path,Buffer.from('corrupt'));
 await assert.rejects(f.adapter.resume({user:'1',episodeId:episode,expectedAction:'source_qa:q41'}),/ARTIFACT_INTEGRITY_FAILURE/);
 assert.equal((await f.store.getEpisode(episode)).first_pending_action,'source_qa:q41');assert.equal(f.calls.length,calls);
});
for(const mode of ['double-click','receipt-crash','nonce-CAS','checkpoint-CAS'])test('SOURCE_QA bounded concurrency and durable recovery: '+mode,async()=>{
 let executions=0,crash=mode==='receipt-crash';
 const f=await sourceQaFixture({inject:async p=>{if(p.stage!=='SOURCE_QA')return;if(p.point==='EXECUTOR_ENTERED')executions++;
  if(crash&&p.point==='AFTER_RECEIPT_BEFORE_CHECKPOINT'){crash=false;throw Error('SOURCE_QA_CRASH');}}});
 const calls=f.calls.length;
 if(mode==='nonce-CAS'){
  const cas=f.reviewStore.cas.bind(f.reviewStore);let raced=false;
  f.reviewStore.cas=async(u,r,s)=>{if(!raced&&Object.values(s.production_commands||{}).some(r=>r.status==='STARTED')){raced=true;const row=await f.reviewStore.get(u);row.state.make_requests={race:{status:'COMPLETE'}};await cas(u,row.revision,row.state);}return cas(u,r,s);};
 }
 const run=()=>f.adapter.resume({user:'1',episodeId:episode,expectedAction:'source_qa:q41'});
 if(mode==='checkpoint-CAS'){
  const cas=f.store.casGenericEpisode.bind(f.store);f.store.casGenericEpisode=async(s,r)=>s.actions.find(a=>a.key==='source_qa:q41')?.status==='COMPLETE'?null:cas(s,r);
  await assert.rejects(run());assert.equal((await f.store.getEpisode(episode)).first_pending_action,'source_qa:q41');f.store.casGenericEpisode=cas;
 }else if(mode==='receipt-crash')await assert.rejects(run(),/SOURCE_QA_CRASH/);
 else if(mode==='double-click')await Promise.allSettled([run(),run()]);
 else await run();
 await f.restart().resume({user:'1',episodeId:episode,expectedAction:'source_qa:q41'});
 const cp=await f.store.getEpisode(episode);assert.equal(cp.first_pending_action,'director:q41');assert.equal(executions,1);assert.equal(f.calls.length,calls);
 const again=await run();assert.equal(again.already_applied,true);assert.deepEqual(await f.store.getEpisode(episode),cp);
});
test('SOURCE_QA operator validation requires HMAC and fresh nonce, rejects arbitrary action/panel, never emits Telegram or providers',async()=>{
 const f=await sourceQaFixture(),routes=new Map(),calls=f.calls.length,edits=f.telegramCalls.length,path='/lumi/telegram-review/make/v1';
 mountMakeTransportEndpoint({get:()=>{},post:(p,h)=>routes.set(p,h)},{store:f.reviewStore,production:f.production,validateOwner:async()=>true,env:f.env});
 const call=async(body,id,bad=false)=>{const signed={method:'POST',path,timestamp:String(Math.floor(Date.now()/1000)),requestId:id,body:Buffer.from(JSON.stringify(body))};
  const res={code:200,status(c){this.code=c;return this;},json(v){this.value=v;return this;}};
  await routes.get(path)({body,rawBody:signed.body,path,headers:{'x-lumi-timestamp':signed.timestamp,'x-lumi-request-id':id,'x-lumi-signature':bad?'bad':signRequest(secret,signed)}},res);return res;};
 const body={op:'VERIFY_EP004_SOURCE_QA',user_id:'1',chat_id:'1'};
 assert.equal((await call(body,'source-bad',true)).code,401);
 assert.equal((await call({...body,action:'video:q41'},'source-forged')).code,409);
 assert.equal((await call({...body,message_id:148},'source-panel')).code,409);
 const r=await call(body,'source-good');assert.equal(r.code,200);assert.equal(r.value.completed_action,'source_qa:q41');assert.deepEqual(r.value.actions,[]);
 assert.equal((await call(body,'source-good')).code,409);
 assert.equal((await call(body,'source-again')).value.already_applied,true);
 assert.equal(f.calls.length,calls);assert.equal(f.telegramCalls.length,edits);assert.equal((await f.store.getEpisode(episode)).first_pending_action,'director:q41');
});
test('SOURCE_QA receipt recovery still verifies original bytes and fails closed on corruption',async()=>{
 let crash=true;const f=await sourceQaFixture({inject:async p=>{if(crash&&p.stage==='SOURCE_QA'&&p.point==='AFTER_RECEIPT_BEFORE_CHECKPOINT'){crash=false;throw Error('QA_CRASH');}}});
 await assert.rejects(f.adapter.resume({user:'1',episodeId:episode,expectedAction:'source_qa:q41'}),/QA_CRASH/);
 const cp=await f.store.getEpisode(episode),a=cp.metadata.source_artifacts.q41.artifact,calls=f.calls.length;
 f.objects.set(a.bucket+'/'+a.path,Buffer.from('corrupt-after-receipt'));
 await assert.rejects(f.restart().resume({user:'1',episodeId:episode,expectedAction:'source_qa:q41'}),/ARTIFACT_HASH_MISMATCH/);
 assert.equal((await f.store.getEpisode(episode)).first_pending_action,'source_qa:q41');assert.equal(f.calls.length,calls);
});
test('SOURCE_QA controlled acceptance refuses pending delivery or command without replaying either',async()=>{
 for(const kind of ['delivery','command']){
  const f=await sourceQaFixture(),before=await f.store.getEpisode(episode),calls=f.calls.length;
  await f.edit(s=>{if(kind==='delivery')s.delivery.status='EMITTING';else s.pending_callback={id:'unknown',status:'PENDING'};});
  await assert.rejects(f.production.verifyEp004SourceQa({user:'1',chat:'1'}),/OWNER_OR_DELIVERY_REQUIRED/);
  assert.deepEqual(await f.store.getEpisode(episode),before);assert.equal(f.calls.length,calls);
 }
});

test('all seven EP004 cinematic descriptors are compatible; future images remain pending, not approved',async()=>{
 const {ep004ProductionRequest,prepareGenericV2Episode,validateEp004DirectorInventory}=await import('../lib/lumi-generic-v2-adapter.js');
 const p=prepareGenericV2Episode(ep004ProductionRequest({episode_id:episode,sha256:'a'.repeat(64)}));
 assert.equal(validateEp004DirectorInventory(p).shots,7);
 assert.deepEqual(p.shot_plans.map(s=>s.duration),[4,4,4,4,5,5,3]);
 assert.ok(p.shot_plans.slice(1).every(s=>s.director_input.contract.SOURCE_ARTIFACT.status==='NOT_CREATED'));
 for(const change of [p=>p.shot_plans.pop(),p=>p.shot_plans[1].focus='flower_red',p=>p.shot_plans[0].duration=5]){
  const bad=structuredClone(p);change(bad);assert.throws(()=>validateEp004DirectorInventory(bad),/INVENTORY_INVALID/);
 }
});
test('director operator requires HMAC and fixed server scope; missing real source evidence fails before durable claim',async()=>{
 const f=await sourceQaFixture();await f.adapter.resume({user:'1',episodeId:episode,expectedAction:'source_qa:q41'});
 const routes=new Map(),calls=f.calls.length,edits=f.telegramCalls.length,path='/lumi/telegram-review/make/v1';
 mountMakeTransportEndpoint({get:()=>{},post:(p,h)=>routes.set(p,h)},{store:f.reviewStore,production:f.production,validateOwner:async()=>true,env:f.env});
 const call=async(body,id,bad=false)=>{const signed={method:'POST',path,timestamp:String(Math.floor(Date.now()/1000)),requestId:id,body:Buffer.from(JSON.stringify(body))};
  const res={code:200,status(c){this.code=c;return this;},json(v){this.value=v;return this;}};
  await routes.get(path)({body,rawBody:signed.body,path,headers:{'x-lumi-timestamp':signed.timestamp,'x-lumi-request-id':id,'x-lumi-signature':bad?'bad':signRequest(secret,signed)}},res);return res;};
 const body={op:'PREPARE_EP004_DIRECTOR',user_id:'1',chat_id:'1'},cp=await f.store.getEpisode(episode);
 assert.equal((await call(body,'dir-bad',true)).code,401);
 assert.equal((await call({...body,action:'video:q41'},'dir-forged')).code,409);
 assert.equal((await call({...body,message_id:148},'dir-panel')).code,409);
 await assert.rejects(f.production.prepareEp004Director({user:'1',chat:'1'}),/DIRECTOR_DURABLE_EVIDENCE_MISMATCH/);
 assert.deepEqual(await f.store.getEpisode(episode),cp);assert.equal(f.calls.length,calls);assert.equal(f.telegramCalls.length,edits);
 await f.edit(s=>{s.delivery.status='EMITTING';});
 await assert.rejects(f.production.prepareEp004Director({user:'1',chat:'1'}),/OWNER_OR_DELIVERY_REQUIRED/);
});
test('director navigation respects expired non-generative authorization and explains the block',async()=>{
 const f=await sourceQaFixture();await f.adapter.resume({user:'1',episodeId:episode,expectedAction:'source_qa:q41'});
 await f.edit(s=>{Object.values(s.v2_authorizations).find(g=>g.operation_id===EP004_IMPORT_OP).expires_at='2000-01-01T00:00:00Z';});
 await f.svc.show('1','1',{kind:'progress',episode_id:episode});const view=f.telegramCalls.at(-1).body;
 assert.ok(!view.reply_markup.inline_keyboard.flat().some(b=>b.text.includes('Continuar producción')));assert.match(view.media.caption,/autorización/);
});

// Synthetic durable director evidence tests transport/authorization, not visual
// quality or a live dollar price. The actual director/source are checked offline
// separately; this fixture never reaches a provider.
async function videoQuoteFixture({mode='usd',quoteUsd=.4,inject=async()=>{},transportPatch={}}={}){
 const f=await sourceQaFixture();await f.adapter.resume({user:'1',episodeId:episode,expectedAction:'source_qa:q41'});
 const cp=await f.store.getEpisode(episode),a=cp.metadata.source_artifacts.q41.artifact;
 const packet={episode_id:episode,shot_id:'q41',gates:{SOURCE_EVIDENCE_READY:true,CAPABILITIES_VERIFIED:true},blockers:[],
  DIRECTOR_PLAN:{contract:{SOURCE_ARTIFACT:{artifact_id:a.artifact_id,sha256:a.sha256},DURATION:4,CAMERA:{type:'STATIC'},
   CHARACTER_STATE:{canonical_wings:2,wand_policy:'VISIBLE_PRESERVE_SOURCE'},REQUIRED_OBJECTS:['cow','hen','sheep'].map(id=>({id}))}},
  PROVIDER_PROMPT:{text:'OFFLINE TRANSPORT FIXTURE: static camera; blink and natural settle.'},
  PROVIDER_REQUEST_PREVIEW:{parameters:{duration:4,sound:'off',multi_shots:false,cfg_scale:.5}}};
 const result={episode_id:episode,stage_id:'DIRECTOR',output:packet},id='offline-director-receipt';
 const receipts=new ReviewStageReceiptStore({store:f.reviewStore,user:'1'});
 await receipts.claim(id,{status:'STARTED'});await receipts.record(id,{status:'COMPLETE',result});
 await f.manager.checkpoint(episode,s=>{s.metadata.stage_results['director:q41']={result,sha256:inputDigest(result),receipt_id:id,hash_version:'CANONICAL_JSON_V1'};
  Object.assign(s.actions.find(a=>a.key==='director:q41'),{status:'COMPLETE',dispatch_state:'LOCAL_COMPLETE',
   evidence:{provider_succeeded:true,artifact_persisted:true,sha_verified:true,artifact_verified:true}});});
 await f.edit(s=>{s.delivery.status='DELIVERED';s.pending_callback=null;});
 const quotes=[];
 const make=()=>createGenericV2Runtime({manager:f.manager,reviewStore:f.reviewStore,artifactStorage:f.storage,journal:f.journal,
  validateOwner:async(u,c)=>u==='1'&&c==='1',env:f.env,inject,
  mediaTransport:async artifact=>({url:f.env.SUPABASE_URL+'/storage/v1/object/sign/'+artifact.bucket+'/'+artifact.path+'?token=OFFLINE_VIDEO',
   sha256:artifact.sha256,expires_at:new Date(Date.now()+290000).toISOString(),...transportPatch}),
  fetchImpl:async(url,options)=>{quotes.push({url,options});assert.equal(url,'https://api.higgsfield.ai/estimate/kling-video/v3.0/pro/image-to-video');
   assert.equal(options.method,'POST');assert.equal(options.redirect,'error');
   if(mode==='timeout')throw Error('OFFLINE_TIMEOUT');if(mode==='credits')return Response.json({credits:12});
   if(mode==='http409')return Response.json({error:'conflict'},{status:409});if(mode==='malformed')return new Response('{');
   return Response.json({usd:quoteUsd,expires_at:mode==='expired'?'2000-01-01T00:00:00Z':undefined});}});
 let adapter=make();f.production.adapters.LUMI_PRODUCTION_PROFILE_V2=adapter;
 return {...f,quotes,packet,source:a,get videoAdapter(){return adapter;},
  quote:()=>adapter.prepareEp004VideoQuote({user:'1',chat:'1'}),restartQuote:()=>{adapter=make();f.production.adapters.LUMI_PRODUCTION_PROFILE_V2=adapter;return adapter;}};
}
test('VIDEO_QUOTE: exact endpoint, durable USD receipt, one source reservation and no emission',async()=>{
 const f=await videoQuoteFixture(),before=await f.store.getEpisode(episode),original=await f.store.getEpisode(operation),journal=structuredClone([...f.journalRows]);
 const q=await f.quote();assert.equal(q.status,'AWAITING_HUMAN_AUTHORIZATION');assert.equal(q.quote_usd,.4);
 assert.equal(q.remaining_before_usd,4.66125);assert.equal(q.existing_exposure_usd,.33875);assert.equal(q.proposed_reserve_usd,.5);
 assert.equal(q.remaining_after_usd,4.16125);assert.equal(q.actual_cost_usd,null);assert.equal(q.generation_authorized,false);
 assert.equal(q.payload_sha256,sha256(f.quotes[0].options.body));const payload=JSON.parse(f.quotes[0].options.body);
 assert.equal(payload.prompt,f.packet.PROVIDER_PROMPT.text);assert.equal(payload.duration,4);assert.equal(payload.sound,'off');
 const receipt=(await f.reviewStore.get('1')).state.production_commands[q.quote_id];
 assert.equal(receipt.result_sha,inputDigest(receipt.result));assert.doesNotMatch(JSON.stringify(receipt),/OFFLINE_VIDEO|OFFLINE_KEY|image_url/);
 await f.restartQuote().prepareEp004VideoQuote({user:'1',chat:'1'});assert.equal(f.quotes.length,1);
 assert.deepEqual(await f.store.getEpisode(episode),before);assert.deepEqual(await f.store.getEpisode(operation),original);assert.deepEqual([...f.journalRows],journal);
});
test('VIDEO_QUOTE: concurrent requests and nonce CAS merge estimate once',async()=>{
 const parallel=await videoQuoteFixture();await Promise.allSettled([parallel.quote(),parallel.quote()]);assert.equal((await parallel.quote()).status,'AWAITING_HUMAN_AUTHORIZATION');assert.equal(parallel.quotes.length,1);
 const f=await videoQuoteFixture();const cas=f.reviewStore.cas.bind(f.reviewStore);let raced=false;
 f.reviewStore.cas=async(u,r,s)=>{if(!raced&&Object.values(s.production_commands||{}).some(x=>x.operation==='VIDEO_USD_QUOTE')){
  raced=true;const row=await f.reviewStore.get(u);row.state.make_requests||={};row.state.make_requests.offline_quote_race={status:'COMPLETE'};await cas(u,row.revision,row.state);
 }return cas(u,r,s);};
 const q=await f.quote();await Promise.all([f.quote(),f.quote()]);assert.equal(q.status,'AWAITING_HUMAN_AUTHORIZATION');
 assert.equal(f.quotes.length,1);assert.equal(raced,true,'CAS race hook entered');assert.equal((await f.reviewStore.get('1')).state.make_requests?.offline_quote_race?.status,'COMPLETE');
});
test('VIDEO_QUOTE: crash before/after estimator is not automatically retried',async()=>{
 for(const point of ['VIDEO_QUOTE_CLAIMED','VIDEO_QUOTE_RETURNED_BEFORE_RECEIPT']){
  let once=true;const f=await videoQuoteFixture({inject:async p=>{if(once&&p.point===point){once=false;throw Error('QUOTE_CRASH');}}});
  await assert.rejects(f.quote(),/QUOTE_CRASH/);const before=f.quotes.length;f.restartQuote();
  assert.equal((await f.quote()).status,'QUOTE_RESULT_UNKNOWN');assert.equal(f.quotes.length,before);
 }
});
test('VIDEO_QUOTE: credits, timeout, HTTP 409, malformed, expired and over-budget remain blocked',async()=>{
 for(const mode of ['credits','timeout','http409','malformed','expired','over-budget']){
  const f=await videoQuoteFixture({mode,quoteUsd:mode==='over-budget'?4:.4}),cp=await f.store.getEpisode(episode);
  const q=await f.quote();assert.equal(q.budget_gate,'BLOCKED',mode);assert.equal(q.status,'BLOCKED',mode);
  if(mode==='http409')assert.equal(q.error_code,'higgsfield_usd_estimate_http_409');
  if(mode==='credits'){assert.equal(q.quote_usd,undefined);assert.equal(q.error_code,'higgsfield_api_usd_quote_required');}
  await f.quote();assert.equal(f.quotes.length,1);assert.deepEqual(await f.store.getEpisode(episode),cp);
  await f.svc.show('1','1',{kind:'progress',episode_id:episode});
  assert.ok(!f.telegramCalls.at(-1).body.reply_markup.inline_keyboard.flat().some(b=>b.text==='Autorizar gasto de video'));
 }
});
test('VIDEO_QUOTE: source, journal, director, pending delivery, authorization and signed URL gates precede estimate',async()=>{
 for(const defect of ['bytes','journal','director','delivery','scope','source-url','prior-emission']){
  const f=await videoQuoteFixture({transportPatch:defect==='source-url'?{url:'https://example.test/other.png'}:{}});
  if(defect==='bytes')f.objects.set(f.source.bucket+'/'+f.source.path,Buffer.from('CORRUPTED'));
  if(defect==='journal')f.journalRows.clear();
  if(defect==='director')await f.edit(s=>{s.production_commands['offline-director-receipt'].result.output.PROVIDER_PROMPT.text='MUTATED';});
  if(defect==='delivery')await f.edit(s=>{s.delivery.status='UNKNOWN';});
  if(defect==='scope')await f.edit(s=>{Object.values(s.v2_authorizations).find(g=>g.operation_id===EP004_IMPORT_OP).expires_at='2000-01-01T00:00:00Z';});
  if(defect==='prior-emission'){const cp=await f.store.getEpisode(episode);f.journalRows.set(sha256(episode+':'+cp.metadata.generic_v2.binding_sha+':video:q41'),{state:'EMITTING'});}
  await assert.rejects(f.quote(),undefined,defect);assert.equal(f.quotes.length,0,defect);
 }
});
test('VIDEO_QUOTE: confirmed human spend is quote-bound, CAS durable and cannot emit or reserve',async()=>{
 const f=await videoQuoteFixture(),cp=await f.store.getEpisode(episode),historical=(await f.reviewStore.get('1')).state.episodes.historical;
 const q=await f.quote();await f.svc.show('1','1',{kind:'progress',episode_id:episode});
 const view=f.telegramCalls.at(-1).body;assert.equal(view.message_id,138);assert.ok(view.media.caption.length<1024);
 assert.match(view.media.caption,/no inicia la generación/);assert.match(view.media.caption,/4.66125/);
 const cb=await f.callback('q41_video_authorize'),command=f.command(cb);
 await assert.rejects(f.videoAdapter.authorizeEp004VideoQuote({command:{...command}}),/HMAC/);
 await Promise.allSettled([f.videoAdapter.authorizeEp004VideoQuote({command}),f.videoAdapter.authorizeEp004VideoQuote({command})]);
 const repeated=await f.videoAdapter.authorizeEp004VideoQuote({command});assert.equal(repeated.already_applied,true);
 const after=(await f.reviewStore.get('1')).state,receipt=after.production_commands[q.quote_id];
 assert.equal(receipt.human_authorization.scope,'VIDEO_Q41_QUOTED_SPEND');assert.equal(receipt.human_authorization.max_reservation_usd,.5);
 assert.equal(receipt.human_authorization.payload_sha256,q.payload_sha256);assert.equal(f.quotes.length,1);
 assert.deepEqual(await f.store.getEpisode(episode),cp);assert.deepEqual(after.episodes.historical,historical);
 await f.svc.show('1','1',{kind:'progress',episode_id:episode});assert.match(f.telegramCalls.at(-1).body.media.caption,/Gasto autorizado/);
});
test('VIDEO_QUOTE: callback expiry, checkpoint/budget changes and panel/token forgery fail closed',async()=>{
 for(const mode of ['expired','checkpoint','budget','wrong-token','old-panel']){
  const f=await videoQuoteFixture(),q=await f.quote();await f.svc.show('1','1',{kind:'progress',episode_id:episode});
  const cb=await f.callback('q41_video_authorize'),cmd=f.command(cb);
  if(mode==='expired')await f.edit(s=>{const r=s.production_commands[q.quote_id];r.result.expires_at='2000-01-01T00:00:00Z';r.result_sha=inputDigest(r.result);s.tokens[cmd.token].quote_sha=r.result_sha;});
  if(mode==='checkpoint')await f.manager.checkpoint(episode,s=>{s.metadata.offline_concurrent_change=true;});
  if(mode==='budget')await f.manager.checkpoint(operation,s=>{s.metadata.budget_reservations['image:q41'].amount_usd=1;});
  if(mode==='wrong-token')await f.edit(s=>{s.tokens[cmd.token].quote_id='wrong';});
  if(mode==='old-panel')await f.edit(s=>{s.message_id=148;});
  await assert.rejects(f.videoAdapter.authorizeEp004VideoQuote({command:cmd}));assert.equal(f.quotes.length,1);
  assert.equal((await f.reviewStore.get('1')).state.production_commands[q.quote_id].human_authorization,undefined);
 }
});
test('VIDEO_QUOTE operator requires HMAC, fresh nonce and fixed server-owned inputs',async()=>{
 const f=await videoQuoteFixture(),routes=new Map(),path='/lumi/telegram-review/make/v1';
 mountMakeTransportEndpoint({get:()=>{},post:(p,h)=>routes.set(p,h)},{store:f.reviewStore,production:f.production,validateOwner:async()=>true,env:f.env});
 const call=async(body,id,bad=false)=>{const signed={method:'POST',path,timestamp:String(Math.floor(Date.now()/1000)),requestId:id,body:Buffer.from(JSON.stringify(body))};
  const res={code:200,status(c){this.code=c;return this;},json(v){this.value=v;return this;}};
  await routes.get(path)({body,rawBody:signed.body,path,headers:{'x-lumi-timestamp':signed.timestamp,'x-lumi-request-id':id,'x-lumi-signature':bad?'bad':signRequest(secret,signed)}},res);return res;};
 const body={op:'PREPARE_EP004_VIDEO_QUOTE',user_id:'1',chat_id:'1'};
 assert.equal((await call(body,'video-quote-bad',true)).code,401);
 for(const key of ['model','source_url','payload','message_id','quote_usd'])assert.equal((await call({...body,[key]:'FORGED'},'video-quote-'+key)).code,409);
 const good=await call(body,'video-quote-good');assert.equal(good.code,200);assert.equal(good.value.status,'AWAITING_HUMAN_AUTHORIZATION');
 assert.equal((await call(body,'video-quote-good')).code,409);
 assert.equal((await call(body,'video-quote-recover')).code,200);assert.equal(f.quotes.length,1);
});
