# Recovering closed context candles and pending maker notices

## Observed incident

On 2026-10-31 the PAPER worker was active on release
`c82d7da4a3e5cd8f21f028229700584a166834c5`, with no service restart after
15:36:40 UTC. Its persisted daily selection limit was `null`; the secondary
had selected 17 plans that UTC day. The removed twelve-plan quota was not the
cause of the reported inactivity.

The diagnostic window was 15:36:42.494–18:11:47.714 UTC. Five secondary plans
were selected in that window and none filled:

| Selection time (UTC) | Frame | Outcome |
| --- | --- | --- |
| 16:00:02.557 | 60 minutes | `POST_ONLY_WOULD_CROSS` |
| 16:00:02.584 | 15 minutes | `POST_ONLY_WOULD_CROSS` |
| 16:15:01.994 | 15 minutes | Posted, then `VENCIDA` at 16:17:02.003 |
| 17:00:02.278 | 60 minutes | `POST_ONLY_WOULD_CROSS` |
| 18:00:03.768 | 15 minutes | Posted, then `STALE_QUOTE` at 18:01:05.529 |

Of 151 one-minute evaluations in this window, 59 waited for an entry pattern,
33 rejected the modeled costs, 32 waited for trend, and 27 ended as
`LATE_EVALUATION`. The principal's eight evaluations returned
`SIN_OPORTUNIDAD_VALIDA`. Both accounts were unhalted and the laboratory trial
was active. These counts describe this fixed window, not later activity.

## Lost context after a brief data gap

The 27 late evaluations form two runs. At 15:45:00.605 UTC,
`FEED_RECOVERED` recorded the last 15-minute candle ending at 15:30, although
the 15:45 candle had just closed. The same mismatch occurred at
17:45:00.188 UTC, with the last 15-minute candle ending at 17:30.

When there were no open or pending positions, `recover()` performed no candle
request, but advanced the evaluation cutoffs to the current boundaries. On
subsequent minute boundaries, the engine requested only timeframes scheduled
at that minute. It therefore refreshed one-minute bars while leaving the
15-minute context stale until the next quarter hour. The laboratory correctly
refused unsynchronized context, waited for the ten-second evaluation window,
and recorded a late evaluation. Thirteen such evaluations occurred in the
first run and fourteen in the second.

The engine now requests the normally due timeframes together with any stale
closed context series. For each timeframe, its expected end is the most recent
closed boundary at the current minute cutoff, rather than the current minute
itself. Retry checks use those same expected ends. This allows the next live
minute to repair missed 15-, 60-, or 240-minute context without replaying an
entry from the outage. Timeframes whose context is current need no additional
request. Normal strategy scheduling and the ten-second evaluation deadline
remain in force.

## Pending maker notification preflight

The diagnostic window contained five expired signal notices. Three plans had
already been cancelled when the notifier checked them. The other two used the
combined reason `PRE_SEND_COST_OR_LIQUIDITY_CHANGED`; their failure receipts
do not establish which part of that combined condition rejected them.

Inspection found that the notifier still required every pending plan to fit
within ten percent of the immediate bid and ask quantities. The active
`maker-sizing-1.0.0` contract explicitly sizes passive maker orders using risk
and capital at posting, and checks observed liquidity at fill. Requiring
immediate liquidity simply to report that such a plan is pending contradicts
that contract and can suppress a valid pending-order notice.

The notification preflight now recognizes the validated, frozen passive maker
sizing contract before omitting that immediate BBO quantity condition.
Unrecognized or legacy contracts and taker plans retain the existing check.
Pending status, plan validity, notice age, fresh market data, spread costs,
recipient identity and the last freshness check before sending still apply.
The simulated fill continues to require observed price and sufficient volume.
Historical expired notices are not requeued.

## Deployment and verification

This is an implementation repair. It changes no strategy recipe, fee, signal
threshold, order type, capital, balance, risk budget, position limit or daily
selection protocol. It performs no state-schema migration and resets no
learning, research, account or event history. All trading remains PAPER.

The scoped updater starts from the exact continuous-operation release above.
It verifies the existing contract, runtime and profiles, runs offline checks,
stops the single writer, and compares a local SQLite backup with the live
database before switching releases. It then checks the new worker, fresh
market observations, a subsequent laboratory evaluation, current closed
context candles, panel publication and a stable process. It never restores an
old database after the new worker has started.

Regression tests reproduce the missed-context recovery and distinguish pending
maker notifications from taker liquidity checks. These tests verify the
repair without forcing an order or fabricating a fill. A healthy worker may
still wait for its signal, reject costs, cancel a stale or crossing order, or
expire an unfilled limit order.
