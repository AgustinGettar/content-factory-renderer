# Lumi Telegram Mini App V1

## EP004 q41 one-tap consent (2026-10-15)

The primary q41 card now offers **Generar primera animación**. Its authenticated,
CSRF-protected POST alone activates one immutable HMAC-sealed consent operation.
Opening, refreshing or polling the app does not activate this consent or submit
a request. The fixed server policy pins the actual approved source SHA, director
receipt SHA, EP004/video:q41, Kling Pro, 4 seconds, audio off, one generation,
USD 0.56 maximum reservation and USD 5 episode ceiling. These are internal
limits, NOT evidence of a provider-enforced maximum charge.

The existing versioned quote adapter renews only completed, expired quotes.
Unknown estimates are never repeated. Up to three safe quote versions can be
considered within the same operation; price changes within the fixed reservation
ceiling require no additional confirmation. The exact quote ID, USD, timestamps,
payload SHA and operation ID are persisted before the existing authorization
and execution adapters run. The existing Budget Gate and CAS reservation remain
authoritative. The consent and exact quote binding are rechecked both before
reservation and at the provider transport boundary. No new ledger or journal.

Expiry before a dispatch claim renews safely under the original consent. Once
dispatch/reservation has begun, any expiry or uncertain outcome fails closed:
there is no rollback/retry that could double spend. This exceptional interruption
requires reconciliation, not a new automatic submission. A duplicate click,
new session or HTTP timeout cannot create a second one-tap operation, even after
a block. A higher limit or retry would require a separately authorized change.

After an accepted job the operation polls only the original request through
`recoverQuotedStage`, with a CAS recovery lease and private artifact verification.
The timer is scoped to that single consent/job, not a global runner. Reopening
may resume GET-only recovery from the acknowledged journal, including an ACK
saved before a lost UI receipt. Unstarted/interrupted submissions are NOT
automatically restarted by reads. The final clip is offered for human review;
no subsequent image, video, TTS or local production stage is started.

The previous separate quote/authorize/generate APIs remain for other supervised
stages and backward compatibility. They are no longer q41's primary UI path.
Focused `ONETAP` tests use synthetic quotes/jobs and an explicitly synthetic local
video. No real provider generation is part of tests or deployment acceptance.

Served by the existing staging Render service at `/lumi/studio`. No new hosting,
schema, queue, episode, provider account or generation on startup.

## Deployment boundary

The mount requires `LUMI_RUNTIME_ENV=staging`, the exact isolated Supabase URL
`https://mofjhwathxzfnjapvvst.supabase.co` and, when Render supplies it, service ID
`srv-dapgakqd0e5s73fottig`. `LUMI_MINI_APP_ENABLED=false` disables the mount.
Existing server-only provider and database credentials are reused. Main and
the production service are not deployment targets.

When a bot token is available, staging startup reads the existing private-chat administrator and
uses `getChatMenuButton` / `setChatMenuButton` to prepare “Abrir Lumi Studio”.
The menu is verified by readback. This changes no messages, panel IDs, histories,
webhooks or Make scenarios. BotFather is not required for this per-chat menu;
a Main Mini App profile button would be a separate optional configuration.

In this deployment the bot token remains in the existing Make connection
11003632. The already-existing API shell 6532649 calls `getMe`,
`setChatMenuButton` and `getChatMenuButton`; scenario 6224860 is unchanged.
The verified public bot ID is 8843261381 (@AppMultimedia_VideosBot).
Set staging `LUMI_TELEGRAM_BOT_ID` to this ID. After the menu readback, record
`LUMI_MINI_APP_MENU_VERIFIED_AT` as its ISO timestamp (an operational observation,
not an authentication grant). No credential is copied from Make.

## Authentication and authorization

`POST /lumi/studio/api/auth` accepts only Telegram `initData`. The backend checks
the official HMAC when a bot token exists, or Telegram's official third-party
Ed25519 signature using the server-configured bot ID and Telegram's pinned
production public key. Neither the public key nor the bot ID comes from the
browser. Ed25519 replay identity uses the signed canonical data, never the
unsigned `hash` parameter. Both methods check unique field names, a five-minute age limit, future-date skew,
numeric Telegram user identity, private-chat context and `cf_bot_admins` ownership.
Signed initData is exchanged once using the existing CAS session store. Browser
provided user IDs and `initDataUnsafe` are never authorization inputs.

