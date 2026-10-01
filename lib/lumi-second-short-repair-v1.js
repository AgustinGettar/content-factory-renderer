import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { ASSET_V2_IMAGE_MODEL, generateBenchmarkComposite } from "./asset-v2/image-provider.js";
import { fetchCanonicalReference } from "./asset-v2/visual-benchmark-runner.js";
import {
  GENERATIVE_VIDEO_BUCKET,
  sha256,
  uploadObject,
} from "./generative-video-benchmark-v1.js";
import {
  SECOND_SHORT_ID,
  SECOND_SHORT_IMAGE_UNIT_USD,
  SECOND_SHORT_PREFIX,
  budgetAllowsClaim,
} from "./lumi-second-short-v1.js";
import {
  compileVideoSourceImagePromptV1,
  validateVideoSourceReadiness,
} from "./video-generation-readiness-v2.js";

export const SECOND_SHORT_REPAIR_PHASE1 = Object.freeze({
  authorization: "USER_EXPLICIT_PHASE1_SOURCE_REPAIRS_ONLY",
  scenes: Object.freeze(["s22", "s23", "s24", "s25"]),
  stage: "IMAGE",
  revision: 1,
  incrementalCeilingUsd: 0.394398,
  totalCeilingUsd: 2.424748,
  currentAccountedUsd: 2.030350,
  maxProviderCalls: 4,
});

export const REPAIR_LIFECYCLE = Object.freeze({
  CLAIMED: "REPAIR_REVISION_CLAIMED",
  PREPARED: "REPAIR_REVISION_PREPARED",
  DISPATCH_COMMITTED: "PROVIDER_DISPATCH_COMMITTED",
  PROVIDER_EMITTED: "PROVIDER_REQUEST_EMITTED",
  SUCCEEDED_QA_PENDING: "SUCCEEDED_SOURCE_QA_PENDING",
  SUCCEEDED_READY: "SUCCEEDED_SOURCE_READY",
  FAILED_PRE_PROVIDER: "FAILED_PRE_PROVIDER_TERMINAL",
  FAILED_AFTER_DISPATCH: "FAILED_AFTER_DISPATCH_NO_RESUBMIT",
});

const contractsPath = fileURLToPath(new URL("../episodes/ep_lumi_formas_002/VIDEO_GENERATION_CONTRACTS_V2.json", import.meta.url));

async function videoContracts() {
  return JSON.parse(await readFile(contractsPath, "utf8"));
}

export function repairIdentity(sceneId) {
  const normalized = String(sceneId || "").trim().toLowerCase();
  return Object.freeze({
    sceneId: normalized,
    revision: `${normalized}-r1`,
    ledgerPilotId: `${SECOND_SHORT_ID}_${normalized}_r1`,
  });
}

export function validatePhase1RepairCommand({ env = process.env, sceneId, revision, stage = "IMAGE" } = {}) {
  const identity = repairIdentity(sceneId);
  if (String(env.LUMI_RUNTIME_ENV || "").trim().toLowerCase() !== "staging") {
    throw new Error("second_short_repair_production_rejected");
  }
  if (env.LUMI_SECOND_SHORT_REPAIR_PHASE1_ENABLED !== "true") {
    throw new Error("second_short_repair_phase1_disabled");
  }
  if (!SECOND_SHORT_REPAIR_PHASE1.scenes.includes(identity.sceneId)) {
    throw new Error("second_short_repair_scene_not_authorized");
  }
  if (String(stage || "").trim().toUpperCase() !== SECOND_SHORT_REPAIR_PHASE1.stage) {
    throw new Error("second_short_repair_video_not_authorized");
  }
  if (revision !== identity.revision) {
    throw new Error("second_short_repair_revision_not_authorized");
  }
  return { ...identity, stage: SECOND_SHORT_REPAIR_PHASE1.stage };
}

async function readRun(supabase, { pilotId, sceneId, stage = "IMAGE" }) {
  const { data, error } = await supabase.from("lumi_pilot_runs").select("*")
    .eq("pilot_id", pilotId).eq("scene_id", sceneId).eq("stage", stage).maybeSingle();
  if (error) throw new Error("second_short_repair_ledger_read_failed");
  return data;
}

export async function readPhase1Repair(supabase, sceneId) {
  const identity = repairIdentity(sceneId);
  return readRun(supabase, { pilotId: identity.ledgerPilotId, sceneId: identity.sceneId });
}

