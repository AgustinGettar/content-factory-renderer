import {
  contentHash,
  deriveContinuity,
  validateEpisodePlan,
} from "../av2/contracts.js";
import {
  LUMI_CHARACTER_LOCK_V1,
  assertCharacterState,
  characterIdentityHash,
} from "./character-lock.js";
import {
  ASSET_CACHE_VERSION,
  PROP_REGISTRY_VERSION,
  SCENE_ASSET_MANIFEST_VERSION,
  VISUAL_BENCHMARK_VERSION,
  WORLD_MANIFEST_VERSION,
  validatePropRegistry,
  validateSceneAssetManifest,
  validateWorldManifest,
} from "./contracts.js";

export const CANONICAL_AV2_ARTIFACT = Object.freeze({
  artifact_id: "090490f8-0e75-47ca-8a2c-5f3340c7f413",
  content_hash: "11f9f31566f2a9090dbbbaa97f9461c84563b9eb6868ad8630ba6a5824a2ea01",
});

const EGG_SOURCE_IDS = Object.freeze(["egg_1", "egg_2", "egg_3", "egg_4", "egg_5"]);
export const CANONICAL_EGG_IDS = Object.freeze(["egg_01", "egg_02", "egg_03", "egg_04", "egg_05"]);
const EGG_ID_MAP = new Map(EGG_SOURCE_IDS.map((source, index) => [source, CANONICAL_EGG_IDS[index]]));

function checked(value, validator, label) {
  const result = validator(value);
  if (!result.ok) throw new Error(`${label}_invalid:${JSON.stringify(result.errors)}`);
  return value;
}

function clone(value) {
  return structuredClone(value);
}

export function assertCanonicalArtifact(snapshot) {
  if (snapshot?.artifact_id !== CANONICAL_AV2_ARTIFACT.artifact_id) throw new Error("canonical_artifact_id_mismatch");
  if (snapshot?.content_hash !== CANONICAL_AV2_ARTIFACT.content_hash) throw new Error("canonical_artifact_hash_mismatch");
  if (!new Set(["valid", "accepted"]).has(snapshot?.status)) throw new Error("canonical_artifact_not_accepted");
  if (contentHash(snapshot.payload) !== snapshot.content_hash) throw new Error("canonical_artifact_payload_hash_mismatch");
  validateEpisodePlan(snapshot.payload);
  return true;
}

export function buildWorldManifest(snapshot) {
  assertCanonicalArtifact(snapshot);
  const sourceRef = snapshot.payload.episode.world_ref;
  return checked({
    version: WORLD_MANIFEST_VERSION,
    environment_id: "garden_world_01",
    source_ref: clone(sourceRef),
    geography: "One continuous gently curved garden path from the basket clearing past leaves, stone, grass and tree-trunk discovery landmarks.",
    landmarks: [
      "basket_clearing", "garden_path", "leaf_patch_01", "stone_marker_01",
      "grass_patch_01", "tree_trunk_01",
    ],
    lighting: {
      direction: "soft upper-left daylight, stable across every camera view",
      quality: "warm diffuse preschool-safe cinematic light with soft contact shadows",
      time_of_day: "clear gentle morning",
      reference: { id: "day_clear", version: "1.0" },
    },
    palette: ["warm_yellow", "mint_green", "soft_violet", "sky_blue", "cream"],
    layers: {
      background: [
        { asset_id: "garden_sky_01", description: "cream-blue sky gradient and distant rounded tree canopy", reusable: true, independently_movable: true },
        { asset_id: "garden_distant_path_01", description: "far continuation of the curved garden path", reusable: true, independently_movable: true },
      ],
      midground: [
        { asset_id: "garden_shrubs_01", description: "rounded shrubs and small flowers framing the path", reusable: true, independently_movable: true },
        { asset_id: "garden_tree_trunk_01", description: "stable tree-trunk landmark used by the fourth discovery", reusable: true, independently_movable: true },
      ],
      foreground: [
        { asset_id: "garden_leaves_01", description: "leaf cluster used by the first discovery", reusable: true, independently_movable: true },
        { asset_id: "garden_grass_01", description: "soft grass cluster used by the third discovery", reusable: true, independently_movable: true },
        { asset_id: "garden_stone_01", description: "rounded stone landmark used by the second discovery", reusable: true, independently_movable: true },
      ],
    },
    continuity_rules: [
      "Keep the curved path and all discovery landmarks in the same geographic order.",
      "Keep the basket clearing at the path start.",
      "Keep lighting direction upper-left and time of day unchanged.",
      "Keep the same palette and rounded material language in every camera view.",
      "Camera changes may reveal new angles but must not move landmarks.",
      "Foreground, midground and background remain separately compositable.",
    ],
  }, validateWorldManifest, "world_manifest");
}

