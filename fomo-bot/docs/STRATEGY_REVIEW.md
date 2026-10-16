# Strategy review for Step 3

The available project records contain engineering fixtures, not a prospective profitable track record. They do not support replacing the current rules with a supposedly better Solana strategy or increasing exposure to chase the original return target.

The review produced two concrete changes:

1. **Preserve fee cash for exits.** The previous entry-sizing path could spend almost all an allocation's cash. The sell gate then refused an exit for lack of its own fee cash. Entry sizing now reserves exit fees per managed position and candidate. Partial exits also preserve fee funding for remaining holdings. Regression tests cover the previously blocked, exactly funded case.
2. **Measure net results by entry strategy.** The new authenticated report reconstructs recorded receipts, including entry/sale fees, rent and failed transaction fees. Partial exits contribute realized PnL, but the closed-position count and win/loss result are recorded once. Open holdings and unfinalized effects remain visible. A high partial-sale count cannot become an inflated win rate.

Use `npm.cmd run controller -- performance`, authenticated `GET /v1/performance`, or WebSocket `GET_PERFORMANCE` to inspect the report. Profit factor refers to completed positions; failed entry fees still reduce the separate overall realized result. Open-position outcomes and small samples must not be treated as a demonstrated edge.

The existing momentum/breakout/pullback rules and cost/price-chase gates remain in force. Experimental mean reversion remains opt-in. Profile names do not justify looser authority/program checks, new-token eligibility, bigger orders or higher fee budgets. A configured target-to-cost ratio is a screening rule, not an estimated probability of winning.

For a later comparison, record normal/copy results prospectively over the same period, keep paper fills labelled, include every failed/unsellable holding and fee, and decide on changes before evaluating a separate later sample. Do not select the best-looking synthetic scenario and call it an out-of-sample result. No automatic strategy optimizer or winner-switching system was added.

Primary context checked: the BIS's *Crypto shocks and retail losses* (20 February 2023) reports that most crypto-app users in its sample lost on bitcoin holdings during the studied period. That historical bitcoin finding does not establish the performance of this Solana bot. It supports testing net outcomes instead of inferring profitability from popularity or activity. Source: https://www.bis.org/publications/bulletin-69-crypto-shocks-and-retail-losses

No funded trade or measured return improvement was established by this work.
