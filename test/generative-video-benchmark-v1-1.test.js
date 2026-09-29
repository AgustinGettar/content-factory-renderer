import test from "node:test";
import assert from "node:assert/strict";
import {
  buildModelInput,
  compileGenerativeVideoPromptV1,
} from "../lib/generative-video-benchmark-v1.js";
import {
  GENERATIVE_VIDEO_BENCHMARK_V11,
  GENERATIVE_VIDEO_V11_CALL_CAP,
  GENERATIVE_VIDEO_V11_MAX_USD,
  GENERATIVE_VIDEO_V11_MODEL,
  GENERATIVE_VIDEO_V11_SCENES,
} from "../lib/generative-video-benchmark-v1-1.js";

test("V1.1 is exactly S11 and S12 with one Kling call each", () => {
  assert.equal(GENERATIVE_VIDEO_BENCHMARK_V11, "generative-video-benchmark/1.1");
  assert.equal(GENERATIVE_VIDEO_V11_CALL_CAP, 2);
  assert.equal(GENERATIVE_VIDEO_V11_MAX_USD, 1);
  assert.equal(GENERATIVE_VIDEO_V11_MODEL.model, "kling-video/v3.0/std/image-to-video");
  assert.deepEqual(GENERATIVE_VIDEO_V11_SCENES.map((scene) => scene.scene_id), ["s11", "s12"]);
  assert.deepEqual(GENERATIVE_VIDEO_V11_SCENES.map((scene) => scene.sha256), [
    "b069f9d7c6ff086708d57e126a3342ed820dc58d58f730f9abd0c1faf65483d4",
    "941fa2a6103b61baacde91dff406b6bf89e2d274c79be97e16ea1cb0cf094d4a",
  ]);
  for (const scene of GENERATIVE_VIDEO_V11_SCENES) {
    assert.equal(scene.width / scene.height, 9 / 16);
  }
});

test("scene prompts are deterministic, semantic and distinct", () => {
  const s11a = compileGenerativeVideoPromptV1("s11");
  const s11b = compileGenerativeVideoPromptV1("s11");
  const s12 = compileGenerativeVideoPromptV1("s12");
  assert.deepEqual(s11a, s11b);
  assert.notEqual(s11a.prompt_hash, s12.prompt_hash);
  assert.match(s11a.text, /physically grounded/);
  assert.match(s11a.text, /No random gestures/);
  assert.match(s12.text, /shoulder initiates/);
  assert.match(s12.text, /credible grip/);
  assert.match(s12.text, /egg_01/);
  assert.match(s12.text, /No pose replacement/);
  assert.match(s11a.text, /Preserve Lumi's exact identity/);
  assert.match(s12.text, /garden_world_01/);
});

test("V1 S17 prompt remains byte-for-byte stable", () => {
  const prompt = compileGenerativeVideoPromptV1();
  assert.equal(prompt.prompt_hash, "76c6a75f6593165d9fdff61e5b09714affc6805b868acf4f5c413ea7b0bab42a");
});

test("Kling input remains five seconds, single-shot and audio off", () => {
  const prompt = compileGenerativeVideoPromptV1("s12");
  const input = buildModelInput(GENERATIVE_VIDEO_V11_MODEL, "https://example.test/s12-v1.1.png", prompt);
  assert.equal(input.duration, 5);
  assert.equal(input.sound, "off");
  assert.equal(input.multi_shots, false);
  assert.equal(input.image_url, "https://example.test/s12-v1.1.png");
  assert.equal(input.prompt, prompt.text);
});

test("unsupported scene prompt is rejected", () => {
  assert.throws(() => compileGenerativeVideoPromptV1("s19"), /generative_video_scene_not_allowed/);
});
