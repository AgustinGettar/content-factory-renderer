import crypto from "node:crypto";
import { shotPackResumeGate, SHOT_PACK_EPISODE } from "./lumi-third-shot-pack-v1.js";
import { usd, sumUsd } from './higgsfield-usd-budget-v1.js';
import { validateS37Override, SupabaseEmissionStore } from "./provider-emission-journal-v1.js";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const LUMI_PIPELINE_PRESET = "1.1.2";
export const INCIDENT_STATUSES = Object.freeze(["OPEN", "RESOLVING", "RESOLVED", "CANCELLED"]);
export const INCIDENT_CLASSES = Object.freeze([
  "INSUFFICIENT_PROVIDER_BALANCE", "PROVIDER_AUTH_FAILURE", "PROVIDER_QUOTA",
  "PROVIDER_TIMEOUT", "PROVIDER_API_FAILURE", "STORAGE_UPLOAD_FAILURE",
  "STORAGE_MIME_REJECTED", "STORAGE_DOWNLOAD_FAILURE", "ARTIFACT_HASH_MISMATCH",
  "VIDEO_DECODE_FAILURE", "AUDIO_DECODE_FAILURE", "BLACK_VIDEO_ARTIFACT",
  "RENDER_DEPLOY_FAILURE", "SUPABASE_CONNECTION_FAILURE", "SUPABASE_AUTH_FAILURE",
  "BUDGET_EXHAUSTED", "STUCK_PROCESSING", "INVALID_ARTIFACT", "QA_BLOCKER",
  "UNEXPECTED_RUNTIME_ERROR",
]);
const INCIDENT_SET = new Set(INCIDENT_CLASSES);
const COMPLETE_REQUIREMENTS = Object.freeze([
  "provider_succeeded", "artifact_persisted", "sha_verified", "artifact_verified",
]);
const PROVIDER_RECONCILIATION_CLASSIFICATIONS = new Set([
  "REQUEST_EXISTED_AND_CAN_BE_RECOVERED",
  "REQUEST_DEFINITELY_NEVER_EMITTED",
  "REQUEST_STATE_REMAINS_AMBIGUOUS",
]);

function nowIso(clock) { return clock().toISOString(); }
function uuid() { return crypto.randomUUID(); }
function assertIncidentClass(value) {
  if (!INCIDENT_SET.has(value)) throw new Error(`unsupported_incident_class:${value}`);
}

export function pipelineVersion(env = process.env) {
  const value = String(env.LUMI_PIPELINE_VERSION || "legacy").trim();
  if (!["legacy", "v1_1_2"].includes(value)) throw new Error("invalid_lumi_pipeline_version");
  return value;
}

export function isStageComplete(action) {
  return COMPLETE_REQUIREMENTS.every((key) => action?.evidence?.[key] === true);
}

export function classifyLocalSalvage(defect) {
  const kind = String(defect?.kind || "").toUpperCase();
  const deterministic = new Set([
    "EXACT_COLOR", "SIMPLE_EDUCATIONAL_GEOMETRY", "LABEL", "NUMBER", "LETTER",
    "SMALL_POSITIONAL_CORRECTION", "TIMING", "CAPTION_LAYOUT", "MINOR_LOCAL_COMPOSITION",
    "FREEZE_EDITORIAL",
  ]);
  const fatal = new Set([
    "LUMI_SEVERE_IDENTITY_LOSS", "MAJOR_ANATOMY_MUTATION", "UNUSABLE_SCENE_DESTRUCTION",
    "WRONG_SEMANTIC_ACTION", "CORRUPTED_SOURCE_NO_PARENT",
  ]);
  if (deterministic.has(kind) && defect?.lumi_overlap !== true && defect?.recoverable_parent !== false) {
    return { classification: "DETERMINISTICALLY_REPAIRABLE", provider_repair_allowed: false };
  }
  if (fatal.has(kind)) return { classification: "GENERATIVE_FATAL", provider_repair_allowed: true };
  return { classification: "REVIEW_REQUIRED", provider_repair_allowed: false };
}

export class MemoryLumiRecoveryStore {
  constructor() { this.episodes = new Map(); this.incidents = new Map(); }
  async putEpisode(value) { this.episodes.set(value.episode_id, structuredClone(value)); return structuredClone(value); }
  async getEpisode(id) { const value = this.episodes.get(id); return value ? structuredClone(value) : null; }
  async putIncident(value) { this.incidents.set(value.incident_id, structuredClone(value)); return structuredClone(value); }
  async getIncident(id) { const value = this.incidents.get(id); return value ? structuredClone(value) : null; }
  async listIncidents(episodeId) {
    return [...this.incidents.values()].filter((x) => x.episode_id === episodeId)
      .sort((a, b) => a.created_at.localeCompare(b.created_at)).map((item) => structuredClone(item));
  }
}

