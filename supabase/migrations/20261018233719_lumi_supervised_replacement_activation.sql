-- One supervised successor per original, on the existing journal and ledgers.
-- No data mutation, grants, reservations or provider work occurs during migration.
begin;
drop index public.lumi_emission_active_scope;
create unique index lumi_emission_active_scope on public.lumi_provider_emission_journal(episode_id,scene_id,stage)
 where incident_classification is distinct from 'INSUFFICIENT_PROVIDER_BALANCE'
 and original_attempt_snapshot->>'supervised_replacement_of' is null;
create unique index lumi_emission_supervised_successor on public.lumi_provider_emission_journal
 ((original_attempt_snapshot->>'supervised_replacement_of')) where original_attempt_snapshot->>'supervised_replacement_of' is not null;

create function public.lumi_supervised_replacement_v1(p jsonb) returns jsonb
language plpgsql security invoker set search_path='' as $$
<<replacement_tx>>
declare cp public.lumi_pipeline_checkpoints; s public.lumi_telegram_review_sessions;
 old public.lumi_provider_emission_journal; nr public.lumi_provider_emission_journal;
 proposal jsonb; g jsonb; q jsonb; a jsonb; op jsonb; reservation jsonb; oldreceipt jsonb;
 pid text:=p->>'proposal_id'; phase text:=p->>'phase'; uid text:=p->>'user_id'; sid text:=p->>'session_id';
 episode text; attempt text; opid text; reservekey text; exposure numeric; t timestamptz:=clock_timestamp();
 metadata jsonb; acts jsonb; state jsonb;
