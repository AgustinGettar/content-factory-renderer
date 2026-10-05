import {TEMPORAL_TOPOLOGY_VERSION,SIGNALS,DEFECTS} from '../../lib/cinematic-director-v1/temporal-topology-qa-v2.js';
export const fixtureSha='a'.repeat(64);
export function validReview(){return {version:TEMPORAL_TOPOLOGY_VERSION,sha256:fixtureSha,evidence_ids:['SYNTHETIC_PIXELS_NOT_HUMAN'],all_frames_decoded:true,decoded_frame_count:24,fps:24,
 comparisons:Object.fromEntries(['canonical_source','video_source','first_frame','preceding_clean_frames','following_frames'].map(k=>[k,{reviewed:true,evidence_ids:['SYNTHETIC_'+k],...(k.endsWith('source')?{sha256:'b'.repeat(64)}:{video_sha256:fixtureSha})}])),findings:[]};}
export function invalidAnatomy(category='POSTERIOR_BODY_MUTATION') {const r=validReview();r.findings=[{category,evidence_ids:['SYNTHETIC_FRAME_5','SYNTHETIC_FRAME_6'],first_suspicious_frame:5,last_suspicious_frame:9,frame_indices:[5,6,7,8,9],duration_seconds:5/24,region:{bbox:[0.1,0.2,0.3,0.3],units:'NORMALIZED'},
 signals:Object.fromEntries(SIGNALS.map((k,i)=>[k,{observed:true,evidence_ids:['SYNTHETIC_STRUCTURAL_SIGNAL_'+i]}])),source_relation:{absent_from_canonical:true,origin:'INTRODUCED_TEMPORALLY'},supporting_signals:[...SIGNALS],contradicting_signals:[]}];return r;}
export function negativeFixtures(){return DEFECTS.map(category=>({id:'SYNTHETIC_UNAMBIGUOUS_'+category,kind:'SYNTHETIC_NOT_HISTORICAL_CLIP',review:invalidAnatomy(category)}));}
