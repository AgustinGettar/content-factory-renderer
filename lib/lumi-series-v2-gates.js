export function stepIdentity(shot,stage){
 if(!['q32','q33','q34','q35','q36'].includes(shot)||!['IMAGE','VIDEO'].includes(stage))throw new Error('v2_explicit_single_step_required');
 return `${shot}-${stage==='IMAGE'?'SOURCE-V2-1':'V2-PRO1'}`;
}
export function budgetGate(budget,projection){
 if(budget?.status!=='AUTHORIZED'||budget.allow_emission!==true||Number(budget.authorized_additional_ceiling_usd)!==3.24)throw new Error('v2_human_budget_authorization_required');
 if(!Number.isFinite(projection)||projection>3.24)throw new Error('v2_budget_projection_exceeds_authorized_3_24');
}
export function sourceGate(record,row){
 const qa=row?.result?.visual_qa;
 if(row?.content_hash!==record.sha256||!['PASS','PASS_WITH_MINOR_WARNING'].includes(qa?.classification)||qa?.sha256!==record.sha256)throw new Error('v2_exact_source_visual_qa_required');
 for(const key of ['IDENTITY','REALISM','ANATOMY','EDUCATIONAL_SEMANTICS','COLOR','VIDEO_SOURCE_READINESS'])if(qa[key]!=='PASS')throw new Error(`v2_source_gate_${key}`);
 if(qa.CARTOON_DRIFT!=='MINIMAL')throw new Error('v2_source_cartoon_drift');
}
export function previousVideoGate(row){
 const qa=row?.result?.temporal_qa;
 if(!['PASS','PASS_WITH_MINOR_WARNING'].includes(qa?.QUALITY_PARITY_WITH_Q31_PRO2)||qa.sha256!==row.content_hash||qa.TECHNICAL_QA!=='PASS')throw new Error('v2_previous_video_quality_gate_required');
}
