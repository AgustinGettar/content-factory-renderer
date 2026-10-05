import Ajv2020 from 'ajv/dist/2020.js';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { compilePromptDraft, validateShotContract, evaluateSourceEvidence, evaluatePostproductionEvidence, verifyLocalArtifact, stableStringify, sha256 } from './PROMPT_COMPILER_V3.mjs';
import { bodyAnatomyGate } from '../lumi-series-v2-gates.js';
import { POLICY, CAPABILITIES } from './profiles.js';
import { evaluateTopology, TOPOLOGY } from './topology.js';
import { ACTING_VERSION, ACTING_PRESETS, GRAMMAR_PRESET } from './acting-presets.js';
import { GRAMMAR, LABELS, GRAMMAR_VERSION, PROJECTION_VERSION, projectCinematicPrompt } from './projection.js';

export const DIRECTOR_VERSION = 'LUMI_CINEMATIC_DIRECTOR_V1';
const schema = JSON.parse(await readFile(new URL('./LUMI_CINEMATIC_DIRECTION_V1.schema.json', import.meta.url), 'utf8'));
const validateEnvelope = new Ajv2020({ allErrors: true, strict: false }).compile(schema);
const clone = v => structuredClone(v);
const digest = v => sha256(stableStringify(v));
const deepFreeze = v => { if (v && typeof v === 'object') { Object.values(v).forEach(deepFreeze); Object.freeze(v); } return v; };
const validDate = v => typeof v === 'string' && Number.isFinite(Date.parse(v));
const authenticReview = (r, synthetic) => Boolean(r?.actor && validDate(r.at) && r.scope && r.sha256 &&
  (r.kind === 'HUMAN' || r.kind === 'VISUAL_REVIEW' || (synthetic && r.kind === 'SYNTHETIC_FIXTURE')));

// Transport and recording timestamps are never creative input. Policy IDs/versions and values are.
function creativeContract(c) {
  const value = clone(c);
  delete value.metadata;
  if (value.SOURCE_ARTIFACT) delete value.SOURCE_ARTIFACT.path;
  return value;
}
function creativePolicy(p) {
  return { id: p.id, version: p.version, episode_id: p.episode_id, provider: p.provider, endpoint: p.endpoint,
    style: p.style, durations: p.durations, educational_objects: p.educational_objects, ledger_aliases: p.ledger_aliases, controls: p.controls,
    automatic_retries: p.automatic_retries, automatic_variants: p.automatic_variants, automatic_resubmits: p.automatic_resubmits,
    explicit_supersession: p.explicit_supersession, authority_records: p.authority_records, conflicts: p.conflicts };
}
export function redact(value) {
  if (typeof value === 'string') return value.replace(/https?:\/\/[^\s"<>]+/g, '[URL_REDACTED]');
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, val]) => [key,
    /authorization|secret|token|api.?key|credential/i.test(key) && typeof val === 'string' ? '[REDACTED]' : redact(val)]));
}

export function resolveEffectivePolicy(input, policy = POLICY) {
  const reasons = [];
  if (input.policy_id !== policy.id || input.episode_id !== policy.episode_id ||
      policy.durations?.[input.contract?.shot_id] !== input.contract?.DURATION ||
      policy.conflicts?.length || !policy.explicit_supersession?.length || !policy.authority?.length || policy.style !== 'premium stylized 3D CGI')
    reasons.push('POLICY_CONFLICT');
  if (policy.controls?.sound !== 'off' || policy.controls?.multi_shots !== false ||
      policy.automatic_retries !== 0 || policy.automatic_variants !== 0 || policy.automatic_resubmits !== 0)
    reasons.push('POLICY_CONFLICT');
  if (input.language !== policy.language && !policy.allowed_languages?.includes(input.language)) reasons.push('LANGUAGE_POLICY_CONFLICT');
  return { policy: clone(policy), reasons };
}

