import {
  CREATIVE_ENGINE_VERSION,
  CreativeValidationError,
  EPISODE_PLAN_VERSION,
  LEGACY_ADAPTER_VERSION,
  MAX_REPAIR_ATTEMPTS,
  SCENE_PLAN_VERSION,
  contentHash,
} from "./contracts.js";
import {
  acceptEpisodeGeneration,
  acceptIdeasGeneration,
  prepareEpisodeGeneration,
  prepareEpisodeRepair,
  prepareIdeasGeneration,
} from "./creative-engine.js";

export const AV2_BENCHMARK_ID = "lumi_cinco_huevos";

export class Av2IntegrationError extends Error {
  constructor(code, message, { status = 400, recoverable = false } = {}) {
    super(message);
    this.name = "Av2IntegrationError";
    this.code = code;
    this.status = status;
    this.recoverable = recoverable;
  }
}

function log(logger, event, fields = {}) {
  logger?.({ component: "av2_pipeline", event, ...fields });
}

function cleanIdempotencyKey(value) {
  const key = String(value || "").trim();
  if (!key || key.length > 180) {
    throw new Av2IntegrationError("missing_idempotency_key", "idempotency_key must contain 1-180 characters");
  }
  return key;
}

function identifiers(context = {}) {
  return {
    job_id: context.job_id || null,
    idea_id: context.idea_id == null ? null : Number(context.idea_id),
    video_id: context.video_id == null ? null : Number(context.video_id),
    episode_id: context.episode_id || null,
    benchmark_id: context.benchmark_id || null,
  };
}

export function selectCreativeEngine({ engineVersion = "legacy", benchmarkOnly = true, context = {} }) {
  if (engineVersion !== "v2") return { engine: "legacy", reason: "v2_disabled" };
  if (benchmarkOnly && context.benchmark_id !== AV2_BENCHMARK_ID) {
    return { engine: "legacy", reason: "benchmark_not_allowed" };
  }
  return { engine: "v2", reason: benchmarkOnly ? "benchmark_allowed" : "v2_enabled" };
}

function requireV2Gate(configuration, context) {
  const selected = selectCreativeEngine({ ...configuration, context });
  if (selected.engine !== "v2") {
    throw new Av2IntegrationError("creative_engine_v2_not_selected", selected.reason, { status: 409 });
  }
  return selected;
}

function baseRecord({ artifactType, request, context, idempotencyKey }) {
  const ids = identifiers(context);
  return {
    artifact_type: artifactType,
    request_hash: request.request_hash,
    idempotency_key: cleanIdempotencyKey(idempotencyKey),
    ...ids,
    creative_engine_version: CREATIVE_ENGINE_VERSION,
    episode_schema_version: artifactType === "episode_plan" ? EPISODE_PLAN_VERSION : null,
    scene_schema_version: artifactType === "episode_plan" ? SCENE_PLAN_VERSION : null,
    renderer_version: artifactType === "episode_plan" ? "lumi-story-v2" : null,
    adapter_version: artifactType === "episode_plan" ? LEGACY_ADAPTER_VERSION : null,
    status: "generating",
    validation_status: "pending",
    generation_attempt: 1,
    repair_attempt: 0,
    generation_metadata: {
      prompt_version: request.prompt_version,
      request_operation: request.operation,
      expected_llm_calls: request.expected_llm_calls,
    },
  };
}

function assertStoredHash(row) {
  if (!row.payload || !row.content_hash || contentHash(row.payload) !== row.content_hash) {
    throw new Av2IntegrationError("cached_artifact_hash_mismatch", "cached AV2 artifact failed its content hash", { status: 409 });
  }
}

function assertStoredVersions(row, artifactType) {
  const compatible = row.creative_engine_version === CREATIVE_ENGINE_VERSION
    && (artifactType !== "episode_plan" || (
      row.episode_schema_version === EPISODE_PLAN_VERSION
      && row.scene_schema_version === SCENE_PLAN_VERSION
      && row.adapter_version === LEGACY_ADAPTER_VERSION
    ));
  if (!compatible) {
    throw new Av2IntegrationError("incompatible_schema", "cached AV2 artifact uses an incompatible contract version", { status: 409 });
  }
}

export class Av2PipelineIntegration {
  constructor({ store, logger, engineVersion = "legacy", benchmarkOnly = true } = {}) {
    if (!store) throw new Error("an AV2 artifact store is required");
    this.store = store;
    this.logger = logger;
    this.configuration = { engineVersion, benchmarkOnly };
  }

