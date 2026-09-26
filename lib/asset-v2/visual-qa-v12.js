import { AV2_VISUAL_FRAME_POLICY_V1, isInsideProtectedSafeFrame } from "./framing.js";
import { evaluateVisualQA } from "./visual-qa.js";

export const VISUAL_QA_V12_VERSION = "visual-qa/1.2";
export const VISIBILITY_REQUIREMENT = Object.freeze({
  FULL: "FULL",
  CRITICAL_REGION: "CRITICAL_REGION",
  RECOGNIZABLE: "RECOGNIZABLE",
  DECORATIVE: "DECORATIVE",
});

export const SAFE_FRAME_SEMANTICS_V12 = Object.freeze({
  version: "semantic-safe-frame/1.2",
  canvas_bounds: Object.freeze({ x: 0, y: 0, width: 1, height: 1, pixels: Object.freeze({ width: 1152, height: 2048 }) }),
  final_frame: Object.freeze({ width: 1080, height: 1920, scale: 0.9375, transform: "proportional_scale_no_crop_no_stretch" }),
  pedagogical_safe_area: AV2_VISUAL_FRAME_POLICY_V1.protected_safe_frame,
  platform_ui_safe_area: Object.freeze({
    owner: "final_composition_qa",
    rule: "Platform and caption overlays are evaluated after asset composition; they are not a symmetric whole-asset inset.",
    renderer_evidence: Object.freeze({ top_caption_y_1080x1920: 156, bottom_caption_box_y: 1420, bottom_caption_box_height: 300 }),
  }),
});

const box = (x, y, width, height) => Object.freeze({ x, y, width, height });
const region = (region_id, planned_bounds) => Object.freeze({ region_id, planned_bounds });
const entity = (entity_id, visibility_requirement, critical_regions = [], extra = {}) => Object.freeze({
  entity_id,
  required: true,
  visibility_requirement,
  critical_regions: Object.freeze(critical_regions),
  ...extra,
});

const SCENE_CONTRACTS = Object.freeze({
  s11: Object.freeze([
    entity("lumi", VISIBILITY_REQUIREMENT.CRITICAL_REGION, [
      region("face", box(0.58, 0.39, 0.20, 0.17)),
      region("eyes", box(0.60, 0.42, 0.17, 0.09)),
      region("active_hand", box(0.47, 0.50, 0.12, 0.12)),
    ], { noncritical_regions: Object.freeze(["inactive_hand", "wings"]) }),
    entity("lumi_wand_01", VISIBILITY_REQUIREMENT.CRITICAL_REGION, [region("wand_star", box(0.43, 0.46, 0.10, 0.10))]),
    entity("gallina_amable", VISIBILITY_REQUIREMENT.RECOGNIZABLE, [region("head", box(0.17, 0.39, 0.15, 0.15)), region("face", box(0.20, 0.42, 0.10, 0.10)), region("torso", box(0.10, 0.49, 0.25, 0.20))], { allow_noncritical_canvas_clip: true }),
    entity("basket_01", VISIBILITY_REQUIREMENT.RECOGNIZABLE, [region("basket_body", box(0.36, 0.66, 0.22, 0.12))]),
  ]),
  s17: Object.freeze([
    entity("lumi", VISIBILITY_REQUIREMENT.CRITICAL_REGION, [region("face", box(0.43, 0.18, 0.20, 0.18)), region("eyes", box(0.46, 0.23, 0.14, 0.08))], { noncritical_regions: Object.freeze(["hands", "wings"]) }),
    entity("lumi_wand_01", VISIBILITY_REQUIREMENT.RECOGNIZABLE, [region("wand_star", box(0.33, 0.39, 0.08, 0.08))]),
    entity("gallina_amable", VISIBILITY_REQUIREMENT.RECOGNIZABLE, [region("head", box(0.10, 0.31, 0.14, 0.14)), region("face", box(0.13, 0.34, 0.09, 0.09)), region("torso", box(0.07, 0.42, 0.22, 0.16))], { allow_noncritical_canvas_clip: true }),
    ...["egg_01", "egg_02", "egg_03", "egg_04", "egg_05"].map((id) => entity(id, VISIBILITY_REQUIREMENT.FULL)),
  ]),
  s12: Object.freeze([
    entity("lumi", VISIBILITY_REQUIREMENT.CRITICAL_REGION, [region("face", box(0.16, 0.30, 0.22, 0.18)), region("eyes", box(0.20, 0.35, 0.15, 0.08)), region("active_hand", box(0.39, 0.48, 0.11, 0.10))], { noncritical_regions: Object.freeze(["inactive_hand", "wings"]) }),
    entity("lumi_wand_01", VISIBILITY_REQUIREMENT.CRITICAL_REGION, [region("wand_star", box(0.48, 0.42, 0.10, 0.10))]),
    entity("egg_01", VISIBILITY_REQUIREMENT.FULL),
    entity("magic_particles", VISIBILITY_REQUIREMENT.DECORATIVE, [], { required: false }),
  ]),
});

