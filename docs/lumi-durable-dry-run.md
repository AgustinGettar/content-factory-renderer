# Durable authenticated staging diagnostic

This change prepares the dry-run transport only. It does not authorize a new
episode, provider generation, publication, or global V2 activation. Deploying it
requires explicit approval of the new commit. Make scenario 6529336 already
passes its `body` input through the existing HMAC signer to the authenticated
endpoint, and returns status/data. No Make edit or timeout increase is needed.

## Contract

Use `POST /lumi/telegram-review/make/v1` with the existing HMAC envelope and a
fresh transport request ID for **every** request. Use a different logical key
for a genuinely new operation; never convert an earlier ambiguous request into
a new operation by retransmitting it.

```json
{
  "op": "START_DRY_RUN",
  "user_id": "<existing authorized owner>",
  "chat_id": "<same owner>",
  "message_id": 138,
  "idempotency_key": "dry-explicitly-approved-operation",
  "verify_tts_preflight": true,
  "dry_run": true,
  "provider_generation": false,
  "publication": false,
  "crash_matrix": true
}
```

The server validates scope, HMAC, payload and active ownership. It claims the
transport nonce and atomically inserts a `QUEUED` checkpoint before returning
202 with `operation_id`. It does not run the diagnostic in the request. The
logical operation ID derives from owner plus idempotency key. Concurrent inserts
use the existing primary key with conflict-ignore, never overwrite-on-conflict.
The same logical key and changed normalized payload is rejected. Unknown fields
and unsafe flags are rejected. A repeated key returns the existing operation.

Query with `GET_DRY_RUN_STATUS` or `GET_DRY_RUN_RESULT` in the same POST namespace,
plus owner/chat and `operation_id`. If the initial response was lost, query with
`idempotency_key` instead of `operation_id`. Queries do not execute work or alter
the operation; only their independent antireplay claim changes. Diagnostic calls
retain expired transport evidence. The old synchronous dry operation returns
`DURABLE_DRY_RUN_REQUIRED` without dispatching work or pruning its original nonce.
The separate existing artifact-replay path is unchanged.

## Persistence and recovery

The existing `lumi_pipeline_checkpoints` table holds the queue, revision-fenced
leases, stage checkpoints and complete projected result under
`metadata.dry_run_operation`. No table, migration, ledger, or database is added.
Every write after insertion uses a conditional diagnostic revision update.

The staging supervisor wakes every three seconds and scans only explicitly
authorized diagnostic records. It creates no work on boot. Global runners and
autorun remain off; normal episodes are never selected by this supervisor.
Accepted operations survive a closed connection, client timeout and process
restart. On a sleeping Render service, polling wakes the service; execution
resumes when a process is running. A 202 alone does not guarantee uninterrupted
process uptime.

Stages are authenticated TTS preflight, generic dry contracts/recovery, and
current runtime checks. Each stage result is saved before the next starts.
Lease duration is 90 seconds with renewal every 30 seconds. Each stage is bounded
to three minutes independently of the unchanged 60-second Make timeout. A stale
worker cannot commit a result. External reads, probes and receipt writes check
the lease. After process death, only an uncheckpointed safe diagnostic stage can
repeat; completed stages and terminal operations never repeat. At most three
process-recovery attempts are allowed, after which the outcome is ambiguous.
An actual diagnostic error is durable and is not retried automatically.

A redeploy to a different revision preserves the operation and marks incomplete
work `OUTCOME_AMBIGUOUS / DRY_REVISION_CHANGED`. It does not merge evidence from
different code revisions. A completed result remains queryable after redeploy.

The TTS stage receives only the client's preflight method, never submit/poll or
publication methods. It performs the native ElevenLabs model, voice and quota
reads, quota-budget gate, real storage round-trip/decode, and existing dry TTS
receipt boundary. One immutable local silence probe is retained under the
operation's isolated storage prefix for crash recovery. No narration is generated.

## Evidence limits

The generic stage runs the existing 14 real wrappers against explicitly labeled
fixture media inputs, including the existing crash/recovery matrices. Authenticated
TTS and real panel/runtime checks are separate gates. Fixtures do not certify
generated media, human review, actual Telegram delivery, or a production episode.
Returned/persisted evidence is a fixed projection: no provider payloads, raw
errors, account details, credentials, headers or signed URLs.

Runtime evidence distinguishes authenticated liveness from direct `/health`
HTTP observation. The health observability warning remains until measured.
Readiness also requires the real Telegram creation/resume/review adapter to be
registered. The current server mount supplies no adapter: the new diagnostic
reports `TELEGRAM_GENERIC_ROUTE_UNREGISTERED` instead of hiding that blocker.
This patch does not rebuild or activate that adapter.

## Validation and rollout boundary

`lumi-durable-dry-run.test.js` tests HMAC, nonce replay, immutable idempotency,
concurrent inserts/workers, response loss, read-only lookup, stage persistence,
lease fencing, sanitized errors, deadlines, zero generation/publication and
the native TTS path with an offline HTTP fixture. The separate process test
kills offline Node workers with SIGKILL and recovers disk-persisted checkpoints
in fresh processes. These are local tests, not authenticated staging evidence.

After explicit publication approval: push only the review branch, require CI,
deploy only staging, and run one newly approved diagnostic. Persist and query
its operation ID; use key lookup if START's response is lost. Do not create a
replacement operation after timeout. Keep readiness BLOCKED until real results
and every gate are available. Do not start the fourth episode in this rollout.
