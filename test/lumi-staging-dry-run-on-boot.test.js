import test from "node:test";
import assert from "node:assert/strict";
import {
  resetAuthenticatedStagingDryRunForTest,
  runAuthenticatedStagingDryRunOnBoot,
  shouldRunAuthenticatedStagingDryRunOnBoot,
} from "../lib/lumi-staging-dry-run-on-boot.js";

const safeEnv = {
  LUMI_RUNTIME_ENV: "staging",
  LUMI_STAGING_DRY_RUN_ON_BOOT: "true",
  LUMI_STAGING_DRY_RUN_ID: "readiness-test-1",
  PROVIDER_CALLS_ALLOWED: "0",
  RENDER_API_TOKEN: "test-secret-never-log-or-return",
};

const passPayload = {
  status: "PASS",
  simulations_pass_count: 5,
  exactly_once_resume: "PASS",
  duplicate_provider_calls: 0,
  provider_calls: 0,
  telegram_single_message: "PASS",
  artifact_validation: { IMAGE: "PASS", VIDEO: "PASS", AUDIO: "PASS", MASTER: "PASS" },
  tts_storage_gate: "PASS",
  budget_gate: "PASS",
  runners_off: true,
  autorun: false,
};

test("boot trigger is opt-in, staging-only and requires the zero-provider hard lock", () => {
  assert.equal(shouldRunAuthenticatedStagingDryRunOnBoot({}), false);
  assert.throws(() => shouldRunAuthenticatedStagingDryRunOnBoot({ ...safeEnv, LUMI_RUNTIME_ENV: "production" }), /production_rejected/);
  assert.throws(() => shouldRunAuthenticatedStagingDryRunOnBoot({ ...safeEnv, PROVIDER_CALLS_ALLOWED: "1" }), /zero_provider_lock_required/);
});

test("authenticated loopback run never logs or returns the token and duplicate boot reuses one execution", async () => {
  resetAuthenticatedStagingDryRunForTest();
  let calls = 0; const logs = [];
  const fetchImpl = async (url, options) => {
    calls += 1;
    assert.match(url, /^http:\/\/127\.0\.0\.1:/);
    assert.equal(options.headers["x-render-token"], safeEnv.RENDER_API_TOKEN);
    assert.equal(JSON.parse(options.body).execution_id, safeEnv.LUMI_STAGING_DRY_RUN_ID);
    return { ok: true, status: 200, json: async () => passPayload };
  };
  const logger = { info: (line) => logs.push(line) };
  const [first, duplicate] = await Promise.all([
    runAuthenticatedStagingDryRunOnBoot({ env: safeEnv, port: 3000, fetchImpl, logger }),
    runAuthenticatedStagingDryRunOnBoot({ env: safeEnv, port: 3000, fetchImpl, logger }),
  ]);
  assert.equal(calls, 1);
  assert.deepEqual(duplicate, first);
  assert.equal(first.status, "PASS");
  assert.equal(first.provider_calls, 0);
  assert.equal(first.autorun, false);
  const serialized = JSON.stringify({ first, logs });
  assert.doesNotMatch(serialized, new RegExp(safeEnv.RENDER_API_TOKEN));
  assert.equal(Object.hasOwn(first, "token"), false);
});

test("missing internal auth fails closed without an external credential", async () => {
  resetAuthenticatedStagingDryRunForTest();
  await assert.rejects(
    runAuthenticatedStagingDryRunOnBoot({ env: { ...safeEnv, RENDER_API_TOKEN: "", ADMIN_API_TOKEN: "" }, port: 3000 }),
    /auth_token_missing/,
  );
});
