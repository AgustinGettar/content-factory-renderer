import { createHash } from 'node:crypto';
import { sumUsd, remainingUsdGate } from './higgsfield-usd-budget-v1.js';

export const SHOT_PACK_VERSION = 'lumi-third-shot-pack/1';
export const SHOT_PACK_EPISODE = 'ep_lumi_flores_003';
export const APPROVED_SHOT_DURATIONS = Object.freeze([4,4,4,4,5,5]);
export const VISUAL_TARGET_USD = 2.45;
export const VISUAL_CEILING_USD = 2.55;
export const MASTER_LOCK = Object.freeze({ width:1080, height:1920, fps:30, codec:'h264', profile:'High', crf:17, preset:'slow', pixel_format:'yuv420p', audio_codec:'aac', audio_sample_rate:48000, audio_bitrate_kbps:192, final_encodes:1 });
const shotSpecs = [
  ['q31','s31','greeting','A natural curious greeting: one small gaze shift, a gentle blink, relaxed breathing. No walking out of frame.'],
  ['q32','s32','red','Lumi gives one gentle teaching point toward the red flower, then settles naturally. Keep the flower fully visible.'],
  ['q33','s33','yellow','Lumi gives one gentle teaching point toward the yellow flower, then settles naturally. Keep the flower fully visible.'],
  ['q34','s34','blue','Lumi gives one gentle teaching point toward the blue flower, then settles naturally. Keep the flower fully visible.'],
  ['q37','s35','question','Lumi looks warmly toward the viewer with a curious listening expression. During the final 2.5 seconds she waits naturally with one blink and subtle breathing. No pointing, gaze, glow or cue identifies the answer.'],
  ['q39','s36','closing','Lumi gives one small warm farewell wave toward the viewer, smiles, then settles. Keep all three flowers visible and unchanged.'],
];
const segments = {
  s31:[['q31',0,4]], s32:[['q32',0,4]], s33:[['q33',0,4]], s34:[['q34',0,4]],
  s35:[['q32',1,1.2],['q33',1,1.2],['q34',1,1.2],['q37',2.5,1.4]],
  s36:[['q32',2,2],['q33',2,2],['q34',2,2]],
  s37:[['q37',0,5]], s38:[['q34',0.5,3.5],['q37',2.5,2.5]], s39:[['q37',4,1],['q39',0,5]],
};
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function buildThirdShotPack(plan, { sources = [], quotes = [], confirmedSpendUsd = 0.591597 } = {}) {
  if(plan?.episode?.id !== SHOT_PACK_EPISODE) throw new Error('shot_pack_episode_mismatch');
  const sourceMap = new Map(sources.map(source => [source.scene_id,source]));
  const shots = shotSpecs.map(([id,source_scene,performance,motion], index) => {
    const source=sourceMap.get(source_scene);
    const duration = APPROVED_SHOT_DURATIONS[index];
    const price=quotes.find(q => q.scene===source_scene && q.model==='kling-video/v3.0/std/image-to-video' && q.duration_seconds===duration);
    return { id,source_scene,performance,motion,duration_seconds:duration,
      model:'kling-video/v3.0/std/image-to-video',input:{duration,sound:'off',multi_shots:false,cfg_scale:0.5},
      source_sha256:source?.content_hash??null, source_qa:source?.result?.visual_qa?.classification??'PENDING',
      estimated_cost_usd:price?.estimated_cost_usd??null, quote_basis:'PERSISTED_API_CONFIGURATION_QUOTE_REQUOTE_BEFORE_EMISSION',
      natural_speed:1, camera:'static', generated_character_motion:true, max_calls:1, retry:false, variant:false };
  });
  const beats=plan.scenes.map(scene => ({id:scene.id,beat_ref:scene.beat_ref,educational_goal:scene.educational_goal,
    narration:(scene.audio?.utterances||[]).map(u=>u.text).join(' '), narration_ids:(scene.audio?.utterances||[]).map(u=>u.id),
    segments:(segments[scene.id]||[]).map(([shot_id,start_seconds,duration_seconds])=>({shot_id,start_seconds,duration_seconds,speed:1})),
    pause_seconds:(scene.audio?.pauses||[]).reduce((n,p)=>n+(p.purpose==='child_response'?p.duration_seconds:0),0),
    breath_seconds:(scene.audio?.pauses||[]).reduce((n,p)=>n+(p.purpose==='breath'?p.duration_seconds:0),0),
    local_only:['s35','s36','s38'].includes(scene.id), text_overlay:[], technical_pause_label:false }));
  const incremental=shots.every(s=>s.estimated_cost_usd!==null)?sumUsd(shots.map(s=>s.estimated_cost_usd)):null;
  for(const shot of shots) shot.covered_beats=beats.filter(b=>b.segments.some(s=>s.shot_id===shot.id)).map(b=>b.id);
  const pack={version:SHOT_PACK_VERSION,episode_id:SHOT_PACK_EPISODE,source_plan_sha256:hash(plan),shots,beats,
    image_calls:0,video_calls:shots.length,generated_video_seconds:shots.reduce((s,x)=>s+x.duration_seconds,0),
    unique_images:new Set(shots.map(s=>s.source_scene)).size,local_only_beats:beats.filter(b=>b.local_only).map(b=>b.id),
    timeline_seconds:beats.reduce((s,b)=>s+b.segments.reduce((n,x)=>n+x.duration_seconds,0),0),
    currency:'USD',confirmed_visual_spend_usd:confirmedSpendUsd,incremental_visual_cost_usd:incremental,
    projected_visual_cost_usd:incremental===null?null:sumUsd([confirmedSpendUsd,incremental]),visual_target_usd:VISUAL_TARGET_USD,visual_ceiling_usd:VISUAL_CEILING_USD,episode_ceiling_usd:3.05,
    safety_reserve_usd:1,reported_balance_usd:9,provider_balance_verified:false,
    master:{...MASTER_LOCK},text_policy:{text_character_overlap:0,overlays_enabled:false,pause_labels_enabled:false},
    execution_policy:{same_episode:true,recovery_manager:true,immediate_request_id_persistence:true,retries:0,variants:0,
      allowed_provider:'higgsfield_api',allowed_video_model:'kling-video/v3.0/std/image-to-video',grok_allowed:false,
      image_s37_needed:false,original_attempts_immutable:true,full_tts_requires_voice_approval:true},
    narration_policy:{original_words_unchanged:true,each_utterance_once:true,audio_speed:1,question_max_speech_seconds:2.5,
      measured_audio_timing_required_before_master:true,recap_word_alignment_required:true},
  };
  pack.pack_sha256=hash(pack);
  return pack;
}

