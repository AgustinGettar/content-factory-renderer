import test from "node:test";
import assert from "node:assert/strict";
import { RENDER_PROFILES, renderProfile, validateManifest, verifyAssetHash, sceneFilters, isApprovedFinal } from "../lib/render-profiles.js";

test("preview is LD and final is Full HD with the same frame timing", () => {
  assert.deepEqual([RENDER_PROFILES.preview.width, RENDER_PROFILES.preview.height], [360, 640]);
  assert.deepEqual([RENDER_PROFILES.final.width, RENDER_PROFILES.final.height], [1080, 1920]);
  assert.equal(RENDER_PROFILES.preview.fps, RENDER_PROFILES.final.fps);
  assert.throws(() => renderProfile("4k"), /Unknown/);
});
test("layout scales proportionally and subtitles cannot expand expressions", () => {
  const low = sceneFilters(renderProfile("preview"), true, "/font.ttf", "/text.txt");
  const hd = sceneFilters(renderProfile("final"), true, "/font.ttf", "/text.txt");
  assert.match(low.join(","), /fontsize=24/);
  assert.match(hd.join(","), /fontsize=72/);
  assert.match(low.join(","), /expansion=none/);
  assert.equal(sceneFilters(renderProfile("preview"), false, "", "").length, 3);
});
const hash = "a".repeat(64);
const scene = {scene_number:1,image_url:"https://example.test/image.png",audio_url:"https://example.test/audio.mp3",image_sha256:hash,audio_sha256:hash};
const manifest = {version:"ld-hd-v1",revision:2,aspect_ratio:"9:16",scenes:[scene]};
const video = {content_revision:2,render_stage:"final",approved_revision:2};
test("HD requires the exact approved revision and verified assets", () => {
  assert.equal(validateManifest(video, manifest), manifest);
  assert.throws(() => validateManifest({...video,approved_revision:null},manifest), /aprobación/);
  assert.throws(() => validateManifest(video,{...manifest,revision:1}), /cambió/);
  assert.throws(() => validateManifest(video,{...manifest,scenes:[{...scene,audio_sha256:null}]}), /verificados/);
  assert.throws(() => validateManifest(video,{...manifest,scenes:[scene,scene]}), /desordenadas/);
});
test("a replaced resource at the same URL cannot silently become the HD version", () => {
  verifyAssetHash(hash,hash,"imagen");
  assert.throws(() => verifyAssetHash(hash,"b".repeat(64),"imagen"), /recurso aprobado cambió/);
});
test("only the approved HD revision is publishable", () => {
  const final = {...video,status:"rendered",render_url:"https://example.test/final.mp4",final_revision:2};
  const review = {verdict:"approved",content_revision:2};
  assert.equal(isApprovedFinal(final,review),true);
  assert.equal(isApprovedFinal({...final,render_stage:"preview"},review),false);
  assert.equal(isApprovedFinal({...final,final_revision:1},review),false);
  assert.equal(isApprovedFinal({...final,status:"rendering"},review),false);
  assert.equal(isApprovedFinal(final,{...review,content_revision:1}),false);
  assert.equal(isApprovedFinal(final,{...review,verdict:"rejected"}),false);
});
