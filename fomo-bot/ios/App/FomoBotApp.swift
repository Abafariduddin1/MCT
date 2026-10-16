#if os(iOS)
import SwiftUI
import FomoBotCore
import FomoBotUI

@main @MainActor struct FomoBotApp: App {
    @State private var model = TradingAppModel.production()
    @Environment(\.scenePhase) private var scenePhase
    var body: some Scene {
        WindowGroup {
            MainTabView(model: model)
                .task { await model.start() }
                .onChange(of: scenePhase) { _, phase in Task { await model.setForeground(phase == .active) } }
        }
    }
}
#endif
