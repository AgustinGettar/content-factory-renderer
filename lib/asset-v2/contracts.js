import Ajv2020 from "ajv/dist/2020.js";

export const WORLD_MANIFEST_VERSION = "av2-world-manifest/1";
export const PROP_REGISTRY_VERSION = "av2-prop-registry/1";
export const SCENE_ASSET_MANIFEST_VERSION = "scene-asset-manifest/1";
export const VISUAL_QA_VERSION = "visual-qa/1";
export const VISUAL_BENCHMARK_VERSION = "visual-benchmark/1";
export const VISUAL_PROMPT_COMPILER_VERSION = "visual-prompt-compiler/1";
export const ASSET_CACHE_VERSION = "av2-asset-cache/1";

const nonEmpty = { type: "string", minLength: 1, maxLength: 1000 };
const id = { type: "string", pattern: "^[a-z][a-z0-9_-]{1,95}$" };
const vec3 = { type: "array", minItems: 3, maxItems: 3, items: { type: "number" } };
const ref = {
  type: "object", additionalProperties: false, required: ["id", "version"],
  properties: { id, version: { type: "string", minLength: 1, maxLength: 64 } },
};
const layerItem = {
  type: "object", additionalProperties: false,
  required: ["asset_id", "description", "reusable", "independently_movable"],
  properties: {
    asset_id: id,
    description: nonEmpty,
    reusable: { type: "boolean" },
    independently_movable: { type: "boolean" },
  },
};

export const AV2_WORLD_MANIFEST_V1_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://content-factory.local/schemas/av2-world-manifest.v1.schema.json",
  type: "object", additionalProperties: false,
  required: [
    "version", "environment_id", "source_ref", "geography", "landmarks",
    "lighting", "palette", "layers", "continuity_rules",
  ],
  properties: {
    version: { const: WORLD_MANIFEST_VERSION },
    environment_id: id,
    source_ref: ref,
    geography: nonEmpty,
    landmarks: { type: "array", minItems: 3, uniqueItems: true, items: id },
    lighting: {
      type: "object", additionalProperties: false,
      required: ["direction", "quality", "time_of_day", "reference"],
      properties: { direction: nonEmpty, quality: nonEmpty, time_of_day: nonEmpty, reference: ref },
    },
    palette: { type: "array", minItems: 3, uniqueItems: true, items: nonEmpty },
    layers: {
      type: "object", additionalProperties: false, required: ["background", "midground", "foreground"],
      properties: {
        background: { type: "array", minItems: 1, items: layerItem },
        midground: { type: "array", minItems: 1, items: layerItem },
        foreground: { type: "array", minItems: 1, items: layerItem },
      },
    },
    continuity_rules: { type: "array", minItems: 5, uniqueItems: true, items: nonEmpty },
  },
};

const propEntry = {
  type: "object", additionalProperties: false,
  required: [
    "prop_id", "source_entity_id", "type", "appearance", "scale", "state",
    "location", "continuity_owner", "version", "countable",
  ],
  properties: {
    prop_id: id,
    source_entity_id: id,
    type: id,
    appearance: nonEmpty,
    scale: { type: "number", exclusiveMinimum: 0, maximum: 10 },
    state: { type: "string", enum: ["hidden", "visible", "found", "grouped", "inside_nest", "inside_basket"] },
    location: nonEmpty,
    continuity_owner: id,
    version: { type: "string", minLength: 1, maxLength: 64 },
    countable: { type: "boolean" },
  },
};

export const AV2_PROP_REGISTRY_V1_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://content-factory.local/schemas/av2-prop-registry.v1.schema.json",
  type: "object", additionalProperties: false,
  required: ["version", "artifact_id", "props", "count_locks"],
  properties: {
    version: { const: PROP_REGISTRY_VERSION },
    artifact_id: { type: "string", format: "uuid" },
    props: { type: "array", minItems: 5, uniqueItems: true, items: propEntry },
    count_locks: {
      type: "array", minItems: 1, items: {
        type: "object", additionalProperties: false,
        required: ["lock_id", "type", "expected_count", "prop_ids"],
        properties: {
          lock_id: id,
          type: id,
          expected_count: { type: "integer", minimum: 1, maximum: 100 },
          prop_ids: { type: "array", minItems: 1, uniqueItems: true, items: id },
        },
      },
    },
  },
};

