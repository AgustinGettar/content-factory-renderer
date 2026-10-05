import { createHash } from 'node:crypto';
import { estimateHiggsfieldUsd, sumUsd } from './higgsfield-usd-budget-v1.js';
import { loadThirdShortProductionScenes } from './lumi-third-short-media-v1.js';

export const V2 = Object.freeze({episode:'ep_lumi_flores_003', pilot:'lumi_tres_flores_colores_v1',
  bucket:'av2-generative-video-benchmarks',prefix:'lumi-series-v2/ep_lumi_flores_003/continuation-v2',
  sourceSha:'5dc31254ad26aa1b606735188ac30d2f4d486bc389f19bc8a50816e1e1b3da33',
  sourcePath:'lumi-series-v2/ep_lumi_flores_003/q31-PRO2/source/5dc31254ad26aa1b606735188ac30d2f4d486bc389f19bc8a50816e1e1b3da33.png',
  imageModel:'marketing-studio/image',videoModel:'kling-video/v3.0/pro/image-to-video',
  maxAdditionalUsd:3.24,sourceScenes:['s32','s33','s34','s35','s36'],shots:['q32','q33','q34','q35','q36'],durations:[4,4,4,5,5]});
export const STYLE = 'Exact supplied canonical Lumi identity and render: same face, eye shape/turquoise color, iris depth/catchlights, pink cheeks, two violet-tipped antennae, yellow hair tuft, rounded warm-yellow body and proportions, two translucent blue canonical wings, two arms/two legs, light-blue denim overalls, white/light-blue sneakers. PREMIUM FEATURE-FILM ULTRA-REALISTIC CINEMATIC 3D CGI. Physically based dimensional materials, natural SSS, eye reflections, fine denim weave/stitching, detailed translucent wings, rich detailed vegetation, cinematic daylight, soft GI/contact shadows, natural DOF; minimal cartoon drift. No flat cartoon, 2D, cel shading, anime, toy/plastic, cheap TV render, simplified materials/background, rubbery anatomy, extra wings/lobes/limbs, tail, abdomen growth, body/face/clothing mutation, humanization, text, captions, logo or watermark.';
export function imagePrompt(scene,shot) {
  const colors=scene.objects??[];
  const educational=colors.length===1?`Exactly ONE teaching flower: ${colors[0].toUpperCase()} petals, unequivocal ${colors[0]}, yellow center, green stem/leaves; fully visible at its approved scene position. No other flowers. Lumi remains full-body and makes one gentle teaching point toward it.`:
    'Exactly THREE distinct flowers, each fully visible and countable, arranged left-to-right RED, YELLOW, BLUE with unequivocal petal colors, green stems/leaves. No extra flowers. Lumi full-body above/slightly left of the flower row; plants and teaching objects never obscure her face or limbs.';
  const performance=shot==='q35'?'Question listening start state: Lumi warmly faces the viewer, hands neutral. No pointing, eye direction, glow, size advantage or lighting cue reveals the blue answer. All three flowers have equal prominence.':shot==='q36'?'Closing start state: Lumi warmly faces the viewer ready for one small farewell wave, all three flowers remain visible.':'';
  return `${STYLE}\n${educational} ${performance} Approved placement: ${scene.position}. Same canonical garden, grounded stationary flowers. Static open full-body frame; room above antennae/below shoes and caption-safe space clear of Lumi. Preserve lesson semantics. One premium 9:16 2K frame.`;
}
export function imageInput(scene,shot,anchorUrl){return {prompt:imagePrompt(scene,shot),image_urls:[anchorUrl],quality:'high',resolution:'2k',aspect_ratio:'9:16',moderation:'auto',enhance_prompt:false};}
export function videoPrompt(scene,shot,duration){
  const action=shot==='q35'?'Lumi faces the viewer with a curious listening expression. During the final 2.5 seconds maintain natural attentive listening with one blink and subtle breathing; no gesture or gaze identifies the answer.':shot==='q36'?'Exactly one small warm farewell hand wave toward the viewer, then natural settle.':'Exactly one gentle teaching point toward the '+(scene.objects?.[0]??'canonical')+' flower, then natural settle. Keep the flower fully visible.';
  return `${STYLE}\nExact source is first-frame authority. Single continuous ${duration}-second shot; natural real-time 1x motion. ${action} Subtle secondary blink, eye tracking, small head follow, tiny canonical wing response and natural body settling only. Feet grounded, static camera, stable full-body composition. No slow motion, dreamy floating, cartoon bounce, squash/stretch, overacting, orbit or aggressive zoom. Every educational flower keeps its exact count, shape, color, position, identity and visibility. No flower duplication, disappearance, fusion, morphing, hue drift or new objects. Preserve face, materials, illumination, environment and anatomy across the full clip. Audio OFF. No text overlays or visible pause labels.`;
}
export async function runLumiV2Preflight({env=process.env,logger=console,fetchImpl=fetch}={}){
  if(env.LUMI_RUNTIME_ENV!=='staging')throw new Error('v2_staging_only');
  const {createClient}=await import('@supabase/supabase-js');
  const db=createClient(env.SUPABASE_URL,env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false}}),storage=db.storage.from(V2.bucket);
  const sign=async path=>{const r=await storage.createSignedUrl(path,21600);if(r.error)throw new Error('v2_source_sign_failed');return r.data.signedUrl;};
  const source=await storage.download(V2.sourcePath);if(source.error)throw new Error('v2_canonical_source_missing');
  const bytes=Buffer.from(await source.data.arrayBuffer());if(createHash('sha256').update(bytes).digest('hex')!==V2.sourceSha)throw new Error('v2_canonical_source_sha_mismatch');
  const golden=await db.from('lumi_pilot_runs').select('content_hash,result').eq('scene_id','q31-PRO2').eq('pilot_id',V2.pilot).eq('stage','VIDEO').single();
  if(golden.error||golden.data.result.human_review!=='HUMAN_APPROVED')throw new Error('v2_q31_human_approval_required');
  const {data:rows,error}=await db.from('lumi_pilot_runs').select('scene_id,storage_path,content_hash').eq('pilot_id',V2.pilot).eq('stage','IMAGE').in('scene_id',V2.sourceScenes);if(error||rows.length!==5)throw new Error('v2_five_existing_sources_required');
  const production=await loadThirdShortProductionScenes(db),anchorUrl=await sign(V2.sourcePath);
  const report={event:'lumi_series_v2_preflight',episode_id:V2.episode,provider_generation_calls:0,source_sha:V2.sourceSha,source_verification:'PASS',image_model:V2.imageModel,image_settings:{quality:'high',resolution:'2k',aspect_ratio:'9:16'},sources:[],image_quotes:[],video_quotes:[],max_additional_usd:V2.maxAdditionalUsd};
  const quote=async(model,input)=>{try{return await estimateHiggsfieldUsd({apiKey:env.HF_API_KEY,model,input,fetchImpl});}catch(error){return {model,error:error.message,diagnostics:error.quote_diagnostics??null};}};
  for(let i=0;i<5;i++){
    const scene=production.scenes.find(x=>x.id===V2.sourceScenes[i]),row=rows.find(x=>x.scene_id===scene.id);
    report.sources.push({...row,shot_id:V2.shots[i],canonical_pack_shot:i<3?V2.shots[i]:i===3?'q37':'q39',review_url:await sign(row.storage_path),scene});
    report.image_quotes.push({shot:V2.shots[i],...await quote(V2.imageModel,imageInput(scene,V2.shots[i],anchorUrl))});
    report.video_quotes.push({shot:V2.shots[i],duration:V2.durations[i],...await quote(V2.videoModel,{duration:V2.durations[i],sound:'off',multi_shots:false,cfg_scale:0.5,prompt:videoPrompt(scene,V2.shots[i],V2.durations[i]),image_url:anchorUrl})});
  }
  report.source_upgrade_cost_all_five_usd=report.image_quotes.every(x=>x.estimated_cost_usd!==undefined)?sumUsd(report.image_quotes.map(x=>x.estimated_cost_usd)):null;report.kling_pro_cost_usd=report.video_quotes.every(x=>x.estimated_cost_usd!==undefined)?sumUsd(report.video_quotes.map(x=>x.estimated_cost_usd)):null;report.projected_new_spend_all_five_usd=[report.source_upgrade_cost_all_five_usd,report.kling_pro_cost_usd].every(x=>x!==null)?sumUsd([report.source_upgrade_cost_all_five_usd,report.kling_pro_cost_usd]):null;
  const saved=await storage.upload(`${V2.prefix}/preflight.json`,Buffer.from(JSON.stringify(report)),{contentType:'application/json',upsert:true});if(saved.error)throw new Error('v2_preflight_persist_failed');
  logger.info(JSON.stringify(report));return report;
}
