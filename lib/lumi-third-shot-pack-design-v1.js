import { createClient } from '@supabase/supabase-js';
import { buildThirdShotPack, validateThirdShotPack } from './lumi-third-shot-pack-v1.js';
import { THIRD_SHORT_MEDIA } from './lumi-third-short-media-v1.js';

export async function runThirdShotPackDesign({env=process.env,logger=console}={}) {
  if(env.LUMI_RUNTIME_ENV!=='staging')throw new Error('shot_pack_staging_only');
  const supabase=createClient(env.SUPABASE_URL,env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false}});
  const {data:artifact,error:planError}=await supabase.from('av2_creative_artifacts').select('payload').eq('id','215bec01-1629-4069-a446-c38199db3fe3').single();
  if(planError||!artifact)throw new Error('shot_pack_plan_missing');
  const {data:sources,error}=await supabase.from('lumi_pilot_runs').select('scene_id,status,content_hash,storage_bucket,storage_path,result').eq('pilot_id',THIRD_SHORT_MEDIA.pilotId).eq('stage','IMAGE').eq('status','SUCCEEDED');
  if(error)throw new Error('shot_pack_sources_missing');
  // Same immutable API quote from 2026-10-04. No estimator or generation during design.
  const quotes=sources.map(s=>({scene:s.scene_id,model:'kling-video/v3.0/std/image-to-video',estimated_cost_usd:0.357}));
  const pack=buildThirdShotPack(artifact.payload,{sources,quotes});
  const review=[];
  for(const source of sources){
    const {data,error}=await supabase.storage.from(source.storage_bucket).createSignedUrl(source.storage_path,3600);
    if(error)throw new Error('shot_pack_review_sign_failed');
    review.push({scene_id:source.scene_id,sha256:source.content_hash,review_url:data.signedUrl});
  }
  const report={event:'lumi_third_shot_pack_design',episode_id:pack.episode_id,design:validateThirdShotPack(pack,artifact.payload),
    execution:validateThirdShotPack(pack,artifact.payload,{requireSourceQa:true}),BEATS:pack.beats.length,VISUAL_SHOTS:pack.shots.length,
    UNIQUE_IMAGES:pack.unique_images,NEW_IMAGE_CALLS:0,KLING_CALLS:pack.video_calls,GENERATED_VIDEO_SECONDS:pack.generated_video_seconds,
    LOCAL_ONLY_BEATS:pack.local_only_beats,PROJECTED_VISUAL_COST_USD:pack.projected_visual_cost_usd,
    INCREMENTAL_VISUAL_COST_USD:pack.incremental_visual_cost_usd,pack_sha256:pack.pack_sha256,provider_calls:0,review};
  logger.info(JSON.stringify(report));return report;
}
