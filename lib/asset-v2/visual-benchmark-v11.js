import { contentHash } from "../av2/contracts.js";
import { LUMI_CHARACTER_LOCK_V1 } from "./character-lock.js";
import { buildVisualBenchmark, CANONICAL_EGG_IDS } from "./director.js";
import { AV2_VISUAL_FRAME_POLICY_V1, isInsideProtectedSafeFrame } from "./framing.js";
import { evaluateVisualQA } from "./visual-qa.js";

export const VISUAL_BENCHMARK_V11_VERSION = "visual-benchmark/1.1";
export const SCENE_ASSET_MANIFEST_V11_VERSION = "scene-asset-manifest/1.1";
export const VISUAL_PROMPT_COMPILER_V11_VERSION = "visual-prompt-compiler/1.1";
export const COMPOSITION_CONTRACT_VERSION = "composition-contract/1";

export const PEDAGOGICAL_SAFE_FRAME_V1 = Object.freeze({
  version: "pedagogical-safe-frame/1",
  canvas: Object.freeze({ width: 1152, height: 2048, aspect_ratio: "9:16" }),
  final: Object.freeze({ width: 1080, height: 1920, transform: "proportional_scale_no_crop_no_stretch" }),
  normalized: AV2_VISUAL_FRAME_POLICY_V1.protected_safe_frame,
  protects: Object.freeze([
    "lumi_face", "required_hands", "wand_star", "educational_props",
    "eggs", "required_secondary_characters", "interaction_focal_point",
  ]),
});

export const LUMI_CHARACTER_SCALE_LOCK_V1 = Object.freeze({
  version: "lumi-character-scale-lock/1",
  identity_rule: "Camera distance may change screen size, but never Lumi's physical proportions.",
  head_to_body_ratio: "canonical_large_rounded_head_to_compact_body",
  eye_to_face_ratio: "canonical_very_large_turquoise_oval_eyes",
  body_volume: "canonical_rounded_firefly_body",
  limb_proportions: "canonical_short_child_friendly_limbs",
});

export const GARDEN_WORLD_LANDMARK_LOCK_V1 = Object.freeze({
  version: "garden-world-landmark-lock/1",
  environment_id: "garden_world_01",
  evidence: Object.freeze({
    role: "approved_world_evidence_only",
    asset_id: "a71f34d3-f2d1-4ff1-8ba9-6a5186d13cf3",
    scene_id: "s11",
    asset_hash: "b069f9d7c6ff086708d57e126a3342ed820dc58d58f730f9abd0c1faf65483d4",
  }),
  landmarks: Object.freeze([
    Object.freeze({
      landmark_id: "tree_trunk_01",
      canonical_appearance: "large mature mossy garden tree with a rounded warm wooden arched door and a small circular blue four-pane window",
      geometry: "broad trunk on the right side of the curved path, rounded canopy overhead, short stone steps at the base",
      material: "soft stylized bark, moss patches, warm wood door, blue glass window",
      relative_location: "right side of garden_path after basket_clearing",
      persistent_features: Object.freeze(["arched_wooden_door", "circular_blue_four_pane_window", "moss_patches", "stone_steps"]),
      forbidden_drift: Object.freeze(["open_tree_hole", "dark_hollow", "door_without_circular_window"]),
    }),
  ]),
});

const box = (x, y, width, height) => Object.freeze({ x, y, width, height });

const S17_ENTITIES = Object.freeze([
  Object.freeze({ entity_id: "lumi", entity_type: "character", importance: "primary", screen_region: "center_upper", safe_frame_required: true, relative_scale: 0.72, relationship_to_focal_point: "asks the child and presents the count", visibility: "required", occlusion_policy: "face_hands_and_wand_clear", bounds: box(0.30, 0.15, 0.40, 0.48) }),
  Object.freeze({ entity_id: "gallina_amable", entity_type: "character", importance: "required_secondary", screen_region: "upper_left", safe_frame_required: true, relative_scale: 0.36, relationship_to_focal_point: "watches Lumi and the completed count", visibility: "required", occlusion_policy: "face_clear", bounds: box(0.10, 0.30, 0.22, 0.28) }),
  ...CANONICAL_EGG_IDS.map((entity_id, index) => Object.freeze({
    entity_id, entity_type: "egg", importance: "pedagogical", screen_region: "lower_counting_row",
    safe_frame_required: true, relative_scale: 0.16,
    relationship_to_focal_point: `counting_position_${index + 1}_of_5`, visibility: "required",
    occlusion_policy: "no_overlap_with_eggs", bounds: box(0.13 + index * 0.16, 0.72, 0.11, 0.14),
  })),
  Object.freeze({ entity_id: "lumi_wand_01", entity_type: "prop", importance: "identity", screen_region: "center_left", safe_frame_required: true, relative_scale: 0.18, relationship_to_focal_point: "held idle without obscuring eggs", visibility: "required", occlusion_policy: "must_not_obscure_face_or_eggs", bounds: box(0.26, 0.48, 0.10, 0.18) }),
]);

