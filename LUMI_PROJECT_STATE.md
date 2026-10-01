# Lumi Project State

## Current authoritative state

- `PILOT_APPROVED=true`
- `PILOT_MASTER_STATUS=HUMAN_APPROVED`
- `PILOT_MASTER_VERSION=V1.1`
- `PILOT_MASTER_SHA=51d354c230972478ef784fc29ecfe0ad32d5f441ed2bfff0c00b33bb60eaf18c`
- `PILOT_DURATION=49.17`
- `PILOT_RESOLUTION=1080x1920`
- `PILOT_VIDEO_CODEC=H.264`
- `PILOT_AUDIO_CODEC=AAC`
- `FREEZE_QA=PASS`
- `ACCIDENTAL_FREEZE_SECONDS=0`
- `ASSEMBLY=9/9`
- `HUMAN_REVIEW=APPROVED`
- `PRODUCTION_PRESET_V1=READY`
- `PRODUCTION_PRESET_V1_ACTIVE=false`
- `LAST_COMPLETED_ACTION=SECOND_SHORT_REPAIR_FORENSICS_AND_COST_GATE`
- `SECOND_SHORT_STATUS=REPAIR_BLOCKED_BY_APPROVED_BUDGET_CEILING`
- `SECOND_SHORT_EPISODE_ID=ep_lumi_formas_002`
- `SECOND_SHORT_DURATION=49.0`
- `SECOND_SHORT_SCENES=9/9_PLANNED`
- `SECOND_SHORT_DRY_RUN=PASS`
- `SECOND_SHORT_PROVIDER_CALLS_ACTUAL=14`
- `SECOND_SHORT_MULTIMEDIA_AUTHORIZED=true`
- `SECOND_SHORT_IMAGE_CALLS=9`
- `SECOND_SHORT_KLING_CALLS=5`
- `SECOND_SHORT_TTS_CALLS=0`
- `SECOND_SHORT_TOTAL_COST_USD=2.030350`
- `SECOND_SHORT_IMAGE_COMPLETE_COUNT=9`
- `SECOND_SHORT_VIDEO_COMPLETE_COUNT=5`
- `SECOND_SHORT_VIDEO_USABLE_COUNT=3`
- `SECOND_SHORT_TTS_COMPLETE_COUNT=0`
- `SECOND_SHORT_ASSEMBLY_GATE=BLOCKED_3_OF_9`
- `SECOND_SHORT_MASTER_STATUS=NOT_CREATED`
- `FIRST_PENDING_ACTION=EXPLICIT_BUDGET_CEILING_EXTENSION_FOR_REPAIR_PACKAGE`
- `NEXT_ACTION=EXPLICIT_BUDGET_CEILING_EXTENSION_FOR_REPAIR_PACKAGE`
- `SECOND_SHORT_REPAIR_IMAGE_CALLS=0`
- `SECOND_SHORT_REPAIR_VIDEO_CALLS=0`
- `SECOND_SHORT_REPAIR_INCREMENTAL_COST_USD=0.000000`
- `SECOND_SHORT_REPAIR_MAX_PLANNED_INCREMENT_USD=1.780398`
- `SECOND_SHORT_REPAIR_MAX_PLANNED_TOTAL_PRE_TTS_USD=3.810748`

## Approved pilot authority

- Canonical approved pilot: `LUMI_PILOT_CINCO_HUEVOS_V1_1.mp4`
- SHA-256: `51d354c230972478ef784fc29ecfe0ad32d5f441ed2bfff0c00b33bb60eaf18c`
- Duration: `49.166667 s` (`49.17 s` display value)
- Resolution: `1080x1920`
- Aspect ratio: `9:16`
- Video: `H.264 High`, 30 fps, yuv420p
- Audio: `AAC LC`, 48 kHz, stereo
- Scenes: `9/9`
- Human review: `APPROVED`
- Publication: `NOT_AUTHORIZED`

The V1.1 master is the canonical accepted first pilot. Human approval does not rewrite or erase any earlier automated finding, warning, blocker, or scene-level override.

