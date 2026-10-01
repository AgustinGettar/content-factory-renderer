export const EDITORIAL_MASTER_READINESS_VERSION = "1.0.0";

export const TEXT_OVER_LUMI = "FORBIDDEN";
export const PERCEIVED_PLAYBACK_SPEED = "NATURAL_1X";

export const EDITORIAL_LIMITS = Object.freeze({
  TARGET_DURATION_MIN_SECONDS: 43,
  TARGET_DURATION_MAX_SECONDS: 47,
  REQUIRED_PEDAGOGICAL_PAUSE_SECONDS: 2.5,
  MAX_UNJUSTIFIED_STATIC_HOLD_SECONDS: 0.75,
  MAX_UNNECESSARY_SILENCE_SECONDS: 0.25,
  MAX_AVERAGE_TRANSITION_SECONDS: 0.3,
});

const TECHNICAL_PAUSE_LABEL = /\b(?:pausa|pause|pausar|wait|hold|espera|esperá|esperen)\b/giu;

function finite(value) {
  return Number.isFinite(Number(value));
}

function validBox(box) {
  return Boolean(
    box && finite(box.x) && finite(box.y) && finite(box.width) && finite(box.height)
    && Number(box.width) > 0 && Number(box.height) > 0,
  );
}

function intersectionArea(left, right) {
  if (!validBox(left) || !validBox(right)) return Number.NaN;
  const width = Math.max(0, Math.min(Number(left.x) + Number(left.width), Number(right.x) + Number(right.width)) - Math.max(Number(left.x), Number(right.x)));
  const height = Math.max(0, Math.min(Number(left.y) + Number(left.height), Number(right.y) + Number(right.height)) - Math.max(Number(left.y), Number(right.y)));
  return width * height;
}

function contains(container, child) {
  if (!validBox(container) || !validBox(child)) return false;
  return Number(child.x) >= Number(container.x)
    && Number(child.y) >= Number(container.y)
    && Number(child.x) + Number(child.width) <= Number(container.x) + Number(container.width)
    && Number(child.y) + Number(child.height) <= Number(container.y) + Number(container.height);
}

function sum(values) {
  return values.reduce((total, value) => total + Number(value || 0), 0);
}

function round(value) {
  return Math.round((Number(value) + Number.EPSILON) * 1000) / 1000;
}

export function containsTechnicalPauseLabel(text) {
  TECHNICAL_PAUSE_LABEL.lastIndex = 0;
  return TECHNICAL_PAUSE_LABEL.test(String(text || ""));
}

export function suppressTechnicalPauseLabel(text) {
  TECHNICAL_PAUSE_LABEL.lastIndex = 0;
  return String(text || "")
    .replace(TECHNICAL_PAUSE_LABEL, "")
    .replace(/\s+([,.;:!?])/gu, "$1")
    .replace(/\s{2,}/gu, " ")
    .trim();
}

export function chooseCharacterSafeTextRegion({
  lumi_bbox: lumiBox,
  critical_educational_object_bboxes: objectBoxes = [],
  safe_area: safeArea,
  candidates = [],
  text_required: textRequired = true,
}) {
  if (!validBox(lumiBox) || !validBox(safeArea) || !objectBoxes.every(validBox)) {
    return { status: "FAIL", placement: null, error: "INVALID_CHARACTER_TEXT_EXCLUSION_GEOMETRY" };
  }

  const ordered = candidates
    .map((candidate, index) => ({ ...candidate, index }))
    .sort((left, right) => Number(right.font_scale || 0) - Number(left.font_scale || 0) || left.index - right.index);
  const placement = ordered.find((candidate) => validBox(candidate.bbox)
    && candidate.readability === "PASS"
    && contains(safeArea, candidate.bbox)
    && intersectionArea(candidate.bbox, lumiBox) === 0
    && objectBoxes.every((box) => intersectionArea(candidate.bbox, box) === 0));

  if (placement) {
    return {
      status: "PASS",
      placement: { id: placement.id, bbox: placement.bbox, font_scale: placement.font_scale },
      TEXT_CHARACTER_OVERLAP: 0,
      EDUCATIONAL_OBJECT_OVERLAP: 0,
    };
  }

  return {
    status: textRequired ? "FAIL" : "SUPPRESS_OPTIONAL_TEXT",
    placement: null,
    error: textRequired ? "NO_READABLE_CHARACTER_SAFE_TEXT_REGION" : null,
    invariant: "NEVER_COVER_LUMI",
  };
}

