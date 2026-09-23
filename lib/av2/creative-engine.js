import {
  MAX_REPAIR_ATTEMPTS,
  contentHash,
  validateEpisodePlan,
  validateIdeaBrief,
  validateIdeaSet,
  validateEpisodePlanStructure,
} from "./contracts.js";
import { canonicalizeAv2Timeline } from "./canonicalizer.js";
import { adaptEpisodeToLegacy, adaptIdeasToLegacyChoices } from "./compat.js";
import { buildEpisodePlanRequest, buildIdeasRequest, buildRepairRequest } from "./prompts.js";
import { transportToAv2Domain, transportToIdeaDomain } from "./llm-transport.js";

function eventLogger(logger, event, fields = {}) {
  logger?.({ component: "creative_engine_v2", event, ...fields });
}

export function prepareIdeasGeneration(input, { logger } = {}) {
  const request = buildIdeasRequest(input);
  eventLogger(logger, "creative_generation_requested", { operation: "ideas", request_hash: request.request_hash });
  return request;
}

export function acceptIdeasGeneration(ideaSet, options = {}, { logger } = {}) {
  try {
    const domainIdeaSet = ideaSet?.transport_version ? transportToIdeaDomain(ideaSet) : ideaSet;
    validateIdeaSet(domainIdeaSet, options);
    const result = {
      version: domainIdeaSet.version,
      ideas: domainIdeaSet.ideas,
      idea_set: domainIdeaSet,
      ideas_sha256: contentHash(domainIdeaSet),
      legacy_choices: adaptIdeasToLegacyChoices(domainIdeaSet),
    };
    result.job_result = result.legacy_choices;
    eventLogger(logger, "schema_validation_passed", { operation: "ideas", ideas_sha256: result.ideas_sha256 });
    return result;
  } catch (error) {
    eventLogger(logger, "schema_validation_failed", { operation: "ideas", error_code: error.code || "idea_set_invalid" });
    throw error;
  }
}

export function prepareEpisodeGeneration({ idea }, { logger } = {}) {
  validateIdeaBrief(idea);
  const request = buildEpisodePlanRequest({ idea });
  eventLogger(logger, "creative_generation_requested", { operation: "episode", idea_id: idea.id, request_hash: request.request_hash });
  return request;
}

export function acceptEpisodeGeneration(plan, { logger } = {}) {
  try {
    const normalized = plan?.transport_version ? transportToAv2Domain(plan) : plan;
    validateEpisodePlanStructure(normalized);
    const canonical = canonicalizeAv2Timeline(normalized);
    const validation = validateEpisodePlan(canonical.plan);
    const legacy = adaptEpisodeToLegacy(canonical.plan);
    const result = {
      version: canonical.plan.version,
      episode_id: canonical.plan.episode.id,
      episode_sha256: legacy.episode_sha256,
      planned_duration_seconds: validation.planned_duration_seconds,
      episode_plan: canonical.plan,
      canonicalization: {
        version: canonical.version,
        timeline: canonical.timeline,
        change_count: canonical.changes.length,
      },
      legacy,
    };
    eventLogger(logger, "schema_validation_passed", {
      operation: "episode", episode_id: result.episode_id, episode_sha256: result.episode_sha256,
    });
    return result;
  } catch (error) {
    const sceneIndex = Number(error.errors?.find((entry) => /^\/scenes\/\d+/.test(entry.path))?.path.split("/")[2]);
    eventLogger(logger, "schema_validation_failed", {
      operation: "episode", episode_id: plan?.episode?.id,
      scene_id: Number.isInteger(sceneIndex) ? plan?.scenes?.[sceneIndex]?.id : undefined,
      error_code: error.code || "episode_plan_invalid",
    });
    throw error;
  }
}

export function prepareEpisodeRepair({ plan, attempt }, { logger } = {}) {
  const normalized = plan?.transport_version ? transportToAv2Domain(plan) : plan;
  validateEpisodePlanStructure(normalized);
  const canonical = canonicalizeAv2Timeline(normalized);
  const validation = validateEpisodePlan(canonical.plan, { throwOnError: false });
  if (validation.ok) throw new Error("episode plan is already valid");
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > MAX_REPAIR_ATTEMPTS) {
    throw new Error(`repair attempt must be between 1 and ${MAX_REPAIR_ATTEMPTS}`);
  }
  const request = buildRepairRequest({ plan: canonical.plan, errors: validation.errors, attempt });
  eventLogger(logger, "repair_requested", {
    episode_id: plan?.episode?.id, attempt, error_count: validation.errors.length, request_hash: request.request_hash,
  });
  return request;
}

export function executePrepareOperation(body, { logger } = {}) {
  if (body?.version !== "cf-prepare/1") throw new Error("unsupported prepare contract version");
  switch (body.operation) {
    case "ideas_request":
      return { ok: true, operation: body.operation, request: prepareIdeasGeneration(body.input || {}, { logger }) };
    case "accept_ideas":
      return { ok: true, operation: body.operation, ...acceptIdeasGeneration(body.payload, body.context || {}, { logger }) };
    case "plan_request":
      return {
        ok: true,
        operation: body.operation,
        request: prepareEpisodeGeneration({ idea: body.input?.idea || body.input?.selected_idea }, { logger }),
      };
    case "accept_plan":
      return { ok: true, operation: body.operation, ...acceptEpisodeGeneration(body.payload, { logger }) };
    case "repair_plan_request":
      return { ok: true, operation: body.operation, request: prepareEpisodeRepair({ plan: body.payload, attempt: body.attempt }, { logger }) };
    default:
      throw new Error("unsupported prepare operation");
  }
}
