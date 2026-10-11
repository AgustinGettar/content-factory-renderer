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
async function fixture({inject,mode='complete',imageBytes=image}={}){
  const reviewStore=new MemoryReviewStore(),store=new MemoryLumiRecoveryStore(),manager=new LumiRecoveryIncidentManager({store});
  const objects=new Map([[d.canonical_artifact.bucket+'/'+d.canonical_artifact.path,canonical]]),journalRows=new Map(),calls=[],telegramCalls=[];
  const env={LUMI_RUNTIME_ENV:'staging',LUMI_TELEGRAM_CALLBACK_SECRET:secret,LUMI_TELEGRAM_TRANSPORT_AUTHORITY:'MAKE',
    LUMI_TELEGRAM_REVIEW_TEST_USERS:'1',HF_API_KEY:'OFFLINE_KEY',SUPABASE_URL:'https://q41-offline.supabase.co'};
  const cover={artifact_id:'home',sha256:sha256(canonical),size:canonical.length,bucket:d.canonical_artifact.bucket,path:d.canonical_artifact.path,mime:'image/png'};
  await reviewStore.create('1',newSession({user_id:'1',chat_id:'1',message_id:138,cover}));
  const now=Date.now(),evidence={source:'VERIFIED_SAME_API_ACCOUNT',proof_reference:'OFFLINE_TEST_ONLY',account_id:'fixture-account',
    user_id:'1',episode_id:episode,shot_id:'q41',descriptor_sha256:d.descriptor_sha256,api_key_sha256:sha256(env.HF_API_KEY),
    checked_at:new Date(now).toISOString(),expires_at:new Date(now+59000).toISOString(),payload_expires_at:new Date(now+59000).toISOString(),
    prepaid_only:true,auto_recharge:false,credit_billing:false,negative_balance_allowed:false,external_funding_locked:true,balance_usd:4.64,source_url:sourceUrl};
  const quote={episode_id:episode,shot_id:'q41',model:d.model,canonical_source_verified:true,canonical_source_sha256:d.canonical_artifact.sha256,
    descriptor_sha256:d.descriptor_sha256,prompt_sha256:d.prompt_sha256,status:'QUOTE_VERIFIED',http_status:200,
    payload_sha256:sha256(JSON.stringify({...d.input,image_urls:[sourceUrl]})),quote_usd:0.271,quote_timestamp:new Date(now).toISOString(),quote_expiration:null};
  const diag=diagnosticOperationId('1',DIAGNOSTIC_Q41_KEY,DIAGNOSTIC_Q41_SCOPE);
  await store.putEpisode({episode_id:diag,metadata:{isolated_validation:{q41_quote_attempt:{result:quote}}}});
  const edit=async fn=>{const row=await reviewStore.get('1');fn(row.state);await reviewStore.cas('1',row.revision,row.state);};
  await edit(s=>{s.q41_prepaid_evidence=seal(evidence);s.episodes.historical={episode_id:'historical',master:{...cover,mime:'video/mp4'},reviews:{approved:{status:'APPROVED'}}};});
  const storage={download:async(b,p)=>objects.get(b+'/'+p)??null,upload:async(b,p,bytes)=>{assert.ok(!objects.has(b+'/'+p));objects.set(b+'/'+p,Buffer.from(bytes));}};
  // Mirror the existing SQL FK/admission contract, not only the JS interface.
  const journal={get:async id=>structuredClone(journalRows.get(id)||null),prepare:async row=>{
    assert.ok(await store.getEpisode(row.episode_id),'journal requires its durable checkpoint');
    if(journalRows.has(row.attempt_id))throw Error('DUPLICATE');journalRows.set(row.attempt_id,structuredClone(row));},
    transition:async(id,from,patch)=>{const row=journalRows.get(id);assert.equal(row.state,from);Object.assign(row,structuredClone(patch));return structuredClone(row);}};
  const fetchImpl=async(url,options={})=>{
    calls.push({url,method:options.method||'GET'});assert.equal(options.redirect,'error');
    if(options.method==='POST'){
      assert.equal(url,'https://api.higgsfield.ai/marketing-studio/image');
      const cp=await store.getEpisode(operation);assert.equal(cp.metadata.first_image.state,'EMITTING');
      assert.equal(cp.metadata.budget_reservations['image:q41'].amount_usd,4.64);assert.equal(journalRows.get(operation).state,'EMITTING');
      assert.equal(sha256(options.body),quote.payload_sha256);
      if(mode==='timeout')throw Error('OFFLINE_TIMEOUT');
      if(mode==='malformed')return new Response('{');
      return Response.json({request_id:'offline-job',status_url:'https://api.higgsfield.ai/requests/offline-job'});
    }
    if(url==='https://api.higgsfield.ai/requests/offline-job')return Response.json({request_id:'offline-job',status:mode==='pending'?'processing':'completed',images:[{url:'https://media.example.test/offline.png'}]});
    assert.equal(url,'https://media.example.test/offline.png');return new Response(imageBytes);
  };
  const makeAdapter=()=>createGenericV2Runtime({manager,reviewStore,artifactStorage:storage,journal,validateOwner:async(u,c)=>u==='1'&&c==='1',env,fetchImpl,inject});
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
  const command=cb=>authenticateFirstImageCallback({env,...envelope(cb)});
  const click=async action=>{const cb=await callback(action);return svc.callback(cb,{firstImageCommand:action==='q41_prepare'?null:command(cb)});};
  const prepare=async()=>{await svc.show('1','1',{kind:'menu'});await click('create_v2_ideas');await click('create_v2_budget');await click('q41_prepare');};
  const restart=()=>{adapter=makeAdapter();production.adapters.LUMI_PRODUCTION_PROFILE_V2=adapter;return adapter;};
  return {store,manager,reviewStore,storage,objects,journal,journalRows,calls,telegramCalls,env,evidence,quote,diag,edit,callback,envelope,command,click,prepare,svc,production,restart,get adapter(){return adapter;},setMode:v=>{mode=v;}};
}

