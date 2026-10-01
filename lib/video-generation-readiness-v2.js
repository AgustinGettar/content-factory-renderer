export const VIDEO_GENERATION_READINESS_VERSION = "2.1.0";
export const HIGGSFIELD_PROMPT_COMPILER_VERSION = "2.1.0";
export const VIDEO_SOURCE_READINESS_VERSION = "1.0.0";
export const VIDEO_SOURCE_IMAGE_PROMPT_VERSION = "1.2.0";

export const SCENE_RISK = Object.freeze({
  LOW: "LOW",
  PEDAGOGICAL_LOCKED: "PEDAGOGICAL_LOCKED",
  HIGH_COMPLEXITY: "HIGH_COMPLEXITY",
});

export const END_FRAME_MODE = Object.freeze({
  NONE: "NONE",
  SAME_STATE_LOCK: "SAME_STATE_LOCK",
  EXPLICIT_END_FRAME: "EXPLICIT_END_FRAME",
});

export const COMPLEXITY_LIMITS = Object.freeze({
  MAX_PRIMARY_CHARACTER_ACTIONS: 1,
  MAX_CAMERA_MOVES: 1,
});

export const REQUIRED_CHARACTER_INVARIANTS = Object.freeze([
  "canonical_face",
  "canonical_silhouette",
  "exactly_two_arms",
  "exactly_two_legs",
  "exactly_two_wings",
  "exactly_two_antennae",
  "no_tail",
  "no_additional_abdomen",
  "no_extra_appendages",
  "no_clothing_mutation",
]);

export const REQUIRED_FORBIDDEN_TRANSFORMATIONS = Object.freeze([
  "no_object_duplication",
  "no_object_disappearance",
  "no_object_fusion",
  "no_object_morphing",
  "no_additional_shapes",
  "no_additional_limbs",
  "no_body_transformation",
  "no_geometry_change",
]);

const PRIMARY_ACTIONS = new Set([
  "point_once",
  "small_wand_trace_once",
  "present_once",
  "gaze_shift_once",
  "small_head_tilt_once",
  "wave_once",
]);

const SECONDARY_MOTIONS = new Set([
  "blink",
  "subtle_head_movement",
  "subtle_wings",
]);

const CAMERA_MOVES = new Set(["subtle_push_in"]);
const PEDAGOGICAL_DOMAINS = new Set(["counting", "shapes", "letters", "numbers", "object_identity"]);
const HIGH_COMPLEXITY_FLAGS = new Set(["multiple_distinct_examples", "occlusion_risk", "multi_object_identity_mapping"]);
const HIGH_COMPLEXITY_MITIGATIONS = Object.freeze([
  "static_camera",
  "objects_spatially_separated",
  "no_educational_object_motion",
  "single_character_action",
]);

const CHARACTER_PHRASES = Object.freeze({
  canonical_face: "canonical Lumi face and turquoise eyes",
  canonical_silhouette: "canonical rounded yellow silhouette",
  exactly_two_arms: "exactly two arms",
  exactly_two_legs: "exactly two legs",
  exactly_two_wings: "exactly two translucent light-blue wings",
  exactly_two_antennae: "exactly two violet-tipped antennae",
  no_tail: "no tail",
  no_additional_abdomen: "no additional abdomen",
  no_extra_appendages: "no extra appendages",
  no_clothing_mutation: "unchanged light-blue denim overalls and white/light-blue shoes",
});

const ACTION_PHRASES = Object.freeze({
  point_once: "Lumi makes one pointing gesture toward the educational object at normal conversational speed.",
  small_wand_trace_once: "Lumi makes one short wand trace beside the educational object at natural real-time speed without touching it.",
  present_once: "Lumi makes one presenting gesture at normal conversational speed.",
  gaze_shift_once: "Lumi makes one natural real-time gaze shift across the separated examples.",
  small_head_tilt_once: "Lumi makes one natural head tilt.",
  wave_once: "Lumi makes one natural wave at normal conversational speed.",
});

const SECONDARY_PHRASES = Object.freeze({
  blink: "one natural blink",
  subtle_head_movement: "subtle head movement",
  subtle_wings: "subtle wing flutter",
});

const FORBIDDEN_PHRASES = Object.freeze({
  no_object_duplication: "no object duplication",
  no_object_disappearance: "no object disappearance",
  no_object_fusion: "no object fusion",
  no_object_morphing: "no object morphing",
  no_additional_shapes: "no additional shapes",
  no_additional_limbs: "no additional limbs",
  no_body_transformation: "no body transformation",
  no_geometry_change: "no geometry change",
});

