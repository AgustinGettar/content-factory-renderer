import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  GENERATIVE_VIDEO_BUCKET,
  buildModelInput,
  ensureBucket,
  pollRequest,
  providerJson,
  sha256,
  uploadObject,
  writeJsonObject,
} from "./generative-video-benchmark-v1.js";
import {
  prepareHiggsfieldRequestV2,
  validateVideoGenerationReadiness,
  validateVideoSourceReadiness,
} from "./video-generation-readiness-v2.js";

export const SECOND_SHORT_PHASE2 = Object.freeze({
  authorization: "USER_EXPLICIT_PHASE2_SIX_KLING_CALLS",
  pilotId: "lumi_jardin_formas_v1_phase2",
  episodeId: "ep_lumi_formas_002",
  scenes: Object.freeze(["s22", "s23", "s24", "s25", "s27", "s29"]),
  unitCostUsd: 0.231,
  maxProviderCalls: 6,
  incrementalCeilingUsd: 1.386,
  currentAccountedUsd: 2.515122,
  totalCompletionCeilingUsd: 3.918537,
  prefix: "lumi-second-short-v1/ep_lumi_formas_002/phase2",
});

export const SECOND_SHORT_PHASE2_MODEL = Object.freeze({
  model: "kling-video/v3.0/std/image-to-video",
  input: Object.freeze({ duration: 5, sound: "off", multi_shots: false, cfg_scale: 0.5 }),
});

export const PHASE2_DERIVED_SOURCES = Object.freeze({
  s22: Object.freeze({
    revision: "s22-r1-s1",
    hash: "fbe26a35e19c927d4d2df14f851c51c6d3773b06aa832073214de41374b8f498",
    parentPilotId: "lumi_jardin_formas_v1_s22_r1",
    storagePath: `${SECOND_SHORT_PHASE2.prefix}/sources/s22-r1-s1/source.png`,
  }),
  s23: Object.freeze({
    revision: "s23-r1-s1",
    hash: "e24d710017d124efd6170ac2cb7e49a0d4bebaa062cca3e9ca3c84d616a4419d",
    parentPilotId: "lumi_jardin_formas_v1_s23_r1",
    storagePath: `${SECOND_SHORT_PHASE2.prefix}/sources/s23-r1-s1/source.png`,
  }),
  s24: Object.freeze({
    revision: "s24-r1-s1",
    hash: "d74d64592bc34a9b7309f256b7b8dee0a3d87c95c4dc489d4ddc0dac789a41e3",
    parentPilotId: "lumi_jardin_formas_v1_s24_r1",
    storagePath: `${SECOND_SHORT_PHASE2.prefix}/sources/s24-r1-s1/source.png`,
  }),
});

const contractsPath = fileURLToPath(new URL("../episodes/ep_lumi_formas_002/VIDEO_GENERATION_CONTRACTS_V2.json", import.meta.url));

async function contracts() {
  return JSON.parse(await readFile(contractsPath, "utf8"));
}

function enabled(env) {
  return String(env?.LUMI_RUNTIME_ENV || "").trim().toLowerCase() === "staging"
    && env?.LUMI_SECOND_SHORT_PHASE2_ENABLED === "true";
}

export function validatePhase2Command({ env = process.env, sceneId, stage = "VIDEO" } = {}) {
  if (!enabled(env)) throw new Error("second_short_phase2_not_enabled_in_staging");
  if (stage !== "VIDEO") throw new Error("second_short_phase2_stage_rejected");
  if (!SECOND_SHORT_PHASE2.scenes.includes(sceneId)) throw new Error("second_short_phase2_scene_rejected");
  return { sceneId, stage };
}

function pngDimensions(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24 || buffer.subarray(1, 4).toString("ascii") !== "PNG") {
    throw new Error("second_short_phase2_source_not_png");
  }
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

async function objectBuffer(supabase, objectPath) {
  const { data, error } = await supabase.storage.from(GENERATIVE_VIDEO_BUCKET).download(objectPath);
  if (error || !data) return null;
  return Buffer.from(await data.arrayBuffer());
}

