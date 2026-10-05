/** Deterministic evidence classifier. Consumes pixel-grounded observations; does not infer hidden anatomy. */
export const TEMPORAL_TOPOLOGY_VERSION = 'TEMPORAL_TOPOLOGY_QA_V2';
export const CONFIDENCE_CALIBRATION_VERSION = 'TOPOLOGY_QA_CONFIDENCE_CALIBRATION_V1';
export const SEVERITY = Object.freeze({HIGH_CONFIDENCE_MUTATION:'BLOCKER',AMBIGUOUS_CONTOUR:'REVIEW_REQUIRED',LIKELY_PERSPECTIVE_OR_OVERLAP:'PASS_WITH_WARNING',NO_DEFECT:'PASS'});
export const SIGNALS = Object.freeze(['NEW_MASS','INDEPENDENT_ANATOMICAL_CONNECTION','MOTION_COHERENCE','CANONICAL_SILHOUETTE_CHANGE']);
export const DEFECTS = Object.freeze(['POSTERIOR_BODY_MUTATION','INDEPENDENT_EXTRA_WING_ROOT','DETACHED_EXTRA_WING','SEPARATELY_ARTICULATED_EXTRA_WING','STINGER','EXTRA_ARM','EXTRA_LEG','EXTRA_LIMB','SECOND_TORSO','REAR_BULB','PERSISTENT_SEGMENTED_ABDOMEN']);
export const CONFOUNDS = Object.freeze(['DARK_REGION','DARK_BANDS','LOWER_CONTOUR','LIGHTING_GRADIENT','SHADOW','TRANSLUCENT_WING_OVERLAP','WING_EDGE','OVERALLS_EDGE','BACKGROUND_ALIGNMENT','PERSPECTIVE_COMPRESSION','MOTION_BLUR','TEMPORARY_SILHOUETTE_AMBIGUITY']);
const hash = x => typeof x==='string' && /^[a-f0-9]{64}$/.test(x);
const evidence = x => Array.isArray(x) && x.length>0 && x.every(v=>typeof v==='string'&&v.length>0);
const finite = x => Number.isFinite(x) && x>=0;
function comparisonReady(r) {
 return ['canonical_source','video_source','first_frame','preceding_clean_frames','following_frames'].every(k=> {
  const c=r.comparisons?.[k];
  return c?.reviewed===true && evidence(c.evidence_ids) && (k.endsWith('source')?hash(c.sha256):hash(c.video_sha256)&&c.video_sha256===r.sha256);
 });
}
function consecutiveRun(indices) {
 let max=0,run=0,previous=-2;
 for(const index of indices||[]) {if(!Number.isInteger(index)||index<0)return 0;run=index===previous+1?run+1:1;max=Math.max(max,run);previous=index;}
 return max;
}
export function evaluateTemporalTopology({sha256,review}) {
 const missing=[];
 if(!hash(sha256)||review?.version!==TEMPORAL_TOPOLOGY_VERSION||review.sha256!==sha256||!evidence(review.evidence_ids))missing.push('EXACT_BYTES_REVIEW_REQUIRED');
 if(!comparisonReady(review||{}))missing.push('SOURCE_TO_VIDEO_COMPARISON_REQUIRED');
 if(review?.all_frames_decoded!==true || !Number.isInteger(review.decoded_frame_count)||review.decoded_frame_count<1||!Number.isFinite(review.fps)||review.fps<=0)missing.push('DECODED_FRAME_COVERAGE_REQUIRED');
 if(!Array.isArray(review?.findings))missing.push('FINDINGS_REQUIRED');
 const findings=(review?.findings||[]).map(f=> {
  const pending=[],indices=f.frame_indices||[],run=consecutiveRun(indices),duration=run/(review.fps||1);
  const bbox=f.region?.bbox;
  if(!evidence(f.evidence_ids)||!Array.isArray(bbox)||bbox.length!==4||!bbox.every(finite)||bbox[2]<=0||bbox[3]<=0)pending.push('REGION_EVIDENCE_REQUIRED');
  if(!indices.length||indices.some(i=>i>=review.decoded_frame_count)||run===0||f.first_suspicious_frame!==indices[0]||f.last_suspicious_frame!==indices.at(-1)||!finite(f.duration_seconds)||Math.abs(f.duration_seconds-(indices.at(-1)-indices[0]+1)/(review.fps||1))>0.001)pending.push('TEMPORAL_RANGE_REQUIRED');
  const structural=SIGNALS.every(k=>f.signals?.[k]?.observed===true && evidence(f.signals[k].evidence_ids));
  const independentEvidence=new Set(SIGNALS.flatMap(k=>f.signals?.[k]?.evidence_ids||[])).size>=2;
  const persists=run>=5 || (run>=2&&duration>=0.20);
  const contradictions=Array.isArray(f.contradicting_signals)?f.contradicting_signals:[];
  if(!Array.isArray(f.contradicting_signals)||!Array.isArray(f.supporting_signals))pending.push('SIGNAL_LEDGER_REQUIRED');
  const newVsCanonical=f.source_relation?.absent_from_canonical===true && ['INTRODUCED_TEMPORALLY','PRESENT_IN_VIDEO_SOURCE','PERSPECTIVE_OR_LIGHTING','UNKNOWN'].includes(f.source_relation?.origin);
  // Confidence is categorical evidence strength, not an invented probability.
  const high=!missing.length&&!pending.length&&DEFECTS.includes(f.category)&&structural&&independentEvidence&&persists&&newVsCanonical&&contradictions.length===0;
  const likely=!high&&!missing.length&&!pending.length&&f.alternative_explanation?.verified===true&&CONFOUNDS.includes(f.alternative_explanation.type)&&evidence(f.alternative_explanation.evidence_ids)&&f.signals?.INDEPENDENT_ANATOMICAL_CONNECTION?.observed!==true;
  const confidence_class=high?'HIGH_CONFIDENCE_MUTATION':likely?'LIKELY_PERSPECTIVE_OR_OVERLAP':'AMBIGUOUS_CONTOUR';
  return {...f,consecutive_decoded_frames:run,persistence_seconds:duration,confidence_class,confidence:confidence_class,severity:SEVERITY[confidence_class],pending,
   supporting_signals:f.supporting_signals||[],contradicting_signals:contradictions,
   high_confidence_criteria:{new_mass:!!f.signals?.NEW_MASS?.observed,independent_connection:!!f.signals?.INDEPENDENT_ANATOMICAL_CONNECTION?.observed,temporal_persistence:persists,motion_coherence:!!f.signals?.MOTION_COHERENCE?.observed,canonical_silhouette_change:!!f.signals?.CANONICAL_SILHOUETTE_CHANGE?.observed,source_comparison:!missing.includes('SOURCE_TO_VIDEO_COMPARISON_REQUIRED')}};
 });
 const confidence_class=findings.some(f=>f.confidence_class==='HIGH_CONFIDENCE_MUTATION')?'HIGH_CONFIDENCE_MUTATION':missing.length||findings.some(f=>f.confidence_class==='AMBIGUOUS_CONTOUR')?'AMBIGUOUS_CONTOUR':findings.length?'LIKELY_PERSPECTIVE_OR_OVERLAP':'NO_DEFECT';
 return {version:TEMPORAL_TOPOLOGY_VERSION,calibration_version:CONFIDENCE_CALIBRATION_VERSION,sha256,confidence_class,severity:SEVERITY[confidence_class],status:SEVERITY[confidence_class],automatic_classification:confidence_class==='HIGH_CONFIDENCE_MUTATION'?'GENERATIVE_FATAL':SEVERITY[confidence_class],findings,pending:missing,visual_certification:false,human_override_used:false,
  limitation:'Typed evidence classification; review annotations must be grounded in decoded pixels. Human assembly approval does not alter confidence.'};
}
