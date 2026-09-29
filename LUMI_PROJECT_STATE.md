# Lumi Project State

## Authority
- Validated code SHA: 472adc82cc4bd9c8582c3a01c3df7e4f0cccb421
- Validated branch: lumi-pilot-ci-validation
- State handoff branch: lumi-pilot-migration-handoff (documentation only; no CI rerun)
- Production authority: main@5fe5556; no production changes during this execution
- Approved reusable scenes: S11, S12, S17
- S13/S14/S15/S16/S18/S19: NOT_STARTED
- Accepted narrative: ep_lumi_huevos_001 / lumi_cinco_huevos

## Gates
- PILOT_CODE_VALIDATED=YES
- CI_RUN_ID=36634634737
- NPM_CI=PASS
- SYNTAX=PASS
- FOCUSED_TESTS=19/19
- REGRESSION=54/54
- SECURITY_DIFF=PASS (test helper only; no secrets)
- PILOT_MIGRATION=PASS
- MIGRATION_NAME=lumi_pilot_internal_runs
- MIGRATION_VERSION=20260929220840
- SUPABASE_PROJECT=hdptwtzhpfdrqiuezjhu (Content Factory)
- Schema/columns/types/timestamps/constraints/indexes=PASS
- Unique key=pilot_id+scene_id+stage
- RLS=enabled
- anon/authenticated=DENIED (SELECT/INSERT/UPDATE)
- service_role=ALLOWED (SELECT/INSERT/UPDATE); transactional INSERT/UPDATE operational
- Valid IMAGE/VIDEO, duplicate rejection, invalid stage/status rejection, terminal states=PASS
- TRANSACTIONAL_ROLLBACK=PASS
- PILOT_ROWS=0
- STAGING_DEPLOY=LIVE
- STAGING_SHA=d373641e234e3b1b1985cd2348149a07ddcfc5b2
- STAGING_DEPLOY_ID=dep-dau3g8h7lnhs73f9av70
- STAGING_HEALTH=HTTP 200 / ok=true
- PRODUCTION_HEALTH=HTTP 200 / ok=true; active_video_id=null; queue_length=0
- PRODUCTION_LIVE_SHA=5fe5556395829e78817771f96d33cce3f692965d
- PRODUCTION_DEPLOY_UNCHANGED=dep-dako6lvqj5pc73d8qju0
- STAGING_DEFAULT_OFF_PROOF=PASS (MERGE flags false; health autorun/enabled=false; post-deploy logs contain no provider activity)
- DRY_CLAIM_DB=PASS (S13 IMAGE first insert accepted, second unique-key insert rejected/cache-safe; terminal states representable; service_role; rollback)
- DRY_CLAIM_RUNTIME=PENDING: Render connector exposes no remote command/job execution or dry-only runner operation. Existing boot runner invokes providers after a successful claim. Do not enable it for a dry proof.
- DRY_CLAIM_FULL_GATE=PENDING
- CLEANUP=PASS; pilot_rows=0; s13_image_rows=0; S13 real=NOT_STARTED

## Accounting
- IMAGE_CALLS=0/6
- KLING_CALLS=0/6
- COST=USD 0
- IMAGE_HARD_BUDGET=USD 2.00
- VIDEO_HARD_BUDGET=USD 3.00
- ASSEMBLY_GATE=3/9
- MASTER=NOT_CREATED

## Runtime
- LUMI_RUNTIME_ENV=staging configured by MERGE.
- LUMI_PILOT_BOOT_ENABLED=false; AV2_PILOT_RUN_ON_BOOT=false.
- LUMI_PRODUCTION_PILOT_ENABLED=false.
- AV2_RUN_BENCHMARK_ON_BOOT=false.
- ASSET_V2_RUN_VISUAL_BENCHMARK_ON_BOOT=false.
- ASSET_V2_RUN_VISUAL_BENCHMARK_V11_ON_BOOT=false.
- HIGGSFIELD_BENCHMARK_V1_ENABLED=false; HIGGSFIELD_BENCHMARK_V11_ENABLED=false.
- PILOT_BOOT_ENABLED=false; IMAGE_RUNNER=false; HIGGSFIELD_RUNNER=false; AUTORUN=false.
- Env MERGE triggered an initial default-OFF deploy of the prior SHA; then deployed sanitized CI-validated runtime.
- Sanitized runtime contains the exact validated runtime/test/migration blobs; no CI rerun and no provider calls.
- No production mutation performed.

## NEXT_ACTION
Complete runtime-level claimPilotRun integration proof through an authorized provider-free remote execution capability. No such capability is exposed by the current Render connector.
Do not equate the completed SQL/DB proof with running claimPilotRun in staging.
Latest user instruction explicitly prohibits providers; keep all flags OFF and all scene generation NOT_STARTED.
No credential request, HTTP execution workaround, Cloud Browser, Make, or runner rewrite.

## DO_NOT_TOUCH
Production main, Telegram, Make, queues, publication, approval workflow, Draft→HD production.
No CI/tests/npm ci repetition. No runner rewrite without demonstrated defect.
No multimedia before migration/staging/default-OFF/dry-claim gates pass.
