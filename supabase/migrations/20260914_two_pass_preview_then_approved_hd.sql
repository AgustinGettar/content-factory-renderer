-- Two-pass rendering: a reviewable LD preview, followed by the approved Full HD revision.
ALTER TABLE public.videos
 ADD COLUMN IF NOT EXISTS render_stage text NOT NULL DEFAULT 'preview' CHECK (render_stage IN ('preview','final')),
 ADD COLUMN IF NOT EXISTS content_revision integer NOT NULL DEFAULT 1 CHECK (content_revision > 0),
 ADD COLUMN IF NOT EXISTS preview_url text,
 ADD COLUMN IF NOT EXISTS preview_revision integer,
 ADD COLUMN IF NOT EXISTS approved_revision integer,
 ADD COLUMN IF NOT EXISTS final_revision integer,
 ADD COLUMN IF NOT EXISTS render_manifest jsonb,
 ADD COLUMN IF NOT EXISTS render_attempt_id uuid,
 ADD COLUMN IF NOT EXISTS render_lease_until timestamptz,
 ADD COLUMN IF NOT EXISTS render_retries integer NOT NULL DEFAULT 0;
ALTER TABLE public.cf_video_reviews ADD COLUMN IF NOT EXISTS content_revision integer;

CREATE OR REPLACE FUNCTION public.cf_claim_render(p_video bigint, p_attempt uuid)
RETURNS jsonb LANGUAGE plpgsql SET search_path='' AS $fn$
DECLARE v public.videos; manifest jsonb;
BEGIN
 IF p_attempt IS NULL THEN RAISE EXCEPTION 'Falta el identificador del intento'; END IF;
 SELECT * INTO v FROM public.videos WHERE id=p_video FOR UPDATE;
 IF NOT FOUND OR v.status<>'queued' THEN RETURN NULL; END IF;
 IF v.render_stage='final' THEN
  IF v.approved_revision IS DISTINCT FROM v.content_revision OR v.preview_revision IS DISTINCT FROM v.content_revision
   OR v.render_manifest IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.cf_video_reviews WHERE video_id=v.id AND verdict='approved' AND content_revision=v.content_revision
   ) THEN RAISE EXCEPTION 'HD necesita aprobación de esta versión'; END IF;
  manifest=v.render_manifest;
 ELSE
  IF NOT EXISTS (SELECT 1 FROM public.video_render_readiness WHERE video_id=v.id AND is_ready) THEN
   RAISE EXCEPTION 'Faltan escenas, imágenes, voz o guion'; END IF;
  SELECT jsonb_build_object(
   'version','ld-hd-v1','revision',v.content_revision,'title',v.title,
   'language',v.language,'aspect_ratio',coalesce(v.aspect_ratio,'9:16'),
   'scenes',jsonb_agg(jsonb_build_object('id',s.id,'scene_number',s.scene_number,
    'narration',s.narration,'on_screen_text',s.on_screen_text,
    'image_url',s.image_url,'audio_url',s.audio_url) ORDER BY s.scene_number)
  ) INTO manifest FROM public.scenes s WHERE s.video_id=v.id;
 END IF;
 UPDATE public.videos SET status='rendering',render_attempt_id=p_attempt,
  render_lease_until=now()+interval '2 minutes',render_manifest=manifest,error_message=NULL
  WHERE id=v.id RETURNING * INTO v;
 RETURN jsonb_build_object('video',to_jsonb(v),'manifest',manifest);
END $fn$;

CREATE OR REPLACE FUNCTION public.cf_save_render_manifest(p_video bigint,p_attempt uuid,p_revision integer,p_manifest jsonb)
RETURNS boolean LANGUAGE plpgsql SET search_path='' AS $fn$
BEGIN
 IF p_manifest->>'version' IS DISTINCT FROM 'ld-hd-v1' OR
  (p_manifest->>'revision')::integer IS DISTINCT FROM p_revision THEN RAISE EXCEPTION 'Manifiesto inválido'; END IF;
 UPDATE public.videos SET render_manifest=p_manifest WHERE id=p_video AND status='rendering'
  AND render_stage='preview' AND render_attempt_id=p_attempt AND content_revision=p_revision;
 RETURN FOUND;
END $fn$;

CREATE OR REPLACE FUNCTION public.cf_renew_render_lease(p_video bigint,p_attempt uuid)
RETURNS boolean LANGUAGE plpgsql SET search_path='' AS $fn$
BEGIN
 UPDATE public.videos SET render_lease_until=now()+interval '2 minutes'
 WHERE id=p_video AND status='rendering' AND render_attempt_id=p_attempt;
 RETURN FOUND;
