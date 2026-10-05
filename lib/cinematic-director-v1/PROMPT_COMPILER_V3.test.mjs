import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compilePromptDraft, compileValidatedPrompt, evaluateReadiness, validateShotContract, verifyLocalArtifact, sha256, CONTRACT_SCHEMA, NEGATIVE_STYLES, REQUIRED_CONTRACT_FIELDS, READINESS_CHECKS, REFERENCE_QA_CHECKS } from './PROMPT_COMPILER_V3.mjs';

// SYNTHETIC TEST FIXTURES ONLY. None of these IDs or QA results are real Golden References.
function fixture() {
  const sourceHash = sha256('synthetic source');
  const characterHash = sha256('synthetic character lock');
  const worldHash = sha256('synthetic world lock');
  const required = { id: 'flower_red', count: 1, color: 'red', shape: 'flower', placement: 'left of Lumi' };
  const state = { description: 'One stationary red flower, fully visible.', object_inventory: [{ ...required, visibility: 'FULLY_VISIBLE' }] };
  const contract = {
    shot_id: 'TEST_ONLY', shot_type: 'MEDIUM_TEACHING',
    START_STATE: structuredClone(state),
    CHARACTER_STATE: { description: 'TEST ONLY canonical two-wing character.', character_lock_id: 'TEST_CHARACTER', character_lock_sha256: characterHash, world_lock_id: 'TEST_WORLD', world_lock_sha256: worldHash, identity_preserved: true, canonical_wings: 2 },
    REQUIRED_OBJECTS: [required],
    EDUCATIONAL_INVARIANTS: ['count', 'color', 'shape'].map(property => ({ object_id: required.id, property, value: required[property] })),
    PRIMARY_ACTION: { action: 'small_pointing_gesture', description: 'One small pointing gesture toward the flower.' },
    ALLOWED_SECONDARY_MOTION: ['blink'],
    FORBIDDEN_ACTIONS: ['Change object count, color or shape.', 'Add limbs or wings.', 'Add text.'],
    CAMERA: { type: 'STATIC', description: 'Fixed medium composition.', necessary: false },
    END_STATE: structuredClone(state), DURATION: 4,
    SOURCE_ARTIFACT: { artifact_id: 'TEST_SOURCE', path: 'SYNTHETIC_NOT_A_REAL_PATH', sha256: sourceHash },
    GOLDEN_REFERENCES: ['character', 'world', 'lighting', 'motion'].map(role => ({ artifact_id: `TEST_${role}`, role, sha256: sha256(`synthetic ${role}`) })),
    NEGATIVE_STYLE_CONTRACT: [...NEGATIVE_STYLES]
  };
  const context = {
    style_authority: { id: 'LUMI_SERIES_STYLE_V2', status: 'FROZEN' },
    locks: { character: { id: 'TEST_CHARACTER', sha256: characterHash, status: 'FROZEN', description: 'SYNTHETIC fixture lock.' }, world: { id: 'TEST_WORLD', sha256: worldHash, status: 'FROZEN', description: 'SYNTHETIC fixture garden.' } },
    artifact_evidence: {},
    source_readiness: { TEST_SOURCE: Object.fromEntries(READINESS_CHECKS.map(check => [check, 'PASS'])) },
    provider_policy: { model: 'Kling 3.0 Standard', audio: false, multi_shots: false, playback_rate: 1, automatic_retries: 0, automatic_variants: 0, automatic_resubmits: 0, provider_repair_budget: 0 },
    economic: { episode_projected_usd: 3.5, currency: 'USD', quote_verified: true },
    postproduction: { deterministic_educational_graphics: true, text_character_overlap: 0, visible_pause_label: false, playback_rate: 1, master_width: 1080, master_height: 1920, planned_captions: ['¿Qué color ves?'] }
  };
  for (const artifact of [contract.SOURCE_ARTIFACT, ...contract.GOLDEN_REFERENCES]) {
    context.artifact_evidence[artifact.artifact_id] = { path: artifact.path, expected_sha256: artifact.sha256, actual_sha256: artifact.sha256, hash_status: 'PASS', human_approved: true, qa_status: 'PASS', qa_checks: Object.fromEntries(REFERENCE_QA_CHECKS.map(check => [check, 'PASS'])) };
  }
  return { contract, context };
}
const codes = (contract, context) => evaluateReadiness(contract, context).blockers.map(error => error.code);