const characterState = {
  type: "object", additionalProperties: false,
  required: [
    "character_id", "pose", "custom_action_id", "expression", "gaze", "screen_position",
    "scale", "layer", "wand_state", "wing_state", "body_orientation", "motion_parts",
  ],
  properties: {
    character_id: id,
    pose: id,
    custom_action_id: { type: ["string", "null"], maxLength: 100 },
    expression: id,
    gaze: nonEmpty,
    screen_position: vec3,
    scale: { type: "number", exclusiveMinimum: 0, maximum: 10 },
    layer: { type: "string", enum: ["background", "midground", "foreground"] },
    wand_state: { type: "string", enum: ["held_idle", "pointing", "casting", "not_visible"] },
    wing_state: { type: "string", enum: ["resting", "open", "flutter_ready", "not_visible"] },
    body_orientation: nonEmpty,
    motion_parts: { type: "array", minItems: 1, uniqueItems: true, items: id },
  },
};

const propState = {
  type: "object", additionalProperties: false,
  required: ["prop_id", "state", "visible", "position", "scale", "layer", "independently_movable"],
  properties: {
    prop_id: id,
    state: { type: "string", enum: ["hidden", "visible", "found", "grouped", "inside_nest", "inside_basket"] },
    visible: { type: "boolean" },
    position: vec3,
    scale: { type: "number", exclusiveMinimum: 0, maximum: 10 },
    layer: { type: "string", enum: ["background", "midground", "foreground"] },
    independently_movable: { type: "boolean" },
  },
};

export const SCENE_ASSET_MANIFEST_V1_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://content-factory.local/schemas/scene-asset-manifest.v1.schema.json",
  type: "object", additionalProperties: false,
  required: [
    "version", "artifact_id", "artifact_content_hash", "scene_id", "scene_index", "environment_id",
    "source_scene_hash", "camera", "characters", "props", "world_layers", "fx", "composition",
    "continuity", "motion_ready", "asset_specification_hash",
  ],
  properties: {
    version: { const: SCENE_ASSET_MANIFEST_VERSION },
    artifact_id: { type: "string", format: "uuid" },
    artifact_content_hash: { type: "string", pattern: "^[a-f0-9]{64}$" },
    scene_id: id,
    scene_index: { type: "integer", minimum: 0 },
    environment_id: id,
    source_scene_hash: { type: "string", pattern: "^[a-f0-9]{64}$" },
    camera: {
      type: "object", additionalProperties: false,
      required: ["shot_type", "framing", "angle", "target", "movement", "depth_plan", "aspect_ratio"],
      properties: {
        shot_type: id, framing: nonEmpty, angle: nonEmpty,
        target: { type: "array", minItems: 1, uniqueItems: true, items: id },
        movement: id,
        depth_plan: {
          type: "object", additionalProperties: false,
          required: ["foreground", "midground", "background", "focus_plane"],
          properties: { foreground: nonEmpty, midground: nonEmpty, background: nonEmpty, focus_plane: nonEmpty },
        },
        aspect_ratio: { const: "9:16" },
      },
    },
    characters: { type: "array", minItems: 1, items: characterState },
    props: { type: "array", items: propState },
    world_layers: {
      type: "object", additionalProperties: false, required: ["background", "midground", "foreground"],
      properties: {
        background: { type: "array", minItems: 1, items: id },
        midground: { type: "array", minItems: 1, items: id },
        foreground: { type: "array", minItems: 1, items: id },
      },
    },
    fx: { type: "array", items: {
      type: "object", additionalProperties: false,
      required: ["fx_id", "type", "origin", "destination", "layer", "independently_movable"],
      properties: {
        fx_id: id, type: id, origin: { type: ["string", "null"], maxLength: 96 },
        destination: { type: ["string", "null"], maxLength: 96 },
        layer: { type: "string", enum: ["background", "midground", "foreground", "overlay"] },
        independently_movable: { type: "boolean" },
      },
    } },
    composition: {
      type: "object", additionalProperties: false,
      required: ["focal_point", "safe_zones", "negative_space", "text_safe_region"],
      properties: {
        focal_point: nonEmpty,
        safe_zones: { type: "array", minItems: 1, uniqueItems: true, items: id },
        negative_space: nonEmpty,
        text_safe_region: { anyOf: [
          { type: "null" },
          { type: "object", additionalProperties: false, required: ["x", "y", "width", "height"], properties: {
            x: { type: "number", minimum: 0, maximum: 1 }, y: { type: "number", minimum: 0, maximum: 1 },
            width: { type: "number", exclusiveMinimum: 0, maximum: 1 }, height: { type: "number", exclusiveMinimum: 0, maximum: 1 },
          } },
        ] },
      },
    },
    continuity: {
      type: "object", additionalProperties: false,
      required: ["previous_scene_dependencies", "persistent_assets", "state_changes"],
      properties: {
        previous_scene_dependencies: { type: "array", uniqueItems: true, items: id },
        persistent_assets: { type: "array", minItems: 1, uniqueItems: true, items: id },
        state_changes: { type: "array", items: nonEmpty },
      },
    },
    motion_ready: {
      type: "object", additionalProperties: false,
      required: ["independent_layers", "character_parts", "camera_motion", "requires_skeletal_animation"],
      properties: {
        independent_layers: { type: "array", minItems: 3, uniqueItems: true, items: id },
        character_parts: { type: "array", minItems: 6, uniqueItems: true, items: id },
        camera_motion: id,
        requires_skeletal_animation: { const: false },
      },
    },
    asset_specification_hash: { type: "string", pattern: "^[a-f0-9]{64}$" },
  },
};