END $fn$;

CREATE OR REPLACE FUNCTION public.cf_complete_render(p_video bigint,p_attempt uuid,p_revision integer,p_url text,p_duration numeric)
RETURNS boolean LANGUAGE plpgsql SET search_path='' AS $fn$
DECLARE v public.videos;
BEGIN
 SELECT * INTO v FROM public.videos WHERE id=p_video FOR UPDATE;
 IF NOT FOUND OR v.status<>'rendering' OR v.render_attempt_id IS DISTINCT FROM p_attempt OR
  v.content_revision<>p_revision THEN RETURN false; END IF;
 IF nullif(btrim(p_url),'') IS NULL OR p_duration IS NULL OR p_duration<=0 THEN
  RAISE EXCEPTION 'El resultado del render no es válido'; END IF;
 IF v.render_stage='final' AND (v.approved_revision IS DISTINCT FROM p_revision OR NOT EXISTS (
  SELECT 1 FROM public.cf_video_reviews WHERE video_id=v.id AND verdict='approved' AND content_revision=p_revision
 )) THEN RETURN false; END IF;
 UPDATE public.videos SET status='rendered',render_url=p_url,duration_seconds=p_duration,error_message=NULL,
  preview_url=CASE WHEN render_stage='preview' THEN p_url ELSE preview_url END,
  preview_revision=CASE WHEN render_stage='preview' THEN p_revision ELSE preview_revision END,
  final_revision=CASE WHEN render_stage='final' THEN p_revision ELSE NULL END,
  render_attempt_id=NULL,render_lease_until=NULL,render_retries=0
 WHERE id=v.id;
 RETURN true;
END $fn$;

CREATE OR REPLACE FUNCTION public.cf_fail_render(p_video bigint,p_attempt uuid,p_error text)
RETURNS boolean LANGUAGE plpgsql SET search_path='' AS $fn$
BEGIN
 UPDATE public.videos SET status='failed',error_message=left(p_error,1800),
  render_attempt_id=NULL,render_lease_until=NULL
 WHERE id=p_video AND status='rendering' AND render_attempt_id=p_attempt;
 RETURN FOUND;
END $fn$;

CREATE OR REPLACE FUNCTION public.cf_release_render(p_video bigint,p_attempt uuid)
RETURNS boolean LANGUAGE plpgsql SET search_path='' AS $fn$
BEGIN
 UPDATE public.videos SET status='queued',render_attempt_id=NULL,render_lease_until=NULL,
  error_message='El servicio se reinició. Se reanudará este render.'
 WHERE id=p_video AND status='rendering' AND render_attempt_id=p_attempt;
 RETURN FOUND;
END $fn$;

CREATE OR REPLACE FUNCTION public.cf_recover_expired_renders()
RETURNS integer LANGUAGE plpgsql SET search_path='' AS $fn$
DECLARE affected integer;
BEGIN
 UPDATE public.videos SET
  status=CASE WHEN render_retries<3 THEN 'queued' ELSE 'failed' END,
  error_message=CASE WHEN render_retries<3 THEN 'Se recuperó un render interrumpido.'
    ELSE 'El render se interrumpió tres veces. Revisá los recursos del servidor antes de reintentar.' END,
  render_retries=render_retries+1,render_attempt_id=NULL,render_lease_until=NULL
 WHERE status='rendering' AND render_lease_until<now();
 GET DIAGNOSTICS affected=ROW_COUNT;
 RETURN affected;
END $fn$;

