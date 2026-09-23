import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  IDEA_SET_SCHEMA,
  contentHash,
  validateEpisodePlan,
  validateIdeaSet,
} from "../lib/av2/contracts.js";
import {
  AV2_AUTHORITY_MODEL,
  AV2_CANONICAL_ANCHOR_GRAMMAR,
  canonicalizeAv2Timeline,
} from "../lib/av2/canonicalizer.js";
import {
  AV2_LLM_EPISODE_TRANSPORT_SCHEMA,
  AV2_LLM_EPISODE_TRANSPORT_SCHEMA_NAME,
  AV2_LLM_IDEA_TRANSPORT_SCHEMA,
  AV2_LLM_IDEA_TRANSPORT_SCHEMA_NAME,
  ideaDomainToTransport,
  inspectOpenAIStructuredOutputSchema,
  transportToAv2Domain,
  transportToIdeaDomain,
  validateIdeaTransport,
} from "../lib/av2/llm-transport.js";
import {
  AV2_BENCHMARK_IDEA,
  AV2_BENCHMARK_IDEMPOTENCY_KEY,
  buildOpenAIRequestEnvelope,
  inspectOpenAIRequestEnvelope,
  replayPersistedBenchmark,
  runCanonicalBenchmark,
} from "../lib/av2/benchmark-runner.js";
import { buildEpisodePlanRequest, buildIdeasRequest, buildRepairRequest } from "../lib/av2/prompts.js";
import { InMemoryCreativeArtifactStore } from "../lib/av2/persistence.js";
import { Av2PipelineIntegration } from "../lib/av2/pipeline-integration.js";

const transportFixture = JSON.parse(await readFile(
  new URL("./fixtures/lumi-cinco-huevos.transport.json", import.meta.url), "utf8",
));

function clone(value = transportFixture) {
  return structuredClone(value);
}

function ideaSetFixture() {
  const dimensions = [
    ["bosque", "lost_path", "count_steps", "follow_fireflies", "point_next", "lantern_glow", "Cinco luciérnagas iluminan el sendero", "Un sendero nocturno se dividió y cada luz revela un paso seguro hasta la cabaña."],
    ["playa", "mixed_shells", "group_objects", "sort_shells", "choose_group", "sand_castle", "Conchas viajeras para un castillo", "La marea mezcló tesoros de colores; agruparlos permite decorar una torre de arena."],
    ["cocina", "missing_recipe", "measure_spoons", "fill_bowls", "say_amount", "picnic", "La receta secreta del picnic", "Un recetario perdió sus medidas y las cucharas correctas completan cada cuenco."],
    ["cielo", "cloud_order", "sequence_shapes", "guide_kites", "predict_next", "rainbow", "Cometas que ordenan las nubes", "El viento desacomodó figuras celestes y una secuencia guía las cometas de regreso."],
    ["jardin", "sleepy_flowers", "match_colors", "wake_flowers", "find_match", "bloom", "Flores dormidas buscan su color", "Pétalos apagados despiertan cuando el niño encuentra parejas cromáticas entre hojas."],
  ];
  return {
    version: "cf-ideas/2.0",
    category: "números",
    ideas: dimensions.map(([world, problem, mechanism, activity, interaction, reward, title, premise], index) => ({
      id: `idea_distinta_${index + 1}`,
      title,
      category: "números",
      age_range: { min_years: 3, max_years: 5 },
      learning: { objective: `Practicar una habilidad numérica mediante ${activity}.`, secondary_skill: "atención", mechanism },
      world_ref: { id: `world_${world}`, version: "catalog-v1" },
      story: { premise, problem_type: problem, challenge: `Completar ${activity} sin perder la secuencia educativa.` },
      activity_id: activity,
      secondary_characters: [`amigo_${index + 1}`],
      interaction: { type: interaction, prompt_goal: `El niño participa en ${interaction} antes de la resolución.` },
      resolution: { reward_type: reward, reward: `La aventura termina con ${reward} como consecuencia de la acción.` },
    })),
  };
}

