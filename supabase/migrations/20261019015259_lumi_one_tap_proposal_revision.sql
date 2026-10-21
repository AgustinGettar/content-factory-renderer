-- Version unactivated replacement limits in the existing transaction; preserve all historical evidence.
begin;
create or replace function public.lumi_supervised_replacement_v1(p jsonb) returns jsonb
language plpgsql security invoker set search_path='' as $$
<<replacement_tx>>
declare cp public.lumi_pipeline_checkpoints; s public.lumi_telegram_review_sessions;
 old public.lumi_provider_emission_journal; nr public.lumi_provider_emission_journal;
 proposal jsonb; g jsonb; q jsonb; a jsonb; op jsonb; reservation jsonb; oldreceipt jsonb;
 pid text:=p->>'proposal_id'; phase text:=p->>'phase'; uid text:=p->>'user_id'; sid text:=p->>'session_id';
 episode text; attempt text; opid text; reservekey text; exposure numeric; t timestamptz:=clock_timestamp();
 metadata jsonb; acts jsonb; state jsonb; qc jsonb; previous_claim jsonb; outcome jsonb;
begin
 -- Read identity, then lock checkpoints in a stable order, then session, journals.
 select sess.state->'supervised_replacement_proposals'->pid->>'episode_id' into episode
 from public.lumi_telegram_review_sessions sess where sess.user_id::text=uid;
 if episode is null then raise exception 'REPLACEMENT_PROPOSAL_REQUIRED'; end if;
 perform c.episode_id from public.lumi_pipeline_checkpoints c where c.episode_id=episode
   or (c.metadata->>'target_episode'=episode) order by c.episode_id for update;
 select * into strict cp from public.lumi_pipeline_checkpoints where episode_id=episode;
 select * into strict s from public.lumi_telegram_review_sessions where user_id::text=uid for update;
 state:=s.state; proposal:=state->'supervised_replacement_proposals'->pid;
 attempt:=proposal->>'planned_attempt_id'; opid:=proposal->>'planned_operation_id'; reservekey:='replacement:'||attempt;
 select * into strict old from public.lumi_provider_emission_journal where attempt_id=proposal->>'original_attempt_id' for update;
 select e into a from jsonb_array_elements(cp.actions) e where e->>'key'=proposal->>'action_id';
 oldreceipt:=state->'production_commands'->old.attempt_id;
 if cp.metadata->>'user' is distinct from uid or s.chat_id::text is distinct from uid
   or (phase<>'REVISE_MAXIMUM' and (coalesce((state->'mini_app'->'sessions'->sid->>'expires_at')::numeric,0)<=extract(epoch from t)*1000
   or state->'mini_app'->'sessions'->sid->>'user' is distinct from uid
   or state->'mini_app'->'sessions'->sid->>'chat' is distinct from uid))
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
 -- Recording an outcome cannot authorize spending. It also works after a
 -- deadline passes, and only changes the matching fenced confirmation record.
 if phase='CONFIRMATION_OUTCOME' then
   g:=p->'grant'; qc:=p->'quote_claim';
   previous_claim:=state->'supervised_replacement_quote_claims'->(g->>'authorization_reference');
   if state->'supervised_replacement_consent_history'->(g->>'authorization_reference') is distinct from g
     or previous_claim->'binding' is distinct from qc or previous_claim->>'status'<>'CLAIMED'
     or coalesce(p->>'error_code','') !~ '^[A-Z0-9_]{1,100}$'
     or p->>'error_phase' not in ('QUOTE','PREFLIGHT','ACTIVATE','SUBMIT','DISPATCH','PROVIDER','RESULT_PERSISTENCE')
     then raise exception 'REPLACEMENT_OUTCOME_CLAIM_CHANGED'; end if;
   select * into nr from public.lumi_provider_emission_journal where attempt_id=attempt for update;
   outcome:=previous_claim||jsonb_build_object('status',case when nr.attempt_id is null
       and state->'mini_app'->'operations'->opid is null then 'PREFLIGHT_FAILED' else 'RECOVERY_REQUIRED' end,
     'finished_at',t,'error_code',p->>'error_code','error_phase',p->>'error_phase',
     'database_code',case when p->>'database_code' ~ '^[A-Z0-9]{5}$' then p->>'database_code' end,
     'quote_receipt',p->'quote_receipt','generation_boundary',case when nr.attempt_id is null
       then 'NO_JOURNAL_NO_GENERATION' else nr.state end);
   state:=jsonb_set(state,array['supervised_replacement_quote_claims',g->>'authorization_reference'],outcome);
   state:=jsonb_set(state,array['supervised_replacement_quote_history',qc->>'claim_id'],outcome);
   if state->'mini_app'->'operations'->opid is not null
     and cp.metadata->'supervised_replacement_activity'->attempt->'quote'->>'quote_claim_id'=qc->>'claim_id' then
     state:=jsonb_set(state,array['mini_app','operations',opid],(state->'mini_app'->'operations'->opid)||
       jsonb_build_object('status','BLOCKED','phase','RECOVERY_REQUIRED','error',p->>'error_code'));
   end if;
   update public.lumi_telegram_review_sessions set state=replacement_tx.state,revision=s.revision+1,updated_at=t where user_id=s.user_id;
   return outcome;
 end if;
 if phase='QUOTE_RESULT' then
   g:=p->'grant'; q:=p->'quote'; qc:=p->'quote_claim';
   previous_claim:=state->'supervised_replacement_quote_claims'->(g->>'authorization_reference');
   if state->'supervised_replacement_consent_history'->(g->>'authorization_reference') is distinct from g
     or previous_claim->>'status' is distinct from 'CLAIMED' or previous_claim->'binding' is distinct from qc
     or previous_claim ? 'quote'
     or not coalesce(q @> jsonb_build_object('episode_id',episode,'action_id',proposal->>'action_id',
       'replacement_proposal_id',pid,'operation_id',opid,'attempt_id',attempt,'model',old.model,
       'currency','USD','status','QUOTED','payload_sha256',qc->>'payload_sha256','quote_claim_id',qc->>'claim_id'),false)
     or coalesce(q->>'quote_id','')='' or coalesce((q->>'estimate_usd')::numeric,-1)<0
     or (q->>'reserve_usd')::numeric is distinct from ceil((q->>'estimate_usd')::numeric*1.25*1000000)/1000000
     or q->'economic_decision'->>'payload_sha256' is distinct from qc->>'payload_sha256'
     or (q->'economic_decision'->>'authorized_max_usd')::numeric is distinct from (proposal->>'maximum_new_reservation')::numeric
     then raise exception 'REPLACEMENT_QUOTE_EVIDENCE_BINDING_REQUIRED'; end if;
   -- Service-only, exact allowlist: never store provider bodies, URLs or secrets.
   select jsonb_object_agg(k,v) into q from jsonb_each(q) e(k,v) where k=any(array[
     'episode_id','action_id','replacement_proposal_id','operation_id','attempt_id','model','currency','status','payload_sha256',
     'quote_claim_id','quote_id','created_at','expires_at','estimate_usd','reserve_usd','http_status','provider_request_id',
     'provider_quote_expiration','correlation_id','approved_content_fingerprint','economic_decision']);
   outcome:=previous_claim||jsonb_build_object('quote',q,'quote_recorded_at',t,
     'status',case when p->>'quote_only'='true' then 'QUOTE_RECORDED' else 'CLAIMED' end,
     'generation_boundary','NO_JOURNAL_NO_GENERATION','quote_only',p->>'quote_only'='true');
   state:=jsonb_set(state,array['supervised_replacement_quote_claims',g->>'authorization_reference'],outcome);
   state:=jsonb_set(state,array['supervised_replacement_quote_history',qc->>'claim_id'],outcome);
   update public.lumi_telegram_review_sessions set state=replacement_tx.state,revision=s.revision+1,updated_at=t where user_id=s.user_id;
   return jsonb_build_object('status','QUOTE_RECORDED','provider_calls',0,'new_reservations',0);
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

 -- Service-only administrative revision backed by an explicit user instruction.
 -- This is NOT risk acceptance, cannot reserve and cannot create an operation.
 if phase='REVISE_MAXIMUM' then
   q:=p->'revised_proposal'; g:=p->'limit_authorization';
   if s.revision is distinct from (p->>'expected_revision')::bigint or to_jsonb(cp) is distinct from p->'checkpoint'
     or to_jsonb(old) is distinct from p->'original_journal' or proposal is distinct from p->'previous_proposal'
     or state->'mini_app'->'operations'->(proposal->>'original_operation_id') is distinct from p->'original_operation'
     or state->'v2_authorizations'->(proposal->>'original_authorization_id') is distinct from p->'original_authorization'
     then raise exception 'REPLACEMENT_CAS_CONFLICT'; end if;
   if cp.status<>'PAUSED_INCIDENT' or cp.first_pending_action is distinct from proposal->>'action_id'
     or a->>'active_attempt_id' is distinct from old.attempt_id or a->>'status'<>'PENDING'
     or a->>'artifact' is not null or a->>'provider_request_id' is not null
     or exists(select 1 from public.lumi_provider_emission_journal where attempt_id=attempt
       or original_attempt_snapshot->>'supervised_replacement_of'=old.attempt_id)
     or state->'mini_app'->'operations'->opid is not null
     or cp.metadata->'budget_reservations' ? reservekey
     then raise exception 'REPLACEMENT_ALREADY_CLAIMED'; end if;
   previous_claim:=state->'supervised_replacement_quote_claims'->(state->'supervised_replacement_grants'->pid->>'authorization_reference');
   if previous_claim->>'status'='CLAIMED' and coalesce((previous_claim->>'expires_at')::timestamptz,'infinity')>t
     then raise exception 'REPLACEMENT_QUOTE_ALREADY_CLAIMED'; end if;
   if not coalesce(g @> jsonb_build_object('scope','REPLACEMENT_MAXIMUM_ONLY','channel','EXPLICIT_USER_REQUEST',
     'episode_id',episode,'action_id',proposal->>'action_id','proposal_id',pid,'accepts_duplicate_risk',false,
     'generation_authorized',false,'reservation_authorized',false),false)
     or coalesce(g->>'authorization_reference','')='' or g->>'authorization_reference' is distinct from q->>'revision_authorization_reference'
     or (g->>'previous_max_usd')::numeric is distinct from (proposal->>'maximum_new_reservation')::numeric
     or (g->>'maximum_reservation_usd')::numeric is distinct from (q->>'maximum_new_reservation')::numeric
     or state->'v2_authorizations'->(g->>'authorization_reference') is not null
     or (q->>'version')::integer is distinct from (proposal->>'version')::integer+1
     or q->>'previous_proposal_digest' is distinct from proposal->>'proposal_digest'
     or coalesce(q->>'proposal_digest','') !~ '^[a-f0-9]{64}$'
     or q->>'proposal_digest'=proposal->>'proposal_digest'
     or (q->>'created_at')::timestamptz<= (proposal->>'created_at')::timestamptz
     or (q->>'created_at')::timestamptz>t
     or coalesce((q->>'maximum_new_reservation')::numeric,0)<=0
     or (q->>'maximum_new_reservation')::numeric=(proposal->>'maximum_new_reservation')::numeric
     or (q-array['version','previous_proposal_digest','revision_authorization_reference','created_at','proposal_digest',
       'maximum_new_reservation','potential_episode_exposure_usd','potential_duplicate_cost'])
       is distinct from (proposal-array['version','previous_proposal_digest','revision_authorization_reference','created_at','proposal_digest',
       'maximum_new_reservation','potential_episode_exposure_usd','potential_duplicate_cost'])
     or q->'potential_duplicate_cost' is distinct from (proposal->'potential_duplicate_cost'||jsonb_build_object(
       'proposed_additional_reservation_usd',(q->>'maximum_new_reservation')::numeric,
       'combined_q42_or_action_exposure_usd',(proposal->>'original_reserved_usd')::numeric+(q->>'maximum_new_reservation')::numeric))
     then raise exception 'REPLACEMENT_LIMIT_REVISION_INVALID'; end if;
   select coalesce(sum(c.current_cost_usd+coalesce((select sum((v->>'amount_usd')::numeric)
     from jsonb_each(coalesce(c.metadata->'budget_reservations','{}')) r(k,v)),0)),0) into exposure
     from public.lumi_pipeline_checkpoints c where c.episode_id=episode or c.metadata->>'target_episode'=episode;
   if exposure is distinct from (proposal->>'existing_episode_exposure_usd')::numeric
     or exposure+(q->>'maximum_new_reservation')::numeric>cp.authorized_ceiling_usd
     or (q->>'potential_episode_exposure_usd')::numeric is distinct from exposure+(q->>'maximum_new_reservation')::numeric
     then raise exception 'REPLACEMENT_DOUBLE_EXPOSURE_BUDGET_BLOCKED'; end if;
   state:=jsonb_set(state,'{supervised_replacement_proposal_history}',coalesce(state->'supervised_replacement_proposal_history','{}')||
     jsonb_build_object(proposal->>'proposal_digest',proposal,q->>'proposal_digest',q));
   state:=jsonb_set(state,array['supervised_replacement_proposals',pid],q);
   state:=jsonb_set(state,'{v2_authorizations}',coalesce(state->'v2_authorizations','{}')||jsonb_build_object(g->>'authorization_reference',g));
   update public.lumi_telegram_review_sessions set state=replacement_tx.state,revision=s.revision+1,updated_at=t where user_id=s.user_id;
   return jsonb_build_object('status','MAXIMUM_REVISED_NEW_RISK_ACCEPTANCE_REQUIRED','proposal_id',pid,'version',q->'version',
     'maximum_reservation_usd',q->'maximum_new_reservation','provider_calls',0,'new_reservations',0);
 end if;
 g:=p->'grant'; q:=p->'quote'; qc:=p->'quote_claim';
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
 if g->>'consent_contract_version'='3' and (coalesce(g->>'approved_content_fingerprint','') !~ '^[a-f0-9]{64}$'
   or (g->>'expires_at')::timestamptz>(g->>'authorized_at')::timestamptz+interval '24 hours')
   then raise exception 'REPLACEMENT_CONSENT_CONTRACT_INVALID'; end if;
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
   previous_claim:=state->'supervised_replacement_quote_claims'->(g->>'authorization_reference');
   if previous_claim is not null and not (previous_claim->>'status' in ('PREFLIGHT_FAILED','QUOTE_RECORDED') or
     (previous_claim->'binding' is not null and previous_claim->>'status'='CLAIMED'
      and (previous_claim->>'expires_at')::timestamptz<=t))
     then raise exception 'REPLACEMENT_QUOTE_ALREADY_CLAIMED'; end if;
   if coalesce(qc->>'claim_id','') !~ '^[a-f0-9-]{36}$'
     or state->'supervised_replacement_quote_history'->(qc->>'claim_id') is not null
     or qc->>'authorization_reference' is distinct from g->>'authorization_reference'
     or coalesce(qc->>'seal','') !~ '^[a-f0-9]{64}$'
     or coalesce(qc->>'payload_sha256','') !~ '^[a-f0-9]{64}$'
     or coalesce((qc->>'expires_at')::timestamptz,'-infinity')<=t
     or (qc->>'expires_at')::timestamptz>t+interval '60 seconds'
     or (qc->>'expires_at')::timestamptz>(g->>'expires_at')::timestamptz
     or (g->>'consent_contract_version'='3' and qc->>'approved_content_fingerprint' is distinct from g->>'approved_content_fingerprint')
     or (g->>'consent_contract_version' is distinct from '3' and qc->>'payload_sha256' is distinct from g->>'payload_sha256')
     then raise exception 'REPLACEMENT_CONFIRMATION_BINDING_REQUIRED'; end if;
   outcome:=jsonb_build_object('status','CLAIMED','created_at',t,'claim_id',qc->>'claim_id','expires_at',qc->>'expires_at','binding',qc);
   state:=jsonb_set(state,'{supervised_replacement_quote_claims}',coalesce(state->'supervised_replacement_quote_claims','{}')||jsonb_build_object(g->>'authorization_reference',outcome));
   state:=jsonb_set(state,'{supervised_replacement_quote_history}',coalesce(state->'supervised_replacement_quote_history','{}')||jsonb_build_object(qc->>'claim_id',outcome));
 elsif phase in ('ACTIVATE','DISPATCH') then
   if state->'supervised_replacement_grants'->pid is distinct from g
     or state->'supervised_replacement_quote_claims'->(g->>'authorization_reference')->>'status' is distinct from 'CLAIMED'
     or state->'supervised_replacement_quote_claims'->(g->>'authorization_reference')->'binding' is distinct from qc
     or coalesce((qc->>'expires_at')::timestamptz,'-infinity')<=t
     then raise exception 'REPLACEMENT_CONSENT_OR_QUOTE_CLAIM_CHANGED'; end if;
   if not coalesce(q @> jsonb_build_object('episode_id',episode,'action_id',proposal->>'action_id','replacement_proposal_id',pid,
     'operation_id',opid,'attempt_id',attempt,'model',old.model,'currency','USD','status','QUOTED','payload_sha256',qc->>'payload_sha256','quote_claim_id',qc->>'claim_id'),false)
     or coalesce((q->>'expires_at')::timestamptz,'-infinity')<=t or coalesce((q->>'created_at')::timestamptz,'infinity')>t
     or (q->>'created_at')::timestamptz<(g->>'authorized_at')::timestamptz
     or state->'supervised_replacement_quote_claims'->(g->>'authorization_reference')->'quote' is distinct from q
     or (q->>'reserve_usd')::numeric is distinct from ceil((q->>'estimate_usd')::numeric*1.25*1000000)/1000000
     or coalesce((q->>'estimate_usd')::numeric,0)<=0 or coalesce((q->>'reserve_usd')::numeric,0)<(q->>'estimate_usd')::numeric
     or (q->>'reserve_usd')::numeric>(proposal->>'maximum_new_reservation')::numeric
     then raise exception 'REPLACEMENT_FRESH_QUOTE_REQUIRED'; end if;
   select coalesce(sum(c.current_cost_usd+(select coalesce(sum((v->>'amount_usd')::numeric),0)
     from jsonb_each(coalesce(c.metadata->'budget_reservations','{}')) e(k,v))),0) into exposure
     from public.lumi_pipeline_checkpoints c where c.episode_id=episode
       or (c.metadata->>'target_episode'=episode);
   if exposure+(case when phase='ACTIVATE' then (q->>'reserve_usd')::numeric else 0 end)>cp.authorized_ceiling_usd
     then raise exception 'REPLACEMENT_DOUBLE_EXPOSURE_BUDGET_BLOCKED'; end if;
   if phase='ACTIVATE' then
     nr:=jsonb_populate_record(null::public.lumi_provider_emission_journal,p->'record');
     if nr.attempt_id is distinct from attempt or nr.episode_id is distinct from episode or nr.scene_id is distinct from old.scene_id
       or nr.stage is distinct from old.stage or nr.provider is distinct from old.provider or nr.model is distinct from old.model
       or nr.payload_fingerprint is distinct from qc->>'payload_sha256' or nr.state is distinct from 'PREPARED'
       or nr.expected_cost_usd is distinct from (q->>'estimate_usd')::numeric
       or nr.original_attempt_snapshot->>'supervised_replacement_of' is distinct from old.attempt_id
       or nr.original_attempt_snapshot->>'proposal_id' is distinct from pid
       or nr.payload_descriptor->'identity'->>'idempotency_key' is distinct from proposal->>'planned_idempotency_key'
       then raise exception 'REPLACEMENT_JOURNAL_BINDING_REQUIRED'; end if;
     insert into public.lumi_provider_emission_journal select nr.*;
     metadata:=jsonb_set(cp.metadata,'{budget_reservations}',coalesce(cp.metadata->'budget_reservations','{}')||jsonb_build_object(reservekey,
       jsonb_build_object('status','RESERVED_UNTIL_ACTUAL_CHARGE_VERIFIED','amount_usd',(q->>'reserve_usd')::numeric,'attempt_id',attempt,'binding',qc->>'payload_sha256')));
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
       or cp.metadata->'budget_reservations'->reservekey->>'binding' is distinct from qc->>'payload_sha256'
       or state->'mini_app'->'operations'->opid->>'phase' is distinct from 'DISPATCHING'
       then raise exception 'REPLACEMENT_DISPATCH_CAS_CONFLICT'; end if;
     update public.lumi_provider_emission_journal set state='EMITTING',request_start_at=t where attempt_id=attempt returning * into nr;
     state:=jsonb_set(state,array['mini_app','operations',opid,'phase'],to_jsonb('EMITTING'::text));
   end if;
 else raise exception 'REPLACEMENT_TRANSACTION_PHASE_INVALID'; end if;
 update public.lumi_telegram_review_sessions set state=replacement_tx.state,revision=s.revision+1,updated_at=t where user_id=s.user_id;
 return case when phase in ('ACTIVATE','DISPATCH') then to_jsonb(nr) else jsonb_build_object('status',phase,'provider_calls',0,'new_reservations',0) end;
end $$;
revoke all on function public.lumi_supervised_replacement_v1(jsonb) from public,anon,authenticated;
grant execute on function public.lumi_supervised_replacement_v1(jsonb) to service_role;
commit;
