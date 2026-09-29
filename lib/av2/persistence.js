import crypto from "node:crypto";

export class Av2PersistenceError extends Error {
  constructor(message, { code = "av2_persistence_failed", cause, diagnostic } = {}) {
    super(message, { cause });
    this.name = "Av2PersistenceError";
    this.code = code;
    this.diagnostic = diagnostic || null;
  }
}

function persistenceError(action, error) {
  const upstreamCode = String(error?.code || "unknown").replace(/[^a-z0-9_-]/gi, "_").slice(0, 80);
  const upstreamStatus = Number(error?.status);
  const message = String(error?.message || "");
  const category = /invalid[^\n]{0,20}(api|key|jwt)|unauthorized|jwt/i.test(message)
    ? "authentication"
    : (/fetch failed|network|econn|enotfound|timeout/i.test(message)
      ? "network"
      : (/invalid header|header value/i.test(message)
        ? "invalid_header"
        : (/permission|denied|42501/i.test(message) ? "permission" : "unknown")));
  return new Av2PersistenceError(`AV2 persistence ${action} failed`, {
    cause: error,
    diagnostic: {
      action,
      upstream_code: upstreamCode,
      upstream_status: Number.isInteger(upstreamStatus) ? upstreamStatus : null,
      category,
    },
  });
}

export class SupabaseCreativeArtifactStore {
  constructor(client) {
    if (!client) throw new Error("a Supabase service-role client is required");
    this.client = client;
  }

  async findByRequest(artifactType, requestHash) {
    const { data, error } = await this.client.from("av2_creative_artifacts")
      .select("*").eq("artifact_type", artifactType).eq("request_hash", requestHash).maybeSingle();
    if (error) throw persistenceError("read", error);
    return data;
  }

  async findByIdempotency(artifactType, idempotencyKey) {
    const { data, error } = await this.client.from("av2_creative_artifacts")
      .select("*").eq("artifact_type", artifactType).eq("idempotency_key", idempotencyKey).maybeSingle();
    if (error) throw persistenceError("idempotency read", error);
    return data;
  }

  async rebindFailedRequest(id, previousHash, requestHash, patch = {}) {
    const { data, error } = await this.client.from("av2_creative_artifacts")
      .update({ ...patch, request_hash: requestHash, updated_at: new Date().toISOString() })
      .eq("id", id).eq("request_hash", previousHash).is("content_hash", null)
      .in("status", ["generating", "repairing", "failed"]).select("*").maybeSingle();
    if (error) throw persistenceError("request rebind", error);
    return data;
  }

  async create(record) {
    const { data, error } = await this.client.from("av2_creative_artifacts")
      .insert(record).select("*").single();
    if (!error) return { record: data, created: true };
    if (error.code === "23505") {
      const existing = await this.findByRequest(record.artifact_type, record.request_hash);
      if (existing) return { record: existing, created: false };
    }
    throw persistenceError("create", error);
  }

  async update(id, patch) {
    const { data, error } = await this.client.from("av2_creative_artifacts")
      .update({ ...patch, updated_at: new Date().toISOString() }).eq("id", id).select("*").single();
    if (error) throw persistenceError("update", error);
    return data;
  }

  async updateIfStatus(id, statuses, patch) {
    const { data, error } = await this.client.from("av2_creative_artifacts")
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq("id", id).in("status", statuses).select("*").maybeSingle();
    if (error) throw persistenceError("conditional update", error);
    return data;
  }

  async attachVideo(id, videoId) {
    const { data, error } = await this.client.from("av2_creative_artifacts")
      .update({ video_id: videoId, updated_at: new Date().toISOString() })
      .eq("id", id).or(`video_id.is.null,video_id.eq.${videoId}`).select("*").maybeSingle();
    if (error) throw persistenceError("video association", error);
    return data;
  }

  async findProviderOutput(artifactId, generationAttempt) {
    const { data, error } = await this.client.from("av2_provider_outputs")
      .select("*").eq("artifact_id", artifactId).eq("generation_attempt", generationAttempt).maybeSingle();
    if (error) throw persistenceError("provider output read", error);
    return data;
  }

