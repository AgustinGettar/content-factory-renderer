import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash,createHmac,randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {MiniAppAuth} from '../lib/telegram-mini-app/auth.js';
import {LumiRecoveryIncidentManager} from '../lib/lumi-recovery-incident-manager-v1.js';
import {ReviewStageReceiptStore} from '../lib/lumi-v2-execution-orchestrator.js';
import {buildReplacementProposal,recoveryDigest,replacementPresentation} from '../lib/lumi-supervised-replacement.js';
import {supervisedReservation,estimateHiggsfieldUsd} from '../lib/higgsfield-usd-budget-v1.js';
import {quoteSupervisedPayload} from '../lib/lumi-supervised-runtime-bindings.js';
import {installSupervisedActivation} from '../lib/lumi-supervised-activation.js';
const hash=s=>createHash('sha256').update(s).digest('hex');
const migration=await readFile(new URL('../supabase/migrations/20261018233719_lumi_supervised_replacement_activation.sql',import.meta.url),'utf8');
const schema=`create role anon; create role authenticated; create role service_role;
 create table lumi_pipeline_checkpoints(episode_id text primary key,pipeline_version text,preset_version text,status text,runner_enabled boolean,autorun boolean,current_cost_usd numeric,authorized_ceiling_usd numeric,last_completed_action text,first_pending_action text,active_incident_id uuid,cancellation_reason text,actions jsonb,metadata jsonb,created_at timestamptz,updated_at timestamptz);
 create table lumi_telegram_review_sessions(user_id bigint primary key,chat_id bigint,message_id bigint,revision bigint,state jsonb,updated_at timestamptz);
 create table lumi_provider_emission_journal(attempt_id text primary key,version text,episode_id text,scene_id text,stage text,provider text,model text,expected_cost_usd numeric,prompt_hash text,payload_fingerprint text,request_fingerprint text,payload_descriptor jsonb,emission_nonce uuid,state text,prepared_at timestamptz,request_start_at timestamptz,acknowledged_at timestamptz,request_end_at timestamptz,http_status integer,provider_request_id text,transport_error text,response_parsing_outcome text,incident_classification text,response_metadata jsonb,human_override jsonb,original_attempt_snapshot jsonb,potential_unconfirmed_cost_exposure jsonb);
 create unique index lumi_emission_active_scope on lumi_provider_emission_journal(episode_id,scene_id,stage) where incident_classification is distinct from 'INSUFFICIENT_PROVIDER_BALANCE';`;
const env={LUMI_RUNTIME_ENV:'staging',SUPABASE_URL:'https://mofjhwathxzfnjapvvst.supabase.co',LUMI_TELEGRAM_BOT_TOKEN:'synthetic-token',LUMI_TELEGRAM_CALLBACK_SECRET:'synthetic-test-secret'};
function initData(nonce){const p=new URLSearchParams({auth_date:String(Math.floor(Date.now()/1000)),user:JSON.stringify({id:1}),query_id:nonce});
 const body=[...p.entries()].sort().map(([k,v])=>k+'='+v).join('\n'),key=createHmac('sha256','WebAppData').update(env.LUMI_TELEGRAM_BOT_TOKEN).digest();
 p.set('hash',createHmac('sha256',key).update(body).digest('hex'));return p.toString();}
