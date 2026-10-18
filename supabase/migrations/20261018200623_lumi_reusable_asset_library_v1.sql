-- Additive staging catalog. Original storage, episodes and approvals are untouched.
create table public.lumi_library_assets (
  asset_id text primary key check (asset_id ~ '^[a-f0-9]{64}$'),
  owner_id bigint not null,
  series_key text not null check (series_key ~ '^[a-f0-9]{64}$'),
  asset_type text not null check (asset_type in ('CHARACTER_REFERENCE','SCENE_REFERENCE','APPROVED_IMAGE','APPROVED_VIDEO','BACKGROUND','MASTER')),
  subject_key text not null default '',
  display_name text not null,
  description text not null,
  source_episode_id text not null,
  source_shot_id text,
  storage_reference jsonb not null,
  sha256 text not null check (sha256 ~ '^[a-f0-9]{64}$'),
  media_type text not null check (media_type in ('image/png','image/jpeg','video/mp4')),
  size_bytes bigint not null check (size_bytes > 0 and size_bytes <= 100000000),
  dimensions jsonb not null,
  duration numeric,
  approval_status text not null check (approval_status in ('HUMAN_APPROVED','PENDING_VERIFICATION')),
  approval_reference jsonb not null,
  version integer not null check (version > 0),
  created_at timestamptz not null default now(),
  reuse_policy jsonb not null,
  continuity_tags jsonb not null default '[]',
  canonical_reference jsonb,
  integrity_verified_at timestamptz not null,
  unique(owner_id,series_key,version),
  check (jsonb_typeof(storage_reference)='object' and storage_reference ?& array['bucket','path']),
  check ((storage_reference->>'path') !~ '(^/|\.\.|://)' and (storage_reference->>'bucket') ~ '^[a-z0-9-]+$'),
  check (dimensions ?& array['width','height']),
  check ((dimensions->>'width')::integer > 0 and (dimensions->>'height')::integer > 0),
  check ((media_type='video/mp4' and duration>0) or (media_type like 'image/%' and duration is null)),
  check (approval_status <> 'HUMAN_APPROVED' or coalesce(
    (approval_reference->>'artifact_sha256'=sha256 and approval_reference->>'status'='HUMAN_APPROVED'
      and approval_reference ?& array['source','evidence_sha256','scope']),false))
);
create index lumi_library_owner_type on public.lumi_library_assets(owner_id,asset_type,created_at desc);
create table public.lumi_library_selections (
  selection_id text primary key check (selection_id ~ '^[a-f0-9]{64}$'),
  owner_id bigint not null,
  asset_id text not null references public.lumi_library_assets(asset_id),
  target_episode_id text not null check (target_episode_id ~ '^[A-Za-z0-9_-]{1,100}$'),
  target_shot_id text not null check (target_shot_id ~ '^[A-Za-z0-9_-]{1,100}$'),
  mode text not null check (mode in ('REFERENCE_REUSE','DIRECT_MEDIA_REUSE','DERIVED_ASSET')),
  contract jsonb not null,
  created_at timestamptz not null default now(),
  check (contract->>'status'='DRAFT_NOT_APPLIED' and contract->>'generation_authorized'='false')
);
create index lumi_library_selection_owner on public.lumi_library_selections(owner_id,target_episode_id,created_at desc);
alter table public.lumi_library_assets enable row level security;
alter table public.lumi_library_selections enable row level security;
revoke all on public.lumi_library_assets,public.lumi_library_selections from public,anon,authenticated;
grant select,insert on public.lumi_library_assets,public.lumi_library_selections to service_role;

create function public.lumi_library_immutable_v1() returns trigger language plpgsql set search_path='' as $$
begin raise exception 'library_versions_are_immutable'; end;
$$;
create trigger lumi_library_asset_immutable before update or delete on public.lumi_library_assets for each row execute function public.lumi_library_immutable_v1();
create trigger lumi_library_selection_immutable before update or delete on public.lumi_library_selections for each row execute function public.lumi_library_immutable_v1();
revoke all on function public.lumi_library_immutable_v1() from public,anon,authenticated;

-- Serializes version allocation across overlapping deployments. No security definer.
create function public.lumi_library_register_v1(candidate jsonb) returns public.lumi_library_assets
language plpgsql security invoker set search_path='' as $$
declare a public.lumi_library_assets; existing public.lumi_library_assets;
begin
  a:=jsonb_populate_record(null::public.lumi_library_assets,candidate);
  perform pg_advisory_xact_lock(hashtextextended(a.owner_id::text||':'||a.series_key,0));
  select * into existing from public.lumi_library_assets where asset_id=a.asset_id;
  if found then
    if existing.owner_id<>a.owner_id or existing.sha256<>a.sha256 or existing.series_key<>a.series_key then raise exception 'library_identity_conflict'; end if;
    return existing;
  end if;
  select coalesce(max(version),0)+1 into a.version from public.lumi_library_assets where owner_id=a.owner_id and series_key=a.series_key;
  a.created_at:=now();
  insert into public.lumi_library_assets select (a).*;
  return a;
end;
$$;
revoke all on function public.lumi_library_register_v1(jsonb) from public,anon,authenticated;
grant execute on function public.lumi_library_register_v1(jsonb) to service_role;
create function public.lumi_library_selection_guard_v1() returns trigger language plpgsql security invoker set search_path='' as $$
declare a public.lumi_library_assets;
begin
  select * into a from public.lumi_library_assets where asset_id=new.asset_id;
  if not found or a.owner_id<>new.owner_id or a.approval_status<>'HUMAN_APPROVED'
    or not ((a.reuse_policy->'modes') ? new.mode)
    or (new.contract->>'asset_id') is distinct from a.asset_id or (new.contract->>'sha256') is distinct from a.sha256
    or (new.contract->>'asset_version')::integer is distinct from a.version
    or (new.contract->>'mode') is distinct from new.mode or (new.contract->>'target_episode_id') is distinct from new.target_episode_id
    or (new.contract->>'target_shot_id') is distinct from new.target_shot_id
  then raise exception 'library_selection_binding_invalid'; end if;
  return new;
end;
$$;
create trigger lumi_library_selection_guard before insert on public.lumi_library_selections for each row execute function public.lumi_library_selection_guard_v1();
revoke all on function public.lumi_library_selection_guard_v1() from public,anon,authenticated;