export function validateCapabilities(parameters, requiredControls, profile = CAPABILITIES, policy = POLICY) {
  const reasons = [];
  if (profile.provider !== policy.provider || profile.endpoint !== policy.endpoint || !profile.verified_on || !profile.provenance)
    reasons.push('CAPABILITY_PROFILE_MISMATCH');
  for (const field of requiredControls || []) if (!profile.fields?.[field]) reasons.push(`REQUIRED_CONTROL_UNSUPPORTED:${field}`);
  for (const [field, value] of Object.entries(parameters || {})) {
    const spec = profile.fields?.[field];
    if (!spec) { reasons.push(`UNSUPPORTED_FIELD:${field}`); continue; }
    const correctType = spec.type === 'integer' ? Number.isInteger(value) : typeof value === spec.type;
    if (!correctType || (typeof value === 'number' && !Number.isFinite(value)) ||
      (spec.enum && !spec.enum.includes(value)) || (spec.minimum !== undefined && value < spec.minimum) ||
      (spec.maximum !== undefined && value > spec.maximum)) reasons.push(`INVALID_PARAMETER:${field}`);
  }
  if (!profile.prompt_limit || !Number.isInteger(profile.prompt_limit.max) || profile.prompt_limit.max <= 0 ||
    !['unicode_codepoints', 'utf8_bytes'].includes(profile.prompt_limit.unit)) reasons.push('PROMPT_LIMIT_UNVERIFIED');
  if (!profile.media_constraints?.verified) reasons.push('MEDIA_CAPABILITIES_UNVERIFIED');
  return reasons;
}

async function persistImmutable(directory, name, value) {
  if (!directory) throw new Error('LOCAL_DIRECTOR_OUTPUT_DIRECTORY_REQUIRED');
  await mkdir(directory, { recursive: true });
  const path = join(directory, name), bytes = stableStringify(value) + '\n';
  try { await writeFile(path, bytes, { flag: 'wx', mode: 0o600 }); }
  catch (e) { if (e.code !== 'EEXIST' || await readFile(path, 'utf8') !== bytes) throw new Error('IMMUTABLE_DIRECTOR_RECORD_CONFLICT'); }
  return path;
}

