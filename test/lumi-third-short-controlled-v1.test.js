import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  THIRD_SHORT,
  thirdShortActions,
  thirdShortPreflight,
} from "../lib/lumi-third-short-controlled-v1.js";
import {
  THIRD_SHORT_SCENES,
  thirdShortImagePrompt,
  thirdShortVideoContract,
} from "../lib/lumi-third-short-media-v1.js";
import { validateVideoGenerationReadiness } from "../lib/video-generation-readiness-v2.js";
import { resetThirdShortBootActionForTest, runThirdShortBootAction, thirdShortBootAction } from "../lib/lumi-third-short-boot-v1.js";

test("third short clean-path budget and provider counts are hard-limited", () => {
  const preflight = thirdShortPreflight();
  assert.equal(preflight.status, "PASS");
  assert.equal(preflight.projected_clean_cost_usd, 2.978645);
  assert.equal(preflight.hard_ceiling_usd, 3.05);
  assert.deepEqual(preflight.planned_calls, { image: 9, kling: 9, tts: 9, provider_repairs: 0 });
  assert.equal(preflight.global_default_unchanged, "legacy");
});

test("third short recovery ledger has one ordered action per controlled stage", () => {
  const actions = thirdShortActions();
  assert.equal(actions.filter((action) => action.stage === "IMAGE").length, 9);
  assert.equal(actions.filter((action) => action.stage === "VIDEO").length, 9);
  assert.equal(actions.filter((action) => action.stage === "TTS").length, 9);
  assert.equal(actions[0].key, "episode_plan_v2");
  assert.equal(actions.at(-1).key, "human_review_notice");
  assert.equal(new Set(actions.map((action) => action.key)).size, actions.length);
  assert.equal(THIRD_SHORT.pipelineVersion, "v1_1_2");
});

test("controlled start migration is isolated, idempotent and does not enqueue legacy Make", async () => {
  const sql = await readFile(new URL("../supabase/migrations/20261004030000_lumi_controlled_episode_start.sql", import.meta.url), "utf8");
  assert.match(sql, /pipeline_version text not null check \(pipeline_version = 'v1_1_2'\)/);
  assert.match(sql, /p_pipeline_version <> 'v1_1_2'/);
  assert.match(sql, /'lumi_controlled'/);
  assert.match(sql, /p_user,p_chat,'scripted'/);
  assert.match(sql, /Conflicto de idempotencia/);
  assert.match(sql, /enable row level security/);
});

test("server exposes only an explicit episode override while retaining legacy global default", async () => {
  const source = await readFile(new URL("../server.js", import.meta.url), "utf8");
  assert.match(source, /LUMI_PIPELINE_VERSION !== "legacy"/);
  assert.match(source, /episode_pipeline_override_required/);
  assert.match(source, /startThirdShortControlled/);
  assert.match(source, /callbacks: \["REANUDAR", "VER ESTADO", "CANCELAR"\]/);
});

test("nine simple flower scenes compile through readiness v2 with exact color and pacing locks", () => {
  assert.equal(THIRD_SHORT_SCENES.length, 9);
  assert.equal(THIRD_SHORT_SCENES.filter((scene) => scene.pause === 2.5).length, 1);
  for (const scene of THIRD_SHORT_SCENES) {
    const prompt = thirdShortImagePrompt(scene);
    assert.match(prompt, /Red is pure clear red/i);
    assert.match(prompt, /Yellow is pure clear yellow/i);
    assert.match(prompt, /Blue is pure clear blue/i);
    assert.match(prompt, /No generated text/);
    const readiness = validateVideoGenerationReadiness(thirdShortVideoContract(scene));
    assert.equal(readiness.status, "PASS", `${scene.id}: ${readiness.errors.join(",")}`);
  }
});

test("third-short boot trigger is staging-only and calls the canonical start endpoint", async () => {
  assert.equal(thirdShortBootAction({}), null);
  assert.throws(() => thirdShortBootAction({ LUMI_THIRD_SHORT_BOOT_ACTION: "START", LUMI_RUNTIME_ENV: "production" }), /production_rejected/);
  resetThirdShortBootActionForTest();
  let observed;
  const result = await runThirdShortBootAction({
    env: { LUMI_THIRD_SHORT_BOOT_ACTION: "START", LUMI_RUNTIME_ENV: "staging", RENDER_API_TOKEN: "secret", LUMI_THIRD_SHORT_COMMAND_KEY: "controlled-command" },
    port: 3000,
    fetchImpl: async (url, options) => { observed = { url, options }; return { ok: true, json: async () => ({ status: "PLANNED", episode_id: THIRD_SHORT.episodeId, provider_calls: 1 }) }; },
    logger: { info() {} },
  });
  assert.match(observed.url, /\/episodes\/third\/start$/);
  assert.equal(observed.options.headers["x-render-token"], "secret");
  assert.equal(JSON.parse(observed.options.body).pipeline_version, "v1_1_2");
  assert.equal(result.status, "PLANNED");
});
