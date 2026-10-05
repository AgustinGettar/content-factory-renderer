import '../scripts/director-offline-guard.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { compileDirectorPacket, evaluateSequence, validateCapabilities, resolveEffectivePolicy } from '../lib/cinematic-director-v1/director.js';
import { compilePromptDraft, stableStringify } from '../lib/cinematic-director-v1/PROMPT_COMPILER_V3.mjs';
import { POLICY, CAPABILITIES } from '../lib/cinematic-director-v1/profiles.js';
import { runLumiV2Step } from '../lib/lumi-series-v2-execution.js';
import { MemoryLumiRecoveryStore, LumiRecoveryIncidentManager, pipelineVersion } from '../lib/lumi-recovery-incident-manager-v1.js';
import { makeFixture, setReviewedFact, syntheticCapabilities } from './fixtures/director-v1.js';

assert.equal(globalThis.LUMI_OFFLINE_GUARD?.active, true, 'Run with --import ./scripts/director-offline-guard.mjs');
const codes = p => p.blockers.map(x => x.code);
async function withFixture(t, fn, config) {
  const f = await makeFixture(config); t.after(() => rm(f.directory, { recursive: true, force: true })); return fn(f);
}
const compile = f => compileDirectorPacket(f.input, f.options);

test('concrete source-supported direction is reviewable; three outputs separate; zero authorization', async t => withFixture(t, async f => {
  const before = stableStringify(f.input), p = await compile(f);
  assert.deepEqual(p.blockers, []);
  assert.equal(p.gates.SCHEMA_VALID, true); assert.equal(p.gates.DIRECTION_COHERENT, true); assert.equal(p.gates.SOURCE_EVIDENCE_READY, true);
  assert.equal(p.gates.EXECUTION_AUTHORIZATION, false); assert.equal(p.gates.BUDGET_AUTHORIZATION, false); assert.equal(p.gates.HUMAN_DIRECTION_APPROVAL, false);
  assert.equal(p.PROVIDER_REQUEST_PREVIEW.status, 'NOT_SENT'); assert.equal(p.PROVIDER_REQUEST_PREVIEW.payload, null);
  assert.match(p.PROVIDER_PROMPT.text, /Lumi, the character in the input image/);
  assert.match(p.PROVIDER_PROMPT.text, /her own left forearm/); assert.match(p.PROVIDER_PROMPT.text, /torso keeps its initial orientation/);
  assert.equal(p.V3_AUDIT.mode, 'OFFLINE_REVIEW_DRAFT'); assert.match(p.V3_AUDIT.prompt, /10\. EXACT END STATE/);
  assert.equal(stableStringify(f.input), before);
  const saved = JSON.parse(await readFile(p.local_files.plan)); assert.equal(saved.version, 'LUMI_CINEMATIC_DIRECTOR_V1');
  assert.equal(p.references.qa_only.length, 4); assert.equal(p.references.conditioning.length, 1);
  assert.equal(p.provider_calls, 0); assert.equal(p.new_media, 0);
}));

test('attentive wait preserves subtle life, response window and no answer cue', async t => withFixture(t, async f => {
  const p = await compile(f); assert.deepEqual(p.blockers, []);
  assert.match(p.PROVIDER_PROMPT.text, /final 2.5-second response window/);
  assert.match(p.PROVIDER_PROMPT.text, /without pointing or looking toward the answer/);
  assert.match(p.PROVIDER_PROMPT.text, /natural blink/); assert.doesNotMatch(p.PROVIDER_PROMPT.text, /PAUSA/);
  assert.equal(p.DIRECTOR_PLAN.contract.DURATION, 5);
}, {grammar:'ATTENTIVE_WAIT'}));

test('all six recovered V3 ten-block outputs remain byte-identical, including readiness results', async () => {
  const baseline=JSON.parse(await readFile(new URL('./fixtures/director-v3-baseline.json',import.meta.url)));
  const contracts=JSON.parse(await readFile(new URL('../docs/cinematic-director-v1/evidence/SHOT_CONTRACTS_V2.json',import.meta.url))).shots;
  assert.deepEqual(contracts.map(c=>compilePromptDraft(c,baseline.context)),baseline.shots);
});

test('editorial QA is reused; hidden PAUSA in legacy context is not silently accepted', async t => withFixture(t, async f => {
  f.input.context.postproduction.planned_captions=['PAUSA'];
  assert.ok(codes(await compile(f)).includes('PAUSE_LABEL_OR_CAPTIONS_UNVERIFIED'));
}));