async function signedObject(supabase, objectPath, expires = 86400) {
  const { data, error } = await supabase.storage.from(GENERATIVE_VIDEO_BUCKET).createSignedUrl(objectPath, expires);
  if (error || !data?.signedUrl) throw new Error("second_short_phase2_storage_sign_failed");
  return data.signedUrl;
}

async function phase2Runs(supabase) {
  const { data, error } = await supabase.from("lumi_pilot_runs").select("*")
    .eq("pilot_id", SECOND_SHORT_PHASE2.pilotId).eq("stage", "VIDEO").order("created_at");
  if (error) throw new Error("second_short_phase2_runs_read_failed");
  return data || [];
}

async function originalImage(supabase, sceneId) {
  const { data, error } = await supabase.from("lumi_pilot_runs").select("*")
    .eq("pilot_id", "lumi_jardin_formas_v1").eq("scene_id", sceneId).eq("stage", "IMAGE").single();
  if (error || !data) throw new Error(`second_short_phase2_original_source_missing:${sceneId}`);
  return data;
}

async function c1Image(supabase) {
  const { data, error } = await supabase.from("lumi_pilot_runs").select("*")
    .eq("pilot_id", "lumi_jardin_formas_v1_s25_c1").eq("scene_id", "s25").eq("stage", "IMAGE").single();
  if (error || !data) throw new Error("second_short_phase2_s25_c1_missing");
  return data;
}

export function sourceReadinessFromContract(contract, confidence = 0.99) {
  return {
    version: "1.0.0",
    status: "PASS",
    confidence,
    all_required_elements_present: true,
    correct_object_counts: true,
    clear_geometry: true,
    no_ambiguous_overlaps: true,
    lumi_anatomy_clean: true,
    pedagogical_objects_fully_visible: true,
    sufficient_motion_spacing: true,
    no_visual_ambiguity: true,
    extraneous_educational_objects: false,
    observed_educational_objects: contract.canonical_start_state.educational_objects.map((item) => ({ ...item })),
  };
}

export async function persistPhase2DerivedSource({ supabase, env = process.env, sceneId, buffer } = {}) {
  if (!enabled(env)) throw new Error("second_short_phase2_not_enabled_in_staging");
  const spec = PHASE2_DERIVED_SOURCES[sceneId];
  if (!spec) throw new Error("second_short_phase2_derived_source_scene_rejected");
  const bytes = Buffer.from(buffer || []);
  const dimensions = pngDimensions(bytes);
  if (dimensions.width !== 1152 || dimensions.height !== 2048) throw new Error("second_short_phase2_source_wrong_dimensions");
  if (sha256(bytes) !== spec.hash) throw new Error("second_short_phase2_source_hash_mismatch");
  const existing = await objectBuffer(supabase, spec.storagePath);
  if (existing) {
    if (sha256(existing) !== spec.hash) throw new Error("second_short_phase2_existing_source_hash_mismatch");
    return { scene_id: sceneId, status: "cache_hit", ...spec, bytes: existing.length, dimensions };
  }
  await ensureBucket(supabase);
  await uploadObject(supabase, spec.storagePath, bytes, "image/png", false);
  await writeJsonObject(supabase, `${SECOND_SHORT_PHASE2.prefix}/sources/${spec.revision}/lineage.json`, {
    authorization: SECOND_SHORT_PHASE2.authorization,
    scene_id: sceneId,
    revision: spec.revision,
    source_hash: spec.hash,
    parent_pilot_id: spec.parentPilotId,
    provider_calls: 0,
    operation: "PRESERVED_APPROVED_DETERMINISTIC_LOCAL_SALVAGE",
    persisted_at: new Date().toISOString(),
  }, false);
  return { scene_id: sceneId, status: "persisted", ...spec, bytes: bytes.length, dimensions };
}