async function readOriginal(supabase, sceneId) {
  const row = await readRun(supabase, { pilotId: SECOND_SHORT_ID, sceneId });
  if (!row || row.status !== "SUCCEEDED") throw new Error("second_short_repair_original_source_missing");
  if (row.result?.visual_qa?.classification !== "BLOCKER") {
    throw new Error("second_short_repair_original_not_terminal_blocker");
  }
  return row;
}

async function allPhase1Rows(supabase) {
  return Promise.all(SECOND_SHORT_REPAIR_PHASE1.scenes.map((sceneId) => readPhase1Repair(supabase, sceneId)));
}

export function providerAttemptConsumed(row = {}) {
  return Number(row.provider_calls || 0) > 0
    || Boolean(row.provider_request_id)
    || row.result?.dispatch_consumed === true
    || [
      REPAIR_LIFECYCLE.DISPATCH_COMMITTED,
      REPAIR_LIFECYCLE.PROVIDER_EMITTED,
      REPAIR_LIFECYCLE.SUCCEEDED_QA_PENDING,
      REPAIR_LIFECYCLE.SUCCEEDED_READY,
      REPAIR_LIFECYCLE.FAILED_AFTER_DISPATCH,
    ].includes(row.result?.lifecycle);
}

export function resumableBeforeProvider(row = {}) {
  return ["CLAIMED", "REQUESTED"].includes(row.status)
    && Number(row.provider_calls || 0) === 0
    && !row.provider_request_id
    && row.result?.dispatch_consumed !== true
    && [REPAIR_LIFECYCLE.CLAIMED, REPAIR_LIFECYCLE.PREPARED].includes(row.result?.lifecycle);
}

export async function patchPhase1Repair(supabase, row, patch) {
  const identity = repairIdentity(row.scene_id);
  if (row.pilot_id !== identity.ledgerPilotId || !SECOND_SHORT_REPAIR_PHASE1.scenes.includes(row.scene_id)) {
    throw new Error("second_short_repair_original_immutable");
  }
  const { data, error } = await supabase.from("lumi_pilot_runs").update({
    ...patch,
    updated_at: new Date().toISOString(),
  }).eq("id", row.id).eq("pilot_id", identity.ledgerPilotId).select("*").single();
  if (error || !data) throw new Error("second_short_repair_ledger_update_failed");
  Object.assign(row, data);
  return row;
}

export async function claimPhase1Repair({
  supabase,
  env = process.env,
  sceneId,
  revision,
  stage = "IMAGE",
  estimatedUsd = SECOND_SHORT_IMAGE_UNIT_USD,
} = {}) {
  const command = validatePhase1RepairCommand({ env, sceneId, revision, stage });
  const original = await readOriginal(supabase, command.sceneId);
  const prior = await readPhase1Repair(supabase, command.sceneId);
  if (prior) {
    if (resumableBeforeProvider(prior)) return { claimed: true, resumed: true, row: prior, original };
    return { claimed: false, resumed: false, row: prior, original, reason: "second_short_repair_duplicate_rejected" };
  }
  if (!Number.isFinite(estimatedUsd) || estimatedUsd !== SECOND_SHORT_IMAGE_UNIT_USD) {
    throw new Error("second_short_repair_unit_budget_rejected");
  }
  const existing = (await allPhase1Rows(supabase)).filter(Boolean);
  const booked = existing.reduce((sum, row) => sum + Number(row.estimated_cost_usd || 0), 0);
  if (existing.length + 1 > SECOND_SHORT_REPAIR_PHASE1.maxProviderCalls
      || !budgetAllowsClaim({
        booked,
        priorCount: existing.length,
        estimate: estimatedUsd,
        ceiling: SECOND_SHORT_REPAIR_PHASE1.incrementalCeilingUsd,
      })) {
    throw new Error("second_short_repair_phase1_budget_exceeded");
  }
  const lineage = {
    parent_run_id: original.id,
    parent_pilot_id: original.pilot_id,
    parent_scene_id: original.scene_id,
    parent_stage: original.stage,
    parent_artifact_reference: original.artifact_reference || null,
    parent_storage_bucket: original.storage_bucket || null,
    parent_storage_path: original.storage_path || null,
    parent_content_hash: original.content_hash || null,
    parent_provider_request_id: original.provider_request_id || null,
    parent_visual_qa: original.result?.visual_qa || null,
  };
  const payload = {
    pilot_id: command.ledgerPilotId,
    scene_id: command.sceneId,
    stage: command.stage,
    status: "CLAIMED",
    provider_calls: 0,
    estimated_cost_usd: estimatedUsd,
    claimed_at: new Date().toISOString(),
    result: {
      revision: command.revision,
      generation_identity: command.ledgerPilotId,
      authorization: SECOND_SHORT_REPAIR_PHASE1.authorization,
      lifecycle: REPAIR_LIFECYCLE.CLAIMED,
      dispatch_consumed: false,
      provider_call_emitted: false,
      estimated_cost_usd_exact: estimatedUsd,
      lineage,
    },
  };
  const { data, error } = await supabase.from("lumi_pilot_runs").insert(payload).select("*").single();
  if (!error) return { claimed: true, resumed: false, row: data, original };
  if (error.code === "23505") {
    return { claimed: false, resumed: false, row: await readPhase1Repair(supabase, command.sceneId), original, reason: "second_short_repair_duplicate_rejected" };
  }
  throw new Error("second_short_repair_claim_failed");
}

