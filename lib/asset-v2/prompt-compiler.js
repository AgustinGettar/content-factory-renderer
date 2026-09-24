import { contentHash } from "../av2/contracts.js";
import { LUMI_CHARACTER_LOCK_V1 } from "./character-lock.js";
import {
  VISUAL_PROMPT_COMPILER_VERSION,
  validatePropRegistry,
  validateSceneAssetManifest,
  validateWorldManifest,
} from "./contracts.js";
import { AV2_VISUAL_FRAME_POLICY_V1 } from "./framing.js";

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
