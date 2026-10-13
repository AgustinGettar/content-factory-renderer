LUMI — MAKE RELIABILITY AND TELEGRAM UX V2
Local approval package. No push, deploy, Make write, Telegram edit, provider call or EP004 creation.

RECOVERED CHECKPOINT
Base local HEAD: 09db69523a282b940b5e6d89470876b1c24ad65f.
Published staging tree: fc59612be36cba8fa7f06e92aaf3671118af73a7.
Recovery found the original inventory JSON and private incident snapshot intact; no implementation changes or completed tests were present. Branch local/lumi-make-ux-v2.
The inventory was recovered, not reconstructed: 76 entries, source revision 4c3a3946ca6e0c40176604ddb5bb04ec78ddf710. It predates the q41 additions. The observed HOME had 12 buttons; the proposed HOME has 4. These are different counting scopes.

DIAGNOSIS AND EVIDENCE LIMIT
Module 21: execution 09f49e47d959442197b1b0ca305f96ae, request :ack. Telegram module 12 returned ok=true and message_id=138, but module 21 returned Conflict. The ACK nonce was absent from revision 356. The exact original internal server error was not logged; attribution of this particular historical 409 to CAS remains an inference.
Module 8: execution 57169d6bbfb144f9a4bc225fe4171c1b, request :update. /menu nonce was recorded, no Telegram module ran, and the previous command was EMITTING. Local execution against the captured snapshot raises telegram_delivery_reconciliation_required.
The actual captured ACK metadata validates without concurrency. The pre-fix deterministic interleaving reproduces concurrent_update at ACK nonce claim, missing ACK nonce, and subsequent menu reconciliation_required. It does not prove every historical 409 has the same cause.
A second demonstrable defect was an intermediate persisted EMITTING record without command between two CAS writes. A process failure or a competing nonce write could strand it. Preparation now saves the complete outbox command atomically.
No lease is used by this Telegram session transport. A lease value must not be invented.

IMPLEMENTATION
Existing claimRequest now retries at most six known CAS rejections, rereading the session and rejecting already-consumed nonces every time. No network/provider operation is retried. Database read/write failures are not treated as CAS success.
Existing acknowledgeCommand rereads and validates owner, panel, command, media identity, size, caption and optional keyboard on every CAS attempt. DELIVERED receipts are validated before ACK_ALREADY_APPLIED. A fresh signed request is required for an explicit retry. Old-command ACKs cannot overwrite a newer command.
Existing state.make_requests also identifies duplicate Telegram update_id values in its retained authentication window. A fresh nonce is still recorded, and the duplicate emits no actions. A changed body under the same update identity is a real conflict. This window does not grant arbitrary old-update replay permission.
Existing state.applied records delivered callback IDs; no new journal or table was introduced. A double click during another delivery is stale/pending and cannot repeat a generative operation. A crash after callback reservation stays blocked until explicit reconciliation; /menu cannot erase that reservation.
A verified callback can reconcile an EMITTING command through the same strict ACK validator. UNKNOWN is never automatically marked delivered. Missing external evidence requires explicit recovery, not resubmission.
Expected pending/stale outcomes have explicit status and no edit; they are not declared successful delivery. Replays, exhausted CAS retries, mismatched receipts and unexpected backend failures remain HTTP 409 with sanitized structured diagnostics. No generic Ignore handler was introduced. Potential provider effects are not reported as zero after an uncertain failure.
Make remains the Bot API transport authority. Render owns routing, outbox, idempotency, reviews and budget gates. No provider or generation logic was added to Make.

MAKE MODULE 21 PROPOSED CHANGE (SEPARATE, PREPARED ONLY)
A targeted read confirmed the ACK serializer has no audio metadata. This is distinct from the photo/CAS incident. Before audio review is accepted, append audio.file_id, audio.file_unique_id and audio.file_size from module 12's actual result in both the HTTP body and its HMAC body expression.
make-module-21-change.json contains two guarded literal substitutions, each matching exactly once in the inspected configuration. No secret or complete signature expression is included. make-module-21-body.iml contains the resulting non-secret body template. Both old and proposed complete body expressions were verified to be the exact arguments hashed by the signature expression.
Offline tests evaluate the template for photo, video, audio and the non-review branch, and feed each receipt through acknowledgeCommand. Real Make evaluation is pending authorization and acceptance. Keep stopOnHttpError=true; do not hide unknown failures. No module 8 configuration change is required for the CAS repair.

