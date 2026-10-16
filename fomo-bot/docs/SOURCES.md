# Primary documentation used for Step 1

Checked 14 October 2026. These are provider contracts, not trading-performance evidence.

| Provider | Source | Used for |
|---|---|---|
| PumpPortal | [Real-time data API](https://pumpportal.fun/data-api/real-time/) | One WebSocket; launch, migration and explicit trade subscriptions |
| PumpPortal | [Fees](https://pumpportal.fun/fees/) | Distinguishing free launch/migration data from charged trade data; leaving metered subscriptions off |
| DexScreener | [API reference](https://docs.dexscreener.com/api/reference) | Solana token metadata, market cap/FDV/liquidity fields and batching up to 30 token addresses |
| RugCheck | [Official Swagger schema](https://api.rugcheck.xyz/swagger/doc.json) | Report-summary schema, normalized score, risk levels and nullable LP-lock evidence |
| Jito | [Low-latency transaction sending](https://docs.jito.wtf/lowlatencytxnsend/) | Region endpoints, approved tip accounts, bundle submission/status, minimum tip and submission not guaranteeing landing |
| Solana | [Prioritization fees](https://solana.com/docs/rpc/http/getrecentprioritizationfees) | RPC fee samples used by the bounded fee helper |
| Solana | [Transaction fees](https://solana.com/docs/core/fees) | Compute-unit price units and priority-fee calculation |
| Jupiter | [Swap API](https://developers.jup.ag/docs/swap) | The existing quote/execution integration and route validation boundary |
| Jupiter | [Build](https://developers.jup.ag/docs/swap/build) and [API schema](https://developers.jup.ag/docs/api-reference/swap/build) | Native raw-instruction route, zero platform fee, instruction composition and compute estimation |
| Jupiter | [V2 migration](https://developers.jup.ag/docs/swap/migration/metis-to-build) | Current instruction version and basis-point route weights |
| Jupiter | [Price API](https://developers.jup.ag/docs/price) | SOL/USDC references, omitted unknown prices, decimals and chain block IDs |
| Apple | [iPhone 15 specifications](https://support.apple.com/en-ie/111831) | Device display and hardware constraints for the later native app |

Default PumpPortal launch/migration subscriptions are free under its documented data policy. Token/account trade data is charged separately. Do not assume that a free WebSocket connection makes every subscription free. The app foundation deliberately does not use PumpPortal's trading endpoints.

Jito minimum tips and rate limits constrain submission. The default local transport spacing is 1.1 seconds. Its endpoint response supplies a bundle identifier rather than a token balance receipt. The app must use chain reconciliation before showing a confirmed fill.

Jupiter documents no platform swap fee for `/build`. The project explicitly requests zero integrator fees too. Pool fees, chain fees, rent and Jito tips are separate. `/build` transactions cannot use Jupiter `/execute`; this project uses Jito or direct RPC for the native route.

The native V2 envelope checks were also compared with actual unsigned build responses on 14 October 2026. The pinned venue payload definitions remain the existing bot's `jupiter-layout.json`, with its recorded primary source. Unknown variants and nonzero extra controls are refused; layouts are not automatically downloaded or trusted during trading.

## Step 2 implementation references

Checked against primary documentation during the Step 2 work:

- Node.js HTTP server request/header/time limits: https://nodejs.org/api/http.html
- `ws` upgrade authentication, payload limits and heartbeat examples: https://github.com/websockets/ws/blob/master/README.md and https://github.com/websockets/ws/blob/master/doc/ws.md
- Jupiter Tokens V2 metadata, 100-mint search batching and category endpoints: https://developers.jup.ag/docs/tokens/token-information
- Helius filtered transaction history contract: https://www.helius.dev/docs/api-reference/rpc/http/gettransactionsforaddress

These references inform adapters; the current release uses bounded pinned compatibility and fails closed on unsupported execution layouts. No new live provider transaction was sent for Step 2.

## Step 3 references

- Apple URLSessionWebSocketTask and authenticated URLRequest transport: https://developer.apple.com/documentation/foundation/urlsessionwebsockettask
- Apple Keychain Services: https://developer.apple.com/documentation/security/keychain_services
- Apple SwiftUI gestures: https://developer.apple.com/documentation/swiftui/draggesture
- Swift.org Ubuntu toolchain distribution: https://www.swift.org/install/linux/ubuntu/24_04/
- BIS Bulletin 69 (historical context, not a Solana-strategy validation): https://www.bis.org/publications/bulletin-69-crypto-shocks-and-retail-losses

The development toolchain was Swift 6.3/Linux. Apple SDK and real-device verification are not implied by these references.

## Step 4 references

- Apple TabView: https://developer.apple.com/documentation/swiftui/tabview
- Apple scene lifecycle: https://developer.apple.com/documentation/swiftui/scenephase
- Apple item-based sheets: https://developer.apple.com/documentation/swiftui/view/sheet(item:ondismiss:content:)
- Swift Linux distribution: https://www.swift.org/install/linux/ubuntu/24_04/
- SEC/CFTC warning about guaranteed crypto returns: https://www.investor.gov/introduction-investing/general-resources/news-alerts/alerts-bulletins/investor-alerts/investor-alert-watch-out-fraudulent-digital-asset-and-crypto-trading-websites

The Step 4 changes add the consumer interface and mode checks. They do not establish a profitable strategy. Apple SDK/device acceptance is separate from the Linux checks.
