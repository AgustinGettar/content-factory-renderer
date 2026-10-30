# Secondary PAPER leverage experiment

User-requested prospective version `secondary-boost-1.0.0`, opt-in through
`LUMI_TRADING_LEVERAGE_PROFILE=secondary-boost-1.0.0` on the isolated AWS worker.
Requires the existing secondary growth/context/net-exit state. Schema 10 prevents
older workers from silently restarting with incompatible risk settings.

The previous policy chose the first feasible leverage, usually 1x. This version
prefers the viable 3x–5x group and chooses the largest risk/capital-constrained
quantity within it, breaking ties at the lower leverage. Only if that group is
infeasible does it consider 1x/2x. Pair metadata, short eligibility in the model,
net costs, stop versus modeled liquidation, lot and notional minima still apply.
It does not claim exchange/account eligibility or simulate real borrowing.

Risk tiers are 1% at net reward/risk >=1, 1.5% at >=1.75, and 2% at >=2.25,
capped at USD 6 per plan. Shared reserved loss is at most 4% of equity; daily
consumed loss plus reservations is bounded by 5% of start-of-day equity. Existing
10% account drawdown, 5% trial drawdown, 10% cash reserve, 3x total account gross
exposure, 75% margin and three slots remain. Stops cannot guarantee final losses.
There is no capital deposit or reset of equity, losses, fees or selection counts.

Activation archives the old experiment and starts a separate prospective trial,
without waiting for existing positions to close. Their frozen plans, quantities,
leverage and goals remain unchanged and consume the shared budget. Late old
settlements update their archived trial, never the new training/validation sample.
Maker sizing and net exits become active for new plans as part of this explicit
transition. Validation still requires the whole account flat and a future purge.
No backdated entry is created; frame cutoffs start at activation's current close.

A larger maker proposal is not an executed trade. The simulator still requires a
later observed opposing trade strictly through its limit, sufficient displayed
BBO and <=10% observed trade participation, shared across pending plans. Partial
fills/queue position remain unmodeled. Financing and both-side fees remain in
selection, net-goal estimates and actual simulated settlement.

Validation: synthetic fixtures cover actual exposure increase, 3x tie selection,
5x cash-limited sizing, lower fallback, fees/liquidation rejection, unfilled maker
orders, shared risk, old-position preservation, archived accounting, reboot and
exact financed net-exit cash reconciliation. These are software checks, not
profitability evidence. AWS updater checks scope, backs up SQLite before changing
the release, and verifies stable runtime plus resumed prospective evaluations.
