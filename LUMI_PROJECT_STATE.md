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
- `LAST_COMPLETED_ACTION=FREEZE_PRODUCTION_PRESET_V1`
- `SECOND_SHORT_STATUS=READY_FOR_EXECUTION`
- `SECOND_SHORT_EPISODE_ID=ep_lumi_formas_002`
- `SECOND_SHORT_DURATION=49.0`
- `SECOND_SHORT_SCENES=9/9_PLANNED`
- `SECOND_SHORT_DRY_RUN=PASS`
- `SECOND_SHORT_PROVIDER_CALLS_ACTUAL=0`
- `SECOND_SHORT_MULTIMEDIA_AUTHORIZED=false`
- `FIRST_PENDING_ACTION=AUTHORIZE_SECOND_SHORT_EXECUTION`
- `NEXT_ACTION=AUTHORIZE_SECOND_SHORT_EXECUTION`

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
- Second episode: not started

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

## Do not touch without explicit authorization

Production, Telegram, Make, queues, publication, approval workflow, Draft→HD, runners, global preset activation, or any second episode generation.