export async function compileDirectorPacket(input, { outputDirectory, policy = POLICY, capabilities = CAPABILITIES,
  transport = null, previousPacket = null, allowSyntheticFixtures = false, topologyReview = null } = {}) {
  const supplied = clone(input ?? {}), errors = [];
  const add = (code, path = '', domain = 'DIRECTION') => errors.push({ code, path, domain });
  const envelopeValid = validateEnvelope(supplied);
  if (!envelopeValid) for (const error of validateEnvelope.errors || []) add('DIRECTION_SCHEMA_INVALID', error.instancePath, 'SCHEMA');
  const c = supplied.contract || {}, d = supplied.direction || {};
  const validatedV2 = validateShotContract(c);
  for (const error of validatedV2.errors) add(error.code, error.path, 'SCHEMA');
  const synthetic = supplied.synthetic_fixture === true;
  const topology = !synthetic || topologyReview ? evaluateTopology({ stage:'SOURCE_PREFLIGHT', sha256:c.SOURCE_ARTIFACT?.sha256, review:topologyReview }) : null;
  if (topology && topology.status !== 'PASS') add('TOPOLOGY_'+topology.status, '', 'SOURCE');
  if (synthetic && !allowSyntheticFixtures) add('SYNTHETIC_EVIDENCE_NOT_REAL_APPROVAL', '', 'SOURCE');
  const resolved = resolveEffectivePolicy(supplied, policy);
  resolved.reasons.forEach(code => add(code, '', 'POLICY'));

  // Schema-valid review drafts still have separate source/evidence and execution gates.
  const context = clone(supplied.context || {});
  context.artifact_evidence ||= {};
  const media = Array.isArray(supplied.media) ? supplied.media : [];
  const refs = Array.isArray(c.GOLDEN_REFERENCES) ? c.GOLDEN_REFERENCES : [];
  const artifacts = [c.SOURCE_ARTIFACT, ...refs].filter(Boolean), byteChecks = [];
  for (const artifact of artifacts) {
    const file = media.find(m => m.artifact_id === artifact.artifact_id && m.sha256 === artifact.sha256);
    if (file && file.role !== (artifact === c.SOURCE_ARTIFACT ? 'source' : 'qa')) add('MEDIA_ROLE_MISMATCH', artifact.artifact_id, 'SOURCE');
    const check = file ? await verifyLocalArtifact({ ...artifact, path: file.path }) : { hash_status: 'UNAVAILABLE', actual_sha256: null };
    byteChecks.push({ artifact_id: artifact.artifact_id, ...check });
    // Local materialization paths are transport; canonical paths remain persistent identity.
    // An explicit canonical_path is accepted only with verified identical bytes.
    const canonicalBound = check.hash_status === 'PASS' && file?.canonical_path === artifact.path;
    context.artifact_evidence[artifact.artifact_id] = { ...context.artifact_evidence[artifact.artifact_id], ...check,
      ...(canonicalBound ? {path:artifact.path} : {}) };
    if (artifact === c.SOURCE_ARTIFACT && file?.path !== artifact.path && !canonicalBound) add('SOURCE_PATH_MISMATCH', artifact.artifact_id, 'SOURCE');
    if (check.hash_status !== 'PASS') add('ARTIFACT_BYTES_UNVERIFIED', artifact.artifact_id, 'SOURCE');
    const approval = supplied.reviews?.find(r => r.artifact_id === artifact.artifact_id && r.sha256 === artifact.sha256 &&
      r.scope === 'SOURCE_FOR_VIDEO' && r.status === 'APPROVED' && authenticReview(r, synthetic && allowSyntheticFixtures) &&
      (r.kind === 'HUMAN' || r.kind === 'SYNTHETIC_FIXTURE'));
    // Scoped warnings are retained below; no warning upgrades full source/golden QA to PASS.
    if (!approval) add('SCOPED_HUMAN_APPROVAL_MISSING', artifact.artifact_id, 'SOURCE');
  }
  const sourceEvidence = evaluateSourceEvidence(c, context);
  sourceEvidence.blockers.forEach(e => add(e.code, e.path, 'SOURCE'));
  evaluatePostproductionEvidence(context).forEach(e => add(e.code, e.path, 'DIRECTION'));
  try { bodyAnatomyGate(supplied.source_qa); }
  catch (error) { add('ANATOMY_REVIEW_REQUIRED', error.message, 'SOURCE'); }
  if (supplied.source_qa?.ANATOMY !== 'PASS') add('ANATOMY_REVIEW_REQUIRED', 'No generalized anatomy warning waiver', 'SOURCE');
  if (supplied.source_qa?.sha256 !== c.SOURCE_ARTIFACT?.sha256) add('SOURCE_QA_SHA_MISMATCH', '', 'SOURCE');

  // Facts must be explicitly recorded by the cited review on these exact source bytes.
  // No prose/regex classifier infers anatomy, free hands, camera support or laterality.
  const observed = (name, allowed) => {
    const f = supplied.facts?.[name];
    if (!f || !['OBSERVED', 'APPROVED'].includes(f.status) || (allowed && !allowed.includes(f.value))) {
      add('VISUAL_FACT_PENDING', name, 'SOURCE'); return undefined;
    }
    const bound = f.evidence_ids?.some(id => supplied.reviews?.some(r => r.id === id &&
      r.artifact_id === c.SOURCE_ARTIFACT?.artifact_id && r.sha256 === c.SOURCE_ARTIFACT?.sha256 &&
      authenticReview(r, synthetic && allowSyntheticFixtures) && ['APPROVED', 'APPROVED_WITH_WARNING'].includes(r.status) &&
      Object.hasOwn(r.observations, name) && stableStringify(r.observations[name]) === stableStringify(f.value)));
    if (!bound) { add('VISUAL_FACT_UNBOUND', name, 'SOURCE'); return undefined; }
    return f.value;
  };
  if (envelopeValid && validatedV2.pass) {
    const a = d.principal_actions[0], grammar = GRAMMAR[a.grammar];
    if (grammar.v2_action !== c.PRIMARY_ACTION.action) add('PRIMARY_ACTION_CONTRADICTION');
    if (stableStringify(d.secondary_motion) !== stableStringify(c.ALLOWED_SECONDARY_MOTION)) add('SECONDARY_ACTION_CONTRADICTION');
    if (d.camera.type !== c.CAMERA.type) add('CAMERA_CONTRADICTION');
    if (d.principal_actions.length !== 1) add('MULTIPLE_PRIMARY_ACTIONS');
    if (a.body_motion !== 'PRESERVE_INITIAL') add('SOURCE_ACTION_MISMATCH', 'body turn reveals unverified anatomy even with a static camera');
    if (!['torso', 'feet', 'posterior_silhouette', 'educational_objects'].every(p => d.stable_parts.includes(p))) add('STABILITY_CONTRACT_INCOMPLETE');
    const wandState = observed('wand_state', ['HELD_LEFT', 'HELD_RIGHT', 'ABSENT', 'OFFSCREEN']);
    if (wandState?.startsWith('HELD') && !d.stable_parts.includes('wand')) add('WAND_STABILITY_REQUIRED');
    observed('body_orientation', ['FRONT', 'THREE_QUARTER']);
    observed('framing', ['SOURCE_SUPPORTS_SHOT']);
    observed('caption_space', ['CLEAR_OF_LUMI_AND_CRITICAL_OBJECTS']);
    const initialGaze = observed('gaze', ['VIEWER', 'TEACHING_OBJECT']);
    if (a.grammar === 'ATTENTIVE_WAIT' && initialGaze !== 'VIEWER') add('SOURCE_ACTION_MISMATCH', 'listening requires reviewed initial eye contact');
    const supported = observed('supported_actions');
    if (!Array.isArray(supported) || !supported.includes(a.grammar)) add('SOURCE_ACTION_MISMATCH', 'pose does not demonstrate the required action');
    const cameras = observed('supported_cameras');
    if (!Array.isArray(cameras) || !cameras.includes(d.camera.type)) add('SOURCE_ACTION_MISMATCH', 'camera path not supported by reviewed source');
    if (d.camera.type !== 'STATIC' && (!d.camera.approval_id || !supplied.reviews.some(r => r.id === d.camera.approval_id &&
      r.scope === 'CAMERA_PATH' && r.status === 'APPROVED' && r.sha256 === c.SOURCE_ARTIFACT.sha256 && authenticReview(r, synthetic)))) add('CAMERA_APPROVAL_REQUIRED');
    if (grammar.hand) {
      if (!['character_left_forearm', 'character_right_forearm'].includes(a.body_part)) add('LATERALITY_UNKNOWN');
      else {
        const side = a.body_part.includes('_left_') ? 'left' : 'right';
        const free = observed(`${side}_hand`, ['FREE']);
        if (free !== 'FREE') add('HAND_UNAVAILABLE_OR_UNKNOWN');
        if (wandState === `HELD_${side.toUpperCase()}`) add('HAND_OCCUPANCY_CONFLICT');
        observed('laterality', ['CHARACTER_SIDES_VERIFIED']);
      }
    } else if (a.body_part !== 'gaze') add('BODY_PART_CONTRADICTION');
    if (!LABELS[a.target] || d.focus !== a.target) add('FOCUS_OR_TARGET_UNRESOLVED');
    if (a.grammar === 'PRESENT_FLOWER') {
      if (a.direction !== 'toward_target' || !c.REQUIRED_OBJECTS.some(o => o.id === a.target)) add('MISSING_EDUCATIONAL_OBJECT');
    } else if (a.target !== 'viewer' || a.direction !== 'toward_viewer') add('ACTION_TARGET_CONTRADICTION');
    const inventory = observed('educational_inventory');
    if (stableStringify(inventory) !== stableStringify(c.START_STATE.object_inventory)) add('SOURCE_EDUCATIONAL_OBJECT_MISMATCH', '', 'SOURCE');
    const expectedObjects = policy.educational_objects?.[c.shot_id];
    if (!expectedObjects || stableStringify(c.REQUIRED_OBJECTS.map(o => o.id)) !== stableStringify(expectedObjects) ||
        c.REQUIRED_OBJECTS.some(o => o.count !== 1 || o.color !== ({flower_red:'red',flower_yellow:'yellow',flower_blue:'blue'})[o.id])) add('APPROVED_EDUCATIONAL_INVENTORY_CHANGED');
    const timing = a.timing;
    if (Math.abs(timing.preparation + timing.gesture + timing.settle - c.DURATION) > 1e-9 || timing.response_window > c.DURATION) add('ACTION_TIMING_MISMATCH');
    if (a.grammar === 'ATTENTIVE_WAIT') {
      if (timing.response_window !== 2.5 || d.end !== 'ATTENTIVE_LIVE_HOLD' || !d.secondary_motion.includes('blink') ||
        d.secondary_motion.includes('subtle_wing_response')) add('PEDAGOGICAL_WAIT_CONFLICT');
    } else if (timing.response_window !== 0 || d.end !== 'NATURAL_SETTLE') add('END_STATE_CONTRADICTION');
    if (d.secondary_motion.includes('subtle_wing_response')) observed('wing_motion', ['MINIMAL_REVIEWED']);
    if (d.continuity.screen_direction !== 'PRESERVE') add('SCREEN_DIRECTION_REVIEW_REQUIRED');
    if (d.captions.labels.length) add('CAPTIONS_REQUIRE_EXISTING_EDITORIAL_QA');
    if (c.CHARACTER_STATE.identity_preserved !== true) add('IDENTITY_CHANGE_FORBIDDEN');
  }
  const parameters = { ...policy.controls, duration: c.DURATION, ...(supplied.request_parameters || {}) };
  // Caller may request controls to be checked, but cannot override direction/media via parameters.
  for (const k of ['prompt', 'image_url']) if (Object.hasOwn(supplied.request_parameters || {}, k)) add('PROMPT_OR_MEDIA_OVERRIDE_FORBIDDEN', k, 'POLICY');
  for (const [k, v] of Object.entries({ ...policy.controls, duration: c.DURATION })) if (parameters[k] !== v) add('POLICY_CONFLICT', k, 'POLICY');
  const capErrors = validateCapabilities(parameters, supplied.required_controls, capabilities, policy);
  capErrors.forEach(code => add(code, '', 'CAPABILITY'));
  if (capabilities.synthetic_fixture && !(synthetic && allowSyntheticFixtures)) add('SYNTHETIC_CAPABILITIES_FORBIDDEN', '', 'CAPABILITY');

  const frozenPlan = deepFreeze({ version: DIRECTOR_VERSION, grammar_version: GRAMMAR_VERSION, projection_version: PROJECTION_VERSION,
    episode_id: supplied.episode_id ?? null, shot_id: c.shot_id ?? null, contract: creativeContract(c),
    direction: d, facts: supplied.facts ?? {}, effective_policy: creativePolicy(policy), language: supplied.language ?? null,
    acting_library_version: ACTING_VERSION, topology_lock: TOPOLOGY.version });
  const directionFingerprint = digest(frozenPlan);
  // Persist decision BEFORE projection. Existing identical content is reused, never a job claim.
  const planPath = await persistImmutable(outputDirectory, `${directionFingerprint}.plan.json`, frozenPlan);
  const audit = compilePromptDraft(c, context); // Original ten-block OFFLINE_REVIEW_DRAFT is preserved.
  let projection = null;
  if (!errors.some(e => ['SCHEMA', 'DIRECTION', 'SOURCE', 'POLICY'].includes(e.domain))) projection = projectCinematicPrompt(frozenPlan, supplied.language);
  if (projection && capabilities.prompt_limit) {
    const count = capabilities.prompt_limit.unit === 'utf8_bytes' ? Buffer.byteLength(projection.text) : [...projection.text].length;
    if (count > capabilities.prompt_limit.max) add('PROMPT_LIMIT_EXCEEDED_NO_TRUNCATION', '', 'CAPABILITY');
  }
  const creativeFingerprint = digest({ directionFingerprint, prompt: projection?.text ?? null, parameters,
    endpoint: policy.endpoint, capabilities: { id: capabilities.id, version: capabilities.version, fields: capabilities.fields,
      prompt_limit: capabilities.prompt_limit, media_constraints: capabilities.media_constraints } });
  const changed = previousPacket && previousPacket.creative_fingerprint !== creativeFingerprint;
  if (changed && supplied.revision <= previousPacket.revision) add('CREATIVE_CHANGE_REQUIRES_NEW_REVISION', '', 'APPROVAL');
  const humanApproval = !synthetic && supplied.direction_approval?.fingerprint === creativeFingerprint &&
    validDate(supplied.direction_approval?.at) && !!supplied.direction_approval?.actor;
  const transportBound = transport && transport.artifact_sha256 === c.SOURCE_ARTIFACT?.sha256 &&
    typeof transport.url === 'string' && transport.url.startsWith('https://') &&
    artifacts.some(a => a.sha256 === transport.artifact_sha256) && byteChecks[0]?.hash_status === 'PASS';
  // The preview is deliberately non-executable: never carries a URL, headers, or a sendable payload.
  const preview = { status: 'NOT_SENT', endpoint: policy.endpoint, method: 'POST', payload: null,
    parameters: Object.fromEntries(Object.entries(parameters).filter(([k]) => capabilities.fields?.[k] && !['prompt', 'image_url'].includes(k))),
    prompt: projection?.text ?? null, conditioning_media: c.SOURCE_ARTIFACT ? [{ artifact_id: c.SOURCE_ARTIFACT.artifact_id,
      sha256: c.SOURCE_ARTIFACT.sha256, field: 'image_url', role: 'START_FRAME', bytes_verified: byteChecks[0]?.hash_status === 'PASS',
      transport_bound: Boolean(transportBound), transmitted: false }] : [],
    transport_redacted: true, executable: false, missing: [...(!transportBound ? ['APPROVED_MEDIA_TRANSPORT_NOT_BOUND'] : []), ...capErrors],
    optional_disabled: capabilities.optional_disabled, limitations: capabilities.limitations };
  const gates = {
    SCHEMA_VALID: envelopeValid && validatedV2.pass,
    DIRECTION_COHERENT: !errors.some(e => ['SCHEMA', 'DIRECTION', 'POLICY'].includes(e.domain)),
    SOURCE_EVIDENCE_READY: !errors.some(e => e.domain === 'SOURCE'),
    CAPABILITIES_VERIFIED: !errors.some(e => e.domain === 'CAPABILITY'),
    HUMAN_DIRECTION_APPROVAL: Boolean(humanApproval && !changed),
    BUDGET_AUTHORIZATION: false, EXECUTION_AUTHORIZATION: false,
  };
  const warnings = (supplied.reviews || []).filter(r => r.status === 'APPROVED_WITH_WARNING').map(r => ({ ...r,
    acceptance: authenticReview(r, synthetic) && (r.kind === 'HUMAN' || (synthetic && r.kind === 'SYNTHETIC_FIXTURE')) && r.warnings.every(w => w.sha256 === r.sha256 && w.scope === r.scope) ? 'EXACT_REVIEW_SCOPE_ONLY' : 'METADATA_INCOMPLETE_REVIEW_REQUIRED' }));
  const packet = {
    version: DIRECTOR_VERSION, status: errors.length ? 'REVIEW_DRAFT_WITH_BLOCKERS' : 'OFFLINE_REVIEWABLE_NOT_AUTHORIZED',
    revision: supplied.revision ?? null, synthetic_fixture: synthetic, episode_id: supplied.episode_id ?? null, shot_id: c.shot_id ?? null,
    resumen_es: { que_veremos: projection ? projectCinematicPrompt(frozenPlan, 'es').text : 'Dirección incompleta: revisar hechos y bloqueos antes de formular un prompt vinculado a la fuente.',
      aprendizaje: d.educational_goal ?? null, por_que: d.reason_es ?? null },
    DIRECTOR_PLAN: frozenPlan, start_end_comparison: { start: c.START_STATE ?? null, end: c.END_STATE ?? null },
    V3_AUDIT: redact(audit), PROVIDER_PROMPT: projection, PROVIDER_REQUEST_PREVIEW: preview,
    references: { qa_only: refs, conditioning: preview.conditioning_media, pending: byteChecks.filter(x => x.hash_status !== 'PASS') },
    evidence: { byte_checks: byteChecks, reviews: supplied.reviews ?? [], schema_does_not_certify_pixels: true },
    gates, blockers: errors, warnings, topology, requirements: ['Human approval of exact creative fingerprint', 'Canonical budget preflight and future execution authorization', ...preview.missing],
    direction_fingerprint: directionFingerprint, creative_fingerprint: creativeFingerprint,
    prompt_sha256: projection ? sha256(projection.text) : null,
    change_review: { previous: previousPacket?.creative_fingerprint ?? null, creative_changed: Boolean(changed),
      approvals_invalidated: changed ? ['DIRECTION', 'BUDGET', 'EXECUTION'] : [],
      changed_sections: previousPacket ? ['direction', 'contract', 'effective_policy', 'facts'].filter(k => digest(previousPacket.DIRECTOR_PLAN?.[k]) !== digest(frozenPlan[k])) : ['INITIAL_REVIEW'] },
    qa_plan: buildQaPlan(c, d),
    cost: { incurred: 'USE_EXISTING_LEDGER', estimated: 'NO_FRESH_QUOTE', pending: 'USE_EXISTING_RECONCILIATION', future_authorized: false, incremental_generation_budget: 0 },
    recovery: { authority: 'LumiRecoveryIncidentManager + existing provider emission journal', reopening_creates_intent: false, new_hash_authorizes_job: false, ambiguous_emission: 'INSPECT_FIRST', remote_exactly_once_guaranteed: false },
    provider_calls: 0, production_activated: false, new_generation_cost: 0, new_media: 0, tts: 0, master: 'NOT_CREATED', episode_resumed: false,
  };
  const safePacket = redact(packet);
  const packetPath = await persistImmutable(outputDirectory, `${digest(safePacket)}.packet.json`, safePacket);
  return { ...safePacket, local_files: { plan: planPath, packet: packetPath } };
}

