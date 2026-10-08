import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {isolatedFixture,secret} from './fixtures/isolated-validation-v2.js';
import {signRequest} from '../lib/telegram-review-v1/make-transport.js';
import {MemoryLumiRecoveryStore} from '../lib/lumi-recovery-incident-manager-v1.js';
import {authenticateDiagnosticCommand} from '../lib/lumi-v2-activation-context.js';

const results=v=>v.http_records.filter(e=>e.event_kind==='HTTP_RESULT');
const query=async(f,requestId,{user='local-operator',operationId=f.base.operation_id,badSignature=false}={})=>{
  const path=`/lumi/telegram-review/make/diagnostic/${user}/${operationId}`+(requestId?`/${requestId}`:'');
  const signed={timestamp:String(Math.floor(Date.now()/1000)),requestId:randomUUID(),method:'GET',path,body:Buffer.alloc(0)};
  const route='/lumi/telegram-review/make/diagnostic/:user/:operationId'+(requestId?'/:requestId':'');
  const res={code:200,status(n){this.code=n;return this;},json(value){this.value=value;return this;}};
  await f.routes.get(route)({path,params:{user,operationId,requestId},headers:{'x-lumi-timestamp':signed.timestamp,
    'x-lumi-request-id':signed.requestId,'x-lumi-signature':badSignature?'0'.repeat(64):signRequest(secret,signed)}},res);
  return res;
};
const setup=async options=>{const f=await isolatedFixture(options);assert.equal((await f.call('CONTEXT')).code,200);return f;};

test('200, 202 and 409 persist before response; correlation, stage, checkpoint and read-only lookup',async()=>{
  const f=await setup();try{
    assert.equal((await f.call('CREATE')).code,200);
    const e=f.envelope('RESUME'),before=await f.read(),r=await f.send(e);
    assert.equal(r.code,202);assert.equal(r.value.http_result_persisted,true);assert.equal(r.value.request_id,e.signed.requestId);
    let v=await f.read();const event=results(v).at(-1),received=v.http_records.at(-2);
    assert.equal(event.http_status,202);assert.equal(event.stage_id,'PLANNING');assert.equal(event.lease_state,'FREE');
    assert.equal(event.checkpoint_version,v.checkpoint.metadata.runtime_revision);assert.equal(event.runtime_revision,f.env.RENDER_GIT_COMMIT);
    assert.equal(received.checkpoint_version,before.checkpoint.metadata.runtime_revision);
    assert.equal(event.evidence_reference,r.value.evidence_reference);assert.equal(event.operation_id,f.base.operation_id);
    assert.ok(event.timestamp);assert.ok(event.checkpoint_sha256);assert.equal(event.error_code,null);
    assert.equal((await f.call('REVIEW')).code,409);v=await f.read();
    assert.deepEqual(results(v).map(e=>e.http_status),[200,200,202,409]);
    const durable=await f.store.getEpisode(f.base.operation_id),q=await query(f,e.signed.requestId);
    assert.equal(q.code,200);assert.equal(q.value.http_records.length,2);assert.deepEqual(q.value.http_records.at(-1),event);
    assert.deepEqual((await query(f)).value.http_records,v.http_records);
    assert.deepEqual(await f.store.getEpisode(f.base.operation_id),durable);
    assert.equal(f.store.episodes.size,1);assert.deepEqual(f.forbidden,[]);assert.deepEqual(globalThis.LUMI_OFFLINE_GUARD.attempts,[]);
  }finally{await f.cleanup();}
});