CREATE OR REPLACE FUNCTION public.cf_invalidate_scene_review()
RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $fn$
DECLARE v public.videos; target_id bigint;
BEGIN
 target_id=CASE WHEN TG_OP='DELETE' THEN OLD.video_id ELSE NEW.video_id END;
 IF TG_OP='UPDATE' THEN
  IF NEW.video_id IS DISTINCT FROM OLD.video_id THEN RAISE EXCEPTION 'No se puede mover una escena a otro video'; END IF;
  IF ROW(NEW.scene_number,NEW.narration,NEW.visual_prompt,NEW.on_screen_text,NEW.image_url,NEW.audio_url)
   IS NOT DISTINCT FROM ROW(OLD.scene_number,OLD.narration,OLD.visual_prompt,OLD.on_screen_text,OLD.image_url,OLD.audio_url) THEN
   RETURN NEW;
  END IF;
 END IF;
 SELECT * INTO v FROM public.videos WHERE id=target_id FOR UPDATE;
 -- Parent deletion can cascade; it does not create a new revision.
 IF NOT FOUND THEN RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END; END IF;
 IF v.status IN ('queued','rendering','publishing','published') OR EXISTS(
  SELECT 1 FROM public.publications WHERE video_id=v.id AND status IN ('scheduled','publishing','published')
 ) THEN RAISE EXCEPTION 'El video está bloqueado. Cancelá la programación o esperá el render antes de editar.'; END IF;
 IF v.render_manifest IS NOT NULL OR v.preview_url IS NOT NULL THEN
  UPDATE public.videos SET content_revision=content_revision+1,render_stage='preview',status='draft',
   approved_revision=NULL,final_revision=NULL,render_url=NULL,render_manifest=NULL,
   render_attempt_id=NULL,render_lease_until=NULL,render_retries=0,error_message=NULL WHERE id=v.id;
 END IF;
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $fn$;
DROP TRIGGER IF EXISTS cf_invalidate_scene_review ON public.scenes;
CREATE TRIGGER cf_invalidate_scene_review BEFORE INSERT OR UPDATE OR DELETE ON public.scenes
 FOR EACH ROW EXECUTE FUNCTION public.cf_invalidate_scene_review();

CREATE OR REPLACE FUNCTION public.cf_invalidate_video_review()
RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $fn$
BEGIN
 IF ROW(NEW.title,NEW.script,NEW.language,NEW.aspect_ratio,NEW.voice_id)
  IS NOT DISTINCT FROM ROW(OLD.title,OLD.script,OLD.language,OLD.aspect_ratio,OLD.voice_id) THEN RETURN NEW; END IF;
 IF OLD.status IN ('queued','rendering','publishing','published') OR EXISTS (
  SELECT 1 FROM public.publications WHERE video_id=OLD.id AND status IN ('scheduled','publishing','published')
 ) THEN RAISE EXCEPTION 'El video está bloqueado para cambios de contenido'; END IF;
 IF OLD.render_manifest IS NOT NULL OR OLD.preview_url IS NOT NULL THEN
  NEW.content_revision=OLD.content_revision+1;
  NEW.render_stage='preview';NEW.status='draft';NEW.approved_revision=NULL;NEW.final_revision=NULL;
  NEW.render_url=NULL;NEW.render_manifest=NULL;NEW.render_attempt_id=NULL;NEW.render_lease_until=NULL;
  NEW.render_retries=0;NEW.error_message=NULL;
 END IF;
 RETURN NEW;
END $fn$;
DROP TRIGGER IF EXISTS cf_invalidate_video_review ON public.videos;
CREATE TRIGGER cf_invalidate_video_review BEFORE UPDATE OF title,script,language,aspect_ratio,voice_id
 ON public.videos FOR EACH ROW EXECUTE FUNCTION public.cf_invalidate_video_review();

CREATE OR REPLACE FUNCTION public.cf_require_approved_hd_publication()
RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $fn$
DECLARE v public.videos;
BEGIN
 IF NEW.status NOT IN ('pending','scheduled','publishing','published') THEN RETURN NEW; END IF;
 SELECT * INTO v FROM public.videos WHERE id=NEW.video_id FOR UPDATE;
 IF NOT FOUND OR v.status NOT IN ('rendered','approved','publishing','published') OR
  v.render_stage<>'final' OR v.final_revision IS DISTINCT FROM v.content_revision OR
  v.approved_revision IS DISTINCT FROM v.content_revision OR nullif(v.render_url,'') IS NULL OR NOT EXISTS (
   SELECT 1 FROM public.cf_video_reviews WHERE video_id=v.id AND verdict='approved' AND content_revision=v.content_revision
  ) THEN RAISE EXCEPTION 'Solo se puede programar o publicar el HD de la versión aprobada'; END IF;
 RETURN NEW;
END $fn$;
DROP TRIGGER IF EXISTS cf_require_approved_hd_publication ON public.publications;
CREATE TRIGGER cf_require_approved_hd_publication BEFORE INSERT OR UPDATE OF status,video_id ON public.publications
 FOR EACH ROW EXECUTE FUNCTION public.cf_require_approved_hd_publication();

-- Wake a sleeping renderer using the existing private outbox and configured credential.
CREATE OR REPLACE FUNCTION lumi_private.enqueue_video_render()
RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $fn$
BEGIN
 IF NEW.status IN ('draft','queued') AND (
  OLD.status IS DISTINCT FROM NEW.status OR OLD.content_revision IS DISTINCT FROM NEW.content_revision
 ) THEN
  INSERT INTO lumi_private.render_outbox(video_id) VALUES (NEW.id)
  ON CONFLICT(video_id) DO UPDATE SET state='waiting',attempts=0,request_id=NULL,
   next_attempt_at=now(),created_at=now(),updated_at=now(),last_error=NULL;
 END IF;
 RETURN NEW;
