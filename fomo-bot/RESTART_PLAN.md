# Supplied prompt — implementation order

The development restart follows the requested five steps. Each delivered archive is cumulative. Development pauses after each step until the user requests continuation.

| Step | Required files and features | State |
|---|---|---|
| 1 | `package.json`, `tsconfig.json`, `solana.ts`, `pumpStream.ts`, `jitoExecutor.ts`; provider safety, native SOL execution and supporting modules | Complete in backend 0.2.0 |
| 2 | `botEngine.ts`, `server.ts`; durable native SOL ledger, normal/copy allocations, presets, TP/SL, authenticated command protocol and notifications | Next |
| 3 | `Models.swift`, `Theme.swift`, `Haptics.swift`, `BotWebSocketClient.swift`, `GlowingLineChart.swift` | After Step 2 |
| 4 | `FeedView.swift`, `PortfolioBotView.swift`, `TokenDetailSheet.swift`, `MainTabView.swift` and application entry point | After Step 3 |
| 5 | `project.yml`, `.github/workflows/build-ipa.yml`, signing/sideloading guide and verified build instructions | After Step 4 |

The requested visual direction remains: black background, rounded cards, market-cap-first rows, two tabs, native sheet and simple bot controls. Size options will fit the €200 budget and backend limits. The system will report measured execution states rather than fabricated fill times or profit figures.

The laptop hosts the backend during development. Step 1 requires no paid VPS, new computer, wallet funding or subscription upgrade. Its local install/tests are usable now; phone connection and trading controls are intentionally introduced in their following steps.
