import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {MemoryLumiRecoveryStore,LumiRecoveryIncidentManager} from '../lib/lumi-recovery-incident-manager-v1.js';
import {MemoryReviewStore} from '../lib/telegram-review-v1/core.js';
import {buildReplacementProposal,recoveryDigest,replacementRiskGate,replacementPresentation,REPLACEMENT_FLOW} from '../lib/lumi-supervised-replacement.js';
import {journaledFetch} from '../lib/provider-emission-journal-v1.js';
import {generateImprovementArtifacts,validateImprovementState} from '../lib/lumi-improvement-loop.js';

const now=Date.parse('2026-10-19T01:30:00Z');
function fixture(episode='ep005_synthetic'){
 const attempt=recoveryDigest(['original-attempt',episode]),operationId=recoveryDigest(['original-op',episode]);
 const authorization={status:'AUTHORIZED',decision:'APPROVED',policy:{episode_id:episode,action_key:'image:s2',authorization_id:'original:'+episode}};
 const operation={id:operationId,status:'BLOCKED',binding:{proposal_id:episode,next_action:'image:s2'},consent:{value:{authorization_id:authorization.policy.authorization_id,operation_id:operationId}}};
 const journal={attempt_id:attempt,episode_id:episode,scene_id:'s2',stage:'IMAGE',provider:'higgsfield_api',model:'marketing-studio/image',state:'EMISSION_UNKNOWN',response_parsing_outcome:'NO_RESPONSE',provider_request_id:null,http_status:null};
 const checkpoint={episode_id:episode,status:'PAUSED_INCIDENT',runner_enabled:false,autorun:false,current_cost_usd:0,authorized_ceiling_usd:8,last_completed_action:'shot_review:s1',first_pending_action:'image:s2',
 actions:[{key:'shot_review:s1',stage:'SHOT_REVIEW',scene_id:'s1',status:'COMPLETE',artifact:{sha256:'a'.repeat(64)},evidence:{provider_succeeded:true,artifact_persisted:true,sha_verified:true,artifact_verified:true}},{key:'image:s2',stage:'IMAGE',scene_id:'s2',status:'PENDING',dispatch_state:'DISPATCHING',active_attempt_id:attempt}],
 metadata:{user:'1',runtime_revision:23,provider_generation_authorized:false,publication_enabled:false,review_requests:{r1:{status:'APPROVED'}},budget_reservations:{'image:s2':{amount_usd:0.3275,attempt_id:attempt,status:'RESERVED_UNTIL_ACTUAL_CHARGE_VERIFIED'}}}};
 return {checkpoint,operation,journal,authorization,budget:{episode_ceiling_usd:8,required_total_usd:0.3275},maximumNewReservation:0.3275,createdAt:new Date(now).toISOString()};
}
async function stores(f){
 const store=new MemoryLumiRecoveryStore(),reviewStore=new MemoryReviewStore();
 await store.putEpisode(f.checkpoint);await reviewStore.create('1',{user_id:'1',chat_id:'1',mini_app:{operations:{[f.operation.id]:f.operation}},v2_authorizations:{[f.authorization.policy.authorization_id]:f.authorization},recovery_state:'NONE',unrelated:{concurrent:'preserve'}});
 const journalStore={get:async id=>id===f.journal.attempt_id?structuredClone(f.journal):null};
 const manager=new LumiRecoveryIncidentManager({store,clock:()=>new Date(now)});
 return {store,reviewStore,journalStore,manager};
}
const proposalArgs=(f,s)=>({episodeId:f.checkpoint.episode_id,originalOperationId:f.operation.id,maximumNewReservation:0.3275,user:'1',reviewStore:s.reviewStore,journalStore:s.journalStore});
function grant(p){return {scope:'SUPERVISED_REPLACEMENT_DUPLICATE_RISK',status:'AUTHORIZED',decision:'APPROVED',episode_id:p.episode_id,action_id:p.action_id,original_operation_id:p.original_operation_id,replacement_proposal_id:p.replacement_proposal_id,proposal_digest:p.proposal_digest,accepts_possible_duplicate_charge:true,preserve_original_reservation:true,max_new_provider_calls:1,max_new_reservation_usd:p.maximum_new_reservation,user_id:'1',authorization_reference:'SYNTHETIC_TEST_ONLY',authorized_at:new Date(now).toISOString(),expires_at:new Date(now+60000).toISOString()};}
function quote(p){return {episode_id:p.episode_id,action_id:p.action_id,replacement_proposal_id:p.replacement_proposal_id,operation_id:p.planned_operation_id,attempt_id:p.planned_attempt_id,model:p.model,currency:'USD',status:'QUOTED',quote_id:'synthetic-quote',payload_sha256:'b'.repeat(64),created_at:new Date(now).toISOString(),expires_at:new Date(now+60000).toISOString(),estimate_usd:0.262,reserve_usd:0.3275};}

