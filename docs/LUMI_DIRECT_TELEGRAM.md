# Direct Telegram transport — prepared, cutover blocked

Observed 2026-10-20. Same bot 8843261381 / AppMultimedia_VideosBot, same Studio,
same staging service and Supabase. No new hosting, production engine, budget
ledger or provider journal. No generation, quote or economic write was made.

## Actual evidence and remaining prerequisite

Remote and live baseline: d695bc56cf5f691e5f55ceee032dbe5840d796af.
getMe through the existing shell verified the exact bot. Render startup logs
at 2026-10-20T15:35:43Z report bot_credential=false, callback_secret=true.
The token exists in Make connection 11003632; it was not extracted. Configure
LUMI_TELEGRAM_BOT_TOKEN directly in Environment for content-factory-av2-staging
(srv-dapgakqd0e5s73fottig). Never paste it in chat. Do not revoke/regenerate it.

This release intentionally leaves transport authority unchanged and DIRECT
inactive. No webhook change or Make deactivation is claimed. No test Telegram
message was sent. The existing Studio menu remains configured as previously
verified; device interaction after this release is NOT_TESTED_REAL.

## Functions and boundaries

- /start, /menu and ordinary owner messages: direct sendMessage with one
  “Abrir Lumi Studio” button. No model, plan, quote, reservation or generation.
- Legacy callbacks: ownership and panel/token validity are checked; both valid
  retired controls and stale controls only answer with a Studio redirect. They
  cannot execute any old approval, spend, generation or retry.
- Future pending review artifacts and masters: discovered from the existing
  review session, delivered as a private Studio notification with a real Telegram
  message ID receipt. Original media remain behind existing authenticated
  Studio/library/range/download routes. No public media URLs in messages.
- First DIRECT activation establishes a durable notification baseline. Existing
  media are not redelivered. Subsequent new artifacts are found after restarts.
- Old Make AI-idea branch (module 11) is retired, not reproduced. Studio remains
  the destination for existing production/library/reviews. Automatic AI idea
  generation has no newly activated substitute. No paid model was called.
- The inspected Lumi scenarios contain no schedule or provider callback trigger:
  panel 6224860 uses WatchUpdates; shell 6532649 is on-demand. The historical
  backend bridge is disabled under DIRECT. No other automation was changed.

## Durable reception and delivery

POST /lumi/telegram-review/telegram/webhook accepts at most 16 KB of JSON and
only message/callback_query updates. It checks the independent
LUMI_TELEGRAM_WEBHOOK_SECRET, private owner/chat, server allowlist and active
cf_bot_admins ownership. getMe must match the configured bot before admission.

lumi_direct_telegram_v1 extends the existing state.make_requests transport
receipts. A transaction and advisory lock enforce bot_id + update_id uniqueness
across owners; the session row lock/revision fences concurrent CAS mutations.
No new table or parallel journal. The function is executable only by service_role.
HTTP 200 follows durable acceptance or a durable IGNORED/LEGACY_HELD disposition.
Unavailable storage returns 503. Invalid owner/secret is rejected without effect.
Only normalized routing descriptors, hashes and authentic delivery IDs are kept;
no incoming personal message text, credentials or raw initData.

QUEUED work is read from Supabase on startup and each transport-only poll.
CLAIM atomically persists DISPATCHING before HTTP transport. Only the winning
claim sends. DELIVERED stores the actual response ID. Lost HTTP response becomes
UNKNOWN; a process crash or failed ACK persistence retains DISPATCHING. Neither
state is automatically resent. Telegram message delivery is not claimed to be
exactly-once end to end. A crash before transport after CLAIM can require manual
reconciliation rather than risking a duplicate. Receipts are not pruned by the
old Make nonce cleanup. Capacity exhaustion fails closed, never clears evidence.

Render is on its existing free plan. Suspension pauses the transport poller;
accepted QUEUED work remains durable and resumes when the service wakes. A new
Telegram delivery can wake it. No instant response or continuous availability is
promised, and no keep-alive, new worker service or plan upgrade was added.

## Authentication compatibility

The callback secret remains the session/media/CSRF key when configured. Adding
the bot token cannot rotate it. The same official Ed25519 initData verifier and
canonical replay identity remain selected for this bot. HMAC remains supported
for existing token-only configurations. Do not rotate the callback secret.
The webhook secret must be independent of both the callback secret and bot token.
DIRECT disables the old Make/legacy callback endpoints with HTTP 410. Existing
CAS, reviews, Budget Gate and Provider Emission Journal remain authoritative.

## Cutover procedure — not executed

1. Configure the bot token in the target Render secret store. Verify getMe from
   the backend, not merely the historical Make connection. Prepare a random
   independent LUMI_TELEGRAM_WEBHOOK_SECRET (32–256 URL-safe characters) there.
   Keep LUMI_TELEGRAM_CALLBACK_SECRET and LUMI_TELEGRAM_BOT_ID unchanged.
