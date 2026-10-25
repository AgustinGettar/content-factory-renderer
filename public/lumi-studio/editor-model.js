// Shared browser/export semantics. Integer 48 kHz ticks; video grid = 1600 ticks.
export const RATE=48000, FRAME=1600, EDIT='LUMI_NATURAL_TIMELINE_V2_EDIT_1';
export const clone=v=>JSON.parse(JSON.stringify(v));
const fail=c=>{throw Error('EDITOR_'+c);};
const integer=(v,min,max)=>Number.isSafeInteger(v)&&v>=min&&v<=max;
export const duration=c=>c.track==='video'?Math.ceil((c.source_out-c.source_in)/FRAME)*FRAME:c.source_out-c.source_in;
export const end=c=>c.timeline_start+duration(c);
export const length=m=>Math.max(0,...m.clips.filter(c=>c.track==='video').map(end));
export const seconds=t=>t/RATE;
export const ticks=s=>Math.round(Number(s)*RATE);
export function normalize(m,old=m){
 const before=new Map(old.clips.filter(c=>c.track==='video').map(c=>[c.id,c.timeline_start]));let cursor=0;
 for(const c of m.clips.filter(c=>c.track==='video')){c.timeline_start=cursor;cursor+=duration(c);}
 for(const c of m.clips.filter(c=>c.track!=='video'&&c.linked_to)){
  const video=m.clips.find(v=>v.id===c.linked_to&&v.track==='video');
  if(video&&before.has(video.id))c.timeline_start+=video.timeline_start-before.get(video.id);
  if(!video)c.linked_to=null;
 }
 return m;
}
export function validateEdit(m,sources,{render=false}={}){
 if(!m||m.version!==EDIT||m.tick_rate!==RATE||m.fps!==30||m.ripple!=='VIDEO_CLOSE_GAPS_LINKED_AUDIO'||!Array.isArray(m.clips)||m.clips.length>120||!Array.isArray(m.markers)||m.markers.length>100)fail('MANIFEST_INVALID');
 if(Object.keys(m).some(k=>!['version','tick_rate','fps','ripple','clips','tracks','markers'].includes(k)))fail('MANIFEST_FIELDS');
 if(Object.keys(m.tracks||{}).sort().join()!=='music,sfx,video,voice')fail('TRACKS_INVALID');
 const warnings=[],ids=new Set();let cursor=0;
 for(const t of Object.values(m.tracks))if(!integer(t.gain_mdb,-60000,12000)||typeof t.mute!=='boolean'||Object.keys(t).sort().join()!=='gain_mdb,mute')fail('GAIN_INVALID');
 for(const c of m.clips){
  if(Object.keys(c).some(k=>!['id','source_id','source_sha','source_in','source_out','timeline_start','track','gain_mdb','mute','fade_in','fade_out','linked_to','cut_reason','speech_reviewed','closure_ticks','pause_ticks'].includes(k)))fail('CLIP_FIELDS');
  if(!/^[a-zA-Z0-9_-]{1,80}$/.test(c.id)||ids.has(c.id))fail('INSTANCE_ID');ids.add(c.id);
  const s=sources[c.source_id];if(!s||s.sha256!==c.source_sha)fail('SOURCE_IDENTITY');if(render&&s.type==='mixed_master')fail('ORIGINAL_CLIPS_REQUIRED');
  if(!Object.hasOwn(m.tracks,c.track)||c.track==='video'&&!s.video||c.track!=='video'&&!s.audio)fail('STREAM_MISSING');
  const limit=c.track==='video'?s.video_ticks:s.audio_ticks;
  if(!integer(c.source_in,0,limit)||!integer(c.source_out,c.source_in+1,limit)||!integer(c.timeline_start,0,RATE*180)||!integer(c.gain_mdb,-60000,12000)||typeof c.mute!=='boolean'||!integer(c.fade_in,0,duration(c))||!integer(c.fade_out,0,duration(c))||c.fade_in+c.fade_out>duration(c))fail('SOURCE_BOUNDS');
  if(typeof c.cut_reason!=='string'||c.cut_reason.length>300||typeof c.speech_reviewed!=='boolean'||!integer(c.closure_ticks,0,RATE*15)||!integer(c.pause_ticks,0,RATE*15))fail('REVIEW_INVALID');
  if(c.track==='video'){
   if(c.timeline_start!==cursor)fail('VIDEO_GAP_OR_OVERLAP');cursor=end(c);
   if(duration(c)<FRAME)fail('VIDEO_TOO_SHORT');
  }
  if(c.source_in>0||c.source_out<limit){warnings.push({code:'DELIBERATE_CUT',id:c.id});if(render&&!c.cut_reason.trim())fail('CUT_REASON_REQUIRED');
   if(render&&c.track==='voice'&&!c.speech_reviewed)fail('SPEECH_BOUNDARY_REVIEW_REQUIRED');}
  if(c.linked_to!==null&&(!m.clips.some(v=>v.id===c.linked_to&&v.track==='video')||c.track==='video'))fail('LINK_INVALID');
 }
 if(cursor>RATE*180)fail('DURATION_LIMIT');
 for(const c of m.clips.filter(c=>c.track!=='video')){
  const v=m.clips.find(v=>v.id===c.linked_to);
  if(end(c)+Math.max(c.closure_ticks,c.pause_ticks)>(v?end(v):cursor))warnings.push({code:'VOICE_TAIL_OR_PAUSE_OUTSIDE_VIDEO',id:c.id});
  if(render&&(end(c)+Math.max(c.closure_ticks,c.pause_ticks)>(v?end(v):cursor)||v&&c.timeline_start<v.timeline_start))fail('AUDIO_VIDEO_TIMING_CONFLICT');
 }
 for(const r of m.markers)if(!/^[a-zA-Z0-9_-]{1,80}$/.test(r.id)||!integer(r.at,0,RATE*180)||!['cut','sync','content','continuity'].includes(r.kind)||typeof r.text!=='string'||r.text.length>500||typeof r.resolved!=='boolean'||Object.keys(r).sort().join()!=='at,id,kind,resolved,text')fail('MARKER_INVALID');
 if(render&&!cursor)fail('VIDEO_REQUIRED');return {duration_ticks:cursor,warnings};
}
export function command(m,action){
 const n=clone(m),c=n.clips.find(c=>c.id===action.id);if(!c&&action.type!=='marker')fail('INSTANCE_MISSING');
 switch(action.type){
 case 'patch':Object.assign(c,action.value);break;
 case 'remove':n.clips=n.clips.filter(x=>x.id!==c.id);break;
 case 'order':{if(c.track!=='video')fail('ORDER_VIDEO_ONLY');const videos=n.clips.filter(x=>x.track==='video'),i=videos.indexOf(c),j=Math.max(0,Math.min(videos.length-1,action.index));videos.splice(i,1);videos.splice(j,0,c);n.clips=[...videos,...n.clips.filter(x=>x.track!=='video')];break;}
 case 'split':{const offset=action.at-c.timeline_start,cut=c.source_in+(c.track==='video'?Math.round(offset/FRAME)*FRAME:offset);
  if(cut<=c.source_in||cut>=c.source_out)fail('SPLIT_OUTSIDE');const other={...clone(c),id:action.new_id,source_in:cut,timeline_start:c.timeline_start+cut-c.source_in};c.source_out=cut;c.fade_out=0;other.fade_in=0;c.fade_in=Math.min(c.fade_in,duration(c));other.fade_out=Math.min(other.fade_out,duration(other));n.clips.splice(n.clips.indexOf(c)+1,0,other);break;}
 case 'marker':n.markers.push(action.marker);break;
 default:fail('COMMAND_UNKNOWN');
 }
 return normalize(n,m);
}
export function gainAt(m,c,t){
 if(c.mute||m.tracks[c.track].mute)return 0;const local=t-c.timeline_start,d=duration(c);if(local<0||local>=d)return 0;
 const fade=Math.min(c.fade_in?local/c.fade_in:1,c.fade_out?(d-local)/c.fade_out:1,1);
 return Math.pow(10,(c.gain_mdb+m.tracks[c.track].gain_mdb)/20000)*Math.max(0,fade);
}
export function emptyEdit(){return {version:EDIT,tick_rate:RATE,fps:30,ripple:'VIDEO_CLOSE_GAPS_LINKED_AUDIO',clips:[],tracks:Object.fromEntries(['video','voice','music','sfx'].map(t=>[t,{gain_mdb:0,mute:false}])),markers:[]};}
export function instance(source,track,start,id,linked=null){return {id,source_id:source.id,source_sha:source.sha256,source_in:0,source_out:track==='video'?source.video_ticks:source.audio_ticks,timeline_start:start,track,gain_mdb:0,mute:false,fade_in:0,fade_out:0,linked_to:linked,cut_reason:'',speech_reviewed:false,closure_ticks:0,pause_ticks:0};}
