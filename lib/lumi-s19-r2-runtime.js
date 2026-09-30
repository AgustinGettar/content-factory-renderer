import { contentHash } from "./av2/contracts.js";
import { buildPilotImagePlan, persistSpecification, LUMI_PILOT_VIDEO_MODEL } from "./lumi-production-pilot-v1.js";
import { fetchCanonicalReference } from "./asset-v2/visual-benchmark-runner.js";
import { ASSET_V2_IMAGE_MODEL, generateBenchmarkComposite } from "./asset-v2/image-provider.js";
import { buildModelInput, providerJson, pollRequest, sha256, GENERATIVE_VIDEO_PROMPT_COMPILER_V1,
  GENERATIVE_VIDEO_BUCKET, uploadObject, writeJsonObject } from "./generative-video-benchmark-v1.js";
import { R2, R2_CONSTRAINTS, claimR2, isR2SourceApproved, patchR2, readR2Run } from "./lumi-s19-r2-guard.js";

export function makeR2Scene(base) {
  const promptText = base.prompt.text
    .replace("all five eggs are inside it yet each egg remains fully visible and individually countable above the rim.",
      "all five eggs rest stationary in a single spaced row on a shallow open basket display, fully above its low rim, with no eggs on the ground or hidden inside it.")
    .replace(base.semantics.motion, R2_CONSTRAINTS.motion)
    + `\n\n[NEW_EXPLICIT_CREATIVE_REVISION]\n${R2.revision}; parent S19 remains terminal.\n`
    + Object.values(R2_CONSTRAINTS).join("\n");
  const manifest = { ...base.manifest, creative_revision: R2.revision,
    lineage: { parent_asset_id: R2.parentAssetId, parent_scene_id: "s19",
      parent_image_request_id: R2.parentImageRequest, parent_video_request_id: R2.parentVideoRequest },
    revision_constraints: R2_CONSTRAINTS };
  manifest.asset_specification_hash = contentHash({ ...manifest, asset_specification_hash: undefined });
  const prompt = { text: promptText, prompt_hash: contentHash(promptText) };
  const specificationHash = contentHash({ version: R2.version, manifest, prompt_hash: prompt.prompt_hash });
  const requestHash = contentHash({ revision: R2.revision, specificationHash, prompt_hash: prompt.prompt_hash,
    model: ASSET_V2_IMAGE_MODEL, size: "1152x2048", quality: "high" });
  return { ...base, manifest, prompt, specificationHash, requestHash };
}

async function downloadAsset(supabase, asset) {
  const { data, error } = await supabase.storage.from(asset.storage_bucket).download(asset.storage_path);
  if (error || !data) throw new Error("r2_reference_download_failed");
  const buffer = Buffer.from(await data.arrayBuffer());
  if (sha256(buffer) !== asset.asset_hash) throw new Error("r2_reference_hash_mismatch");
  return buffer;
}

async function assertParent(supabase) {
  const { data: repair, error } = await supabase.from("lumi_pilot_repairs").select("*")
    .eq("pilot_id", "lumi_cinco_huevos_v1").eq("scene_id", "s19").eq("stage", "IMAGE").single();
  const { data: video } = await supabase.from("lumi_pilot_runs").select("*")
    .eq("pilot_id", "lumi_cinco_huevos_v1").eq("scene_id", "s19").eq("stage", "VIDEO").single();
  if (error || repair?.status !== "SUCCEEDED" || repair.provider_request_id !== R2.parentImageRequest
    || video?.result?.results?.[0]?.request_id !== R2.parentVideoRequest
    || video.result.temporal_qa?.status !== "BLOCKER") throw new Error("r2_terminal_parent_required");
  const { data: parent } = await supabase.from("av2_assets").select("*").eq("id", R2.parentAssetId).single();
  if (parent?.status !== "qa_passed" || parent.provider_request_id !== R2.parentImageRequest) throw new Error("r2_parent_image_required");
  return parent;
}