for(const [patch,status,code] of [
  [{extra:'unaccepted'},400,'DIAGNOSTIC_PAYLOAD_INVALID'],
  [{provider_generation:true},403,'DIAGNOSTIC_SCOPE_DENIED'],
  [{phase:'REVIEW',decision:'APPROVED'},409,'DIAGNOSTIC_PHASE_ORDER'],
  [{expires_at:'2000-01-01'},403,'DIAGNOSTIC_EXPIRED']
])test('authenticated rejection is persisted: '+code,async()=>{
  const f=await setup();try{
    const before=await f.read(),r=await f.call('CREATE',patch),after=await f.read();
    assert.equal(r.code,status);assert.equal(r.value.error,code);assert.equal(r.value.http_result_persisted,true);
    assert.equal(results(after).at(-1).http_status,status);assert.equal(results(after).at(-1).error_code,code);
    assert.deepEqual(after.checkpoint,before.checkpoint);assert.deepEqual(after.results,before.results);
    assert.deepEqual(after.review.state.v2_authorizations,before.review.state.v2_authorizations);
  }finally{await f.cleanup();}
});

for(const [raw,status,code] of [['STALE_CHECKPOINT',409,'DIAGNOSTIC_STALE_CHECKPOINT'],
  ['ARTIFACT_MISSING',422,'DIAGNOSTIC_ARTIFACT_MISSING'],
  ['Authorization Bearer LOCAL_SECRET cookie=PRIVATE https://example.invalid/?signature=SECRET',500,'DIAGNOSTIC_PHASE_FAILED']])
test('stage error mapping and closed-message sanitation: '+code,async()=>{
  let fault=false;
  const f=await setup({inject:async e=>{if(fault&&e.point==='CREATE_AFTER_AUTHORIZATION')throw Error(raw);}});
  try{
    fault=true;const r=await f.call('CREATE'),v=await f.read(),event=results(v).at(-1);
    assert.equal(r.code,status);assert.equal(event.error_code,code);assert.equal(event.sanitized_error_message,code);
    assert.equal(event.lease_state,'FREE');assert.equal(v.lease,null);
    const stored=JSON.stringify(v.http_records);
    for(const secretValue of ['LOCAL_SECRET','PRIVATE','example.invalid','Bearer','cookie=',secret])assert.ok(!stored.includes(secretValue));
    for(const forbidden of ['authorization','cookie','headers','request_body','response_body','signature','lease_token'])
      assert.ok(v.http_records.every(e=>!(forbidden in e)));
  }finally{await f.cleanup();}
});

test('unauthenticated, forged, stale HMAC, foreign and revoked-owner requests write nothing',async()=>{
  let active=true;const f=await setup({validateOwner:async()=>active});try{
    const before=await f.store.getEpisode(f.base.operation_id);
    const missing=f.envelope('CREATE');delete missing.signature;
    assert.equal((await f.send(missing)).code,401);
    const bad=f.envelope('CREATE');bad.signature='0'.repeat(64);assert.equal((await f.send(bad)).code,401);
    const expired=f.envelope('CREATE');expired.signed.timestamp=String(Math.floor(Date.now()/1000)-200);
    expired.signature=signRequest(secret,expired.signed);assert.equal((await f.send(expired)).code,401);
    assert.equal((await f.call('CREATE',{user_id:'foreign',chat_id:'foreign'})).code,404);
    active=false;assert.equal((await f.call('CREATE')).code,403);active=true;
    assert.equal((await query(f,undefined,{badSignature:true})).code,401);
    assert.equal((await query(f,undefined,{user:'foreign'})).code,403);
    assert.deepEqual(await f.store.getEpisode(f.base.operation_id),before);
  }finally{await f.cleanup();}
});

test('original diagnostic without HTTP schema is immutable and not backfilled',async()=>{
  const f=await setup();try{
    const row=await f.store.getEpisode(f.base.operation_id);
    delete row.metadata.isolated_validation.http_records;delete row.metadata.isolated_validation.http_observability_version;
    await f.store.putEpisode(row);
    assert.equal((await f.call('CREATE')).value.error,'DIAGNOSTIC_HTTP_OBSERVABILITY_REQUIRED');
    assert.equal((await f.call('CONTEXT')).value.error,'DIAGNOSTIC_HTTP_OBSERVABILITY_REQUIRED');
    assert.equal((await query(f)).value.status,'HTTP_EVIDENCE_NOT_AVAILABLE');
    assert.deepEqual(await f.store.getEpisode(f.base.operation_id),row);
  }finally{await f.cleanup();}
});

