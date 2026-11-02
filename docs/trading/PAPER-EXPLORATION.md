# Secondary PAPER exploration recovery

This change operates the existing `FREQUENT_PAPER` account of the existing
`secondary-futures-1.0.0` broker. It does not add a ledger, a bot, a real exchange
adapter, infrastructure, or an audiovisual production route.

## Versioned activation and reversal

The historical execution protocol and its hash remain unchanged. The additive
profile is `secondary-paper-exploration-1.0.0`; new signals use entry revision
`secondary-entry-exploration-1.0.0` and execution contract
`secondary-exploration-execution-1.0.0`.

Configuration on the existing PAPER/staging/SQLite worker:

```
LUMI_TRADING_SECONDARY_EXECUTION=secondary-futures-1.0.0
LUMI_TRADING_SECONDARY_PROFILE=secondary-paper-exploration-1.0.0
LUMI_TRADING_SECONDARY_NOMINAL_USD=100
```

The profile is persisted under `secondaryExecution.exploration`, with a policy
hash, activation baseline, and explicit policy history. Activation is idempotent.
It does not reset balances, net losses, fees, peaks, closed trades, legacy
protocols, rejected trials or primary-account settings. Explicit configuration
changes produce a new policy hash/history entry; they never rewrite a selected
order's contract.

Set `LUMI_TRADING_SECONDARY_PROFILE=OFF` **on this compatible release** to reverse
new-signal selection to the conservative profile. Outstanding exploration orders
and positions still settle under their own frozen execution contracts. Do not
roll back to `247250e` or another older broker after the migration, and do not
restore a stale database over subsequent operations. The deployment helper
supports this configuration reversal using the same exact commit.

## Effective policy

Only the experimental secondary bypasses financial selection vetoes: daily loss,
drawdown, loss streak/cooldown, historical trial rejection, daily counts,
position/pattern/direction counts, opposing exposure, per-trade/aggregate risk,
cash-reserve/exposure ceilings, capital shortage, and training/promotion gates.
Primary-account rules and balances remain independent.

Quantity is the configured nominal USD divided by the decision-time estimated
entry price, rounded **down** to the instrument's quantity increment. The default
is 100 USD per signal and fixed 2x simulated leverage. Actual execution exposure
can differ with the subsequently observed price. Losses and deposits never
increase the nominal size or leverage.

`BREAKOUT`, `PULLBACK` and `RANGE_REENTRY` retain their causal pattern definitions.
Both 5-minute and 15-minute candles must be closed and synchronized; each pattern
records its actual evaluation time, input hash, context and reason. PULLBACK
already confirms a completed recovery, so all three initially use taker IOC.
RR and cost coverage are quality labels in this profile, not universal vetoes.
`COSTS_NOT_COVERED` and `ESTIMATED_COSTS_EXCEED_TARGET` explicitly identify an
unfavorable estimated net target. Structural stop/target prices are not extended
to manufacture acceptable economics.

## Causal execution and liquidity

- Public `PF_XBTUSD` futures quotes and trades only. Spot quotes cannot value or
  fill these positions. The instrument metadata checks contract type, currencies,
  lot increment and price increment.
- Taker entries wait 1,000 ms after decision. Both exchange and receipt timestamps
  of the executable quote must be after that boundary. A future timestamp within
  allowed clock skew does not make an earlier-received quote executable.
- Use ask for buys and bid for sells, with 2 basis points of adverse modeled
  slippage. The modeled participation is 10% of displayed best-side quantity.
  No deeper book liquidity is assumed. The same quote capacity is shared across
  entries and exits and its consumption survives checkpoints/restarts.
- An IOC attempts the first executable quote within its 30-second validity.
  It fills a lot-rounded partial quantity if necessary and cancels the remainder;
  zero liquidity produces an explicit no-fill event, not a loss or a fake fill.
  A `post_only` market cannot execute a taker simulation.
- New maker mode remains an explicit option per pattern through
  `LUMI_TRADING_SECONDARY_<PATTERN>_EXECUTION=MAKER_LIMIT`. Its validity is three
  5-minute candles (900 seconds). Only subsequent, correctly sided `fill` or
  `liquidation` trades strictly through the limit can supply volume. Ten percent
  of eligible trade volume can accumulate toward lot-sized partial fills. Each
  trade's allocation is persisted and cannot fund several orders twice.