test("Ideas, Episode and Repair use strict-compatible transport contracts", () => {
  const plan = transportToAv2Domain(transportFixture);
  const requests = [
    buildIdeasRequest({ category: "números" }),
    buildEpisodePlanRequest({ idea: AV2_BENCHMARK_IDEA }),
    buildRepairRequest({
      plan,
      errors: [{ path: "/scenes/0/stage/placements/0/entity_id", keyword: "reference", message: "unknown creative prop" }],
      attempt: 1,
    }),
  ];
  assert.equal(requests[0].response_format.name, AV2_LLM_IDEA_TRANSPORT_SCHEMA_NAME);
  assert.equal(requests[1].response_format.name, AV2_LLM_EPISODE_TRANSPORT_SCHEMA_NAME);
  assert.equal(requests[2].response_format.name, AV2_LLM_EPISODE_TRANSPORT_SCHEMA_NAME);
  assert.equal(requests[1].response_format.schema, requests[2].response_format.schema);
  for (const request of requests) {
    assert.equal(inspectOpenAIStructuredOutputSchema(request.response_format.schema).ok, true);
    assert.equal(inspectOpenAIRequestEnvelope(buildOpenAIRequestEnvelope(request)).ok, true);
  }
  assert.equal(inspectOpenAIStructuredOutputSchema(IDEA_SET_SCHEMA).ok, false);
});

test("Idea transport normalizes to five valid and diverse mini lessons", () => {
  const domain = ideaSetFixture();
  const transport = ideaDomainToTransport(domain);
  assert.deepEqual(validateIdeaTransport(transport), { ok: true, errors: [] });
  const normalized = transportToIdeaDomain(transport);
  assert.deepEqual(normalized, domain);
  assert.deepEqual(validateIdeaSet(normalized, { category: "números" }), { ok: true, errors: [] });
});

test("authority model keeps creative content with the LLM and mechanics with the engine", () => {
  assert.ok(AV2_AUTHORITY_MODEL.llm.includes("narration"));
  assert.ok(AV2_AUTHORITY_MODEL.llm.includes("transition_style"));
  assert.ok(AV2_AUTHORITY_MODEL.engine.includes("timeline"));
  assert.ok(AV2_AUTHORITY_MODEL.engine.includes("transition_from_scene"));
  assert.deepEqual(AV2_CANONICAL_ANCHOR_GRAMMAR.transport_aliases, ["scene_start", "scene_end", "mid_scene"]);
});

test("canonicalizer repairs derivable anchors, transition edges and one-frame duration drift", () => {
  const plan = transportToAv2Domain(clone());
  plan.scenes.at(-1).duration_target_seconds = 10.02;
  plan.scenes[0].camera.start.anchor = "scene_start";
  plan.episode.transitions[0].from_scene = "s09";
  plan.episode.transitions[0].to_scene = "s01";
  plan.scenes[0].transition_out = "edge_wrong";
  const before = validateEpisodePlan(plan, { throwOnError: false });
  assert.equal(before.ok, false);
  assert.ok(before.errors.some((error) => error.keyword === "timing"));
  assert.ok(before.errors.some((error) => error.keyword === "timing_reference"));
  assert.ok(before.errors.some((error) => error.keyword === "reference"));

  const canonical = canonicalizeAv2Timeline(plan);
  const after = validateEpisodePlan(canonical.plan, { throwOnError: false });
  assert.equal(after.ok, true);
  assert.equal(canonical.timeline.planned_duration_seconds, 50);
  assert.equal(canonical.timeline.duration_adjusted, true);
  assert.equal(canonical.plan.scenes[0].camera.start.anchor, "scene.start");
  assert.equal(canonical.plan.episode.transitions[0].from_scene, "s01");
  assert.equal(canonical.plan.episode.transitions[0].to_scene, "s02");
  assert.equal(canonical.plan.scenes[0].transition_out, canonical.plan.episode.transitions[0].id);
});

test("51.1333 seconds exceeds the explicit one-frame normalization tolerance", () => {
  const plan = transportToAv2Domain(clone());
  plan.scenes.at(-1).duration_target_seconds = 11.1333;
  const canonical = canonicalizeAv2Timeline(plan);
  assert.equal(canonical.timeline.planned_duration_seconds, 51.1333);
  assert.equal(canonical.timeline.duration_adjusted, false);
  const result = validateEpisodePlan(canonical.plan, { throwOnError: false });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.keyword === "timing"));
});

