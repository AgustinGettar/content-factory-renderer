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
