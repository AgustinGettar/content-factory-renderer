# Secondary PAPER growth profile

Requested by Agustín on 2026-10-30: increase the secondary simulated account to
300 USD and allow greater risk and autonomous leverage. No real orders or funds.

Activation is opt-in with `LUMI_TRADING_SECONDARY_PROFILE=secondary-growth-1.0.0`.
The new worker waits for the secondary account to have no open positions or
orders, then deposits the difference up to 300 USD exactly once. It never removes
money if equity already exceeds that target. Realized P&L, fees, losses, trades,
learning records and historical drawdowns remain. A deposit is not a gain.

| Limit | Secondary profile |
| --- | --- |
| Planned risk per entry | 0.5%, 0.75% or 1% of equity, capped at 3 USD |
| Net reward/risk tiers | 1.5, 1.75, 2.25 respectively, after costs |
| Shared committed risk | 2% of equity, initially 6 USD |
| Daily loss plus commitments | 3% of start-of-day equity, initially about 9 USD |
| Account drawdown halt | 10% from the account peak |
| Research trial drawdown gate | Existing 5% remains stricter |
| Slots / daily selected plans | Existing 3 / 12 |
| Leverage | Lowest feasible value from 1–5x, constrained by live pair metadata |
| Gross exposure | At most 3x equity, never a sizing target |
| Financed collateral | At most 75% equity |
| Cash buffer | 10% equity |

Stop gaps, funding, slippage and liquidation may produce losses above the planned
risk. Leverage does not make the existing fee-heavy one-minute signals profitable.
Pattern, freshness and net-cost acceptance thresholds are unchanged. The margin
model is still a conservative segregated-collateral simulation, not Kraken's
actual liquidation engine. There are no private exchange trading APIs.

Account-local policy is applied to selection, marking, pending-order cancellation,
ongoing market processing and restart recovery. Primary and audiovisual Lumi have
no profile changes. A risk change archives the preceding research round and uses
a separate version for new examples. A successful growth trial requires another
validation under primary risk before promotion; higher risk alone is not proof
that the primary's strategy improved.

Emergency refill remains strictly below 1 USD and only when flat. With this
profile it refills to 300 USD, records the deposit, increments the emergency
refill count and disqualifies the current research trial. The requested initial
capital increase does not count as an emergency refill.

## Remote management procedure

For an existing isolated PAPER worker, Systems Manager can provide remote
maintenance after the owner explicitly authorizes the EC2 instance role and
profile. Use the managed core SSM policy and associate the profile only with the
intended worker. Verify the managed node is Online before sending commands.
Do not open inbound network ports for this workflow.

The pinned `scripts/trading-aws-secondary-risk-update.py <target-commit>` verifies
the previous release, runtime isolation, unchanged dependencies and allowed file
scope. It tests the release, stops the sole writer, verifies a SQLite backup,
sets only the opt-in profile setting, switches release and checks stable process,
market freshness, dashboard updates, backup and Telegram delivery receipt.
Schema 5 prevents an old worker silently reading the new policy. Do not roll back
the database or overwrite current trading events.

Keep account identifiers, command receipts and private account outcomes in the
owner's authenticated operational tools, rather than in repository documentation.
These implementation checks establish behavior, not profitability.
