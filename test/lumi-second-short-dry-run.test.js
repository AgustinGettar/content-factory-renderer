import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const root = new URL("../episodes/ep_lumi_formas_002/", import.meta.url);
const read = (name) => JSON.parse(fs.readFileSync(new URL(name, root), "utf8"));
const episode = read("EPISODE_PLAN_V2.json");
const scenes = read("SCENE_PLAN_V2.json");
const manifest = read("PRODUCTION_MANIFEST.json");
const dry = read("DRY_RUN_REPORT.json");

test("second short is compilation-ready with zero provider dispatches", () => {
  assert.equal(episode.episode.id, "ep_lumi_formas_002");
  assert.equal(episode.episode.learning.objective_id, "recognize_basic_shapes");
  assert.equal(scenes.scenes.length, 9);
  assert.equal(scenes.scenes.reduce((n, scene) => n + scene.duration, 0), 49);
  assert.equal(scenes.scenes.filter((scene) => scene.audio.pedagogical_pause_seconds > 0).length, 1);
  assert.equal(scenes.scenes.at(-1).purpose, "simple_reward_close");
  assert.ok(scenes.scenes.every((scene) => scene.visual_prompt_compilation.status === "PASS"));
  assert.ok(scenes.scenes.every((scene) => scene.video_prompt_compilation.status === "PASS"));
  assert.deepEqual(manifest.planned_calls, {image_calls:9,kling_calls:9,tts_calls:9,music_provider_calls:0,sfx_provider_calls:0,total_provider_calls:27});
  assert.equal(manifest.generation_policy.automatic_retries, 0);
  assert.equal(manifest.generation_policy.automatic_variants, 0);
  assert.equal(manifest.execution_gate.multimedia_authorized, false);
  assert.equal(manifest.execution_gate.runners, "OFF");
  assert.deepEqual(dry.provider_calls_actual, {image:0,kling:0,tts:0,total:0});
  assert.equal(dry.status, "PASS");
  assert.equal(dry.result, "SECOND_SHORT_STATUS=READY_FOR_EXECUTION");
});
