# TTS and stage continuation — implementation checkpoint

Status: BLOCKED FOR PRODUCTION ACCEPTANCE. No activation or provider emission is authorized by this change.

## Follow-up: shared materialization and audio transport

The shared materializer now consumes accepted result identities for image, video,
audio and local master stages, using the existing CAS receipts and storage client.
Original bytes are written immutably before their digest/QA checkpoint; recovery
reuses that object after crashes. Image pixels and audio/video are decoded with
ffmpeg. Native video dimensions are retained. URLs are transport-only.
`LumiV2ExecutionOrchestrator.recoverResult` requires the exact accepted job receipt,
then routes through the real wrapper and existing StageResult/Recovery Manager.
IMAGE/VIDEO recovery reuses the existing authenticated provider GET client.
The TTS lifecycle delegates audio materialization to this same path.

Telegram supports AUDIO_REVIEW, SHA/version-bound decisions, audio file_id caching,
and HOME restoration. The existing Make action path can use a short-lived storage
URL after verifying canonical bytes, then persist the returned audio file_id. It
does not create a new navigation message or require a parallel Make scenario.

The executor has a strict non-generative cost pathway through the same configured
Higgsfield CLI as submission. Credit estimates require a credit budget; USD is
never inferred. Canonical signed diagnostics can request `verify_tts_preflight`.
The 100-credit diagnostic ceiling is fictitious test data, not production authority.
An absent client/session/quote fails closed. No authentication is copied into Git.

Evidence limits: historical original media exercises local decode/materialization
and continuation. The existing full 14-stage dry fixture still contains explicit
synthetic planning/source/Temporal QA metadata; it is not a real production E2E
acceptance. Live routing remains unregistered until authenticated transport and
the complete generic runtime handoff are verified. No test grants Human Approval.
Audio UI transport contracts passing locally do not certify actual Telegram delivery.
CI now installs ffmpeg, required by the real media tests.

## Recovered authority

`qa/LUMI_VOICE_PROFILE_V2.json` matches the approved voice identity in Library
`libfile_74e0c0eb477081919ab482e1b08c26ba`: Higgsfield, text2speech_v2,
elevenlabs, Annie, preset `f2801b0f-e345-598e-86f5-8364d886d96b`.
The benchmark SHA is `0f5b78a23260a770337af12072eecca9c1721c3a3ef6cdcdb984511044c47bbb`;
the recorded user approval selected sample A. Native output was MP3 mono, 44100 Hz;
speed was the engine default. No format, sample-rate or speed parameters are invented.

The historical successful request and response are recorded in
`libfile_46a03943deb48191b6b7ae526fd0fbde` version 6. They use connector
`prompt`, `variant`, `voice_id`, `voice_type`, `count:1`, and `results[].id`.
Their price unit is Higgsfield credits and USD cost is null. This differs from
the server's public-API `providerJson` / `pollRequest` and USD estimator contracts.
The model name is not evidence of a public API endpoint. No provider was queried
to resolve this distinction during this work.

## Existing components reused

- Persisted voice resolution: `lumi-production-profile-v2.js` / `qa/LUMI_VOICE_PROFILE_V2.json`.
- Atomic claims and durable lifecycle records: existing review session CAS via `ReviewStageReceiptStore`.
- Technical decode/hash and pre-emission storage gate: `lumi-recovery-incident-manager-v1.js`.
- Budget arithmetic: `higgsfield-usd-budget-v1.js`; credits are never converted into USD.
- Checkpoints/incidents: existing `LumiRecoveryIncidentManager`.
- Review ownership, canonical message identity, rendering and callbacks: existing Telegram Review V1.
- No additional database, table, queue, background runner or autonomous pipeline was introduced.

## Implemented

`executeLumiTtsStage` takes generic episode/narration/text/profile/storage/budget input.
It persists request and text hashes, profile fingerprint, attempt identity, quote,
storage gate and lifecycle state before submission. CAS claims prevent competing
submissions. Known job IDs resume the same job. An ambiguous transport cannot
automatically resubmit. A transport can supply explicit definitive no-job rejection
evidence; a generic CLI error is deliberately not sufficient evidence.

Artifact persistence uses immutable SHA paths, readback and independent decode.
The artifact includes provider/profile/job identity, cost provenance, format,
sample rate, channels, duration and QA. Actual cost stays null when unavailable.
Technical QA measures decoded PCM energy and clipping (warning above 0.1% of
samples at absolute amplitude >= 0.999). Silence is allowed only for the deterministic
zero-provider storage probe. Spanish pronunciation is not automatically certified.
The frozen voice does not prompt new voice selection; warnings pause for review.

The official CLI wrapper uses argument arrays and explicit model/voice fields;
it has no login, fallback or retry. Reference:
https://github.com/higgsfield-ai/cli/blob/main/MODELS.md (text2speech_v2), and
https://github.com/higgsfield-ai/cli/blob/main/README.md (generate create/get).
CLI protocol envelope tests use explicit synthetic fixtures. They do not prove an
authenticated deployed client or a historical server-side TTS executor exists.

The existing orchestrator now delegates live normalized receipts to
`handleStageResult`. The shared path verifies canonical artifact bytes, persists
result/artifact/QA metadata, records incidents, applies warning policy and lets
Recovery Manager calculate FIRST_PENDING_ACTION. Paid dispatch is not implied.
All eight requested terminal/pause outcomes plus IN_PROGRESS are represented.
Generic review requests are rendered in the same canonical photo panel; decisions
bind artifact SHA, artifact ID, stage and version before persistence. Approval
reconciles the Recovery Manager checkpoint. Rejection requires a repair plan.
Audio playback/delivery from these generic requests is not yet connected.

## Remaining acceptance blockers — do not report READY

1. The server does not have a verified authenticated deployable transport for the
   successful connector TTS contract. The official CLI wrapper is code, not a
   configured, authenticated runtime. No credential was copied from ChatGPT into Render.
2. There is no bound authoritative USD quote for that TTS transport. Historical
   credits and the public API prepaid USD balance are different accounting surfaces.
3. Generic image/video same-job artifact recovery and the concrete live materializer
   are still unbound. Local normalized result continuation is implemented, but a
   component test does not establish the full live 14-stage handoff.
4. Generic review requests currently render metadata/actions on the canonical
   photo panel; an audio review needs a verified playable/downloadable artifact path.

Consequently the live adapter remains unregistered. Readiness stays BLOCKED with
13/14 deployable component bindings, while 14/14 wrapper dry boundaries exist.
No global default, approved historical artifact, Telegram delivery binding,
production deployment or main branch is modified by this implementation.

## Validation scope

The CI regression adds durable TTS and generic continuation tests to the existing
offline suite. Synthetic provider responses are explicitly labeled test evidence.
Real local ffmpeg probe/decode exercises run with outbound network blocked.
The offline guard preserves promisified execFile stdout/stderr while retaining
the original allowlist of local ffmpeg/ffprobe commands.
Dry crash matrix: 14 stages x 4 boundaries; zero provider calls.
No paid generation, publication, new real episode or live Human Approval is created.
