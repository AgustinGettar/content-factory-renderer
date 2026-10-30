# Automatic margin — PAPER only

The secondary laboratory now registers two fixed long/short four-timeframe trials (breakout, then pullback). One ledger still funds 1m, 15m, 1h and 4h. All historical balances, deposits, positions, results and prediction groups survive. The principal receives the exact new recipe only after the existing prospective economic gates; it never receives simulated profits or confidence from another ledger. Nothing enables real exchange orders, deposits or a wallet.

## Diagnosis, 30 October 2026, 20:32 UTC

Authenticated read-only monitor: engine and current Kraken quotes/trades were healthy. The four-frame trial had started at 20:22:49 UTC. At the reading, 1m had a trend without the required breakout; 15m had no complete pattern. The next new 1h/4h closes had not occurred. The secondary retained four prior closed operations, net −0.7388537238538496 USD and equity 99.2611462761461504 USD; the primary had 100 USD and zero closures. Those historical results are not outcomes from the newly enabled four-frame trial.

The previous laboratory tested LONG only even when the market was bearish. The new recipe also requires closed-bar bearish EMA20/50 context and a lower-channel breakout or bearish pullback for SHORT. It retains natural ATR stop/target distances and rejects insufficient net reward instead of extending targets. The monitor now records per-frame decisions, evaluated numeric thresholds, review/selection counts and precise rejection reasons. A cost field is untested when no pattern exists, not a failed cost calculation.

## Frozen execution assumptions

- Select the **lowest feasible leverage** in 1×, 2×, 3×. LONG can be spot cash at 1×; SHORT requires the public pair's supported borrowing leverage. No larger leverage, even if metadata permits it.
- Size by planned loss including round-trip fees, spread, slippage, opening and maximum holding financing. Cap planned entry risk at USD1 and the existing equity/daily/shared limits. Leverage never multiplies the risk budget. Gap losses can exceed it.
- Shared maximum three open/pending slots and twelve selected plans per UTC date. Gross notional exposure at most 1.5× equity. Financed collateral allocation at most 50% equity. Cash safety buffer 10%. All pending collateral and open funding allowances remain reserved across slots.
- Entry: causal stop-limit, two-minute expiry, post-placement trade and BBO, conservative all-or-none quantity ≤10% both displayed sides. Buy at ask plus slippage, sell at bid minus slippage. Recheck actual collateral against the frozen reservation. Exit shorts at ask and longs at bid, with slippage.
- Kraken spot taker assumption is 0.80% per side, confirmed from the official schedule on 2026-10-30. This alone is about 1.6% round-trip, so a minute-scale target commonly fails. There is no assumption of maker fills or futures fees.
- Conservative financing assumption: USD-funded LONG 0.05% opening and per four hours; BTC-funded SHORT 0.02%. Size using ceil(maximum holding / four hours); accrue complete periods while open. For SHORT, BTC cost is conservatively converted using max(entry,current/exit price), not reconstructed interval-specific execution prices. Freeze rates per plan; actual Kraken rates may differ.
- **This is a separate-collateral model, not Kraken's actual cross-account liquidation engine.** Close at an early model boundary of 80% allocated margin after entry costs and accrued funding, using observable adverse BBO. Reject plans whose stop reaches that estimate after maximum funding. Charge the published 2% liquidation fee instead of ordinary exit trading fees on a model liquidation. Record funding, collateral, notional and estimated liquidation separately. Long 1× cash positions have no liquidation boundary or financing charge.
- No future prices create entries. Gaps use a labelled adverse feasible path; shorts use adverse highs. Gap closures are excluded from training. Worst-case model loss is retained even if it exceeds collateral; balances are never silently reset.

Official references (reviewed 2026-10-30):
https://www.kraken.com/features/fee-schedule
https://docs.kraken.com/api-reference/market-data/get-tradable-asset-pairs
https://support.kraken.com/articles/206161568-what-are-the-fees-opening-and-rollover-for-trading-using-margin-
https://support.kraken.com/articles/203325763-margin-call-level-and-margin-liquidation-level

## Learning and migration

Schema 4 prevents older workers from reverting the new execution state. New margin trials wait until the secondary is flat, archive the prior registered round and start separate version/timeframe groups. Direction-aware causal features use version2. Seven registered economic hypotheses cover the three original, two prior four-frame and two margin candidates. Per-frame 25 training /50 future validation observations and overall100/200, 24-hour purge,90 common days, stressed costs, drawdown limits and multiple-testing adjustment still apply. These gates are not a claim of profitability. No probability is published before its independent prediction validation.

Use scripts/trading-aws-margin-update.py through margen.py for the existing dedicated VM only. Supported source is7efb855514d59e9ff7218ca713a13841ca6972fe or the exact target. The updater validates scope, dependency equality, runtime and tests before stopping the service, creates and checks a SQLite snapshot, verifies state/configuration preservation, then switches releases. Completion requires schema4 marginACTIVE, fourTFactive,65 seconds stable process, current market/heartbeat, panel, encrypted backup and a delivered MARGIN_ENABLED Telegram receipt. Repeating the helper reads its detached saved result. An existing position may postpone activation. Do not use an older worker after schema4 is stored.

Validation:141 Trading tests and89 AWS Python checks passed locally, including synthetic leverage1/2/3 selection, unsupported borrowing, long/short accounting, funding, liquidation, gaps, shared reservations, migration, causal bars and promotion isolation. Tests establish behavior, not predictive performance. AWS activation is not certified by these local checks.
