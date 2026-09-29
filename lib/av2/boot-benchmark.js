import { contentHash } from "./contracts.js";
import { runCanonicalBenchmark } from "./benchmark-runner.js";
import { AV2_BENCHMARK_ID, Av2IntegrationError } from "./pipeline-integration.js";

function log(logger, event, fields = {}) {
  logger?.({ component: "av2_boot_benchmark", event, benchmark_id: AV2_BENCHMARK_ID, ...fields });
}

export function shouldRunBootBenchmark({ engineVersion, benchmarkOnly, runOnBoot }) {
  return engineVersion === "v2" && benchmarkOnly === true && runOnBoot === true;
}

function assertSameArtifact(result, expected, operation) {
  if (result.provider_calls !== 0) {
    throw new Av2IntegrationError("benchmark_provider_replay", `${operation} attempted an additional provider call`, { status: 409 });
  }
  if (result.artifact_id !== expected.artifact_id || result.request_hash !== expected.request_hash) {
    throw new Av2IntegrationError("benchmark_idempotency_mismatch", `${operation} returned a different artifact`, { status: 409 });
  }
}

function validateRecoveredArtifact(row, expected) {
  if (!row || row.id !== expected.artifact_id || row.status !== "valid" || row.validation_status !== "valid") {
    throw new Av2IntegrationError("benchmark_recovery_invalid", "Persisted benchmark artifact is not valid", { status: 409 });
  }
  if (!row.payload || !row.content_hash || contentHash(row.payload) !== row.content_hash) {
    throw new Av2IntegrationError("benchmark_recovery_hash_mismatch", "Persisted benchmark content hash is invalid", { status: 409 });
  }
  const legacy = row.legacy_payload;
  if (!legacy || !Array.isArray(legacy.scenes) || legacy.scenes.length === 0) {
    throw new Av2IntegrationError("benchmark_legacy_missing", "Persisted benchmark has no legacy scenes", { status: 409 });
  }
  const invalidScene = legacy.scenes.find((scene) => (
    !String(scene?.narration || "").trim()
    || !String(scene?.visual_prompt || "").trim()
    || !String(scene?.on_screen_text || "").trim()
    || !Number.isFinite(Number(scene?.duration_seconds))
    || Number(scene.duration_seconds) <= 0
    || !scene?.metadata?.production
  ));
  if (invalidScene) {
    throw new Av2IntegrationError("benchmark_legacy_contract_invalid", "Persisted benchmark legacy scene contract is invalid", { status: 409 });
  }
  return row;
}

export async function runBootBenchmark({
  integration,
  apiKey,
  model,
  logger,
  runBenchmark = runCanonicalBenchmark,
} = {}) {
  if (!integration) throw new Error("AV2 integration is required");
  log(logger, "benchmark_started");

  const first = await runBenchmark({ integration, apiKey, model });
  const stored = validateRecoveredArtifact(
    await integration.store.findByRequest("episode_plan", first.request_hash),
    first,
  );
  log(logger, first.provider_calls === 1 ? "benchmark_generated" : "benchmark_cache_hit", {
    artifact_id: stored.id,
    request_hash: first.request_hash,
    content_hash: stored.content_hash,
    cache_hit: first.provider_calls === 0,
    provider_calls: first.provider_calls,
    validation_result: "valid",
  });

  const cached = await runBenchmark({ integration, apiKey, model });
  assertSameArtifact(cached, first, "cache verification");
  log(logger, "benchmark_cache_hit", {
    artifact_id: stored.id,
    request_hash: first.request_hash,
    content_hash: stored.content_hash,
    cache_hit: true,
    provider_calls: 0,
    validation_result: "valid",
  });

  const retry = await runBenchmark({ integration, apiKey, model });
  assertSameArtifact(retry, first, "idempotency verification");
  log(logger, "benchmark_idempotency_verified", {
    artifact_id: stored.id,
    request_hash: first.request_hash,
    content_hash: stored.content_hash,
    cache_hit: true,
    provider_calls: 0,
    idempotency_result: "valid",
  });

  const recovered = validateRecoveredArtifact(
    await integration.store.findByRequest("episode_plan", first.request_hash),
    first,
  );
  log(logger, "benchmark_recovered", {
    artifact_id: recovered.id,
    request_hash: first.request_hash,
    content_hash: recovered.content_hash,
    recovery_result: "valid",
    legacy_adaptation_result: "valid",
  });
  log(logger, "benchmark_completed", {
    artifact_id: recovered.id,
    request_hash: first.request_hash,
    content_hash: recovered.content_hash,
    cache_hit: true,
    provider_calls: first.provider_calls,
    validation_result: "valid",
    recovery_result: "valid",
    legacy_adaptation_result: "valid",
  });
  return {
    ok: true,
    benchmark_id: AV2_BENCHMARK_ID,
    artifact_id: recovered.id,
    request_hash: first.request_hash,
    content_hash: recovered.content_hash,
    provider_calls: first.provider_calls,
    provider_call_count_total: first.provider_call_count_total,
    cache_hit: true,
    idempotency_result: "valid",
    recovery_result: "valid",
    legacy_adaptation_result: "valid",
  };
}
