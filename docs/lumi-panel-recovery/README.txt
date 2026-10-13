LUMI — EXPLICIT PANEL RECOVERY / LOCAL APPROVAL PACKAGE

BASE
Local parent 6dfa62f916c5c712a114d57bbc5fb9a6a4dc837d.
Deployed equivalent base tree: a1a34e8cf84ddbaa3b575b74f329bd57014080e1.
No push, deploy, Make edit, Telegram message, provider call or EP004 creation performed.

DEMONSTRATED PROBLEM
The user confirms panel 138 is invisible after clearing chat history even though Telegram accepts edits. The existing route only edits. Q41 authentication and module21 ACK envelope also hard-code138. A database-only panel replacement would break continuity.

MINIMAL CHANGE
Existing ReviewService.recoverPanel implements RECOVER_TELEGRAM_PANEL through the signed staging Make endpoint. A fresh owner message /recuperar_panel invokes it in scenario6224860, using the existing module8 -> module12 -> module21 path. No new scenario or module.
HMAC, staging scope, owner allowlist, active-owner check and existing durable nonce claim precede preparation. Direct op accepts only op,user_id,chat_id; clients cannot choose a new message ID. The explicit Telegram command must be at most120seconds old; old queued recovery commands fail closed.
The existing durable session reserves one recovery emission in one CAS. It prepares a sendPhoto action using only the cached canonical HOME file_id and the existing four-button renderer. Ordinary navigation still edits the operational panel.
The reservation remains permanently retained for this controlled incident. Repeated requests, new nonces and duplicate webhooks cannot create a second panel. A second future recovery is deliberately not automatically enabled by this release.
Only a signed ACK with the matching command, owner/chat, a positive new Telegram message ID, canonical photo identity, caption hash and available keyboard evidence changes the operational panel. Supabase CAS updates the JSON state and the message_id column together under one revision predicate. ACK contention rereads and revalidates before retrying.
The previous panel, delivery, screen, canonical binding and tokens are archived in session.panel_history[oldId]. Episodes, master binding, reviews, approval decisions and economic records are not rewritten. Old callbacks become stale without invoking production. New callbacks and commands bind to the active panel.
Q41 and balance authorization compare with the trusted current session ID instead of138. Existing signed budget policies remain unchanged; runtime validation permits only the current panel or a server-archived panel for historical consent. Owner, account fingerprint, expiry, USD5 ceiling, quote/reserve/reconcile gates and request limits remain mandatory. Existing Recovery Manager grants retain their original signed context while recognizing a server-recorded panel migration. New callbacks must use the current panel.
Historical one-time master bootstrap and legacy audio-serializer workaround intentionally remain restricted to their original138 evidence; neither is an operational new-panel route.

FAIL-CLOSED LIMITS
This is not a claim of exactly-once Telegram delivery. Telegram sendPhoto has no application idempotency key. After reserving the emission, an HTTP timeout, crash, lost response or missing ACK leaves recovery pending; no command or /menu resends it. This can leave zero delivered messages if failure precedes the send.
If sendPhoto succeeded but the ACK was lost, recover the exact Make module12 success receipt and reconcile with a fresh signed ACK. Never rerun module12, replay a cached sendPhoto action, clear the reservation or invent a receipt. Unknown outcome requires explicit evidence recovery. The application cannot prevent a person or external transport from manually replaying a raw Telegram call.
Visibility still requires human confirmation after actual delivery. HTTP200 alone is insufficient.

MAKE PATCH — PREPARED ONLY
Scenario6224860 module21 currently embeds message_id138 in both the JSON ACK body and its HMAC body expression. The two guarded substitutions in make-module-21-change.json replace only that literal with10.message_id. The Telegram result's new message ID remains sourced from12.body.result.message_id.
For the initial recovery ACK, the envelope retains the previous command panel ID; for subsequent edits it carries the new operational ID. Backend validates envelope against the current durable command and independently validates the actual receipt. Duplicate ACK cannot bind a different new ID.
Read-only inspection of current module21 confirmed one match in each field and exact body/HMAC equality before and after substitution. Offline IML evaluation verifies recovery and subsequent new-panel navigation. Real Make evaluation remains pending authorization.
No change to webhook, module8, module12, HTTP timeouts, keys or stopOnHttpError. No generic Ignore added.

TESTS AND SECURITY REVIEW
187/187 focused and relevant regression tests passed with network hard-disabled.
Includes19 new tests: invisible editable panel, explicit recovery, concurrent claims, repeated requests/webhooks, forged HMAC, forbidden client IDs, old queued commands, invalid receipts, ACK CAS, duplicate ACK, old/new callbacks, dynamic Q41 binding, dual-column CAS, real-shaped Make ACK template, crash after reservation, lost ACK persistence, historical sealed budget policy and full single-panel navigation/master preservation.
Relevant prior suites: Make transport/concurrency, Telegram review/rendering, EP004 blocked flow, first-image gates, generic runtime and balance recovery, audio review, Recovery Manager and controlled episode actions.
Security review: no credential exposure, no new permission/table/journal, no generative calls, no implicit budget authorization, no automatic ambiguous retry, no historical approval mutation. CI workflow now includes the new tests and existing concurrency suite. Remote CI has not run for this local commit.

ONE DEPLOYMENT APPROVAL PACKAGE
Authorize publishing this commit's changes only to lumi-telegram-review-v1 without force; preserve unexpected remote changes; require CI GREEN; deploy only content-factory-av2-staging.
Apply only the two guarded module21 substitutions after fresh configuration comparison, preserving the identical HMAC body. Pause only6224860 during coordinated cutover if necessary; inspect its queue and never process old or ambiguous events. Queue disposition requires its exact authorization.
After deploy and patch, the user sends /recuperar_panel once. Do not call the direct recovery endpoint merely as a probe: it durably reserves the emission.
Correlate module8 command, exactly one module12 sendPhoto success and module21 ACK200. Verify actual new message_id in both Supabase column and JSON, archived138, unchanged master/reviews and no provider journal entries. User confirms new panel visibility and four buttons.
Then /menu -> Crear video -> Volver -> Producción -> Volver -> Mis videos -> Inicio must edit the same new ID; verify Make remainsACTIVE, ACK200, no further sends and no generation. View EP004 proposal/budget screen only; do not confirm economic policy or generation merely for acceptance.
If outcome is ambiguous, stop with the existing pending reservation and collect exact receipt evidence. No automatic replacement or reset.
