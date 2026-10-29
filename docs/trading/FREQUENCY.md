# Independent frequent-entry paper experiment

User request: compare the original selective strategy with a separate USD100
paper account that accepts more opportunities. No actual exchange orders,
additional cloud instance, Mini App edits or transfer of original balances.

`lumi-frequency-1.0.0` is initialized once under `state.frequency`; initialization,
protocol hash, original-account snapshot and Telegram activation notice share
the existing atomic state/outbox commit. Restarts preserve both accounts. A
changed experiment protocol requires a new reviewed version; no silent tuning.

## Predeclared rules

- Independent initial cash USD100. Same Kraken BTC/USD spot live BBO/trades,
  metadata, spread/freshness checks, conservative fills and recovery model.
- Evaluate the last closed one-minute candle once, 1.5–10 seconds after close.
  Require at least 60 continuous closed bars; EMA9 > EMA21, positive candle,
  close above EMA9 and not below the preceding close. No original H4/volume
  filters. Historical bars warm indicators only; trades start prospectively.
- Buy trigger one tick above both the closed candle high and current ask.
  Stop-limit cap +0.05%, one-second placement latency, two-minute expiry.
- Stop distance max(0.2% of entry, 1.5×ATR14). Target solves for NET gain at least
  max(0.15% of entry notional, 0.1×modeled loss), including costs. This does NOT
  mean a 0.15% gross price rise is profitable. At the frozen 0.8% taker fee per
  side, a target generally needs roughly 1.8% or more gross price appreciation.
- Both entry/exit taker fee 0.8%, spread observed and 2bps slippage unchanged
  from the baseline. Source: https://www.kraken.com/features/fee-schedule,
  checked 2026-10-29. No fabricated maker fills, rebates or volume-tier upgrades.
- Risk budget 0.25% of current equity (initially USD0.25); reserve 10%; one
  pending/open position; reject exchange minimum/liquidity failures. No loans,
  short selling or increases in risk to manufacture a trade.
- Maximum 12 selected plans per UTC date, 60-second cooldown after a close or
  unfilled cancellation; exit after 30 minutes from fill if no barrier reached.
  One-percent daily loss budget and 5% drawdown pause. Budgets are modeled
  entry constraints, not guarantees against larger gap losses.

Lower filters/required net reward-to-risk are experimental. Neither a lower nor
higher win probability is known. Frequent small wins may be outweighed by losses.
Do not promise a minimum trade count, net profit or income.

## Evaluation and delivery

Counts, recent decisions, fills, expiries, net P&L, all charged fees, closed-trade
gross P&L/fees, uncertainty and drawdown are durable and independent. Closed
gross minus closed fees equals net; an open entry fee is excluded from closed
fees. Missing-data outcomes remain labeled and counted. Telegram signals/results
identify FREQUENT_PAPER; they never feed the original ALERT_PLUS_60S account.

The private dashboard compares recorded net results from the common experiment
start, while preserving the full original history. If the active base version
changes, the comparison retains its starting version and labels the difference.
No success probability is published or experiment promoted based on a few wins.
The experiment is fixed; any later proposed improvement must retain prior
results and be evaluated prospectively under a new version.

## Existing AWS instance update

`scripts/trading-aws-frequency-update.py` is passed the exact reviewed commit by
the authenticated CloudShell helper. It requires the existing 4aad0cd release
or the target, verifies origin and changed-file scope, reuses identical locked
dependencies, runs offline account tests, and does read-only runtime/state
preflight. It stops only lumi-trading.service, atomically switches release and
verifies the committed frequency account plus active service/recent heartbeat.
Known uncommitted failure restores the old release. After an ambiguous or
committed checkpoint it retains the new release to avoid freezing the new
account under old code. It never recreates the VM or modifies its identity tags.

Publishing this source or dashboard does not activate the AWS account. Report
activation only after the helper/checkpoint, fresh minute evaluation, Telegram
receipt and original-account preservation have been inspected.
