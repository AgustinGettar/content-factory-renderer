// Typed evidence policy, NOT a visual detector or independent approval system.
// Legacy bodyAnatomyGate remains authoritative for its existing consumers.
import { bodyAnatomyGate } from '../lumi-series-v2-gates.js';
export const TOPOLOGY_VERSION='LUMI_CHARACTER_TOPOLOGY_LOCK_V2';
export const TOPOLOGY=Object.freeze({
  version:TOPOLOGY_VERSION,
  canonical:{head:1,rounded_torso:1,arms:2,legs:2,antennae:2,wings:2,
    wing_attachment:'UPPER_BACK_ONLY',lower_torso_silhouette:'DEFINED_BY_OVERALLS'},
  hard:Object.freeze(['NO_BEE_ABDOMEN','NO_STRIPED_POSTERIOR_BODY','NO_STINGER','NO_REAR_BULB',
    'NO_SECOND_TORSO','NO_EXTRA_APPENDAGE','NO_INDEPENDENT_EXTRA_WING','NO_BODY_MASS_BEHIND_OVERALLS']),
  wing_semantics:Object.freeze({WING_ASSEMBLY_COUNT:2,
    attachment_roots:['LEFT_UPPER_BACK','RIGHT_UPPER_BACK'],
    VISIBLE_CONTOUR_LOBE_COUNT:'SEPARATE_OBSERVATION_NOT_AN_ASSEMBLY_COUNT',
    allowed:['PERSPECTIVE_OVERLAP','INTERNAL_CONTOUR','FOLDED_EDGE','FOREGROUND_BACKGROUND_OVERLAP'],
    invalid:['INDEPENDENT_EXTRA_ROOT','DETACHED_APPENDAGE','SEPARATELY_ARTICULATED_STRUCTURE','NON_CANONICAL_APPENDAGE'],
    positive_precedent:'q31-PRO2 human-approved lower contour; no waiver for independent extra wings'}),
  stages:Object.freeze(['SOURCE_PREFLIGHT','VIDEO_REQUEST_PACKAGE','SAMPLED_FRAME_TEMPORAL_QA','MASTER_QA']),
  detection_contract:Object.freeze({version:'TOPOLOGY_FRAME_COVERAGE_V1',
    source:['source_frame'],video:['first_frame','sampled_temporal_frames','worst_silhouette_frames','end_frame'],
    playback:'FULL_NATIVE_SPEED_REVIEW_REQUIRED; all-frame decoding or contact sheets are not playback',
    measurements:'Frame timestamps may be measured; hidden geometry and 3D angles must not be inferred as exact.'}),
});
const defects={POSTERIOR_BODY_MUTATION:'NO_BODY_MASS_BEHIND_OVERALLS',STRIPED_ABDOMEN:'NO_STRIPED_POSTERIOR_BODY',
  EXTRA_BODY_SEGMENT:'NO_SECOND_TORSO',EXTRA_WING_LOBE:'NO_INDEPENDENT_EXTRA_WING',
  INDEPENDENT_EXTRA_WING_ROOT:'NO_INDEPENDENT_EXTRA_WING',DETACHED_EXTRA_WING:'NO_INDEPENDENT_EXTRA_WING',
  SEPARATELY_ARTICULATED_EXTRA_WING:'NO_INDEPENDENT_EXTRA_WING',SILHOUETTE_DRIFT:'NO_BODY_MASS_BEHIND_OVERALLS',
  REAR_BULB:'NO_REAR_BULB',STINGER:'NO_STINGER',EXTRA_APPENDAGE:'NO_EXTRA_APPENDAGE'};
export function evaluateTopology({stage,sha256,review,legacyQa=null}){
  if(!TOPOLOGY.stages.includes(stage))throw new Error('UNKNOWN_TOPOLOGY_QA_STAGE');
  const blockers=[],pending=[],confirmed=[],hypotheses=[];
  if(!review||review.version!==TOPOLOGY_VERSION||review.sha256!==sha256||!review.evidence_ids?.length)
    return {version:TOPOLOGY_VERSION,stage,status:'REVIEW_REQUIRED',blockers:[],pending:['EXACT_BYTES_TOPOLOGY_REVIEW_REQUIRED'],confirmed,hypotheses,visual_certification:false};
  for(const f of review.findings||[]){
    if(f.category==='CANONICAL_WING_CONTOUR'&&f.certainty==='CONFIRMED'&&f.evidence_ids?.length&&
      TOPOLOGY.wing_semantics.allowed.includes(f.structure)){continue;}
    if(!defects[f.category]||!['CONFIRMED','POSSIBLE_OCCLUSION','UNKNOWN'].includes(f.certainty)||!f.evidence_ids?.length){pending.push('FINDING_EVIDENCE_REQUIRED');continue;}
    // A contour label alone cannot establish an additional attachment/appendage.
    if(f.category==='EXTRA_WING_LOBE'&&!TOPOLOGY.wing_semantics.invalid.includes(f.structure)){
      hypotheses.push(f);pending.push('INDEPENDENT_WING_STRUCTURE_REVIEW_REQUIRED');continue;
    }
    if(f.certainty==='CONFIRMED'){confirmed.push(f);blockers.push(defects[f.category]);}
    else{hypotheses.push(f);pending.push(f.category+':'+f.certainty);}
  }
  for(const rule of TOPOLOGY.hard){
    const value=review.checks?.[rule];
    if(value==='FAIL')blockers.push(rule);
    else if(value!=='PASS')pending.push(rule+':REVIEW_REQUIRED');
  }
  for(const [part,count] of Object.entries(TOPOLOGY.canonical).filter(([,v])=>typeof v==='number')){
    const observed=part==='wings'?(review.WING_ASSEMBLY_COUNT??review.counts?.wings):review.counts?.[part];
    if(observed===undefined)pending.push(part+':COUNT_REVIEW_REQUIRED');
    else if(observed!==count)blockers.push(part+':CANONICAL_COUNT_MISMATCH');
  }
  if(review.wing_attachment!=='UPPER_BACK_ONLY')pending.push('WING_ATTACHMENT_REVIEW_REQUIRED');
  if(review.lower_torso_silhouette!=='DEFINED_BY_OVERALLS')pending.push('LOWER_TORSO_REVIEW_REQUIRED');
  if(legacyQa){try{bodyAnatomyGate(legacyQa);}catch(e){pending.push(e.message);}}
  const coverage=review.coverage;
  const sourceStage=stage==='SOURCE_PREFLIGHT'||stage==='VIDEO_REQUEST_PACKAGE';
  for(const key of sourceStage?TOPOLOGY.detection_contract.source:TOPOLOGY.detection_contract.video)
    if(coverage?.[key]!==true)pending.push('COVERAGE_REQUIRED:'+key);
  if(!sourceStage&&coverage?.full_native_speed_playback!==true)pending.push('FULL_NATIVE_SPEED_REVIEW_REQUIRED');
  return {version:TOPOLOGY_VERSION,stage,status:blockers.length?'BLOCKED':pending.length?'REVIEW_REQUIRED':'PASS',
    blockers:[...new Set(blockers)],pending:[...new Set(pending)],confirmed,hypotheses,visual_certification:false,
    WING_ASSEMBLY_COUNT:review.WING_ASSEMBLY_COUNT??review.counts?.wings??null,
    VISIBLE_CONTOUR_LOBE_COUNT:review.VISIBLE_CONTOUR_LOBE_COUNT??null,
    warnings:review.warnings||[],
    limitation:'Consumes scoped QA observations; does not inspect pixels, certify all frames, or waive hard rules.'};
}
