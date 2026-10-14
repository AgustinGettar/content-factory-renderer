import {sha256,validateArtifact,artifactReview} from './telegram-review-v1/core.js';
import {inputDigest,FIRST_IMAGE_EPISODE,FIRST_IMAGE_OPERATION} from './lumi-v2-activation-context.js';
import {acceptEpisodeGeneration} from './av2/creative-engine.js';
import {LUMI_PRODUCTION_PROFILE_V2 as profile,PROFILE_SHA} from './lumi-production-profile-v2.js';
import {isStageComplete} from './lumi-recovery-incident-manager-v1.js';
import {sourceGate} from './lumi-series-v2-gates.js';
import sourceEvidence from '../episodes/ep_lumi_granja_004_20261008_ee7ab4b3/q41-source-qa.json' with {type:'json'};
import {isolatedQ41Input} from './lumi-isolated-usd-preflight.js';
import {materializeEp004Direction,ep004HumanSourceEvidence} from './lumi-generic-v2-adapter.js';

// Scoped observations of one inspected original, never a detector or human approval.
// The caller must still verify original bytes, the journal and the existing decision.
export function sourceQaRecord(state,shotId,artifact){
  const stored=state.metadata.source_artifacts?.[shotId];
  if(stored)return stored.artifact?.artifact_id===artifact?.artifact_id&&stored.artifact?.sha256===artifact?.sha256?stored:null;
  const human=ep004HumanSourceEvidence(state,shotId,artifact);if(human)return human;
  const i=state.metadata.imported_stage_sources?.['image:'+shotId],e=sourceEvidence;
  if(state.episode_id!==e.episode_id||shotId!==e.shot_id||artifact?.sha256!==e.sha256
    ||artifact.size!==e.size||artifact.width!==e.width||artifact.height!==e.height||artifact.mime!==e.mime
    ||e.canonical_sha256!==profile.visual.source_sha||i?.artifact_sha!==e.sha256||i.artifact_id!==artifact.artifact_id
    ||i.provider_request_id!==e.provider_request_id||i.human_review?.status!=='APPROVED'
    ||i.human_review.artifact_sha!==e.sha256)return null;
  return {artifact,ledger:structuredClone(e.ledger)};
}

export const checkpointIdentity = state => inputDigest(state);
const required=(value,code)=>{if(value==null)throw Error(code);return value;};

