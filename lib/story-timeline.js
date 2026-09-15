export const STORY_VERSION = "lumi-story-v2";
const roles = new Set(["hook", "teach", "example", "question", "answer", "recap"]);
const kinds = new Set(["label", "letter", "count", "color", "shape"]);
export const COLORS = Object.freeze({ blue: "#60BFEF", yellow: "#FFD769", pink: "#F395B9", purple: "#B7A0EF", green: "#8CD5AE", red: "#EF7775" });

export function validateProduction(value) {
  if (value?.version !== STORY_VERSION) throw new Error("Versión de escena animada no compatible.");
  if (!roles.has(value.role)) throw new Error("La escena necesita una función educativa válida.");
  const focus = value.focus;
  if (!focus || !kinds.has(focus.kind) || !Object.hasOwn(COLORS, focus.color)) throw new Error("Foco educativo inválido.");
  const label = String(focus.value ?? "").normalize("NFC").trim();
  if (!label || [...label].length > 32 || /[\r\n\x00-\x1f]/u.test(label)) throw new Error("Foco educativo vacío o demasiado largo.");
  if (focus.kind === "count" && !/^(?:[1-9]|10)$/.test(label)) throw new Error("El conteo debe estar entre 1 y 10.");
  if (focus.kind === "letter" && !/^[A-ZÁÉÍÓÚÜÑ]$/u.test(label)) throw new Error("Mostrá una sola letra mayúscula.");
  if (focus.kind === "shape" && !["círculo", "cuadrado", "triángulo"].includes(label.toLowerCase())) throw new Error("Forma educativa no compatible.");
  const colorNames = {azul:"blue",amarillo:"yellow",rosa:"pink",violeta:"purple",verde:"green",rojo:"red"};
  if (focus.kind === "color" && !Object.hasOwn(colorNames,label.toLowerCase())) throw new Error("Nombre de color no compatible.");
  const pause = Number(value.pause_after_seconds);
  if (!Number.isFinite(pause) || pause < 0 || pause > 3 || (value.role === "question" && pause < 1.5)) throw new Error("La pregunta necesita una pausa real de 1,5 a 3 segundos.");
  return { version: STORY_VERSION, role: value.role, pause_after_seconds: pause, focus: { kind: focus.kind, value: label, color: focus.kind === "color" ? colorNames[label.toLowerCase()] : focus.color } };
}

export function validateSpokenText(text) {
  const value = String(text ?? "").trim();
  if (!value || /\[(?:pausa|música|sonido|ríe|canta)|(?:^|[.!?…]\s*)(?:pausa(?: para pensar)?|esperar \d)/iu.test(value)) {
    throw new Error("La narración contiene acotaciones. Las pausas van en los metadatos, nunca en la voz.");
  }
  return value;
}

// Round UP to the common 30 fps clock: never clip the last spoken syllable.
export function createTimeline(audioSeconds, production, fps = 30) {
  const p = validateProduction(production);
  if (!Number.isFinite(audioSeconds) || audioSeconds <= 0 || audioSeconds > 30 || fps !== 30) throw new Error("Duración de audio inválida para una microescena.");
  const audioFrames = Math.ceil(audioSeconds * fps);
  const pauseFrames = Math.ceil(p.pause_after_seconds * fps);
  const tailFrames = 6;
  return { version: STORY_VERSION, fps, audio_seconds: audioSeconds, audio_frames: audioFrames,
    pause_frames: pauseFrames, tail_frames: tailFrames, frames: audioFrames + pauseFrames + tailFrames,
    duration_seconds: (audioFrames + pauseFrames + tailFrames) / fps };
}

export function verifyTimeline(timeline, audioSeconds, production) {
  const expected = createTimeline(audioSeconds, production);
  for (const key of ["version", "fps", "audio_frames", "pause_frames", "tail_frames", "frames", "duration_seconds"]) {
    if (timeline?.[key] !== expected[key]) throw new Error("La línea de tiempo aprobada cambió. Se necesita otra vista previa.");
  }
  return timeline;
}
