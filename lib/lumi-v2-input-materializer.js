import {sha256,validateArtifact,artifactReview} from './telegram-review-v1/core.js';
import {inputDigest} from './lumi-v2-activation-context.js';
import {acceptEpisodeGeneration} from './av2/creative-engine.js';
import {LUMI_PRODUCTION_PROFILE_V2 as profile,PROFILE_SHA} from './lumi-production-profile-v2.js';
import {isStageComplete} from './lumi-recovery-incident-manager-v1.js';
import {sourceGate} from './lumi-series-v2-gates.js';

export const checkpointIdentity = state => inputDigest(state);
const required=(value,code)=>{if(value==null)throw Error(code);return value;};

// Read-only reconstruction. Registry records identify durable original objects;
// signed URLs, local paths, credentials and callback-supplied inputs are not used.
export function createV2InputMaterializer({store,storage,reviewStore,journal,receipts}) {
  if(!store?.getEpisode||!storage?.download||!reviewStore?.get||!journal?.get)throw Error('INPUT_MATERIALIZER_DEPENDENCIES_REQUIRED');
  return async function materialize({episode_id,stage_id,checkpoint_id,profile_version,execution_context}) {
    const state=required(await store.getEpisode(episode_id),'CHECKPOINT_REQUIRED'),p=state.metadata?.generic_v2;
    if(state.episode_id!==episode_id||p?.episode_id!==episode_id)throw Error('EPISODE_IDENTITY_MISMATCH');
    if(profile_version!==profile.version||p.profile_sha!==PROFILE_SHA)throw Error('PROFILE_COMPATIBILITY_FAILURE');
    if(!Number.isSafeInteger(state.metadata.runtime_revision)||state.metadata.runtime_revision<1)throw Error('CHECKPOINT_VERSION_REQUIRED');
    if(checkpointIdentity(state)!==checkpoint_id)throw Error('STALE_CHECKPOINT');
    if(execution_context?.user!==state.metadata.user||execution_context?.profile_sha!==PROFILE_SHA)throw Error('EXECUTION_CONTEXT_REQUIRED');
    const action=state.actions.find(a=>a.key===state.first_pending_action);
    if(!action||action.stage!==stage_id||execution_context.action_key!==action.key)throw Error('STAGE_IDENTITY_MISMATCH');
    const expected=p.actions.find(a=>a.key===action.key);
    if(!expected||expected.stage!==action.stage||(expected.scene_id||null)!==action.scene_id)throw Error('STAGE_IDENTITY_MISMATCH');
    if(state.actions.length!==p.actions.length||state.actions.some((a,i)=>a.key!==p.actions[i].key||a.stage!==p.actions[i].stage
      ||a.scene_id!==(p.actions[i].scene_id||null)||a.index!==i)
      ||state.actions.find(a=>!isStageComplete(a))?.key!==state.first_pending_action)throw Error('CHECKPOINT_CONSISTENCY_FAILURE');
    if(state.actions.slice(0,state.actions.indexOf(action)).some(a=>!isStageComplete(a)))throw Error('CHECKPOINT_CONSISTENCY_FAILURE');
    if(acceptEpisodeGeneration(p.plan).episode_sha256!==p.plan_sha)throw Error('ARTIFACT_INTEGRITY_FAILURE');
    const {binding_sha,...bound}=p;
    if(p.binding_hash_version!=='CANONICAL_JSON_V1'||inputDigest(bound)!==binding_sha)throw Error('CHECKPOINT_INTEGRITY_FAILURE');
    const row=required(await reviewStore.get(state.metadata.user),'REVIEW_OWNER_REQUIRED');
    const e=required(row.state.episodes[episode_id],'REVIEW_EPISODE_REQUIRED');
    if(e.episode_id!==episode_id||e.profile_sha!==PROFILE_SHA)throw Error('PROFILE_COMPATIBILITY_FAILURE');
    const reviewDigest=inputDigest(e),references={},hashes={plan:p.plan_sha,prepared:binding_sha},bytes={};
    const provenance={episode_id,stage_id,action_key:action.key,checkpoint_id,profile_sha:PROFILE_SHA,
      source:'DURABLE_CHECKPOINT_AND_ARTIFACT_REGISTRY',emission_journal:[],qa:{},human_reviews:{}};
    const approved=a=>{
      const matching=Object.values(e.review_requests||{}).filter(r=>r.artifact_id===a.artifact_id&&r.artifact_sha===a.sha256)
        .sort((a,b)=>b.review_version-a.review_version||a.review_request_id.localeCompare(b.review_request_id));
      if(matching.some(r=>r.status!=='APPROVED'))throw Error('HUMAN_REVIEW_REQUIRED');
      const r=matching.find(r=>r.status==='APPROVED');
      const b=r&&state.metadata.review_requests?.[r.review_request_id];
      if(r&&b&&r.status==='APPROVED'&&b.status==='APPROVED'&&r.review_version===b.review_version
        &&b.artifact_id===a.artifact_id&&b.artifact_sha===a.sha256&&b.episode_id===episode_id
        &&r.human_decision?.user===state.metadata.user&&r.human_decision?.artifact_sha===a.sha256
        &&r.human_decision?.review_version===r.review_version){provenance.human_reviews[a.artifact_id]=r;return;}
      const shot=e.shots?.find(s=>s.artifact?.artifact_id===a.artifact_id),legacy=artifactReview(e,a,shot?.shot_id||null);
      if(legacy?.status==='APPROVED'&&legacy.user===state.metadata.user){provenance.human_reviews[a.artifact_id]=legacy;return;}
      throw Error('HUMAN_REVIEW_REQUIRED');
    };
    const read=async(ref,{review=false,shared=false}={})=>{
      const a=required(state.metadata.artifacts?.[typeof ref==='string'?ref:ref?.artifact_id],'ARTIFACT_MISSING');
      validateArtifact(a);
      if(a.episode_id!==episode_id&&!(shared&&a.profile_sha===PROFILE_SHA))throw Error('EPISODE_IDENTITY_MISMATCH');
      if(ref?.sha256&&ref.sha256!==a.sha256)throw Error('ARTIFACT_INTEGRITY_FAILURE');
      const data=await storage.download(a.bucket,a.path);if(data==null)throw Error('ARTIFACT_MISSING');
      const dataBytes=Buffer.from(data);if(dataBytes.length!==a.size||sha256(dataBytes)!==a.sha256)throw Error('ARTIFACT_INTEGRITY_FAILURE');
      if(review)approved(a);
      references[a.artifact_id]=a;hashes[a.artifact_id]=a.sha256;bytes[a.artifact_id]=dataBytes;
      return a;
    };
    const result=key=>{
      const r=required(state.metadata.stage_results?.[key],'STAGE_RESULT_MISSING');
      if(r.hash_version!=='CANONICAL_JSON_V1'||inputDigest(r.result)!==r.sha256)throw Error('ARTIFACT_INTEGRITY_FAILURE');
      if(r.result.episode_id!==episode_id||r.result.stage_id!==state.actions.find(a=>a.key===key)?.stage)throw Error('STAGE_IDENTITY_MISMATCH');
      return r.result;
    };
    const fromStage=async(key,options={})=>{
      const r=result(key),a=await read(required(r.artifacts?.[0],'ARTIFACT_MISSING'),options);
      if(r.qa?.ok!==true||r.qa.sha256&&r.qa.sha256!==a.sha256)throw Error('QA_NOT_ELIGIBLE');
      if(r.human_review_requirement===true&&!options.allowPendingReview)approved(a);
      provenance.qa[key]=r.qa;
      if(['IMAGE','VIDEO','TTS'].includes(r.stage_id)){
        if(!a.provider_job_id)throw Error('PROVIDER_JOURNAL_MISMATCH');
        if(!r.provider_job_ids.includes(a.provider_job_id))throw Error('PROVIDER_JOURNAL_MISMATCH');
        // TTS uses its existing CAS receipt journal; image/video use the shared journal.
        const receipt=r.stage_id==='TTS'?await receipts?.get('tts:'+r.claims?.[0]):await journal.get(r.claims?.[0]);
        if(!receipt||receipt.episode_id!==episode_id||(receipt.stage||receipt.stage_id)!==r.stage_id
          ||(receipt.provider_request_id||receipt.job_id)!==a.provider_job_id
          ||!['ACKNOWLEDGED','SUCCEEDED','SUCCEEDED_WITH_WARNING','HUMAN_REVIEW_REQUIRED'].includes(receipt.state))throw Error('PROVIDER_JOURNAL_MISMATCH');
        provenance.emission_journal.push({attempt_id:receipt.attempt_id,provider_request_id:a.provider_job_id});
      }
      return {artifact:a,qa:r.qa,output:r.output,result:r};
    };
    const shot=p.shot_plans.find(s=>s.shot_id===action.scene_id),input={episode_plan:p.plan,
      ...(shot?{shot_plan:shot}:{}),...(stage_id==='TTS'?{narration_request:p.narration_request}:{})};
    const source=async(review=false)=>{
      const x=await fromStage('image:'+shot.shot_id,{review});
      const ledger=state.metadata.source_artifacts?.[shot.shot_id]?.ledger
        ||{content_hash:x.artifact.sha256,result:{visual_qa:x.qa.visual_qa||x.output?.visual_qa}};
      sourceGate(x.artifact,ledger);return {artifact:x.artifact,ledger};
    };
    switch(stage_id){
      case 'PLANNING':case 'SOURCE_PLANNING':break;
      case 'IMAGE':{
        const a=Object.values(state.metadata.artifacts||{}).filter(a=>a.sha256===profile.visual.source_sha)
          .sort((a,b)=>a.artifact_id.localeCompare(b.artifact_id))[0];
        input.canonical_artifact=await read(required(a,'ARTIFACT_MISSING'),{shared:true,review:true});
        input.canonical_sha=profile.visual.source_sha;break;
      }
      case 'SOURCE_QA':input.source=await source();break;
      case 'DIRECTOR':
        input.source=await source(true);
        for(const a of [shot.director_input.contract.SOURCE_ARTIFACT,...shot.director_input.contract.GOLDEN_REFERENCES])await read(a,{review:true,shared:true});
        input.topology_review=required(state.metadata.stage_qa?.['source_qa:'+shot.shot_id]?.topology_review,'QA_NOT_ELIGIBLE');
        break;
      case 'VIDEO':
        input.source=await source(true);input.director_packet=required(result('director:'+shot.shot_id).output,'DIRECTOR_PACKET_MISSING');
        if(input.director_packet.DIRECTOR_PLAN?.contract.SOURCE_ARTIFACT.sha256!==input.source.artifact.sha256)throw Error('ARTIFACT_INTEGRITY_FAILURE');
        break;
      case 'TEMPORAL_QA':{
        input.source=await source();const v=await fromStage('video:'+shot.shot_id);
        input.video_artifact=v.artifact;input.video_sha=v.artifact.sha256;
        input.temporal_review=required(v.qa.temporal_review||v.output?.temporal_review,'QA_NOT_ELIGIBLE');break;
      }
      case 'SHOT_REVIEW':{
        const v=await fromStage('video:'+shot.shot_id,{allowPendingReview:true});input.shot_artifact=v.artifact;input.technical_qa=v.qa;input.review_episode=e;break;
      }
      case 'TTS':
        for(const s of p.shot_plans)await fromStage('video:'+s.shot_id,{review:true});
        input.output_artifact_target={bucket:'generated-audio',prefix:`lumi-v2/${episode_id}`};
        input.budget_context=required(state.metadata.tts_budget_context,'TTS_BUDGET_CONTEXT_REQUIRED');break;
      case 'TTS_STORAGE':input.audio_artifact=(await fromStage('tts')).artifact;break;
      case 'CAPTIONS':
        input.caption_qa=required(state.metadata.stage_qa?.captions,'QA_NOT_ELIGIBLE');break;
      case 'ASSEMBLY':{
        for(const s of p.shot_plans)await fromStage('video:'+s.shot_id,{review:true});
        await fromStage('tts',{review:true});
        input.segments=required(state.metadata.assembly_segments,'ASSEMBLY_INPUT_REQUIRED');
        for(const s of input.segments){await read(s.video_artifact,{review:true});await read(s.audio_artifact,{review:true});}
        break;
      }
      case 'MASTER':input.master_artifact=(await fromStage('assembly')).artifact;break;
      case 'MASTER_REVIEW':{
        const master=await fromStage('master',{allowPendingReview:true});input.master_artifact=master.artifact;input.technical_qa=master.qa;
        input.review_episode={...e,master:master.artifact};
        input.panel={...row.state,episodes:{...row.state.episodes,[episode_id]:input.review_episode}};break;
      }
      default:throw Error('STAGE_IDENTITY_MISMATCH');
    }
    // Quotes and budgets are persisted evidence, never guessed by reconstruction.
    if(['IMAGE','VIDEO'].includes(stage_id))input.quote=required(state.metadata.provider_quotes?.[action.key],'CURRENT_USD_QUOTE_REQUIRED');
    if(checkpointIdentity(await store.getEpisode(episode_id))!==checkpoint_id
      ||inputDigest((await reviewStore.get(state.metadata.user))?.state.episodes[episode_id])!==reviewDigest)throw Error('STALE_CHECKPOINT');
    return {materialized_stage_input:input,artifact_references:Object.values(references),validated_hashes:hashes,
      checkpoint_version:state.metadata.runtime_revision,provenance,readiness_status:'READY',artifact_bytes:bytes,
      MATERIALIZE_PROVIDER_CALLS:0,MATERIALIZE_NEW_ARTIFACTS:0};
  };
}
