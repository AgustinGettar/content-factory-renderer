import crypto from "node:crypto";

export const LUMI_CHARACTER_LOCK_VERSION = "lumi-character-lock/1";

export const LUMI_EXPRESSION_VOCABULARY = Object.freeze([
  "neutral_happy",
  "excited",
  "curious",
  "thinking",
  "surprised_gentle",
  "encouraging",
  "celebrating",
  "questioning",
  "focused",
  "proud",
]);

export const LUMI_POSE_VOCABULARY = Object.freeze([
  "idle",
  "presenting",
  "pointing_left",
  "pointing_right",
  "pointing_down",
  "wand_point",
  "wand_cast",
  "counting",
  "listening",
  "celebrating",
  "lean_in",
  "look_at_prop",
  "look_at_camera",
  "walk",
  "small_hop",
  "custom",
]);

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  Object.values(value).forEach(deepFreeze);
  return value;
}

// Identity evidence is split from scene state. The storage reference is the
// original identity master; the local transparent PNGs are approved state
// derivatives used by the current renderer, not alternative character designs.
export const LUMI_CHARACTER_LOCK_V1 = deepFreeze({
  version: LUMI_CHARACTER_LOCK_VERSION,
  character_id: "lumi",
  canonical_lumi_reference: {
    role: "identity_master",
    storage_bucket: "characters",
    object_path: "lumi-reference.png",
    pixel_size: { width: 1122, height: 1402 },
    sha256: "9216398a13f8baac4ddae2d80718997248fbce9a9bef9a61e6be2c409f797c00",
  },
  approved_state_references: [
    {
      role: "open_eyes_with_wand",
      path: "assets/lumi-canonical-wand.png",
      pixel_size: { width: 561, height: 701 },
      sha256: "77d1b42c07a3de6a3845ae7674bc3637b79d9d1c373959c736ed984656646b17",
    },
    {
      role: "blink_with_wand",
      path: "assets/lumi-canonical-wand-blink.png",
      pixel_size: { width: 561, height: 701 },
      sha256: "ae8ecb4886b88e9ec0bff6f178b70839037f0f8698e977d4953d225c09a0c5fd",
    },
  ],
  identity: {
    species_role: "original fairy-firefly preschool teacher",
    personality: ["warm", "magical", "encouraging", "curious", "safe"],
    apparent_age: "ageless friendly young teacher",
  },
  body: {
    color: "warm luminous yellow",
    silhouette: "rounded firefly body with a large rounded head and compact child-friendly limbs",
    proportions: "large head, short torso, short rounded limbs, stable preschool-readable silhouette",
  },
  face: {
    eyes: "two very large turquoise oval eyes with dark pupils, white catchlights and soft lashes",
    eye_color: "turquoise",
    cheeks: "two soft round pink cheeks",
    smile: "wide gentle curved smile with a small rounded mouth",
    eyebrows: "thin warm-brown expressive arcs",
    mouth_placement: "centered low on face below the nose mark",
  },
  head: {
    antennae_count: 2,
    antennae: "two thin warm-brown antennae with rounded violet tips",
    hair: "one small three-point yellow tuft",
  },
  wings: {
    count: 2,
    appearance: "small symmetric translucent light-blue teardrop wings with subtle pale veins",
    placement: "paired behind upper torso, one per side",
  },
  clothing: {
    garment: "light-blue denim-style overalls",
    straps: 2,
    details: "two round yellow buttons, centered front pocket, rolled cuffs",
  },
  shoes: {
    type: "rounded white preschool sneakers",
    details: "light-blue side and sole accents",
  },
  magic_wand: {
    id: "lumi_wand_v1",
    design: "short violet handle with a rounded yellow five-point star tip and warm inner glow",
    proportions: "short enough for one-handed child-friendly use",
    trail: "small white, yellow and violet magical particles following the star tip",
  },
  style: {
    direction: "premium stylized children's animation",
    surfaces: "smooth rounded surfaces with soft material response",
    lighting: "soft cinematic preschool lighting",
    readability: "clean silhouette, large readable expression, no facial clutter",
  },
  negative_invariants: [
    "body color must not change",
    "eye color must remain turquoise",
    "exactly two antennae",
    "exactly two wings",
    "overalls and sneakers must not change",
    "apparent age, species and core proportions must not change",
    "no extra or malformed limbs, hands or fingers",
    "wand design must remain lumi_wand_v1",
    "never human, photorealistic, creepy or uncanny",
    "no broken facial anatomy",
  ],
  state_contract: {
    mutable: [
      "pose", "expression", "gaze", "mouth_state", "hand_gesture",
      "wand_position", "wing_pose", "body_orientation", "camera_facing_angle",
    ],
    expressions: LUMI_EXPRESSION_VOCABULARY,
    poses: LUMI_POSE_VOCABULARY,
  },
});

export function characterIdentityHash(lock = LUMI_CHARACTER_LOCK_V1) {
  const canonical = (value) => {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  };
  const stable = canonical(lock);
  return crypto.createHash("sha256").update(stable).digest("hex");
}

export function assertCharacterState(state, lock = LUMI_CHARACTER_LOCK_V1) {
  if (!state || state.character_id !== lock.character_id) throw new Error("character_state_wrong_identity");
  if (!lock.state_contract.expressions.includes(state.expression)) throw new Error("character_state_expression_invalid");
  if (!lock.state_contract.poses.includes(state.pose)) throw new Error("character_state_pose_invalid");
  if (state.pose === "custom" && !String(state.custom_action_id || "").trim()) throw new Error("character_state_custom_action_missing");
  return true;
}