  async resolveIdeas({ input, context = {}, idempotencyKey }) {
    requireV2Gate(this.configuration, context);
    if (!context.job_id) throw new Av2IntegrationError("missing_job_id", "job_id is required for ideas persistence");
    const request = prepareIdeasGeneration(input, { logger: this.logger });
    return this.#resolve("idea_set", request, context, idempotencyKey, (payload) => (
      acceptIdeasGeneration(payload, input, { logger: this.logger })
    ));
  }

  async acceptIdeas({ requestHash, payload, input = {}, context = {}, idempotencyKey }) {
    requireV2Gate(this.configuration, context);
    try {
      return await this.#accept("idea_set", requestHash, payload, context, idempotencyKey, (candidate) => (
        acceptIdeasGeneration(candidate, input, { logger: this.logger })
      ));
    } catch (error) {
      await this.#recordValidationFailure("idea_set", requestHash, idempotencyKey, error, false);
      throw error;
    }
  }

  async resolvePlan({ idea, context = {}, idempotencyKey }) {
    requireV2Gate(this.configuration, context);
    if (!context.idea_id && context.benchmark_id !== AV2_BENCHMARK_ID) {
      throw new Av2IntegrationError("missing_idea_id", "idea_id is required for episode persistence");
    }
    const request = prepareEpisodeGeneration({ idea }, { logger: this.logger });
    return this.#resolve("episode_plan", request, context, idempotencyKey, (payload) => (
      acceptEpisodeGeneration(payload, { logger: this.logger })
    ));
  }

  async acceptPlan({ requestHash, payload, context = {}, idempotencyKey }) {
    requireV2Gate(this.configuration, context);
    try {
      return await this.#accept("episode_plan", requestHash, payload, context, idempotencyKey, (candidate) => (
        acceptEpisodeGeneration(candidate, { logger: this.logger })
      ));
    } catch (error) {
      await this.#recordValidationFailure("episode_plan", requestHash, idempotencyKey, error, true);
      throw error;
    }
  }

  async requestRepair({ requestHash, payload, attempt, context = {}, idempotencyKey }) {
    requireV2Gate(this.configuration, context);
    if (!Number.isInteger(attempt) || attempt < 1 || attempt > MAX_REPAIR_ATTEMPTS) {
      throw new Av2IntegrationError("repair_limit_exceeded", `repair attempt must be between 1 and ${MAX_REPAIR_ATTEMPTS}`);
    }
    const row = await this.store.findByRequest("episode_plan", requestHash);
    this.#assertOwner(row, idempotencyKey);
    if (row.status === "valid") throw new Av2IntegrationError("artifact_already_valid", "a valid plan cannot enter repair", { status: 409 });
    const request = prepareEpisodeRepair({ plan: payload, attempt }, { logger: this.logger });
    const updated = await this.store.updateIfStatus(row.id, ["generating", "repairing"], {
      status: "repairing", validation_status: "invalid", repair_attempt: attempt,
    });
    if (!updated) throw new Av2IntegrationError("idempotency_conflict", "artifact state changed before repair", { status: 409 });
    log(this.logger, "repair_attempt", { artifact_id: row.id, request_hash: requestHash, repair_attempt: attempt });
    return { ok: true, operation: "repair_plan_persisted", state: "repair", artifact_id: row.id, request_hash: requestHash, request };
  }

  async attachVideo({ requestHash, videoId, context = {}, idempotencyKey }) {
    requireV2Gate(this.configuration, context);
    const row = await this.store.findByRequest("episode_plan", requestHash);
    this.#assertOwner(row, idempotencyKey);
    const normalized = Number(videoId);
    if (!Number.isInteger(normalized) || normalized <= 0) throw new Av2IntegrationError("invalid_video_id", "video_id must be a positive integer");
    if (row.video_id && Number(row.video_id) !== normalized) {
      throw new Av2IntegrationError("video_id_conflict", "the AV2 plan is already attached to another video", { status: 409 });
    }
    const updated = await this.store.attachVideo(row.id, normalized);
    if (!updated) throw new Av2IntegrationError("video_id_conflict", "the AV2 plan is already attached to another video", { status: 409 });
    log(this.logger, "persistence_attached", { artifact_id: row.id, request_hash: requestHash, video_id: normalized, persistence_result: "updated" });
    return { ok: true, operation: "attach_video", artifact_id: updated.id, request_hash: requestHash, video_id: normalized };
  }

  async recordFailure({ artifactType, requestHash, code, recoverable = false, failureId, context = {}, idempotencyKey }) {
    requireV2Gate(this.configuration, context);
    const row = await this.store.findByRequest(artifactType, requestHash);
    this.#assertOwner(row, idempotencyKey);
    if (row.status === "valid") {
      return {
        ok: true, operation: "record_failure", state: "ready", request_hash: requestHash,
        recoverable: false, retry: false, generation_attempt: row.generation_attempt,
      };
    }
    const safeCode = String(code || "unknown_failure").replace(/[^a-z0-9_-]/gi, "_").slice(0, 80);
    const safeFailureId = String(failureId || `${safeCode}:${row.generation_attempt}`).slice(0, 180);
    if (row.last_error?.failure_id === safeFailureId) {
      return {
        ok: row.status !== "failed", operation: "record_failure", request_hash: requestHash,
        error: safeCode, recoverable: row.status !== "failed", retry: row.status !== "failed",
        generation_attempt: row.generation_attempt, replay: true,
      };
    }
    const retry = Boolean(recoverable) && row.generation_attempt < 2;
    const updated = await this.store.updateIfStatus(row.id, ["generating", "repairing"], {
      status: retry ? "generating" : "failed",
      generation_attempt: retry ? row.generation_attempt + 1 : row.generation_attempt,
      validation_status: row.validation_status || "pending",
      last_error_code: safeCode,
      last_error: { code: safeCode, recoverable: Boolean(recoverable), failure_id: safeFailureId },
    });
    if (!updated) {
      const concurrent = await this.store.findByRequest(artifactType, requestHash);
      if (concurrent?.status === "valid") {
        return {
          ok: true, operation: "record_failure", state: "ready", request_hash: requestHash,
          recoverable: false, retry: false, generation_attempt: concurrent.generation_attempt,
        };
      }
      throw new Av2IntegrationError("idempotency_conflict", "artifact state changed while recording failure", { status: 409 });
    }
    log(this.logger, retry ? "generation_retry_allowed" : "generation_failed", {
      artifact_id: row.id, request_hash: requestHash, error_code: safeCode,
      generation_attempt: retry ? row.generation_attempt + 1 : row.generation_attempt,
    });
    return {
      ok: retry, operation: "record_failure", request_hash: requestHash, error: safeCode,
      recoverable: retry, retry, generation_attempt: retry ? row.generation_attempt + 1 : row.generation_attempt,
    };
  }

  async #resolve(artifactType, request, context, idempotencyKey, accept) {
    const key = cleanIdempotencyKey(idempotencyKey);
    let row = await this.store.findByRequest(artifactType, request.request_hash);
    if (row?.status === "valid") {
      assertStoredVersions(row, artifactType);
      assertStoredHash(row);
      const accepted = accept(row.payload);
      log(this.logger, "cache_hit", {
        artifact_id: row.id, job_id: row.job_id, idea_id: row.idea_id, video_id: row.video_id,
        episode_id: accepted.episode_id, request_hash: request.request_hash, content_hash: row.content_hash,
        cache_hit: true, validation_result: "valid", persistence_result: "reused",
      });
      return { ok: true, operation: `resolve_${artifactType}`, state: "ready", cache_hit: true, artifact_id: row.id, request_hash: request.request_hash, ...accepted };
    }
    if (row) {
      this.#assertOwner(row, key);
      const state = row.status === "failed" ? "failed" : (row.status === "repairing" ? "repairing" : "generate");
      log(this.logger, "cache_miss_replay", { artifact_id: row.id, request_hash: request.request_hash, cache_hit: false, generation_attempt: row.generation_attempt });
      return { ok: state !== "failed", operation: `resolve_${artifactType}`, state, cache_hit: false, replay: true, artifact_id: row.id, request_hash: request.request_hash, ...(state === "generate" ? { request } : {}), ...(state === "failed" ? { error: row.last_error_code } : {}) };
    }
    const claimed = await this.store.create(baseRecord({ artifactType, request, context, idempotencyKey: key }));
    row = claimed.record;
    if (!claimed.created) return this.#resolve(artifactType, request, context, key, accept);
    log(this.logger, "cache_miss", {
      artifact_id: row.id, job_id: row.job_id, idea_id: row.idea_id, request_hash: request.request_hash,
      cache_hit: false, generation_attempt: 1, persistence_result: "claimed",
    });
    return { ok: true, operation: `resolve_${artifactType}`, state: "generate", cache_hit: false, replay: false, artifact_id: row.id, request_hash: request.request_hash, request };
  }

  async #accept(artifactType, requestHash, payload, context, idempotencyKey, accept) {
    const row = await this.store.findByRequest(artifactType, requestHash);
    this.#assertOwner(row, idempotencyKey);
    const accepted = accept(payload);
    const payloadHash = contentHash(payload);
    if (row.status === "valid") {
      if (row.content_hash !== payloadHash) {
        throw new Av2IntegrationError("idempotency_conflict", "a different valid artifact already exists for this request", { status: 409 });
      }
      return { ok: true, operation: `accept_${artifactType}`, state: "ready", cache_hit: true, artifact_id: row.id, request_hash: requestHash, ...accepted };
    }
    const ids = identifiers(context);
    const patch = {
      ...Object.fromEntries(Object.entries(ids).filter(([, value]) => value !== null)),
      episode_id: accepted.episode_id || row.episode_id,
      status: "valid",
      validation_status: "valid",
      content_hash: payloadHash,
      payload,
      legacy_payload: artifactType === "episode_plan" ? accepted.legacy : accepted.job_result,
      validated_at: new Date().toISOString(),
      last_error_code: null,
      last_error: null,
    };
    const updated = await this.store.updateIfStatus(row.id, ["generating", "repairing"], patch);
    if (!updated) {
      const concurrent = await this.store.findByRequest(artifactType, requestHash);
      if (concurrent?.status === "valid" && concurrent.content_hash === payloadHash) {
        return { ok: true, operation: `accept_${artifactType}`, state: "ready", cache_hit: true, artifact_id: concurrent.id, request_hash: requestHash, ...accepted };
      }
      throw new Av2IntegrationError("idempotency_conflict", "artifact state changed during acceptance", { status: 409 });
    }
    log(this.logger, "persistence_succeeded", {
      artifact_id: updated.id, job_id: updated.job_id, idea_id: updated.idea_id, video_id: updated.video_id,
      episode_id: updated.episode_id, request_hash: requestHash, content_hash: payloadHash,
      validation_result: "valid", persistence_result: "stored", legacy_adaptation_result: "valid",
    });
    return { ok: true, operation: `accept_${artifactType}`, state: "ready", cache_hit: false, artifact_id: updated.id, request_hash: requestHash, ...accepted };
  }

  #assertOwner(row, idempotencyKey) {
    if (!row) throw new Av2IntegrationError("av2_artifact_not_found", "AV2 artifact does not exist", { status: 404 });
    const key = cleanIdempotencyKey(idempotencyKey);
    if (row.idempotency_key !== key) {
      throw new Av2IntegrationError("idempotency_conflict", "idempotency_key does not own this AV2 artifact", { status: 409 });
    }
  }

  async #recordValidationFailure(artifactType, requestHash, idempotencyKey, error, repairable) {
    if (!(error instanceof CreativeValidationError)) return;
    const row = await this.store.findByRequest(artifactType, requestHash);
    this.#assertOwner(row, idempotencyKey);
    const updated = await this.store.updateIfStatus(row.id, ["generating", "repairing"], {
      status: repairable ? "repairing" : "failed",
      validation_status: "invalid",
      last_error_code: error.code,
      last_error: {
        code: error.code,
        recoverable: repairable,
        errors: error.errors.slice(0, 40).map(({ path, keyword }) => ({ path, keyword })),
      },
    });
    if (!updated) return;
    log(this.logger, "validation_failure_persisted", {
      artifact_id: row.id, request_hash: requestHash, error_code: error.code,
      validation_result: "invalid", persistence_result: "stored",
    });
  }
}

