create table public.lumi_provider_emission_journal (
  attempt_id text primary key,
  version text not null check (version = 'PROVIDER_EMISSION_JOURNAL_V1'),
  episode_id text not null references public.lumi_pipeline_checkpoints(episode_id),
  scene_id text not null, stage text not null, provider text not null, model text not null,
  expected_cost_usd numeric(12,9) not null check (expected_cost_usd >= 0),
  prompt_hash text not null, payload_fingerprint text not null, request_fingerprint text not null,
  payload_descriptor jsonb not null, emission_nonce uuid not null unique,
  state text not null check (state in ('PREPARED','EMITTING','ACKNOWLEDGED','EMISSION_UNKNOWN')),
  prepared_at timestamptz not null, request_start_at timestamptz, acknowledged_at timestamptz,
  request_end_at timestamptz, http_status integer, provider_request_id text,
  transport_error text, response_parsing_outcome text, incident_classification text, response_metadata jsonb,
  human_override jsonb, original_attempt_snapshot jsonb,
  potential_unconfirmed_cost_exposure jsonb,
  unique (episode_id, scene_id, stage)
);
alter table public.lumi_provider_emission_journal enable row level security;
revoke all on public.lumi_provider_emission_journal from public, anon, authenticated;
grant select,insert,update on public.lumi_provider_emission_journal to service_role;

create function public.lumi_prepare_emission_v1(p_record jsonb) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare cp public.lumi_pipeline_checkpoints; original public.lumi_pilot_runs;
  r public.lumi_provider_emission_journal; action jsonb; override jsonb; reserved numeric;
begin
  select * into strict cp from public.lumi_pipeline_checkpoints
    where episode_id=p_record->>'episode_id' for update;
  if cp.pipeline_version <> 'v1_1_2' or cp.status='CANCELLED' then raise exception 'episode_not_emittable'; end if;
  if p_record->>'state' <> 'PREPARED' then raise exception 'prepared_required'; end if;
  override := p_record->'human_override';
  if override is not null then
    if not (override @> '{"type":"AMBIGUOUS_EMISSION_HUMAN_OVERRIDE","episode_id":"ep_lumi_flores_003","scene_id":"s37","stage":"IMAGE","original_attempt_id":"49c9a67c-7394-4851-b3bc-cb2684f8c737","attempt_id":"s37-AMB1","scope":"ep_lumi_flores_003/s37","override_reason":"provider does not expose enough request-level evidence to prove emission or non-emission","possible_duplicate_remote_charge":true,"max_new_provider_calls_authorized":1,"authorized_by":"HUMAN_EXPLICIT_APPROVAL"}'::jsonb)
      or cp.episode_id <> 'ep_lumi_flores_003' or p_record->>'scene_id' <> 's37'
      or p_record->>'stage' <> 'IMAGE' or p_record->>'attempt_id' <> 's37-AMB1'
      or p_record->>'provider' <> 'openai' or cp.status <> 'PAUSED_INCIDENT'
      or cp.first_pending_action <> 'image:s37' then raise exception 'explicit_scoped_human_override_required'; end if;
    select e into action from jsonb_array_elements(cp.actions) e where e->>'key'='image:s37';
    if action->>'dispatch_state' <> 'EMISSION_AMBIGUOUS'
      or cp.active_incident_id <> '124c2a60-35c8-4f96-a751-b67440062408'::uuid
      or not exists (select 1 from public.lumi_pipeline_incidents where incident_id=cp.active_incident_id
        and status='OPEN' and retryability='PROVIDER_EMISSION_AMBIGUOUS') then raise exception 'ambiguous_attempt_binding_changed'; end if;
    select * into strict original from public.lumi_pilot_runs where id='49c9a67c-7394-4851-b3bc-cb2684f8c737';
    if original.scene_id <> 's37' or original.stage <> 'IMAGE' or original.provider_request_id is not null
      or original.provider_calls <> 0 then raise exception 'original_attempt_changed'; end if;
    p_record := p_record || jsonb_build_object('original_attempt_snapshot',to_jsonb(original),
      'potential_unconfirmed_cost_exposure', jsonb_build_object('classification','UNRESOLVED_POTENTIAL_COST_EXPOSURE',
        'original_attempt_id',original.id,'confirmed',false,'amount_usd',null,'count',1));
  elsif cp.status <> 'RUNNING' or cp.active_incident_id is not null then
    raise exception 'episode_paused_no_emission';
  end if;
  -- Reserve outstanding emissions as well as accounted costs; row lock serializes admission.
  select coalesce(sum(j.expected_cost_usd),0) into reserved from public.lumi_provider_emission_journal j
    where j.episode_id=cp.episode_id and not exists (
      select 1 from jsonb_array_elements(cp.actions) a
      where a->>'key'=lower(j.stage)||':'||j.scene_id and a->>'status'='COMPLETE');
  if cp.current_cost_usd + reserved + (p_record->>'expected_cost_usd')::numeric > cp.authorized_ceiling_usd
    then raise exception 'BUDGET_EXHAUSTED'; end if;
  r := jsonb_populate_record(null::public.lumi_provider_emission_journal,p_record);
  insert into public.lumi_provider_emission_journal select r.*;
  return to_jsonb(r);
