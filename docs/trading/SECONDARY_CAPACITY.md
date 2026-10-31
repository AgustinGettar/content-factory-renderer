# Secondary capacity PAPER revision

Opt-in `LUMI_TRADING_CAPACITY_PROFILE=secondary-capacity-1.0.0` upgrades schema 10 to 11. The existing isolated AWS worker adds exactly 200 fictitious USD once, atomically with the profile and notice. Cash, equity, peak and daily capital anchors increase equally. Net results, fees, historical drawdown, halts, day selections and existing contracts are retained. Funding records the contribution separately; it is not training profit or an emergency refill.

The secondary has 10 combined open/pending slots (primary 3), preferred leverage 5x and metadata-supported alternatives up to 10x. Risk tiers remain 1/1.5/2 percent by net RR, capped at 10 USD per new entry. Open and daily risk each have a shared 10 percent budget. Gross exposure is at most 5x equity, margin at most 75 percent, and cash reserve 10 percent. Costs, liquidity, minimum order size, liquidation distance, 12 daily selections, account 10 percent and trial 5 percent drawdown limits still apply. Ten slots do not guarantee ten trades. Leverage can increase losses; estimated risk is not a guaranteed maximum at execution.

Activation archives the previous round and starts a prospective trial. Legacy outcomes settle in their original round. Existing positions retain quantity, leverage, stops and targets, while consuming shared portfolio capacity and risk. Emergency refill remains 300 USD only below 1 USD while flat.

Deployment uses the pinned capacity updater, scope whitelist, pre-start SQLite integrity backup and unchanged-state check. No exchange orders or real balances are touched. A schema 10 worker cannot open schema 11 state. Monitor projects dynamic limits and retains its 2-second refresh.
