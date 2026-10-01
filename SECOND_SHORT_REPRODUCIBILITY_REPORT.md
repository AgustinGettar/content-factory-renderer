# Lumi Second Short — Reproducibility Report

- `ORIGINAL_IMAGE_CALLS=9`
- `REPAIR_IMAGE_CALLS=4`
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
- `TOTAL_PROVIDER_CALLS=18`
- `TOTAL_COST_USD=2.422187`
- `REPAIR_COST_USD=0.391837`
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

## Phase 1 source execution result

- `REMOTE_HEAD=d094575b4e0e781725060b0220179c38177a506f`
- `REMOTE_TREE=49227ac4e8728c4ec19964611dbdd715408d3d90`
- `PRESERVED_LOCAL_CHECKPOINT=bf858a8f32348d79e9f42765f91ff9b4ea467145`
- `CI_RUN=36910887975`
- `CI_RESULT=GREEN`
- `FOCUSED_REPAIR_AND_REGRESSION_TESTS=103/103_PASS`
- `STAGING_SHA=d094575b4e0e781725060b0220179c38177a506f`
- `STAGING_HEALTH=200`
- `UNEXPECTED_EXECUTIONS=0`
- `DRY_REPAIR=PASS_DRY_NO_PROVIDER_NO_WRITE`
- `IMAGE_REPAIR_CALLS=4`
- `IMAGE_REPAIR_COST_USD=0.391837`
- `TOTAL_COST_USD=2.422187`
- `SIX_SOURCE_GATES=FAIL_4_OF_6_SOURCE_BLOCKERS`
- `KLING_REPAIR_CALLS=0`
- `TTS_CALLS=0`
- `ASSEMBLY=3/9`
- `RUNNERS=OFF`
- `PRODUCTION=main@5fe5556395829e78817771f96d33cce3f692965d_LIVE_UNCHANGED`

The GitHub connector reproduced the two preserved commits from their exact Git trees because the shell clone had no GitHub credentials. Commit IDs therefore changed, but both tree IDs match the local preserved commits byte-for-byte. The isolated validation branch and the fixed staging branch were advanced only by non-forced fast-forward. `main` was not modified.

CI run `36910887975` passed syntax/JSON validation and the zero-provider readiness/second-short regression job. Staging reached LIVE on the validated SHA with health 200, empty queue, no active video, all boot benchmark flags false, no pilot or second-short autorun, and no unexpected execution in startup logs.

The `s22-r1` dry proof preserved the original terminal row, used a distinct revision identity, accepted the simulated first claim, rejected the duplicate, proved restart-before-provider resumability, respected the exact Phase 1 budget, emitted zero provider calls, and created zero fake rows.

Exactly four serialized provider requests were then emitted. No retry, variant, resubmit, Kling, TTS, assembly, or master action occurred:

- `s22-r1`: `req_1673fa114e92430aa537e1510a9ba595`; hash `f3d28d58cdeb9130375f446119fd34d7dcbf94369136a4e55422f326168e56bf`; actual cost `USD 0.097900`; Visual QA V1.2 `BLOCKER`; `VIDEO_SOURCE_READINESS_V1=FAIL`. The single rigid circle has a black/dark face instead of the required unmistakable blue.
- `s23-r1`: `req_d38ffceda7b5490da58f485428982fc7`; hash `600a027994a0594b994ac79a0a729e033d8031e32f636f460b316679c7b0fb19`; actual cost `USD 0.097925`; Visual QA V1.2 `BLOCKER`; `VIDEO_SOURCE_READINESS_V1=FAIL`. The single three-sided triangle has a black/dark face instead of the required unmistakable yellow.
- `s24-r1`: `req_da02bd8b469f40509d14c6e13d962304`; hash `5944817b26393fcf736206dbc0a5423b33a43486f558bfcdc93b9807d4af6046`; actual cost `USD 0.097927`; Visual QA V1.2 `BLOCKER`; `VIDEO_SOURCE_READINESS_V1=FAIL`. The single equal-sided square has a black/dark face instead of the required unmistakable coral.
- `s25-r1`: `req_4a7cea4092fc4d26b4abca181f26e54f`; hash `991179f876db84bc01ac105a353dce1f5a6bc21abb136b0a18fb74de440250a1`; actual cost `USD 0.098085`; Visual QA V1.2 `BLOCKER`; `VIDEO_SOURCE_READINESS_V1=FAIL`. The correct moon disc, triangular pennant, and square window are present without lantern substitution, but on open pedestals rather than in the three required separate alcoves.

Offline reevaluation used the immutable original sources and their manifest hashes:

- `s27`: hash `9877f0e813d0ec191f9088793f58e8258e61084e19315d0ad34b430e4510e598`; `VIDEO_SOURCE_READINESS_V1=PASS`; `VIDEO_GENERATION_READINESS_GATE_V2=PASS`; expected-value gate `PASS`; blink only, static camera, natural 1x, exact `2.5 s` pedagogical pause.
- `s29`: hash `f4be008318fdc8123a8b526329b2c60b203d8806bc46f4e1f566412e2644ead7`; `VIDEO_SOURCE_READINESS_V1=PASS`; `VIDEO_GENERATION_READINESS_GATE_V2=PASS`; expected-value gate `PASS`; one natural wave plus blink, static camera, natural 1x.

Because only two of six sources are ready, `SIX_SOURCE_GATES` is terminally `FAIL` for Phase 1. The manual Phase 1 execution flag was turned OFF after the fourth request. `LUMI_RECOVERY_INCIDENT_MANAGER_V1` remains backlog-only and unimplemented.