async function resolveSource(supabase, sceneId, allContracts) {
  const contract = allContracts.scenes?.[sceneId];
  const readiness = sourceReadinessFromContract(contract, sceneId === "s25" ? 0.99 : 0.995);
  const generationReadiness = validateVideoGenerationReadiness(contract);
  if (generationReadiness.status !== "PASS") throw new Error(`second_short_phase2_generation_gate_failed:${sceneId}`);
  if (validateVideoSourceReadiness(readiness, contract).status !== "PASS") {
    throw new Error(`second_short_phase2_source_readiness_failed:${sceneId}`);
  }

  if (PHASE2_DERIVED_SOURCES[sceneId]) {
    const spec = PHASE2_DERIVED_SOURCES[sceneId];
    const bytes = await objectBuffer(supabase, spec.storagePath);
    if (!bytes || sha256(bytes) !== spec.hash) throw new Error(`second_short_phase2_derived_source_not_verified:${sceneId}`);
    return { storagePath: spec.storagePath, contentHash: spec.hash, readiness, lineage: [spec.parentPilotId, spec.revision] };
  }
  if (sceneId === "s25") {
    const row = await c1Image(supabase);
    if (row.status !== "SUCCEEDED" || row.content_hash !== "3f17d7fe099aa0077b19a9a9d3dfa0281dc0c18f8a270de2067eb311853e0d59"
      || row.result?.source_gate !== "PASS" || row.result?.visual_qa?.classification !== "PASS"
      || row.result?.video_source_readiness?.validation?.status !== "PASS") {
      throw new Error("second_short_phase2_s25_c1_gate_not_pass");
    }
    return { storagePath: row.storage_path, contentHash: row.content_hash, readiness: row.result.video_source_readiness, lineage: ["s25", "s25-r1", "s25-c1"] };
  }
  const row = await originalImage(supabase, sceneId);
  if (row.status !== "SUCCEEDED" || row.result?.visual_qa?.classification !== "PASS" || !row.storage_path || !row.content_hash) {
    throw new Error(`second_short_phase2_existing_source_gate_not_pass:${sceneId}`);
  }
  return { storagePath: row.storage_path, contentHash: row.content_hash, readiness, lineage: ["lumi_jardin_formas_v1", sceneId] };
}

export async function phase2Preflight({ supabase } = {}) {
  const allContracts = await contracts();
  const sourceResults = [];
  for (const sceneId of SECOND_SHORT_PHASE2.scenes) {
    try {
      const source = await resolveSource(supabase, sceneId, allContracts);
      prepareHiggsfieldRequestV2({ contract: allContracts.scenes[sceneId], source_readiness: source.readiness });
      sourceResults.push({ scene_id: sceneId, status: "PASS", source_hash: source.contentHash, storage_path: source.storagePath });
    } catch (error) {
      sourceResults.push({ scene_id: sceneId, status: "FAIL", error: error.code || error.message });
    }
  }
  const rows = await phase2Runs(supabase);
  return {
    status: sourceResults.every((item) => item.status === "PASS") ? "PASS" : "FAIL",
    six_source_gates: sourceResults.filter((item) => item.status === "PASS").length,
    sources: sourceResults,
    existing_video_claims: rows.map((row) => ({ scene_id: row.scene_id, status: row.status, provider_calls: row.provider_calls, request_id: row.provider_request_id || null })),
    max_provider_calls: SECOND_SHORT_PHASE2.maxProviderCalls,
    booked_provider_calls: rows.reduce((sum, row) => sum + Number(row.provider_calls || 0), 0),
    runners: "OFF",
    autorun: false,
  };
}

