# Lumi Telegram review V1

Status: STAGING_IMPLEMENTED_OFF; LIVE_INTEGRATION_BLOCKED; NOT READY FOR HUMAN VALIDATION.
Feature flag defaults OFF and is additionally restricted to LUMI_RUNTIME_ENV=staging.

Existing master verified on 2026-10-06: 30,709,796 bytes; SHA-256
b6f9fe837d000a924608ed4bda13034ff30560ac48b5a085f7cb0a90f35a2624;
41.125 seconds; H.264 High, AAC, 1080×1920. Full FFmpeg decode passes.
Do not generate images, video or speech or rebuild this file.

## Delivered code

- Media-only single-message shell with mandatory existing message ID; original
  multipart upload, persistent SHA/file_id mapping, and same-ID assertion.
- Generic progress, shot, final review, reasons, paginated videos, original-video
  download guidance and legacy menu pagination.
- Owner/chat/message validation, random persisted callback tokens bound to the
  artifact SHA, atomic optimistic concurrency and idempotent decisions.
- Separate automated QA and human disposition. Approvals never transfer to new SHA.
- SUPERVISED and AUTO_WITH_EXCEPTIONS gates; final human review always required.
- Recovery Manager can read review state and refuses continuation while paused.
- V2 execution entrypoint consults review gate only with the staging flag ON.
- Delivery failures preserve production artifacts. Unknown upload outcome blocks
  resubmission until reconciled from an authentic callback. No Telegram send or
  delete API is exposed by the transport.
- Additive service-role-only storage migration; no legacy RLS or schema changes.
- Authenticated staging registration/show/readiness routes and callback endpoint.
- Make bridge candidate preserving original legacy menu options and business
  logic; not connected to the active Make scenario.

## Confirmed integration blockers

The authoritative cf_bot_sessions row is phase=closed with data={}. The latest
persisted menu acknowledgement is message 133 (2026-09-29), and message 134 is
only a historical recovery note. Neither is an authorized current message ID.
No message was created or deleted by this implementation.

The active Make scenario 6224860 calls content-factory-bot, and its existing
Telegram connection is healthy. The old menu deletes/recreates messages on
/menu and close. A staging candidate must handle those paths before its media
shell can be activated. The Make bridge covers synchronous menus and authenticated asynchronous
AI/render completion forwarding; connecting these routes still needs end-to-end tests.
It must not be enabled until those asynchronous writers also preserve the shell.

The direct multipart runtime needs LUMI_TELEGRAM_BOT_TOKEN configured securely in
staging (never in chat, code, reports or URLs shown to users). The current Make
connection does not expose that credential to the renderer. Do not replace the
existing Telegram webhook: use authenticated forwarding from Make.

The canonical master currently resolves to its durable Library artifact, not a
registered renderer Storage object. Register only after copying exact verified
bytes to approved private storage, then repeat hash/probe/decode in staging.
Reuse an existing approved canonical image as LUMI_MENU_COVER; do not call imagegen.
No media or episode session has been registered in live review storage.

Production continuation is capability-driven through ProductionReviewController.
It supports idempotent canonical resume/cancel adapters, authorization and budget
checks, supervised pause, automatic continuation only on PASS, and generic
shot/master completion events. No adapter is enabled for the completed Third
Short, whose only next action is final human review. It therefore never displays
a misleading Continue button for this existing master. Any future episode must
register its canonical pipeline adapter before presenting Continue/Resume.
The ordinary and directed V2 shot paths consult the opt-in review gate; generic
completion events additionally accept artifact-verified shot/master registrations.

The current 30.7 MB original needs no proxy. Oversize masters fail closed until a
separate verified proxy and authenticated download route are supplied; automatic
recompression is intentionally unavailable.

## Required activation sequence

1. Recover an active panel and authoritative message ID, without guessing an ID.
2. Configure secure Telegram transport and authenticated Make forwarding.
3. Connect all synchronous and asynchronous Make writers to the staging shell.
4. Register original artifacts/cover and bind the existing private session.
5. Pass CI plus existing-artifact dry run in staging.
6. Enable only controlled staging review, edit original master into same message,
   persist returned file IDs, and test actual navigation/download and callbacks.

No production deployment, main change, publication, paid provider call or new
multimedia cost is authorized by enabling this review module.
