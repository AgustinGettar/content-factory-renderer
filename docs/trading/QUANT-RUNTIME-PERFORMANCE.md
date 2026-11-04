# Runtime performance and flow audit — 2026-11-04

Scope: existing AWS PAPER engine, secondary operational account, private monitor and Telegram transport. No strategy thresholds, capital, leverage, contracts, credentials, real-order adapter or audiovisual routes changed. Shared persistence/engine optimizations retain both ledgers' financial semantics.

## Observed baseline

Measured on deployed ebccc7def321d3d66ae6c3f63ebbb5f9b699de07, with read-only diagnostics:

| Area | Observation | Consequence |
| --- | --- | --- |
| Process | RSS 179,348 KiB; high-water 190,592 KiB; zero restarts | Not evidence of an established leak; heap trend needs longer observation |
| Cgroup | Around 458 MB charged; 152 MB anonymous, 298 MB file cache; 7,045 memory-limit reclaim events, zero OOM kills | Disk/cache pressure matters even when process RSS is below its guard |
| CPU | Around 29.4% of one CPU over the sampled health window | Material ongoing work even without open positions |
| Checkpoint | 2,268,321 bytes; history and neural observations dominate | Repeated full parsing, cloning and encoding allocate unnecessary objects |
| Ledger | 529 MB SQLite, 117,688 events; 1.02 GB free disk | Future growth/retention must be planned; no ledger/history deleted |
| Dashboard | One measured projection 165 ms; serialization 22 ms; live 735 KB, detail 2.69 MB | Repeated historic plan reads compete with market processing |
| Telegram | Tick awaited network drain | A slow send delayed market/lease supervision |
| Detail upload | Live publication awaited detail PUT | A slow detail request delayed newer live updates |
| Recovery | Site upload hits 16 MiB limit; separate encrypted S3 recovery verified at revision 167432 | Keep hourly local copies/S3; do not imply Site backup is healthy |

## Changes

- SQLite lease/claim/finish/CAS inspection selects only fencing metadata. Checkpoints encode state once, preserve the exact UTF-8 payload budget, and retain FULL synchronous WAL transactions, CAS, fencing and event/outbox idempotence.
- The SQLite checkpoint serializes synchronously before yielding, allowing a shallow root snapshot. Asynchronous stores retain a deep clone. Regression verifies later in-memory mutation does not change the persisted checkpoint or remove later events.
- Dashboard history cache is immutable, limited to 16 entries/4 MiB of serialized data (heap usage can exceed serialized size), and invalidated by relevant committed event kinds, notice transitions and other SQLite connections. Quotes, positions, equity and checkpoints remain fresh. Historical fills/closures cache only consumed projection fields; complete execution evidence remains in the ledger and selected detail plans.
- Live and detail uploads each have one in-flight request. No backlog of old detail snapshots accumulates. Slower detail responses cannot hold the next live upload. The existing Site merge rejects stale monetary state.
- Closed secondary operation plans use compact live projections; full detail evidence remains available. The same observed live sample decreased from 728,453 to 627,337 bytes, with all 30 operations and equity preserved. This is payload reduction, not trading performance.
- AWS notification delivery runs outside market ticks, one request at a time. Results are consumed on the next tick with existing receipts/deduplication; errors remain visible. The worker waits for the current tick and notification before shutdown checkpoint/release, with a bounded timeout; it never releases the lease while those are still running.
- Failed oversized Site backups back off remote compression for 24 hours; hourly local snapshots continue for the separate S3 service. The Site backup error remains explicit and its success timestamp is not fabricated.
- Bounded health instrumentation records checkpoint/tick/publication durations, event-loop p95/max, heap/external memory, queue sizes and cache hit/miss/size. Existing memory/CPU guards remain unchanged; resource-triggered shutdown uses the same ordered drain.

## Whole-flow assessment and remaining limits

| Stage | Assessment |
| --- | --- |
| Public feed / candles | Bounded series/queue, timeout and overflow gap handling exist. No coalescing of trades or quotes: deleting events could change fills, stops or MFE. Track overflow and age under higher traffic. |
| Regime / strategies | Closed-bar independent clocks and deterministic guards retained. No risk/filter relaxation as a performance shortcut. |
| PAPER execution | Existing latency, observed liquidity, fees/funding and independent positions retained. Queue/cycle telemetry now exposes processing pressure. |
| Durable checkpoint | Atomic and restart-safe contracts retained. Full state still rewrites periodically: write amplification remains a candidate for a separately migrated journal/checkpoint architecture. |
| Learning | Training remains outside worker; bounded runtime collections remain. Large historical research exports should remain offline; row-count bounds alone do not prove a safe byte budget. |
| Notifications | Durable outbox retained; network waits isolated. Ambiguous deliveries stay UNKNOWN and are not blindly resent. |
| Panels | Separate bounded uploads; private routes unchanged. Both views poll with busy guards and visibility/backoff handling. Full UI detail is still relatively large; lazy per-operation retrieval is a future compatibility change. |
| Backup / disk | Verified encrypted off-instance stream exists. Local rotating copies and old deployment snapshots consume space. No automatic deletion introduced. A bounded retention policy with restore evidence is still needed as history grows. |

## Validation and real-account boundary

Regressions include fencing, atomic rollback, idempotent retry, UTF-8 size rejection, synchronous checkpoint isolation, cache invalidation, external writes, slow Telegram/detail requests, backup retries, ten-slot display budgets, execution and financial contracts. Complete suite results and actual deployment/after-measurements are saved separately; this document does not claim deployment by itself.

This optimization does not establish real-money readiness. Required separate evidence includes sustained stress/soak testing, broker sandbox reconciliation of accepted/partial/rejected/cancelled orders, exact account-specific margin/liquidation and fees, disconnect recovery, kill-switch validation, disaster recovery RPO/RTO and out-of-sample net expectancy. No real orders are enabled.

Reference: Node.js v24.22.1 Performance measurement APIs, https://nodejs.org/download/release/v24.22.1/docs/api/perf_hooks.html (event-loop utilization differs from CPU; monitorEventLoopDelay reports nanoseconds). Runtime counters and timings are measured evidence; future recommendations are engineering judgments, not profit claims.