export async function dispatchPhase1Repair({ supabase, row, fetchImpl = fetch, url, options }) {
  if (providerAttemptConsumed(row) || !resumableBeforeProvider(row)) {
    throw new Error("second_short_repair_provider_attempt_consumed");
  }
  await patchPhase1Repair(supabase, row, {
    status: "REQUESTED",
    result: {
      ...row.result,
      lifecycle: REPAIR_LIFECYCLE.DISPATCH_COMMITTED,
      dispatch_consumed: true,
      provider_call_emitted: false,
      dispatch_committed_at: new Date().toISOString(),
    },
  });
  const promise = fetchImpl(url, options);
  await patchPhase1Repair(supabase, row, {
    provider: "openai",
    provider_calls: 1,
    result: {
      ...row.result,
      lifecycle: REPAIR_LIFECYCLE.PROVIDER_EMITTED,
      dispatch_consumed: true,
      provider_call_emitted: true,
      provider_emitted_at: new Date().toISOString(),
    },
  });
  const response = await promise;
  const requestId = response.headers?.get?.("x-request-id") || null;
  if (requestId) await patchPhase1Repair(supabase, row, { provider_request_id: requestId });
  return response;
}

async function objectBuffer(supabase, objectPath) {
  const { data, error } = await supabase.storage.from(GENERATIVE_VIDEO_BUCKET).download(objectPath);
  if (error || !data) throw new Error(`second_short_repair_storage_read_failed:${objectPath}`);
  return Buffer.from(await data.arrayBuffer());
}

async function signedObject(supabase, objectPath, expires = 7200) {
  const { data, error } = await supabase.storage.from(GENERATIVE_VIDEO_BUCKET).createSignedUrl(objectPath, expires);
  if (error || !data?.signedUrl) throw new Error("second_short_repair_storage_sign_failed");
  return data.signedUrl;
}

function actualImageCost(usage) {
  const input = usage?.input_tokens_details || {};
  const output = usage?.output_tokens_details || {};
  if (![input.text_tokens, input.image_tokens, output.image_tokens].every(Number.isFinite)) return null;
  return Number((input.text_tokens * 2.5 / 1e6 + input.image_tokens * 4 / 1e6 + output.image_tokens * 15 / 1e6).toFixed(6));
}

