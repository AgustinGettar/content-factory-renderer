# Lumi 004 — Higgsfield USD preflight (offline patch)

Source snapshot: `4c3a3946ca6e0c40176604ddb5bb04ec78ddf710`.

## Included

- `lib/lumi-fourth-episode-usd-preflight.js`: strict quote-only engine for five 2K High images with the frozen `marketing-studio/image` model and five Kling 3.0 Pro videos (4+5+5+5+5 seconds, audio off).
- `test/lumi-fourth-episode-usd-preflight.test.js`: offline tests for model/quality/source binding, credits-only rejection, budget, authentication prerequisites, and no media generation.

## Verified locally

`node --test test/higgsfield-usd-budget-v1.test.js test/lumi-fourth-episode-usd-preflight.test.js`

The helper is NOT registered as an HTTP endpoint. It has not been deployed or tested against a real Higgsfield API key. It cannot create an episode or enable Telegram V2. Full repository tests require dependencies that are unavailable in the current offline environment.

## Integration steps requiring review and separate authorization

1. Recover an exact source tree in a CI-capable checkout; apply the patch to the isolated `lumi-telegram-review-v1` branch only.
2. Wire a staging-only, HMAC-authenticated, isolated diagnostic phase to call `quoteFourthEpisodeUsd`. Reuse the existing diagnostic CAS row and HTTP observability. Do not use the Telegram 138 session.
3. Assemble ten **actual provider request envelopes** from the approved fourth-episode planner. The future VIDEO source images do not yet exist; do not substitute fabricated URLs or call these estimates final/binding. For planning-only quotes, explicitly label them provisional and keep the Budget Gate closed.
4. Read `HF_API_KEY` presence without returning the value, length, prefix, suffix, or hash. Use only `https://api.higgsfield.ai/estimate/{model}`; never send a generation POST.
5. Verify that `quality=high` is actually supported/honored by the selected image endpoint; a payload containing that field is insufficient.
6. If Higgsfield only returns credits, keep the USD gate blocked. Do not convert ChatGPT connector credits to prepaid USD.
7. Verify billing account and API USD balance from the **same API identity**, and verify TTS contractual upper bound separately. Do not mark budget PASS without these gates.
8. Requote before each eventual emission, enforce the hard USD 5 ceiling with a per-action budget reservation and fail closed on ambiguity.
9. Separately connect a server-issued, episode-scoped V2 authorization to the existing Telegram `Crear video` flow. Do not enable V2 globally or alter the historical master/panel.

## Budget warning

At previously reported **non-binding** standard video estimates, five clips plus images and TTS can exceed USD 5. The approved five-shot plan may need a lower-cost shot count or a separately authorized higher ceiling; do not downgrade Kling Pro or the frozen quality profile automatically.

No push, deploy, provider requests, Telegram changes, or production writes were performed by this patch.

## Corrected model binding

The approved `qa/LUMI_IMAGE_QUALITY_PROFILE_V2.json` specifies `marketing-studio/image` and explicitly supersedes `marketing-studio/image/flare`. The quote helper binds to the frozen `LUMI_PRODUCTION_PROFILE_V2.image.model` and rejects the superseded Flare endpoint.