async function fixture({episode='ep005_synthetic',stage='IMAGE',fetchHook=null,afterActivate=null}={}){
 const db=new PGlite();await db.exec(schema);await db.exec(migration);await db.exec(await readFile(new URL('../supabase/migrations/20261019003616_lumi_supervised_durable_consent.sql',import.meta.url),'utf8'));
 await db.exec(await readFile(new URL('../supabase/migrations/20261019010401_lumi_cost_traceability.sql',import.meta.url),'utf8'));
 const oldMigration=await readFile(new URL('../supabase/migrations/20261011215758_lumi_balance_recovery.sql',import.meta.url),'utf8');
 await db.exec(oldMigration.slice(oldMigration.indexOf('create or replace function public.lumi_emission_immutable_v1()'),oldMigration.lastIndexOf('commit;')));
 await db.exec('create trigger immutable before update on lumi_provider_emission_journal for each row execute function lumi_emission_immutable_v1()');
 const json=async(sql,args=[])=> (await db.query(sql,args)).rows[0]?.value;
 const insert=async(table,v)=>db.query(`insert into ${table} select (jsonb_populate_record(null::${table},$1)).*`,[JSON.stringify(v)]);
 const cpId=episode,action=stage.toLowerCase()+':s2',attempt=hash(episode+':original-attempt'),opId=hash(episode+':original-operation');
 const cp={episode_id:cpId,pipeline_version:'v1_1_2',preset_version:'1.1.2',status:'PAUSED_INCIDENT',runner_enabled:false,autorun:false,current_cost_usd:0,authorized_ceiling_usd:8,
  last_completed_action:'shot_review:s1',first_pending_action:action,actions:[{key:'shot_review:s1',scene_id:'s1',stage:'SHOT_REVIEW',status:'COMPLETE',evidence:{provider_succeeded:true,artifact_persisted:true,sha_verified:true,artifact_verified:true}},{key:action,stage,scene_id:'s2',status:'PENDING',dispatch_state:'DISPATCHING',active_attempt_id:attempt}],
  metadata:{user:'1',runtime_revision:23,provider_generation_authorized:false,publication_enabled:false,review_requests:{q41:{status:'APPROVED'}},budget_reservations:{[action]:{status:'RESERVED_UNTIL_ACTUAL_CHARGE_VERIFIED',attempt_id:attempt,amount_usd:.3275}}}};
 const j={attempt_id:attempt,version:'PROVIDER_EMISSION_JOURNAL_V1',episode_id:cpId,scene_id:'s2',stage,provider:'higgsfield_api',model:stage==='IMAGE'?'marketing-studio/image':'kling-video/v3.0/pro/image-to-video',state:'EMISSION_UNKNOWN',response_parsing_outcome:'NO_RESPONSE',response_metadata:{transport_invoked:true}};
 const authorization={status:'AUTHORIZED',decision:'APPROVED',policy:{episode_id:cpId,action_key:action,authorization_id:'original-grant'}};
 const operation={id:opId,kind:'second_image',status:'BLOCKED',binding:{proposal_id:cpId,next_action:action},consent:{value:{authorization_id:'original-grant',operation_id:opId}}};
 await insert('lumi_pipeline_checkpoints',cp);await insert('lumi_provider_emission_journal',j);
 const getCp=id=>json('select to_jsonb(c) value from lumi_pipeline_checkpoints c where episode_id=$1',[id]);
 const getJ=id=>json('select to_jsonb(j) value from lumi_provider_emission_journal j where attempt_id=$1',[id]);
 const proposal=buildReplacementProposal({checkpoint:await getCp(cpId),operation,journal:await getJ(attempt),authorization,budget:{episode_ceiling_usd:8,required_total_usd:.3275},maximumNewReservation:.3275,createdAt:new Date(Date.now()-1000).toISOString()});
 await insert('lumi_telegram_review_sessions',{user_id:1,chat_id:1,revision:1,state:{user_id:'1',chat_id:'1',episodes:{[cpId]:{episode_id:cpId}},mini_app:{sessions:{},exchanges:{},operations:{[opId]:operation},active_episode_id:cpId},v2_authorizations:{'original-grant':authorization},supervised_replacement_proposals:{[proposal.replacement_proposal_id]:proposal},unrelated:{keep:true},recovery_state:'NONE'}});
 const reviewStore={get:async()=>{const r=await db.query('select revision,state from lumi_telegram_review_sessions where user_id=1');return r.rows[0];},cas:async(user,rev,state)=>{
  const r=await db.query('update lumi_telegram_review_sessions set state=$1,revision=revision+1 where user_id=1 and revision=$2 returning revision,state',[JSON.stringify(state),rev]);if(!r.rows.length)throw Error('concurrent_update');return r.rows[0];}};
 const tx=async p=>{const result=await json('select lumi_supervised_replacement_v1($1) value',[JSON.stringify(p)]);if(p.phase==='ACTIVATE'&&afterActivate)await afterActivate({db,reviewStore,p});return result;};
 const store={getEpisode:getCp,supervisedReplacementTransaction:tx};
 const manager=new LumiRecoveryIncidentManager({store});
 const journal={get:getJ,transition:async(id,from,patch)=>{
  const entries=Object.entries(patch),args=[id,from,...entries.map(([,v])=>typeof v==='object'?JSON.stringify(v):v)];
  const r=await db.query('update lumi_provider_emission_journal set '+entries.map(([k],i)=>k+'=$'+(i+3)).join(',')+' where attempt_id=$1 and state=$2 returning to_jsonb(lumi_provider_emission_journal) value',args);
  if(!r.rows.length)throw Error('emission_transition_rejected');return r.rows[0].value;}};
 const auth=new MiniAppAuth({store:reviewStore,validateOwner:async u=>u==='1',env});
 const login=await auth.login(initData(episode)),principal=await auth.authenticate(login.cookie,login.csrf);
 let quotes=0,calls=0;const sent=[];
 const controls={content:'Synthetic only',token:'1',quoteError:null,quoteExpired:false,beforeQuote:null,quoteAmount:.262,realEstimator:false};
 const payload=()=>JSON.stringify({prompt:controls.content,image_url:'https://example.invalid/source?token='+controls.token,sound:'off',duration:4,multi_shots:false,cfg_scale:.5});
 const adapter={};
 installSupervisedActivation(adapter,{manager,reviewStore,journal,validateOwner:async u=>u==='1',secret:env.LUMI_TELEGRAM_CALLBACK_SECRET,
  buildPayload:async()=>({payload_sha256:hash(payload()),approved_content_fingerprint:hash(controls.content),private_payload:{synthetic:payload()},expires_at:new Date(Date.now()+120000).toISOString()}),openPayload:v=>v.synthetic,
  quotePayload:async(c,g,body)=>{quotes++;if(controls.beforeQuote)await controls.beforeQuote();if(controls.quoteError)throw Error(controls.quoteError);if(controls.realEstimator)return quoteSupervisedPayload({proposal:c.proposal,grant:g,body,env:{HF_API_KEY:'mock-only'},fetchImpl:async(url,options)=>{assert.equal(url,'https://api.higgsfield.ai/estimate/'+j.model);assert.equal(options.body,body);return new Response(JSON.stringify({usd:String(controls.quoteAmount)}),{status:200,headers:{'x-request-id':'synthetic-estimate-id'}});}});return {episode_id:cpId,action_id:action,replacement_proposal_id:proposal.replacement_proposal_id,operation_id:proposal.planned_operation_id,attempt_id:proposal.planned_attempt_id,model:j.model,currency:'USD',status:'QUOTED',payload_sha256:hash(body),quote_id:'synthetic-quote',created_at:new Date().toISOString(),expires_at:new Date(Date.now()+(controls.quoteExpired?-1000:50000)).toISOString(),estimate_usd:controls.quoteAmount,reserve_usd:supervisedReservation(controls.quoteAmount)};},
  submitPayload:Object.assign(async({submit,payload})=>{const r=await submit('https://api.higgsfield.ai/'+j.model,{method:'POST',headers:{'content-type':'application/json'},body:payload});return r.json();},{fetch:async(url,opts)=>{calls++;sent.push({url,idempotency:opts.headers.get('Idempotency-Key')});if(fetchHook)return fetchHook();return new Response(JSON.stringify({request_id:'synthetic-job',status_url:'https://api.higgsfield.ai/requests/synthetic-job/status'}),{status:200,headers:{'content-type':'application/json'}});}}),
  receiptsFor:user=>new ReviewStageReceiptStore({store:reviewStore,user}),recoverResult:async(p,c,id)=>{const jr=await getJ(id),receipt=(await reviewStore.get()).state.production_commands?.[id];
   if(id===attempt){const cp=await getCp(cpId);assert.equal(cp.actions[1].active_attempt_id,attempt);assert.equal(cp.metadata.supervised_original_recoveries[attempt].provider_request_id,receipt.result.provider_job_ids[0]);}
   else {assert.equal(jr.state,'ACKNOWLEDGED');assert.equal(receipt.result.provider_job_ids[0],jr.provider_request_id);}
   return {status:'AWAITING_HUMAN_REVIEW',provider_calls:0};}});
 const review=()=>adapter.reviewSupervisedReplacement(principal,proposal.replacement_proposal_id);
 const accept=async()=>{const r=await review();return adapter.acceptSupervisedReplacement(principal,{challenge:r.challenge,accept_duplicate_risk:true});};
 const generate=async(p=principal)=>adapter.generateSupervisedReplacement(p,{proposal_id:proposal.replacement_proposal_id,authorization_reference:(await reviewStore.get()).state.supervised_replacement_grants?.[proposal.replacement_proposal_id]?.authorization_reference??null,confirmation_id:randomUUID(),confirm:true});
 return {controls,db,json,insert,tx,getCp,getJ,cpId,action,attempt,operation,authorization,proposal,reviewStore,manager,journal,auth,login,principal,adapter,review,accept,generate,sent,counts:()=>({quotes,calls}),close:()=>db.close()};
}