## Preserved immutable lineage

### Masters and manifests

- `LUMI_PILOT_CINCO_HUEVOS_V1.mp4`
  - SHA-256: `4374bb617713f9ba264fe473409df5e0b73dc382898c50bfd135ef6e6558a380`
  - State: preserved base master
- `LUMI_PILOT_CINCO_HUEVOS_V1_1.mp4`
  - SHA-256: `51d354c230972478ef784fc29ecfe0ad32d5f441ed2bfff0c00b33bb60eaf18c`
  - State: canonical human-approved pilot
- `SHORT_MASTER_MANIFEST_V1.json`
  - SHA-256: `d8aa8fb83a94687e80d9e8e15ab0c36e1b3c5f8d95f38c2a22ebb91e75be9d58`
  - State: preserved
- `SHORT_MASTER_MANIFEST_V1_1.json`
  - State: preserved; V1.1 forensic polish and QA record

### Source and production artifacts

Preserve without regeneration, replacement, cleanup, or provenance loss:

- all source images;
- all approved Kling clips;
- all rejected or terminal source/clip records required for audit;
- all Visual QA and Temporal QA records;
- all automated warnings and blockers;
- all human overrides, including S19-R2 `APPROVED_WITH_WARNING`;
- all nine TTS stems;
- original music;
- all selective SFX;
- deterministic captions;
- request IDs, hashes, cost accounting, claim rows, repair rows, and provider provenance.

No provider request was made by the approval/preset-freeze step.

## Production preset

- Specification: `LUMI_SHORT_PRODUCTION_PRESET_V1.json`
- Version: `1.0.0`
- State: `READY_NOT_ACTIVE`
- Basis: exclusively the accepted pilot, its manifests, and the explicit human approval.
- Global activation: not authorized.
- Production deployment: none.
- Second episode: planning and zero-provider dry run complete; multimedia not started.

The preset freezes defaults for AV2 structure, scene timing, 9:16 delivery, 48–50 second duration, Character Lock, world continuity, prompt compilation, Visual QA V1.2, image-to-video motion, Temporal QA, voice/TTS, music, SFX, captions, overlays, pedagogical pauses, mastering, freeze prevention, human-QA traceability, and exactly-once provider safety.

## Permanent freeze-prevention rule

`ACCIDENTAL_FREEZE=0` is a required master gate.

Never extend a clip with a perceptible static last-frame hold. Resolve a visual gap in this order:

1. subtle retiming;
2. transition overlap;
3. editorial micro-motion;
4. timing redistribution.

A pedagogical pause must retain the intended response time while maintaining minimum visible motion. Freeze QA is mandatory before Human Review.

## Generative-video stability rule

For educational counting scenes, `stability > motion complexity`.

Temporal locks are mandatory for:

- exact object count;
- no duplication;
- no disappearance;
- stable Lumi anatomy;
- no extra appendages;
- no morphing;
- stable prop identity.

Default motion is conservative, simple, readable, and compatible with counting.

## QA governance

Automated QA and Human Creative Review remain separate records.

- An automated `WARNING` or `BLOCKER` is never deleted or rewritten by a human decision.
- A human override must retain the finding, decision, scope, reason, and traceability.
- A human override must never conceal a serious temporal defect.
- Master Freeze QA must pass before Human Review.

## Master defaults

- `1080x1920`
- `9:16`
- `H.264`
- `AAC`
- voice dominant;
- music ducked beneath narration;
- selective SFX;
- deterministic captions inside vertical safe area;
- deterministic educational overlays matching visible objects;
- required pedagogical response pause;
- required final freeze scan.

Approved reference mix: `-20.4 LUFS` integrated, `-3.9 dBFS` true peak, no clipping.

## Exactly-once and cost controls

Required for every future authorized generation:

- persistent claims;
- one-shot generation;
- no automatic retries;
- no variants without explicit authorization;
- immediate request-ID persistence;
- restart safety;
- ambiguous dispatch blocks automatic resubmission;
- provider-call and cost accounting.

## Runtime safety

