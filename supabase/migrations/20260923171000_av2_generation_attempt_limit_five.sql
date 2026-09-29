alter table public.av2_creative_artifacts
  drop constraint av2_creative_artifacts_generation_attempt_check,
  add constraint av2_creative_artifacts_generation_attempt_check
    check (generation_attempt >= 1 and generation_attempt <= 5);

update public.av2_creative_artifacts
set status = 'failed', updated_at = now()
where id = '090490f8-0e75-47ca-8a2c-5f3340c7f413'
  and benchmark_id = 'lumi_cinco_huevos'
  and generation_attempt = 4
  and content_hash is null
  and validation_status = 'invalid'
  and status = 'repairing';
