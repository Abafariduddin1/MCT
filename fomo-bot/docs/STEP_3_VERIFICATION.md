# Step 3 verification

Checked on 16 October 2026 UTC in the Linux build environment, with Node 24.19.0 and Swift 6.3 (Swift 6 language mode).

| Check | Result |
| --- | --- |
| Backend strict TypeScript check | Passed |
| Backend tests | 90 passed |
| Retained standalone/core tests | 95 passed |
| Swift tests, including local native HTTP integration | 29 passed, 0 skipped |
| Swift core Release build | Passed |
| All six Swift-encoded command variants validated by actual backend parser | Passed; no commands executed |
| SwiftUI component syntax check | Passed |

Total: **214 test cases passed**, zero failures. The retained 95 core tests are counted once. These counts establish engineering checks, not financial performance.

The Swift tests cover exact quantities, nullable/stale fields, decoding actual local-server fixtures, strict flat command encoding, endpoint/header separation, journal identity/order, pre-send persistence, interrupted delivery, read-only recovery, duplicate taps, protocol/authentication failures, background transitions, observed chart geometry/coverage and endpoint preferences. The native URLSession HTTP check authenticated against a local paper controller, resolved an original command ID, rejected a wrong token and preserved a missing record as missing.

The backend additions test own-allocation exit funding, an exactly funded buy followed by a sale, rejection of an uneconomic partial that would consume required fee cash, receipt-based strategy results, partial-win counting, failed fees and unfinalized effects. All prior native execution, receipt, ledger, copy, risk and server regressions remain included.

The current logs are in the outer handoff's `evidence/step3-*.txt`. The optional local fixture must be enabled to reproduce all 29 Swift tests; without it, 28 run and one is explicitly skipped. See `STEP_3_SETUP.md`.

No funded transaction, real strategy return, Windows run or phone run was established. SwiftUI/UIKit/Security code is conditionally excluded on Linux, so Apple SDK type-checking and device acceptance are still required. The syntax check does not substitute for that build. The native iPhone screens and IPA remain later steps.