2. Recheck the exact remote commit CI GREEN, staging SHA, isolated Supabase,
   runners OFF and autorun false. Check the direct readiness endpoint. Read
   getWebhookInfo without logging its secret-bearing URL. Preserve its exact
   configuration securely; the original scenario/configuration still exists.
3. Inspect Telegram and Make queues separately. At this observation Telegram
   pending_update_count=0; Make queued.count=1, limit=50. The latest accepted
   update 830558974 has an existing durable Make claim and a failed run
   0672edcb5b394115a23575f0db7a243c. Do not replay it. The queued payload is not
   exposed by available inspection. Retain it in Make for review, never import
   it as an executable event. History also has two pending entries without IDs;
   incompleteExecutions=0 does not prove they were delivered. Full provenance
   is in docs/lumi-improvement/make-cutover-evidence.json.
4. Reinspect and deactivate only substituted panel 6224860, preserving its
   configuration, queue and histories. Confirm no other consumer will restore
   its webhook. Do not clear the queue or automatically replay old callbacks.
   Set LUMI_TELEGRAM_TRANSPORT_AUTHORITY=DIRECT on staging and verify the new
   backend identity/readiness before changing Telegram. The shell can remain
   available only through the controlled cutover; deactivate it after success.
5. Make exactly one explicit setWebhook call FROM THE BACKEND for this bot to the staging HTTPS
   endpoint above, secret_token from the independent secret, allowed_updates
   ["message","callback_query"], drop_pending_updates=false. Never call
   getUpdates alongside a webhook. Never register a webhook on startup.
   Do not pass secret_token through Make: its execution history is an unnecessary
   disclosure. Use the temporary backend control described below.
6. Immediately verify getWebhookInfo destination, pending count and errors.
   Use at most one owner /start interaction: it should return the Studio button;
   open Studio and verify existing private media. Do not click Generate.
   Confirm the real message receipt. Then deactivate shell 6532649, preserve
   everything, and verify both consumers are inactive. No subscription changes.

There is currently NO prevalidated operational Make rollback: panel status is
error, not a verified working backup. This intervention changes no webhook and
therefore requires no rollback. If a later cutover fails, do not improvise or buy
a plan. Only restore a separately prevalidated transport configuration; otherwise
keep Studio accessible and retain pending events while reporting the interruption.

## Validation and recovery handoff

PASS_OFFLINE: actual SQL in PGlite, concurrent/repeated updates, cross-owner
identity, CAS conflicts, database reopen, response/ACK loss, legacy callbacks,
notification baseline, authentic response receipts, token-addition signatures.
PASS_OFFLINE: affected HMAC, binary receipt, library/auth/private master tests.
PASS_REAL: getMe/getWebhookInfo via existing shell; Make queue/history inspection;
staging schema-only migration, service-only privileges; protected snapshot equality.
NOT_TESTED_REAL: direct authenticated delivery, actual webhook cutover, device
/start and Studio opening, hosting suspend/resume. Missing backend token blocks
these. Synthetic events were not inserted in staging or presented as Telegram.

EP004 remains PAUSED_INCIDENT 8/50. Q41 approval, Q42 original, proposal,
consent history, USD 0.3275 reserve, USD 8 cap and all journals are unchanged.
The prior grant expired at its original timestamp, 2026-10-20T00:53:52.703Z;
it was not deleted or extended. USD 0.375 one-tap work is preserved, not applied.
See docs/recovery/README.md for the exact unfinished one-tap work. Transport work
is technical progress only and does not advance episode production.

Official protocol reference: https://core.telegram.org/bots/api#setwebhook

## Temporary backend cutover control

The original procedure lacked a safe operator path for setWebhook. Automatic
approval review rejected transmitting the independent webhook secret through
Make. State inspection confirmed the rejected action did not change Telegram.
The receiver itself is unchanged; the existing direct adapter now exposes an
explicit staging-only control at `/lumi/telegram-review/telegram/cutover`.

Configure a separate random `LUMI_TELEGRAM_CUTOVER_KEY` and a short explicit
`LUMI_TELEGRAM_CUTOVER_EXPIRES_AT` in Render using a merge, never replacing env.
The key must differ from the bot, callback and webhook secrets. Keep the local
operator key in a private temporary file outside the repo. The CLI accepts only
INSPECT or CONFIGURE, signs the body and timestamp, and pins the deployed SHA.
INSPECT exposes only a hash of the previous destination and safe metadata.
CONFIGURE requires that hash, checks the exact bot and existing Studio menu,
claims once through the existing session CAS, then invokes Telegram using the
backend credential. The webhook secret travels only from Render to Telegram.
The receipt has kind OPERATOR_CUTOVER and cannot be drained as a notification.

Run `node scripts/lumi-telegram-cutover.mjs INSPECT <sha> <private-key-file>`.
After checking the response, run CONFIGURE with the same arguments and the
returned destination_sha256. On any uncertainty, use INSPECT; never reissue the
mutation. A DISPATCHING receipt after process loss is retained and blocks replay.
There is no automatic retry or startup registration. Clear the temporary key
and expire the control after verification. No bot, callback or Studio keys rotate.