test("canonicalizer is idempotent, hash-stable and does not alter creative content", () => {
  const plan = transportToAv2Domain(clone());
  const narration = plan.scenes.map((scene) => scene.audio.utterances);
  const acting = plan.scenes.map((scene) => scene.actions.map(({ start: _start, ...action }) => action));
  const once = canonicalizeAv2Timeline(plan);
  const twice = canonicalizeAv2Timeline(once.plan);
  assert.deepEqual(twice.plan, once.plan);
  assert.equal(contentHash(twice.plan), contentHash(once.plan));
  assert.deepEqual(once.plan.scenes.map((scene) => scene.audio.utterances), narration);
  assert.deepEqual(once.plan.scenes.map((scene) => scene.actions.map(({ start: _start, ...action }) => action)), acting);
});

test("anchor grammar accepts local anchors and rejects unknown, cross-scene and out-of-scene offsets", () => {
  const valid = transportToAv2Domain(clone());
  valid.scenes[0].camera.start = { anchor: "scene.end", offset_seconds: -1 };
  assert.equal(validateEpisodePlan(valid, { throwOnError: false }).ok, true);
  for (const ref of [
    { anchor: "unknown.start", offset_seconds: 0 },
    { anchor: "s02.start", offset_seconds: 0 },
    { anchor: "scene.start", offset_seconds: -0.1 },
  ]) {
    const invalid = transportToAv2Domain(clone());
    invalid.scenes[0].camera.start = ref;
    const result = validateEpisodePlan(invalid, { throwOnError: false });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => error.keyword === "timing_reference"));
  }
});

test("canonicalization preserves creative references and never invents a missing prop", () => {
  const valid = transportToAv2Domain(clone());
  const placement = structuredClone(valid.scenes[0].stage.placements[0]);
  assert.deepEqual(canonicalizeAv2Timeline(valid).plan.scenes[0].stage.placements[0], placement);

  const invalid = transportToAv2Domain(clone());
  invalid.scenes[0].stage.placements[0].entity_id = "missing_creative_prop";
  const canonical = canonicalizeAv2Timeline(invalid);
  const result = validateEpisodePlan(canonical.plan, { throwOnError: false });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.keyword === "reference" && error.message.includes("missing_creative_prop")));
});

test("provider raw survives semantic failure and replays after integration restart without network", async () => {
  const store = new InMemoryCreativeArtifactStore();
  const context = { benchmark_id: "lumi_cinco_huevos", episode_id: "lumi_cinco_huevos" };
  const firstIntegration = new Av2PipelineIntegration({ store, engineVersion: "v2", benchmarkOnly: true });
  const resolved = await firstIntegration.resolvePlan({
    idea: AV2_BENCHMARK_IDEA,
    context,
    idempotencyKey: AV2_BENCHMARK_IDEMPOTENCY_KEY,
  });
  const raw = clone();
  raw.episode_plan.scenes[0].camera.start.anchor = "scene_start";
  raw.episode_plan.episode.transitions[0].from_scene = "s09";
  assert.equal(validateEpisodePlan(transportToAv2Domain(raw), { throwOnError: false }).ok, false);
  await firstIntegration.persistProviderOutput({
    requestHash: resolved.request_hash,
    generationAttempt: resolved.generation_attempt,
    rawTransport: raw,
    providerMetadata: {
      provider: "openai",
      provider_response_id: "resp_survives_restart",
      model: "gpt-5-mini",
      request_payload_hash: "f".repeat(64),
      input_tokens: 10,
      output_tokens: 20,
    },
    context,
    idempotencyKey: AV2_BENCHMARK_IDEMPOTENCY_KEY,
  });
  await firstIntegration.recordFailure({
    artifactType: "episode_plan",
    requestHash: resolved.request_hash,
    code: "episode_plan_invalid",
    recoverable: false,
    failureId: "synthetic-semantic-failure",
    context,
    idempotencyKey: AV2_BENCHMARK_IDEMPOTENCY_KEY,
  });
  assert.equal(store.records[0].status, "failed");

  const restartedIntegration = new Av2PipelineIntegration({ store, engineVersion: "v2", benchmarkOnly: true });
  const replayed = await replayPersistedBenchmark({
    integration: restartedIntegration,
    requestHash: resolved.request_hash,
    generationAttempt: resolved.generation_attempt,
    context,
  });
  assert.equal(replayed.state, "ready");
  assert.equal(store.providerOutputs.length, 1);
  assert.equal(store.providerOutputs[0].provider_response_id, "resp_survives_restart");
  assert.equal(store.providerOutputs[0].generation_attempt, 1);
  assert.deepEqual(store.providerOutputs[0].raw_transport, raw);
  assert.equal(store.records[0].status, "valid");
  assert.equal(store.records[0].generation_attempt, 1);
});

