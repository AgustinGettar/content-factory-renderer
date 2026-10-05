export const ACTING_VERSION='LUMI_ACTING_PRESET_LIBRARY_V1';
const common={version:ACTING_VERSION,status:'OFFLINE_DIRECTION_POLICY_REQUIRES_SHOT_REVIEW',
  maximum_body_yaw:'NO_ADDED_YAW_PRESERVE_SOURCE',maximum_torso_rotation:'NO_ADDED_ROTATION',
  numeric_angle_measurements:null,head_movement:'SMALL_SOURCE_SUPPORTED_NO_REAR_REVEAL',
  wing_amplitude:'MINIMAL_REVIEWED_RESPONSE_ONLY',camera_behavior:'STATIC_OR_SEPARATELY_APPROVED_SUPPORTED_PATH',
  forbidden_movements:['TORSO_TURN','ORBIT_REVEAL','BACK_FACING','LARGE_WING_FLUTTER','SQUASH_STRETCH','SECOND_EDUCATIONAL_ACTION'],
  end_state_contract:'Natural settle; same body orientation, object inventory, screen direction and unobstructed teaching objects.',
  required_evidence:['source pose','target visibility','active hand availability and character/screen laterality if used','safe wing silhouette','caption space'],
  timing:'NATURAL_1X; no numeric turn angles inferred from prose or frames'};
const define=(primary,eyes,hand,secondary,end)=>Object.freeze({...common,primary_action:primary,eye_behavior:eyes,
  hand_arm_amplitude:hand,allowed_secondary_motion:secondary,...(end?{end_state_contract:end}:{})});
export const ACTING_PRESETS=Object.freeze({
  GREETING:define('One restrained greeting toward viewer; prepare, small forearm gesture, settle.','Warm eye contact; subtle glance and blink.','SMALL_FOREARM_WRIST',['blink','small_head_response','minimal_reviewed_wing_response']),
  PRESENT_OBJECT:define('One small presentation gesture beside the educational object; keep its color and shape legible.','Look briefly at target then settle toward viewer.','SMALL_FOREARM_WRIST',['blink','warm_expression']),
  POINT:define('Point beside one reviewed target without covering it; settle.','One target-directed gaze.','SMALL_FOREARM_WRIST',['blink']),
  LOOK_AT_OBJECT:define('Bring gaze to one reviewed object and settle without moving torso.','Target fixation; natural blink.','PRESERVE_INITIAL',['small_head_response','blink']),
  LOOK_AT_VIEWER:define('Bring gaze to viewer and settle warmly.','Warm contact; natural blink.','PRESERVE_INITIAL',['small_head_response','blink']),
  ASK_QUESTION:define('Address the viewer with a curious expression, opening a response opportunity.','Viewer contact; no answer-directed gaze.','PRESERVE_NEUTRAL',['blink','subtle_breathing']),
  WAIT_LISTEN:define('Maintain attentive listening throughout the approved response window.','Viewer contact; no cue to answer.','PRESERVE_NEUTRAL',['blink','subtle_breathing'],'Attentive live hold; preserve approved response duration, objects, torso and neutral hands.'),
  CELEBRATE:define('One small encouraging forearm lift and warm smile; settle.','Viewer contact.','SMALL_FOREARM_WRIST',['blink','warm_expression']),
  GENTLE_WAVE:define('One small wrist/forearm wave toward viewer; settle.','Warm viewer contact.','SMALL_FOREARM_WRIST',['blink','small_head_response']),
});
export const GRAMMAR_PRESET=Object.freeze({PRESENT_FLOWER:'PRESENT_OBJECT',ATTENTIVE_WAIT:'WAIT_LISTEN',GAZE_VIEWER:'LOOK_AT_VIEWER',FAREWELL:'GENTLE_WAVE'});
export function assessActing(presetId,motion){
  const preset=ACTING_PRESETS[presetId];if(!preset)throw new Error('UNKNOWN_ACTING_PRESET');
  const blockers=[],pending=[];
  for(const field of ['body_yaw','torso_rotation']){
    if(motion?.[field]==='ADDED_ROTATION')blockers.push(field+':SOURCE_ACTION_MISMATCH');
    else if(motion?.[field]!=='PRESERVE_INITIAL')pending.push(field+':UNKNOWN');
  }
  if(motion?.wing_motion==='LARGE')blockers.push('WING_AMPLITUDE_EXCEEDED');
  else if(!['MINIMAL_REVIEWED','STABLE'].includes(motion?.wing_motion))pending.push('WING_AMPLITUDE_UNKNOWN');
  if(motion?.camera==='ORBIT_REVEAL')blockers.push('UNDOCUMENTED_REAR_REVEAL');
  else if(motion?.camera!=='STATIC'&&motion?.camera_approval!==true)pending.push('CAMERA_APPROVAL_REQUIRED');
  return {preset_id:presetId,preset,status:blockers.length?'SOURCE_ACTION_MISMATCH':pending.length?'REVIEW_REQUIRED':'COMPATIBLE',blockers,pending,
    mitigation:'Preserve source torso orientation; localize acting to reviewed gaze, expression, forearm/wrist. A fixed camera does not fix the torso.',
    prediction:'Risk reduction proposal, not a guarantee of provider motion.'};
}
