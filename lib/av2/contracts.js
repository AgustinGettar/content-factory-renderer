import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";

export const CREATIVE_ENGINE_VERSION = "v2";
export const EPISODE_PLAN_VERSION = "cf-episode/2.0";
export const SCENE_PLAN_VERSION = "cf-scene/2.0";
export const IDEA_SET_VERSION = "cf-ideas/2.0";
export const LEGACY_ADAPTER_VERSION = "cf-legacy-adapter/1";
export const MAX_REPAIR_ATTEMPTS = 2;
export const MAX_GENERATION_ATTEMPTS = 5;
export const MAX_AUTOMATIC_GENERATION_ATTEMPTS = 2;

const EPISODE_SCHEMA_URL = new URL("./schemas/episode-plan.v2.schema.json", import.meta.url);
export const EPISODE_PLAN_SCHEMA = JSON.parse(readFileSync(EPISODE_SCHEMA_URL, "utf8"));

const refSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "version"],
  properties: {
    id: { type: "string", pattern: "^[a-z][a-z0-9_-]{1,63}$" },
    version: { type: "string", minLength: 1, maxLength: 32 },
  },
};

export const IDEA_SET_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://content-factory.local/schemas/idea-set.v2.schema.json",
  title: "Content Factory Idea Set V2",
  type: "object",
  additionalProperties: false,
  required: ["version", "category", "ideas"],
  properties: {
    version: { const: IDEA_SET_VERSION },
    category: { type: "string", minLength: 2, maxLength: 48 },
    ideas: {
      type: "array",
      minItems: 5,
      maxItems: 5,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "id", "title", "category", "age_range", "learning", "world_ref",
          "story", "activity_id", "secondary_characters", "interaction", "resolution",
        ],
        properties: {
          id: { type: "string", pattern: "^idea_[a-z0-9_-]{2,63}$" },
          title: { type: "string", minLength: 20, maxLength: 220 },
          category: { type: "string", minLength: 2, maxLength: 48 },
          age_range: {
            type: "object",
            additionalProperties: false,
            required: ["min_years", "max_years"],
            properties: {
              min_years: { type: "integer", minimum: 2, maximum: 10 },
              max_years: { type: "integer", minimum: 2, maximum: 10 },
            },
          },
          learning: {
            type: "object",
            additionalProperties: false,
            required: ["objective", "mechanism"],
            properties: {
              objective: { type: "string", minLength: 8, maxLength: 240 },
              secondary_skill: { type: "string", minLength: 3, maxLength: 160 },
              mechanism: { type: "string", pattern: "^[a-z][a-z0-9_-]{2,63}$" },
            },
          },
          world_ref: refSchema,
          story: {
            type: "object",
            additionalProperties: false,
            required: ["premise", "problem_type", "challenge"],
            properties: {
              premise: { type: "string", minLength: 30, maxLength: 500 },
              problem_type: { type: "string", pattern: "^[a-z][a-z0-9_-]{2,63}$" },
              challenge: { type: "string", minLength: 12, maxLength: 240 },
            },
          },
          activity_id: { type: "string", pattern: "^[a-z][a-z0-9_-]{2,63}$" },
          secondary_characters: {
            type: "array", uniqueItems: true, maxItems: 4,
            items: { type: "string", minLength: 2, maxLength: 60 },
          },
          interaction: {
            type: "object",
            additionalProperties: false,
            required: ["type", "prompt_goal"],
            properties: {
              type: { type: "string", pattern: "^[a-z][a-z0-9_-]{2,63}$" },
              prompt_goal: { type: "string", minLength: 8, maxLength: 220 },
            },
          },
          resolution: {
            type: "object",
            additionalProperties: false,
            required: ["reward_type", "reward"],
            properties: {
              reward_type: { type: "string", pattern: "^[a-z][a-z0-9_-]{2,63}$" },
              reward: { type: "string", minLength: 8, maxLength: 220 },
            },
          },
        },
      },
    },
  },
};

