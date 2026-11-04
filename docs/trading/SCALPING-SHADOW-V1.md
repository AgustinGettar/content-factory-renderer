# Lumi Trading — continuación scalping SHADOW v1

## Scope and isolation
Research-only prototype on the **existing** secondary `FREQUENT_PAPER` engine, `PF_XBTUSD`, 5m entries with 15m trend confirmation. No new exchange provider, no order-capable API, no new account, no changes to the primary, audiovisual, execution contract, leverage, capital allocation, original stop/TP, trailing or neural network. It depends on the draft market-regime observation PR #5, and compares future evidence against the independently drafted performance-review PR #6.

The module has **no order or plan return path**, always reports `authority:'NONE'`, `realTrading:false`, `execution_eligible:false`, `submitted_orders:0`, and `capital_reserved_usd:0`. This observer **never calls** `broker.choose` or `broker.market`.

## Algorithm (hypotheses, not optimized)
- Only after a naturally completed 5m evaluation: closed `PF_XBTUSD` 5m bars, current 5m regime and matching causal 15m regime; no history replay or future OHLC values.
- Require fresh official futures BBO, an observed funding-rate estimate, and 5m/15m **aligned trend** (`UPTREND` or `DOWNTREND`). `BREAKOUT_EXPANSION`, `RANGE`, `UNKNOWN` or ambiguous regime do not pass in this version; breakout/retest must be evaluated as another separately validated strategy.
- Previous bar touches the 5m EMA9 region; last CLOSED bar recovers EMA9 in trend direction. Last-bar relative volume must be at least 0.8.
- Refuse wide spread (>8 bps), quote displaced >0.75 ATR from last close, or structural stop distance outside 0.35–2.5 ATR.
- Hypothetical entry at ask (LONG) or bid (SHORT) plus adverse slippage. Stop beyond two-bar structure plus 0.2 ATR; target 1.8x structural stop distance, capped at 2.5 ATR.
- Experimental **fixed nominal of 300 USD for comparison only**; no funds are actually allocated. Use the existing secondary protocol's fee and slippage assumptions as taker/taker, count observed BBO spread and conservative absolute funding allowance. Minimum hypothetical net gain = 0.2% of nominal (0.60 USD); minimum net R:R = 1.2. A result passing this screen remains *hypothetical*, not statistically profitable and not guaranteed executable.
- If any prerequisite fails, emit bounded `WAIT` with explicit reason, never an invented signal.

## Wiring
A 5m evaluation appends `SECONDARY_SCALPING_SHADOW_OBSERVATION` to the **existing** paper ledger diagnostics and saves the latest compact observation in the existing frame's state. `secondary_activity.frames[5].scalping_shadow` exposes it additively to the private monitor; the frontend need not change. Other timeframe frames and all actual decisions are untouched. The observer is isolated inside `try/catch`: failure is `RESEARCH_OBSERVER_ERROR`, not a blocker to the signed decision flow.

This is proposed in a draft PR only, **not deployed**. The running AWS worker is unchanged until signed regression and deployment verification. Even if deployed, it does not produce a forecast of profit or execute a hypothetical position.

## Repeatable smoke checks

```sh
node --test --test-concurrency=1 test/secondary-scalping-shadow.test.js test/secondary-market-regime.test.js test/secondary-independent-timeframes.test.js
node scripts/trading-scalping-shadow-probe.mjs
node scripts/trading-excursion-review.mjs
```

The one-shot public probe fetches **Kraken Futures**, not spot, 5m and 15m `trade` candles and public funding, plus the latest quote from the local SQLite store opened strictly read-only. The candle `time` field was verified in a live sample as a candle-end boundary; the current unfinished candle is excluded at the cutoff. The probe does not write outputs to AWS beyond its standard console stream.

The excursion review reads `CLOSED` operations with explicit `FREQUENT_PAPER`/ `realTrading:false`, excludes manual outcomes from autonomous data and separates complete `OBSERVED` MFE/MAE from `UNRESOLVED_MARKET_GAP`, `FUNDING_GAP` or missing evidence. An MFE observed during a position does NOT mean a limit exit at that price would have filled. A future strategy comparison must model actual bid/ask, order-book capacity, delay, funding and out-of-sample regimes, with no retroactive self-learning.

## Verified first live smoke observation
2026-11-04T00:22:38Z: 230 5m futures trade candles, 230 15m futures trade candles, public funding present. Both regimes were `BREAKOUT_EXPANSION`. The continuation-pullback shadow returned `WAIT / NO_CONFIRMED_5M_TREND`. Exactly zero orders and zero capital reservations. This observation is not a profitability claim.

## Next gate to operational enablement
Before any merge or deployment: verify the current EC2 commit and worker heartbeat, compare complete tests including neural and regressions, confirm monitor payload compatibility and size, inspect SQLite backup status, confirm no exchange trade permissions, then deploy only with a rollback-ready code-only procedure. Merging this draft into the branch does not authorize changing economic policy, increasing leverage or activating 1m futures.
