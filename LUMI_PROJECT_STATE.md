# Lumi Project State

## Authority
- Validated code SHA: 472adc82cc4bd9c8582c3a01c3df7e4f0cccb421
- Validated branch: lumi-pilot-ci-validation
- State handoff branch: lumi-pilot-migration-handoff (documentation only; no CI rerun)
- Production authority: main@5fe5556; no production changes during this execution
- Approved reusable scenes: S11, S12, S17
- S13/S14/S15/S16/S18: IMAGE accepted; VIDEO generated; Temporal QA persisted (S13/S15/S16/S18 PASS_WITH_WARNING, S14 PASS)
- S19: SOURCE_REPAIR_REQUIRED; do not reuse for VIDEO
- Accepted narrative: ep_lumi_huevos_001 / lumi_cinco_huevos

## Media Pilot — IMAGE / KLING

- IMAGE_CALLS=6/6
- IMAGE_COST=USD 0.590649
- S13 IMAGE=APPROVED_WITH_WARNING
- S14 IMAGE=APPROVED
- S15 IMAGE=APPROVED_WITH_WARNING
- S16 IMAGE=APPROVED_WITH_WARNING
- S18 IMAGE=APPROVED_WITH_WARNING
- S19 IMAGE=SOURCE_REPAIR_REQUIRED (5 BLOCKERS; eggs partially occluded by basket)
- S13 VIDEO=SUCCEEDED; model=kling-video/v3.0/std/image-to-video; audio=off; request_id=80b042d9-1660-4bd2-bd13-6534f843e88d; output_hash=f47445bc1baa664577927bb0ea1954750d7a339d7b721fd3ee76649de676ae97; TEMPORAL_QA=NOT_RECORDED
- S14 VIDEO=SUCCEEDED; model=kling-video/v3.0/std/image-to-video; audio=off; request_id=300ad518-a453-4f74-ae5d-bbd766677d02; output_hash=c70acabbf431d55c55bac019f1d083dbc09117bf7d5552aa7077d1911dd6a990; TEMPORAL_QA=NOT_RECORDED
- S15 VIDEO=SUCCEEDED; model=kling-video/v3.0/std/image-to-video; audio=off; request_id=cfee3798-5d3e-453e-82a5-2c761c289c51; output_hash=8a1d14f8902947e0aeacf44a202a996e3038fcd4b6ad1e7c44cd70a649fcc0c2; TEMPORAL_QA=NOT_RECORDED
- S16 VIDEO=SUCCEEDED; model=kling-video/v3.0/std/image-to-video; audio=off; request_id=619feac9-f590-4f6f-a717-9a61f4a7051e; output_hash=b2bd94e2926f4ff30c1f8226bd6cd62ab5661a67c066a827ebb8d4705cc719d3; TEMPORAL_QA=NOT_RECORDED
- S18 VIDEO=SUCCEEDED; model=kling-video/v3.0/std/image-to-video; audio=off; request_id=351efe26-7df7-48ca-903e-e35e338aabba; output_hash=aaf56baf7675845d5a70a0595c69bdb5fcfadf756248f1f2d05c1ce564638cff; TEMPORAL_QA=NOT_RECORDED
- KLING_CALLS=5/6
- KLING_COST=USD 1.155000
- TEMPORAL_QA=PASS_WITH_WARNING/PASS for S13/S14/S15/S16/S18
- S19_REPAIR_ATTEMPT=0 (not started; failed source artifact preserved)
- Generated clips are persisted; no retries, no variants, and no resubmissions were issued in this session.
- Temporal QA requires access to the private video objects; no temporal QA record is present in the current runtime.
- ASSEMBLY_GATE=8/9 confirmed after persisted Temporal QA; S19 blocked confirmed reusable clips; 8/9 potential pending Temporal QA; S19 unavailable.

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
- IMAGE_CALLS=6/6
- IMAGE_COST=USD 0.590649
- KLING_CALLS=5/6
- KLING_COST=USD 1.155000
- COST=USD 1.745649
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
REPAIR_S19_SOURCE_IMAGE_ONE_SHOT
Do not execute the repair in this session.
Do not generate more images, retry, create variants, reuse S19 for VIDEO, or exceed the image budget.
Temporal QA persisted for S13/S14/S15/S16/S18; Assembly Gate=8/9. Next authorized action is REPAIR_S19_SOURCE_IMAGE_ONE_SHOT; preserve the failed S19 artifact and do not retry automatically.

## DO_NOT_TOUCH
Production main, Telegram, Make, queues, publication, approval workflow, Draft→HD production.
No CI/tests/npm ci repetition. No runner rewrite without demonstrated defect.
No multimedia before migration/staging/default-OFF/dry-claim gates pass.


## S19 Controlled Repair Attempt — 2026-09-29
- REPAIR_DESIGN=explicit staging-only S19/IMAGE exception; SOURCE_REPAIR_REQUIRED; repair_attempt=0 input; one ledger claim at attempt=1; unique pilot/scene/stage/attempt key; original run/asset/QA preserved; no general retry/variant/terminal regeneration.
- REPAIR_TESTS=PASS: normal terminal claim blocked; non-S19 rejected; VIDEO rejected; missing SOURCE_REPAIR_REQUIRED rejected; production rejected; attempt 0 accepted; duplicate rejected; attempt 1 rejected; provider not invoked by tests.
- CI=GREEN run 36646853533 (focused + relevant regression).
- MIGRATION=yes additive lumi_pilot_repairs; RLS enabled; anon/authenticated denied; service_role only; dry insert/duplicate/rollback PASS; zero fake rows.
- STAGING=LIVE commit 47b53d491cc69b2e7a63dd5f3efb7bf054ebdc5e; health HTTP 200; repair flag was enabled only for the one controlled boot and is now OFF.
- DRY_REPAIR_PROOF=PASS (attempt 0 accepted logically; duplicate rejected; rollback cleanup left no rows).
- S19_REPAIR_ATTEMPT=1
- S19_REPAIR_STATUS=SOURCE_REPAIR_FAILED / S19_REPAIR_EXHAUSTED
- S19_REPAIR_ERROR=asset_v2_persistence_scene_specification_failed before new asset/provider request persisted; no repair request ID; no repair hash; original S19 artifact and blockers preserved.
- S19_VIDEO=NOT_EXECUTED (repair failed; no Kling call).
- IMAGE_CALLS=6/6
- IMAGE_COST=USD 0.590649
- KLING_CALLS=5/6
- KLING_COST=USD 1.155000
- ASSEMBLY_GATE=8/9
- NEXT_ACTION=SOURCE_REPAIR_FAILED_NO_RETRY
- RUNNER_OFF=YES; AUTORUN=false
- PRODUCTION=main@5fe5556395829e78817771f96d33cce3f692965d intact; no production deploy.
