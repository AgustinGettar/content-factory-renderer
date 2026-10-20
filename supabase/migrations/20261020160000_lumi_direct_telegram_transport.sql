-- Extend the existing transport receipt map, not production/budget journals.
-- No data migration and no episode writes. Service role only.
create or replace function public.lumi_direct_telegram_v1(p jsonb)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare
  u text:=p->>'user_id'; b text:=p->>'bot_id'; k text:=p->>'key';
  phase text:=p->>'phase'; s jsonb; rev bigint; r jsonb; receipts jsonb;
  t text:=to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
begin
  if phase='READINESS' then return jsonb_build_object('version',1); end if;
  if u !~ '^[0-9]+$' or b !~ '^[0-9]+$' or u is null or b is null
    or k is null or (k !~ ('^direct:'||b||':(update:[0-9]+|notice:[a-f0-9]{64}|baseline)$'))
    then raise exception 'DIRECT_IDENTITY_INVALID'; end if;
  -- One globally unique bot/update key even across owners. Row lock also fences
  -- concurrent ordinary CAS writes; their revision predicate will fail safely.
  perform pg_advisory_xact_lock(hashtextextended(k,0));
  if k like 'direct:'||b||':update:%' and exists(select 1 from public.lumi_telegram_review_sessions x
    where x.user_id::text<>u and x.state->'make_requests' ? k)
    then raise exception 'DIRECT_UPDATE_OWNER_CONFLICT'; end if;
  select state,revision into s,rev from public.lumi_telegram_review_sessions
    where user_id::text=u for update;
  if s is null or s->>'user_id'<>u or s->>'chat_id'<>u or not exists(
    select 1 from public.cf_bot_admins where user_id::text=u and chat_id::text=u and active=true)
    then raise exception 'DIRECT_OWNER_REQUIRED'; end if;
  receipts:=coalesce(s->'make_requests','{}'::jsonb); r:=receipts->k;
  if phase='BASELINE' then
    if r is not null then return r; end if;
    if k<>'direct:'||b||':baseline' or jsonb_typeof(p->'notices')<>'array' or jsonb_array_length(p->'notices')>2000
      then raise exception 'DIRECT_BASELINE_INVALID'; end if;
    r:=jsonb_build_object('transport','TELEGRAM_DIRECT','status','BASELINE','notices',p->'notices','created_at',t);
  elsif phase='ACCEPT' then
    if coalesce(p->>'payload_hash','') !~ '^[a-f0-9]{64}$' or coalesce(p->>'kind','') not in
      ('STUDIO_ENTRY','LEGACY_CALLBACK','STALE_CALLBACK','UNSUPPORTED','REVIEW_READY','MASTER_READY')
      then raise exception 'DIRECT_EVENT_INVALID'; end if;
    if r is not null then
      if r->>'payload_hash' is distinct from p->>'payload_hash' then raise exception 'DIRECT_UPDATE_CONFLICT'; end if;
      return r;
    end if;
    if (select count(*) from jsonb_object_keys(receipts))>=5000 then raise exception 'DIRECT_RECEIPT_CAPACITY'; end if;
    r:=jsonb_build_object('transport','TELEGRAM_DIRECT','bot_id',b,'key',k,
      'payload_hash',p->>'payload_hash','kind',p->>'kind','created_at',t,'status','QUEUED');
    if k like 'direct:'||b||':update:%' then
      if split_part(k,':',4) is distinct from p->>'update_id' then raise exception 'DIRECT_UPDATE_CONFLICT'; end if;
      r:=r||jsonb_build_object('update_id',p->'update_id');
      -- An old Make claim is evidence of prior acceptance, NOT of non-emission.
      if exists(select 1 from jsonb_each(receipts) x where x.value->>'transport' is distinct from 'TELEGRAM_DIRECT'
        and x.value->>'update_id'=p->>'update_id') then
        r:=r||jsonb_build_object('status','LEGACY_HELD','reason','PRIOR_MAKE_ACCEPTANCE');
      end if;
    elsif k not like 'direct:'||b||':notice:%' then raise exception 'DIRECT_EVENT_KEY_INVALID'; end if;
    if p->>'kind'='UNSUPPORTED' then r:=r||'{"status":"IGNORED"}'::jsonb; end if;
    if p->>'kind' in ('LEGACY_CALLBACK','STALE_CALLBACK') then
      if coalesce(p->>'callback_id','') !~ '^[A-Za-z0-9_-]{1,128}$' then raise exception 'DIRECT_CALLBACK_INVALID'; end if;
      r:=r||jsonb_build_object('callback_id',p->>'callback_id');
    end if;
  elsif phase='CLAIM' then
    if r->>'status' is distinct from 'QUEUED' then return coalesce(r,'{}'::jsonb); end if;
    if coalesce(p->>'dispatch_id','') !~ '^[a-f0-9-]{36}$' then raise exception 'DIRECT_CLAIM_INVALID'; end if;
    r:=r||jsonb_build_object('status','DISPATCHING','dispatch_id',p->>'dispatch_id','dispatch_at',t);
  elsif phase='FINISH' then
    if r->>'status' is distinct from 'DISPATCHING' or r->>'dispatch_id' is distinct from p->>'dispatch_id'
      then raise exception 'DIRECT_CLAIM_CONFLICT'; end if;
    if coalesce(p->>'status','') not in ('DELIVERED','UNKNOWN','REJECTED') then raise exception 'DIRECT_OUTCOME_INVALID'; end if;
    if p->>'status'='DELIVERED' and not coalesce((
      p->'receipt'->>'chat_id'=u and (p->'receipt'->>'message_id') ~ '^[1-9][0-9]*$'
      or p->'receipt'->>'callback_answered'='true' and r->>'kind' in ('LEGACY_CALLBACK','STALE_CALLBACK')),false)
      then raise exception 'DIRECT_RECEIPT_INVALID'; end if;
    r:=r||jsonb_build_object('status',p->>'status','finished_at',t,'receipt',jsonb_strip_nulls(jsonb_build_object(
      'message_id',p->'receipt'->'message_id','chat_id',p->'receipt'->'chat_id','date',p->'receipt'->'date',
      'callback_answered',p->'receipt'->'callback_answered')));
  else raise exception 'DIRECT_PHASE_INVALID'; end if;
  s:=jsonb_set(s,'{make_requests}',receipts||jsonb_build_object(k,r),true);
  update public.lumi_telegram_review_sessions set state=s,revision=rev+1,updated_at=clock_timestamp()
    where user_id::text=u and revision=rev;
  if not found then raise exception 'DIRECT_CAS_CONFLICT'; end if;
  return r;
end $$;
revoke all on function public.lumi_direct_telegram_v1(jsonb) from public,anon,authenticated;
grant execute on function public.lumi_direct_telegram_v1(jsonb) to service_role;
