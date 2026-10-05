// SYNTHETIC UNIT FIXTURES. Text bytes are not images. Reviews/capabilities are mocks,
// never evidence of a real human approval or valid provider media.
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { sha256, NEGATIVE_STYLES, READINESS_CHECKS, REFERENCE_QA_CHECKS } from '../../lib/cinematic-director-v1/PROMPT_COMPILER_V3.mjs';
import { BODY_QA_FIELDS } from '../../lib/lumi-series-v2-gates.js';
import { POLICY, CAPABILITIES } from '../../lib/cinematic-director-v1/profiles.js';

export const syntheticCapabilities = () => ({ ...structuredClone(CAPABILITIES), id: 'SYNTHETIC_TEST_CAPABILITIES', synthetic_fixture: true,
  provenance: 'SYNTHETIC_FIXTURE_NOT_OFFICIAL', prompt_limit: { max: 10000, unit: 'unicode_codepoints' },
  media_constraints: { verified: true, scope: 'SYNTHETIC_TEXT_BYTES_NOT_MEDIA' }, pending: [] });

export async function makeFixture({ grammar = 'PRESENT_FLOWER', directory } = {}) {
  const dir = directory || await mkdtemp(join(tmpdir(), 'lumi-director-test-'));
  await mkdir(dir, { recursive: true });
  const wait = grammar === 'ATTENTIVE_WAIT', shot = wait ? 'q35' : grammar === 'GAZE_VIEWER' ? 'q31' : grammar === 'FAREWELL' ? 'q36' : 'q32';
  const duration = POLICY.durations[shot];
  const required = (wait || grammar === 'FAREWELL' ? ['red','yellow','blue'] : grammar === 'GAZE_VIEWER' ? [] : ['red']).map(color => ({ id: `flower_${color}`, count: 1, color, shape: 'flower', placement: 'reviewed source position' }));
  const inventory = required.map(o => ({ ...o, visibility: 'FULLY_VISIBLE' }));
  const source = { artifact_id: 'SYNTHETIC_SOURCE', path: join(dir, 'SYNTHETIC_SOURCE.txt'), sha256: sha256('SYNTHETIC SOURCE BYTES NOT AN IMAGE') };
  const refs = ['character','world','lighting','motion'].map(role => ({ artifact_id: `SYNTHETIC_${role}`, role, sha256: sha256(`SYNTHETIC ${role} BYTES NOT MEDIA`) }));
  await writeFile(source.path, 'SYNTHETIC SOURCE BYTES NOT AN IMAGE');
  const media = [{ ...source, role: 'source' }];
  for (const r of refs) { const path = join(dir, `${r.artifact_id}.txt`); await writeFile(path, `SYNTHETIC ${r.role} BYTES NOT MEDIA`); media.push({ artifact_id: r.artifact_id, sha256: r.sha256, path, role: 'qa' }); }
  const state = { description: 'SYNTHETIC reviewed inventory.', object_inventory: inventory };
  const contract = {
    shot_id: shot, shot_type: wait ? 'QUESTION_TO_VIEWER' : 'MEDIUM_TEACHING', START_STATE: structuredClone(state), END_STATE: structuredClone(state),
    CHARACTER_STATE: { description: 'SYNTHETIC canonical identity.', character_lock_id: 'SYNTHETIC_CHARACTER_LOCK', character_lock_sha256: sha256('character lock'),
      world_lock_id: 'SYNTHETIC_WORLD_LOCK', world_lock_sha256: sha256('world lock'), identity_preserved: true, canonical_wings: 2 },
    REQUIRED_OBJECTS: required, EDUCATIONAL_INVARIANTS: required.flatMap(o => ['count','color','shape'].map(property => ({ object_id: o.id, property, value: o[property] }))),
    PRIMARY_ACTION: { action: grammar === 'PRESENT_FLOWER' ? 'small_pointing_gesture' : grammar === 'FAREWELL' ? 'small_wave' : 'look_at_viewer', description: 'SYNTHETIC one performance.' },
    ALLOWED_SECONDARY_MOTION: ['blink'], FORBIDDEN_ACTIONS: ['Identity change'], CAMERA: { type: 'STATIC', description: 'Reviewed static camera.', necessary: false },
    DURATION: duration, SOURCE_ARTIFACT: source, GOLDEN_REFERENCES: refs, NEGATIVE_STYLE_CONTRACT: [...NEGATIVE_STYLES],
  };
  const observations = { body_orientation: 'THREE_QUARTER', framing: 'SOURCE_SUPPORTS_SHOT', caption_space: 'CLEAR_OF_LUMI_AND_CRITICAL_OBJECTS',
    gaze: 'VIEWER', supported_actions: [grammar], supported_cameras: ['STATIC'], wand_state: 'ABSENT', left_hand: 'FREE', right_hand: 'FREE',
    laterality: 'CHARACTER_SIDES_VERIFIED', educational_inventory: inventory };
  const reviews = [source, ...refs].map(a => ({ id: `review_${a.artifact_id}`, artifact_id: a.artifact_id, sha256: a.sha256,
    actor: 'SYNTHETIC_REVIEWER_NOT_A_PERSON', at: '2000-01-01T00:00:00Z', scope: 'SOURCE_FOR_VIDEO', kind: 'SYNTHETIC_FIXTURE', status: 'APPROVED',
    observations: a === source ? observations : {}, warnings: [] }));
  const facts = Object.fromEntries(Object.entries(observations).map(([key, value]) => [key, { value, status: 'OBSERVED', evidence_ids: [reviews[0].id] }]));
  const context = {
    style_authority: { id: 'LUMI_SERIES_STYLE_V2', status: 'FROZEN' },
    locks: Object.fromEntries(['character','world'].map(kind => [kind, { id: contract.CHARACTER_STATE[`${kind}_lock_id`], sha256: contract.CHARACTER_STATE[`${kind}_lock_sha256`], status: 'FROZEN', description: 'SYNTHETIC lock' }])),
    artifact_evidence: Object.fromEntries([source,...refs].map(a => [a.artifact_id, { path: media.find(m => m.artifact_id === a.artifact_id).path,
      expected_sha256: a.sha256, actual_sha256: a.sha256, hash_status: 'PASS', human_approved: true, qa_status: 'PASS',
      qa_checks: Object.fromEntries(REFERENCE_QA_CHECKS.map(k => [k,'PASS'])) }])),
    source_readiness: { [source.artifact_id]: Object.fromEntries(READINESS_CHECKS.map(k => [k,'PASS'])) },
    provider_policy: { model: 'Kling 3.0 Standard', audio: false, multi_shots: false, playback_rate: 1, automatic_retries: 0, automatic_variants: 0, automatic_resubmits: 0, provider_repair_budget: 0 },
    economic: { quote_verified: true, currency: 'USD', episode_projected_usd: 3.5 },
    postproduction: { deterministic_educational_graphics: true, text_character_overlap: 0, visible_pause_label: false, playback_rate: 1, master_width: 1080, master_height: 1920, planned_captions: [] },
  };
  const plan = JSON.parse(await readFile(new URL('../../episodes/ep_lumi_flores_003/EPISODE_PLAN_V2.json', import.meta.url)));
  const sceneId = ({q31:'s31',q32:'s32',q35:'s37',q36:'s39'})[shot];
  const input = { version: 'LUMI_CINEMATIC_DIRECTION_V1', episode_id: POLICY.episode_id, revision: 1, contract,
    direction: { educational_goal: plan.scenes.find(s => s.id === sceneId).educational_goal,
      reason_es: wait ? 'La espera conserva contacto visual y no revela la respuesta.' : 'Un único gesto dirige la atención sin girar el torso ni tapar los pétalos.',
      emotion: wait ? 'attentive' : 'warm', focus: grammar === 'PRESENT_FLOWER' ? 'flower_red' : 'viewer', framing: 'FROM_APPROVED_SOURCE',
      principal_actions: [{ grammar, actor: 'lumi', body_part: grammar === 'PRESENT_FLOWER' || grammar === 'FAREWELL' ? 'character_left_forearm' : 'gaze',
        target: grammar === 'PRESENT_FLOWER' ? 'flower_red' : 'viewer', direction: grammar === 'PRESENT_FLOWER' ? 'toward_target' : 'toward_viewer', amplitude: 'small', pace: 'natural_1x', body_motion: 'PRESERVE_INITIAL',
        timing: { preparation: 0.5, gesture: duration - 1.5, settle: 1, response_window: wait ? 2.5 : 0 } }],
      secondary_motion: ['blink'], stable_parts: ['torso','feet','posterior_silhouette','educational_objects'],
      camera: { type: 'STATIC', reason_es: 'El gesto concentra la atención; la cámara no necesita desplazarse.', approval_id: null },
      end: wait ? 'ATTENTIVE_LIVE_HOLD' : 'NATURAL_SETTLE',
      continuity: { previous_shot: wait ? 'q34' : 'q31', next_shot: wait ? 'q36' : 'q33', entry_gaze: 'viewer', exit_gaze: 'viewer', screen_direction: 'PRESERVE', function: wait ? 'question' : 'teaching' },
      captions: { generated_text: false, labels: [], text_character_overlap: 0, critical_object_overlap: 0, safe_region_fact: 'caption_space' } },
    policy_id: POLICY.id, language: 'en', facts, reviews, context, media,
    source_qa: { sha256: source.sha256, BODY_LOCK_VERSION: 'LUMI_BODY_ANATOMY_LOCK_V1', ANATOMY: 'PASS', ...Object.fromEntries(BODY_QA_FIELDS.map(k => [k,'PASS'])) },
    request_parameters: {}, required_controls: ['sound','duration','multi_shots','image_url','prompt'],
    direction_approval: null, execution_authorization: false, synthetic_fixture: true };
  return { input, directory: dir, options: { outputDirectory: join(dir,'packets'), capabilities: syntheticCapabilities(), allowSyntheticFixtures: true } };
}

export function setReviewedFact(input, key, value) {
  input.facts[key].value = value;
  input.reviews[0].observations[key] = value;
}
