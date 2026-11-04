# Quantitative PAPER provenance, Fibonacci and panel navigation

The full and compact monitors now offer Simple / Completo navigation, preserving Overview / Operations / Activity via fragments. Both use the existing private API. Primary and older contracts remain in explicitly labelled history/management views; no financial state is moved or reclassified.

The quant contract was missing from `planView`, so consumers could not reliably distinguish new-engine operations. The projection now retains provenance in full and live payloads, together with compact Fibonacci evidence. Live evaluations retain quantitative version and Fibonacci diagnostics. The full default overview uses secondary equity, prices, positions, evaluations and strategies.

Telegram renders concise messages for quantitative plans: actual state, direction, timeframe, leverage, strategy, entry, SL/TP, estimated loss/net target or realized net, reason and identifier. Partial fills show actual quantities. Finality is explicit. Both private views have buttons. While quant is active, legacy SIGNAL/RESULT notices are durably rejected with `SUPERSEDED_BY_QUANT_ENGINE`; ledger operations are unaffected. Quant selected signals older than 30 seconds or no longer pending expire before transmission. Transport identity, private recipient checks and idempotency remain.

## Fibonacci protocol 1.0.0

- Confirmed pivot uses two completed bars on each side, strictly extremal prices, maximum 80-bar history and endpoint age 24 bars.
- Minimum impulse is 2 ATR. Opposite anchors must be temporally ordered. Invalidation of the origin invalidates the construction.
- Retracements: 23.6%, 38.2%, 50% (conventional, not Fibonacci), 61.8%, 78.6%. Continuation rejection requires a candle crossing the level, closing back in the trade direction, a directional body and improvement over the preceding close. Tolerance is 0.15 ATR.
- Targets: prior impulse endpoint (100%), 127.2% and 161.8%. A level ahead of the entry can only shorten an existing target. A target is never extended to make an entry economical. Tick rounding and all net-cost, margin and aggregate-risk checks run afterwards.
- No entry is created by Fibonacci alone. No forced quota, higher leverage, risk increase, stop widening, new funds or real orders.
- Each new quant plan freezes its anchors, levels, original/applied target, policy version and integrity hash. Old signed positions keep their existing terms. Training domains and recorded results distinguish the Fibonacci policy.
- Missing/invalid swings are explicit UNAVAILABLE context; deterministic pattern evaluation continues.

## Evidence and limits

Causal long/short symmetry, future-bar exclusion, pivot confirmation delay, invalidation, target monotonicity, integrity, provenance, compact messages, expired/legacy notice routing and panel navigation have regression coverage. Public candle research uses protocol 1.3.0, explicitly including the Fibonacci policy hash; it retains cost, funding and intrabar-execution assumptions. It is not an execution replay, calibrated prediction or demonstration of profitability. No learned model is promoted.

Sources consulted:
- https://www.cmegroup.com/education/courses/technical-analysis/fibonacci-retracements-and-extensions
- https://support.kraken.com/articles/how-to-use-drawing-tools

Deployment uses the existing exact-commit PAPER updater after external tests and CI. No tests, training or backtests execute on EC2. Existing private Site access must remain 403 without authorization and accessible with the owner session.