test('AUTHENTICATED_RISK_GATE / ORIGINAL_JOURNAL_PRESERVED: read and consent do not reserve or emit; forged identities and altered disclosure fail',async t=>{
 const f=await fixture();t.after(f.close);const before=await f.getCp(f.cpId),j=await f.getJ(f.attempt);
 await assert.rejects(f.adapter.reviewSupervisedReplacement({...f.principal},f.proposal.replacement_proposal_id),/SESSION/);
 await assert.rejects(f.generate(),/SEAL/);
 const r=await f.review();assert.equal(r.combined_exposure_usd,.655);assert.equal(r.hard_budget_usd,8);
 await assert.rejects(f.adapter.acceptSupervisedReplacement(f.principal,{challenge:r.challenge,accept_duplicate_risk:false}),/EXPLICIT/);
 await assert.rejects(f.adapter.acceptSupervisedReplacement(f.principal,{challenge:{...r.challenge,maximum_reservation_usd:1},accept_duplicate_risk:true}),/SEAL/);
 await f.adapter.acceptSupervisedReplacement(f.principal,{challenge:r.challenge,accept_duplicate_risk:true});
 await assert.rejects(f.adapter.generateSupervisedReplacement(f.principal,{proposal_id:f.proposal.replacement_proposal_id,authorization_reference:'stale',confirmation_id:randomUUID(),confirm:true}),/CONSENT_CHANGED/);
 assert.equal((await f.adapter.acceptSupervisedReplacement(f.principal,{challenge:r.challenge,accept_duplicate_risk:true})).already_applied,true);
 const s=(await f.reviewStore.get()).state,g=s.supervised_replacement_grants[f.proposal.replacement_proposal_id];
 for(const key of ['payload_sha256','human_identity','consent_timestamp','shot_id','action_id','risk_disclosure_version','maximum_reservation_usd'])assert.ok(g[key]);
 assert.deepEqual(await f.getCp(f.cpId),before);assert.deepEqual(await f.getJ(f.attempt),j);assert.deepEqual(s.supervised_replacement_proposals[f.proposal.replacement_proposal_id],f.proposal);
 assert.deepEqual(f.counts(),{quotes:0,calls:0});assert.equal(Object.keys(s.mini_app.operations).length,1);
});
test('CONCURRENT_RISK_ACCEPTANCE / DOUBLE_CLICK / SESSION_REOPEN: one atomic claim, independent idempotency, both reserves and preserved originals',async t=>{
 const f=await fixture();t.after(f.close);const old=await f.getJ(f.attempt),r=await f.review();
 const decisions=await Promise.allSettled([1,2].map(()=>f.adapter.acceptSupervisedReplacement(f.principal,{challenge:r.challenge,accept_duplicate_risk:true})));
 assert.ok(decisions.some(r=>r.status==='fulfilled'));
 const session=await f.auth.login(initData('reopen')),p=await f.auth.authenticate(session.cookie,session.csrf);
 const outcomes=await Promise.allSettled([f.generate(p),f.generate(p)]);assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1);
 assert.deepEqual(f.counts(),{quotes:1,calls:1});const cp=await f.getCp(f.cpId);
 assert.equal(Object.keys(cp.metadata.budget_reservations).length,2);assert.equal(cp.metadata.budget_reservations[f.action].amount_usd,.3275);
 assert.equal(cp.metadata.budget_reservations['replacement:'+f.proposal.planned_attempt_id].amount_usd,.3275);
 assert.equal(cp.authorized_ceiling_usd,8);assert.equal(cp.first_pending_action,f.action);assert.equal(cp.last_completed_action,'shot_review:s1');
 assert.equal(cp.metadata.review_requests.q41.status,'APPROVED');assert.deepEqual(await f.getJ(f.attempt),old);
 assert.equal(f.sent[0].idempotency,f.proposal.planned_idempotency_key);assert.notEqual(f.sent[0].idempotency,f.attempt);
 await assert.rejects(f.generate(p),/EVIDENCE|ALREADY|IDENTITY|PAUSED/);assert.equal(f.counts().calls,1);
 assert.equal((await f.adapter.recoverSupervisedReplacement(p,f.proposal.replacement_proposal_id)).status,'AWAITING_HUMAN_REVIEW');
 assert.equal(f.counts().calls,1);
});
test('PROVIDER_TIMEOUT / AMBIGUOUS_RESULT: committed new reservation and journal survive; never submit a third request',async t=>{
 const f=await fixture({fetchHook:()=>{throw Error('SYNTHETIC_TIMEOUT');}});t.after(f.close);await f.accept();await assert.rejects(f.generate(),/TIMEOUT/);
 const j=await f.getJ(f.proposal.planned_attempt_id);assert.equal(j.state,'EMISSION_UNKNOWN');assert.equal(j.response_parsing_outcome,'NO_RESPONSE');
 assert.equal(Object.keys((await f.getCp(f.cpId)).metadata.budget_reservations).length,2);
 await assert.rejects(f.generate());await assert.rejects(f.adapter.recoverSupervisedReplacement(f.principal,f.proposal.replacement_proposal_id));assert.equal(f.counts().calls,1);
});
test('CAS_CONFLICT / BUDGET_RACE / QUOTE_EXPIRATION / STALE_UI_RESPONSE: transactional denial leaves no new operation, reservation or journal',async t=>{
 const f=await fixture();t.after(f.close);const r=await f.review();
 await f.db.query("update lumi_pipeline_checkpoints set metadata=jsonb_set(metadata,'{runtime_revision}','24') where episode_id=$1",[f.cpId]);
 await assert.rejects(f.adapter.acceptSupervisedReplacement(f.principal,{challenge:r.challenge,accept_duplicate_risk:true}),/EVIDENCE_CHANGED/);
 await f.db.query("update lumi_pipeline_checkpoints set metadata=jsonb_set(metadata,'{runtime_revision}','23') where episode_id=$1",[f.cpId]);
 await f.accept();const row=await f.reviewStore.get(),p=f.proposal,g=row.state.supervised_replacement_grants[p.replacement_proposal_id];
 const base={phase:'QUOTE_CLAIM',user_id:'1',session_id:f.principal.session,proposal_id:p.replacement_proposal_id,expected_revision:row.revision,checkpoint:await f.getCp(f.cpId),original_journal:await f.getJ(f.attempt),original_operation:f.operation,original_authorization:f.authorization,grant:g,quote_claim:{claim_id:randomUUID(),authorization_reference:g.authorization_reference,payload_sha256:g.payload_sha256,approved_content_fingerprint:g.approved_content_fingerprint,seal:'a'.repeat(64),expires_at:new Date(Date.now()+50000).toISOString()}};
 await assert.rejects(f.tx({...base,expected_revision:0}),/CAS_CONFLICT/);
 await f.tx(base);
 const quote={quote_claim_id:base.quote_claim.claim_id,episode_id:f.cpId,action_id:f.action,replacement_proposal_id:p.replacement_proposal_id,operation_id:p.planned_operation_id,attempt_id:p.planned_attempt_id,model:p.model,currency:'USD',status:'QUOTED',payload_sha256:g.payload_sha256,quote_id:'q',created_at:new Date().toISOString(),expires_at:new Date(Date.now()-1).toISOString(),estimate_usd:.262,reserve_usd:.3275};
 const input={...base,phase:'ACTIVATE',expected_revision:(await f.reviewStore.get()).revision,quote};
 await assert.rejects(f.tx(input),/FRESH_QUOTE/);
 // Separate source liability changes while the target checkpoint stays identical.
 await f.insert('lumi_pipeline_checkpoints',{episode_id:'ep005_independent_source_liability',current_cost_usd:7.5,metadata:{target_episode:f.cpId,budget_reservations:{}}});
 const freshQuote={...quote,expires_at:new Date(Date.now()+40000).toISOString(),economic_decision:{payload_sha256:g.payload_sha256,authorized_max_usd:.3275}};
 await f.tx({...base,phase:'QUOTE_RESULT',quote:freshQuote,quote_only:false});
 await assert.rejects(f.tx({...input,expected_revision:(await f.reviewStore.get()).revision,quote:freshQuote}),/DOUBLE_EXPOSURE/);
 assert.equal(await f.getJ(p.planned_attempt_id),undefined);assert.equal(Object.keys((await f.getCp(f.cpId)).metadata.budget_reservations).length,1);assert.equal(f.counts().calls,0);
});
test('ORIGINAL_RESULT_APPEARS_LATE: before claim blocks replacement; after emission keeps both records and discloses duplicate risk',async t=>{
 const f=await fixture();t.after(f.close);await f.accept();
 const addOriginal=async()=>{const r=await f.reviewStore.get();r.state.production_commands={[f.attempt]:{status:'WAITING',result:{provider_job_ids:['late-original'],output:{request_id:'late-original'}}},...r.state.production_commands};await f.reviewStore.cas('1',r.revision,r.state);};
 await addOriginal();await assert.rejects(f.generate(),/ORIGINAL_RESULT/);assert.equal(f.counts().calls,0);
 const r=await f.reviewStore.get();delete r.state.production_commands[f.attempt];await f.reviewStore.cas('1',r.revision,r.state);
 await f.generate();await addOriginal();const result=await f.adapter.recoverSupervisedReplacement(f.principal,f.proposal.replacement_proposal_id);
 assert.equal(result.original_result_visible,true);assert.equal(result.possible_duplicate_charge,true);assert.equal(f.counts().calls,1);
 assert.equal(await f.json('select count(*)::integer value from lumi_provider_emission_journal'),2);
});
test('MULTI_EPISODE_REUSE EP006 video: same authenticated transaction and recovery, no provider network',async t=>{
 const f=await fixture({episode:'ep006_synthetic',stage:'VIDEO'});t.after(f.close);assert.match((await f.review()).risk_disclosure,/este video/);
 await f.accept();await f.generate();assert.equal((await f.getJ(f.proposal.planned_attempt_id)).stage,'VIDEO');
 await f.adapter.recoverSupervisedReplacement(f.principal,f.proposal.replacement_proposal_id);assert.equal(f.counts().calls,1);
 const permissions=await f.db.query("select has_function_privilege('anon','lumi_supervised_replacement_v1(jsonb)','execute') anon,has_function_privilege('authenticated','lumi_supervised_replacement_v1(jsonb)','execute') authenticated,has_function_privilege('service_role','lumi_supervised_replacement_v1(jsonb)','execute') service");
 assert.deepEqual(permissions.rows[0],{anon:false,authenticated:false,service:true});assert.equal(globalThis.LUMI_OFFLINE_GUARD.attempts.length,0);
});

