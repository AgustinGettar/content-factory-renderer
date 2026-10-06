-- Isolated, opt-in staging review state. No legacy table or policy changes.
create table if not exists public.lumi_telegram_review_sessions (
  user_id bigint primary key,
  chat_id bigint not null,
  message_id bigint not null check (message_id > 0),
  revision bigint not null default 0 check (revision >= 0),
  state jsonb not null,
  updated_at timestamptz not null default now(),
  unique(chat_id),
  check (state->>'user_id' = user_id::text),
  check (state->>'chat_id' = chat_id::text),
  check ((state->>'message_id')::bigint = message_id)
);
alter table public.lumi_telegram_review_sessions enable row level security;
revoke all on public.lumi_telegram_review_sessions from public, anon, authenticated;
grant select, insert, update on public.lumi_telegram_review_sessions to service_role;
