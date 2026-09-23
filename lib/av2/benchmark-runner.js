import { Av2IntegrationError, AV2_BENCHMARK_ID } from "./pipeline-integration.js";
import { canonicalizeAv2Timeline } from "./canonicalizer.js";
import { contentHash, validateEpisodePlanStructure, validateScenePlan } from "./contracts.js";
import {
  AV2_LLM_EPISODE_TRANSPORT_VERSION,
  assertOpenAIStructuredOutputSchema,
  inspectOpenAIStructuredOutputSchema,
  transportToAv2Domain,
  validateEpisodeTransport,
} from "./llm-transport.js";

export const AV2_BENCHMARK_IDEMPOTENCY_KEY = "benchmark:lumi_cinco_huevos:v2";
export const DEFAULT_CREATIVE_MODEL = "gpt-5-mini";
export const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";

export const AV2_BENCHMARK_IDEA = Object.freeze({
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
});

const UNSUPPORTED_PROVIDER_KEYWORDS = new Set([
  "$schema", "$id", "default", "exclusiveMinimum", "maximum", "minimum",
  "maxItems", "minItems", "maxLength", "minLength", "maxProperties", "pattern", "uniqueItems",
]);

export function providerSchema(schema) {
  if (Array.isArray(schema)) return schema.map(providerSchema);
  if (!schema || typeof schema !== "object") return schema;
  const normalized = {};
  for (const [key, value] of Object.entries(schema)) {
    if (!UNSUPPORTED_PROVIDER_KEYWORDS.has(key)) normalized[key] = providerSchema(value);
  }
  if (normalized.type === "object" && normalized.properties) {
    normalized.required = Object.keys(normalized.properties);
    normalized.additionalProperties = false;
  }
  return normalized;
}

function outputText(response) {
  if (typeof response?.output_text === "string" && response.output_text.trim()) return response.output_text;
  for (const item of response?.output || []) {
    for (const content of item?.content || []) {
      if (content?.type === "output_text" && typeof content.text === "string") return content.text;
    }
  }
  throw new Av2IntegrationError("openai_empty_output", "OpenAI returned no structured episode plan", { status: 502 });
}

function sanitizedProviderField(value, maxLength = 500) {
  if (value == null) return null;
  return String(value)
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\bBearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]+\b/g, "[REDACTED]")
    .replace(/\b(api[_ -]?key|authorization)\s*[:=]\s*\S+/gi, "$1=[REDACTED]")
    .trim()
    .slice(0, maxLength) || null;
}

async function openAIErrorDiagnostic(response) {
  let payload = null;
  try {
    payload = typeof response?.json === "function" ? await response.json() : null;
  } catch {
    payload = null;
  }
  const providerError = payload?.error && typeof payload.error === "object" ? payload.error : {};
  const requestId = typeof response?.headers?.get === "function"
    ? (response.headers.get("x-request-id") || response.headers.get("request-id"))
    : null;
  return {
    http_status: Number(response?.status) || null,
    type: sanitizedProviderField(providerError.type, 100),
    code: sanitizedProviderField(providerError.code, 100),
    param: sanitizedProviderField(providerError.param, 160),
    message: sanitizedProviderField(providerError.message, 500),
    request_id: sanitizedProviderField(requestId, 160),
  };
}

