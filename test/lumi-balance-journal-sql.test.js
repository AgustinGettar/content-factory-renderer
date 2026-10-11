import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';

// Embedded PostgreSQL, local only; exercise the real migration, lock/admission
// function, immutable trigger, unique indexes and privileges, not a SQL mock.
const migration=(await readdir(new URL('../supabase/migrations/',import.meta.url))).find(n=>n.endsWith('_lumi_balance_recovery.sql'));
async function fixture({stage='IMAGE',generic=false}={}){
  const db=new PGlite();
  await db.exec(`create role anon;create role authenticated;create role service_role;
    create table public.lumi_pilot_runs(id uuid,scene_id text,stage text,provider_request_id text,provider_calls integer,
      pilot_id text,status text,content_hash text,result jsonb,storage_path text);`);
  await db.exec(await readFile(new URL('../supabase/migrations/20261004010000_lumi_recovery_incident_manager_v1.sql',import.meta.url),'utf8'));
  await db.exec(await readFile(new URL('../docs/provider-emission-journal-v1.sql',import.meta.url),'utf8'));
  await db.exec(await readFile(new URL('../supabase/migrations/'+migration,import.meta.url),'utf8'));
  const cp={episode_id:'ep004_q41_first_image',pipeline_version:'v1_1_2',preset_version:'1.1.2',status:'RUNNING',authorized_ceiling_usd:5,
    first_pending_action:stage.toLowerCase()+':q41',actions:[{key:stage.toLowerCase()+':q41',stage,scene_id:'q41',status:'PENDING'}],metadata:generic?{generic_v2:{profile_sha:'offline-profile'}}:{operation_type:'EP004_Q41_FIRST_IMAGE'}};
  await db.query(`insert into lumi_pipeline_checkpoints(episode_id,pipeline_version,preset_version,status,authorized_ceiling_usd,first_pending_action,actions,metadata)
    values($1,$2,$3,$4,$5,$6,$7,$8)`,[cp.episode_id,cp.pipeline_version,cp.preset_version,cp.status,5,cp.first_pending_action,JSON.stringify(cp.actions),JSON.stringify(cp.metadata)]);
  const row={attempt_id:'first',version:'PROVIDER_EMISSION_JOURNAL_V1',episode_id:cp.episode_id,scene_id:'q41',stage,provider:'higgsfield_api',
    model:'marketing-studio/image',expected_cost_usd:0.271,prompt_hash:'a',payload_fingerprint:'b',request_fingerprint:'c',payload_descriptor:{},
    emission_nonce:'11111111-1111-4111-8111-111111111111',state:'PREPARED',prepared_at:new Date().toISOString()};
  const prepare=r=>db.query('select lumi_prepare_emission_v1($1::jsonb)',[JSON.stringify(r)]);
  await prepare(row);
  const transition=async(status=402,code='insufficient_balance')=>{
    await db.exec("update lumi_provider_emission_journal set state='EMITTING' where attempt_id='first'");
    await db.query(`update lumi_provider_emission_journal set state='ACKNOWLEDGED',http_status=$1,response_parsing_outcome='JSON_PARSED',
      incident_classification='INSUFFICIENT_PROVIDER_BALANCE',response_metadata=$2 where attempt_id='first'`,[status,JSON.stringify({accepted_job_absent:true,error_code:code})]);
  };
  const successor={...row,attempt_id:'second',emission_nonce:'22222222-2222-4222-8222-222222222222',original_attempt_snapshot:{balance_recovery_of:'first'}};
  const authorize=async patch=>{
    const fi={state:'EMITTING',attempt_id:'second',prior_attempt_id:'first',binding:'bound',
      action_key:cp.first_pending_action,authorization:{attempt_id:'second',status:'AUTHORIZED',episode_id:cp.episode_id,profile_sha:'offline-profile',explicit_user_authorization:true,expires_at:new Date(Date.now()+60000).toISOString()}};
    const metadata={...cp.metadata,[generic?'balance_recovery':'first_image']:fi,budget_reservations:{'rejected:first':{amount_usd:0.33875},[cp.first_pending_action]:{amount_usd:0.33875,binding:'bound'}}};
    if(patch)patch(metadata);
    await db.query('update lumi_pipeline_checkpoints set metadata=$1 where episode_id=$2',[JSON.stringify(metadata),cp.episode_id]);
  };
  return {db,row,prepare,transition,successor,authorize};
}

test('SQL: immutable rejected attempt permits one scoped successor; races and third submission fail',async()=>{
  const f=await fixture();try{
    await f.transition();await f.authorize();
    await f.prepare(f.successor);
    const duplicate={...f.successor,attempt_id:'third',emission_nonce:'33333333-3333-4333-8333-333333333333'};
    await assert.rejects(f.prepare(f.successor));await assert.rejects(f.prepare(duplicate));
    assert.equal((await f.db.query('select count(*)::int n from lumi_provider_emission_journal')).rows[0].n,2);
    await assert.rejects(f.db.exec("update lumi_provider_emission_journal set response_metadata='{}' where attempt_id='first'"),/immutable/);
  }finally{await f.db.close();}
});

test('SQL: no arbitrary second attempt, forged recovery, expired authority, or exhausted budget',async()=>{
  const f=await fixture();try{
    await assert.rejects(f.prepare(f.successor),/authorization/);await f.transition();
    await assert.rejects(f.prepare({...f.successor,original_attempt_snapshot:null}),/scoped_recovery/);
    for(const patch of [m=>m.first_image.authorization.status='REVOKED',m=>m.first_image.authorization.expires_at='2020-01-01T00:00:00Z',
      m=>m.first_image.accepted={request_id:'job'},m=>m.budget_reservations['image:q41'].binding='wrong',
      m=>m.budget_reservations['rejected:first'].amount_usd=5]){
      await f.authorize(patch);await assert.rejects(f.prepare(f.successor));
    }
  }finally{await f.db.close();}
});

test('SQL: generic 402 and 500 are not balance evidence; anon/authenticated cannot submit',async()=>{
  const f=await fixture();try{
    await assert.rejects(f.transition(500),/evidence_required/);
    const permissions=await f.db.query(`select has_function_privilege('anon','lumi_prepare_emission_v1(jsonb)','execute') a,
      has_function_privilege('authenticated','lumi_prepare_emission_v1(jsonb)','execute') b,
      has_function_privilege('service_role','lumi_prepare_emission_v1(jsonb)','execute') c`);
    assert.deepEqual(permissions.rows[0],{a:false,b:false,c:true});
  }finally{await f.db.close();}
});

for(const stage of ['IMAGE','VIDEO'])test('SQL: generic '+stage+' recovery uses the same immutable journal and authorization',async()=>{
  const f=await fixture({stage,generic:true});try{
    await f.transition();await f.authorize();await f.prepare(f.successor);
    assert.equal((await f.db.query('select count(*)::int n from lumi_provider_emission_journal')).rows[0].n,2);
  }finally{await f.db.close();}
});