export function validateThirdShotPack(pack, plan, { requireSourceQa = false } = {}) {
  const errors=[];
  const check=(value,code)=>{if(!value)errors.push(code);};
  check(pack.episode_id===SHOT_PACK_EPISODE,'SAME_EPISODE_REQUIRED');
  const expected=plan.scenes.map(s=>s.id);
  check(JSON.stringify(pack.beats.map(b=>b.id))===JSON.stringify(expected),'NINE_BEATS_ORDER_AND_COVERAGE');
  check(pack.beats.length===9 && new Set(pack.beats.map(b=>b.id)).size===9,'NO_MISSING_OR_DUPLICATE_BEAT');
  const allIds=pack.beats.flatMap(b=>b.narration_ids);
  const originalIds=plan.scenes.flatMap(s=>s.audio.utterances.map(u=>u.id));
  check(allIds.length===new Set(allIds).size && JSON.stringify(allIds)===JSON.stringify(originalIds),'NO_DUPLICATED_NARRATION');
  check(pack.beats.every(b=>b.narration===plan.scenes.find(s=>s.id===b.id)?.audio.utterances.map(u=>u.text).join(' ')),'NARRATION_UNCHANGED');
  check(pack.shots.length===6 && pack.video_calls===6 && pack.unique_images===6,'EXACT_SIX_SHOTS_AND_SOURCES');
  check(pack.image_calls===0,'NO_NEW_IMAGES');
  check(pack.generated_video_seconds===26 && pack.generated_video_seconds===pack.shots.reduce((s,x)=>s+x.duration_seconds,0),'EXACT_TWENTY_SIX_GENERATED_SECONDS');
  check(JSON.stringify(pack.shots.map(s=>s.duration_seconds))===JSON.stringify(APPROVED_SHOT_DURATIONS),'APPROVED_SHOT_DURATIONS_REQUIRED');
  check(new Set(pack.shots.map(s=>s.id)).size===pack.shots.length,'UNIQUE_SHOT_IDS');
  check(pack.shots.every(s=>s.model==='kling-video/v3.0/std/image-to-video' && s.duration_seconds===s.input.duration && s.input.sound==='off' && s.input.multi_shots===false),'APPROVED_KLING_ONLY');
  check(pack.shots.every(s=>s.generated_character_motion===true && s.natural_speed===1),'NATURAL_CHARACTER_PERFORMANCE');
  check(pack.shots.some(s=>s.performance==='question')&&pack.shots.some(s=>s.performance==='closing'),'QUESTION_AND_CLOSING_PERFORMANCES');
  for(const beat of pack.beats){
    check(beat.segments.length>0,`EMPTY_BEAT:${beat.id}`);
    for(const segment of beat.segments){
      const shot=pack.shots.find(s=>s.id===segment.shot_id);
      check(shot && segment.start_seconds>=0 && segment.duration_seconds>0 && segment.start_seconds+segment.duration_seconds<=shot.duration_seconds+1e-9,`SEGMENT_RANGE:${beat.id}`);
      check(segment.speed===1,`NO_SLOW_MOTION_OR_STATIC_PAN:${beat.id}`);
    }
    check(!beat.text_overlay?.length&&!beat.technical_pause_label,`TEXT_EXCLUSION:${beat.id}`);
  }
  for(const color of ['red','yellow','blue'])check(pack.shots.some(s=>s.performance===color),`COLOR:${color}`);
  check(pack.beats.find(b=>b.id==='s37')?.pause_seconds===2.5 && pack.beats.filter(b=>b.pause_seconds>0).length===1,'QUESTION_REAL_PAUSE');
  check(Object.keys(pack.master||{}).length===Object.keys(MASTER_LOCK).length && Object.entries(MASTER_LOCK).every(([key,value])=>pack.master?.[key]===value),'FULL_HD_MASTER_LOCK');
  let computedCost=null;
  try {computedCost=sumUsd(pack.shots.map(s=>s.estimated_cost_usd));}catch{}
  check(computedCost!==null && computedCost===pack.incremental_visual_cost_usd && sumUsd([pack.confirmed_visual_spend_usd,computedCost])===pack.projected_visual_cost_usd,'COST_TOTALS_RECOMPUTED');
  check(pack.visual_ceiling_usd===VISUAL_CEILING_USD && pack.visual_target_usd===VISUAL_TARGET_USD && pack.episode_ceiling_usd===3.05,'AUTHORIZED_CEILINGS_UNCHANGED');
  check(pack.projected_visual_cost_usd!==null && pack.projected_visual_cost_usd<=VISUAL_CEILING_USD,'VISUAL_BUDGET_CEILING');
  check(pack.incremental_visual_cost_usd!==null && sumUsd([pack.incremental_visual_cost_usd,pack.safety_reserve_usd])<=pack.reported_balance_usd,'BALANCE_PLUS_RESERVE');
  const computedDuration=pack.beats.reduce((s,b)=>s+b.segments.reduce((n,x)=>n+x.duration_seconds,0),0);
  check(Math.abs(computedDuration-pack.timeline_seconds)<1e-9 && pack.timeline_seconds>=40&&pack.timeline_seconds<=46,'NATURAL_EPISODE_DURATION');
  check(pack.beats.find(b=>b.id==='s35')?.segments.some(s=>pack.shots.find(q=>q.id===s.shot_id)?.source_scene==='s35'),'RECAP_THREE_FLOWERS_TOGETHER');
  check(pack.shots.every(s=>JSON.stringify(s.covered_beats)===JSON.stringify(pack.beats.filter(b=>b.segments.some(x=>x.shot_id===s.id)).map(b=>b.id))),'SHOT_BEAT_MAPPING');
  check(pack.beats.find(b=>b.id==='s39')?.breath_seconds===1,'CLOSING_BREATH_PRESERVED');
  check(pack.shots.every(s=>s.source_sha256 && /^[a-f0-9]{64}$/.test(s.source_sha256)),'SOURCE_IDENTITIES_REQUIRED');
  if(requireSourceQa)check(pack.shots.every(s=>['PASS','PASS_WITH_WARNING'].includes(s.source_qa)),'SOURCE_VISUAL_QA_REQUIRED');
  return {status:errors.length?'FAIL':'PASS',errors,provider_generation_calls:0,
    design_only:!requireSourceQa, temporal_qa:'REQUIRED_AFTER_GENERATION',measured_voice_alignment:'REQUIRED_BEFORE_MASTER'};
}

