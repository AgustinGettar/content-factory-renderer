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
- `FOCUSED_TESTS=17/17_PASS`
- `TEST_PROVIDER_CALLS=0`
- `CI_RUN=36863860310`
- `CI_RESULT=GREEN`
- `VALIDATION_COMMIT=e65acc8249115cbf29713a9ae9b6572957e79145`
- `REPAIR_AUTHORIZATION_GRANTED=false`

The gate now executes before the persistent video claim. The source-image compiler uses an exact exclusive inventory instead of carrying the old three-pedestal continuity ambiguity. The six repair contracts compile, but the current sources for `s22`–`s25` remain terminal blockers. `s27` and `s29` require only a zero-provider source-readiness reinspection/backfill before their video-only repair can be dispatched.

Minimum provider work is still four image repairs plus six Kling repairs after every gate passes. The implementation improves expected success qualitatively by rejecting bad sources and excessive motion at zero Kling cost; it does not justify a numeric success guarantee or reduce the unavoidable minimum call count. A phased authorization can cap the first step at `USD 0.394398` (four source repairs, total `USD 2.424748`) before any further Kling spend.
