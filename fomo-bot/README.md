# FomoBot — Step 4

Complete cumulative source through the native screen milestone. Start with [STEP_4_SETUP.md](STEP_4_SETUP.md).

- Paper, Real and Copy trading tabs; explicit environment selection for copying.
- Native feed/portfolio navigation, token chart sheet, position controls, auto-pilot and allocations.
- Separate HTTPS profiles, Keychain credential entry, matching-mode checks and durable original command IDs.
- Existing backend 0.3.1 and retained standalone 4.0.2 trading behavior.

Verification: 90 backend + 95 retained + 41 Swift tests passed. One additional Apple-native WebSocket test is explicitly skipped on Linux. Core Release and native-source syntax checks pass. See [STEP_4_VERIFICATION.md](docs/STEP_4_VERIFICATION.md).

No strategy guarantees profit. Defaults stay paper; no funded trade was performed. Step 5 still provides Xcode generation, GitHub device builds, IPA packaging and installation. Apple SDK type-checking and device acceptance remain required. No IPA is included yet.