test("provider success followed by a creative semantic failure still persists immutable raw", async () => {
  const store = new InMemoryCreativeArtifactStore();
  const integration = new Av2PipelineIntegration({ store, engineVersion: "v2", benchmarkOnly: true });
  const raw = clone();
  raw.episode_plan.scenes[0].stage.placements[0].entity_id = "missing_creative_prop";
  let providerCalls = 0;
  await assert.rejects(
    () => runCanonicalBenchmark({
      integration,
      apiKey: "configured",
      fetchImpl: async () => {
        providerCalls += 1;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: "resp_creative_failure",
            created_at: 1_800_000_000,
            output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(raw) }] }],
            usage: { input_tokens: 11, output_tokens: 22 },
          }),
        };
      },
    }),
    (error) => error.code === "episode_plan_invalid",
  );
  assert.equal(providerCalls, 1);
  assert.equal(store.records.length, 1);
  assert.equal(store.records[0].status, "failed");
  assert.equal(store.providerOutputs.length, 1);
  assert.equal(store.providerOutputs[0].provider_response_id, "resp_creative_failure");
  assert.deepEqual(store.providerOutputs[0].raw_transport, raw);
  assert.equal(store.records[0].generation_metadata.provider_output_persisted, true);
});

test("provider output is immutable per generation attempt", async () => {
  const store = new InMemoryCreativeArtifactStore();
  const base = {
    artifact_id: "artifact-immutable",
    generation_attempt: 5,
    request_hash: "a".repeat(64),
    raw_transport: clone(),
    raw_transport_hash: contentHash(transportFixture),
  };
  assert.equal((await store.saveProviderOutput(base)).created, true);
  assert.equal((await store.saveProviderOutput(base)).created, false);
  await assert.rejects(
    () => store.saveProviderOutput({ ...base, request_hash: "b".repeat(64) }),
    (error) => error.code === "provider_output_conflict",
  );
  assert.equal(store.providerOutputs.length, 1);
});

test("failed attempt four reopens as attempt five on the same logical artifact", async () => {
  const store = new InMemoryCreativeArtifactStore();
  const created = await store.create({
    artifact_type: "episode_plan",
    request_hash: "d".repeat(64),
    idempotency_key: AV2_BENCHMARK_IDEMPOTENCY_KEY,
    benchmark_id: "lumi_cinco_huevos",
    episode_id: "lumi_cinco_huevos",
    status: "failed",
    validation_status: "invalid",
    content_hash: null,
    generation_attempt: 4,
    generation_metadata: { provider_call_count: 4, previous_failures: [{ attempt: 3, code: "openai_generation_failed" }] },
    last_error_code: "episode_plan_invalid",
    last_error: { code: "episode_plan_invalid", failure_id: "attempt-4-semantic", recoverable: false },
  });
  const integration = new Av2PipelineIntegration({ store, engineVersion: "v2", benchmarkOnly: true });
  const resolved = await integration.resolvePlan({
    idea: AV2_BENCHMARK_IDEA,
    context: { benchmark_id: "lumi_cinco_huevos", episode_id: "lumi_cinco_huevos" },
    idempotencyKey: AV2_BENCHMARK_IDEMPOTENCY_KEY,
  });
  assert.equal(resolved.state, "generate");
  assert.equal(resolved.artifact_id, created.record.id);
  assert.equal(resolved.generation_attempt, 5);
  assert.equal(store.records.length, 1);
  assert.deepEqual(store.records[0].generation_metadata.previous_failures.at(-1), {
    attempt: 4,
    code: "episode_plan_invalid",
    failure_id: "attempt-4-semantic",
    recoverable: false,
  });
});

test("strict contract metrics stay within supported limits", () => {
  for (const schema of [AV2_LLM_IDEA_TRANSPORT_SCHEMA, AV2_LLM_EPISODE_TRANSPORT_SCHEMA]) {
    const result = inspectOpenAIStructuredOutputSchema(schema);
    assert.equal(result.ok, true);
    assert.ok(result.max_object_depth <= 10);
    assert.ok(result.property_count <= 5000);
    assert.ok(result.enum_value_count <= 1000);
    assert.ok(result.serialized_schema_bytes < 120000);
  }
});
