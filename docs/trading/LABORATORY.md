# Laboratory protocol, 29 October 2026

This release is exclusively simulated Kraken BTC/USD spot trading. It cannot
place exchange orders. The principal ledger seeks positive net results under
unchanged risk limits; this is an objective, not established profitability.

## Research actually reviewed

- [Bysik and Ślepaczuk, 2026 preprint](https://arxiv.org/abs/2606.00060):
  hourly Bitcoin forecasting with chronological walk-forward tests and costs.
  Turnover and cost-aware filtering materially affect net outcomes. Its reported
  lower costs and BTC/USDT data do not establish profitability at Lumi's BTC/USD
  fee assumptions. A preprint is not independent replication.
- [Rob Carver interview, 23 February 2021](https://www.youtube.com/watch?v=vGhzvJbJzEc),
  automatic English transcript, especially 05:11–08:38 and 10:04–20:25;
  [producer's written breakdown](https://bettersystemtrader.com/180-3-ways-traders-kill-trading-strategies-and-how-to-avoid-them-rob-carver/).
  Avoid future information, understated costs, excessive parameter search and
  retrospective removal of failed strategies. This is educational testimony.
- [Andreas Clenow interview](https://www.youtube.com/watch?v=tdGGZd68bLw),
  automatic Spanish transcript reviewed, especially 00:07–04:13,
  18:34–20:55 and 01:11:44–01:13:42. Trends vary across regimes; backtest execution
  can be unrealistic. His discussion of diversified futures portfolios cannot
  be extrapolated to one small spot Bitcoin account.
- [Kraken fee schedule](https://www.kraken.com/features/fee-schedule) and
  [official fee explanation](https://support.kraken.com/articles/201893638-how-trading-fees-work-on-kraken).
  Retain the existing conservative 0.80% taker fee on each side, plus spread and
  slippage. No unverified fee discount or zero-cost fills are introduced.

Professional history is not an independently audited personal trading return.
The interviews were analyzed through their automatic transcripts, not by
verifying every chart frame or auditing brokerage accounts. There is no claim
that these are the newest or universally best rules.

## Executable hypotheses

Three original, predeclared recipes are tried sequentially on the existing
secondary ledger: hourly 20-bar breakout, hourly trend pullback, and four-hour
20-bar breakout. Trend uses EMA20/EMA50; stop is 2 ATR, target is 6 ATR. Entries
use closed, available candles and fresh executable quotes. A natural target
that cannot provide net reward/risk >=1.5 after costs is rejected, not moved
further away to manufacture an attractive ratio. Holding periods are 48 hours
for hourly recipes and seven days for the four-hour recipe. There may be long
periods without trades at these fees. No trade-count target is imposed.

Existing open or pending orders retain their frozen rules. The first new trial
starts only once the secondary ledger is flat. At most one secondary position
is open; risk remains 0.25% per entry and daily loss budget 1%. A 5% decline from
a trial's high-water mark rejects that trial once flat. The next registered
trial uses the remaining cash, with a new trial risk anchor. Account net P&L,
fees and historical outcomes are never erased. A separate contribution-adjusted
drawdown retains the overall loss path across trials and deposits. Three failed
or completed trials end this research round; new recipes require a reviewed
protocol release. Each trial also has a 365-day limit.

## Transfer to the principal PAPER ledger

Require 100 observed feature-bearing closes first, a 24-hour separation, then
at least 200 observed future closes and 90 complete common UTC days including
inactive days. Include conservative/incomplete outcomes in the economic totals;
exclude them from model training. More than 5% incomplete outcomes or any
unresolved gap in validation prevents transfer. Missing calendar observations
cannot be treated as known zero-return days.

At one predeclared final evaluation per recipe, require positive net P&L,
positive stressed P&L (50% extra fees and 5 bps additional round-trip notional
slippage), validation drawdown <=5%, and positive lower confidence bounds versus
both cash and the principal's concurrent daily returns. Use a seven-day block
bootstrap and Bonferroni correction across all three recipes and both comparisons.
Minimum counts are engineering gates, not proof of future performance.

Transfer waits until both actual ledgers and the delayed-alert ledger are flat.
Only the frozen recipe transfers; the principal keeps its own existing cash and
history. The secondary then starts the next registered trial concurrently with
the principal. Primary probabilities must validate on the primary's own group;
secondary predictions or simulated gains are not copied across accounts.
The existing prediction learner continues fitting frozen logistic models and
testing them prospectively. This research layer changes rules only at declared
trial boundaries; it never changes stops on an already-open position.

## Fictitious funding

Only the secondary may refill. Require flat ledger, no pending order, consistent
cash/equity and balance strictly below USD1. Deposit precisely the amount needed
to restore USD100. Record each deposit atomically with its notice and preserve
all cumulative losses, fees and trades. A refill disqualifies the current trial.
There is no real payment. Risk limits will normally stop a trial well before
this threshold. USD1 exactly does not trigger a deposit.

## Research outside the worker

A separately scheduled weekly research review proposes sourced hypotheses and
checks results. It does not install code, change capital or promote strategies.
The worker does not execute text downloaded from YouTube or the web, and this
release does not claim unrestricted autonomous strategy invention. The worker's
registered experiments and prediction training run automatically on AWS.

## Operation and rollout

Natural Spanish notices identify the simulated account, actual amount including
entry commission, planned risk, estimated target net gain, barriers, criteria,
result after fees and the private panel link. Pending plans are not represented
as fills. Gaps remain visible. Existing recipient verification, durable outbox,
deduplication and ambiguous-send handling are retained.

The dashboard is read-only and keeps its private audience. The pinned AWS
updater accepts only the reviewed Trading files over release 887c90c, checks
dependencies and tests before stopping the dedicated service, preserves secrets
and state, and refuses an older rollback after a committed/ambiguous laboratory
checkpoint. It does not provision resources. Local tests and a published panel
do not prove activation: verify a new AWS checkpoint and Telegram receipt after
running the updater.
