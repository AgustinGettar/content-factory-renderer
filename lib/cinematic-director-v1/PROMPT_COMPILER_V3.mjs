/** Offline review compiler. No network, provider client, dispatcher, or paid operation. */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export const VERSION = 'PROMPT_COMPILER_V3';
export const ACTIONS = Object.freeze(['blink', 'look_at_object', 'look_at_viewer', 'small_pointing_gesture', 'small_wave', 'gentle_wand_gesture', 'subtle_wing_response', 'smile', 'natural_settle']);
export const SECONDARY_ACTIONS = Object.freeze(['blink', 'subtle_wing_response', 'smile', 'natural_settle']);
export const SHOT_TYPES = Object.freeze(['ESTABLISHING', 'MEDIUM_TEACHING', 'CLOSE_EMOTION', 'EDUCATIONAL_OBJECT', 'MAGIC_REWARD', 'QUESTION_TO_VIEWER']);
export const CAMERA_TYPES = Object.freeze(['STATIC', 'SUBTLE_PUSH_IN', 'SUBTLE_REFRAME', 'GENTLE_TRACKING']);
export const NEGATIVE_STYLES = Object.freeze(['flat cartoon', '2D illustration', 'cel shading', 'anime', 'comic look', 'cheap TV animation', 'simplified low-detail rendering', 'plastic toy', 'rubber toy', 'human photorealism', 'live-action humanization', 'uncanny insect anatomy', 'overly realistic skin pores']);
export const READINESS_CHECKS = Object.freeze(['STYLE_MATCH_TO_GOLDEN_REFERENCE', 'IDENTITY', 'ANATOMY', 'MATERIALS', 'LIGHTING', 'WORLD', 'OBJECT_COMPLETENESS', 'EDUCATIONAL_SEMANTICS', 'MOTION_SPACE', 'CAMERA_COMPATIBILITY', 'END_STATE_COMPATIBILITY']);
export const REFERENCE_QA_CHECKS = Object.freeze(['identity', 'anatomy', 'materials', 'lighting', 'wings', 'clothing', 'face', 'no_text_overlap', 'no_motion_blur', 'no_corruption']);
export const REQUIRED_CONTRACT_FIELDS = Object.freeze(['START_STATE', 'CHARACTER_STATE', 'REQUIRED_OBJECTS', 'EDUCATIONAL_INVARIANTS', 'PRIMARY_ACTION', 'ALLOWED_SECONDARY_MOTION', 'FORBIDDEN_ACTIONS', 'CAMERA', 'END_STATE', 'DURATION', 'SOURCE_ARTIFACT', 'GOLDEN_REFERENCES', 'NEGATIVE_STYLE_CONTRACT']);

const str = { type: 'string', minLength: 1 };
const hash = { type: 'string', pattern: '^[a-f0-9]{64}$' };
const enumeration = values => ({ type: 'string', enum: values });
const arr = (items, minItems = 0, maxItems) => ({ type: 'array', items, minItems, ...(maxItems === undefined ? {} : { maxItems }) });
const obj = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const objectFields = { id: str, count: { type: 'integer', minimum: 1 }, color: str, shape: str, placement: str };
const state = obj({ description: str, object_inventory: arr(obj({ ...objectFields, visibility: enumeration(['FULLY_VISIBLE', 'PARTIAL', 'HIDDEN']) })) });
export const CONTRACT_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'urn:lumi:LUMI_KLING_SHOT_CONTRACT_V2',
  title: 'LUMI_KLING_SHOT_CONTRACT_V2',
  description: 'Offline contract. Schema validity alone never authorizes a provider call. Runtime readiness and evidence gates remain mandatory.',
  ...obj({
    shot_id: str,
    shot_type: enumeration(SHOT_TYPES),
    START_STATE: state,
    CHARACTER_STATE: obj({ description: str, character_lock_id: str, character_lock_sha256: hash, world_lock_id: str, world_lock_sha256: hash, identity_preserved: { const: true }, canonical_wings: { const: 2 } }),
    REQUIRED_OBJECTS: arr(obj(objectFields)),
    EDUCATIONAL_INVARIANTS: arr(obj({ object_id: str, property: enumeration(['count', 'color', 'shape']), value: { anyOf: [{ type: 'integer', minimum: 1 }, str] } })),
    PRIMARY_ACTION: obj({ action: enumeration(ACTIONS), description: str }),
    ALLOWED_SECONDARY_MOTION: { ...arr(enumeration(SECONDARY_ACTIONS), 0, 2), uniqueItems: true },
    FORBIDDEN_ACTIONS: arr(str, 1),
    CAMERA: obj({ type: enumeration(CAMERA_TYPES), description: str, necessary: { type: 'boolean' } }),
    END_STATE: state,
    DURATION: { type: 'number', minimum: 3, maximum: 5 },
    SOURCE_ARTIFACT: obj({ artifact_id: str, path: str, sha256: hash }),
    GOLDEN_REFERENCES: arr(obj({ artifact_id: str, role: enumeration(['character', 'world', 'lighting', 'motion']), sha256: hash }), 4),
    NEGATIVE_STYLE_CONTRACT: { ...arr(enumeration(NEGATIVE_STYLES), NEGATIVE_STYLES.length, NEGATIVE_STYLES.length), uniqueItems: true }
  })
};

