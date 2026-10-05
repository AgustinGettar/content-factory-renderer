import { readFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { sha256, stableStringify } from './PROMPT_COMPILER_V3.mjs';
import { evaluateTopology, TOPOLOGY } from './topology.js';
import { assessActing } from './acting-presets.js';

// Read-only replay consumes existing QA annotations bound to original bytes.
// It is neither a vision model nor a new approval, claim, or provider request.
export async function evaluateHistoricalReplay({binding,observations,mediaRoot},input){
  if(binding?.version!=='ORIGINAL_MEDIA_BINDING_V1'||binding.episode!==input.episode_id||binding.shot!==input.contract.shot_id)
    throw new Error('HISTORICAL_BINDING_SCOPE_MISMATCH');
  if(binding.source.sha256!==input.contract.SOURCE_ARTIFACT.sha256)throw new Error('HISTORICAL_SOURCE_MISMATCH');
  const {fingerprint,...body}=binding;
  if(sha256(stableStringify(body))!==fingerprint)throw new Error('BINDING_FINGERPRINT_MISMATCH');
  if(observations?.binding_fingerprint!==fingerprint)throw new Error('OBSERVATION_BINDING_MISMATCH');
  for(const artifact of [binding.source,binding.video]){
    const path=resolve(mediaRoot,artifact.local_filename);
    if(relative(resolve(mediaRoot),path).startsWith('..'))throw new Error('ORIGINAL_MEDIA_PATH_ESCAPE');
    if(sha256(await readFile(path))!==artifact.sha256)throw new Error('ORIGINAL_MEDIA_SHA_MISMATCH');
    if(artifact.verification?.sha!=='PASS'||artifact.verification?.decode!=='PASS')throw new Error('ORIGINAL_MEDIA_VERIFICATION_REQUIRED');
  }
  const stages=Object.fromEntries(TOPOLOGY.stages.map(stage=>[stage,evaluateTopology({stage,
    sha256:stage==='SOURCE_PREFLIGHT'||stage==='VIDEO_REQUEST_PACKAGE'?binding.source.sha256:binding.video.sha256,
    review:stage==='SOURCE_PREFLIGHT'||stage==='VIDEO_REQUEST_PACKAGE'?observations.source:observations.video})]));
  const sourceBlocked=stages.SOURCE_PREFLIGHT.status==='BLOCKED', videoBlocked=stages.SAMPLED_FRAME_TEMPORAL_QA.status==='BLOCKED';
  const approved=binding.human_review.state==='HUMAN_APPROVED';
  const acting=assessActing(observations.intended_preset,observations.observed_motion);
  const sourceDecision=sourceBlocked?'SOURCE_REGEN_REQUIRED':binding.qa.forensics?.SOURCE_ANATOMY==='PASS'?'SOURCE_REUSE':'REVIEW_REQUIRED';
  const repair=!approved?{
    source:sourceDecision,
    video:sourceBlocked||videoBlocked?'VIDEO_REPAIR_REQUIRED':'REVIEW_REQUIRED',
    source_reuse_condition:sourceBlocked?null:'Current source action/topology review must pass before future emission; existing bytes retained.',
    acting_preset:observations.intended_preset,
    estimated_provider_calls:sourceBlocked?{image:1,video:1,tts:0}:videoBlocked&&sourceDecision==='SOURCE_REUSE'?{image:0,video:1,tts:0}:null,
    estimated_cost_usd:null,cost_status:'FRESH_QUOTE_REQUIRED_NOT_AUTHORIZED',
    historical_cost_reference_usd:binding.qa.forensics?.expected_total_cost_usd_reference??binding.qa.forensics?.expected_cost_usd_reference??null,
    retries:0,variants:0,resubmits:0,execute:false,
  }:null;
  return {version:'LUMI_AUTHENTIC_HISTORICAL_REPLAY_V1',binding_fingerprint:fingerprint,authentic_bytes:'PASS',
    repair_outcome:approved?'ACCEPT_COMPATIBLE_WITH_HUMAN_GOLDEN':sourceBlocked?'SOURCE_REGEN_AND_VIDEO_REPAIR_REQUIRED':videoBlocked?'CONTROLLED_REPAIR_REQUIRED':'REVIEW_REQUIRED',
    readiness_for_repair:false,
    evaluation:approved?'COMPATIBLE_WITH_EXISTING_HUMAN_APPROVAL':videoBlocked?'BLOCKED':'REVIEW_REQUIRED',
    human_approval_preserved:approved,approval_scope:'Existing video only; never a new source, hard-topology waiver, or generation permission.',
    source_gate:stages.SOURCE_PREFLIGHT,topology_stages:stages,acting,
    questions:{
      would_source_gate_block:sourceBlocked?'YES':stages.SOURCE_PREFLIGHT.status==='REVIEW_REQUIRED'?'REVIEW_REQUIRED_UNDER_V2':'NO_OBSERVED_SOURCE_BLOCKER',
      would_direction_reduce_risk:'LIKELY: preserve torso and restrict gesture; no causal guarantee or word-level diagnosis.',
      would_endpoint_gate_change_request:'BLOCK_PENDING_EXACT_ENDPOINT_LIMITS_AND_PERSISTED_ENVELOPE; never silently rewrite fields or change model.',
      would_temporal_qa_detect:videoBlocked?'YES_WITH_BOUND_DEFECT_OBSERVATIONS':'EXISTING_APPROVAL_PRESERVED_WITH_SCOPED_WARNING',
      repair_class:repair?.source==='SOURCE_REGEN_REQUIRED'?'SOURCE_THEN_VIDEO':repair?.source==='SOURCE_REUSE'?'VIDEO_ONLY_CONDITIONAL_SOURCE_REUSE':repair?'REVIEW_REQUIRED':'NONE_FOR_APPROVED_HISTORICAL_CLIP'},
    minimum_future_repair:repair,qa_integration:'Consumes existing ledger QA; no QA/approval database write; master stage is a checklist evaluation, no master created.',
    visual_recertification:false,full_native_speed_review_this_run:false,provider_calls:0,execution_authorization:false};
}
