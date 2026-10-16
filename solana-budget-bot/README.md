# Solana Budget Bot 4.0.2

A local Solana spot bot with normal strategies, wallet copy trading and separate capital allocations. The supplied settings start with **€200 of virtual SOL**. No real money is used in paper mode. Optional live execution remains a guarded **USDC → token → USDC** route; SOL paper accounting does not enable native-SOL live signing.

Follow [the Windows setup guide](docs/SETUP.md). [The audit](docs/AUDIT.md) separates completed checks from untested integrations. [Performance](docs/PERFORMANCE.md) explains the one-second target and measurement commands. The dashboard/iPhone app is the next phase.

## Changes in version 4

- Standard WebSocket native and owned classic-token account updates wake copy checks immediately. Notifications are hints: successful finalized transaction history, signer/ownership checks and known swap instructions establish an actual copy signal. No raw address-mention flood or paid stream is required by this implementation.
- Copy requests are coalesced, with bounded index retries, overlapping slot coverage and persisted signature claims. Reconnects reconcile missed activity. Observed leader sales queue proportional exits, including sales arriving while the follower's own buy is unresolved.
- Separate scheduling for exits, copy checks, discovery, market refresh and settlement. Background discovery reads do not hold the financial mutation queue. Exit quotes take priority over queued discovery requests. There is one serialized execution path and no automatic replacement of an unknown live transaction.
- Broad discovery targets up to 200 unique candidates per minute, configurable through 500. Overlapping category results can produce fewer unique candidates. Up to 30 eligible shortlisted tokens are refreshed in a batch on a one-second target, alongside holdings and SOL/USDC references. Broad metadata and full executable quotes are different workloads.
- SOL paper buys and sales use SOL routes and exact native-unit cash/cost basis. Status includes cash/equity in SOL and estimated EUR, realized native trading profit and the change in overall capital. Idle SOL is repriced, so a rise in SOL is visible without being counted as a closed trade.
- Normal/copy/reserve allocations default to 50/30/20. Each active allocation has its own loss control, while position/exposure/entry/global loss caps still apply. Allocation cannot count the same money twice or borrow the reserve for an entry.
- Live orders are assembled once, then reverse liquidity, fees, wallet, transaction instructions, simulation and expiry are checked before submission. Confirmed settlement is selectable; its receipts are journaled and subsequently checked for finality. A disagreement pauses trading for reconciliation.
- Measured handling/preparation latency, a read-only network probe, synthetic benchmark, reconnect/usage checks, bounded caches, fewer repetitive logs and cancellation of background reads on orderly shutdown.

The source defaults preserve USDC paper compatibility when no `PAPER_BASE` is supplied; the included `.env.example` explicitly selects SOL. Version 4 state uses a new data folder and rejects older ledger formats rather than silently resetting them.

## Supplied settings

| Item | Value |
|---|---:|
| Mode / paper base | Paper / SOL |
| Starting paper capital | €200 converted to virtual SOL using reference prices |
| Normal / copy / idle reserve | 50% / 30% / 20% |
| Maximum all-in position / total exposure | 10 / 20 USDC equivalents |
| Estimated risk sizing / daily entries | 1 USDC equivalent / four |
| Open positions | Two total, one per active allocation |
| Daily loss / peak drawdown triggers | 5 / 15 USDC equivalents |
| Stop / take profit | 8% / 16% of estimated net liquidation value |
| Normal / copy maximum hold | 60 / 240 minutes |
| Maximum round-trip drag / reward-to-cost ratio | 5% / 2x |
| Entry / exit slippage cap | 0.5% / 1% |
| Broad scan / candidate target | Every 60 seconds / up to 200 |
| Shortlist / position check target | Every second, plus provider/queue time |
| Copy signal age / worse-price cap | 60 seconds / 1% |
| Copy history / stream daily guards | 20,000 / 2,000 estimated credits |
| Fallback history reconciliation | Every 60 seconds; stream activity wakes earlier checks |

Settings named `USDC` remain USDC-equivalent risk limits even in SOL paper mode. The reserve is unallocated trading cash, not protection from SOL price declines. Global equity/loss controls include the changing value of idle SOL. Flatten closes token positions into SOL in SOL paper mode; it does not convert that SOL into a stable asset.

