# FomoBot — backend setup on Windows

Current backend: **0.3.1**. Use `STEP_3_SETUP.md` for the new Swift package, performance report and current verification.

Step 2 adds the trading controller and authenticated server. The iPhone screens and IPA are later steps. You can run and control this backend from your Windows laptop now.

## 1. Open the correct folder

Extract the full handoff ZIP into a new folder. Keep your existing bot installation, private `.env` and saved trading records.

Open **source → fomo-bot → backend** in File Explorer. Click the address bar, type **cmd**, then press Enter. Run each command separately:

```bat
node --version
npm.cmd ci --ignore-scripts
npm.cmd run build
npm.cmd test
```

Use Node 24 or newer. The tested environment was Node 24.19.0 on Linux; Windows and a real phone have not been tested in this build. The expected test summaries are **90 backend tests** and **95 core tests**, with zero failures. The tests use fixtures and local connections, not real trading funds.

## 2. Add your local settings

In the same Command Prompt:

```bat
if not exist .env copy .env.example .env
notepad .env
```

Set your own `JUPITER_API_KEY` and `RPC_HTTP_URL`. Keep:

```dotenv
MODE=paper
ENABLE_LIVE_TRADING=false
PAPER_BASE=SOL
LIVE_BASE=SOL
PAPER_BALANCE_EUR=200
APP_HOST=127.0.0.1
ALLOW_METERED_PUMP_DATA=false
```

The example retains the previously selected public copy-leader address. Check `COPY_LEADER` before enabling copying. An address is not evidence of a successful trading record.

Generate the controller credential:

```bat
npm.cmd run token:create
```

Copy only the generated token into `APP_ACCESS_TOKEN=` in your local `.env`. Keep it private. It authorizes commands for this backend; do not put it in a URL, screenshot or source archive. Do not paste wallet keys into chat. The paper controller does not need a wallet vault or unlock key.

Save `.env` and make sure Notepad did not call it `.env.txt`.

## 3. Start the controller

```bat
npm.cmd start
```

Leave that window open. Startup prints `status: listening`, `mode: paper`, and the host/port. Auto-pilot starts off on a new ledger. A restarted ledger preserves its previous settings.

Paper mode uses virtual SOL. On the first run, the configured EUR amount is converted using a current SOL reference and an ECB EUR/USD reference (or your explicit reference setting). The result is saved once. Reconnecting does not reset the portfolio or add another €200.

Market data still uses your provider quota. Stop the old standalone bot if it uses the same provider account while you evaluate this controller.

Open a **second** Command Prompt in the same `backend` folder:

```bat
npm.cmd run controller -- status
```

You should see the actual mode, balances, allocations, positions, pending orders and copy-health status. No positions may simply mean no candidate passed the policy.

## 4. Use the local controls

These commands talk to the running controller. Check `mode` in status before issuing a trade command.

| Action | Command |
| --- | --- |
| Read portfolio and health | `npm.cmd run controller -- status` |
| Read the discovery feed | `npm.cmd run controller -- feed` |
| Pause new entries; keep protection active | `npm.cmd run controller -- pause` |
| Resume manual entries after an ordinary pause | `npm.cmd run controller -- resume` |
| Turn automatic entries on, normal strategies only | `npm.cmd run controller -- preset Safe on normal 0.05` |
| Turn automatic entries on, normal + configured copying | `npm.cmd run controller -- preset Safe on copy 0.05` |
| Turn auto-pilot off; keep protection active | `npm.cmd run controller -- preset Safe off normal 0.05` |
| Request a bounded buy | `npm.cmd run controller -- buy MINT_ADDRESS 0.05` |
| Sell half a managed position | `npm.cmd run controller -- sell MINT_ADDRESS 5000` |
| Sell a whole managed position | `npm.cmd run controller -- sell MINT_ADDRESS 10000` |
| Disable new entries and sell managed tokens to SOL | `npm.cmd run controller -- panic` |
| Read a previous command's durable status | `npm.cmd run controller -- command COMMAND_ID` |

Replace `MINT_ADDRESS` with the token's actual mint. The requested `0.05` is an example in SOL, not a promise it is affordable. Automatic orders can be reduced to fit the limits; manual orders above the permitted size are rejected. The server reports conservative `maxAffordableBuyLamports` values.