export async function runR2Image({ supabase, store, env, apiKey, supabaseUrl, fetchImpl = fetch }) {
  if (!apiKey) throw new Error("r2_image_key_missing");
  const parent = await assertParent(supabase);
  const plan = await buildPilotImagePlan({ supabase, supabaseUrl });
  const scene = makeR2Scene(plan.scenes.find(s => s.sceneId === "s19"));
  const canonical = await fetchCanonicalReference({ supabaseUrl, fetchImpl });
  const { data: world } = await supabase.from("av2_assets").select("*")
    .eq("artifact_id", R2.artifactId).eq("scene_id", "s11").eq("variant", "visual_benchmark_v1")
    .eq("asset_hash", "b069f9d7c6ff086708d57e126a3342ed820dc58d58f730f9abd0c1faf65483d4").single();
  if (!world) throw new Error("r2_world_missing");
  const worldBuffer = await downloadAsset(supabase, world);
  const row = await claimR2({ supabase, env, revision: R2.revision, sceneId: "s19", stage: "IMAGE", estimatedUsd: 0.103052 });
  try {
    const spec = await persistSpecification(store, plan, scene, { version: R2.version, benchmarkRole: "s19_r2_recap" });
    if (!await store.claimSpecification(spec.id)) throw new Error("r2_spec_consumed");
    await patchR2(supabase, row, { result: { ...row.result, specification_id: spec.id,
      specification_hash: scene.specificationHash, request_hash: scene.requestHash } });
    const { dispatchR2 } = await import("./lumi-s19-r2-guard.js");
    const result = await generateBenchmarkComposite({ apiKey, model: ASSET_V2_IMAGE_MODEL,
      prompt: scene.prompt.text, referenceBuffers: [
        { buffer: canonical, filename: "canonical-lumi.png" },
        { buffer: worldBuffer, filename: "canonical-world.png" }],
      fetchImpl: (url, options) => dispatchR2({ supabase, row, fetchImpl, url, options }) });
    if (result.image.width !== 1152 || result.image.height !== 2048) throw new Error("r2_image_dimensions");
    const path = `${R2.artifactId}/s19-r2/source/${scene.specificationHash}/source.png`;
    await store.uploadPng(path, result.buffer, { revision: R2.revision, content_sha256: result.image.sha256 });
    const details = result.usage?.input_tokens_details || {};
    const output = result.usage?.output_tokens_details || {};
    const cost = [details.text_tokens, details.image_tokens, output.image_tokens].every(Number.isFinite)
      ? Number((details.text_tokens * 2.5e-6 + details.image_tokens * 4e-6 + output.image_tokens * 15e-6).toFixed(6)) : null;
    const asset = { ...parent, specification_id: spec.id, specification_hash: scene.specificationHash,
      variant: R2.variant, asset_hash: result.image.sha256, provider_model: result.model,
      provider_request_hash: scene.requestHash, provider_request_id: result.provider_request_id,
      provider_response_id: result.provider_response_id, storage_path: path, parent_asset_id: parent.id,
      reuse_of_asset_id: null, scene_manifest_version: R2.version, generated_at: result.created_at,
      status: "generated", review_url: null, review_url_expires_at: null,
      provider_metadata: { revision: R2.revision, lineage: row.result.lineage,
        usage: result.usage, actual_cost_usd: cost, estimated_cost_usd: 0.103052 } };
    delete asset.id; delete asset.created_at; delete asset.updated_at;
    const saved = await store.saveGeneratedAsset(asset);
    await store.setSpecificationStatus(spec.id, "generated");
    await patchR2(supabase, row, { status: "SUCCEEDED", provider_request_id: result.provider_request_id,
      storage_bucket: saved.storage_bucket, storage_path: saved.storage_path, content_hash: saved.asset_hash,
      artifact_reference: saved.id, completed_at: new Date().toISOString(),
      result: { ...row.result, lifecycle: "SUCCEEDED_VISUAL_QA_PENDING", asset: saved,
        actual_cost_usd: cost, visual_qa: { accepted: false, status: "PENDING" } } });
    return row;
  } catch (error) {
    await patchR2(supabase, row, { status: "FAILED", error_code: error.code || error.message,
      result: { ...row.result, lifecycle: row.result.dispatch_consumed ? "FAILED_AFTER_DISPATCH_NO_RESUBMIT" : "FAILED_PREPARATION_NO_RETRY" } });
    throw error;
  }
}