test('duplicate request identity never executes twice; distinct attempt errors preserve original result and nonce',async()=>{
  const f=await setup();try{
    const e=f.envelope('CREATE');assert.equal((await f.send(e)).code,200);
    const original=await f.read();assert.equal((await f.send(e)).value.error,'replayed_request');
    const changed=f.envelope('RESUME',{},e.signed.requestId);
    assert.equal((await f.send(changed)).value.error,'DIAGNOSTIC_REQUEST_ID_CONFLICT');
    const v=await f.read(),same=results(v).filter(r=>r.request_id===e.signed.requestId);
    assert.deepEqual(same.map(r=>r.http_status),[200,409,409]);assert.equal(new Set(same.map(r=>r.http_attempt_id)).size,3);
    assert.deepEqual(v.http_records.slice(0,original.http_records.length),original.http_records);
    assert.deepEqual(v.checkpoint,original.checkpoint);assert.deepEqual(v.nonces,original.nonces);
    assert.equal(f.events.filter(e=>e.point==='CREATE_AFTER_AUTHORIZATION').length,1);assert.equal(f.store.episodes.size,1);
  }finally{await f.cleanup();}
});

test('CAS retries merge concurrent HTTP records; stale writers cannot erase records or leases',async()=>{
  let conflicts=0;
  class ConflictingStore extends MemoryLumiRecoveryStore{
    async casDiagnostic(row,rev){await Promise.resolve();const result=await super.casDiagnostic(row,rev);if(!result)conflicts++;return result;}
  }
  const f=await setup({store:new ConflictingStore()});try{
    const before=await f.read();const rs=await Promise.all(Array.from({length:3},()=>f.call('REVIEW')));
    assert.ok(rs.every(r=>r.code===409&&r.value.http_result_persisted));assert.ok(conflicts>0);
    const v=await f.read();assert.equal(v.http_records.length,before.http_records.length+6);
    assert.deepEqual(v.http_records.slice(0,before.http_records.length),before.http_records);
    assert.equal(new Set(results(v).map(e=>e.http_attempt_id)).size,4);
    assert.deepEqual(v.checkpoint,before.checkpoint);assert.equal(v.lease,null);
  }finally{await f.cleanup();}
});

test('lease conflict records HELD without stealing lease; stage completion records FREE',async()=>{
  let entered,release;const barrier=new Promise(r=>entered=r),wait=new Promise(r=>release=r);
  const f=await setup({inject:async e=>{if(e.point==='CREATE_AFTER_AUTHORIZATION'){entered();await wait;}}});try{
    const first=f.call('CREATE');await barrier;
    const before=await f.read(),busy=await f.call('CREATE'),during=await f.read();
    assert.equal(busy.code,409);assert.equal(busy.value.error,'DIAGNOSTIC_BUSY');
    assert.deepEqual(during.lease,before.lease);assert.deepEqual(during.checkpoint,before.checkpoint);
    assert.equal(results(during).at(-1).lease_state,'HELD');release();assert.equal((await first).code,200);
    assert.equal(results(await f.read()).at(-1).lease_state,'FREE');
  }finally{release();await f.cleanup();}
});

