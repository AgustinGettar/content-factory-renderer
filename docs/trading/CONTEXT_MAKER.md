# Context and maker PAPER experiment

`context-maker-1.0.0` is an explicit opt-in secondary experiment, enabled by
`LUMI_TRADING_CONTEXT_PROFILE=context-maker-1.0.0`. It requires the existing agile
entry and secondary growth profiles. Activation waits until the secondary is
flat, archives the previous trial, preserves every ledger and starts a separate
prospective round. Schema 7 prevents older workers from reading the new state.
No exchange order API, deposits, real funds, or change to primary risk is added.

Entry signals remain EMA 9/21 and either a five-bar Donchian breakout or a pullback
with recovery, for long and short directions. Closed history is loaded before
startup; new closes update it. Up to 120 closed bars per relevant frame are used.
Only bars whose close and availability precede the decision are eligible.

| Entry signal | Stop volatility | Target volatility | Maximum holding |
| --- | --- | --- | --- |
| 1 minute | 15 minutes | 1 hour | 12 hours |
| 15 minutes | 1 hour | 4 hours | 48 hours |
| 1 hour | 4 hours | 4 hours | 7 days |
| 4 hours | 4 hours | 4 hours | 7 days |

Stop distance is two ATR 14 and target distance is six ATR 14, with the fixed
frames above. These values are frozen before cost evaluation, not adjusted to
make an individual candidate pass. This is a new hypothesis, not a demonstrated
improvement in returns. Higher-frame volatility is context, not an additional
trend veto. A rising one-minute chart alone remains insufficient for entry.

## Maker simulation

A long limit is proposed at the decision bid (short at ask), tick-rounded. After
simulated placement latency, a fresh quote must leave it passive; crossing
orders cancel. Posting itself cannot fill. The model then requires a later live
WebSocket trade, an opposite-side aggressor, strict trade-through of the limit,
and observed trade volume at least ten times our whole quantity. Both-side BBO
capacity must also be at least ten times the quantity. Price merely touching the
limit, snapshots, stale trades and candle extrema cannot cause observed fills.
Price is the limit with no invented improvement. Observed trade volume and BBO
capacity are shared across pending orders, including repeated events. Actual
queue position and partial fills are not modeled; this remains a conservative
all-or-none approximation, not exchange execution evidence.

Maker entry fee is 0.40%; taker exit fee remains 0.80%. Official lowest-tier spot
rates were checked on 2026-10-30 at https://www.kraken.com/pro/fees . The public
trade channel documents `side` as taker side at
https://docs.kraken.com/exchange/api-reference/spot-websocket-v2/trade . Funding,
spread, exit slippage and margin/liquidation estimates remain included. Old
plans retain their frozen entry and exit rates. Missing observation intervals
remain adverse, explicitly uncertain outcomes excluded from clean learning.

Net estimated target reward / stop loss must remain at least one. Secondary
risk budgets, maximum slots and daily selection limits are unchanged. Leverage
uses the lowest feasible allowed value; it does not create a profitable setup.
Learning updates outcome estimates, never silently alters these entry rules.

## Candle retries and validation

At each close the engine retries only missing due frames, at least one second
apart, up to four reconciliation attempts and within the existing ten-second
decision window. A missing close does not consume the secondary's evaluation;
there is one final evaluation per frame and close, and no retrospective entries
after the window. Restart recovery still skips missed historical signals.

Synthetic tests cover causal multi-frame inputs, fee accounting, long/short
maker fills and rejections, shared trade liquidity, uncertain recovery, profile
isolation, preservation and bounded retries. They are not a profitability
backtest. Activation updater validates the exact isolated PAPER scope, runs
checks before stopping, backs up SQLite, fingerprints preserved state, adds only
the context opt-in, and verifies service, market, persistence, dashboard and the
existing private notification channel after activation.
