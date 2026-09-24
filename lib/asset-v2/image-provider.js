import crypto from "node:crypto";

export const ASSET_V2_IMAGE_PROVIDER = "openai";
export const ASSET_V2_IMAGE_MODEL = "gpt-image-2-2026-04-21";

export class AssetImageProviderError extends Error {
  constructor(message, diagnostic) {
    super(message);
    this.name = "AssetImageProviderError";
    this.code = "asset_image_provider_failed";
    this.diagnostic = diagnostic;
  }
}

function sanitizedMessage(value) {
  return String(value || "Image provider request failed")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]")
    .replace(/sk-[A-Za-z0-9_-]+/g, "[REDACTED]")
    .slice(0, 1200);
}

async function providerError(response) {
  let body = null;
  try { body = await response.json(); } catch { /* status-only diagnostic */ }
  const value = body?.error || {};
  return new AssetImageProviderError(sanitizedMessage(value.message || `Image provider returned HTTP ${response.status}`), {
    http_status: response.status,
    type: value.type || null,
    code: value.code || null,
    param: value.param || null,
    message: sanitizedMessage(value.message),
    provider_request_id: response.headers.get("x-request-id") || null,
  });
}

export function inspectPng(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24
      || buffer.subarray(1, 4).toString("ascii") !== "PNG") {
    throw new Error("asset_image_invalid_png");
  }
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
    sha256: crypto.createHash("sha256").update(buffer).digest("hex"),
    bytes: buffer.length,
  };
}

export function buildImageEditRequest({
  model = ASSET_V2_IMAGE_MODEL,
  prompt,
  referenceBuffer,
  referenceFilename = "lumi-reference.png",
  size = "1152x2048",
  quality = "high",
}) {
  if (!String(prompt || "").trim()) throw new Error("asset_image_prompt_missing");
  if (!Buffer.isBuffer(referenceBuffer) || referenceBuffer.length === 0) throw new Error("asset_image_reference_missing");
  const form = new FormData();
  form.append("model", model);
  form.append("prompt", prompt);
  form.append("image[]", new Blob([referenceBuffer], { type: "image/png" }), referenceFilename);
  form.append("n", "1");
  form.append("size", size);
  form.append("quality", quality);
  form.append("output_format", "png");
  return form;
}

export async function generateBenchmarkComposite({
  apiKey,
  model = ASSET_V2_IMAGE_MODEL,
  prompt,
  referenceBuffer,
  size = "1152x2048",
  quality = "high",
  fetchImpl = fetch,
}) {
  if (!apiKey) throw new Error("asset_image_provider_not_configured");
  const response = await fetchImpl("https://api.openai.com/v1/images/edits", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: buildImageEditRequest({ model, prompt, referenceBuffer, size, quality }),
  });
  if (!response.ok) throw await providerError(response);
  const body = await response.json();
  const encoded = body?.data?.[0]?.b64_json;
  if (!encoded) throw new AssetImageProviderError("Image provider response did not contain PNG data", {
    http_status: response.status,
    type: "invalid_response",
    code: "missing_b64_json",
    param: null,
    message: "Image provider response did not contain PNG data",
    provider_request_id: response.headers.get("x-request-id") || null,
  });
  const buffer = Buffer.from(encoded, "base64");
  return {
    buffer,
    image: inspectPng(buffer),
    provider: ASSET_V2_IMAGE_PROVIDER,
    model,
    provider_response_id: body.id || response.headers.get("x-request-id") || null,
    provider_request_id: response.headers.get("x-request-id") || null,
    created_at: body.created ? new Date(body.created * 1000).toISOString() : new Date().toISOString(),
    usage: body.usage || null,
  };
}