for(const mode of ['admission','result'])test('storage failure at '+mode+' returns explicit 503, never PASS or automatic next stage',async()=>{
  let failing=false;
  class FailingStore extends MemoryLumiRecoveryStore{
    async casDiagnostic(row,rev){
      if(failing&&(mode==='admission'||row.metadata.isolated_validation.http_records.at(-1)?.event_kind==='HTTP_RESULT'))
        throw Error('LOCAL_SECRET_STORAGE_FAILURE');
      return super.casDiagnostic(row,rev);
    }
  }
  const f=await setup({store:new FailingStore()});try{
    const before=await f.read();failing=true;
    const r=await f.call('CREATE');failing=false;
    assert.equal(r.code,503);assert.equal(r.value.error,'DIAGNOSTIC_HTTP_PERSISTENCE_FAILED');assert.equal(r.value.http_result_persisted,false);
    const v=await f.read();assert.equal(results(v).length,results(before).length);
    assert.equal(f.events.filter(e=>e.point==='EXECUTOR_ENTERED').length,0);
    if(mode==='admission'){assert.deepEqual(v,before);assert.equal(f.events.filter(e=>e.point==='CREATE_AFTER_AUTHORIZATION').length,0);}
    else{assert.equal(v.http_records.at(-1).result_status,'OUTCOME_UNKNOWN');assert.equal(v.checkpoint.first_pending_action,'planning');}
    const durable=await f.store.getEpisode(f.base.operation_id);await query(f,r.value.request_id);
    assert.deepEqual(await f.store.getEpisode(f.base.operation_id),durable);
  }finally{await f.cleanup();}
});

test('lease release failure is visible, keeps owned lease and checkpoint, no hidden success',async()=>{
  let failing=false;
  class ReleaseFailureStore extends MemoryLumiRecoveryStore{
    async casDiagnostic(row,rev){
      const old=await this.getEpisode(row.episode_id);
      if(failing&&old.metadata.isolated_validation.lease&&!row.metadata.isolated_validation.lease)throw Error('LOCAL_RELEASE_FAILURE');
      return super.casDiagnostic(row,rev);
    }
  }
  const f=await setup({store:new ReleaseFailureStore(),inject:async e=>{if(e.point==='CREATE_AFTER_AUTHORIZATION')failing=true;}});
  try{
    const r=await f.call('CREATE'),v=await f.read();
    assert.equal(r.code,503);assert.equal(r.value.error,'DIAGNOSTIC_LEASE_RELEASE_FAILED');
    assert.equal(results(v).at(-1).lease_state,'HELD');assert.ok(v.lease);assert.ok(v.checkpoint);
    assert.equal(v.results.CREATE,undefined);assert.equal(v.checkpoint.first_pending_action,'planning');
  }finally{await f.cleanup();}
});

test('same terminal append is idempotent; capacity reserves completion without deleting evidence',async()=>{
  const f=await setup();try{
    const envelope=f.envelope('STATUS'),a=await f.isolatedValidation.http.identity(envelope);
    await f.isolatedValidation.http.append(a);const terminal={http_status:200};
    const first=await f.isolatedValidation.http.append(a,terminal),row=await f.store.getEpisode(f.base.operation_id);
    assert.deepEqual(await f.isolatedValidation.http.append(a,terminal),first);
    assert.deepEqual(await f.store.getEpisode(f.base.operation_id),row);
    const {command:c}=authenticateDiagnosticCommand({env:f.env,...f.envelope('STATUS')});
    await f.isolatedValidation.mutate(c,v=>{while(v.http_records.filter(e=>e.event_kind==='RECEIVED').length<256)
      v.http_records.push({...v.http_records[0],http_attempt_id:'capacity-'+v.http_records.length});});
    const full=await f.store.getEpisode(f.base.operation_id),r=await f.call('CREATE');
    assert.equal(r.code,409);assert.equal(r.value.error,'DIAGNOSTIC_HTTP_CAPACITY');assert.equal(r.value.http_result_persisted,false);
    assert.deepEqual(await f.store.getEpisode(f.base.operation_id),full);
  }finally{await f.cleanup();}
});

test('new-context storage failure is classified, with no fabricated diagnostic row',async()=>{
  class UnavailableStore extends MemoryLumiRecoveryStore{async createDiagnostic(){throw Error('DRY_CHECKPOINT_WRITE_FAILED');}}
  const f=await isolatedFixture({store:new UnavailableStore()});try{
    const r=await f.call('CONTEXT');assert.equal(r.code,503);assert.equal(r.value.error,'DIAGNOSTIC_STORAGE_FAILED');
    assert.equal(r.value.http_result_persisted,false);assert.equal(f.store.episodes.size,0);assert.deepEqual(f.events,[]);
  }finally{await f.cleanup();}
});

