import {inputDigest} from './lumi-v2-activation-context.js';

// Opt-in for newly prepared plans. Frozen plans keep their original contract.
export const EDITORIAL_VERSION='LUMI_NATURAL_TIMELINE_V2';
export const EDITORIAL_POLICY=Object.freeze({version:EDITORIAL_VERSION,natural_speed:1,
  default_action_seconds:5,pedagogical_pause_seconds:2.5,transition:'CUT',
  fit:'CONTAIN',fps:30,final_encodes:1,automatic_source_extension:false});

// Planning range, deliberately not a measured voice duration or a quote.
export function estimateNarration(text,{entry=0,closure=0,pause=0}={}){
  const words=String(text||'').trim().split(/\s+/u).filter(Boolean).length;
  if([entry,closure,pause].some(n=>!Number.isFinite(n)||n<0))throw Error('EDITORIAL_MARGIN_INVALID');
  const low=words/2.8,high=words/1.8;
  return {method:'SPANISH_WORD_RANGE_V1',words,minimum_seconds:low,maximum_seconds:high,
    required_visual_seconds:high+entry+closure+pause,uncertain:true,measured:false};
}

export function buildEditorialTimeline(segments){
  let cursor=0;
  const decisions=segments.map(s=>{
    const source=Number(s.source_duration_seconds??s.video_artifact?.duration),voice=Number(s.voice_duration_seconds??s.audio_artifact?.duration);
    const start=s.source_in??0,end=s.source_out??source,offset=s.audio_start_seconds??0,pause=s.pause??0,closure=s.closure_margin_seconds??0;
    if(![source,voice,start,end,offset,pause,closure].every(Number.isFinite)||source<=0||voice<=0||start<0||end>source+1e-6||end<=start||offset<0||pause<0||closure<0)throw Error('EDITORIAL_TIMING_INVALID');
    if(s.action_complete===false)throw Error('EDITORIAL_ACTION_INCOMPLETE');
    if(s.transition&&s.transition!=='CUT'||(s.transition_overlap_seconds??0)!==0)throw Error('EDITORIAL_TRANSITION_REVIEW_REQUIRED');
    if((start>0||end<source-1e-6)&&(!s.cut_reason||s.action_complete!==true))throw Error('EDITORIAL_CUT_REVIEW_REQUIRED');
    // ffprobe's decimal seconds can round an exact frame boundary upward.
    // One 48 kHz sample of measurement tolerance must not add a whole frame.
    const retained=end-start,frames=Math.ceil((retained-1/48000)*30),duration=frames/30;
    // Use the measured stream, not padded output frames, to judge real room.
    if(offset+voice+Math.max(pause,closure)>retained+1/48000)throw Error('NATURAL_AUDIO_VIDEO_TIMING_REVIEW_REQUIRED');
    const item={policy_version:EDITORIAL_VERSION,shot_id:s.shot_id??null,
      source_sha:s.video_artifact?.sha256??s.source_sha,voice_sha:s.audio_artifact?.sha256??s.voice_sha,
      generated_seconds:source,source_in:start,source_out:end,retained_seconds:retained,
      timeline_in:cursor,timeline_out:cursor+duration,editorial_seconds:duration,frames,
      voice_seconds:voice,voice_offset:offset,pause_seconds:pause,
      effective_post_voice_seconds:retained-offset-voice,closure_margin_seconds:closure,
      transition:'CUT',overlap_seconds:0,speed:1,fit:'CONTAIN',
      action_resolution:s.action_complete===true?'HUMAN_CONFIRMED':'REQUIRES_FINAL_HUMAN_REVIEW',
      reason:s.cut_reason||'PRESERVE_COMPLETE_SOURCE_AT_NATURAL_SPEED'};
    if(!/^[a-f0-9]{64}$/.test(item.source_sha||'')||!/^[a-f0-9]{64}$/.test(item.voice_sha||''))throw Error('EDITORIAL_SOURCE_IDENTITY_REQUIRED');
    cursor+=duration;return item;
  });
  const value={version:EDITORIAL_VERSION,fps:30,duration_seconds:cursor,decisions};
  return {...value,sha256:inputDigest(value)};
}

export function naturalSegments(segments){
  const timeline=buildEditorialTimeline(segments);
  return segments.map((s,i)=>({...s,editorial_version:EDITORIAL_VERSION,duration:timeline.decisions[i].editorial_seconds,
    source_in:timeline.decisions[i].source_in,source_out:timeline.decisions[i].source_out,editorial_decision:timeline.decisions[i]}));
}
