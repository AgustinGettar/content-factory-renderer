# Frequent dashboard updates

The owner-private monitor now receives a compact authoritative state every two
seconds at `/api/aws/live`, read through `/api/monitor/live`. Financial values,
current plans, positions, net-exit estimates, statuses and receipts come from the
same persisted worker projection and current observed quotes as before. Trading
rules, state schema, capital and execution behavior are unchanged.

The compact JSON omits immutable chart evidence and marks its availability.
Full chart evidence remains in `/api/aws/snapshot`, published every 15 seconds
or as soon as operation identity/status changes. Both streams retain separate
revision/time checks and conditional writes. Live reads fall back to the old
snapshot only while the live channel has not yet been initialized.

The browser polls compact state every two seconds and detail every 15 seconds.
It can merge matching immutable plan evidence from a late full response, but
never regress prices, balance, position status or receipt state. Each channel
has an in-flight guard; hidden tabs pause and visible/online tabs refresh.
Failed live requests back off up to 30 seconds. The interface reports the actual
worker sample age, not only the time it last downloaded a response. Estimates
older than ten seconds do not enable voluntary close controls.

Backups run independently of state publications and cannot start twice. Errors
and success times remain in private local metadata. Market WebSocket drawing
continues at its existing 500 ms cadence. Two-second polling is not a latency
guarantee: persistence, network delivery and rendering add time; no prices,
profits or fills are interpolated to create apparent activity.

Deployment preflights the new authenticated Site capability before stopping the
isolated worker, backs up SQLite, preserves configuration and history, and
checks stable process, live publication interval and payload size. Software
checks cover out-of-order responses, unchanged-plan evidence, isolated storage,
writer authorization, overlapping requests and backup concurrency.