// Annotations do not substitute for verified context or participate in provider policy.
CONTRACT_SCHEMA.properties.metadata = { type: 'object', additionalProperties: true };
CONTRACT_SCHEMA.properties.CHARACTER_STATE.properties.wand_policy = str;

export function stableStringify(value) {
  if (value === undefined) return '"UNRESOLVED"';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}
export const sha256 = value => createHash('sha256').update(value).digest('hex');
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Implements only the subset used by the exported schema; no external dependencies. */
function schemaErrors(schema, value, path = '$') {
  const errors = [];
  const add = code => errors.push({ code, path });
  if (schema.anyOf && !schema.anyOf.some(candidate => schemaErrors(candidate, value, path).length === 0)) add('SCHEMA_ANY_OF');
  if ('const' in schema && value !== schema.const) add('SCHEMA_CONST');
  if (schema.enum && !schema.enum.includes(value)) add('SCHEMA_ENUM');
  if (schema.type) {
    const valid = schema.type === 'array' ? Array.isArray(value)
      : schema.type === 'object' ? record(value)
      : schema.type === 'integer' ? Number.isInteger(value)
      : schema.type === 'number' ? typeof value === 'number' && Number.isFinite(value)
      : typeof value === schema.type;
    if (!valid) { add('SCHEMA_TYPE'); return errors; }
  }
  if (typeof value === 'string') {
    if (schema.minLength && value.trim().length < schema.minLength) add('SCHEMA_MIN_LENGTH');
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) add('SCHEMA_PATTERN');
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) add('SCHEMA_MINIMUM');
    if (schema.maximum !== undefined && value > schema.maximum) add('SCHEMA_MAXIMUM');
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) add('SCHEMA_MIN_ITEMS');
    if (schema.maxItems !== undefined && value.length > schema.maxItems) add('SCHEMA_MAX_ITEMS');
    if (schema.uniqueItems && new Set(value.map(stableStringify)).size !== value.length) add('SCHEMA_DUPLICATE');
    if (schema.items) value.forEach((item, index) => errors.push(...schemaErrors(schema.items, item, `${path}[${index}]`)));
  }
  if (record(value) && schema.properties) {
    for (const key of schema.required || []) if (!Object.hasOwn(value, key)) errors.push({ code: 'MISSING_REQUIRED_FIELD', path: `${path}.${key}` });
    for (const [key, item] of Object.entries(value)) {
      if (schema.properties[key]) errors.push(...schemaErrors(schema.properties[key], item, `${path}.${key}`));
      else if (schema.additionalProperties === false) errors.push({ code: 'UNKNOWN_FIELD', path: `${path}.${key}` });
    }
  }
  return errors;
}