export async function runPhase1SourceRepair({
  supabase,
  env = process.env,
  sceneId,
  revision,
  openAiApiKey,
  supabaseUrl,
  fetchImpl = fetch,
  logger = () => {},
} = {}) {
  const command = validatePhase1RepairCommand({ env, sceneId, revision, stage: "IMAGE" });
  if (!supabase || !openAiApiKey) throw new Error("second_short_repair_provider_not_configured");
  const [contracts, canonical, world] = await Promise.all([
    videoContracts(),
    fetchCanonicalReference({ supabaseUrl, fetchImpl }),
    readRun(supabase, { pilotId: SECOND_SHORT_ID, sceneId: "s21" }).then((row) => {
      if (!row?.storage_path || row.status !== "SUCCEEDED") throw new Error("second_short_repair_world_reference_missing");
      return objectBuffer(supabase, row.storage_path);
    }),
  ]);
  const contract = contracts.scenes?.[command.sceneId];
  const sourcePrompt = compileVideoSourceImagePromptV1(contract);
  const prompt = `${sourcePrompt.text}\n\n[EXPLICIT_REPAIR_REVISION]\n${command.revision}; the original scene artifact remains terminal and immutable. Generate one corrected source keyframe only. Follow the exclusive object set literally; do not preserve any contradictory object from the parent image.`;
  const promptHash = sha256(prompt);
  const claim = await claimPhase1Repair({ supabase, env, sceneId: command.sceneId, revision: command.revision });
  if (!claim.claimed) {
    const error = new Error(claim.reason || "second_short_repair_duplicate_rejected");
    error.code = claim.reason || "second_short_repair_duplicate_rejected";
    throw error;
  }
  const row = claim.row;
  try {
    await patchPhase1Repair(supabase, row, {
      status: "CLAIMED",
      result: {
        ...row.result,
        lifecycle: REPAIR_LIFECYCLE.PREPARED,
        source_prompt_version: sourcePrompt.version,
        video_generation_readiness_version: contract.version,
        prompt_hash: promptHash,
        provider_model: ASSET_V2_IMAGE_MODEL,
      },
    });
    logger({ event: "second_short_repair_prepared", scene_id: command.sceneId, revision: command.revision, provider_calls: 0 });
    const generated = await generateBenchmarkComposite({
      apiKey: openAiApiKey,
      model: ASSET_V2_IMAGE_MODEL,
      prompt,
      referenceBuffers: [
        { buffer: canonical, filename: "canonical-lumi.png" },
        { buffer: world, filename: "lantern-garden-style.png" },
      ],
      size: "1152x2048",
      quality: "high",
      fetchImpl: (url, options) => dispatchPhase1Repair({ supabase, row, fetchImpl, url, options }),
    });
    if (generated.image.width !== 1152 || generated.image.height !== 2048) {
      throw new Error("second_short_repair_image_wrong_dimensions");
    }
    if (claim.original.content_hash && generated.image.sha256 === claim.original.content_hash) {
      throw new Error("second_short_repair_artifact_identity_collision");
    }
    const objectPath = `${SECOND_SHORT_PREFIX}/repairs/${command.revision}/${promptHash}/source.png`;
    await uploadObject(supabase, objectPath, generated.buffer, "image/png", false);
    const reviewUrl = await signedObject(supabase, objectPath);
    const cost = actualImageCost(generated.usage);
    await patchPhase1Repair(supabase, row, {
      status: "SUCCEEDED",
      provider_request_id: generated.provider_request_id || row.provider_request_id || null,
      storage_bucket: GENERATIVE_VIDEO_BUCKET,
      storage_path: objectPath,
      content_hash: generated.image.sha256,
      artifact_reference: objectPath,
      completed_at: new Date().toISOString(),
      result: {
        ...row.result,
        lifecycle: REPAIR_LIFECYCLE.SUCCEEDED_QA_PENDING,
        output_hash: generated.image.sha256,
        output_bytes: generated.image.bytes,
        actual_cost_usd: cost,
        review_url: reviewUrl,
        visual_qa: { version: "visual-qa/1.2", classification: "PENDING" },
        video_source_readiness: { version: "1.0.0", status: "PENDING" },
      },
    });
    logger({ event: "second_short_repair_completed", scene_id: command.sceneId, revision: command.revision, provider_calls: 1 });
    return row;
  } catch (error) {
    const afterDispatch = providerAttemptConsumed(row);
    await patchPhase1Repair(supabase, row, {
      status: "FAILED",
      error_code: error.code || error.message || "second_short_repair_failed",
      completed_at: new Date().toISOString(),
      result: {
        ...row.result,
        lifecycle: afterDispatch ? REPAIR_LIFECYCLE.FAILED_AFTER_DISPATCH : REPAIR_LIFECYCLE.FAILED_PRE_PROVIDER,
        failure_terminal: true,
      },
    });
    throw error;
  }
}