test('DOUBLE_CLICK_IDEMPOTENCY: concurrent confirmation and restarted replay emit once',async()=>{
  const f=await fixture();await f.prepare();const cb=await f.callback('q41_confirm'),command=f.command(cb);
  await Promise.allSettled([f.adapter.firstImageAction({command}),f.adapter.firstImageAction({command})]);
  await f.restart().firstImageAction({command:f.command(cb)});
  assert.equal(f.calls.filter(c=>c.method==='POST').length,1);assert.equal(f.journalRows.size,1);
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
  await f.edit(s=>{s.tokens[cb.data.slice(3)].proposal_id='other';});
  await assert.rejects(f.adapter.firstImageAction({command:f.command(cb)}),/SCOPE/);assert.equal(f.calls.length,0);
});

test('PAYLOAD_MUTATION_REJECTION: signed URL, quote and confirmed binding must remain exact',async()=>{
  for(const kind of ['url','quote','evidence-seal','after-confirmation']){
    const f=await fixture();await f.prepare();const cb=await f.callback('q41_confirm');
    if(kind==='quote'){const cp=await f.store.getEpisode(f.diag);cp.metadata.isolated_validation.q41_quote_attempt.result.payload_sha256='a'.repeat(64);await f.store.putEpisode(cp);}
    else await f.edit(s=>{
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
  await f.restart().firstImageAction({command:f.command(cb)});assert.equal(f.calls.length,0);
  const cp=await f.store.getEpisode(operation);assert.equal(cp.metadata.budget_reservations['image:q41'].amount_usd,4.64);assert.equal(cp.metadata.first_image.state,'EMITTING');
  let continued=0;
  const recovered=await f.manager.resume(operation,{continueAction:async()=>{continued++;return {};}});
  assert.equal(continued,0);assert.equal(recovered.status,'Q41_SCOPED_CALLBACK_RECOVERY_REQUIRED');
});

test('SUBMISSION_OUTCOME_UNKNOWN: timeout or malformed JSON consumes the only attempt',async()=>{
  for(const mode of ['timeout','malformed']){const f=await fixture({mode});await f.prepare();await f.click('q41_confirm');
    assert.equal(f.calls.filter(c=>c.method==='POST').length,1);await f.restart();await f.click('q41_status');await f.click('q41_status');
    assert.equal(f.calls.length,1);assert.equal((await f.reviewStore.get('1')).state.q41_first_image.blocker,'Q41_EMISSION_OUTCOME_UNKNOWN_NO_RESUBMIT');
  }
});

test('ARTIFACT_RECOVERY: pending original and storage crash recover via GET with one immutable upload',async()=>{
  let crashed=false;const f=await fixture({mode:'pending',inject:async({point})=>{if(point==='Q41:ARTIFACT_PERSISTED_QA_NOT_PERSISTED'&&!crashed){crashed=true;throw Error('OFFLINE_CRASH');}}});
  await f.prepare();await f.click('q41_confirm');f.setMode('complete');await f.click('q41_status');await f.restart();await f.click('q41_status');
  const s=(await f.reviewStore.get('1')).state;assert.equal(s.q41_first_image.artifact.sha256,sha256(image));assert.equal(s.q41_first_image.technical_qa.ok,true);
  assert.equal(s.q41_first_image.visual_qa,'REQUIRES_HUMAN_VISUAL_REVIEW');assert.equal(f.objects.size,2);assert.equal(f.calls.filter(c=>c.method==='POST').length,1);
});

test('SAME_ARTIFACT_SHA_BINDING: stale review and corrupted storage cannot approve',async()=>{
  const f=await fixture();await f.prepare();await f.click('q41_confirm');const cb=await f.callback('q41_approve');
  await f.edit(s=>{s.tokens[cb.data.slice(3)].artifact_sha='b'.repeat(64);});
  await assert.rejects(f.adapter.firstImageAction({command:f.command(cb)}),/REVIEW_STALE/);
  await f.edit(s=>{s.tokens[cb.data.slice(3)].artifact_sha=sha256(image);});
  const a=(await f.reviewStore.get('1')).state.q41_first_image.artifact;f.objects.set(a.bucket+'/'+a.path,Buffer.from('corrupt'));
  await assert.rejects(f.adapter.firstImageAction({command:f.command(cb)}),/SHA_MISMATCH/);assert.equal(f.calls.filter(c=>c.method==='POST').length,1);
});

test('HUMAN_REVIEW_GATE and NO_AUTOMATIC_KLING: approve/reject are immutable pauses',async()=>{
  for(const action of ['q41_approve','q41_reject']){const f=await fixture();await f.prepare();await f.click('q41_confirm');
    const cb=await f.callback(action),other=await f.callback(action==='q41_approve'?'q41_reject':'q41_approve');
    await f.click(action);await f.adapter.firstImageAction({command:f.command(cb)});
    await assert.rejects(f.adapter.firstImageAction({command:f.command(other)}),/IMMUTABLE/);
    const cp=await f.store.getEpisode(operation);assert.equal(cp.actions.length,1);assert.match(cp.metadata.first_image.state,/_PAUSED$/);
    assert.equal(cp.runner_enabled,false);assert.equal(cp.autorun,false);assert.equal(f.calls.filter(c=>c.method==='POST').length,1);
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
    {negative_balance_allowed:true},{external_funding_locked:false},{balance_usd:0.2},{balance_usd:5},{checked_at:'2026-01-01T00:00:00Z'}]){
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
  f.setMode('pending');const result=await run(e.signature);assert.equal(result.status,200);assert.equal(f.calls.filter(c=>c.method==='POST').length,1);
  assert.equal((await run(e.signature)).status,409);assert.equal(f.calls.filter(c=>c.method==='POST').length,1);
});

test('CAS and journal persistence failures occur before the provider boundary',async()=>{
  for(const fault of ['authorization','reservation','journal-prepare','journal-emitting']){
    const f=await fixture();await f.prepare();const cb=await f.callback('q41_confirm');
    if(fault==='authorization'){const cas=f.reviewStore.cas.bind(f.reviewStore);f.reviewStore.cas=async(u,r,s)=>{
      if(s.v2_authorizations?.[operation])throw Error('OFFLINE_STORAGE_FAILURE');return cas(u,r,s);};}
    if(fault==='reservation')f.store.casGenericEpisode=async()=>null;
    if(fault==='journal-prepare')f.journal.prepare=async()=>{throw Error('OFFLINE_STORAGE_FAILURE');};
    if(fault==='journal-emitting')f.journal.transition=async()=>{throw Error('OFFLINE_STORAGE_FAILURE');};
    await f.adapter.firstImageAction({command:f.command(cb)}).catch(()=>null);assert.equal(f.calls.length,0,fault);
  }
});

test('budget records reject missing evidence, expired quote and accumulated exposure above USD 5',async()=>{
  const absent=await fixture();await absent.edit(s=>{delete s.q41_prepaid_evidence;});await absent.prepare();
  assert.equal((await absent.reviewStore.get('1')).state.q41_first_image.blocker,'Q41_VERIFIED_PREPAID_EVIDENCE_REQUIRED');
  const stale=await fixture(),q=await stale.store.getEpisode(stale.diag);q.metadata.isolated_validation.q41_quote_attempt.result.quote_timestamp='2026-01-01T00:00:00Z';
  await stale.store.putEpisode(q);await stale.prepare();assert.equal((await stale.reviewStore.get('1')).state.q41_first_image.status,'BLOCKED');
  const f=await fixture();await f.manager.startEpisode({episodeId:operation,actions:[{key:'image:q41',stage:'IMAGE'}],authorizedCeilingUsd:5,
    metadata:{operation_type:scope,runtime_revision:0,first_image:{state:'PREPARED',binding:'fixture'},budget_reservations:{other:{amount_usd:0.2}}}});
  await f.manager.checkpoint(operation,s=>{s.current_cost_usd=0.2;});
  await assert.rejects(f.manager.reserveFirstImage({episodeId:operation,actionKey:'image:q41',amountUsd:4.64,binding:'fixture'}),/BUDGET/);
  assert.equal(f.calls.length,0);
});

test('human review cannot turn an undersized original into a technically approved 2K source',async()=>{
  const f=await fixture({imageBytes:canonical});await f.prepare();await f.click('q41_confirm');
  const s=(await f.reviewStore.get('1')).state;assert.equal(s.q41_first_image.technical_qa.ok,false);
  assert.equal(s.q41_first_image.blocker,'Q41_IMAGE_TECHNICAL_QA_FAILED');
  const active=s.delivery.tokens.map(t=>s.tokens[t]);assert.equal(active.some(t=>t.action==='q41_approve'),false);
  await f.click('q41_reject');assert.equal(f.calls.filter(c=>c.method==='POST').length,1);
});
