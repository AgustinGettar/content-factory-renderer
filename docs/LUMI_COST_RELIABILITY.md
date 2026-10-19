# Lumi cost and recovery contract

This extends the existing USD Budget Gate, Recovery Manager, emission journal,
session claims, result receipts and asset library. There is no new budget system,
journal, scheduler, provider service or production permission.

## Real EP004 rejection: 2026-10-19 00:54:36 UTC

The durable confirmation `dbef34a4-3106-4b67-858b-fe25e236e1f7` failed in QUOTE
with `Q41_REQUEST_RESERVATION_LIMIT_EXCEEDED`, before ACTIVATE. Render recorded the
same code at 00:54:37 UTC. The transaction recorded NO_JOURNAL_NO_GENERATION;
independent operation, reservation and journal are absent. This establishes the
replacement boundary through the deployed code and durable transaction, not
through a popup or absence of logs. The original q42 remains ambiguous.

The deployed gate rejected either a zero quote or a reserve above USD 0.3275.
It computed ceil(quote × 1.25 × 1,000,000) / 1,000,000. The quote amount, quote ID,
provider receipt and expiration were not retained when that gate threw. Their
exact historical values are UNKNOWN. It is not possible to choose between the
zero-price and over-limit branches retrospectively. The Q41 prefix is a legacy
error label, not evidence of cross-shot identity. Freshness/body binding checks
preceded this branch; USD 6.77375 available for the episode did not expand its
specific USD 0.3275 authorization. No new estimate was requested to infer history.

The human grant was recorded at 00:54:03.567 UTC and explicitly expires at
2026-10-20 00:53:52.703 UTC. It is preserved, with its original signed content
fingerprint, maximum, identity and history. This technical intervention does not
accept, extend, replace or exercise the grant.

## Cost admission and durable evidence

`supervisedBudgetDecision` is the shared pure USD decision. Exact decimal
arithmetic rounds the 25% internal margin upward to micro-USD. A rejected decision
retains quote ID/time/body hash/HTTP receipt, exact quote, multiplier, calculated
reserve, specific maximum, existing exposure, remaining episode budget and a
distinct reason. Zero, stale/binding mismatch, specific-limit and episode-limit
failures are distinguishable. An internal reserve does not cap provider billing.

The supervised runtime obtains its quote through the actual Higgsfield estimator
adapter, then records QUOTE_RESULT in the existing fenced claim/history before
admission. SQL validates episode/action/model/payload/claim and recomputes the
decimal reservation. ACTIVATE requires that same durable quote, fresh consent
and quote, original evidence, checkpoint/session CAS and both liabilities under
the locked episode ceiling. DISPATCH checks them again. No migration rewrites
an existing claim, grant, journal, checkpoint or reserve.

An authenticated explicit POST to `/replacement/quote` records only a quote.
It cannot reach ACTIVATE, reserve, journal preparation or generation. POST to
`/replacement/generate` remains a separate explicit action and obtains a fresh
quote within the unchanged grant. Known over-limit decisions disable generation
in Studio and display exact amounts. Historical missing-price rejections show
that limitation and offer only a new explicit price consultation. GET progress
does not quote, poll providers, accept risk, reserve or emit. A valid consent is
not requested again merely because a quote or signed transport URL expires.

Whole-episode planning covers images, clips, voice, contingency, storage and
infrastructure in the existing episode ledger. Missing USD evidence stays null;
voice character quota is not translated into fabricated USD. Historical estimates
are labeled and do not authorize execution. A new production without completed
visual media must complete its cost plan before its first paid admission.
Existing episodes retain their scoped recovery contracts. The projection does
not approve quality reduction, model/provider substitution or budget expansion.

The approved library is searched before supervised estimates. Direct media and
references retain existing compatibility checks and explicit selection. A
reference still requires generation; only an applied completed direct reuse with
an existing bound quote can report verified savings. Suggestions, unknown prices
and reused references do not become verified savings.

## Provider evidence and recovery states

