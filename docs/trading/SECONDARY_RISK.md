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

## Remote operation readiness

AWS plugin reads verified account `146766539818`, region `eu-north-1`, existing
PAPER VM `i-0ae2ad0bb886f3d7f`, running Amazon Linux 2023. No SSM managed node or
instance profile was present. The intended management setup is:

1. Dedicated EC2-trusted IAM role and instance profile named
   `lumi-trading-paper-management`, tagged for PAPER.
2. Attach `arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore` to that role.
3. Associate only the existing PAPER VM with that profile; verify SSM Online.
4. Use SSM Run Command for this VM, without sharing credentials or uploading
   a new user-side installer on each change.

Automatic approval review rejected creation of the persistent IAM role/profile
because explicit authorization for that security permission change is required.
Readback confirmed neither was created. No alternate route was used to bypass
the rejection. Deployment remains pending that permission.

Once management is available, the pinned script
`scripts/trading-aws-secondary-risk-update.py <target-commit>` validates the exact
previous commit `394168179d7b79b055ac7c441864e792d6284cc5`, unchanged dependencies,
isolated runtime and file scope, runs checks, stops the sole writer, saves and
verifies a SQLite backup, writes only the opt-in environment setting, switches
release and verifies stable heartbeat, fresh market, dashboard, encrypted backup
and the actual Telegram receipt. Schema 5 prevents an old worker silently reading
the new policy. Never roll back the database or overwrite current trading events.

Local validation: 150 Trading tests (9 new profile tests), 8 updater tests and
Lumi isolation checks. These establish implementation behavior, not profitability.
