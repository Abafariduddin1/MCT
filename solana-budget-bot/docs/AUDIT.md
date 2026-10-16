# Version 4.0.2 audit and acceptance status — 14 October 2026

**95 automated tests pass.** The supplied configuration is paper/SOL, with explicit opt-in required for guarded USDC-based live execution. No real swap was placed during development. These are code/fault checks, not independent certification or evidence of profitability.

## Verified behavior

- Exact SOL paper cash/buckets, SOL entry/exit routes, proportional native cost basis, rent charged once per simulated token account, and restart persistence. ECB reference parsing rejects invalid/stale data; idle SOL repricing changes EUR/USD equity without inventing a closed-trade profit.
- Normal/copy/reserve capital cannot be double-counted or silently borrowed. Global and allocation loss controls, exposure/position/day-entry caps, stop/take/trail/hold rules, allocation mismatch rejection and stopped/flat native reallocation remain active.
- Automatic normal scan → paper buy → costed exit works for SOL and USDC. Momentum, prior-range breakout and pullback are exercised; unsafe metadata, excessive one-tick jumps and unenabled experimental reversion are rejected. Diagnostics explain warmup/eligibility/rejection rather than silently showing a candidate list.
- Up to 200 deduplicated discovery candidates are exercised; known-mint metadata batches split at 100. A shared priority queue spaces general requests and lets urgent exits overtake queued discovery. Background discovery does not prevent a copy signal from being processed.
- Standard owned-account WebSocket hints, ownership validation, unchanged-value deduplication, immediate wake, heartbeat/reconnect, read-only probe cleanup and usage-budget stop are checked. Metadata screens reuse fresh stream slots; actual entries still read confirmed RPC data.
- Finalized filtered full history supports parsed v1 observations and validates source signer, token owners and known swap instructions. Transfers, address-only mentions, LP deposits and failures are rejected. Overlap recovers late-indexed swaps without duplicate fills; bounded claims/coverage/usage survive restarts.
- Copy SOL paper entry preserves the other allocations. Proportional leader sales retain residual token/native cost basis. Sales arriving during a pending follower buy are saved and applied once. Stale signals, source errors/credits and incompatible trades fail closed.
- Full running-loop checks exercise notification wake, coalesced fetch deadlines, automatic paper entry, saved holdings on stop, cancellation of blocked background reads and release of the process lock. Slow optional notifications do not hold up financial processing.
- A live-mode controlled engine test sends buy and sale through mocked preparation/submission/settlement. The entry requests one assembled buy order and one reverse quote. No real submission occurs in these tests.
- A separate real SDK v0 serialization/signing/simulation test uses ephemeral generated keys and mocked RPC, including 37 unused empty token accounts. Signer/fee payer, approved programs, wallet authorities, encoded exact-in/minimum/slippage, simulated token/native deltas, expiry, fee/rent caps and SOL reserve are checked.
- Pinned complete Jupiter Borsh layouts reject hidden trailing bytes and unsupported route variants. JSON quote validation is not substituted for instruction validation. A native transfer cannot hide inside the rent allowance.
- Transaction intent is durable before the single execution attempt. Ambiguous outcomes block replacement orders. Atomic ledger commits preserve copy object references/claims. Failed-transaction fees and partial cost basis are applied once.
- Confirmed settlement receipts remain in a durable finality journal. Finalized verification does not double-book; divergent or missing finality pauses/halt reconciliation while retaining the recorded receipt/accounting. Finalized-only settlement remains selectable.
- Missing sell routes preserve the holding. After repeated failures, SOL/native risk marks stay zero through repricing and new entries halt. Resume cannot clear a loss halt; flatten stays paused.

## Final checks

Linux, Node **24.19.0**. Clean pinned `npm ci --ignore-scripts` succeeded. Tests: **95 passed, zero failed/cancelled/skipped**. All source/script/test modules passed syntax checks. Dependency audit: **zero known vulnerabilities** at checking time. No runtime dependency or paid service was added.

Both offline demo bases bought and sold automatically with financial invariants checked. Controlled synthetic copy benchmark: **30/30** samples below the 1,000 ms local target; p50 **1.77 ms**, p95 **2.16 ms**, maximum **5.62 ms**. Providers were mocked; the real engine/disk ledger ran. These numbers exclude network, source confirmation/indexing and actual fills and cannot be presented as mainnet latency or strategy performance.

