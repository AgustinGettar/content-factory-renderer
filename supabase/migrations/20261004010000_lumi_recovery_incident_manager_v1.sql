create table if not exists public.lumi_pipeline_checkpoints (
  episode_id text primary key,
  pipeline_version text not null check (pipeline_version in ('v1_1_2')),
  preset_version text not null check (preset_version = '1.1.2'),
  status text not null,
  runner_enabled boolean not null default false,
  autorun boolean not null default false check (autorun = false),
  current_cost_usd numeric(12,6) not null default 0,
  authorized_ceiling_usd numeric(12,6) not null default 0,
  last_completed_action text,
  first_pending_action text,
  active_incident_id uuid,
  cancellation_reason text,
  actions jsonb not null default '[]'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.lumi_pipeline_incidents (
  incident_id uuid primary key,
  episode_id text not null references public.lumi_pipeline_checkpoints(episode_id),
  scene_id text,
  stage text not null,
  error_class text not null,
  reason text not null,
  provider_request_id text,
  artifact_id_path text,
  last_successful_checkpoint text,
  first_pending_action text not null,
  retryability text not null,
  safe_resume_available boolean not null,
  cost_lost_avoidable boolean not null,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  status text not null check (status in ('OPEN','RESOLVING','RESOLVED','CANCELLED'))
);

create index if not exists lumi_pipeline_incidents_episode_created_idx
  on public.lumi_pipeline_incidents (episode_id, created_at desc);

alter table public.lumi_pipeline_checkpoints enable row level security;
alter table public.lumi_pipeline_incidents enable row level security;
revoke all on public.lumi_pipeline_checkpoints from anon, authenticated;
revoke all on public.lumi_pipeline_incidents from anon, authenticated;
