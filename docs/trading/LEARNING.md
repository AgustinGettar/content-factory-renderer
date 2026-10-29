# Prospective prediction learning and concise Telegram notices

This release adds entry-time features, automatic logistic training, frozen prospective
validation and per-trade cost analysis to the existing USD 100 paper accounts.
It does not change their entry rules, risk, cash, positions, fees, targets or stops.
The independent frequent experiment remains comparable with its registered rules.
No real exchange orders, paid model API, new AWS instance, or Mini App changes.

## What Telegram sends

Brief separate notices for a pending purchase plan, a simulated executed purchase,
and a closed trade. Each includes the relevant prices, risk or net result, account,
Italy timestamp, short reference and the private monitor link. Link previews are
disabled. The existing private recipient, bot identity, market freshness, durable
outbox and ambiguous-send handling remain in force. No repeated waiting alerts.

## What is learned

Each selected plan freezes ten fixed, causal numeric features: intercept, trend,
momentum, candle body/range, volatility, spread, stop distance, target distance and
fee level. Only candles available before selection are used. The binary outcome is
**strictly positive net P&L at actual simulated closure**, including timeouts and
both fees. It is not the probability of reaching take profit first.

Separate groups are maintained for each account and strategy version. Only fully
observed closes with recorded pre-entry features train. Cancelled/unfilled plans
are counted separately. Legacy entries and data-gap/reconstructed outcomes remain
in financial history and cost analysis but are excluded from clean training.
Analysis records gross P&L (already including modeled execution costs), fees, net,
holding time, exit reason, quality, and observed favorable/adverse net excursion
in units of planned risk. Excursions reflect samples, not unseen extrema.

## Frozen acceptance protocol v1

1. At least 100 eligible closes, including 20 positive and 20 non-positive results,
   train a regularized logistic model on at most the latest 500 eligible examples.
2. Freeze weights and record candidate probabilities before future entries. A
   one-day gap separates the last training close from validation selections.
3. Require at least 200 later closes, at least 20 of each outcome, and 30 distinct
   UTC dates containing outcomes. At the first qualifying checkpoint, evaluate
   once: Brier and log loss must both improve over the recorded baseline, ECE must
   be at most 0.10, and the daily Brier improvement's moving-block bootstrap lower
   bound must exceed zero (7-day blocks, 2,000 deterministic replicates).
4. At most six attempts per group, with 100 additional eligible labels between
   attempts. The confidence level uses alpha 0.05/6. A candidate stops after at
   most 1,000 validation closes even if other sample gates remain unmet.
5. Only validated predictors can publish an estimate. A relevant probability bin
   needs at least 40 independent-of-training validation outcomes, Wilson 95%
   interval width at most 0.20, and consistency with the raw model probability.
   The interval describes the validation group's win rate, not a guarantee for an
   individual trade. Inputs outside training support and models older than 90 days
   yield `NO DISPONIBLE`. A 50-outcome deterioration check can suspend a model.

Training runs automatically after eligible closes; frozen validation survives
restarts. A model may never pass. More activity and a high hit rate do not establish
positive expectancy. Excluding uncertain samples limits conclusions to the observed
subset; financial history still includes uncertain losses. The six-attempt cap
requires a reviewed new protocol before more attempts, rather than unlimited search.
Do not silently relabel data, reset losses, or tune thresholds after seeing results.

Method references: https://scikit-learn.org/stable/modules/calibration.html and
https://scikit-learn.org/stable/modules/generated/sklearn.model_selection.TimeSeriesSplit.html
(method guidance only; implementation uses local JavaScript, not scikit-learn).
Telegram transport: https://core.telegram.org/bots/api#linkpreviewoptions

## Activation and verification

`scripts/trading-aws-learning-update.py` accepts a pinned descendant of
`b10b03aa7cf927bec3aad69cafd2a836cadddefd` and only the listed trading files. It reuses
the existing service's private environment and unchanged dependencies. It runs
offline tests and read-only state checks before a short stop/symlink/start, preserving
both accounts and their open position. Normal gap reconciliation remains enabled.
It requires a committed learning protocol, recent heartbeat and active service.
After an ambiguous read or committed state it never rolls back to an unaware worker.

Code publication alone is not AWS activation. The operator runs the pinned
`aprender.py` helper in CloudShell on the existing VM, then checks the persisted
learning protocol, Telegram activation receipt and monitor freshness. Until then,
the panel must show learning pending, not enabled or trained.
