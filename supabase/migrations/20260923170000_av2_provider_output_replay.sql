create table if not exists public.av2_provider_outputs (
  id uuid primary key default gen_random_uuid(),
  artifact_id uuid not null references public.av2_creative_artifacts(id) on delete cascade,
  generation_attempt smallint not null check (generation_attempt >= 1 and generation_attempt <= 5),
  request_hash text not null check (request_hash ~ '^[a-f0-9]{64}$'),
  request_payload_hash text null check (request_payload_hash is null or request_payload_hash ~ '^[a-f0-9]{64}$'),
  transport_version text not null check (char_length(transport_version) between 1 and 100),
  provider text not null check (char_length(provider) between 1 and 40),
  provider_response_id text null check (provider_response_id is null or char_length(provider_response_id) <= 180),
  provider_model text null check (provider_model is null or char_length(provider_model) <= 100),
  provider_created_at timestamptz null,
  received_at timestamptz not null default now(),
  input_tokens integer not null default 0 check (input_tokens >= 0),
  output_tokens integer not null default 0 check (output_tokens >= 0),
  raw_transport jsonb not null check (jsonb_typeof(raw_transport) = 'object'),
  raw_transport_hash text not null check (raw_transport_hash ~ '^[a-f0-9]{64}$'),
  constraint av2_provider_outputs_artifact_attempt_key unique (artifact_id, generation_attempt)
);

alter table public.av2_provider_outputs enable row level security;

revoke all on table public.av2_provider_outputs from anon, authenticated;
revoke update, delete on table public.av2_provider_outputs from service_role;
grant select, insert on table public.av2_provider_outputs to service_role;

comment on table public.av2_provider_outputs is
  'Immutable provider Structured Output per AV2 artifact generation attempt; replay source before semantic validation.';