Session cookies are opaque, Secure, HttpOnly, SameSite=None and Partitioned for
Telegram Web iframe compatibility. Server storage contains only session hashes.
They expire after 30 minutes; owner revocation is checked on every API request.
POST requests require the exact staging Origin, JSON and a session-bound CSRF
token. Content Security Policy restricts scripts to this app and Telegram's SDK.
Session and media MACs use domain-separated keys derived from the existing
server-only callback secret when the bot token is absent. Missing authentication
configuration fails closed; readiness reports configuration, not real acceptance.
No CORS authorization, bearer credentials, provider payloads or storage paths are
exposed to the frontend. Session expiry requires reopening from the bot.

## Production authority

Mini App operations are persisted in `state.mini_app.operations` in the existing
review session with CAS. This is an interface receipt, not another execution
engine. The HTTP action returns 202 before provider work. An in-process task
invokes the existing production adapter. No global runner or autorun is enabled.

The adapter shares `prepareEp004VideoQuote`, `authorizeEp004VideoQuote`,
`executeQuotedStage`, `recoverQuotedStage`, local continuation, Recovery Manager,
budget exposure, stage receipts and Provider Emission Journal with the existing
backend. A verified Mini App capability replaces only the Telegram callback
transport condition. Legacy callback callers retain their existing conditions.

The frontend never supplies a model, prompt, amount, source URL, episode choice,
authorization grant or provider payload. It echoes the current quote identity
and explicitly confirms a decision. Separate actions are required for economic
authorization and actual generation. Approval itself neither reserves money nor
submits a provider request. The existing engine reserves immediately before
dispatch and rechecks payload, quote expiry, budget and emission identity.

Duplicate interface submissions resolve to one operation. After reopening,
status reads durable results. A lost interface receipt is reconciled from the
canonical quote, economic decision or dispatch receipt. A queued operation may
be resumed explicitly. An interrupted quote re-enters only the same immutable
lineage; an ambiguous estimate is never re-emitted. Started generation is never
replayed by interface recovery. An existing accepted provider job is recovered
through the existing GET-only provider recovery path. Uncertain outcomes remain
blocked for reconciliation.

## Media and review

Media IDs are server-derived from registered episode artifacts. Access requires
a valid owner session and a five-minute session-bound signed app URL. The server
downloads and verifies the original SHA/size before serving it; private bucket
names and signed storage URLs are not returned. Byte ranges support playback and
an authenticated attachment response supports master download. The bounded
64 MB cache contains only verified original bytes, never public derivatives.

Human review uses `persistStageDecision` and `reconcileStageReview`. The stored
Mini App operation proves the exact request, artifact SHA, version and decision.
Existing approvals are immutable. Video approval requires full-playback and
source-comparison confirmations. No review implicitly authorizes a paid action.

## Validation and acceptance

Targeted offline tests cover authentication, replay, expiry, CSRF, owner
revocation, isolation, checkpoint projection, versioned quotes, budget limits,
double clicks, restart recovery, media integrity/access and separate generation.
The mock-generation boundary test asserts the existing reservation and journal
before a synthetic ACK, and proves recovery polls that same mock job once.
No real provider generation is needed to validate this change.

The existing CI workflow includes `test/lumi-mini-app-auth.test.js` and the Mini
App integration cases in `test/lumi-q41-first-image.test.js`. UI markup checks
are explicitly offline and are not a real mobile-device acceptance claim.

Real acceptance must open the app from the bot in an authenticated Telegram
client, display the existing EP004 source and checkpoint, and exercise a quote
renewal without clicking either economic authorization or generation during
deployment validation. HTTPS readiness alone does not prove Telegram acceptance.

Official protocol reference: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
Official public-key protocol: https://core.telegram.org/bots/webapps#validating-data-for-third-party-use
Menu API reference: https://core.telegram.org/bots/api#setchatmenubutton