test('concurrent identical request IDs produce one operation and one durable 409 without losing 200',async()=>{
  const f=await setup();try{
    const e=f.envelope('CREATE'),responses=await Promise.all([f.send(e),f.send(e)]),v=await f.read();
    assert.deepEqual(responses.map(r=>r.code).sort(),[200,409]);assert.ok(responses.every(r=>r.value.http_result_persisted));
    assert.deepEqual(results(v).filter(r=>r.request_id===e.signed.requestId).map(r=>r.http_status).sort(),[200,409]);
    assert.equal(f.events.filter(e=>e.point==='CREATE_AFTER_AUTHORIZATION').length,1);assert.equal(f.store.episodes.size,1);
  }finally{await f.cleanup();}
});

test('expired diagnostic is queryable with a fresh signed GET; querying changes no grant, nonce or lease',async()=>{
  let now=Date.now();const f=await setup({clock:()=>now});try{
    now=Date.parse(f.base.expires_at)+1000;
    const path=`/lumi/telegram-review/make/diagnostic/local-operator/${f.base.operation_id}`;
    const signed={timestamp:String(Math.floor(now/1000)),requestId:'fresh-read-expired-context',method:'GET',path,body:Buffer.alloc(0)};
    const before=await f.store.getEpisode(f.base.operation_id),r=await f.isolatedValidation.http.query({signed,
      signature:signRequest(secret,signed),user:'local-operator',operationId:f.base.operation_id});
    assert.equal(r.status,200);assert.equal(r.body.http_records.length,2);
    assert.deepEqual(await f.store.getEpisode(f.base.operation_id),before);
  }finally{await f.cleanup();}
});

test('signature expiring after trusted admission persists 401, never authorizes the operation',async()=>{
  let now=Date.now(),expire=false;
  const f=await setup({clock:()=>now,validateOwner:async()=>{if(expire)now+=121000;return true;}});
  try{
    const before=await f.read();expire=true;const r=await f.call('CREATE'),v=await f.read();
    assert.equal(r.code,401);assert.equal(r.value.error,'DIAGNOSTIC_AUTH_REQUIRED');assert.equal(r.value.http_result_persisted,true);
    assert.equal(results(v).at(-1).http_status,401);assert.deepEqual(v.checkpoint,before.checkpoint);
    assert.deepEqual(v.nonces,before.nonces);assert.deepEqual(v.results,before.results);
    assert.equal(f.events.filter(e=>e.point==='CREATE_AFTER_AUTHORIZATION').length,0);
  }finally{await f.cleanup();}
});

test('query recovers request IDs containing colon without changing the signed path grammar',async()=>{
  const f=await setup();try{
    const id='request:with:colon',e=f.envelope('CREATE',{},id);assert.equal((await f.send(e)).code,200);
    const requestIdHex=Buffer.from(id).toString('hex');
    const path=`/lumi/telegram-review/make/diagnostic/local-operator/${f.base.operation_id}/request/${requestIdHex}`;
    const signed={method:'GET',path,body:Buffer.alloc(0),requestId:'read-encoded',timestamp:String(Math.floor(Date.now()/1000))};
    const before=await f.store.getEpisode(f.base.operation_id),res={code:200,status(n){this.code=n;return this;},json(value){this.value=value;return this;}};
    await f.routes.get('/lumi/telegram-review/make/diagnostic/:user/:operationId/request/:requestIdHex')({path,
      params:{user:'local-operator',operationId:f.base.operation_id,requestIdHex},headers:{'x-lumi-timestamp':signed.timestamp,
        'x-lumi-request-id':signed.requestId,'x-lumi-signature':signRequest(secret,signed)}},res);
    assert.equal(res.code,200);assert.equal(res.value.request_id,id);assert.equal(res.value.http_records.length,2);
    assert.equal(res.value.http_records.at(-1).http_status,200);
    assert.deepEqual(await f.store.getEpisode(f.base.operation_id),before);
  }finally{await f.cleanup();}
});