  async saveProviderOutput(record) {
    const { data, error } = await this.client.from("av2_provider_outputs")
      .insert(record).select("*").single();
    if (!error) return { record: data, created: true };
    if (error.code === "23505") {
      const existing = await this.findProviderOutput(record.artifact_id, record.generation_attempt);
      if (existing && existing.raw_transport_hash === record.raw_transport_hash
          && existing.request_hash === record.request_hash) {
        return { record: existing, created: false };
      }
      throw new Av2PersistenceError("Provider output is immutable for a generation attempt", {
        code: "provider_output_conflict",
      });
    }
    throw persistenceError("provider output create", error);
  }
}

export class InMemoryCreativeArtifactStore {
  constructor() {
    this.records = [];
    this.providerOutputs = [];
  }

  async findByRequest(artifactType, requestHash) {
    return this.records.find((row) => row.artifact_type === artifactType && row.request_hash === requestHash) || null;
  }

  async findByIdempotency(artifactType, idempotencyKey) {
    return this.records.find((row) => row.artifact_type === artifactType && row.idempotency_key === idempotencyKey) || null;
  }

  async rebindFailedRequest(id, previousHash, requestHash, patch = {}) {
    const row = this.records.find((candidate) => candidate.id === id);
    if (!row || row.request_hash !== previousHash || row.content_hash
        || !["generating", "repairing", "failed"].includes(row.status)) return null;
    return this.update(id, { ...patch, request_hash: requestHash });
  }

  async create(record) {
    const existing = await this.findByRequest(record.artifact_type, record.request_hash);
    if (existing) return { record: structuredClone(existing), created: false };
    const now = new Date().toISOString();
    const row = { id: crypto.randomUUID(), created_at: now, updated_at: now, ...structuredClone(record) };
    this.records.push(row);
    return { record: structuredClone(row), created: true };
  }

  async update(id, patch) {
    const index = this.records.findIndex((row) => row.id === id);
    if (index === -1) throw new Av2PersistenceError("AV2 artifact not found", { code: "av2_artifact_not_found" });
    this.records[index] = { ...this.records[index], ...structuredClone(patch), updated_at: new Date().toISOString() };
    return structuredClone(this.records[index]);
  }

  async updateIfStatus(id, statuses, patch) {
    const index = this.records.findIndex((row) => row.id === id);
    if (index === -1) throw new Av2PersistenceError("AV2 artifact not found", { code: "av2_artifact_not_found" });
    if (!statuses.includes(this.records[index].status)) return null;
    return this.update(id, patch);
  }

  async attachVideo(id, videoId) {
    const index = this.records.findIndex((row) => row.id === id);
    if (index === -1) throw new Av2PersistenceError("AV2 artifact not found", { code: "av2_artifact_not_found" });
    if (this.records[index].video_id != null && Number(this.records[index].video_id) !== videoId) return null;
    return this.update(id, { video_id: videoId });
  }

  async findProviderOutput(artifactId, generationAttempt) {
    const row = this.providerOutputs.find((candidate) => (
      candidate.artifact_id === artifactId && candidate.generation_attempt === generationAttempt
    ));
    return row ? structuredClone(row) : null;
  }

  async saveProviderOutput(record) {
    const existing = await this.findProviderOutput(record.artifact_id, record.generation_attempt);
    if (existing) {
      if (existing.raw_transport_hash !== record.raw_transport_hash
          || existing.request_hash !== record.request_hash) {
        throw new Av2PersistenceError("Provider output is immutable for a generation attempt", {
          code: "provider_output_conflict",
        });
      }
      return { record: existing, created: false };
    }
    const row = {
      id: crypto.randomUUID(),
      received_at: new Date().toISOString(),
      ...structuredClone(record),
    };
    this.providerOutputs.push(row);
    return { record: structuredClone(row), created: true };
  }
}