Security gates require classic SPL tokens, disabled mint/freeze authorities, provider verification, minimum 48-hour pool age, $100k liquidity, 500 holders, organic score 60, concentration at most 25% and $50k hourly volume. These checks can reject every observed leader trade or candidate. They are incomplete protections, not proof of safety. Stops are attempted sales and can exceed their estimated loss when routes/liquidity fail.

## Windows commands

Run one command at a time from the extracted project folder:

```bat
npm.cmd ci --ignore-scripts
npm.cmd test
npm.cmd run check
npm.cmd run demo
```

The demo and `npm.cmd run benchmark` are offline, use synthetic data and never load `.env`, sign a real transaction or submit one. The benchmark is local software overhead, not mainnet latency or a strategy success rate.

After setting your existing keys locally:

```bat
npm.cmd run doctor
npm.cmd run feed-check
npm.cmd run latency
npm.cmd run diagnose
npm.cmd run leader-check
npm.cmd start
```

These diagnostic commands are read-only. `latency` measures an RPC read, metadata and two USDC/SOL quotes including rate waits; it does not broadcast. `leader-check` samples supported own-wallet swaps and does not establish a 400-day profit record.

Controls in a second terminal:

```bat
npm.cmd run status
npm.cmd run pause
npm.cmd run resume
npm.cmd run resume-copy
npm.cmd run flatten
npm.cmd run export
```

Pause prevents entries and retains exit monitoring. Resume cannot erase loss halts. Flatten requires the main process running and a sellable route. Ctrl+C saves holdings and stops monitoring without selling. Reallocation while stopped, flat and with no pending/finality records uses `npm.cmd run allocate -- 60 20`; set the same percentages in `.env` before restarting.

## Limits and records

Jupiter's free general API allowance is one request per second; batching and priority do not remove that limit. Quotes in both directions, source confirmation/indexing, simulation, internet and transaction landing can take longer than a second. No sub-second live fill guarantee or commercial-bot parity was established. Provider credit guards estimate only their respective history/stream traffic: other RPC reads, retries and other uses of your key also consume quota. Check your provider dashboard; the program buys no upgrade.

Data is stored under `data-v4/paper/` or `data-v4/live/`. Keep old records separately. Trade intents, claims and financial fills are saved immediately; routine scan snapshots avoid redundant writes. JSON state is authoritative. Event logs remain on disk and can grow; archive old logs privately while stopped and retain the trade/state records. Keep `.env`, wallet keys and trading data out of GitHub and chat.

The CSV includes SOL and estimated EUR fields where available. It is a performance export, not complete Irish acquisition/disposal tax accounting. EUR values use a daily ECB reference or your manual reference, not an executable cash-out quote; exchange/off-ramp fees are not inferred.

**Verified:** 95 automated tests, syntax checks, clean dependency install, zero known dependency vulnerabilities at checking time, offline SOL/USDC buy/sell demos and a controlled copy benchmark. **Still unverified:** your authenticated Helius/Jupiter integration, this leader's genuine trade compatibility, real wallet execution/fill latency and profitability. No real swap was placed during development. Your current laptop is sufficient; no GPU model, new computer or paid plan was added.


## Copy history correction — 4.0.1, 14 October 2026

An authenticated Windows doctor check exposed a rejected cross-mint transfer amount filter. The amount predicate is now omitted while the own-transfer, success, slot, pagination and local signed-swap validation remain. The updated contract regression reproduces the original error and accepts the correction; all 91 tests and syntax checks pass. The corrected provider request still needs a local doctor rerun. See docs/COPY_HISTORY_FIX.md (or COPY_HISTORY_FIX.md from this docs folder).


## 4.0.2 scheduling and provider correction

Overdue discovery now launches even while fast results are arriving, and background request fairness prevents refresh traffic from starving it. Urgent quotes retain priority. Empty shortlists skip redundant screening RPCs. Four new regressions bring the suite to 95 passing tests. Actual Windows doctor checks established that the own-transfer history filter requires finalized commitment; the shipped defaults now match that requirement and allow 60-second source age with the unchanged price/risk gates. Source availability is slower than a one-second leader-follow target. Details are in DISCOVERY_FIX.md in the docs folder.