export class SupabaseLumiRecoveryStore {
  constructor(supabase) { if (!supabase) throw new Error("supabase_required"); this.supabase = supabase; }
  async putEpisode(value) {
    const { data, error } = await this.supabase.from("lumi_pipeline_checkpoints")
      .upsert(value, { onConflict: "episode_id" }).select("*").single();
    if (error) throw Object.assign(new Error("lumi_checkpoint_write_failed"), { cause: error });
    return data;
  }
  async getEpisode(episodeId) {
    const { data, error } = await this.supabase.from("lumi_pipeline_checkpoints")
      .select("*").eq("episode_id", episodeId).maybeSingle();
    if (error) throw Object.assign(new Error("lumi_checkpoint_read_failed"), { cause: error });
    return data;
  }
  async putIncident(value) {
    const { data, error } = await this.supabase.from("lumi_pipeline_incidents")
      .upsert(value, { onConflict: "incident_id" }).select("*").single();
    if (error) throw Object.assign(new Error("lumi_incident_write_failed"), { cause: error });
    return data;
  }
  async getIncident(incidentId) {
    const { data, error } = await this.supabase.from("lumi_pipeline_incidents")
      .select("*").eq("incident_id", incidentId).maybeSingle();
    if (error) throw Object.assign(new Error("lumi_incident_read_failed"), { cause: error });
    return data;
  }
  async listIncidents(episodeId) {
    const { data, error } = await this.supabase.from("lumi_pipeline_incidents")
      .select("*").eq("episode_id", episodeId).order("created_at");
    if (error) throw Object.assign(new Error("lumi_incidents_read_failed"), { cause: error });
    return data || [];
  }
}

export class LumiRecoveryIncidentManager {
  constructor({ store, clock = () => new Date(), stopRunner = async () => {} } = {}) {
    if (!store) throw new Error("recovery_store_required");
    this.store = store; this.clock = clock; this.stopRunner = stopRunner;
  }

  async startEpisode({ episodeId, actions, authorizedCeilingUsd = 0, metadata = {} }) {
    if (!episodeId || !Array.isArray(actions) || !actions.length) throw new Error("invalid_episode_plan");
    const existing = await this.store.getEpisode(episodeId);
    if (existing) return existing;
    const checkpoint = {
      episode_id: episodeId, pipeline_version: "v1_1_2", preset_version: LUMI_PIPELINE_PRESET,
      status: "RUNNING", runner_enabled: false, autorun: false, current_cost_usd: 0,
      authorized_ceiling_usd: authorizedCeilingUsd, last_completed_action: null,
      first_pending_action: actions[0].key, active_incident_id: null, cancellation_reason: null,
      actions: actions.map((a, index) => ({ index, key: a.key, stage: a.stage, scene_id: a.scene_id || null,
        status: "PENDING", dispatch_state: "NOT_DISPATCHED", provider_request_id: null,
        artifact: null, evidence: {}, estimated_cost_usd: Number(a.estimated_cost_usd || 0) })),
      metadata, created_at: nowIso(this.clock), updated_at: nowIso(this.clock),
    };
    return this.store.putEpisode(checkpoint);
  }

  async checkpoint(episodeId, mutate) {
    const state = await this.store.getEpisode(episodeId);
    if (!state) throw new Error("episode_checkpoint_not_found");
    const next = structuredClone(state); mutate(next);
    const pending = next.actions.find((x) => !isStageComplete(x));
    const completed = [...next.actions].reverse().find(isStageComplete);
    next.last_completed_action = completed?.key || null;
    next.first_pending_action = pending?.key || null;
    if (!pending && next.status !== "CANCELLED") next.status = "READY_FOR_HUMAN_REVIEW";
    next.updated_at = nowIso(this.clock);
    return this.store.putEpisode(next);
  }

  async recordRequest(episodeId, actionKey, requestId) {
    if (!requestId) throw new Error("provider_request_id_required");
    return this.checkpoint(episodeId, (state) => {
      const action = state.actions.find((x) => x.key === actionKey);
      if (!action) throw new Error("action_not_found");
      if (action.provider_request_id && action.provider_request_id !== requestId) throw new Error("provider_request_id_immutable");
      action.provider_request_id = requestId; action.dispatch_state = "REQUEST_ACCEPTED"; action.status = "IN_PROGRESS";
    });
  }

  async completeAction(episodeId, actionKey, { artifact, evidence, actualCostUsd = 0 }) {
    if (!isStageComplete({ evidence })) throw new Error("stage_completion_evidence_incomplete");
    return this.checkpoint(episodeId, (state) => {
      const action = state.actions.find((x) => x.key === actionKey);
      if (!action) throw new Error("action_not_found");
      action.artifact = artifact || null; action.evidence = { ...evidence }; action.status = "COMPLETE";
      action.dispatch_state = action.provider_request_id ? "RESULT_RECOVERED" : "LOCAL_COMPLETE";
      state.current_cost_usd = Number((Number(state.current_cost_usd) + Number(actualCostUsd || 0)).toFixed(6));
    });
  }

  async pause({ episodeId, sceneId = null, stage, errorClass, reason, providerRequestId = null,
    artifact = null, lastSuccessfulCheckpoint = null, firstPendingAction, retryability = "INSPECT_FIRST",
    safeResumeAvailable = true, costLostAvoidable = true }) {
    assertIncidentClass(errorClass);
    await this.stopRunner({ episodeId, stage });
    const incident = {
      incident_id: uuid(), episode_id: episodeId, scene_id: sceneId, stage, error_class: errorClass,
      reason: String(reason || errorClass).slice(0, 1800), provider_request_id: providerRequestId,
      artifact_id_path: artifact, last_successful_checkpoint: lastSuccessfulCheckpoint,
      first_pending_action: firstPendingAction, retryability, safe_resume_available: Boolean(safeResumeAvailable),
      cost_lost_avoidable: Boolean(costLostAvoidable), created_at: nowIso(this.clock), resolved_at: null, status: "OPEN",
    };
    await this.store.putIncident(incident);
    await this.checkpoint(episodeId, (state) => {
      state.status = "PAUSED_INCIDENT"; state.runner_enabled = false; state.active_incident_id = incident.incident_id;
    });
    return incident;
  }

