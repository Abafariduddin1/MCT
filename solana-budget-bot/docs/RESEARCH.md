# Trading methods and evidence — updated 13 October 2026

**Selection for this €200 project:** spot momentum as the first research strategy, breakout/pullback as separate technical variants, guarded wallet copy trading, and optional range reversion for experimentation. This is an engineering selection for evaluation, not a ranking by demonstrated future profitability. No reliable universal success percentage was established for these implementations.

## What the accessible research supports

Liu and Tsyvinski's research and their own 2018 summary identify time-series momentum and investor attention as predictors in Bitcoin, Ripple and Ethereum. The summary discusses weekly horizons. That supports testing trend behavior; it does not validate a three-minute signal in Solana memes or provide this bot's win rate. Jupiter organic score is a token-quality metric, not the same variable as the authors' investor-attention measures.

Source: https://cepr.org/voxeu/columns/risks-and-returns-cryptocurrencies and https://www.nber.org/papers/w24877

The 2024 paper *Cryptocurrency anomalies and economic constraints* examines whether return patterns survive implementation restrictions. Its accessible publisher material reports materially reduced momentum alpha after costs (26–53%). The application here is to test net returns with plausible fees/rent/slippage rather than select an impressive gross chart. These figures are reductions in reported alpha, NOT predicted returns, win rates, or evidence for this minute-level bot.

Source: https://doi.org/10.1016/j.irfa.2024.103218

The accessible abstract/results for *Trading volume and liquidity provision in cryptocurrency markets* associate reversal behavior with volume conditions. This is a reason to treat reversal as conditional research, not buy every falling token. Its strategy/assets/cost model do not establish a hit rate for Solana launch trading.

Source: https://www.sciencedirect.com/science/article/pii/S0378426622001418

Research access varied: available abstracts, publisher excerpts and the authors' summary were reviewed. Full datasets and all full papers were not reproduced, and no historical Solana dataset was acquired or backtested. The following judgments are implementation inferences, not conclusions measured by those papers.

## Implemented choices

| Method | Entry logic | Main failure mode | Evidence status / default |
|---|---|---|---|
| Momentum | Advancing observations over three minutes, bounded rise, positive latest tick and buy pressure | Chasing an exhausted move, false price/volume signals | Broader crypto momentum has empirical support; this rule is unvalidated. Enabled. |
| Breakout | Price clears the prior observed range with EMA trend and pressure confirmation | False breakout or insufficient follow-through after costs | A testable technical variant, not a claimed published success rate. Enabled. |
| Pullback | Measured upward trend, dip around the short EMA, then rebound without demanding a new high | Trend ending or a rebound inside a collapse | A testable trend variant, not independent proof of alpha. Enabled. |
| Range reversion | Small long-window drift, a low standardized price deviation and a rising latest observation | A real downtrend/rug continues lower | Conditional evidence elsewhere is not transferable. Experimental, disabled unless explicitly selected. |
| Wallet copy | Supported signed own-wallet swaps, fresh follower-size quote, age/chase/security/cost/budget gates | Entry delay, unsupported trades, leader advantages, missed exits | Intended trader compatibility and 400-day record remain unverified. Enabled when configured history works. |

The three normal strategies share ONE normal budget; a token confirming several signals does not get three purchases. Their returns may be correlated. Allocation percentages do not make them independent investments. Copy has its own budget/loss control, but the same market can affect both sleeves. Duplicate same-token positions across sleeves are blocked to limit concentration and simplify real wallet reconciliation.

## Methods considered but not implemented

- **Grid trading:** repeated entries/exits can accumulate costs and inventory during a one-way decline. I would not use it as a default on unpredictable memes with a €200 balance.
- **Cross-venue/triangular arbitrage:** an observed spread is not an executable net profit after slippage, fees, timing and capital movement. Infrastructure and competition make it a poor first project here.
- **Launch sniping:** detection alone does not establish an edge; new token authorities/extensions, liquidity changes and insider selling complicate exits. The safety policy still excludes young pools and Token-2022.
- **Liquidity provision:** earning fees also exposes principal to inventory/impermanent-loss and smart-contract risks. It is a different position model from this bot's guarded spot swaps.
- **Staking/lending:** can be researched for longer-term holdings but does not support a dependable 50% month-end target; principal/asset/protocol risk remains. No yield percentage is asserted here.
- **Leverage/perpetual funding trades:** liquidation, borrowing and additional accounting are outside this small-capital spot design.

These are budget/risk judgments, not an exhaustive survey of every product or a claim that professionals cannot profit with them. No paid terminal, API plan, GPU model or new computer is needed for the implemented research workflow; provider free quotas still apply.

## Success rates: what can be stated

