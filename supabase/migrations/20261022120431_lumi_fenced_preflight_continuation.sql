-- Same journal and reservation. A distinct state fences even the previous binary,
-- whose dispatch CAS only accepts PREPARED. Never admit EMITTING/UNKNOWN/ACK.
alter table public.lumi_provider_emission_journal drop constraint lumi_provider_emission_journal_state_check;
alter table public.lumi_provider_emission_journal add constraint lumi_provider_emission_journal_state_check
 check (state in ('PREPARED','FENCED_PREPARED','EMITTING','ACKNOWLEDGED','EMISSION_UNKNOWN'));

create or replace function public.lumi_fence_preflight_v1(p_attempt text, p_nonce uuid, p_user bigint, p_job text, p_lease text,p_semantic text,p_payload_hash text)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare j public.lumi_provider_emission_journal; s public.lumi_telegram_review_sessions; cp public.lumi_pipeline_checkpoints; job jsonb; a jsonb;
begin
 select * into strict j from public.lumi_provider_emission_journal where attempt_id=p_attempt for update;
 select * into strict s from public.lumi_telegram_review_sessions where user_id=p_user for update;
 select * into strict cp from public.lumi_pipeline_checkpoints where episode_id=j.episode_id for update;
 job:=s.state->'mini_app'->'episode_jobs'->j.episode_id;
 select e into a from jsonb_array_elements(cp.actions) e where e->>'key'=cp.first_pending_action;
 if (j.state not in ('PREPARED','FENCED_PREPARED') and not(j.state='EMISSION_UNKNOWN' and j.incident_classification='LOCAL_PRE_DISPATCH_REJECTED' and j.response_metadata->>'transport_invoked'='false' and j.response_parsing_outcome='NOT_DISPATCHED')) or j.state in ('PREPARED','FENCED_PREPARED') and j.request_start_at is not null or j.provider_request_id is not null
   or j.http_status is not null or j.episode_id is distinct from cp.episode_id or cp.metadata->>'user'<>p_user::text
   or job->>'id' is distinct from p_job or job->>'lease_token' is distinct from p_lease or job->>'status'<>'RUNNING'
   or (job->>'lease_until')::numeric <= extract(epoch from clock_timestamp())*1000
   or job->>'activated_by'<>'AUTHENTICATED_MINI_APP_PRODUCE_CLICK'
   or a->>'active_attempt_id' is distinct from p_attempt or a->>'status'<>'PENDING' or a->>'dispatch_state'<>'DISPATCHING'
   or a->>'stage' is distinct from j.stage or a->>'scene_id' is distinct from j.scene_id
   or s.state->'production_commands'->p_attempt->>'status' is distinct from 'STARTED'
   or cp.metadata->'budget_reservations'->cp.first_pending_action->>'attempt_id' is distinct from p_attempt
   or cp.status not in ('RUNNING','PAUSED_INCIDENT') or j.payload_fingerprint is distinct from p_payload_hash
   or p_semantic !~ '^[a-f0-9]{64}$' or (j.payload_descriptor ? 'preflight_semantic_sha256' and j.payload_descriptor->>'preflight_semantic_sha256' is distinct from p_semantic) then raise exception 'PREFLIGHT_FENCE_SCOPE_REJECTED'; end if;
 if cp.status='PAUSED_INCIDENT' and not exists(select 1 from public.lumi_pipeline_incidents i
   where i.incident_id=cp.active_incident_id and i.status='OPEN' and i.reason in ('STAGE_QUOTE_EXPIRED_BEFORE_DISPATCH','Q41_VIDEO_CURRENT_QUOTE_REQUIRED','PREFLIGHT_QUOTE_EXPIRED'))
   then raise exception 'PREFLIGHT_INCIDENT_NOT_RECOVERABLE'; end if;
 if cp.active_incident_id is not null then
   update public.lumi_pipeline_incidents set status='RESOLVED',resolved_at=now(),retryability='FENCED_BEFORE_TRANSPORT' where incident_id=cp.active_incident_id;
   update public.lumi_pipeline_checkpoints set status='RUNNING',active_incident_id=null,
    metadata=jsonb_set(metadata,'{runtime_revision}',to_jsonb((metadata->>'runtime_revision')::bigint+1)) where episode_id=cp.episode_id;
 end if;
 update public.lumi_provider_emission_journal set state='FENCED_PREPARED',emission_nonce=p_nonce,request_start_at=null,
   payload_descriptor=coalesce(payload_descriptor,'{}')||jsonb_build_object('preflight_semantic_sha256',p_semantic,
   'preflight_fence',jsonb_build_object('nonce',p_nonce,'job_id',p_job,'lease_token',p_lease,'fenced_at',clock_timestamp()),
   'fence_history',coalesce(payload_descriptor->'fence_history','[]')||jsonb_build_array(jsonb_build_object('state',j.state,'nonce',j.emission_nonce,'request_start_at',j.request_start_at,'response_metadata',j.response_metadata,'fenced_at',clock_timestamp())))
   where attempt_id=p_attempt returning * into j;
 return to_jsonb(j);
