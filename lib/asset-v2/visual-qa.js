import { LUMI_CHARACTER_LOCK_V1 } from "./character-lock.js";
import { CANONICAL_EGG_IDS } from "./director.js";
import { VISUAL_QA_VERSION } from "./contracts.js";

export const VISUAL_QA_V1 = Object.freeze({
  version: VISUAL_QA_VERSION,
  severity: ["BLOCKER", "WARNING", "INFO"],
  domains: [
    "character_identity", "anatomy", "wardrobe", "wand", "prop_count",
    "continuity", "composition", "child_safety_appeal", "text",
  ],
  acceptance: "BLOCKER count must equal zero; WARNING and INFO do not force regeneration",
});

function finding(severity, code, message, path) {
  return { severity, code, message, path };
}

export function evaluateVisualQA({ manifest, observation, characterLock = LUMI_CHARACTER_LOCK_V1 }) {
  const findings = [];
  const lumiExpected = manifest.characters.some((entry) => entry.character_id === "lumi");
  const lumi = observation.characters?.find((entry) => entry.character_id === "lumi");
  if (lumiExpected && !lumi) findings.push(finding("BLOCKER", "lumi_missing", "Lumi is required but absent", "/characters"));
  if (lumi) {
    if (!lumi.identity_match) findings.push(finding("BLOCKER", "wrong_lumi", "Character does not match canonical Lumi", "/characters/lumi/identity_match"));
    if (lumi.species_match === false || lumi.apparent_age_match === false) findings.push(finding("BLOCKER", "identity_drift", "Lumi species or apparent age changed", "/characters/lumi/identity"));
    if (lumi.body_color !== "warm_yellow") findings.push(finding("BLOCKER", "wrong_body_color", "Lumi body color changed", "/characters/lumi/body_color"));
    if (lumi.eye_color !== characterLock.face.eye_color) findings.push(finding("BLOCKER", "wrong_eye_color", "Lumi eye color changed", "/characters/lumi/eye_color"));
    if (lumi.antennae_count !== characterLock.head.antennae_count) findings.push(finding("BLOCKER", "wrong_antennae_count", "Lumi must have exactly two antennae", "/characters/lumi/antennae_count"));
    if (lumi.wing_count !== characterLock.wings.count) findings.push(finding("BLOCKER", "wrong_wing_count", "Lumi must have exactly two wings", "/characters/lumi/wing_count"));
    if (!lumi.overalls_match) findings.push(finding("BLOCKER", "wrong_outfit", "Canonical overalls are missing or changed", "/characters/lumi/overalls_match"));
    if (!lumi.shoes_match) findings.push(finding("BLOCKER", "wrong_shoes", "Canonical shoes are missing or changed", "/characters/lumi/shoes_match"));
    if (!lumi.wand_match) findings.push(finding("BLOCKER", "wrong_wand", "Canonical wand design changed", "/characters/lumi/wand_match"));
    if (lumi.extra_limbs || !lumi.hands_ok) findings.push(finding("BLOCKER", "broken_anatomy", "Extra or malformed limbs/hands detected", "/characters/lumi/anatomy"));
    if (!lumi.face_ok || lumi.uncanny) findings.push(finding("BLOCKER", "broken_face", "Face is broken, frightening or uncanny", "/characters/lumi/face"));
    if (lumi.face_clutter) findings.push(finding("BLOCKER", "face_clutter", "Visual clutter obscures Lumi's face", "/characters/lumi/face_clutter"));
    const expectedState = manifest.characters.find((entry) => entry.character_id === "lumi");
    if (lumi.pose_match === false) findings.push(finding("WARNING", "pose_mismatch", `Pose is weaker than ${expectedState.pose}`, "/characters/lumi/pose"));
  }

  const expectedVisible = new Set(manifest.props.filter((entry) => entry.visible).map((entry) => entry.prop_id));
  const observedVisible = new Set(observation.visible_prop_ids || []);
  for (const propId of expectedVisible) {
    if (!observedVisible.has(propId)) findings.push(finding("BLOCKER", "important_prop_missing", `${propId} is required and missing`, "/visible_prop_ids"));
  }
  const expectedEggCount = [...expectedVisible].filter((id) => CANONICAL_EGG_IDS.includes(id)).length;
  const observedEggIds = [...observedVisible].filter((id) => CANONICAL_EGG_IDS.includes(id));
  const unknownEggCount = Number(observation.unregistered_egg_count || 0);
  if (observedEggIds.length + unknownEggCount !== expectedEggCount) {
    findings.push(finding("BLOCKER", "wrong_egg_count", `Expected ${expectedEggCount} visible canonical eggs`, "/visible_prop_ids"));
  }
  if (new Set(observedEggIds).size !== observedEggIds.length || unknownEggCount > 0) {
    findings.push(finding("BLOCKER", "unlocked_egg", "Duplicate or unregistered egg detected", "/visible_prop_ids"));
  }
  if (observation.environment_id !== manifest.environment_id) findings.push(finding("BLOCKER", "wrong_environment_identity", "Environment continuity lock changed", "/environment_id"));
  if (observation.width <= 0 || observation.height <= 0 || Math.abs(observation.width / observation.height - 9 / 16) > 0.002) {
    findings.push(finding("BLOCKER", "wrong_aspect_ratio", "Asset must be true 9:16", "/width"));
  }
  if (observation.critical_crop) findings.push(finding("BLOCKER", "critical_crop", "A critical subject or prop is accidentally cropped", "/critical_crop"));
  if (observation.generated_text || observation.logo_or_watermark) findings.push(finding("BLOCKER", "generated_text_or_logo", "Generated text, logo or watermark is forbidden", "/generated_text"));
  if (observation.child_safe === false) findings.push(finding("BLOCKER", "child_safety", "Visual is frightening or unsuitable for preschool viewers", "/child_safe"));
  if (observation.composition_strength === "weak") findings.push(finding("WARNING", "weak_composition", "Composition needs stronger hierarchy", "/composition_strength"));
  if (observation.depth_strength === "weak") findings.push(finding("WARNING", "weak_depth", "Foreground/midground/background separation is weak", "/depth_strength"));
  if (observation.background_density === "empty") findings.push(finding("WARNING", "background_too_empty", "World feels under-populated", "/background_density"));

  const counts = { BLOCKER: 0, WARNING: 0, INFO: 0 };
  findings.forEach((entry) => { counts[entry.severity] += 1; });
  return {
    version: VISUAL_QA_VERSION,
    accepted: counts.BLOCKER === 0,
    counts,
    findings,
  };
}
