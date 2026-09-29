import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  LUMI_PILOT_IMAGE_CALL_CAP,
  LUMI_PILOT_IMAGE_ESTIMATE_USD,
  LUMI_PILOT_IMAGE_MAX_USD,
  LUMI_PILOT_SCENE_IDS,
  LUMI_PILOT_VIDEO_CALL_CAP,
  compilePilotImagePromptV1,
  derivePilotSceneSpecification,
  evaluatePilotVisualQA,
} from "../lib/lumi-production-pilot-v1.js";
import { compileGenerativeVideoPromptV1 } from "../lib/generative-video-benchmark-v1.js";
import {
  readLumiPilotBootConfig,
  runLumiPilotOnBoot,
  shouldRunLumiPilotOnBoot,
} from "../lib/lumi-production-pilot-boot.js";

const fixture = JSON.parse(fs.readFileSync(new URL("./fixtures/av2-canonical-lumi-cinco-huevos.accepted.json", import.meta.url), "utf8"));

test("pilot is locked to exactly the six missing canonical scenes", () => {
  assert.deepEqual(LUMI_PILOT_SCENE_IDS, ["s13", "s14", "s15", "s16", "s18", "s19"]);
  assert.equal(LUMI_PILOT_IMAGE_CALL_CAP, 6);
  assert.equal(LUMI_PILOT_VIDEO_CALL_CAP, 6);
  assert.ok(LUMI_PILOT_IMAGE_ESTIMATE_USD * 6 < LUMI_PILOT_IMAGE_MAX_USD);
});

test("pilot scene specifications preserve canonical count progression", () => {
  const expected = { s13: [1, ["egg_02"]], s14: [1, ["egg_03"]], s15: [1, ["egg_04"]], s16: [1, ["egg_05"]], s18: [5, ["egg_01", "egg_02", "egg_03", "egg_04", "egg_05"]], s19: [5, ["egg_01", "egg_02", "egg_03", "egg_04", "egg_05"]] };
  for (const sceneId of LUMI_PILOT_SCENE_IDS) {
    const value = derivePilotSceneSpecification(fixture, sceneId);
    assert.equal(value.manifest.pilot_semantics.exact_egg_count, expected[sceneId][0]);
    assert.deepEqual(value.manifest.pilot_semantics.visible_egg_ids, expected[sceneId][1]);
    assert.deepEqual(value.manifest.props.filter((entry) => entry.visible && entry.prop_id.startsWith("egg_")).map((entry) => entry.prop_id), expected[sceneId][1]);
  }
});

test("image prompts are deterministic, motion-aware and lock pedagogical counts", () => {
  for (const sceneId of LUMI_PILOT_SCENE_IDS) {
    const specification = derivePilotSceneSpecification(fixture, sceneId);
    const first = compilePilotImagePromptV1(specification);
    const again = compilePilotImagePromptV1(specification);
    assert.equal(first.prompt_hash, again.prompt_hash);
    assert.match(first.text, /source keyframe for image-to-video/i);
    assert.match(first.text, new RegExp(`EXACTLY ${specification.semantics.exact_eggs}`));
    assert.match(first.text, /FULL visibility/i);
    assert.match(first.text, /No text, numbers, letters/i);
  }
});

