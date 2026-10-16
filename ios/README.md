# FomoBotKit — Step 4

FomoBotCore contains the typed protocol, exact amounts, durable commands, secure transport, separate Paper/Real profiles and observable app state. FomoBotUI contains the native screens, Copy environment selector, charts and controls.

App/FomoBotApp.swift is the iOS application entry source, outside the two package library targets. Step 5 must include it in an app target and provide the verified Xcode/IPA pipeline.

Use ../STEP_4_SETUP.md. From backend, npm run verify:ios reproduces shared tests, actual controller HTTP, command codecs, core Release and source syntax. Scripts/check-apple-types.sh requires macOS/Xcode and type-checks the actual iOS branches. Linux checks do not establish Apple SDK or device behavior.