function unique(values) {
  return Array.isArray(values) && new Set(values).size === values.length;
}

function missing(required, actual) {
  const present = new Set(Array.isArray(actual) ? actual : []);
  return required.filter((value) => !present.has(value));
}

function validInventoryItem(item) {
  return Boolean(
    item && typeof item.id === "string" && item.id.length > 0
    && Number.isInteger(item.count) && item.count > 0
    && typeof item.position === "string" && item.position.length > 0,
  );
}

function validEducationalObject(item) {
  return validInventoryItem(item)
    && typeof item.geometry === "string"
    && item.geometry.length > 0
    && !item.geometry.includes("ambiguous")
    && item.fully_visible === true;
}

function add(errors, condition, code) {
  if (!condition) errors.push(code);
}

export function classifySceneRisk(contract) {
  const flags = Array.isArray(contract?.complexity_flags) ? contract.complexity_flags : [];
  if (flags.some((flag) => HIGH_COMPLEXITY_FLAGS.has(flag))) return SCENE_RISK.HIGH_COMPLEXITY;
  if (PEDAGOGICAL_DOMAINS.has(contract?.educational_domain)) return SCENE_RISK.PEDAGOGICAL_LOCKED;
  return SCENE_RISK.LOW;
}

export function validateVideoGenerationReadiness(contract) {
  const errors = [];
  const start = contract?.canonical_start_state;
  const educationalObjects = start?.educational_objects;
  const primary = contract?.allowed_motion?.primary_character_actions;
  const secondary = contract?.allowed_motion?.secondary_micro_motion;
  const cameraMoves = contract?.camera_contract?.moves;
  const riskClass = classifySceneRisk(contract);

  add(errors, contract?.version === VIDEO_GENERATION_READINESS_VERSION, "INVALID_READINESS_VERSION");
  add(errors, typeof contract?.scene_id === "string" && contract.scene_id.length > 0, "MISSING_SCENE_ID");
  add(errors, start?.lumi?.id === "lumi" && start?.lumi?.count === 1 && typeof start?.lumi?.position === "string", "INVALID_CANONICAL_LUMI_START_STATE");
  add(errors, Array.isArray(start?.props) && start.props.every(validInventoryItem), "INVALID_PROP_INVENTORY");
  add(errors, Array.isArray(educationalObjects) && educationalObjects.length > 0, "MISSING_EDUCATIONAL_OBJECT_INVENTORY");
  if (Array.isArray(educationalObjects)) {
    add(errors, educationalObjects.every(validEducationalObject), "MISSING_OR_AMBIGUOUS_OBJECT_COUNT_GEOMETRY_POSITION");
    add(errors, unique(educationalObjects.map((item) => item.id)), "DUPLICATE_EDUCATIONAL_OBJECT_ID");
    add(errors, educationalObjects.length <= Number(contract?.max_educational_focus_objects), "TOO_MANY_EDUCATIONAL_FOCUS_OBJECTS");
  }

  const invariants = contract?.educational_invariants;
  add(errors, Array.isArray(invariants) && invariants.length > 0, "MISSING_EDUCATIONAL_INVARIANT");
  if (Array.isArray(educationalObjects) && Array.isArray(invariants)) {
    const invariantIds = new Set(invariants.filter((item) => item?.rule).map((item) => item.object_id));
    add(errors, educationalObjects.every((item) => invariantIds.has(item.id)), "MISSING_OBJECT_EDUCATIONAL_INVARIANT");
  }

  add(errors, missing(REQUIRED_CHARACTER_INVARIANTS, contract?.character_invariants).length === 0, "MISSING_CHARACTER_ANATOMY_LOCK");
  add(errors, unique(contract?.character_invariants), "DUPLICATE_CHARACTER_INVARIANT");
  add(errors, Array.isArray(primary) && primary.every((action) => PRIMARY_ACTIONS.has(action)), "INVALID_PRIMARY_ACTION");
  add(errors, Array.isArray(primary) && primary.length <= COMPLEXITY_LIMITS.MAX_PRIMARY_CHARACTER_ACTIONS, "TOO_MANY_PRIMARY_CHARACTER_ACTIONS");
  add(errors, Array.isArray(secondary) && secondary.every((motion) => SECONDARY_MOTIONS.has(motion)) && unique(secondary), "INVALID_SECONDARY_MICRO_MOTION");
  add(errors, missing(REQUIRED_FORBIDDEN_TRANSFORMATIONS, contract?.forbidden_transformations).length === 0, "MISSING_FORBIDDEN_TRANSFORMATION");

  add(errors, contract?.camera_contract?.single_continuous_shot === true, "CAMERA_NOT_SINGLE_CONTINUOUS_SHOT");
  add(errors, contract?.camera_contract?.multi_shots === false, "MULTI_SHOT_NOT_FORBIDDEN");
  add(errors, Array.isArray(cameraMoves) && cameraMoves.length <= COMPLEXITY_LIMITS.MAX_CAMERA_MOVES, "TOO_MANY_CAMERA_MOVES");
  add(errors, Array.isArray(cameraMoves) && cameraMoves.every((move) => CAMERA_MOVES.has(move)), "INVALID_CAMERA_MOVE");

  if (riskClass === SCENE_RISK.PEDAGOGICAL_LOCKED) {
    const motionLoad = (primary?.length || 0) + (secondary?.length || 0) + (cameraMoves?.length || 0);
    add(errors, motionLoad <= 2, "PEDAGOGICAL_LOCKED_COMPLEX_MOTION");
  }
  if (riskClass === SCENE_RISK.HIGH_COMPLEXITY) {
    add(errors, missing(HIGH_COMPLEXITY_MITIGATIONS, contract?.risk_mitigation).length === 0, "HIGH_COMPLEXITY_WITHOUT_MITIGATION");
    add(errors, (cameraMoves?.length || 0) === 0, "HIGH_COMPLEXITY_CAMERA_MUST_BE_STATIC");
  }

  const endObjects = contract?.end_state_contract?.visible_intact_objects;
  add(errors, contract?.end_state_contract?.lumi_visible === true, "END_STATE_LUMI_NOT_REQUIRED_VISIBLE");
  add(errors, Array.isArray(endObjects), "MISSING_END_STATE_OBJECTS");
  if (Array.isArray(educationalObjects) && Array.isArray(endObjects)) {
    const endMap = new Map(endObjects.map((item) => [item.id, item]));
    add(errors, educationalObjects.every((item) => {
      const end = endMap.get(item.id);
      return end?.count === item.count && end?.geometry === item.geometry && end?.position === item.position;
    }), "END_STATE_DOES_NOT_PRESERVE_EDUCATIONAL_OBJECTS");
  }
  add(errors, Object.values(END_FRAME_MODE).includes(contract?.end_frame_mode), "INVALID_END_FRAME_MODE");
  add(errors, Number.isFinite(contract?.source_image_requirements?.minimum_confidence), "MISSING_SOURCE_CONFIDENCE_THRESHOLD");
  add(errors,
    contract?.pacing_contract?.mode === "NATURAL_REAL_TIME"
      && contract?.pacing_contract?.normal_conversational_gesture_speed === true
      && contract?.pacing_contract?.natural_blink_head_hand_timing === true
      && contract?.pacing_contract?.slow_motion === false
      && contract?.pacing_contract?.dreamy_slow_movement === false
      && contract?.pacing_contract?.prolonged_pose_holds === false
      && Number.isFinite(contract?.pacing_contract?.pedagogical_pause_seconds)
      && contract.pacing_contract.pedagogical_pause_seconds >= 0,
    "MISSING_OR_INVALID_NATURAL_PACING_CONTRACT");
  if (contract?.pacing_contract?.pedagogical_pause_seconds > 0) {
    add(errors, secondary?.includes("blink") && (cameraMoves?.length || 0) === 0, "PEDAGOGICAL_PAUSE_REQUIRES_LIVE_MICRO_MOTION_AND_STATIC_CAMERA");
  }

  return {
    status: errors.length === 0 ? "PASS" : "FAIL",
    version: VIDEO_GENERATION_READINESS_VERSION,
    risk_class: riskClass,
    errors,
  };
}

