# Passive maker sizing correction

`maker-sizing-1.0.0` is an opt-in secondary PAPER sizing revision. Enable with
`LUMI_TRADING_MAKER_SIZING=maker-sizing-1.0.0` on the existing context-maker worker.

The previous maker simulation capped the proposed order at 10% of both best-quote
sizes. A small displayed quote could reduce an otherwise affordable order below
the exchange minimum *before posting*. This treated a resting order like an
immediate liquidity taker. Kraken's official post-only description requires
passive posting and rejects crossing orders, not a pre-existing opposite order
of matching size: https://docs.kraken.com/exchange/api-reference/spot-websocket-v2/add_order
(verified 2026-10-31 Europe/Berlin). This project uses no order API.

New passive quantities are bounded by risk, gross exposure, free cash including
fee/funding reserves, and margin caps. Tick/lot rounding and exchange quantity
and notional minima remain mandatory. The first allowed feasible leverage is
used, with size reduced to affordable capital if needed. Increasing risk or
capital is not required to resolve the pre-posting BBO rejection. Old taker and
legacy maker sizing stays unchanged unless the account explicitly activates
this revision.

Posting is not a fill. The existing simulator still requires a noncrossing
post-only quote, a later opposite-side trade strictly through the limit, a 10%
participation cap on that trade, and both-side BBO capacity at the observed fill.
Snapshots, a price touch, candle highs/lows or recycled volume cannot fill it.
Fees, risk limits, targets, stops and frozen existing orders are unchanged.

Precise rejection codes distinguish risk, cash/margin, exposure, and exchange
minimum constraints. Decision diagnostics include proposed BTC quantity and USD
notional, both exchange minima and the limiting budget. The monitor displays
these values without requiring interpretation of a generic liquidity warning.

Schema 8 protects the revision against silent rollback. Activation waits until
flat, archives the old prospective trial, and preserves balances, deposits,
closed results and learning. It starts a separate registered trial with the same
entry signals. Open trades retain their frozen plan until natural closure; a
queued migration is reported explicitly. No automatic primary promotion follows.

Tests cover the thin-quote regression (old rejection/new pending order), rejection
of insufficient fill liquidity, observed full fill, bounded capital/risk sizing,
precise below-minimum diagnostics, unchanged taker sizing, primary isolation,
frozen orders and flat-only activation across restart. These tests make no claim
about profitable returns.