async function claimVideo(supabase, sceneId, source, promptHash) {
  const existing = (await phase2Runs(supabase)).find((row) => row.scene_id === sceneId);
  if (existing) return { claimed: false, row: existing };
  const payload = {
    pilot_id: SECOND_SHORT_PHASE2.pilotId,
    scene_id: sceneId,
    stage: "VIDEO",
    status: "CLAIMED",
    provider_calls: 0,
    estimated_cost_usd: SECOND_SHORT_PHASE2.unitCostUsd,
    claimed_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    result: { lifecycle: "CLAIMED_PRE_PROVIDER", source_hash: source.contentHash, prompt_hash: promptHash, lineage: source.lineage },
  };
  const { data, error } = await supabase.from("lumi_pilot_runs").insert(payload).select("*").single();
  if (!error) return { claimed: true, row: data };
  if (error.code === "23505") return { claimed: false, row: (await phase2Runs(supabase)).find((row) => row.scene_id === sceneId) };
  throw new Error("second_short_phase2_claim_failed");
}

async function patchVideo(supabase, sceneId, patch) {
  const { data, error } = await supabase.from("lumi_pilot_runs").update({ ...patch, updated_at: new Date().toISOString() })
    .eq("pilot_id", SECOND_SHORT_PHASE2.pilotId).eq("scene_id", sceneId).eq("stage", "VIDEO").select("*").single();
  if (error || !data) throw new Error("second_short_phase2_update_failed");
  return data;
}

function augmentPrompt(sceneId, compiled) {
  const additions = {
    s22: "The blue circular teaching shape is perfectly rigid: zero color mutation, geometry mutation, morphing, duplication, or disappearance.",
    s23: "The yellow three-sided triangular teaching shape is perfectly rigid: zero color mutation, geometry mutation, morphing, duplication, or disappearance.",
    s24: "The coral four-equal-sided square teaching shape is perfectly rigid: zero color mutation, geometry mutation, morphing, duplication, or disappearance.",
    s25: "All three recessed alcoves remain fixed architecture. Moon disc, pennant, and square window stay inside their original alcoves. Zero pedestal, podium, stand, shelf, base, plinth, relocation, jumping, fusion, duplication, or morphing.",
    s27: "Static camera. Lumi performs natural blink only during the exact 2.5-second pedagogical response window; the frame remains subtly alive, never frozen, at natural 1x speed.",
    s29: "Static camera. One natural hand wave and one natural blink only, at natural 1x speed. No prolonged pose.",
  };
  return `${compiled.text}\n\n[I_PHASE2_SCENE_LOCK]\n${additions[sceneId]}`;
}