test('AMBIGUOUS_OPERATION_PRESERVATION Q41_APPROVAL_PRESERVATION Q42_RESERVATION_PRESERVATION: proposal is isolated and idempotent across restart',async()=>{
 const f=fixture(),s=await stores(f),before=await s.reviewStore.get('1');
 const p=await s.manager.proposeSupervisedReplacement(proposalArgs(f,s));
 assert.equal(p.proposal_status,'REPLACEMENT_PROPOSAL');assert.equal(p.risk_acceptance,null);
 assert.equal(p.generation_enabled,false);assert.equal(p.new_reservation_status,'NOT_RESERVED');
 assert.deepEqual(await s.store.getEpisode(f.checkpoint.episode_id),f.checkpoint);
 assert.deepEqual(await s.journalStore.get(f.journal.attempt_id),f.journal);
 const after=await s.reviewStore.get('1');assert.deepEqual(after.state.mini_app,before.state.mini_app);assert.deepEqual(after.state.v2_authorizations,before.state.v2_authorizations);assert.equal(after.state.recovery_state,'NONE');
 const restarted=new LumiRecoveryIncidentManager({store:s.store,clock:()=>new Date(now+1000)});
 assert.deepEqual(await restarted.proposeSupervisedReplacement(proposalArgs(f,s)),p);
 assert.equal((await s.reviewStore.get('1')).revision,after.revision);
});
test('REPLACEMENT_PROPOSAL: concurrent writers merge once, preserve unrelated data and deny changed evidence',async()=>{
 const f=fixture(),s=await stores(f),cas=s.reviewStore.cas.bind(s.reviewStore);let race=true;
 s.reviewStore.cas=async(id,rev,value)=>{if(race){race=false;const old=await s.reviewStore.get(id);old.state.unrelated.extra='concurrent';await cas(id,rev,old.state);}return cas(id,rev,value);};
 await s.manager.proposeSupervisedReplacement(proposalArgs(f,s));
 const [a,b]=await Promise.all([s.manager.proposeSupervisedReplacement(proposalArgs(f,s)),s.manager.proposeSupervisedReplacement(proposalArgs(f,s))]);
 assert.deepEqual(a,b);const row=await s.reviewStore.get('1');assert.equal(Object.keys(row.state.supervised_replacement_proposals).length,1);assert.equal(row.state.unrelated.extra,'concurrent');
 await assert.rejects(s.manager.proposeSupervisedReplacement({...proposalArgs(f,s),maximumNewReservation:0.5}),/IMMUTABLE/);
 await assert.rejects(s.manager.proposeSupervisedReplacement({...proposalArgs(f,s),user:'2'}),/OWNER/);
});
test('PROVIDER_JOURNAL_INTEGRITY: timeout cannot become failure or non-emission, mismatched attempts and recovered originals are rejected',()=>{
 for(const change of [f=>f.journal.state='FAILED',f=>f.journal.response_parsing_outcome='NOT_DISPATCHED',f=>f.journal.provider_request_id='already-found',f=>f.checkpoint.actions[1].active_attempt_id='other',f=>f.operation.binding.proposal_id='foreign',f=>f.checkpoint.metadata.budget_reservations={},f=>f.authorization.policy.action_key='image:s3']){
   const f=fixture();change(f);assert.throws(()=>buildReplacementProposal(f),/REPLACEMENT_/);
 }
 const f=fixture(),p=buildReplacementProposal(f);assert.equal(p.original_status,'EMISSION_UNKNOWN');assert.equal(p.potential_duplicate_cost.actual_previous_charge_usd,null);
});
test('HUMAN_RISK_GATE: budget increase, original consent, timeout and forged/mismatched grants cannot authorize replacement',()=>{
 const f=fixture(),proposal=buildReplacementProposal(f),base={...f,proposal,quote:quote(proposal),now};
 for(const g of [null,f.authorization,{scope:'EPISODE_BUDGET_LIMIT_ONLY',status:'AUTHORIZED'},...[
  {accepts_possible_duplicate_charge:false},{preserve_original_reservation:false},{replacement_proposal_id:'other'},{episode_id:'ep006'},{max_new_provider_calls:2},{max_new_reservation_usd:1},{user_id:'2'},{proposal_digest:'a'.repeat(64)},{expires_at:new Date(now-1).toISOString()}
 ].map(p=>({...grant(proposal),...p}))])assert.throws(()=>replacementRiskGate({...base,riskGrant:g}),/SPECIFIC_HUMAN/);
 const result=replacementRiskGate({...base,riskGrant:grant(proposal)});assert.equal(result.emission_enabled,false);
 assert.equal(result.status,'DRAFT_ONLY_NOT_EMISSION_AUTHORITY');
});
test('BUDGET_DOUBLE_EXPOSURE: both liabilities included; changed spend, insufficient headroom and stale quotes fail closed',()=>{
 const f=fixture(),p=buildReplacementProposal(f),base={...f,proposal:p,riskGrant:grant(p),quote:quote(p),now};
 assert.equal(replacementRiskGate(base).projected_episode_exposure_usd,0.655);
 for(const patch of [{expires_at:new Date(now-1).toISOString()},{reserve_usd:0.4},{reserve_usd:-1},{payload_sha256:null},{operation_id:f.operation.id}])assert.throws(()=>replacementRiskGate({...base,quote:{...base.quote,...patch}}),/FRESH_BOUND_QUOTE/);
 assert.throws(()=>replacementRiskGate({...base,budget:{...f.budget,required_total_usd:7.9}}),/DOUBLE_EXPOSURE/);
 const poor=fixture();poor.checkpoint.authorized_ceiling_usd=0.5;poor.budget.episode_ceiling_usd=0.5;
 const pp=buildReplacementProposal(poor);assert.equal(pp.budget_gate,'BLOCKED');
 assert.throws(()=>replacementRiskGate({...poor,proposal:pp,riskGrant:grant(pp),quote:quote(pp),now}),/DOUBLE_EXPOSURE/);
 assert.throws(()=>replacementRiskGate({...base,checkpoint:{...f.checkpoint,authorized_ceiling_usd:9}}),/EVIDENCE_CHANGED/);
});
test('IDEMPOTENCY_ISOLATION: operations, attempts and keys differ from originals and across episodes',()=>{
 const ps=[buildReplacementProposal(fixture()),buildReplacementProposal(fixture('ep006_synthetic'))];
 const ids=ps.flatMap(p=>[p.original_operation_id,p.original_attempt_id,p.replacement_proposal_id,p.planned_operation_id,p.planned_attempt_id,p.planned_idempotency_key]);
 assert.equal(new Set(ids).size,ids.length);
});
test('HUMAN_RISK_GATE: direct Mini App command cannot bypass a proposal-only server gate',async()=>{
 const {MiniAppService}=await import('../lib/telegram-mini-app/runtime.js');
 const f=fixture(),p=buildReplacementProposal(f),state={supervised_replacement_proposals:{[p.replacement_proposal_id]:p}};
 const service=new MiniAppService({});service.context=async()=>({checkpoint:f.checkpoint,state});
 for(const kind of ['quote','authorize','generate','first_animation','second_image'])
   await assert.rejects(service.enqueue({},kind,{confirm:true}),/SUPERVISED_REPLACEMENT_PROPOSAL_ONLY/);
 assert.equal(globalThis.LUMI_OFFLINE_GUARD?.attempts.length,0);
});
test('MINI_APP_UX: read-only proposal displays risk and amounts with no generation or approval control',async()=>{
 const f=fixture(),p=buildReplacementProposal(f),state={supervised_replacement_proposals:{[p.replacement_proposal_id]:p}};
 const ctx={...f,state,current_emission:{state:'EMISSION_UNKNOWN',attempt_id:f.journal.attempt_id}};
 const view=replacementPresentation(ctx);assert.equal(view.authorization_status,'NOT_GRANTED');assert.equal(view.generation_enabled,false);
 const before=recoveryDigest(ctx);replacementPresentation(ctx);assert.equal(recoveryDigest(ctx),before);
 const element={innerHTML:'',textContent:'',hidden:false};const box={document:{querySelector:()=>element,addEventListener(){},querySelectorAll:()=>[]},window:{},localStorage:{getItem:()=>null},setInterval(){},setTimeout(){},clearTimeout(){}};
 const js=await readFile(new URL('../public/lumi-studio/app.js',import.meta.url),'utf8');
 runInNewContext(js.replace('navigation();login();','')+'\nglobalThis.card=s=>{state=s;return quoteCard();};',box);
 const html=box.card({supervised_replacement:view,budget:{ceiling_usd:8},capabilities:{}});
 assert.match(html,/cargo anterior no verificado/);assert.match(html,/Reserva anterior conservada/);assert.match(html,/disabled>Generar reemplazo/);assert.match(html,/Actualizar progreso/);
 assert.doesNotMatch(html,/data-action="(?:generate|authorize|second_image)"/);
 const changed={...ctx,checkpoint:{...f.checkpoint,metadata:{...f.checkpoint.metadata,runtime_revision:24}}};
 assert.equal(replacementPresentation(changed).status,'EVIDENCE_CHANGED_REVIEW_REQUIRED');
});

