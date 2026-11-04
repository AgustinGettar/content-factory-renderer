# Contextual pullback and entry diagnosis — 2026-11-04

Scope: the existing secondary PAPER account only. No private exchange orders,
new capital, principal policy changes, risk relaxation or neural authority.

## Observed cause

The worker was active, consuming closed candles with fresh futures quotes, and
had no daily-loss/drawdown block. At the first diagnostic it had no open orders
or positions and equity USD 988.98209. The opportunity protocol had evaluated
174 timeframe closes without an economic candidate. Multiple strategy checks
per candle must not be reported as separate missed trades. Unsupported pattern
timeframes are intentional exclusions, not operational failures.

One detected 1m short continuation had entry 79,881, stop 80,047 and target
79,906: price had already crossed the target. The engine correctly rejected it,
but reported a generic structural error and misleadingly labeled immediate
economics valid despite negative net RR. Specific target-passed, stop-invalid
and stop-too-wide reasons now distinguish these cases. The immediate economics
label now requires positive net gain/loss, RR >= 1 and the signed minimum net
target fraction. The existing downstream pre-execution checks remain required.

Before this change was deployed, the existing engine selected a 5m short
BREAKOUT_RETEST on 2026-11-04 at 20:00:03 UTC and opened 0.0066 BTC at
79,943.0082. Selection estimated USD 1.874 net at target against USD 1.699 risk.
These are forecasts, not realized profit. This is evidence that admission works.

## Additive experiment

`secondary-context-pullback-1.0.0` is enabled only by its explicit PAPER/staging/
SQLite flag, with quant and opportunities already active. Its policy and plans
have independent hashes; the nine-strategy baseline policy is unchanged.

Entry/context pairs: 1m/5m, 5m/15m and 15m/1h. The higher closed timeframe must
confirm trend using EMA ordering, normalized slope, ADX and DMI. The entry
timeframe must touch EMA9 and reclaim it and the prior candle extreme with a
directional body >= 25% of range and relative volume >= 0.5. Strong opposite
local trend, a chase beyond 1 ATR, missing data or excessive spread reject entry.

Stop: the last three entry-frame bars plus 0.15 ATR. Target: the nearest known
unbroken Donchian extreme or confirmed swing on either timeframe. A closer local
obstacle cannot be ignored to obtain a more attractive target. Existing Fibonacci
rules may only shorten it. Signed provenance records the exact level/timeframe.

Execution uses the existing taker model with post-latency fee, spread, slippage,
funding, net RR, lot, margin and observed liquidity revalidation. This experiment
does not add a maker fill assumption. Existing position/risk allocation,
independent clocks, exits and profit protection apply unchanged. The shared
portfolio may still reject an otherwise valid candidate. No probability is claimed.

The monitor receives translated rejection explanations, the new strategy and a
per-close funnel: enabled patterns, confirmed patterns, plans before allocation,
selected orders. Selected orders are not reported as fills. Unsupported strategy
timeframes do not increase the enabled-pattern denominator. Counters are bounded.
Telegram uses the existing compact quant message and the new plan's title.

## Fixed-rule causal feasibility check

Public PF_XBTUSD trade candles; seven days ending 2026-11-04 12:00 UTC.
12,771 timeframe evaluations. Five days and the final two days are reported
separately without parameter changes after observing either period.

| Entry timeframe | Detected patterns | Additional economic candidates | Final two days |
|---|---:|---:|---:|
| 1m | 228 | 2 | 1 |
| 5m | 61 | 0 | 0 |
| 15m | 16 | 0 | 0 |

Both viable candidates occurred on candles without another viable baseline
candidate. Baseline strategies produced 63 candidates in these same three
timeframes. The improvement in availability is small, not evidence of higher
returns. Do not retune thresholds to inflate these counts.

There is no historical BBO/queue data. The replay assumes a 1 bp spread and
adverse 0.3 bp/hour funding, applies the existing execution costs and records
candidate feasibility only. It does not simulate fills, independent trades,
dynamic-exit returns or aggregate portfolio performance. Profitability remains
unproven; prospective PAPER results are required before any promotion.

Reproduce outside the worker:

```
node scripts/trading-quant-context-research.mjs --data PATH_TO_PUBLIC_CANDLES --output REPORT.json
node --test test/secondary-quant.test.js
```

Regression coverage includes long/short symmetry, nearer obstacles, stale/future
context, signed contract tampering, plan/position restoration, actual PAPER fill,
unchanged baseline decisions, independent clocks and the selection funnel.

## References

- https://www.kraken.com/pro/fees — the modeled initial futures tier is 0.02%
  maker and 0.05% taker; execution uses the existing signed fee contract.
- https://docs.freqtrade.io/en/stable/strategy-customization/ — informative
  timeframe alignment and closed-data strategy construction.
- https://www.freqtrade.io/en/stable/lookahead-analysis/ — causal validation.

Deployment is evidenced by the external deployment receipt and fresh live state,
not by this source document. Rollback disables new quant admission on the same
compatible parser; it does not restore an old ledger or change existing plans.