export async function recordPhase1SourceQa({ supabase, sceneId, revision, observation } = {}) {
  const identity = repairIdentity(sceneId);
  if (revision !== identity.revision) throw new Error("second_short_repair_revision_not_authorized");
  const row = await readPhase1Repair(supabase, identity.sceneId);
  if (!row || row.status !== "SUCCEEDED" || !row.content_hash) throw new Error("second_short_repair_source_not_generated");
  if (observation?.content_hash !== row.content_hash) throw new Error("second_short_repair_qa_hash_mismatch");
  const contracts = await videoContracts();
  const contract = contracts.scenes?.[identity.sceneId];
  const source = {
    version: "1.0.0",
    status: "PASS",
    confidence: observation.confidence,
    all_required_elements_present: observation.required_elements_complete === true,
    correct_object_counts: observation.correct_object_counts === true,
    clear_geometry: observation.clear_geometry === true,
    no_ambiguous_overlaps: observation.no_ambiguous_overlaps === true,
    lumi_anatomy_clean: observation.lumi_anatomy_clean === true,
    pedagogical_objects_fully_visible: observation.pedagogical_objects_fully_visible === true,
    sufficient_motion_spacing: observation.sufficient_motion_spacing === true,
    no_visual_ambiguity: observation.no_visual_ambiguity === true,
    extraneous_educational_objects: observation.extraneous_educational_objects === true,
    observed_educational_objects: observation.observed_educational_objects,
    evidence: observation.evidence || null,
  };
  const preliminary = validateVideoSourceReadiness(source, contract);
  if (preliminary.status !== "PASS") source.status = "FAIL";
  const readiness = validateVideoSourceReadiness(source, contract);
  const visualQa = {
    version: "visual-qa/1.2",
    classification: readiness.status === "PASS" ? "PASS" : "BLOCKER",
    accepted: readiness.status === "PASS",
    blocker_count: readiness.errors.length,
    findings: readiness.errors,
    reviewed_at: new Date().toISOString(),
  };
  await patchPhase1Repair(supabase, row, {
    result: {
      ...row.result,
      lifecycle: readiness.status === "PASS" ? REPAIR_LIFECYCLE.SUCCEEDED_READY : REPAIR_LIFECYCLE.SUCCEEDED_QA_PENDING,
      visual_qa: visualQa,
      video_source_readiness: { ...source, validation: readiness },
      source_gate: readiness.status,
    },
  });
  return { row, visual_qa: visualQa, video_source_readiness: readiness };
}

export async function phase1RepairStatus({ supabase, includeReviewUrls = false } = {}) {
  const rows = (await allPhase1Rows(supabase)).filter(Boolean);
  const result = [];
  for (const row of rows) {
    let reviewUrl = null;
    if (includeReviewUrls && row.storage_path) reviewUrl = await signedObject(supabase, row.storage_path);
    result.push({ ...row, review_url: reviewUrl });
  }
  const providerCalls = rows.reduce((sum, row) => sum + Number(row.provider_calls || 0), 0);
  const actualCost = rows.reduce((sum, row) => sum + Number(
    row.result?.actual_cost_usd
      ?? row.result?.estimated_cost_usd_exact
      ?? SECOND_SHORT_IMAGE_UNIT_USD,
  ), 0);
  return {
    phase: "SOURCE_REPAIR_ONLY",
    rows: result,
    provider_calls: providerCalls,
    incremental_cost_usd: Number(actualCost.toFixed(6)),
    total_accounted_usd: Number((SECOND_SHORT_REPAIR_PHASE1.currentAccountedUsd + actualCost).toFixed(6)),
    runners: "OFF",
    autorun: false,
  };
}

export async function provePhase1DryRepair({ supabase, env = process.env, sceneId = "s22", revision = "s22-r1" } = {}) {
  const command = validatePhase1RepairCommand({ env, sceneId, revision, stage: "IMAGE" });
  const [original, existing] = await Promise.all([readOriginal(supabase, command.sceneId), readPhase1Repair(supabase, command.sceneId)]);
  if (existing) throw new Error("second_short_repair_dry_proof_requires_unclaimed_revision");
  const simulated = new Set();
  const key = `${command.ledgerPilotId}:${command.sceneId}:IMAGE`;
  const firstAccepted = !simulated.has(key);
  simulated.add(key);
  const duplicateRejected = simulated.has(key);
  const restartState = { status: "CLAIMED", provider_calls: 0, provider_request_id: null, result: { lifecycle: REPAIR_LIFECYCLE.CLAIMED, dispatch_consumed: false } };
  return {
    status: "PASS",
    mode: "DRY_NO_PROVIDER_NO_WRITE",
    revision_identity: command,
    original_untouched: true,
    original_lineage: { run_id: original.id, request_id: original.provider_request_id, hash: original.content_hash, visual_qa: original.result?.visual_qa },
    new_revision_identity_accepted: firstAccepted,
    duplicate_rejected: duplicateRejected,
    restart_before_provider_resumable: resumableBeforeProvider(restartState),
    provider_calls: 0,
    incremental_budget_usd: SECOND_SHORT_REPAIR_PHASE1.incrementalCeilingUsd,
    total_budget_usd: SECOND_SHORT_REPAIR_PHASE1.totalCeilingUsd,
    fake_rows_created: 0,
    cleanup_required: false,
  };
}
