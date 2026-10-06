# Lumi Production Readiness V2 — blocked

The original Third Short is human approved. Its master SHA is
`b6f9fe837d000a924608ed4bda13034ff30560ac48b5a085f7cb0a90f35a2624`.
The persisted review keeps timestamp `2026-10-06T13:52:56.472Z`, review version 1,
callback query `8241490267754384475`, update `830558911`, Make execution
`84c55d84a12b4220a131266d5fbfa692`, and panel 138. No approval was impersonated.

## Exact Telegram constraint

On 2026-10-06, two real Bot API calls through the existing Telegram connection
11003632 attempted `editMessageText` on the video in message 138:

- text: Make execution `4ce172fbaba2442988be170e44ed324f`;
- rich_message HTML: execution `50f90a48f261451dba406be121e1ab3f`.

Both returned HTTP 400: `Bad Request: there is no text in the message to edit`.
Telegram documents editMessageText for text/rich/game messages and editMessageMedia
for replacing text with media; it does not provide the inverse video-to-text
operation in those methods. Official source: https://core.telegram.org/bots/api.
This is an observed constraint of this bot/API route, not a guessed message age
restriction. Neither probe succeeded, created a message, deleted a message, nor
uploaded the master. HOME was NOT restored, and cannot be marked PASS.

The canonical renderer distinguishes text and media, owns complete content,
keyboard, artifact binding and versioned review tokens, and preserves BACK
return representations. A known unsupported media-to-text transition fails before
recording a pending callback or dispatching an edit. It never silently renders the
master behind HOME and never silently replaces panel 138. A menu with an approved
static cover could remove the video using editMessageMedia while keeping 138;
that changes the requested text HOME representation and needs a user UX decision.

Text-capable scenarios are regression-tested with explicit capability fixtures;
those tests DO NOT assert Telegram supports media-to-text. Historical renderer V1
compatibility tests remain labeled separately. Make acknowledgements now include
text_sha for review deliveries only; legacy payloads and connections are retained.

## Frozen profile and activation

`qa/LUMI_PRODUCTION_PROFILE_V2.json` freezes the approved source SHA, Pro endpoint,
Director/topology/source gates, calibrated temporal QA, component file hashes,
Annie/ElevenLabs voice ID, editorial constraints, master settings and recovery
policy. Exact approved voice configuration is in `qa/LUMI_VOICE_PROFILE_V2.json`.

The prepared creation selector requires a readiness PASS and explicit authorization
bound to PROFILE_SHA. Its rollback selects legacy without data migration and
refuses rerouting existing episodes. Global defaults remain legacy. No adapter is
activated. Existing execution modules are episode-specific: a generic new-episode
V2 CREATE adapter is still needed before activation; the dry-run adapter is a
fixture and is not presented as a live production adapter.

## Readiness and dry run

The offline dry run uses the actual Director, source evidence gate, calibrated QA,
Recovery Manager, budget gate, journal and renderer with synthetic plan/media/
request fixtures. It exercises claim collision after restart, exactly-once
simulated transport, TTS request shape, editorial exclusion/pause, assembly/master
profile, master review and publication preview. All ten requested generic incident
classes are registered and exercised. The pre-existing five recovery simulations
are reused, including artifact decode and TTS storage gates.

No new live episode, media generation, real approval, master encode, publication,
or social account mutation occurs. Passing a synthetic dry run does not close the
live Telegram limitation or certify new generic paid-provider orchestration.
Readiness remains BLOCKED.

## Existing publication inventory

| Platform | Implementation | Connection | Missing authorization | Dry run |
|---|---|---|---|---|
| YouTube Shorts | Direct OAuth/upload code and existing approval gate; queue/menu available | No social_connections row; integrations=not_connected | OAuth application setup and user channel consent; OAuth not configured in inspected staging | Metadata and preview fixtures; no upload |
| Instagram Reels | Menu, channel_platforms and scheduling queue scaffolding; no publisher/Make executor found | No social_connections row; integrations=not_connected | Publisher integration first; account consent is not the only missing item | Queue/preview only |
| TikTok | Menu, channel_platforms and scheduling queue scaffolding; no publisher/Make executor found | No social_connections row; integrations=not_connected | Publisher integration first; account consent is not the only missing item | Queue/preview only |

Make team inventory has 14 Lumi scenarios plus the temporary API probe shell; no
social publication executor was found. The project's sole deployed Edge Function
is content-factory-bot and exposes menu/completion handling, not a publisher.
There are no existing publications for channel 1. No Facebook requirement is
invented. Existing YouTube upload validation binds legacy video revision approval;
the new SHA-bound review needs an explicit adapter before using that publisher.

Publication states are prepared as complete panels and require SHA-bound master
approval. Confirmation is closed and never calls a publisher or queue.

## Outstanding work

- User UX choice for HOME: allow a canonical static-cover HOME on the same panel,
  or another explicit representation compatible with Telegram. No new message is
  silently authorized.
- Engineering: wire generic V2 creation and a SHA/revision adapter to the existing
  publisher before re-running readiness and requesting controlled activation.
- External: configure YouTube OAuth and authorize the intended channel when ready.
  Instagram/TikTok are not labeled CONNECT-only requirements.
