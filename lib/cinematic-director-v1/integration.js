import { readFile } from 'node:fs/promises';
import { compileDirectorPacket, evaluateSequence } from './director.js';
import { pipelineVersion } from '../lumi-recovery-incident-manager-v1.js';
import { validateThirdShotPack } from '../lumi-third-shot-pack-v1.js';
import { stableStringify, sha256 } from './PROMPT_COMPILER_V3.mjs';

// Called only by the opt-in branch of runLumiV2Step, before clients, remote preflight or claims.
export async function reviewAtCanonicalBoundary({ env, directorReview }) {
  if (env.LUMI_RUNTIME_ENV !== 'local_offline' || pipelineVersion(env) !== 'v1_1_2') throw new Error('director_local_offline_episode_selection_required');
  if (!directorReview?.input || !directorReview.outputDirectory) throw new Error('director_local_input_required');
  const [planBytes, packBytes] = await Promise.all([
    readFile(new URL('../../episodes/ep_lumi_flores_003/EPISODE_PLAN_V2.json', import.meta.url)),
    readFile(new URL('../../episodes/ep_lumi_flores_003/SHOT_PACK_V1.json', import.meta.url)),
  ]);
  const plan = JSON.parse(planBytes), pack = JSON.parse(packBytes);
  if (directorReview.input.episode_id !== plan.episode.id) throw new Error('director_existing_episode_required');
  const validation = validateThirdShotPack(pack, plan);
  if (validation.status !== 'PASS') throw new Error('director_persisted_pack_invalid:' + validation.errors.join(','));
  const aliases = { q35: 'q37', q36: 'q39' }, input = directorReview.input;
  const shot = pack.shots.find(s => s.id === (aliases[input.contract?.shot_id] || input.contract?.shot_id));
  if (!shot || shot.duration_seconds !== input.contract.DURATION) throw new Error('director_approved_shot_duration_required');
  // A source scene is not necessarily the educational beat: q35/q37 uses s35 pixels
  // but serves the s37 child-response beat; q36/q39 closes s39 with s36 pixels.
  const primaryBeat = shot.performance === 'question'
    ? pack.beats.find(b => b.pause_seconds === 2.5 && b.segments.some(s => s.shot_id === shot.id))
    : shot.performance === 'closing' ? pack.beats.at(-1) : pack.beats.find(b => b.id === shot.source_scene);
  const scene = plan.scenes.find(s => s.id === primaryBeat?.id);
  if (input.direction?.educational_goal !== scene?.educational_goal) throw new Error('director_persisted_educational_goal_required');
  const replay = directorReview.historicalReplay
    ? await (await import('./historical-replay.js')).evaluateHistoricalReplay(directorReview.historicalReplay, input) : null;
  const packet = await compileDirectorPacket(input, { ...directorReview,
    topologyReview: directorReview.historicalReplay?.observations?.source,
    allowSyntheticFixtures: env.LUMI_DIRECTOR_FIXTURES === 'true' });
  const sequence = evaluateSequence([packet], pack);
  return { ...packet, ...(replay ? { historical_replay: replay } : {}), integration: {
    entrypoint: 'lib/lumi-series-v2-execution.js:runLumiV2Step',
    branch: 'LUMI_CINEMATIC_DIRECTOR_V1=true; local_offline; pipeline v1_1_2',
    episode_plan_sha256: sha256(planBytes), shot_pack_sha256: sha256(packBytes),
    canonical_shot_id: shot.id, educational_beat_id: scene.id, source_scene_id: shot.source_scene, pedagogical_beats: pack.beats.length, visual_shots: pack.shots.length,
    duration_vector: pack.shots.map(s => s.duration_seconds),
    historical_pack_validation: validation, historical_budget_is_not_authorization: true,
    sequence, provider_boundary_reached: false, recovery_state_mutated: false,
    original_structure_digest: sha256(stableStringify({ plan, pack })),
  } };
}
