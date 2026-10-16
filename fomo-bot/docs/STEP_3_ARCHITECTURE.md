# Step 3 architecture

The Swift package separates platform-neutral protocol/connection behavior (`FomoBotCore`) from native presentation (`FomoBotUI`). It has no external Swift dependencies.

## Protocol and accounting boundary

Raw lamports/token quantities remain validated strings, including values above JavaScript's safe integer range. Conversion for display uses decimal/string operations; market-cap plotting uses numeric observations separately from trade accounting. Amounts, nullable prices, stale marks, allocations, copy health, orders and command stages are typed.

Protocol v1 envelopes are decoded by message type. Unknown read-only message types can be ignored, while unsupported protocol versions or invalid financial state block the connection. Unknown execution stages remain unresolved. Snapshot balances are checked against allocation cash, and holdings/collection sizes are bounded.

Swift-generated command variants are validated against the actual TypeScript parser. Actual local server snapshots, ACKs, chart data, fill events and strategy reports are captured as labelled synthetic fixtures and decoded in Swift tests.

## Connection lifecycle

`BotWebSocketClient` is observable and main-actor isolated. Generation counters prevent older receive/reconnect operations from overwriting a newer connection. Both state and feed snapshots are required before readiness. Commands require recent portfolio receipt.

A native URLSession socket uses an authenticated URLRequest. The session is ephemeral, does not store cookies/cache and refuses redirects. Remote endpoints require TLS; there is no certificate-trust bypass. Pings have an independent watchdog, so waiting for a ping cannot suspend the connection-health timer indefinitely. Retry delay is bounded with backoff/jitter. Authentication/protocol/storage failures require review rather than an endless reconnect loop.

Backgrounding closes the socket; foregrounding resynchronizes. Backend position protection is independent of phone execution. Endpoint preferences and Keychain credentials are separate. Avatar requests are deliberately separate and unauthenticated.

## Identified commands

The file command store writes before sending and preserves the original endpoint, wallet, mode, ID and payload. Repeated pending taps reuse the existing ID. Unknown sends survive restarts and are resolved by read-only status lookup; neither reconnect nor a timeout creates another buy.

ACKs and lookup responses merge monotonically. A late local send completion or older response cannot downgrade a terminal record. Hash/identity mismatches retain evidence and block mutation. Recent snapshot commands and bounded, rotating status lookups resolve older IDs without monopolizing requests. Missing server records remain unknown for explicit investigation.

The local journal is bounded to 1,000 records and does not automatically discard unresolved actions. The backend remains the authoritative portfolio and keeps its independent command/order journals.

## Presentation

Theme components use the requested black/dark/green/red palette, native rounded type, accessible labels and comfortable touch targets. Haptics are foreground-only, user-disableable and throttled. Fill haptics are intended only for actual durable fill events.

The chart sanitizes, sorts, deduplicates and bounds observations. Its time axis uses actual timestamps; long gaps start a new segment. Scrubbing picks an observed point rather than interpolating a price. Missing/stale states and actual observed coverage remain explicit. Fixed timeframes require collected coverage; `All` means all observed data. Accessibility adjustment and reduced-motion behavior are included.

## Remaining Apple acceptance

Shared code is compiled/tested on Swift 6.3/Linux, including native URLSession HTTP against the actual local controller. The platform-specific SwiftUI, UIKit and Security paths are syntax-reviewed but excluded from Linux type-checking. They must be built against an Apple SDK and exercised for Keychain access, visual layout, haptics, TLS/WebSocket behavior and scene transitions. Step 4 adds the screens; Step 5 adds the verified device build and installation pipeline.
