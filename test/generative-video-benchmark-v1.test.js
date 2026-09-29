import test from "node:test";
import assert from "node:assert/strict";
import {
  GENERATIVE_VIDEO_CALL_CAP,
  GENERATIVE_VIDEO_MAX_USD,
  GENERATIVE_VIDEO_MODELS,
  GENERATIVE_VIDEO_SOURCE,
  buildModelInput,
  compileGenerativeVideoPromptV1,
  parseEstimateUsd,
} from "../lib/generative-video-benchmark-v1.js";

test("Generative Video V1 is exactly two fixed model calls over the canonical S17 source", () => {
  assert.equal(GENERATIVE_VIDEO_CALL_CAP, 2);
  assert.equal(GENERATIVE_VIDEO_MODELS.length, 2);
  assert.deepEqual(GENERATIVE_VIDEO_MODELS.map((entry) => entry.model), [
    "bytedance/seedance-2.5/image-to-video",
    "kling-video/v3.0/std/image-to-video",
  ]);
  assert.equal(GENERATIVE_VIDEO_SOURCE.sha256, "af6651b3de885c159c7a54cb8eb4474b3955e054c705c166ad302a4818149232");
  assert.equal(GENERATIVE_VIDEO_SOURCE.width / GENERATIVE_VIDEO_SOURCE.height, 9 / 16);
  assert.equal(GENERATIVE_VIDEO_MAX_USD, 2.731);
});

test("prompt compiler is deterministic and locks identity, world and exactly five eggs", () => {
  const first = compileGenerativeVideoPromptV1();
  const second = compileGenerativeVideoPromptV1();
  assert.deepEqual(first, second);
  assert.match(first.text, /EXACTLY FIVE EGGS/);
  assert.match(first.text, /Preserve Lumi's exact identity/);
  assert.match(first.text, /garden_world_01/);
  assert.match(first.text, /No face drift/);
  assert.match(first.prompt_hash, /^[a-f0-9]{64}$/);
});

test("both providers receive the same source and prompt with audio disabled", () => {
  const prompt = compileGenerativeVideoPromptV1();
  const source = "https://example.test/s17-v1.1.png";
  const [seedance, kling] = GENERATIVE_VIDEO_MODELS.map((model) => buildModelInput(model, source, prompt));
  assert.equal(seedance.image_url, source);
  assert.equal(kling.image_url, source);
  assert.equal(seedance.prompt, kling.prompt);
  assert.equal(seedance.duration, 5);
  assert.equal(kling.duration, 5);
  assert.equal(seedance.generate_audio, false);
  assert.equal(kling.sound, "off");
  assert.equal(kling.multi_shots, false);
});

test("unapproved models cannot be injected into the benchmark runner", () => {
  const prompt = compileGenerativeVideoPromptV1();
  assert.throws(
    () => buildModelInput({ model: "third/model", input: {} }, "https://example.test/s17.png", prompt),
    /generative_video_model_not_allowed/,
  );
});

test("missing provider USD fields cannot be mistaken for a zero-cost estimate", () => {
  assert.equal(parseEstimateUsd({ usd: "2.311" }), 2.311);
  assert.equal(parseEstimateUsd({ cost: { usd: 0.231 } }), 0.231);
  assert.throws(() => parseEstimateUsd({ detail: "estimate unavailable" }), /higgsfield_estimate_missing_usd/);
});
