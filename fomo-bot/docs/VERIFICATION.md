# Step 1 verification

Verified on 14 October 2026 with Node 24 in the build workspace. No wallet was funded or transaction sent.

## Automated checks

| Check | Result |
|---|---|
| TypeScript strict compilation | Passed |
| Backend unit/integration tests | 49 passed, 0 failed |
| Unchanged bot 4.0.2 regression tests | 95 passed, 0 failed |
| npm dependency audit | 0 known vulnerabilities at the time of the check |

The pinned lockfile is included. Run `npm.cmd ci --ignore-scripts`, `npm.cmd run check` and `npm.cmd test` from `backend` to reproduce the local checks. A dependency audit is a point-in-time check, not an assessment of the entire application.

## What the new tests cover

- Authenticated vault round-trips, wrong-key/tampering rejection, exclusive creation and a usable wallet after temporary decrypted bytes are wiped.
- Persistent request budgets, reserve access, UTC rollover, corrupt-state refusal and multiple local quota writers.
- Exact raw token amounts, canonical public keys, image URL restrictions and priority-fee unit conversion/caps.
- Read-only wallet behavior and SDK requests using the quota wrapper.
- DexScreener exact-mint parsing, separate FDV/market cap, 30-token batches and cache reuse.
- Unknown/failing safety evidence, new/stale token rejection without unnecessary report spending, liquidity drops invalidating prior checks, and unknown risk classifications.
- PumpPortal singleton connection, subscription restoration, reconnects, event deduplication, nullable bonding progress and no default metered subscriptions.
- Opted-in metered-event budgets, including duplicate, malformed and untracked events, stopping at the local cap.
- Feed charts using observed samples and missing values remaining unknown.
- Guarded Jito receipts, required persisted trade intent, one submission POST on ambiguous outcomes, persistent duplicate protection, tip-address/cap checks, expiry and rejection of serialized authorization receipts.
- Native SOL buy/sell preparation through the actual SDK and route decoder, two simulations, conservative sizing, exact SOL spending, reserve/rent limits and refusal of unexpected token changes.
- Native receipt reconciliation, verification of the message signature, separation of gross swap amounts from fees/rent, and waiting for requested finality.
- Current V2 route envelopes, conservative handling of API minimum-output rounding, and a captured real unsigned Jupiter response.
- Shared submission locks across executor instances, no RPC resubmission after an unknown outcome, exit-credit access through the actual SDK, and exits remaining available when the valuation source is down.
- Market refresh continuing while safety I/O is blocked, and unrelated frozen airdrops not preventing a native exit.

The original transport isolation tests use mocked chains. The native tests use the actual SDK, instruction decoder, signer and native balance/receipt validators against controlled RPC fixtures. They do not submit a funded swap. The retained core tests separately exercise accounting, normal/copy strategies and settlement with fixtures and mocked chain responses.

Two public, unsigned `/swap/v2/build` GET requests returned HTTP 200 during the restart. A captured response is included in `backend/test/fixtures/jupiter-build-v2-readonly.json` as a provider compatibility test. Its public taker address is a documented Jito tip account, not an app wallet. No account key was loaded, no response was signed and no transaction was submitted during those probes. These reads establish response compatibility; they do not establish mainnet fills.

## Not established by these results

An installed app, GitHub IPA build, end-to-end authenticated phone controls, actual Jupiter/Jito mainnet fills, profitable strategies, a leader's historical profitability, complete malicious-token detection, a measured sub-second fill time, or a provider-billed monthly total.

The provider adapters follow the primary documentation linked in `SOURCES.md`. Provider schemas, rate limits and service availability can change. Full real-service and device integration checks belong to the later steps; passed offline tests must not be described as a production or mainnet certification.

The native SOL execution and receipt modules are implemented. The native portfolio ledger, controller API and auto-exit integration are Step 2 work. The old live USDC engine must not be connected to native SOL receipts without changing its accounting. SOL paper accounting remains in the retained core.
