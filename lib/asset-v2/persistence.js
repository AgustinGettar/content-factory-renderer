const TABLES = Object.freeze({
  character: "av2_character_locks",
  world: "av2_world_manifests",
  props: "av2_prop_registries",
  specs: "av2_scene_asset_manifests",
  assets: "av2_assets",
  qa: "av2_visual_qa_runs",
});

function failure(action, error) {
  const wrapped = new Error(`asset_v2_persistence_${action}_failed`);
  wrapped.code = "asset_v2_persistence_failed";
  wrapped.diagnostic = {
    action,
    upstream_code: String(error?.code || "unknown").slice(0, 80),
    upstream_status: Number.isInteger(Number(error?.status)) ? Number(error.status) : null,
  };
  return wrapped;
}

async function single(query, action) {
  const { data, error } = await query;
  if (error) throw failure(action, error);
  return data;
}

async function insertOrFind({ insert, find, action }) {
  const { data, error } = await insert;
  if (!error) return data;
  if (error.code === "23505") {
    const existing = await find();
    if (existing) return existing;
  }
  throw failure(action, error);
}

export class SupabaseAssetV2Store {
  constructor(client, { bucket = "av2-assets-v2" } = {}) {
    if (!client) throw new Error("asset_v2_supabase_client_required");
    this.client = client;
    this.bucket = bucket;
  }

  async saveCharacterLock(row) {
    return insertOrFind({
      insert: this.client.from(TABLES.character).insert(row).select("*").single(),
      find: () => single(this.client.from(TABLES.character).select("*").eq("character_id", row.character_id).eq("version", row.version).maybeSingle(), "character_lock_read"),
      action: "character_lock",
    });
  }

  async saveWorldManifest(row) {
    return insertOrFind({
      insert: this.client.from(TABLES.world).insert(row).select("*").single(),
      find: () => single(this.client.from(TABLES.world).select("*").eq("artifact_id", row.artifact_id).eq("environment_id", row.environment_id).eq("version", row.version).maybeSingle(), "world_manifest_read"),
      action: "world_manifest",
    });
  }

  async savePropRegistry(row) {
    return insertOrFind({
      insert: this.client.from(TABLES.props).insert(row).select("*").single(),
      find: () => single(this.client.from(TABLES.props).select("*").eq("artifact_id", row.artifact_id).eq("version", row.version).maybeSingle(), "prop_registry_read"),
      action: "prop_registry",
    });
  }

  async saveSceneSpecification(row) {
    return insertOrFind({
      insert: this.client.from(TABLES.specs).insert(row).select("*").single(),
      find: () => single(this.client.from(TABLES.specs).select("*").eq("specification_hash", row.specification_hash).maybeSingle(), "scene_specification_read"),
      action: "scene_specification",
    });
  }

  async findAssetBySpecificationHash(specificationHash) {
    return single(this.client.from(TABLES.assets).select("*").eq("specification_hash", specificationHash).maybeSingle(), "asset_read");
  }

  async assertStorageReady() {
    const { error } = await this.client.storage.from(this.bucket).list("", { limit: 1 });
    if (error) throw failure("storage_preflight", error);
    return true;
  }

  async claimSpecification(id) {
    return single(this.client.from(TABLES.specs).update({ status: "generating", updated_at: new Date().toISOString() })
      .eq("id", id).eq("status", "planned").select("*").maybeSingle(), "specification_claim");
  }

  async setSpecificationStatus(id, status, error = null) {
    return single(this.client.from(TABLES.specs).update({ status, last_error: error, updated_at: new Date().toISOString() })
      .eq("id", id).select("*").single(), "specification_status");
  }

  async uploadPng(path, buffer, metadata) {
    const { data, error } = await this.client.storage.from(this.bucket).upload(path, buffer, {
      contentType: "image/png",
      cacheControl: "31536000",
      upsert: false,
      metadata,
    });
    if (error) throw failure("asset_upload", error);
    return data;
  }

  async saveGeneratedAsset(row) {
    return single(this.client.from(TABLES.assets).insert(row).select("*").single(), "asset_create");
  }

  async createReviewUrl(path, expiresIn = 7200) {
    const { data, error } = await this.client.storage.from(this.bucket).createSignedUrl(path, expiresIn);
    if (error) throw failure("review_url", error);
    return data.signedUrl;
  }

  async attachReviewUrl(id, signedUrl, expiresAt) {
    return single(this.client.from(TABLES.assets).update({ review_url: signedUrl, review_url_expires_at: expiresAt })
      .eq("id", id).select("*").single(), "review_url_attach");
  }
}
