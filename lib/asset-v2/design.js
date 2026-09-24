export const AV2_ASSET_STORAGE_DESIGN_V1 = Object.freeze({
  version: "av2-asset-storage-design/1",
  migration_status: "applied_staging",
  isolation: "new V2 tables; existing scenes, videos and AV2 creative artifacts remain unchanged",
  bucket: {
    proposed: "av2-assets-v2",
    visibility: "private",
    object_key: "{artifact_id}/{asset_kind}/{specification_hash}/{variant}.{ext}",
  },
  tables: [
    { name: "av2_character_locks", key: ["character_id", "version"], payload: "specification jsonb + specification_hash + status" },
    { name: "av2_world_manifests", key: ["artifact_id", "environment_id", "version"], payload: "manifest jsonb + manifest_hash + status" },
    { name: "av2_prop_registries", key: ["artifact_id", "version"], payload: "registry jsonb + registry_hash + status" },
    { name: "av2_scene_asset_manifests", key: ["artifact_id", "scene_id", "version"], payload: "manifest jsonb + specification_hash + status" },
    { name: "av2_assets", key: ["specification_hash", "variant"], payload: "storage path + content hash + provider metadata + status" },
    { name: "av2_visual_qa_runs", key: ["asset_id", "qa_version", "run_number"], payload: "findings jsonb + severity counts + status" },
  ],
  access: "service-role only writes; least-privilege read path for renderer; RLS deny browser writes",
  immutability: "accepted specifications and content hashes are append-only; provider metadata excludes credentials and headers",
});

export const AV2_ASSET_CALL_BUDGET_V1 = Object.freeze({
  version: "av2-asset-call-budget/1",
  visual_benchmark: {
    canonical_lumi_base: 0,
    environment_master: 0,
    reusable_prop_sheets: 0,
    scene_specific_character_states: 0,
    benchmark_composites: 3,
    automatic_retries: 0,
    estimated_max_provider_calls: 3,
  },
  nine_scene_episode_after_benchmark: {
    reused_character_environment_props: "all accepted benchmark masters",
    additional_character_state_derivatives: "4-6",
    full_scene_regenerations: 0,
    estimated_incremental_provider_calls: "4-6",
  },
  rule: "reuse accepted character/environment/prop hashes; only generate a new state delta when no compatible asset exists",
});

export const AV2_VISUAL_ARCHITECTURE_OPTIONS_V1 = Object.freeze({
  recommended_initial: "layered_2_5d",
  upgrade_path: "layered_2_5d now; optional true_3d Lumi rig after an approved model and GPU/cost gate",
  comparison: [
    {
      option: "layered_2_5d",
      consistency: "high with locked PNG/reference layers",
      motion: "deterministic parallax, swaps and independent props",
      automation: "high in current FFmpeg/Blender-2D infrastructure",
      gpu_cost: "low",
      complexity: "low-medium",
      render_time: "short",
      shorts_fit: "best initial fit",
    },
    {
      option: "generated_pseudo_3d_frames",
      consistency: "medium-low across poses",
      motion: "limited unless many costly derivatives are generated",
      automation: "medium",
      gpu_cost: "provider-dependent per frame/state",
      complexity: "medium",
      render_time: "medium",
      shorts_fit: "use only for controlled asset derivation, not full scenes",
    },
    {
      option: "true_blender_3d_rig",
      consistency: "highest after a correct approved rig",
      motion: "highest",
      automation: "high after substantial setup",
      gpu_cost: "high relative to current Render service",
      complexity: "high",
      render_time: "longest",
      shorts_fit: "future upgrade after character-model approval",
    },
  ],
});
