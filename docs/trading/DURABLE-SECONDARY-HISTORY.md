# Durable secondary operation history

Version: `secondary-history-page-1.0.0`.

This read-only account projection publishes secondary PAPER operations from the existing worker's `events` table to the existing private monitor. It does not open another SQLite connection, execute an order, alter an account or acknowledge a new trading result. Only publisher metadata is written through the worker's existing `store.db` connection.

## Scope and accounting

The operational archive contains `SELECTED`, `FILLED`, `PARTIAL_FILL`, `PARTIAL_CLOSE`, `CLOSED`, `NOT_FILLED`, `ORDER_REMAINDER_CANCELLED` and `FUNDING_RECONCILED` for `FREQUENT_PAPER`. Technical diagnostics remain in the durable event store and the recent diagnostic view; they cannot push a close out of an archived operation page.

`CLOSED.pnl` is the cumulative operation total, including any earlier partial closes. `fill_pnl` is a fragment, and `PARTIAL_CLOSE` has `amount_scope=EXECUTION_FRAGMENT`. A funding reconciliation is an `ACCOUNTING_ADJUSTMENT` with its own `net_adjustment`. Displaying these records does not sum them again or credit the balance. Decimal amounts remain strings; the historical manual result `0.2460525197` is not rounded or recredited by the archive.

Each record separates `accounted`, `manual` and `training_eligibility`. Manual management retains `EXCLUDED / MANUAL_OR_MANAGEMENT_OVERRIDE`. Unresolved funding is `PENDING / FUNDING_UNRESOLVED`. Other records use `UNKNOWN / DURABLE_NEURAL_LABEL_NOT_INCLUDED_IN_OPERATION_PROJECTION`: the operation archive does not infer a mature training label from a close. It is not the neural training dataset.

Only a minimal plan projection, amounts, quantities, policy versions, compact protection state and boolean evidence-presence flags are sent. Candle arrays, raw quotes, execution/liquidity/funding receipts, neural weights and credentials are excluded. Signed original contracts and original events remain in SQLite.

## Publication and recovery

The publisher captures a SQLite rowid high watermark, then reads the indexed operational kinds in increasing rowid order. A full immutable page contains 40 records and is keyed by its last rowid. Its `previous_cursor` points to the preceding immutable page. The current tip contains at most 40 later records and points to the last immutable page. Records in each response are presented newest first. The decimal rowid cursor is a pagination address, not a trading identity.

At most three full pages and one tip are uploaded per attempt, with a minimum 15 second attempt interval and an 8 second deadline per request. An archive request never blocks the two-second live-price publication. A tip with `backfill_complete=false` means historical incorporation is still in progress; recent snapshot Activity remains available separately.

Pages are capped at 512 KiB. Canonical sorted JSON is SHA-256 hashed. The API verifies the digest and strict schema, then acknowledges the same kind, cursor and digest. The publisher advances its saved cursor only after this exact acknowledgement. A lost response retries identical immutable content. The server checks page immutability, linked cursor continuity and storage etags; a page uploaded before an interrupted head update can repair that head on retry. Tips cannot move backwards. Existing pages are never overwritten with another hash.

The existing private Site boundary protects reading. `PUT /api/aws/history` additionally requires the existing ingest key; there is no browser mutation endpoint. `GET /api/monitor/history?cursor=...` returns:

```json
{
  "version": "secondary-history-page-1.0.0",
  "records": [],
  "previous_cursor": null,
  "backfill_complete": false,
  "generated_at": 0
}
```

No cursor requests the current tip. A returned cursor requests the preceding immutable page. Until the first tip arrives, an empty response explicitly reports `ARCHIVE_PENDING`. The durable publication status appears at `snapshot.secondary_history`, including last successful publication, last complete/published cursor, backfill status and bounded error code. A failure affects history publication, not trading.

No rowid rewind is accepted. Recovery preserves the current database and later operations; restoring an old database to make archival cursors match is prohibited.

## Live versus detail transport

The live body preserves authoritative balances, current quantities and net valuations, signed position levels, protection floors, durable exit requests and exact historical close/fragment amounts. It replaces extensive historical contracts with a compact display projection and removes proof objects. The original full detail snapshot continues at its existing 15 second cadence and retains decision evidence. The archive provides independent pagination beyond the snapshot's finite recent history.

## External checks

Isolated temporary SQLite tests cover bounded catch-up, restart from metadata, uncertain upload retry with the same digest, exact manual amounts and exclusions, fragment separation, rejected acknowledgement, cursor rewind and untouched account balances. In-memory API storage tests cover authentication, read-only/cross-site boundaries, unsafe cursors, immutable pages, descending pagination, malformed/future/non-PAPER data, payload limits, backwards tips and interrupted head repair. A local publisher-to-API roundtrip verified one 40-record page plus a seven-record tip. These are functional tests, not live activity or evidence of strategy performance.