const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true, validateFormats: false });
const validators = {
  world: ajv.compile(AV2_WORLD_MANIFEST_V1_SCHEMA),
  props: ajv.compile(AV2_PROP_REGISTRY_V1_SCHEMA),
  scene: ajv.compile(SCENE_ASSET_MANIFEST_V1_SCHEMA),
};

function result(validator, value) {
  const ok = validator(value);
  return {
    ok,
    errors: ok ? [] : validator.errors.map((error) => ({
      path: error.instancePath || "/", keyword: error.keyword, message: error.message,
    })),
  };
}

export const validateWorldManifest = (value) => result(validators.world, value);

export function validatePropRegistry(value) {
  const shape = result(validators.props, value);
  if (!shape.ok) return shape;
  const errors = [];
  const ids = new Set();
  value.props.forEach((prop, index) => {
    if (ids.has(prop.prop_id)) errors.push({ path: `/props/${index}/prop_id`, keyword: "unique", message: "duplicate prop_id" });
    ids.add(prop.prop_id);
  });
  value.count_locks.forEach((lock, index) => {
    if (lock.prop_ids.length !== lock.expected_count) {
      errors.push({ path: `/count_locks/${index}`, keyword: "count_lock", message: "prop_ids must match expected_count" });
    }
    if (lock.prop_ids.some((propId) => !ids.has(propId))) {
      errors.push({ path: `/count_locks/${index}/prop_ids`, keyword: "reference", message: "count lock references an unknown prop" });
    }
    if (lock.lock_id === "five_egg_lock") {
      const eggProps = value.props.filter((prop) => prop.type === "egg" && prop.countable);
      if (lock.expected_count !== 5 || eggProps.length !== 5 || eggProps.some((prop) => !lock.prop_ids.includes(prop.prop_id))) {
        errors.push({ path: `/count_locks/${index}`, keyword: "five_egg_lock", message: "registry must contain exactly the five locked egg props" });
      }
    }
  });
  return { ok: errors.length === 0, errors };
}

export function validateSceneAssetManifest(value) {
  const shape = result(validators.scene, value);
  if (!shape.ok) return shape;
  const errors = [];
  const propIds = new Set();
  value.props.forEach((prop, index) => {
    if (propIds.has(prop.prop_id)) errors.push({ path: `/props/${index}/prop_id`, keyword: "unique", message: "duplicate prop state" });
    propIds.add(prop.prop_id);
  });
  const characterIds = new Set();
  value.characters.forEach((character, index) => {
    if (characterIds.has(character.character_id)) errors.push({ path: `/characters/${index}/character_id`, keyword: "unique", message: "duplicate character state" });
    characterIds.add(character.character_id);
  });
  return { ok: errors.length === 0, errors };
}
