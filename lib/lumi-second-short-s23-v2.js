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
  PHASE2_DERIVED_SOURCES,
  SECOND_SHORT_PHASE2_MODEL,
  sourceReadinessFromContract,
} from "./lumi-second-short-phase2-v1.js";
import {
  prepareHiggsfieldRequestV2,
  validateVideoGenerationReadiness,
  validateVideoSourceReadiness,
} from "./video-generation-readiness-v2.js";

export const SECOND_SHORT_S23_V2 = Object.freeze({
  authorization: "EXPLICIT_TEMPORAL_CREATIVE_REVISION",
  identity: "s23-V2",
  pilotId: "lumi_jardin_formas_v1_phase2_s23_v2",
  episodeId: "ep_lumi_formas_002",
  sceneId: "s23",
  unitCostUsd: 0.231,
  maxProviderCalls: 1,
  currentAccountedUsd: 2.977122,
  maxAdditionalKlingCallsFromCheckpoint: 5,
  totalCompletionCeilingUsd: 4.143872,
  prefix: "lumi-second-short-v1/ep_lumi_formas_002/phase2/s23-v2",
  originalVideo: Object.freeze({
    pilotId: "lumi_jardin_formas_v1_phase2",
    requestId: "a05b628a-9f5a-4b2d-9250-6d58b84fa73b",
    contentHash: "44bb9225fa288d96a5987c110dd4e0c386a5b6ef4af7f0c4598112483bbc9154",
  }),
});

const contractsPath = fileURLToPath(new URL("../episodes/ep_lumi_formas_002/VIDEO_GENERATION_CONTRACTS_V2.json", import.meta.url));

async function contracts() {
  return JSON.parse(await readFile(contractsPath, "utf8"));
}

function enabled(env) {
  return String(env?.LUMI_RUNTIME_ENV || "").trim().toLowerCase() === "staging"
    && env?.LUMI_SECOND_SHORT_S23_V2_ENABLED === "true";
}

export function validateS23V2Command({ env = process.env, sceneId, stage = "VIDEO" } = {}) {
  if (!enabled(env)) throw new Error("second_short_s23_v2_not_enabled_in_staging");
  if (stage !== "VIDEO") throw new Error("second_short_s23_v2_stage_rejected");
  if (sceneId !== SECOND_SHORT_S23_V2.sceneId) throw new Error("second_short_s23_v2_scene_rejected");
  return { sceneId, stage };
}

export function buildS23V2Contract(baseContract) {
  return {
    ...baseContract,
    allowed_motion: {
      primary_character_actions: ["small_head_tilt_once"],
      secondary_micro_motion: ["blink"],
    },
    camera_contract: {
      single_continuous_shot: true,
      multi_shots: false,
      moves: [],
    },
  };
}

export function compileS23V2Prompt(baseContract, readiness) {
  const contract = buildS23V2Contract(baseContract);
  const prepared = prepareHiggsfieldRequestV2({ contract, source_readiness: readiness });
  const creativeRevision = [
    "[I_EXPLICIT_TEMPORAL_CREATIVE_REVISION]",
    "This is the single explicitly authorized s23-V2 creative revision. Stability is more important than motion complexity.",
    "[J_TRIANGLE_GEOMETRY_ABSOLUTE_LOCK]",
    "The yellow triangle is completely rigid and remains exactly three straight sides and three corners for the entire shot. It is fixed on the center pedestal and does not move, rotate, bend, warp, pulse, fold, gain an internal ridge or fourth edge, duplicate, disappear, fade, become transparent, or get replaced.",
    "[K_MOTION_REDUCTION]",
    "Static camera. Lumi performs at most one small natural head tilt and one natural blink. No arm sweep, no wand trace near the triangle, no object motion, no zoom, no orbit, no slow motion, no dreamy movement, and no prolonged pose.",
  ].join("\n");
  const text = `${prepared.compiled_prompt.text}\n\n${creativeRevision}`;
  return { contract, prepared, text, prompt_hash: sha256(text) };
}

async function objectBuffer(supabase, objectPath) {
  const { data, error } = await supabase.storage.from(GENERATIVE_VIDEO_BUCKET).download(objectPath);
  if (error || !data) return null;
  return Buffer.from(await data.arrayBuffer());
}

async function signedObject(supabase, objectPath, expires = 86400) {
  const { data, error } = await supabase.storage.from(GENERATIVE_VIDEO_BUCKET).createSignedUrl(objectPath, expires);
  if (error || !data?.signedUrl) throw new Error("second_short_s23_v2_storage_sign_failed");
  return data.signedUrl;
}