test('ORIGINAL_RESULT_APPEARS_BEFORE_TRANSPORT: final transactional check stops prepared replacement without releasing either reserve',async t=>{
 const f=await fixture({afterActivate:async({reviewStore,p})=>{
  const row=await reviewStore.get();row.state.production_commands[p.original_journal.attempt_id]={status:'WAITING',episode_id:p.checkpoint.episode_id,action_key:p.grant.action_id,result:{episode_id:p.checkpoint.episode_id,stage_id:'IMAGE',provider_job_ids:['late-original'],output:{request_id:'late-original',status_url:'https://api.higgsfield.ai/requests/late-original/status'}}};
  await reviewStore.cas('1',row.revision,row.state);
 }});t.after(f.close);await f.accept();await assert.rejects(f.generate(),/ORIGINAL_RESULT/);
 assert.equal(f.counts().calls,0);assert.equal((await f.getJ(f.proposal.planned_attempt_id)).state,'PREPARED');
 assert.equal(Object.keys((await f.getCp(f.cpId)).metadata.budget_reservations).length,2);
 await assert.rejects(f.generate());assert.equal(f.counts().calls,0);
 const recovered=await f.adapter.recoverSupervisedReplacement(f.principal,f.proposal.replacement_proposal_id);assert.equal(recovered.status,'AWAITING_HUMAN_REVIEW');
 assert.equal((await f.getJ(f.attempt)).state,'EMISSION_UNKNOWN');assert.equal((await f.getJ(f.proposal.planned_attempt_id)).state,'PREPARED');
});
test('CAS_CONFLICT_AT_DISPATCH: no emission after the atomic reservation if the final state changes',async t=>{
 const f=await fixture({afterActivate:async({db,p})=>{
  await db.query("update lumi_pipeline_checkpoints set status='PAUSED_INCIDENT' where episode_id=$1",[p.checkpoint.episode_id]);
 }});t.after(f.close);await f.accept();await assert.rejects(f.generate(),/DISPATCH_CAS/);
 assert.equal(f.counts().calls,0);assert.equal((await f.getJ(f.proposal.planned_attempt_id)).state,'PREPARED');
});

