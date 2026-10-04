create table if not exists public.lumi_controlled_episode_requests (
  episode_id text primary key,
  idea_id bigint not null unique references public.ideas(id),
  command_key text not null unique,
  user_id bigint not null references public.cf_bot_admins(user_id),
  chat_id bigint not null,
  title text not null,
  educational_objective text not null,
  pipeline_version text not null check (pipeline_version = 'v1_1_2'),
  status text not null check (status in ('ACCEPTED','RUNNING','PAUSED_INCIDENT','HUMAN_REVIEW_PENDING','CANCELLED')),
  telegram_message_id bigint,
  specification jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.lumi_controlled_episode_requests enable row level security;
revoke all on public.lumi_controlled_episode_requests from anon, authenticated;
grant select, insert, update on public.lumi_controlled_episode_requests to service_role;

create or replace function public.cf_lumi_controlled_start(
  p_user bigint,
  p_chat bigint,
  p_command_key text,
  p_episode_id text,
  p_title text,
  p_objective text,
  p_pipeline_version text,
  p_specification jsonb
) returns public.lumi_controlled_episode_requests
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  a public.cf_bot_admins;
  v_idea_id bigint;
  r public.lumi_controlled_episode_requests;
begin
  select * into a from public.cf_bot_admins
   where user_id=p_user and chat_id=p_chat and active for update;
  if not found then raise exception 'Acceso no autorizado'; end if;
  if p_pipeline_version <> 'v1_1_2' then raise exception 'Pipeline controlado inválido'; end if;
  if p_episode_id !~ '^ep_lumi_[a-z0-9_]{3,80}$' then raise exception 'Episode ID inválido'; end if;
  if length(p_command_key) not between 8 and 180 then raise exception 'Command key inválido'; end if;
  if length(btrim(p_title)) not between 4 and 220 then raise exception 'Título inválido'; end if;
  if length(btrim(p_objective)) not between 8 and 500 then raise exception 'Objetivo inválido'; end if;

  select * into r from public.lumi_controlled_episode_requests where episode_id=p_episode_id;
  if found then
    if r.command_key <> p_command_key or r.pipeline_version <> p_pipeline_version then
      raise exception 'Conflicto de idempotencia';
    end if;
    return r;
  end if;

  insert into public.ideas(
    channel_id,idea,notes,source,source_message_id,
    telegram_user_id,telegram_chat_id,status
  ) values (
    a.channel_id,btrim(p_title),left(btrim(p_objective),800),'lumi_controlled',
    p_command_key,p_user,p_chat,'scripted'
  ) returning id into v_idea_id;

  insert into public.lumi_controlled_episode_requests(
    episode_id,idea_id,command_key,user_id,chat_id,title,educational_objective,
    pipeline_version,status,specification
  ) values (
    p_episode_id,v_idea_id,p_command_key,p_user,p_chat,btrim(p_title),btrim(p_objective),
    p_pipeline_version,'ACCEPTED',coalesce(p_specification,'{}'::jsonb)
  ) returning * into r;
  return r;
end $function$;

revoke execute on function public.cf_lumi_controlled_start(bigint,bigint,text,text,text,text,text,jsonb) from public, anon, authenticated;
grant execute on function public.cf_lumi_controlled_start(bigint,bigint,text,text,text,text,text,jsonb) to service_role;
