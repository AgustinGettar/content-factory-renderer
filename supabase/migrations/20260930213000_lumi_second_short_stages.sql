alter table public.lumi_pilot_runs
  drop constraint if exists lumi_pilot_runs_stage_check;

alter table public.lumi_pilot_runs
  add constraint lumi_pilot_runs_stage_check
  check (stage in ('IMAGE','VIDEO','TTS','ASSEMBLY'));
