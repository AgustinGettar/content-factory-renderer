import { Av2IntegrationError, AV2_BENCHMARK_ID } from "./pipeline-integration.js";
import {
  AV2_LLM_EPISODE_TRANSPORT_SCHEMA_NAME,
  AV2_LLM_EPISODE_TRANSPORT_VERSION,
  assertOpenAIStructuredOutputSchema,
  transportToAv2Domain,
} from "./llm-transport.js";

export const AV2_BENCHMARK_IDEMPOTENCY_KEY = "benchmark:lumi_cinco_huevos:v2";
export const DEFAULT_CREATIVE_MODEL = "gpt-5-mini";

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

async function generatePlan(request, { apiKey, fetchImpl, model }) {
  const providerRequest = buildOpenAIResponseRequest(request, { model });
  const response = await fetchImpl("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(providerRequest),
  });
  if (!response.ok) {
    throw new Av2IntegrationError("openai_generation_failed", `OpenAI request failed with HTTP ${response.status}`, {
      status: 502,
      recoverable: response.status === 429 || response.status >= 500,
    });
  }
  const raw = await response.json();
  let payload;
  try {
    payload = transportToAv2Domain(JSON.parse(outputText(raw)));
  } catch (error) {
    if (error instanceof Av2IntegrationError) throw error;
    throw new Av2IntegrationError("openai_invalid_json", "OpenAI returned invalid structured JSON", { status: 502 });
  }
  return {
    payload,
    metadata: {
      provider: "openai",
      model,
      provider_response_id: typeof raw.id === "string" ? raw.id : null,
      provider_call_count: 1,
      transport_version: AV2_LLM_EPISODE_TRANSPORT_VERSION,
      input_tokens: Number(raw.usage?.input_tokens || 0),
      output_tokens: Number(raw.usage?.output_tokens || 0),
    },
  };
}

export function buildOpenAIResponseRequest(request, { model = DEFAULT_CREATIVE_MODEL } = {}) {
  if (request?.response_format?.name !== AV2_LLM_EPISODE_TRANSPORT_SCHEMA_NAME) {
    throw new Error("canonical benchmark requires the AV2 episode transport contract");
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
    });
    throw error;
  }

  const accepted = await integration.acceptPlan({
    requestHash: resolved.request_hash,
    payload: generated.payload,
    context,
    idempotencyKey: AV2_BENCHMARK_IDEMPOTENCY_KEY,
  });
  const row = await integration.store.findByRequest("episode_plan", resolved.request_hash);
  const providerCallCountTotal = Math.max(
    Number(row?.generation_attempt || resolved.generation_attempt || 1),
    Number(row?.generation_metadata?.provider_call_count || 0) + 1,
  );
  await integration.store.update(accepted.artifact_id, {
    generation_metadata: {
      ...row.generation_metadata,
      ...generated.metadata,
      provider_call_count: providerCallCountTotal,
    },
  });
  return {
    ...accepted,
    provider_calls: 1,
    provider_call_count_total: providerCallCountTotal,
    provider_model: model,
  };
}
