# Lumi reusable asset library V2

Extends V1 inside the existing Studio, AV2 runtime, checkpoint CAS, review flow and private bucket. No new persistence layer, orchestrator, provider integration or migration. Historical draft selections remain immutable and unapplied until an explicit authenticated confirmation.

## Private preview

The observed V1 symptom was an empty Gallina preview on iPhone. The verified code defect was an unobserved native-media load: no load/error states, no retry, and no fresh access request after a failed load. Available request logs did not establish the initiating HTTP failure; CORS or URL expiry is not asserted as its cause. Gallina points to the unchanged complete q41 image, not a crop.

V2 requests a fresh, session-bound five-minute access ticket, fetches through the authenticated same-origin route, verifies MIME/length and browser SHA-256 where available, then displays an ephemeral Blob URL. Server-side private-bucket and SHA verification remain mandatory. CSP permits same-origin Blob images/video. READY requires an image load or video metadata event; FAILED and EXPIRED_ACCESS expose a read-only visual retry. No signed URL is stored persistently. Whole-image references are identified explicitly. The existing five-section design is preserved.

Actual authenticated Telegram/iPhone visual acceptance remains NOT_TESTED_REAL. Offline browser-behavior tests cannot establish device playback acceptance.

## Planner and controlled application

The existing library exposes owned target episodes/shots and read-only compatible suggestions. Compatibility checks include durable approval/hash/version, owner, canonical profile, permitted reuse, dimensions/aspect ratio, authored scene semantics, duration and educational pause. Missing or mismatched evidence fails closed. The quote path consults recommendations without applying a selection.

An explicit narrative/continuity/rights confirmation and expected checkpoint revision are required. The existing manager claims the application by CAS in checkpoint metadata; conflicting dispatch, reservations, journals, authorizations, incidents and completed actions reject a new claim. Replay verifies the original application fingerprint. No q41/q42-specific reuse exception exists.

REFERENCE_REUSE adds the approved private image to the existing image materializer/compiler alongside the unchanged canonical reference. New generation remains paid and separately authorized.

DIRECT_MEDIA_REUSE gives the exact original private bytes a destination artifact identity and submits evidence to the existing stage-result/review mechanism. It creates no provider request or synthetic provider ACK. The target must pass its own human review before downstream Source QA, temporal QA or assembly can consume the artifact.

DERIVED_ASSET accepts explicit local crop/trim recipes. Existing storage and FFmpeg inspection are reused, outputs have immutable content-addressed paths in the same bucket, and original approval is never inherited. Storage outages are not treated as missing objects. Derivation cannot bypass destination review or ambiguity guards. No real resource was derived during rollout.

Potential savings use an existing same-action estimate or quote; absent price evidence remains unknown. Verified savings require direct reuse, completed destination review and an existing current same-checkpoint USD quote. This is an avoided-generation estimate supported by execution evidence, not a cash refund or provider billing credit. Reference reuse reports no avoided generation cost. The library never releases reservations or changes budget limits.

## Approval capture and recovery

The existing production review controller captures approved media only after durable reconciliation. Generic approval capture compares the existing review-session and checkpoint decisions; a split/incomplete decision cannot register an approved resource. Legacy review capture uses its existing durable approval. Immutable catalog IDs and version allocation deduplicate repeated events; exact original bytes are checked before a new registration. Startup or explicit catalog reconciliation repairs a missed capture without approving or generating again.

## Validation and preserved state

Tests use synthetic EP005/EP006 and a protected paused fixture. Coverage includes authenticated private access for all five media types, expiry/reopen, reference payload wiring, image/clip direct application, local-derivation boundaries, provenance/hash/owner/version/scene checks, CAS conflict, duplicate clicks, lost acknowledgement, destination review/materialization, approval capture, quote-backed savings, budget isolation and provider ambiguity. No fixtures are inserted in staging.

Staging pre-deploy evidence (2026-10-18):

- Branch/base: `lumi-telegram-review-v1`, `af5f43b78c1dd76a4854c0832f468e8b28fe57d1`.
- Supabase: `mofjhwathxzfnjapvvst`; Render: `content-factory-av2-staging`, auto-deploy OFF.
- EP004: revision 23, PAUSED_INCIDENT, `shot_review:q41` completed, `image:q42` pending, 8/50. Whole checkpoint MD5: `fcdf4f7a9760788f5000e22431a0688f`.
- Pilot checkpoint MD5: `9db50472ae7d3d318078c7e3c517d422`; approved episode projection MD5: `44be1b70ae960f034572a27ef73694f3`.
- q42 journal MD5: `dc1d45cf5632aa1b4d7dcf2571b351fd`, EMISSION_UNKNOWN; original reservation USD 0.3275.
- q41 image/video journal MD5: `3181a967eb3d7c51a2750097831bc7a7` / `83696ca27cc4f50df889beadca972c9a`.
- Cap USD 8; reserved exposure USD 1.22625; internal remaining USD 6.77375. Actual provider charges unverified.
- Catalog: 8 entries / 4 original objects; 4 character, 1 scene, 1 image, 1 clip, 1 master. Catalog MD5: `7f8e83ae337a17591532a09da4721c5b`; selections: 0.
- Runners OFF, autorun false, publication disabled. Real provider generation calls during this intervention: 0.

## Resume checkpoint

LAST_COMPLETED_TASK: V2 implementation and focused library/auth acceptance; 11 new V2 tests pass, prior V1/auth tests pass. Executor/materialization boundaries: 21/21 pass. Relevant runtime/stage/review regression: 198/198 pass, including both synthetic seven-shot episodes (50 actions each), both Full HD master/download hashes and review acknowledgement-loss recovery.

FIRST_PENDING_TASK: publish only the target branch without force push, require the existing CI gate to pass, then deploy only the verified staging service and compare protected-state fingerprints. The existing broader CI gate is preserved because shared runtime/review files changed; no local historical full suite is requested.

Existing earlier budget work in the original worktree is preserved. This intervention uses an isolated worktree at the verified remote V1 commit. No real EP004 checkpoint, review, journal, reservation or library selection was written.