export function validateShotContract(contract) {
  const errors = schemaErrors(CONTRACT_SCHEMA, contract);
  if (errors.length) return { pass: false, errors };
  const add = (code, path) => errors.push({ code, path });
  if (contract.CAMERA.type === 'GENTLE_TRACKING' && !contract.CAMERA.necessary) add('TRACKING_NEEDS_JUSTIFICATION', '$.CAMERA.necessary');
  if (contract.ALLOWED_SECONDARY_MOTION.includes(contract.PRIMARY_ACTION.action)) add('PRIMARY_ACTION_DUPLICATED', '$.ALLOWED_SECONDARY_MOTION');
  for (const role of ['character', 'world', 'lighting', 'motion']) {
    if (!contract.GOLDEN_REFERENCES.some(ref => ref.role === role)) add('MISSING_GOLDEN_ROLE', `$.GOLDEN_REFERENCES.${role}`);
  }
  for (const [path, items] of [['REQUIRED_OBJECTS', contract.REQUIRED_OBJECTS], ['START_STATE.object_inventory', contract.START_STATE.object_inventory], ['END_STATE.object_inventory', contract.END_STATE.object_inventory]]) {
    if (new Set(items.map(item => item.id)).size !== items.length) add('DUPLICATE_OBJECT_ID', `$.${path}`);
  }
  const required = new Map(contract.REQUIRED_OBJECTS.map(item => [item.id, item]));
  for (const stateName of ['START_STATE', 'END_STATE']) {
    const inventory = new Map(contract[stateName].object_inventory.map(item => [item.id, item]));
    // Inventory is exclusively the educational-object inventory; world props live in the world lock.
    for (const id of inventory.keys()) if (!required.has(id)) add('UNDECLARED_EDUCATIONAL_OBJECT', `$.${stateName}.${id}`);
    for (const item of required.values()) {
      const found = inventory.get(item.id);
      if (!found) { add('MISSING_EDUCATIONAL_OBJECT', `$.${stateName}.${item.id}`); continue; }
      for (const property of ['count', 'color', 'shape']) {
        if (found[property] !== item[property]) add('OBJECT_STATE_MISMATCH', `$.${stateName}.${item.id}.${property}`);
      }
      if (found.visibility !== 'FULLY_VISIBLE') add('EDUCATIONAL_OBJECT_OCCLUDED', `$.${stateName}.${item.id}.visibility`);
    }
  }
  const invariantKeys = new Set();
  for (const invariant of contract.EDUCATIONAL_INVARIANTS) {
    const key = `${invariant.object_id}:${invariant.property}`;
    if (invariantKeys.has(key)) add('DUPLICATE_INVARIANT', `$.EDUCATIONAL_INVARIANTS.${key}`);
    invariantKeys.add(key);
    const item = required.get(invariant.object_id);
    if (!item) add('INVARIANT_UNKNOWN_OBJECT', `$.EDUCATIONAL_INVARIANTS.${invariant.object_id}`);
    else if (item[invariant.property] !== invariant.value) add('INVARIANT_VALUE_MISMATCH', `$.EDUCATIONAL_INVARIANTS.${key}`);
  }
  for (const id of required.keys()) for (const property of ['count', 'color', 'shape']) {
    if (!invariantKeys.has(`${id}:${property}`)) add('MISSING_EDUCATIONAL_INVARIANT', `$.EDUCATIONAL_INVARIANTS.${id}.${property}`);
  }
  return { pass: errors.length === 0, errors };
}

/** Hash local bytes only. A successful hash is not visual QA or Human Approval. */
export async function verifyLocalArtifact(artifact) {
  try {
    const bytes = await readFile(artifact.path);
    const actual = sha256(bytes);
    return { artifact_id: artifact.artifact_id, path: artifact.path, expected_sha256: artifact.sha256, actual_sha256: actual, bytes: bytes.length, hash_status: actual === artifact.sha256 && /^[a-f0-9]{64}$/.test(artifact.sha256) ? 'PASS' : 'FAIL' };
  } catch {
    return { artifact_id: artifact.artifact_id, path: artifact.path, expected_sha256: artifact.sha256, actual_sha256: null, bytes: null, hash_status: 'UNAVAILABLE' };
  }
}

