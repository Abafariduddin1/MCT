# Step 5 Verification & Acceptance Checklist

## 1. Local Pre-Push Verification (Windows)

Run from `source/fomo-bot/backend` in Command Prompt:

```bat
npm.cmd ci --ignore-scripts
npm.cmd run build
npm.cmd test
npm.cmd run verify:swift
node scripts/verify-ios.mjs
```

Expected local results before pushing to GitHub:
- Backend TypeScript compiles cleanly (`dist/`).
- Backend test suite and 95 retained core tests pass with 0 failures.
- All 6 Swift command fixtures validate against the backend protocol parser.
- Source comparison confirms `backend/core/` matches standalone `4.0.2` byte-for-byte.

## 2. Cloud macOS Build Verification (GitHub Actions)

Inspect the downloaded `build-logs/` directory inside the `FomoBot-IPA` artifact:
- `toolchain.txt`: Confirms macOS 15, Xcode 16+, Swift 6, iOS SDK version, and XcodeGen version.
- `apple-syntax.log` & `apple-types.log`: Confirms all `FomoBotCore`, `FomoBotUI`, and `FomoBotApp` files type-check against the real Apple iOS SDK (resolving the Linux-only verification gap from Steps 3–4).
- `swift-tests.log`: Confirms the `FomoBotCoreTests` suite passes on macOS.
- `xcodebuild.log`: Confirms `FomoBot.app` compiled in `Release` configuration for `generic/platform=iOS` (`arm64`).
- `SHA256SUMS.txt`: Records the exact SHA-256 hash of `FomoBot.ipa`.

## 3. On-Device iPhone Acceptance (Paper Mode)

With `MODE=paper` and `ENABLE_LIVE_TRADING=false` on the laptop:
1. **Launch & Keychain Setup**: App opens on iPhone in dark mode without letterboxing; saving the `https://` endpoint and `APP_ACCESS_TOKEN` persists the token in Keychain and transitions to `Ready` after receiving `PORTFOLIO_UPDATE` and `FEED_UPDATE`.
2. **Feed & Token Sheet**: Feed displays observed tokens, safety statuses (`pass`/`fail`/`unknown`), and age/liquidity blocks; tapping a token opens `TokenDetailSheet` and scrubs real timestamped chart points.
3. **Paper Trade & Idempotency**: Tapping an affordable Quick Buy sends a single persisted command ID, transitions through ACK to `Paper fill`, and updates the portfolio tab without duplicate orders on rapid taps.
4. **Scene Lifecycle & Reconnect**: Locking/backgrounding the iPhone suspends the socket while the laptop continues 500 ms exit monitoring; unlocking the iPhone reconnects and fetches an authoritative snapshot without replaying old buys.
