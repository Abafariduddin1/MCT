# Step 2 implementation

The controller uses one persistent native SOL ledger. It does not pass native receipts into the retained USDC engine. The standalone bot and its 4.0.2 core files are preserved unchanged.

## Modules

| File | Responsibility |
| --- | --- |
| `controller.ts` | Startup, providers, workers, shutdown and paper/live initialization |
| `botEngine.ts` | Operational PortfolioGate, commands, strategy entry, exit monitoring and reconciliation |
| `ledger.ts` | Exclusive writer, atomic validated state, native accounting and receipt application |
| `controllerTypes.ts` | Portfolio, order, command, quote and provider interfaces |
| `controllerCore.ts` | Typed bridge to retained strategy/history/stream modules |
| `controllerProviders.ts` | Actual token-policy metadata, safety evidence, shared provider services and guarded transports |
| `copyController.ts` | Future-only baseline, overlap, durable claims, queued sales and source health |
| `server.ts` / `protocol.ts` | Authentication, strict payload validation, limits, snapshots and persistent command IDs |
| `notifications.ts` | Optional bounded post-event notification delivery |
| `scripts/controller-client.mjs` | Local controls before the native app exists |

## Money and execution

Cash, token quantities, remaining cost basis and pending reservations use integer strings. The ledger validates both allocation cash conservation and:

`cash + remaining position cost = external funding + realized trading result`

Entry cost includes actual fees and net rent outflow. Partial sales allocate cost by integer proportion; the last sale takes the residual cost exactly. Failed transactions debit actual fees. Rent is recorded separately and conservatively included in trade cost; retained token-account rent is not presented as immediately spendable cash.

One unresolved order blocks further financial orders. Its durable reservation is shown separately from gross cash. Control commands, especially pause/panic, can still disable entries while preparation is in flight. The gate rechecks them before submission.

The live gate verifies current complete token evidence, original policy metadata, signal freshness, copy claim where applicable, own-size reverse quote, price-chase ceiling, expected round-trip cost, SOL reserve, allocation cash, all-in USD-equivalent position/exposure/risk caps, position/day counts, cooldowns and halts. Sell intents must match a managed position. Execution still passes through the Step 1 mint/route/simulation/native-audit checks.

The exact signature, audit and order are saved before either transport is called. Signed bytes stay inside the process-local validated executor object. Unknown outcomes are not retried, replaced or inferred to have failed from a missing receipt. Reconciliation books a successful or failed receipt once; confirmed effects remain blocked until a matching finalized receipt. A disagreement latches a halt and preserves the evidence.

The current ledger has no import/reset/deposit/withdrawal command. Initial live funding is explicitly recorded, bounded by the configured first-wallet cap, and matched to a dedicated wallet. Later external cash/token differences block execution pending reconciliation. This avoids silently adopting an existing standalone portfolio or unrelated wallet holdings.

## Strategy and worker behavior

The normal signal engine, verified swap decoder, finalized version-1-capable history request contract and account-stream implementation come from the retained core. Fresh policy metadata is fetched for entry; feed badges alone cannot authorize a purchase.

Copy history runs through the same metered RPC fetch wrapper. Each page attempt also reserves its feature-specific budget, with no hidden page retries. It retains slot overlap and durable claims. A leader sale is saved atomically with its claim and can wait for a follower buy's final receipt. A sale later in the same scan suppresses an older buy. Stale buys are skipped. History/stream failures block copying and request protective handling of copied holdings, without disabling independent normal strategies.

A 500 ms nonoverlapping monitor makes cached exit decisions. Quote refresh runs as a separate bounded job, so a slow refresh does not hold the timer. Pending receipts and requested exits take priority. Existing in-flight network work cannot be interrupted. A 15-second retry delay bounds repeated failed exit preparations, while the holding remains visible.

All Jupiter work shares one priority/rate queue. Urgent exits rank ahead of discovery. Older background discovery gets a turn so repeated metadata refresh cannot starve it. No preset enables paid subscriptions or raises hard limits. The integrated discovery batch rotates through the configured bounded candidate pool.

## Persistence and limits

The ledger has schema version 1, mode, base, wallet identity, Europe/Dublin reporting days, UTC quota days, positions, reference/FX snapshots, command IDs, order receipts, copy coverage and event records. A single-writer lock and copy-on-write transactions guard every update. File contents and, where supported, the parent directory are fsynced before mutation returns.

Commands/orders are retained up to 10,000 each; the controller fails closed instead of evicting old IDs and allowing a replay. The executor submission journal retains its existing 5,000-entry limit. The live event window is 500 events; order/receipt history remains separate. Archive/migration beyond these limits requires an explicit reviewed procedure.

A crash lock can be archived only through the local recovery command after confirming its recorded process is dead on the same computer. This operation never erases financial or submission records. Unknown pending signatures without an authoritative eventual receipt need manual investigation; automatic abandonment is intentionally absent.

## Network boundary

HTTP and WebSocket traffic require a generated bearer credential. The default bind is loopback. Non-loopback binding requires TLS files. The server authenticates before WebSocket upgrade, limits frame/body/header sizes and connection/request counts, coalesces state updates, uses heartbeat checks and disconnects slow clients. Browser origins and query credentials are refused by default.

No wallet unlock/mode change/funding transfer is available through the protocol. Telegram delivery is opt-in, occurs after a durable event, has separate retry/backoff and never shares the financial transaction path. Delivery can repeat after a notification crash; the trade cannot.

## Validation boundary

Automated tests cover native accounting, command replay, invalid payloads, auth, read-only startup, policy failures, source claims, partial exits, fee-only failures, persist-before-send, crash recovery, finality disagreement, panic behavior, queue fairness and notification isolation. Existing execution tests still exercise the guarded native route/receipt modules.

This is engineering validation with fixtures and loopback sockets. It does not establish mainnet execution, production security, strategy profitability, sub-second fills, Windows device behavior, remote TLS connectivity, Telegram delivery or an iPhone build. Those require separate acceptance work in the relevant environment.

## Step 3 changes

Backend 0.3.1 now reserves exit-fee cash per allocation/managed position before entry. Partial sales cannot consume fee funding required by remaining holdings. Paper fee checks use the configured paper charge; live checks retain their ceiling. `performance.ts` reconstructs net strategy results from recorded receipts through authenticated read-only endpoints, with partial exits and unfinalized effects represented explicitly. See the Step 3 guides for the Swift client and current verification.