const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true, validateFormats: false });
const validateEpisodeShape = ajv.compile(EPISODE_PLAN_SCHEMA);
const validateSceneShape = ajv.compile({ $ref: `${EPISODE_PLAN_SCHEMA.$id}#/$defs/scene` });
const validateIdeasShape = ajv.compile(IDEA_SET_SCHEMA);
const validateIdeaShape = ajv.compile({ $ref: `${IDEA_SET_SCHEMA.$id}#/properties/ideas/items` });

export class CreativeValidationError extends Error {
  constructor(code, errors) {
    super(`${code}: ${errors.map((entry) => entry.message).join("; ")}`);
    this.name = "CreativeValidationError";
    this.code = code;
    this.errors = errors;
  }
}

function schemaErrors(errors = []) {
  return errors.map((error) => ({
    path: error.instancePath || "/",
    keyword: error.keyword,
    message: error.message || "invalid value",
    params: error.params,
  }));
}

function validationResult(code, errors, throwOnError) {
  if (!errors.length) return { ok: true, errors: [] };
  if (throwOnError) throw new CreativeValidationError(code, errors);
  return { ok: false, errors };
}

function normalizedWords(value) {
  return new Set(String(value || "").toLocaleLowerCase("es")
    .normalize("NFD").replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9ñ ]/g, " ").split(/\s+/).filter((word) => word.length > 2));
}

function similarity(left, right) {
  const a = normalizedWords(left);
  const b = normalizedWords(right);
  if (!a.size && !b.size) return 1;
  const intersection = [...a].filter((word) => b.has(word)).length;
  return intersection / new Set([...a, ...b]).size;
}

function addSemanticError(errors, path, message, keyword = "semantic") {
  errors.push({ path, keyword, message, params: {} });
}

function collectTimeRefs(value, target = [], path = "") {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => collectTimeRefs(entry, target, `${path}/${index}`));
  } else if (value && typeof value === "object") {
    if (typeof value.anchor === "string" && Object.keys(value).every((key) => ["anchor", "offset_seconds"].includes(key))) {
      target.push({ anchor: value.anchor, offset_seconds: Number(value.offset_seconds ?? 0), path: path || "/" });
    } else {
      Object.entries(value).forEach(([key, entry]) => collectTimeRefs(entry, target, `${path}/${key}`));
    }
  }
  return target;
}

export function validateIdeaSet(value, { category, recentIdeas = [], recent_ideas = [], throwOnError = true } = {}) {
  const errors = [];
  if (!validateIdeasShape(value)) errors.push(...schemaErrors(validateIdeasShape.errors));
  if (errors.length) return validationResult("idea_set_invalid", errors, throwOnError);

  const recentEpisodeIdeas = Array.isArray(recentIdeas) && recentIdeas.length
    ? recentIdeas
    : (Array.isArray(recent_ideas) ? recent_ideas : []);
  const expectedCategory = String(category || value.category).trim().toLocaleLowerCase("es");
  const dimensions = {
    world: new Set(), problem: new Set(), mechanism: new Set(), activity: new Set(),
    interaction: new Set(), reward: new Set(), id: new Set(),
  };
  value.ideas.forEach((idea, index) => {
    const path = `/ideas/${index}`;
    if (idea.category.trim().toLocaleLowerCase("es") !== expectedCategory) {
      addSemanticError(errors, `${path}/category`, "must match the requested category");
    }
    if (idea.age_range.min_years > idea.age_range.max_years) {
      addSemanticError(errors, `${path}/age_range`, "min_years must be less than or equal to max_years");
    }
    for (const [key, valueToAdd] of [
      ["world", idea.world_ref.id], ["problem", idea.story.problem_type],
      ["mechanism", idea.learning.mechanism], ["activity", idea.activity_id],
      ["interaction", idea.interaction.type], ["reward", idea.resolution.reward_type], ["id", idea.id],
    ]) {
      if (dimensions[key].has(valueToAdd)) addSemanticError(errors, path, `duplicate diversity dimension: ${key}=${valueToAdd}`);
      dimensions[key].add(valueToAdd);
    }
    const signature = `${idea.title} ${idea.story.premise}`;
    recentEpisodeIdeas.forEach((recent, recentIndex) => {
      const recentText = typeof recent === "string" ? recent : `${recent?.title || ""} ${recent?.story_premise || recent?.premise || ""}`;
      if (similarity(signature, recentText) >= 0.72) {
        addSemanticError(errors, path, `too similar to recent idea ${recentIndex + 1}`, "diversity");
      }
    });
  });

  for (let left = 0; left < value.ideas.length; left += 1) {
    for (let right = left + 1; right < value.ideas.length; right += 1) {
      const a = `${value.ideas[left].title} ${value.ideas[left].story.premise}`;
      const b = `${value.ideas[right].title} ${value.ideas[right].story.premise}`;
      if (similarity(a, b) >= 0.68) addSemanticError(errors, `/ideas/${right}`, `too similar to idea ${left + 1}`, "diversity");
    }
  }
  return validationResult("idea_set_invalid", errors, throwOnError);
}

