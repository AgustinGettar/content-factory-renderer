import {sha256, stableStringify} from './PROMPT_COMPILER_V3.mjs';

// Exact-artifact assembly authority is separate from automated anatomy and source QA.
export function applyEpisodeAssemblyApproval(replay, binding, approval) {
  const expected = binding.shot === 'q31' ? 'HUMAN_APPROVED' : 'HUMAN_APPROVED_FOR_ASSEMBLY';
  if (approval?.episode_id !== binding.episode || approval.shot !== binding.shot ||
      approval.artifact_id !== binding.video.artifact_id || approval.sha256 !== binding.video.sha256 ||
      approval.kind !== 'HUMAN' || approval.actor !== 'USER' || !Number.isFinite(Date.parse(approval.at)) ||
      approval.status !== expected || approval.scope !== 'CURRENT_EPISODE_ASSEMBLY' ||
      approval.full_playback_1x !== true || approval.assembly_eligible !== true ||
      approval.golden_reference !== (binding.shot === 'q31') ||
      approval.golden_scope !== (binding.shot === 'q31' ? 'GREETING' : null))
    throw new Error('EXACT_EPISODE_HUMAN_ASSEMBLY_PROVENANCE_REQUIRED');
  return {...replay, automated_evaluation_preserved: structuredClone(replay),
    human_review_layer: {...approval, record_sha256: sha256(stableStringify(approval))},
    repair_outcome: binding.shot === 'q31' ? 'HUMAN_APPROVED_GOLDEN_GREETING' : expected,
    evaluation: expected, assembly_eligible: true,
    golden_reference: approval.golden_reference, golden_scope: approval.golden_scope,
    golden_anatomy_reference: false, repair_execution_forbidden: true,
    minimum_future_repair: null, readiness_for_repair: false,
    automated_warning_preserved: true, full_native_speed_review_this_run: false,
    full_native_speed_review_by_user: true, execution_authorization: false, provider_calls: 0};
}
