import test from "node:test";
import assert from "node:assert/strict";
import {
  chooseCharacterSafeTextRegion,
  containsTechnicalPauseLabel,
  editorialMasterReadinessGateV1,
  suppressTechnicalPauseLabel,
  validateCaptionQa,
  validateEditorialPacing,
} from "../lib/lumi-editorial-readiness-v1.js";

const safeArea = { x: 60, y: 80, width: 960, height: 1760 };
const lumi = { x: 100, y: 700, width: 420, height: 980 };
const criticalObject = { x: 620, y: 760, width: 280, height: 420 };

function passingCaptionQa() {
  return validateCaptionQa({
    lumi_bbox: lumi,
    critical_educational_object_bboxes: [criticalObject],
    safe_area: safeArea,
    text_elements: [{ text: "¿Cuál es el círculo?", bbox: { x: 120, y: 120, width: 760, height: 160 }, readability: "PASS" }],
  });
}

function passingPacingQa() {
  return validateEditorialPacing({
    duration_seconds: 45.5,
    clip_stretched_to_fill: false,
    scenes: [
      { scene_id: "s21", static_hold_duration_seconds: 0, unnecessary_silence_duration_seconds: 0, pedagogical_pause_seconds: 0, motion_pacing: "NATURAL_REAL_TIME", perceived_speed: "NATURAL_1X" },
      { scene_id: "s27", static_hold_duration_seconds: 2.5, unnecessary_silence_duration_seconds: 0, pedagogical_pause_seconds: 2.5, motion_pacing: "PEDAGOGICAL_HOLD", perceived_speed: "SLOW", pedagogical_justification: "CHILD_RESPONSE_WINDOW" },
    ],
    transitions: [{ duration_seconds: 0.18 }, { duration_seconds: 0.2 }],
  });
}

test("character text exclusion chooses a readable non-overlapping region", () => {
  const result = chooseCharacterSafeTextRegion({
    lumi_bbox: lumi,
    critical_educational_object_bboxes: [criticalObject],
    safe_area: safeArea,
    candidates: [
      { id: "over_lumi", bbox: { x: 120, y: 800, width: 360, height: 120 }, font_scale: 1, readability: "PASS" },
      { id: "top_safe", bbox: { x: 120, y: 120, width: 760, height: 160 }, font_scale: 0.9, readability: "PASS" },
    ],
  });
  assert.equal(result.status, "PASS");
  assert.equal(result.placement.id, "top_safe");
  assert.equal(result.TEXT_CHARACTER_OVERLAP, 0);
});

test("required text fails closed when no safe region exists and never covers Lumi", () => {
  const result = chooseCharacterSafeTextRegion({
    lumi_bbox: lumi,
    critical_educational_object_bboxes: [criticalObject],
    safe_area: safeArea,
    candidates: [{ id: "over_lumi", bbox: { x: 120, y: 800, width: 360, height: 120 }, font_scale: 1, readability: "PASS" }],
  });
  assert.equal(result.status, "FAIL");
  assert.equal(result.placement, null);
  assert.equal(result.invariant, "NEVER_COVER_LUMI");
});

test("caption QA rejects any overlap with Lumi or a critical educational object", () => {
  const result = validateCaptionQa({
    lumi_bbox: lumi,
    critical_educational_object_bboxes: [criticalObject],
    safe_area: safeArea,
    text_elements: [{ text: "CÍRCULO", bbox: { x: 300, y: 820, width: 500, height: 160 }, readability: "PASS" }],
  });
  assert.equal(result.status, "FAIL");
  assert.ok(result.TEXT_CHARACTER_OVERLAP > 0);
  assert.ok(result.EDUCATIONAL_OBJECT_OVERLAP > 0);
});

test("technical PAUSA labels are suppressed from captions and overlays", () => {
  assert.equal(containsTechnicalPauseLabel("PAUSA"), true);
  assert.equal(containsTechnicalPauseLabel("pause"), true);
  assert.equal(suppressTechnicalPauseLabel("¿Cuál es? PAUSA"), "¿Cuál es?");
  const result = validateCaptionQa({
    lumi_bbox: lumi,
    critical_educational_object_bboxes: [criticalObject],
    safe_area: safeArea,
    text_elements: [{ text: "Pausa", bbox: { x: 120, y: 120, width: 400, height: 120 }, readability: "PASS" }],
  });
  assert.equal(result.PEDAGOGICAL_PAUSE_TECHNICAL_LABEL_VISIBLE, true);
  assert.ok(result.errors.includes("PEDAGOGICAL_PAUSE_TECHNICAL_LABEL_VISIBLE"));
});

test("unjustified slow perceived speed blocks the master", () => {
  const result = validateEditorialPacing({
    duration_seconds: 49,
    clip_stretched_to_fill: true,
    scenes: [
      { scene_id: "s21", static_hold_duration_seconds: 1, unnecessary_silence_duration_seconds: 0.5, pedagogical_pause_seconds: 0, motion_pacing: "SLOW", perceived_speed: "SLOW" },
      { scene_id: "s27", static_hold_duration_seconds: 2.5, unnecessary_silence_duration_seconds: 0, pedagogical_pause_seconds: 2.5, motion_pacing: "PEDAGOGICAL_HOLD", perceived_speed: "SLOW", pedagogical_justification: "CHILD_RESPONSE_WINDOW" },
    ],
    transitions: [{ duration_seconds: 0.5 }],
  });
  assert.equal(result.status, "FAIL");
  assert.equal(result.PERCEIVED_SPEED, "SLOW");
  assert.ok(result.errors.includes("PERCEIVED_SPEED_SLOW_WITHOUT_PEDAGOGICAL_JUSTIFICATION"));
  assert.ok(result.errors.includes("CLIP_STRETCHED_TO_FILL_DURATION"));
});

test("valid natural pacing and caption layout pass the pre-master gate", () => {
  const captionQa = passingCaptionQa();
  const pacingQa = passingPacingQa();
  assert.equal(captionQa.TEXT_CHARACTER_OVERLAP, 0);
  assert.equal(captionQa.EDUCATIONAL_OBJECT_OVERLAP, 0);
  assert.equal(captionQa.PEDAGOGICAL_PAUSE_TECHNICAL_LABEL_VISIBLE, false);
  assert.equal(pacingQa.PERCEIVED_SPEED, "NATURAL_1X");
  assert.equal(pacingQa.PEDAGOGICAL_PAUSE_DURATION, 2.5);
  assert.equal(editorialMasterReadinessGateV1({ caption_qa: captionQa, pacing_qa: pacingQa }).master_allowed, true);
});