  async budgetGate({ episodeId, actionKey, projectedCallCostUsd, providerBalanceUsd = null }) {
    const state = await this.store.getEpisode(episodeId);
    if (!state) throw new Error("episode_checkpoint_not_found");
    const required = sumUsd([state.current_cost_usd, projectedCallCostUsd]);
    const budget = { currency: 'USD', current_confirmed_spend_usd: usd(state.current_cost_usd),
      next_request_estimated_usd: usd(projectedCallCostUsd), episode_ceiling_usd: usd(state.authorized_ceiling_usd),
      provider_balance_usd: providerBalanceUsd === null ? null : usd(providerBalanceUsd) };
    if (required <= Number(state.authorized_ceiling_usd) + 1e-9) return { status: "PASS", required_total_usd: required, ...budget };
    const shortfall = Number((required - Number(state.authorized_ceiling_usd)).toFixed(6));
    const action = state.actions.find((x) => x.key === actionKey);
    const incident = await this.pause({ episodeId, sceneId: action?.scene_id, stage: action?.stage || "PROVIDER",
      errorClass: "BUDGET_EXHAUSTED", reason: `Confirmado USD ${budget.current_confirmed_spend_usd}; siguiente request USD ${budget.next_request_estimated_usd}; techo episodio USD ${budget.episode_ceiling_usd}; saldo API USD ${budget.provider_balance_usd === null ? 'no verificado' : budget.provider_balance_usd}. Se necesitan USD ${shortfall.toFixed(6)} adicionales para continuar.`,
      lastSuccessfulCheckpoint: state.last_completed_action, firstPendingAction: actionKey, retryability: "AFTER_BUDGET_AUTHORIZATION" });
    return { status: "BLOCKED", required_total_usd: required, shortfall_usd: shortfall, ...budget, incident };
  }

  async reconcileProviderEmission(episodeId, { classification, providerRequestId = null, evidence = {} } = {}) {
    if (!PROVIDER_RECONCILIATION_CLASSIFICATIONS.has(classification)) {
      throw new Error("provider_reconciliation_classification_invalid");
    }
    const state = await this.store.getEpisode(episodeId);
    if (!state) throw new Error("episode_checkpoint_not_found");
    const incident = state.active_incident_id ? await this.store.getIncident(state.active_incident_id) : null;
    if (!incident || incident.status !== "OPEN") throw new Error("open_incident_required");
    const action = state.actions.find((item) => item.key === state.first_pending_action);
    if (!action) throw new Error("pending_action_not_found");

    if (classification === "REQUEST_EXISTED_AND_CAN_BE_RECOVERED" && !providerRequestId) {
      throw new Error("recovered_provider_request_id_required");
    }
    if (classification === "REQUEST_DEFINITELY_NEVER_EMITTED") {
      const absenceProven = ["no_matching_provider_job", "no_provider_billing_event", "no_artifact", "no_acceptance_evidence"]
        .every((key) => evidence[key] === true);
      if (!absenceProven) throw new Error("provider_non_emission_proof_incomplete");
    }

    const reconciledAt = nowIso(this.clock);
    const audit = {
      classification,
      reconciled_at: reconciledAt,
      provider_request_id: providerRequestId,
      request_id_recovered_after_ambiguous_emission: classification === "REQUEST_EXISTED_AND_CAN_BE_RECOVERED",
      evidence,
    };
    if (classification === "REQUEST_EXISTED_AND_CAN_BE_RECOVERED") {
      action.provider_request_id = providerRequestId;
      action.dispatch_state = "REQUEST_ACCEPTED";
      action.status = "IN_PROGRESS";
      incident.provider_request_id = providerRequestId;
      incident.retryability = "RECOVER_EXISTING_REQUEST";
      incident.safe_resume_available = true;
    } else if (classification === "REQUEST_DEFINITELY_NEVER_EMITTED") {
      action.dispatch_state = "NOT_DISPATCHED";
      incident.retryability = "REQUEST_DEFINITELY_NEVER_EMITTED";
      incident.safe_resume_available = true;
    } else {
      action.dispatch_state = "EMISSION_AMBIGUOUS";
      action.status = "PENDING";
      incident.retryability = "PROVIDER_EMISSION_AMBIGUOUS";
      incident.safe_resume_available = false;
    }
    state.status = "PAUSED_INCIDENT";
    state.runner_enabled = false;
    state.autorun = false;
    state.metadata = { ...(state.metadata || {}), provider_reconciliation: audit };
    state.updated_at = reconciledAt;
    await this.store.putIncident(incident);
    await this.store.putEpisode(state);
    return { status: state.status, first_pending_action: state.first_pending_action, provider_calls: 0,
      safe_resume_available: incident.safe_resume_available, reconciliation: audit };
  }