/** Checks supplied evidence; it cannot independently certify artistic/human judgments. */
export function evaluateSourceEvidence(contract, context = {}) {
  const validation = validateShotContract(contract);
  const blockers = [...validation.errors];
  const add = (code, path) => blockers.push({ code, path });
  if (context.style_authority?.id !== 'LUMI_SERIES_STYLE_V2' || context.style_authority?.status !== 'FROZEN') add('STYLE_AUTHORITY_UNFROZEN', 'context.style_authority');
  const character = record(contract?.CHARACTER_STATE) ? contract.CHARACTER_STATE : {};
  for (const kind of ['character', 'world']) {
    const lock = context.locks?.[kind];
    if (!lock || lock.status !== 'FROZEN' || typeof lock.description !== 'string' || !lock.description.trim() || !/^[a-f0-9]{64}$/.test(lock.sha256 || '')) add('LOCK_UNFROZEN_OR_UNVERIFIED', `context.locks.${kind}`);
    else if (character[`${kind}_lock_id`] !== lock.id || character[`${kind}_lock_sha256`] !== lock.sha256) add('LOCK_MISMATCH', `$.CHARACTER_STATE.${kind}_lock_id`);
  }
  const source = record(contract?.SOURCE_ARTIFACT) ? contract.SOURCE_ARTIFACT : {};
  const refs = Array.isArray(contract?.GOLDEN_REFERENCES) ? contract.GOLDEN_REFERENCES.filter(record) : [];
  for (const artifact of [source, ...refs]) {
    const evidence = context.artifact_evidence?.[artifact.artifact_id];
    const base = `context.artifact_evidence.${artifact.artifact_id || 'MISSING'}`;
    if (!evidence || evidence.hash_status !== 'PASS' || evidence.expected_sha256 !== artifact.sha256 || evidence.actual_sha256 !== artifact.sha256 || !/^[a-f0-9]{64}$/.test(artifact.sha256 || '')) add('ARTIFACT_BYTES_UNVERIFIED', base);
    if (evidence?.human_approved !== true) add('HUMAN_REFERENCE_APPROVAL_MISSING', base);
    if (evidence?.qa_status !== 'PASS') add('ARTIFACT_QA_NOT_PASS', base);
    if (evidence?.classification === 'EXPERIMENTAL_NOT_PRODUCTION_BASELINE') add('EXPERIMENTAL_BASELINE_FORBIDDEN', base);
    if (artifact === source && evidence?.path !== artifact.path) add('SOURCE_PATH_MISMATCH', base);
    if (artifact !== source) {
      for (const check of REFERENCE_QA_CHECKS) if (evidence?.qa_checks?.[check] !== 'PASS') add('GOLDEN_QA_NOT_PASS', `${base}.qa_checks.${check}`);
    }
  }
  const readiness = context.source_readiness?.[source.artifact_id];
  for (const check of READINESS_CHECKS) if (readiness?.[check] !== 'PASS') add('SOURCE_NOT_READY', `context.source_readiness.${source.artifact_id || 'MISSING'}.${check}`);
  return { contract_valid: validation.pass, blockers };
}

// Historical V3 policy is unchanged. The director reuses source evidence separately.
export function evaluateReadiness(contract, context = {}) {
  const source = evaluateSourceEvidence(contract, context);
  const validation = { pass: source.contract_valid };
  const blockers = [...source.blockers];
  const add = (code, path) => blockers.push({ code, path });
  const policy = context.provider_policy || {};
  for (const [key, value] of Object.entries({ model: 'Kling 3.0 Standard', audio: false, multi_shots: false, playback_rate: 1, automatic_retries: 0, automatic_variants: 0, automatic_resubmits: 0, provider_repair_budget: 0 })) {
    if (policy[key] !== value) add('PROVIDER_POLICY_MISMATCH', `context.provider_policy.${key}`);
  }
  const economic = context.economic || {};
  if (economic.quote_verified !== true || economic.currency !== 'USD' || !Number.isFinite(economic.episode_projected_usd) || economic.episode_projected_usd < 0) add('COST_UNKNOWN_OR_UNVERIFIED', 'context.economic');
  else if (economic.episode_projected_usd > 4) add('EPISODE_CEILING_EXCEEDED', 'context.economic.episode_projected_usd');
  blockers.push(...evaluatePostproductionEvidence(context));
  return { contract_valid: validation.pass, evidence_ready: blockers.length === 0, blockers, provider_dispatch_authorized: false, execution_hold: 'DESIGN_ONLY_NO_PROVIDERS', provider_calls: 0 };
}