END $fn$;
DROP TRIGGER IF EXISTS lumi_enqueue_video_render ON public.videos;
CREATE TRIGGER lumi_enqueue_video_render AFTER UPDATE OF status,content_revision ON public.videos
 FOR EACH ROW EXECUTE FUNCTION lumi_private.enqueue_video_render();

REVOKE ALL ON FUNCTION public.cf_claim_render(bigint,uuid),public.cf_save_render_manifest(bigint,uuid,integer,jsonb),
 public.cf_renew_render_lease(bigint,uuid),public.cf_complete_render(bigint,uuid,integer,text,numeric),
 public.cf_fail_render(bigint,uuid,text),public.cf_release_render(bigint,uuid),public.cf_recover_expired_renders(),
 public.cf_invalidate_scene_review(),public.cf_invalidate_video_review(),public.cf_require_approved_hd_publication(),
 lumi_private.enqueue_video_render() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.cf_claim_render(bigint,uuid),public.cf_save_render_manifest(bigint,uuid,integer,jsonb),
 public.cf_renew_render_lease(bigint,uuid),public.cf_complete_render(bigint,uuid,integer,text,numeric),
 public.cf_fail_render(bigint,uuid,text),public.cf_release_render(bigint,uuid),public.cf_recover_expired_renders()
 TO service_role;