for (const [label, mutate, expected] of [
  ['missing source', f => { f.input.media = f.input.media.filter(m => m.role !== 'source'); }, 'ARTIFACT_BYTES_UNVERIFIED'],
  ['missing golden bytes', f => { f.input.media.pop(); }, 'ARTIFACT_BYTES_UNVERIFIED'],
  ['QA reference is not source conditioning', f => { f.input.media[0].role = 'qa'; }, 'MEDIA_ROLE_MISMATCH'],
  ['missing golden role', f => { f.input.contract.GOLDEN_REFERENCES.pop(); }, 'SCHEMA_MIN_ITEMS'],
  ['wrong hash', f => { f.input.contract.SOURCE_ARTIFACT.sha256 = 'a'.repeat(64); }, 'ARTIFACT_BYTES_UNVERIFIED'],
  ['unknown anatomy', f => { f.input.source_qa.ANATOMY = 'UNKNOWN'; }, 'ANATOMY_REVIEW_REQUIRED'],
  ['source defect', f => { f.input.source_qa.NO_REAR_BULB = 'FAIL'; }, 'ANATOMY_REVIEW_REQUIRED'],
  ['static camera with torso turn', f => { f.input.direction.principal_actions[0].body_motion = 'TURN'; }, 'SOURCE_ACTION_MISMATCH'],
  ['hand occupied', f => setReviewedFact(f.input,'left_hand','OCCUPIED'), 'HAND_UNAVAILABLE_OR_UNKNOWN'],
  ['laterality unknown', f => { f.input.facts.laterality.status = 'UNKNOWN'; }, 'VISUAL_FACT_PENDING'],
  ['absent flower', f => setReviewedFact(f.input,'educational_inventory',[]), 'SOURCE_EDUCATIONAL_OBJECT_MISMATCH'],
  ['two primary actions', f => { f.input.direction.principal_actions.push(structuredClone(f.input.direction.principal_actions[0])); }, 'DIRECTION_SCHEMA_INVALID'],
  ['unbound observations', f => { f.input.facts.body_orientation.evidence_ids = ['UNRESOLVED']; }, 'VISUAL_FACT_UNBOUND'],
  ['unknown pose support', f => { f.input.facts.supported_actions.status = 'UNKNOWN'; }, 'SOURCE_ACTION_MISMATCH'],
  ['new identity', f => { f.input.contract.CHARACTER_STATE.identity_preserved = false; }, 'SCHEMA_CONST'],
  ['conflicting primary', f => { f.input.contract.PRIMARY_ACTION.action = 'small_wave'; }, 'PRIMARY_ACTION_CONTRADICTION'],
  ['unknown extension field', f => { f.input.direction.unreviewed_turn_degrees = 45; }, 'DIRECTION_SCHEMA_INVALID'],
  ['caption over Lumi', f => { f.input.direction.captions.text_character_overlap = 1; }, 'DIRECTION_SCHEMA_INVALID'],
  ['PAUSA label', f => { f.input.direction.captions.labels = ['PAUSA']; }, 'CAPTIONS_REQUIRE_EXISTING_EDITORIAL_QA'],
  ['missing reviewer date', f => { f.input.reviews[0].at = null; }, 'SCOPED_HUMAN_APPROVAL_MISSING'],
  ['changed source QA binding', f => { f.input.source_qa.sha256 = 'f'.repeat(64); }, 'SOURCE_QA_SHA_MISMATCH'],
]) test(label + ' fails closed without a prompt pretending source readiness', async t => withFixture(t, async f => {
  mutate(f); const p = await compile(f); assert.ok(codes(p).includes(expected), JSON.stringify(p.blockers));
  assert.equal(p.PROVIDER_REQUEST_PREVIEW.payload, null); assert.equal(p.gates.EXECUTION_AUTHORIZATION, false);
  assert.equal(p.PROVIDER_PROMPT, null);
}));

test('tampered local bytes override asserted SHA PASS', async t => withFixture(t, async f => {
  await writeFile(f.input.contract.SOURCE_ARTIFACT.path, 'TAMPERED');
  const p = await compile(f); assert.ok(codes(p).includes('ARTIFACT_BYTES_UNVERIFIED'));
}));

test('contradictory free-hand review cannot wave or point with the hand holding the wand', async t => withFixture(t, async f => {
  setReviewedFact(f.input,'wand_state','HELD_LEFT'); f.input.direction.stable_parts.push('wand');
  assert.ok(codes(await compile(f)).includes('HAND_OCCUPANCY_CONFLICT'));
}));