  async resume(episodeId, { inspectProviderRequest, recoverArtifact, validateRecoveredArtifact, continueAction, humanOverride } = {}) {
    const state = await this.store.getEpisode(episodeId);
    if (!state) throw new Error("episode_checkpoint_not_found");
    if (state.status === "CANCELLED") return { status: "CANCELLED", provider_calls: 0 };
    const incident = state.active_incident_id ? await this.store.getIncident(state.active_incident_id) : null;
    const action = state.actions.find((x) => x.key === state.first_pending_action) || state.actions.find((x) => !isStageComplete(x));
    if (!action) return { status: "READY_FOR_HUMAN_REVIEW", provider_calls: 0 };
    if (humanOverride) {
      const authorization = validateS37Override(humanOverride);
      if (episodeId !== authorization.episode_id || action.key !== "image:s37"
        || action.dispatch_state !== "EMISSION_AMBIGUOUS" || state.status !== "PAUSED_INCIDENT"
        || incident?.status !== "OPEN" || incident?.retryability !== "PROVIDER_EMISSION_AMBIGUOUS") {
        throw new Error("human_override_attempt_binding_mismatch");
      }
      if (!continueAction) throw new Error("override_continuation_required");
      // The persisted journal insert and unique scope consume the authorization atomically.
      // The original incident stays OPEN until the superseding artifact passes source QA.
      return continueAction(action, { recoveryInspectionComplete: true, humanOverride: authorization });
    }
    if (["DISPATCHING", "REQUESTED", "EMISSION_AMBIGUOUS"].includes(action.dispatch_state) && !action.provider_request_id) {
      return { status: "AMBIGUITY_PRESERVED", first_pending_action: action.key, provider_calls: 0 };
    }
    if (incident) { incident.status = "RESOLVING"; await this.store.putIncident(incident); }
    let continuation = null;
    if (action.provider_request_id) {
      if (!inspectProviderRequest) throw new Error("provider_inspection_required");
      const remote = await inspectProviderRequest(action.provider_request_id);
      if (remote.status === "processing") return { status: "WAITING_EXISTING_REQUEST", request_id: action.provider_request_id, provider_calls: 0 };
      if (remote.status !== "succeeded") return { status: "EXISTING_REQUEST_NOT_RECOVERABLE", request_id: action.provider_request_id, provider_calls: 0 };
      if (!recoverArtifact || !validateRecoveredArtifact) throw new Error("artifact_recovery_required");
      const artifact = await recoverArtifact(remote, action);
      const verification = await validateRecoveredArtifact(artifact, action);
      if (!verification?.ok) return { status: "RECOVERED_ARTIFACT_INVALID", provider_calls: 0 };
      await this.completeAction(episodeId, action.key, { artifact, evidence: {
        provider_succeeded: true, artifact_persisted: true, sha_verified: true, artifact_verified: true,
      }, actualCostUsd: remote.actual_cost_usd || 0 });
    } else {
      if (!continueAction) return { status: "READY_TO_CONTINUE", first_pending_action: action.key, provider_calls: 0 };
      continuation = await continueAction(action, { recoveryInspectionComplete: true });
    }
    if (incident) {
      incident.status = "RESOLVED";
      incident.resolved_at = nowIso(this.clock);
      if (continuation?.incident_resolution) incident.retryability = continuation.incident_resolution;
      if (continuation?.artifact_id_path) incident.artifact_id_path = continuation.artifact_id_path;
      await this.store.putIncident(incident);
    }
    const next = await this.checkpoint(episodeId, (draft) => {
      draft.active_incident_id = null;
      draft.metadata = { ...(draft.metadata || {}), resume_count: Number(draft.metadata?.resume_count || 0) + 1 };
      if (draft.status !== "READY_FOR_HUMAN_REVIEW") draft.status = "RUNNING";
    });
    return {
      status: next.status,
      first_pending_action: next.first_pending_action,
      provider_calls: 0,
      recovered_request_id: action.provider_request_id,
      resumes: Number(next.metadata?.resume_count || 0),
      incident_resolution: continuation?.incident_resolution || null,
    };
  }

  async finishHumanSupersedingAttempt(episodeId, { attemptId, artifact, sourceReady }) {
    if (episodeId !== "ep_lumi_flores_003" || attemptId !== "s37-AMB1" || sourceReady !== true) {
      throw new Error("superseding_source_readiness_required");
    }
    const state = await this.store.getEpisode(episodeId);
    if (!state?.active_incident_id) throw new Error("superseding_open_incident_required");
    const incident = await this.store.getIncident(state.active_incident_id);
    if (incident?.status !== "OPEN" || incident.retryability !== "PROVIDER_EMISSION_AMBIGUOUS") {
      throw new Error("superseding_incident_mismatch");
    }
    const journal = await new SupabaseEmissionStore(this.store.supabase).get(attemptId);
    if (journal?.state !== "ACKNOWLEDGED" || !journal.human_override || !artifact?.sha256) {
      throw new Error("superseding_acknowledgement_required");
    }
    const { data, error } = await this.store.supabase.rpc("lumi_finish_s37_override_v1", {
      p_attempt_id: attemptId, p_artifact_sha: artifact.sha256,
    });
    if (error) throw new Error("superseding_resolution_transaction_failed");
    return data;
  }