export function validateVideoSourceReadiness(source, contract) {
  const errors = [];
  const required = contract?.canonical_start_state?.educational_objects || [];
  const observed = source?.observed_educational_objects;
  const minimumConfidence = Number(contract?.source_image_requirements?.minimum_confidence);

  add(errors, source?.version === VIDEO_SOURCE_READINESS_VERSION, "INVALID_SOURCE_READINESS_VERSION");
  add(errors, source?.status === "PASS", "SOURCE_READINESS_NOT_PASS");
  add(errors, Number.isFinite(source?.confidence) && source.confidence >= minimumConfidence, "SOURCE_QA_CONFIDENCE_INSUFFICIENT");
  add(errors, source?.all_required_elements_present === true, "SOURCE_REQUIRED_ELEMENTS_MISSING");
  add(errors, source?.correct_object_counts === true, "SOURCE_OBJECT_COUNT_UNVERIFIED");
  add(errors, source?.clear_geometry === true, "SOURCE_GEOMETRY_AMBIGUOUS");
  add(errors, source?.no_ambiguous_overlaps === true, "SOURCE_OVERLAP_AMBIGUOUS");
  add(errors, source?.lumi_anatomy_clean === true, "SOURCE_LUMI_ANATOMY_UNCLEAN");
  add(errors, source?.pedagogical_objects_fully_visible === true, "SOURCE_PEDAGOGICAL_OBJECT_PARTIALLY_HIDDEN");
  add(errors, source?.sufficient_motion_spacing === true, "SOURCE_MOTION_SPACING_INSUFFICIENT");
  add(errors, source?.no_visual_ambiguity === true, "SOURCE_VISUAL_AMBIGUITY");
  add(errors, source?.extraneous_educational_objects === false, "SOURCE_HAS_EXTRANEOUS_EDUCATIONAL_OBJECTS");
  add(errors, Array.isArray(observed), "SOURCE_OBSERVED_OBJECTS_MISSING");

  if (Array.isArray(observed)) {
    const observedMap = new Map(observed.map((item) => [item.id, item]));
    add(errors, observed.length === required.length, "SOURCE_EDUCATIONAL_OBJECT_SET_MISMATCH");
    add(errors, required.every((item) => {
      const actual = observedMap.get(item.id);
      return actual?.count === item.count
        && actual?.geometry === item.geometry
        && actual?.position === item.position
        && actual?.fully_visible === true;
    }), "SOURCE_CANONICAL_START_STATE_MISMATCH");
  }

  return {
    status: errors.length === 0 ? "PASS" : "FAIL",
    version: VIDEO_SOURCE_READINESS_VERSION,
    errors,
  };
}