export function buildPropRegistry(snapshot) {
  assertCanonicalArtifact(snapshot);
  const eggLocations = ["leaf_patch_01", "stone_marker_01", "grass_patch_01", "tree_trunk_01", "garden_path"];
  const eggs = EGG_SOURCE_IDS.map((sourceEntityId, index) => ({
    prop_id: CANONICAL_EGG_IDS[index],
    source_entity_id: sourceEntityId,
    type: "egg",
    appearance: "same warm ivory egg shell, rounded oval silhouette, identical material and canonical scale",
    scale: 1,
    state: "hidden",
    location: eggLocations[index],
    continuity_owner: snapshot.payload.episode.id,
    version: "egg-asset/1",
    countable: true,
  }));
  return checked({
    version: PROP_REGISTRY_VERSION,
    artifact_id: snapshot.artifact_id,
    props: [
      ...eggs,
      {
        prop_id: "basket_01", source_entity_id: "basket", type: "basket",
        appearance: "small rounded woven basket with a warm natural finish and stable handle",
        scale: 1, state: "visible", location: "basket_clearing",
        continuity_owner: snapshot.payload.episode.id, version: "basket-asset/1", countable: false,
      },
      {
        prop_id: "lumi_wand_01", source_entity_id: "wand", type: "magic_wand",
        appearance: LUMI_CHARACTER_LOCK_V1.magic_wand.design,
        scale: 1, state: "visible", location: "held_by_lumi",
        continuity_owner: "lumi", version: "lumi-wand/1", countable: false,
      },
    ],
    count_locks: [{
      lock_id: "five_egg_lock",
      type: "exact_prop_count",
      expected_count: 5,
      prop_ids: [...CANONICAL_EGG_IDS],
    }],
  }, validatePropRegistry, "prop_registry");
}

const expressionMap = Object.freeze({
  attentive: "focused", curious: "curious", surprised: "surprised_gentle",
  celebratory: "celebrating", encouraging: "encouraging", warm: "neutral_happy",
  concerned: "surprised_gentle",
});

function poseFor(actionId = "") {
  if (actionId === "face_camera") return { pose: "look_at_camera", custom_action_id: null };
  if (actionId === "gesture_count") return { pose: "counting", custom_action_id: null };
  if (actionId === "celebrate") return { pose: "celebrating", custom_action_id: null };
  if (actionId === "wave_wand") return { pose: "wand_cast", custom_action_id: null };
  if (actionId === "point") return { pose: "pointing_right", custom_action_id: null };
  if (actionId === "nod") return { pose: "listening", custom_action_id: null };
  if (actionId.startsWith("walk_to_")) return { pose: "walk", custom_action_id: null };
  if (actionId.startsWith("look_")) return { pose: "look_at_prop", custom_action_id: null };
  if (actionId.startsWith("spot_")) return { pose: "look_at_prop", custom_action_id: null };
  if (actionId === "pick_up") return { pose: "pointing_down", custom_action_id: null };
  if (actionId === "place_eggs_in_basket") return { pose: "presenting", custom_action_id: null };
  if (actionId === "tap") return { pose: "wand_point", custom_action_id: null };
  return actionId ? { pose: "custom", custom_action_id: actionId } : { pose: "idle", custom_action_id: null };
}

function characterFor(scene, entityId) {
  const placement = scene.stage.placements.find((entry) => entry.entity_id === entityId && entry.visible);
  // The manifest represents the scene's focal/key pose. Earlier actions remain
  // authoritative in AV2; the last action for a character is the visual payoff
  // state used to prepare the reusable asset.
  const action = scene.actions.filter((entry) => entry.entity_id === entityId).at(-1);
  const pose = poseFor(action?.action_id);
  const isLumi = entityId === "lumi";
  const mappedExpression = expressionMap[action?.expression];
  if (isLumi && action?.expression && !mappedExpression) throw new Error(`unsupported_lumi_expression:${action.expression}`);
  const state = {
    character_id: entityId,
    ...pose,
    expression: isLumi ? (mappedExpression || "neutral_happy") : (action?.expression || "neutral_happy").replaceAll(" ", "_"),
    gaze: action?.gaze_target || scene.camera.subjects[0] || "camera",
    screen_position: placement?.transform?.position_m || [0, 0, 0],
    scale: placement?.transform?.scale?.[0] || 1,
    layer: placement?.layer || "midground",
    wand_state: !isLumi ? "not_visible" : action?.action_id === "wave_wand" ? "casting" : action?.action_id?.includes("point") ? "pointing" : "held_idle",
    wing_state: isLumi ? (action?.action_id?.startsWith("walk") ? "flutter_ready" : "open") : "not_visible",
    body_orientation: `rotation_deg:${(placement?.transform?.rotation_deg || [0, 0, 0]).join(",")}`,
    motion_parts: isLumi
      ? ["body", "wand", "wings", "eyes", "mouth", "left_arm", "right_arm"]
      : ["body", "eyes", "mouth"],
  };
  if (isLumi) assertCharacterState(state);
  return state;
}

