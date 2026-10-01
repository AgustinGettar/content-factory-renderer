# Lumi Second Short — Reproducibility Report

- `ORIGINAL_IMAGE_CALLS=9`
- `REPAIR_IMAGE_CALLS=0`
- `ORIGINAL_KLING_CALLS=5`
- `REPAIR_KLING_CALLS=0`
- `TTS_CALLS=0`
- `MANUAL_USER_INTERVENTIONS=1` (explicit controlled-repair authorization)
- `SYSTEM_INTERVENTIONS=3` (runtime budget-rounding fix; explicit QA classification/persistence; repair forensic review and cost-gate enforcement)
- `AUTOMATIC_RETRIES=0`
- `AUTOMATIC_VARIANTS=0`
- `RESUBMITS=0`
- `IMAGE_CALLS=9`
- `KLING_CALLS=5`
- `TTS_CALLS=0`
- `TOTAL_PROVIDER_CALLS=14`
- `TOTAL_COST_USD=2.030350`
- `REPAIR_COST_USD=0.000000`
- `MAX_PLANNED_REPAIR_INCREMENT_USD=1.780398`
- `EXPECTED_TOTAL_BEFORE_TTS_IF_AUTHORIZED_USD=3.810748`
- `NATURAL_DURATION_TARGET_SECONDS=43_TO_47_NOT_FORCED`
- `NEW_COMPLETION_CEILING_REQUEST_USD=3.822498`
- `PRODUCTION_MANIFEST_CEILING_USD=2.978645`
- `COST_GATE=BLOCKED_BY_CEILING`
- `VISUAL_QA_BLOCKERS=4`
- `TEMPORAL_QA_BLOCKERS=2`
- `GENERATED_CLIP_FREEZE_DEFECTS=0`
- `GENERATED_CLIP_BLACK_FRAME_SEGMENTS=0`
- `ASSEMBLY_GATE=BLOCKED_3_OF_9`
- `MASTER_STATUS=NOT_CREATED`

The run proved exactly-once provider dispatch and restart safety, but did not prove unattended end-to-end master production. The image prompt compiler over-applied world continuity to single-shape and guided-example scenes. The video motion contract also failed to keep option/final props front-facing in two clips. Per policy, no blocked scene was retried or resubmitted and no partial master was created.

The explicit repair review classified `s22`–`s25` as source-image-plus-video repairs and `s27`/`s29` as video-only repairs reusing their Visual-QA-PASS source images. The minimum package is four image calls plus six Kling calls. Its maximum increment is USD 1.780398, which would bring the accounted total to USD 3.810748 before TTS—USD 0.832103 above the approved Production Manifest ceiling. The cost gate therefore stopped execution before any repair claim or provider dispatch. Assembly remains `3/9`; freeze defects remain `0`; master remains `NOT_CREATED`.

## Cost optimization V2

- `VIDEO_GENERATION_READINESS_GATE_V2=PASS_IMPLEMENTED_FAIL_CLOSED`
- `HIGGSFIELD_PROMPT_COMPILER_V2=PASS_IMPLEMENTED`
- `VIDEO_SOURCE_READINESS_V1=PASS_IMPLEMENTED`
- `SCENE_RISK_CLASSIFIER=PASS_IMPLEMENTED`
- `EXPECTED_VALUE_GATE=PASS_IMPLEMENTED`
- `PRODUCTION_PRESET_V1_1=READY_NOT_GLOBALLY_ACTIVE`
- `CFG_SCALE_TUNING_REQUIRED=true`
- `END_FRAME_MODE=NONE`
- `LAST_IMAGE_URL_ENABLED=false`
- `FOCUSED_TESTS=26/26_PASS`
- `TEST_PROVIDER_CALLS=0`
- `CI_RUN=36866322451`
- `CI_RESULT=GREEN`
- `VALIDATION_COMMIT=0e38f1f24ca94004f3adfa4f13b64e420a008111`
- `REPAIR_AUTHORIZATION_GRANTED=false`

The gate now executes before the persistent video claim. The source-image compiler uses an exact exclusive inventory instead of carrying the old three-pedestal continuity ambiguity. The six repair contracts compile, but the current sources for `s22`–`s25` remain terminal blockers. `s27` and `s29` require only a zero-provider source-readiness reinspection/backfill before their video-only repair can be dispatched.