for(const episode of ['ep005_synthetic','ep006_synthetic'])test('MULTI_EPISODE_REUSE '+episode+': simulated full lifecycle with original preserved and zero real providers',async()=>{
 const f=fixture(episode),s=await stores(f),p=await s.manager.proposeSupervisedReplacement(proposalArgs(f,s));
 const descriptor=replacementRiskGate({...f,proposal:p,riskGrant:grant(p),quote:quote(p),now});
 const rows=new Map([[f.journal.attempt_id,structuredClone(f.journal)]]);let mockCalls=0;
 const journal={prepare:async row=>{assert.equal(rows.has(row.attempt_id),false);rows.set(row.attempt_id,structuredClone(row));},transition:async(id,from,patch)=>{assert.equal(rows.get(id).state,from);Object.assign(rows.get(id),patch);}};
 const submit=journaledFetch({store:journal,context:{attempt_id:descriptor.attempt_id,episode_id:episode,scene_id:'s2',stage:'IMAGE',provider:'synthetic',model:'synthetic',original_attempt_snapshot:{replacement_proposal_id:p.replacement_proposal_id,original_attempt_id:p.original_attempt_id}},fetchImpl:async()=>{mockCalls++;return new Response(JSON.stringify({request_id:'synthetic-result-'+episode}),{status:200});}});
 const response=await submit('https://provider.invalid',{method:'POST',headers:{'content-type':'application/json'},body:'{"synthetic":true}'});await response.json();
 await assert.rejects(submit('https://provider.invalid',{}),/already_consumed/);assert.equal(mockCalls,1);
 // Result recovery + human review use existing Recovery Manager in an isolated
 // synthetic replacement checkpoint, never the real episode or original journal.
 const complete={provider_succeeded:true,artifact_persisted:true,sha_verified:true,artifact_verified:true};
 await s.manager.startEpisode({episodeId:episode+':replacement',actions:[{key:'image:s2',stage:'IMAGE',scene_id:'s2'},{key:'shot_review:s2',stage:'SHOT_REVIEW',scene_id:'s2'}]});
 await s.manager.recordRequest(episode+':replacement','image:s2','synthetic-result-'+episode);
 await s.manager.completeAction(episode+':replacement','image:s2',{artifact:{sha256:'c'.repeat(64),synthetic:true},evidence:complete});
 await s.manager.completeAction(episode+':replacement','shot_review:s2',{artifact:{decision:'APPROVED',source:'SYNTHETIC_HUMAN_REVIEW'},evidence:complete});
 assert.equal((await s.store.getEpisode(episode+':replacement')).status,'READY_FOR_HUMAN_REVIEW');
 assert.deepEqual(rows.get(f.journal.attempt_id),f.journal);assert.deepEqual(await s.store.getEpisode(episode),f.checkpoint);
 assert.equal(REPLACEMENT_FLOW.length,8);assert.equal(globalThis.LUMI_OFFLINE_GUARD?.attempts.length,0);
 const state=JSON.parse(await readFile(new URL('../docs/lumi-improvement/state.json',import.meta.url),'utf8'));
 const incidents=JSON.parse(await readFile(new URL('../docs/lumi-improvement/incidents.json',import.meta.url),'utf8'));
 state.episode_id=episode;state.proposal_id=p.replacement_proposal_id;state.original={operation_id:p.original_operation_id,attempt_id:p.original_attempt_id,status:'EMISSION_UNKNOWN',response:'NO_RESPONSE',reserved_usd:0.3275};
 const output=generateImprovementArtifacts(state,incidents.map(i=>({...i,EPISODE_ID:episode})));
 assert.match(output.prompt,new RegExp(episode));assert.match(output.prompt,/BORRADOR/);
});