export function validateCaptionQa({
  lumi_bbox: lumiBox,
  critical_educational_object_bboxes: objectBoxes = [],
  safe_area: safeArea,
  text_elements: textElements = [],
}) {
  const errors = [];
  const invalidGeometry = !validBox(lumiBox) || !validBox(safeArea)
    || !objectBoxes.every(validBox) || !textElements.every((item) => validBox(item?.bbox));
  if (invalidGeometry) errors.push("INVALID_CAPTION_QA_GEOMETRY");

  const characterOverlap = invalidGeometry ? Number.NaN : sum(textElements.map((item) => intersectionArea(item.bbox, lumiBox)));
  const objectOverlap = invalidGeometry ? Number.NaN : sum(textElements.flatMap((item) => objectBoxes.map((box) => intersectionArea(item.bbox, box))));
  const technicalPauseVisible = textElements.some((item) => containsTechnicalPauseLabel(item?.text));
  const safeAreaPass = !invalidGeometry && textElements.every((item) => contains(safeArea, item.bbox));
  const readabilityPass = textElements.every((item) => item?.readability === "PASS");

  if (characterOverlap !== 0) errors.push("TEXT_OVER_LUMI_FORBIDDEN");
  if (objectOverlap !== 0) errors.push("TEXT_OVER_CRITICAL_EDUCATIONAL_OBJECT_FORBIDDEN");
  if (technicalPauseVisible) errors.push("PEDAGOGICAL_PAUSE_TECHNICAL_LABEL_VISIBLE");
  if (!safeAreaPass) errors.push("CAPTION_SAFE_AREA_FAIL");
  if (!readabilityPass) errors.push("CAPTION_READABILITY_FAIL");

  return {
    status: errors.length === 0 ? "PASS" : "FAIL",
    version: EDITORIAL_MASTER_READINESS_VERSION,
    TEXT_CHARACTER_OVERLAP: round(characterOverlap),
    EDUCATIONAL_OBJECT_OVERLAP: round(objectOverlap),
    PEDAGOGICAL_PAUSE_TECHNICAL_LABEL_VISIBLE: technicalPauseVisible,
    SAFE_AREA: safeAreaPass ? "PASS" : "FAIL",
    READABILITY: readabilityPass ? "PASS" : "FAIL",
    errors,
  };
}

export function validateEditorialPacing({
  duration_seconds: durationSeconds,
  duration_justification: durationJustification = null,
  scenes = [],
  transitions = [],
  clip_stretched_to_fill: clipStretchedToFill = false,
}) {
  const errors = [];
  const unjustifiedStaticHold = sum(scenes.map((scene) => scene.pedagogical_justification ? 0 : scene.static_hold_duration_seconds));
  const unnecessarySilence = sum(scenes.map((scene) => scene.unnecessary_silence_duration_seconds));
  const transitionDurations = transitions.map((item) => Number(item.duration_seconds));
  const averageTransition = transitionDurations.length > 0 ? sum(transitionDurations) / transitionDurations.length : 0;
  const slowScenes = scenes.filter((scene) => scene.perceived_speed === "SLOW" && !scene.pedagogical_justification);
  const nonNaturalMotion = scenes.filter((scene) => scene.motion_pacing !== "NATURAL_REAL_TIME" && !scene.pedagogical_justification);
  const pedagogicalPause = sum(scenes.map((scene) => scene.pedagogical_pause_seconds));
  const inTargetRange = finite(durationSeconds)
    && Number(durationSeconds) >= EDITORIAL_LIMITS.TARGET_DURATION_MIN_SECONDS
    && Number(durationSeconds) <= EDITORIAL_LIMITS.TARGET_DURATION_MAX_SECONDS;

  if (!inTargetRange && !durationJustification) errors.push("DURATION_OUTSIDE_NATURAL_TARGET_WITHOUT_JUSTIFICATION");
  if (unjustifiedStaticHold > EDITORIAL_LIMITS.MAX_UNJUSTIFIED_STATIC_HOLD_SECONDS) errors.push("EXCESS_UNJUSTIFIED_STATIC_HOLD");
  if (unnecessarySilence > EDITORIAL_LIMITS.MAX_UNNECESSARY_SILENCE_SECONDS) errors.push("EXCESS_UNNECESSARY_SILENCE");
  if (averageTransition > EDITORIAL_LIMITS.MAX_AVERAGE_TRANSITION_SECONDS) errors.push("TRANSITIONS_TOO_SLOW");
  if (slowScenes.length > 0) errors.push("PERCEIVED_SPEED_SLOW_WITHOUT_PEDAGOGICAL_JUSTIFICATION");
  if (nonNaturalMotion.length > 0) errors.push("MOTION_PACING_NOT_NATURAL_REAL_TIME");
  if (clipStretchedToFill) errors.push("CLIP_STRETCHED_TO_FILL_DURATION");
  if (round(pedagogicalPause) !== EDITORIAL_LIMITS.REQUIRED_PEDAGOGICAL_PAUSE_SECONDS) errors.push("PEDAGOGICAL_PAUSE_DURATION_MISMATCH");

  return {
    status: errors.length === 0 ? "PASS" : "FAIL",
    version: EDITORIAL_MASTER_READINESS_VERSION,
    STATIC_HOLD_DURATION: round(unjustifiedStaticHold),
    UNNECESSARY_SILENCE_DURATION: round(unnecessarySilence),
    AVERAGE_TRANSITION_DURATION: round(averageTransition),
    MOTION_PACING: nonNaturalMotion.length === 0 ? "NATURAL_REAL_TIME" : "NON_NATURAL",
    PERCEIVED_SPEED: slowScenes.length === 0 ? PERCEIVED_PLAYBACK_SPEED : "SLOW",
    PEDAGOGICAL_PAUSE_DURATION: round(pedagogicalPause),
    errors,
  };
}

export function editorialMasterReadinessGateV1({ caption_qa: captionQa, pacing_qa: pacingQa }) {
  const errors = [];
  if (captionQa?.status !== "PASS") errors.push("CAPTION_QA_NOT_PASS");
  if (pacingQa?.status !== "PASS") errors.push("EDITORIAL_PACING_QA_NOT_PASS");
  return {
    status: errors.length === 0 ? "PASS" : "FAIL",
    master_allowed: errors.length === 0,
    version: EDITORIAL_MASTER_READINESS_VERSION,
    errors,
  };
}