export function validateIdeaBrief(value, { throwOnError = true } = {}) {
  const errors = validateIdeaShape(value) ? [] : schemaErrors(validateIdeaShape.errors);
  if (value?.age_range?.min_years > value?.age_range?.max_years) {
    addSemanticError(errors, "/age_range", "min_years must be less than or equal to max_years");
  }
  return validationResult("idea_invalid", errors, throwOnError);
}

function pathParts(path) {
  const parts = String(path).split(".");
  if (!parts.length || parts.some((part) => !/^[a-z][a-z0-9_-]*$/.test(part) || ["__proto__", "prototype", "constructor"].includes(part))) {
    throw new Error(`Unsafe continuity path: ${path}`);
  }
  return parts;
}

function getPath(state, path) {
  return pathParts(path).reduce((current, part) => current?.[part], state);
}

function setPath(state, path, value) {
  const parts = pathParts(path);
  let current = state;
  for (const part of parts.slice(0, -1)) {
    if (!current[part] || typeof current[part] !== "object" || Array.isArray(current[part])) current[part] = {};
    current = current[part];
  }
  current[parts.at(-1)] = structuredClone(value);
}

function equalValue(left, right) {
  return canonicalStringify(left) === canonicalStringify(right);
}

export function deriveContinuity(plan, { throwOnError = true } = {}) {
  const errors = [];
  const snapshots = [];
  const state = structuredClone(plan?.episode?.continuity_initial || {});
  for (const [sceneIndex, scene] of (plan?.scenes || []).entries()) {
    const continuityIn = structuredClone(state);
    for (const [ruleIndex, rule] of scene.continuity?.preconditions?.entries?.() || []) {
      if (rule.op !== "equals") {
        addSemanticError(errors, `/scenes/${sceneIndex}/continuity/preconditions/${ruleIndex}/op`, "preconditions only allow equals", "continuity");
      } else if (!equalValue(getPath(state, rule.path), rule.value)) {
        addSemanticError(errors, `/scenes/${sceneIndex}/continuity/preconditions/${ruleIndex}`, `continuity precondition failed for ${rule.path}`, "continuity");
      }
    }
    for (const [ruleIndex, rule] of scene.continuity?.operations?.entries?.() || []) {
      const path = `/scenes/${sceneIndex}/continuity/operations/${ruleIndex}`;
      if (rule.op === "set") setPath(state, rule.path, rule.value);
      else if (rule.op === "append_unique") {
        const existing = getPath(state, rule.path);
        if (!Array.isArray(existing)) addSemanticError(errors, path, `${rule.path} must be an array before append_unique`, "continuity");
        else if (!existing.some((item) => equalValue(item, rule.value))) existing.push(structuredClone(rule.value));
      } else if (rule.op === "remove") {
        const existing = getPath(state, rule.path);
        if (!Array.isArray(existing)) addSemanticError(errors, path, `${rule.path} must be an array before remove`, "continuity");
        else setPath(state, rule.path, existing.filter((item) => !equalValue(item, rule.value)));
      } else addSemanticError(errors, `${path}/op`, "operations allow set, append_unique or remove", "continuity");
    }
    snapshots.push({ scene_id: scene.id, continuity_in: continuityIn, continuity_out: structuredClone(state) });
  }
  const result = validationResult("continuity_invalid", errors, throwOnError);
  return { ...result, snapshots, final_state: structuredClone(state) };
}