function sourcePlacement(scene, sourceEntityId) {
  return scene.stage.placements.find((entry) => entry.entity_id === sourceEntityId);
}

function propStateFor(scene, snapshotBefore, snapshotAfter, registryEntry) {
  const placement = sourcePlacement(scene, registryEntry.source_entity_id);
  const collectedBefore = new Set(snapshotBefore.collected_eggs || []);
  const collectedAfter = new Set(snapshotAfter.collected_eggs || []);
  const isEgg = EGG_ID_MAP.has(registryEntry.source_entity_id);
  const finalBasketAction = scene.actions.find((action) => action.action_id === "place_eggs_in_basket");
  let state = registryEntry.state;
  if (isEgg) {
    if (finalBasketAction?.parameters?.eggs?.includes(registryEntry.source_entity_id)) state = "inside_basket";
    else if (placement?.visible && collectedAfter.has(registryEntry.source_entity_id)) state = "found";
    else if (collectedBefore.has(registryEntry.source_entity_id)) state = "grouped";
    else if (placement?.visible) state = "visible";
    else state = "hidden";
  } else if (registryEntry.type === "magic_wand") {
    state = scene.actions.some((action) => action.entity_id === "lumi") ? "visible" : "hidden";
  } else state = placement?.visible ? "visible" : "hidden";
  const visible = state === "inside_basket" || state === "visible" || Boolean(placement?.visible);
  return {
    prop_id: registryEntry.prop_id,
    state,
    visible,
    position: placement?.transform?.position_m || [0, 0, 0],
    scale: placement?.transform?.scale?.[0] || registryEntry.scale,
    layer: placement?.layer || (registryEntry.type === "magic_wand" ? "midground" : "foreground"),
    independently_movable: true,
  };
}

function fxFor(scene) {
  const fx = scene.effects.map((effect) => ({
    fx_id: effect.id,
    type: effect.type,
    origin: effect.origin || null,
    destination: effect.destination || null,
    layer: "overlay",
    independently_movable: true,
  }));
  scene.actions.forEach((action) => {
    if (action.parameters?.sparkle && !fx.some((entry) => entry.origin === action.entity_id)) {
      fx.push({
        fx_id: `${action.id}_particles`, type: "magic_particles", origin: "lumi_wand_01",
        destination: action.gaze_target || null, layer: "overlay", independently_movable: true,
      });
    }
  });
  return fx;
}

function manifestHash(manifest) {
  const copy = clone(manifest);
  delete copy.asset_specification_hash;
  return contentHash(copy);
}