end $$;
revoke all on function public.lumi_prepare_emission_v1(jsonb) from public,anon,authenticated;
grant execute on function public.lumi_prepare_emission_v1(jsonb) to service_role;

create function public.lumi_emission_immutable_v1() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
  if (to_jsonb(new) - array['state','request_start_at','acknowledged_at','request_end_at','http_status','provider_request_id','transport_error','response_parsing_outcome','incident_classification','response_metadata'])
    is distinct from (to_jsonb(old) - array['state','request_start_at','acknowledged_at','request_end_at','http_status','provider_request_id','transport_error','response_parsing_outcome','incident_classification','response_metadata'])
    then raise exception 'emission_identity_immutable'; end if;
  if not ((old.state='PREPARED' and new.state='EMITTING')
    or (old.state='EMITTING' and new.state in ('ACKNOWLEDGED','EMISSION_UNKNOWN'))
    or (old.state='ACKNOWLEDGED' and new.state='ACKNOWLEDGED')) then raise exception 'emission_transition_rejected'; end if;
  return new;
end $$;
revoke all on function public.lumi_emission_immutable_v1() from public,anon,authenticated;
create trigger lumi_emission_immutable_v1 before update on public.lumi_provider_emission_journal
  for each row execute function public.lumi_emission_immutable_v1();

create function public.lumi_finish_s37_override_v1(p_attempt_id text,p_artifact_sha text) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare cp public.lumi_pipeline_checkpoints; r public.lumi_pilot_runs;
begin
  if p_attempt_id <> 's37-AMB1' then raise exception 'override_scope_mismatch'; end if;
  select * into strict cp from public.lumi_pipeline_checkpoints where episode_id='ep_lumi_flores_003' for update;
  if cp.metadata->>'human_override_attempt' = p_attempt_id and cp.active_incident_id is null then return to_jsonb(cp); end if;
  if cp.active_incident_id is distinct from '124c2a60-35c8-4f96-a751-b67440062408'::uuid then raise exception 'incident_binding_mismatch'; end if;
  select * into strict r from public.lumi_pilot_runs where pilot_id='lumi_tres_flores_colores_v1' and scene_id=p_attempt_id and stage='IMAGE';
  if r.status <> 'SUCCEEDED' or r.content_hash is distinct from p_artifact_sha
    or r.result->'video_source_readiness'->>'status' is distinct from 'PASS'
    or r.result->'visual_qa'->>'classification' not in ('PASS','PASS_WITH_WARNING')
    or not exists(select 1 from public.lumi_provider_emission_journal where attempt_id=p_attempt_id and state='ACKNOWLEDGED')
    then raise exception 'source_readiness_required'; end if;
  update public.lumi_pipeline_incidents set status='RESOLVED',resolved_at=now(),
    retryability='RESOLVED_BY_HUMAN_AUTHORIZED_SUPERSEDING_ATTEMPT',safe_resume_available=false,artifact_id_path=r.storage_path
    where incident_id=cp.active_incident_id and status='OPEN' and retryability='PROVIDER_EMISSION_AMBIGUOUS';
  if not found then raise exception 'open_ambiguous_incident_required'; end if;
  update public.lumi_pipeline_checkpoints set active_incident_id=null,status='RUNNING',updated_at=now(),
    metadata=metadata || jsonb_build_object('human_override_attempt',p_attempt_id,'resume_count',coalesce((metadata->>'resume_count')::integer,0)+1)
    where episode_id=cp.episode_id returning * into cp;
  return to_jsonb(cp);
end $$;
revoke all on function public.lumi_finish_s37_override_v1(text,text) from public,anon,authenticated;
grant execute on function public.lumi_finish_s37_override_v1(text,text) to service_role;
