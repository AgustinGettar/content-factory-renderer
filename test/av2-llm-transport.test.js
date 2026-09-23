import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  CREATIVE_ENGINE_VERSION,
  EPISODE_PLAN_VERSION,
  LEGACY_ADAPTER_VERSION,
  SCENE_PLAN_VERSION,
  deriveContinuity,
  validateEpisodePlan,
  validateScenePlan,
} from "../lib/av2/contracts.js";
import { acceptEpisodeGeneration } from "../lib/av2/creative-engine.js";
import {
  AV2_BENCHMARK_IDEA,
  AV2_BENCHMARK_IDEMPOTENCY_KEY,
  buildOpenAIResponseRequest,
  runCanonicalBenchmark,
} from "../lib/av2/benchmark-runner.js";
import { buildEpisodePlanRequest } from "../lib/av2/prompts.js";
import {
  AV2_LLM_EPISODE_TRANSPORT_SCHEMA_NAME,
  AV2_LLM_EPISODE_TRANSPORT_VERSION,
  inspectOpenAIStructuredOutputSchema,
  transportToAv2Domain,
  validateEpisodeTransport,
} from "../lib/av2/llm-transport.js";
import { InMemoryCreativeArtifactStore } from "../lib/av2/persistence.js";
import { Av2PipelineIntegration } from "../lib/av2/pipeline-integration.js";

const fixture = JSON.parse(await readFile(
  new URL("./fixtures/lumi-cinco-huevos.transport.json", import.meta.url), "utf8",
));

function clone(value = fixture) {
  return structuredClone(value);
}

function invalidDomain(plan) {
  return validateEpisodePlan(plan, { throwOnError: false });
}

test("transport schema is OpenAI strict-compatible and request uses it exactly", () => {
  const inspection = inspectOpenAIStructuredOutputSchema();
  assert.equal(inspection.ok, true);
  assert.ok(inspection.property_count < 5000);
  assert.ok(inspection.max_object_depth <= 10);

  const request = buildEpisodePlanRequest({ idea: AV2_BENCHMARK_IDEA });
  const body = buildOpenAIResponseRequest(request, { model: "gpt-5-mini" });
  assert.equal(body.text.format.type, "json_schema");
  assert.equal(body.text.format.strict, true);
  assert.equal(body.text.format.name, AV2_LLM_EPISODE_TRANSPORT_SCHEMA_NAME);
  assert.equal(body.text.format.schema, request.response_format.schema);
  assert.match(body.input[0].content, new RegExp(AV2_LLM_EPISODE_TRANSPORT_VERSION.replace("/", "\\/")));
  assert.equal(JSON.stringify(body).includes('"type":"json_object"'), false);
});

test("canonical transport fixture passes the complete local AV2 pipeline", () => {
  assert.deepEqual(validateEpisodeTransport(fixture), { ok: true, errors: [] });
  const plan = transportToAv2Domain(fixture);
  const episodeValidation = validateEpisodePlan(plan, { throwOnError: false });
  assert.equal(episodeValidation.ok, true);
  assert.ok(plan.scenes.every((scene) => validateScenePlan(scene, { throwOnError: false }).ok));
  assert.equal(deriveContinuity(plan, { throwOnError: false }).ok, true);

  const eggs = plan.entities.filter((entity) => entity.tags.includes("egg"));
  const progression = plan.scenes.flatMap((scene) => scene.continuity.operations)
    .filter((operation) => operation.path === "educational_progress.count_reached")
    .map((operation) => operation.value);
  const childPauses = plan.scenes.flatMap((scene) => scene.audio.pauses)
    .filter((pause) => pause.purpose === "child_response" && pause.duration_seconds >= 2);
  const lumiActions = plan.scenes.flatMap((scene) => scene.actions)
    .filter((action) => action.entity_id === "lumi");
  const cameraMoves = new Set(plan.scenes.map((scene) => scene.camera.move));
  const layers = new Set(plan.scenes.flatMap((scene) => scene.stage.placements.map((placement) => placement.layer)));
  assert.equal(plan.version, EPISODE_PLAN_VERSION);
  assert.equal(plan.episode.id, "lumi_cinco_huevos");
  assert.equal(eggs.length, 5);
  assert.deepEqual(progression, [1, 2, 3, 4, 5]);
  assert.ok(childPauses.length >= 1);
  assert.ok(lumiActions.length >= plan.scenes.length);
  assert.ok(cameraMoves.size >= 3);
  assert.ok(plan.scenes.every((scene) => scene.stage.environment_ref.id));
  assert.ok(layers.has("midground") && layers.has("foreground"));
  assert.ok(plan.episode.music_direction.rules.length > 0);
  assert.equal(plan.episode.transitions.length, plan.scenes.length - 1);

  const accepted = acceptEpisodeGeneration(plan);
  assert.ok(accepted.legacy.scenes.every((scene) => (
    scene.narration && scene.visual_prompt && scene.on_screen_text
    && scene.duration_seconds > 0 && scene.metadata.production
  )));
});

