# Secondary PAPER entry experiment

The optional `LUMI_TRADING_ENTRY_PROFILE=agile-5bars-1.0.0` starts a separate secondary experiment once all previous positions and orders are finished. It requires the existing secondary growth profile. The principal account keeps its own settings.

The four existing timeframes use a 5-bar breakout **or** a recovery after a pullback, with EMA 9/21 and minimum net reward/risk of 1. The historical bars needed to initialize indicators are still loaded; five bars defines the breakout window, not a new startup delay. Stops, natural ATR targets, holding times, actual configured costs, financing, daily selections and capital/risk limits remain enforced. A candidate with net reward/risk below 1.5 uses the existing 0.5% baseline secondary risk tier. This is an experiment, not evidence of profitability.

Activation records a new protocol and trial, archives previous rounds, preserves cash, deposits, P&L, fees and learning history, and does not repeat a capital addition. Schema 6 prevents an older worker from silently interpreting the changed rules. Active profiles persist over restart. Only closed, available bars enter decisions; evidence charts use the same EMA periods and values as the actual signal.

The existing learning process collects closed outcomes by version and timeframe, trains after enough clean examples, and validates on later outcomes. It does not automatically change entry thresholds. The new round has one registered combined hypothesis and retains training, validation, cost stress and drawdown gates. New thresholds require a separately versioned prospective experiment. A secondary risk result cannot directly promote a different risk policy to the principal account.

Use the dedicated pinned-release updater for the isolated PAPER worker. It checks deployment scope and environment, runs tests, stops the single writer, verifies and backs up SQLite, sets only the entry-profile option, then verifies service, market feed, persistence, dashboard, backup and the existing activation notice. Do not restore an old database over later trade outcomes.
