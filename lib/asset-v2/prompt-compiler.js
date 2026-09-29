import { contentHash } from "../av2/contracts.js";
import { LUMI_CHARACTER_LOCK_V1 } from "./character-lock.js";
import {
  VISUAL_PROMPT_COMPILER_VERSION,
  validatePropRegistry,
  validateSceneAssetManifest,
  validateWorldManifest,
} from "./contracts.js";
import { AV2_VISUAL_FRAME_POLICY_V1 } from "./framing.js";
import {
  VISUAL_PROMPT_COMPILER_V11_VERSION,
  validateComposition,
} from "./visual-benchmark-v11.js";

export const PREMIUM_PRESCHOOL_ART_DIRECTION_V1 = Object.freeze({
  id: "premium_preschool_stylized_animation",
  version: "1",
  positive: [
    "original premium stylized children's animation",
    "rounded forms and soft tactile materials",
    "vivid but pleasant preschool-safe colors",
    "soft cinematic child-friendly lighting",
    "clear foreground, midground and background depth",
    "populated living environment without facial clutter",
    "large readable expressions and professional staging",
    "moderate depth of field and motion-ready separated layers",
  ],
  negative: [
    "no copied third-party character, frame, logo or asset",
    "no photorealism, horror, uncanny anatomy or harsh dramatic shadow",
    "no generated text, letters, numbers, logo, signature or watermark",
    "no accidental crop of Lumi, teaching props, wings, antennae or wand",
  ],
});

function list(values) {
  return values.join("; ");
}

function benchmarkObjective(role) {
  if (role === "establishing_world") return "WORLD PROOF: show rich garden_world_01 geography, all three depth planes and stable landmarks; Lumi is integrated at modest scale and must not dominate more than roughly one third of the frame.";
  if (role === "close_interaction_counting") return "COUNTING PROOF: show exactly five clearly separated ivory eggs and no egg-like decoys; Lumi's face, gaze and presenting/counting gesture make one-to-one counting immediately legible to a preschool child.";
  if (role === "magic_discovery_reward") return "MAGIC PROOF: preserve the canonical wand, readable Lumi acting and one visible egg; premium particles and their light interaction must not obscure Lumi's face, hands, wand or the egg.";
  return "Render the canonical scene state without inventing narrative content.";
}