`journaledFetch` durably records operation/idempotency/body/quote/reservation/
dispatch identities before transport. Its EMITTING claim records request start;
HTTP status and X-Correlation-ID are saved before parsing. Safe accepted job and
status metadata are retained afterward. Verified result receipts contain private
artifact identity and request-bound billing evidence. `providerOperationTrace`
projects these existing records without mutating them. Missing old fields remain
unknown; history is not backfilled with invented acknowledgements.

| State | Required evidence | Allowed next state / recovery | Budget and duplicate guard |
| --- | --- | --- | --- |
| PREPARED | Payload/operation or PREPARED journal | AUTHORIZE; inspect existing claim | No automatic replay of a journal |
| AUTHORIZED | Specific unexpired human grant | Fresh quote then RESERVED | Specific maximum, not entire episode budget |
| RESERVED | Atomic reserve and operation claim | DISPATCHING if final CAS passes | Keep original plus new reserve |
| DISPATCHING | Durable EMITTING claim/start | SUBMITTED or EMISSION_UNKNOWN | A crash cannot create another POST |
| SUBMITTED | Accepted job ID and status URL | PROCESSING, SUCCEEDED, FAILED_CONFIRMED via same-job GET | No resubmit; preserve liability |
| PROCESSING | Matching provider job status | Same-job GET to terminal state | No new generation |
| SUCCEEDED | Matching terminal response | Persist/verify artifact then review | Do not invent actual charge |
| FAILED_CONFIRMED | Explicit terminal job/rejection or durable local non-emission proof | Evidence review | Failure alone does not release reserve or authorize replay |
| EMISSION_UNKNOWN | Lost response, unresolved claim, or HTTP without accepted job proof | Evidence review; GET only with verified job identity | Preserve journal and reserve; no timeout retry |
| AWAITING_HUMAN_REVIEW | Verified persisted artifact tied to accepted job | APPROVED by exact human review | No third request |
| APPROVED | Human decision for exact artifact | Next production stage | Reconcile only verified request cost |

The remote side can accept a request while local acknowledgement persistence
fails. This remains ambiguous and blocked after restart. A response header alone
is not an accepted job receipt. If an original appears before replacement
transport, original recovery takes precedence; after transport, both records and
possible duplicate cost remain visible. Neither path emits a third request.

## Current official provider contract and its limits

Read 2026-10-19: https://docs.higgsfield.ai/docs/concepts/idempotency.md documents
Idempotency-Key on generation submissions, one key per intent, with the same
endpoint/JSON/webhook required for reuse. URL changes are material. New independent
replacements keep different keys. The application sends and records the header;
it does not follow the provider's retry suggestion because automatic resubmission
is outside Lumi's authorized recovery contract. No live replay or account-level
exactly-once guarantee has been verified. Never retrofit a key onto historical q42.

https://docs.higgsfield.ai/docs/concepts/errors.md documents X-Correlation-ID.
https://docs.higgsfield.ai/docs/concepts/requests.md documents accepted job IDs and
same-job polling. https://docs.higgsfield.ai/docs/concepts/billing-and-retention.md
documents the exact-payload estimate and output retention. General refund policy
is not request-specific billing proof and does not authorize releasing q42.

## Current episode economics and validation limits

EP004 remains 8/50, PAUSED_INCIDENT, next image:q42, q41 approved. Cap USD 8;
unreconciled exposure USD 1.22625; remaining internal budget USD 6.77375; original
q42 reserve USD 0.3275. No replacement reserve or generation was created here.
Its 6 remaining images, 6 clips, voice and storage/infra allocation lack sufficient
current USD evidence for a complete total. Minimum/probable total are UNKNOWN,
not zero and not a promise of fitting USD 8. Of 17 approved library records, the
read-only q42 compatibility analysis found 13 compatible reference suggestions
and no compatible direct media reuse. Verified monetary savings are UNKNOWN.

The actual SQL/auth/quote adapter paths are tested with synthetic EP005/EP006
and network blocked. Real EP004 reads validate preservation, not a new provider
generation, price, charge or completed master. See the versioned incident,
cost-recovery evidence, resume state and one generated next prompt for exact
test/release evidence. Real device interaction remains NOT_TESTED_REAL.