test('INCIDENT_REGISTRY PROMPT_FEEDBACK RESUME_STATE NEXT_PROMPT_GENERATION: deterministic, evidence-based and cannot expand permissions',async()=>{
 const state=JSON.parse(await readFile(new URL('../docs/lumi-improvement/state.json',import.meta.url),'utf8'));
 const incidents=JSON.parse(await readFile(new URL('../docs/lumi-improvement/incidents.json',import.meta.url),'utf8'));
 assert.equal(validateImprovementState(state,incidents),true);const a=generateImprovementArtifacts(state,incidents),b=generateImprovementArtifacts(structuredClone(state),structuredClone(incidents));assert.deepEqual(a,b);
 for(const field of ['prompt','resume','feedback'])assert.ok(a[field].length>500);
 assert.match(a.prompt,/aceptación de riesgo NO OTORGADA/);assert.match(a.prompt,/no autoriza/i);assert.match(a.prompt,/USD 8/);
 assert.match(a.resume,/PRODUCTION_PROGRESS/);assert.match(a.feedback,/qué evidencia faltó/i);
 assert.throws(()=>generateImprovementArtifacts({...state,authorizations:{provider_generation:true}},incidents),/PREPARATION_SCOPE/);
 assert.throws(()=>validateImprovementState(state,[{...incidents[0],CONFIDENCE:'CONFIRMED_BY_GUESS'}]),/EVIDENCE/);
 assert.throws(()=>validateImprovementState(state,[{...incidents[0],CONFIDENCE:'UNKNOWN',ROOT_CAUSE:'timeout proves no charge'}]),/UNKNOWN_CAUSE/);
 const changed=structuredClone(incidents);changed[0].NEXT_ACTION+=' Evidence changed.';assert.notEqual(generateImprovementArtifacts(state,changed).input_sha256,a.input_sha256);
});