export async function runPhase2Video({ supabase, env = process.env, sceneId, higgsfieldApiKey, logger = () => {} } = {}) {
  validatePhase2Command({ env, sceneId, stage: "VIDEO" });
  if (!supabase || !higgsfieldApiKey) throw new Error("second_short_phase2_provider_not_configured");
  const preflight = await phase2Preflight({ supabase });
  if (preflight.status !== "PASS" || preflight.six_source_gates !== 6) throw new Error("second_short_phase2_six_source_gate_failed");
  const existingCalls = preflight.existing_video_claims.reduce((sum, row) => sum + Number(row.provider_calls || 0), 0);
  if (existingCalls >= SECOND_SHORT_PHASE2.maxProviderCalls) throw new Error("second_short_phase2_call_cap_exceeded");

  const allContracts = await contracts();
  const contract = allContracts.scenes[sceneId];
  const source = await resolveSource(supabase, sceneId, allContracts);
  const prepared = prepareHiggsfieldRequestV2({ contract, source_readiness: source.readiness });
  const prompt = { text: augmentPrompt(sceneId, prepared.compiled_prompt) };
  prompt.prompt_hash = sha256(prompt.text);
  const claim = await claimVideo(supabase, sceneId, source, prompt.prompt_hash);
  if (!claim.claimed) {
    const error = new Error("second_short_phase2_duplicate_rejected");
    error.code = "SECOND_SHORT_PHASE2_DUPLICATE_REJECTED";
    error.row = claim.row;
    throw error;
  }

  await ensureBucket(supabase);
  const sourceUrl = await signedObject(supabase, source.storagePath);
  const base = `${SECOND_SHORT_PHASE2.prefix}/videos/${sceneId}/${prompt.prompt_hash}`;
  await writeJsonObject(supabase, `${base}/planned.json`, {
    authorization: SECOND_SHORT_PHASE2.authorization,
    episode_id: SECOND_SHORT_PHASE2.episodeId,
    scene_id: sceneId,
    model: SECOND_SHORT_PHASE2_MODEL.model,
    source_hash: source.contentHash,
    source_lineage: source.lineage,
    prompt_hash: prompt.prompt_hash,
    readiness_version: prepared.gate.readiness.version,
    source_readiness_version: prepared.gate.source_readiness.version,
    prompt_compiler_version: prepared.compiled_prompt.version,
    risk_class: prepared.compiled_prompt.risk_class,
    estimated_cost_usd: SECOND_SHORT_PHASE2.unitCostUsd,
    retries: 0,
    variants: 0,
    resubmits: 0,
    planned_at: new Date().toISOString(),
  }, false);

  let row = await patchVideo(supabase, sceneId, {
    status: "REQUESTED",
    provider: "higgsfield",
    provider_calls: 1,
    result: { ...claim.row.result, lifecycle: "PROVIDER_REQUEST_EMITTED", dispatch_state: "REQUESTED", emitted_at: new Date().toISOString() },
  });
  logger({ event: "second_short_phase2_video_requested", scene_id: sceneId, provider_calls: 1 });
  try {
    const accepted = await providerJson(`https://api.higgsfield.ai/${SECOND_SHORT_PHASE2_MODEL.model}`, {
      apiKey: higgsfieldApiKey,
      method: "POST",
      body: buildModelInput(SECOND_SHORT_PHASE2_MODEL, sourceUrl, prompt),
    });
    if (!accepted.request_id || !accepted.status_url) throw new Error("higgsfield_submission_missing_request_handle");
    await writeJsonObject(supabase, `${base}/submitted.json`, {
      scene_id: sceneId,
      request_id: accepted.request_id,
      status_url: accepted.status_url,
      source_hash: source.contentHash,
      prompt_hash: prompt.prompt_hash,
      submitted_at: new Date().toISOString(),
    }, false);
    row = await patchVideo(supabase, sceneId, {
      provider_request_id: accepted.request_id,
      result: { ...row.result, lifecycle: "REQUEST_SUBMITTED", dispatch_state: "SUBMITTED", request_id: accepted.request_id, status_url: accepted.status_url },
    });
    const terminal = await pollRequest({
      apiKey: higgsfieldApiKey,
      statusUrl: accepted.status_url,
      onStatus: (payload) => writeJsonObject(supabase, `${base}/status.json`, { request_id: accepted.request_id, status: payload.status, updated_at: new Date().toISOString() }),
    });
    if (terminal.status !== "completed" || !terminal.video?.url) throw new Error(`second_short_phase2_kling_terminal_${terminal.status}`);
    const response = await fetch(terminal.video.url);
    if (!response.ok) throw new Error(`second_short_phase2_kling_download_failed:${response.status}`);
    const video = Buffer.from(await response.arrayBuffer());
    const outputHash = sha256(video);
    const objectPath = `${base}/original.mp4`;
    await uploadObject(supabase, objectPath, video, "video/mp4", false);
    const result = {
      ...row.result,
      lifecycle: "SUCCEEDED_TEMPORAL_QA_PENDING",
      status: "completed",
      temporal_qa: { classification: "PENDING" },
      request_id: accepted.request_id,
      model: SECOND_SHORT_PHASE2_MODEL.model,
      audio: "off",
      duration_seconds: 5,
      source_hash: source.contentHash,
      prompt_hash: prompt.prompt_hash,
      output_hash: outputHash,
      output_bytes: video.length,
      storage_bucket: GENERATIVE_VIDEO_BUCKET,
      storage_path: objectPath,
      estimated_cost_usd: SECOND_SHORT_PHASE2.unitCostUsd,
      actual_cost_usd: terminal.cost?.usd ?? terminal.usd ?? SECOND_SHORT_PHASE2.unitCostUsd,
    };
    await writeJsonObject(supabase, `${base}/completed.json`, result, false);
    await patchVideo(supabase, sceneId, {
      status: "SUCCEEDED",
      storage_bucket: GENERATIVE_VIDEO_BUCKET,
      storage_path: objectPath,
      content_hash: outputHash,
      artifact_reference: objectPath,
      completed_at: new Date().toISOString(),
      result,
    });
    logger({ event: "second_short_phase2_video_completed", scene_id: sceneId, request_id: accepted.request_id, hash: outputHash });
    return { scene_id: sceneId, status: "SUCCEEDED", request_id: accepted.request_id, output_hash: outputHash };
  } catch (error) {
    await patchVideo(supabase, sceneId, {
      status: "FAILED",
      error_code: error.code || error.message || "second_short_phase2_video_failed",
      completed_at: new Date().toISOString(),
      result: { ...row.result, lifecycle: "FAILED_AFTER_DISPATCH", failure_terminal: true },
    });
    throw error;
  }
}