export async function runR2Video({ supabase, env, apiKey, balanceConfirmed, fetchImpl = fetch }) {
  await assertParent(supabase);
  if (!apiKey || !balanceConfirmed) throw new Error("r2_video_provider_not_ready");
  const source = await readR2Run(supabase, "IMAGE");
  if (!isR2SourceApproved(source)) throw new Error("r2_source_qa_required");
  const asset = source.result.asset;
  await downloadAsset(supabase, asset);
  const { data: signed, error } = await supabase.storage.from(asset.storage_bucket).createSignedUrl(asset.storage_path, 7200);
  if (error || !signed?.signedUrl) throw new Error("r2_source_signing_failed");
  const prompt = { compiler_version: GENERATIVE_VIDEO_PROMPT_COMPILER_V1,
    text: `[S19-R2 recap and close]\n${Object.values(R2_CONSTRAINTS).join("\n")}\nHigh-end original preschool 3D animation; preserve the source composition precisely. No generated text, no new props. Five seconds, single shot, no audio.` };
  prompt.prompt_hash = sha256(prompt.text);
  const input = buildModelInput(LUMI_PILOT_VIDEO_MODEL, signed.signedUrl, prompt);
  // Fixed known model price avoids a separate provider estimate call: one submission only.
  const usd = 0.231;
  const row = await claimR2({ supabase, env, revision: R2.revision, sceneId: "s19", stage: "VIDEO", estimatedUsd: usd });
  const base = `lumi-production-pilot-v1/s19-r2/video/${asset.asset_hash}/${prompt.prompt_hash}`;
  await writeJsonObject(supabase, `${base}/planned.json`, { revision: R2.revision, source_hash: asset.asset_hash, prompt_hash: prompt.prompt_hash, lineage: row.result.lineage }, false);
  const { dispatchR2 } = await import("./lumi-s19-r2-guard.js");
  const accepted = await providerJson(`https://api.higgsfield.ai/${LUMI_PILOT_VIDEO_MODEL.model}`, {
    apiKey, method: "POST", body: input,
    fetchImpl: (url, options) => dispatchR2({ supabase, row, fetchImpl, url, options }) });
  if (!accepted.request_id || !accepted.status_url) throw new Error("r2_video_handle_missing_no_resubmit");
  if ([R2.parentImageRequest, R2.parentVideoRequest].includes(accepted.request_id)) throw new Error("r2_request_identity_collision");
  await patchR2(supabase, row, { provider_request_id: accepted.request_id,
    result: { ...row.result, submitted: accepted, base, prompt_hash: prompt.prompt_hash,
      source_hash: asset.asset_hash, estimated_cost_usd: usd } });
  await writeJsonObject(supabase, `${base}/submitted.json`, row.result, false);
  return recoverR2Video({ supabase, apiKey, fetchImpl });
}

// Poll/retrieve the already persisted request only; this function never submits.
export async function recoverR2Video({ supabase, apiKey, fetchImpl = fetch }) {
  const row = await readR2Run(supabase, "VIDEO");
  if (row?.status === "SUCCEEDED" || row?.status === "FAILED") return row;
  if (!row?.result?.submitted?.status_url || !row.provider_request_id) throw new Error("r2_video_ambiguous_no_resubmit");
  const terminal = await pollRequest({ apiKey, statusUrl: row.result.submitted.status_url, fetchImpl, onStatus: async () => {} });
  if (terminal.status !== "completed" || !terminal.video?.url) {
    await patchR2(supabase, row, { status: "FAILED", error_code: "r2_video_terminal_failure", result: { ...row.result, terminal } });
    return row;
  }
  const response = await fetchImpl(terminal.video.url);
  if (!response.ok) throw new Error("r2_output_download_failed");
  const bytes = Buffer.from(await response.arrayBuffer());
  const outputHash = sha256(bytes);
  const outputPath = `${row.result.base}/original.mp4`;
  // Storage failure preserves the original handle; recovery may download it again, never submit.
  const { data: existing } = await supabase.storage.from(GENERATIVE_VIDEO_BUCKET).download(outputPath);
  if (existing) {
    if (sha256(Buffer.from(await existing.arrayBuffer())) !== outputHash) throw new Error("r2_output_collision");
  } else await uploadObject(supabase, outputPath, bytes, "video/mp4", false);
  const result = { ...row.result, output_hash: outputHash, output_path: outputPath,
    output_bucket: GENERATIVE_VIDEO_BUCKET, output_bytes: bytes.length,
    model: LUMI_PILOT_VIDEO_MODEL.model, actual_cost_usd: terminal.cost?.usd ?? terminal.usd ?? null,
    temporal_qa: { status: "PENDING", accepted: false }, lifecycle: "COMPLETED_TEMPORAL_QA_PENDING" };
  await writeJsonObject(supabase, `${row.result.base}/completed.json`, result, false);
  return patchR2(supabase, row, { status: "SUCCEEDED", result, storage_bucket: GENERATIVE_VIDEO_BUCKET,
    storage_path: outputPath, content_hash: outputHash, completed_at: new Date().toISOString() });
}
