import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {readFile,readdir} from 'node:fs/promises';
const dir=new URL('../supabase/migrations/',import.meta.url);
const sql=(await Promise.all((await readdir(dir)).filter(n=>/_lumi_trading_(paper|fencing_hardening)\.sql$/.test(n)).sort().map(n=>readFile(new URL(n,dir),'utf8')))).join('\n');
test('real SQL: durable CAS, fencing, idempotence, receipts, restart ambiguity and least privilege',async()=>{
  const db=new PGlite();try{
    await db.exec('create role anon;create role authenticated;create role service_role;');await db.exec(sql);
    const owner='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222',claim_id='33333333-3333-4333-8333-333333333333';let fence=1;
    const tx=async p=>(await db.query('select lumi_trading_tx($1::jsonb) v',[JSON.stringify({owner,fence,...p})])).rows[0].v;
    const s=await tx({phase:'ACQUIRE'});assert.equal(s.fence,1);assert.equal(s.revision,0);
    await assert.rejects(tx({phase:'RENEW',fence:null}),/LEASE_LOST/);
    await assert.rejects(tx({phase:'ACQUIRE',owner:null}),/OWNER_REQUIRED/);
    await assert.rejects(tx({phase:'ACQUIRE',owner:other}),/LEASE_BUSY/);
    const commit={phase:'COMMIT',batch:'one',revision:0,state:{schema:1,position:{entry:'101'}},events:[{id:'immutable',kind:'PLAN',payload:{stop:'90'}}],notices:[{id:'notice',kind:'TECHNICAL',payload:{test:true}}]};
    await tx(commit);await tx(commit);assert.equal((await db.query('select count(*) n from lumi_trading_events')).rows[0].n,1);
    await assert.rejects(tx({...commit,batch:'wrong'}),/CAS_CONFLICT/);
    const claim=await tx({phase:'CLAIM',id:'notice',claim_id});assert.equal(claim.status,'DISPATCHING');assert.equal((await tx({phase:'CLAIM',id:'notice',claim_id:other})).claim_id,claim_id);
    // Process dies after send: new holder never retries the ambiguous message.
    await db.exec("update lumi_trading_state set lease_until=now()-interval '1 second'");
    const recovered=await tx({phase:'ACQUIRE',owner:other});assert.equal(recovered.fence,2);assert.equal(recovered.state.position.entry,'101');
    assert.equal((await db.query('select status from lumi_trading_outbox')).rows[0].status,'UNKNOWN');
    await assert.rejects(tx({phase:'COMMIT',batch:'old',revision:1,state:{}}),/LEASE_LOST/);
    await db.exec('set role anon');await assert.rejects(db.query('select * from lumi_trading_events'),/permission denied/);await assert.rejects(db.query('select lumi_trading_tx($1::jsonb)',[JSON.stringify({phase:'ACQUIRE',owner})]),/permission denied/);
    await db.exec('reset role;set role service_role');await assert.rejects(db.query("update lumi_trading_events set payload='{}'"),/permission denied/);
  }finally{await db.close();}
});
test('real SQL: queued expired signal cannot be claimed as current after restart',async()=>{const db=new PGlite();try{await db.exec('create role anon;create role authenticated;create role service_role;');await db.exec(sql);const owner='11111111-1111-4111-8111-111111111111';const tx=async p=>(await db.query('select lumi_trading_tx($1::jsonb) v',[JSON.stringify({owner,fence:1,...p})])).rows[0].v;await tx({phase:'ACQUIRE'});await tx({phase:'COMMIT',batch:'b',revision:0,state:{},notices:[{id:'late',kind:'SIGNAL',payload:{plan:{decision_at:Date.now()-60000,expires_at:Date.now()+60000}}}]});assert.equal((await tx({phase:'CLAIM',id:'late',claim_id:owner})).status,'EXPIRED');}finally{await db.close();}});
