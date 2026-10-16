# Step 4 architecture

App/FomoBotApp.swift is the actual iOS entry source. It creates TradingAppModel with a durable file command journal and Keychain credentials and forwards scene changes to the client. The entry is outside the two Swift library targets; Step 5 must include it in the application target.

| Module | Responsibility |
| --- | --- |
| TradingAppModel / TradingPresentation | Separate profiles, expected mode, screen state, exact amount choices, feed filters and clock-based freshness |
| MainTabView | Paper/Real/Copy workspace tabs and Feed/Portfolio navigation |
| FeedView | Observed feed, search, reported-only graduation filter and bounded quick buys |
| PortfolioBotView | Values, holdings, pending receipts, activity, recorded results and panic control |
| AutoPilotCard | Server-authoritative toggles, profiles, amounts and flat allocation editor |
| CopyTradingView | Explicit environment selection, source health and copied holdings |
| TokenDetailSheet | Observed chart/history, expiring evidence and buy/sell dock |
| ConnectionSetupView | HTTPS profiles, secure credential entry and unresolved-ID review |
| Components | Shared cards, exact amount choices, sparklines and separate bounded unauthenticated image requests |

Paper/live is an environment; normal/copy is a strategy. Duplicate profile endpoints are refused before modifying a credential. The client requires the expected mode before accepting portfolio data. A mode or wallet change blocks commands. Switching profile clears old portfolio/feed/chart/result data before waiting for the old socket to close. Generations/revisions prevent earlier async work restoring a previous connection.

Tab selection and view appearance issue no bot-setting or trade command. Backends continue their own configured behavior independently of the phone. Mutations use the original typed, identified command path; pending taps coalesce and unresolved outcomes remain reviewable. Presets reflect current server state, and financial controls require fresh matching snapshots.

Buy choices use Decimal/integer strings and backend ceilings. The backend still rechecks token policy, routes, fees, reserve and capital limits. Market cap never becomes position cost basis. Realized PnL is labelled as recorded results. A display clock expires data even without new frames; the client independently checks freshness at send.

Filled feedback requires the event's receipt, mint, side and signature to match a durable order snapshot. Paper remains explicit. Charts use observed timestamps, no fabricated history. Graduating needs reported progress. Avatar loading uses separate ephemeral HTTPS requests, approved hosts, no redirects/cookies/controller header, and a response bound.

Backend trading source, retained core and standalone 4.0.2 are unchanged. New backend scripts only reproduce local validation. Linux shared-core/syntax checks do not compile iOS-only branches. check-apple-types.sh covers those branches on an actual iOS SDK; native WebSocket/Keychain/UI/device acceptance remains required.
