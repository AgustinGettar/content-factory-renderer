import { EPISODE_PLAN_SCHEMA, IDEA_SET_SCHEMA, MAX_REPAIR_ATTEMPTS, contentHash } from "./contracts.js";

export const CREATIVE_PROMPT_VERSION = "cf-creative-v2.0.0";

const EDUCATIONAL_RULES = `EDUCACIÓN
- Una habilidad principal observable y adecuada al rango de edad.
- El aprendizaje ocurre mediante acciones visibles y correspondencias correctas.
- Incluí pregunta concreta, pausa real para responder, confirmación y recapitulación.
- La narración deja espacio a reacción, observación, movimiento y transición.`;

const STORYTELLING_RULES = `HISTORIA
- Estructura narrativa: hook, problema o misión, descubrimiento, enseñanza, práctica, interacción, pausa, respuesta, resolución y recap.
- Es una mini aventura causal, no una lista de ejemplos ni una plantilla de frases.
- Cada beat modifica el estado de la historia y prepara el siguiente.`;

const LUMI_RULES = `LUMI
- Lumi conserva character_lock_ref {id:"lumi",version:"1.0"} y su identidad original.
- Seleccioná acciones, expresiones y miradas estructuradas; no redescribas su cuerpo en cada escena.
- La varita guía la atención cuando tiene propósito. Sin personajes o diseños protegidos.`;

const SCENE_RULES = `ESCENAS
- Cada escena es un beat audiovisual: goal, stage por capas, entidades, actuación, cámara, acciones, audio, continuidad, transición y assertions.
- Usá IDs/referencias y parámetros breves. No escondas órdenes en párrafos de visual_prompt.
- La cámara y el movimiento deben estar motivados por historia o aprendizaje.
- narration vive únicamente en audio.utterances. Los silencios son audio.pauses.`;

const CONTINUITY_RULES = `CONTINUIDAD
- continuity_initial más operations produce el estado. Cada precondition debe coincidir con el estado anterior.
- continuity_initial debe incluir location, narrative_state, lumi_position, props_state, educational_progress, secondary_characters y persistent_elements, aunque algún dominio sea vacío.
- Conservá ubicación, progreso educativo, inventario, props, secundarios y estado narrativo mediante operations explícitas.
- Nunca reinicies objetos encontrados sin una operación o elipsis declarada.`;

const OUTPUT_RULES = `SALIDA
- Respondé únicamente el JSON que valida el schema estricto. Sin markdown ni explicación.
- IDs únicos y referencias existentes. 30 fps conceptual, 40-50 s objetivo y transiciones declaradas una vez.
- No incluyas URLs, hashes inventados, comandos de renderer, FFmpeg, Blender ni prompts de generación visual.`;

function structuredRequest({ operation, instructions, input, schema, schemaName }) {
  const request = {
    version: "cf-creative-request/1",
    operation,
    prompt_version: CREATIVE_PROMPT_VERSION,
    expected_llm_calls: 1,
    instructions,
    input,
    response_format: {
      type: "json_schema",
      name: schemaName,
      strict: true,
      schema,
    },
  };
  return { ...request, request_hash: contentHash(request) };
}

export function buildIdeasRequest({
  category,
  ageRange = { min_years: 3, max_years: 5 },
  age_range,
  recentIdeas = [],
  recent_ideas = [],
}) {
  const cleanCategory = String(category || "").trim();
  if (cleanCategory.length < 2 || cleanCategory.length > 48) throw new Error("category must contain 2-48 characters");
  const requestedAgeRange = age_range || ageRange;
  if (!Number.isInteger(requestedAgeRange?.min_years) || !Number.isInteger(requestedAgeRange?.max_years)
      || requestedAgeRange.min_years < 2 || requestedAgeRange.max_years > 10
      || requestedAgeRange.min_years > requestedAgeRange.max_years) {
    throw new Error("age_range must contain ordered integer years between 2 and 10");
  }
  const sourceRecentIdeas = Array.isArray(recentIdeas) && recentIdeas.length
    ? recentIdeas
    : (Array.isArray(recent_ideas) ? recent_ideas : []);
  const recent = sourceRecentIdeas.slice(0, 20).map((idea) => typeof idea === "string" ? idea.slice(0, 500) : {
    title: String(idea?.title || "").slice(0, 220),
    story_premise: String(idea?.story_premise || idea?.premise || "").slice(0, 500),
  });
  return structuredRequest({
    operation: "generate_ideas",
    schemaName: "content_factory_idea_set_v2",
    schema: IDEA_SET_SCHEMA,
    instructions: `${EDUCATIONAL_RULES}\n\n${STORYTELLING_RULES}\n\nDIVERSIDAD\n- Proponé exactamente cinco mini aventuras relacionadas con la categoría.\n- Las cinco deben usar mundos, problemas, mecanismos, actividades, interacciones y recompensas distintos.\n- Evitá equivalencias triviales y similitud con episodios recientes.\n\n${LUMI_RULES}\n\n${OUTPUT_RULES}`,
    input: { category: cleanCategory, age_range: requestedAgeRange, recent_ideas: recent },
  });
}

export function buildEpisodePlanRequest({ idea }) {
  if (!idea || typeof idea !== "object") throw new Error("a selected V2 idea is required");
  return structuredRequest({
    operation: "generate_episode_plan",
    schemaName: "content_factory_episode_plan_v2",
    schema: EPISODE_PLAN_SCHEMA,
    instructions: `${EDUCATIONAL_RULES}\n\n${STORYTELLING_RULES}\n\n${LUMI_RULES}\n\n${SCENE_RULES}\n\n${CONTINUITY_RULES}\n\n${OUTPUT_RULES}`,
    input: { selected_idea: idea, duration_seconds: { min: 40, target: 48, max: 50 }, language: "es-419" },
  });
}

export function buildRepairRequest({ plan, errors, attempt }) {
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > MAX_REPAIR_ATTEMPTS) {
    throw new Error(`repair attempt must be between 1 and ${MAX_REPAIR_ATTEMPTS}`);
  }
  const compactErrors = errors.slice(0, 40).map(({ path, keyword, message }) => ({ path, keyword, message }));
  const affectedScenes = [...new Set(compactErrors.map((error) => error.path.match(/^\/scenes\/(\d+)/)?.[1]).filter(Boolean).map(Number))];
  return structuredRequest({
    operation: "repair_episode_plan",
    schemaName: "content_factory_episode_plan_v2_repaired",
    schema: EPISODE_PLAN_SCHEMA,
    instructions: `${CONTINUITY_RULES}\n\n${OUTPUT_RULES}\n\nREPARACIÓN\n- Corregí únicamente los paths indicados y sus dependencias directas.\n- Conservá IDs, texto y escenas válidas.\n- No cambies la premisa ni regeneres todo el episodio salvo que un error raíz lo haga inevitable.`,
    input: { attempt, validation_errors: compactErrors, affected_scene_indexes: affectedScenes, episode_plan: plan },
  });
}
