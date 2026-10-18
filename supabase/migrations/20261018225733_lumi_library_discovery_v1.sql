-- Extend the existing immutable catalog only; no data or approval rewrites.
-- Discovery provenance and lifecycle remain in reuse_policy.discovery JSONB.
alter table public.lumi_library_assets drop constraint lumi_library_assets_asset_type_check;
alter table public.lumi_library_assets add constraint lumi_library_assets_asset_type_check
  check (asset_type in ('CHARACTER_REFERENCE','SCENE_REFERENCE','OBJECT_REFERENCE','APPROVED_IMAGE','APPROVED_VIDEO','BACKGROUND','MASTER'));
