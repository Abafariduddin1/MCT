# Step 4 verification

Environment: Node 24.19.0, Swift 6.3/Linux, Swift 6 language mode.

| Check | Result |
| --- | --- |
| Backend build/tests | 90 passed |
| Retained core tests | 95 passed |
| Swift tests with actual local HTTP fixture | 41 passed; one additional native WebSocket test skipped |
| Fresh Swift command encoding through actual backend parser | Six variants accepted; none executed |
| Shared core Release build | Passed |
| Screen/app entry syntax | Passed |
| Apple iOS SDK type-checking / installed iPhone | Not available in this Linux environment |

**226 test cases passed; one platform-specific test skipped.** Retained core tests are counted once. This is engineering verification, not a trading return.

New checks cover separate profiles, wrong-mode servers, changed wallet identity, clearing old data, Copy retaining its environment, consistent tab labels, no implicit auto-pilot activation, duplicate endpoints, stale displays blocking actions, exact affordable amounts, reported-only graduation and matching durable fill evidence. Prior duplicate-tap, original-ID recovery, background and interrupted-send tests remain.

verify:ios starts an actual loopback virtual-paper controller in the same process environment as Swift. Native HTTP authenticates, resolves the original order, rejects a wrong token and preserves a missing record. A direct native WebSocket probe returned NSURLErrorDomain -1002 on Linux; the Apple transport test is explicitly skipped there. Mock client lifecycle and actual Node server/WebSocket tests pass.

The package uses XCTest. The verification command explicitly disables the additional empty Swift Testing runner after intermittent toolchain crashes during its shutdown in this Linux environment. The final command completed with exit code 0; no XCTest case was disabled by that flag.

Linux excludes SwiftUI/UIKit/Security implementations. Parser checks are not Apple-framework compilation. Scripts/check-apple-types.sh is supplied for actual iOS Simulator SDK type-checking, including the application entry, and has not been run here.

No real phone, remote TLS endpoint, Keychain/haptic/layout acceptance, IPA install, funded trade, provider latency or strategy profitability was established. Step 5 remains the Xcode/GitHub/IPA stage.

Evidence: outer evidence/backend-tests.txt, ios-verification.txt, source-comparison.json and verification-summary.json.
