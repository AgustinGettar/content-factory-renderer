-- Additive control panel schema. The existing render status machine is preserved.
create table public.cf_bot_settings (
 id boolean primary key default true check(id), secret_hash text not null default '',
 generation_enabled boolean not null default false,
 ai_enabled boolean not null default true, ai_message text not null default '',
 integrations jsonb not null default '{"youtube":"not_connected","tiktok":"not_connected","instagram":"not_connected"}'::jsonb
);
insert into public.cf_bot_settings(id) values(true);
create table public.cf_bot_admins (
 user_id bigint primary key, chat_id bigint not null, channel_id bigint not null references public.channels(id), active boolean not null default true
);
create table public.cf_bot_sessions (
 user_id bigint primary key references public.cf_bot_admins(user_id), phase text not null default 'home',
 data jsonb not null default '{}', expires_at timestamptz not null default now()+interval '30 minutes'
);
create table public.cf_bot_jobs (
 id uuid primary key default gen_random_uuid(), user_id bigint not null references public.cf_bot_admins(user_id),
 channel_id bigint not null references public.channels(id), kind text not null check(kind in ('ideas','trends')),
 status text not null default 'pending' check(status in ('pending','ready','failed')),
 result jsonb not null default '[]', created_at timestamptz not null default now(), completed_at timestamptz,
 usage jsonb not null default '{}'
);
create index cf_jobs_recent on public.cf_bot_jobs(user_id,kind,created_at desc);
create table public.cf_bot_choices (
 job_id uuid not null references public.cf_bot_jobs(id), choice integer not null,
 idea_id bigint not null references public.ideas(id), primary key(job_id,choice)
);
create table public.cf_video_reviews (
 video_id bigint primary key references public.videos(id), verdict text not null check(verdict in ('approved','rejected')),
 reviewed_by bigint not null references public.cf_bot_admins(user_id), reason text, reviewed_at timestamptz not null default now()
);
create table public.cf_schedule_drafts (
 id uuid primary key default gen_random_uuid(), user_id bigint not null references public.cf_bot_admins(user_id),
 video_id bigint not null references public.videos(id), scheduled_at timestamptz not null,
 platforms text[] not null default '{}', confirmed_at timestamptz,
 expires_at timestamptz not null default now()+interval '30 minutes'
);
create table public.cf_bot_commands (
 command_key text primary key, user_id bigint not null references public.cf_bot_admins(user_id),
 result jsonb not null, created_at timestamptz not null default now()
);
create table public.cf_bot_audit (
 id bigint generated always as identity primary key, user_id bigint not null,
 action text not null, entity_id text, created_at timestamptz not null default now()
);
create index cf_audit_recent on public.cf_bot_audit(user_id,created_at desc);
create unique index cf_publication_once on public.publications(video_id,platform) where status in ('scheduled','publishing','published');

do $$ declare n text; begin
 foreach n in array array['cf_bot_settings','cf_bot_admins','cf_bot_sessions','cf_bot_jobs','cf_bot_choices','cf_video_reviews','cf_schedule_drafts','cf_bot_commands','cf_bot_audit'] loop
  execute format('alter table public.%I enable row level security',n);
  execute format('revoke all on public.%I from anon,authenticated',n);
  execute format('grant all on public.%I to service_role',n);
 end loop;
end $$;
grant usage,select on sequence public.cf_bot_audit_id_seq to service_role;

-- All mutations are serialized per administrator and idempotent per Telegram update.
create function public.cf_bot_command(p_user bigint,p_chat bigint,p_key text,p_action text,p_args jsonb default '{}')
returns jsonb language plpgsql security invoker set search_path='' as $$
declare a public.cf_bot_admins; v public.videos; j public.cf_bot_jobs; d public.cf_schedule_drafts;
 result jsonb; existing bigint; target bigint; slot timestamptz; tz text; local_time timestamp;
 platforms text[]; plat text; idea_text text; selection jsonb;
