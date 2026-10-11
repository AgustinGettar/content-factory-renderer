-- Local only. Preserve immutable attempts and the existing locked admission RPC.
-- A terminal, explicit rejection frees only the scope slot, never a cost reserve.
begin;
alter table public.lumi_provider_emission_journal
  drop constraint lumi_provider_emission_journal_episode_id_scene_id_stage_key;
create unique index lumi_emission_active_scope on public.lumi_provider_emission_journal(episode_id,scene_id,stage)
  where incident_classification is distinct from 'INSUFFICIENT_PROVIDER_BALANCE';
create unique index lumi_emission_balance_successor on public.lumi_provider_emission_journal
  ((original_attempt_snapshot->>'balance_recovery_of')) where original_attempt_snapshot->>'balance_recovery_of' is not null;
create or replace function public.lumi_prepare_emission_v1(p_record jsonb) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare cp public.lumi_pipeline_checkpoints; original public.lumi_pilot_runs;
  r public.lumi_provider_emission_journal; action jsonb; override jsonb; reserved numeric; previous public.lumi_provider_emission_journal; prior_id text; fi jsonb;
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
  -- An explicit, parsed balance rejection may have ONE authorized successor.
  -- The original row, payload, diagnostic request id and cost remain immutable.
  prior_id := p_record->'original_attempt_snapshot'->>'balance_recovery_of';
  if prior_id is not null then
    select * into strict previous from public.lumi_provider_emission_journal where attempt_id=prior_id for update;
    fi := case when cp.metadata->>'operation_type'='EP004_Q41_FIRST_IMAGE'
      then cp.metadata->'first_image' else cp.metadata->'balance_recovery' end;
    select e into action from jsonb_array_elements(cp.actions) e where e->>'key'=cp.first_pending_action;
    if previous.episode_id is distinct from cp.episode_id or previous.scene_id is distinct from p_record->>'scene_id'
      or previous.stage is distinct from p_record->>'stage' or previous.provider <> 'higgsfield_api'
      or previous.state <> 'ACKNOWLEDGED' or previous.http_status not in (400,402,403)
      or previous.response_parsing_outcome is distinct from 'JSON_PARSED'
      or previous.incident_classification is distinct from 'INSUFFICIENT_PROVIDER_BALANCE'
      or previous.response_metadata->>'accepted_job_absent' is distinct from 'true'
      or coalesce(previous.response_metadata->>'error_code','') not in ('insufficient_balance','insufficient_funds','credit_balance_exhausted')
      or (cp.metadata->>'operation_type' is distinct from 'EP004_Q41_FIRST_IMAGE' and not coalesce(
        fi->>'action_key'=cp.first_pending_action and fi->'authorization'->>'episode_id'=cp.episode_id
        and fi->'authorization'->>'profile_sha'=cp.metadata->'generic_v2'->>'profile_sha'
        and fi->'authorization'->>'explicit_user_authorization'='true',false))
      or action->>'stage' is distinct from previous.stage or action->>'scene_id' is distinct from previous.scene_id
      or action->>'provider_request_id' is not null or action->>'status'='COMPLETE' or cp.authorized_ceiling_usd <> 5
      or fi->>'prior_attempt_id' is distinct from prior_id or fi->>'attempt_id' is distinct from p_record->>'attempt_id'
      or fi->>'state' is distinct from 'EMITTING' or fi->>'accepted' is not null or fi->>'artifact' is not null or fi->>'review' is not null
      or fi->'authorization'->>'attempt_id' is distinct from p_record->>'attempt_id'
      or fi->'authorization'->>'status' is distinct from 'AUTHORIZED'
      or coalesce((fi->'authorization'->>'expires_at')::timestamptz,'-infinity') <= now()
      or cp.metadata->'budget_reservations'->cp.first_pending_action->>'binding' is distinct from fi->>'binding'
      then raise exception 'balance_recovery_authorization_required'; end if;
    if exists(select 1 from public.lumi_provider_emission_journal where original_attempt_snapshot->>'balance_recovery_of'=prior_id)
      then raise exception 'balance_recovery_already_consumed'; end if;
    if cp.current_cost_usd+(select coalesce(sum((v->>'amount_usd')::numeric),0)
      from jsonb_each(cp.metadata->'budget_reservations') e(k,v)) > cp.authorized_ceiling_usd
      then raise exception 'BUDGET_EXHAUSTED'; end if;
  elsif exists(select 1 from public.lumi_provider_emission_journal where episode_id=cp.episode_id
    and scene_id=p_record->>'scene_id' and stage=p_record->>'stage') then
    raise exception 'existing_emission_requires_scoped_recovery';
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

create or replace function public.lumi_emission_immutable_v1() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
  if (to_jsonb(new) - array['state','request_start_at','acknowledged_at','request_end_at','http_status','provider_request_id','transport_error','response_parsing_outcome','incident_classification','response_metadata'])
    is distinct from (to_jsonb(old) - array['state','request_start_at','acknowledged_at','request_end_at','http_status','provider_request_id','transport_error','response_parsing_outcome','incident_classification','response_metadata'])
    then raise exception 'emission_identity_immutable'; end if;
  if not ((old.state='PREPARED' and new.state='EMITTING')
    or (old.state='EMITTING' and new.state in ('ACKNOWLEDGED','EMISSION_UNKNOWN'))
    or (old.state='ACKNOWLEDGED' and new.state='ACKNOWLEDGED')) then raise exception 'emission_transition_rejected'; end if;
  if old.incident_classification='INSUFFICIENT_PROVIDER_BALANCE'
    and to_jsonb(new) is distinct from to_jsonb(old) then raise exception 'balance_rejection_immutable'; end if;
  if new.incident_classification='INSUFFICIENT_PROVIDER_BALANCE' and not coalesce(
    new.provider='higgsfield_api' and new.state='ACKNOWLEDGED' and new.http_status in (400,402,403)
    and new.response_parsing_outcome='JSON_PARSED' and new.response_metadata->>'accepted_job_absent'='true'
    and new.response_metadata->>'error_code' in ('insufficient_balance','insufficient_funds','credit_balance_exhausted'),false)
    then raise exception 'balance_rejection_evidence_required'; end if;
  return new;
end $$;

commit;
