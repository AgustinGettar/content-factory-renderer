import { createClient } from '@supabase/supabase-js';
import {readFile} from 'node:fs/promises';
import { buildThirdShotPack, validateThirdShotPack, shotPackResumeGate } from './lumi-third-shot-pack-v1.js';
import { THIRD_SHORT_MEDIA } from './lumi-third-short-media-v1.js';
import { estimateHiggsfieldUsd } from './higgsfield-usd-budget-v1.js';
import {createHash} from 'node:crypto';

export async function runThirdShotPackDesign({env=process.env,logger=console,freshPreflight=false,fetchImpl=fetch}={}) {
  if(env.LUMI_RUNTIME_ENV!=='staging')throw new Error('shot_pack_staging_only');
  const supabase=createClient(env.SUPABASE_URL,env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false}});
  const {data:artifact,error:planError}=await supabase.from('av2_creative_artifacts').select('payload').eq('id','215bec01-1629-4069-a446-c38199db3fe3').single();
  if(planError||!artifact)throw new Error('shot_pack_plan_missing');
  const {data:sources,error}=await supabase.from('lumi_pilot_runs').select('scene_id,status,content_hash,storage_bucket,storage_path,result').eq('pilot_id',THIRD_SHORT_MEDIA.pilotId).eq('stage','IMAGE').eq('status','SUCCEEDED');
  if(error)throw new Error('shot_pack_sources_missing');
  const qa=JSON.parse(await readFile(new URL('../episodes/ep_lumi_flores_003/SHOT_PACK_SOURCE_QA.json',import.meta.url),'utf8'));
  for(const source of sources){
    const evidence=qa.sources.find(q=>q.scene_id===source.scene_id&&q.sha256===source.content_hash);
    if(evidence)source.result={...source.result,visual_qa:evidence};
  }
  // Same immutable API quote from 2026-10-04. No estimator or generation during design.
  const quotes=[];
  let pack=buildThirdShotPack(artifact.payload,{sources,quotes});
  const review=[];
  for(const source of sources){
    const {data,error}=await supabase.storage.from(source.storage_bucket).createSignedUrl(source.storage_path,3600);
    if(error)throw new Error('shot_pack_review_sign_failed');
    review.push({scene_id:source.scene_id,sha256:source.content_hash,review_url:data.signedUrl});
  }
  if(freshPreflight){
    for(const shot of pack.shots){
      const source=review.find(s=>s.scene_id===shot.source_scene);
      if(!source)throw new Error('six_existing_sources_required');
      const response=await fetchImpl(source.review_url);
      if(!response.ok)throw new Error('source_download_failed');
      const bytes=Buffer.from(await response.arrayBuffer());
      if(createHash('sha256').update(bytes).digest('hex')!==shot.source_sha256)throw new Error('source_hash_mismatch');
      const input={...shot.input,prompt:shotPackPrompt(shot),image_url:source.review_url};
      try{
        const quote=await estimateHiggsfieldUsd({apiKey:env.HF_API_KEY,model:shot.model,input,fetchImpl});
        quotes.push({scene:shot.source_scene,shot_id:shot.id,duration_seconds:shot.duration_seconds,...quote});
      }catch(error){
        quotes.push({scene:shot.source_scene,shot_id:shot.id,model:shot.model,duration_seconds:shot.duration_seconds,error:error.message});
      }
    }
    pack=buildThirdShotPack(artifact.payload,{sources,quotes});
  }
  const {data:checkpoint,error:checkpointError}=await supabase.from('lumi_pipeline_checkpoints').select('episode_id,status,current_cost_usd,authorized_ceiling_usd,first_pending_action,active_incident_id,metadata,runner_enabled,autorun').eq('episode_id',pack.episode_id).single();
  if(checkpointError)throw new Error('checkpoint_read_failed');
  const report={event:'lumi_third_shot_pack_design',episode_id:pack.episode_id,design:validateThirdShotPack(pack,artifact.payload),
    execution:validateThirdShotPack(pack,artifact.payload,{requireSourceQa:true}),BEATS:pack.beats.length,VISUAL_SHOTS:pack.shots.length,
    UNIQUE_IMAGES:pack.unique_images,NEW_IMAGE_CALLS:0,KLING_CALLS:pack.video_calls,GENERATED_VIDEO_SECONDS:pack.generated_video_seconds,
    LOCAL_ONLY_BEATS:pack.local_only_beats,PROJECTED_VISUAL_COST_USD:pack.projected_visual_cost_usd,
    INCREMENTAL_VISUAL_COST_USD:pack.incremental_visual_cost_usd,resume:shotPackResumeGate(pack,artifact.payload,{freshQuotes:freshPreflight&&quotes.every(q=>q.estimated_cost_usd!==undefined)}),pack_sha256:pack.pack_sha256,provider_calls:0,quotes,checkpoint,pack,review};
  logger.info(JSON.stringify(report));return report;
}

export function shotPackPrompt(shot){
  return `Preserve the canonical Lumi character in the source image: stable face, clothing, two arms, two legs, two wings and two antennae. Preserve the scene and all flowers, their count, geometry and clear red, yellow or blue petal colors. No new props or characters. One continuous shot, static camera, natural real-time 1x motion. No slow motion, dreamy movement, prolonged holds, text, labels, logos or watermark. One main character action only; allowed secondary motion: blink, small head movement, subtle wing response and natural settle.\n\n${shot.motion}`;
}