- `RUNNER_STATE=OFF`
- `autorun=false`
- Production: `main@5fe5556` intact
- Production preset activation: OFF
- Telegram: unchanged
- Make: unchanged
- Queues: unchanged
- Publication: not started
- Second episode: repair package blocked by the approved budget ceiling; no repair provider calls emitted

## Second validation short

- Episode: `ep_lumi_formas_002` — “Lumi y el jardín de las formas”
- Educational objective: recognize circle, triangle and square.
- Duration: `49.0 s`
- Scene plan: `9/9` compilation-ready scenes.
- Real child-response pause: `2.5 s` in `s27`, with minimum visible micro-motion.
- Final scene: low-complexity portrait close; three locked lantern props remain static.
- Planned provider calls: images `9`, Kling `9`, TTS `9`.
- Automatic retries: `0`; automatic variants: `0`.
- Dry run: `PASS`; provider calls emitted: `0`.
- Status: `SECOND_SHORT_STATUS=READY_FOR_EXECUTION`.
- Multimedia execution: not authorized.

Artifacts:

- `episodes/ep_lumi_formas_002/EPISODE_PLAN_V2.json`
- `episodes/ep_lumi_formas_002/SCENE_PLAN_V2.json`
- `episodes/ep_lumi_formas_002/PRODUCTION_MANIFEST.json`
- `episodes/ep_lumi_formas_002/DRY_RUN_REPORT.json`

Production remains `main@5fe5556`, runners OFF, autorun false, global preset activation OFF.

## Second-short execution recovery — 2026-09-30

- Staging service: `content-factory-av2-staging`
- Staging status: `LIVE`
- Staging commit: `a896c0bf3da2448aa5876c9ac34f176ddc1d638a`
- Runner: `OFF`
- autorun: `false`
- Images: `9/9` generated, one call per scene, no retries, no variants.
- Visual QA PASS: `s21`, `s26`, `s27`, `s28`, `s29`.
- Visual QA BLOCKER: `s22`, `s23`, `s24`, `s25`.
- Kling: `5` calls only for Visual-QA-approved images.
- Temporal QA PASS/usable: `s21`, `s26`, `s28`.
- Temporal QA BLOCKER: `s27`, `s29`.
- TTS: `0`; not started because assembly gate failed.
- Assembly gate: `BLOCKED`, usable clips `3/9`.
- Master: not created; no false or partial master.
- Actual image cost: `USD 0.875350`.
- Accounted Kling cost: `USD 1.155000`.
- Total accounted cost: `USD 2.030350`.
- Automatic retries: `0`.
- Automatic variants: `0`.
- Resubmits: `0`.
- Final master freeze QA: not applicable; master does not exist.
- Generated clips freeze scan: no freeze or black-frame segments detected.
- Production remains `main@5fe5556`, unchanged and LIVE.

Visual blockers are immutable:

- `s22`: triangle and square remained present in the single-circle teaching scene.
- `s23`: circle and square remained present in the single-triangle teaching scene.
- `s24`: circle and triangle remained present in the single-square teaching scene.
- `s25`: required moon, pennant and square-window examples were missing; shape lanterns were substituted.

Temporal blockers are immutable:

- `s27`: triangle and square rotate edge-on, lose readable side counts and do not remain fixed answer options.
- `s29`: triangle and square rotate edge-on and the final prop group reconfigures despite the lock.

No blocked scene may be regenerated or resubmitted without a new explicit repair authorization.

## Second-short explicit repair review and cost gate — 2026-10-01

The user explicitly authorized one controlled repair revision for each of `s22`, `s23`, `s24`, `s25`, `s27`, and `s29`. The original artifacts, provider request IDs, hashes, QA records, and terminal classifications remain immutable.

Forensic classification from persisted QA records:

