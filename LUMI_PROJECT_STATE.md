# Lumi Project State

## Current objective

Complete the 48-second short `LUMI_PILOT_CINCO_HUEVOS_V1.mp4` for human creative review.

## Authority

- Production HEAD: `main@5fe5556` (intact)
- Staging HEAD: `47b53d491cc69b2e7a63dd5f3efb7bf054ebdc5e`
- Accepted narrative artifact: `ep_lumi_huevos_001` / `lumi_cinco_huevos`
- Approved reusable video scenes: S11, S12, S13, S14, S15, S16, S17, S18
- Pending scene: S19 repair image, Visual QA, Kling and Temporal QA

## Pilot accounting

- Original image calls: 6
- S19 repair image calls: 0
- Kling calls: 5
- Image cost: USD 0.590649
- Kling cost: USD 1.155000
- Total provider cost: USD 1.745649
- Image hard budget: USD 2.00
- Video hard budget: USD 3.00

## Runtime and gates

- Boot runner: OFF
- Image runner: OFF
- Higgsfield runner: OFF
- autorun: false
- Assembly Gate: 8/9
- Human creative review: pending
- Focused tests for S19 semantics: 28/28 PASS locally
- Relevant regression: 54/54 PASS locally
- Provider calls during S19 repair diagnosis/fix: 0
- VALIDATION_STATUS: `LOCAL_PASS_REMOTE_CI_PENDING`
- BASE_VALIDATION_HEAD: `a088bfaaa4bba51a6493d7633d5c6ed43d079b73`

## Historical environment recovery — superseded

- Earlier Work command-approval and branch-publication blockers were resolved in subsequent runtimes.
- Repair architecture CI run `36646853533` completed GREEN before the real S19 repair preparation failure.
- The current recovery state below supersedes the earlier 0-call pre-pilot checkpoints.

## NEXT_ACTION

Commit and publish the S19 semantics fix to `lumi-pilot-ci-validation`; do not deploy until the new CI run passes.

## DO_NOT_TOUCH

Telegram, Make, queues, publication, approval workflow, Draft→HD production, production Render, `main@5fe5556`, second episode, Compilation Engine, Blender.

## S19 repair semantics recovery — 2026-09-30

- `LAST_COMPLETED_ACTION`: Implemented the minimal repair-lifecycle fix in isolated branch `lumi-s19-repair-semantics`; focused tests 28/28 PASS and relevant regression 54/54 PASS with zero provider calls.
- `FIRST_PENDING_ACTION`: Commit and publish the validated fix to `lumi-pilot-ci-validation`, then require GitHub CI GREEN before staging deploy.
- `ROOT_CAUSE`: The repair ledger acquired `repair_attempt=1`, then `runPilotImageRepair` tried to insert a repair scene specification with the original version `scene-asset-manifest/production-pilot-v1`. The existing unique key `(artifact_id, scene_id, version)` rejected it. `saveSceneSpecification` then searched by the new specification hash, found no row, and threw `asset_v2_persistence_scene_specification_failed` before the provider request.
- `SEMANTIC_BUG`: The old claim stored/announced provider call 1 and every prior repair row blocked another command, so the pre-provider persistence failure was treated as consumed/exhausted.
- `FIX`: Claim/preparation now records zero provider calls and zero cost. A failed-before-provider row is atomically recoverable and preserves history. Only `PROVIDER_REQUEST_EMITTED`, recorded after the provider fetch is initiated, consumes the one-shot. Provider response ID is persisted immediately on response. Restart after emission is rejected without resubmission.
- `SPECIFICATION_FIX`: S19 repair uses `scene-asset-manifest/production-pilot-v1-repair-1`, avoiding the original unique version key; repaired asset lookup/QA is hash-specific.
- `EXISTING_REPAIR_ROW`: id `1eda08fc-03c8-4277-8762-71d65b6f8e98`; status `FAILED`; provider_calls `0`; cost `0`; provider_request_id `null`; artifact/specification/request hashes `null`; preserved for auditable reconciliation.
- `S19_REPAIR_STATE`: `FAILED_BEFORE_PROVIDER`; creative repair opportunity remains unused.
- `S19_PROVIDER_REQUEST_ID`: `null`
- `S19_IMAGE_QA`: `SOURCE_REPAIR_REQUIRED`
- `S19_KLING_REQUEST_ID`: `null`
- `S19_VIDEO_QA`: `NOT_STARTED`
- `ASSEMBLY_GATE`: `8/9`
- `MASTER_STATUS`: `NOT_STARTED`
- `CALL_COUNTS`: original images `6`; repair images `0`; Kling `5`
- `COST`: images `USD 0.590649`; Kling `USD 1.155000`; total `USD 1.745649`
- `RUNNER_STATE`: pilot boot OFF; image runner OFF; Higgsfield runner OFF; autorun=false
- `PRODUCTION`: `main@5fe5556` intact

