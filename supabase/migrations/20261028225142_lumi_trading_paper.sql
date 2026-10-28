-- Independent staging paper ledger. No audiovisual/session writes and no UI API.
create table public.lumi_trading_state (
 id text primary key check(id='KRAKEN_BTCUSD_PAPER'),
 revision bigint not null default 0, fence bigint not null default 0,
 lease_owner uuid, lease_until timestamptz, last_batch text,
 state jsonb not null default '{}'::jsonb, updated_at timestamptz not null default now()
);
insert into public.lumi_trading_state(id) values ('KRAKEN_BTCUSD_PAPER');
create table public.lumi_trading_events (
 id text primary key, created_at timestamptz not null default now(),
 kind text not null, payload jsonb not null
);
create index lumi_trading_events_kind_time on public.lumi_trading_events(kind,created_at);
create table public.lumi_trading_outbox (
 id text primary key, kind text not null check(kind in ('SIGNAL','RESULT','SUMMARY','TECHNICAL','VERSION')),
 payload jsonb not null, status text not null default 'QUEUED'
 check(status in ('QUEUED','DISPATCHING','DELIVERED','REJECTED','UNKNOWN','EXPIRED')),
 created_at timestamptz not null default now(), attempted_at timestamptz,
 finished_at timestamptz, claim_id uuid, receipt jsonb, reason text
);
create index lumi_trading_outbox_status on public.lumi_trading_outbox(status,created_at);
alter table public.lumi_trading_state enable row level security;
alter table public.lumi_trading_events enable row level security;
alter table public.lumi_trading_outbox enable row level security;
revoke all on public.lumi_trading_state,public.lumi_trading_events,public.lumi_trading_outbox from public,anon,authenticated;
grant select,update on public.lumi_trading_state to service_role;
grant select,insert on public.lumi_trading_events to service_role;
grant select,insert,update on public.lumi_trading_outbox to service_role;
-- Defense in depth for installations where service_role does not bypass RLS.
create policy trading_state_backend on public.lumi_trading_state to service_role using(true) with check(true);
create policy trading_events_backend_read on public.lumi_trading_events for select to service_role using(true);
create policy trading_events_backend_append on public.lumi_trading_events for insert to service_role with check(true);
create policy trading_outbox_backend on public.lumi_trading_outbox to service_role using(true) with check(true);

create function public.lumi_trading_tx(p jsonb) returns jsonb
language plpgsql security invoker set search_path=pg_catalog,public as $$
declare s public.lumi_trading_state; o public.lumi_trading_outbox; e jsonb; prev jsonb;
 owner_id uuid:=(p->>'owner')::uuid; stamp timestamptz:=clock_timestamp(); phase text:=p->>'phase';
begin
 if octet_length(p::text)>8000000 then raise exception 'TRADING_PAYLOAD_LIMIT'; end if;
 select * into s from public.lumi_trading_state where id='KRAKEN_BTCUSD_PAPER' for update;
 if phase='ACQUIRE' then
  if s.lease_until>stamp and s.lease_owner is distinct from owner_id then raise exception 'TRADING_LEASE_BUSY'; end if;
  if s.lease_owner is distinct from owner_id or s.lease_until<=stamp then
   s.fence:=s.fence+1;
   update public.lumi_trading_outbox set status='UNKNOWN',reason='PROCESS_RESTART_DURING_SEND',finished_at=stamp where status='DISPATCHING';
  end if;
  update public.lumi_trading_state set lease_owner=owner_id,lease_until=stamp+interval '45 seconds',fence=s.fence where id=s.id returning * into s;
  return to_jsonb(s);
 end if;
 if s.lease_owner is distinct from owner_id or s.lease_until<=stamp or s.fence<>(p->>'fence')::bigint then raise exception 'TRADING_LEASE_LOST'; end if;
 if phase='RENEW' then
  update public.lumi_trading_state set lease_until=stamp+interval '45 seconds' where id=s.id;
  return jsonb_build_object('ok',true);
 elsif phase='COMMIT' then
  if p->>'batch'=s.last_batch then return jsonb_build_object('revision',s.revision); end if;
  if s.revision<>(p->>'revision')::bigint then raise exception 'TRADING_CAS_CONFLICT'; end if;
  for e in select value from jsonb_array_elements(coalesce(p->'events','[]')) loop
   select payload into prev from public.lumi_trading_events where id=e->>'id';
   if found and prev<>e->'payload' then raise exception 'TRADING_EVENT_CONFLICT'; end if;
   insert into public.lumi_trading_events(id,kind,payload) values(e->>'id',e->>'kind',e->'payload') on conflict(id) do nothing;
  end loop;
  for e in select value from jsonb_array_elements(coalesce(p->'notices','[]')) loop
   select payload into prev from public.lumi_trading_outbox where id=e->>'id';
   if found and prev<>e->'payload' then raise exception 'TRADING_NOTICE_CONFLICT'; end if;
   insert into public.lumi_trading_outbox(id,kind,payload) values(e->>'id',e->>'kind',e->'payload') on conflict(id) do nothing;
  end loop;
  update public.lumi_trading_state set state=p->'state',revision=revision+1,last_batch=p->>'batch',updated_at=stamp where id=s.id returning * into s;
  return jsonb_build_object('revision',s.revision);
 elsif phase='CLAIM' then
  select * into o from public.lumi_trading_outbox where id=p->>'id' for update;
  if not found or o.status<>'QUEUED' then return coalesce(to_jsonb(o),'{}'); end if;
  if o.kind='SIGNAL' and (to_timestamp((o.payload->'plan'->>'decision_at')::double precision/1000)+interval '30 seconds'<stamp or to_timestamp((o.payload->'plan'->>'expires_at')::double precision/1000)<=stamp) then
   update public.lumi_trading_outbox set status='EXPIRED',reason='NOTICE_EXPIRED',finished_at=stamp where id=o.id returning * into o;
  else
   update public.lumi_trading_outbox set status='DISPATCHING',claim_id=(p->>'claim_id')::uuid,attempted_at=stamp where id=o.id returning * into o;
  end if;
  return to_jsonb(o);
 elsif phase='FINISH' then
  if p->>'status' not in ('DELIVERED','REJECTED','UNKNOWN','EXPIRED') then raise exception 'TRADING_INVALID_STATUS'; end if;
  update public.lumi_trading_outbox set status=p->>'status',receipt=p->'receipt',reason=p->>'reason',finished_at=stamp
   where id=p->>'id' and status='DISPATCHING' and claim_id=(p->>'claim_id')::uuid returning * into o;
  if not found then raise exception 'TRADING_CLAIM_CONFLICT'; end if;
  return to_jsonb(o);
 elsif phase='RELEASE' then
  update public.lumi_trading_state set lease_until=stamp where id=s.id;return jsonb_build_object('ok',true);
 end if;
 raise exception 'TRADING_PHASE_INVALID';
end;$$;
revoke all on function public.lumi_trading_tx(jsonb) from public,anon,authenticated;
grant execute on function public.lumi_trading_tx(jsonb) to service_role;