function formatInventory(items) {
  return items.map((item) => `${item.count} ${item.id}; geometry=${item.geometry}; position=${item.position}; fully visible`).join(" ");
}

export function compileVideoSourceImagePromptV1(contract) {
  const readiness = validateVideoGenerationReadiness(contract);
  if (readiness.status !== "PASS") {
    const error = new Error(`video_source_prompt_contract_failed:${readiness.errors.join(",")}`);
    error.code = "VIDEO_SOURCE_PROMPT_CONTRACT_FAILED";
    error.readiness = readiness;
    throw error;
  }
  const start = contract.canonical_start_state;
  const props = start.props.map((item) => `${item.count} ${item.id} at ${item.position}`).join("; ") || "no props";
  return {
    version: VIDEO_SOURCE_IMAGE_PROMPT_VERSION,
    scene_id: contract.scene_id,
    text: [
      "[STYLE]\nHigh-end original stylized 3D children's educational animation, clean premium CGI, cheerful cinematic twilight lighting, vibrant saturated preschool-safe palette, rounded proportions, smooth clay-like materials with soft subsurface scattering, expressive large cartoon eyes, shallow depth of field, polished modern animation look.",
      `[CANONICAL_START_STATE]\nExactly 1 canonical Lumi at ${start.lumi.position}. Props: ${props}. Educational objects: ${formatInventory(start.educational_objects)}`,
      `[EXCLUSIVE_OBJECT_SET]\nRender exactly and only the listed educational objects with the listed counts, identities, geometry, visibility, and positions. Zero other teaching shapes, zero substitute objects, and zero unused teaching pedestals.` ,
      `[EDUCATIONAL_INVARIANTS]\n${contract.educational_invariants.map((item) => `${item.object_id}=${item.rule}`).join("; ")}.`,
      "[CHARACTER_LOCK]\nCanonical Lumi face and silhouette; exactly two arms, two legs, two wings, and two antennae; no tail, no additional abdomen, no extra appendages, and unchanged clothing.",
      "[WORLD_STYLE_ONLY]\nUse the twilight lantern-garden style, lighting, palette, path, and ivy only. World continuity does not authorize any unlisted educational object, lantern, example, or pedestal.",
      "[COMPOSITION]\nNative portrait 1152x2048; learning-safe center; reserve flexible text-safe negative space outside Lumi and every educational object; every listed educational object fully visible without ambiguous overlap and with sufficient spacing for the allowed video motion.",
      "[SOURCE_KEYFRAME]\nOne clean canonical first frame, not an action sequence. No motion trails, no object transition, no appearance event, and no camera movement.",
      "[OUTPUT]\nNo captions, labels, letters, numbers, logos, watermarks, or signatures. Educational text is added deterministically in postproduction.",
    ].join("\n\n"),
  };
}