Minimum provider work is still four image repairs plus six Kling repairs after every gate passes. The implementation improves expected success qualitatively by rejecting bad sources and excessive motion at zero Kling cost; it does not justify a numeric success guarantee or reduce the unavoidable minimum call count. A phased authorization can cap the first step at `USD 0.394398` (four source repairs, total `USD 2.424748`) before any further Kling spend.

## Human-review gates

- `TEXT_OVER_LUMI=FORBIDDEN`
- `CHARACTER_TEXT_EXCLUSION_ZONE=PASS_IMPLEMENTED_FAIL_CLOSED`
- `TEXT_CHARACTER_OVERLAP=0_REQUIRED`
- `EDUCATIONAL_OBJECT_OVERLAP_WHEN_CRITICAL=0_REQUIRED`
- `PEDAGOGICAL_PAUSE_TECHNICAL_LABEL_VISIBLE=false`
- `PERCEIVED_PLAYBACK_SPEED=NATURAL_1X`
- `EDITORIAL_MASTER_READINESS_GATE_V1=PASS_IMPLEMENTED_FAIL_CLOSED_PENDING_EDIT`
- `HIGGSFIELD_PROMPT_COMPILER_V2=2.1.0_NATURAL_REAL_TIME`
- `FULL_LOCAL_SUITE=160/161_PASS`

The six repair prompts were recompiled with natural real-time motion, normal conversational gesture speed, and explicit prohibitions on slow motion, dreamy movement, and prolonged holds. `s27` retains only its exact 2.5-second response window, static camera, and one natural blink. The dry plan also requires dynamic frame-level placement around Lumi and critical teaching objects and suppresses technical pause labels.

The content-driven edit target is 43–47 seconds with a 45.5-second working estimate; no clip may be stretched merely to reach the old 49-second plan. At the USD 0.015/minute planning rate, TTS is estimated at USD 0.010750 for 43 seconds, USD 0.011375 for 45.5 seconds, and capped at USD 0.011750 for 47 seconds. This yields a new completion range estimate of USD 3.821498–3.822498 and a preferred estimate of USD 3.822123. No TTS call occurred.

The full suite's only failure remains the unrelated absent external fixture `/workspace/scratch/f10a12ff9859/visual-benchmark-v1/lumi-master.png`. The focused zero-provider workflow passed on GitHub Actions run `36866322451`.

## Phase 1 repair executor checkpoint

- `RECOVERY_HEAD=a5927884e0b3c018ca992728e53cbb2cacedd6fb`
- `REPAIR_EXECUTOR_LOCAL_COMMIT=8cb7e2e`
- `REPAIR_EXECUTOR_STATUS=IMPLEMENTED_LOCAL_COMMIT_UNPUSHED`
- `FOCUSED_REPAIR_AND_REGRESSION_TESTS=103/103_PASS`
- `REAL_PROVIDER_CALLS_DURING_TESTS=0`
- `MIGRATION_STATUS=NOT_REQUIRED_EXISTING_LEDGER_REUSED`
- `CI_STATUS=NOT_STARTED_PUSH_BLOCKED`
- `STAGING_STATUS=NOT_DEPLOYED`
- `DRY_REPAIR_PROOF=NOT_RUN`
- `REPAIR_IMAGE_CALLS=0`
- `REPAIR_COST_USD=0.000000`
- `TOTAL_COST_USD=2.030350`
- `SIX_SOURCE_GATES=NOT_RUN`

The existing `lumi_pilot_runs` uniqueness contract is reused with four distinct revision ledger identities, preserving the original terminal rows unchanged. The new manual executor is fail-closed to staging, `IMAGE`, `s22`–`s25`, and `R1`; it has no boot hook or autorun and consumes dispatch durably before the network request. No schema or RLS change was needed.

The attempted push was rejected by the external-destination safety gate pending explicit confirmation of `github.com/AgustinGettar/content-factory-renderer`. The confirmation request timed out, so CI, staging deploy, dry proof, real source repairs and six-source review did not begin.
