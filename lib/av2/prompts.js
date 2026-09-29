import { MAX_REPAIR_ATTEMPTS, contentHash } from "./contracts.js";
import {
  AV2_LLM_IDEA_TRANSPORT_SCHEMA,
  AV2_LLM_IDEA_TRANSPORT_SCHEMA_NAME,
  AV2_LLM_IDEA_TRANSPORT_VERSION,
  AV2_LLM_EPISODE_TRANSPORT_SCHEMA,
  AV2_LLM_EPISODE_TRANSPORT_SCHEMA_NAME,
  AV2_LLM_EPISODE_TRANSPORT_VERSION,
  assertOpenAIStructuredOutputSchema,
} from "./llm-transport.js";

export const CREATIVE_PROMPT_VERSION = "cf-creative-v2.1.0";

const EDUCATIONAL_RULES = `EDUCACIÓN
- Una habilidad principal observable y adecuada al rango de edad.
- El aprendizaje ocurre mediante acciones visibles y correspondencias correctas.
- Incluí exactamente una pregunta infantil clara, una pausa child_response de al menos 2 segundos, confirmación y recapitulación.
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
- narration vive únicamente en audio.utterances. Los silencios son audio.pauses.
- Gramática local de anchors: scene.start, scene.end, <id_local>.start o <id_local>.end. No uses scene_start, scene_end, mid_scene ni referencias cruzadas.`;

const CONTINUITY_RULES = `CONTINUIDAD
- continuity_initial más operations produce el estado. Cada precondition debe coincidir con el estado anterior.
- continuity_initial debe incluir location, narrative_state, lumi_position, props_state, educational_progress, secondary_characters y persistent_elements, aunque algún dominio sea vacío.
- Conservá ubicación, progreso educativo, inventario, props, secundarios y estado narrativo mediante operations explícitas.
- Nunca reinicies objetos encontrados sin una operación o elipsis declarada.`;

const OUTPUT_RULES = `SALIDA
- Respondé únicamente el JSON que valida el schema estricto. Sin markdown ni explicación.
- IDs únicos y referencias existentes. Cada transición se declara una vez y corresponde al límite entre escenas consecutivas.
- No incluyas URLs, hashes inventados, comandos de renderer, FFmpeg, Blender ni prompts de generación visual.`;

const DURATION_RULES = `DURACIÓN
- HARD RANGE: el total calculado debe estar entre 40 y 50 segundos, inclusive. TARGET: 48 segundos.
- Total calculado = SUM(scene.duration_target_seconds) - SUM(transition.overlap_frames / 30).
- 48 no es un límite rígido; menos de 40 o más de 50 invalida el plan.`;

const EPISODE_TRANSPORT_RULES = `CONTRATO DE TRANSPORTE
- Emití exclusivamente ${AV2_LLM_EPISODE_TRANSPORT_VERSION} según el JSON Schema adjunto.
- transport_version identifica el contrato; episode_plan contiene el plan creativo completo.
- Los mapas abiertos del dominio aparecen como arrays de entradas tipadas key/value.
- No omitas acting, continuidad, cámara, audio, motion, world layers ni transiciones.
- No dependas de documentación externa: todos los datos requeridos están en el input y en el schema.`;

const IDEA_TRANSPORT_RULES = `CONTRATO DE TRANSPORTE
- Emití exclusivamente ${AV2_LLM_IDEA_TRANSPORT_VERSION} según el JSON Schema adjunto.
- transport_version identifica el contrato; idea_set contiene exactamente cinco mini aventuras distintas.
- No dependas de documentación externa: todos los datos requeridos están en el input y en el schema.`;

function structuredRequest({ operation, instructions, input, schema, schemaName }) {
  assertOpenAIStructuredOutputSchema(schema);
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
    schemaName: AV2_LLM_IDEA_TRANSPORT_SCHEMA_NAME,
    schema: AV2_LLM_IDEA_TRANSPORT_SCHEMA,
    instructions: `${EDUCATIONAL_RULES}\n\n${STORYTELLING_RULES}\n\nDIVERSIDAD\n- Proponé exactamente cinco mini aventuras relacionadas con la categoría.\n- Las cinco deben usar mundos, problemas, mecanismos, actividades, interacciones y recompensas distintos.\n- Evitá equivalencias triviales y similitud con episodios recientes.\n\n${LUMI_RULES}\n\n${IDEA_TRANSPORT_RULES}\n\n${OUTPUT_RULES}`,
    input: { category: cleanCategory, age_range: requestedAgeRange, recent_ideas: recent },
  });
}

export function buildEpisodePlanRequest({ idea }) {
  if (!idea || typeof idea !== "object") throw new Error("a selected V2 idea is required");
  return structuredRequest({
    operation: "generate_episode_plan",
    schemaName: AV2_LLM_EPISODE_TRANSPORT_SCHEMA_NAME,
    schema: AV2_LLM_EPISODE_TRANSPORT_SCHEMA,
    instructions: `${EDUCATIONAL_RULES}\n\n${STORYTELLING_RULES}\n\n${LUMI_RULES}\n\n${SCENE_RULES}\n\n${CONTINUITY_RULES}\n\n${DURATION_RULES}\n\n${EPISODE_TRANSPORT_RULES}\n\n${OUTPUT_RULES}\n\nCONTEO\n- Si el objetivo es contar 1→5, declará exactamente cinco entidades countable y hacé observable la progresión 1, 2, 3, 4, 5 mediante acciones y continuidad.`,
    input: { selected_idea: idea, duration_seconds: { min: 40, target: 48, max: 50 }, language: "es-419" },
  });
}

export function buildRepairRequest({ plan, errors, attempt }) {
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > MAX_REPAIR_ATTEMPTS) {
    throw new Error(`repair attempt must be between 1 and ${MAX_REPAIR_ATTEMPTS}`);
  }
  const compactErrors = errors.filter(({ path, keyword }) => !(
    ["timing", "timing_reference"].includes(keyword)
    || /^\/episode\/transitions\//.test(path)
    || /^\/scenes\/\d+\/transition_(in|out)$/.test(path)
  )).slice(0, 40).map(({ path, keyword, message }) => ({ path, keyword, message }));
  if (!compactErrors.length) throw new Error("repair requires at least one creative-authoritative validation error");
  const affectedScenes = [...new Set(compactErrors.map((error) => error.path.match(/^\/scenes\/(\d+)/)?.[1]).filter(Boolean).map(Number))];
  return structuredRequest({
    operation: "repair_episode_plan",
    schemaName: AV2_LLM_EPISODE_TRANSPORT_SCHEMA_NAME,
    schema: AV2_LLM_EPISODE_TRANSPORT_SCHEMA,
    instructions: `${CONTINUITY_RULES}\n\n${DURATION_RULES}\n\n${EPISODE_TRANSPORT_RULES}\n\n${OUTPUT_RULES}\n\nREPARACIÓN\n- Corregí únicamente los paths indicados y sus dependencias directas.\n- Conservá IDs, texto y escenas válidas.\n- No cambies la premisa ni regeneres todo el episodio salvo que un error raíz lo haga inevitable.\n- No repares timeline, scene.start/end, edges from/to, hashes ni referencias mecánicas derivables: esas pertenecen al engine.`,
    input: { attempt, validation_errors: compactErrors, affected_scene_indexes: affectedScenes, episode_plan: plan },
  });
}