// Read-only reconstruction. Registry records identify durable original objects;
// signed URLs, local paths, credentials and callback-supplied inputs are not used.
export function createV2InputMaterializer({store,storage,reviewStore,journal,receipts,quoteOnly=false}) {
  if(!store?.getEpisode||!storage?.download||!reviewStore?.get||!journal?.get)throw Error('INPUT_MATERIALIZER_DEPENDENCIES_REQUIRED');
  return async function materialize({episode_id,stage_id,checkpoint_id,profile_version,execution_context}) {
    const state=required(await store.getEpisode(episode_id),'CHECKPOINT_REQUIRED'),p=state.metadata?.generic_v2;
    if(state.episode_id!==episode_id||p?.episode_id!==episode_id)throw Error('EPISODE_IDENTITY_MISMATCH');
    if(profile_version!==profile.version||p.profile_sha!==PROFILE_SHA)throw Error('PROFILE_COMPATIBILITY_FAILURE');
    if(!Number.isSafeInteger(state.metadata.runtime_revision)||state.metadata.runtime_revision<1)throw Error('CHECKPOINT_VERSION_REQUIRED');
    if(checkpointIdentity(state)!==checkpoint_id)throw Error('STALE_CHECKPOINT');
    if(execution_context?.user!==state.metadata.user||execution_context?.profile_sha!==PROFILE_SHA)throw Error('EXECUTION_CONTEXT_REQUIRED');
    const action=state.actions.find(a=>a.key===state.first_pending_action);
    if(quoteOnly&&(episode_id!==FIRST_IMAGE_EPISODE||!(quoteOnly==='CURRENT_PAID_ACTION'?['IMAGE','VIDEO','TTS'].includes(stage_id):stage_id==='VIDEO'&&action?.key==='video:q41')))throw Error('VIDEO_QUOTE_SCOPE_REQUIRED');
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
      const canonical=shared&&isolatedQ41Input().canonical_artifact;
      const frozen=canonical&&ref?.artifact_id===canonical.artifact_id&&ref.sha256===canonical.sha256;
      const a=required(state.metadata.artifacts?.[typeof ref==='string'?ref:ref?.artifact_id]||(frozen?{...canonical,profile_sha:PROFILE_SHA}:null),'ARTIFACT_MISSING');
      validateArtifact(a);
      if(a.episode_id!==episode_id&&!(shared&&a.profile_sha===PROFILE_SHA))throw Error('EPISODE_IDENTITY_MISMATCH');
      if(ref?.sha256&&ref.sha256!==a.sha256)throw Error('ARTIFACT_INTEGRITY_FAILURE');
      const data=await storage.download(a.bucket,a.path);if(data==null)throw Error('ARTIFACT_MISSING');
      const dataBytes=Buffer.from(data);if(dataBytes.length!==a.size||sha256(dataBytes)!==a.sha256)throw Error('ARTIFACT_INTEGRITY_FAILURE');
      if(review&&!frozen)approved(a);
      if(frozen)provenance.human_reviews[a.artifact_id]={status:'FROZEN_PROFILE_CANONICAL',profile_sha:PROFILE_SHA};
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
        let journalEpisode=episode_id;
        const imported=state.metadata.imported_stage_sources?.[key];
        if(imported){
          const source=await store.getEpisode(FIRST_IMAGE_OPERATION),f=source?.metadata.first_image;
          if(episode_id!==FIRST_IMAGE_EPISODE||key!=='image:q41'||imported.source_episode_id!==FIRST_IMAGE_OPERATION
            ||source?.metadata.target_episode!==episode_id||source.metadata.user!==state.metadata.user
            ||f?.review?.status!=='APPROVED'||inputDigest(f.review)!==inputDigest(imported.human_review)
            ||f.artifact?.sha256!==a.sha256||imported.artifact_sha!==a.sha256||imported.artifact_id!==a.artifact_id
            ||imported.attempt_id!==r.claims[0]||imported.attempt_id!==(f.attempt_id??FIRST_IMAGE_OPERATION)
            ||f.accepted?.request_id!==imported.provider_request_id||imported.provider_request_id!==a.provider_job_id)
            throw Error('PROVIDER_JOURNAL_MISMATCH');
          journalEpisode=FIRST_IMAGE_OPERATION;
        }
        if(!receipt||receipt.episode_id!==journalEpisode||(receipt.stage||receipt.stage_id)!==r.stage_id
          ||(receipt.provider_request_id||receipt.job_id)!==a.provider_job_id
          ||!['ACKNOWLEDGED','SUCCEEDED','SUCCEEDED_WITH_WARNING','HUMAN_REVIEW_REQUIRED'].includes(receipt.state))throw Error('PROVIDER_JOURNAL_MISMATCH');
        provenance.emission_journal.push({attempt_id:receipt.attempt_id,provider_request_id:a.provider_job_id});
      }
      const artifacts=[a];
      if(r.stage_id==='TTS'&&r.output?.narration_units){
        if(r.output.narration_units.length!==p.shot_plans.length||r.artifacts.length!==p.shot_plans.length)throw Error('TTS_SEGMENTS_INCOMPLETE');
        for(const [index,unit] of r.output.narration_units.entries()){
          const artifact=await read(r.artifacts[index],{review:true}),receipt=await receipts.get('tts:'+unit.claim);
          if(unit.shot_id!==p.shot_plans[index].shot_id||unit.artifact_id!==artifact.artifact_id||unit.artifact_sha!==artifact.sha256
            ||receipt?.job_id!==artifact.provider_job_id||receipt.episode_id!==episode_id||receipt.narration_unit_id!==unit.narration_unit_id
            ||!['SUCCEEDED','SUCCEEDED_WITH_WARNING'].includes(receipt.state)||receipt.artifact?.sha256!==artifact.sha256||unit.qa?.ok!==true)throw Error('TTS_SEGMENT_JOURNAL_MISMATCH');
          if(index)artifacts.push(artifact);
        }
      }
      return {artifact:a,artifacts,qa:r.qa,output:r.output,result:r};
    };
    const shot=p.shot_plans.find(s=>s.shot_id===action.scene_id),input={episode_plan:p.plan,
      ...(shot?{shot_plan:shot}:{}),...(stage_id==='TTS'?{narration_request:p.narration_request}:{})};
    const source=async(review=false)=>{
      const x=await fromStage('image:'+shot.shot_id,{review});
      const ledger=sourceQaRecord(state,shot.shot_id,x.artifact)?.ledger
        ||{content_hash:x.artifact.sha256,result:{visual_qa:x.qa.visual_qa||x.output?.visual_qa}};
      sourceGate(x.artifact,ledger);return {artifact:x.artifact,ledger};
    };
    switch(stage_id){
      case 'PLANNING':case 'SOURCE_PLANNING':break;
      case 'IMAGE':{
        const a=Object.values(state.metadata.artifacts||{}).filter(a=>a.sha256===profile.visual.source_sha)
          .sort((a,b)=>a.artifact_id.localeCompare(b.artifact_id))[0];
        input.canonical_artifact=await read(a||isolatedQ41Input().canonical_artifact,{shared:true,review:true});
        input.canonical_sha=profile.visual.source_sha;break;
      }
      case 'SOURCE_QA':input.source=await source(true);break;
      case 'DIRECTOR':
        input.source=await source(true);
        for(const a of [input.source.artifact,...shot.director_input.contract.GOLDEN_REFERENCES])await read(a,{review:true,shared:true});
        input.topology_review=required(state.metadata.stage_qa?.['source_qa:'+shot.shot_id]?.topology_review,'QA_NOT_ELIGIBLE');
        if(shot.director_input.materialization_status==='SOURCE_EVIDENCE_REQUIRED'){
          result('source_qa:'+shot.shot_id);
          input.director_input=materializeEp004Direction({state,prepared:p,shot,source:input.source,
            sourceQa:state.metadata.stage_results['source_qa:'+shot.shot_id],
            approval:state.metadata.imported_stage_sources?.['image:'+shot.shot_id]?.human_review});
        }
        break;
      case 'VIDEO':
        input.source=await source(true);input.director_packet=required(result('director:'+shot.shot_id).output,'DIRECTOR_PACKET_MISSING');
        if(input.director_packet.DIRECTOR_PLAN?.contract.SOURCE_ARTIFACT.sha256!==input.source.artifact.sha256)throw Error('ARTIFACT_INTEGRITY_FAILURE');
        break;
      case 'TEMPORAL_QA':{
        input.source=await source();const v=await fromStage('video:'+shot.shot_id);
        input.video_artifact=v.artifact;input.video_sha=v.artifact.sha256;
        input.temporal_review=v.qa.temporal_review||v.output?.temporal_review;
        if(!input.temporal_review){
          const r=Object.values(state.metadata.review_requests||{}).find(r=>r.stage_id==='VIDEO'&&r.artifact_id===v.artifact.artifact_id&&r.artifact_sha===v.artifact.sha256&&r.status==='APPROVED');
          const h=r?.human_decision,c=r?.review_contract,decision=h?.checklist_decision;
          const fps=String(v.qa.video?.avg_frame_rate||'').split('/').map(Number),count=Number(v.qa.video?.nb_frames);
          if(c?.version==='EP004_MEDIA_CHECKLIST_V1'&&decision?.contract_sha===inputDigest(c)&&decision.full_playback===true
            &&decision.source_comparison===true&&h.user===state.metadata.user&&h.callback_query_id&&h.artifact_sha===v.artifact.sha256
            &&c.source_sha===input.source.artifact.sha256&&v.qa.decode==='PASS'&&Number.isSafeInteger(count)&&count>0&&fps[1]>0){
            const evidence_ids=[h.callback_query_id];
            input.temporal_review={version:'TEMPORAL_TOPOLOGY_QA_V2',sha256:v.artifact.sha256,evidence_ids,
              method:'AUTHENTIC_HUMAN_FULL_PLAYBACK_CHECKLIST',all_frames_decoded:true,decoded_frame_count:count,fps:fps[0]/fps[1],findings:[],
              comparisons:{canonical_source:{reviewed:true,sha256:profile.visual.source_sha,evidence_ids},
                video_source:{reviewed:true,sha256:input.source.artifact.sha256,evidence_ids},
                ...Object.fromEntries(['first_frame','preceding_clean_frames','following_frames'].map(k=>[k,{reviewed:true,video_sha256:v.artifact.sha256,evidence_ids}]))}};
          }
        }
        required(input.temporal_review,'QA_NOT_ELIGIBLE');break;
      }
      case 'SHOT_REVIEW':{
        const v=await fromStage('video:'+shot.shot_id,{allowPendingReview:true});input.shot_artifact=v.artifact;input.technical_qa=v.qa;input.review_episode=e;break;
      }
      case 'TTS':
        for(const s of p.shot_plans)await fromStage('video:'+s.shot_id,{review:true});
        input.output_artifact_target={bucket:'generated-audio',prefix:`lumi-v2/${episode_id}`};
        input.budget_context=quoteOnly?{authorized:false}:required(state.metadata.tts_budget_context,'TTS_BUDGET_CONTEXT_REQUIRED');break;
      case 'TTS_STORAGE':{const tts=await fromStage('tts',{review:true});input.audio_artifact=tts.artifact;input.audio_artifacts=tts.artifacts;break;}
      case 'CAPTIONS':
        if(p.plan.scenes.every(s=>Array.isArray(s.text)&&s.text.length===0)){
          // Conservative full-frame protected regions; no text is authored or rendered.
          const frame={x:0,y:0,width:1080,height:1920};
          input.caption_qa={lumi_bbox:frame,critical_educational_object_bboxes:[frame],safe_area:frame,text_elements:[]};
        }else input.caption_qa=required(state.metadata.stage_qa?.captions,'QA_NOT_ELIGIBLE');break;
      case 'ASSEMBLY':{
        for(const s of p.shot_plans)await fromStage('video:'+s.shot_id,{review:true});
        const tts=await fromStage('tts',{review:true});
        input.segments=state.metadata.assembly_segments;
        if(!input.segments&&tts.output?.narration_units){
          input.segments=[];
          for(const shot of p.shot_plans){
            const unit=tts.output.narration_units.find(u=>u.shot_id===shot.shot_id),audio=tts.artifacts.find(a=>a.artifact_id===unit?.artifact_id);
            const video=(await fromStage('video:'+shot.shot_id,{review:true})).artifact,pause=shot.response_window_seconds||0;
            if(!audio||!(audio.duration>0)||audio.duration>shot.duration-pause+.03||Math.abs(video.duration-shot.duration)>.08)throw Error('NATURAL_AUDIO_VIDEO_TIMING_REVIEW_REQUIRED');
            input.segments.push({video_artifact:video,audio_artifact:audio,duration:shot.duration,pause,audio_start_seconds:pause?Math.max(0,Number((shot.duration-pause-audio.duration).toFixed(3))):0});
          }
        }
        required(input.segments,'ASSEMBLY_INPUT_REQUIRED');
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
    if(['IMAGE','VIDEO'].includes(stage_id)&&!quoteOnly)input.quote=required(state.metadata.provider_quotes?.[action.key],'CURRENT_USD_QUOTE_REQUIRED');
    if(checkpointIdentity(await store.getEpisode(episode_id))!==checkpoint_id
      ||inputDigest((await reviewStore.get(state.metadata.user))?.state.episodes[episode_id])!==reviewDigest)throw Error('STALE_CHECKPOINT');
    return {materialized_stage_input:input,artifact_references:Object.values(references),validated_hashes:hashes,
      checkpoint_version:state.metadata.runtime_revision,provenance,readiness_status:'READY',artifact_bytes:bytes,
      MATERIALIZE_PROVIDER_CALLS:0,MATERIALIZE_NEW_ARTIFACTS:0};
  };
}