- Existing maker orders keep the original 120-second, single-trade 20x contract.
  No expired signal is revived or converted retrospectively to taker.
- New stop, structural target and timeout exits create a durable intent with a
  further 1,000 ms latency. Execution uses a subsequent fresh observed quote and
  available capacity, including partial closures. The eventual execution price
  can be worse than the trigger price. Conditional manual-profit/net-goal exits
  cannot obstruct an observed stop or a timeout after their condition ceases to
  hold. Funding uncertainty prevents a claim of verified positive net profit.

Taker commission is 0.05% per side; optional maker commission is 0.02%. Fees and
signed funding are recorded. Spread and slippage are reflected in actual modeled
entry/exit prices and therefore net P&L; they must not be subtracted twice.
These are reproducible paper-model parameters, not a claim about a real account's
fee tier, queue position, or execution guarantee.

Kraken's public schema documents best bid/ask quantities, timestamps and omitted
zero funding fields in the [ticker feed](https://docs-legacy.kraken.com/api/docs/futures-api/websocket/ticker/)
and unique IDs, taker side, trade type and quantity in the
[trade feed](https://docs-legacy.kraken.com/api/docs/futures-api/websocket/trade/).

## Accounting, contributions and gaps

A valid selected order receives only the fictitious capital deficit needed for
its reservation; a subsequently observed fill can cover a price-induced deficit.
`PAPER_CAPITAL_TOPUP` stores stable idempotency key, order, amount, time, reason,
portfolio, before/after cash and cumulative contributions. State, event and
outbox are committed atomically through the existing fenced SQLite store. No
recarga is emitted for an ordinary evaluation without an operable order.

The monitor reports contributed capital, current cash/equity, realized net,
unrealized net, recorded costs and exploration topups separately. Deposits do not
enter net profit. Historical uncertain outcomes remain in account totals, with
their uncertainty disclosed and excluded from clean pattern validation.

A restart or missing market interval preserves outstanding contracts and records
uncertainty. It does not prove a stop and cannot create a fictitious exit price.
Only subsequent observed evidence can execute a new exit. When the historical
price path cannot be reconstructed, that uncertainty remains attached to the
position/result even after live evaluation resumes.

Missing funding is kept as an unresolved interval, never a made-up rate. It can
be reconciled later against retrieved public funding history, including after a
partial/final close, exactly once. Until then result finality is false and the
monitor exposes the recorded provisional value without labeling it final.

Each operation retains rules, pattern/context, input hash and candles, decision
and signal times, planned/actual prices, execution contract/evidence, fees,
funding, cancellation/close reason, net result, favorable/adverse excursion and
data quality. Aggregates distinguish signals, selected orders, fills, partials,
expiries, cancellations, costs and results by pattern and entry revision.
Accumulation is evidence collection, not automatic code editing or proven ML.

## Monitor, notifications and deployment

The existing publisher sends live/detail views from one committed revision. The
secondary activity view distinguishes lease/checkpoint health, usable quotes,
decision inputs, actual per-pattern evaluation, pending orders, open positions,
exit intents and explicit blockers. Entry cards are 5m with 15m context; the
primary and old 1m/1h/4h secondary history remain identifiable.

Telegram uses the existing verified private recipient, original transport and
claimed outbox. It distinguishes selection, partial/full execution, unfilled
expiry/cancellation, partial/final closure and fictitious topups. Unknown delivery
is not blindly resent.

`scripts/trading-aws-exploration-update.py` accepts exact target/current SHAs,
checks the authorized PAPER instance/branch, restricts changed paths, reuses
installed dependencies and tests pure migration on an in-memory copy. It then
stops the sole worker, takes a consistent checked SQLite backup, rechecks the
quiescent state, changes only explicit profile settings, atomically switches the
release and verifies a newer persisted checkpoint with the requested profile.
No suite, installation, backtest or optimization runs on the active instance.

Local regression coverage includes all three patterns through honest isolated
execution/closure, no-signal behavior, losses/rejected-trial continuity, old/new
contracts, liquidity consumption, partial fills/closures, expiry, clock skew,
funding gaps/reconciliation, exit intent latency/restarts, primary isolation,
SQLite atomicity/lease exclusivity, monitor revision consistency, outbox
idempotency and rejection of real trading mode.