export function buildQaPlan(contract, direction) {
  return { integration: 'sourceGate / previousVideoGate / bodyAnatomyGate; recordShotPackTemporalQa remains approval writer',
    topology_lock: TOPOLOGY, topology_stages: TOPOLOGY.stages,
    acting_preset: ACTING_PRESETS[GRAMMAR_PRESET[direction.principal_actions?.[0]?.grammar]] ?? null,
    domains: ['technical', 'identity', 'anatomy', 'performance', 'educational_content', 'continuity', 'human_review'],
    checks: ['full_native_speed_playback', 'maximum_risk_moments', 'requested_gesture', 'torso_orientation', 'posterior_silhouette', 'wings', 'hands', 'wand',
      'object_count_color_shape_visibility', 'camera', 'natural_rhythm', 'final_settle', 'text_character_overlap_0', 'critical_object_overlap_0', 'no_pause_label'],
    source_and_final_inventory: { initial: contract.START_STATE?.object_inventory ?? null, final: contract.END_STATE?.object_inventory ?? null },
    action_timing_for_review: direction.principal_actions?.[0]?.timing ?? null,
    classification: ['SOURCE', 'TEMPORAL', 'POSSIBLE_OCCLUSION', 'INCOMPATIBLE_DIRECTION', 'INSUFFICIENT_EVIDENCE'],
    confirmed_causes: [], hypotheses: [], assessment: 'NOT_PERFORMED',
    limits: ['Decode PASS is not visual PASS.', 'Partial sampling cannot certify all frames.', 'Occlusion is not automatically anatomical disappearance.',
      'No automatic aesthetic score, repair, retry, variant, resubmit or production prompt learning.'] };
}

