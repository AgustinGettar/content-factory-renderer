import test from "node:test";
import assert from "node:assert/strict";
import {
  SECOND_SHORT_IMAGE_MAX_USD,
  SECOND_SHORT_SCENES,
  SECOND_SHORT_TTS_MAX_USD,
  SECOND_SHORT_VIDEO_MAX_USD,
  shouldRunSecondShortOnBoot,
} from "../lib/lumi-second-short-v1.js";

test("second short runtime keeps the manifest ceilings and nine canonical scenes", () => {
  assert.deepEqual(SECOND_SHORT_SCENES, ["s21","s22","s23","s24","s25","s26","s27","s28","s29"]);
  assert.equal(SECOND_SHORT_IMAGE_MAX_USD, 0.887396);
  assert.equal(SECOND_SHORT_VIDEO_MAX_USD, 2.079);
  assert.equal(SECOND_SHORT_TTS_MAX_USD, 0.01225);
});

test("second short boot runner is staging-only and defaults off", () => {
  assert.equal(shouldRunSecondShortOnBoot({}), false);
  assert.equal(shouldRunSecondShortOnBoot({ LUMI_RUNTIME_ENV: "production", LUMI_SECOND_SHORT_BOOT_ENABLED: "true", LUMI_SECOND_SHORT_BOOT_STAGE: "IMAGE" }), false);
  assert.equal(shouldRunSecondShortOnBoot({ LUMI_RUNTIME_ENV: "staging", LUMI_SECOND_SHORT_BOOT_ENABLED: "true", LUMI_SECOND_SHORT_BOOT_STAGE: "IMAGE" }), true);
  assert.equal(shouldRunSecondShortOnBoot({ LUMI_RUNTIME_ENV: "staging", LUMI_SECOND_SHORT_BOOT_ENABLED: "true", LUMI_SECOND_SHORT_BOOT_STAGE: "ASSEMBLY" }), false);
});