There is **no measured live or out-of-sample success rate for version 4**. The synthetic demo is deliberately built to enter and exit; its result must never be marketed as strategy evidence. No commercial-bot benchmark was run.

The status report calculates completed-position wins, losses, net realized P&L by strategy, equity including open holdings, drawdown, and a Wilson 95% interval for the observed win proportion. Partial profitable sells do not inflate the completed-position count. The interval assumes independent trials and is only an approximate description when trades are correlated.

Win rate alone is insufficient. For example, before costs, a strategy winning 40% of trades with twice as much average gain as average loss can have positive expected value; 90% small wins can be overwhelmed by occasional large losses. Here the 8% stop is an attempted sale trigger, not a guaranteed maximum loss. Unclosed losing positions and missing routes must be included in equity and risk review.

Compare variants prospectively with settings frozen during the evaluation interval. Inspect net expectancy, payoff ratio, fees/rent, drawdown, open losing holdings, exposure and whether one outlier accounts for most profit. Use later observations for evaluation after any tuning. A few dozen correlated trades remain a small sample; at four total entries per day, meaningful evidence takes time and may extend beyond this month. Do not raise limits merely to meet €300.

## Your proposed copy wallet

Target: 4vw54BmAogeRV3vPKWyFet5yf8DTLcREzdSzx4rw9Ud9, associated with the public notdecu profile. Prior direct RPC sampling found very heavy address-reference activity; three inspected v1 transactions were not signed or paid by that wallet and did not contain its token balance rows. Those were not proof of its trades or losses.

Version 4 retains filtered own-transfer history and then validates signer, owners, successful status and known swap instruction data. It reads v1 observations via raw parsed JSON but constructs the follower's own managed v0 Jupiter order. Supported observed partial sales are proportional, with own protective rules overriding the leader when needed.

The filter must pass `doctor`/`leader-check` with your Helius credentials. This environment had no user API keys; that authenticated integration and the exact leader's genuine swap compatibility were not tested. The public 400-day claim is not verified, no complete daily marked-to-market series was reconstructed, and closed profits can coexist with open losses. A profitable leader does not establish positive follower returns with smaller capital and later execution.

## Technical references

- Filtered full history, v1, pagination and credits: https://www.helius.dev/docs/rpc/gettransactionsforaddress
- Token discovery/audits: https://developers.jup.ag/docs/tokens/token-information
- Order parameters/fees/transaction-version ceiling: https://developers.jup.ag/docs/api-reference/swap/order
- Jupiter route schema: https://github.com/jup-ag/instruction-parser/blob/main/src/idl/jupiter.ts
- PumpSwap swap and LP instruction distinction: https://github.com/pump-fun/pump-public-docs/blob/main/docs/PUMP_SWAP_README.md


## Version 4 execution research update

The strategy selection is unchanged; faster processing is an execution improvement, not evidence of a better win rate. Standard owned-account notifications now wake filtered finalized history checks, and overlapping coverage handles late indexing without duplicate orders. Source confirmation, index lag and two-direction executable quotes remain latency constraints.

The free Jupiter general limit is one request per second, but known-mint metadata can batch 100 addresses. Version 4 therefore targets 200 broad candidates per minute and a smaller fast shortlist. Its separate submission queue follows Jupiter's documented execution bucket; it does not evade read limits. Sources: https://developers.jup.ag/pricing, https://developers.jup.ag/docs/tokens/token-information and https://developers.jup.ag/changelog/developer-platform.

Standard Helius subscriptions are documented for all plans and are metered. Notifications alone do not prove a successful swap, so ownership, signer, supported instruction and confirmed-history checks are retained. No paid feed was purchased. Sources: https://www.helius.dev/docs/rpc/websocket and https://www.helius.dev/docs/billing/credits.

SOL paper accounting now permits testing token returns in native SOL while separately showing overall estimated EUR equity. Idle SOL market moves are included in capital valuation; they do not become closed trade wins. Daily ECB EUR/USD references are informational, not executable conversion quotes. Source: https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/index.en.html.

The controlled 30-sample benchmark measured only local notification handling with fake providers and actual disk accounting. It does not establish network latency, confirmed fill time, the supplied leader's compatibility, commercial-bot parity or a strategy return. See PERFORMANCE.md and TEST_RESULTS.md.


## 4.0.2 scheduling and provider correction

Overdue discovery now launches even while fast results are arriving, and background request fairness prevents refresh traffic from starving it. Urgent quotes retain priority. Empty shortlists skip redundant screening RPCs. Four new regressions bring the suite to 95 passing tests. Actual Windows doctor checks established that the own-transfer history filter requires finalized commitment; the shipped defaults now match that requirement and allow 60-second source age with the unchanged price/risk gates. Source availability is slower than a one-second leader-follow target. Details are in DISCOVERY_FIX.md in the docs folder.