begin
 -- Read identity, then lock checkpoints in a stable order, then session, journals.
 select sess.state->'supervised_replacement_proposals'->pid->>'episode_id' into episode
 from public.lumi_telegram_review_sessions sess where sess.user_id::text=uid;
 if episode is null then raise exception 'REPLACEMENT_PROPOSAL_REQUIRED'; end if;
 perform c.episode_id from public.lumi_pipeline_checkpoints c where c.episode_id=episode
   or (c.episode_id='ep004_q41_first_image' and c.metadata->>'target_episode'=episode) order by c.episode_id for update;
 select * into strict cp from public.lumi_pipeline_checkpoints where episode_id=episode;
 select * into strict s from public.lumi_telegram_review_sessions where user_id::text=uid for update;
 state:=s.state; proposal:=state->'supervised_replacement_proposals'->pid;
 attempt:=proposal->>'planned_attempt_id'; opid:=proposal->>'planned_operation_id'; reservekey:='replacement:'||attempt;
 select * into strict old from public.lumi_provider_emission_journal where attempt_id=proposal->>'original_attempt_id' for update;
 select e into a from jsonb_array_elements(cp.actions) e where e->>'key'=proposal->>'action_id';
 oldreceipt:=state->'production_commands'->old.attempt_id;
 if cp.metadata->>'user' is distinct from uid or s.chat_id::text is distinct from uid
   or coalesce((state->'mini_app'->'sessions'->sid->>'expires_at')::numeric,0)<=extract(epoch from t)*1000
   or state->'mini_app'->'sessions'->sid->>'user' is distinct from uid
   or state->'mini_app'->'sessions'->sid->>'chat' is distinct from uid
   or state->'episodes'->episode is null or coalesce(state->'mini_app'->>'active_episode_id',episode)<>episode
   or cp.runner_enabled or cp.autorun or cp.metadata->>'provider_generation_authorized' is distinct from 'false'
   or cp.metadata->>'publication_enabled' is distinct from 'false' then raise exception 'REPLACEMENT_OWNER_OR_SCOPE_REQUIRED'; end if;
 if proposal->>'proposal_status' is distinct from 'REPLACEMENT_PROPOSAL' or proposal->>'risk_acceptance' is not null
   or proposal->>'generation_enabled' is distinct from 'false' or proposal->>'new_reservation_status' is distinct from 'NOT_RESERVED'
   or cp.authorized_ceiling_usd is distinct from (proposal->>'budget_ceiling_usd')::numeric
   or old.episode_id<>episode or old.scene_id is distinct from proposal->>'shot_id'
   or old.stage is distinct from a->>'stage' or old.provider is distinct from proposal->>'provider' or old.model is distinct from proposal->>'model'
   or old.attempt_id=attempt or proposal->>'original_operation_id'=opid or attempt=opid
   or proposal->>'planned_idempotency_key' in (old.attempt_id,attempt,opid,proposal->>'original_operation_id')
   then raise exception 'REPLACEMENT_IDENTITY_REQUIRED'; end if;
 -- Result recovery is authenticated but requires no spend/risk grant. It cannot submit.
 if phase='SELECT_ORIGINAL' then
   if cp.first_pending_action is distinct from proposal->>'action_id' or a->>'active_attempt_id' not in (old.attempt_id,attempt)
     or a->>'status' is distinct from 'PENDING' or a->>'artifact' is not null
     or cp.metadata->'budget_reservations'->(proposal->>'action_id')->>'attempt_id' is distinct from old.attempt_id
     then raise exception 'REPLACEMENT_ORIGINAL_RECOVERY_SCOPE_CHANGED'; end if;
   select * into nr from public.lumi_provider_emission_journal where attempt_id=attempt for update;
   if nr.attempt_id is not null and not (nr.state='PREPARED' or
     (nr.response_metadata->>'transport_invoked'='false' and nr.response_parsing_outcome='NOT_DISPATCHED'))
     then raise exception 'REPLACEMENT_ALREADY_EMITTED_KEEP_BOTH'; end if;
   if old.state='ACKNOWLEDGED' and old.response_metadata->'accepted_result'->>'request_id'=old.provider_request_id then
     oldreceipt:=coalesce(oldreceipt,'{}')||jsonb_build_object('status','WAITING','episode_id',episode,'action_key',proposal->>'action_id',
       'result',jsonb_build_object('episode_id',episode,'stage_id',old.stage,'status','IN_PROGRESS','artifacts','[]'::jsonb,
       'provider_job_ids',jsonb_build_array(old.provider_request_id),'claims',jsonb_build_array(old.attempt_id),'output',old.response_metadata->'accepted_result'));
   end if;
   if oldreceipt->>'episode_id' is distinct from episode or oldreceipt->>'action_key' is distinct from proposal->>'action_id'
     or oldreceipt->'result'->>'episode_id' is distinct from episode or oldreceipt->'result'->>'stage_id' is distinct from old.stage
     or oldreceipt->'result'->'provider_job_ids'->>0 is null
     or oldreceipt->'result'->'output'->>'request_id' is distinct from oldreceipt->'result'->'provider_job_ids'->>0
     or coalesce(oldreceipt->'result'->'output'->>'status_url','') !~ '^https://api[.]higgsfield[.]ai/[A-Za-z0-9_/-]+$'
     then raise exception 'REPLACEMENT_ORIGINAL_VERIFIED_RECEIPT_REQUIRED'; end if;
   metadata:=jsonb_set(cp.metadata,'{supervised_original_recoveries}',coalesce(cp.metadata->'supervised_original_recoveries','{}')||
     jsonb_build_object(old.attempt_id,jsonb_build_object('proposal_id',pid,'provider_request_id',oldreceipt->'result'->'provider_job_ids'->>0,
       'original_incident_id',cp.active_incident_id,'selected_at',t)));
   metadata:=jsonb_set(metadata,'{runtime_revision}',to_jsonb((cp.metadata->>'runtime_revision')::bigint+1));
   select jsonb_agg(case when e->>'key'=proposal->>'action_id' then e||jsonb_build_object('active_attempt_id',old.attempt_id,
     'dispatch_state','REQUEST_ACCEPTED','provider_request_id',oldreceipt->'result'->'provider_job_ids'->>0) else e end order by n)
     into acts from jsonb_array_elements(cp.actions) with ordinality x(e,n);
   update public.lumi_pipeline_checkpoints set metadata=replacement_tx.metadata,actions=acts,status='RUNNING',active_incident_id=null,updated_at=t where episode_id=episode;
   state:=jsonb_set(state,'{production_commands}',coalesce(state->'production_commands','{}')||jsonb_build_object(old.attempt_id,oldreceipt));
   if state->'mini_app'->'operations'->opid is not null then
     state:=jsonb_set(state,array['mini_app','operations',opid],(state->'mini_app'->'operations'->opid)||jsonb_build_object('status','BLOCKED','phase','ORIGINAL_RESULT_PRIORITY'));
   end if;
   update public.lumi_telegram_review_sessions set state=replacement_tx.state,revision=s.revision+1,updated_at=t where user_id=s.user_id;
   return jsonb_build_object('status','ORIGINAL_RESULT_SELECTED','provider_calls',0,'new_reservations',0);
 end if;
 if old.state is distinct from 'EMISSION_UNKNOWN' or old.response_parsing_outcome is distinct from 'NO_RESPONSE'
   or old.http_status is not null or old.provider_request_id is not null or old.response_metadata->'accepted_result' is not null
   or old.response_metadata->>'transport_invoked'='false'
   or coalesce(jsonb_array_length(oldreceipt->'result'->'provider_job_ids'),0)>0
   or coalesce(jsonb_array_length(oldreceipt->'result'->'artifacts'),0)>0
   then raise exception 'REPLACEMENT_ORIGINAL_RESULT_OR_EVIDENCE_CHANGED'; end if;
 reservation:=cp.metadata->'budget_reservations'->(proposal->>'action_id');
 if reservation->>'attempt_id' is distinct from old.attempt_id
   or reservation->>'status' is distinct from 'RESERVED_UNTIL_ACTUAL_CHARGE_VERIFIED'
   or (reservation->>'amount_usd')::numeric is distinct from (proposal->>'original_reserved_usd')::numeric
   then raise exception 'REPLACEMENT_ORIGINAL_RESERVATION_CHANGED'; end if;
 g:=p->'grant'; q:=p->'quote';
 if not coalesce(g @> jsonb_build_object('scope','SUPERVISED_REPLACEMENT_DUPLICATE_RISK','status','AUTHORIZED','decision','APPROVED',
   'replacement_proposal_id',pid,'proposal_digest',proposal->>'proposal_digest','original_operation_id',proposal->>'original_operation_id',
   'episode_id',episode,'shot_id',proposal->>'shot_id','action_id',proposal->>'action_id','human_identity',uid,'user_id',uid,
   'risk_disclosure_version','LUMI_DUPLICATE_RISK_V2','accepts_possible_duplicate_charge',true,'preserve_original_reservation',true,'max_new_provider_calls',1),false)
   or coalesce((g->>'max_new_reservation_usd')::numeric,0) is distinct from (proposal->>'maximum_new_reservation')::numeric
   or g->>'maximum_reservation_usd' is distinct from g->>'max_new_reservation_usd'
   or coalesce(g->>'payload_sha256','') !~ '^[a-f0-9]{64}$' or coalesce(g->>'seal','') !~ '^[a-f0-9]{64}$'
   or coalesce((g->>'expires_at')::timestamptz,'-infinity')<=t
   or coalesce((g->>'consent_timestamp')::timestamptz,'infinity')>t
   or g->>'consent_timestamp' is distinct from g->>'authorized_at'
   or coalesce((g->>'authorized_at')::timestamptz,'-infinity')<(proposal->>'created_at')::timestamptz
   or g->>'authorization_reference' is null then raise exception 'REPLACEMENT_SPECIFIC_CONSENT_REQUIRED'; end if;
 if phase<>'DISPATCH' then
   if s.revision is distinct from (p->>'expected_revision')::bigint or to_jsonb(cp) is distinct from p->'checkpoint'
     or to_jsonb(old) is distinct from p->'original_journal'
     or state->'mini_app'->'operations'->(proposal->>'original_operation_id') is distinct from p->'original_operation'
     or state->'v2_authorizations'->(proposal->>'original_authorization_id') is distinct from p->'original_authorization'
     then raise exception 'REPLACEMENT_CAS_CONFLICT'; end if;
   if cp.status<>'PAUSED_INCIDENT' or cp.first_pending_action is distinct from proposal->>'action_id'
     or a->>'active_attempt_id' is distinct from old.attempt_id or a->>'status' is distinct from 'PENDING'
     or a->>'artifact' is not null or a->>'provider_request_id' is not null
     then raise exception 'REPLACEMENT_CHECKPOINT_CHANGED'; end if;
   if exists(select 1 from public.lumi_provider_emission_journal where attempt_id=attempt
     or original_attempt_snapshot->>'supervised_replacement_of'=old.attempt_id)
     or state->'mini_app'->'operations'->opid is not null then raise exception 'REPLACEMENT_ALREADY_CLAIMED'; end if;
 end if;
 if phase='ACCEPT' then
   if g->>'session_id' is distinct from sid then raise exception 'REPLACEMENT_CONSENT_SESSION_REQUIRED'; end if;
   if state->'supervised_replacement_consent_history'->(g->>'authorization_reference') is not null then raise exception 'REPLACEMENT_CONSENT_REPLAY'; end if;
   -- Preserve every consent; renewing an expired payload never changes a prior grant.
   state:=jsonb_set(state,'{supervised_replacement_grants}',coalesce(state->'supervised_replacement_grants','{}')||jsonb_build_object(pid,g));
   state:=jsonb_set(state,'{supervised_replacement_consent_history}',coalesce(state->'supervised_replacement_consent_history','{}')||jsonb_build_object(g->>'authorization_reference',g));
 elsif phase='QUOTE_CLAIM' then
   if state->'supervised_replacement_grants'->pid is distinct from g then raise exception 'REPLACEMENT_CONSENT_CHANGED'; end if;
   if state->'supervised_replacement_quote_claims'->(g->>'authorization_reference') is not null then raise exception 'REPLACEMENT_QUOTE_ALREADY_CLAIMED'; end if;
   state:=jsonb_set(state,'{supervised_replacement_quote_claims}',coalesce(state->'supervised_replacement_quote_claims','{}')||jsonb_build_object(g->>'authorization_reference',jsonb_build_object('status','CLAIMED','created_at',t)));
 elsif phase in ('ACTIVATE','DISPATCH') then
   if state->'supervised_replacement_grants'->pid is distinct from g
     or state->'supervised_replacement_quote_claims'->(g->>'authorization_reference')->>'status' is distinct from 'CLAIMED'
     then raise exception 'REPLACEMENT_CONSENT_OR_QUOTE_CLAIM_CHANGED'; end if;
   if not coalesce(q @> jsonb_build_object('episode_id',episode,'action_id',proposal->>'action_id','replacement_proposal_id',pid,
     'operation_id',opid,'attempt_id',attempt,'model',old.model,'currency','USD','status','QUOTED','payload_sha256',g->>'payload_sha256'),false)
     or coalesce((q->>'expires_at')::timestamptz,'-infinity')<=t or coalesce((q->>'created_at')::timestamptz,'infinity')>t
     or (q->>'created_at')::timestamptz<(g->>'authorized_at')::timestamptz
     or coalesce((q->>'estimate_usd')::numeric,0)<=0 or coalesce((q->>'reserve_usd')::numeric,0)<(q->>'estimate_usd')::numeric
     or (q->>'reserve_usd')::numeric>(proposal->>'maximum_new_reservation')::numeric
     then raise exception 'REPLACEMENT_FRESH_QUOTE_REQUIRED'; end if;
   select coalesce(sum(c.current_cost_usd+(select coalesce(sum((v->>'amount_usd')::numeric),0)
     from jsonb_each(coalesce(c.metadata->'budget_reservations','{}')) e(k,v))),0) into exposure
     from public.lumi_pipeline_checkpoints c where c.episode_id=episode
       or (c.episode_id='ep004_q41_first_image' and c.metadata->>'target_episode'=episode);
   if exposure+(case when phase='ACTIVATE' then (q->>'reserve_usd')::numeric else 0 end)>cp.authorized_ceiling_usd
     then raise exception 'REPLACEMENT_DOUBLE_EXPOSURE_BUDGET_BLOCKED'; end if;
   if phase='ACTIVATE' then
     nr:=jsonb_populate_record(null::public.lumi_provider_emission_journal,p->'record');
     if nr.attempt_id is distinct from attempt or nr.episode_id is distinct from episode or nr.scene_id is distinct from old.scene_id
       or nr.stage is distinct from old.stage or nr.provider is distinct from old.provider or nr.model is distinct from old.model
       or nr.payload_fingerprint is distinct from g->>'payload_sha256' or nr.state is distinct from 'PREPARED'
       or nr.expected_cost_usd is distinct from (q->>'estimate_usd')::numeric
       or nr.original_attempt_snapshot->>'supervised_replacement_of' is distinct from old.attempt_id
       or nr.original_attempt_snapshot->>'proposal_id' is distinct from pid
       or nr.payload_descriptor->'identity'->>'idempotency_key' is distinct from proposal->>'planned_idempotency_key'
       then raise exception 'REPLACEMENT_JOURNAL_BINDING_REQUIRED'; end if;
     insert into public.lumi_provider_emission_journal select nr.*;
     metadata:=jsonb_set(cp.metadata,'{budget_reservations}',coalesce(cp.metadata->'budget_reservations','{}')||jsonb_build_object(reservekey,
       jsonb_build_object('status','RESERVED_UNTIL_ACTUAL_CHARGE_VERIFIED','amount_usd',(q->>'reserve_usd')::numeric,'attempt_id',attempt,'binding',g->>'payload_sha256')));
     metadata:=jsonb_set(metadata,'{supervised_replacement_activity}',coalesce(metadata->'supervised_replacement_activity','{}')||jsonb_build_object(attempt,
       jsonb_build_object('proposal_id',pid,'original_action',a,'original_attempt_id',old.attempt_id,'original_incident_id',cp.active_incident_id,'reservation_key',reservekey,'quote',q)));
     metadata:=jsonb_set(metadata,'{runtime_revision}',to_jsonb((cp.metadata->>'runtime_revision')::bigint+1));
     select jsonb_agg(case when e->>'key'=proposal->>'action_id' then e||jsonb_build_object('active_attempt_id',attempt,'dispatch_state','DISPATCHING') else e end order by n)
       into acts from jsonb_array_elements(cp.actions) with ordinality t(e,n);
     update public.lumi_pipeline_checkpoints set metadata=replacement_tx.metadata,actions=acts,status='RUNNING',active_incident_id=null,updated_at=t where episode_id=episode;
     op:=jsonb_build_object('id',opid,'kind','supervised_replacement','status','RUNNING','phase','DISPATCHING','session_id',sid,'started_at',t,
       'replacement_proposal_id',pid,'original_operation_id',proposal->>'original_operation_id','binding',jsonb_build_object('proposal_id',episode,'next_action',proposal->>'action_id'));
     state:=jsonb_set(state,array['mini_app','operations',opid],op);
     state:=jsonb_set(state,'{mini_app,active_operation}',to_jsonb(opid));
     state:=jsonb_set(state,'{production_commands}',coalesce(state->'production_commands','{}')||jsonb_build_object(attempt,
       jsonb_build_object('status','STARTED','episode_id',episode,'action_key',proposal->>'action_id','quote',q)));
   else
     select * into strict nr from public.lumi_provider_emission_journal where attempt_id=attempt for update;
     if p->>'attempt_id' is distinct from attempt or nr.state<>'PREPARED' or cp.status<>'RUNNING'
       or cp.first_pending_action is distinct from proposal->>'action_id' or a->>'active_attempt_id' is distinct from attempt
       or cp.metadata->'supervised_replacement_activity'->attempt->'quote' is distinct from q
       or cp.metadata->'budget_reservations'->reservekey->>'binding' is distinct from g->>'payload_sha256'
       or state->'mini_app'->'operations'->opid->>'phase' is distinct from 'DISPATCHING'
       then raise exception 'REPLACEMENT_DISPATCH_CAS_CONFLICT'; end if;
     update public.lumi_provider_emission_journal set state='EMITTING',request_start_at=t where attempt_id=attempt returning * into nr;
     state:=jsonb_set(state,array['mini_app','operations',opid,'phase'],'"EMITTING"');
   end if;
 else raise exception 'REPLACEMENT_TRANSACTION_PHASE_INVALID'; end if;
 update public.lumi_telegram_review_sessions set state=replacement_tx.state,revision=s.revision+1,updated_at=t where user_id=s.user_id;
 return case when phase in ('ACTIVATE','DISPATCH') then to_jsonb(nr) else jsonb_build_object('status',phase,'provider_calls',0,'new_reservations',0) end;
end $$;
revoke all on function public.lumi_supervised_replacement_v1(jsonb) from public,anon,authenticated;
grant execute on function public.lumi_supervised_replacement_v1(jsonb) to service_role;
commit;