- `s22`: `SOURCE_IMAGE_REPAIR`; original image is terminal `BLOCKER` because triangle and square are present in a single-circle teaching scene. Minimal repair: retain Lumi and the twilight garden while showing only one unmistakable blue circle lantern; then generate one video revision.
- `s23`: `SOURCE_IMAGE_REPAIR`; original image is terminal `BLOCKER` because circle and square are present in a single-triangle teaching scene. Minimal repair: retain Lumi and the twilight garden while showing only one unmistakable yellow triangle with exactly three visible sides; then generate one video revision.
- `s24`: `SOURCE_IMAGE_REPAIR`; original image is terminal `BLOCKER` because circle and triangle are present in a single-square teaching scene. Minimal repair: retain Lumi and the twilight garden while showing only one unmistakable coral square with four equal readable sides; then generate one video revision.
- `s25`: `SOURCE_IMAGE_REPAIR`; original image is terminal `BLOCKER` because the required moon, triangular pennant, and square window are absent and shape lanterns were substituted. Minimal repair: use the three planned real-world examples in separate alcoves, without lantern substitution; then generate one video revision.
- `s27`: `VIDEO_REPAIR_ONLY`; the original source image remains Visual QA `PASS`. The original video is terminal `BLOCKER` because triangle and square rotate edge-on and the three answer options do not remain fixed. Minimal repair: reuse the approved source image and generate one conservative video revision with all three options frontal, fixed, separated, and readable.
- `s29`: `VIDEO_REPAIR_ONLY`; the original source image remains Visual QA `PASS`. The original video is terminal `BLOCKER` because triangle and square rotate edge-on and the final prop group reconfigures. Minimal repair: reuse the approved source image and generate one conservative video revision with all three final props frontal, fixed, separated, and unchanged.

Cost gate:

- Required image repairs: `4`.
- Required Kling repairs: `6`.
- Image repair maximum: `4 × USD 0.0985995 = USD 0.394398`.
- Kling repair maximum: `6 × USD 0.231000 = USD 1.386000`.
- Maximum repair increment: `USD 1.780398`.
- Current accounted cost: `USD 2.030350`.
- New expected total before TTS: `USD 3.810748`.
- Production Manifest total ceiling: `USD 2.978645`.
- Ceiling excess before TTS: `USD 0.832103`.
- Projected total including the still-unspent TTS allowance: `USD 3.822998`, exceeding the manifest by `USD 0.844353`.

Result: `COST_GATE=BLOCKED`. Per the Production Manifest ceiling rule, no repair claim was created, no provider request was emitted, no retry/variant/resubmit occurred, and no repair artifact exists. Assembly remains `3/9`; TTS remains `0/9`; master remains `NOT_CREATED`.

Repair status by scene:

- `s22=AWAITING_BUDGET_CEILING_EXTENSION_SOURCE_IMAGE_THEN_VIDEO`
- `s23=AWAITING_BUDGET_CEILING_EXTENSION_SOURCE_IMAGE_THEN_VIDEO`
- `s24=AWAITING_BUDGET_CEILING_EXTENSION_SOURCE_IMAGE_THEN_VIDEO`
- `s25=AWAITING_BUDGET_CEILING_EXTENSION_SOURCE_IMAGE_THEN_VIDEO`
- `s27=AWAITING_BUDGET_CEILING_EXTENSION_VIDEO_ONLY`
- `s29=AWAITING_BUDGET_CEILING_EXTENSION_VIDEO_ONLY`

## Backlog priority

- `BACKLOG_PRIORITY=LUMI_RECOVERY_INCIDENT_MANAGER_V1`
- Future purpose: safely detect provider balance/quota/auth/outage failures, Render/Supabase/storage failures, exhausted budgets, invalid artifacts, stuck processing, and external timeouts; persist an exact checkpoint; prevent duplicate provider calls; notify Telegram with episode, scene, stage, cause, and required action; expose `RESUME`, `/status`, `/resume`, and `/cancel` or equivalent callbacks; resume strictly from `FIRST_PENDING_ACTION` without restarting the episode.
- Implementation status: `BACKLOG_ONLY_NOT_IMPLEMENTED`.

## Do not touch without explicit authorization

Production, Telegram, Make, queues, publication, approval workflow, Draft→HD, runners, global preset activation, or any second episode generation.