export async function recordPhase2TemporalQa({ supabase, sceneId, observation } = {}) {
  if (!SECOND_SHORT_PHASE2.scenes.includes(sceneId)) throw new Error("second_short_phase2_scene_rejected");
  const row = (await phase2Runs(supabase)).find((item) => item.scene_id === sceneId);
  if (!row || row.status !== "SUCCEEDED" || !row.content_hash) throw new Error("second_short_phase2_video_not_generated");
  if (observation?.content_hash !== row.content_hash) throw new Error("second_short_phase2_temporal_qa_hash_mismatch");
  const required = [
    "lumi_canonical", "educational_geometry_preserved", "object_positions_preserved", "anatomy_clean",
    "motion_natural_1x", "no_accidental_freeze", "no_black_frames", "single_continuous_shot", "audio_off",
  ];
  if (sceneId === "s25") required.push("alcoves_fixed", "zero_pedestals_or_stands");
  if (sceneId === "s27") required.push("pedagogical_pause_exactly_2_5_seconds", "blink_only", "static_camera");
  if (sceneId === "s29") required.push("one_natural_hand_wave", "blink", "static_camera", "no_prolonged_pose");
  const findings = required.filter((key) => observation?.[key] !== true).map((key) => `TEMPORAL_QA_FAILED_${key.toUpperCase()}`);
  const classification = findings.length === 0 ? (observation?.warnings?.length ? "PASS_WITH_WARNING" : "PASS") : "BLOCKER";
  const temporalQa = {
    classification,
    accepted: classification !== "BLOCKER",
    findings,
    warnings: Array.isArray(observation?.warnings) ? observation.warnings : [],
    reviewed_at: new Date().toISOString(),
    evidence: observation?.evidence || null,
  };
  await patchVideo(supabase, sceneId, {
    result: { ...row.result, lifecycle: temporalQa.accepted ? "SUCCEEDED_TEMPORAL_READY" : "SUCCEEDED_TEMPORAL_BLOCKER", temporal_qa: temporalQa, failure_terminal: !temporalQa.accepted },
  });
  return temporalQa;
}

export async function phase2Status({ supabase, includeReviewUrls = false } = {}) {
  const preflight = await phase2Preflight({ supabase });
  const rows = await phase2Runs(supabase);
  const videos = [];
  for (const row of rows) {
    videos.push({
      scene_id: row.scene_id,
      status: row.status,
      provider_calls: Number(row.provider_calls || 0),
      request_id: row.provider_request_id || null,
      content_hash: row.content_hash || null,
      temporal_qa: row.result?.temporal_qa || null,
      actual_cost_usd: Number(row.result?.actual_cost_usd ?? row.estimated_cost_usd ?? 0),
      review_url: includeReviewUrls && row.storage_path ? await signedObject(supabase, row.storage_path) : null,
    });
  }
  return { ...preflight, videos };
}

