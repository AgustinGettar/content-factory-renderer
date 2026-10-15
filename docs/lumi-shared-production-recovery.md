# Shared production recovery — 2026-10-15

Scope: `lumi-telegram-review-v1`, `content-factory-av2-staging`, Supabase
`mofjhwathxzfnjapvvst`. No schema migration, parallel persistence, automatic
publication, provider refill or real generation is part of this change.

## Original q42 evidence

The inspected branch and live staging started at
`fbec54e850f6ad36d058d66ed3ccf612f3c7f35d`.
EP004 is at revision 22, PAUSED_INCIDENT, eight of 50 actions complete,
last `shot_review:q41`, next `image:q42`. q41 image/video approvals are preserved.

Original Mini App operation:
`125ed083ab1bc866e0c3670c60d7cadee1dc284dbcd48f97dc6bdca95795dc90`.
Original provider attempt:
`6caebf9f4cbafe0fc69c0d71755a2e16cb1df4cdde2ff6b85af36df99e301f30`.
Its durable journal says EMISSION_UNKNOWN / NO_RESPONSE, no provider request ID.
There is no verified artifact or ACK to reconcile. It must remain fail closed.

`Q41_EMISSION_BINDING_CHANGED` was a combined shared-stage validation error,
not proof that q42 used q41's identity. The durable q42 quote, source, payload,
authorization, attempt and reservation are independently scoped. No identity
collision was demonstrated. The quote expired at 20:20:52.775Z; the journal
entered EMITTING at 20:20:52.420Z and recorded its error at 20:20:54.232Z.
The old wrapper performed asynchronous local validation inside the transport
callback, after marking EMITTING. The observed interval supports quote expiry,
but the historical combined error cannot isolate which predicate failed or
prove provider non-emission. This change does not reinterpret that record.

The connected Higgsfield marketing history did not supply an original request
ID; an empty marketing history is not API non-emission evidence. Connector
credits are not a verified API USD balance or billing ledger.

## Shared boundaries

* Each new journal descriptor records episode, shot, action, attempt, original
  operation, quote, source and payload hashes, authorization digest, reservation
  identity and checkpoint revision. Existing journal CAS states remain the
  concurrency authority; there is no invented numeric journal revision.
* Asynchronous validation precedes EMITTING. A synchronous deadline guard
  immediately precedes the transport. A rejection at that guard records
  NOT_DISPATCHED / transport_invoked=false. No path automatically releases a
  reservation or reuses a consumed claim.
* Status and recovery verify the original episode/shot/stage/attempt. A sealed
  historical consent and quote authorize recovery of their original accepted
  job independently of later compiler changes. They do not authorize a new POST.
* Mini App operation selection and session intents include the episode. Server
  selection accepts only existing owned V2 episodes and refuses in-flight work.
* The IMAGE compiler uses authored AV2 entities, placement and continuity plus
  the canonical Lumi reference. The old compatibility background plate omitted
  Lumi. Existing frozen quotes and consent fingerprints are not rewritten to
  authorize the changed payload.
* Each new source needs its own authenticated human checklist and artifact SHA.
  Future episodes supply an explicit object inventory in their director contract;
  missing inventory fails closed. Mini App review operations are checked against
  the durable review before source/direction/temporal QA can consume them. If a crash separates the
  decision, checkpoint and UI acknowledgement, recovery uses that exact existing
  decision; read-only projection never creates a replacement approval.
* Future TTS consent may cover a frozen bounded request set. Quote observation
  expiry does not erase that explicit consent. Every segment checks remaining
  quota and has its own original receipt. Legacy consents are not broadened.

## State projection

The normalized lifecycle is a read-only projection of the existing checkpoint,
operations, receipts, reviews, reservation and provider journal. It is not a
second stored state machine. Legacy API status fields remain compatible.

| State | Required evidence | Permitted progression |
| --- | --- | --- |
| NOT_STARTED | Pending checkpoint, no emission claim | Prepare current action |
| PREPARING | Current durable operation or local claim | Read; recover a proven unclaimed local action |
| QUOTING | Original estimate claim/result | Read or authorize a valid returned quote |
| AUTHORIZED | Exact durable economic decision | Emit once only while all current gates pass |
| RESERVED | Original budget reservation | Read; inspect original evidence |
| EMITTING | Journal transport boundary | Read; never resend on timeout |
| PROCESSING | Verified original accepted job or bounded TTS continuation | Recover original or continue authorized unit |
| SUCCEEDED | Verified persisted artifact and result | Enter required review |
| AWAITING_HUMAN_REVIEW | Exact pending review and artifact | Human approve/reject |
| APPROVED | Durable human decisions and completed checkpoint | Download or select another episode |
| FAILED_CONFIRMED | Verified original provider rejection | Inspect evidence; no automatic retry |
| AMBIGUOUS | Unresolved original request/response | Read and reconcile evidence only |
| BLOCKED | Failed gate or incident | Read and resolve the specific gate |

Returned allowed actions are further restricted by the actual checkpoint and
capabilities. Every state forbids automatic retries, timeout re-emission,
release of ambiguous reserves and skipped human reviews. State GET is read only.

## EP004 production and budget

The seven authored shots last 4, 4, 4, 4, 5, 5 and 3 seconds (29 total).
q45 retains its 2.5-second response window. Narration uses the frozen Fernanda
profile. The AV2 plan contains no authored subtitle text; the CAPTIONS gate
validates that contract without inventing captions. A different captioned
version requires an explicit authored contract and its existing QA gate.

Original exposure is USD 1.22625: imported first image 0.33875, q41 video 0.56,
q42 ambiguous image reserve 0.3275. Remaining internal allowance is 3.77375 under
the unchanged USD 5 ceiling. These are reservations, not verified provider
charges; actual cost and API balance are unknown.

For planning only, reusing historical rates and the existing 25% reserve buffer
would require 5 x 0.3275 for later images plus 25 seconds x 0.112 x 1.25 for the
six remaining videos: USD 5.1375 additional, or 6.36375 total exposure. This
scenario exceeds available allowance by USD 1.36375 before any unverified
audio charge. It is not a current quote or approval to increase the budget.
Full coverage requires current exact-payload quotes, original q42 evidence,
provider charge reconciliation and Fernanda quota evidence.

## Reproducible acceptance

`MULTI_EPISODE_INTEGRATION` exercises two isolated synthetic episodes sharing the
real Mini App/runtime/stores, with identical shot keys but separate episodes:
14 shots, 28 mocked image/video submissions, 14 mocked audio submissions,
authenticated session reopen, double clicks, human fixture reviews, all stages,
two local 1080x1920 masters and authenticated downloads verified by SHA. It
advances the clock beyond the TTS quote lifetime before continuing authorized
segments. Network access is forbidden by `director-offline-guard.mjs`.

Related focused tests cover cross-episode contamination, mismatched original
journal scope, CAS/concurrent clicks, budget limits, lost ACKs, ambiguous provider
outcomes, local deadline rejection, historical fail-closed behavior, read-only
progress, source review, playable audio and stale client responses.

These are PASS_INTEGRATION / PASS_OFFLINE evidence when green, never proof of
new real provider output or human quality approval. EP004 remains incomplete
until its actual remaining images, animations, reviews, voice, synchronization,
assembly and final master review are completed. The next real action is to
obtain verifiable evidence for the original q42 attempt, not to create another.
