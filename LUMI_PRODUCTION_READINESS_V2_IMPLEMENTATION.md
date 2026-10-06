# Lumi media-first panel and generic V2 adapter

HOME is now a photo-backed representation. The live panel stayed at message 138
through VIDEO → PHOTO HOME → VIDEO MASTER → PHOTO HOME. The existing, owned
`assets/lumi-canonical-wand.png` is reused as LUMI_TELEGRAM_HOME_V1; exact SHA
`77d1b42c07a3de6a3845ae7674bc3637b79d9d1c373959c736ed984656646b17`.
Initial photo registration was Make execution `84bd3df93a3a41c4bc64b0027e42198a`.
Master reopening was `520cbe251e964f1e9b8ef3fc501cc209`, final HOME restoration
`c6f3c39bddf441e1b939609cba70c660`. Both media edits reuse cached file_id.
No send/delete method is used; no master upload, regeneration, approval or publication.

The existing authentic approval remains bound to
`LUMI_SHORT_TRES_FLORES_COLORES_V1.mp4`, SHA
`b6f9fe837d000a924608ed4bda13034ff30560ac48b5a085f7cb0a90f35a2624`,
episode ep_lumi_flores_003, review version 1,
2026-10-06T13:52:56.472Z, callback 8241490267754384475,
update 830558911, execution 84c55d84a12b4220a131266d5fbfa692.
Navigation does not create another approval.

## Renderer and transport

The canonical renderer owns media type/file_id, full caption, keyboard, state ID,
review version and artifact binding. All operational states use editMessageMedia.
HOME, progress, details, incident, approval success and publication previews reuse
one static photo; shot/master/download use their exact video binding. Approval
success offers VER VIDEO explicitly and otherwise removes the active player.
Server-side logical history is bounded to 32 states; BACK re-renders the complete
prior representation, while HOME clears history. Legacy menu actions are retained.

Make acknowledgement modules 21/22 now carry both photo and video identities and
hash the exact same serialized body that is sent. This also fixes the earlier
text_sha body/signature drift. HMAC, expiry, replay, ownership, stale SHA/version
checks and approval idempotence remain intact. Secrets are not stored in this repo.

## Generic adapter scope

`lib/lumi-generic-v2-adapter.js` reuses the actual AV2 plan validator/canonicalizer,
frozen profiles, Director compiler, source gate, Recovery Manager and emission
journal. Episode/scene/shot identities, durations, sources, plans and action keys
come from inputs. There are no q31–q36 branches or third-short IDs in this adapter.
Director policy scopes are derived per episode. The frozen shot contract admits
3–5 seconds; larger scene timings remain assembly concerns, not a silent expansion
of Director capability. Source QA and a Director packet are required before video.
Serial durable claims precede workers, and a claimed stage cannot be redispatched
on restart. Provider actions require quote/budget, exactly one journaled transport,
and explicit action-bound authorization. No automatic paid retry exists.

The adapter is registered only in staging, with activation closed and concrete
workers unbound. Signed CREATE V2 routing is prepared; legacy remains the default,
and existing episodes cannot be rerouted. Missing workers fail before episode
creation or dispatch. No real future episode is created during this work.

## Remaining production blocker

The contract adapter and two full fictitious episode simulations PASS. A real
paid-production adapter is not yet ready: concrete generic workers must be bound.
The historical image/video execution (`lumi-series-v2-execution.js`,
`cinematic-director-v1/episode-step.js`) assumes the Third Short, fixed ledger IDs,
source paths, shot aliases and authorization records. Audio/assembly helpers
(`episode-completion-audio.js`, `lumi-third-short-master-v1.js`) similarly require
that episode's six-shot proof and storage layout. Attaching those executors as
"generic" would bypass their identity and evidence gates.

Minimum remaining work is to extract parameterized worker bindings for the
existing provider/storage/QA/audio/assembly operations; retain exact quotes,
source/character checks, durable journal claims, calibrated QA, TTS storage proof,
master profile and Human Review waits. Then run this adapter through the signed
Telegram CREATE path with those bindings in dry-run mode. This turn does not
activate paid execution or claim fixtures certify those live workers.

Validation: 338 offline regression tests PASS, including nine explicit photo/video
transitions, file_id reuse, logical BACK, approval idempotence, callback auth and
four generic-adapter tests. `scripts/lumi-production-readiness-v2.mjs` exercises
real Director compilation with new fictional IDs, 19 simulated emissions per
future episode, zero real provider/publication calls and immediate legacy routing.
Readiness therefore remains BLOCKED by GENERIC_V2_WORKER_BINDINGS_REQUIRED.

## Repository, staging and publication scope

The tree of local e1b30ee was uploaded exactly to lumi-telegram-review-v1. GitHub's
connected commit API assigned remote ff4e79c; tree
2259c9f426c8cfccc4dca84f1de94d1ff06d01d6 is identical, diff empty.
Initial CI 37510326661 is GREEN. Main remains
5fe5556395829e78817771f96d33cce3f692965d. Staging source branch alone was changed
from lumi-app-recovery-manager-v1 to lumi-telegram-review-v1; AutoDeploy remains OFF.
Final feature commit/deploy are recorded in the delivery report.

Publication architecture is untouched. YouTube upload/OAuth code exists; OAuth
setup/channel consent and SHA-bound review adaptation remain pending. Instagram
and TikTok still have menu/queue scaffolding and need publisher implementation.
No social connection, publication, main change, production deployment, global
activation or public.characters RLS change is made.