test('complete synthetic fixture is review-ready but never dispatch-authorized', () => {
  const { contract, context } = fixture();
  const result = compileValidatedPrompt(contract, context);
  assert.equal(result.gates.evidence_ready, true);
  assert.equal(result.provider_dispatch_authorized, false);
  assert.equal(result.gates.provider_dispatch_authorized, false);
  assert.equal(result.gates.execution_hold, 'DESIGN_ONLY_NO_PROVIDERS');
  assert.equal(result.provider_calls, 0);
});

for (const field of REQUIRED_CONTRACT_FIELDS) test(`missing ${field} blocks validated compilation`, () => {
  const { contract, context } = fixture();
  delete contract[field];
  assert.equal(validateShotContract(contract).pass, false);
  assert.throws(() => compileValidatedPrompt(contract, context), error => error.code === 'LUMI_PREFLIGHT_BLOCKED');
});

test('multiple primary actions are rejected as an array', () => {
  const { contract } = fixture();
  contract.PRIMARY_ACTION = [contract.PRIMARY_ACTION, { action: 'small_wave', description: 'Wave.' }];
  assert.equal(validateShotContract(contract).pass, false);
});
test('unsupported motion and camera are rejected', () => {
  const { contract } = fixture();
  contract.PRIMARY_ACTION.action = 'jump_and_spin';
  contract.CAMERA.type = 'AGGRESSIVE_ORBIT';
  assert.equal(validateShotContract(contract).pass, false);
});
test('gentle tracking needs explicit necessity', () => {
  const { contract, context } = fixture();
  contract.CAMERA.type = 'GENTLE_TRACKING';
  assert.ok(codes(contract, context).includes('TRACKING_NEEDS_JUSTIFICATION'));
});
test('duplicate primary action and excess secondary motion are rejected', () => {
  const { contract } = fixture();
  contract.ALLOWED_SECONDARY_MOTION = ['small_pointing_gesture'];
  assert.equal(validateShotContract(contract).pass, false);
  contract.ALLOWED_SECONDARY_MOTION = ['blink', 'small_wave', 'smile'];
  assert.equal(validateShotContract(contract).pass, false);
});
test('all source readiness checks must explicitly PASS', () => {
  for (const check of READINESS_CHECKS) {
    const { contract, context } = fixture();
    delete context.source_readiness.TEST_SOURCE[check];
    assert.ok(codes(contract, context).includes('SOURCE_NOT_READY'), check);
  }
});
test('secondary movement cannot introduce a second performance action', () => {
  for (const secondary of ['small_wave', 'gentle_wand_gesture', 'small_pointing_gesture', 'look_at_object', 'look_at_viewer']) {
    const { contract } = fixture();
    contract.ALLOWED_SECONDARY_MOTION = [secondary];
    assert.equal(validateShotContract(contract).pass, false, secondary);
  }
});
test('review metadata is optional and cannot override evidence or execution hold', () => {
  const { contract, context } = fixture();
  contract.metadata = { contract_version: 'LUMI_KLING_SHOT_CONTRACT_V2', historical_ledger_alias: 'q37', quote_verified: true, provider_dispatch_authorized: true };
  contract.CHARACTER_STATE.wand_policy = 'Do not invent a wand.';
  context.economic.quote_verified = false;
  const review = compilePromptDraft(contract, context);
  assert.equal(review.gates.contract_valid, true);
  assert.equal(review.gates.evidence_ready, false);
  assert.equal(review.gates.provider_dispatch_authorized, false);
});
test('experimental artifacts cannot become the production baseline despite old Human Approval', () => {
  const { contract, context } = fixture();
  context.artifact_evidence.TEST_SOURCE.classification = 'EXPERIMENTAL_NOT_PRODUCTION_BASELINE';
  assert.ok(codes(contract, context).includes('EXPERIMENTAL_BASELINE_FORBIDDEN'));
});
test('golden hash mismatch is blocked even with QA PASS', () => {
  const { contract, context } = fixture();
  context.artifact_evidence.TEST_character.actual_sha256 = sha256('tampered bytes');
  assert.ok(codes(contract, context).includes('ARTIFACT_BYTES_UNVERIFIED'));
});
test('golden QA warning, missing Human Approval and missing golden role are blocked', () => {
  const { contract, context } = fixture();
  context.artifact_evidence.TEST_character.qa_checks.wings = 'HUMAN_WARNING';
  context.artifact_evidence.TEST_world.human_approved = false;
  contract.GOLDEN_REFERENCES[3].role = 'character';
  const errors = codes(contract, context);
  assert.ok(errors.includes('GOLDEN_QA_NOT_PASS'));
  assert.ok(errors.includes('HUMAN_REFERENCE_APPROVAL_MISSING'));
  assert.ok(errors.includes('MISSING_GOLDEN_ROLE'));
});
test('source path cannot substitute another artifact', () => {
  const { contract, context } = fixture();
  contract.SOURCE_ARTIFACT.path = 'OTHER_SOURCE';
  assert.ok(codes(contract, context).includes('SOURCE_PATH_MISMATCH'));
});
test('frozen character and world lock digests must match', () => {
  for (const kind of ['character', 'world']) {
    const { contract, context } = fixture();
    context.locks[kind].sha256 = sha256('different lock');
    assert.ok(codes(contract, context).includes('LOCK_MISMATCH'));
  }
});
test('cost is fail-closed for missing, unverified, nonnumeric or above-ceiling values', () => {
  for (const value of [null, undefined, NaN, Infinity, '3.50', -1]) {
    const { contract, context } = fixture();
    context.economic.episode_projected_usd = value;
    assert.ok(codes(contract, context).includes('COST_UNKNOWN_OR_UNVERIFIED'));
  }
  const { contract, context } = fixture();
  context.economic.episode_projected_usd = 4.000001;
  assert.ok(codes(contract, context).includes('EPISODE_CEILING_EXCEEDED'));
  context.economic.episode_projected_usd = 4;
  assert.equal(evaluateReadiness(contract, context).evidence_ready, true);
  context.economic.quote_verified = false;
  assert.ok(codes(contract, context).includes('COST_UNKNOWN_OR_UNVERIFIED'));
});
test('inventory omission, color drift, duplicate IDs and count drift are blocked', () => {
  const { contract, context } = fixture();
  contract.START_STATE.object_inventory = [];
  contract.END_STATE.object_inventory[0].color = 'blue';
  contract.END_STATE.object_inventory[0].count = 2;
  contract.REQUIRED_OBJECTS.push({ ...contract.REQUIRED_OBJECTS[0] });
  const errors = codes(contract, context);
  assert.ok(errors.includes('MISSING_EDUCATIONAL_OBJECT'));
  assert.ok(errors.includes('OBJECT_STATE_MISMATCH'));
  assert.ok(errors.includes('DUPLICATE_OBJECT_ID'));
});
test('invariants cannot omit educational properties or disagree with inventory', () => {
  const { contract, context } = fixture();
  contract.EDUCATIONAL_INVARIANTS[0].value = 2;
  contract.EDUCATIONAL_INVARIANTS.pop();
  const errors = codes(contract, context);
  assert.ok(errors.includes('INVARIANT_VALUE_MISMATCH'));
  assert.ok(errors.includes('MISSING_EDUCATIONAL_INVARIANT'));
});
test('undeclared educational objects are rejected, including an object-free opening', () => {
  const { contract, context } = fixture();
  contract.REQUIRED_OBJECTS = [];
  contract.EDUCATIONAL_INVARIANTS = [];
  assert.ok(codes(contract, context).includes('UNDECLARED_EDUCATIONAL_OBJECT'));
  contract.START_STATE.object_inventory = [];
  contract.END_STATE.object_inventory = [];
  assert.equal(validateShotContract(contract).pass, true);
});
test('educational objects must remain visible', () => {
  const { contract, context } = fixture();
  contract.END_STATE.object_inventory[0].visibility = 'PARTIAL';
  assert.ok(codes(contract, context).includes('EDUCATIONAL_OBJECT_OCCLUDED'));
});
test('PAUSA label variants, character text overlap and non-Full-HD output are blocked', () => {
  const { contract, context } = fixture();
  for (const caption of ['PAUSA', 'Pausa 2.5 segundos', 'pause', 'PÁUSA']) {
    context.postproduction.planned_captions = [caption];
    assert.ok(codes(contract, context).includes('PAUSE_LABEL_OR_CAPTIONS_UNVERIFIED'));
  }
  context.postproduction.text_character_overlap = 0.01;
  context.postproduction.master_width = 720;
  assert.ok(codes(contract, context).includes('POSTPRODUCTION_POLICY_MISMATCH'));
});
test('provider quality tier, audio, multishot, pacing, retries, variants and repairs remain locked', () => {
  const alternatives = { model: 'Kling 3.0 Pro', audio: true, multi_shots: true, playback_rate: 0.5, automatic_retries: 1, automatic_variants: 1, automatic_resubmits: 1, provider_repair_budget: 1 };
  for (const [key, value] of Object.entries(alternatives)) {
    const { contract, context } = fixture();
    context.provider_policy[key] = value;
    assert.ok(codes(contract, context).includes('PROVIDER_POLICY_MISMATCH'), key);
  }
});
test('duration range rejects unsupported durations', () => {
  for (const seconds of [2.99, 5.01, NaN, '4']) {
    const { contract } = fixture();
    contract.DURATION = seconds;
    assert.equal(validateShotContract(contract).pass, false);
  }
});
test('deterministic compiler is independent of object key ordering and does not mutate input', () => {
  const { contract, context } = fixture();
  const before = JSON.stringify({ contract, context });
  const reversed = value => Array.isArray(value) ? value.map(reversed) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reversed(item)])) : value;
  const a = compilePromptDraft(contract, context);
  const b = compilePromptDraft(reversed(contract), reversed(context));
  assert.equal(a.prompt, b.prompt);
  assert.equal(a.prompt_sha256, b.prompt_sha256);
  assert.equal(a.contract_sha256, b.contract_sha256);
  assert.equal(JSON.stringify({ contract, context }), before);
  assert.deepEqual(a.prompt.match(/^\d+\. /gm), Array.from({ length: 10 }, (_, i) => `${i + 1}. `));
});
test('empty or null drafts preserve unresolved blockers without dispatch', () => {
  for (const contract of [{}, null, []]) {
    const draft = compilePromptDraft(contract);
    assert.equal(draft.gates.evidence_ready, false);
    assert.equal(draft.gates.provider_dispatch_authorized, false);
    assert.match(draft.prompt, /UNRESOLVED/);
  }
});
test('local byte verification detects tampering and unavailable files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lumi-compiler-test-'));
  try {
    const path = join(directory, 'synthetic.txt');
    await writeFile(path, 'expected bytes');
    const artifact = { artifact_id: 'TEST_ONLY', path, sha256: sha256('expected bytes') };
    assert.equal((await verifyLocalArtifact(artifact)).hash_status, 'PASS');
    await writeFile(path, 'tampered bytes');
    assert.equal((await verifyLocalArtifact(artifact)).hash_status, 'FAIL');
    assert.equal((await verifyLocalArtifact({ ...artifact, path: join(directory, 'missing.txt') })).hash_status, 'UNAVAILABLE');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test('delivered JSON schema matches the compiler schema', async () => {
  const delivered = JSON.parse(await readFile(new URL('./LUMI_KLING_SHOT_CONTRACT_V2.schema.json', import.meta.url), 'utf8'));
  assert.deepEqual(delivered, CONTRACT_SCHEMA);
});
