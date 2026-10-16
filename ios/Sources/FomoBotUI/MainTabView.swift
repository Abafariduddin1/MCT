#if canImport(SwiftUI) && os(iOS)
import SwiftUI
import FomoBotCore

public struct MainTabView: View {
    @Bindable var model: TradingAppModel
    @State private var token: FeedToken?
    @State private var tab = 0
    public init(model: TradingAppModel) { self.model = model }
    public var body: some View {
        VStack(spacing: 0) {
            VStack(spacing: 12) {
                HStack {
                    Text("FomoBot").font(.system(.title2, design: .rounded, weight: .heavy))
                    Spacer()
                    Button { model.needsConnection = true; Haptics.shared.tap() } label: {
                        Image(systemName: "slider.horizontal.3").font(.headline).frame(width: 44, height: 44).background(BotTheme.card, in: Circle())
                    }.accessibilityLabel("Connection settings")
                }
                HStack(spacing: 6) {
                    ForEach(TradingSection.allCases) { section in
                        Button {
                            token = nil; model.notice = nil; Haptics.shared.tap()
                            Task { await model.select(section) }
                        } label: {
                            VStack(spacing: 5) {
                                Image(systemName: section.symbol)
                                Text(section.title).font(.system(.caption2, design: .rounded, weight: .bold)).multilineTextAlignment(.center)
                            }.frame(maxWidth: .infinity, minHeight: 57).padding(.vertical, 3)
                                .foregroundStyle(model.section == section ? Color.black : BotTheme.muted)
                                .background(model.section == section ? BotTheme.positive : BotTheme.card, in: RoundedRectangle(cornerRadius: 14))
                        }.buttonStyle(.plain).accessibilityAddTraits(model.section == section ? .isSelected : [])
                    }
                }
                ConnectionBanner(model: model)
            }.padding(.horizontal, 16).padding(.bottom, 12).background(BotTheme.background)
            if model.section == .copy { CopyTradingView(model: model) }
            else {
                TabView(selection: $tab) {
                    FeedView(model: model) { token = $0 }.tabItem { Label("Feed", systemImage: "square.grid.2x2.fill") }.tag(0)
                    PortfolioBotView(model: model).tabItem { Label("Portfolio", systemImage: "chart.pie.fill") }.tag(1)
                }.tint(BotTheme.positive)
            }
        }.background(BotTheme.background).preferredColorScheme(.dark)
            .task {
                while !Task.isCancelled {
                    model.refreshClock()
                    do { try await Task.sleep(for: .seconds(2)) } catch { return }
                }
            }
            .sheet(item: $token) { TokenDetailSheet(model: model, token: $0) }
            .sheet(isPresented: $model.needsConnection) { ConnectionSetupView(model: model) }
            .overlay(alignment: .bottom) {
                if let message = model.notice {
                    Text(message).font(.subheadline.weight(.semibold)).foregroundStyle(.white).padding(14)
                        .background(BotTheme.card, in: RoundedRectangle(cornerRadius: 16)).padding(.horizontal, 16).padding(.bottom, 70)
                        .accessibilityElement(children: .combine).allowsHitTesting(false)
                }
            }
            .onChange(of: model.client.tradeAlerts.last?.seq) { _, _ in
                guard let event = model.client.tradeAlerts.last, event.isFill, event.mode == model.mode else { return }
                model.notice = event.display; Haptics.shared.fill()
            }
            .task(id: model.notice) { if let original = model.notice { try? await Task.sleep(for: .seconds(5)); if model.notice == original { model.notice = nil } } }
    }
}
#endif