test('consistent but wrong source color/count cannot change approved educational inventory', async t => withFixture(t, async f => {
  const c=f.input.contract;c.REQUIRED_OBJECTS[0].color='blue';
  c.START_STATE.object_inventory[0].color='blue';c.END_STATE.object_inventory[0].color='blue';
  c.EDUCATIONAL_INVARIANTS.find(i=>i.property==='color').value='blue';
  setReviewedFact(f.input,'educational_inventory',c.START_STATE.object_inventory);
  assert.ok(codes(await compile(f)).includes('APPROVED_EDUCATIONAL_INVENTORY_CHANGED'));
}));

for (const [field, value, code] of [
  ['seed', 1, 'UNSUPPORTED_FIELD:seed'], ['negative_prompt','tail','UNSUPPORTED_FIELD:negative_prompt'],
  ['elements',['golden_character'],'UNSUPPORTED_FIELD:elements'], ['cfg_scale',2,'INVALID_PARAMETER:cfg_scale'],
  ['sound',true,'INVALID_PARAMETER:sound'], ['duration',4.5,'INVALID_PARAMETER:duration'],
  ['enhance_prompt',false,'UNSUPPORTED_FIELD:enhance_prompt'],
]) test('unsupported or invalid control '+field+' blocks preview', async t => withFixture(t, async f => {
  f.input.request_parameters[field] = value; const p = await compile(f);
  assert.ok(codes(p).includes(code)); assert.equal(p.gates.CAPABILITIES_VERIFIED, false);
  assert.equal(p.PROVIDER_REQUEST_PREVIEW.payload, null);
}));

test('required unsupported control and mismatched endpoint block; universal limits are noncritical', async t => withFixture(t, async f => {
  f.input.required_controls.push('motion_control'); f.options.capabilities = CAPABILITIES;
  const p = await compile(f);
  for (const code of ['REQUIRED_CONTROL_UNSUPPORTED:motion_control']) assert.ok(codes(p).includes(code));
  assert.ok(validateCapabilities({},[],{...CAPABILITIES,endpoint:'different'},POLICY).includes('CAPABILITY_PROFILE_MISMATCH'));
}));

test('length limit is enforced without truncating an essential clause', async t => withFixture(t, async f => {
  f.options.capabilities.prompt_limit.max = 10; const p = await compile(f);
  assert.ok(codes(p).includes('PROMPT_LIMIT_EXCEEDED_NO_TRUNCATION')); assert.ok(p.PROVIDER_PROMPT.text.length > 10);
  assert.equal(p.PROVIDER_REQUEST_PREVIEW.payload, null);
}));

test('model policy conflict is explicit; legacy ceilings do not become new authorization', async t => withFixture(t, async f => {
  f.input.context.provider_policy.model = 'Kling 3.0 Standard';
  f.input.context.economic.episode_projected_usd = 9;
  const p = await compile(f); assert.equal(p.gates.DIRECTION_COHERENT,true);
  assert.equal(p.gates.BUDGET_AUTHORIZATION,false); assert.equal(p.DIRECTOR_PLAN.effective_policy.endpoint,POLICY.endpoint);
  assert.ok(p.V3_AUDIT.gates.blockers.some(x => x.code === 'EPISODE_CEILING_EXCEEDED'));
  f.options.policy = {...POLICY,conflicts:['unresolved episode exception']};
  assert.ok(codes(await compile(f)).includes('POLICY_CONFLICT'));
}));

test('same creative inputs, path-independent hashes and renewed URLs preserve one intention', async t => withFixture(t, async f => {
  const a = await compile(f);
  f.options.transport = {artifact_sha256:f.input.contract.SOURCE_ARTIFACT.sha256,url:'https://synthetic.invalid/source?token=SECRET_ONE'};
  const b = await compile(f);
  f.options.transport.url = 'https://synthetic.invalid/source?token=SECRET_TWO';
  f.input.reviews[0].at = '2001-01-01T00:00:00Z';
  const c = await compile(f);
  assert.equal(a.creative_fingerprint,b.creative_fingerprint); assert.equal(b.creative_fingerprint,c.creative_fingerprint);
  assert.equal(a.PROVIDER_PROMPT.text,c.PROVIDER_PROMPT.text);
  assert.doesNotMatch(JSON.stringify(c),/SECRET_ONE|SECRET_TWO|synthetic.invalid/);
  assert.equal(c.recovery.reopening_creates_intent,false);
}));