No user keys, real wallet or funds were supplied. The current package was not run on the user's Windows machine; their earlier version's connectivity result does not accept the new filtered history/WSS/FX paths. Run the supplied read-only checks locally.

## Material limits

1. No funded mainnet buy/sale, authenticated provider integration, actual fill-latency comparison, long unattended run, historical Solana backtest, out-of-sample performance test or commercial-bot benchmark was performed.
2. One-second metadata/monitor targets are scheduling goals. Confirmation/indexing, free general API bandwidth, active quotes, RPC/simulation, congestion and missing liquidity can exceed them. Processed wake hints do not authorize unconfirmed source trades.
3. The supplied leader's compatible genuine swaps and 400-day equity record remain unverified. Other wallets, rebates, private allocations, off-chain actions and unclosed losses are not reconstructed. Smaller later follower orders can have different returns.
4. Daily history/stream counters are estimates for those features, not total provider billing or a guaranteed free monthly quota. Other RPC calls, retries and shared account use matter. Usage errors can block copy and request exits.
5. Native SOL live signing/settlement is outside this release; live stays USDC-based with SOL for gas. Confirmed booking accepts a small finality risk. The verifier halts on disagreement and does not automatically unwind/replay a disputed receipt. Manual wallet/ledger reconciliation is required.
6. The pinned Jupiter route layout and venue decoders need maintenance when programs evolve. Unknown ABI/routes refuse signing; do not bypass those checks to force a buy. Unsupported/complex source swaps, Token-2022 and young launches are skipped.
7. Authority/holder/volume/liquidity/organic/verification filters do not eliminate manipulation, coordinated wallets, removable liquidity, insiders or platform compromise. Simulation is not a formal contract audit.
8. Stops/loss limits are triggers, not guaranteed maximum losses. Sleep, outages, local disk/process failure, RPC lag, gaps and unsellable holdings can prevent exit. A whole position may be lost. SOL idle cash can decline and trigger equity loss controls; flattening into SOL does not stabilize its EUR value.
9. Paper uses quotes with adverse-fill, network and rent estimates. It cannot reproduce every failed fill or wallet-specific route. SOL rent is charged once per simulated account and never automatically reclaimed. USDC paper retains its conservative per-entry rent assumption.
10. EUR estimates use daily/manual references, not executable conversion quotes. CSV is not complete Irish acquisition/disposal cost-basis accounting and excludes other-wallet history/off-ramp costs. SOL and USDC performance denominators can give different results; review native profit and total EUR equity together.
11. Event logs accumulate; routine fast snapshots/rejection logs were reduced, but old trade/state records need private retention and available disk space. A software test cannot prove that every future external/network fault will be handled.
12. No dashboard, remote command server, authentication layer or IPA was included. The next app can read existing allocations, health, diagnostics, latency, positions and performance; its controls must preserve the serialized execution path and keep keys on the laptop.

## Operational acceptance

Use a new folder, preserve old ledgers, and keep paper settings for this evaluation. Run install, tests, syntax, demos, doctor, feed-check, latency, diagnose and leader-check. Keep source/risk gates in place even if no trade qualifies. A later deliberately chosen tiny real-wallet test requires a supported no-broadcast preflight and independently verified buy/sale signatures/balance changes before unattended use. No funding, paid upgrade or trade was performed on the user's behalf.


## Copy history correction — 4.0.1, 14 October 2026

An authenticated Windows doctor check exposed a rejected cross-mint transfer amount filter. The amount predicate is now omitted while the own-transfer, success, slot, pagination and local signed-swap validation remain. The updated contract regression reproduces the original error and accepts the correction; all 91 tests and syntax checks pass. The corrected provider request still needs a local doctor rerun. See docs/COPY_HISTORY_FIX.md (or COPY_HISTORY_FIX.md from this docs folder).


## 4.0.2 scheduling and provider correction

Overdue discovery now launches even while fast results are arriving, and background request fairness prevents refresh traffic from starving it. Urgent quotes retain priority. Empty shortlists skip redundant screening RPCs. Four new regressions bring the suite to 95 passing tests. Actual Windows doctor checks established that the own-transfer history filter requires finalized commitment; the shipped defaults now match that requirement and allow 60-second source age with the unchanged price/risk gates. Source availability is slower than a one-second leader-follow target. Details are in DISCOVERY_FIX.md in the docs folder.