export function compileHiggsfieldPromptV2(contract) {
  const readiness = validateVideoGenerationReadiness(contract);
  if (readiness.status !== "PASS") {
    const error = new Error(`video_generation_readiness_failed:${readiness.errors.join(",")}`);
    error.code = "VIDEO_GENERATION_READINESS_FAILED";
    error.readiness = readiness;
    throw error;
  }

  const primary = contract.allowed_motion.primary_character_actions;
  const secondary = contract.allowed_motion.secondary_micro_motion;
  const cameraMoves = contract.camera_contract.moves;
  const objects = contract.canonical_start_state.educational_objects;
  const endObjects = contract.end_state_contract.visible_intact_objects;
  const pacing = contract.pacing_contract;
  const pacingText = pacing.pedagogical_pause_seconds > 0
    ? `Natural real-time motion with normal conversational gesture speed and natural blink, head, and hand timing. No slow motion and no dreamy slow movement. The only allowed hold is the explicit ${pacing.pedagogical_pause_seconds}-second pedagogical response window; keep it visually alive with the allowed blink.`
    : "Natural real-time motion with normal conversational gesture speed and natural blink, head, and hand timing. No slow motion, no dreamy slow movement, and no prolonged pose holds.";

  const blocks = [
    ["A_START_FRAME_AUTHORITY", "Use the supplied image as the canonical first frame. Preserve its composition unless the camera contract explicitly permits one move."],
    ["B_CHARACTER_LOCK", `Preserve Lumi exactly: ${contract.character_invariants.map((item) => CHARACTER_PHRASES[item]).join(", ")}.`],
    ["C_EDUCATIONAL_OBJECT_LOCK", `${formatInventory(objects)} Invariants: ${contract.educational_invariants.map((item) => `${item.object_id}=${item.rule}`).join("; ")}.`],
    ["D_ALLOWED_ACTION", primary.length === 0 ? "No primary character action. Lumi holds the canonical pose." : ACTION_PHRASES[primary[0]]],
    ["E_SECONDARY_MICRO_MOTION", `${secondary.length === 0 ? "No secondary motion." : `Only: ${secondary.map((item) => SECONDARY_PHRASES[item]).join(", ")}.`} ${pacingText}`],
    ["F_FORBIDDEN_CHANGES", contract.forbidden_transformations.map((item) => FORBIDDEN_PHRASES[item]).join(", ") + ". Do not invent any unlisted motion or object."],
    ["G_CAMERA", cameraMoves.length === 0 ? "Single continuous shot; multi_shots=false; static camera." : "Single continuous shot; multi_shots=false; one subtle push-in only."],
    ["H_END_STATE", `At the final frame Lumi remains visible and canonical. Preserve intact: ${formatInventory(endObjects)} End-frame mode=${contract.end_frame_mode}; no last image is supplied.`],
  ];

  return {
    version: HIGGSFIELD_PROMPT_COMPILER_VERSION,
    scene_id: contract.scene_id,
    risk_class: readiness.risk_class,
    blocks: blocks.map(([name, text]) => ({ name, text })),
    text: blocks.map(([name, text]) => `[${name}]\n${text}`).join("\n\n"),
  };
}

export function expectedValueGate({ contract, source_readiness: sourceReadiness }) {
  const readiness = validateVideoGenerationReadiness(contract);
  const source = validateVideoSourceReadiness(sourceReadiness, contract);
  const errors = [...readiness.errors, ...source.errors];
  return {
    status: errors.length === 0 ? "PASS" : "FAIL",
    provider_call_allowed: errors.length === 0,
    failure_cost_usd: 0,
    readiness,
    source_readiness: source,
    errors,
  };
}

export function prepareHiggsfieldRequestV2({ contract, source_readiness: sourceReadiness }) {
  const gate = expectedValueGate({ contract, source_readiness: sourceReadiness });
  if (gate.status !== "PASS") {
    const error = new Error(`expected_value_gate_failed:${gate.errors.join(",")}`);
    error.code = "EXPECTED_VALUE_GATE_FAILED";
    error.gate = gate;
    throw error;
  }
  return { gate, compiled_prompt: compileHiggsfieldPromptV2(contract) };
}