## S19 repair execution terminal recovery — 2026-09-30

- `LAST_COMPLETED_ACTION`: S19 Kling temporal QA was persisted as `BLOCKER`; all provider one-shots are consumed and no retry or variant is authorized.
- `FIRST_PENDING_ACTION`: Human decision on a future, separately authorized source/video strategy; do not resubmit the existing S19 repair or Kling request.
- `REMOTE_HEAD`: `lumi-pilot-ci-validation@1555ce6c9c294352a94979f76a4136f94e2a5a1d`; validated staging code `av2-staging-runtime@853b7e79abc5d497f84bdb277785277a94d96fd2`.
- `CI_RUN_ID`: `36696076052` — GREEN.
- `TESTS`: focused `28/28 PASS`; relevant regression `54/54 PASS`; zero providers in tests.
- `STAGING`: fix deploy live; health 200 before execution; deploy itself emitted zero provider calls.
- `S19_REPAIR_STATE`: `SUCCEEDED`; previous `FAILED_BEFORE_PROVIDER` history retained in the same repair row.
- `S19_PROVIDER_REQUEST_ID`: `req_a40559d461ef42b182d219bd813e1b30`
- `S19_IMAGE_ASSET_ID`: `883f54de-242d-4cd2-a80c-d1fc9999e8c0`
- `S19_IMAGE_SHA256`: `03c560d00035b31f1efd2c5f5934df93e9f2d1e9bed926483634ef5cc25401d0`
- `S19_IMAGE_QA`: `PASS`; Visual QA V1.2 `qa_passed`; exactly five complete, separated, countable eggs; basket present without pedagogical occlusion; character/world/prop/safe-frame/anatomy/semantic/motion-readiness pass.
- `S19_KLING_REQUEST_ID`: `78fcf851-ba90-4206-b5eb-c09c5825d243`
- `S19_KLING_MODEL`: `kling-video/v3.0/std/image-to-video`; audio OFF; duration 5 s; output bytes `6351855`.
- `S19_VIDEO_SHA256`: `025d0744fe080fc8413d56bd91f55c0b756557e3fa41e02fba8c9fc802457e2a`
- `S19_VIDEO_QA`: `BLOCKER`; at approximately 00:02 five eggs remain on the ground while multiple additional egg-like objects appear in the lifted basket, and Lumi develops a non-canonical striped abdomen/tail. Disposition: `NO_RETRY_NO_VARIANT_STOP`.
- `ASSEMBLY_GATE`: `8/9`
- `MASTER_STATUS`: `NOT_STARTED`; correctly stopped before assembly/master.
- `CALL_COUNTS`: original images `6`; S19 repair images `1`; physical image calls total `7`; Kling calls total `6`.
- `COST`: original images `USD 0.590649`; S19 repair image `USD 0.098905`; images total `USD 0.689554`; Kling total `USD 1.386000`; all providers total `USD 2.075554`.
- `RUNNER_STATE`: pilot boot OFF; repair gate OFF; image runner OFF; Higgsfield runner OFF; autorun=false; manual pilot surface OFF.
- `PRODUCTION`: `main@5fe5556` intact; no production deploy.
- `FINAL_DISPOSITION`: `S19_VIDEO_QA_BLOCKER`; no master; Human Creative Review cannot begin from this S19 video.