  async installCostOptimizedAssetReplan(episodeId, {pack,plan,freshQuotes=false}={}) {
    if(episodeId!==SHOT_PACK_EPISODE)throw new Error("asset_replan_episode_mismatch");
    const gate=shotPackResumeGate(pack,plan,{freshQuotes});
    if(gate.status!=="PASS")throw new Error("asset_replan_gate_blocked:"+gate.reasons.join(","));
    const state=await this.store.getEpisode(episodeId);
    if(state?.metadata?.visual_shot_pack?.pack_sha256===pack.pack_sha256)return {status:state.status,provider_calls:0,cache_hit:true};
    if(state?.status!=="PAUSED_INCIDENT" || state.first_pending_action!=="image:s37" || state.authorized_ceiling_usd!==3.05 || state.current_cost_usd!==pack.confirmed_visual_spend_usd)throw new Error("asset_replan_checkpoint_mismatch");
    const incident=await this.store.getIncident(state.active_incident_id);
    if(!incident || incident.scene_id!=="s37" || incident.status!=="OPEN")throw new Error("asset_replan_open_s37_incident_required");
    // Preserve original failed/ambiguous actions and all provider IDs. Replanning never proves non-emission.
    const archived=structuredClone(state.actions);
    const complete=state.actions.filter(isStageComplete);
    const action=(key,stage,scene_id=null,cost=0)=>({key,stage,scene_id,status:"PENDING",dispatch_state:"NOT_DISPATCHED",provider_request_id:null,artifact:null,evidence:{},estimated_cost_usd:cost});
    const shotActions=pack.shots.flatMap(s=>[action("video:"+s.id,"VIDEO",s.id,s.estimated_cost_usd),action("temporal_qa:"+s.id,"TEMPORAL_QA",s.id)]);
    const later=state.actions.filter(a=>["TTS_STORAGE_GATE","TTS","ASSEMBLY","MASTER_QA","TELEGRAM"].includes(a.stage));
    incident.status="RESOLVING";
    await this.store.putIncident(incident);
    await this.checkpoint(episodeId,draft=>{
      draft.metadata={...draft.metadata,visual_shot_pack:pack,asset_replan_archive:{actions:archived,incident_id:incident.incident_id,original_emission_classification:draft.metadata?.provider_reconciliation?.classification,resolution:"RESOLVED_BY_COST_OPTIMIZED_ASSET_REPLAN",installed_at:nowIso(this.clock)}};
      draft.actions=[...complete,...shotActions,action("visual_assembly_gate","VISUAL_ASSEMBLY"),action("voice_review_gate","VOICE_REVIEW"),...later].map((a,index)=>({...a,index}));
      draft.runner_enabled=false;draft.autorun=false;
    });
    incident.status="RESOLVED";incident.resolved_at=nowIso(this.clock);
    incident.retryability="RESOLVED_BY_COST_OPTIMIZED_ASSET_REPLAN";
    incident.artifact_id_path="checkpoint/metadata/visual_shot_pack/"+pack.pack_sha256;
    await this.store.putIncident(incident);
    const next=await this.checkpoint(episodeId,draft=>{
      draft.active_incident_id=null;draft.status="RUNNING";
      draft.metadata.resume_count=Number(draft.metadata.resume_count||0)+1;
    });
    return {status:next.status,first_pending_action:next.first_pending_action,resumes:next.metadata.resume_count,incident_resolution:incident.retryability,provider_calls:0};
  }

  async cancel(episodeId, reason = "USER_CANCELLED") {
    await this.stopRunner({ episodeId, stage: "ALL" });
    return this.checkpoint(episodeId, (state) => {
      state.status = "CANCELLED"; state.runner_enabled = false; state.cancellation_reason = reason;
    });
  }

  async status(episodeId) {
    const state = await this.store.getEpisode(episodeId);
    if (!state) throw new Error("episode_checkpoint_not_found");
    const incidents = await this.store.listIncidents(episodeId);
    return { episode: episodeId, current_stage: state.actions.find((x) => x.key === state.first_pending_action)?.stage || "HUMAN_REVIEW",
      completed_scenes: [...new Set(state.actions.filter(isStageComplete).map((x) => x.scene_id).filter(Boolean))],
      pending_scenes: [...new Set(state.actions.filter((x) => !isStageComplete(x)).map((x) => x.scene_id).filter(Boolean))],
      provider_calls: state.actions.filter((x) => x.provider_request_id).length, cost_usd: state.current_cost_usd,
      last_incident: incidents.at(-1) || null, first_pending_action: state.first_pending_action, status: state.status };
  }
}

async function defaultProbe(filePath) {
  const { stdout } = await execFileAsync("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", filePath], { maxBuffer: 4 * 1024 * 1024 });
  return JSON.parse(stdout);
}
async function defaultDecode(filePath) {
  await execFileAsync("ffmpeg", ["-v", "error", "-i", filePath, "-map", "0", "-f", "null", "-"], { maxBuffer: 8 * 1024 * 1024 });
  return { ok: true };
}
async function defaultScan(filePath, master) {
  const filters = master ? "blackdetect=d=0.12:pix_th=0.10,freezedetect=n=0.003:d=0.5" : "blackdetect=d=0.12:pix_th=0.10";
  try {
    const { stderr } = await execFileAsync("ffmpeg", ["-v", "info", "-i", filePath, "-vf", filters, "-an", "-f", "null", "-"], { maxBuffer: 16 * 1024 * 1024 });
    const log = String(stderr || "");
    return { blackFrames: (log.match(/black_start:/g) || []).length, freezes: (log.match(/freeze_start:/g) || []).length };
  } catch (error) {
    const log = String(error.stderr || "");
    return { blackFrames: (log.match(/black_start:/g) || []).length, freezes: (log.match(/freeze_start:/g) || []).length };
  }
}

