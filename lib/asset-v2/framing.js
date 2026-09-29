export const AV2_VISUAL_FRAME_POLICY_V1 = Object.freeze({
  version: "av2-visual-frame-policy/1",
  aspect_ratio: "9:16",
  source: Object.freeze({ width: 1152, height: 2048, size: "1152x2048" }),
  final: Object.freeze({ width: 1080, height: 1920 }),
  // The source is native 9:16. Critical teaching action stays inside this
  // protected inset while scenery may extend to the full canvas.
  protected_safe_frame: Object.freeze({
    x: 0.0833333333,
    y: 0.0625,
    width: 0.8333333334,
    height: 0.875,
  }),
  transform: "proportional_downscale_no_crop_no_stretch",
  legacy_2_3_fallback: Object.freeze({
    source: Object.freeze({ width: 1024, height: 1536 }),
    crop: Object.freeze({ x: 80, y: 0, width: 864, height: 1536 }),
    final: Object.freeze({ width: 1080, height: 1920 }),
    transform: "center_crop_then_proportional_scale",
  }),
});

export function validateFramePolicy(policy = AV2_VISUAL_FRAME_POLICY_V1) {
  const sourceRatio = policy.source.width / policy.source.height;
  const finalRatio = policy.final.width / policy.final.height;
  if (Math.abs(sourceRatio - 9 / 16) > 1e-12 || Math.abs(finalRatio - 9 / 16) > 1e-12) {
    throw new Error("asset_v2_frame_policy_not_9_16");
  }
  if (policy.source.width % 16 !== 0 || policy.source.height % 16 !== 0) {
    throw new Error("asset_v2_provider_dimensions_not_multiple_of_16");
  }
  const safe = policy.protected_safe_frame;
  if (safe.x < 0 || safe.y < 0 || safe.width <= 0 || safe.height <= 0
      || safe.x + safe.width > 1 || safe.y + safe.height > 1) {
    throw new Error("asset_v2_safe_frame_invalid");
  }
  const fallback = policy.legacy_2_3_fallback;
  if (fallback.crop.width / fallback.crop.height !== 9 / 16
      || fallback.crop.x * 2 + fallback.crop.width !== fallback.source.width
      || fallback.crop.height !== fallback.source.height) {
    throw new Error("asset_v2_legacy_crop_invalid");
  }
  return true;
}

export function isInsideProtectedSafeFrame(box, policy = AV2_VISUAL_FRAME_POLICY_V1) {
  const safe = policy.protected_safe_frame;
  return box.x >= safe.x && box.y >= safe.y
    && box.x + box.width <= safe.x + safe.width
    && box.y + box.height <= safe.y + safe.height;
}
