# Continuous PAPER operation

The user requested removal of the twelve selected-plan limit per UTC day.
The previous counter included cancelled and unfilled entry plans, as well as
plans that became positions. The worker already runs continuously; this change
removes the calendar quota from the legacy minute experiment, the current
secondary laboratory and the primary's promoted multi-frame recipes.

Daily selection counts remain visible and reset at the UTC date boundary. They
are statistics, never an instruction to place an order or a reason to block a
valid thirteenth entry. Candle deduplication, evaluation windows, existing
cooldowns, research pauses, prospective validation and market freshness checks
are unchanged. So are cash, fees, leverage, risk and simultaneous position
limits. The current secondary capacity remains ten open or pending entries;
the primary retains its own capacity and risk settings. All execution is PAPER.

## Durable migration

`FREQUENCY_PROTOCOL.maxSelectionsPerUTCDate` is now `null`. The exact previous
contract remains available as `LEGACY_FREQUENCY_PROTOCOL` for validation.
`initializeFrequency` requires both the stored hash and the actual protocol to
match one of these known contracts. It refuses unknown, corrupt or mismatched
contracts before changing state.

For an exact legacy contract it appends the old protocol, its hash, the time and
reason `DAILY_SELECTION_LIMIT_REMOVED` to `frequency.protocol_history`, then
stores the new protocol and hash. The engine commits the corresponding
`DAILY_SELECTION_LIMIT_REMOVED` event with before `12`, after `null`, and scope
`FREQUENT_PAPER`, `LABORATORY`, `ENGINE`. It sends no migration notification.
Repeated initialization or restart does not append another archive or event.

The migration preserves strategy versions, the current research trial,
training and validation evidence, balances, deposits, open and pending frozen
contracts, results and daily counters. There is no new trading hypothesis,
capital contribution or balance reset. Existing events retain their historical
meaning. Analysis across this date should account for the removal of the entry
quota; the recorded migration time identifies that policy change.

No new state schema is required. An older release refuses the new protocol hash
instead of silently reapplying the quota. After a committed migration, recover
with the current compatible release; do not downgrade the worker to legacy
code or rewrite the ledger to satisfy its old hash check.

## Operational evidence

The monitor exposes `frequency.operation_mode=CONTINUOUS_PAPER` and
`frequency.daily_selection_limit=null` only for an exact, persisted new
protocol. A legacy checkpoint remains `DAILY_CAPPED_PAPER` with limit `12`;
an unrecognized contract reports `UNKNOWN`. This describes the configured
entry quota. A recent heartbeat and market sample are still required to claim
that the worker is currently evaluating market data.

Offline regression checks cover migration with an open position and pending
order, exact state preservation, corruption refusal, restart idempotence, no
extra migration notice, a real selected thirteenth plan in each of the three
execution routes, retained daily statistics, and preserved risk, freshness and
simultaneous-capacity gates. These checks establish software behavior, not
profitability or a minimum number of trades.
