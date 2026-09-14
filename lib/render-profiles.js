export const RENDER_PROFILES = Object.freeze({
  preview: Object.freeze({ name: "Vista previa LD", width: 360, height: 640, fps: 30, crf: 30, audioBitrate: "96k" }),
  final: Object.freeze({ name: "Full HD", width: 1080, height: 1920, fps: 30, crf: 18, audioBitrate: "128k" }),
});

export function renderProfile(stage) {
  if (!Object.hasOwn(RENDER_PROFILES, stage)) throw new Error("Unknown render stage");
  return RENDER_PROFILES[stage];
}

export function isApprovedFinal(video, review) {
  return Boolean(
    video &&
    ["rendered", "approved"].includes(video.status) &&
    video.render_stage === "final" &&
    video.render_url &&
    video.final_revision === video.content_revision &&
    video.approved_revision === video.content_revision &&
    review?.verdict === "approved" &&
    review.content_revision === video.content_revision
  );
}

export function validateManifest(video, manifest) {
  if (manifest?.version !== "ld-hd-v1" || manifest.revision !== video.content_revision) {
    throw new Error("El contenido cambió. Generá y aprobá una nueva vista previa.");
  }
  if (manifest.aspect_ratio !== "9:16") throw new Error("Este render admite videos verticales 9:16.");
  if (!Array.isArray(manifest.scenes) || manifest.scenes.length < 1 || manifest.scenes.length > 30) {
    throw new Error("El video debe tener entre 1 y 30 escenas.");
  }
  let previous = 0;
  for (const scene of manifest.scenes) {
    if (!Number.isInteger(scene.scene_number) || scene.scene_number <= previous || !scene.image_url || !scene.audio_url) {
      throw new Error("Las escenas están incompletas o desordenadas.");
    }
    if (video.render_stage === "final" &&
        (!/^[a-f0-9]{64}$/.test(scene.image_sha256 || "") || !/^[a-f0-9]{64}$/.test(scene.audio_sha256 || ""))) {
      throw new Error("La vista previa no tiene recursos verificados. Revisá una nueva vista previa.");
    }
    previous = scene.scene_number;
  }
  if (video.render_stage === "final" && video.approved_revision !== video.content_revision) {
    throw new Error("El render HD necesita aprobación de esta versión.");
  }
  return manifest;
}

export function verifyAssetHash(expected, actual, label) {
  if (expected && expected !== actual) {
    throw new Error("El recurso aprobado cambió (" + label + "). Se requiere una nueva vista previa.");
  }
}

export function sceneFilters(profile, showText, fontPath, textPath) {
  const ratio = profile.width / 1080;
  const px = (value) => Math.round(value * ratio);
  const filters = [
    "scale=" + profile.width + ":" + profile.height + ":force_original_aspect_ratio=increase",
    "crop=" + profile.width + ":" + profile.height,
    "setsar=1",
  ];
  if (showText) {
    filters.push(
      "drawbox=x=" + px(60) + ":y=ih-" + px(500) + ":w=iw-" + px(120) + ":h=" + px(300) + ":color=black@0.35:t=fill",
      "drawtext=fontfile='" + fontPath + "':textfile='" + textPath + "':expansion=none:fontcolor=white:fontsize=" + px(72) +
      ":line_spacing=" + px(18) + ":x=(main_w-text_w)/2:y=main_h-" + px(355) + "-text_h/2"
    );
  }
  return filters;
}