const S12_ENTITIES = Object.freeze([
  Object.freeze({ entity_id: "lumi", entity_type: "character", importance: "primary", screen_region: "left_center", safe_frame_required: true, relative_scale: 0.68, relationship_to_focal_point: "looks and points toward egg_01", visibility: "required", occlusion_policy: "face_hands_and_wand_clear", bounds: box(0.11, 0.20, 0.43, 0.52) }),
  Object.freeze({ entity_id: "lumi_wand_01", entity_type: "prop", importance: "pedagogical", screen_region: "center", safe_frame_required: true, relative_scale: 0.20, relationship_to_focal_point: "star points toward egg_01", visibility: "required", occlusion_policy: "must_not_obscure_face_or_egg", bounds: box(0.48, 0.42, 0.14, 0.12) }),
  Object.freeze({ entity_id: "egg_01", entity_type: "egg", importance: "pedagogical", screen_region: "right_lower", safe_frame_required: true, relative_scale: 0.22, relationship_to_focal_point: "single discovered egg receiving magic trail", visibility: "required", occlusion_policy: "fully_visible_no_fx_occlusion", bounds: box(0.69, 0.62, 0.16, 0.19) }),
]);

function compositionFor(sceneId) {
  if (sceneId === "s17") return {
    required_visual_entities: S17_ENTITIES,
    exact_count_locks: [{ entity_type: "egg", expected_count: 5, entity_ids: [...CANONICAL_EGG_IDS] }],
    focal_relationship: ["lumi", "egg_01", "egg_02", "egg_03", "egg_04", "egg_05", "gallina_amable"],
    required_camera_subjects: ["lumi", "gallina_amable", "egg_group"],
    decorative_priority: "lowest",
  };
  if (sceneId === "s12") return {
    required_visual_entities: S12_ENTITIES,
    exact_count_locks: [{ entity_type: "egg", expected_count: 1, entity_ids: ["egg_01"] }],
    focal_relationship: ["lumi", "lumi_wand_01", "egg_01"],
    required_camera_subjects: ["lumi", "egg_01"],
    fx_policy: "magic trail may connect wand to egg_01 but may not cover Lumi's face, wand star, or egg shell",
    decorative_priority: "lowest",
  };
  throw new Error(`visual_benchmark_v11_scene_not_supported:${sceneId}`);
}

function visibleBaseIds(manifest) {
  return new Set([
    ...manifest.characters.map((entry) => entry.character_id),
    ...manifest.props.filter((entry) => entry.visible).map((entry) => entry.prop_id),
  ]);
}

function overlaps(a, b) {
  return a.x < b.x + b.width && a.x + a.width > b.x
    && a.y < b.y + b.height && a.y + a.height > b.y;
}

export function validateComposition(manifestV11) {
  const errors = [];
  const contract = manifestV11?.composition_contract;
  const base = manifestV11?.base_manifest;
  if (!contract || !base) return { ok: false, errors: [{ code: "composition_contract_missing", path: "/composition_contract" }] };
  const canvas = contract.safe_frame.canvas;
  if (canvas.width !== 1152 || canvas.height !== 2048 || canvas.aspect_ratio !== "9:16") {
    errors.push({ code: "composition_canvas_invalid", path: "/composition_contract/safe_frame/canvas" });
  }
  const baseIds = visibleBaseIds(base);
  const entries = contract.required_visual_entities || [];
  const ids = new Set(entries.map((entry) => entry.entity_id));
  for (const entry of entries) {
    if (entry.visibility !== "required") errors.push({ code: "required_entity_visibility_invalid", path: `/required_visual_entities/${entry.entity_id}` });
    if (!baseIds.has(entry.entity_id)) errors.push({ code: "required_entity_not_in_canonical_scene", path: `/required_visual_entities/${entry.entity_id}` });
    if (entry.safe_frame_required && !isInsideProtectedSafeFrame(entry.bounds)) {
      errors.push({ code: "critical_entity_outside_safe_frame", path: `/required_visual_entities/${entry.entity_id}/bounds` });
    }
  }
  for (const id of contract.focal_relationship || []) {
    if (!ids.has(id)) errors.push({ code: "focal_entity_not_required", path: `/focal_relationship/${id}` });
  }
  for (const lock of contract.exact_count_locks || []) {
    const actual = entries.filter((entry) => entry.entity_type === lock.entity_type).map((entry) => entry.entity_id);
    if (actual.length !== lock.expected_count || lock.entity_ids.some((id) => !actual.includes(id))) {
      errors.push({ code: "composition_count_lock_failed", path: `/exact_count_locks/${lock.entity_type}` });
    }
  }
  const eggs = entries.filter((entry) => entry.entity_type === "egg");
  for (let i = 0; i < eggs.length; i += 1) {
    for (let j = i + 1; j < eggs.length; j += 1) {
      if (overlaps(eggs[i].bounds, eggs[j].bounds)) errors.push({ code: "critical_entity_overlap", path: `/required_visual_entities/${eggs[i].entity_id}` });
    }
  }
  return { ok: errors.length === 0, errors };
}