test("video prompt compiler materializes each missing scene without changing semantic authority", () => {
  for (const sceneId of LUMI_PILOT_SCENE_IDS) {
    const first = compileGenerativeVideoPromptV1(sceneId);
    const again = compileGenerativeVideoPromptV1(sceneId);
    assert.equal(first.prompt_hash, again.prompt_hash);
    assert.match(first.text, /Preserve Lumi's exact identity/i);
    assert.match(first.text, /No face drift/i);
    assert.ok(first.text.includes("EXACTLY ONE") || first.text.includes("EXACTLY FIVE"));
  }
});

test("pilot semantic QA keeps counting eggs FULL and rejects an unsafe or extra egg", () => {
  const specification = derivePilotSceneSpecification(fixture, "s13");
  const region = (bounds) => ({ visible: true, occluded: false, bounds });
  const box = (x, y, width, height) => ({ x, y, width, height });
  const safe = box(0.3, 0.3, 0.2, 0.2);
  const observation = {
    width: 1152, height: 2048, environment_id: "garden_world_01",
    characters: [{ character_id: "lumi", identity_match: true, species_match: true,
      apparent_age_match: true, body_color: "warm_yellow", eye_color: "turquoise",
      antennae_count: 2, wing_count: 2, overalls_match: true, shoes_match: true,
      wand_match: true, extra_limbs: false, hands_ok: true, face_ok: true,
      uncanny: false, face_clutter: false }],
    visible_prop_ids: ["egg_02", "lumi_wand_01"],
    visible_entity_ids: ["lumi", "lumi_wand_01", "egg_02"],
    entity_observations: {
      lumi: region(box(0.2, 0.2, 0.4, 0.5)),
      lumi_wand_01: region(safe),
      egg_02: region(box(0.65, 0.65, 0.12, 0.14)),
    },
    unregistered_egg_count: 0, egg_count_verified: 1,
    child_safe: true, generated_text: false, logo_or_watermark: false,
    critical_crop: false, motion_ready: true, semantic_match: true,
    world_landmark_match: true,
  };
  observation.entity_observations.lumi.critical_regions = Object.fromEntries(
    ["face", "eyes", "active_hand"].map((id) => [id, region(safe)]));
  observation.entity_observations.lumi_wand_01.critical_regions = { wand_star: region(safe) };
  assert.equal(evaluatePilotVisualQA({ sceneId: "s13", manifest: specification.manifest, observation }).accepted, true);
  const unsafe = structuredClone(observation);
  unsafe.entity_observations.egg_02.bounds.x = 0.9;
  assert.equal(evaluatePilotVisualQA({ sceneId: "s13", manifest: specification.manifest, observation: unsafe }).accepted, false);
  const extra = structuredClone(observation);
  extra.egg_count_verified = 2;
  assert.equal(evaluatePilotVisualQA({ sceneId: "s13", manifest: specification.manifest, observation: extra }).accepted, false);
});

test("one-shot boot is disabled by default and rejects non-pilot scenes", () => {
  assert.equal(shouldRunLumiPilotOnBoot({}), false);
  assert.equal(shouldRunLumiPilotOnBoot({
    LUMI_PRODUCTION_PILOT_ENABLED: "true", AV2_PILOT_RUN_ON_BOOT: "true",
    AV2_PILOT_RUN_STAGE: "IMAGE", AV2_PILOT_RUN_SCENE: "S11", LUMI_RUNTIME_ENV: "staging",
  }), false);
  assert.deepEqual(readLumiPilotBootConfig({
    LUMI_PRODUCTION_PILOT_ENABLED: "true", AV2_PILOT_RUN_ON_BOOT: "true",
    AV2_PILOT_RUN_STAGE: "video", AV2_PILOT_RUN_SCENE: "S13", LUMI_RUNTIME_ENV: "staging",
  }), { enabled: true, stage: "VIDEO", sceneId: "s13" });
});

test("one-shot boot dispatches exactly one stage and preserves cache-hit zero-call result", async () => {
  const env = {
    LUMI_PRODUCTION_PILOT_ENABLED: "true", AV2_PILOT_RUN_ON_BOOT: "true",
    AV2_PILOT_RUN_STAGE: "IMAGE", AV2_PILOT_RUN_SCENE: "S13", LUMI_RUNTIME_ENV: "staging",
  };
  let imageInvocations = 0;
  let videoInvocations = 0;
  const result = await runLumiPilotOnBoot({
    env, supabase: {}, store: {}, logger: () => {},
    runCommand: async ({ sceneId }) => {
      imageInvocations += 1;
      assert.equal(sceneId, "s13");
      return { status: "cache_hit", provider_calls: 0 };
    },
  });
  assert.equal(result.status, "cache_hit");
  assert.equal(result.provider_calls, 0);
  assert.equal(imageInvocations, 1);
  assert.equal(videoInvocations, 0);
});