export function buildSceneAssetManifest({ snapshot, sceneId, worldManifest, propRegistry }) {
  assertCanonicalArtifact(snapshot);
  const plan = snapshot.payload;
  const sceneIndex = plan.scenes.findIndex((scene) => scene.id === sceneId);
  if (sceneIndex < 0) throw new Error(`unknown_scene:${sceneId}`);
  const scene = plan.scenes[sceneIndex];
  const continuity = deriveContinuity(plan);
  const continuitySnapshot = continuity.snapshots[sceneIndex];
  const characterIds = [...new Set([
    ...scene.stage.placements.filter((entry) => entry.visible).map((entry) => entry.entity_id),
    ...scene.actions.map((entry) => entry.entity_id),
  ])].filter((entityId) => plan.entities.some((entity) => entity.id === entityId && ["character", "animal"].includes(entity.kind)));
  if (!characterIds.includes("lumi")) characterIds.unshift("lumi");
  const characters = characterIds.map((entityId) => characterFor(scene, entityId));
  const props = propRegistry.props.map((entry) => propStateFor(
    scene, continuitySnapshot.continuity_in, continuitySnapshot.continuity_out, entry,
  ));
  const previousScene = plan.scenes[sceneIndex - 1];
  const manifest = {
    version: SCENE_ASSET_MANIFEST_VERSION,
    artifact_id: snapshot.artifact_id,
    artifact_content_hash: snapshot.content_hash,
    scene_id: scene.id,
    scene_index: sceneIndex,
    environment_id: worldManifest.environment_id,
    source_scene_hash: contentHash(scene),
    camera: {
      shot_type: scene.camera.shot,
      framing: scene.camera.framing.intent,
      angle: scene.camera.from.position_m[1] >= 2 ? "slightly_high_eye_level" : "eye_level",
      target: [...scene.camera.subjects],
      movement: scene.camera.move,
      depth_plan: {
        foreground: "narrative props and near garden foliage remain separately compositable",
        midground: "Lumi, secondary character and active educational objects",
        background: "locked garden geography with moderate depth of field",
        focus_plane: scene.camera.subjects.join("+") || "lumi",
      },
      aspect_ratio: "9:16",
    },
    characters,
    props,
    world_layers: {
      background: worldManifest.layers.background.map((entry) => entry.asset_id),
      midground: worldManifest.layers.midground.map((entry) => entry.asset_id),
      foreground: worldManifest.layers.foreground.map((entry) => entry.asset_id),
    },
    fx: fxFor(scene),
    composition: {
      focal_point: scene.camera.framing.intent,
      safe_zones: [scene.camera.framing.safe_region, "face_safe", "action_safe"],
      negative_space: "protect the upper caption band and keep Lumi's eyes and hands clear",
      text_safe_region: { x: 0.1, y: 0.04, width: 0.8, height: 0.15 },
    },
    continuity: {
      previous_scene_dependencies: previousScene ? [previousScene.id] : [],
      persistent_assets: [
        worldManifest.environment_id, "lumi", "gallina_amable", "basket_01", "lumi_wand_01", ...CANONICAL_EGG_IDS,
      ],
      state_changes: scene.continuity.operations.map((operation) => `${operation.op}:${operation.path}:${JSON.stringify(operation.value)}`),
    },
    motion_ready: {
      independent_layers: [
        "background", "midground", "foreground", "lumi", "lumi_wand_01",
        "lumi_wings", "educational_props", "magic_particles", "camera",
      ],
      character_parts: ["body", "wand", "wings", "eyes", "mouth", "left_arm", "right_arm"],
      camera_motion: scene.camera.move,
      requires_skeletal_animation: false,
    },
    asset_specification_hash: "",
  };
  manifest.asset_specification_hash = manifestHash(manifest);
  return checked(manifest, validateSceneAssetManifest, `scene_asset_manifest_${scene.id}`);
}

export function assetCacheKey({ manifest, worldManifest, propRegistry, characterLock = LUMI_CHARACTER_LOCK_V1 }) {
  return contentHash({
    cache_version: ASSET_CACHE_VERSION,
    character_lock_version: characterLock.version,
    character_identity_hash: characterIdentityHash(characterLock),
    environment_version: `${worldManifest.source_ref.id}@${worldManifest.source_ref.version}`,
    environment_manifest_hash: contentHash(worldManifest),
    prop_registry_version: propRegistry.version,
    prop_registry_hash: contentHash(propRegistry),
    asset_specification_hash: manifest.asset_specification_hash,
  });
}

export function buildVisualBenchmark(snapshot) {
  assertCanonicalArtifact(snapshot);
  const beforeHash = contentHash(snapshot.payload);
  const worldManifest = buildWorldManifest(snapshot);
  const propRegistry = buildPropRegistry(snapshot);
  const roles = [
    { role: "establishing_world", scene_id: "s11" },
    { role: "close_interaction_counting", scene_id: "s17" },
    { role: "magic_discovery_reward", scene_id: "s12" },
  ];
  const scenes = roles.map(({ role, scene_id }) => {
    const manifest = buildSceneAssetManifest({ snapshot, sceneId: scene_id, worldManifest, propRegistry });
    return { role, scene_id, manifest, cache_key: assetCacheKey({ manifest, worldManifest, propRegistry }) };
  });
  if (contentHash(snapshot.payload) !== beforeHash) throw new Error("asset_engine_mutated_av2_source");
  return {
    version: VISUAL_BENCHMARK_VERSION,
    source: {
      artifact_id: snapshot.artifact_id,
      content_hash: snapshot.content_hash,
      episode_schema_version: snapshot.episode_schema_version,
      scene_schema_version: snapshot.scene_schema_version,
    },
    character_lock: LUMI_CHARACTER_LOCK_V1,
    world_manifest: worldManifest,
    prop_registry: propRegistry,
    scenes,
  };
}
