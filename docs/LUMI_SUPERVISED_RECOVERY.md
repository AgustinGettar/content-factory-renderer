# Supervised recovery within the existing Lumi runtime

The immutable proposal remains in `lumi_telegram_review_sessions.state.supervised_replacement_proposals`. Preparing or displaying it does not accept risk, create an operation, reserve funds or call a provider. EP004 remains paused at image:q42, checkpoint revision 23, 8/50.

## Human decision and execution boundaries

The existing Telegram Mini App verifies HMAC or Telegram Ed25519 initData, owner, private chat, session, Origin and CSRF. The new routes use the same authenticated principal. A read of `/replacement/:id/review` materializes verified sources, creates a short-lived encrypted payload and returns a signed challenge. It has no database writes or provider calls.

The user must check an initially unchecked risk box and press “Registrar mi aceptación de riesgo”. `/replacement/accept` records consent only. The server binds proposal, original operation, episode, shot, action, exact payload SHA-256, maximum reservation, disclosure version, authenticated identity and server timestamp. The HMAC-sealed consent and its append-only history live in the existing session. Replaying an older challenge cannot replace a newer grant. Original q42 consent and the USD 8 budget consent never grant this permission.

A separate confirmation posts `/replacement/generate`, bound to the displayed consent reference. It claims one quote attempt, obtains a fresh exact-payload quote through the existing estimator and enters the Recovery Manager transaction. Expired source/payload consent needs a new explicit review; quotes are never automatically retried. A failed quote may be reviewed again only while there is no generative claim.

`lumi_supervised_replacement_v1` is SECURITY INVOKER, executable only by service_role. It locks the target and contributing source checkpoints in stable order, the review session and the journals. ACTIVATE verifies CAS, grant, quote and both liabilities, then atomically creates the distinct operation, a separate `replacement:<attempt>` reservation, stage receipt and PREPARED journal. A unique index permits only one supervised successor per original. The ordinary admission RPC still rejects pre-existing ambiguous scopes.

The existing `journaledFetch` performs the emission. Its PREPARED-to-EMITTING transition repeats the original-result, consent, deadline, reservation and checkpoint checks transactionally. A synchronous deadline guard immediately precedes transport. The new request uses the proposal's independent idempotency key. A local rejection, connection timeout, ambiguous response or interrupted process never releases the claim or permits another generation.

## Recovery and accounting

Recovery is an explicit authenticated action. It reuses the existing accepted-job GET, artifact verification, receipt persistence, stage handling and human review. Reading progress never polls a provider or resumes generation.

If an original result appears before the replacement emission claim, activation stops. SELECT_ORIGINAL accepts only a matching durable original receipt or acknowledged original journal; it serializes against DISPATCH, preserves both journal rows and any reservations, and selects the original for existing-result recovery. An original ambiguous journal is never rewritten to ACKNOWLEDGED. A successfully retrieved and verified original gets separate, exact receipt/artifact proof in checkpoint metadata, checked by input materialization. A mere request ID or unbound artifact is insufficient.

If an original result appears after the replacement emission claim, both records remain and possible duplicate charging stays explicit. No third request is admitted. The database emission claim is the concurrency boundary; no database transaction can guarantee what a remote provider did or charged.

A replacement result reconciles only its own reservation key. The old reservation remains until independently verified cost evidence exists. The original incident is retained and linked in recovery metadata when a future replacement activates; its old active pointer does not block the new artifact's separate human review. No incident or original operation is deleted.

## Generality and validation

The consent and atomic transaction are episode/shot independent. Current concrete provider bindings support Higgsfield IMAGE and VIDEO using existing payload builders. Other provider families require their own verified payload/quote adapter; unsupported bindings fail closed. EP005 image and EP006 video are synthetic local cases, never staging fixtures.

Tests use PGlite to execute the actual migration and authenticated handler path: duplicate clicks, concurrent consent, stale references, session reopen, quote expiry, CAS conflict, source-budget race, timeout, ambiguous result, late original, HTTP Origin/CSRF, immutable journals, original reserve preservation, distinct idempotency and read-only UI. Existing materialization and stage-review tests guard result provenance and cost reconciliation. Synthetic provider responses are not real generations or financial evidence.

This release performs no consent, quote, activation, reservation or provider-generation request in staging. Real user decision, real quote/emission/recovery and Telegram device interaction remain NOT_TESTED_REAL. Inspect deployment evidence and the compact resume file before any future action.

## Durable consent and failed confirmations (2026-10-19)

The existing adapter and RPC now separate three deadlines: the signed review challenge (up to 3 minutes), the human's explicitly displayed consent (24 hours for new contract version 3 decisions), and each fresh quote/confirmation (at most 60 seconds). Existing version 2 grants keep their exact signed expiration and history; no migration extends or reissues them. New consent remains bound to the proposal, original operation, original payload SHA, maximum amount, disclosure version, person, and a stable approved-content fingerprint. Verified source SHA values replace only expiring transport URLs in that fingerprint; prompt, model, profile, settings and reference order remain bound. Each fresh quote, reservation and journal binds the newly materialized exact body SHA.

A failed quote cannot consume valid consent. An explicit generation confirmation has a single-use UUID and a signed, bounded claim. Its outcome records a safe error code, phase, optional SQLSTATE and estimator receipt in the existing session state. A later user confirmation may replace only a failed or expired quote claim when no replacement journal/operation exists. Its different claim ID fences out the older process. No automatic retries, consent renewal or provider calls occur on GET/status/session reopen. A claim with any existing journal stays blocked for recovery; the original ambiguous journal and reservation remain unchanged.

Real EP004 observations: two specific acceptances were persisted (23:58:54Z and 00:02:48Z), with explicit stored expirations 00:01:47Z and 00:05:40Z. Quote claims were written at 00:00:58Z and 00:03:10Z. No replacement operation, journal or reserve exists. Both confirmations started before their consent deadlines. The primary backend error was not persisted and is absent from available Render/application and PostgreSQL error logs: UNKNOWN, not retroactively attributed to expiry. Confirmed defects are the inherited short consent deadline and quote claims without durable terminal diagnostics. A current calculated reservation above USD 0.3275 remains blocked; no limit is relaxed to make a test or generation pass.

Migration 20261019003616_lumi_supervised_durable_consent.sql replaces only the existing service-role RPC. It creates no service/table and rewrites no consent, journal, checkpoint or budget data. Tests use PGlite and mocked provider responses; they are not real generation evidence.

## Cost and traceability continuation

The later 00:54:36 UTC rejection and third, valid 24-hour human grant are documented in docs/LUMI_COST_RELIABILITY.md and docs/lumi-improvement/q42-cost-recovery.json. This supersedes the earlier two-expired-grants snapshot, without changing its history. QUOTE_RESULT now persists exact economics before admission; an authenticated quote-only action never activates a generation. Shared decimal reserve calculations, linked-source exposure, whole-episode cost planning and existing-journal correlation/recovery projections apply across episodes. No original data is backfilled or altered.
