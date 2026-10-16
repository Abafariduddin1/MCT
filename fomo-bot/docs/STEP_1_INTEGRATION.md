# Restarted Step 1 interfaces

Backend version 0.2.0 implements the feed, safety and execution foundation. Step 2 supplies the trading engine, durable portfolio ledger and authenticated phone server. This boundary prevents a new interface from bypassing the existing bot's risk policy.

## Native SOL execution

`SolanaService.create(config, portfolioGate)` creates a shared metered SDK connection. `LIVE_BASE=SOL` selects `NativeSolChain`; the inherited USDC chain is retained for compatibility/reference. Production native configuration requires the existing local live opt-in and `I_ACCEPT_REAL_TRADES` acknowledgement before the encrypted vault can be unlocked. Step 1's public doctor/feed commands force read-only behavior and never unlock a wallet.

`quoteSol(side, mint, amountRaw, recentMovePct, fast)` obtains Jupiter `/build` instructions. The request selects exact-in v0 transactions, zero integrator fee, a wallet-owned destination ATA and disabled provider wrapping. The backend constructs controlled wrapping/unwrapping itself. A `fast` request can use the documented reduced-latency routing mode within the same spending and slippage limits.

The native route uses SOL as its settlement asset. USDC is queried alongside SOL only to maintain the existing USDC-equivalent risk ceilings. A cached reference must have positive prices, correct decimals, acceptable USDC peg deviation and block IDs consistent with the RPC slot. Entry sizing conservatively includes configured fee/rent allowances and uses integer rounding. Sale preparation does not require a fresh USD reference, so a valuation outage does not itself block exits.

The server's mandatory policy port is:

```typescript
interface PortfolioGate {
  assertAllowed(intent: SwapIntent): Promise<void>;
  assertPersisted(signature: string): Promise<void>;
}
```

`assertAllowed` must check the actual candidate audit, global/allocation budgets, remaining balances, entry blocks, signal age, reverse-quote affordability and configured strategy/copy policy. A sell must match an owned position and its allowed exit amount. The port runs before and after preparation. An implementation that simply returns success is not an operational trading gate.

`prepare` checks mint authorities/decimals and the matching quote. Native preparation validates known exact-in V1/V2 instruction envelopes, pinned venue payloads, top-level programs and the signer. It refuses unsupported layouts and nonzero V2 extra controls. If the API rounds a minimum up by one unit, the backend reduces the encoded tolerance; it never accepts a weaker floor to make a quote pass.

SOL is wrapped into the wallet's canonical WSOL account inside the transaction and unwrapped to the same wallet. An already funded WSOL account is outside this path and must not be silently counted or spent as native cash. Provider-supplied native transfers or authority-changing token instructions are rejected. Every transaction-referenced owned token account is covered by simulation; accounts absent from the message cannot be modified by its SVM execution. Unrelated frozen airdrops therefore do not prevent a valid exit.

Preparation first simulates an unsigned, capped compute estimate. It then constructs the final capped compute budget, reads the actual message fee, signs locally and simulates the signed transaction. Snapshot validation requires the exact SOL/token input, minimum output, unchanged unrelated token amounts, acceptable account rent and a remaining SOL reserve.

The returned `ValidatedSwap` exposes an immutable receipt. A private process-local association retains the signed bytes, payer, actual native audit, policy port and exit-budget context. A serialized clone cannot authorize submission. Private keys and signed transactions must not appear in phone payloads or logs.

## Submission and settlement

The engine must save the pending intent and native audit before sending. `assertPersisted` verifies that exact signature and intent against the durable ledger. Acquire a single writer/run lock before constructing an operational engine.

Use one transport for each intent:

- `JitoExecutor.send` submits a one-transaction bundle with only the locally checked wrapping transfer and a tip to a pinned Jito recipient. Its endpoint requests are spaced at 1.1 seconds by default.
- `RpcExecutor.send` submits the checked native transaction through RPC with preflight enabled and `maxRetries=0`. This path adds no Jito tip.

`/build` transactions cannot use Jupiter `/execute`. The old USDC `/order` path is a separate compatibility route; never connect its accounting directly to a native receipt.

Both native transports use `SubmissionJournal`. A synchronous exclusive reservation rereads the on-disk journal before claiming a signature, so two executor instances cannot race into duplicate submission. The shared journal records hashes and signatures, not signed bytes. Prior Step 1 Jito receipts are respected too. A crash can leave a lock requiring explicit reconciliation; the backend does not erase it to continue trading.

An accepted transport response is **submitted**. A timeout or ambiguous response remains **unknown** and must not be automatically retried or replaced with a second order. After a restart, reconcile the existing signature instead of preparing another purchase.

`NativeSolChain.settlement` waits for the requested commitment, verifies the message's wallet/signature, and derives token and native balance effects from the receipt. It reports exact input/output units, network fee, Jito tip and net rent change separately. A bundle ID or `Landed` label is not a fill. Step 2 must apply the reconciled effect once to its ledger, persist it and then emit a fill alert.