begin
 select * into a from public.cf_bot_admins where user_id=p_user and chat_id=p_chat and active for update;
 if not found then raise exception 'Acceso no autorizado'; end if;
 if length(p_key)>180 then raise exception 'Solicitud inválida'; end if;
 select c.result into result from public.cf_bot_commands c where command_key=p_key and user_id=p_user;
 if found then return case when p_action='ai_start' then result||'{"cached":true}'::jsonb else result end; end if;
 select timezone into tz from public.channels where id=a.channel_id;
 if p_action='session' then
  insert into public.cf_bot_sessions(user_id,phase,data) values(p_user,p_args->>'phase',coalesce(p_args->'data','{}'))
   on conflict(user_id) do update set phase=excluded.phase,data=excluded.data,expires_at=now()+interval '30 minutes';
  result='{}';
 elsif p_action='ai_start' then
  select * into j from public.cf_bot_jobs where user_id=p_user and kind=p_args->>'kind' and
   ((status='ready' and created_at>now()-interval '24 hours') or (status='pending' and created_at>now()-interval '5 minutes'))
   order by created_at desc limit 1;
  if found then result=to_jsonb(j)||'{"cached":true}';
  else
   if (select count(*) from public.cf_bot_jobs where user_id=p_user and created_at>now()-interval '1 hour')>=6 then
    raise exception 'Llegaste al límite de consultas de esta hora. Probá más tarde.';
   end if;
   insert into public.cf_bot_jobs(user_id,channel_id,kind) values(p_user,a.channel_id,p_args->>'kind') returning * into j;
   result=to_jsonb(j)||'{"cached":false}';
  end if;
 elsif p_action='ai_finish' then
  select * into j from public.cf_bot_jobs where id=(p_args->>'id')::uuid and user_id=p_user for update;
  if not found then raise exception 'Consulta inexistente'; end if;
  if j.status='pending' then
   update public.cf_bot_jobs set result=p_args->'result',status=p_args->>'status',usage=coalesce(p_args->'usage','{}'),completed_at=now() where id=j.id returning * into j;
  end if;
  result=to_jsonb(j);
 elsif p_action in ('choose','manual') then
  if not (select generation_enabled from public.cf_bot_settings where id) then raise exception 'La generación está pausada. Tu idea todavía no se envió a producir.'; end if;
  if p_action='choose' then
   select * into j from public.cf_bot_jobs where id=(p_args->>'job')::uuid and user_id=p_user and status='ready' for update;
   if not found then raise exception 'La propuesta ya no está disponible'; end if;
   select idea_id into existing from public.cf_bot_choices where job_id=j.id and choice=(p_args->>'index')::int;
   if found then return jsonb_build_object('idea_id',existing,'duplicate',true); end if;
   selection=j.result->(p_args->>'index')::int;
   idea_text=selection->>'title';
  else idea_text=p_args->>'title'; end if;
  if idea_text is null or length(btrim(idea_text)) not between 4 and 300 then raise exception 'La idea debe tener entre 4 y 300 caracteres'; end if;
  select id into existing from public.ideas where channel_id=a.channel_id and lower(btrim(idea))=lower(btrim(idea_text)) and status<>'rejected' limit 1;
  if found then raise exception 'Esta idea ya existe en Ideas anteriores. Elegí otra propuesta.'; end if;
  insert into public.ideas(channel_id,idea,notes,source,source_message_id,telegram_user_id,telegram_chat_id,status)
   values(a.channel_id,btrim(idea_text),left(coalesce(selection->>'lesson','Idea ingresada desde el panel'),800),'telegram',p_key,p_user,p_chat,'pending') returning id into target;
  if p_action='choose' then insert into public.cf_bot_choices values(j.id,(p_args->>'index')::int,target); end if;
  result=jsonb_build_object('idea_id',target);
 elsif p_action in ('approve','reject') then
  select * into v from public.videos where id=(p_args->>'video')::bigint and channel_id=a.channel_id for update;
  if not found or v.status not in ('rendered','approved') or nullif(v.render_url,'') is null then raise exception 'Este video todavía no está listo para revisar'; end if;
  if exists(select 1 from public.publications where video_id=v.id and status in ('scheduled','publishing','published')) then raise exception 'Primero cancelá su programación. Un contenido publicado no se rechaza desde aquí.'; end if;
  insert into public.cf_video_reviews(video_id,verdict,reviewed_by,reason) values(v.id,case when p_action='approve' then 'approved' else 'rejected' end,p_user,left(p_args->>'reason',500))
   on conflict(video_id) do update set verdict=excluded.verdict,reviewed_by=p_user,reason=excluded.reason,reviewed_at=now();
  result=jsonb_build_object('video_id',v.id,'verdict',p_action);
 elsif p_action='draft' then
  select * into v from public.videos where id=(p_args->>'video')::bigint and channel_id=a.channel_id for update;
  if not found or v.status not in ('rendered','approved') or nullif(v.render_url,'') is null or not exists(select 1 from public.cf_video_reviews where video_id=v.id and verdict='approved') then raise exception 'Aprobá el video antes de programarlo'; end if;
  if coalesce(p_args->>'local','')='' then
   select s into slot from (select (day::date+time '18:00') at time zone tz s from generate_series((now() at time zone tz)::date,(now() at time zone tz)::date+30,interval '1 day') day) slots
   where s>now()+interval '30 minutes' and not exists(select 1 from public.publications where channel_id=a.channel_id and status in ('scheduled','publishing','published') and (coalesce(scheduled_at,published_at) at time zone tz)::date=(s at time zone tz)::date)
   order by s limit 1;
  else
   local_time=(p_args->>'local')::timestamp; slot=local_time at time zone tz;
   if (slot at time zone tz)<>local_time or ((slot-interval '1 hour') at time zone tz)=local_time or ((slot+interval '1 hour') at time zone tz)=local_time then raise exception 'Esa hora es ambigua o no existe por el cambio horario. Elegí otra.'; end if;
  end if;
  if slot is null or slot<now()+interval '5 minutes' or slot>now()+interval '180 days' then raise exception 'Elegí una fecha futura dentro de los próximos 180 días'; end if;
  select array_agg(platform order by platform) into platforms from public.channel_platforms where channel_id=a.channel_id and enabled;
  insert into public.cf_schedule_drafts(user_id,video_id,scheduled_at,platforms) values(p_user,v.id,slot,coalesce(platforms,'{}')) returning * into d;
  result=to_jsonb(d);
 elsif p_action='toggle' then
  select * into d from public.cf_schedule_drafts where id=(p_args->>'draft')::uuid and user_id=p_user and confirmed_at is null and expires_at>now() for update;
  if not found then raise exception 'La selección venció. Volvé a elegir el video.'; end if;
  plat=p_args->>'platform';
  if not exists(select 1 from public.channel_platforms where channel_id=a.channel_id and platform=plat and enabled) then raise exception 'Red no disponible'; end if;
  update public.cf_schedule_drafts set platforms=case when plat=any(cf_schedule_drafts.platforms) then array_remove(cf_schedule_drafts.platforms,plat) else array_append(cf_schedule_drafts.platforms,plat) end where id=d.id returning * into d;
  result=to_jsonb(d);
 elsif p_action='schedule' then
  select * into d from public.cf_schedule_drafts where id=(p_args->>'draft')::uuid and user_id=p_user for update;
  if not found then raise exception 'Selección inexistente'; end if;
  if d.confirmed_at is not null then return jsonb_build_object('scheduled',true,'duplicate',true); end if;
  if d.expires_at<now() or d.scheduled_at<now()+interval '5 minutes' then raise exception 'La selección venció. Elegí una nueva fecha.'; end if;
  select * into v from public.videos where id=d.video_id and channel_id=a.channel_id for update;
  if not found or v.status not in ('rendered','approved') or nullif(v.render_url,'') is null or not exists(select 1 from public.cf_video_reviews where video_id=v.id and verdict='approved') then raise exception 'El video debe estar aprobado y listo'; end if;
  if cardinality(d.platforms)=0 then raise exception 'Seleccioná al menos una red'; end if;
  foreach plat in array d.platforms loop
   if not exists(select 1 from public.channel_platforms where channel_id=a.channel_id and platform=plat and enabled) then raise exception 'La red seleccionada está deshabilitada'; end if;
   if coalesce((select integrations->>plat from public.cf_bot_settings where id),'not_connected')<>'ready' then raise exception 'Falta conectar % para publicar. La propuesta se conserva, pero no se confirmó ninguna subida.',plat; end if;
   if exists(select 1 from public.publications where video_id=v.id and platform=plat and status in ('publishing','published')) then raise exception 'Este video ya se publicó o está publicándose en %',plat; end if;
   if exists(select 1 from public.publications where channel_id=a.channel_id and platform=plat and video_id<>v.id and status in ('scheduled','publishing','published') and (coalesce(scheduled_at,published_at) at time zone tz)::date=(d.scheduled_at at time zone tz)::date) then raise exception 'Ya hay contenido para % ese día. Elegí otra fecha.',plat; end if;
  end loop;
  foreach plat in array d.platforms loop
   select id into existing from public.publications where video_id=v.id and platform=plat and status='scheduled' for update;
   if found then update public.publications set scheduled_at=d.scheduled_at where id=existing;
   else insert into public.publications(video_id,channel_id,platform,status,scheduled_at) values(v.id,a.channel_id,plat,'scheduled',d.scheduled_at); end if;
  end loop;
  update public.cf_schedule_drafts set confirmed_at=now() where id=d.id;
  result=jsonb_build_object('scheduled',true,'video_id',v.id);
 elsif p_action='cancel' then
  update public.publications set status='cancelled' where id=(p_args->>'publication')::bigint and channel_id=a.channel_id and status='scheduled' returning id into target;
  if not found then raise exception 'Esta publicación ya no se puede cancelar desde aquí'; end if;
  result=jsonb_build_object('cancelled',target);
 else raise exception 'Acción desconocida'; end if;
 insert into public.cf_bot_commands(command_key,user_id,result) values(p_key,p_user,result);
 if p_action not in ('session','ai_start') then insert into public.cf_bot_audit(user_id,action,entity_id) values(p_user,p_action,coalesce(target::text,p_args->>'video',p_args->>'draft')); end if;
 return result;
end $$;
revoke all on function public.cf_bot_command(bigint,bigint,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.cf_bot_command(bigint,bigint,text,text,jsonb) to service_role;
