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

## Security deploy and S19-R2 preparation — 2026-09-30

- `LAST_COMPLETED_ACTION`: Deployed the CI-validated durable provider-dispatch guard from `lumi-pilot-ci-validation@6ccab977765e5d6d48b6eb6cc079e391f819d201` as sanitized staging runtime `av2-staging-runtime@bd34e022b479374fc4a9a7a2e57e456bd42ffcb2`; Render deploy `dep-dauf76u0tbcc73f6suq0` is LIVE, `/health` returned HTTP 200, and deploy/startup logs contain zero image or Kling provider execution.
- `FIRST_PENDING_ACTION`: Obtain explicit authorization for one S19-R2 IMAGE execution and, only after its Visual QA passes, one S19-R2 Kling execution.
- `SECURITY_FIX_DEPLOYED`: `true`
- `SECURITY_FIX_SOURCE`: `6ccab977765e5d6d48b6eb6cc079e391f819d201`; local tests `83/83 PASS`; CI `36705669398 GREEN`.
- `STAGING_SHA`: `bd34e022b479374fc4a9a7a2e57e456bd42ffcb2`
- `STAGING_HEALTH`: `200`; service `content-factory-av2-staging`; active video `null`; queue length `0`.
- `RUNNERS`: `LUMI_RUNTIME_ENV=staging`; pilot boot OFF; repair gate OFF; image runners OFF; Higgsfield runners OFF; AV2 benchmark boot OFF; autorun=false.
- `UNEXPECTED_PROVIDER_CALLS_DURING_DEPLOY`: image `0`; Kling `0`.
- `PRODUCTION`: `main@5fe5556395829e78817771f96d33cce3f692965d`; health HTTP 200; no new deploy; unchanged.
- `S19_TERMINAL`: `true`; original claims and history remain closed and immutable; no status reset, retry, resubmit, request-ID reuse or provider call occurred.
- `S19_IMAGE_REQUEST_ID`: `req_a40559d461ef42b182d219bd813e1b30`
- `S19_KLING_REQUEST_ID`: `78fcf851-ba90-4206-b5eb-c09c5825d243`
- `S19_IMAGE_QA`: `PASS`
- `S19_VIDEO_QA`: `BLOCKER` — additional eggs appear in the basket and Lumi develops a non-canonical abdomen/tail.
- `ASSEMBLY_GATE`: `8/9`
- `MASTER_STATUS`: `NOT_STARTED`

### S19-R2 minimal canonical representation

- `S19_R2_DESIGN_STATUS`: `DEFINED_SAFE_NOT_EXECUTED`
- `REVISION_ID`: `s19-r2`; `PILOT_ID`: `lumi_cinco_huevos_v1_s19_r2`; canonical scene remains `s19`; narrative purpose remains `recap_and_close`.
- `SEMANTICS`: S19-R2 is a new explicit creative revision, not `repair_attempt=2`, not a retry/variant of either terminal request, and does not modify the original `lumi_pilot_runs` or `lumi_pilot_repairs` records.
- `EXISTING_MECHANISMS_ONLY`: use `lumi_pilot_runs` with the distinct revision pilot ID and its existing unique key `(pilot_id, scene_id, stage)` for one IMAGE row and one VIDEO row; pass `maxCalls=1` per stage. Use the existing Asset V2 manifest/asset lineage fields; no schema migration or arbitrary retry architecture is required.
- `IMAGE_IDENTITY`: manifest version `scene-asset-manifest/production-pilot-v1-s19-r2`; asset variant `production_pilot_v1_source_s19_r2`; new specification/request hashes; `parent_asset_id=883f54de-242d-4cd2-a80c-d1fc9999e8c0`; provenance metadata names parent scene `s19`, revision `s19-r2`, and both terminal request IDs without reusing them.
- `VIDEO_IDENTITY`: revision-scoped immutable storage prefix containing `s19-r2`, source hash and prompt hash; its own planned/submitted/completed records. A durable planned record precedes submission; ambiguous dispatch blocks resubmission. It never reads or writes the terminal S19 video base path.
- `AUTHORIZATION_GATE`: staging only; exact revision `s19-r2`; exact scene `s19`; explicit `LUMI_S19_R2_ENABLED=true`; IMAGE maximum once and Kling maximum once; no boot hook or autorun. Production, other scenes, duplicate claims and any pre-existing/ambiguous stage row are rejected before provider dispatch.
- `SOURCE_IMAGE_CONSTRAINTS`: exactly five canonical eggs (`egg_01` through `egg_05`) simultaneously visible, complete, unoccluded, clearly separated and individually countable; no additional, duplicated, fused or hidden egg; basket must not cover any egg. Preserve full Lumi Character Lock, canonical silhouette, torso, wings, limbs, face, clothing and wand; forbid added abdomen, tail, appendages, torso deformation or silhouette mutation. Preserve world, camera, lighting and recap purpose.
- `KLING_EGG_CONSTRAINTS`: exact egg count remains five for every frame; no appearance, disappearance, duplication, fusion, morphing or count-changing movement between basket interior/exterior.
- `KLING_LUMI_CONSTRAINTS`: canonical body silhouette throughout; no abdomen growth, tail, extra limbs, body elongation or torso mutation; canonical wings remain stable; hands and arms remain anatomically coherent.
- `KLING_MOTION_CONSTRAINTS`: conservative animation, natural small gestures, no aggressive body transformation, minimal camera movement when needed for stability, and continuous pedagogical readability.
- `RESTART_AND_DUPLICATE_POLICY`: acquiring either revision stage consumes that stage's sole authorized opportunity before dispatch; the existing unique ledger key rejects concurrent/duplicate acquisition; image specification claiming and video `planned.json` preserve restart safety; no automatic resubmission after an ambiguous dispatch.
- `PROVIDER_EXECUTION`: `0`; no S19-R2 image, Kling video or master exists.
- `NEXT_ACTION`: `AUTHORIZE_S19_R2_EXECUTION`

