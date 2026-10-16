# Step 3 — Swift client foundation

Step 3 supplies the native client libraries. The cumulative package also includes backend **0.3.1**, with exit-fee funding and recorded performance by strategy.

The full iPhone screens and app entry point are Step 4. The Xcode project, IPA pipeline and installation check are Step 5. This package does not contain an IPA.

## Included Swift code

Open the `ios` folder as a Swift package. It contains two products:

| Product | Files and behavior |
| --- | --- |
| `FomoBotCore` | `Models.swift`, exact amounts, commands, endpoint validation, Keychain credentials, endpoint preferences, durable command journal, `BotWebSocketClient.swift`, native transport and observed chart data |
| `FomoBotUI` | `Theme.swift`, `Haptics.swift`, `GlowingLineChart.swift` and reusable status/amount/button components |

The package uses Swift 6, with iOS 18 / macOS 15 minimums. It is compatible in scope with the requested iPhone 15 running iOS 26; actual device compilation and operation have not yet been verified.

The palette is OLED black, dark cards, green/red accents and native rounded type. Components support Dynamic Type and accessibility labels. The chart uses real timestamped observations, leaves long gaps visible, supports nearest-point scrubbing and enables fixed timeframes only when their coverage exists. `All` means all collected observations. It never fabricates earlier prices or lifetime history.

## Windows backend update

Keep the existing Windows instructions in `STEP_2_SETUP.md`. Stop the running backend before updating. Back up its entire private `state` folder and configuration locally. Preserve any existing vault and its configured path. Extract into a separate folder and use the intended existing state/configuration; do not replace a live portfolio with a fresh ledger.

From `source/fomo-bot/backend`, open Command Prompt and run each command separately:

```bat
npm.cmd ci --ignore-scripts
npm.cmd run build
npm.cmd test
npm.cmd run verify:swift
```

Expected results: **90 backend tests**, **95 retained core tests**, and six Swift command variants accepted by the actual parser. No real trade is sent by these checks.

Keep paper mode while evaluating. Start/read the controller as before:

```bat
npm.cmd start
```

In a second Command Prompt in the same folder:

```bat
npm.cmd run controller -- status
npm.cmd run controller -- performance
```

The new report groups recorded results by entry strategy and allocation. Fees, rent, failed transaction fees and partial exits are accounted for. A position counts as a closed trade once, after its remaining quantity is sold. Open positions are shown separately. Confirmed effects awaiting finality are flagged. These are observed results, not a backtest or forecast.

Backend state schema remains 1; existing Step 2 controller records are retained. The update does not import standalone ledgers, reset losses or change the default allocation/risk policy.

## Connection and command behavior

A connection needs both an authoritative portfolio snapshot and feed snapshot before it becomes ready. Recent portfolio data is required for a command. The app client:

- Sends its bearer credential during the WebSocket handshake; remote endpoints require HTTPS/WSS.
- Stores credentials in device-only, unlocked Keychain entries. Ordinary preferences contain only the endpoint.
- Saves a unique command ID locally before attempting a send.
- Coalesces repeated pending taps and blocks overlapping financial actions.
- Retains an interrupted action and looks up its original ID after reconnect. It never automatically resends a buy.
- Preserves terminal command status against late send completions or stale lookup responses.
- Suspends the socket on backgrounding and obtains fresh snapshots on return. The laptop continues position protection.
- Validates protocol version, raw amount strings, portfolio structure and frame bounds.
- Uses separate unauthenticated image requests; controller credentials are never attached to avatar/CDN requests.

The Step 4 app will supply the connection form, construct the file journal in Application Support, save the credential through `KeychainCredentialStore`, and connect the observable client to the screens. Call `setForeground` from scene changes. Trade feedback must be driven by validated durable fill events; an ACK or submission is not a successful fill. Paper fills must remain labelled simulated.

A loopback HTTP/WS exception exists only when explicitly requested for local tests. `127.0.0.1` on an iPhone points to that phone. Use a trusted HTTPS/WSS endpoint for laptop-to-phone access; do not disable certificate validation.

## Validate the Swift package

On a machine with Swift 6 installed, from `source/fomo-bot/ios`:

```sh
swift test -j 1
swift build -c release --target FomoBotCore
sh Scripts/check-apple-syntax.sh
```

The normal unit suite has **28 tests**. An additional native HTTP integration test runs when `FOMOBOT_LOCAL_PROBE_FILE` is set; otherwise that one test is explicitly skipped.

To enable it, build the backend, then run this local virtual-data fixture in another terminal from `backend`:

```sh
node scripts/serve-swift-fixture.mjs /absolute/private/temporary/probe.json
```

Set `FOMOBOT_LOCAL_PROBE_FILE` to that file in the Swift-test terminal and run `swift test -j 1`. The file contains a temporary test credential: keep it private and stop the fixture with Ctrl+C after testing. The fixture uses no external provider or trading wallet.

The development run enabled this fixture: **29 Swift tests passed, no failures or skips**. It also built the shared core in Release mode and passed the Apple-component syntax check. SwiftUI/UIKit/Security code still requires a build with an Apple SDK. Linux builds exclude those platform-specific implementations; syntax validation is not Apple SDK type-checking.

For codec checks, `npm.cmd run fixtures:swift` regenerates synthetic real-server frames after a backend build. Swift tests can emit their encoded command variants using the `FOMOBOT_CODEC_OUTPUT` environment variable; `verify:swift` validates the shipped variants without executing them. Fixture data is clearly synthetic and is never a production portfolio source.

## Changes aimed at better execution

The backend now leaves each allocation enough SOL to pay for exits before allowing an entry. It also rejects a partial sale that would consume fee cash needed by the remaining holding. Paper checks use the configured paper fee; live checks retain the live fee ceiling. The idle reserve is not borrowed.

This fixes an execution gap; it does not establish higher returns. `docs/STRATEGY_REVIEW.md` explains the current evidence and how to compare recorded results after costs before changing the trading rules.