Native receipts contain `baseDelta`, not a fabricated `usdcDelta`. A buy debits its SOL swap amount; a sale credits gross swap SOL, with fees/rent recorded separately. The old live USDC engine is not native-compatible merely because the app displays SOL. The paper SOL implementation, copy decoder and strategy/risk rules can be reused while the live ledger is integrated.

## Quotas, fees and data freshness

`SolanaService.rpcFetch` must also be used by the controller's history client. `withExitBudget` reserves access for exits and reconciliation; submission already restores its preparation intent's exit context. Existing copy-history and stream quotas remain relevant.

RPC weights are local estimates: basic calls count as one, program-account calls as ten, and full history pages as ten per requested hundred rows. Provider dashboards remain authoritative for billed credits. Other processes, service plans, stream bytes and in-flight events can affect actual usage. Default local RPC allowance is 25,000 credits/day including a 1,000-credit exit reserve. RugCheck summaries have a separate 500-request daily cap.

Jupiter price and build requests share a queue because the organisation's API rate limit is shared. Step 2 must integrate any additional discovery requests with that same organisation-level limit rather than creating competing queues.

Compute-price suggestions and the optional Jito tip-floor source are bounded. The minimum configured tip remains capped if the source is unavailable. Entry/exit slippage can adapt to a server-observed recent movement, within the existing maximum. No preset may silently raise fee budgets or enable a paid subscription.

Free PumpPortal launch/migration notifications seed discovery. Trade subscriptions require explicit opt-in and a key; they are disabled by default. Optional metered counters include malformed and duplicate trade events and stop at the local limit, although a local counter cannot prevent messages already in flight from being billed.

DexScreener metadata is batched in groups of at most thirty mints. Market cap and FDV are separate nullable values. Boosted tokens are discovery hints, not volume or safety proof. Charts append observed, timestamped samples only. A metadata-only Pump event does not renew an old market-cap timestamp. Market refresh continues while a separate bounded safety worker waits for reports.

## Safety and strategy boundaries

Safety evidence includes classic SPL support, revoked mint/freeze authorities, top-ten token-account concentration, minimum age/liquidity, RugCheck risk/score and reported LP locking. Token accounts are not beneficial-owner attribution. Missing evidence remains unknown. A passed badge requires completed checks, fresh market-audit data and an unexpired report; fresh liquidity/age failures override old passed badges.

Use **Checks passed**, **Checks failed** or **Not verified** in the app. Provider evidence is incomplete protection. The expanded checklist must preserve unknown states. The existing holder count, volume, verification, organic score, signal, reverse-quote and affordability rules still apply at entry.

The retained default policy rejects pools younger than 48 hours and Token-2022 targets. Fresh launches can be displayed; a feed listing does not authorize a buy. Any preset that changes launch eligibility requires explicit, tested policy support. Fast/Degen labels cannot quietly bypass mint, spending or unsupported-program checks.

Very small trades can be refused because rent, slippage and pool fees make their round-trip cost too high. Do not force a purchase simply because the scanner found candidates. UI amount choices must reflect actual affordable size, not the rough prompt's 0.25–1 SOL defaults.

## Step 2 controller requirements

- Preserve normal/copy/reserve allocations of 50%/30%/20%, with adjustable validated allocation settings and the existing global limits. Never treat a leader's activity as evidence of a 400-day profit record.
- Authenticate controller connections, validate all payloads and use persisted unique command IDs for money-changing requests. Keep keys, raw signed transactions and private RPC URLs on the backend.
- Bind to loopback by default. A phone connection needs a separately configured HTTPS/WSS endpoint or private tunnel; do not expose an unauthenticated port.
- Persist mode, allocations and positions. Resolve the current state on reconnect rather than replaying a buy command. Use explicit pending/unknown states for ambiguous execution.
- Position monitoring may schedule at 500 ms with cached quotes and bounded refreshes. It does not establish a 500 ms price-update or fill guarantee.
- Panic mode first disables normal/copy entries, then requests serialized bounded exits for actual positions. Keep failed and pending exits visible. Native SOL liquidation returns SOL, not fiat.
- Store token quantities and actual entry costs. Position PnL must use token valuation/executable proceeds; a market-cap ratio alone can be misleading when supply changes.
- Record SOL and reference USD/EUR values separately. Reference-driven portfolio movement is different from realized trading PnL. Quota days use UTC; the consumer's reporting-day/timezone must be explicit.

## Steps 3–5 native app requirements

Keep the requested two tabs and token sheet, OLED palette, rounded typography, haptics, observed-data chart and compact controls. The device controls the display refresh rate; a base iPhone 15 cannot gain a 120 Hz display from app code.

Amounts, market cap, bonding progress, safety evidence and charts can be missing. Show their unknown states and actual server mode. A trade tap can acknowledge receipt immediately; only a reconciled fill can show a successful trade toast. Paper fills must be clearly marked simulated, and latency must be measured.

The sideloaded app is a controller; the laptop backend continues its exits while the phone is locked. ntfy/Telegram can deliver alerts through a separately installed notification client. A webhook alone does not give the custom sideloaded app native APNs delivery.

Step 5 supplies the XcodeGen project and GitHub build workflow after the Swift project exists. Signing/sideloading and the currently supported runner will be verified then. Never put wallet or backend service secrets in an IPA or build artifact.