end $$;
revoke all on function public.lumi_fence_preflight_v1(text,uuid,bigint,text,text,text,text) from public,anon,authenticated;
grant execute on function public.lumi_fence_preflight_v1(text,uuid,bigint,text,text,text,text) to service_role;

-- Atomic final admission: exact job lease + journal fence + budget difference.
-- Old payload fingerprints and reservation snapshots remain in the history.
create or replace function public.lumi_commit_preflight_v1(p_attempt text,p_nonce uuid,p_user bigint,p_job text,p_lease text,p_version jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare j public.lumi_provider_emission_journal; cp public.lumi_pipeline_checkpoints; s public.lumi_telegram_review_sessions;
 job jsonb; grant_value jsonb; r jsonb; k text; exposure numeric; linked numeric; amount numeric; meta jsonb;
begin
 select * into strict j from public.lumi_provider_emission_journal where attempt_id=p_attempt for update;
 select * into strict s from public.lumi_telegram_review_sessions where user_id=p_user for update;
 select * into strict cp from public.lumi_pipeline_checkpoints where episode_id=j.episode_id for update;
 k:=cp.first_pending_action;job:=s.state->'mini_app'->'episode_jobs'->cp.episode_id;
 grant_value:=s.state->'v2_authorizations'->(job->>'plan_authorization_id')->'value';
 r:=cp.metadata->'budget_reservations'->k;amount:=(p_version->>'reservation_usd')::numeric;
 if grant_value is null or s.state->'v2_authorizations'->(job->>'plan_authorization_id')->>'status' is distinct from 'AUTHORIZED'
   or grant_value->>'scope' is distinct from 'EPISODE_PLAN_SPEND_V1' or grant_value->>'decision' is distinct from 'APPROVED'
   or grant_value->>'expires_at' is null or grant_value->'per_action_limits'->>k is null
   or j.state<>'FENCED_PREPARED' or j.emission_nonce is distinct from p_nonce or j.request_start_at is not null
   or cp.status<>'RUNNING' or cp.metadata->>'user'<>p_user::text or r->>'attempt_id' is distinct from p_attempt
   or job->>'id' is distinct from p_job or job->>'lease_token' is distinct from p_lease or job->>'status'<>'RUNNING'
   or (job->>'lease_until')::numeric<=extract(epoch from clock_timestamp())*1000
   or (grant_value->>'expires_at')::timestamptz<=clock_timestamp() or not(grant_value->'action_set' ? k)
   or p_version->>'action_key' is distinct from k or p_version->>'episode_id' is distinct from cp.episode_id
   or p_version->>'model' is distinct from grant_value->'model'->>k
   or amount<0 or amount>(grant_value->'per_action_limits'->>k)::numeric
   or (grant_value->>'maximum_episode_exposure')::numeric<>cp.authorized_ceiling_usd
   or p_version->>'plan_seal' is distinct from s.state->'v2_authorizations'->(job->>'plan_authorization_id')->>'seal'
   or p_version->>'semantic_sha256' is distinct from j.payload_descriptor->>'preflight_semantic_sha256'
   then raise exception 'PREFLIGHT_FINAL_ADMISSION_REJECTED'; end if;
 if (p_version->>'expires_at')::timestamptz<=clock_timestamp() then raise exception 'PREFLIGHT_QUOTE_EXPIRED'; end if;
 select coalesce(sum((v->>'amount_usd')::numeric),0) into exposure from jsonb_each(cp.metadata->'budget_reservations') e(k,v);
 select coalesce(sum(x.current_cost_usd+(select coalesce(sum((v->>'amount_usd')::numeric),0) from jsonb_each(x.metadata->'budget_reservations') t(k,v))),0)
 into linked from public.lumi_pipeline_checkpoints x where x.metadata->>'target_episode'=cp.episode_id and x.episode_id<>cp.episode_id;
 if cp.current_cost_usd+linked+exposure-(r->>'amount_usd')::numeric+greatest(amount,(r->>'amount_usd')::numeric)
    +(p_version->>'remaining_plan_reservation_usd')::numeric>cp.authorized_ceiling_usd then raise exception 'BUDGET_EXHAUSTED'; end if;
 -- A cheaper quote does not release the original liability; an increase is delta-only.
 meta:=jsonb_set(cp.metadata,array['budget_reservations',k],r||jsonb_build_object('amount_usd',greatest(amount,(r->>'amount_usd')::numeric),
  'binding',p_version->>'payload_sha256','preflight_history',coalesce(r->'preflight_history','[]')||jsonb_build_array(r-'preflight_history')));
 meta:=jsonb_set(meta,'{runtime_revision}',to_jsonb((meta->>'runtime_revision')::bigint+1));
 update public.lumi_pipeline_checkpoints set metadata=meta where episode_id=cp.episode_id;
 update public.lumi_provider_emission_journal set state='EMITTING',request_start_at=clock_timestamp(),
  payload_descriptor=jsonb_set(payload_descriptor,'{preflight_versions}',coalesce(payload_descriptor->'preflight_versions','[]')||jsonb_build_array(p_version)) where attempt_id=p_attempt returning * into j;
 return to_jsonb(j);
end $$;
revoke all on function public.lumi_commit_preflight_v1(text,uuid,bigint,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.lumi_commit_preflight_v1(text,uuid,bigint,text,text,jsonb) to service_role;

create or replace function public.lumi_emission_immutable_v1() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
  if new.state='FENCED_PREPARED' or old.state='FENCED_PREPARED' then
    if (to_jsonb(new)-array['state','emission_nonce','payload_descriptor','request_start_at'])
      is distinct from (to_jsonb(old)-array['state','emission_nonce','payload_descriptor','request_start_at'])
      or (new.payload_descriptor-array['preflight_fence','fence_history','preflight_versions','preflight_semantic_sha256'])
      is distinct from (old.payload_descriptor-array['preflight_fence','fence_history','preflight_versions','preflight_semantic_sha256'])
      or (new.state='FENCED_PREPARED' and not (old.state in ('PREPARED','FENCED_PREPARED') and old.request_start_at is null
        or old.state='EMISSION_UNKNOWN' and old.incident_classification='LOCAL_PRE_DISPATCH_REJECTED'
          and old.response_metadata->>'transport_invoked'='false' and old.response_parsing_outcome='NOT_DISPATCHED'))
      or (old.state='FENCED_PREPARED' and new.state not in ('FENCED_PREPARED','EMITTING'))
      then raise exception 'emission_fence_identity_immutable'; end if;
    return new;
  end if;
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

