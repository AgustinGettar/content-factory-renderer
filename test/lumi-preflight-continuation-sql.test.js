import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
const sql=await readFile(new URL('../supabase/migrations/20261022120431_lumi_fenced_preflight_continuation.sql',import.meta.url),'utf8');
async function fixture(){
 const db=new PGlite();await db.exec(`create role anon;create role authenticated;create role service_role;
 create table lumi_pilot_runs(id uuid,scene_id text,stage text,provider_request_id text,provider_calls integer);`);
 for(const path of ['supabase/migrations/20261004010000_lumi_recovery_incident_manager_v1.sql','docs/provider-emission-journal-v1.sql','supabase/migrations/20261006103125_lumi_telegram_review_v1.sql'])await db.exec(await readFile(new URL('../'+path,import.meta.url),'utf8'));
 await db.exec(sql);
 const key='video:take3',attempt='same-attempt',episode='ep_fixture_005',nonce=randomUUID(),lease=randomUUID(),semantic='s'.repeat(64).replaceAll('s','a');
 const value={scope:'EPISODE_PLAN_SPEND_V1',decision:'APPROVED',expires_at:new Date(Date.now()+3600000).toISOString(),action_set:[key],model:{[key]:'kling'},per_action_limits:{[key]:.6},maximum_episode_exposure:8};
 const work={id:'same-job',lease_token:lease,lease_until:Date.now()+120000,status:'RUNNING',activated_by:'AUTHENTICATED_MINI_APP_PRODUCE_CLICK',plan_authorization_id:'plan'};
 const state={user_id:'1',chat_id:'1',message_id:1,mini_app:{episode_jobs:{[episode]:work}},v2_authorizations:{plan:{status:'AUTHORIZED',seal:'seal',value}},production_commands:{[attempt]:{status:'STARTED'}}};
 const metadata={user:'1',runtime_revision:52,budget_reservations:{[key]:{amount_usd:.56,binding:'b',attempt_id:attempt},'ambiguous-original':{amount_usd:.3275,attempt_id:'unknown'}}};
 await db.query(`insert into lumi_pipeline_checkpoints(episode_id,pipeline_version,preset_version,status,authorized_ceiling_usd,first_pending_action,actions,metadata) values($1,'v1_1_2','1.1.2','RUNNING',8,$2,$3,$4)`,[episode,key,JSON.stringify([{key,stage:'VIDEO',scene_id:'take3',active_attempt_id:attempt,status:'PENDING',dispatch_state:'DISPATCHING'}]),JSON.stringify(metadata)]);
 await db.query(`insert into lumi_telegram_review_sessions(user_id,chat_id,message_id,state) values(1,1,1,$1)`,[JSON.stringify(state)]);
 const record={attempt_id:attempt,version:'PROVIDER_EMISSION_JOURNAL_V1',episode_id:episode,scene_id:'take3',stage:'VIDEO',provider:'higgsfield_api',model:'kling',expected_cost_usd:.448,prompt_hash:'prompt',payload_fingerprint:'b',request_fingerprint:'req',payload_descriptor:{identity:{quote_id:'original'},json:{prompt:'unchanged'}},emission_nonce:nonce,state:'PREPARED',prepared_at:new Date().toISOString()};
 await db.query('select lumi_prepare_emission_v1($1)',[JSON.stringify(record)]);
 const fence=async(n=randomUUID(),l=lease)=>{await db.query('select lumi_fence_preflight_v1($1,$2,1,$3,$4,$5,$6)',[attempt,n,work.id,l,semantic,'b']);return n;};
 const version={episode_id:episode,action_key:key,model:'kling',reservation_usd:.56,quote_usd:.448,expires_at:new Date(Date.now()+60000).toISOString(),semantic_sha256:semantic,payload_sha256:'new-url-hash',remaining_plan_reservation_usd:0,plan_seal:'seal'};
 const commit=(n,v=version,l=lease)=>db.query('select lumi_commit_preflight_v1($1,$2,1,$3,$4,$5)',[attempt,n,work.id,l,JSON.stringify(v)]);
 const journal=async()=>(await db.query('select * from lumi_provider_emission_journal')).rows[0];
 return {db,fence,commit,journal,version,record,lease,attempt,key,episode};
}
test('PREFLIGHT_SQL same logical attempt fences old binary; immutable fingerprints and one reservation; no third emission',async()=>{
 const f=await fixture();try{const n=await f.fence();
  const old=await f.db.query("update lumi_provider_emission_journal set state='EMITTING' where attempt_id=$1 and state='PREPARED' returning *",[f.attempt]);assert.equal(old.rows.length,0);
  await f.commit(n);await assert.rejects(f.commit(n));await assert.rejects(f.fence());
  const j=await f.journal();assert.equal(j.state,'EMITTING');assert.equal(j.payload_fingerprint,f.record.payload_fingerprint);assert.equal(j.request_fingerprint,f.record.request_fingerprint);assert.equal(j.expected_cost_usd,'0.448000000');assert.deepEqual(j.payload_descriptor.json,f.record.payload_descriptor.json);assert.equal(j.payload_descriptor.preflight_versions.length,1);
  const cp=(await f.db.query('select metadata from lumi_pipeline_checkpoints')).rows[0].metadata;
  assert.equal(Object.keys(cp.budget_reservations).length,2);assert.equal(cp.budget_reservations[f.key].amount_usd,.56);assert.equal(cp.budget_reservations['ambiguous-original'].amount_usd,.3275);
 }finally{await f.db.close();}
});
test('PREFLIGHT_SQL expired quote, budget race, expired lease and late old worker cannot dispatch; delta-only reservation',async()=>{
 const f=await fixture();try{const first=await f.fence(),second=await f.fence();await assert.rejects(f.commit(first));
  await assert.rejects(f.commit(second,{...f.version,expires_at:'2000-01-01Z'}),/PREFLIGHT_QUOTE_EXPIRED/);
  await assert.rejects(f.commit(second,f.version,'wrong-lease'));
  await assert.rejects(f.commit(second,{...f.version,reservation_usd:.7}));
  await assert.rejects(f.commit(second,{...f.version,remaining_plan_reservation_usd:8}));
  await assert.rejects(f.commit(second,{...f.version,semantic_sha256:'b'.repeat(64)}));
  await f.commit(second,{...f.version,reservation_usd:.575});
  const r=(await f.db.query('select metadata from lumi_pipeline_checkpoints')).rows[0].metadata.budget_reservations[f.key];assert.equal(r.amount_usd,.575);assert.equal(r.preflight_history[0].amount_usd,.56);
 }finally{await f.db.close();}
});
test('PREFLIGHT_SQL response loss after transport remains immutable and cannot be fenced',async()=>{
 const f=await fixture();try{await f.db.exec("update lumi_provider_emission_journal set state='EMITTING';update lumi_provider_emission_journal set state='EMISSION_UNKNOWN',response_parsing_outcome='NO_RESPONSE'");await assert.rejects(f.fence());
  await f.db.exec('set role anon');await assert.rejects(f.fence(),/permission denied/);
 }finally{await f.db.close();}
});
