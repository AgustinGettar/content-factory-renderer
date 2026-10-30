# Concurrent paper operations — 29 October 2026

User scope: several simultaneous BTC/USD opportunities, conditional entries and
exits, complete costs, up to USD1 planned risk. This interprets USD1 as loss at
the planned stop, including estimated fees, spread and slippage, not as the BTC
purchase notional. It remains paper-only, cash spot, no borrowing or shorts.

Each account has one cash balance and at most three total slots (open positions
plus pending entries). All pending orders reserve their worst-case purchase
cost at the limit, including the entry fee. All pending and open trades reserve
their original planned stop risk; profits do not release that reservation until
closure. The portfolio cannot spend a cash balance independently in each slot.

Conditional buys use the existing simulated stop-limit execution: cross the
entry, respect the limit and valid time window, require fresh trade/quote data,
latency and displayed liquidity. A new confirmed pattern can add a slot while
other trades are open. Identical opportunities are deduplicated. Every position
retains its own automatic sell conditions: stop, target and maximum holding time.
These are simulated conditions inside the worker, not exchange orders.

Net reward/risk must be at least 1.5 for every new entry. Planned risk tiers are
0.25%, 0.5% and 1% of equity for net reward/risk of at least 1.5, 1.75 and 2.25,
respectively. These are registered experiment parameters, not probabilities or
evidence that a more distant target is more likely. Never move the target to
qualify. Cap each entry at USD1, cap all committed risk at 1% of equity, retain
the 1% daily loss budget and the 10% cash reserve. Size down to the remaining
budget and exchange minima. At USD100, USD1 is shared across open/pending trades;
three simultaneous trades do not each receive USD1. Planned risk is not a hard
maximum loss under gaps or recovery uncertainty.

The target must show positive NET gain after entry/exit fees, spread and
slippage. Stop or timeout must still close at a loss when indicated. Waiting
indefinitely for profit would invalidate both risk controls and the experiment.
Larger sizes alone do not change percentage fees or create a positive edge.

Persistence advances to schema2. Immutable position/entry plans survive the
migration; all balances, accumulated outcomes, costs and funding survive. Old
single-position workers reject schema2. Compatibility fields expose only the
first slot; calculations, learning and execution always use the complete maps.
The read-only dashboard exposes all slots and totals, without model inputs or
secrets. Telegram sends a distinct ID and amounts for each pending/fill/close.

The execution revision forms part of new model/plan versions. Prior learning is
retained but not mixed with results under the new risk and concurrency policy.
The secondary waits for legacy positions to close, archives any old laboratory
round, and starts prospective trials under the new execution revision. It does
not reset cash, financial history or deposits. At the training boundary it waits
until all training positions/orders have ended, then pauses new selections for
24 hours before prospective validation. Existing promotion gates remain in force.

The AWS updater stages pinned code and offline checks before stopping only the
existing lumi-trading service. It verifies a durable schema checkpoint and
heartbeat. It cannot roll back to the old worker after a confirmed schema2
commit or an ambiguous checkpoint read. It provisions no infrastructure.

Validation uses synthetic execution fixtures, real local SQL persistence tests,
read-only projection tests and scoped installer tests. They prove implementation
properties, not market profitability. AWS activation must be verified separately.

Reference for order terminology and constraints:
https://docs.kraken.com/api-reference/trading/add-order
