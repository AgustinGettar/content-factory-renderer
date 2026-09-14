import crypto from "node:crypto";

function keyFromBase64(value) {
  const key = Buffer.from(value || "", "base64");
  if (key.length !== 32) throw new Error("TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes");
  return key;
}

export function encryptJson(value, keyBase64) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", keyFromBase64(keyBase64), iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final(),
  ]);
  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    auth_tag: cipher.getAuthTag().toString("base64"),
  };
}

export function decryptJson(payload, keyBase64) {
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    keyFromBase64(keyBase64),
    Buffer.from(payload.iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(payload.auth_tag, "base64"));
  const clear = Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext, "base64")),
    decipher.final(),
  ]);
  return JSON.parse(clear.toString("utf8"));
}