async function generatePlan(request, { apiKey, fetchImpl, model }) {
  const providerRequest = buildOpenAIRequestEnvelope(request, { model });
  const requestInspection = inspectOpenAIRequestEnvelope(providerRequest);
  if (!requestInspection.ok) {
    throw new Av2IntegrationError("openai_request_contract_invalid", "OpenAI request failed local contract validation", {
      status: 500,
      diagnostic: { message: requestInspection.errors.join("; ").slice(0, 500) },
    });
  }
  const response = await fetchImpl(providerRequest.url, {
    method: providerRequest.method,
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(providerRequest.body),
  });
  if (!response.ok) {
    const diagnostic = await openAIErrorDiagnostic(response);
    throw new Av2IntegrationError("openai_generation_failed", `OpenAI request failed with HTTP ${response.status}`, {
      status: 502,
      recoverable: response.status === 429 || response.status >= 500,
      providerCalled: true,
      diagnostic,
    });
  }
  const raw = await response.json();
  let transport;
  try {
    transport = JSON.parse(outputText(raw));
  } catch (error) {
    if (error instanceof Av2IntegrationError) throw error;
    throw new Av2IntegrationError("openai_invalid_json", "OpenAI returned invalid structured JSON", { status: 502 });
  }
  return {
    transport,
    metadata: {
      provider: "openai",
      model,
      provider_response_id: typeof raw.id === "string" ? raw.id : null,
      provider_created_at: Number.isFinite(Number(raw.created_at))
        ? new Date(Number(raw.created_at) * 1000).toISOString()
        : null,
      request_payload_hash: contentHash(providerRequest.body),
      transport_version: AV2_LLM_EPISODE_TRANSPORT_VERSION,
      input_tokens: Number(raw.usage?.input_tokens || 0),
      output_tokens: Number(raw.usage?.output_tokens || 0),
    },
  };
}

export function buildOpenAIResponseRequest(request, { model = DEFAULT_CREATIVE_MODEL } = {}) {
  if (request?.response_format?.type !== "json_schema" || request?.response_format?.strict !== true
      || !/^[a-z0-9_]{1,64}$/.test(request?.response_format?.name || "")) {
    throw new Error("request requires a named strict Structured Outputs contract");
  }
  assertOpenAIStructuredOutputSchema(request.response_format.schema);
  return {
    model,
    store: false,
    max_output_tokens: 50000,
    input: [
      { role: "system", content: request.instructions },
      { role: "user", content: JSON.stringify(request.input) },
    ],
    text: {
      format: {
        type: "json_schema",
        name: request.response_format.name,
        strict: true,
        schema: request.response_format.schema,
      },
    },
  };
}

export function buildOpenAIRequestEnvelope(request, options = {}) {
  return {
    method: "POST",
    url: OPENAI_RESPONSES_URL,
    body: buildOpenAIResponseRequest(request, options),
  };
}

export function inspectOpenAIRequestEnvelope(envelope) {
  const errors = [];
  const body = envelope?.body;
  if (envelope?.method !== "POST") errors.push("method must be POST");
  if (envelope?.url !== OPENAI_RESPONSES_URL) errors.push("url must target the Responses API");
  if (!body || typeof body !== "object" || Array.isArray(body)) errors.push("body must be an object");
  if (body && Object.hasOwn(body, "response_format")) errors.push("Responses API must not use response_format");
  if (typeof body?.model !== "string" || !body.model) errors.push("model is required");
  if (body?.store !== false) errors.push("store must be false");
  if (!Number.isInteger(body?.max_output_tokens) || body.max_output_tokens < 1) errors.push("max_output_tokens must be positive");
  if (!Array.isArray(body?.input) || body.input.length !== 2
      || body.input[0]?.role !== "system" || typeof body.input[0]?.content !== "string"
      || body.input[1]?.role !== "user" || typeof body.input[1]?.content !== "string") {
    errors.push("input must contain system and user messages");
  }
  const format = body?.text?.format;
  if (format?.type !== "json_schema") errors.push("text.format.type must be json_schema");
  if (format?.strict !== true) errors.push("text.format.strict must be true");
  if (!/^[a-z0-9_]{1,64}$/.test(format?.name || "")) errors.push("transport schema name is invalid");
  const schemaInspection = inspectOpenAIStructuredOutputSchema(format?.schema);
  if (!schemaInspection.ok) errors.push(...schemaInspection.errors.map((error) => (
    `schema ${error.path} ${error.keyword}`
  )));
  return {
    ok: errors.length === 0,
    errors,
    api: "responses",
    model: body?.model || null,
    schema: schemaInspection,
    serialized_request_bytes: Buffer.byteLength(JSON.stringify(body || null)),
  };
}

