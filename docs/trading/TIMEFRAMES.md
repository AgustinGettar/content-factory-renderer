# Four candle timeframes — paper only

The secondary ledger evaluates 1, 15, 60 and 240 minute closed candles in parallel. It uses the same existing USD 100 initial account, retains the current balance, every deposit and every loss, and shares its cash and portfolio limits across all four frames. This is not four new accounts. The primary keeps its existing rules until the whole candidate passes prospective validation.

Two predefined trials use the existing EMA 20/50, ATR 14 and natural stop/target rules: breakout, then pullback. Each trial is a fixed four-frame portfolio. Simultaneous closes are processed from 4h to 1m in a fixed order. At most three slots, USD 1 maximum planned risk per entry, 1% aggregate/daily risk and twelve selected plans per UTC day remain shared. A stop can still lose money. Stops/targets never move further out to force a net reward ratio. One-minute targets may frequently fail the cost filter.

Hold limits are 30 minutes, 12 hours, 48 hours and seven days respectively. Entry plans still expire after two minutes, require fresh executable quotes, and do not borrow or short. Each plan records its timeframe, decision-time candles/indicators, isolated prediction version and outcome. The statistical learning groups are separate by frame; the candidate portfolio is assessed as a whole against the same primary and cash baseline, with at least 25 training and 50 validation observations per frame, 100/200 total, 24-hour purge and 90 common calendar days. Five economic hypotheses cover the three previous registered trials and these two. These are gates, not performance claims.

## Data

Source: https://docs.kraken.com/api/docs/rest-api/get-ohlc-data/ and public Kraken BTC/USD OHLC. The REST final item is always uncommitted and excluded. WebSocket BBO/trades still trigger simulated fills and exits tick by tick. The engine reconciles 1m at each minute, with 15m/1h/4h requests only when those frames close. On restart or recovery it skips already elapsed decisions. Historical bars are warm-up, never emitted as live entries. Failed or late reconciliation and stale prices cannot create a fresh order.

## Migration and delivery

State schema becomes 3 so older workers refuse it. An active legacy secondary position is managed with its frozen original plan; no new legacy entries are opened, and the research round changes only when the ledger is flat. Prior trials/protocols and all learning are archived/preserved, not reinterpreted as evidence for the new rule. Existing account risk halts survive. New activation and per-entry notices use the existing Trading-only Telegram transport/button.

The updater `scripts/trading-aws-timeframes-update.py` accepts the existing dedicated EC2 identity and SQLite/PAPER configuration only, starting from 00ee827d14155c43465c45d30a388bdec54f4084 or the exact target. It checks scope/tests before stopping the writer, creates an integrity-checked SQLite backup as the service user, verifies all logical tables and configuration unchanged before switching code, then observes heartbeat, fresh market, dashboard, encrypted backup and Telegram receipt. No export import, VM creation, plan upgrade, audiovisual changes or secrets input.

The companion `velas.py` CloudShell launcher survives terminal disconnection and reads its saved result on repeated invocation. An installed release waiting for a legacy position is pending activation, not failure or proof of four-frame operation. Do not re-run old migration/import helpers or roll back schema 3 to the old worker.

## Verification

Synthetic tests cover migration with existing exposure/losses, all four closes, minute-only boundaries, shared slots/risk/cash, idempotence, learning separation, no future/open candles, stale feed rejection, cost rejection, per-frame promotion sample gates and restart recovery. These tests are not market-performance evidence.
