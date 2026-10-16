# Step 4 — screens and trading tabs

The cumulative source now includes the native screens and application entry. Backend runtime remains **0.3.1**; standalone remains **4.0.2**.

## The trading tabs

| Tab | Behavior |
| --- | --- |
| Paper trading | Uses the saved paper backend and virtual funds. Feed and Portfolio are available. |
| Real trading | Uses a separately saved live backend. Commands require a matching live snapshot. |
| Copy trading | Shows the leader, source health, allocation and copied holdings, with an explicit Paper/Real environment selector. |

Copy is a strategy that works in either environment. Selecting a tab does not activate auto-pilot, change server mode, place a trade or stop another backend. The app starts in Paper. Backends retain their own saved settings.

The app contains feed filters/search, market-cap rows, observed charts, bounded quick buys, portfolio values, normal/copy controls, allocation editing, partial/full sells, exit plans, pending/failed actions, and recorded results after costs. A passed check badge is not a guarantee. The existing 48-hour/classic-SPL policy still blocks unsuitable new launches.

No strategy guarantees profit. Existing momentum/breakout/pullback and guarded copying remain; no new strategy or larger risk limit was introduced.

## Windows backend update

Stop the running process. Back up its private settings, complete state directory and wallet/vault locally. Extract into a new folder. When updating a controller, use the intended existing state/configuration paths; do not reset a financial ledger.

In File Explorer open **source → fomo-bot → backend**. Type **cmd** in the address bar and press Enter. Run each command separately:

```bat
npm.cmd ci --ignore-scripts
npm.cmd run build
npm.cmd test
npm.cmd run verify:swift
```

Expect **90 backend tests**, **95 retained core tests**, and all six command variants accepted. These checks do not contact a trading provider or use real funds. Use STEP_2_SETUP.md for existing provider settings/token generation. Preserve an existing .env; keep MODE=paper and ENABLE_LIVE_TRADING=false during evaluation.

```bat
npm.cmd start
```

From a second Command Prompt in the same folder:

```bat
npm.cmd run controller -- status
npm.cmd run controller -- performance
```

Leave the laptop awake and connected for exits. Stopping the laptop/backend stops monitoring. The phone never needs wallet keys, vault unlock keys or provider keys.

## Connection and installation

**These are app source files. Step 5 is still needed to build the app and obtain an IPA. This package cannot be installed directly on an iPhone.**

Once built, Connection settings accepts a profile's trusted HTTPS endpoint and generated controller token. Tokens go into Keychain; endpoint preferences contain no credential. Reconnect reuses a saved credential.

Paper and Real require different endpoint identities, such as different trusted hosts/ports. The corresponding backend must already be configured locally in that mode. A mismatch blocks commands. The app cannot enable live execution, unlock/fund a wallet or switch a server's mode.

127.0.0.1 on an iPhone is the phone. Laptop access needs a trusted private HTTPS/WSS endpoint or correctly configured TLS binding. None was deployed here. Plain remote HTTP, query credentials and certificate bypasses are refused.

If operating both controllers with one provider account, use different ports and a shared absolute APP_STATE_DIR for the local aggregate RPC counter. Mode-specific ledgers stay separate. Other traffic and stream counters are not a complete provider bill. Do not run competing funded engines over one wallet.

The feed/position fields expire visibly when updates stop. MAX is the backend-permitted ceiling, not the wallet balance. Token/quote/cost checks still run on the backend. Manual buys use the normal allocation. Copy controls and funds are labelled by environment.

Pause new entries keeps protection active. Resume new entries is available after panic liquidation is complete; it does not clear loss halts.

Interrupted commands retain their original IDs in Activity/Connection settings; reconnect never repeats a buy. An ACK/submission is not a fill. Fill feedback must match a durable order receipt. Paper fills stay labelled. Sell all requests liquidation of managed tokens to SOL; it does not convert SOL to euros and unsold holdings remain visible.

## Native verification

With Swift 6 on PATH, run from backend:

```sh
npm run verify:ios
```

This builds the backend, starts an actual local virtual-paper fixture, runs Swift tests/native HTTP authentication, validates freshly encoded commands, builds the shared core in Release, checks source syntax and cleans up the temporary credential/server. It uses no provider or wallet credentials. Windows backend-only checks above do not need Swift.

Linux results: **41 Swift tests passed**, with **one additional native WebSocket test explicitly skipped**. Linux FoundationNetworking returned unsupported URL (-1002) for WebSockets. Mock client lifecycle tests and actual Node WebSocket server tests pass; Apple native transport acceptance remains separate.

On macOS with Xcode and its iOS Simulator SDK, run from ios:

```sh
sh Scripts/check-apple-types.sh
```

This type-checks the actual iOS branches and App/FomoBotApp.swift. It has not run in this Linux environment. Then run npm run verify:ios from backend on Apple tooling to exercise its native WebSocket.

Device acceptance must cover Keychain, trusted TLS/WebSocket/reconnect, scene changes, Dynamic Type/layout, chart scrubbing, one identified paper command, pending states and fill feedback. Step 5 provides the project/build/IPA/install workflow. No Apple SDK compilation, installed iPhone run, remote TLS deployment, funded trade, measured return or profit guarantee is claimed here.
