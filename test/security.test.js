import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { encryptJson, decryptJson } from "../lib/security.js";
import { buildAuthorizationUrl, buildVideoMetadata } from "../lib/youtube.js";

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
