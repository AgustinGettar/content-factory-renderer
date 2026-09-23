import test from "node:test";
import assert from "node:assert/strict";
import { contentHash } from "../lib/av2/contracts.js";
import { runBootBenchmark, shouldRunBootBenchmark } from "../lib/av2/boot-benchmark.js";
import { runCanonicalBenchmark } from "../lib/av2/benchmark-runner.js";
import { InMemoryCreativeArtifactStore } from "../lib/av2/persistence.js";
import { Av2PipelineIntegration } from "../lib/av2/pipeline-integration.js";

function fixture() {
  const payload = { version: "episode-plan.v2", episode: { id: "lumi_cinco_huevos" }, scenes: [] };
  const legacyScene = {
    narration: "Contemos un huevo.",
    visual_prompt: "Jardín vertical.",
    on_screen_text: "1 huevo",
    duration_seconds: 5,
    metadata: { production: { version: "lumi-story-v2" } },
  };
  return {
    id: "artifact-1",
    status: "valid",
    validation_status: "valid",
    payload,
    content_hash: contentHash(payload),
    legacy_payload: { scenes: [legacyScene] },
  };
}

test("boot benchmark is off unless all three gates are explicitly enabled", () => {
  assert.equal(shouldRunBootBenchmark({ engineVersion: "v2", benchmarkOnly: true, runOnBoot: true }), true);
  assert.equal(shouldRunBootBenchmark({ engineVersion: "legacy", benchmarkOnly: true, runOnBoot: true }), false);
  assert.equal(shouldRunBootBenchmark({ engineVersion: "v2", benchmarkOnly: false, runOnBoot: true }), false);
  assert.equal(shouldRunBootBenchmark({ engineVersion: "v2", benchmarkOnly: true, runOnBoot: false }), false);
});

test("boot benchmark generates at most once, proves cache/idempotency and recovers legacy", async () => {
  const row = fixture();
  const integration = { store: { findByRequest: async () => structuredClone(row) } };
  const calls = [];
  const runBenchmark = async () => {
    const index = calls.length;
    calls.push(index);
    return {
      artifact_id: row.id,
      request_hash: "a".repeat(64),
      provider_calls: index === 0 ? 1 : 0,
      provider_call_count_total: 1,
    };
  };
  const logs = [];
  const result = await runBootBenchmark({
    integration,
    apiKey: "configured",
    model: "test-model",
    runBenchmark,
    logger: (entry) => logs.push(entry),
  });

  assert.equal(calls.length, 3);
  assert.equal(result.provider_calls, 1);
  assert.equal(result.artifact_id, row.id);
  assert.equal(result.content_hash, row.content_hash);
  assert.equal(result.cache_hit, true);
  assert.equal(result.idempotency_result, "valid");
  assert.equal(result.recovery_result, "valid");
  assert.equal(result.legacy_adaptation_result, "valid");
  assert.deepEqual(logs.map(({ event }) => event), [
    "benchmark_started",
    "benchmark_generated",
    "benchmark_cache_hit",
    "benchmark_idempotency_verified",
    "benchmark_recovered",
    "benchmark_completed",
  ]);
});

test("boot benchmark rejects any provider replay during cache verification", async () => {
  const row = fixture();
  const integration = { store: { findByRequest: async () => structuredClone(row) } };
  let call = 0;
  await assert.rejects(
    () => runBootBenchmark({
      integration,
      apiKey: "configured",
      runBenchmark: async () => ({
        artifact_id: row.id,
        request_hash: "a".repeat(64),
        provider_calls: call++ === 0 ? 1 : 1,
        provider_call_count_total: call,
      }),
    }),
    (error) => error.code === "benchmark_provider_replay",
  );
});

test("canonical benchmark uses JSON mode for the open AV2 episode contract", async () => {
  const store = new InMemoryCreativeArtifactStore();
  const integration = new Av2PipelineIntegration({ store, engineVersion: "v2", benchmarkOnly: true });
  let requestBody;
  const fetchImpl = async (_url, init) => {
    requestBody = JSON.parse(init.body);
    return { ok: false, status: 400 };
  };

  await assert.rejects(
    () => runCanonicalBenchmark({ integration, apiKey: "configured", fetchImpl }),
    (error) => error.code === "openai_generation_failed",
  );
  assert.deepEqual(requestBody.text.format, { type: "json_object" });
});