async function revisionRuns(supabase) {
  const { data, error } = await supabase.from("lumi_pilot_runs").select("*")
    .eq("pilot_id", SECOND_SHORT_S23_V2.pilotId).eq("stage", "VIDEO").order("created_at");
  if (error) throw new Error("second_short_s23_v2_runs_read_failed");
  return data || [];
}

async function originalBlocker(supabase) {
  const { data, error } = await supabase.from("lumi_pilot_runs").select("*")
    .eq("pilot_id", SECOND_SHORT_S23_V2.originalVideo.pilotId)
    .eq("scene_id", SECOND_SHORT_S23_V2.sceneId).eq("stage", "VIDEO").single();
  if (error || !data) throw new Error("second_short_s23_v2_original_video_missing");
  if (data.provider_request_id !== SECOND_SHORT_S23_V2.originalVideo.requestId
    || data.content_hash !== SECOND_SHORT_S23_V2.originalVideo.contentHash
    || data.result?.temporal_qa?.classification !== "BLOCKER") {
    throw new Error("second_short_s23_v2_original_blocker_mismatch");
  }
  return data;
}

async function verifiedSource(supabase, allContracts) {
  const spec = PHASE2_DERIVED_SOURCES.s23;
  const bytes = await objectBuffer(supabase, spec.storagePath);
  if (!bytes || sha256(bytes) !== spec.hash) throw new Error("second_short_s23_v2_source_not_verified");
  const readiness = sourceReadinessFromContract(allContracts.scenes.s23, 0.995);
  const contract = buildS23V2Contract(allContracts.scenes.s23);
  if (validateVideoGenerationReadiness(contract).status !== "PASS") throw new Error("second_short_s23_v2_generation_gate_failed");
  if (validateVideoSourceReadiness(readiness, contract).status !== "PASS") throw new Error("second_short_s23_v2_source_gate_failed");
  return { ...spec, readiness, bytes: bytes.length, lineage: [spec.parentPilotId, spec.revision] };
}

export async function s23V2Preflight({ supabase } = {}) {
  const allContracts = await contracts();
  const source = await verifiedSource(supabase, allContracts);
  const blocker = await originalBlocker(supabase);
  const prompt = compileS23V2Prompt(allContracts.scenes.s23, source.readiness);
  const rows = await revisionRuns(supabase);
  return {
    status: rows.length === 0 ? "PASS" : "ALREADY_CLAIMED",
    authorization: SECOND_SHORT_S23_V2.authorization,
    identity: SECOND_SHORT_S23_V2.identity,
    source_hash: source.hash,
    source_storage_path: source.storagePath,
    source_bytes: source.bytes,
    prompt_hash: prompt.prompt_hash,
    original_blocker: {
      request_id: blocker.provider_request_id,
      content_hash: blocker.content_hash,
      temporal_qa: blocker.result.temporal_qa.classification,
    },
    existing_claims: rows.map((row) => ({
      status: row.status,
      provider_calls: Number(row.provider_calls || 0),
      request_id: row.provider_request_id || null,
    })),
    max_provider_calls: 1,
    retries: 0,
    variants: 0,
    resubmits: 0,
    runners: "OFF",
    autorun: false,
  };
}

async function claimRevision(supabase, source, promptHash) {
  const existing = (await revisionRuns(supabase))[0];
  if (existing) return { claimed: false, row: existing };
  const now = new Date().toISOString();
  const payload = {
    pilot_id: SECOND_SHORT_S23_V2.pilotId,
    scene_id: SECOND_SHORT_S23_V2.sceneId,
    stage: "VIDEO",
    status: "CLAIMED",
    provider_calls: 0,
    estimated_cost_usd: SECOND_SHORT_S23_V2.unitCostUsd,
    claimed_at: now,
    updated_at: now,
    result: {
      lifecycle: "CLAIMED_PRE_PROVIDER",
      authorization: SECOND_SHORT_S23_V2.authorization,
      revision: SECOND_SHORT_S23_V2.identity,
      source_hash: source.hash,
      prompt_hash: promptHash,
      lineage: [...source.lineage, SECOND_SHORT_S23_V2.originalVideo],
    },
  };
  const { data, error } = await supabase.from("lumi_pilot_runs").insert(payload).select("*").single();
  if (!error) return { claimed: true, row: data };
  if (error.code === "23505") return { claimed: false, row: (await revisionRuns(supabase))[0] };
  throw new Error("second_short_s23_v2_claim_failed");
}