test("A missing acting is rejected by transport validation", () => {
  const value = clone();
  delete value.episode_plan.scenes[0].actions;
  assert.equal(validateEpisodeTransport(value, { throwOnError: false }).ok, false);
});

test("B missing continuity is rejected by transport validation", () => {
  const value = clone();
  delete value.episode_plan.scenes[0].continuity;
  assert.equal(validateEpisodeTransport(value, { throwOnError: false }).ok, false);
});

test("C unknown prop reference is rejected by domain validation", () => {
  const value = clone();
  value.episode_plan.scenes[0].stage.placements[0].entity_id = "missing_prop";
  const result = invalidDomain(transportToAv2Domain(value));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.keyword === "reference"));
});

test("D duplicate IDs are rejected by domain semantics", () => {
  const value = clone();
  value.episode_plan.scenes[1].id = value.episode_plan.scenes[0].id;
  const result = invalidDomain(transportToAv2Domain(value));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.keyword === "unique"));
});

test("E six countable eggs are rejected for count 1 through 5", () => {
  const value = clone();
  const sixth = clone(value.episode_plan.entities.find((entity) => entity.id === "egg_05"));
  sixth.id = "egg_06";
  value.episode_plan.entities.push(sixth);
  const result = invalidDomain(transportToAv2Domain(value));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.message.includes("exactly 5 countable")));
});

test("F missing child-response pause is rejected by domain semantics", () => {
  const value = clone();
  const questionBeat = value.episode_plan.episode.story_beats.find((beat) => beat.function === "question");
  const scene = value.episode_plan.scenes.find((candidate) => candidate.beat_ref === questionBeat.id);
  scene.audio.pauses = [];
  const result = invalidDomain(transportToAv2Domain(value));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.message.includes("child_response pause")));
});

test("G transport-valid duplicate map keys are rejected by normalization", () => {
  const value = clone();
  value.episode_plan.episode.continuity_initial.push(clone(value.episode_plan.episode.continuity_initial[0]));
  assert.equal(validateEpisodeTransport(value, { throwOnError: false }).ok, true);
  assert.throws(() => transportToAv2Domain(value), (error) => error.code === "episode_transport_normalization_invalid");
});

test("H arbitrary transport fields are rejected", () => {
  const value = clone();
  value.arbitrary = "not_allowed";
  const result = validateEpisodeTransport(value, { throwOnError: false });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.keyword === "additionalProperties"));
});

test("failed benchmark retry rebinds one logical row, persists once, then caches", async () => {
  const store = new InMemoryCreativeArtifactStore();
  const prior = await store.create({
    artifact_type: "episode_plan",
    request_hash: "a".repeat(64),
    idempotency_key: AV2_BENCHMARK_IDEMPOTENCY_KEY,
    benchmark_id: "lumi_cinco_huevos",
    episode_id: "lumi_cinco_huevos",
    creative_engine_version: CREATIVE_ENGINE_VERSION,
    episode_schema_version: EPISODE_PLAN_VERSION,
    scene_schema_version: SCENE_PLAN_VERSION,
    adapter_version: LEGACY_ADAPTER_VERSION,
    renderer_version: "lumi-story-v2",
    status: "failed",
    validation_status: "invalid",
    content_hash: null,
    generation_attempt: 2,
    repair_attempt: 0,
    generation_metadata: { provider_call_count: 2 },
    last_error_code: "episode_plan_invalid",
    last_error: { code: "episode_plan_invalid", recoverable: false, failure_id: "attempt-2" },
  });
  const integration = new Av2PipelineIntegration({ store, engineVersion: "v2", benchmarkOnly: true });
  let providerCalls = 0;
  const fetchImpl = async () => {
    providerCalls += 1;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        id: "resp_transport_fixture",
        output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(fixture) }] }],
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    };
  };
  const generated = await runCanonicalBenchmark({ integration, apiKey: "configured", fetchImpl });
  const cached = await runCanonicalBenchmark({ integration, apiKey: "configured", fetchImpl });
  assert.equal(providerCalls, 1);
  assert.equal(store.records.length, 1);
  assert.equal(generated.artifact_id, prior.record.id);
  assert.equal(cached.artifact_id, generated.artifact_id);
  assert.equal(cached.episode_sha256, generated.episode_sha256);
  assert.equal(cached.cache_hit, true);
  assert.equal(store.records[0].status, "valid");
  assert.equal(store.records[0].generation_attempt, 3);
  assert.equal(store.records[0].generation_metadata.provider_call_count, 3);
  assert.deepEqual(store.records[0].generation_metadata.previous_failures, [{
    attempt: 2, code: "episode_plan_invalid", recoverable: false, failure_id: "attempt-2",
  }]);
});