CREATE OR REPLACE FUNCTION public.cf_bot_command(p_user bigint, p_chat bigint, p_key text, p_action text, p_args jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
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
 elsif p_action in ('approve','reject','retry_render') then
  select * into v from public.videos where id=(p_args->>'video')::bigint and channel_id=a.channel_id for update;
  if not found then raise exception 'Video inexistente'; end if;
  if (p_args->>'revision')::integer is distinct from v.content_revision then
   raise exception 'Este botón corresponde a otra versión. Volvé a abrir el video.';
  end if;
  if exists(select 1 from public.publications where video_id=v.id and status in ('scheduled','publishing','published')) then
   raise exception 'Primero cancelá su programación. Un contenido publicado no se rechaza desde aquí.';
  end if;
  if p_action='retry_render' then
   if v.status<>'failed' then raise exception 'Este video no necesita un reintento'; end if;
   if v.render_stage='final' and (
    v.approved_revision is distinct from v.content_revision or not exists (
     select 1 from public.cf_video_reviews where video_id=v.id and verdict='approved' and content_revision=v.content_revision
    )
   ) then raise exception 'Revisá y aprobá la vista previa antes de reintentar HD'; end if;
   update public.videos set status=case when render_stage='final' then 'queued' else 'draft' end,
    render_retries=0,render_attempt_id=null,render_lease_until=null,error_message=null where id=v.id;
   result=jsonb_build_object('video_id',v.id,'stage',v.render_stage,'retry',true);
  elsif p_action='approve' and v.render_stage='final' and v.approved_revision=v.content_revision then
   result=jsonb_build_object('video_id',v.id,'verdict','approved','stage','final','duplicate',true);
  else
   if v.status<>'rendered' or v.preview_revision is distinct from v.content_revision or nullif(v.preview_url,'') is null then
    raise exception 'Esta versión todavía no tiene una vista previa lista para revisar';
   end if;
   insert into public.cf_video_reviews(video_id,verdict,reviewed_by,reason,content_revision)
    values(v.id,case when p_action='approve' then 'approved' else 'rejected' end,p_user,left(p_args->>'reason',500),v.content_revision)
    on conflict(video_id) do update set verdict=excluded.verdict,reviewed_by=p_user,
     reason=excluded.reason,reviewed_at=now(),content_revision=excluded.content_revision;
   if p_action='approve' then
    update public.videos set status='queued',render_stage='final',approved_revision=content_revision,
     final_revision=null,error_message=null,render_retries=0 where id=v.id;
   else
    update public.videos set status='rendered',render_stage='preview',approved_revision=null,
     final_revision=null,render_url=preview_url where id=v.id;
   end if;
   result=jsonb_build_object('video_id',v.id,'verdict',p_action,'stage',case when p_action='approve' then 'final' else 'preview' end);
  end if;
 elsif p_action='draft' then
  select * into v from public.videos where id=(p_args->>'video')::bigint and channel_id=a.channel_id for update;
  if not found or v.status not in ('rendered','approved') or nullif(v.render_url,'') is null or (v.render_stage<>'final' or v.final_revision is distinct from v.content_revision or v.approved_revision is distinct from v.content_revision or not exists(select 1 from public.cf_video_reviews where video_id=v.id and verdict='approved' and content_revision=v.content_revision)) then raise exception 'Esperá al HD de la versión aprobada antes de programarlo'; end if;
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
  if not found or v.status not in ('rendered','approved') or nullif(v.render_url,'') is null or (v.render_stage<>'final' or v.final_revision is distinct from v.content_revision or v.approved_revision is distinct from v.content_revision or not exists(select 1 from public.cf_video_reviews where video_id=v.id and verdict='approved' and content_revision=v.content_revision)) then raise exception 'El HD de la versión aprobada todavía no está listo'; end if;
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
end $function$;
CREATE OR REPLACE FUNCTION lumi_private.dispatch_render_outbox()
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE j record; response record; v_status text; ready boolean; token text;
 sent integer:=0; rid bigint; payload jsonb;
BEGIN
 IF NOT pg_try_advisory_xact_lock(174812,5) THEN RETURN 0; END IF;
 FOR j IN SELECT * FROM lumi_private.render_outbox
  WHERE state IN ('waiting','submitted') AND next_attempt_at<=now()
  ORDER BY next_attempt_at LIMIT 20 FOR UPDATE SKIP LOCKED
 LOOP
  SELECT status INTO v_status FROM public.videos WHERE id=j.video_id;
  IF v_status IS NULL OR v_status NOT IN ('draft','queued') THEN
   UPDATE lumi_private.render_outbox SET state='done',updated_at=now(),last_error=NULL WHERE video_id=j.video_id;
   CONTINUE;
  END IF;
  IF j.state='submitted' THEN
   SELECT status_code,timed_out INTO response FROM net._http_response WHERE id=j.request_id;
   IF NOT FOUND AND j.updated_at > now()-interval '2 minutes' THEN CONTINUE; END IF;
   IF response.status_code IN (401,403) THEN
    UPDATE lumi_private.render_outbox SET state='error',last_error='Renderer authentication rejected',updated_at=now() WHERE video_id=j.video_id;
    CONTINUE;
   END IF;
   -- A delivery is only finished when the renderer has durably claimed the video.
   IF j.attempts>=8 THEN
    UPDATE lumi_private.render_outbox SET state='error',last_error='Eight dispatch attempts exhausted; inspect renderer',updated_at=now() WHERE video_id=j.video_id;
   ELSE
    UPDATE lumi_private.render_outbox SET state='waiting',next_attempt_at=now()+make_interval(secs=>least(600,30*power(2,j.attempts)::integer)),last_error='Renderer did not claim video; retry scheduled',updated_at=now() WHERE video_id=j.video_id;
   END IF;
   CONTINUE;
  END IF;
  IF v_status='queued' THEN ready:=true;
  ELSE SELECT is_ready INTO ready FROM public.video_render_readiness WHERE video_id=j.video_id; END IF;
  IF ready IS DISTINCT FROM true THEN
   UPDATE lumi_private.render_outbox SET next_attempt_at=now()+interval '1 minute',
    state=CASE WHEN created_at<now()-interval '24 hours' THEN 'error' ELSE 'waiting' END,
    last_error=CASE WHEN created_at<now()-interval '24 hours' THEN 'Assets or script not ready after 24 hours' ELSE NULL END
    WHERE video_id=j.video_id;
   CONTINUE;
  END IF;
  SELECT decrypted_secret INTO token FROM vault.decrypted_secrets WHERE name='lumi_render_api_token';
  IF nullif(token,'') IS NULL THEN
   UPDATE lumi_private.render_outbox SET state='error',last_error='Missing lumi_render_api_token',updated_at=now() WHERE video_id=j.video_id;
   CONTINUE;
  END IF;
  rid:=net.http_post(url:=CASE WHEN v_status='queued' THEN 'https://content-factory-renderer.onrender.com/render' ELSE 'https://content-factory-renderer.onrender.com/render-if-ready' END,
   body:=jsonb_build_object('video_id',j.video_id),
   headers:=jsonb_build_object('Content-Type','application/json','x-render-token',token),
   timeout_milliseconds:=60000);
  UPDATE lumi_private.render_outbox SET state='submitted',request_id=rid,attempts=attempts+1,
   updated_at=now(),next_attempt_at=now()+interval '1 minute',last_error=NULL WHERE video_id=j.video_id;
  sent:=sent+1;
 END LOOP;
 RETURN sent;
END $function$;