test('material creative change invalidates approvals and requires a revision', async t => withFixture(t, async f => {
  const p = await compile(f); f.options.previousPacket = p; f.input.direction.reason_es = 'Otra decisión de dirección.';
  f.input.direction_approval = { fingerprint:p.creative_fingerprint,actor:'SYNTHETIC',at:'2000-01-01T00:00:00Z',scope:'DIRECTOR_DIRECTION' };
  const changed = await compile(f); assert.notEqual(p.creative_fingerprint,changed.creative_fingerprint);
  assert.ok(codes(changed).includes('CREATIVE_CHANGE_REQUIRES_NEW_REVISION')); assert.equal(changed.gates.HUMAN_DIRECTION_APPROVAL,false);
  assert.deepEqual(changed.change_review.approvals_invalidated,['DIRECTION','BUDGET','EXECUTION']);
  f.input.revision++; assert.ok(!codes(await compile(f)).includes('CREATIVE_CHANGE_REQUIRES_NEW_REVISION'));
}));

test('human warning remains scoped and cannot approve new posterior anatomy', async t => withFixture(t, async f => {
  const r=f.input.reviews[0]; r.status='APPROVED_WITH_WARNING'; r.scope='EXISTING_WING_CONTOUR';
  r.warnings=[{code:'SMALL_LOWER_WING_CONTOUR',scope:r.scope,sha256:r.sha256}];
  f.input.source_qa.NO_REAR_BULB='UNKNOWN'; const p=await compile(f);
  assert.equal(p.warnings[0].actor,'SYNTHETIC_REVIEWER_NOT_A_PERSON'); assert.equal(p.warnings[0].acceptance,'EXACT_REVIEW_SCOPE_ONLY');
  assert.ok(codes(p).includes('ANATOMY_REVIEW_REQUIRED')); assert.ok(codes(p).includes('SCOPED_HUMAN_APPROVAL_MISSING'));
}));

test('permitted camera movement needs source support and scoped review', async t => withFixture(t, async f => {
  f.input.direction.camera.type='SUBTLE_PUSH_IN'; f.input.contract.CAMERA.type='SUBTLE_PUSH_IN';
  assert.ok(codes(await compile(f)).includes('CAMERA_APPROVAL_REQUIRED'));
  setReviewedFact(f.input,'supported_cameras',['STATIC','SUBTLE_PUSH_IN']);
  const review={...structuredClone(f.input.reviews[0]),id:'SYNTHETIC_CAMERA_REVIEW',scope:'CAMERA_PATH'};
  f.input.reviews.push(review); f.input.direction.camera.approval_id=review.id;
  const p=await compile(f); assert.deepEqual(p.blockers,[]); assert.match(p.PROVIDER_PROMPT.text,/subtle push-in/);
}));

test('synthetic approvals never pass outside isolated test mode', async t => withFixture(t, async f => {
  f.options.allowSyntheticFixtures=false; const p=await compile(f);
  assert.ok(codes(p).includes('SYNTHETIC_EVIDENCE_NOT_REAL_APPROVAL')); assert.equal(p.gates.HUMAN_DIRECTION_APPROVAL,false);
}));

test('explicit Spanish config projects the same grammar with auditable Spanish summary', async t => withFixture(t, async f => {
  f.input.language='es'; f.options.policy={...POLICY,allowed_languages:['en','es']};
  const p=await compile(f); assert.match(p.PROVIDER_PROMPT.text,/Lumi, el personaje de la imagen de entrada/);
  assert.equal(p.PROVIDER_PROMPT.text,p.resumen_es.que_veremos);
}));

const offlineEnv={LUMI_CINEMATIC_DIRECTOR_V1:'true',LUMI_RUNTIME_ENV:'local_offline',LUMI_PIPELINE_VERSION:'v1_1_2',LUMI_DIRECTOR_FIXTURES:'true'};
test('canonical entry runs opt-in review before clients, preserving six shots and nine beats', async t => withFixture(t, async f => {
  const p=await runLumiV2Step({env:offlineEnv,directorReview:{input:f.input,...f.options},fetchImpl:()=>{throw Error('provider should never be called');}});
  assert.equal(p.integration.entrypoint,'lib/lumi-series-v2-execution.js:runLumiV2Step');
  assert.deepEqual(p.integration.duration_vector,[4,4,4,4,5,5]); assert.equal(p.integration.pedagogical_beats,9);
  assert.equal(p.integration.recovery_state_mutated,false); assert.equal(p.integration.provider_boundary_reached,false);
  assert.equal(p.episode_resumed,false); assert.equal(p.provider_calls,0);
}));

