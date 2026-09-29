create table if not exists public.lumi_pilot_runs (
  id uuid primary key default gen_random_uuid(),
  pilot_id text not null,
  scene_id text not null,
  stage text not null check (stage in ('IMAGE','VIDEO')),
  status text not null check (status in ('NOT_STARTED','CLAIMED','REQUESTED','SUCCEEDED','FAILED')),
  provider text,
  provider_calls integer not null default 0 check (provider_calls >= 0),
  estimated_cost_usd numeric(12,6) not null default 0 check (estimated_cost_usd >= 0),
  provider_request_id text,
  artifact_reference text,
  storage_bucket text,
  storage_path text,
  content_hash text,
  result jsonb,
  error_code text,
  claimed_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (pilot_id, scene_id, stage)
);

alter table public.lumi_pilot_runs enable row level security;
revoke all on public.lumi_pilot_runs from anon, authenticated;
grant select, insert, update on public.lumi_pilot_runs to service_role;
