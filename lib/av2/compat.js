import { STORY_VERSION } from "../story-timeline.js";
import { LEGACY_ADAPTER_VERSION, contentHash, deriveContinuity, validateEpisodePlan } from "./contracts.js";

const COLORS = new Set(["blue", "yellow", "pink", "purple", "green", "red"]);

function cleanLabel(value, maxLength) {
  const cleaned = String(value || "").replace(/\s+/g, " ").trim();
  if (!cleaned) return "Aprendemos con Lumi".slice(0, maxLength);
  return cleaned.length <= maxLength ? cleaned : `${cleaned.slice(0, maxLength - 1).trimEnd()}…`;
}

function sceneBeat(plan, scene) {
  return plan.episode.story_beats.find((beat) => beat.id === scene.beat_ref);
}

function legacyRole(beatFunction, index) {
  if (beatFunction === "setup") return "hook";
  if (beatFunction === "question") return "question";
  if (beatFunction === "answer") return "answer";
  if (["recap", "close"].includes(beatFunction)) return "recap";
  return index % 2 === 0 ? "teach" : "example";
}

function countAssertion(scene) {
  return scene.assertions.find((assertion) => assertion.type === "entity_count" && Number.isInteger(assertion.expected));
}

function legacyFocus(scene) {
  const count = countAssertion(scene);
  if (count && count.expected >= 1 && count.expected <= 10) {
    return { kind: "count", value: String(count.expected), color: "yellow" };
  }
  const label = scene.text[0]?.content || scene.educational_goal;
  return { kind: "label", value: cleanLabel(label, 32), color: "blue" };
}

function narrationFor(scene) {
  return scene.audio.utterances.map((utterance) => utterance.text.trim()).filter(Boolean).join(" ");
}

function captionFor(plan, scene) {
  const explicit = scene.text.map((entry) => entry.content.trim()).filter(Boolean).join(" · ");
  if (explicit) return cleanLabel(explicit, 48);
  const beat = sceneBeat(plan, scene);
  const count = countAssertion(scene)?.expected;
  if (beat?.function === "question" && count) return "¿Cuántos hay?";
  if (beat?.function === "answer" && count) return String(count);
  if (count) return `${count} ${count === 1 ? "objeto" : "objetos"}`;
  return cleanLabel(scene.educational_goal, 48);
}

function visibleByLayer(scene, layer) {
  return scene.stage.placements
    .filter((placement) => placement.layer === layer && placement.visible && placement.entity_id !== "lumi")
    .map((placement) => placement.entity_id.replaceAll("_", " "));
}

function visualPromptFor(scene) {
  const environment = scene.stage.environment_ref.id.replaceAll("_", " ");
  const foreground = visibleByLayer(scene, "foreground");
  const midground = visibleByLayer(scene, "midground");
  const background = visibleByLayer(scene, "background");
  const actedProps = scene.actions.filter((action) => action.entity_id !== "lumi")
    .map((action) => `${action.entity_id.replaceAll("_", " ")} ${action.action_id.replaceAll("_", " ")}`);
  const clauses = [
    `Placa vertical 9:16 del entorno ${environment}, sin dibujar a Lumi y sin texto.`,
    background.length ? `Fondo: ${background.join(", ")}.` : "Fondo coherente con el mundo y profundidad suave.",
    midground.length ? `Plano medio: ${midground.join(", ")}.` : "Plano medio despejado para la acción educativa.",
    foreground.length ? `Primer plano: ${foreground.join(", ")}.` : "Primer plano discreto sin tapar el foco.",
    actedProps.length ? `Acción visual preparada: ${actedProps.join(", ")}.` : "Mantener continuidad espacial con la escena anterior.",
    `Encuadre ${scene.camera.shot}; movimiento previsto ${scene.camera.move}; iluminación ${scene.stage.lighting_ref.id.replaceAll("_", " ")}.`,
  ];
  return cleanLabel(clauses.join(" "), 800);
}

export function adaptSceneToLegacy(plan, scene, index, continuitySnapshot, episodeHash = contentHash(plan)) {
  const beat = sceneBeat(plan, scene);
  const narration = narrationFor(scene);
  if (!narration) throw new Error(`Scene ${scene.id} has no spoken utterance for CF-04`);
  const role = legacyRole(beat?.function, index);
  const focus = legacyFocus(scene);
  if (!COLORS.has(focus.color)) throw new Error(`Scene ${scene.id} has an unsupported legacy focus color`);
  return {
    scene_number: index + 1,
    narration,
    visual_prompt: visualPromptFor(scene),
    on_screen_text: captionFor(plan, scene),
    duration_seconds: scene.duration_target_seconds,
    metadata: {
      production: {
        version: STORY_VERSION,
        role,
        pause_after_seconds: role === "question" ? 2 : 0.25,
        focus,
      },
      av2_preparation: {
        version: "cf-av2",
        adapter_version: LEGACY_ADAPTER_VERSION,
        episode_id: plan.episode.id,
        scene_id: scene.id,
        episode_sha256: episodeHash,
        timing: {
          scene_target_seconds: scene.duration_target_seconds,
          narration_duration_seconds: null,
          narration_duration_source: "pending_audio_measurement",
          planned_pause_seconds: scene.audio.pauses.reduce((sum, pause) => sum + pause.duration_seconds, 0),
        },
        continuity_in: continuitySnapshot.continuity_in,
        continuity_out: continuitySnapshot.continuity_out,
      },
    },
  };
}

export function adaptEpisodeToLegacy(plan) {
  const validation = validateEpisodePlan(plan);
  const continuity = validation.continuity || deriveContinuity(plan);
  const episodeHash = contentHash(plan);
  const scenes = plan.scenes.map((scene, index) => adaptSceneToLegacy(
    plan, scene, index, continuity.snapshots[index], episodeHash,
  ));
  return {
    version: LEGACY_ADAPTER_VERSION,
    creative_engine_version: "v2",
    episode_sha256: episodeHash,
    video: {
      title: plan.episode.title,
      language: "es",
      duration_seconds: validation.planned_duration_seconds,
      script: scenes.map((scene) => scene.narration).join(" "),
      metadata: {
        creative_engine_version: "v2",
        episode_plan_version: plan.version,
        episode_id: plan.episode.id,
        episode_sha256: episodeHash,
      },
    },
    scenes,
  };
}

export function adaptIdeasToLegacyChoices(ideaSet) {
  return ideaSet.ideas.map((idea) => ({
    title: idea.title,
    lesson: idea.learning.objective,
    creative_brief: idea,
  }));
}