test('feature OFF preserves original rejection and legacy global selection', async () => {
  assert.equal(pipelineVersion({}),'legacy');
  for(const flag of [undefined,'false']) await assert.rejects(runLumiV2Step({env:{LUMI_CINEMATIC_DIRECTOR_V1:flag,LUMI_RUNTIME_ENV:'local_offline'}}),/v2_staging_scoped_authorization_required/);
  await assert.rejects(runLumiV2Step({env:{...offlineEnv,LUMI_RUNTIME_ENV:'staging'}}),/director_local_offline_episode_selection_required/);
});

test('canonical entry rejects changed duration, learning goal or a new episode', async t => withFixture(t, async f => {
  const call=()=>runLumiV2Step({env:offlineEnv,directorReview:{input:f.input,...f.options}});
  f.input.contract.DURATION=5; await assert.rejects(call(),/approved_shot_duration/);
  f.input.contract.DURATION=4; f.input.direction.educational_goal='New lesson'; await assert.rejects(call(),/persisted_educational_goal/);
  f.input.episode_id='new episode'; await assert.rejects(call(),/existing_episode/);
}));

test('canonical question binds s35 source to s37 educational beat, without changing either', async t => withFixture(t, async f => {
  const p=await runLumiV2Step({env:offlineEnv,directorReview:{input:f.input,...f.options}});
  assert.equal(p.integration.educational_beat_id,'s37'); assert.equal(p.integration.source_scene_id,'s35');
  assert.equal(p.integration.canonical_shot_id,'q37'); assert.equal(p.shot_id,'q35');
  assert.equal(p.gates.DIRECTION_COHERENT,true);
}, {grammar:'ATTENTIVE_WAIT'}));

test('existing Recovery Manager preserves ambiguity; reopening or new fingerprint cannot resend', async t => withFixture(t, async f => {
  const store=new MemoryLumiRecoveryStore(), manager=new LumiRecoveryIncidentManager({store});
  const id='SYNTHETIC_EXISTING_EPISODE';
  await store.putEpisode({episode_id:id,status:'PAUSED_INCIDENT',active_incident_id:null,first_pending_action:'video:q32',actions:[{key:'video:q32',dispatch_state:'EMISSION_AMBIGUOUS',provider_request_id:null}],metadata:{}});
  const before=stableStringify(await store.getEpisode(id)); let continuations=0;
  const a=await compile(f); f.input.revision++; f.input.direction.reason_es='Revisión pendiente'; await compile(f);
  const result=await manager.resume(id,{continueAction:()=>{continuations++;throw Error('NO RESUBMIT');}});
  assert.equal(result.status,'AMBIGUITY_PRESERVED'); assert.equal(continuations,0); assert.equal(a.recovery.new_hash_authorizes_job,false);
  assert.equal(stableStringify(await store.getEpisode(id)),before);
}));

test('documentary regressions preserve q31 warning and later forensic q32/q33 findings, never certify pixels', async () => {
  const base=new URL('../docs/cinematic-director-v1/evidence/',import.meta.url);
  const forensic=JSON.parse(await readFile(new URL('LUMI_q32_q33_REPAIR_PLAN.json',base)));
  const earlier=JSON.parse(await readFile(new URL('LUMI_SERIES_V2_QUALITY_GATE_REPORT.json',base)));
  const quality=JSON.parse(await readFile(new URL('LUMI_SERIES_V2_QUALITY_BUDGET_REVIEW.json',base)));
  assert.equal(forensic.analysis.q32.classification,'TEMPORAL_MUTATION');
  assert.equal(forensic.analysis.q32.VIDEO_ANATOMY,'BLOCKER');
  assert.equal(forensic.analysis.q33.classification,'SOURCE_DEFECT_WITH_TEMPORAL_AMPLIFICATION');
  assert.equal(forensic.analysis.q33.SOURCE_ANATOMY,'BLOCKER');
  assert.equal(quality.human_approval.status,'HUMAN_APPROVED');
  assert.equal(quality.human_approval.human_wing_decision,'APPROVED_WITH_WARNING');
  assert.equal(quality.human_approval.actor,undefined); // Missing metadata is not invented.
  assert.ok(JSON.stringify(earlier).includes('INITIAL_PASS_WITHDRAWN'));
});

test('sequence review does not label incomplete evidence as PASS', async () => {
  const pack=JSON.parse(await readFile(new URL('../episodes/ep_lumi_flores_003/SHOT_PACK_V1.json',import.meta.url)));
  assert.equal(evaluateSequence([],pack).status,'REVIEW_REQUIRED');
  pack.shots[0].duration_seconds=5; assert.equal(evaluateSequence([],pack).status,'BLOCKED');
});

test('all tested paths have zero real outbound attempts', () => {
  assert.deepEqual(globalThis.LUMI_OFFLINE_GUARD.attempts,[]);
});