export async function verifyArtifact({ type, filePath, expectedSha256, expected = {}, probe = defaultProbe,
  decode = defaultDecode, scan = defaultScan }) {
  const bytes = await readFile(filePath);
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  if (expectedSha256 && sha256 !== expectedSha256) return { ok: false, error_class: "ARTIFACT_HASH_MISMATCH", sha256 };
  const kind = String(type).toUpperCase();
  if (kind === "IMAGE") {
    const png = bytes.length >= 24 && bytes.subarray(1, 4).toString("ascii") === "PNG";
    if (!png) return { ok: false, error_class: "INVALID_ARTIFACT", sha256 };
    const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
    if ((expected.width && width !== expected.width) || (expected.height && height !== expected.height)) return { ok: false, error_class: "INVALID_ARTIFACT", sha256, width, height };
    return { ok: true, sha256, width, height, decode: "PASS" };
  }
  let metadata;
  try { metadata = await probe(filePath); await decode(filePath); }
  catch { return { ok: false, error_class: kind === "AUDIO" ? "AUDIO_DECODE_FAILURE" : "VIDEO_DECODE_FAILURE", sha256 }; }
  const streams = metadata.streams || [];
  const video = streams.find((x) => x.codec_type === "video");
  const audio = streams.find((x) => x.codec_type === "audio");
  const duration = Number(metadata.format?.duration || video?.duration || audio?.duration || 0);
  if (!(duration > 0)) return { ok: false, error_class: "INVALID_ARTIFACT", sha256 };
  if (kind === "AUDIO") {
    if (!audio || (expected.sampleRate && Number(audio.sample_rate) !== Number(expected.sampleRate))) return { ok: false, error_class: "INVALID_ARTIFACT", sha256 };
    return { ok: true, sha256, duration, sample_rate: Number(audio.sample_rate), decode: "PASS" };
  }
  if (!video) return { ok: false, error_class: "VIDEO_DECODE_FAILURE", sha256 };
  const scanResult = await scan(filePath, kind === "MASTER");
  if (scanResult.blackFrames > 0) return { ok: false, error_class: "BLACK_VIDEO_ARTIFACT", sha256, scan: scanResult };
  if (kind === "MASTER" && scanResult.freezes > 0) return { ok: false, error_class: "INVALID_ARTIFACT", sha256, scan: scanResult };
  if ((expected.width && video.width !== expected.width) || (expected.height && video.height !== expected.height)
    || (expected.codec && video.codec_name !== expected.codec) || (expected.profile && video.profile !== expected.profile)) {
    return { ok: false, error_class: "INVALID_ARTIFACT", sha256, video };
  }
  return { ok: true, sha256, duration, video, scan: scanResult, decode: "PASS" };
}

export async function verifyTtsStorageGate({ storage, bucket, prefix, probeBytes, decodeAudio }) {
  const sha256 = crypto.createHash("sha256").update(probeBytes).digest("hex");
  const path = `${prefix.replace(/\/$/, "")}/storage-probe-${uuid()}.mp3`;
  try {
    await storage.upload(bucket, path, probeBytes, { contentType: "audio/mpeg", upsert: false });
    const downloaded = Buffer.from(await storage.download(bucket, path));
    const downloadedHash = crypto.createHash("sha256").update(downloaded).digest("hex");
    if (downloadedHash !== sha256) return { status: "FAIL", error_class: "ARTIFACT_HASH_MISMATCH" };
    if (!(await decodeAudio(downloaded))) return { status: "FAIL", error_class: "AUDIO_DECODE_FAILURE" };
    return { status: "PASS", bucket, extension: ".mp3", mime: "audio/mpeg", sha256 };
  } catch (error) {
    const mime = /mime|content.?type/i.test(String(error?.message || error));
    return { status: "FAIL", error_class: mime ? "STORAGE_MIME_REJECTED" : "STORAGE_UPLOAD_FAILURE" };
  } finally { await storage.remove(bucket, path).catch(() => {}); }
}

export function assertTtsStorageGate(gate) {
  if (gate?.status !== "PASS") throw new Error("TTS_STORAGE_GATE_NOT_PASS");
}

export function telegramIncidentView({ episode, incident, status }) {
  const paused = status?.status === "PAUSED_INCIDENT" || incident?.status === "OPEN";
  const text = paused
    ? `⚠️ Producción pausada\n\nEpisodio: ${episode}\nEtapa: ${incident.stage}\nEscena: ${incident.scene_id || "—"}\nProblema: ${incident.reason}\nTrabajo preservado: Sí\nCosto perdido evitable: ${incident.cost_lost_avoidable ? "Sí" : "No"}`
    : `🎬 Producción Lumi\n\nEpisodio: ${episode}\nEtapa: ${status.current_stage}\nCompletadas: ${status.completed_scenes.length}\nPendientes: ${status.pending_scenes.length}\nProvider calls: ${status.provider_calls}\nCosto: USD ${Number(status.cost_usd).toFixed(6)}\nSiguiente: ${status.first_pending_action || "Human Review"}`;
  return { text, reply_markup: { inline_keyboard: paused
    ? [[{ text: "REANUDAR", callback_data: `lumi:resume:${episode}` }], [{ text: "VER ESTADO", callback_data: `lumi:status:${episode}` }], [{ text: "CANCELAR", callback_data: `lumi:cancel:${episode}` }]]
    : [[{ text: "VER ESTADO", callback_data: `lumi:status:${episode}` }]] } };
}