HOME AND NAVIGATION
HOME PHOTO, same message 138:
🎬 Crear video -> existing create_v2_ideas -> choose existing proposal -> create_v2_budget -> budget explanation -> q41_prepare. create_v2_start remains blocked; this package creates no episode or authorization.
📁 Mis videos -> paginated existing masters -> Ver master -> Descargar MP4 (native Telegram download) / details / Volver.
📊 Producción -> paginated existing episodes -> progress -> available shot -> approve or request correction -> progress. Pending stage review uses the existing review route, including Fernanda audio when an artifact exists. Master approval appears only for a master requiring review.
⚙️ Ajustes -> supervised-mode explanation / intended voice / existing cached voice comparison -> Volver.
All ordinary views edit the existing panel. HOME, details and progress use the stored HOME photo. Master and shots use their bound media. There are no sendMessage/sendPhoto/sendVideo navigation operations.
A balance pause shows Saldo recargado only in the corresponding existing state. Existing revalidation/reservation/reconciliation gates remain authoritative and cannot raise USD 5. Ambiguous provider outcomes offer no unsafe generative retry.
Recovery remains accessible through the incident/progress screen. Full episode activation and future multimedia acceptance are outside this execution and remain subject to their existing gates.

CALLBACK COMPATIBILITY
callback-compatibility.csv and .json map every original entry. lr: opaque identities and all current action names remain unchanged. Old read-only literal navigation is aliased to the isolated router. Historical production commands (choose, manualconfirm, retry, approve and old AI actions) are deliberately blocked as stale in staging; they are not migrated into production RPCs. Historical menu/state records are retained. This is safe compatibility with an explicit unavailable notice, not a claim those production functions work in isolated staging.
The original inventory file is unchanged. Post-inventory q41/current settings additions are listed separately.

SECURITY AND PROTECTED STATE
HMAC bytes, secret, namespace, timestamp window and scope guard unchanged. Consumed nonces are rejected within the existing durable request window; old signed envelopes expire under the unchanged HMAC window. No retry reuses a consumed nonce. CAS retained and bounded. No new table, schema migration, journal, webhook, bot or panel.
Master artifacts, file IDs, reviews and approvals are preserved; ACK merging now also preserves existing delivery review_status rather than replacing it.
No production/main/historical Supabase writes. No global V2 activation, runner activation or autorun change. Network/provider access hard-blocked in tests. No multimedia generated.

ACCEPTANCE PLAN REQUIRING ONE REMOTE APPROVAL
1. Publish only the reviewed local tree to lumi-telegram-review-v1 without force push; require CI GREEN; deploy only content-factory-av2-staging. Keep production and main untouched.
2. Apply only the two guarded module 21 substitutions after verifying the fresh configuration matches. Preserve HMAC, routes, webhook and other scenarios. If the configuration differs, stop before mutation.
3. Read the current isolated session and current queue. The previous queue count of two is historical, not a current assertion. Do not process or delete queued events without identifying and backing them up and obtaining the specific authority required for their disposition.
4. Reconcile only a currently matching pending command with authentic captured Telegram success metadata and a fresh signed ACK. Never resend the Telegram edit. If the command or panel changed, stop and recover matching evidence. UNKNOWN or missing receipt stays fail closed.
5. Activate only scenario 6224860 when its queue can be handled safely. User sends a fresh /menu and navigates Crear video -> Volver -> Producción -> existing episode -> Revisar -> Volver. Do not confirm generation, human approval, correction, cancellation or publication merely to test navigation.
6. Verify module 8 outcome, module 12 actual ok=true/message_id=138, module 21 ACK, DELIVERED persisted state, scenario remaining active and no duplicate messages. Include repeated /menu and double click. Correlate request IDs with new sanitized logs.
7. View the existing master and native download, then restore HOME PHOTO. Verify unchanged master SHA/file identity and historical reviews. Exercise audio transport only with already verified cached audio and explicit transport authority; no synthesis.
8. Local-only negative tests cover forged/replayed requests and unexpected409. Do not deliberately disable the live scenario by injecting unexpected failures during human acceptance.
Only after these observations may real Telegram acceptance be declared. A staging deploy or active scenario alone is insufficient.