test('HTTP_RISK_GATE: Origin, CSRF and cookie validation precede the same durable acceptance; body cannot select another owner',async t=>{
 const {mountMiniApp}=await import('../lib/telegram-mini-app/runtime.js');const f=await fixture();t.after(f.close);
 const routes=new Map(),middleware=[];const app={use:(path,fn)=>middleware.push(fn),get:(path,fn)=>routes.set('GET '+path,fn),post:(path,fn)=>routes.set('POST '+path,fn)};
 mountMiniApp(app,{db:{},store:f.reviewStore,adapter:f.adapter,env,validateOwner:async u=>u==='1',configureEntry:false,configureLibrary:false});
 const invoke=async(path,body,headers={})=>{
  const req={method:'POST',headers:{origin:'https://content-factory-av2-staging.onrender.com','content-type':'application/json',cookie:'__Secure-lumi_studio='+f.login.cookie,'x-lumi-csrf':f.login.csrf,...headers},body};
  let status=200,value,go=false;const res={set:()=>res,status:n=>(status=n,res),json:v=>{value=v;return res;}};
  middleware[0](req,res,()=>{go=true;});if(go)await routes.get('POST /lumi/studio/api/replacement/'+path)(req,res);
  return {status,value};
 };
 const r=await f.review(),body={challenge:r.challenge,accept_duplicate_risk:true};
 assert.equal((await invoke('accept',body,{origin:'https://evil.invalid'})).status,403);
 assert.equal((await invoke('accept',body,{'x-lumi-csrf':'forged'})).status,401);
 assert.equal((await invoke('accept',body,{cookie:'wrong'})).status,401);
 assert.equal((await invoke('accept',{...body,user_id:'other'})).status,409);
 assert.equal((await invoke('accept',body)).status,200);
 assert.deepEqual(f.counts(),{quotes:0,calls:0});assert.equal(Object.keys((await f.getCp(f.cpId)).metadata.budget_reservations).length,1);
 const grant=(await f.reviewStore.get()).state.supervised_replacement_grants[f.proposal.replacement_proposal_id];
 const priceBody={proposal_id:f.proposal.replacement_proposal_id,authorization_reference:grant.authorization_reference,confirmation_id:randomUUID(),confirm:true};
 assert.equal((await invoke('quote',priceBody,{origin:'https://evil.invalid'})).status,403);
 assert.equal((await invoke('quote',priceBody,{'x-lumi-csrf':'forged'})).status,401);
 assert.equal((await invoke('quote',{...priceBody,generate:true})).status,409);
 assert.deepEqual(f.counts(),{quotes:0,calls:0});
 assert.equal((await invoke('quote',priceBody)).value.status,'QUOTE_RECORDED');
 assert.deepEqual(f.counts(),{quotes:1,calls:0});assert.equal(Object.keys((await f.getCp(f.cpId)).metadata.budget_reservations).length,1);
});

test('MINI_APP_RISK_UI / STALE_UI_RESPONSE: explicit unchecked consent and separate generation; progress is GET only',async()=>{
 const {runInNewContext}=await import('node:vm');const elements=new Map(),get=id=>{if(!elements.has(id))elements.set(id,{innerHTML:'',textContent:'',disabled:false,checked:false});return elements.get(id);};
 let pending;const requests=[];
 const box={document:{querySelector:get,addEventListener(){},querySelectorAll:()=>[]},window:{},crypto:{randomUUID},localStorage:{getItem:()=>null},setInterval(){},setTimeout(){return 1;},clearTimeout(){},AbortController,
  fetch:async(url,options)=>{requests.push({url,method:options.method});return new Promise(resolve=>{pending=v=>resolve({ok:true,json:async()=>v});});}};
 const js=await readFile(new URL('../public/lumi-studio/app.js',import.meta.url),'utf8');
 runInNewContext(js.replace('navigation();login();','')+`\nglobalThis.init=s=>{state=s;csrf='local';};globalThis.openRisk=reviewReplacement;globalThis.openQuote=confirmReplacementQuote;globalThis.bump=()=>mutationEpoch++;globalThis.card=()=>quoteCard();`,box);
 get('#confirmation').showModal=()=>{get('#confirmation').open=true;};get('#confirmation').close=()=>{get('#confirmation').open=false;};
 const state={episode:{id:'ep005_synthetic',checkpoint_version:23},supervised_replacement:{proposal_id:'p',risk_review_available:true,status:'REPLACEMENT_PROPOSAL',previous_reservation_usd:.3275,estimated_new_reservation_usd:.3275,combined_exposure_usd:.655,available_budget_usd:6.77375,authorization_status:'NOT_GRANTED',generation_enabled:false},budget:{ceiling_usd:8},capabilities:{}};
 box.init(state);assert.match(box.card(),/Revisar riesgo y autorización/);assert.match(box.card(),/disabled>Generar reemplazo/);
 const late=box.openRisk();box.bump();pending({challenge:{expires_at:new Date(Date.now()+60000).toISOString()}});await late;assert.notEqual(get('#confirmation').open,true);
 const current=box.openRisk();pending({challenge:{expires_at:new Date(Date.now()+60000).toISOString()},risk_disclosure:'Riesgo',maximum_reservation_usd:.3275});await current;
 assert.equal(get('#dialog-confirm').disabled,true);assert.equal(get('#replacement-risk-check').checked,false);
 assert.equal(requests.length,2);assert.ok(requests.every(r=>r.method==='GET'));
 get('#replacement-risk-check').onchange({target:{checked:true}});assert.equal(get('#dialog-confirm').disabled,false);assert.equal(requests.length,2);
 state.supervised_replacement={...state.supervised_replacement,authorization_status:'HUMAN_RISK_ACCEPTANCE',authorization_reference:'valid',quote_only_available:true,
   economic_decision:{status:'BLOCKED',quote_amount_usd:.271,reservation_multiplier:1.25,calculated_reservation_usd:.33875,authorized_max_usd:.3275,episode_remaining_usd:6.77375}};
 assert.match(box.card(),/Aceptación específica registrada/);assert.match(box.card(),/Consultar cotización sin generar/);assert.match(box.card(),/0,33875/);
 assert.match(box.card(),/disabled>Generar reemplazo/);box.openQuote();assert.equal(get('#dialog-confirm').textContent,'Consultar y guardar cotización');
 assert.equal(requests.length,2);assert.ok(requests.every(r=>r.method==='GET'));
});