export function evaluateSequence(packets, pack) {
  const errors = [], warnings = [];
  if (pack?.shots?.length !== 6 || pack?.beats?.length !== 9 || stableStringify(pack.shots.map(s => s.duration_seconds)) !== '[4,4,4,4,5,5]') errors.push('APPROVED_SEQUENCE_CHANGED');
  const ids = new Set(packets.map(p => p.shot_id));
  if (pack?.shots?.some(s => !ids.has(({ q37: 'q35', q39: 'q36' })[s.id] || s.id))) warnings.push('SEQUENCE_DIRECTION_REVIEW_INCOMPLETE');
  for (let i = 1; i < packets.length; i++) {
    const prev = packets[i - 1].DIRECTOR_PLAN.direction?.continuity, next = packets[i].DIRECTOR_PLAN.direction?.continuity;
    if (!prev || !next || prev.next_shot !== packets[i].shot_id || next.previous_shot !== packets[i - 1].shot_id || prev.exit_gaze !== next.entry_gaze) warnings.push('NEIGHBOR_CONTINUITY_REVIEW_REQUIRED');
  }
  const functions = packets.map(p => p.DIRECTOR_PLAN.direction?.continuity?.function);
  if (!functions.includes('question') || functions.at(-1) !== 'closing') warnings.push('FUNCTIONAL_DIVERSITY_AND_CLOSURE_REVIEW_REQUIRED');
  return { status: errors.length ? 'BLOCKED' : warnings.length ? 'REVIEW_REQUIRED' : 'STRUCTURALLY_COHERENT_REQUIRES_VISUAL_REVIEW', errors, warnings,
    sequence_pixels_reviewed: false, approved_timing_unchanged: errors.length === 0 };
}
