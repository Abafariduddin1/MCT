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