test('QUOTE_EXPIRATION_AT_DISPATCH: final SQL guard rejects an expired quote after reservation and before transport',async t=>{
 const f=await fixture({afterActivate:async({p})=>{p.quote.expires_at=new Date(Date.now()-1).toISOString();}});t.after(f.close);
 await f.accept();await assert.rejects(f.generate(),/FRESH_QUOTE/);assert.equal(f.counts().calls,0);
 assert.equal((await f.getJ(f.proposal.planned_attempt_id)).state,'PREPARED');
});
test('ATOMIC_RESERVATION_ROLLBACK: a checkpoint write failure rolls back the new journal, reservation and operation together',async t=>{
 const f=await fixture();t.after(f.close);await f.accept();
 await f.db.exec("create function test_reject_checkpoint() returns trigger language plpgsql as $$ begin raise exception 'SYNTHETIC_WRITE_FAILURE'; end $$; create trigger fail_write before update on lumi_pipeline_checkpoints for each row execute function test_reject_checkpoint();");
 await assert.rejects(f.generate(),/SYNTHETIC_WRITE_FAILURE/);
 assert.equal(await f.getJ(f.proposal.planned_attempt_id),undefined);assert.equal(Object.keys((await f.getCp(f.cpId)).metadata.budget_reservations).length,1);
 assert.equal((await f.reviewStore.get()).state.mini_app.operations[f.proposal.planned_operation_id],undefined);assert.equal(f.counts().calls,0);
});
test('CONSENT_ANTIREPLAY: an old signed challenge cannot replace a later human decision',async t=>{
 const f=await fixture();t.after(f.close);const a=await f.review();await f.adapter.acceptSupervisedReplacement(f.principal,{challenge:a.challenge,accept_duplicate_risk:true});
 f.controls.content='Changed material content';const b=await f.review();await f.adapter.acceptSupervisedReplacement(f.principal,{challenge:b.challenge,accept_duplicate_risk:true});
 await assert.rejects(f.adapter.acceptSupervisedReplacement(f.principal,{challenge:a.challenge,accept_duplicate_risk:true}),/CONSENT_REPLAY/);
 const s=(await f.reviewStore.get()).state;assert.equal(Object.keys(s.supervised_replacement_consent_history).length,2);
 assert.equal(s.supervised_replacement_grants[f.proposal.replacement_proposal_id].authorization_reference,b.challenge.challenge_id);assert.equal(f.counts().calls,0);
});

const reseal=value=>{const {seal,...v}=value;return {...v,seal:createHmac('sha256',env.LUMI_TELEGRAM_CALLBACK_SECRET).update('lumi-supervised-risk-v2:'+recoveryDigest(v)).digest('hex')};};
const projection=async f=>replacementPresentation({checkpoint:await f.getCp(f.cpId),state:(await f.reviewStore.get()).state,
 budget:await f.manager.budgetExposure({episodeId:f.cpId}),current_emission:await f.getJ(f.attempt),supervised_replacement_ready:true});

test('RISK_ACCEPTANCE_RECOVERY / FAILED_CONFIRMATION / NETWORK_TIMEOUT: failed estimate is durable and reopening preserves consent without a reserve',async t=>{
 const f=await fixture();t.after(f.close);await f.accept();const before=(await f.reviewStore.get()).state;
 const g=before.supervised_replacement_grants[f.proposal.replacement_proposal_id];f.controls.quoteError='higgsfield_usd_estimate_http_503';
 await assert.rejects(f.generate(),/HIGGSFIELD_USD_ESTIMATE_HTTP_503/);
 const r=await projection(f);assert.equal(r.authorization_status,'HUMAN_RISK_ACCEPTANCE');assert.equal(r.generation_enabled,true);
 assert.equal(r.confirmation_error,'HIGGSFIELD_USD_ESTIMATE_HTTP_503');assert.equal(r.generation_boundary,'NO_JOURNAL_NO_GENERATION');
 assert.deepEqual((await f.reviewStore.get()).state.supervised_replacement_grants[f.proposal.replacement_proposal_id],g);
 assert.equal(await f.getJ(f.proposal.planned_attempt_id),undefined);assert.equal(Object.keys((await f.getCp(f.cpId)).metadata.budget_reservations).length,1);
 const login=await f.auth.login(initData('reopen-after-error')),principal=await f.auth.authenticate(login.cookie,login.csrf);
 assert.equal((await f.adapter.reviewSupervisedReplacement(principal,f.proposal.replacement_proposal_id)).authorization_status,'HUMAN_RISK_ACCEPTANCE');
 assert.equal(f.counts().calls,0);f.controls.quoteError=null;f.controls.token='renewed';
 await f.generate(principal);assert.equal(f.counts().calls,1);assert.deepEqual((await f.reviewStore.get()).state.supervised_replacement_grants[f.proposal.replacement_proposal_id],g);
});

