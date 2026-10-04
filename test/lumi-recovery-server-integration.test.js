import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("server integration is legacy-default, zero-autorun and has a staging-only authenticated boot trigger", async () => {
  const source = await readFile(new URL("../server.js", import.meta.url), "utf8");
  assert.match(source, /const LUMI_PIPELINE_VERSION = pipelineVersion\(process\.env\)/);
  assert.match(source, /const LUMI_PIPELINE_AUTORUN = false/);
  assert.match(source, /LUMI_RUNTIME_ENV !== "staging"/);
  assert.match(source, /runZeroProviderRecoveryDryRun/);
  assert.match(source, /PROVIDER_CALLS_ALLOWED !== "0"/);
  assert.match(source, /runAuthenticatedStagingDryRunOnBoot/);
  assert.doesNotMatch(source, /x-render-token.*console|console.*x-render-token/);
});

test("incident migration is additive and service-role only", async () => {
  const sql = await readFile(new URL("../supabase/migrations/20261004010000_lumi_recovery_incident_manager_v1.sql", import.meta.url), "utf8");
  assert.match(sql, /create table if not exists public\.lumi_pipeline_incidents/);
  assert.match(sql, /enable row level security/);
  assert.match(sql, /revoke all .* from anon, authenticated/);
  assert.match(sql, /autorun boolean not null default false check \(autorun = false\)/);
});