A command acknowledgment is not a fill. Read its later status or portfolio update. If a request times out, look up the original command ID; do not issue a fresh ID to retry the same purchase. For scripted retries, set `COMMAND_ID` to the same ID. Reusing it with different content is rejected.

The default 50% normal / 30% copy / 20% reserve allocation is saved. The protocol supports explicit reallocation only when flat, with no pending transaction and auto-pilot off. It preserves loss history and halts.

`panic` returns token-sale proceeds to SOL. It does not convert SOL to EUR, transfer to a bank or sell unrelated wallet assets. Failed and unresolved exits remain visible. `resume` cannot clear an unfinished panic or a loss-budget halt.

## 5. Understand the current profiles and limits

| Profile | Default target behavior | Remaining tokens |
| --- | --- | --- |
| Safe | Sell the full quantity at the configured take-profit target | None after a completed target exit |
| Fast | Sell 50% once at that target | Existing stop, trailing stop and time limit continue |
| Degen | Sell 75% once at that target | Existing stop, trailing stop and time limit continue |

All profiles retain the same token checks, allocations, fee ceilings, slippage limits and risk caps. Their names do not indicate a safety guarantee. The profiles use the configured normal strategies; Fast/Degen may request the supported faster build route. A profile change applies to future entries. Existing positions retain their recorded exit plan.

Defaults remain an 8% stop, 16% take-profit target, trailing activation at 10% and trailing distance of 6%. They are evaluated against estimated net sale value and recorded cost. They cannot guarantee an execution price.

Tokens must still pass the complete policy, including classic SPL support, revoked authorities, minimum 48-hour pool age and the other configured liquidity/holder/volume/verification checks. A token can appear in the feed and still be blocked from buying. Unknown evidence stays unknown.

The scheduler checks cached protection decisions every 500 ms. Network quotes and confirmation take longer. Discovery, reference prices and quotes share a bounded Jupiter queue; exits have priority. A request already on the network cannot be preempted.

## 6. Stop, restart and recover

Press **Ctrl+C** in the controller window. It closes the server and workers and releases its ledger lock after outstanding work finishes.

The portfolio lives at:

```text
backend/state/controller/paper/ledger.json
backend/state/controller/live/ledger.json
```

Back up the entire `state` directory and your private configuration locally. Do not delete the ledger, change its amounts or copy a standalone USDC state into it. Old/unknown formats are rejected. There is no automatic standalone-portfolio migration.

If a crash leaves **the controller's ledger lock**, stop the previous controller process, then run:

```bat
npm.cmd run lock:recover
npm.cmd start
```

Recovery checks that the recorded process no longer exists on this computer and archives only that controller lock. It refuses an active process or an unverifiable owner. It does not clear a quota lock or submission-journal lock. Those need separate investigation.

Signed pending orders are reconciled by their existing signature after restart. A timeout, missing receipt or ambiguous response is not treated as failure and is never resubmitted automatically. If no authoritative receipt becomes available, the order remains unresolved and blocks further financial actions. Preserve its records for investigation; changing IDs or deleting state is not a recovery method.

Loss-budget halts are deliberately latched. A phone toggle does not clear them. External deposits/withdrawals and changes to `COPY_LEADER` require explicit reconciliation; they are not silently folded into the saved portfolio.

## 7. Phone access and optional alerts

The local address is for testing on the laptop. `127.0.0.1` on an iPhone refers to the phone itself.

For later phone access, use an authenticated HTTPS/WSS connection: either keep the server on loopback behind a properly configured private TLS endpoint, or provide `APP_TLS_CERT` and `APP_TLS_KEY` before selecting a non-loopback `APP_HOST`. The server refuses a non-loopback binding without TLS files. Certificates must be trusted by the phone. Do not open an unauthenticated port.

The future Swift client will send `Authorization: Bearer …` during WebSocket upgrade. Browser origins are refused by default. Connection setup and Keychain storage are Step 3 work.

Telegram delivery is optional and disabled when its two settings are blank. If you later choose to use it, configure your own `TELEGRAM_BOT_TOKEN` and numeric `TELEGRAM_CHAT_ID` locally. Alerts are sent only after durable trade events; a failed notification never retries a trade. These alerts use Telegram's client, not native push in the unfinished iPhone app. No notification was sent in development.

The guarded native live path is integrated, but no funded trade or mainnet latency measurement was performed. Keep this release in paper mode while evaluating it. This package contains no IPA; the next development step is the Swift client foundation.