test('CONSENT_EXPIRATION: stored explicit deadlines, including legacy grants, are never extended by session reopen or transport renewal',async t=>{
 for(const legacy of [false,true]){
 const f=await fixture({episode:legacy?'ep006_legacy':'ep005_expired'});t.after(f.close);await f.accept();
 const row=await f.reviewStore.get(),id=f.proposal.replacement_proposal_id;let g={...row.state.supervised_replacement_grants[id],expires_at:new Date(Date.now()-1000).toISOString()};
 if(legacy){delete g.consent_contract_version;delete g.approved_content_fingerprint;}
 g=reseal(g);row.state.supervised_replacement_grants[id]=g;row.state.supervised_replacement_consent_history[g.authorization_reference]=g;await f.reviewStore.cas('1',row.revision,row.state);
 await assert.rejects(f.generate(),/CONSENT_EXPIRED/);const view=await projection(f);
 assert.equal(view.consent_recorded,true);assert.equal(view.authorization_status,'CONSENT_EXPIRED');assert.equal(view.generation_enabled,false);
 assert.equal(view.consent_expiration_reason,legacy?'LEGACY_CONSENT_BOUND_TO_SIGNED_CONTENT':'EXPLICIT_24_HOUR_LIMIT');
 const review=await f.review();assert.ok(review.challenge);assert.deepEqual((await f.reviewStore.get()).state.supervised_replacement_grants[id],g);
 assert.deepEqual(f.counts(),{quotes:0,calls:0});
 }
});

test('QUOTE_EXPIRATION / APPROVED_CONTENT_BINDING: renew exact transport with same consent; changed creative content is blocked',async t=>{
 const f=await fixture({episode:'ep006_transport',stage:'VIDEO'});t.after(f.close);await f.accept();
 const original=(await f.reviewStore.get()).state.supervised_replacement_grants[f.proposal.replacement_proposal_id];
 f.controls.content='changed creative';await assert.rejects(f.generate(),/APPROVED_CONTENT_CHANGED/);assert.equal(f.counts().quotes,0);
 f.controls.content='Synthetic only';f.controls.quoteExpired=true;await assert.rejects(f.generate(),/CURRENT_EXACT_PAYLOAD_QUOTE/);
 assert.equal((await projection(f)).authorization_status,'HUMAN_RISK_ACCEPTANCE');assert.equal(f.counts().calls,0);
 f.controls.quoteExpired=false;f.controls.token='fresh-transport';await f.generate();
 const journal=await f.getJ(f.proposal.planned_attempt_id);assert.notEqual(journal.payload_fingerprint,original.payload_sha256);
 assert.deepEqual((await f.reviewStore.get()).state.supervised_replacement_grants[f.proposal.replacement_proposal_id],original);
 assert.equal(journal.payload_fingerprint,(await f.getCp(f.cpId)).metadata.budget_reservations['replacement:'+f.proposal.planned_attempt_id].binding);
 assert.equal(f.counts().calls,1);
});

test('DOUBLE_CLICK / NO_DUPLICATE_EMISSION: a failed confirmation ID is single-use; a separate human confirmation can renew a quote',async t=>{
 const f=await fixture();t.after(f.close);await f.accept();const g=(await f.reviewStore.get()).state.supervised_replacement_grants[f.proposal.replacement_proposal_id];
 const body={proposal_id:f.proposal.replacement_proposal_id,authorization_reference:g.authorization_reference,confirmation_id:randomUUID(),confirm:true};
 f.controls.quoteError='TIMEOUT';await assert.rejects(f.adapter.generateSupervisedReplacement(f.principal,body),/TIMEOUT/);
 f.controls.quoteError=null;await assert.rejects(f.adapter.generateSupervisedReplacement(f.principal,body),/CONFIRMATION_BINDING/);
 assert.deepEqual(f.counts(),{quotes:1,calls:0});await f.generate();assert.equal(f.counts().calls,1);
});

test('STALE_CONFIRMATION_FENCE / BUDGET_PRESERVATION: expired worker cannot activate after a newer quote claim',async t=>{
 const f=await fixture();t.after(f.close);await f.accept();let captured;
 const real=f.manager.supervisedReplacementTransaction.bind(f.manager);
 f.manager.supervisedReplacementTransaction=async p=>{if(p.phase==='QUOTE_CLAIM')captured=structuredClone(p);return real(p);};
 f.controls.quoteError='SYNTHETIC_TIMEOUT';await assert.rejects(f.generate());const first=captured.quote_claim;
 f.controls.quoteError=null;f.controls.beforeQuote=async()=>{
 const r=await f.reviewStore.get();
 await assert.rejects(f.tx({...captured,phase:'ACTIVATE',expected_revision:r.revision,quote_claim:first}),/CONSENT_OR_QUOTE_CLAIM_CHANGED/);
 };
 await f.generate();assert.equal(f.counts().calls,1);assert.equal((await f.getCp(f.cpId)).authorized_ceiling_usd,8);
});

test('APPROVED_CONTENT_FINGERPRINT: IMAGE and VIDEO retain prompt, settings, model, ordered references and verified source bytes across signed URL renewal',async()=>{
 const {supervisedContentFingerprint:f}=await import('../lib/lumi-supervised-runtime-bindings.js');
 for(const stage of ['IMAGE','VIDEO']){
 const model=stage==='IMAGE'?'marketing-studio/image':'kling-video/v3.0/pro/image-to-video';
 const payload={prompt:'approved content',duration:4,sound:'off',...(stage==='IMAGE'?{image_urls:['https://storage.invalid/a?token=old']}:{image_url:'https://storage.invalid/a?token=old'})};
 const a={stage,model,payload,sourceSha:'a'.repeat(64),referenceShas:stage==='IMAGE'?['b'.repeat(64)]:[]};
 const fresh={...payload,...(stage==='IMAGE'?{image_urls:['https://storage.invalid/a?token=new']}:{image_url:'https://storage.invalid/a?token=new'})};
 assert.equal(f(a),f({...a,payload:fresh}));
 for(const changed of [{payload:{...payload,prompt:'different'}},{payload:{...payload,duration:5}},{model:'different-model'},{sourceSha:'c'.repeat(64)}])assert.notEqual(f(a),f({...a,...changed}));
 if(stage==='IMAGE')assert.notEqual(f(a),f({...a,referenceShas:['c'.repeat(64)]}));
 assert.throws(()=>f({...a,sourceSha:'unverified'}),/APPROVED_SOURCE/);
 }
});