## S19-R2 authorized execution checkpoint — 2026-09-30

- `AUTHORIZATION`: explicit user authorization received for one new S19-R2 image, then one Kling only after Visual QA; no retries, variants or resubmits; staging only. Master permitted only if Assembly reaches 9/9.
- `LAST_COMPLETED_ACTION`: recovered Git/Render/ledger; confirmed staging security fix LIVE `bd34e02`, health 200, all runners OFF; production LIVE `5fe5556`, health OK. Original S19 repair SUCCEEDED and video temporal BLOCKER preserved. No R2 storage objects existed. Implemented isolated manual R2 endpoint and existing-ledger exactly-once guard, without provider execution.
- `FIRST_PENDING_ACTION`: validate and publish/deploy the isolated R2 runtime with runners OFF; persist a new R2 ledger claim and durable dispatch boundary before the sole authorized image call.
- `S19_R2_DESIGN_STATUS`: `IMPLEMENTED_LOCAL_VALIDATION_PENDING_DEPLOY`
- `S19_R2_IMAGE_CALLS`: `0`
- `S19_R2_KLING_CALLS`: `0`
- `ASSEMBLY_GATE`: `8/9`; master not created.
- `NEXT_ACTION`: `VALIDATE_DEPLOY_R2_MANUAL_RUNTIME`

## S19-R2 terminal Visual QA checkpoint — 2026-09-30

This checkpoint supersedes the historical NOT_EXECUTED and validation/deploy-pending entries above. Read the ledger before any action; never reissue R2 IMAGE.