// Exact voice durations are checked again before assembly; no audio speedup or silent truncation.
export function validateShotPackAudio(pack, measuredDurations) {
  const errors=[];
  for(const beat of pack.beats){
    const duration=measuredDurations[beat.id];
    const available=beat.segments.reduce((s,x)=>s+x.duration_seconds,0);
    if(!Number.isFinite(duration)||duration<=0||duration+beat.pause_seconds+(beat.breath_seconds||0)>available)errors.push(`NARRATION_DOES_NOT_FIT:${beat.id}`);
  }
  return {status:errors.length?'FAIL':'PASS',errors};
}

// Visual execution is independent of TTS. Full audio still requires approval and a separate USD gate.
export function shotPackResumeGate(pack, plan, {benchmarkUsd=null,fullTtsUsd=null,freshQuotes=false,episodeCeilingUsd=3.05}={}) {
  const validation=validateThirdShotPack(pack,plan,{requireSourceQa:true});
  const remaining=pack.incremental_visual_cost_usd;
  const balance=remainingUsdGate({remainingCostUsd:remaining,reportedBalanceUsd:pack.reported_balance_usd,reserveUsd:pack.safety_reserve_usd});
  const reasons=[...validation.errors];
  if(!freshQuotes)reasons.push('FRESH_USD_PREFLIGHT_REQUIRED');
  if(remaining!==null && sumUsd([pack.confirmed_visual_spend_usd,remaining])>episodeCeilingUsd)reasons.push('EPISODE_USD_CEILING');
  if(balance.status!=='PASS')reasons.push(balance.status);
  return {status:reasons.length?'BLOCKED':'PASS',reasons,balance,episode_ceiling_usd:episodeCeilingUsd,
    current_confirmed_spend_usd:pack.confirmed_visual_spend_usd,next_request_estimated_usd:pack.shots[0]?.estimated_cost_usd??null,
    resume_allowed:reasons.length===0,resolve_s37_allowed:reasons.length===0&&!pack.execution_policy.image_s37_needed,
    tts_status:'VOICE_REVIEW_REQUIRED',remaining_episode_budget_usd:remaining===null?null:Number((episodeCeilingUsd-pack.projected_visual_cost_usd).toFixed(9)),provider_calls:0};
}