test('EXPIRED_IN_FLIGHT_CONFIRMATION: only a new explicit confirmation may supersede an expired fenced quote; stale worker cannot reserve',async t=>{
 const f=await fixture();t.after(f.close);await f.accept();let captured;
 const real=f.manager.supervisedReplacementTransaction.bind(f.manager);
 f.manager.supervisedReplacementTransaction=async p=>{if(p.phase==='QUOTE_CLAIM')captured=structuredClone(p);return real(p);};
 f.controls.quoteError='SYNTHETIC_TIMEOUT';await assert.rejects(f.generate());
 const row=await f.reviewStore.get(),g=row.state.supervised_replacement_grants[f.proposal.replacement_proposal_id],old=captured.quote_claim;
 // Model a crashed worker: no outcome, lease expired; the old signed deadline
 // remains part of the stale worker's request and cannot be extended by it.
 row.state.supervised_replacement_quote_claims[g.authorization_reference].status='CLAIMED';
 row.state.supervised_replacement_quote_claims[g.authorization_reference].expires_at=new Date(Date.now()-1000).toISOString();
 await f.reviewStore.cas('1',row.revision,row.state);assert.equal((await projection(f)).generation_enabled,true);
 f.controls.quoteError=null;f.controls.beforeQuote=async()=>{
 await assert.rejects(f.tx({...captured,phase:'ACTIVATE',expected_revision:(await f.reviewStore.get()).revision,quote_claim:old}),/CONSENT_OR_QUOTE_CLAIM_CHANGED/);
 };
 await f.generate();assert.equal(f.counts().calls,1);assert.equal(Object.keys((await f.getCp(f.cpId)).metadata.budget_reservations).length,2);
 assert.equal(globalThis.LUMI_OFFLINE_GUARD.attempts.length,0);
});


test('QUOTE_OVER_LIMIT / RESERVATION_MULTIPLIER: real estimator adapter preserves exact rejected economics before any generation claim',async t=>{
 const f=await fixture();t.after(f.close);await f.accept();f.controls.realEstimator=true;f.controls.quoteAmount=.271;
 const before=await f.getCp(f.cpId),original=await f.getJ(f.attempt),grant=(await f.reviewStore.get()).state.supervised_replacement_grants[f.proposal.replacement_proposal_id];
 await assert.rejects(f.generate(),/Q41_REQUEST_RESERVATION_LIMIT_EXCEEDED/);
 const state=(await f.reviewStore.get()).state,claim=state.supervised_replacement_quote_claims[grant.authorization_reference],d=claim.quote.economic_decision;
 assert.equal(claim.error_phase,'QUOTE');assert.equal(claim.generation_boundary,'NO_JOURNAL_NO_GENERATION');
 assert.equal(d.quote_amount_usd,.271);assert.equal(d.reservation_multiplier,1.25);assert.equal(d.calculated_reservation_usd,.33875);
 assert.equal(d.authorized_max_usd,.3275);assert.equal(d.episode_remaining_usd,7.6725);assert.equal(d.reason,'RESERVATION_MARGIN_OVER_AUTHORIZED_MAX');
 assert.equal(claim.quote.provider_request_id,'synthetic-estimate-id');assert.ok(claim.quote.quote_id);assert.ok(claim.quote.expires_at);
 assert.deepEqual(await f.getCp(f.cpId),before);assert.deepEqual(await f.getJ(f.attempt),original);assert.equal(await f.getJ(f.proposal.planned_attempt_id),undefined);
 assert.deepEqual(state.supervised_replacement_grants[f.proposal.replacement_proposal_id],grant);assert.equal(f.counts().calls,0);
 const view=await projection(f);assert.equal(view.generation_enabled,false);assert.equal(view.quote_only_available,true);assert.equal(view.authorization_status,'HUMAN_RISK_ACCEPTANCE');
 assert.equal(view.economic_decision.calculated_reservation_usd,.33875);
});
test('QUOTE_ONLY / SESSION_REOPEN / CROSS_SHOT_IDENTITY: explicit quote persists without reserve, then a distinct human confirmation may generate within the same consent',async t=>{
 const f=await fixture({episode:'ep006_cost',stage:'VIDEO'});t.after(f.close);await f.accept();f.controls.realEstimator=true;
 const before=await f.getCp(f.cpId),g=(await f.reviewStore.get()).state.supervised_replacement_grants[f.proposal.replacement_proposal_id];
 const body={proposal_id:f.proposal.replacement_proposal_id,authorization_reference:g.authorization_reference,confirmation_id:randomUUID(),confirm:true};
 const result=await f.adapter.quoteSupervisedReplacement(f.principal,body);assert.equal(result.status,'QUOTE_RECORDED');assert.equal(result.economic_decision.calculated_reservation_usd,.3275);
 assert.deepEqual(await f.getCp(f.cpId),before);assert.equal(await f.getJ(f.proposal.planned_attempt_id),undefined);assert.equal(f.counts().calls,0);
 await assert.rejects(f.adapter.quoteSupervisedReplacement(f.principal,body),/BINDING|ALREADY|CONFIRMATION/);
 const row=await f.reviewStore.get(),claim=row.state.supervised_replacement_quote_claims[g.authorization_reference];
 await assert.rejects(f.manager.requestCostDecision({episodeId:f.cpId,actionKey:f.action,quote:{...claim.quote,action_id:'video:s99'},payloadSha:g.payload_sha256,payloadExpiresAt:g.expires_at,maximumReservationUsd:.3275}),/IDENTITY/);
 const login=await f.auth.login(initData('cost-reopen')),p=await f.auth.authenticate(login.cookie,login.csrf);
 await f.generate(p);assert.equal(f.counts().calls,1);const j=await f.getJ(f.proposal.planned_attempt_id);
 assert.equal(j.payload_descriptor.trace.idempotency_key,f.proposal.planned_idempotency_key);
 assert.equal(j.payload_descriptor.trace.reservation_id,'replacement:'+f.proposal.planned_attempt_id);
 assert.ok(j.payload_descriptor.trace.quote_id);assert.equal(j.payload_descriptor.trace.payload_hash,j.payload_fingerprint);
 assert.deepEqual((await f.reviewStore.get()).state.supervised_replacement_grants[f.proposal.replacement_proposal_id],g);
});