export function validateScenePlan(scene, { throwOnError = true } = {}) {
  const errors = validateSceneShape(scene) ? [] : schemaErrors(validateSceneShape.errors);
  return validationResult("scene_plan_invalid", errors, throwOnError);
}

export function validateEpisodePlanStructure(plan, { throwOnError = true } = {}) {
  const errors = validateEpisodeShape(plan) ? [] : schemaErrors(validateEpisodeShape.errors);
  return validationResult("episode_plan_invalid", errors, throwOnError);
}

export function validateEpisodePlan(plan, { throwOnError = true } = {}) {
  const errors = [];
  const structure = validateEpisodePlanStructure(plan, { throwOnError: false });
  errors.push(...structure.errors);
  if (errors.length) return validationResult("episode_plan_invalid", errors, throwOnError);

  const { episode, entities, scenes } = plan;
  if (episode.age_range.min_years > episode.age_range.max_years) addSemanticError(errors, "/episode/age_range", "min_years must not exceed max_years");
  const duration = episode.duration_target;
  if (!(duration.min_seconds <= duration.target_seconds && duration.target_seconds <= duration.max_seconds)) {
    addSemanticError(errors, "/episode/duration_target", "must satisfy min_seconds <= target_seconds <= max_seconds");
  }
  for (const key of [
    "location", "narrative_state", "lumi_position", "props_state",
    "educational_progress", "secondary_characters", "persistent_elements",
  ]) {
    if (!Object.hasOwn(episode.continuity_initial, key)) {
      addSemanticError(errors, `/episode/continuity_initial/${key}`, `missing required continuity domain ${key}`, "continuity");
    }
  }
  const plannedDurationTicks = scenes.reduce((sum, scene) => sum + Math.round(scene.duration_target_seconds * 30_000), 0)
    - episode.transitions.reduce((sum, edge) => sum + edge.overlap_frames * 1_000, 0);
  const plannedDuration = Number((plannedDurationTicks / 30_000).toFixed(6));
  if (plannedDuration < duration.min_seconds || plannedDuration > duration.max_seconds) {
    addSemanticError(errors, "/scenes", `planned duration ${plannedDuration}s is outside episode range`, "timing");
  }

  const entityIds = new Set();
  entities.forEach((entity, index) => {
    if (entityIds.has(entity.id)) addSemanticError(errors, `/entities/${index}/id`, `duplicate entity id ${entity.id}`, "unique");
    entityIds.add(entity.id);
  });
  const countObjective = episode.learning.objective_id.match(/^count_1_to_([1-9][0-9]?)$/);
  if (countObjective) {
    const expectedCount = Number(countObjective[1]);
    const countableEntities = entities.filter((entity) => entity.tags.includes("countable"));
    if (countableEntities.length !== expectedCount) {
      addSemanticError(errors, "/entities", `counting objective requires exactly ${expectedCount} countable entities`, "semantic");
    }
    const progression = scenes.flatMap((scene) => scene.continuity.operations)
      .filter((operation) => operation.op === "set" && operation.path === "educational_progress.count_reached")
      .map((operation) => operation.value);
    const expectedProgression = Array.from({ length: expectedCount }, (_, index) => index + 1);
    if (!equalValue(progression, expectedProgression)) {
      addSemanticError(errors, "/scenes", `counting progression must advance exactly 1 through ${expectedCount}`, "semantic");
    }
    const collected = scenes.flatMap((scene) => scene.continuity.operations)
      .filter((operation) => operation.op === "append_unique" && operation.path === "collected_eggs")
      .map((operation) => operation.value);
    const countableIds = new Set(countableEntities.map((entity) => entity.id));
    if (collected.length !== expectedCount || new Set(collected).size !== expectedCount
        || collected.some((entityId) => !countableIds.has(entityId))) {
      addSemanticError(errors, "/scenes", `counting objective must collect each of the ${expectedCount} countable entities once`, "semantic");
    }
  }
  const beatIds = new Set();
  episode.story_beats.forEach((beat, index) => {
    if (beatIds.has(beat.id)) addSemanticError(errors, `/episode/story_beats/${index}/id`, `duplicate beat id ${beat.id}`, "unique");
    beatIds.add(beat.id);
  });
  const sceneIds = new Set();
  scenes.forEach((scene, sceneIndex) => {
    if (sceneIds.has(scene.id)) addSemanticError(errors, `/scenes/${sceneIndex}/id`, `duplicate scene id ${scene.id}`, "unique");
    sceneIds.add(scene.id);
    if (!beatIds.has(scene.beat_ref)) addSemanticError(errors, `/scenes/${sceneIndex}/beat_ref`, `unknown beat ${scene.beat_ref}`, "reference");
    const actionIds = new Set();
    scene.actions.forEach((action, actionIndex) => {
      if (actionIds.has(action.id)) addSemanticError(errors, `/scenes/${sceneIndex}/actions/${actionIndex}/id`, `duplicate action id ${action.id}`, "unique");
      actionIds.add(action.id);
      if (!entityIds.has(action.entity_id)) addSemanticError(errors, `/scenes/${sceneIndex}/actions/${actionIndex}/entity_id`, `unknown entity ${action.entity_id}`, "reference");
    });
    scene.stage.placements.forEach((placement, placementIndex) => {
      if (!entityIds.has(placement.entity_id)) addSemanticError(errors, `/scenes/${sceneIndex}/stage/placements/${placementIndex}/entity_id`, `unknown entity ${placement.entity_id}`, "reference");
    });
    scene.camera.subjects.forEach((subject, subjectIndex) => {
      if (!entityIds.has(subject)) addSemanticError(errors, `/scenes/${sceneIndex}/camera/subjects/${subjectIndex}`, `unknown entity ${subject}`, "reference");
    });
    const utteranceIds = new Set();
    scene.audio.utterances.forEach((utterance, utteranceIndex) => {
      if (utteranceIds.has(utterance.id)) addSemanticError(errors, `/scenes/${sceneIndex}/audio/utterances/${utteranceIndex}/id`, `duplicate utterance id ${utterance.id}`, "unique");
      utteranceIds.add(utterance.id);
    });
    const pauseIds = new Set();
    scene.audio.pauses.forEach((pause, pauseIndex) => {
      if (pauseIds.has(pause.id)) addSemanticError(errors, `/scenes/${sceneIndex}/audio/pauses/${pauseIndex}/id`, `duplicate pause id ${pause.id}`, "unique");
      pauseIds.add(pause.id);
      if (!utteranceIds.has(pause.after_utterance)) addSemanticError(errors, `/scenes/${sceneIndex}/audio/pauses/${pauseIndex}/after_utterance`, `unknown utterance ${pause.after_utterance}`, "reference");
    });
    const localAnchors = new Set(["scene.start", "scene.end"]);
    for (const id of [...actionIds, ...utteranceIds, ...pauseIds]) {
      localAnchors.add(`${id}.start`);
      localAnchors.add(`${id}.end`);
    }
    collectTimeRefs(scene).forEach(({ anchor, offset_seconds: offset, path }) => {
      if (!localAnchors.has(anchor)) {
        addSemanticError(errors, `/scenes/${sceneIndex}${path}`, `unknown local time anchor ${anchor}`, "timing_reference");
      } else if (anchor === "scene.start" && (offset < 0 || offset > scene.duration_target_seconds)) {
        addSemanticError(errors, `/scenes/${sceneIndex}${path}`, "scene.start offset must remain inside the scene", "timing_reference");
      } else if (anchor === "scene.end" && (offset > 0 || offset < -scene.duration_target_seconds)) {
        addSemanticError(errors, `/scenes/${sceneIndex}${path}`, "scene.end offset must remain inside the scene", "timing_reference");
      }
    });
    scene.assertions.forEach((assertion, assertionIndex) => {
      assertion.entities?.forEach((entityId) => {
        if (!entityIds.has(entityId)) addSemanticError(errors, `/scenes/${sceneIndex}/assertions/${assertionIndex}/entities`, `unknown entity ${entityId}`, "reference");
      });
    });
    const beat = episode.story_beats.find((candidate) => candidate.id === scene.beat_ref);
    const childResponse = scene.audio.pauses.find((pause) => pause.purpose === "child_response");
    if (beat?.function === "question" && (!childResponse || childResponse.duration_seconds < 2)) {
      addSemanticError(errors, `/scenes/${sceneIndex}/audio/pauses`, "question scene requires a child_response pause of at least 2 seconds", "timing");
    }
  });

  const transitionIds = new Set();
  if (episode.transitions.length !== Math.max(0, scenes.length - 1)) {
    addSemanticError(errors, "/episode/transitions", "consecutive scenes require exactly one transition edge per boundary", "reference");
  }
  episode.transitions.forEach((edge, edgeIndex) => {
    if (transitionIds.has(edge.id)) addSemanticError(errors, `/episode/transitions/${edgeIndex}/id`, `duplicate transition id ${edge.id}`, "unique");
    transitionIds.add(edge.id);
    if (!sceneIds.has(edge.from_scene) || !sceneIds.has(edge.to_scene)) addSemanticError(errors, `/episode/transitions/${edgeIndex}`, "transition references an unknown scene", "reference");
    if (edge.from_scene === edge.to_scene) addSemanticError(errors, `/episode/transitions/${edgeIndex}`, "transition cannot be a self-edge", "reference");
    if (scenes[edgeIndex] && scenes[edgeIndex + 1]
        && (edge.from_scene !== scenes[edgeIndex].id || edge.to_scene !== scenes[edgeIndex + 1].id)) {
      addSemanticError(errors, `/episode/transitions/${edgeIndex}`, "transition must connect consecutive scenes in canonical order", "reference");
    }
  });
  scenes.forEach((scene, sceneIndex) => {
    for (const [field, value] of [["transition_in", scene.transition_in], ["transition_out", scene.transition_out]]) {
      if (value !== null && !transitionIds.has(value)) addSemanticError(errors, `/scenes/${sceneIndex}/${field}`, `unknown transition ${value}`, "reference");
    }
    if (scene.transition_out) {
      const edge = episode.transitions.find((candidate) => candidate.id === scene.transition_out);
      if (edge && edge.from_scene !== scene.id) addSemanticError(errors, `/scenes/${sceneIndex}/transition_out`, "outgoing transition starts at another scene", "reference");
    }
    if (scene.transition_in) {
      const edge = episode.transitions.find((candidate) => candidate.id === scene.transition_in);
      if (edge && edge.to_scene !== scene.id) addSemanticError(errors, `/scenes/${sceneIndex}/transition_in`, "incoming transition ends at another scene", "reference");
    }
  });

  const questionBeats = episode.story_beats.filter((beat) => beat.function === "question");
  const childResponsePauses = scenes.flatMap((scene) => scene.audio.pauses)
    .filter((pause) => pause.purpose === "child_response");
  if (questionBeats.length !== 1) addSemanticError(errors, "/episode/story_beats", "episode requires exactly one child question beat", "semantic");
  if (childResponsePauses.length !== 1) addSemanticError(errors, "/scenes", "episode requires exactly one child-response pause", "semantic");

  const continuity = deriveContinuity(plan, { throwOnError: false });
  errors.push(...continuity.errors);
  const result = validationResult("episode_plan_invalid", errors, throwOnError);
  return { ...result, planned_duration_seconds: plannedDuration, continuity };
}

export function canonicalStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalStringify(value[key])}`).join(",")}}`;
}

export function contentHash(value) {
  return crypto.createHash("sha256").update(canonicalStringify(value)).digest("hex");
}