- `LAST_COMPLETED_ACTION`: sole authorized R2 image completed, downloaded/hash-verified and inspected. Visual QA BLOCKER persisted with both observations retained. R2 manual gate disabled and token cleared; restart deploy `dep-daufpe8jo6nc7388hsk0` LIVE, health 200, no subsequent provider execution. Original terminal records and production verified unchanged.
- `FIRST_PENDING_ACTION`: `HUMAN_CREATIVE_DECISION_AFTER_S19_R2_SOURCE_BLOCKER`; no retries or automatic new revision. No remaining authorization permits Kling on this rejected image.
- `SECURITY_FIX_DEPLOYED`: `true`; durable dispatch guard from source `6ccab97` remains deployed.
- `STAGING_SHA`: `45ffec97ca026519a3233fd2afc38b45f326e6e8`
- `STAGING_HEALTH`: `200`; LIVE; active video null; queue 0; auto-deploy OFF.
- `VALIDATION`: CI `36712435502 GREEN`; focused tests `20/20 PASS`; zero real providers in tests.
- `RUNNERS`: `LUMI_RUNTIME_ENV=staging`; pilot boot OFF; repair gate OFF; image runners OFF; Higgsfield runners OFF; AV2 benchmark boot OFF; production pilot OFF; isolated R2 manual gate OFF; manual token cleared; autorun=false.
- `UNEXPECTED_PROVIDER_CALLS`: image `0`; Kling `0`; the explicitly authorized R2 image is accounted separately.
- `PRODUCTION`: LIVE `main@5fe5556395829e78817771f96d33cce3f692965d`; health 200; deploy remains `dep-dako6lvqj5pc73d8qju0`; no new deploy or modification.
- `S19_TERMINAL`: `true`; original repair/video claims, histories, provenance and IDs preserved without mutation or re-emission.
- `S19_IMAGE_REQUEST_ID`: `req_a40559d461ef42b182d219bd813e1b30`
- `S19_KLING_REQUEST_ID`: `78fcf851-ba90-4206-b5eb-c09c5825d243`
- `S19_R2_DESIGN_STATUS`: `IMPLEMENTED_VALIDATED_EXECUTED_IMAGE_QA_BLOCKER_TERMINAL`
- `S19_R2_TERMINAL`: `true`; creative revision `s19-r2`, pilot `lumi_cinco_huevos_v1_s19_r2`; not a retry of S19.
- `S19_R2_IMAGE_LEDGER_ID`: `3dc857b5-1425-4527-a237-a3abf42b6a24`; provider status SUCCEEDED; `dispatch_consumed=true`; lifecycle `VISUAL_QA_BLOCKER_TERMINAL`. Provider success is not QA acceptance.
- `S19_R2_IMAGE_REQUEST_ID`: `req_5b1627f296b441178296ef1e87826a8b`
- `S19_R2_IMAGE_ASSET_ID`: `dd627c4b-b145-4edc-b5e8-475b7767f235`; status rejected; parent asset `883f54de-242d-4cd2-a80c-d1fc9999e8c0`.
- `S19_R2_SOURCE_SHA256`: `e2d6de1afd4b50a7e702c056bac9b1ea900203f16914d29f1cde8eb3bfc395aa`; PNG 1152x2048.
- `S19_R2_STORAGE`: `av2-assets-v2/090490f8-0e75-47ca-8a2c-5f3340c7f413/s19-r2/source/15d548e58fcb992fb9f488867964df9ca020a757f65662c085d4c50d5cdc0baf/source.png`.
- `S19_R2_VISUAL_QA`: BLOCKER. Five distinct eggs are countable, but the front woven basket rim hides each egg's lower shell/base. All five full-visibility/no-occlusion contracts fail. Lumi anatomy/identity pass; two noncritical safe-inset warnings. Final QA V1.2 counts: 5 BLOCKER, 2 WARNING, 0 INFO. Observation 1 preserved; corrected motion-readiness observation preserved as run 2.
- `S19_R2_QA_EVIDENCE`: `qa/s19-r2-visual-qa.json`; manual full-resolution observations and deterministic Visual QA evaluator results, also persisted in Supabase.
- `S19_R2_IMAGE_CALLS`: `1`; sole IMAGE opportunity consumed and closed.
- `S19_R2_IMAGE_ACTUAL_COST_USD`: `0.099242`, based on returned usage.
- `S19_R2_KLING_CALLS`: `0`; no VIDEO ledger or request; ineligible because Visual QA failed.
- `ASSEMBLY_GATE`: `8/9`
- `MASTER_STATUS`: `NOT_STARTED`; `LUMI_PILOT_CINCO_HUEVOS_V1.mp4` and `SHORT_MASTER_MANIFEST_V1` not created. No audio generation or assembly.
- `CUMULATIVE_CALL_COUNTS`: physical images 8 (original 6 + S19 repair 1 + R2 1); Kling 6 (unchanged).
- `CUMULATIVE_COST`: actual images USD 0.788796; historical Kling booked/estimated USD 1.386000 (provider actual unavailable); combined actual-image plus booked-video total USD 2.174796. Do not call the video estimate actual spend.
- `PROTECTED_SCOPE`: S13-S18 untouched; no Make, Telegram, social publication, production deployment, retry, variant, resubmit or master.
- `CLOUD_ONLY_CONTINUATION`: latest user cloud-only instruction acknowledged; checkpoint closure uses GitHub, Render and Supabase connectors only, no user computer execution. No missing local-computer capability caused the stop; the creative QA gate caused it.
- `FINAL_DISPOSITION`: `NO_KLING_NO_RETRY_NO_VARIANT_NO_MASTER`
- `NEXT_ACTION`: `HUMAN_CREATIVE_DECISION_NO_PROVIDER_AUTHORIZATION`
