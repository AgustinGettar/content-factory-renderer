BEGIN;
SET LOCAL statement_timeout='20s';
DO $test$
DECLARE claim jsonb; manifest jsonb; result jsonb; v public.videos; ok boolean;
 attempt uuid='11111111-1111-4111-8111-111111111111';
 final_attempt uuid='22222222-2222-4222-8222-222222222222';
BEGIN
 IF EXISTS(SELECT 1 FROM public.channels WHERE id=-901401) OR EXISTS(SELECT 1 FROM public.videos WHERE id=-901401) THEN
  RAISE EXCEPTION 'Fixture ID occupied'; END IF;
 INSERT INTO public.channels(id,name,slug,timezone) VALUES(-901401,'LD HD transaction test','ld-hd-transaction-test','UTC');
 INSERT INTO public.cf_bot_admins(user_id,chat_id,channel_id) VALUES(-901401,-901401,-901401);
 INSERT INTO public.ideas(id,channel_id,idea,status) VALUES(-901401,-901401,'Transactional preview test','scripted');
 INSERT INTO public.videos(id,idea_id,channel_id,title,status,aspect_ratio) VALUES(-901401,-901401,-901401,'Preview test','draft','9:16');
 INSERT INTO public.scenes(id,video_id,scene_number,narration,image_url,audio_url,status)
 VALUES(-901401,-901401,1,'Hola Lumi','https://example.test/image.png','https://example.test/audio.mp3','ready');
 UPDATE public.videos SET status='queued' WHERE id=-901401;
 claim=public.cf_claim_render(-901401,attempt);
 IF claim->'video'->>'render_stage'<>'preview' THEN RAISE EXCEPTION 'Initial render was not preview'; END IF;
 IF public.cf_claim_render(-901401,final_attempt) IS NOT NULL THEN RAISE EXCEPTION 'Duplicate worker claim accepted'; END IF;
 manifest=claim->'manifest';
 manifest=jsonb_set(manifest,'{scenes,0,image_sha256}',to_jsonb(repeat('a',64)));
 manifest=jsonb_set(manifest,'{scenes,0,audio_sha256}',to_jsonb(repeat('b',64)));
 IF NOT public.cf_save_render_manifest(-901401,attempt,1,manifest) THEN RAISE EXCEPTION 'Manifest save failed'; END IF;
 IF NOT public.cf_complete_render(-901401,attempt,1,'https://example.test/preview.mp4',2) THEN RAISE EXCEPTION 'Preview finish failed'; END IF;
 SELECT * INTO v FROM public.videos WHERE id=-901401;
 IF v.preview_revision<>1 OR v.final_revision IS NOT NULL THEN RAISE EXCEPTION 'Preview/final provenance mixed'; END IF;
 BEGIN
  INSERT INTO public.publications(id,video_id,channel_id,platform,status) VALUES(-901401,-901401,-901401,'youtube','scheduled');
  RAISE EXCEPTION 'BUG preview publication allowed';
 EXCEPTION WHEN OTHERS THEN IF SQLERRM NOT LIKE 'Solo se puede%' THEN RAISE; END IF; END;
 BEGIN
  PERFORM public.cf_bot_command(-901401,-901401,'test-stale','approve','{"video":-901401,"revision":2}');
  RAISE EXCEPTION 'BUG stale revision approved';
 EXCEPTION WHEN OTHERS THEN IF SQLERRM NOT LIKE 'Este botón%' THEN RAISE; END IF; END;
 PERFORM public.cf_bot_command(-901401,-901401,'test-reject','reject','{"video":-901401,"revision":1,"reason":"visual"}');
 SELECT * INTO v FROM public.videos WHERE id=-901401;
 IF v.render_stage<>'preview' OR v.approved_revision IS NOT NULL THEN RAISE EXCEPTION 'Rejection queued HD'; END IF;
 PERFORM public.cf_bot_command(-901401,-901401,'test-approve','approve','{"video":-901401,"revision":1}');
 result=public.cf_bot_command(-901401,-901401,'test-approve-again','approve','{"video":-901401,"revision":1}');
 IF (result->>'duplicate')::boolean IS DISTINCT FROM true THEN RAISE EXCEPTION 'Second approval not deduplicated'; END IF;
 SELECT * INTO v FROM public.videos WHERE id=-901401;
 IF v.status<>'queued' OR v.render_stage<>'final' OR v.approved_revision<>1 THEN RAISE EXCEPTION 'Approval did not queue HD'; END IF;
 IF v.render_manifest<>manifest THEN RAISE EXCEPTION 'Approved manifest changed'; END IF;
 IF (SELECT count(*) FROM lumi_private.render_outbox WHERE video_id=-901401)<>1 THEN RAISE EXCEPTION 'Duplicate outbox jobs'; END IF;
 BEGIN
  PERFORM public.cf_bot_command(-901401,-901401,'test-too-early','draft','{"video":-901401}');
  RAISE EXCEPTION 'BUG scheduled before HD';
 EXCEPTION WHEN OTHERS THEN IF SQLERRM NOT LIKE 'Esperá al HD%' THEN RAISE; END IF; END;
 claim=public.cf_claim_render(-901401,final_attempt);
 IF claim->'manifest'<>manifest THEN RAISE EXCEPTION 'Final did not reuse preview manifest'; END IF;
 BEGIN
  UPDATE public.scenes SET narration='Changed during render' WHERE id=-901401;
  RAISE EXCEPTION 'BUG mutation during render accepted';
 EXCEPTION WHEN OTHERS THEN IF SQLERRM NOT LIKE 'El video está bloqueado%' THEN RAISE; END IF; END;
 IF public.cf_complete_render(-901401,attempt,1,'https://example.test/stale.mp4',2) THEN RAISE EXCEPTION 'Stale attempt completed'; END IF;
 IF NOT public.cf_fail_render(-901401,final_attempt,'test transient failure') THEN RAISE EXCEPTION 'Failure not recorded'; END IF;
 PERFORM public.cf_bot_command(-901401,-901401,'test-retry','retry_render','{"video":-901401,"revision":1}');
 SELECT * INTO v FROM public.videos WHERE id=-901401;
 IF v.status<>'queued' OR v.render_stage<>'final' OR v.approved_revision<>1 OR v.render_manifest<>manifest THEN
  RAISE EXCEPTION 'Retry lost approval or assets'; END IF;
 claim=public.cf_claim_render(-901401,final_attempt);
 IF NOT public.cf_complete_render(-901401,final_attempt,1,'https://example.test/final.mp4',2) THEN RAISE EXCEPTION 'HD finish failed'; END IF;
 SELECT * INTO v FROM public.videos WHERE id=-901401;
 IF v.final_revision<>1 OR v.preview_url<>'https://example.test/preview.mp4' OR v.render_url<>'https://example.test/final.mp4' THEN
  RAISE EXCEPTION 'Preview/final URLs not retained'; END IF;
 INSERT INTO public.publications(id,video_id,channel_id,platform,status) VALUES(-901401,-901401,-901401,'youtube','pending');
 UPDATE public.publications SET status='cancelled' WHERE id=-901401;
 UPDATE public.scenes SET narration='Changed after review' WHERE id=-901401;
 SELECT * INTO v FROM public.videos WHERE id=-901401;
 IF v.content_revision<>2 OR v.status<>'draft' OR v.approved_revision IS NOT NULL OR v.final_revision IS NOT NULL OR v.render_manifest IS NOT NULL THEN
  RAISE EXCEPTION 'Content edit did not invalidate review'; END IF;
 BEGIN
  UPDATE public.publications SET status='scheduled' WHERE id=-901401;
  RAISE EXCEPTION 'BUG old HD published after content edit';
 EXCEPTION WHEN OTHERS THEN IF SQLERRM NOT LIKE 'Solo se puede%' THEN RAISE; END IF; END;
 IF has_function_privilege('anon','public.cf_claim_render(bigint,uuid)','EXECUTE') THEN RAISE EXCEPTION 'Anonymous render access'; END IF;
END $test$;
ROLLBACK;
SELECT 'passed: preview, rejection, approval, duplicate/stale buttons, immutable snapshot, HD retry, publication gate, revision invalidation; all fixture rows rolled back' AS result;