export async function replayPersistedBenchmark({
  integration,
  requestHash,
  generationAttempt,
  context = { benchmark_id: AV2_BENCHMARK_ID, episode_id: AV2_BENCHMARK_ID },
  idempotencyKey = AV2_BENCHMARK_IDEMPOTENCY_KEY,
} = {}) {
  const persisted = await integration.loadProviderOutput({
    artifactType: "episode_plan",
    requestHash,
    generationAttempt,
    context,
    idempotencyKey,
  });
  validateEpisodeTransport(persisted.raw_transport);
  const normalized = transportToAv2Domain(persisted.raw_transport);
  validateEpisodePlanStructure(normalized);
  normalized.scenes.forEach((scene) => validateScenePlan(scene));
  const canonical = canonicalizeAv2Timeline(normalized);
  const accepted = await integration.acceptPlan({
    requestHash,
    payload: canonical.plan,
    context,
    idempotencyKey,
    repairable: false,
    validationMetadata: {
      raw_transport_hash: persisted.raw_transport_hash,
      canonicalizer_version: canonical.version,
      canonical_domain_hash: contentHash(canonical.plan),
      canonical_timeline: canonical.timeline,
      canonical_change_count: canonical.changes.length,
    },
  });
  return { ...accepted, canonical, raw_transport_hash: persisted.raw_transport_hash };
}

export async function runCanonicalBenchmark({
  integration,
  apiKey,
  fetchImpl = fetch,
  model = DEFAULT_CREATIVE_MODEL,
} = {}) {
  if (!integration) throw new Error("AV2 integration is required");
  if (!apiKey) throw new Av2IntegrationError("openai_api_not_configured", "OPENAI_API_KEY is required", { status: 503 });
  const context = { benchmark_id: AV2_BENCHMARK_ID, episode_id: AV2_BENCHMARK_ID };
  const resolved = await integration.resolvePlan({
    idea: AV2_BENCHMARK_IDEA,
    context,
    idempotencyKey: AV2_BENCHMARK_IDEMPOTENCY_KEY,
  });
  if (resolved.state === "ready") {
    const row = await integration.store.findByRequest("episode_plan", resolved.request_hash);
    return {
      ...resolved,
      provider_calls: 0,
      provider_call_count_total: Number(row?.generation_metadata?.provider_call_count || 0),
    };
  }
  if (resolved.state !== "generate") {
    throw new Av2IntegrationError("benchmark_artifact_not_generatable", `Benchmark artifact is ${resolved.state}`, { status: 409 });
  }

  let generated;
  try {
    generated = await generatePlan(resolved.request, { apiKey, fetchImpl, model });
  } catch (error) {
    await integration.recordFailure({
      artifactType: "episode_plan",
      requestHash: resolved.request_hash,
      code: error.code || "openai_generation_failed",
      recoverable: Boolean(error.recoverable),
      failureId: `benchmark:${resolved.request_hash}:${Number(resolved.generation_attempt || 1)}`,
      context,
      idempotencyKey: AV2_BENCHMARK_IDEMPOTENCY_KEY,
      providerCalled: Boolean(error.providerCalled),
      providerError: error.providerCalled ? (error.diagnostic || null) : null,
    });
    throw error;
  }

  const persisted = await integration.persistProviderOutput({
    artifactType: "episode_plan",
    requestHash: resolved.request_hash,
    generationAttempt: resolved.generation_attempt,
    rawTransport: generated.transport,
    providerMetadata: generated.metadata,
    context,
    idempotencyKey: AV2_BENCHMARK_IDEMPOTENCY_KEY,
  });
  const accepted = await replayPersistedBenchmark({
    integration,
    requestHash: resolved.request_hash,
    generationAttempt: resolved.generation_attempt,
    context,
    idempotencyKey: AV2_BENCHMARK_IDEMPOTENCY_KEY,
  });
  return {
    ...accepted,
    provider_calls: 1,
    provider_call_count_total: persisted.provider_call_count_total,
    provider_model: model,
  };
}