async function patchRevision(supabase, patch) {
  const { data, error } = await supabase.from("lumi_pilot_runs").update({ ...patch, updated_at: new Date().toISOString() })
    .eq("pilot_id", SECOND_SHORT_S23_V2.pilotId).eq("scene_id", "s23").eq("stage", "VIDEO").select("*").single();
  if (error || !data) throw new Error("second_short_s23_v2_update_failed");
  return data;
}

export async function runS23V2({ supabase, env = process.env, sceneId, higgsfieldApiKey, logger = () => {} } = {}) {
  validateS23V2Command({ env, sceneId, stage: "VIDEO" });
  if (!supabase || !higgsfieldApiKey) throw new Error("second_short_s23_v2_provider_not_configured");
  const preflight = await s23V2Preflight({ supabase });
  if (preflight.status !== "PASS") throw new Error("second_short_s23_v2_already_claimed");

  const allContracts = await contracts();
  const source = await verifiedSource(supabase, allContracts);
  const prompt = compileS23V2Prompt(allContracts.scenes.s23, source.readiness);
  const claim = await claimRevision(supabase, source, prompt.prompt_hash);
  if (!claim.claimed) {
    const error = new Error("second_short_s23_v2_duplicate_rejected");
    error.code = "SECOND_SHORT_S23_V2_DUPLICATE_REJECTED";
    error.row = claim.row;
    throw error;
  }

  await ensureBucket(supabase);
  const sourceUrl = await signedObject(supabase, source.storagePath);
  const base = `${SECOND_SHORT_S23_V2.prefix}/${prompt.prompt_hash}`;
  await writeJsonObject(supabase, `${base}/planned.json`, {
    authorization: SECOND_SHORT_S23_V2.authorization,
    revision: SECOND_SHORT_S23_V2.identity,
    episode_id: SECOND_SHORT_S23_V2.episodeId,
    scene_id: "s23",
    model: SECOND_SHORT_PHASE2_MODEL.model,
    source_hash: source.hash,
    source_lineage: source.lineage,
    original_blocker: SECOND_SHORT_S23_V2.originalVideo,
    prompt_hash: prompt.prompt_hash,
    prompt_compiler_version: prompt.prepared.compiled_prompt.version,
    risk_class: prompt.prepared.compiled_prompt.risk_class,
    estimated_cost_usd: SECOND_SHORT_S23_V2.unitCostUsd,
    retries: 0,
    variants: 0,
    resubmits: 0,
    planned_at: new Date().toISOString(),
  }, false);

  let row = await patchRevision(supabase, {
    status: "REQUESTED",
    provider: "higgsfield",
    provider_calls: 1,
    result: { ...claim.row.result, lifecycle: "PROVIDER_REQUEST_EMITTED", dispatch_state: "REQUESTED", emitted_at: new Date().toISOString() },
  });
  logger({ event: "second_short_s23_v2_requested", scene_id: "s23", provider_calls: 1 });
  try {
    const accepted = await providerJson(`https://api.higgsfield.ai/${SECOND_SHORT_PHASE2_MODEL.model}`, {
      apiKey: higgsfieldApiKey,
      method: "POST",
      body: buildModelInput(SECOND_SHORT_PHASE2_MODEL, sourceUrl, { text: prompt.text, prompt_hash: prompt.prompt_hash }),
    });
    if (!accepted.request_id || !accepted.status_url) throw new Error("second_short_s23_v2_submission_missing_request_handle");
    await writeJsonObject(supabase, `${base}/submitted.json`, {
      scene_id: "s23",
      revision: SECOND_SHORT_S23_V2.identity,
      request_id: accepted.request_id,
      status_url: accepted.status_url,
      source_hash: source.hash,
      prompt_hash: prompt.prompt_hash,
      submitted_at: new Date().toISOString(),
    }, false);
    row = await patchRevision(supabase, {
      provider_request_id: accepted.request_id,
      result: { ...row.result, lifecycle: "REQUEST_SUBMITTED", dispatch_state: "SUBMITTED", request_id: accepted.request_id, status_url: accepted.status_url },
    });
    const terminal = await pollRequest({
      apiKey: higgsfieldApiKey,
      statusUrl: accepted.status_url,
      onStatus: (payload) => writeJsonObject(supabase, `${base}/status.json`, { request_id: accepted.request_id, status: payload.status, updated_at: new Date().toISOString() }),
    });
    if (terminal.status !== "completed" || !terminal.video?.url) throw new Error(`second_short_s23_v2_terminal_${terminal.status}`);
    const response = await fetch(terminal.video.url);
    if (!response.ok) throw new Error(`second_short_s23_v2_download_failed:${response.status}`);
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
      source_hash: source.hash,
      prompt_hash: prompt.prompt_hash,
      output_hash: outputHash,
      output_bytes: video.length,
      storage_bucket: GENERATIVE_VIDEO_BUCKET,
      storage_path: objectPath,
      estimated_cost_usd: SECOND_SHORT_S23_V2.unitCostUsd,
      actual_cost_usd: terminal.cost?.usd ?? terminal.usd ?? SECOND_SHORT_S23_V2.unitCostUsd,
    };
    await writeJsonObject(supabase, `${base}/completed.json`, result, false);
    await patchRevision(supabase, {
      status: "SUCCEEDED",
      storage_bucket: GENERATIVE_VIDEO_BUCKET,
      storage_path: objectPath,
      content_hash: outputHash,
      artifact_reference: objectPath,
      completed_at: new Date().toISOString(),
      result,
    });
    logger({ event: "second_short_s23_v2_completed", scene_id: "s23", request_id: accepted.request_id, content_hash: outputHash });
    return { scene_id: "s23", revision: SECOND_SHORT_S23_V2.identity, status: "SUCCEEDED", request_id: accepted.request_id, output_hash: outputHash };
  } catch (error) {
    await patchRevision(supabase, {
      status: "FAILED",
      error_code: error.code || error.message || "second_short_s23_v2_failed",
      completed_at: new Date().toISOString(),
      result: { ...row.result, lifecycle: "FAILED_AFTER_DISPATCH", failure_terminal: true },
    });
    throw error;
  }
}