function stablePromptSections({ characterLock, manifest, worldManifest, propRegistry, artDirection, benchmarkRole }) {
  const visibleProps = manifest.props.filter((prop) => prop.visible);
  const hiddenProps = manifest.props.filter((prop) => !prop.visible);
  const registryById = new Map((propRegistry?.props || []).map((prop) => [prop.prop_id, prop]));
  return [
    {
      name: "GLOBAL_ART_DIRECTION",
      text: `${list(artDirection.positive)}. Produce one complete benchmark composite in exact portrait 9:16 at ${AV2_VISUAL_FRAME_POLICY_V1.source.size}; the final delivery is a proportional downscale to 1080x1920 with no crop or stretch.`,
    },
    {
      name: "REFERENCE_HIERARCHY",
      text: "Priority is immutable: the attached canonical Lumi visual reference first; LUMI_CHARACTER_LOCK_V1 second; approved Lumi derived assets third; scene state fourth; art direction fifth. Lower-priority instructions must never contradict a higher-priority identity source.",
    },
    {
      name: "CHARACTER_LOCK",
      text: [
        characterLock.identity.species_role,
        characterLock.body.color,
        characterLock.body.silhouette,
        characterLock.face.eyes,
        characterLock.face.cheeks,
        characterLock.head.antennae,
        characterLock.head.hair,
        characterLock.wings.appearance,
        `${characterLock.clothing.garment}; ${characterLock.clothing.details}`,
        `${characterLock.shoes.type}; ${characterLock.shoes.details}`,
        characterLock.magic_wand.design,
      ].join(". "),
    },
    {
      name: "ENVIRONMENT_LOCK",
      text: `${worldManifest.environment_id}: ${worldManifest.geography} Landmarks: ${list(worldManifest.landmarks)}. Lighting: ${worldManifest.lighting.direction}; ${worldManifest.lighting.quality}. Palette: ${list(worldManifest.palette)}.`,
    },
    {
      name: "BENCHMARK_OBJECTIVE",
      text: benchmarkObjective(benchmarkRole),
    },
    {
      name: "PROP_LOCK",
      text: visibleProps.map((entry) => {
        const definition = registryById.get(entry.prop_id);
        return definition
          ? `${entry.prop_id}: ${definition.appearance}; canonical scale=${definition.scale}; current state=${entry.state}`
          : `${entry.prop_id}: current state=${entry.state}`;
      }).join("; ") || "No visible narrative props in this scene.",
    },
    {
      name: "SCENE_STATE",
      text: `Scene ${manifest.scene_id}. Characters: ${manifest.characters.map((entry) => `${entry.character_id} pose=${entry.pose}${entry.custom_action_id ? `(${entry.custom_action_id})` : ""}, expression=${entry.expression}, gaze=${entry.gaze}, wand=${entry.wand_state}, wings=${entry.wing_state}, position=${entry.screen_position.join("/")}`).join("; ")}. Visible props: ${visibleProps.map((entry) => `${entry.prop_id}:${entry.state}@${entry.position.join("/")}`).join("; ") || "none"}. Do not render hidden props: ${hiddenProps.map((entry) => entry.prop_id).join(", ") || "none"}. FX: ${manifest.fx.map((entry) => `${entry.type}:${entry.origin || "environment"}->${entry.destination || "none"}`).join("; ") || "none"}.`,
    },
    {
      name: "CAMERA_COMPOSITION",
      text: `${manifest.camera.shot_type} shot, ${manifest.camera.angle}, ${manifest.camera.movement}; target ${list(manifest.camera.target)}; framing intent ${manifest.camera.framing}. Focal point: ${manifest.composition.focal_point}. Keep ${list(manifest.composition.safe_zones)} and ${manifest.composition.negative_space}. Keep Lumi's face, relevant body and hands, wand, every visible egg and the teaching action fully inside normalized protected safe frame x=${AV2_VISUAL_FRAME_POLICY_V1.protected_safe_frame.x}, y=${AV2_VISUAL_FRAME_POLICY_V1.protected_safe_frame.y}, width=${AV2_VISUAL_FRAME_POLICY_V1.protected_safe_frame.width}, height=${AV2_VISUAL_FRAME_POLICY_V1.protected_safe_frame.height}. Scenery may extend to the canvas edge.`,
    },
    {
      name: "LAYER_DELIVERY",
      text: `This quality proof is one composite, but stage background, midground, foreground, characters, props and FX with clear visual separation for later 2.5D extraction. Future movable parts: ${list(manifest.motion_ready.independent_layers)}.`,
    },
    {
      name: "NEGATIVE_CONSTRAINTS",
      text: `${list(characterLock.negative_invariants)}; ${list(artDirection.negative)}. Metadata IDs are not visible labels: render no text, letters, numbers, logos, signatures or watermarks. Do not add oval objects that could be mistaken for eggs.`,
    },
  ];
}

export function compileVisualPrompt({
  characterLock = LUMI_CHARACTER_LOCK_V1,
  sceneState,
  worldManifest,
  assetManifest = sceneState,
  propRegistry = null,
  benchmarkRole = null,
  artDirection = PREMIUM_PRESCHOOL_ART_DIRECTION_V1,
}) {
  const manifestResult = validateSceneAssetManifest(assetManifest);
  if (!manifestResult.ok) throw new Error(`visual_prompt_manifest_invalid:${JSON.stringify(manifestResult.errors)}`);
  const worldResult = validateWorldManifest(worldManifest);
  if (!worldResult.ok) throw new Error(`visual_prompt_world_invalid:${JSON.stringify(worldResult.errors)}`);
  if (characterLock.character_id !== "lumi" || characterLock.version !== LUMI_CHARACTER_LOCK_V1.version) {
    throw new Error("visual_prompt_character_lock_not_canonical");
  }
  if (propRegistry) {
    const propResult = validatePropRegistry(propRegistry);
    if (!propResult.ok) throw new Error(`visual_prompt_prop_registry_invalid:${JSON.stringify(propResult.errors)}`);
  }
  if (assetManifest.environment_id !== worldManifest.environment_id) throw new Error("visual_prompt_environment_mismatch");
  const sections = stablePromptSections({
    characterLock, manifest: assetManifest, worldManifest, propRegistry, artDirection, benchmarkRole,
  });
  const text = sections.map((section) => `[${section.name}]\n${section.text}`).join("\n\n");
  return {
    compiler_version: VISUAL_PROMPT_COMPILER_VERSION,
    character_lock_version: characterLock.version,
    world_manifest_version: worldManifest.version,
    scene_asset_manifest_version: assetManifest.version,
    scene_id: assetManifest.scene_id,
    sections,
    text,
    prompt_hash: contentHash({
      compiler_version: VISUAL_PROMPT_COMPILER_VERSION,
      character_lock_version: characterLock.version,
      world_manifest_version: worldManifest.version,
      prop_registry_version: propRegistry?.version || null,
      benchmark_role: benchmarkRole,
      asset_specification_hash: assetManifest.asset_specification_hash,
      art_direction: artDirection,
      sections,
    }),
  };
}

