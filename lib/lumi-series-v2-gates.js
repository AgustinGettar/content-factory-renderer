import approvedAssembly from '../docs/cinematic-director-v1/human-review-20261005/HUMAN_ASSEMBLY_APPROVALS_V1.json' with {type:'json'};
import {stableStringify,sha256} from './cinematic-director-v1/PROMPT_COMPILER_V3.mjs';
export const BODY_QA_FIELDS = Object.freeze(['NO_BEE_ABDOMEN','NO_STRIPED_POSTERIOR_BODY','NO_STINGER','NO_EXTRA_TORSO','NO_REAR_BULB']);
export function bodyAnatomyGate(qa){
 if(qa?.BODY_LOCK_VERSION!=='LUMI_BODY_ANATOMY_LOCK_V1')throw new Error('v2_body_lock_review_required');
 for(const key of BODY_QA_FIELDS)if(qa[key]!=='PASS')throw new Error(`v2_body_anatomy_gate_${key}`);
 if(!['PASS','PASS_WITH_WARNING'].includes(qa.ANATOMY))throw new Error('v2_body_anatomy_blocker');
}
export function stepIdentity(shot,stage){
 if(!['q32','q33','q34','q35','q36'].includes(shot)||!['IMAGE','VIDEO'].includes(stage))throw new Error('v2_explicit_single_step_required');
 return `${shot}-${stage==='IMAGE'?'SOURCE-V2-1':'V2-PRO1'}`;
}
export function budgetGate(budget,projection){
 const renewed=budget?.current_episode_completion;
 if(renewed?.authorization==='USER_20261005_EPISODE_COMPLETION' && renewed.episode_id==='ep_lumi_flores_003' &&
    renewed.additional_visual_ceiling_usd===3 && Number.isFinite(renewed.previous_checkpoint_spend_usd)){
   const additional=Number((projection-renewed.previous_checkpoint_spend_usd).toFixed(6));
   if(!Number.isFinite(additional)||additional<0||additional>3)throw new Error('v2_additional_visual_budget_exceeds_3');
   return;
 }
 if(budget?.status!=='AUTHORIZED'||budget.allow_emission!==true||Number(budget.authorized_additional_ceiling_usd)!==3.24)throw new Error('v2_human_budget_authorization_required');
 if(!Number.isFinite(projection)||projection>3.24)throw new Error(`v2_budget_projection_exceeds_authorized_3_24:${projection}`);
}
export function sourceGate(record,row){
 const qa=row?.result?.visual_qa;
 if(row?.content_hash!==record.sha256||!['PASS','PASS_WITH_MINOR_WARNING'].includes(qa?.classification)||qa?.sha256!==record.sha256)throw new Error('v2_exact_source_visual_qa_required');
 for(const key of ['IDENTITY','REALISM','ANATOMY','EDUCATIONAL_SEMANTICS','COLOR','VIDEO_SOURCE_READINESS'])if(qa[key]!=='PASS')throw new Error(`v2_source_gate_${key}`);
 bodyAnatomyGate(qa);
 if(qa.CARTOON_DRIFT!=='MINIMAL')throw new Error('v2_source_cartoon_drift');
}
export function previousVideoGate(row){
 const layer=row?.result?.human_review_layers?.HUMAN_REVIEW_20261005;
 const exact=approvedAssembly.records.find(a=>a.sha256===row?.content_hash && a.shot===layer?.shot);
 if(exact && layer?.record_sha256===sha256(stableStringify(exact)) &&
    stableStringify({...layer,record_sha256:undefined})===stableStringify({...exact,record_sha256:undefined}))return;
 const qa=row?.result?.temporal_qa;
 if(!['PASS','PASS_WITH_MINOR_WARNING'].includes(qa?.QUALITY_PARITY_WITH_Q31_PRO2)||qa.sha256!==row.content_hash||qa.TECHNICAL_QA!=='PASS')throw new Error('v2_previous_video_quality_gate_required');
 bodyAnatomyGate(qa);
}

export async function readV2Json(storage,prefix,name){
 const path=`${prefix}/${name}.json`,split=path.lastIndexOf('/');
 const listing=await storage.list(path.slice(0,split),{search:path.slice(split+1),limit:100});
 if(listing.error||!Array.isArray(listing.data))throw new Error(`v2_record_list_failed:${name}`);
 if(!listing.data.some(x=>x.name===path.slice(split+1)))return null;
 const r=await storage.download(path);if(r.error||!r.data)throw new Error(`v2_record_read_failed:${name}`);
 return JSON.parse(await r.data.text());
}