/** Shared editorial gate; no source or provider policy changes. */
export function evaluatePostproductionEvidence(context = {}) {
  const blockers = [];
  const add = (code, path) => blockers.push({ code, path });
  const graphics = context.postproduction || {};
  for (const [key, value] of Object.entries({ deterministic_educational_graphics: true, text_character_overlap: 0, visible_pause_label: false, playback_rate: 1, master_width: 1080, master_height: 1920 })) {
    if (graphics[key] !== value) add('POSTPRODUCTION_POLICY_MISMATCH', `context.postproduction.${key}`);
  }
  if (!Array.isArray(graphics.planned_captions) || graphics.planned_captions.some(text => typeof text !== 'string' || /\bpaus[ae]\b/i.test(text.normalize('NFD').replace(/[\u0300-\u036f]/g, '')))) add('PAUSE_LABEL_OR_CAPTIONS_UNVERIFIED', 'context.postproduction.planned_captions');
  return blockers;
}

/** Exactly ten ordered sections. Unavailable evidence stays visibly UNRESOLVED. */
export function compilePromptDraft(contract = {}, context = {}) {
  const c = record(contract) ? contract : {};
  const sections = [
    ['GOLDEN STYLE AUTHORITY', { style: 'premium feature-film-quality stylized 3D CGI', authority: context.style_authority, references: c.GOLDEN_REFERENCES }],
    ['CANONICAL CHARACTER LOCK', { lock: context.locks?.character, state: c.CHARACTER_STATE }],
    ['CANONICAL WORLD LOCK', context.locks?.world],
    ['EXACT START STATE', c.START_STATE],
    ['ONE PRIMARY ACTION', c.PRIMARY_ACTION],
    ['ALLOWED SECONDARY MOTION', c.ALLOWED_SECONDARY_MOTION],
    ['EDUCATIONAL INVARIANTS', { required_objects: c.REQUIRED_OBJECTS, invariants: c.EDUCATIONAL_INVARIANTS, execution: 'Exact colors, geometry and text are deterministic postproduction. Preserve count, visibility, silhouette and motion space.' }],
    ['FORBIDDEN CHANGES', { actions: c.FORBIDDEN_ACTIONS, negative_style: c.NEGATIVE_STYLE_CONTRACT, anatomy: 'Preserve canonical anatomy, two wings, clothing, face and all locks.' }],
    ['CAMERA INSTRUCTION', { camera: c.CAMERA, duration_seconds: c.DURATION, playback_rate: 1, audio: false, multi_shots: false, shot: 'single continuous shot' }],
    ['EXACT END STATE', c.END_STATE]
  ];
  const prompt = sections.map(([title, value], i) => `${i + 1}. ${title}\n${stableStringify(value)}`).join('\n\n');
  const gates = evaluateReadiness(c, context);
  return { compiler_version: VERSION, mode: 'OFFLINE_REVIEW_DRAFT', shot_id: c.shot_id ?? 'UNRESOLVED', prompt, prompt_sha256: sha256(prompt), contract_sha256: sha256(stableStringify(c)), gates, provider_calls: 0 };
}

export function compileValidatedPrompt(contract, context) {
  const result = compilePromptDraft(contract, context);
  if (!result.gates.evidence_ready) {
    const error = new Error('BLOCKED: contract or evidence readiness is incomplete. No provider call is available.');
    error.code = 'LUMI_PREFLIGHT_BLOCKED';
    error.blockers = result.gates.blockers;
    throw error;
  }
  return { ...result, mode: 'VALIDATED_OFFLINE_REVIEW', provider_dispatch_authorized: false };
}