export function evaluateVisualQAV11({ manifest, observation }) {
  const base = evaluateVisualQA({ manifest: manifest.base_manifest, observation });
  const findings = [...base.findings];
  const observedIds = new Set(observation.visible_entity_ids || []);
  const observedBounds = observation.entity_bounds || {};
  for (const entity of manifest.composition_contract.required_visual_entities) {
    if (!observedIds.has(entity.entity_id)) {
      findings.push({ severity: "BLOCKER", code: "required_visual_entity_missing", message: `${entity.entity_id} is required and missing`, path: `/visible_entity_ids/${entity.entity_id}` });
      continue;
    }
    if (entity.safe_frame_required) {
      const bounds = observedBounds[entity.entity_id];
      if (!bounds || !isInsideProtectedSafeFrame(bounds)) {
        findings.push({ severity: "BLOCKER", code: "required_visual_entity_outside_safe_frame", message: `${entity.entity_id} must be fully inside PEDAGOGICAL_SAFE_FRAME_V1`, path: `/entity_bounds/${entity.entity_id}` });
      }
    }
  }
  if (observation.character_physical_proportions_match === false) {
    findings.push({ severity: "WARNING", code: "character_scale_drift", message: "Lumi identity is preserved but physical proportions drift from the canonical scale lock", path: "/character_physical_proportions_match" });
  }
  const tree = observation.landmarks?.tree_trunk_01;
  if (tree && tree.identity_match === false) {
    findings.push({ severity: "BLOCKER", code: "world_landmark_identity_drift", message: "tree_trunk_01 no longer matches its locked world identity", path: "/landmarks/tree_trunk_01" });
  } else if (tree && tree.detail_match === false) {
    findings.push({ severity: "WARNING", code: "world_landmark_detail_drift", message: "tree_trunk_01 preserves identity but a persistent feature drifted", path: "/landmarks/tree_trunk_01" });
  }
  if (observation.fx_obscures_critical_entity) {
    findings.push({ severity: "BLOCKER", code: "critical_fx_occlusion", message: "Magic FX obscures a required face, wand, or educational prop", path: "/fx_obscures_critical_entity" });
  }
  const counts = { BLOCKER: 0, WARNING: 0, INFO: 0 };
  findings.forEach((entry) => { counts[entry.severity] += 1; });
  return {
    version: "visual-qa/1.1",
    accepted: counts.BLOCKER === 0,
    counts,
    findings,
  };
}

function specificationHash(value) {
  const copy = structuredClone(value);
  delete copy.asset_specification_hash;
  return contentHash(copy);
}

export function buildVisualBenchmarkV11(snapshot) {
  const benchmarkV1 = buildVisualBenchmark(snapshot);
  const scenes = benchmarkV1.scenes.filter((entry) => ["s17", "s12"].includes(entry.scene_id)).map((entry) => {
    const policy = compositionFor(entry.scene_id);
    const manifest = {
      version: SCENE_ASSET_MANIFEST_V11_VERSION,
      benchmark_version: VISUAL_BENCHMARK_V11_VERSION,
      base_manifest: entry.manifest,
      required_visual_entities: policy.required_visual_entities,
      composition_contract: {
        version: COMPOSITION_CONTRACT_VERSION,
        safe_frame: PEDAGOGICAL_SAFE_FRAME_V1,
        required_visual_entities: policy.required_visual_entities,
        exact_count_locks: policy.exact_count_locks,
        focal_relationship: policy.focal_relationship,
        required_camera_subjects: policy.required_camera_subjects,
        fx_policy: policy.fx_policy || null,
        decorative_priority: policy.decorative_priority,
      },
      landmark_lock: GARDEN_WORLD_LANDMARK_LOCK_V1,
      character_scale_lock: LUMI_CHARACTER_SCALE_LOCK_V1,
      approved_world_reference: GARDEN_WORLD_LANDMARK_LOCK_V1.evidence,
      character_lock_version: LUMI_CHARACTER_LOCK_V1.version,
      asset_specification_hash: "",
    };
    manifest.asset_specification_hash = specificationHash(manifest);
    const preflight = validateComposition(manifest);
    if (!preflight.ok) throw new Error(`visual_benchmark_v11_preflight_failed:${entry.scene_id}:${JSON.stringify(preflight.errors)}`);
    return {
      role: entry.role,
      scene_id: entry.scene_id,
      parent_cache_key: entry.cache_key,
      manifest,
      cache_key: contentHash({ cache_version: "av2-asset-cache/1.1", asset_specification_hash: manifest.asset_specification_hash }),
      preflight_hash: contentHash(preflight),
    };
  });
  return {
    version: VISUAL_BENCHMARK_V11_VERSION,
    source: benchmarkV1.source,
    character_lock: benchmarkV1.character_lock,
    world_manifest: benchmarkV1.world_manifest,
    prop_registry: benchmarkV1.prop_registry,
    scenes,
  };
}
