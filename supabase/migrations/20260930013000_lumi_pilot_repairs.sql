create table if not exists public.lumi_pilot_repairs (
  id uuid primary key default gen_random_uuid(),
  pilot_id text not null,
  scene_id text not null check (scene_id = 's19'),
  stage text not null check (stage = 'IMAGE'),
  source_run_id uuid not null references public.lumi_pilot_runs(id),
  repair_reason text not null check (repair_reason = 'SOURCE_REPAIR_REQUIRED'),
  repair_attempt integer not null check (repair_attempt = 1),
  status text not null check (status in ('CLAIMED','REQUESTED','SUCCEEDED','FAILED')),
  provider_calls integer not null default 0 check (provider_calls >= 0),
  estimated_cost_usd numeric(12,6) not null default 0 check (estimated_cost_usd >= 0),
  provider_request_id text,
  artifact_reference text,
  content_hash text,
  result jsonb,
  error_code text,
  claimed_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (pilot_id, scene_id, stage, repair_attempt)
);

alter table public.lumi_pilot_repairs enable row level security;
revoke all on public.lumi_pilot_repairs from anon, authenticated;
grant select, insert, update on public.lumi_pilot_repairs to service_role;
