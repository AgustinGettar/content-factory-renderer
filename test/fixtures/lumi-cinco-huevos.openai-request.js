import { AV2_LLM_EPISODE_TRANSPORT_SCHEMA } from "../../lib/av2/llm-transport.js";

const instructions = `EDUCACIÓN
- Una habilidad principal observable y adecuada al rango de edad.
- El aprendizaje ocurre mediante acciones visibles y correspondencias correctas.
- Incluí pregunta concreta, pausa real para responder, confirmación y recapitulación.
- La narración deja espacio a reacción, observación, movimiento y transición.

HISTORIA
- Estructura narrativa: hook, problema o misión, descubrimiento, enseñanza, práctica, interacción, pausa, respuesta, resolución y recap.
- Es una mini aventura causal, no una lista de ejemplos ni una plantilla de frases.
- Cada beat modifica el estado de la historia y prepara el siguiente.

LUMI
- Lumi conserva character_lock_ref {id:"lumi",version:"1.0"} y su identidad original.
- Seleccioná acciones, expresiones y miradas estructuradas; no redescribas su cuerpo en cada escena.
- La varita guía la atención cuando tiene propósito. Sin personajes o diseños protegidos.

ESCENAS
- Cada escena es un beat audiovisual: goal, stage por capas, entidades, actuación, cámara, acciones, audio, continuidad, transición y assertions.
- Usá IDs/referencias y parámetros breves. No escondas órdenes en párrafos de visual_prompt.
- La cámara y el movimiento deben estar motivados por historia o aprendizaje.
- narration vive únicamente en audio.utterances. Los silencios son audio.pauses.

CONTINUIDAD
- continuity_initial más operations produce el estado. Cada precondition debe coincidir con el estado anterior.
- continuity_initial debe incluir location, narrative_state, lumi_position, props_state, educational_progress, secondary_characters y persistent_elements, aunque algún dominio sea vacío.
- Conservá ubicación, progreso educativo, inventario, props, secundarios y estado narrativo mediante operations explícitas.
- Nunca reinicies objetos encontrados sin una operación o elipsis declarada.

CONTRATO DE TRANSPORTE
- Emití exclusivamente av2-llm-episode-transport/1 según el JSON Schema adjunto.
- transport_version identifica el contrato; episode_plan contiene el plan creativo completo.
- Los mapas abiertos del dominio aparecen como arrays de entradas tipadas key/value.
- No omitas acting, continuidad, cámara, audio, motion, world layers ni transiciones.
- No dependas de documentación externa: todos los datos requeridos están en el input y en el schema.

SALIDA
- Respondé únicamente el JSON que valida el schema estricto. Sin markdown ni explicación.
- IDs únicos y referencias existentes. 30 fps conceptual, 40-50 s objetivo y transiciones declaradas una vez.
- No incluyas URLs, hashes inventados, comandos de renderer, FFmpeg, Blender ni prompts de generación visual.`;

const input = JSON.stringify({
  selected_idea: {
    id: "idea_huevos",
    title: "Lumi ayuda a una gallina a recuperar cinco huevos perdidos contando cada hallazgo.",
    category: "números",
    age_range: { min_years: 3, max_years: 5 },
    learning: {
      objective: "Contar del uno al cinco con correspondencia uno a uno.",
      secondary_skill: "atención y seguimiento",
      mechanism: "one_to_one_count",
    },
    world_ref: { id: "garden_world", version: "catalog-v1" },
    story: {
      premise: "Una brisa escondió cinco huevos y Lumi debe devolverlos a la cesta siguiendo el sendero.",
      problem_type: "lost_objects",
      challenge: "Encontrar y mover cada huevo sin contar ninguno dos veces.",
    },
    activity_id: "collect_in_order",
    secondary_characters: ["gallina amable"],
    interaction: { type: "answer_total", prompt_goal: "El niño cuenta en voz alta y Lumi espera su respuesta." },
    resolution: { reward_type: "family_reunion", reward: "La gallina recupera su nido y celebra con Lumi." },
  },
  duration_seconds: { min: 40, target: 48, max: 50 },
  language: "es-419",
});

export const requestFixture = Object.freeze({
  method: "POST",
  url: "https://api.openai.com/v1/responses",
  body: {
    model: "gpt-5-mini",
    store: false,
    max_output_tokens: 50000,
    input: [
      { role: "system", content: instructions },
      { role: "user", content: input },
    ],
    text: {
      format: {
        type: "json_schema",
        name: "av2_llm_episode_transport_v1",
        strict: true,
        schema: AV2_LLM_EPISODE_TRANSPORT_SCHEMA,
      },
    },
  },
});
