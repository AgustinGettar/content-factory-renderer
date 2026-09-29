-- Asset Engine V2 is isolated from legacy scene/image tables. All browser roles
-- are denied; the staging runtime uses its server-side service role.

create table if not exists public.av2_character_locks (
  id uuid primary key default gen_random_uuid(),
  character_id text not null,
  version text not null,
  specification jsonb not null,
  specification_hash text not null check (specification_hash ~ '^[a-f0-9]{64}$'),
  reference_hash text not null check (reference_hash ~ '^[a-f0-9]{64}$'),
  status text not null check (status in ('planned','generating','generated','qa_passed','qa_warning','rejected')),
  created_at timestamptz not null default now(),
  unique (character_id, version)
);

create table if not exists public.av2_world_manifests (
  id uuid primary key default gen_random_uuid(),
  artifact_id uuid not null references public.av2_creative_artifacts(id) on delete restrict,
  environment_id text not null,
  version text not null,
  manifest jsonb not null,
  manifest_hash text not null check (manifest_hash ~ '^[a-f0-9]{64}$'),
  status text not null check (status in ('planned','generating','generated','qa_passed','qa_warning','rejected')),
  created_at timestamptz not null default now(),
  unique (artifact_id, environment_id, version)
);

create table if not exists public.av2_prop_registries (
  id uuid primary key default gen_random_uuid(),
  artifact_id uuid not null references public.av2_creative_artifacts(id) on delete restrict,
  version text not null,
  registry jsonb not null,
  registry_hash text not null check (registry_hash ~ '^[a-f0-9]{64}$'),
  status text not null check (status in ('planned','generating','generated','qa_passed','qa_warning','rejected')),
  created_at timestamptz not null default now(),
  unique (artifact_id, version)
);

create table if not exists public.av2_scene_asset_manifests (
  id uuid primary key default gen_random_uuid(),
  artifact_id uuid not null references public.av2_creative_artifacts(id) on delete restrict,
  scene_id text not null,
  benchmark_role text not null,
  version text not null,
  manifest jsonb not null,
  specification_hash text not null unique check (specification_hash ~ '^[a-f0-9]{64}$'),
  asset_manifest_hash text not null check (asset_manifest_hash ~ '^[a-f0-9]{64}$'),
  compiled_prompt text not null,
  compiled_prompt_hash text not null check (compiled_prompt_hash ~ '^[a-f0-9]{64}$'),
  provider_request_hash text not null unique check (provider_request_hash ~ '^[a-f0-9]{64}$'),
  character_lock_version text not null,
  character_lock_hash text not null check (character_lock_hash ~ '^[a-f0-9]{64}$'),
  character_reference_version text not null,
  character_reference_hash text not null check (character_reference_hash ~ '^[a-f0-9]{64}$'),
  world_manifest_version text not null,
  world_manifest_hash text not null check (world_manifest_hash ~ '^[a-f0-9]{64}$'),
  prop_registry_version text not null,
  prop_registry_hash text not null check (prop_registry_hash ~ '^[a-f0-9]{64}$'),
  framing_policy jsonb not null,
  status text not null check (status in ('planned','generating','generated','qa_passed','qa_warning','rejected')),
  last_error jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (artifact_id, scene_id, version)
);

create table if not exists public.av2_assets (
  id uuid primary key default gen_random_uuid(),
  artifact_id uuid not null references public.av2_creative_artifacts(id) on delete restrict,
  scene_id text not null,
  specification_id uuid not null references public.av2_scene_asset_manifests(id) on delete restrict,
  specification_hash text not null check (specification_hash ~ '^[a-f0-9]{64}$'),
  variant text not null,
  asset_hash text not null check (asset_hash ~ '^[a-f0-9]{64}$'),
  provider text not null,
  provider_model text not null,
  provider_request_hash text not null check (provider_request_hash ~ '^[a-f0-9]{64}$'),
  provider_response_id text,
  provider_request_id text,
  provider_metadata jsonb not null default '{}'::jsonb,
  source_width integer not null check (source_width > 0),
  source_height integer not null check (source_height > 0),
  final_width integer not null check (final_width > 0),
  final_height integer not null check (final_height > 0),
  storage_bucket text not null,
  storage_path text not null,
  character_reference_hash text not null check (character_reference_hash ~ '^[a-f0-9]{64}$'),
  world_manifest_version text not null,
  scene_manifest_version text not null,
  parent_asset_id uuid references public.av2_assets(id) on delete restrict,
  reuse_of_asset_id uuid references public.av2_assets(id) on delete restrict,
  generated_at timestamptz not null,
  review_url text,
  review_url_expires_at timestamptz,
  status text not null check (status in ('planned','generating','generated','qa_passed','qa_warning','rejected')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (specification_hash, variant),
  unique (storage_bucket, storage_path)
);

create table if not exists public.av2_visual_qa_runs (
  id uuid primary key default gen_random_uuid(),
  artifact_id uuid not null references public.av2_creative_artifacts(id) on delete restrict,
  asset_id uuid references public.av2_assets(id) on delete restrict,
  benchmark_version text not null,
  qa_version text not null,
  scope text not null check (scope in ('individual','cross_scene')),
  run_number smallint not null default 1 check (run_number >= 1),
  result jsonb not null,
  blocker_count integer not null check (blocker_count >= 0),
  warning_count integer not null check (warning_count >= 0),
  info_count integer not null check (info_count >= 0),
  status text not null check (status in ('qa_passed','qa_warning','rejected')),
  created_at timestamptz not null default now(),
  unique nulls not distinct (asset_id, qa_version, scope, run_number)
);

alter table public.av2_character_locks enable row level security;
alter table public.av2_world_manifests enable row level security;
alter table public.av2_prop_registries enable row level security;
alter table public.av2_scene_asset_manifests enable row level security;
alter table public.av2_assets enable row level security;
alter table public.av2_visual_qa_runs enable row level security;

revoke all on public.av2_character_locks from anon, authenticated;
revoke all on public.av2_world_manifests from anon, authenticated;
revoke all on public.av2_prop_registries from anon, authenticated;
revoke all on public.av2_scene_asset_manifests from anon, authenticated;
revoke all on public.av2_assets from anon, authenticated;
revoke all on public.av2_visual_qa_runs from anon, authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('av2-assets-v2', 'av2-assets-v2', false, 20971520, array['image/png']::text[])
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;