export async function recordS23V2TemporalQa({ supabase, observation } = {}) {
  const row = (await revisionRuns(supabase))[0];
  if (!row || row.status !== "SUCCEEDED" || !row.content_hash) throw new Error("second_short_s23_v2_not_generated");
  if (observation?.content_hash !== row.content_hash) throw new Error("second_short_s23_v2_temporal_qa_hash_mismatch");
  const required = [
    "lumi_canonical", "triangle_exactly_three_straight_sides_throughout", "triangle_rigid",
    "triangle_fixed_on_center_pedestal", "no_internal_ridge_or_fourth_edge", "no_object_motion",
    "no_duplication", "no_disappearance", "no_morphing", "anatomy_clean", "motion_natural_1x",
    "static_camera", "no_accidental_freeze", "no_black_frames", "single_continuous_shot", "audio_off",
  ];
  const findings = required.filter((key) => observation?.[key] !== true).map((key) => `TEMPORAL_QA_FAILED_${key.toUpperCase()}`);
  const classification = findings.length === 0 ? (observation?.warnings?.length ? "PASS_WITH_WARNING" : "PASS") : "BLOCKER";
  const temporalQa = {
    classification,
    accepted: classification !== "BLOCKER",
    findings,
    warnings: Array.isArray(observation?.warnings) ? observation.warnings : [],
    evidence: observation?.evidence || null,
    reviewed_at: new Date().toISOString(),
  };
  await patchRevision(supabase, {
    result: { ...row.result, lifecycle: temporalQa.accepted ? "SUCCEEDED_TEMPORAL_READY" : "SUCCEEDED_TEMPORAL_BLOCKER", temporal_qa: temporalQa, failure_terminal: !temporalQa.accepted },
  });
  return temporalQa;
}

export async function s23V2Status({ supabase, includeReviewUrl = false } = {}) {
  const rows = await revisionRuns(supabase);
  const row = rows[0] || null;
  return {
    authorization: SECOND_SHORT_S23_V2.authorization,
    identity: SECOND_SHORT_S23_V2.identity,
    status: row?.status || "NOT_CLAIMED",
    provider_calls: Number(row?.provider_calls || 0),
    request_id: row?.provider_request_id || null,
    content_hash: row?.content_hash || null,
    temporal_qa: row?.result?.temporal_qa || null,
    actual_cost_usd: Number(row?.result?.actual_cost_usd ?? row?.estimated_cost_usd ?? 0),
    review_url: includeReviewUrl && row?.storage_path ? await signedObject(supabase, row.storage_path) : null,
    retries: 0,
    variants: 0,
    resubmits: 0,
  };
}
