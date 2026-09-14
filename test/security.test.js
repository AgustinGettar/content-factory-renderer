import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { encryptJson, decryptJson } from "../lib/security.js";
import { buildAuthorizationUrl, buildVideoMetadata } from "../lib/youtube.js";
import { synthesizeSpeech } from "../lib/openai.js";

test("encrypts and decrypts OAuth credentials without plaintext output", () => {
  const key = crypto.randomBytes(32).toString("base64");
  const value = { refresh_token: "secret-refresh", scope: "youtube.upload" };
  const encrypted = encryptJson(value, key);
  assert.equal(JSON.stringify(encrypted).includes("secret-refresh"), false);
  assert.deepEqual(decryptJson(encrypted, key), value);
});

test("builds a consent URL with the minimum YouTube scopes", () => {
  const url = new URL(buildAuthorizationUrl({ clientId: "client", redirectUri: "https://example.com/callback", state: "state" }));
  assert.equal(url.searchParams.get("access_type"), "offline");
  assert.match(url.searchParams.get("scope"), /youtube\.upload/);
  assert.equal(url.searchParams.get("state"), "state");
});

test("marks Lumi uploads as made for kids and synthetic", () => {
  const metadata = buildVideoMetadata({ title: "Los colores con Lumi", privacyStatus: "unlisted" });
  assert.equal(metadata.status.selfDeclaredMadeForKids, true);
  assert.equal(metadata.status.containsSyntheticMedia, true);
  assert.equal(metadata.status.privacyStatus, "unlisted");
  assert.equal(metadata.snippet.categoryId, "27");
});

test("scheduled uploads remain private until publishAt", () => {
  const metadata = buildVideoMetadata({ title: "Lumi", privacyStatus: "public", publishAt: "2026-09-20T10:00:00Z" });
  assert.equal(metadata.status.privacyStatus, "private");
  assert.equal(metadata.status.publishAt, "2026-09-20T10:00:00.000Z");
});

test("requests direct narration with Lumi's friendly Marin voice", async () => {
  let request;
  const result = await synthesizeSpeech({
    apiKey: "test-key",
    input: "Hola, soy Lumi.",
    voice: "marin",
    fetchImpl: async (url, options) => {
      request = { url, options };
      return new Response(Buffer.from("fake-mp3"), { status: 200 });
    },
  });
  const payload = JSON.parse(request.options.body);
  assert.equal(request.url, "https://api.openai.com/v1/audio/speech");
  assert.equal(payload.model, "gpt-4o-mini-tts");
  assert.equal(payload.voice, "marin");
  assert.match(payload.instructions, /cálida/);
  assert.equal(result.buffer.toString(), "fake-mp3");
});

test("turns an exhausted API balance into an actionable error", async () => {
  await assert.rejects(
    synthesizeSpeech({
      apiKey: "test-key",
      input: "Hola",
      fetchImpl: async () => new Response(JSON.stringify({
        error: { code: "credit_balance_exhausted", message: "balance is zero" },
      }), { status: 429, headers: { "content-type": "application/json" } }),
    }),
    (error) => error.code === "openai_api_credit_required" && error.status === 402,
  );
});
