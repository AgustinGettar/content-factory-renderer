# Multi-pattern PAPER research

This additive, opt-in comparison runs in the existing worker and SQLite state (`multiStrategy`). It does not restart the rejected legacy trial, rewrite previous outcomes, transfer money, modify the primary account, or submit any exchange order. The existing secondary balance is copied as a reference into three **independent virtual mirrors**. The mirrors must never be added together or presented as deposits or as the actual secondary account.

Activation: `LUMI_TRADING_MULTI_PATTERN=multi-pattern-paper-1.0.0`, only with staging, PAPER and SQLITE. Absence of the flag leaves it off. The existing private snapshot includes the additive `multi_strategy` payload; legacy balances and operations remain unchanged. No additional Telegram alerts are sent by this comparison.

## Hypotheses and execution

Closed five-minute signals with closed fifteen-minute context: trend breakout with volume, trend pullback/recovery, and Bollinger-band re-entry in a low-efficiency range. Both directions are supported. The patterns run independently so one cannot claim another's outcome. They share the same market feed, not capital.

Stops come from local structure, targets from nearby structure or three five-minute ATRs (range target: mean), never six four-hour ATRs. Reject a target beyond 1.2%, or a net reward/risk below 1.5 after costs. A fifteen-minute time barrier remains active. These are frozen research hypotheses, not validated predictors or promised profits.

Public **PF_XBTUSD linear futures** candles, live bid/ask and quantities, instrument precision and hourly funding come from Kraken Futures. No spot candles are relabelled as futures. Both entry and exit are charged as taker (0.05% each), plus 2 bps slippage each and signed accrued funding. Maker pricing is not assumed merely because a limit could theoretically be placed. Source: https://www.kraken.com/pro/fees (checked 2026-11-01).

Each mirror permits one position, risk budget 0.5% of equity, maximum notional twice equity, and at most 5% of the observed relevant top-of-book quantity. The daily loss budget is 3%, drawdown stop 5%, and three consecutive losses introduce a fifteen-minute cooldown. These limits do not guarantee exit prices or profits. There is no daily trade-count quota.

A gap prevents new entries. Existing simulated positions are closed at a subsequent fresh executable quote, labelled DATA_GAP_CLOSE, not at an invented stop price. Restart and unknown-funding paths remain separately labelled and do not count as clean observations. Historical legacy conservative losses are preserved, not deleted or reclassified as gains.

## Sources informing the methodology

- Freqtrade: https://www.freqtrade.io/en/stable/lookahead-analysis/ and https://www.freqtrade.io/en/stable/backtesting/ — causal features, costs and explicit historical execution assumptions.
- Hummingbot: https://hummingbot.org/strategies/v2-strategies/controllers/ and https://hummingbot.org/strategies/v2-strategies/executors/positionexecutor/ — separate strategy decisions and price/time exits.
- Jesse: https://docs.jesse.trade/docs/monte-carlo/ — stress tests and avoiding lucky historical paths.

No code or advertised profitability from these projects is claimed as the source of returns. This implementation does not install or secretly delegate trading to another bot.

## Evaluation

`node scripts/multi-pattern-study.mjs <output-directory>` obtains a bounded fourteen-day public sample plus warm-up, records a ten-day development/four-day chronological holdout, replays one-minute paths, and records gross P&L, fees, funding, net, stress net and ambiguity. Fixed 1000 USD notional comparisons are not additive portfolio returns and differ from the live shadow risk sizing. There is no parameter search or automatic promotion. A small positive sample, if any, does not establish an edge. Both-barrier minutes resolve stop-first and incomplete paths are separately counted.

The prospective comparison requires clean future outcomes before review, preserves all its own losses over restarts, and never enables real trading. Fifty clean closes only trigger a request for review; they do not prove profitability or authorize a promotion.