export async function executeIntegratedOperation(body, { integration }) {
  if (body?.version !== "cf-prepare/1") throw new Av2IntegrationError("unsupported_prepare_version", "unsupported prepare contract version");
  const common = {
    context: body.context || {},
    idempotencyKey: body.idempotency_key,
  };
  switch (body.operation) {
    case "resolve_ideas":
      return integration.resolveIdeas({ input: body.input || {}, ...common });
    case "accept_ideas_persisted":
      return integration.acceptIdeas({ requestHash: body.request_hash, payload: body.payload, input: body.input || {}, ...common });
    case "resolve_plan":
      return integration.resolvePlan({ idea: body.input?.idea || body.input?.selected_idea, ...common });
    case "accept_plan_persisted":
      return integration.acceptPlan({ requestHash: body.request_hash, payload: body.payload, ...common });
    case "repair_plan_persisted":
      return integration.requestRepair({ requestHash: body.request_hash, payload: body.payload, attempt: body.attempt, ...common });
    case "attach_video":
      return integration.attachVideo({ requestHash: body.request_hash, videoId: body.video_id, ...common });
    case "record_failure":
      return integration.recordFailure({
        artifactType: body.artifact_type,
        requestHash: body.request_hash,
        code: body.error_code,
        recoverable: body.recoverable,
        failureId: body.failure_id,
        ...common,
      });
    default:
      throw new Av2IntegrationError("unsupported_prepare_operation", "unsupported persisted prepare operation");
  }
}