function insideCanvas(bounds) {
  return Boolean(bounds) && bounds.x >= 0 && bounds.y >= 0
    && bounds.width >= 0 && bounds.height >= 0
    && bounds.x + bounds.width <= 1 && bounds.y + bounds.height <= 1;
}

function baseManifest(manifest) {
  return manifest.base_manifest || manifest;
}

function manifestEntityIds(manifest) {
  const base = baseManifest(manifest);
  return new Set([
    ...(base.characters || []).map((entry) => entry.character_id),
    ...(base.props || []).filter((entry) => entry.visible).map((entry) => entry.prop_id),
  ]);
}

export function buildVisibilityContractV12(sceneId, manifest) {
  const definitions = SCENE_CONTRACTS[sceneId];
  if (!definitions) throw new Error(`visual_qa_v12_scene_not_supported:${sceneId}`);
  const planned = new Map((manifest?.composition_contract?.required_visual_entities || []).map((entry) => [entry.entity_id, entry.bounds]));
  return {
    version: "entity-visibility-contract/1.2",
    scene_id: sceneId,
    entities: definitions.map((entry) => ({ ...entry, planned_bounds: planned.get(entry.entity_id) || null })),
  };
}

export function validateSemanticCompositionV12({ manifest, contract }) {
  const errors = [];
  const ids = manifestEntityIds(manifest);
  for (const item of contract.entities) {
    if (item.required && !ids.has(item.entity_id)) errors.push({ code: "required_entity_not_in_scene", entity_id: item.entity_id });
    if (item.planned_bounds && !insideCanvas(item.planned_bounds)) errors.push({ code: "planned_entity_outside_canvas", entity_id: item.entity_id });
    if (item.visibility_requirement === VISIBILITY_REQUIREMENT.FULL
        && (!item.planned_bounds || !isInsideProtectedSafeFrame(item.planned_bounds))) {
      errors.push({ code: "full_entity_outside_pedagogical_safe", entity_id: item.entity_id });
    }
    if (item.visibility_requirement === VISIBILITY_REQUIREMENT.CRITICAL_REGION) {
      for (const critical of item.critical_regions) {
        if (!isInsideProtectedSafeFrame(critical.planned_bounds)) errors.push({ code: "planned_critical_region_unsafe", entity_id: item.entity_id, region_id: critical.region_id });
      }
    }
    if (item.visibility_requirement === VISIBILITY_REQUIREMENT.RECOGNIZABLE) {
      for (const critical of item.critical_regions) {
        if (!insideCanvas(critical.planned_bounds)) errors.push({ code: "planned_recognition_region_outside_canvas", entity_id: item.entity_id, region_id: critical.region_id });
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

function add(findings, severity, code, entity_id, message, region_id = null) {
  findings.push({ severity, code, entity_id, ...(region_id ? { region_id } : {}), message });
}

export function evaluateVisualQAV12({ manifest, contract, observation }) {
  const base = evaluateVisualQA({ manifest: baseManifest(manifest), observation });
  const findings = [...base.findings];
  const visible = new Set(observation.visible_entity_ids || []);
  const observed = observation.entity_observations || {};
  for (const item of contract.entities) {
    const value = observed[item.entity_id];
    if (item.required && (!visible.has(item.entity_id) || !value?.visible)) {
      add(findings, "BLOCKER", "required_entity_missing", item.entity_id, `${item.entity_id} is required but absent`);
      continue;
    }
    if (!value) continue;
    if (value.canvas_clip === "unacceptable") {
      add(findings, "BLOCKER", "unacceptable_canvas_clip", item.entity_id, `${item.entity_id} is physically clipped in a semantically unacceptable way`);
      continue;
    }
    if (!insideCanvas(value.bounds) && value.canvas_clip !== "noncritical") {
      add(findings, "BLOCKER", "entity_outside_canvas", item.entity_id, `${item.entity_id} is outside physical canvas bounds`);
      continue;
    }
    if (item.visibility_requirement === VISIBILITY_REQUIREMENT.FULL) {
      if (!insideCanvas(value.bounds) || !isInsideProtectedSafeFrame(value.bounds) || value.occluded) {
        add(findings, "BLOCKER", "full_visibility_contract_failed", item.entity_id, `${item.entity_id} must be fully visible, unoccluded and inside the pedagogical safe area`);
      }
      continue;
    }
    if (item.visibility_requirement === VISIBILITY_REQUIREMENT.CRITICAL_REGION) {
      for (const expected of item.critical_regions) {
        const actual = value.critical_regions?.[expected.region_id];
        if (!actual?.visible || actual.occluded || !insideCanvas(actual.bounds) || !isInsideProtectedSafeFrame(actual.bounds)) {
          add(findings, "BLOCKER", "critical_region_visibility_failed", item.entity_id, `${item.entity_id}.${expected.region_id} must remain visible and pedagogically safe`, expected.region_id);
        }
      }
      if (!isInsideProtectedSafeFrame(value.bounds)) {
        add(findings, "WARNING", "noncritical_extent_outside_safe", item.entity_id, `${item.entity_id} has only non-critical extent outside the pedagogical safe area`);
      }
      continue;
    }
    if (item.visibility_requirement === VISIBILITY_REQUIREMENT.RECOGNIZABLE) {
      if (!value.recognizable) {
        add(findings, "BLOCKER", "required_entity_not_recognizable", item.entity_id, `${item.entity_id} is present but not recognizable`);
        continue;
      }
      for (const expected of item.critical_regions) {
        const actual = value.critical_regions?.[expected.region_id];
        if (!actual?.visible || actual.occluded || !insideCanvas(actual.bounds)) {
          add(findings, "BLOCKER", "recognition_region_failed", item.entity_id, `${item.entity_id}.${expected.region_id} is required for recognition`, expected.region_id);
        }
      }
      if (!isInsideProtectedSafeFrame(value.bounds) || value.canvas_clip === "noncritical") {
        add(findings, "WARNING", "recognizable_entity_edge_proximity", item.entity_id, `${item.entity_id} remains recognizable but has non-critical extent outside the pedagogical inset`);
      }
      continue;
    }
    if (item.visibility_requirement === VISIBILITY_REQUIREMENT.DECORATIVE && value.canvas_clip) {
      add(findings, "INFO", "decorative_edge_overflow", item.entity_id, `${item.entity_id} decoratively reaches the canvas edge`);
    }
  }
  const counts = { BLOCKER: 0, WARNING: 0, INFO: 0 };
  findings.forEach((entry) => { counts[entry.severity] += 1; });
  return { version: VISUAL_QA_V12_VERSION, accepted: counts.BLOCKER === 0, counts, findings };
}

export function evaluateCrossSceneQAV12({ individualResults, characterIdentity, worldIdentity, propIdentity }) {
  const findings = [];
  if (!characterIdentity) add(findings, "BLOCKER", "cross_scene_character_identity", "lumi", "Lumi identity drifts across scenes");
  if (!worldIdentity) add(findings, "BLOCKER", "cross_scene_world_identity", "garden_world_01", "World or landmark identity drifts across scenes");
  if (propIdentity === "warning") add(findings, "WARNING", "cross_scene_prop_detail", "egg_01", "Egg identity is stable but shell surface detail varies slightly");
  if (propIdentity === false) add(findings, "BLOCKER", "cross_scene_prop_identity", "egg_01", "Canonical prop identity changes across scenes");
  const counts = { BLOCKER: 0, WARNING: 0, INFO: 0 };
  for (const result of individualResults) {
    counts.BLOCKER += result.counts.BLOCKER;
    counts.WARNING += result.counts.WARNING;
    counts.INFO += result.counts.INFO;
  }
  findings.forEach((entry) => { counts[entry.severity] += 1; });
  return { version: VISUAL_QA_V12_VERSION, accepted: counts.BLOCKER === 0, counts, findings };
}
