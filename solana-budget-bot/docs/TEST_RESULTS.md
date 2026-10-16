# Verification — version 4.0.2, 14 October 2026

| Check | Result |
|---|---|
| Environment | Linux, Node 24.19.0 |
| Clean `npm ci --ignore-scripts` | Passed; 54 packages installed |
| `npm test` | 95 tests, 95 passed, 0 failed/cancelled/skipped |
| `npm run check` | All source/script/test modules passed syntax checks |
| `npm audit --json` | 0 known dependency vulnerabilities at checking time |
| `npm run demo` | SOL and USDC automatic paper buys and costed exits passed |
| `npm run benchmark` | 30 synthetic notification → SOL paper entries and proportional exits passed |
| Controlled local benchmark p50 / p95 / max | 1.77 / 2.16 / 5.62 ms; 30/30 under 1,000 ms |
| Real network/mainnet fill timing | Not tested |

The benchmark uses mocked providers and actual engine/disk accounting. It excludes internet, confirmation, indexing and quote-rate waits. The demo deliberately uses made-up prices. Neither is a backtest, profitability result or real execution-speed claim.

Coverage includes automatic normal/copy entries and sales, native accounting/repricing/restart, strategy gates, allocation isolation, live mocked execution, real SDK signing with simulated RPC, exact encoded route limits, fee/rent/reserve protections, ambiguous-outcome recovery, confirmed/finalized verification, leader-sale queues, v1 history filtering, late indexing/deduplication, reconnect/stream quotas, bounded API batches/priority, wake deadlines, background-read cancellation and slow notification isolation.

No real swap, user-credential integration, Windows acceptance of version 4, full leader-performance reconstruction or prolonged unattended/profit test was performed. See AUDIT.md and PERFORMANCE.md for the practical limits and the read-only laptop checks.


## Copy history correction — 4.0.1, 14 October 2026

An authenticated Windows doctor check exposed a rejected cross-mint transfer amount filter. The amount predicate is now omitted while the own-transfer, success, slot, pagination and local signed-swap validation remain. The updated contract regression reproduces the original error and accepts the correction; all 91 tests and syntax checks pass. The corrected provider request still needs a local doctor rerun. See docs/COPY_HISTORY_FIX.md (or COPY_HISTORY_FIX.md from this docs folder).


## 4.0.2 scheduling and provider correction

Overdue discovery now launches even while fast results are arriving, and background request fairness prevents refresh traffic from starving it. Urgent quotes retain priority. Empty shortlists skip redundant screening RPCs. Four new regressions bring the suite to 95 passing tests. Actual Windows doctor checks established that the own-transfer history filter requires finalized commitment; the shipped defaults now match that requirement and allow 60-second source age with the unchanged price/risk gates. Source availability is slower than a one-second leader-follow target. Details are in DISCOVERY_FIX.md in the docs folder.
