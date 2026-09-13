-- Run against the existing channel with an administrator and a rendered video.
-- Every write, including queued webhook calls, is rolled back.
begin;
do $$
declare a public.cf_bot_admins; vid bigint; d jsonb; j jsonb; r jsonb; n integer;
begin
 select * into a from public.cf_bot_admins where active limit 1;
 select id into vid from public.videos where channel_id=a.channel_id and status='rendered' and render_url is not null limit 1;
 if vid is null then raise exception 'Needs one rendered video'; end if;
 begin
  perform public.cf_bot_command(a.user_id,a.chat_id+1,'qa:auth','approve',jsonb_build_object('video',vid));
  raise exception 'FAIL authorization';
 exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;
 begin
  perform public.cf_bot_command(a.user_id,a.chat_id,'qa:unapproved','draft',jsonb_build_object('video',vid));
  raise exception 'FAIL unapproved';
 exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;
 perform public.cf_bot_command(a.user_id,a.chat_id,'qa:approve','approve',jsonb_build_object('video',vid));
 perform public.cf_bot_command(a.user_id,a.chat_id,'qa:approve','approve',jsonb_build_object('video',vid));
 if (select count(*) from public.cf_bot_audit where action='approve' and entity_id=vid::text)<>1 then raise exception 'FAIL duplicate review'; end if;
 d=public.cf_bot_command(a.user_id,a.chat_id,'qa:draft','draft',jsonb_build_object('video',vid));
 d=public.cf_bot_command(a.user_id,a.chat_id,'qa:toggle','toggle',jsonb_build_object('draft',d->>'id','platform','instagram'));
 if (d->'platforms') ? 'instagram' then raise exception 'FAIL platform toggle'; end if;
 begin
  perform public.cf_bot_command(a.user_id,a.chat_id,'qa:missing','schedule',jsonb_build_object('draft',d->>'id'));
  raise exception 'FAIL unconnected platform';
 exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;
 update public.cf_bot_settings set integrations='{"youtube":"ready","tiktok":"ready","instagram":"ready"}' where id;
 r=public.cf_bot_command(a.user_id,a.chat_id,'qa:schedule','schedule',jsonb_build_object('draft',d->>'id'));
 r=public.cf_bot_command(a.user_id,a.chat_id,'qa:scheduleagain','schedule',jsonb_build_object('draft',d->>'id'));
 if (select count(*) from public.publications where video_id=vid and status='scheduled')<>2 then raise exception 'FAIL duplicate publication'; end if;
 begin
  perform public.cf_bot_command(a.user_id,a.chat_id,'qa:rejectscheduled','reject',jsonb_build_object('video',vid));
  raise exception 'FAIL reject scheduled';
 exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;
 begin
  perform public.cf_bot_command(a.user_id,a.chat_id,'qa:dst','draft',jsonb_build_object('video',vid,'local','2026-10-25T02:30:00'));
  raise exception 'FAIL ambiguous DST';
 exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;
 j=public.cf_bot_command(a.user_id,a.chat_id,'qa:aistart','ai_start','{"kind":"ideas"}');
 r=public.cf_bot_command(a.user_id,a.chat_id,'qa:aistart','ai_start','{"kind":"ideas"}');
 if not (r->>'cached')::boolean then raise exception 'FAIL AI replay cache'; end if;
 if has_function_privilege('anon','public.cf_bot_command(bigint,bigint,text,text,jsonb)','EXECUTE') then raise exception 'FAIL anonymous RPC'; end if;
 if has_table_privilege('authenticated','public.cf_bot_settings','SELECT') then raise exception 'FAIL settings exposure'; end if;
end $$;
rollback;
