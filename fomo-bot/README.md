# FomoBot

Native iPhone controller and Solana trading backend, restarted from the supplied five-step prompt. This archive is **Step 1, backend version 0.2.0**. It contains complete implementations of the Step 1 modules and the existing bot's source and regression tests. The auto-pilot server, iPhone screens and IPA pipeline are added in Steps 2–5.

Start with [STEP_1_SETUP.md](STEP_1_SETUP.md). Keep the existing bot installation and trading data until the controller integration is complete.

## Included now

| File | Responsibility |
|---|---|
| `backend/src/solana.ts` | Metered RPC, classic SPL mint inspection, guarded quote validation and transaction preparation through the existing bot |
| `backend/src/nativeSol.ts`, `nativeRoute.ts` | Native SOL buy/sell preparation, current V2 instruction limits, simulations, reserve checks and signed-message receipt verification |
| `backend/src/jupiterBuild.ts` | Exact-in raw swap instructions with zero integrator fee and backend-controlled SOL wrapping |
| `backend/src/priceReference.ts` | Cached SOL/USDC prices checked against chain slots; conservative sizing in integer units |
| `backend/src/pumpStream.ts` | One reconnecting PumpPortal connection, launch/migration events, explicitly opted-in metered trade subscriptions |
| `backend/src/dexScreener.ts` | Batched market metadata, separate market cap/FDV, caching and bounded requests |
| `backend/src/rugcheck.ts` | RugCheck summary parsing and combined authority, concentration, liquidity, age and LP checks |
| `backend/src/jitoExecutor.ts` | Validated Jito submission, tip caps, durable submission journal and bundle status lookup |
| `backend/src/rpcExecutor.ts`, `submissionJournal.ts` | Optional direct RPC transport and shared protection against duplicate submission across executor instances |
| `backend/src/walletVault.ts` | AES-256-GCM wallet encryption, authenticated unlocking and exclusive vault creation |
| `backend/src/feePolicy.ts` | Bounded priority-fee calculations and entry/exit slippage limits |
| `backend/src/feed.ts` | Bounded feed registry and charts built from observed market-cap samples |
| `backend/src/quota.ts`, `http.ts` | Persistent local budgets, an exit reserve, request queues and response limits |
| `backend/src/cli.ts` | Read-only doctor/feed commands and explicit local encrypted-wallet creation |
| `backend/core/` | Unchanged Solana Budget Bot 4.0.2 source and 95 regression tests |

There are **49 backend tests plus the retained 95 tests: 144 passing checks**. See [docs/VERIFICATION.md](docs/VERIFICATION.md) for what they establish and what still needs integration testing.

## Decisions for the €200 starting balance

- Paper mode starts with virtual SOL derived from €200. The new live execution foundation buys with native SOL and returns sale proceeds to native SOL. USDC remains a price reference for the existing risk limits; it is not purchased by this route. The old USDC executor remains a compatibility/reference path.
- The normal/copy/reserve allocations remain 50%/30%/20%. The existing all-in position ceiling is 10 USDC, total exposure ceiling 20 USDC, and two open positions maximum. App amount selectors must obey these ceilings.
- The native route uses Jupiter `/build`, with `platformFeeBps=0`; this route has no Jupiter platform swap fee. DEX pool fees, network fees, rent and optional Jito tips still affect a trade. The native SOL ceiling is 0.1 SOL, and the independently priced **10 USDC all-in ceiling** can require a smaller amount. This ceiling is not a suggested buy size.
- Jito is the default native transport, with an optional direct RPC route. The backend validates instructions, simulates twice, verifies actual message fees and signs locally. Neither transport accepts arbitrary phone-supplied transactions or automatically retries an ambiguous send.
- Metered PumpPortal trade data is disabled. The default connection requests launch and migration events. DexScreener supplies batched metadata; it is a REST polling source rather than a tick-by-tick price stream.
- Fresh launches can appear in the feed. The existing policy still rejects pools younger than 48 hours and unsupported token programs. A feed listing is not an automatic-buy permission.
- Missing market cap, bonding progress or safety evidence stays unknown. A passed badge describes completed checks, never a guarantee against loss. Charts only grow from observations collected while the backend runs.
- A bundle submission is reported as **submitted**. The native receipt reader verifies the signed message and reconciles SOL input/output, token amounts, fees and rent separately. Step 2 must connect that receipt to the durable portfolio ledger before broadcasting **filled**. Latency will be measured, not hard-coded.

The archive has no funded wallet, private API keys, real trading records or deployed service. Step 1's `doctor` and `feed` commands cannot authorize transactions, even if a copied settings file requests live mode.

## Following steps

1. Completed here: backend foundations, feeds, safety and guarded execution modules.
2. Auto-pilot integration, position management, copy/normal allocations and authenticated controller server.
3. SwiftUI models, design system, WebSocket client and observed-data chart.
4. Feed, portfolio, token sheet and controller navigation.
5. XcodeGen project, GitHub build workflow and sideloading guide.

API boundaries and integration requirements are documented in [docs/INTEGRATION.md](docs/INTEGRATION.md). Primary provider documentation is linked in [docs/SOURCES.md](docs/SOURCES.md).

The native instruction parser supports the pinned venue layouts and known exact-in V1/V2 route envelopes. It refuses unsupported venues, nonzero V2 extra controls, unknown programs and Token-2022 targets. This is an explicit compatibility boundary, not a promise to trade every listed mint.
