begin;

alter table public.av2_creative_artifacts
  drop constraint av2_creative_artifacts_generation_attempt_check,
  add constraint av2_creative_artifacts_generation_attempt_check
    check (generation_attempt >= 1 and generation_attempt <= 3);

commit;