function normalizedBox(bounds) {
  const right = bounds.x + bounds.width;
  const bottom = bounds.y + bounds.height;
  return `x=${bounds.x.toFixed(2)}..${right.toFixed(2)}, y=${bounds.y.toFixed(2)}..${bottom.toFixed(2)}`;
}

export function compileVisualPromptV11({
  manifest,
  worldManifest,
  propRegistry,
  characterLock = LUMI_CHARACTER_LOCK_V1,
  artDirection = PREMIUM_PRESCHOOL_ART_DIRECTION_V1,
}) {
  const preflight = validateComposition(manifest);
  if (!preflight.ok) throw new Error(`visual_prompt_v11_preflight_failed:${JSON.stringify(preflight.errors)}`);
  const baseResult = validateSceneAssetManifest(manifest.base_manifest);
  if (!baseResult.ok) throw new Error(`visual_prompt_v11_base_manifest_invalid:${JSON.stringify(baseResult.errors)}`);
  const worldResult = validateWorldManifest(worldManifest);
  if (!worldResult.ok) throw new Error(`visual_prompt_v11_world_invalid:${JSON.stringify(worldResult.errors)}`);
  const propResult = validatePropRegistry(propRegistry);
  if (!propResult.ok) throw new Error(`visual_prompt_v11_props_invalid:${JSON.stringify(propResult.errors)}`);
  if (characterLock.character_id !== "lumi" || characterLock.version !== LUMI_CHARACTER_LOCK_V1.version) {
    throw new Error("visual_prompt_v11_character_lock_not_canonical");
  }
  const base = manifest.base_manifest;
  const contract = manifest.composition_contract;
  const visibleProps = base.props.filter((entry) => entry.visible);
  const hiddenProps = base.props.filter((entry) => !entry.visible);
  const tree = manifest.landmark_lock.landmarks.find((entry) => entry.landmark_id === "tree_trunk_01");
  const entityText = contract.required_visual_entities.map((entry) => [
    `${entry.entity_id} (${entry.entity_type}, ${entry.importance})`,
    `REQUIRED and fully visible`,
    `region=${entry.screen_region}`,
    `box=${normalizedBox(entry.bounds)}`,
    `scale=${entry.relative_scale}`,
    `relationship=${entry.relationship_to_focal_point}`,
    `occlusion=${entry.occlusion_policy}`,
  ].join(", ")).join("; ");
  const sections = [
    {
      name: "REFERENCE_HIERARCHY",
      text: "Image 1 is the canonical Lumi identity master and is authoritative for Lumi. Image 2 is approved s11 evidence for garden_world_01 only: use its world materials, palette, lighting, path and persistent tree landmark; do not copy its framing or introduce its basket/chicken unless this scene requires them. Priority: canonical Lumi reference, Character Lock, approved world evidence and Landmark Lock, then Scene Manifest.",
    },
    {
      name: "1_CHARACTER_IDENTITY",
      text: `${characterLock.identity.species_role}; ${characterLock.body.color}; ${characterLock.body.silhouette}; ${characterLock.face.eyes}; ${characterLock.face.cheeks}; ${characterLock.head.antennae}; ${characterLock.head.hair}; ${characterLock.wings.appearance}; ${characterLock.clothing.garment}; ${characterLock.clothing.details}; ${characterLock.shoes.type}; ${characterLock.shoes.details}; ${characterLock.magic_wand.design}. Physical proportion lock: ${manifest.character_scale_lock.head_to_body_ratio}; ${manifest.character_scale_lock.eye_to_face_ratio}; ${manifest.character_scale_lock.body_volume}; ${manifest.character_scale_lock.limb_proportions}. Camera distance may change screen size, never physical proportions.`,
    },
    {
      name: "2_REQUIRED_ENTITIES_COUNTS",
      text: `${entityText}. Count locks: ${contract.exact_count_locks.map((lock) => `exactly ${lock.expected_count} ${lock.entity_type}: ${lock.entity_ids.join(", ")}`).join("; ")}. Required entities outrank decoration; omit decorative elements before omitting or moving a required entity.`,
    },
    {
      name: "3_PEDAGOGICAL_ACTION",
      text: `Scene ${base.scene_id}: ${benchmarkObjective(base.scene_id === "s17" ? "close_interaction_counting" : "magic_discovery_reward")} Focal chain: ${contract.focal_relationship.join(" -> ")}. Characters: ${base.characters.map((entry) => `${entry.character_id} pose=${entry.pose}, expression=${entry.expression}, gaze=${entry.gaze}`).join("; ")}. Visible props: ${visibleProps.map((entry) => `${entry.prop_id}:${entry.state}`).join("; ")}. Hidden props must remain absent: ${hiddenProps.map((entry) => entry.prop_id).join(", ") || "none"}.`,
    },
    {
      name: "4_SAFE_COMPOSITION",
      text: `Exact canvas 1152x2048 (9:16), final proportional 1080x1920, no crop and no stretch. Critical safe frame is x=${contract.safe_frame.normalized.x}..${(contract.safe_frame.normalized.x + contract.safe_frame.normalized.width).toFixed(10)}, y=${contract.safe_frame.normalized.y}..${(contract.safe_frame.normalized.y + contract.safe_frame.normalized.height).toFixed(4)}. Every required entity and its full silhouette must remain inside its assigned normalized box and the safe frame. Required camera subjects: ${contract.required_camera_subjects.join(", ")}. No critical overlaps. ${contract.fx_policy || "No FX may obscure required faces, hands, wand or pedagogical props."}`,
    },
    {
      name: "5_WORLD_CONTINUITY",
      text: `${worldManifest.environment_id}: ${worldManifest.geography}. Tree lock: ${tree.canonical_appearance}; ${tree.geometry}; ${tree.material}; location=${tree.relative_location}; persistent=${tree.persistent_features.join(", ")}; forbidden=${tree.forbidden_drift.join(", ")}. Lighting=${worldManifest.lighting.direction}; ${worldManifest.lighting.quality}. Palette=${list(worldManifest.palette)}.`,
    },
    {
      name: "6_CAMERA",
      text: `${base.camera.shot_type} shot, ${base.camera.angle}, ${base.camera.movement}; framing=${base.camera.framing}; focus=${base.camera.depth_plan.focus_plane}. Keep the interaction readable at preschool viewing size.`,
    },
    {
      name: "7_MAGIC_FX",
      text: base.fx.length ? base.fx.map((entry) => `${entry.type}: ${entry.origin || "environment"} -> ${entry.destination || "none"}, subordinate to faces and educational props`).join("; ") : "No magic FX; preserve clear counting readability.",
    },
    {
      name: "8_DECORATIVE_DETAIL",
      text: `${list(artDirection.positive)}. Background, midground and foreground remain rich and separable, but decorative detail is lowest priority and must never displace required entities, counts or safe composition.`,
    },
    {
      name: "NEGATIVE_CONSTRAINTS",
      text: `${list(characterLock.negative_invariants)}; ${list(artDirection.negative)}. No generated text, letters, numbers, logo, signature or watermark. Do not add oval objects that could be mistaken for eggs. Do not turn the locked tree door into a hollow or remove its circular blue four-pane window.`,
    },
  ];
  const text = sections.map((section) => `[${section.name}]\n${section.text}`).join("\n\n");
  return {
    compiler_version: VISUAL_PROMPT_COMPILER_V11_VERSION,
    character_lock_version: characterLock.version,
    world_manifest_version: worldManifest.version,
    scene_asset_manifest_version: manifest.version,
    scene_id: base.scene_id,
    sections,
    text,
    prompt_hash: contentHash({
      compiler_version: VISUAL_PROMPT_COMPILER_V11_VERSION,
      character_lock_version: characterLock.version,
      world_manifest_hash: contentHash(worldManifest),
      prop_registry_hash: contentHash(propRegistry),
      asset_specification_hash: manifest.asset_specification_hash,
      sections,
    }),
  };
}
