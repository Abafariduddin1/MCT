# Current integration boundary — Step 4

The cumulative native source includes the application entry and screens. Backend runtime stays 0.3.1. Step 1 execution, Step 2 ledger/controller and Step 3 client/exit funding are retained.

Use STEP_4_SETUP.md in the project root, STEP_4_ARCHITECTURE.md, STEP_4_VERIFICATION.md and CONTROLLER_PROTOCOL.md. Older guides are historical milestones.

Paper and Real use separate locally configured server profiles. Copy selects one explicitly. The app cannot change server mode or unlock a wallet. Every connection requires its expected mode; mode/wallet changes block mutation and original unresolved IDs stay reviewable. Switching profiles does not stop an inactive backend.

Next is Step 5: include ios/App/FomoBotApp.swift in the real app target, consume FomoBotCore/FomoBotUI locally, generate Xcode configuration, verify iOS compilation, supply GitHub device/IPA packaging and signing/install instructions. Configure tokens/URLs on device; never compile secrets into the app.

Run ios/Scripts/check-apple-types.sh with the actual iOS Simulator SDK and verify:ios on Apple tooling. Linux compilation/syntax does not establish SwiftUI/Keychain/haptics or Apple transport behavior. Device acceptance includes all three tabs, mode mismatches, one identified paper action, reconnect, pending states and chart interaction.

No strategy/risk policy changed. No guaranteed return, funded execution or deployed endpoint is implied.