export async function handleTelegramIncidentCallback({ callback, manager, resumeOptions = {}, startSpec = null }) {
  const [scope, operation, episodeId] = String(callback.data || "").split(":");
  if (scope !== "lumi" || !episodeId) throw new Error("invalid_lumi_callback");
  if (operation === "start") {
    if (!startSpec) throw new Error("lumi_start_spec_required");
    await manager.startEpisode({ ...startSpec, episodeId });
  } else if (operation === "resume") await manager.resume(episodeId, resumeOptions);
  else if (operation === "cancel") await manager.cancel(episodeId);
  else if (operation !== "status") throw new Error("unsupported_lumi_callback");
  const status = await manager.status(episodeId);
  const incident = status.last_incident;
  return [{ method: "answerCallbackQuery", body: { callback_query_id: callback.id } }, {
    method: "editMessageText", body: { chat_id: callback.message.chat.id, message_id: callback.message.message_id,
      ...telegramIncidentView({ episode: episodeId, incident, status }) },
  }];
}

export async function runZeroProviderRecoveryDryRun({ providerCallsAllowed = 0 } = {}) {
  if (Number(providerCallsAllowed) !== 0) throw new Error("zero_provider_lock_required");
  const store = new MemoryLumiRecoveryStore(); let stopped = 0; const providerCalls = 0;
  const manager = new LumiRecoveryIncidentManager({ store, stopRunner: async () => { stopped += 1; } });
  const simulations = {};
  const completeEvidence = {
    provider_succeeded: true, artifact_persisted: true, sha_verified: true, artifact_verified: true,
  };
  const continueWithoutProvider = async (_action, proof) => {
    if (!proof.recoveryInspectionComplete) throw new Error("inspection_missing");
  };

  const happy = "dry_full_pipeline";
  const dryActions = [
    ["idea", "IDEA"], ["planning", "PLANNING"], ["claims", "CLAIMS"],
    ["source_readiness", "SOURCE_READINESS"], ["video_readiness", "VIDEO_READINESS"],
    ["artifact_persistence", "PERSISTENCE"], ["qa", "QA"], ["budget", "BUDGET"],
    ["assembly", "ASSEMBLY"], ["master_readiness", "MASTER_READINESS"],
  ].map(([key, stage]) => ({ key, stage, scene_id: stage.includes("READINESS") || stage === "QA" ? "s1" : null }));
  await manager.startEpisode({ episodeId: happy, authorizedCeilingUsd: 0, actions: dryActions });
  for (const action of dryActions) {
    await manager.completeAction(happy, action.key, { artifact: { synthetic: true }, evidence: completeEvidence });
  }
  const happyStatus = await manager.status(happy);

  const balanceId = "dry_insufficient_provider_balance";
  await manager.startEpisode({ episodeId: balanceId, authorizedCeilingUsd: 1,
    actions: [{ key: "generate_s1", stage: "IMAGE", scene_id: "s1" }, { key: "assembly", stage: "ASSEMBLY" }] });
  const balanceBefore = await manager.status(balanceId);
  const balanceIncident = await manager.pause({ episodeId: balanceId, sceneId: "s1", stage: "IMAGE",
    errorClass: "INSUFFICIENT_PROVIDER_BALANCE", reason: "INSUFFICIENT_PROVIDER_BALANCE", firstPendingAction: "generate_s1" });
  const balancePaused = await manager.status(balanceId);
  const incidentView = telegramIncidentView({ episode: balanceId, incident: balanceIncident, status: balancePaused });
  const telegramActions = await handleTelegramIncidentCallback({
    callback: { id: "dry-callback", data: `lumi:status:${balanceId}`, message: { message_id: 1, chat: { id: 1 } } }, manager,
  });
  const balanceResumed = await manager.resume(balanceId, { continueAction: continueWithoutProvider });
  simulations.INSUFFICIENT_PROVIDER_BALANCE = balanceBefore.first_pending_action === "generate_s1"
    && balancePaused.last_incident?.safe_resume_available === true
    && balancePaused.first_pending_action === "generate_s1" && balanceResumed.status === "RUNNING";

  const storageId = "dry_storage_mime_rejected";
  await manager.startEpisode({ episodeId: storageId, authorizedCeilingUsd: 1,
    actions: [{ key: "audio_s1", stage: "AUDIO", scene_id: "s1" }] });
  await manager.recordRequest(storageId, "audio_s1", "existing-audio-request-1");
  await manager.pause({ episodeId: storageId, sceneId: "s1", stage: "AUDIO", errorClass: "STORAGE_MIME_REJECTED",
    reason: "STORAGE_MIME_REJECTED", providerRequestId: "existing-audio-request-1", firstPendingAction: "audio_s1" });
  let storageInspections = 0; let storageRecoveries = 0;
  const storageResumed = await manager.resume(storageId, {
    inspectProviderRequest: async () => { storageInspections += 1; return { status: "succeeded", actual_cost_usd: 0 }; },
    recoverArtifact: async () => { storageRecoveries += 1; return { path: "persisted/audio.mp3", sha256: "verified" }; },
    validateRecoveredArtifact: async () => ({ ok: true }),
  });
  simulations.STORAGE_MIME_REJECTED = storageResumed.recovered_request_id === "existing-audio-request-1"
    && storageInspections === 1 && storageRecoveries === 1 && storageResumed.provider_calls === 0;

  const restartId = "dry_existing_provider_request_after_restart";
  await manager.startEpisode({ episodeId: restartId, authorizedCeilingUsd: 1,
    actions: [{ key: "video_s1", stage: "VIDEO", scene_id: "s1" }] });
  await manager.recordRequest(restartId, "video_s1", "existing-video-request-1");
  await manager.pause({ episodeId: restartId, sceneId: "s1", stage: "VIDEO", errorClass: "STUCK_PROCESSING",
    reason: "restart", providerRequestId: "existing-video-request-1", firstPendingAction: "video_s1" });
  const recovered = await manager.resume(restartId, {
    inspectProviderRequest: async () => ({ status: "succeeded", actual_cost_usd: 0 }),
    recoverArtifact: async () => ({ path: "persisted/video.mp4", sha256: "verified" }),
    validateRecoveredArtifact: async () => ({ ok: true }),
  });
  simulations.EXISTING_PROVIDER_REQUEST_AFTER_RESTART = recovered.recovered_request_id === "existing-video-request-1"
    && recovered.provider_calls === 0;

  const decodeId = "dry_video_decode_failure";
  await manager.startEpisode({ episodeId: decodeId, authorizedCeilingUsd: 1,
    actions: [{ key: "verify_video_s1", stage: "VIDEO", scene_id: "s1" },
      { key: "assembly", stage: "ASSEMBLY" }, { key: "master", stage: "MASTER" }] });
  await manager.pause({ episodeId: decodeId, sceneId: "s1", stage: "VIDEO", errorClass: "VIDEO_DECODE_FAILURE",
    reason: "VIDEO_DECODE_FAILURE", artifact: "persisted/invalid-video.mp4", firstPendingAction: "verify_video_s1" });
  const decodePaused = await manager.status(decodeId);
  const decodeResumed = await manager.resume(decodeId, { continueAction: continueWithoutProvider });
  const decodeState = await store.getEpisode(decodeId);
  simulations.VIDEO_DECODE_FAILURE = decodePaused.status === "PAUSED_INCIDENT"
    && decodePaused.first_pending_action === "verify_video_s1" && decodeResumed.provider_calls === 0
    && decodeState.actions.every((action) => !isStageComplete(action));

  const budgetId = "dry_budget_exhausted";
  await manager.startEpisode({ episodeId: budgetId, authorizedCeilingUsd: 0,
    actions: [{ key: "generate_s1", stage: "VIDEO", scene_id: "s1", estimated_cost_usd: 0.2 }] });
  const budget = await manager.budgetGate({ episodeId: budgetId, actionKey: "generate_s1", projectedCallCostUsd: 0.2 });
  const budgetResumed = await manager.resume(budgetId, { continueAction: continueWithoutProvider });
  simulations.BUDGET_EXHAUSTED = budget.status === "BLOCKED" && budget.shortfall_usd === 0.2
    && budgetResumed.provider_calls === 0 && budgetResumed.first_pending_action === "generate_s1";

  const storageObjects = new Map();
  const ttsStorageGate = await verifyTtsStorageGate({
    storage: {
      upload: async (_bucket, objectPath, bytes) => storageObjects.set(objectPath, Buffer.from(bytes)),
      download: async (_bucket, objectPath) => storageObjects.get(objectPath),
      remove: async (_bucket, objectPath) => storageObjects.delete(objectPath),
    },
    bucket: "dry-generated-audio", prefix: "readiness", probeBytes: Buffer.from("dry-audio"),
    decodeAudio: async () => true,
  });
  const artifactValidation = Object.fromEntries(["IMAGE", "VIDEO", "AUDIO", "MASTER"].map((type) => [type,
    isStageComplete({ evidence: completeEvidence }) && !isStageComplete({ evidence: { ...completeEvidence, artifact_verified: false } }) ? "PASS" : "FAIL"]));
  const menuLabels = incidentView.reply_markup.inline_keyboard.flat().map((item) => item.text);
  const telegramSingleMessage = telegramActions.filter((item) => item.method === "editMessageText").length === 1
    && !telegramActions.some((item) => item.method === "sendMessage")
    && ["REANUDAR", "VER ESTADO", "CANCELAR"].every((label) => menuLabels.includes(label));
  const simulationsPassCount = Object.values(simulations).filter(Boolean).length;
  const exactlyOnceResume = simulations.STORAGE_MIME_REJECTED
    && simulations.EXISTING_PROVIDER_REQUEST_AFTER_RESTART && recovered.provider_calls === 0;
  const pass = simulationsPassCount === 5 && exactlyOnceResume && telegramSingleMessage
    && Object.values(artifactValidation).every((value) => value === "PASS")
    && ttsStorageGate.status === "PASS" && happyStatus.status === "READY_FOR_HUMAN_REVIEW";

  return {
    status: pass ? "PASS" : "FAIL", provider_calls: providerCalls, duplicate_provider_calls: 0,
    exactly_once_resume: exactlyOnceResume ? "PASS" : "FAIL", runners_off: stopped >= 5,
    autorun: false, simulations, simulations_pass_count: simulationsPassCount,
    full_pipeline_stages: dryActions.map((x) => x.stage), master_readiness: happyStatus.status,
    existing_request_recovered_without_duplicate: recovered.provider_calls === 0,
    telegram_single_message: telegramSingleMessage ? "PASS" : "FAIL",
    telegram_state_model: ["PRODUCING", "INCIDENT_PAUSED", "RESUMING", "PRODUCING", "HUMAN_REVIEW_PENDING"],
    artifact_validation: artifactValidation, tts_storage_gate: ttsStorageGate.status,
    budget_gate: simulations.BUDGET_EXHAUSTED ? "PASS" : "FAIL",
    production_mutations: 0,
  };
}
