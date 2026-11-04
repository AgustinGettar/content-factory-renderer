# Lumi Trading PAPER — performance attribution v1 (read-only)

Standalone research instrumentation for the existing secondary SQLite ledger. Does not add a provider, start a worker, amend a position, alter stops or modify the main branch. The running service is untouched.

Run **on an isolated checkout** with Node 24 and dependencies:

```sh
node --test test/secondary-performance-review.test.js
node scripts/trading-paper-performance.mjs /var/lib/lumi-trading/trading.sqlite
```

The CLI opens SQLite using `readOnly: true`, never opens a writer, and reads only durable `CLOSED` event payloads plus an account snapshot. The resulting JSON separates autonomous and manual exits; groups net PnL, fees, version, timeframe, pattern and reason; reports a Wilson 95% interval to discourage claims from tiny samples; and lists unfinalized operations separately. Older historical PAPER records without the explicit `realTrading: false` futures contract are counted as excluded legacy scope, not incorrectly blended into the futures strategy. Partial-close fragments and non-close records are excluded to avoid double-counting. Net numbers in event aggregation are diagnostic; the account ledger remains authoritative, and later funding adjustments or open PnL are not reconciled by this report.

This is *not* a strategy change, not a backtest, and not proof of profitable scalping. Follow-up version should compare rolling out-of-sample regimes, protection MFE/MAE and simulated scalping exits against this baseline before any decision-authorizing change.
