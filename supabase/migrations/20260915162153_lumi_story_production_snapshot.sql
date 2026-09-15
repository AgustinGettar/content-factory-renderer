CREATE OR REPLACE FUNCTION public.cf_claim_render(p_video bigint, p_attempt uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
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
    'image_url',s.image_url,'audio_url',s.audio_url,'production',s.metadata->'production') ORDER BY s.scene_number)
  ) INTO manifest FROM public.scenes s WHERE s.video_id=v.id;
 END IF;
 UPDATE public.videos SET status='rendering',render_attempt_id=p_attempt,
  render_lease_until=now()+interval '2 minutes',render_manifest=manifest,error_message=NULL
  WHERE id=v.id RETURNING * INTO v;
 RETURN jsonb_build_object('video',to_jsonb(v),'manifest',manifest);
END $function$;

CREATE OR REPLACE FUNCTION public.cf_invalidate_scene_review()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE v public.videos; target_id bigint;
BEGIN
 target_id=CASE WHEN TG_OP='DELETE' THEN OLD.video_id ELSE NEW.video_id END;
 IF TG_OP='UPDATE' THEN
  IF NEW.video_id IS DISTINCT FROM OLD.video_id THEN RAISE EXCEPTION 'No se puede mover una escena a otro video'; END IF;
  IF ROW(NEW.scene_number,NEW.narration,NEW.visual_prompt,NEW.on_screen_text,NEW.image_url,NEW.audio_url,NEW.metadata->'production')
   IS NOT DISTINCT FROM ROW(OLD.scene_number,OLD.narration,OLD.visual_prompt,OLD.on_screen_text,OLD.image_url,OLD.audio_url,OLD.metadata->'production') THEN
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
END $function$;
